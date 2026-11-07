import { createHash } from 'node:crypto';
import type { Store, Row } from '../storage/database.js';
import { fail, randomId, type Json } from '../core/security.js';

export const installationContractVersion = 1;
export interface InstallationRef { github_host: string; app_id: string; installation_id: string }
export type InstallationStatus = 'active' | 'pending_sync' | 'suspended' | 'deleted';
export interface InstallationSnapshot extends Json {
  contract_version: 1; installation: InstallationRef;
  target: { id: string | null; type: string | null; login: string | null };
  status: InstallationStatus; completeness: 'pending' | 'stale' | 'error' | 'complete';
  repository_selection: 'all' | 'selected' | null; permissions: Record<string, string>; events: string[];
  projection_version: number; scope_version: number; permissions_version: number;
  last_success_at: string | null; error: string | null; execution_blocked: boolean;
  evidence: { history_missing: boolean; creation_event_id: string | null; sender: Json | null; requester: Json | null;
    approval: { status: 'unknown'; label: '批准者未知' } };
}
export interface InstallationDomainEvent {
  contract_version: 1; event_id: string; type: 'installation.changed' | 'installation.access_revoked';
  tenant: { github_host: string; account_id: string | null }; installation: InstallationRef;
  projection_version: number; scope_version: number; permissions_version: number; status: InstallationStatus;
  repository_ids: string[]; actor_ref: null; occurred_at: string; source: string;
}
export interface VerifiedInstallationAccess {
  github_user_id: string; target_id: string; repository_ids: string[] | null;
  can_manage: boolean; authorization_revision: string;
}
// Implemented by the identity module using the current GitHub user and official installation/repository APIs.
// A session or historical sender alone is never sufficient. Null denies all archive disclosure.
export interface InstallationIdentity {
  verifyInstallation(sessionRef: string, ref: InstallationRef): Promise<VerifiedInstallationAccess | null>;
}
export const installationRef = (ref: InstallationRef): string => {
  if (!/^[a-z0-9.-]+$/.test(ref.github_host) || !numericId(ref.app_id) || !numericId(ref.installation_id)) return fail(400, 'invalid_installation_ref');
  return `${ref.github_host}/${ref.app_id}/${ref.installation_id}`;
};
export const numericId = (value: unknown): string | null => /^(?:[1-9]\d*)$/.test(String(value ?? '')) &&
  (typeof value !== 'number' || Number.isSafeInteger(value)) ? String(value) : null;
export const accountRef = (account: Row, id: string): InstallationRef => ({ github_host: 'github.com', app_id: String(account.app_id), installation_id: id });
const person = (value: unknown): Json | null => {
  const user = value as Json | null;
  return user && numericId(user.id) ? { id: String(user.id), login: typeof user.login === 'string' ? user.login : '', type: typeof user.type === 'string' ? user.type : null } : null;
};
export const safeSyncError = (error: unknown): string => /^github_[a-z_0-9]+$/.test((error as Error)?.message || '') ? (error as Error).message : 'installation_sync_failed';

export function queueInstallationSync(store: Store, accountId: string): number {
  store.run(`INSERT INTO installation_sync_jobs(account_id,generation) VALUES(?,1)
    ON CONFLICT(account_id) DO UPDATE SET generation=generation+1,
    state=CASE WHEN state='running' THEN state ELSE 'pending' END,next_attempt=0`, accountId);
  return Number(store.get('SELECT generation FROM installation_sync_jobs WHERE account_id=?', accountId)!.generation);
}

export function emitInstallationEvent(store: Store, row: Row, type: 'installation.changed' | 'installation.access_revoked', source: string, repositoryIds: string[] = []): void {
  const eventId = `${row.ref}:${row.revision}:${type}`, now = new Date().toISOString();
  const data: InstallationDomainEvent = { contract_version: installationContractVersion, event_id: eventId, type, tenant: { github_host: row.github_host, account_id: row.target_id },
    installation: { github_host: row.github_host, app_id: row.app_id, installation_id: row.installation_id },
    projection_version: row.revision, scope_version: row.scope_version, permissions_version: row.permissions_version,
    status: row.status, repository_ids: repositoryIds, actor_ref: null, occurred_at: now, source };
  store.run(`INSERT OR IGNORE INTO installation_domain_events(event_id,type,installation_ref,revision,data,created_at) VALUES(?,?,?,?,?,?)`,
    eventId, type, row.ref, row.revision, JSON.stringify(data), now);
}

// Trusted downstream workers keep their own sequence cursor and deduplicate event_id before applying effects.
export function readInstallationDomainEvents(store: Store, after = 0, limit = 100): { sequence: number; event: InstallationDomainEvent }[] {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return fail(400, 'invalid_event_cursor');
  return store.all('SELECT sequence,data FROM installation_domain_events WHERE sequence>? ORDER BY sequence LIMIT ?', after, limit)
    .map(row => ({ sequence: Number(row.sequence), event: JSON.parse(row.data) }));
}

export function isInstallationControlEvent(event: string): boolean {
  return ['installation', 'installation_repositories', 'installation_target'].includes(event);
}

// Called only after signature verification and inside the delivery transaction; no network work occurs here.
export function archiveInstallationEvent(store: Store, accountId: string, endpointId: string, deliveryId: string,
  deliveryRecordId: string, event: string, payload: Json, bytes: Buffer): boolean {
  if (!isInstallationControlEvent(event)) return false;
  const account = store.get("SELECT * FROM accounts WHERE id=? AND type='github_app'", accountId);
  if (!account) return false;
  const installation = payload.installation as Json | undefined, id = numericId(installation?.id);
  if (!id || !numericId(account.app_id)) return false;
  const ref = installationRef(accountRef(account, id)), now = new Date().toISOString(), hash = createHash('sha256').update(bytes).digest('hex');
  const existing = store.get(`SELECT e.* FROM installation_events e JOIN github_installations g ON g.ref=e.installation_ref
    WHERE g.github_host='github.com' AND g.app_id=? AND e.delivery_id=?`, String(account.app_id), deliveryId);
  const eventId = existing?.id || randomId(), receiptId = randomId();
  store.run('INSERT INTO installation_receipts VALUES(?,?,?,?,?,?,?,?)', receiptId, eventId, deliveryRecordId, endpointId, now, hash,
    store.secrets.seal({ body: bytes.toString('base64') }, `installation-receipt:${receiptId}`), Number(!!existing));
  if (existing) return false;
  const target = (event === 'installation_target' ? payload.account : installation?.account) as Json | undefined;
  store.run(`INSERT OR IGNORE INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,target_login,updated_at)
    VALUES(?,'github.com',?,?,?,?,?,?,?)`, ref, String(account.app_id), id, accountId, numericId(target?.id), target?.type ? String(target.type) : null, target?.login ? String(target.login) : null, now);
  const before = store.get('SELECT * FROM github_installations WHERE ref=?', ref)!;
  const action = String(payload.action || ''), negative = event === 'installation' && ['deleted', 'suspend'].includes(action);
  const selection = payload.repository_selection || installation?.repository_selection;
  const contraction = before.repository_selection === 'all' && selection === 'selected';
  const removed = event === 'installation_repositories' && Array.isArray(payload.repositories_removed)
    ? payload.repositories_removed.map(r => numericId((r as Json)?.id)).filter((id): id is string => !!id) : [];
  // Positive payloads are evidence, never authority for restoring access. In particular created cannot undo a tombstone.
  const status = before.status === 'deleted' ? 'deleted' : negative ? action === 'deleted' ? 'deleted' : 'suspended' : before.status;
  store.run(`UPDATE github_installations SET revision=revision+1,scope_version=scope_version+1,
    status=?,completeness='stale',scope_pending=CASE WHEN ? THEN 1 ELSE scope_pending END,
    history_missing=CASE WHEN ? THEN 0 ELSE history_missing END,updated_at=? WHERE ref=?`,
    status, Number(contraction || negative),
    Number(event === 'installation' && action === 'created'), now, ref);
  if (negative) {
    store.run(`UPDATE installed_repositories SET installed=0 WHERE account_id IN
      (SELECT id FROM accounts WHERE type='github_app' AND app_id=?) AND installation_id=?`, String(account.app_id), id);
    store.run('UPDATE installation_repositories SET present=0 WHERE installation_ref=?', ref);
  }
  for (const repositoryId of removed) {
    store.run(`UPDATE installed_repositories SET installed=0 WHERE account_id IN
      (SELECT id FROM accounts WHERE type='github_app' AND app_id=?) AND installation_id=? AND repository_id=?`, String(account.app_id), id, repositoryId);
    store.run('UPDATE installation_repositories SET present=0 WHERE installation_ref=? AND repository_id=?', ref, repositoryId);
  }
  const row = store.get('SELECT * FROM github_installations WHERE ref=?', ref)!;
  store.run('INSERT INTO installation_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', eventId, ref, accountId, endpointId,
    deliveryId, event, action, 1, now, hash, store.secrets.seal({ body: bytes.toString('base64') }, `installation-event:${eventId}`),
    JSON.stringify(person(payload.sender)), JSON.stringify(person(payload.requester)), 'signed_webhook',
    negative || removed.length ? 'revocation_applied' : 'waiting_sync', row.revision);
  emitInstallationEvent(store, row, 'installation.changed', eventId);
  if (negative || removed.length || contraction) emitInstallationEvent(store, row, 'installation.access_revoked', eventId, removed);
  queueInstallationSync(store, accountId);
  return true;
}

export function installationExecutionDenied(store: Store, accountId: string, repositoryId: string): boolean {
  const account = store.get('SELECT type,app_id FROM accounts WHERE id=?', accountId);
  if (account?.type !== 'github_app') return false;
  const row = store.get(`SELECT g.status,g.scope_pending,r.present FROM installation_repositories r
    JOIN github_installations g ON g.ref=r.installation_ref
    LEFT JOIN installed_repositories i ON i.account_id=? AND i.installation_id=g.installation_id AND i.repository_id=r.repository_id
    WHERE g.github_host='github.com' AND g.app_id=? AND r.repository_id=?
    ORDER BY CASE WHEN i.repository_id IS NOT NULL THEN 0 ELSE 1 END,r.present DESC,g.updated_at DESC LIMIT 1`, accountId, String(account.app_id), repositoryId);
  if (row) return row.status !== 'active' || !!row.scope_pending || !row.present;
  // An installation can be revoked before its repositories have ever been synchronized.
  return !!store.get(`SELECT 1 FROM github_installations g JOIN repositories r ON r.owner_id=g.target_id
    WHERE g.github_host='github.com' AND g.app_id=? AND r.id=? AND r.account_id=? AND (g.status<>'active' OR g.scope_pending=1)`, String(account.app_id), repositoryId, accountId);
}

export function installationSnapshot(store: Store, ref: string): InstallationSnapshot | null {
  const row = store.get('SELECT * FROM github_installations WHERE ref=?', ref); if (!row) return null;
  const created = store.get("SELECT id,sender,requester FROM installation_events WHERE installation_ref=? AND event='installation' AND action='created' ORDER BY rowid LIMIT 1", ref);
  // A creation actor and requester are recorded facts, not an independent approval record.
  return { contract_version: installationContractVersion, installation: { github_host: row.github_host, app_id: row.app_id, installation_id: row.installation_id },
    target: { id: row.target_id, type: row.target_type, login: row.target_login }, status: row.status,
    completeness: row.completeness, repository_selection: row.repository_selection, permissions: JSON.parse(row.permissions), events: JSON.parse(row.events),
    projection_version: row.revision, scope_version: row.scope_version, permissions_version: row.permissions_version,
    last_success_at: row.last_success_at, error: row.last_error, execution_blocked: row.status !== 'active' || !!row.scope_pending,
    evidence: { history_missing: !!row.history_missing, creation_event_id: created?.id || null,
      sender: created ? JSON.parse(created.sender) : null, requester: created ? JSON.parse(created.requester) : null,
      approval: { status: 'unknown', label: '批准者未知' } } };
}

export class InstallationArchive {
  constructor(readonly store: Store, readonly identity?: InstallationIdentity) {}
  private async authorize(sessionRef: string, ref: InstallationRef, manage = false): Promise<VerifiedInstallationAccess> {
    installationRef(ref);
    const access = await this.identity?.verifyInstallation(sessionRef, ref);
    if (!access || !numericId(access.github_user_id) || !numericId(access.target_id) || (manage && !access.can_manage)) return fail(403, 'installation_forbidden');
    const row = this.store.get('SELECT target_id FROM github_installations WHERE ref=?', installationRef(ref));
    if (row?.target_id && row.target_id !== access.target_id) return fail(403, 'installation_forbidden');
    return access;
  }
  async getInstallationSnapshot(sessionRef: string, ref: InstallationRef): Promise<InstallationSnapshot> {
    const access = await this.authorize(sessionRef, ref);
    // Installation-wide permissions/evidence are visible only after verifying the whole target account.
    if (access.repository_ids !== null) return fail(403, 'installation_target_access_required');
    return installationSnapshot(this.store, installationRef(ref)) || { contract_version: 1, installation: ref,
      target: { id: access.target_id, type: null, login: null }, status: 'pending_sync', completeness: 'pending',
      repository_selection: null, permissions: {}, events: [], projection_version: 0, scope_version: 0, permissions_version: 0,
      last_success_at: null, error: null, execution_blocked: true,
      evidence: { history_missing: true, creation_event_id: null, sender: null, requester: null, approval: { status: 'unknown', label: '批准者未知' } } };
  }
  async listInstallationRepositories(sessionRef: string, ref: InstallationRef): Promise<Json> {
    const access = await this.authorize(sessionRef, ref);
    const rows = this.store.all(`SELECT repository_id,full_name,owner_id,owner_login,private,present,last_success_at
      FROM installation_repositories WHERE installation_ref=? ORDER BY repository_id`, installationRef(ref));
    const snapshot = installationSnapshot(this.store, installationRef(ref));
    return { contract_version: 1, installation: ref, status: snapshot?.status || 'pending_sync', completeness: snapshot?.completeness || 'pending',
      execution_blocked: snapshot?.execution_blocked ?? true,
      projection_version: snapshot?.projection_version || 0, scope_version: snapshot?.scope_version || 0, permissions_version: snapshot?.permissions_version || 0,
      authorization_revision: access.authorization_revision,
      repositories: rows.filter(r => access.repository_ids === null || access.repository_ids.includes(r.repository_id))
        .map(row => ({ ...row, private: !!row.private, present: !!row.present })) };
  }
  async requestInstallationSync(sessionRef: string, ref: InstallationRef): Promise<Json> {
    await this.authorize(sessionRef, ref, true);
    const row = this.store.get('SELECT account_id FROM github_installations WHERE ref=?', installationRef(ref)) ||
      (ref.github_host === 'github.com' ? this.store.get("SELECT id AS account_id FROM accounts WHERE type='github_app' AND app_id=? ORDER BY created_at LIMIT 1", ref.app_id) : null);
    if (!row) return fail(409, 'installation_credentials_missing');
    if (!this.store.get('SELECT 1 FROM accounts WHERE id=?', row.account_id)) return fail(409, 'installation_credentials_missing');
    return this.store.transaction(() => ({ contract_version: 1, status: 'pending', generation: queueInstallationSync(this.store, row.account_id) }));
  }
}
