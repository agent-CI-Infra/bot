import type { Row, Store } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import { renewBeforeMs, revokeInstallationToken } from '../github/client.js';

/**
 * Read-only installation tokens of the member-cache sync (#1411), kept in control-plane memory: one per account,
 * installation and permission set, reused across rounds until less than renewBeforeMs remains. GitHub binds ETags to the
 * token, so only a reused token lets a conditional request answer 304.
 *
 * A token is revoked when it is replaced, when its account's credentials change, or when the cache is closed, but never
 * while a round still holds it: it is revoked when the last holder releases it. A token GitHub refused (401) is dropped
 * without a revoke. A token minted without a usable expiry is not kept and is revoked at its release, as before #1411.
 */
interface Entry {
  key: string; apiUrl: string; accountId: string; credentials: string; token: string; expiresAt: number;
  holders: number; retired: boolean; revoked: boolean;
}
interface Pool { tokens: Map<string, Entry>; minting: Map<string, Promise<Entry>> }
export interface ReadTokenLease {
  readonly token: string;
  /** Whether an earlier round minted this token. */
  readonly reused: boolean;
  /** Ends this round's use; `retire` also drops the token from the cache. Only the first call counts. */
  release(retire?: boolean): Promise<void>;
}

const pools = new WeakMap<Store, Pool>();
function pool(store: Store): Pool {
  let found = pools.get(store);
  if (!found) pools.set(store, found = { tokens: new Map(), minting: new Map() });
  return found;
}

async function revoke(entry: Entry): Promise<void> {
  if (entry.revoked || entry.holders) return;
  entry.revoked = true;
  await revokeInstallationToken(entry.apiUrl, entry.token).catch(() => false);
}

// Takes the token out of the cache; it is revoked now or, while held, by its last release. `gone`: GitHub no longer
// accepts it (expired or refused), so there is nothing to revoke.
function retire(store: Store, entry: Entry, gone = false): Promise<void> {
  const tokens = pool(store).tokens;
  if (tokens.get(entry.key) === entry) tokens.delete(entry.key);
  entry.retired = true;
  if (gone) entry.revoked = true;
  return revoke(entry);
}

function lease(store: Store, entry: Entry, reused: boolean): ReadTokenLease {
  entry.holders++;
  let released = false;
  return {
    token: entry.token, reused,
    async release(drop = false) {
      if (released) return;
      released = true; entry.holders--;
      if (drop && !entry.retired) await retire(store, entry);
      else if (entry.retired) await revoke(entry);
    },
  };
}

/**
 * A lease on the cached read-only token for this account, installation and permission set, minting one with `mint` (the
 * JWT `POST /app/installations/:id/access_tokens`) when none is usable. Concurrent callers share one mint.
 */
export async function acquireReadToken(store: Store, apiUrl: string, account: Row, installationId: string, permissions: Record<string, string>,
  mint: () => Promise<Json | null>): Promise<ReadTokenLease> {
  const { tokens, minting } = pool(store), now = Date.now();
  const key = JSON.stringify([apiUrl, String(account.id), installationId, Object.entries(permissions).sort()]);
  // Expired tokens are gone on GitHub already; a token whose account credentials changed or vanished is revoked.
  for (const entry of [...tokens.values()]) {
    if (entry.expiresAt <= now) await retire(store, entry, true);
    else if (store.get('SELECT credentials FROM accounts WHERE id=?', entry.accountId)?.credentials !== entry.credentials) await retire(store, entry);
  }
  const cached = tokens.get(key);
  if (cached && cached.credentials === account.credentials && cached.expiresAt - now >= renewBeforeMs) return lease(store, cached, true);
  if (cached) await retire(store, cached);
  let pending = minting.get(key);
  if (!pending) {
    pending = (async (): Promise<Entry> => {
      const access = await mint();
      if (typeof access?.token !== 'string' || !access.token) return fail(502, 'github_incomplete_evidence');
      const expiresAt = Date.parse(String(access.expires_at ?? ''));
      const entry: Entry = { key, apiUrl, accountId: String(account.id), credentials: String(account.credentials), token: access.token,
        expiresAt, holders: 0, revoked: false, retired: !(expiresAt - Date.now() >= renewBeforeMs) };
      if (!entry.retired) tokens.set(key, entry);
      return entry;
    })().finally(() => minting.delete(key));
    minting.set(key, pending);
  }
  return lease(store, await pending, false);
}

/** GitHub answered 401 to this token: the cache drops it, so the next lease mints a new one. */
export function refuseReadToken(store: Store, token: string): void {
  for (const entry of pool(store).tokens.values()) if (entry.token === token) void retire(store, entry, true);
}

/** Revokes every cached token of this store (on shutdown); tokens still held are revoked by their last release. */
export async function closeReadTokens(store: Store): Promise<void> {
  await Promise.all([...pool(store).tokens.values()].map(entry => retire(store, entry)));
}
