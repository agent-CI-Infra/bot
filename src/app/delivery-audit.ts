import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Store } from '../storage/database.js';
import type { Json } from '../core/security.js';

// A webhook that is refused (unknown endpoint, bad signature, oversized body) is still worth an audit row, but never at
// the sender's chosen size: one row is a digest, the refused archive keeps at most 500 rows within 7 days, and every
// bound here is readable from the delivery list so hitting a limit is visible instead of silent.
export const rejectedAudit = Object.freeze({ summaryBytes: 256, headerBytes: 1024, maxRows: 500, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
// Every outcome a refusal can have; a closed set so each query reaches delivery_status_time by its first column instead
// of scanning deliveries for NOT accepted.
export const rejectedStatuses = ['unknown_endpoint', 'invalid_signature', 'payload_too_large', 'invalid_payload', 'missing_event_or_delivery'] as const;
const REJECTED = `(${rejectedStatuses.map(() => '?').join(',')})`;
const PRUNED_TOTAL = 'deliveries.rejected_pruned_total';

/** What is kept for a refused request: the outcome, the received length and a digest, never the body. */
export function rejectionSummary(outcome: string, bytes: Buffer, truncated: boolean): Buffer {
  return Buffer.from(JSON.stringify({ rejected: outcome, bytes: bytes.length, truncated,
    sha256: createHash('sha256').update(bytes).digest('hex') }));
}

/** Only the headers that identify the delivery; a sender cannot inflate a refused row with other header values. */
export function rejectionHeaders(headers: IncomingHttpHeaders): Json {
  const pick = (name: string, max: number) => String(headers[name] ?? '').slice(0, max);
  return { 'x-github-event': pick('x-github-event', 100), 'x-github-delivery': pick('x-github-delivery', 200),
    'content-type': pick('content-type', 80), 'user-agent': pick('user-agent', 120) };
}

/** Drops refused rows past the age window and makes room for one new refused row inside the row cap. */
export function pruneRejectedArchive(store: Store, now: number): void {
  let pruned = Number(store.run(`DELETE FROM deliveries WHERE status IN ${REJECTED} AND received_at<?`,
    ...rejectedStatuses, new Date(now - rejectedAudit.maxAgeMs).toISOString()).changes || 0);
  const rows = Number(store.get(`SELECT count(*) AS n FROM deliveries WHERE status IN ${REJECTED}`, ...rejectedStatuses)!.n);
  if (rows >= rejectedAudit.maxRows) pruned += Number(store.run(`DELETE FROM deliveries WHERE id IN
    (SELECT id FROM deliveries WHERE status IN ${REJECTED} ORDER BY received_at,id LIMIT ?)`,
    ...rejectedStatuses, rows - rejectedAudit.maxRows + 1).changes || 0);
  if (!pruned) return;
  const total = Number(store.get('SELECT value FROM settings WHERE key=?', PRUNED_TOTAL)?.value || 0) + pruned;
  store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', PRUNED_TOTAL, String(total));
}

/** The refused archive as it stands, with the bounds it enforces, for the delivery list. */
export function rejectedArchiveState(store: Store): Json {
  const row = store.get(`SELECT count(*) AS rows,COALESCE(sum(length(payload)),0) AS bytes FROM deliveries WHERE status IN ${REJECTED}`, ...rejectedStatuses)!;
  return { rows: Number(row.rows), bytes: Number(row.bytes),
    pruned_total: Number(store.get('SELECT value FROM settings WHERE key=?', PRUNED_TOTAL)?.value || 0),
    max_rows: rejectedAudit.maxRows, max_age_ms: rejectedAudit.maxAgeMs,
    summary_bytes: rejectedAudit.summaryBytes, header_bytes: rejectedAudit.headerBytes };
}
