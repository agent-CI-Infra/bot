import { createSign } from 'node:crypto';
import { type Store, type Row } from '../storage/database.js';
import { digest } from '../core/security.js';
import { appBucket, blockedUntil, bucketName, installationBucket, observe, refused, userBucket, utcTime, type Bucket } from './rate-limits.js';
import { errorBody, networkReason, Redactor, safePath, stop } from '../agent/common.js';
import { installationExecutionDenied } from '../installations/archive.js';

type SnapshotTree = {tree:any[],directory_fallback:boolean};
const treeCache=new WeakMap<object,Map<string,Promise<SnapshotTree>>>();
function errorDetail(message:unknown,redactor:Redactor,token:string,status:number):string{
  let detail=typeof message==='string'?message:`GitHub HTTP ${status}`;
  if(token)detail=detail.replaceAll(token,'[REDACTED]');
  return redactor.text(detail)
    .replace(/authorization[^\r\n]*/gi,'[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi,'[REDACTED]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+/g,'[REDACTED]')
    .replace(/\b(?:access_token|token|api_key)\s*[:=]\s*[^\s,;]+/gi,'[REDACTED]')
    .replace(/\s+/g,' ').trim().slice(0,320)||`GitHub HTTP ${status}`;
}
// Rule preflight and workspace preparation share the same complete listing for an immutable tree.
export function repositoryTree(github:Pick<GitHub,'request'|'path'>,sha:string):Promise<SnapshotTree>{
  let cache=treeCache.get(github);if(!cache){cache=new Map();treeCache.set(github,cache);}
  const saved=cache.get(sha);if(saved)return saved;
  const load=async():Promise<SnapshotTree>=>{
    const recursive=await github.request('GET',github.path('/git/trees/'+sha+'?recursive=1'));
    if(!recursive.truncated){
      if(!Array.isArray(recursive.tree))stop('repository_tree_invalid','waiting_environment',`Missing tree entries: ${sha}`);
      for(const entry of recursive.tree)safePath(entry.path);
      return {tree:recursive.tree,directory_fallback:false};
    }
    // Discard the partial recursive response and walk each directory from the fixed tree.
    const tree:any[]=[],pending=[{path:'',sha}];
    while(pending.length){
      const dir=pending.pop()!,part=await github.request('GET',github.path('/git/trees/'+dir.sha));
      if(part.truncated||!Array.isArray(part.tree))stop('repository_tree_invalid','waiting_environment',`Incomplete directory listing: ${dir.path||'/'} (${dir.sha})`);
      for(const entry of part.tree){
        safePath(entry.path);if(entry.path.includes('/'))stop('unsafe_repository_path',undefined,`Invalid directory entry: ${dir.path}/${entry.path}`);
        const path=dir.path?dir.path+'/'+entry.path:entry.path;safePath(path);tree.push({...entry,path});
        if(entry.type==='tree')pending.push({path,sha:entry.sha});
      }
    }
    return {tree,directory_fallback:true};
  };
  const result=load();cache.set(sha,result);result.catch(()=>cache!.delete(sha));return result;
}

// A GitHub App JWT signed in the control plane; it never leaves this process.
export function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now()/1000), encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: now-60, exp: now+540, iss: appId });
  return unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
}
// The permissions a GitHub App needs for review and development: the onboarding manifest asks for exactly these, and the
// permission check compares existing Apps and installations with them. Tokens still request only what each use needs.
// Gate onboarding asks for more (workflows) in its own tokens, only after a person confirms; see projects/gate-onboarding.ts.
export const appPermissions: Record<string,string> = { contents:'write', issues:'write', pull_requests:'write', statuses:'write', actions:'write', checks:'write', metadata:'read' };
// The webhook events those Apps subscribe to: opened and updated Issues and PRs, their comments, reviews and review comments.
// installation and installation_repositories reach every App without a subscription. The permission check compares with these too.
export const appEvents = ['issues', 'pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'];
export function missingEvents(subscribed: unknown, required: string[] = appEvents) { const have = Array.isArray(subscribed) ? subscribed.map(String) : []; return required.filter(name => !have.includes(name)); }
const permissionRank: Record<string,number> = { read:1, write:2, admin:3 };
export function missingPermissions(granted: unknown, required: Record<string,string> = appPermissions) {
  const have = granted && typeof granted === 'object' ? granted as Record<string,unknown> : {};
  return Object.entries(required).filter(([name, level]) => (permissionRank[String(have[name])] || 0) < permissionRank[level]!)
    .map(([name, level]) => ({ permission: name, required: level, current: typeof have[name] === 'string' ? have[name] as string : null }));
}
// What a task agent may read with its own token. Every value is read; installations that lack one simply omit it.
export const agentReadPermissions: Record<string,string> = { metadata:'read', contents:'read', issues:'read', pull_requests:'read', actions:'read', checks:'read', statuses:'read' };
export async function revokeInstallationToken(apiUrl: string, token: string) {
  const response = await fetch(apiUrl.replace(/\/$/, '') + '/installation/token', { method:'DELETE', redirect:'error', signal:AbortSignal.timeout(10000),
    headers:{ Authorization:'Bearer ' + token, Accept:'application/vnd.github+json' } });
  return [204, 401].includes(response.status);
}
// The account's actor (an App's bot user, or the bot account's user) rarely changes, so connect looks it up once an hour per
// account and credential rather than on every task.
const actors = new Map<string, { at: number, id: string, login: string }>();
const actorTtlMs = 3600_000;
export class GitHub {
  installationEvents: string[] | null = null;
  token = ''; actorId = ''; actorLogin = ''; fullName = ''; defaultBranch = ''; expiresAt = ''; permissions: Record<string,string> = {};
  // The repository's HTTPS clone URL as GitHub reports it; the Git cache fetches from it without putting the token in it.
  cloneUrl = '';
  // A publication fence runs after guards and quota checks, immediately before a write is sent.
  beforeWrite?: () => void;
  // The rate-limit windows this client's credentials count against: the App's JWT, and the installation (or the bot
  // account's user) for the token.
  private jwt = ''; private installationId = ''; private appWindow?: Bucket; private tokenWindow?: Bucket;
  constructor(readonly store: Store, readonly repository: Row, readonly redactor: Redactor,
    readonly guard: () => Promise<void>, readonly apiUrl = 'https://api.github.com') {}
  path(suffix = ''): string { return '/repos/' + this.fullName.split('/').map(encodeURIComponent).join('/') + suffix; }
  async request(method: string, path: string, body?: unknown, allow404 = false, token = this.token, allowEmptyRepository = false, snapshotBlob = false, jobLogs = false): Promise<any> {
    await this.guard();
    if (this.store && installationExecutionDenied(this.store, String(this.repository.account_id), String(this.repository.id)))
      stop('github_installation_access_revoked', 'waiting_permission', 'GitHub App 安装已暂停、卸载或正在核实范围；请等待安装同步后重试。');
    // A window that is used up (or refused a moment ago) is not sent into: the task waits until GitHub resets it.
    const window = token && token === this.token ? this.tokenWindow : token && token === this.jwt ? this.appWindow : undefined, blocked = window ? blockedUntil(this.store, window) : null;
    if (blocked) stop('github_rate_limited', 'retry_wait', `GitHub 流控：${bucketName(window!)}本小时的请求额度已用完，${utcTime(blocked)} 重置后继续（${method} ${path} 未发送）。`, blocked - Date.now(), window!.key);
    let response: Response;
    if(method!=='GET')this.beforeWrite?.();
    try { response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { method, redirect: jobLogs ? 'manual' : 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch (error) { return stop(method === 'GET' ? 'github_unavailable' : 'github_response_unknown', 'retry_wait',
      this.redactor.text(`GitHub 请求 ${method} ${path} 失败：${networkReason(error,30000)}${method==='GET'?'':'，写入结果尚未确认'}。`)); }
    if (window) observe(this.store, window, response.headers, response.status);
    if (jobLogs && response.status === 302) {
      // Only a fixed Actions job-log endpoint can enter this branch. The URL is supplied by GitHub,
      // never by a model; signed storage requests deliberately carry no GitHub authorization header.
      const location = response.headers.get('location'); await response.body?.cancel();
      let address: URL;
      try { address = new URL(location || ''); } catch { return stop('github_log_redirect_invalid', undefined, 'GitHub 日志下载没有返回有效地址。'); }
      if (address.username || address.password || address.hash || (address.protocol !== 'https:' && !(address.protocol === 'http:' && address.origin === new URL(this.apiUrl).origin)))
        return stop('github_log_redirect_invalid', undefined, 'GitHub 日志下载返回了不安全的地址，已拒绝读取。');
      await this.guard();
      try { response = await fetch(address, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000) }); }
      catch { return stop('github_log_download_failed', 'retry_wait', 'GitHub 日志下载失败，未转发 GitHub 令牌或记录临时下载地址。'); }
      if (!response.ok) { await response.body?.cancel(); return stop('github_log_download_failed', 'retry_wait', `GitHub 日志存储返回 HTTP ${response.status}，可稍后重试读取。`); }
    }
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const error=await errorBody(response),detail=errorDetail(error?.message,this.redactor,token,response.status);
      // Ref reads report an empty repository as 409; writes and other conflicts must still fail.
      if(response.status===409&&allowEmptyRepository&&['Git Repository is empty.','Git Repository is empty'].includes(error?.message))return null;
      if(snapshotBlob&&[403,413,422].includes(response.status)){
        // Do not mistake denied permissions or rate limiting for a file-size exclusion.
        if(error?.errors?.some?.((e:any)=>e.code==='too_large')||/\b(?:blob|file)\b.*\btoo large\b/i.test(error?.message||''))
          return {skipped:true,status:response.status,size:error?.size,message:error?.message?detail:'Blob too large for GitHub API'};
      }
      const retryAfter=response.headers.get('retry-after'),limited=[403,429].includes(response.status)&&
        (retryAfter!==null||response.headers.get('x-ratelimit-remaining')==='0'||/rate[\s_-]*limit|abuse[\s_-]*(?:detection|detected)/i.test(String(error?.message||'')+' '+String(error?.documentation_url||'')));
      // GitHub's own message is often only "Server Error": name the request and status too. A 5xx also keeps
      // GitHub's request ID, the only handle GitHub has for tracing that response.
      const said=detail===`GitHub HTTP ${response.status}`?'':detail;
      const requestId=response.status>=500?response.headers.get('x-github-request-id')?.match(/^[A-Za-z0-9:._-]{1,80}$/)?.[0]:undefined;
      const explain=(message:string,note='')=>this.redactor.text(`GitHub 请求 ${method} ${path} 返回 HTTP ${response.status}${note}`
        +(message?'：'+message:'')+(requestId?`（GitHub 请求 ID：${requestId}）`:''));
      // Without a time from GitHub the task backs off on its own (a minute, doubling up to 15 minutes).
      if(limited){const now=Date.now(),{until,reported}=refused(this.store,window,response.headers,now);
        stop('github_rate_limited','retry_wait',explain(said||'rate limit exceeded',reported?`，${utcTime(until)} 后重试`:'，GitHub 未给出恢复时间，稍后重试（每次等待加倍）'),reported?until-now:undefined,window?.key);}
      if ([401,403,404].includes(response.status)) stop('github_permission_' + response.status, 'waiting_permission',explain(said));
      if (response.status >= 500 && method !== 'GET') stop('github_response_unknown', 'retry_wait',explain(said,'，写入结果尚未确认'));
      stop('github_http_' + response.status, response.status === 429 || response.status >= 500 ? 'retry_wait' : 'failed',explain(said));
    }
    if (jobLogs) {
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 8 * 1024 * 1024) return stop('github_log_too_large', undefined, '该 job 日志超过 8 MiB，未返回不完整内容；请在 Actions 查看完整日志。');
          chunks.push(value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      return Buffer.concat(chunks).toString('utf8');
    }
    const value = await response.text(); if (!snapshotBlob && value.length > 48 * 1024 * 1024) stop('github_response_too_large',undefined,`GitHub 请求 ${method} ${path} 的响应长度 ${value.length}，超过 48 MiB 上限。`);
    try { return value ? JSON.parse(value) : {}; } catch { return stop('github_invalid_response',undefined,`GitHub 请求 ${method} ${path} 返回无效 JSON，HTTP ${response.status}。`); }
  }
  async jobLog(jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId < 1) return stop('github_log_job_invalid', undefined, 'Actions job ID 无效。');
    return this.request('GET', this.path(`/actions/jobs/${jobId}/logs`), undefined, false, this.token, false, false, true);
  }
  // A short-lived token of the App installation with permissions the task token was not given, for one control-plane write
  // (resolving a review thread takes contents: write). It covers this repository only and is revoked after use; GitHub
  // refuses it (422) when the installation does not grant those permissions. A Token account uses its own token.
  async withPermissions<T>(permissions:Record<string,string>,use:(token:string)=>Promise<T>):Promise<T>{
    if(!this.jwt||!this.installationId)return use(this.token);
    const access=await this.request('POST',`/app/installations/${this.installationId}/access_tokens`,{repository_ids:[Number(this.repository.id)],permissions},false,this.jwt);
    const token=String(access?.token||'');if(!token)stop('github_token_missing','waiting_permission',`GitHub 未返回安装 ${this.installationId} 的访问令牌。`);this.redactor.add(token);
    try{return await use(token);}finally{await revokeInstallationToken(this.apiUrl,token).catch(()=>false);}
  }
  // A GraphQL request; GitHub answers 200 with errors for a refused or invalid one.
  async graphql(query:string,variables:Record<string,unknown>,token=this.token):Promise<any>{
    const value=await this.request('POST','/graphql',{query,variables},false,token);
    if(Array.isArray(value?.errors)&&value.errors.length){
      const denied=value.errors.some((e:any)=>['FORBIDDEN','INSUFFICIENT_SCOPES'].includes(String(e?.type)));
      stop(denied?'github_permission_graphql':'github_graphql_failed',denied?'waiting_permission':'failed',this.redactor.text(`GitHub GraphQL 请求失败：${value.errors.map((e:any)=>String(e?.message||e?.type||'error')).join('; ').slice(0,500)}`));
    }
    return value?.data;
  }
  async snapshotBlob(sha:string):Promise<any>{
    if(!/^[a-f0-9]{40}$/.test(sha))stop('repository_blob_invalid',undefined,`Invalid blob SHA: ${sha}`);
    return this.request('GET',this.path('/git/blobs/'+sha),undefined,false,this.token,false,true);
  }
  async pages(path: string): Promise<any[]> {
    const rows: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request('GET', path + (path.includes('?') ? '&' : '?') + `per_page=100&page=${page}`);
      if (!Array.isArray(result)) stop('github_invalid_page',undefined,`GitHub 分页 ${path} 的第 ${page} 页未返回数组。`); rows.push(...result);
      if (result.length < 100) return rows;
    }
    return stop('github_pagination_limit', 'waiting_configuration', `GitHub 分页 ${path} 已读取 100 页，仍未结束，无法确认完整结果。`);
  }
  // requiredPermissions must all be granted; requestedPermissions are taken where the installation has them.
  // Read-only webhook preflight can skip actor identity; task publication keeps the default identity checks.
  async connect(development: boolean, requiredPermissions?: Record<string,string>, requestedPermissions?: Record<string,string>, identifyActor = true): Promise<any> {
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', this.repository.account_id);
    if (!account) stop('github_account_missing', 'waiting_configuration', `仓库 ${this.repository.id} 关联的 GitHub 账号不存在，请重新配置账号。`);
    const secrets = this.store.secrets.open(account!.credentials, `account:${account!.id}`);
    this.fullName = this.repository.full_name;
    if (account!.type === 'bot_account') {
      if (!secrets.token) stop('github_credentials_missing', 'waiting_configuration', 'GitHub 机器人账号未保存访问令牌，请重新配置凭据。'); this.token = String(secrets.token); this.redactor.add(this.token);
      // The login seen last time names the window until GET /user answers, so a used-up window that stops that very
      // request still says whose it is.
      this.tokenWindow = userBucket(account!.id, this.store.get("SELECT owner FROM github_rate_limits WHERE bucket=? AND owner IS NOT NULL LIMIT 1", 'user:' + account!.id)?.owner ?? null);
      if (identifyActor) {
        const key = account!.id + ':' + digest(this.token), known = actors.get(key);
        if (known && Date.now() - known.at < actorTtlMs) Object.assign(this, { actorId: known.id, actorLogin: known.login });
        else { const actor = await this.request('GET','/user'); this.actorId = String(actor.id); this.actorLogin = String(actor.login || ''); actors.set(key, { at: Date.now(), id: this.actorId, login: this.actorLogin }); }
        // The window is the token's user's; naming it lets the console show whose quota this is.
        this.tokenWindow = userBucket(account!.id, this.actorLogin || this.tokenWindow.owner);
      }
    } else {
      if (!secrets.private_key) stop('github_credentials_missing', 'waiting_configuration', 'GitHub App 账号未保存私钥，请重新配置凭据。');
      this.redactor.add(secrets.private_key);
      const jwt = this.jwt = appJwt(String(account!.app_id), String(secrets.private_key)); this.redactor.add(jwt); this.appWindow = appBucket(account!.id);
      const actorKey = account!.id + ':' + String(account!.app_id), known = actors.get(actorKey), fresh = !!known && Date.now() - known.at < actorTtlMs;
      const app = identifyActor && !fresh ? await this.request('GET','/app', undefined, false, jwt) : null;
      const installation = await this.request('GET',this.path('/installation'), undefined, false, jwt);
      this.installationEvents = Array.isArray(installation.events) ? installation.events.map(String) : null;
      this.installationId = String(installation.id);
      this.tokenWindow = installationBucket(account!.id, String(installation.id), installation.account?.login ? String(installation.account.login) : null);
      if (String(installation.account?.id) !== this.repository.owner_id) stop('github_installation_owner_changed','waiting_permission', `GitHub App 安装 ${installation.id} 的所属账号与仓库登记的所有者不一致。`);
      const requested: Record<string,string> = requiredPermissions || requestedPermissions || { contents: development ? 'write':'read', issues:'write',pull_requests:'write' };
      if(requiredPermissions&&Object.entries(requiredPermissions).some(([key,value])=>!installation.permissions?.[key]||value==='write'&&installation.permissions[key]!=='write'))stop('github_permissions_insufficient','waiting_permission', `GitHub App 安装 ${installation.id} 缺少本次操作所需的权限，请检查安装授权。`);
      const permissions: Record<string,string> = {};
      for (const [key,value] of Object.entries(requested)) if (installation.permissions?.[key]) permissions[key] = installation.permissions[key] === 'read' ? 'read':value;
      const access = await this.request('POST',`/app/installations/${installation.id}/access_tokens`, { repository_ids:[Number(this.repository.id)], permissions }, false,jwt);
      this.token = String(access.token || ''); if (!this.token) stop('github_token_missing','waiting_permission', `GitHub 未返回安装 ${installation.id} 的访问令牌。`); this.redactor.add(this.token);
      this.expiresAt=String(access.expires_at||'');this.permissions=access.permissions&&typeof access.permissions==='object'?access.permissions:permissions;
      if (identifyActor && fresh) Object.assign(this, { actorId: known!.id, actorLogin: known!.login });
      else if (identifyActor) {
        const actor = await this.request('GET','/users/' + encodeURIComponent(app.slug + '[bot]'));
        this.actorId = String(actor.id); this.actorLogin = String(actor.login || app.slug + '[bot]'); actors.set(actorKey, { at: Date.now(), id: this.actorId, login: this.actorLogin });
      }
    }
    const repo = await this.request('GET','/repositories/' + this.repository.id);
    if (String(repo.id) !== this.repository.id || String(repo.owner?.id) !== this.repository.owner_id) stop('github_repository_scope_changed','waiting_permission', `GitHub 返回的仓库身份或所有者与登记仓库 ${this.repository.id} 不一致。`);
    this.fullName = repo.full_name; this.defaultBranch = repo.default_branch; this.cloneUrl = typeof repo.clone_url === 'string' ? repo.clone_url : '';
    if ((identifyActor && !this.actorId) || !this.defaultBranch || !/^[\w.-]+\/[\w.-]+$/.test(this.fullName)) stop('github_repository_invalid',undefined,`GitHub 仓库 ${this.repository.id} 缺少有效的机器人身份、默认分支或仓库全名。`);
    return repo;
  }
  authorEmail(): string {
    // The installation token's actor, not a hard-coded user or organization.
    if (!/^[1-9]\d*$/.test(this.actorId) || !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(this.actorLogin)) stop('github_actor_invalid','waiting_configuration','生成提交作者邮箱时发现 GitHub 账号 ID 或登录名格式无效。');
    return `${this.actorId}+${this.actorLogin}@users.noreply.github.com`;
  }
  async object(kind: string, number: number): Promise<any> { return this.request('GET',this.path(`/${kind.endsWith('.pr') ? 'pulls':'issues'}/${number}`)); }
  async ref(branch: string): Promise<any> { return this.request('GET',this.path('/git/ref/heads/' + encodeURIComponent(branch)), undefined, true, this.token, true); }
}
