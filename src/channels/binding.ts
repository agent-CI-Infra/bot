import type { Store, Row } from '../storage/database.js';
import { ExternalBindings, revokeIdentity, type ExternalSubject, type VerifiedExternalProof } from '../identity/bindings.js';
import { resolveActor } from '../identity/authorization.js';
import { digest, fail, randomId, type Json } from '../core/security.js';
import type { ChannelEvent } from './types.js';

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
  begin(e: ChannelEvent): { challenge: string; expires_at: number } {
    this.source(e); if (e.chat_type !== 'p2p') return fail(403, 'binding_private_chat_required');
    const challenge = randomId(), expires = Date.now() + 5 * 60_000, hash = digest(challenge);
    this.store.run('INSERT INTO channel_bind_requests(challenge_hash,connector_id,subject,expires_at) VALUES(?,?,?,?)',
      hash, e.connector_id, this.store.secrets.seal(e, 'channel-bind:' + hash), expires);
    return { challenge, expires_at: expires };
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
    const link = this.store.get('SELECT challenge_hash FROM channel_oauth_links WHERE state_hash=?', digest(state));
    if (!link) return null;
    const row = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=?', link.challenge_hash)!;
    if (row.expires_at <= Date.now() || row.consumed_at || row.principal_id || row.oauth_state !== digest(state)) return fail(410, 'binding_expired');
    const actor = resolveActor(this.store, sessionRef), e = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash) as unknown as ChannelEvent;
    if (!this.store.get("SELECT 1 FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", actor.principal_id)) fail(403, 'github_reauthentication_required');
    const binding = await this.identities.beginVerifiedExternalBinding(sessionRef, this.credential(e, '', row.expires_at));
    const confirm = randomId();
    this.store.transaction(() => {
      const current = this.store.get('SELECT * FROM channel_bind_requests WHERE challenge_hash=?', row.challenge_hash)!;
      if (current.principal_id || current.consumed_at || current.expires_at <= Date.now()) fail(409, 'binding_replayed');
      this.store.run('UPDATE channel_bind_requests SET principal_id=?,session_ref=?,binding_ref=?,confirmation_hash=? WHERE challenge_hash=?', actor.principal_id,
        this.store.secrets.seal({ value: sessionRef }, 'channel-session:' + row.challenge_hash),
        this.store.secrets.seal({ ...binding, confirmation: confirm }, 'channel-challenge:' + row.challenge_hash), digest(confirm), row.challenge_hash);
      this.store.run('DELETE FROM channel_oauth_links WHERE state_hash=?', digest(state));
    });
    return e;
  }
  pending(principal: string): Json[] {
    return this.store.all('SELECT * FROM channel_bind_requests WHERE principal_id=? AND consumed_at IS NULL AND expires_at>?', principal, Date.now()).map(row => {
      const e = this.store.secrets.open(row.subject, 'channel-bind:' + row.challenge_hash) as unknown as ChannelEvent;
      const binding = this.store.secrets.open(row.binding_ref, 'channel-challenge:' + row.challenge_hash);
      return { provider: 'feishu', app_id: e.app_id, installation_tenant: e.installation_tenant, actor_tenant: e.actor_tenant,
        open_id: e.actor_id, confirmation: binding.confirmation, expires_at: row.expires_at,
        github: this.store.get("SELECT display_name,external_actor FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", principal) ?? null };
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
