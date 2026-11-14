import type { Store } from '../storage/database.js';
import { listEffectiveProjectAccess, listEffectiveScopes } from './authorization.js';
import { rewriteGithubAppInstallUrl } from '../github/app-install-url.js';

// A computed GitHub connection summary for the identity page: one state, one sentence, and the
// next step. "已验证" on an identity row only means the binding is live; this object is what
// tells the person whether they can already see repositories and, if not, why.
export type GitHubConnectionState = 'disconnected' | 'reauthorization_required' | 'pending_verification'
  | 'connected' | 'outside_tenant' | 'not_listed' | 'pending_activation' | 'no_repositories';
export type GitHubConnectionAction = 'connect' | 'reconnect' | 'reverify' | 'choose_repos' | 'wait_activation' | 'switch_tenant' | null;
export interface GitHubRepositoryRef { id: string; full_name: string }
export interface GitHubConnection {
  state: GitHubConnectionState; status: string; next_step: string; action: GitHubConnectionAction;
  repository_count: number; repositories: GitHubRepositoryRef[]; pending_repositories: GitHubRepositoryRef[];
  install_url: string | null;
  /** Granted repositories the session's project list does not show (`outside_tenant` / `not_listed`), else 0. */
  hidden_repository_count: number;
  /** Display name of the organization the session is limited to, set only for `outside_tenant`. */
  tenant_name: string | null;
}

function byName(left: GitHubRepositoryRef, right: GitHubRepositoryRef): number {
  return left.full_name.localeCompare(right.full_name) || left.id.localeCompare(right.id);
}


// Only the public "install / choose repositories" address of this deployment's GitHub App. The App owner's
// settings page, account ids and webhook addresses stay on the super-admin onboarding APIs. Stored
// `/installations/new` addresses are rewritten to `select_target` on read.
export function githubAppInstallUrl(store: Store): string | null {
  const raw = store.get('SELECT value FROM settings WHERE key=?', 'onboarding.app')?.value;
  if (typeof raw !== 'string' || !raw) return null;
  let saved: { slug?: unknown; install_url?: unknown };
  try { saved = JSON.parse(raw); } catch { return null; }
  return rewriteGithubAppInstallUrl(typeof saved.install_url === 'string' ? saved.install_url : '', typeof saved.slug === 'string' ? saved.slug : undefined);}

/** Installed repositories this principal already administers, but that a platform administrator has not started.
 *  When a tenant is selected, only grants of that tenant are considered, matching the project list. */
export function pendingInstalledRepositories(store: Store, principal: string, tenantId?: string | null): GitHubRepositoryRef[] {
  const active = listEffectiveScopes(store, principal).filter(g => g.source === 'github_derived' && g.state === 'active'
    && (!tenantId || g.tenant_id === tenantId));
  const seen = new Map<string, GitHubRepositoryRef>();
  for (const grant of active) {
    const row = store.get('SELECT installation_ref,project_id FROM scoped_grants WHERE id=?', grant.grant_id);
    if (!row?.installation_ref) continue;
    const repos = store.all(`SELECT r.repository_id AS id,r.full_name FROM installation_repositories r
      WHERE r.installation_ref=? AND r.present=1 AND NOT EXISTS(SELECT 1 FROM repositories p WHERE p.id=r.repository_id)
      AND (? IS NULL OR r.repository_id=?)`, row.installation_ref, row.project_id, row.project_id);
    for (const repo of repos) {
      if (typeof repo.id === 'string' && typeof repo.full_name === 'string' && repo.full_name) seen.set(repo.id, { id: repo.id, full_name: repo.full_name });
    }
  }
  return [...seen.values()].sort(byName);
}

/**
 * `visible` is the project list this session actually gets (the ids /api/repositories filters by), and `tenant` the
 * organization the session is confined to. A count the project list cannot show is not reported as "openable".
 */
export function githubConnection(store: Store, principal: string, scope: { visible?: string[]; tenant?: string | null } = {}): GitHubConnection {
  const granted = listEffectiveProjectAccess(store, principal)
    .map(p => ({ id: p.id, full_name: p.full_name })).sort(byName);
  const visible = scope.visible ? new Set(scope.visible) : null;
  const repositories = visible
    ? granted.filter(r => visible.has(r.id))
    : granted.filter(p => !scope.tenant || !!store.get('SELECT 1 FROM identity_projects WHERE project_id=? AND tenant_id=?', p.id, scope.tenant));
  const hidden = granted.length - repositories.length;
  const pending = pendingInstalledRepositories(store, principal, scope.tenant);
  const identity = store.get(`SELECT status,credentials FROM external_identities
    WHERE principal_id=? AND provider='github' AND status<>'revoked' ORDER BY verified_at DESC LIMIT 1`, principal);
  const scopes = listEffectiveScopes(store, principal);
  const githubPending = scopes.some(g => g.source === 'github_derived' && g.state === 'pending_verification');
  const install_url = githubAppInstallUrl(store);
  const result = (state: GitHubConnectionState, status: string, next_step: string, action: GitHubConnectionAction,
    extra: { hidden?: number; tenant_name?: string | null } = {}): GitHubConnection =>
    ({ state, status, next_step, action, repository_count: repositories.length, repositories, pending_repositories: pending, install_url,
      hidden_repository_count: extra.hidden ?? 0, tenant_name: extra.tenant_name ?? null });

  if (!identity) {
    return result('disconnected', '尚未连接 GitHub', '连接 GitHub，然后选择要授权的仓库。', 'connect');
  }
  if (!identity.credentials) {
    return result('reauthorization_required', 'GitHub 授权已失效', '重新连接 GitHub 后再查看仓库。', 'reconnect');
  }
  // Started repositories the person can already open (including by explicit delegation) win over a pending
  // GitHub proof. Derived grants are themselves pending when the proof is, so they do not appear here.
  if (repositories.length) {
    return result('connected', `已连接 GitHub，可访问 ${repositories.length} 个仓库`, '可在项目列表中打开这些仓库。', null);
  }
  // Granted, but not in the list this session reads: say where they are instead of sending the person to an empty list.
  if (hidden && scope.tenant) {
    const name = store.get('SELECT display_name FROM tenants WHERE id=?', scope.tenant)?.display_name || scope.tenant;
    return result('outside_tenant', '已连接 GitHub，但当前组织下没有你能打开的项目',
      `你有权访问的 ${hidden} 个仓库不在当前组织「${name}」里。切换到「所有已授权组织与项目」后，就能在项目列表中打开。`, 'switch_tenant',
      { hidden, tenant_name: name });
  }
  if (hidden) {
    return result('not_listed', `已连接 GitHub，但项目列表暂时打不开这 ${hidden} 个仓库`,
      '请点「重新验证 GitHub 权限」后再打开项目列表；仍然看不到时，请联系管理员核对项目授权。', 'reverify',
      { hidden });
  }
  if (identity.status === 'pending_verification' || githubPending) {
    return result('pending_verification', 'GitHub 授权待验证', '重新验证 GitHub 权限；若安装还在同步，请稍后再试。', 'reverify');
  }
  if (pending.length) {
    return result('pending_activation',
      `已登录 GitHub，有 ${pending.length} 个仓库已安装但还没有被超级管理员启动`,
      '请联系超级管理员在控制台启动这些仓库。', 'wait_activation');
  }
  // "App not installed on my repos" and "I am not a repository Admin" look the same in stored data:
  // installations belong to the whole deployment, and verification does not persist non-admin membership.
  // A single state avoids telling the person they lack Admin rights on someone else's installation.
  return result('no_repositories', '已登录 GitHub，但还没有授权任何仓库',
    '请到 GitHub 选择要授权的仓库；你需要是这些仓库的管理员。若已经安装仍看不到，请联系管理员启动或委派。', 'choose_repos');
}
