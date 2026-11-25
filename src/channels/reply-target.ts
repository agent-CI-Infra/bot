import type { Row, Store } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { ledgerVisibility } from './ledger.js';

export const replyTargetToolName = 'set_reply_target';

export interface ResolvedReplyTarget {
  reply_to: string;
  reply_in_thread: boolean;
  thread_id?: string;
}

export interface ReplyTargetVisibility {
  projects?: string[];
  fence?: string;
}

/** Normalized non-empty Feishu message relation fields exposed to models in group and private chat contexts. */
export function messageRelationFields(source: { parent_id?: unknown; root_id?: unknown; thread_id?: unknown }): Json {
  const parent = typeof source.parent_id === 'string' ? source.parent_id.trim() : '';
  const root = typeof source.root_id === 'string' ? source.root_id.trim() : '';
  const thread = typeof source.thread_id === 'string' ? source.thread_id.trim() : '';
  return {
    ...(parent ? { parent_id: parent, reply_to_message_id: parent } : {}),
    ...(root ? { root_id: root } : {}),
    ...(thread ? { thread_id: thread } : {}),
  };
}

export function formatReplyTargetObservation(target: ResolvedReplyTarget): Json {
  return {
    reply_to_message_id: target.reply_to,
    reply_in_thread: target.reply_in_thread,
    ...(target.thread_id ? { thread_id: target.thread_id } : {}),
  };
}

export const replyTargetProperties: Json = {
  reply_to_message_id: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Optional Feishu message_id from this chat\'s local visible history to reply to. Omit to post directly to the main chat stream (unless thread_id is set).',
  },
  thread_id: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Optional Feishu thread_id (e.g. omt_...) from this chat\'s local visible history to reply inside that thread (automatically sets reply_in_thread: true).',
  },
  reply_in_thread: {
    type: 'boolean',
    description: 'Optional. Used with reply_to_message_id: true posts into that message\'s Feishu thread (or starts one); false (default) quotes the message in the main stream. Cannot be false when thread_id is set.',
  },
};

export const replyTargetTool = {
  type: 'function',
  function: {
    name: replyTargetToolName,
    description: 'Choose (or clear) which Feishu message or thread your final reply (plain Markdown, attachments, or staged Feishu card) will reply to. The platform NEVER auto-attaches a reply target or thread: if you do not call this tool (and do not pass reply target fields on set_feishu_card), your final reply posts directly to the main chat stream. Pass reply_to_message_id to quote-reply a specific message (add reply_in_thread: true to reply inside its thread), pass thread_id to reply inside an existing Feishu thread, or pass { clear: true } to revert to the main chat stream. Validated immediately against this chat\'s local visible history.',
    parameters: {
      type: 'object',
      properties: {
        ...replyTargetProperties,
        clear: {
          type: 'boolean',
          description: 'Set true to clear any previously selected reply target so the final reply posts directly to the main chat stream.',
        },
      },
      additionalProperties: false,
    },
  },
};

export const replyTargetInstructions =
  ' Feishu reply targeting: the platform never automatically attaches your replies to a specific message or thread—without an explicit target, every message (both send_message and your final reply) posts directly to the main chat stream.'
  + ' Every Feishu message in context carries its message_id and, when present, parent_id / reply_to_message_id (the message it replied to), root_id (the root message), and thread_id (the Feishu thread/topic it belongs to).'
  + ' Choose reply targets deliberately based on the conversation:'
  + ' when answering a message inside a Feishu thread (non-empty thread_id), normally reply into that same thread (pass thread_id, or reply_to_message_id with reply_in_thread: true);'
  + ' when answering a specific message in a busy chat, pass reply_to_message_id to quote-reply it (add reply_in_thread: true only when you intend to reply inside or start a thread);'
  + ' when posting a general announcement, summary, or combined answer, leave the target unset to post directly to the main stream—or when answering multiple people/questions in one turn, use send_message with each person\'s reply_to_message_id / thread_id and set your final reply target separately.'
  + ` Call ${replyTargetToolName} to set or clear the target for your final reply (plain Markdown, attachments, or staged card), or pass optional reply_to_message_id / thread_id / reply_in_thread directly on set_feishu_card or send_message.`
  + ' Only real, non-recalled messages in this chat\'s local visible history may be targeted; synthetic card-act-* IDs cannot be replied to directly (use the card message\'s parent_id or post directly to the main stream).';

const isUsableRow = (row?: Row): row is Row =>
  !!row && !row.deleted && !row.sensitive && !String(row.message_id).startsWith('card-act-');

/**
 * Validate and resolve optional reply target fields against the current chat's local visible ledger.
 * Returns `{ target: null }` when no target was requested (meaning post directly to the main stream).
 */
export function resolveReplyTarget(
  store: Store,
  chatId: string,
  input: Json,
  options: ReplyTargetVisibility = {},
): { target: ResolvedReplyTarget | null } | { error: string; detail: string } {
  const rawReplyTo = input.reply_to_message_id;
  const rawThreadId = input.thread_id;
  const rawInThread = input.reply_in_thread;

  if (rawReplyTo !== undefined && (typeof rawReplyTo !== 'string' || !rawReplyTo.trim() || rawReplyTo.trim().length > 200)) {
    return { error: 'invalid_reply_target', detail: 'reply_to_message_id must be a non-empty string of at most 200 characters.' };
  }
  if (rawThreadId !== undefined && (typeof rawThreadId !== 'string' || !rawThreadId.trim() || rawThreadId.trim().length > 200)) {
    return { error: 'invalid_reply_target', detail: 'thread_id must be a non-empty string of at most 200 characters.' };
  }
  if (rawInThread !== undefined && typeof rawInThread !== 'boolean') {
    return { error: 'invalid_reply_target', detail: 'reply_in_thread must be a boolean.' };
  }

  const replyTo = typeof rawReplyTo === 'string' ? rawReplyTo.trim() : '';
  const threadId = typeof rawThreadId === 'string' ? rawThreadId.trim() : '';

  if (!replyTo && !threadId) {
    if (rawInThread === true) {
      return { error: 'invalid_reply_target', detail: 'reply_in_thread: true requires reply_to_message_id or thread_id.' };
    }
    return { target: null };
  }
  if (threadId && rawInThread === false) {
    return { error: 'reply_target_conflict', detail: 'thread_id always replies inside that thread and cannot be combined with reply_in_thread: false.' };
  }
  if (replyTo && replyTo.startsWith('card-act-')) {
    return {
      error: 'invalid_reply_target',
      detail: 'Synthetic card action IDs (card-act-*) are not real Feishu messages and cannot be replied to directly. Target the card message_id (parent_id) or post directly to the main stream.',
    };
  }

  const visible = ledgerVisibility(options.projects, options.fence);
  const getVisibleRow = (messageId: string): Row | undefined => store.get(
    `SELECT message_id, parent_id, root_id, thread_id, deleted, sensitive FROM channel_messages WHERE chat_id=? AND message_id=?${visible.sql}`,
    chatId, messageId, ...visible.args,
  );

  if (replyTo) {
    const row = getVisibleRow(replyTo);
    if (!row) {
      return { error: 'reply_target_not_found', detail: `Message "${replyTo}" was not found in this chat's local visible history.` };
    }
    if (row.deleted) {
      return { error: 'reply_target_unavailable', detail: `Message "${replyTo}" has been recalled and cannot be replied to.` };
    }
    if (row.sensitive) {
      return { error: 'reply_target_unavailable', detail: `Message "${replyTo}" is not available as a reply target.` };
    }
    if (threadId) {
      const threadExists = store.get(
        `SELECT 1 FROM channel_messages WHERE chat_id=? AND thread_id=?${visible.sql} LIMIT 1`,
        chatId, threadId, ...visible.args,
      );
      if (!threadExists) {
        return { error: 'reply_target_not_found', detail: `Thread "${threadId}" was not found in this chat's local visible history.` };
      }
      const matchesDirectly = String(row.thread_id) === threadId;
      const matchesAsRoot = !row.thread_id && !!store.get(
        `SELECT 1 FROM channel_messages WHERE chat_id=? AND thread_id=? AND root_id=?${visible.sql} LIMIT 1`,
        chatId, threadId, row.message_id, ...visible.args,
      );
      if (!matchesDirectly && !matchesAsRoot) {
        return {
          error: 'reply_target_conflict',
          detail: `Message "${replyTo}" does not belong to thread "${threadId}". Pass only reply_to_message_id, only thread_id, or a matching pair.`,
        };
      }
      return { target: { reply_to: String(row.message_id), reply_in_thread: true, thread_id: threadId } };
    }
    const inThread = rawInThread === true;
    const rowThread = String(row.thread_id ?? '');
    return {
      target: {
        reply_to: String(row.message_id),
        reply_in_thread: inThread,
        ...(inThread && rowThread ? { thread_id: rowThread } : {}),
      },
    };
  }

  // Only thread_id was provided: resolve an active anchor message within this chat's visible thread.
  const activeRows = store.all(
    `SELECT message_id, root_id, thread_id, deleted, sensitive FROM channel_messages
     WHERE chat_id=? AND thread_id=? AND deleted=0 AND sensitive=0 AND message_id NOT LIKE 'card-act-%'${visible.sql}
     ORDER BY CASE WHEN root_id='' THEN 0 ELSE 1 END, created_at ASC, message_id ASC LIMIT 5`,
    chatId, threadId, ...visible.args,
  );
  let anchor: Row | undefined = activeRows.find(r => !r.root_id);
  if (!anchor) {
    const candidates = activeRows.length ? activeRows : store.all(
      `SELECT message_id, root_id, thread_id, deleted, sensitive FROM channel_messages
       WHERE chat_id=? AND thread_id=?${visible.sql}
       ORDER BY created_at ASC, message_id ASC LIMIT 5`,
      chatId, threadId, ...visible.args,
    );
    if (!candidates.length) {
      return { error: 'reply_target_not_found', detail: `Thread "${threadId}" was not found in this chat's local visible history.` };
    }
    for (const candidate of candidates) {
      const rootId = String(candidate.root_id ?? '');
      if (!rootId) continue;
      const rootRow = getVisibleRow(rootId);
      if (isUsableRow(rootRow) && (!rootRow.thread_id || String(rootRow.thread_id) === threadId)) {
        anchor = rootRow;
        break;
      }
    }
    if (!anchor) anchor = activeRows[0];
  }
  if (!anchor) {
    return { error: 'reply_target_unavailable', detail: `No active (non-recalled) message was found in thread "${threadId}" to anchor a reply.` };
  }
  return { target: { reply_to: String(anchor.message_id), reply_in_thread: true, thread_id: threadId } };
}

/**
 * Re-check a previously resolved target both before queueing and right before each outbox part is sent.
 * If the specific anchor message was recalled after staging, retries resolving the thread_id (when set),
 * otherwise falls back to main-stream delivery (`undefined`) rather than failing a completed answer.
 */
export function revalidateReplyTarget(
  store: Store,
  chatId: string,
  target: ResolvedReplyTarget | null | undefined,
  options: ReplyTargetVisibility = {},
): ResolvedReplyTarget | undefined {
  if (!target?.reply_to) return undefined;
  const checked = resolveReplyTarget(store, chatId, {
    reply_to_message_id: target.reply_to,
    ...(target.thread_id ? { thread_id: target.thread_id } : {}),
    reply_in_thread: !!target.reply_in_thread,
  }, options);
  if (!('error' in checked) && checked.target) return checked.target;
  if (target.thread_id) {
    const reanchored = resolveReplyTarget(store, chatId, { thread_id: target.thread_id }, options);
    if (!('error' in reanchored) && reanchored.target) return reanchored.target;
  }
  return undefined;
}

/** Per-turn holder for the AI-selected Feishu reply target of the turn's final answer (and attachments/card). */
export class ReplyTargetTurn {
  private target: ResolvedReplyTarget | null = null;
  constructor(
    private readonly store: Store,
    private readonly chatId: string,
    private readonly visibility: () => ReplyTargetVisibility = () => ({}),
  ) {}
  get current(): ResolvedReplyTarget | null { return this.target; }
  reset(): void { this.target = null; }
  resolve(input: Json): { target: ResolvedReplyTarget | null } | { error: string; detail: string } {
    return resolveReplyTarget(this.store, this.chatId, input, this.visibility());
  }
  apply(target: ResolvedReplyTarget): void { this.target = target; }
  execute(args: unknown): Json {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { error: 'invalid_arguments', detail: `${replyTargetToolName} takes a JSON object.` };
    }
    const input = args as Json;
    const allowedKeys = new Set(['reply_to_message_id', 'thread_id', 'reply_in_thread', 'clear']);
    if (Object.keys(input).some(key => !allowedKeys.has(key))) {
      return { error: 'invalid_arguments', detail: `${replyTargetToolName} accepts only reply_to_message_id, thread_id, reply_in_thread, and clear.` };
    }
    if (input.clear !== undefined && typeof input.clear !== 'boolean') {
      return { error: 'invalid_arguments', detail: 'clear must be a boolean.' };
    }
    const hasTargetField = input.reply_to_message_id !== undefined || input.thread_id !== undefined || input.reply_in_thread !== undefined;
    if (input.clear === true) {
      if (hasTargetField) {
        return { error: 'invalid_arguments', detail: 'Pass either clear: true or a reply target (reply_to_message_id / thread_id), not both.' };
      }
      this.target = null;
      return { cleared: true, reply_target: null, notice: 'Reply target cleared; the final reply will post directly to the main chat stream.' };
    }
    if (input.reply_to_message_id === undefined && input.thread_id === undefined) {
      return { error: 'invalid_reply_target', detail: 'Provide reply_to_message_id, thread_id, or clear: true.' };
    }
    const resolved = this.resolve(input);
    if ('error' in resolved) return resolved;
    this.target = resolved.target;
    return {
      set: true,
      reply_target: resolved.target ? formatReplyTargetObservation(resolved.target) : null,
      notice: resolved.target?.reply_in_thread
        ? 'Final reply (and any attachments) will be posted inside that Feishu thread.'
        : 'Final reply (and any attachments) will quote-reply that message in the main chat stream.',
    };
  }
}
