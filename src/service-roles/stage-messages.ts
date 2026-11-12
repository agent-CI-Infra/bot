import type { Json } from '../core/security.js';

// Staged messages (#435): while a turn runs, a service role may post short progress messages to its conversation. This is a
// default capability of every service role turn (no permission item, no approval). Each turn may send at most
// `stageMessageLimit`; a further call is refused as an observation and never ends the turn. The final answer (the reply
// without tool calls) and every selected attachment are still sent once, when the turn ends.
export const stageMessageLimit = 10;
const maxChars = 4000;
export const sendMessageName = 'send_message';
export const sendMessageTool = { type: 'function', function: { name: sendMessageName,
  description: `向当前对话立即发送一条阶段消息并继续工作：通报计划、关键发现、新证据或阶段结论。长耗时任务（多步工具调用、跨仓库或多文件改动、日志排查、虚拟电脑执行）开工前先发一条，不要让人干等；中途只在有实质内容时再发。禁止发送「仍在执行」「请稍候」这类没有实质内容的心跳，也不要在最终回答里重复已经发过的内容。允许静默的上下文（未被 @ 的群消息、没有可汇报内容的定时任务）不要求先通报。每回合最多 ${stageMessageLimit} 条，超出后本工具拒绝调用而回合继续。只接受文本（允许 Markdown，最多 ${maxChars} 字符）；附件只随最终回答发送，最终回答（没有工具调用的回复）仍会在回合结束时自动发送，不能用它代替最终回答。`,
  parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: maxChars, description: 'The progress message for the people in this conversation.' } },
    required: ['text'], additionalProperties: false } } };
/** The same contract for the system prompt, so the model knows the limit before it calls the tool. */
export const stageMessageInstructions = ` 长耗时任务开工前先调用 ${sendMessageName} 通报一次本次工作的进展或计划：需要多步工具调用、跨仓库或多文件改动、日志排查、虚拟电脑执行的工作都属于这一类，先通报，别让人干等。开始之后只在出现关键发现、新证据或一个阶段结论时同步一次，不要按固定节奏刷进度。禁止发送「仍在执行」「请稍候」这类没有实质内容的心跳，也不要在最终回答里重复已经发过的进展。允许静默的上下文（未被 @ 的群消息、没有可汇报内容的定时任务）不要求先通报。每回合最多 ${stageMessageLimit} 条，超出后调用会被拒绝且不会结束回合；只接受文本，附件只随最终回答发送，最终回答（没有工具调用的回复）在回合结束时自动发送。`;

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
