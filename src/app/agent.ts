/**
 * Delegated bot identity (#1 answer 1/3).
 *
 * A project administrator can mint a short-lived `botagent_…` token for one repository and a
 * small scope set. An external worker (for example a reviewer on a maintainer laptop) presents it
 * with `Authorization: Bearer …`; the control plane acts as the bot, so the worker never holds a
 * GitHub App key or a PAT. Tokens are stored hashed and can be revoked.
 */

import { type IncomingHttpHeaders } from 'node:http';
import { digest, fail, fields, randomId, text, type Json } from '../core/security.js';
import { type Store } from '../storage/database.js';
import { type Actor } from './auth.js';

export const AGENT_SCOPES = ['review:submit'] as const;
const TOKEN = /^Bearer (botagent_[a-f0-9]{48})$/;

export interface AgentActor {
  tokenId: string;
  repositoryId: string;
  subject: string;
  scopes: string[];
}

export type PublishReview = (
  store: Store, repositoryId: string, pullNumber: number, headSha: string, body: string,
) => Promise<{ id: string; url: string }>;

export function issueAgentToken(store: Store, user: Actor, repositoryId: string, body: Json): Json {
  fields(body, ['subject', 'scopes', 'ttl_seconds']);
  const subject = text(body.subject, 100);
  const scopes = body.scopes === undefined ? [...AGENT_SCOPES] : body.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 16
    || scopes.some(scope => typeof scope !== 'string' || !AGENT_SCOPES.includes(scope as typeof AGENT_SCOPES[number]))) {
    fail(400, 'invalid_agent_scopes');
  }
  const ttl = body.ttl_seconds === undefined ? 3600 : body.ttl_seconds;
  if (!Number.isSafeInteger(ttl) || Number(ttl) < 60 || Number(ttl) > 86_400) fail(400, 'invalid_agent_token_ttl');
  const id = randomId(), token = `botagent_${randomId()}`, expires = Date.now() + Number(ttl) * 1000;
  store.run(`INSERT INTO agent_tokens(id,repository_id,subject,scopes,token_hash,expires_at,created_at,created_by,revoked_at)
    VALUES(?,?,?,?,?,?,?,?,NULL)`, id, repositoryId, subject, JSON.stringify(scopes), digest(token), expires,
    new Date().toISOString(), user.id);
  store.audit(user.id, 'agent_token.created', id, repositoryId);
  return { id, token, subject, scopes, expires_at: new Date(expires).toISOString() };
}

export function listAgentTokens(store: Store, repositoryId: string): Json {
  return {
    tokens: store.all(`SELECT id,repository_id,subject,scopes,expires_at,created_at,created_by,revoked_at
      FROM agent_tokens WHERE repository_id=? ORDER BY created_at DESC`, repositoryId).map(row => ({
      ...row, scopes: safeScopes(row.scopes), expires_at: new Date(Number(row.expires_at)).toISOString(),
    })),
  };
}

export function revokeAgentToken(store: Store, user: Actor, tokenId: string): Json {
  const row = store.get('SELECT * FROM agent_tokens WHERE id=?', tokenId);
  if (!row) return fail(404, 'agent_token_not_found');
  if (!row.revoked_at) {
    store.run('UPDATE agent_tokens SET revoked_at=? WHERE id=?', new Date().toISOString(), tokenId);
    store.audit(user.id, 'agent_token.revoked', tokenId, String(row.repository_id));
  }
  return { ok: true };
}

export function agentActor(store: Store, headers: IncomingHttpHeaders): AgentActor {
  const match = TOKEN.exec(String(headers.authorization || ''));
  if (!match) return fail(401, 'agent_token_required');
  const row = store.get('SELECT * FROM agent_tokens WHERE token_hash=?', digest(match[1]!));
  if (!row || row.revoked_at || Number(row.expires_at) <= Date.now()) return fail(401, 'agent_token_invalid');
  if (!store.get('SELECT id FROM repositories WHERE id=?', row.repository_id)) return fail(401, 'agent_token_invalid');
  return { tokenId: String(row.id), repositoryId: String(row.repository_id), subject: String(row.subject), scopes: safeScopes(row.scopes) };
}

/**
 * Accept a review result from a delegated worker and publish it as the bot. The same
 * (token, PR, head, body) is idempotent: a retry returns the first publication.
 */
export async function submitAgentReview(
  store: Store, headers: IncomingHttpHeaders, body: Json, publish: PublishReview,
): Promise<Json> {
  const actor = agentActor(store, headers);
  if (!actor.scopes.includes('review:submit')) fail(403, 'agent_scope_required');
  fields(body, ['pull_number', 'head_sha', 'body']);
  const pullNumber = Number(body.pull_number);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) fail(400, 'invalid_pull_number');
  const headSha = text(body.head_sha, 40);
  if (!/^[a-f0-9]{40}$/.test(headSha)) fail(400, 'invalid_head_sha');
  const content = text(body.body, 60_000), bodyHash = digest(content);
  const existing = store.get(
    'SELECT * FROM external_reviews WHERE agent_token_id=? AND pull_number=? AND head_sha=? AND body_hash=?',
    actor.tokenId, pullNumber, headSha, bodyHash,
  );
  if (existing) return { id: existing.id, state: existing.state, duplicate: true, response: safeResponse(existing.response) };
  const id = randomId();
  store.run(`INSERT INTO external_reviews(id,repository_id,agent_token_id,pull_number,head_sha,body_hash,body,state,response,created_at)
    VALUES(?,?,?,?,?,?,?,'pending',NULL,?)`, id, actor.repositoryId, actor.tokenId, pullNumber, headSha, bodyHash, content, new Date().toISOString());
  try {
    const published = await publish(store, actor.repositoryId, pullNumber, headSha, content);
    store.run("UPDATE external_reviews SET state='sent', response=? WHERE id=?", JSON.stringify(published), id);
    return { id, state: 'sent', duplicate: false, response: published };
  } catch {
    store.run("UPDATE external_reviews SET state='failed' WHERE id=?", id);
    return fail(502, 'review_publish_failed');
  }
}

function safeScopes(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch { return []; }
}

function safeResponse(value: unknown): Json | null {
  try { return value ? JSON.parse(String(value)) as Json : null; } catch { return null; }
}
