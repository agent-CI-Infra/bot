import { GitHub, repositoryTree, revokeInstallationToken } from '../github/client.js';
import { Redactor, stop } from '../agent/common.js';
import type { Store } from '../storage/database.js';

export const skillPath = '.agents/skills/release-notes/SKILL.md';
export function releaseRedactor(store: Store, repositoryId: string): Redactor {
  const redactor = new Redactor();
  const add = (value: any): void => { if (value && typeof value === 'object') Object.values(value).forEach(add); else redactor.add(value); };
  const repo = store.get('SELECT account_id FROM repositories WHERE id=?', repositoryId);
  const account = repo && store.get('SELECT * FROM accounts WHERE id=?', repo.account_id);
  if (account) add(store.secrets.open(account.credentials, `account:${account.id}`));
  for (const model of store.all('SELECT id,api_key FROM models WHERE api_key IS NOT NULL')) add(store.secrets.open(model.api_key, `model:${model.id}`));
  if (account) for (const endpoint of store.all('SELECT id,secret FROM endpoints WHERE account_id=?', account.id)) add(store.secrets.open(endpoint.secret, `endpoint:${endpoint.id}`));
  return redactor;
}
export function enabled(store: Store, id: string): void {
  const repo = store.get('SELECT * FROM repositories WHERE id=?', id);
  if (!repo || !store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1', id)) return stop('release_disabled', 'waiting_permission', '项目已禁用，发版本不可用。');
  if (!store.get('SELECT 1 FROM installed_repositories WHERE repository_id=? AND account_id=? AND installed=1', id, repo.account_id)) stop('release_uninstalled', 'waiting_permission', 'GitHub App 已卸载或仓库已移出安装。');
  if (store.get('SELECT type FROM accounts WHERE id=?', repo.account_id)?.type !== 'github_app') stop('release_app_required', 'waiting_permission', '发版本需要 GitHub App 安装令牌，不能使用机器人账号写令牌。');
}
export async function withGitHub<T>(store: Store, id: string, api: string, permissions: Record<string, string>, redactor: Redactor,
  fn: (github: GitHub) => Promise<T>, guard: () => Promise<void> = async () => {}): Promise<T> {
  enabled(store, id);
  const github = new GitHub(store, store.get('SELECT * FROM repositories WHERE id=?', id)!, redactor, async () => { enabled(store, id); await guard(); }, api);
  try { await github.connect(false, { contents: 'read', actions: 'read', ...permissions }, undefined, false); return await fn(github); }
  finally { if (github.token) await revokeInstallationToken(api, github.token).catch(() => false); }
}
export async function file(github: GitHub, sha: string, path: string, allowEmpty = false) {
  const { tree } = await repositoryTree(github, sha), entry = tree.find(e => e.path === path);
  if (!entry) return null;
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) stop('release_file_invalid', 'failed', `发布文件不是有效的普通文本文件：${path}`);
  const blob = await github.snapshotBlob(entry.sha);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') stop('release_file_invalid', 'failed', `发布文件读取失败：${path}`);
  const bytes = Buffer.from(blob.content, 'base64'), content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (content.includes('\0') || (!allowEmpty && !content.trim())) stop('release_file_invalid', 'failed', `发布文件为空或不是文本：${path}`);
  return { sha: String(entry.sha), content };
}
export async function resolveObject(github: GitHub, object: any): Promise<{ commit: string; object_sha: string }> {
  const objectSha = object?.sha;
  for (let depth = 0; depth < 32; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object?.sha)) stop('release_tag_invalid', 'failed', '标签对象缺少有效 SHA。');
    if (object.type === 'commit') return { commit: object.sha, object_sha: objectSha };
    if (object.type !== 'tag') break;
    object = (await github.request('GET', github.path('/git/tags/' + object.sha))).object;
  }
  return stop('release_tag_invalid', 'failed', '标签不能解析到提交。');
}
export async function tag(github: GitHub, version: string) {
  const ref = await github.request('GET', github.path('/git/ref/tags/' + encodeURIComponent(version)), undefined, true);
  return ref ? resolveObject(github, ref.object) : null;
}
export async function releases(github: GitHub, version: string, savedId?: number) {
  const saved = savedId ? await github.request('GET', github.path('/releases/' + savedId), undefined, true) : null;
  const found = (await github.pages(github.path('/releases'))).filter(r => r.tag_name === version);
  if (saved?.tag_name === version && !found.some(r => r.id === saved.id)) found.push(saved);
  if (found.length > 1) stop('release_duplicate', 'failed', '发现多份同名 Release，需要人工处理。');
  return found[0] || null;
}
