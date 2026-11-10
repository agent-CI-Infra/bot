import type { Store } from '../storage/database.js';
import { digest, fail, randomId } from '../core/security.js';
import { invalidate, listEffectiveScopes, resolveActor, resolvePrincipalActor, restrictActor, type ActorContext } from './authorization.js';

export interface ExternalSubject { provider: string; host: string; connector: string; external_tenant: string; external_actor: string }
export interface VerifiedExternalProof extends ExternalSubject { proof_id: string; challenge: string; expires_at: number }
export type ProofVerifier = (credential: unknown) => Promise<VerifiedExternalProof | null>;
const subjectKeys = ['provider', 'host', 'connector', 'external_tenant', 'external_actor'] as const;
const valid = (subject: ExternalSubject) => subjectKeys.every(k => typeof subject[k] === 'string' && subject[k].length <= 256) && !!subject.provider && !!subject.host && !!subject.external_actor &&
  (subject.provider !== 'github' || subject.host === 'github.com' && !subject.connector && !subject.external_tenant && /^[1-9]\d*$/.test(subject.external_actor));

// A connector supplies its verifier in trusted server code. No HTTP endpoint accepts a self-asserted proof.
export class ExternalBindings {
  constructor(readonly store: Store, private readonly verify: ProofVerifier, private readonly assertProof: (proof: VerifiedExternalProof) => void = () => {}) {}
  // Association can precede project authorization. This never creates a scoped_grant.
  async beginVerifiedExternalBinding(sessionRef: string, credential: unknown): Promise<{ challenge: string; expires_at: number }> {
    const actor = resolveActor(this.store, sessionRef, { channel: 'api' }), proof = await this.verify(credential);
    if (!proof || !valid(proof) || !proof.proof_id || proof.expires_at <= Date.now()) return fail(403, 'binding_proof_mismatch');
    this.assertProof(proof);
    const challenge = randomId(), expires = Math.min(proof.expires_at, Date.now() + 5 * 60_000);
    this.store.run(`INSERT INTO bind_challenges(challenge_hash,principal_id,session_hash,tenant_id,provider,host,connector,external_tenant,external_actor,expires_at,verified_origin)
      VALUES(?,?,?,?,?,?,?,?,?,?,1)`, digest(challenge), actor.principal_id, digest(sessionRef), actor.tenant_id ?? '', ...subjectKeys.map(k => proof[k]), expires);
    return { challenge, expires_at: expires };
  }
  beginExternalBinding(sessionRef: string, subject: ExternalSubject): { challenge: string; expires_at: number } {
    const actor = resolveActor(this.store, sessionRef, { channel: 'api' });
    if (!actor.tenant_id) return fail(400, 'tenant_selection_required');
    if (!listEffectiveScopes(this.store, actor.principal_id).some(g => g.state === 'active' && (g.scope === 'platform' || g.tenant_id === actor.tenant_id))) return fail(403, 'tenant_forbidden');
    if (!valid(subject)) return fail(400, 'invalid_external_subject');
    const challenge = randomId(), expires = Date.now() + 5 * 60_000;
    this.store.run('INSERT INTO bind_challenges(challenge_hash,principal_id,session_hash,tenant_id,provider,host,connector,external_tenant,external_actor,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)', digest(challenge), actor.principal_id, digest(sessionRef),
      actor.tenant_id, ...subjectKeys.map(k => subject[k]), expires);
    return { challenge, expires_at: expires };
  }
  async completeExternalBinding(sessionRef: string, challenge: string, credential: unknown): Promise<{ identity_id: string; principal_id: string }> {
    const actor = resolveActor(this.store, sessionRef, { channel: 'api' }), proof = await this.verify(credential);
    const current = resolveActor(this.store, sessionRef, { channel: 'api' });
    if (current.principal_id !== actor.principal_id || current.tenant_id !== actor.tenant_id) return fail(403, 'binding_context_mismatch');
    return this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM bind_challenges WHERE challenge_hash=?', digest(challenge));
      if (!row || row.session_hash !== digest(sessionRef) || row.principal_id !== actor.principal_id || row.tenant_id !== (actor.tenant_id ?? '')) return fail(403, 'binding_context_mismatch');
      if (!row.verified_origin && !listEffectiveScopes(this.store, current.principal_id).some(g => g.state === 'active' && (g.scope === 'platform' || g.tenant_id === current.tenant_id))) return fail(403, 'tenant_forbidden');
      if (!proof || !valid(proof) || !proof.proof_id || proof.challenge !== challenge || proof.expires_at <= Date.now() ||
        subjectKeys.some(k => row[k] !== proof[k])) return fail(403, 'binding_proof_mismatch');
      this.assertProof(proof);
      if (row.identity_id) {
        const identity = this.store.get("SELECT * FROM external_identities WHERE id=? AND status='active'", row.identity_id);
        if (!identity || row.proof_id !== proof.proof_id) return fail(409, 'binding_replayed');
        return { identity_id: identity.id, principal_id: identity.principal_id };
      }
      if (row.expires_at <= Date.now()) return fail(410, 'binding_expired');
      if (this.store.get('SELECT 1 FROM bind_challenges WHERE provider=? AND connector=? AND proof_id=?', proof.provider, proof.connector, proof.proof_id)) return fail(409, 'binding_replayed');
      const previous = this.store.get('SELECT * FROM external_identities WHERE provider=? AND host=? AND connector=? AND external_tenant=? AND external_actor=?', ...subjectKeys.map(k => proof[k]));
      // A revoked mapping remains owned by the original principal, preventing account reassignment.
      if (previous && previous.principal_id !== actor.principal_id) return fail(409, 'external_identity_conflict');
      const id = previous?.id || randomId();
      if (previous) this.store.run("UPDATE external_identities SET status='active',verified_at=? WHERE id=?", Date.now(), id);
      else this.store.run(`INSERT INTO external_identities(id,principal_id,provider,host,connector,external_tenant,external_actor,display_name,status,verified_at)
        VALUES(?,?,?,?,?,?,?,?,'active',?)`, id, actor.principal_id, ...subjectKeys.map(k => proof[k]), proof.external_actor, Date.now());
      this.store.run('UPDATE bind_challenges SET identity_id=?,proof_id=? WHERE challenge_hash=? AND identity_id IS NULL', id, proof.proof_id, digest(challenge));
      invalidate(this.store, actor.principal_id, 'identity.bound'); this.store.audit(actor.principal_id, 'identity.bound', id);
      return { identity_id: id, principal_id: actor.principal_id };
    });
  }
  revokeExternalBinding(sessionRef: string, identityId: string): void {
    const actor = resolveActor(this.store, sessionRef);
    this.store.transaction(() => revokeIdentity(this.store, actor.principal_id, identityId));
  }
  async resolveExternalPrincipal(credential: unknown): Promise<string | null> {
    const proof = await this.verify(credential);
    if (!proof || !valid(proof) || !proof.proof_id || proof.expires_at <= Date.now()) return null;
    this.assertProof(proof);
    const row = this.store.get(`SELECT e.principal_id FROM external_identities e JOIN principals p ON p.id=e.principal_id
      WHERE provider=? AND host=? AND connector=? AND external_tenant=? AND external_actor=? AND status='active' AND p.active=1`, ...subjectKeys.map(k => proof[k]));
    return row?.principal_id || null;
  }
  async resolveExternalActor(credential: unknown, tenant: string | null, project: string | undefined, guard: () => void): Promise<ActorContext> {
    const proof = await this.verify(credential), principal = await this.resolveExternalPrincipal(credential);
    if (!proof || !principal) return fail(403, 'external_binding_required');
    const actor = resolvePrincipalActor(this.store, principal, tenant, project, 'im');
    return restrictActor(actor, () => {
      guard();
      if (!this.store.get(`SELECT 1 FROM external_identities WHERE provider=? AND host=? AND connector=? AND external_tenant=? AND external_actor=? AND principal_id=? AND status='active'`,
        ...subjectKeys.map(k => proof[k]), principal)) fail(403, 'external_binding_required');
    });
  }
}
export function revokeIdentity(store: Store, principal: string, id: string): void {
  const row = store.get('SELECT * FROM external_identities WHERE id=? AND principal_id=?', id, principal);
  if (!row) return fail(404, 'identity_not_found');
  if (row.status === 'revoked') return;
  store.run("UPDATE external_identities SET status='revoked',credentials=NULL WHERE id=?", id);
  if (row.provider === 'github') store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='github_derived'", Date.now(), principal);
  store.run('DELETE FROM sessions WHERE identity_id=?', id);
  invalidate(store, principal, 'identity.revoked'); store.audit(principal, 'identity.revoked', id);
}
export const beginExternalBinding = (service: ExternalBindings, ...args: Parameters<ExternalBindings['beginExternalBinding']>) => service.beginExternalBinding(...args);
export const completeExternalBinding = (service: ExternalBindings, ...args: Parameters<ExternalBindings['completeExternalBinding']>) => service.completeExternalBinding(...args);
export const revokeExternalBinding = (service: ExternalBindings, ...args: Parameters<ExternalBindings['revokeExternalBinding']>) => service.revokeExternalBinding(...args);
export const resolveExternalPrincipal = (service: ExternalBindings, ...args: Parameters<ExternalBindings['resolveExternalPrincipal']>) => service.resolveExternalPrincipal(...args);
