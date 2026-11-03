import type { Store } from '../storage/database.js';

// GitHub limits requests per credential and per hour-long window: an App's own JWT, each installation (one organization or
// user; its tokens are shared by everything working there, task agents included) and a bot account's user. Every response
// reports the window it counts against: the limit, what is left and when it resets. The latest report is kept per bucket
// and resource, so a task waits for the window to reset instead of sending into it, and the global settings show it.
export interface Bucket { key: string, kind: 'app' | 'installation' | 'user', account_id: string, installation_id?: string | null, owner?: string | null }
export const appBucket = (accountId: string): Bucket => ({ key: 'app:' + accountId, kind: 'app', account_id: accountId });
export const userBucket = (accountId: string): Bucket => ({ key: 'user:' + accountId, kind: 'user', account_id: accountId });
export const installationBucket = (accountId: string, installationId: string, owner?: string | null): Bucket =>
  ({ key: 'installation:' + installationId, kind: 'installation', account_id: accountId, installation_id: installationId, owner: owner || null });
// The windows shown; GitHub reports others (code scanning uploads, manifests) that the bot does not use.
export const shownResources = ['core', 'graphql', 'search'];

export function rateLimitStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS github_rate_limits(bucket TEXT NOT NULL,resource TEXT NOT NULL,kind TEXT NOT NULL,account_id TEXT NOT NULL,
    installation_id TEXT,owner TEXT,quota INTEGER,remaining INTEGER,used INTEGER,reset_at INTEGER,limited_until INTEGER,observed_at TEXT NOT NULL,
    PRIMARY KEY(bucket,resource))`);
}
interface Window { quota: number, remaining: number, used: number, reset_at: number | null }
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
  : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null;
export function record(store: Store, bucket: Bucket, resource: string, window: Window): void {
  store.run(`INSERT INTO github_rate_limits(bucket,resource,kind,account_id,installation_id,owner,quota,remaining,used,reset_at,limited_until,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(bucket,resource) DO UPDATE SET kind=excluded.kind,account_id=excluded.account_id,
    installation_id=COALESCE(excluded.installation_id,installation_id),owner=COALESCE(excluded.owner,owner),quota=excluded.quota,
    remaining=excluded.remaining,used=excluded.used,reset_at=excluded.reset_at,observed_at=excluded.observed_at`,
  bucket.key, resource.slice(0, 40), bucket.kind, bucket.account_id, bucket.installation_id || null, bucket.owner || null,
  window.quota, window.remaining, window.used, window.reset_at, new Date().toISOString());
}
// The window a response reports in its x-ratelimit-* headers; a response without them changes nothing.
export function observe(store: Store, bucket: Bucket, headers: Headers): void {
  const quota = count(headers.get('x-ratelimit-limit')), remaining = count(headers.get('x-ratelimit-remaining')), reset = count(headers.get('x-ratelimit-reset'));
  if (quota === null || remaining === null) return;
  record(store, bucket, headers.get('x-ratelimit-resource') || 'core', { quota, remaining, used: count(headers.get('x-ratelimit-used')) ?? quota - remaining, reset_at: reset === null ? null : reset * 1000 });
}
// The windows GET /rate_limit lists (that request is not counted against them).
export function observeAll(store: Store, bucket: Bucket, body: any): void {
  for (const resource of shownResources) {
    const value = body?.resources?.[resource], quota = count(value?.limit), remaining = count(value?.remaining), reset = count(value?.reset);
    if (quota !== null && remaining !== null) record(store, bucket, resource, { quota, remaining, used: count(value?.used) ?? quota - remaining, reset_at: reset === null ? null : reset * 1000 });
  }
}
// A refused request: the bucket waits until the window resets when it is used up, otherwise (a secondary limit, for
// requests sent too fast) for as long as GitHub asks, or a minute. Returns when requests may be sent again.
export function refused(store: Store, bucket: Bucket | undefined, headers: Headers, now = Date.now()): number {
  if (bucket) observe(store, bucket, headers);
  const retryAfter = count(headers.get('retry-after')), reset = count(headers.get('x-ratelimit-reset')), remaining = count(headers.get('x-ratelimit-remaining'));
  const until = retryAfter !== null ? now + retryAfter * 1000 : remaining === 0 && reset !== null && reset * 1000 > now ? reset * 1000 : now + 60_000;
  if (bucket) store.run(`INSERT INTO github_rate_limits(bucket,resource,kind,account_id,installation_id,owner,limited_until,observed_at) VALUES(?,'core',?,?,?,?,?,?)
    ON CONFLICT(bucket,resource) DO UPDATE SET limited_until=MAX(COALESCE(limited_until,0),excluded.limited_until),observed_at=excluded.observed_at`,
  bucket.key, bucket.kind, bucket.account_id, bucket.installation_id || null, bucket.owner || null, until, new Date(now).toISOString());
  return until;
}
// When the bucket's REST window can be used again, if it is used up or refused right now; null when requests may go.
export function blockedUntil(store: Store, bucket: Bucket, now = Date.now()): number | null {
  const row = store.get("SELECT remaining,reset_at,limited_until FROM github_rate_limits WHERE bucket=? AND resource='core'", bucket.key);
  const until = row ? Math.max(Number(row.limited_until || 0), row.remaining === 0 ? Number(row.reset_at || 0) : 0) : 0;
  return until > now ? until : null;
}
export function bucketName(bucket: Bucket): string {
  return bucket.kind === 'app' ? 'GitHub App 自身（JWT）' : bucket.kind === 'user' ? '机器人账号' : `安装 ${bucket.installation_id}${bucket.owner ? `（${bucket.owner}）` : ''}`;
}
export const utcTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

// The windows grouped by account, with how many tasks wait for each one to reset.
export function rateLimitView(store: Store, now = Date.now()) {
  const waiting = new Map<string, number>();
  for (const row of store.all(`SELECT a.id AS account_id,ir.installation_id,count(*) AS n FROM tasks t JOIN repositories r ON r.id=t.repository_id
      JOIN accounts a ON a.id=r.account_id LEFT JOIN installed_repositories ir ON ir.account_id=r.account_id AND ir.repository_id=r.id
      WHERE t.status='retry_wait' AND t.error_code='github_rate_limited' GROUP BY a.id,ir.installation_id`))
    waiting.set(row.installation_id ? 'installation:' + row.installation_id : 'user:' + row.account_id, Number(row.n));
  const accounts = new Map<string, any>();
  for (const row of store.all(`SELECT l.*,a.name AS account_name,a.type AS account_type FROM github_rate_limits l JOIN accounts a ON a.id=l.account_id
      ORDER BY a.created_at,a.id,CASE l.kind WHEN 'app' THEN 0 WHEN 'user' THEN 1 ELSE 2 END,l.owner,l.bucket,l.resource`)) {
    let account = accounts.get(row.account_id);
    if (!account) accounts.set(row.account_id, account = { account_id: row.account_id, name: row.account_name, type: row.account_type, buckets: [] });
    let bucket = account.buckets.find((b: any) => b.key === row.bucket);
    if (!bucket) account.buckets.push(bucket = { key: row.bucket, kind: row.kind, installation_id: row.installation_id, owner: row.owner, windows: [],
      blocked_until: blockedUntil(store, { key: row.bucket } as Bucket, now), waiting_tasks: waiting.get(row.bucket) || 0 });
    // A window whose reset has passed was replaced by a fresh one GitHub has not reported yet: its numbers are history.
    if (row.quota !== null) bucket.windows.push({ resource: row.resource, quota: row.quota, remaining: row.remaining, used: row.used,
      reset_at: row.reset_at, expired: !!row.reset_at && row.reset_at <= now, observed_at: row.observed_at });
  }
  return { now, accounts: [...accounts.values()] };
}
