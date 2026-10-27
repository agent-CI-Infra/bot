import { createSign } from 'node:crypto';
import { type Store, type Row } from '../storage/database.js';
import { Redactor, safePath, stop, TaskError } from '../agent/common.js';

type SnapshotTree = {tree:any[],directory_fallback:boolean};
const treeCache=new WeakMap<object,Map<string,Promise<SnapshotTree>>>();
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
    catch { return stop(method === 'GET' ? 'github_unavailable' : 'github_response_unknown', 'retry_wait'); }
    if (response.status === 404 && allow404) return null;
    // Ref reads report an empty repository as 409; writes and other conflicts must still fail.
    if (response.status === 409 && allowEmptyRepository) {
      let error; try { error = await response.json(); } catch { /* Keep the original HTTP failure for other responses. */ }
      if (error?.message === 'Git Repository is empty.' || error?.message === 'Git Repository is empty') return null;
    }
    if (!response.ok) {
      if(snapshotBlob&&[403,413,422].includes(response.status)){
        const error=await response.json().catch(()=>null);
        // Do not mistake denied permissions or rate limiting for a file-size exclusion.
        if(error?.errors?.some?.((e:any)=>e.code==='too_large')||/\b(?:blob|file)\b.*\btoo large\b/i.test(error?.message||''))
          return {skipped:true,status:response.status,size:error?.size,message:error?.message||'Blob too large for GitHub API'};
      }
      if ([401,403,404].includes(response.status)) stop('github_permission_' + response.status, 'waiting_permission');
      if (response.status >= 500 && method !== 'GET') stop('github_response_unknown', 'retry_wait');
      stop('github_http_' + response.status, response.status === 429 || response.status >= 500 ? 'retry_wait' : 'failed');
    }
    const value = await response.text(); if (!snapshotBlob && value.length > 48 * 1024 * 1024) stop('github_response_too_large');
    try { return value ? JSON.parse(value) : {}; } catch { return stop('github_invalid_response'); }
  }
  async snapshotBlob(sha:string):Promise<any>{
    if(!/^[a-f0-9]{40}$/.test(sha))stop('repository_blob_invalid',undefined,`Invalid blob SHA: ${sha}`);
    return this.request('GET',this.path('/git/blobs/'+sha),undefined,false,this.token,false,true);
  }
  async pages(path: string): Promise<any[]> {
    const rows: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request('GET', path + (path.includes('?') ? '&' : '?') + `per_page=100&page=${page}`);
      if (!Array.isArray(result)) stop('github_invalid_page'); rows.push(...result);
      if (result.length < 100) return rows;
    }
    return stop('github_pagination_limit', 'waiting_configuration');
  }
  // requiredPermissions must all be granted; requestedPermissions are taken where the installation has them.
  async connect(development: boolean, requiredPermissions?: Record<string,string>, requestedPermissions?: Record<string,string>): Promise<any> {
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', this.repository.account_id);
    if (!account) stop('github_account_missing', 'waiting_configuration');
    const secrets = this.store.secrets.open(account!.credentials, `account:${account!.id}`);
    this.fullName = this.repository.full_name;
    if (account!.type === 'bot_account') {
      if (!secrets.token) stop('github_credentials_missing', 'waiting_configuration'); this.token = String(secrets.token); this.redactor.add(this.token);
      const actor = await this.request('GET','/user'); this.actorId = String(actor.id); this.actorLogin = String(actor.login || '');
    } else {
      if (!secrets.private_key) stop('github_credentials_missing', 'waiting_configuration');
      this.redactor.add(secrets.private_key);
      const jwt = appJwt(String(account!.app_id), String(secrets.private_key)); this.redactor.add(jwt);
      const app = await this.request('GET','/app', undefined, false, jwt);
      const installation = await this.request('GET',this.path('/installation'), undefined, false, jwt);
      if (String(installation.account?.id) !== this.repository.owner_id) stop('github_installation_owner_changed','waiting_permission');
      const requested: Record<string,string> = requiredPermissions || requestedPermissions || { contents: development ? 'write':'read', issues:'write',pull_requests:'write' };
      if(requiredPermissions&&Object.entries(requiredPermissions).some(([key,value])=>!installation.permissions?.[key]||value==='write'&&installation.permissions[key]!=='write'))stop('github_permissions_insufficient','waiting_permission');
      const permissions: Record<string,string> = {};
      for (const [key,value] of Object.entries(requested)) if (installation.permissions?.[key]) permissions[key] = installation.permissions[key] === 'read' ? 'read':value;
      const access = await this.request('POST',`/app/installations/${installation.id}/access_tokens`, { repository_ids:[Number(this.repository.id)], permissions }, false,jwt);
      this.token = String(access.token || ''); if (!this.token) stop('github_token_missing','waiting_permission'); this.redactor.add(this.token);
      this.expiresAt=String(access.expires_at||'');this.permissions=access.permissions&&typeof access.permissions==='object'?access.permissions:permissions;
      const actor = await this.request('GET','/users/' + encodeURIComponent(app.slug + '[bot]'));
      this.actorId = String(actor.id); this.actorLogin = String(actor.login || app.slug + '[bot]');
    }
    const repo = await this.request('GET','/repositories/' + this.repository.id);
    if (String(repo.id) !== this.repository.id || String(repo.owner?.id) !== this.repository.owner_id) stop('github_repository_scope_changed','waiting_permission');
    this.fullName = repo.full_name; this.defaultBranch = repo.default_branch; this.cloneUrl = typeof repo.clone_url === 'string' ? repo.clone_url : '';
    if (!this.actorId || !this.defaultBranch || !/^[\w.-]+\/[\w.-]+$/.test(this.fullName)) stop('github_repository_invalid');
    return repo;
  }
  authorEmail(): string {
    // The installation token's actor, not a hard-coded user or organization.
    if (!/^[1-9]\d*$/.test(this.actorId) || !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(this.actorLogin)) stop('github_actor_invalid','waiting_configuration');
    return `${this.actorId}+${this.actorLogin}@users.noreply.github.com`;
  }
  async object(kind: string, number: number): Promise<any> { return this.request('GET',this.path(`/${kind.endsWith('.pr') ? 'pulls':'issues'}/${number}`)); }
  async ref(branch: string): Promise<any> { return this.request('GET',this.path('/git/ref/heads/' + encodeURIComponent(branch)), undefined, true, this.token, true); }
}
