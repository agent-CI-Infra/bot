import { createSign } from 'node:crypto';
import { type Store, type Row } from '../storage/database.js';
import { Redactor, safePath, stop, TaskError } from '../agent/common.js';

type SnapshotTree = {tree:any[],directory_fallback:boolean};
const treeCache=new WeakMap<object,Map<string,Promise<SnapshotTree>>>();
// Error responses are untrusted: keep only a short message, never headers or the whole payload.
async function githubError(response:Response):Promise<any>{
  const reader=response.body?.getReader();if(!reader)return null;
  const chunks:Uint8Array[]=[];let length=0;
  try{
    while(length<16384){const {done,value}=await reader.read();if(done)break;chunks.push(value.subarray(0,16384-length));length+=value.length;}
  }catch{/* Preserve the HTTP failure when the error body cannot be read. */}
  finally{await reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString('utf8');
  try{return JSON.parse(text);}catch{return response.headers.get('content-type')?.startsWith('text/plain')?{message:text.split(/[\r\n]/)[0]}:null;}
}
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
function retryAfterMs(value:string|null):number{
  // GitHub sends seconds. Also accept HTTP dates; invalid or excessive waits use the one-minute fallback.
  const delay=value&&/^\d+$/.test(value)?Number(value)*1000:value?Date.parse(value)-Date.now():NaN;
  return Number.isFinite(delay)&&delay>=0&&delay<=900000?delay:60000;
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
// One-click onboarding asks for more (workflows, pages, repository_creation) in its own tokens; see projects/quickstart.ts.
export const appPermissions: Record<string,string> = { contents:'write', issues:'write', pull_requests:'write', statuses:'write', actions:'write', checks:'write', metadata:'read' };
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
export class GitHub {
  token = ''; actorId = ''; actorLogin = ''; fullName = ''; defaultBranch = ''; expiresAt = ''; permissions: Record<string,string> = {};
  // The repository's HTTPS clone URL as GitHub reports it; the Git cache fetches from it without putting the token in it.
  cloneUrl = '';
  constructor(readonly store: Store, readonly repository: Row, readonly redactor: Redactor,
    readonly guard: () => Promise<void>, readonly apiUrl = 'https://api.github.com') {}
  path(suffix = ''): string { return '/repos/' + this.fullName.split('/').map(encodeURIComponent).join('/') + suffix; }
  async request(method: string, path: string, body?: unknown, allow404 = false, token = this.token, allowEmptyRepository = false, snapshotBlob = false): Promise<any> {
    await this.guard();
    let response: Response;
    try { response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { return stop(method === 'GET' ? 'github_unavailable' : 'github_response_unknown', 'retry_wait', this.redactor.text(`GitHub 请求 ${method} ${path} 连接失败或超时${method==='GET'?'，等待重试':'，写入结果尚未确认'}。`)); }
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const error=await githubError(response),detail=errorDetail(error?.message,this.redactor,token,response.status);
      // Ref reads report an empty repository as 409; writes and other conflicts must still fail.
      if(response.status===409&&allowEmptyRepository&&['Git Repository is empty.','Git Repository is empty'].includes(error?.message))return null;
      if(snapshotBlob&&[403,413,422].includes(response.status)){
        // Do not mistake denied permissions or rate limiting for a file-size exclusion.
        if(error?.errors?.some?.((e:any)=>e.code==='too_large')||/\b(?:blob|file)\b.*\btoo large\b/i.test(error?.message||''))
          return {skipped:true,status:response.status,size:error?.size,message:error?.message?detail:'Blob too large for GitHub API'};
      }
      const retryAfter=response.headers.get('retry-after'),limited=[403,429].includes(response.status)&&
        (retryAfter!==null||response.headers.get('x-ratelimit-remaining')==='0'||/rate[\s_-]*limit|abuse[\s_-]*(?:detection|detected)/i.test(String(error?.message||'')+' '+String(error?.documentation_url||'')));
      if(limited)stop('github_rate_limited','retry_wait',detail===`GitHub HTTP ${response.status}`?detail+': rate limit exceeded':detail,retryAfterMs(retryAfter));
      if ([401,403,404].includes(response.status)) stop('github_permission_' + response.status, 'waiting_permission',detail);
      if (response.status >= 500 && method !== 'GET') stop('github_response_unknown', 'retry_wait',detail);
      stop('github_http_' + response.status, response.status === 429 || response.status >= 500 ? 'retry_wait' : 'failed',detail);
    }
    const value = await response.text(); if (!snapshotBlob && value.length > 48 * 1024 * 1024) stop('github_response_too_large',undefined,`GitHub 请求 ${method} ${path} 的响应长度 ${value.length}，超过 48 MiB 上限。`);
    try { return value ? JSON.parse(value) : {}; } catch { return stop('github_invalid_response',undefined,`GitHub 请求 ${method} ${path} 返回无效 JSON，HTTP ${response.status}。`); }
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
      if (identifyActor) { const actor = await this.request('GET','/user'); this.actorId = String(actor.id); this.actorLogin = String(actor.login || ''); }
    } else {
      if (!secrets.private_key) stop('github_credentials_missing', 'waiting_configuration', 'GitHub App 账号未保存私钥，请重新配置凭据。');
      this.redactor.add(secrets.private_key);
      const jwt = appJwt(String(account!.app_id), String(secrets.private_key)); this.redactor.add(jwt);
      const app = identifyActor ? await this.request('GET','/app', undefined, false, jwt) : null;
      const installation = await this.request('GET',this.path('/installation'), undefined, false, jwt);
      if (String(installation.account?.id) !== this.repository.owner_id) stop('github_installation_owner_changed','waiting_permission', `GitHub App 安装 ${installation.id} 的所属账号与仓库登记的所有者不一致。`);
      const requested: Record<string,string> = requiredPermissions || requestedPermissions || { contents: development ? 'write':'read', issues:'write',pull_requests:'write' };
      if(requiredPermissions&&Object.entries(requiredPermissions).some(([key,value])=>!installation.permissions?.[key]||value==='write'&&installation.permissions[key]!=='write'))stop('github_permissions_insufficient','waiting_permission', `GitHub App 安装 ${installation.id} 缺少本次操作所需的权限，请检查安装授权。`);
      const permissions: Record<string,string> = {};
      for (const [key,value] of Object.entries(requested)) if (installation.permissions?.[key]) permissions[key] = installation.permissions[key] === 'read' ? 'read':value;
      const access = await this.request('POST',`/app/installations/${installation.id}/access_tokens`, { repository_ids:[Number(this.repository.id)], permissions }, false,jwt);
      this.token = String(access.token || ''); if (!this.token) stop('github_token_missing','waiting_permission', `GitHub 未返回安装 ${installation.id} 的访问令牌。`); this.redactor.add(this.token);
      this.expiresAt=String(access.expires_at||'');this.permissions=access.permissions&&typeof access.permissions==='object'?access.permissions:permissions;
      if (identifyActor) {
        const actor = await this.request('GET','/users/' + encodeURIComponent(app.slug + '[bot]'));
        this.actorId = String(actor.id); this.actorLogin = String(actor.login || app.slug + '[bot]');
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
