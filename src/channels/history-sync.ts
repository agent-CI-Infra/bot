import type { Row, Store } from '../storage/database.js';
import { digest, HttpError, randomId } from '../core/security.js';
import { ChannelHistoryError, ChannelRateLimitError, type FeishuAdapter } from './feishu.js';
import { ChannelLedger } from './ledger.js';

/** Persistent ingestion jobs have their own leases; they never consume business task execution slots. */
export class ChannelHistorySync {
  private busy = false;
  private stopped = false;
  constructor(readonly store: Store, readonly ledger: ChannelLedger, readonly adapter: (connector: Row, guard: () => void) => FeishuAdapter) {}
  close(): void { this.stopped = true; }
  private claim(id: string, now: number): Row | undefined {
    return this.store.transaction(() => {
      const token = randomId();
      const result = this.store.run(`UPDATE channel_sync_jobs SET state='running',lease_token=?,lease_until=?,updated_at=?
        WHERE id=? AND state IN ('pending','retry','running') AND next_attempt<=? AND lease_until<=?`, token, now + 120000, now, id, now, now);
      return result.changes ? this.store.get('SELECT * FROM channel_sync_jobs WHERE id=?', id) : undefined;
    });
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const chat of this.store.all('SELECT * FROM channel_chats WHERE retention_days IS NOT NULL')) {
        const before = Math.floor(now / 86400000) * 86400000 - chat.retention_days * 86400000;
        if (before > chat.retained_after) this.ledger.cleanup(chat.id, before, chat.revision);
      }
      const jobs = this.store.all(`SELECT j.id FROM channel_sync_jobs j JOIN channel_chats h ON h.id=j.chat_id
        JOIN channel_connectors c ON c.id=h.connector_id WHERE h.state='active' AND c.enabled=1 AND c.app_id=h.app_id
        AND c.installation_tenant=h.installation_tenant AND j.state IN ('pending','retry','running') AND j.next_attempt<=? AND j.lease_until<=?
        ORDER BY j.updated_at,j.id LIMIT 10`, now, now);
      for (const candidate of jobs) {
        if (this.stopped) return;
        const job = this.claim(candidate.id, now); if (!job) continue;
        const chat = this.store.get('SELECT * FROM channel_chats WHERE id=?', job.chat_id)!;
        const connector = this.store.get('SELECT * FROM channel_connectors WHERE id=?', chat.connector_id)!;
        const guard = () => {
          if (this.stopped) throw new HttpError(409, 'channel_sync_stopped');
          const current = this.store.get('SELECT * FROM channel_connectors WHERE id=?', connector.id);
          const currentChat = this.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id);
          const lease = this.store.get('SELECT lease_token,lease_until FROM channel_sync_jobs WHERE id=?', job.id);
          if (!current?.enabled || current.revision !== connector.revision || current.app_id !== chat.app_id || current.installation_tenant !== chat.installation_tenant ||
            currentChat?.state !== 'active' || currentChat.connector_id !== connector.id || lease?.lease_token !== job.lease_token || !lease || lease.lease_until <= Date.now())
            throw new HttpError(409, 'channel_sync_source_changed');
        };
        try {
          guard();
          const page = await this.adapter(connector, guard).history(job);
          guard();
          this.store.transaction(() => {
            guard();
            if (page.has_more && (!page.page_token || page.page_token === job.page_token || this.store.get(
              'SELECT 1 FROM channel_sync_cursors WHERE job_id=? AND generation=? AND token_hash=?', job.id, job.generation, digest(page.page_token))))
              throw new ChannelHistoryError('channel_history_cursor_stalled', true);
            // Explicit retention cleanup can commit while history() is awaiting HTTP.
            // Use the boundary in this transaction, never the pre-request snapshot.
            const currentChat = this.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id)!;
            for (const message of page.items) this.ledger.merge(currentChat, message, 'history');
            if (page.has_more) this.store.run('INSERT INTO channel_sync_cursors VALUES(?,?,?)', job.id, job.generation, digest(page.page_token));
            else this.store.run('INSERT INTO channel_sync_ranges VALUES(?,?,?,?)', job.id, job.generation, job.start_time, job.end_time);
            // Message writes and cursor advancement either both commit, or both roll back.
            this.store.run(`UPDATE channel_sync_jobs SET state=?,page_token=?,covered_until=?,pages=pages+1,messages=messages+?,
              attempts=0,last_error=NULL,next_attempt=0,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?`,
              page.has_more ? 'pending' : 'complete', page.page_token, page.has_more ? job.covered_until : job.end_time,
              page.items.length, Date.now(), job.id, job.lease_token);
          });
        } catch (error) {
          if (this.stopped) return;
          const permanent = error instanceof ChannelHistoryError && error.permanent;
          const delay = error instanceof ChannelRateLimitError ? error.retryAfterMs : Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12));
          this.store.run(`UPDATE channel_sync_jobs SET state=?,attempts=attempts+1,last_error=?,next_attempt=?,lease_token=NULL,lease_until=0,updated_at=?
            WHERE id=? AND lease_token=?`, permanent ? 'blocked' : 'retry', error instanceof HttpError ? error.code : 'channel_history_failed', Date.now() + delay, Date.now(), job.id, job.lease_token);
        }
      }
    } finally { this.busy = false; }
  }
}
