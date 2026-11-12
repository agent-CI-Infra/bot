import type { Json } from '../core/security.js';

// Staged messages (#435): while a turn runs, a service role may post short progress messages to its conversation. This is a
// default capability of every service role turn (no permission item, no approval). Each turn may send at most
// `stageMessageLimit`; a further call is refused as an observation and never ends the turn. The final answer (the reply
// without tool calls) and every selected attachment are still sent once, when the turn ends.
export const stageMessageLimit = 10;
const maxChars = 4000;
export const sendMessageName = 'send_message';
export const sendMessageTool = { type: 'function', function: { name: sendMessageName,
  description: `Send a progress message to the current conversation now and keep working: what you are doing, an intermediate finding, or why the work takes longer. At most ${stageMessageLimit} per turn; after that this tool refuses and the turn continues. Text only (Markdown allowed, at most ${maxChars} characters); attachments are sent only with your final answer. Your final answer, the reply you give without tool calls, is still sent automatically when the turn ends: never use this tool for it and do not repeat a progress message there.`,
  parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: maxChars, description: 'The progress message for the people in this conversation.' } },
    required: ['text'], additionalProperties: false } } };
/** The same contract for the system prompt, so the model knows the limit before it calls the tool. */
export const stageMessageInstructions = ` For longer work you may call ${sendMessageName} to post a short progress message to this conversation while you keep working; at most ${stageMessageLimit} per turn, and further calls are refused without ending the turn. Attachments go only with your final answer, and your final answer (the reply without tool calls) is sent automatically at the end of the turn.`;

/**
 * Answers one send_message call. `sent` counts this turn's delivered progress messages; `post` records and queues the
 * redacted text with its 1-based sequence and throws when the turn's source no longer allows sending (that ends the turn).
 */
export async function stageMessage(args: unknown, sent: number, post: (text: string, sequence: number) => void | Promise<void>, redact: (value: string) => string): Promise<Json> {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Json : null;
  if (!input || Object.keys(input).some(key => key !== 'text') || typeof input.text !== 'string' || !input.text.trim() || input.text.length > maxChars)
    return { error: 'invalid_arguments', detail: `${sendMessageName} takes one non-empty text of at most ${maxChars} characters.` };
  if (sent >= stageMessageLimit) return { error: 'stage_message_limit', sent: false, sent_count: sent, remaining: 0,
    detail: `This turn already sent ${stageMessageLimit} progress messages, the most allowed; nothing was sent. Continue the work without progress messages and give the conclusion in your final answer, which is still sent automatically.` };
  const sequence = sent + 1, remaining = stageMessageLimit - sequence;
  await post(redact(input.text), sequence);
  return { sent: true, sequence, remaining,
    notice: (remaining ? `${remaining} more progress messages may be sent in this turn.` : 'That was the last progress message allowed in this turn.') + ' Your final answer is still sent automatically when the turn ends.' };
}
