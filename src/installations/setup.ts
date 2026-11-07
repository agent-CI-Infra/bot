import type { Store } from '../storage/database.js';
import { digest, fail, randomId, type Json } from '../core/security.js';
import { accountRef, InstallationArchive, installationRef, numericId, queueInstallationSync, type InstallationIdentity } from './archive.js';

// This service correlates an opaque OAuth/session reference. It does not implement OAuth or assign console roles.
export class InstallationSetup {
  readonly archive: InstallationArchive;
  constructor(readonly store: Store, identity?: InstallationIdentity) { this.archive = new InstallationArchive(store, identity); }
  begin(accountId: string, expectedTargetId: string | null = null): { state: string; expires_in: number } {
    if (!this.store.get("SELECT 1 FROM accounts WHERE id=? AND type='github_app'", accountId)) return fail(404, 'account_not_found');
    const state = randomId(), now = Date.now();
    if (expectedTargetId !== null && !numericId(expectedTargetId)) return fail(400, 'invalid_installation_target');
    this.store.run('INSERT INTO installation_setup_states VALUES(?,?,NULL,NULL,?,NULL,?,?)', digest(state), accountId, expectedTargetId, now + 30 * 60_000, new Date(now).toISOString());
    return { state, expires_in: 1800 };
  }
  // Trusted identity-module entry point, after validating its own OAuth state. Never accepts a user ID from HTTP input.
  bindIdentity(state: string, identitySessionRef: string): void {
    this.store.transaction(() => {
      const row = this.state(state);
      if (!identitySessionRef || row.identity_session_ref && row.identity_session_ref !== identitySessionRef) return fail(409, 'installation_identity_conflict');
      this.store.run('UPDATE installation_setup_states SET identity_session_ref=? WHERE state_hash=?', identitySessionRef, digest(state));
    });
  }
  private state(state: string) {
    if (!/^[a-f0-9]{48}$/.test(state)) return fail(400, 'invalid_installation_state');
    const row = this.store.get('SELECT * FROM installation_setup_states WHERE state_hash=? AND expires_at>?', digest(state), Date.now());
    if (!row) return fail(400, 'invalid_installation_state');
    return row;
  }
  async callback(state: string, installationId: string, action: string): Promise<Json> {
    this.store.transaction(() => {
      const row = this.state(state);
      if (!['install', 'update', 'request'].includes(action)) return fail(400, 'invalid_setup_action');
      if (action !== 'request' && !numericId(installationId)) return fail(400, 'invalid_installation_id');
      if (row.installation_id && row.installation_id !== installationId) return fail(409, 'installation_callback_conflict');
      this.store.run('UPDATE installation_setup_states SET installation_id=?,setup_action=? WHERE state_hash=?',
        action === 'request' ? row.installation_id : installationId, action, digest(state));
    });
    return this.resume(state);
  }
  async resume(state: string): Promise<Json> {
    const row = this.state(state);
    if (!row.identity_session_ref) return { contract_version: 1, status: 'waiting_identity' };
    if (!row.installation_id) return { contract_version: 1, status: row.setup_action === 'request' ? 'waiting_approval' : 'waiting_setup' };
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', row.account_id);
    if (!account) return { contract_version: 1, status: 'waiting_configuration' };
    const ref = accountRef(account, row.installation_id);
    // Verifying a session's current relationship precedes any projection/scope disclosure or synchronization request.
    const access = await this.archive.identity?.verifyInstallation(row.identity_session_ref, ref);
    if (!access || !numericId(access.github_user_id) || !numericId(access.target_id)) return fail(403, 'installation_forbidden');
    if (row.expected_target_id && row.expected_target_id !== access.target_id) return fail(403, 'installation_forbidden');
    const projection = this.store.get('SELECT * FROM github_installations WHERE ref=?', installationRef(ref));
    if (projection?.target_id && projection.target_id !== access.target_id) return fail(403, 'installation_forbidden');
    if (!projection || projection.completeness !== 'complete') {
      // Repeated callbacks attach to the same durable work rather than advancing its generation indefinitely.
      this.store.transaction(() => {
        const job = this.store.get('SELECT state FROM installation_sync_jobs WHERE account_id=?', row.account_id);
        if (!job || job.state === 'idle') queueInstallationSync(this.store, row.account_id);
      });
      return { contract_version: 1, status: 'waiting_sync' };
    }
    return { contract_version: 1, status: projection.status === 'active' && !projection.scope_pending ? 'ready' : 'access_revoked' };
  }
}
