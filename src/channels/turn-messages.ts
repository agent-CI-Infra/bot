import type { Row, Store } from '../storage/database.js';
import type { Json } from '../core/security.js';
import type { ChannelEvent } from './types.js';
import { chatContextBytes, requestBytes } from '../agent/tool-context.js';

export const turnMessageInstructions = ' New messages may arrive while you work. A subsequent user message marked incoming_during_turn contains reply_required messages to answer together, attributed to each speaker, and reference_only discussion which is context, not a request. Each message has is_direct_mention: true only for an authenticated mention of your own Feishu bot account, independently of whether the group participation mode requires a reply. mentions preserves verified target actor_id, name and is_self metadata when available; never infer a mention from matching display names or literal @text. Reconsider the next tools when someone corrects or cancels a request. Inputs join only before an existing next model step: do not interrupt reasoning, tools or output, and do not add a model step to include late messages after your final answer. Only the initial request and reply_required messages belong to this turn; other history is reference. Never repeat a write merely because a message is recovered; inspect its existing receipts first.';
// A private message is always addressed to the assistant, even without an @. Prefer normalized mention targets (#460).
export const directMention = (event: ChannelEvent): boolean => event.mentions?.some(mention => mention.is_self) ?? (event.chat_type === 'group' && !!event.addressed);

/** Transport hook shared by the group and management model loops. */
export interface TurnMessages {
  take(maxBytes?: number): Json | undefined;
  pause(): void;
  resume(): void;
  finish(): void;
  check(): void;
  seal(): void;
  release(): void;
}

// Identity commands keep their transport semantics even while an assistant is working.
export const assistantMessage = (event: ChannelEvent, received = Date.now()): boolean => event.kind === 'message' && event.sender_type === 'user' &&
  Math.abs(received - event.created_at) <= 300_000 && !/^(?:绑定|\/bind|重新认证|\/reauth|确认绑定|\/confirm|解绑|\/unbind|身份|\/identity)(?:\s|$)/.test((event.command_text ?? event.content).trim());

/** Persist membership separately from delivery. The inbox deduplicates events; this table keeps every recovery's membership
 * without copying message bodies. Completing the outbox and these memberships happens in the caller's transaction. */
export class ChannelTurnMessages {
  private readonly active = new Map<string, { turn: string; merge: (source: Row, reply: boolean) => boolean }>();
  constructor(readonly store: Store, readonly clock = () => Date.now()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS channel_turn_inputs(turn_id TEXT NOT NULL,source_event TEXT NOT NULL,
      chat_id TEXT NOT NULL,needs_reply INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,injected_at INTEGER,outbox_id TEXT,
      PRIMARY KEY(turn_id,source_event));
      CREATE INDEX IF NOT EXISTS channel_turn_inputs_source ON channel_turn_inputs(source_event);
      CREATE INDEX IF NOT EXISTS channel_turn_inputs_chat ON channel_turn_inputs(chat_id,turn_id)`);
    if (!store.all('PRAGMA table_info(channel_turn_inputs)').some(c => c.name === 'outbox_id'))
      store.db.exec('ALTER TABLE channel_turn_inputs ADD COLUMN outbox_id TEXT');
    if (!store.all('PRAGMA table_info(channel_inbox)').some(c => c.name === 'chat_ref'))
      store.db.exec('ALTER TABLE channel_inbox ADD COLUMN chat_ref TEXT');
    store.db.exec('CREATE INDEX IF NOT EXISTS channel_inbox_chat_pending ON channel_inbox(chat_ref,state)');
    // Resolve unfinished pre-upgrade sources so they also stay out of another turn's history prompt.
    for (const row of store.all("SELECT * FROM channel_inbox WHERE chat_ref IS NULL AND state IN ('queued','running','submitted')")) {
      const event = this.event(row), chat = store.get('SELECT id FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?', event.provider, event.app_id, event.installation_tenant, event.chat_id);
      if (chat) store.run('UPDATE channel_inbox SET chat_ref=? WHERE id=?', chat.id, row.id);
    }
    // No model turn survives a process restart. A persisted final outbox already owns delivery; everything else is recoverable.
    for (const row of store.all("SELECT DISTINCT turn_id FROM channel_turn_inputs WHERE state IN ('pending','injected')")) this.release(row.turn_id);
  }
  event(source: Row): ChannelEvent { return this.store.secrets.open(source.payload, 'channel-event:' + source.id) as unknown as ChannelEvent; }
  merge(chat: string, source: Row, reply: boolean): boolean { return this.active.get(chat)?.merge(source, reply) ?? false; }
  /** Start listening before the first model await, including already accepted messages waiting for this chat. */
  open(chat: Row, turn: string, conversation: string, source: string, needsReply: (event: ChannelEvent) => boolean,
    guard: (source: Row, event: ChannelEvent) => void): TurnMessages {
    let sealed = false, paused = false;
    const rows = (state: string) => this.store.all('SELECT i.*,m.needs_reply FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? AND m.state=? ORDER BY i.created_at,i.rowid', turn, state);
    const check = () => { for (const row of rows('injected')) guard(row, this.event(row)); };
    const seal = () => { sealed = true; if (this.active.get(chat.id)?.turn === turn) this.active.delete(chat.id); };
    const finish = () => {
      seal();
      // A final answer ends model admission, even while cleanup or platform delivery is still pending.
      this.store.transaction(() => { for (const row of rows('pending')) this.returnInput(turn, row); });
    };
    const merge = (row: Row, reply: boolean): boolean => {
      if (sealed || paused || row.id === source) return false;
      const event = this.event(row);
      if (!assistantMessage(event,row.created_at) || event.chat_id !== chat.chat_id || event.app_id !== chat.app_id || event.installation_tenant !== chat.installation_tenant) return false;
      const inserted = this.store.run("INSERT OR IGNORE INTO channel_turn_inputs(turn_id,source_event,chat_id,needs_reply,state,created_at) VALUES(?,?,?,?,'pending',?)", turn, row.id, chat.id, reply ? 1 : 0, this.clock());
      if (!inserted.changes) return true;
      this.store.run("UPDATE channel_inbox SET state='merged',conversation_id=?,message_id=?,context_revision=? WHERE id=?", conversation, turn, chat.context_revision, row.id);
      return true;
    };
    const resume = () => { if (!sealed) { paused = false; this.active.set(chat.id,{turn,merge}); } };
    const capture = () => { for (const row of this.store.all("SELECT * FROM channel_inbox WHERE chat_ref=? AND state='queued' ORDER BY created_at,rowid", chat.id)) merge(row,needsReply(this.event(row))); };
    resume(); capture();
    return { check, seal, finish, resume, pause: () => { paused = true; if (this.active.get(chat.id)?.turn === turn) this.active.delete(chat.id); },
      release: () => { seal(); this.release(turn); }, take: (maxBytes = chatContextBytes) => {
      if (sealed || paused) return;
      check();
      capture();
      const pending = rows('pending');
      if (!pending.length) return;
      const reply_required: Json[] = [], reference_only: Json[] = [];
      const batch = { incoming_during_turn: true, notice: '你处理期间新到的消息。请按提问人综合回应需要回复的消息；仅供参考的讨论不要求回复。', reply_required, reference_only };
      for (const row of pending) {
        const event = this.event(row);
        const message = { source_event: row.id, message_id: event.message_id, sender_id: event.actor_id, sender_tenant: event.actor_tenant,
          is_direct_mention: directMention(event), mentions: event.mentions ?? [],
          created_at: event.created_at, content: event.content.slice(0, 14000), ...(event.content.length > 14000 ? { truncated: true, notice: 'Use read_message_text to read the rest of this message.' } : {}) };
        const target = row.needs_reply ? reply_required : reference_only;
        target.push(message);
        // This is the existing model-context budget, not a message-count or turn-duration limit. Unseen inputs stay durable.
        if (requestBytes({ role: 'user', content: JSON.stringify(batch) }) > maxBytes) { target.pop(); break; }
        guard(row, event);
        this.store.run("UPDATE channel_turn_inputs SET state='injected',injected_at=? WHERE turn_id=? AND source_event=?", this.clock(), turn, row.id);
      }
      return reply_required.length || reference_only.length ? batch : undefined;
    } };
  }
  private returnInput(turn: string, row: Row): void {
    this.store.run("UPDATE channel_inbox SET state=?,conversation_id=NULL,message_id=NULL,error=NULL WHERE id=? AND state IN ('merged','completed') AND message_id=?", row.needs_reply ? 'queued' : 'completed', row.id, turn);
    this.store.run("UPDATE channel_turn_inputs SET state='released' WHERE turn_id=? AND source_event=?", turn, row.id);
  }
  release(turn: string, undelivered = false): void {
    this.store.transaction(() => {
      for (const row of this.store.all(`SELECT i.*,m.needs_reply FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? AND m.state IN ('pending','injected'${undelivered?",'answered'":''})`, turn)) this.returnInput(turn, row);
    });
  }
  complete(turn: string, outbox?: string): void {
    this.store.run("UPDATE channel_inbox SET state='completed' WHERE state='merged' AND message_id=?", turn);
    this.store.run("UPDATE channel_turn_inputs SET state='answered',outbox_id=? WHERE turn_id=? AND state IN ('pending','injected')", outbox ?? null, turn);
  }
  /** Last required message actually presented to the model, in arrival order rather than provider timestamp order. */
  replyEvent(turn: string): ChannelEvent | undefined {
    const row = this.store.get("SELECT i.* FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? AND m.needs_reply=1 AND m.state IN ('injected','answered') ORDER BY i.created_at DESC,i.rowid DESC LIMIT 1", turn);
    return row ? this.event(row) : undefined;
  }
  /** Private conversation history must keep supplemental user selections, not only the first request and final answer. */
  history(turn: string): Json[] {
    return this.store.all("SELECT i.*,m.chat_id FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? AND m.needs_reply=1 AND m.state='answered' ORDER BY i.created_at,i.rowid", turn).flatMap(row => {
      const event = this.event(row), current = this.store.get('SELECT * FROM channel_messages WHERE chat_id=? AND message_id=?', row.chat_id, event.message_id);
      if (!current || current.deleted || current.sensitive) return [];
      const message = this.store.secrets.open(current.payload, 'channel-message:' + row.chat_id + ':' + event.message_id);
      return [{ message_id: event.message_id, sender_id: event.actor_id, content: String(message.content).slice(0, 4000) }];
    });
  }
  list(turn: string): Json[] {
    return this.store.all(`SELECT m.*,i.payload FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? ORDER BY i.created_at,i.rowid`, turn).map(row => {
      const event = this.event({ ...row, id: row.source_event });
      const current = this.store.get('SELECT deleted,sensitive FROM channel_messages WHERE chat_id=? AND message_id=?',row.chat_id,event.message_id);
      const visible = current && !current.deleted && !current.sensitive;
      return { message_id: event.message_id, sender_id: event.actor_id, needs_reply: !!row.needs_reply, is_direct_mention: !!visible && directMention(event),
        mentions: visible ? event.mentions ?? [] : [], state: row.state, created_at: row.created_at, injected_at: row.injected_at };
    });
  }
}
