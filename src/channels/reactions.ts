import type { Row, Store } from '../storage/database.js';
import { fail, HttpError } from '../core/security.js';
import { ChannelRateLimitError, type FeishuAdapter } from './feishu.js';
import type { ChannelEvent } from './types.js';

/** Best-effort receipt indicators have their own worker: a slow reaction must never hold up an answer. */
export class ChannelReactions {
  private readonly work = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(private readonly store: Store, private readonly adapter: (c: Row, guard: () => void) => FeishuAdapter,
    private readonly source: (e: ChannelEvent) => Row) {}
  close(): void { this.stopped = true; }
  async drain(): Promise<void> { await Promise.allSettled([...this.work.values()]); }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const rows = this.store.all(`SELECT r.*,i.payload FROM channel_reactions r JOIN channel_inbox i ON i.id=r.source_event
      WHERE r.state IN ('pending','adding','active','removing') AND r.next_attempt<=? ORDER BY r.next_attempt,r.rowid LIMIT ?`, Date.now(), 20 + this.work.size);
    const started: Promise<void>[] = [];
    for (const row of rows) {
      if (this.work.size >= 20) break;
      if (this.work.has(row.source_event)) continue;
      // Reserve each receipt separately so one slow API call cannot delay other messages' add/remove work.
      const work = this.reconcile(row).finally(() => { this.work.delete(row.source_event); });
      this.work.set(row.source_event, work); started.push(work);
    }
    await Promise.all(started);
  }
  private wanted(row: Row, e: ChannelEvent): boolean {
    try { this.source(e); } catch { return false; }
    const message = this.store.get(`SELECT m.deleted FROM channel_messages m JOIN channel_chats h ON h.id=m.chat_id
      WHERE h.connector_id=? AND m.message_id=?`, e.connector_id, e.message_id);
    if (!message || message.deleted) return false;
    const inbox = this.store.get('SELECT state FROM channel_inbox WHERE id=?', row.source_event);
    // A completed model turn can still have an unsent reply. Keep the indicator throughout delivery retries.
    return !!inbox && (['queued', 'running', 'submitted'].includes(inbox.state) ||
      !this.store.get("SELECT 1 FROM channel_outbox WHERE source_event=? AND state='sent'", row.source_event) &&
      !!this.store.get("SELECT 1 FROM channel_outbox WHERE source_event=? AND state IN ('queued','sending','retry')", row.source_event));
  }
  private async reconcile(row: Row): Promise<void> {
    if (this.stopped) return;
    let adding = false;
    try {
      const e = this.store.secrets.open(row.payload, 'channel-event:' + row.source_event) as unknown as ChannelEvent;
      const wanted = this.wanted(row, e);
      if (!wanted && row.state === 'pending') { this.done(row); return; }
      if (wanted && row.state === 'active') {
        this.store.run('UPDATE channel_reactions SET next_attempt=? WHERE source_event=?', Date.now() + 250, row.source_event); return;
      }
      // Cleanup may use a refreshed credential for the same app installation, never a replacement app or tenant.
      const current = () => {
        const c = this.store.get('SELECT * FROM channel_connectors WHERE id=? AND enabled=1', e.connector_id);
        if (!c || c.app_id !== e.app_id || c.installation_tenant !== e.installation_tenant) return fail(403, 'channel_configuration_changed');
        const chat = this.store.get('SELECT state FROM channel_chats WHERE connector_id=? AND chat_id=?', c.id, e.chat_id);
        if (chat?.state !== 'active') fail(403, 'channel_chat_inactive');
        return c;
      };
      const c = current(), guard = () => {
        if (this.stopped) fail(409, 'channel_stopped');
        const latest = current();
        if (latest.revision !== c.revision || latest.credential_ref !== c.credential_ref) fail(403, 'channel_configuration_changed');
        if (adding && !this.wanted(row, e)) fail(409, 'channel_reaction_finished');
      };
      const adapter = this.adapter(c, guard);
      let reaction = row.reaction_id as string | undefined;
      if (row.state === 'adding') {
        // The previous process or request may have added the reaction without recording its returned ID.
        reaction = await adapter.findProcessingReaction(e.message_id);
        if (reaction) this.store.run("UPDATE channel_reactions SET state='active',reaction_id=?,attempts=0,last_error=NULL WHERE source_event=?", reaction, row.source_event);
      }
      if (!reaction && this.wanted(row, e)) {
        adding = true;
        this.store.run("UPDATE channel_reactions SET state='adding' WHERE source_event=?", row.source_event);
        reaction = await adapter.addProcessingReaction(e.message_id);
        // Persist even if shutdown or completion occurred while the request was in flight, so the next worker can remove it.
        this.store.run("UPDATE channel_reactions SET state='active',reaction_id=?,attempts=0,next_attempt=0,last_error=NULL WHERE source_event=?", reaction, row.source_event);
        adding = false;
      }
      if (!reaction) { this.done(row); return; }
      if (!this.stopped && !this.wanted(row, e)) {
        this.store.run("UPDATE channel_reactions SET state='removing' WHERE source_event=?", row.source_event);
        await adapter.removeProcessingReaction(e.message_id, reaction);
        this.done(row);
      }
    } catch (error) {
      if (this.stopped) return;
      const code = error instanceof HttpError ? error.code : 'channel_reaction_unavailable';
      if (code === 'channel_reaction_not_found' || adding && code === 'channel_reaction_finished') { this.done(row); return; }
      const permanent = error instanceof HttpError && error.status < 500;
      const delay = error instanceof ChannelRateLimitError ? error.retryAfterMs : Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
      this.store.run('UPDATE channel_reactions SET state=CASE WHEN ? THEN ? ELSE state END,attempts=attempts+1,next_attempt=?,last_error=? WHERE source_event=?',
        permanent ? 1 : 0, 'failed', Date.now() + delay, code, row.source_event);
    }
  }
  private done(row: Row): void {
    this.store.run("UPDATE channel_reactions SET state='done',last_error=NULL WHERE source_event=?", row.source_event);
  }
}
