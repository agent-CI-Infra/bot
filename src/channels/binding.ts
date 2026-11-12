import type { Store, Row } from '../storage/database.js';
import { ExternalBindings, revokeIdentity, type ExternalSubject, type VerifiedExternalProof } from '../identity/bindings.js';
import { assertCurrent, resolveActor } from '../identity/authorization.js';
import { digest, fail, randomId, type Json } from '../core/security.js';
import type { ChannelEvent } from './types.js';
import { applicationVisible } from './applications.js';

export const externalSubject = (e: ChannelEvent): ExternalSubject => ({ provider: e.provider, host: 'open.feishu.cn',
  connector: e.connector_id + ':' + e.app_id, external_tenant: e.actor_tenant, external_actor: e.actor_id });
export class ChannelBindings {
  readonly identities: ExternalBindings;
  private readonly proofs = new WeakMap<object, VerifiedExternalProof>();
  private readonly sources = new WeakMap<VerifiedExternalProof, ChannelEvent>();
  constructor(readonly store: Store, private readonly source: (e: ChannelEvent) => void) {
    this.identities = new ExternalBindings(store, async credential => credential && typeof credential === 'object' ? this.proofs.get(credential) ?? null : null,
      proof => { const event = this.sources.get(proof); if (!event) fail(403, 'binding_proof_mismatch'); this.source(event!); });
  }
  credential(e: ChannelEvent, challenge = '', expires = Date.now() + 60_000): object {
    this.source(e);
    const credential = {};
    const proof = { ...externalSubject(e), proof_id: e.connector_id + ':' + e.event_id, challenge, expires_at: expires };
    this.proofs.set(credential, proof); this.sources.set(proof, e);
    return credential;
  }
  begin(e: ChannelEvent): { challenge: string; code: string; expires_at: number } {
    this.source(e); if (e.chat_type !== 'p2p') return fail(403, 'binding_private_chat_required');
    const challenge = randomId(), code = 'FSB-' + randomId(), expires = Date.now() + 5 * 60_000, hash = digest(challenge);
    this.store.run('INSERT INTO channel_bind_requests(challenge_hash,connector_id,subject,expires_at,code_hash) VALUES(?,?,?,?,?)',
      hash, e.connector_id, this.store.secrets.seal(e, 'channel-bind:' + hash), expires, digest(code));
    return { challenge, code, expires_at: expires };
  }
  // A console-initiated request exists before any private-chat message: the web session, the chosen bot and a one-time
  // code are recorded together. The first private-chat message carrying that code completes the binding in one step, so
  // the person never pastes a code back into the console (#236).
  issue(connectorId: string, sessionRef: string): { request_id: string; code: string; expires_at: number } {
    const connector = this.store.get('SELECT * FROM channel_connectors WHERE id=? AND enabled=1', connectorId);
    if (!connector) return fail(404, 'channel_connector_not_found');
    const actor = resolveActor(this.store, sessionRef), challenge = randomId(), code = 'FSB-' + randomId(), expires = Date.now() + 5 * 60_000;
    this.assertVisible(connectorId, actor.principal_id);
    const placeholder: ChannelEvent = { provider: 'feishu', connector_id: connectorId, connector_revision: Number(connector.revision), app_id: connector.app_id,
      installation_tenant: connector.installation_tenant, actor_tenant: '', actor_id: '', chat_id: '', chat_type: 'p2p',
      message_id: '', event_id: 'console:' + challenge, thread_id: '', created_at: Date.now(), kind: 'message', content: '' };
    const hash = digest(challenge);
    this.store.transaction(() => {
      // One account has at most one usable string per bot: issuing a new one retires every earlier code that was never
      // used, so a message left over in the chat cannot bind after the person asked for a fresh string.
      this.store.run('UPDATE channel_bind_requests SET superseded_at=? WHERE principal_id=? AND connector_id=? AND code_hash IS NOT NULL' +
        ' AND consumed_at IS NULL AND superseded_at IS NULL', Date.now(), actor.principal_id, connectorId);
      this.store.run('INSERT INTO channel_bind_requests(challenge_hash,connector_id,subject,expires_at,code_hash,principal_id,session_ref) VALUES(?,?,?,?,?,?,?)',
        hash, connectorId, this.store.secrets.seal(placeholder, 'channel-bind:' + hash), expires, digest(code), actor.principal_id,
        this.store.secrets.seal({ value: sessionRef }, 'channel-session:' + hash));
    });
    return { request_id: hash, code, expires_at: expires };
  }
  requestStatus(id: string, sessionRef: string): Json {
    const actor = resolveActor(this.store, sessionRef);
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=? AND principal_id=?', id, actor.principal_id);
    if (!row || !row.code_hash) return fail(404, 'binding_request_not_found');
    this.assertVisible(row.connector_id, actor.principal_id);
    const result = { request_id: id, expires_at: Number(row.expires_at) };
    // The identity transaction may have committed before the channel receipt was updated or the process restarted.
    let identityId = row.identity_id;
    if (!identityId && row.binding_ref) {
      const binding = this.store.secrets.open(row.binding_ref, 'channel-challenge:' + row.challenge_hash);
      identityId = this.store.get('SELECT identity_id FROM bind_challenges WHERE challenge_hash=? AND principal_id=?',
        digest(String(binding.challenge)), actor.principal_id)?.identity_id;
    }
    if (identityId) {
      const identity = this.store.get('SELECT id,status FROM external_identities WHERE id=? AND principal_id=?', identityId, actor.principal_id);
      if (!identity || identity.status !== 'active') return { ...result, state: 'revoked' };
      return { ...result, state: 'completed', identity_id: identity.id };
    }
    if (row.superseded_at) return { ...result, state: 'superseded' };
    if (row.expires_at <= Date.now()) return { ...result, state: 'expired' };
    const connector = this.store.get('SELECT app_id,installation_tenant,enabled,revision FROM channel_connectors WHERE id=?', row.connector_id);
    const issued = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash);
    if (!connector?.enabled || connector.app_id !== issued.app_id || connector.installation_tenant !== issued.installation_tenant
      || issued.connector_revision && Number(connector.revision) !== issued.connector_revision)
      return { ...result, state: 'invalidated' };
    if (!row.session_ref) return { ...result, state: 'invalidated' };
    try {
      const original = resolveActor(this.store, String(this.store.secrets.open(row.session_ref, 'channel-session:' + row.challenge_hash).value));
      if (original.principal_id !== actor.principal_id) return { ...result, state: 'invalidated' };
    } catch (error) {
      if ([401,403].includes(Number((error as { status?: number }).status))) return { ...result, state: 'invalidated' };
      throw error;
    }
    return { ...result, state: row.consumed_at || row.confirmation_hash ? 'processing' : 'pending' };
  }
  // The private-chat message is the proof: it replaces the placeholder subject before the proof is minted, then the same
  // consume-first confirmation the link flow uses runs, so a replayed code cannot bind twice.
  async redeem(code: string, e: ChannelEvent): Promise<Json> {
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE code_hash=?', digest(code));
    if (!row || row.connector_id !== e.connector_id) return fail(403, 'binding_code_invalid');
    if (row.consumed_at) return fail(409, 'binding_replayed');
    if (row.superseded_at) return fail(409, 'binding_superseded');
    if (row.expires_at <= Date.now()) return fail(410, 'binding_expired');
    if (e.chat_type !== 'p2p') return fail(403, 'binding_private_chat_required');
    if (!row.principal_id || !row.session_ref) return fail(409, 'binding_code_needs_console');
    if (row.binding_ref || row.confirmation_hash) return fail(409, 'binding_login_already_started');
    this.source(e);
    const issued = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash);
    if (issued.app_id !== e.app_id || issued.installation_tenant !== e.installation_tenant
      || issued.connector_revision && issued.connector_revision !== e.connector_revision) return fail(403, 'binding_code_invalid');
    const sessionRef = String(this.store.secrets.open(row.session_ref, 'channel-session:' + row.challenge_hash).value);
    const actor = resolveActor(this.store, sessionRef);
    if (actor.principal_id !== row.principal_id) return fail(403, 'binding_session_changed');
    this.assertVisible(row.connector_id, actor.principal_id);
    const claim = digest(randomId()), confirm = randomId(), confirmation = digest(confirm);
    // Claim and save the sender before the first await: a second sender must not replace the first one's proof.
    if (this.store.run('UPDATE channel_bind_requests SET subject=?,confirmation_hash=? WHERE challenge_hash=? AND consumed_at IS NULL' +
      ' AND binding_ref IS NULL AND confirmation_hash IS NULL AND superseded_at IS NULL AND expires_at>?',
      this.store.secrets.seal(e, 'channel-bind:' + row.challenge_hash), claim, row.challenge_hash, Date.now()).changes !== 1) fail(409, 'binding_replayed');
    try {
      const binding = await this.identities.beginVerifiedExternalBinding(sessionRef, this.credential(e, '', row.expires_at));
      this.store.transaction(() => {
        const current = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=?', row.challenge_hash)!;
        if (current.superseded_at) fail(409, 'binding_superseded');
        if (current.consumed_at || current.binding_ref || current.confirmation_hash !== claim || current.expires_at <= Date.now()) fail(409, 'binding_replayed');
        assertCurrent(actor);
        this.assertVisible(row.connector_id, actor.principal_id);
        this.store.run('UPDATE channel_bind_requests SET binding_ref=?,confirmation_hash=? WHERE challenge_hash=?',
          this.store.secrets.seal({ ...binding, confirmation: confirm }, 'channel-challenge:' + row.challenge_hash), confirmation, row.challenge_hash);
      });
      return await this.confirm(e, confirm);
    } catch (error) {
      this.store.run('UPDATE channel_bind_requests SET superseded_at=coalesce(superseded_at,?) WHERE challenge_hash=? AND identity_id IS NULL' +
        ' AND confirmation_hash IN (?,?)', Date.now(), row.challenge_hash, claim, confirmation);
      throw error;
    }
  }
  async confirmCode(code: string, connector: string, sessionRef: string): Promise<Json> {
    // The private-chat code is independent of the legacy navigation link, which cannot complete a binding.
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE code_hash=?', digest(code));
    if (!row || row.connector_id !== connector) return fail(403, 'binding_code_invalid');
    if (row.consumed_at) return fail(409, 'binding_replayed');
    if (row.expires_at <= Date.now()) return fail(410, 'binding_expired');
    if (row.oauth_state || row.principal_id) return fail(409, 'binding_login_already_started');
    const e = await this.authenticateRequest(row, sessionRef);
    const current = this.store.get('SELECT binding_ref FROM channel_bind_requests WHERE challenge_hash=?', row.challenge_hash)!;
    const binding = this.store.secrets.open(current.binding_ref, 'channel-challenge:' + row.challenge_hash);
    return this.confirm(e, String(binding.confirmation));
  }
  request(challenge: string): Row {
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=?', digest(challenge));
    if (!row || row.expires_at <= Date.now()) return fail(410, 'binding_expired');
    if (row.consumed_at) return fail(409, 'binding_replayed');
    this.source(this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash) as unknown as ChannelEvent);
    return row;
  }
  associateOAuth(challenge: string, oauthState: string): void {
    this.store.transaction(() => {
      const row = this.request(challenge);
      if (row.oauth_state) fail(409, 'binding_login_already_started');
      this.store.run('INSERT INTO channel_oauth_links VALUES(?,?)', digest(oauthState), row.challenge_hash);
      this.store.run('UPDATE channel_bind_requests SET oauth_state=? WHERE challenge_hash=?', digest(oauthState), row.challenge_hash);
    });
  }
  async githubAuthenticated(state: string, sessionRef: string): Promise<ChannelEvent | null> {
    // Resume OAuth links issued by older versions, or an explicitly chosen GitHub login.
    const link = this.store.get('SELECT challenge_hash FROM channel_oauth_links WHERE state_hash=?', digest(state));
    if (!link) return null;
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=?', link.challenge_hash)!;
    if (row.oauth_state !== digest(state)) return fail(410, 'binding_expired');
    return this.authenticateRequest(row, sessionRef);
  }
  async authenticate(challenge: string, sessionRef: string): Promise<ChannelEvent> {
    return this.authenticateRequest(this.request(challenge), sessionRef);
  }
  private async authenticateRequest(row: Row, sessionRef: string): Promise<ChannelEvent> {
    if (row.expires_at <= Date.now() || row.consumed_at) return fail(410, 'binding_expired');
    if (row.principal_id) return fail(409, 'binding_login_already_started');
    const actor = resolveActor(this.store, sessionRef), e = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash) as unknown as ChannelEvent;
    this.assertVisible(row.connector_id, actor.principal_id);
    const binding = await this.identities.beginVerifiedExternalBinding(sessionRef, this.credential(e, '', row.expires_at));
    const confirm = randomId();
    this.store.transaction(() => {
      const current = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=?', row.challenge_hash)!;
      if (current.principal_id || current.consumed_at || current.expires_at <= Date.now()) fail(409, 'binding_replayed');
      assertCurrent(actor); this.source(e);
      this.store.run('UPDATE channel_bind_requests SET principal_id=?,session_ref=?,binding_ref=?,confirmation_hash=? WHERE challenge_hash=?', actor.principal_id,
        this.store.secrets.seal({ value: sessionRef }, 'channel-session:' + row.challenge_hash),
        this.store.secrets.seal({ ...binding, confirmation: confirm }, 'channel-challenge:' + row.challenge_hash), digest(confirm), row.challenge_hash);
      this.store.run('DELETE FROM channel_oauth_links WHERE challenge_hash=?', row.challenge_hash);
    });
    return e;
  }
  /** Only people who may see an organization's app bind through it (#424); a platform-wide app is open to every account. */
  private assertVisible(connector: string, principal: string): void {
    const app = this.store.get('SELECT * FROM channel_connectors WHERE id=?', connector);
    if (app && !applicationVisible(this.store, principal, app)) fail(403, 'channel_application_forbidden');
  }
  pending(principal: string): Json[] {
    return this.store.all('SELECT * FROM channel_bind_requests WHERE principal_id=? AND consumed_at IS NULL AND binding_ref IS NOT NULL AND expires_at>?', principal, Date.now()).map(row => {
      const e = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash) as unknown as ChannelEvent;
      const binding = this.store.secrets.open(row.binding_ref, 'channel-challenge:' + row.challenge_hash);
      const app = this.store.get('SELECT app_name,tenant_name FROM channel_connectors WHERE id=? AND app_id=? AND installation_tenant=?', row.connector_id, e.app_id, e.installation_tenant);
      return { provider: 'feishu', app_id: e.app_id, installation_tenant: e.installation_tenant, actor_tenant: e.actor_tenant,
        app_name: app?.app_name || '', tenant_name: app?.tenant_name || '',
        open_id: e.actor_id, confirmation: binding.confirmation, expires_at: row.expires_at,
        account: { id: principal, username: this.store.get('SELECT username FROM users WHERE id=?', principal)?.username || principal } };
    });
  }
  async confirm(e: ChannelEvent, confirmation: string): Promise<Json> {
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE confirmation_hash=?', digest(confirmation));
    if (!row) return fail(403, 'binding_confirmation_invalid');
    if (row.consumed_at) return fail(409, 'binding_replayed');
    if (row.expires_at <= Date.now()) return fail(410, 'binding_expired');
    const original = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash) as unknown as ChannelEvent;
    if (e.chat_type !== 'p2p' || ['connector_id', 'app_id', 'installation_tenant', 'actor_tenant', 'actor_id', 'chat_id', 'thread_id'].some(k => e[k as keyof ChannelEvent] !== original[k as keyof ChannelEvent]))
      return fail(403, 'binding_operator_mismatch');
    const session = String(this.store.secrets.open(row.session_ref, 'channel-session:' + row.challenge_hash).value);
    const binding = this.store.secrets.open(row.binding_ref, 'channel-challenge:' + row.challenge_hash);
    // Consume before the asynchronous proof verifier: parallel/replayed confirmations cannot both commit.
    if (this.store.run('UPDATE channel_bind_requests SET consumed_at=? WHERE challenge_hash=? AND consumed_at IS NULL', Date.now(), row.challenge_hash).changes !== 1) fail(409, 'binding_replayed');
    const result = await this.identities.completeExternalBinding(session, String(binding.challenge), this.credential(e, String(binding.challenge), row.expires_at));
    this.store.run('UPDATE channel_bind_requests SET identity_id=?,session_ref=NULL,binding_ref=NULL WHERE challenge_hash=?', result.identity_id, row.challenge_hash);
    return result;
  }
  async unlink(e: ChannelEvent): Promise<void> {
    if (e.chat_type !== 'p2p') fail(403, 'binding_private_chat_required');
    const principal = await this.identities.resolveExternalPrincipal(this.credential(e));
    if (!principal) return fail(403, 'external_binding_required');
    const s = externalSubject(e), row = this.store.get('SELECT id FROM external_identities WHERE provider=? AND host=? AND connector=? AND external_tenant=? AND external_actor=?', s.provider, s.host, s.connector, s.external_tenant, s.external_actor)!;
    this.store.transaction(() => revokeIdentity(this.store, principal, row.id));
  }
}
