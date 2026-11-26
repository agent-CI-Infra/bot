import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir as mkdirAsync, open as openAsync } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Row, Store } from './database.js';
import { addColumns, segment } from './trajectories.js';

// Bodies of accepted webhook deliveries (#1403), one file each beside the database: <webhook-bodies>/<project>/<first two
// characters of the row id>/<row id>, the bytes as received. The deliveries row keeps an empty payload, the file in
// payload_ref, its sha256 and size in payload_sha256 / payload_bytes (the columns the retention cleanup keeps for a body
// it removed) and, in payload_summary, the few fields the console's delivery list shows. A body of at most
// inlineDeliveryBytes, a refused request's digest and a row the background migration has not reached keep their bytes
// in payload. deliveryBody() returns the same bytes for every one of them.
//
// One file per delivery, not an append-only file per day: the retention cleanup removes bodies one delivery at a time
// (a delivery an external executor still has to receive keeps its body), and a file can only be removed whole.

export const inlineDeliveryBytes = 2048;

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export class DeliveryBodyError extends Error {
  /** cause: the file system error behind a body file that could not be read (ENOENT, or EMFILE while out of descriptors). */
  constructor(readonly code: 'delivery_body_missing' | 'delivery_body_corrupt' | 'delivery_body_ref_invalid', readonly detail: string, options?: { cause?: unknown }) {
    super(code + ': ' + detail, options);
  }
}

/** Columns of a body kept outside the row; adding a column does not read the table's rows. */
export function webhookBodyStorage(store: Store): void {
  addColumns(store.db, 'deliveries', { payload_sha256: 'TEXT', payload_bytes: 'INTEGER', payload_removed_at: 'TEXT', payload_ref: 'TEXT', payload_summary: 'TEXT' });
}

export interface StoredBody { ref: string; sha256: string; bytes: number }

/** The path of a delivery's body relative to the directory; a project's bodies share its directory. */
export function deliveryBodyRef(repositoryId: string | null | undefined, id: string): string {
  return `${segment(repositoryId ?? '_')}/${segment(id.slice(0, 2))}/${segment(id)}`;
}

function bodyPath(store: Store, ref: string): string {
  const root = resolve(store.webhookBodiesDir), path = resolve(root, ref);
  if (!path.startsWith(root + sep)) throw new DeliveryBodyError('delivery_body_ref_invalid', String(ref).slice(0, 200));
  return path;
}

/** Writes a body and waits until it is on disk, off the event loop: a row may point to it once this resolves. */
export async function writeDeliveryBody(store: Store, repositoryId: string | null | undefined, id: string, body: Buffer): Promise<StoredBody> {
  const ref = deliveryBodyRef(repositoryId, id), path = bodyPath(store, ref);
  await mkdirAsync(dirname(path), { recursive: true, mode: 0o700 });
  const file = await openAsync(path, 'w', 0o600);
  try { await file.writeFile(body); await file.datasync(); } finally { await file.close(); }
  return { ref, sha256: sha256(body), bytes: body.length };
}

/**
 * Writes a body without waiting for the disk; the background migration syncs it (syncDeliveryBody) and reads it back
 * before any row points to it. The path depends only on the row, so writing it again replaces an earlier attempt.
 */
export function writeDeliveryBodyUnsynced(store: Store, repositoryId: string | null | undefined, id: string, body: Buffer): StoredBody {
  const ref = deliveryBodyRef(repositoryId, id), path = bodyPath(store, ref);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
  return { ref, sha256: sha256(body), bytes: body.length };
}

/** Waits until a body written by writeDeliveryBodyUnsynced is on disk (fdatasync), off the event loop. */
export async function syncDeliveryBody(store: Store, ref: string): Promise<void> {
  const file = await openAsync(bodyPath(store, ref), 'r+');
  try { await file.datasync(); } finally { await file.close(); }
}

/** A delivery's body as received: read from its file and checked against the sha256 in the row, or the row's own bytes. */
export function deliveryBody(store: Store, row: Row): Buffer {
  if (!row.payload_ref) return Buffer.from((row.payload ?? new Uint8Array()) as Uint8Array);
  let data: Buffer;
  try { data = readFileSync(bodyPath(store, String(row.payload_ref))); }
  catch (error) { if (error instanceof DeliveryBodyError) throw error; throw new DeliveryBodyError('delivery_body_missing', String(row.payload_ref), { cause: error }); }
  if (sha256(data) !== row.payload_sha256) throw new DeliveryBodyError('delivery_body_corrupt', String(row.payload_ref));
  return data;
}

/** Removes a body file the row no longer points to; one already gone is fine. */
export function removeDeliveryBody(store: Store, ref: string): void {
  rmSync(bodyPath(store, ref), { force: true });
}

/** Removes every body of a deleted project, after its rows are committed. */
export function removeProjectDeliveryBodies(store: Store, repositoryId: string): void {
  rmSync(join(resolve(store.webhookBodiesDir), segment(repositoryId)), { recursive: true, force: true });
}

/**
 * The fields of a body the console's delivery list reads (deliveryResult), in the body's own shape, so the list reads
 * a summary exactly like the body it stands for: repository name, action, number, and the issue's or pull request's
 * number, PR marker, draft flag and head sha. null for a body that is not a JSON object.
 */
export function deliverySummary(body: Buffer): string | null {
  let payload: any;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
  const repository = object(payload.repository), issue = object(payload.issue), pr = object(payload.pull_request);
  return JSON.stringify({
    ...(typeof payload.action === 'string' ? { action: payload.action } : {}),
    ...(payload.number !== undefined ? { number: payload.number } : {}),
    ...(repository && typeof repository.full_name === 'string' ? { repository: { full_name: repository.full_name } } : {}),
    ...(issue ? { issue: { number: issue.number, ...(issue.pull_request ? { pull_request: {} } : {}) } } : {}),
    ...(pr ? { pull_request: { number: pr.number, draft: pr.draft, head: { sha: object(pr.head)?.sha } } } : {}),
  });
}
