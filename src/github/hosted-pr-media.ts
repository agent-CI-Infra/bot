import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { digest, fail } from '../core/security.js';
import { installationExecutionDenied } from '../installations/archive.js';
import { deploymentOrigin, publicOrigin, verifiedOrigin } from '../onboarding/public-url.js';
import type { Store } from '../storage/database.js';

const prefix = '/pr-media/';
const tokenPattern = /^[a-f0-9]{64}$/;
const mimeTypes = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['mp4', 'video/mp4'], ['webm', 'video/webm'],
]);

export const hostedMediaType = (format: string) => mimeTypes.get(format);
export const invokesHostedMedia = (target: string) => /^\/pr-media(?:[/?]|$)/.test(target);

export type HostedPullRequestMedia = { origin: string; tokens: Record<string, string> };

export function hostedMediaStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS hosted_pr_media(
    token_hash TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    blob_hash TEXT NOT NULL, format TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hosted_pr_media_repository ON hosted_pr_media(repository_id)`);
}

export function hostedMediaOrigin(store: Store): string | undefined {
  try { return publicOrigin(verifiedOrigin(store) || deploymentOrigin(process.env)); } catch { return undefined; }
}

/** Store a hash of the bearer token and reuse the immutable byte snapshot. No HTTP input can select its path. */
export function registerHostedMedia(store: Store, repositoryId: string, blobHash: string, format: string, bytes: number): string {
  const token = randomBytes(32).toString('hex');
  store.run('INSERT INTO hosted_pr_media(token_hash,repository_id,blob_hash,format,bytes) VALUES(?,?,?,?,?)',
    digest(token), repositoryId, blobHash, format, bytes);
  return token;
}

export function hostedMediaUrl(hosted: HostedPullRequestMedia | undefined, asset: string): string | undefined {
  const token = hosted?.tokens?.[asset];
  return hosted && typeof token === 'string' && tokenPattern.test(token) ? hosted.origin + prefix + token : undefined;
}

export function serveHostedMedia(store: Store, req: IncomingMessage, res: ServerResponse): void {
  // Match the raw request before URL normalization so alternate spellings and dot segments never reach lookup.
  const token = req.url?.slice(prefix.length) ?? '';
  if (!['GET', 'HEAD'].includes(req.method ?? '') || !req.url?.startsWith(prefix) || !tokenPattern.test(token))
    return fail(404, 'hosted_media_not_found');
  const row = store.get(`SELECT m.*,r.account_id FROM hosted_pr_media m JOIN repositories r ON r.id=m.repository_id
    JOIN trajectory_blobs b ON b.repository_id=m.repository_id AND b.sha256=m.blob_hash WHERE m.token_hash=?`, digest(token));
  const mime = row && hostedMediaType(row.format);
  if (!row || !mime || installationExecutionDenied(store, String(row.account_id), String(row.repository_id)))
    return fail(404, 'hosted_media_not_found');
  let bytes: Buffer;
  try {
    const saved = store.trajectories.getBlob(row.blob_hash);
    if (typeof saved !== 'string') return fail(404, 'hosted_media_not_found');
    bytes = Buffer.from(saved, 'base64');
  } catch { return fail(404, 'hosted_media_not_found'); }
  if (bytes.length !== row.bytes) return fail(404, 'hosted_media_not_found');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(mime.startsWith('video/') ? { 'Content-Disposition': `attachment; filename="recording.${row.format}"` } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
