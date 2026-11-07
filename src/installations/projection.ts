import type { Store, Row } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { accountRef, emitInstallationEvent, installationRef, numericId, queueInstallationSync, safeSyncError } from './archive.js';

export interface SyncClaim { accountId: string; generation: number; token: string; attemptId: string }
export function claimInstallationSync(store: Store, accountId: string): SyncClaim | null {
  return store.transaction(() => {
    const job = store.get('SELECT * FROM installation_sync_jobs WHERE account_id=?', accountId), now = Date.now();
    if (job?.state === 'running' && job.lease_until > now) return null;
    if (!job || job.state === 'idle') queueInstallationSync(store, accountId);
    const generation = Number(store.get('SELECT generation FROM installation_sync_jobs WHERE account_id=?', accountId)!.generation);
    const token = randomId(), attemptId = randomId();
    store.run("UPDATE installation_sync_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE account_id=?", token, now + 60_000, accountId);
    // An expired lease's unfinished attempt is retained as recovery evidence.
    store.run("UPDATE installation_sync_attempts SET result='lease_expired',finished_at=? WHERE account_id=? AND result='running'", new Date().toISOString(), accountId);
    store.run("INSERT INTO installation_sync_attempts VALUES(?,?,?,?,NULL,'running',NULL)", attemptId, accountId, generation, new Date().toISOString());
    return { accountId, generation, token, attemptId };
  });
}
export function assertSyncClaim(store: Store, claim: SyncClaim): void {
  if (!store.get(`SELECT 1 FROM installation_sync_jobs WHERE account_id=? AND generation=? AND lease_token=? AND lease_until>?`,
    claim.accountId, claim.generation, claim.token, Date.now())) throw new Error('github_installation_sync_superseded');
}
export function finishInstallationSync(store: Store, claim: SyncClaim, error?: unknown): void {
  store.transaction(() => {
    const job = store.get('SELECT * FROM installation_sync_jobs WHERE account_id=?', claim.accountId);
    if (job?.lease_token !== claim.token) return;
    const superseded = job.generation !== claim.generation || (error as Error)?.message === 'github_installation_sync_superseded';
    const code = error && !superseded ? safeSyncError(error) : null;
    store.run(`UPDATE installation_sync_attempts SET finished_at=?,result=?,error=? WHERE id=?`,
      new Date().toISOString(), superseded ? 'superseded' : code ? 'retry' : 'succeeded', code, claim.attemptId);
    store.run(`UPDATE installation_sync_jobs SET state=?,completed_generation=CASE WHEN ? THEN completed_generation ELSE ? END,
      lease_token=NULL,lease_until=0,last_error=?,next_attempt=?,attempts=CASE WHEN ? THEN 0 ELSE attempts END WHERE account_id=? AND lease_token=?`,
      superseded ? 'pending' : code ? 'retry' : 'idle', Number(!!error || superseded), claim.generation, code,
      code ? Date.now() + Math.min(10 * 60_000, 1000 * 2 ** Math.min(job.attempts, 9)) : 0, Number(!error && !superseded), claim.accountId, claim.token);
    if (code) store.run("UPDATE github_installations SET completeness='error',last_error=? WHERE account_id=? AND status<>'deleted'", code, claim.accountId);
    if (!error && !superseded) store.run(`UPDATE installation_events SET result='synchronized' WHERE account_id=?
      AND result IN ('waiting_sync','revocation_applied')`, claim.accountId);
  });
}

export function validateInstallation(installation: Json, appId: string): void {
  const target = installation.account as Json | undefined;
  if (!numericId(installation.id) || !numericId(target?.id) || !['User', 'Organization'].includes(String(target?.type)) ||
    typeof target?.login !== 'string' || !['all', 'selected'].includes(String(installation.repository_selection)) ||
    (installation.app_id !== undefined && String(installation.app_id) !== appId) ||
    !installation.permissions || typeof installation.permissions !== 'object' || Array.isArray(installation.permissions) ||
    Object.entries(installation.permissions).some(([key, value]) => !/^[a-z_]+$/.test(key) || !['read', 'write', 'admin'].includes(String(value))) ||
    !Array.isArray(installation.events) || installation.events.some(event => typeof event !== 'string' || !/^[a-z_]+$/.test(event)))
    throw new Error('github_invalid_installation');
}

// Called only after every installation and repository page succeeded, in the snapshot's commit transaction.
export function commitInstallationProjection(store: Store, account: Row, installations: Json[], repos: Row[], now: string): void {
  const seen = new Set<string>();
  for (const installation of installations) {
    const id = String(installation.id), ref = installationRef(accountRef(account, id)), target = installation.account as Json;
    seen.add(ref);
    store.run(`INSERT OR IGNORE INTO github_installations(ref,github_host,app_id,installation_id,account_id,updated_at)
      VALUES(?,'github.com',?,?,?,?)`, ref, String(account.app_id), id, account.id, now);
    const before = store.get('SELECT * FROM github_installations WHERE ref=?', ref)!;
    // Deleted installation IDs are terminal. Suspension recovery has already received an authoritative reread.
    const status = before.status === 'deleted' ? 'deleted' : installation.suspended_at ? 'suspended' : 'active';
    const permissions = JSON.stringify(installation.permissions), events = JSON.stringify(installation.events);
    const previousIds = store.all('SELECT repository_id FROM installation_repositories WHERE installation_ref=? AND present=1', ref).map(r => r.repository_id);
    const incoming = status === 'active' ? repos.filter(r => r.installation_id === id) : [];
    const removed = previousIds.filter(repositoryId => !incoming.some(r => r.repository_id === repositoryId));
    const scopeChanged = status !== before.status || before.repository_selection !== installation.repository_selection ||
      previousIds.length !== incoming.length || removed.length > 0 || incoming.some(r => {
        const old = store.get('SELECT * FROM installation_repositories WHERE installation_ref=? AND repository_id=?', ref, r.repository_id);
        return !old || old.full_name !== r.full_name || old.owner_id !== r.owner_id || old.private !== Number(r.private);
      });
    const permissionsChanged = permissions !== before.permissions || events !== before.events;
    const changed = scopeChanged || permissionsChanged || before.target_login !== target.login || before.target_id !== String(target.id) ||
      before.completeness !== 'complete' || !!before.scope_pending;
    store.run(`UPDATE github_installations SET account_id=?,target_id=?,target_type=?,target_login=?,repository_selection=?,
      permissions=?,events=?,status=?,completeness='complete',scope_pending=0,
      revision=revision+?,scope_version=scope_version+?,permissions_version=permissions_version+?,last_success_at=?,last_error=NULL,updated_at=? WHERE ref=?`,
      account.id, String(target.id), String(target.type), String(target.login), String(installation.repository_selection),
      permissions, events, status, Number(changed), Number(scopeChanged), Number(permissionsChanged), now, now, ref);
    store.run('UPDATE installation_repositories SET present=0 WHERE installation_ref=?', ref);
    for (const r of incoming) store.run(`INSERT INTO installation_repositories VALUES(?,?,?,?,?,?,1,?)
      ON CONFLICT(installation_ref,repository_id) DO UPDATE SET full_name=excluded.full_name,owner_id=excluded.owner_id,
      owner_login=excluded.owner_login,private=excluded.private,present=1,last_success_at=excluded.last_success_at`,
      ref, r.repository_id, r.full_name, r.owner_id, r.owner_login, Number(r.private), now);
    if (status !== 'active') store.run('UPDATE installed_repositories SET installed=0 WHERE account_id=? AND installation_id=?', account.id, id);
    const row = store.get('SELECT * FROM github_installations WHERE ref=?', ref)!;
    if (changed) emitInstallationEvent(store, row, 'installation.changed', 'authoritative_sync');
    if (removed.length || (status !== 'active' && before.status !== status) || permissionsChanged && before.last_success_at)
      emitInstallationEvent(store, row, 'installation.access_revoked', 'authoritative_sync', removed);
  }
  for (const old of store.all('SELECT * FROM github_installations WHERE account_id=?', account.id)) {
    if (seen.has(old.ref)) continue;
    if (old.status === 'deleted') {
      if (old.completeness !== 'complete' || old.scope_pending || old.last_error) {
        store.run(`UPDATE github_installations SET completeness='complete',scope_pending=0,last_error=NULL,
          revision=revision+1,last_success_at=?,updated_at=? WHERE ref=?`, now, now, old.ref);
        emitInstallationEvent(store, store.get('SELECT * FROM github_installations WHERE ref=?', old.ref)!, 'installation.changed', 'authoritative_sync');
      }
      continue;
    }
    store.run(`UPDATE github_installations SET status='deleted',completeness='complete',scope_pending=0,
      revision=revision+1,scope_version=scope_version+1,last_success_at=?,last_error=NULL,updated_at=? WHERE ref=?`, now, now, old.ref);
    store.run('UPDATE installation_repositories SET present=0 WHERE installation_ref=?', old.ref);
    const row = store.get('SELECT * FROM github_installations WHERE ref=?', old.ref)!;
    emitInstallationEvent(store, row, 'installation.changed', 'authoritative_sync');
    emitInstallationEvent(store, row, 'installation.access_revoked', 'authoritative_sync');
  }
  // Stable repository IDs survive renames/transfers. Administrative activation and hidden flags are never changed here.
  for (const r of repos) {
    const collision = store.get('SELECT id FROM repositories WHERE full_name=? AND id<>?', r.full_name, r.repository_id);
    if (!collision) store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=? AND account_id=?', r.full_name, r.owner_id, r.repository_id, account.id);
  }
}
