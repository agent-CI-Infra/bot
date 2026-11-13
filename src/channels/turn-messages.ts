import type { Row, Store } from '../storage/database.js';
import type { Json } from '../core/security.js';
import type { ChannelEvent } from './types.js';
import { chatContextBytes, requestBytes } from '../agent/tool-context.js';

// What the model is told about messages merged into its turn (#458). The platform gives facts about each message; whether a
// message concerns the assistant, and whether it needs an answer, is the model's own judgement.
const recovered = ' Never repeat a write merely because a message is recovered; inspect its existing receipts first.';
export const groupTurnMessageInstructions = ' Messages that arrive in this group while you work are added before your next step as a user message marked incoming_during_turn.'
  + ' They are not necessarily addressed to you: people also talk to each other. Judge each one yourself from its sender, its mentions, whether it replies in the thread of your request, and its content.'
  + ' Take in what continues the current request (an addition, correction or cancellation, which may change your next tools), answer what is clearly asked of you, and leave other conversation as background: do not answer it, and do not mention it in your reply, not even to say that you are not answering it.'
  + ' is_direct_mention is the only verified mention of you. group_setting_invites_reply tells whether, in this group\'s working mode, that message would have started a reply on its own: a hint, not an obligation.'
  + ' When one answer covers several people, make clear whom each part is for. You never need to wait for further messages.' + recovered;
// The group's participation setting, stated to the model so it knows when it is expected to speak (its working mode).
const workingModes: Record<string, string> = {
  mentions: ' Working mode of this group: you answer only when someone @-mentions you. Messages without an @ are people talking among themselves unless one clearly continues the request you are working on (for example the requester adding to, correcting or cancelling it). You still see them so you can follow the conversation, but otherwise do not answer them, and do not mention them in your reply, not even to say that you are leaving them alone.',
  questions: ' Working mode of this group: besides messages that @-mention you, you see every message ending with a question mark, without an @. Most of those questions are meant for other people: answer one only when you can genuinely help, otherwise stay silent.',
  all: ' Working mode of this group: you see every message, without an @. Most of them are people talking to each other: answer only when someone addresses you or a reply is genuinely helpful, otherwise stay silent.',
};
export const groupWorkingMode = (participation: unknown): string => workingModes[String(participation)] ?? workingModes.mentions!;
export const privateTurnMessageInstructions = ' Messages the person sends while you work are added before your next step as a user message marked incoming_during_turn.'
  + ' In this private chat they come from the person you serve and are addressed to you: take them in (an addition, correction or cancellation may change your next tools) and answer them together with the request. You never need to wait for further messages.' + recovered;
// A private message is always addressed to the assistant, even without an @. Prefer normalized mention targets (#460).
export const directMention = (event: ChannelEvent): boolean => event.mentions?.some(mention => mention.is_self) ?? (event.chat_type === 'group' && !!event.addressed);
// In a private chat every message is for the assistant; in a group only a verified mention of it is.
const addressed = (event: ChannelEvent): boolean => event.chat_type !== 'group' || directMention(event);
const thread = (event: ChannelEvent): string => event.thread_id || event.root_id || '';

/** A batch for the next model step. `direct` is true when a merged message is certainly for the assistant (see `addressed`). */
export interface IncomingBatch { content: Json; direct: boolean }
/** Transport hook shared by the group and management model loops. */
export interface TurnMessages {
  take(maxBytes?: number): IncomingBatch | undefined;
  /** Messages presented to the model so far in this turn; each allows one more progress message. */
  injected(): number;
  pause(): void;
  resume(): void;
  finish(): void;
  check(): void;
  seal(): void;
  release(): void;
}
export interface TurnMessageSource {
  /** Whether the chat's participation setting would answer this message on its own; such messages get their own turn if unseen. */
  needsReply: (event: ChannelEvent) => boolean;
  guard: (source: Row, event: ChannelEvent) => void;
  /** Best known display name of the sender, from the member name cache. */
  senderName?: (event: ChannelEvent) => string | undefined;
  /** The message that started this turn, when it was started by one. */
  request?: ChannelEvent;
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
  open(chat: Row, turn: string, conversation: string, source: string, options: TurnMessageSource): TurnMessages {
    const { needsReply, guard, senderName, request } = options;
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
    // Facts only: who sent it, whether it is the requester, whether it verifiably mentions the assistant and where it was posted.
    const describe = (row: Row, event: ChannelEvent): Json => {
      const name = senderName?.(event), group = event.chat_type === 'group';
      const inThread = !!request && (event.root_id === request.message_id || event.parent_id === request.message_id || !!thread(request) && thread(event) === thread(request));
      return { message_id: event.message_id, sender_id: event.actor_id, ...(name ? { sender_name: name } : {}),
        ...(request ? { same_sender_as_request: event.actor_id === request.actor_id && event.actor_tenant === request.actor_tenant } : {}),
        ...(group ? { is_direct_mention: directMention(event), mentions: event.mentions ?? [], group_setting_invites_reply: !!row.needs_reply,
          ...(event.parent_id ? { reply_to_message_id: event.parent_id } : {}), ...(inThread ? { in_request_thread: true } : {}) } : {}),
        created_at: event.created_at, content: event.content.slice(0, 14000),
        ...(event.content.length > 14000 ? { truncated: true, notice: 'Use read_message_text to read the rest of this message.' } : {}) };
    };
    resume(); capture();
    return { check, seal, finish, resume, pause: () => { paused = true; if (this.active.get(chat.id)?.turn === turn) this.active.delete(chat.id); },
      injected: () => Number(this.store.get("SELECT count(*) n FROM channel_turn_inputs WHERE turn_id=? AND state IN ('injected','answered')", turn)!.n),
      release: () => { seal(); this.release(turn); }, take: (maxBytes = chatContextBytes) => {
      if (sealed || paused) return;
      check();
      capture();
      const pending = rows('pending');
      if (!pending.length) return;
      const messages: Json[] = [];
      const content = { incoming_during_turn: true, notice: chat.chat_type === 'group'
        ? 'Messages that arrived while you were working, oldest first. They are not necessarily addressed to you: decide for each whether it concerns you.'
        : 'Messages the person sent while you were working, oldest first.', messages };
      let direct = false;
      for (const row of pending) {
        const event = this.event(row);
        messages.push(describe(row, event));
        // This is the existing model-context budget, not a message-count or turn-duration limit. Unseen inputs stay durable.
        if (requestBytes({ role: 'user', content: JSON.stringify(content) }) > maxBytes) { messages.pop(); break; }
        guard(row, event);
        direct ||= addressed(event);
        this.store.run("UPDATE channel_turn_inputs SET state='injected',injected_at=? WHERE turn_id=? AND source_event=?", this.clock(), turn, row.id);
      }
      return messages.length ? { content, direct } : undefined;
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
  /** The last merged message certainly meant for the assistant that it actually saw, in arrival order; the answer quotes it. */
  replyEvent(turn: string): ChannelEvent | undefined {
    for (const row of this.store.all("SELECT i.* FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? AND m.state IN ('injected','answered') ORDER BY i.created_at DESC,i.rowid DESC", turn)) {
      const event = this.event(row);
      if (addressed(event)) return event;
    }
    return undefined;
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
  list(turn: string, senderName?: (event: ChannelEvent) => string | undefined): Json[] {
    return this.store.all(`SELECT m.*,i.payload FROM channel_turn_inputs m JOIN channel_inbox i ON i.id=m.source_event WHERE m.turn_id=? ORDER BY i.created_at,i.rowid`, turn).map(row => {
      const event = this.event({ ...row, id: row.source_event });
      const current = this.store.get('SELECT deleted,sensitive FROM channel_messages WHERE chat_id=? AND message_id=?',row.chat_id,event.message_id);
      const visible = current && !current.deleted && !current.sensitive;
      const name = visible ? senderName?.(event) : undefined;
      return { message_id: event.message_id, sender_id: event.actor_id, ...(name ? { sender_name: name } : {}), needs_reply: !!row.needs_reply, is_direct_mention: !!visible && directMention(event),
        mentions: visible ? event.mentions ?? [] : [], state: row.state, created_at: row.created_at, injected_at: row.injected_at };
    });
  }
}
