import type { Json } from '../core/security.js';
import { formatReplyTargetObservation, replyTargetProperties, type ResolvedReplyTarget } from '../channels/reply-target.js';

// Staged messages (#435): while an interactive turn runs, a service role may post short progress messages to its conversation.
// This is a default capability of interactive service role turns (no permission item, no approval); scheduled timer turns
// omit send_message and deliver only their final result (#1367). Each turn may send `stageMessageLimit`, plus one for each
// new message merged into the turn (#458); a further call is refused as an observation and never ends the turn. The final
// answer (the reply without tool calls) and every selected attachment are still sent once, when the turn ends.
export const stageMessageLimit = 10;
const maxChars = 4000;
export const sendMessageName = 'send_message';
/** Shared credential-redaction safety rule kept even in turns without progress messages (such as timer turns). */
export const credentialSafetyInstructions = ' Do not paste environment variables or real credentials into public comments, issues, pull requests or messages.';
// When to send (#453): announce long work before starting it, then report only what is worth knowing. A turn that may end
// silently sends nothing until it knows it will answer.
const allowance = `At most ${stageMessageLimit} per turn, plus one for each new message merged into the turn; further calls are refused and the turn continues.`;
const baseDescription = `Send a progress message to the current conversation now and keep working. Before work that will take a while (several tool calls, searches across repositories or files, log investigation, commands on a computer), send one short message saying what you are about to do. After that, send one only when there is something worth knowing: a key finding, new evidence or an intermediate conclusion. Never send a message without substance, such as "still working", "仍在执行" or "请稍候", and never repeat a progress message in your final answer. When the turn may end without an answer (a group message without an @ to you), send nothing until you know you will answer. ${allowance} Text only (Markdown allowed, at most ${maxChars} characters); attachments are sent only with your final answer. Your final answer, the reply you give without tool calls, is still sent automatically when the turn ends: never use this tool for it.`;
const textParameter = { type: 'string', minLength: 1, maxLength: maxChars, description: 'What you are about to do, or a key finding, new evidence or intermediate conclusion, for the people in this conversation.' };
export const sendMessageTool = { type: 'function', function: { name: sendMessageName,
  description: baseDescription,
  parameters: { type: 'object', properties: { text: textParameter },
    required: ['text'], additionalProperties: false } } };
export const feishuSendMessageTool = { type: 'function', function: { name: sendMessageName,
  description: `${baseDescription} Optional reply_to_message_id, thread_id, and reply_in_thread let you reply to a specific Feishu message or thread (otherwise this message posts directly to the main chat stream; the platform never auto-attaches a reply target). You may also use this tool to deliver targeted answers to separate people or threads within one turn.`,
  parameters: { type: 'object', properties: { text: textParameter, ...replyTargetProperties },
    required: ['text'], additionalProperties: false } } };
/** The same contract for the system prompt, so the model knows when to send and the limit before it calls the tool. */
export const stageMessageInstructions = `${credentialSafetyInstructions} Keep people informed with ${sendMessageName} while you work: before work that will take a while (several tool calls, searches across repositories or files, log investigation, commands on a computer), first send one short message saying what you are about to do, so nobody waits in silence. While working, send another only for a key finding, new evidence or an intermediate conclusion; never send messages without substance such as "still working", "仍在执行" or "请稍候", and do not repeat them in your final answer. When the turn may end without an answer (a group message without an @ to you), send nothing until you know you will answer. ${allowance} Attachments go only with your final answer, and your final answer (the reply without tool calls) is sent automatically at the end of the turn.`;

/**
 * Answers one send_message call. `sent` counts this turn's delivered progress messages and `limit` is what the turn allows now;
 * `post` records and queues the redacted text (and optional resolved Feishu reply target) with its 1-based sequence and throws
 * when the turn's source no longer allows sending (that ends the turn).
 */
export async function stageMessage(
  args: unknown,
  sent: number,
  post: (text: string, sequence: number, target?: ResolvedReplyTarget) => void | Promise<void>,
  redact: (value: string) => string,
  limit = stageMessageLimit,
  resolveTarget?: (input: Json) => { target: ResolvedReplyTarget | null } | { error: string; detail: string },
): Promise<Json> {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Json : null;
  const allowedKeys = resolveTarget ? new Set(['text', 'reply_to_message_id', 'thread_id', 'reply_in_thread']) : new Set(['text']);
  if (!input || Object.keys(input).some(key => !allowedKeys.has(key)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > maxChars)
    return { error: 'invalid_arguments', detail: `${sendMessageName} takes one non-empty text of at most ${maxChars} characters${resolveTarget ? ' (plus optional reply_to_message_id, thread_id, reply_in_thread)' : ''}.` };
  let target: ResolvedReplyTarget | undefined;
  if (resolveTarget) {
    const resolved = resolveTarget(input);
    if ('error' in resolved) return resolved;
    target = resolved.target ?? undefined;
  }
  if (sent >= limit) return { error: 'stage_message_limit', sent: false, sent_count: sent, remaining: 0,
    detail: `This turn already sent ${sent} progress messages, the most allowed now (each new message merged into the turn allows one more); nothing was sent. Continue the work and give the conclusion in your final answer, which is still sent automatically.` };
  const sequence = sent + 1, remaining = limit - sequence;
  await post(redact(input.text), sequence, target);
  return { sent: true, sequence, remaining,
    ...(target ? { reply_target: formatReplyTargetObservation(target) } : {}),
    notice: (remaining ? `${remaining} more progress messages may be sent in this turn.` : 'That was the last progress message allowed in this turn unless new messages are merged into it.') + ' Your final answer is still sent automatically when the turn ends.' };
}
