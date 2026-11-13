import type { Json } from '../core/security.js';

// Ending a turn without an answer (#489). Turns that may stay silent (a group message without an @, a timer whose task
// allows nothing to report) offer this tool: calling it ends the turn and the platform sends nothing. Silence used to be an
// empty final text, and models often wrote a placeholder such as "（无需回复）" instead, which was then posted as the answer.
export const staySilentName = 'stay_silent';
const maxReason = 200;
export const staySilentTool = { type: 'function', function: { name: staySilentName,
  description: 'End this turn without sending anything to the conversation. Call it when no reply is needed: any text you write instead is sent as your answer. The reason stays in the console record and is never sent.',
  parameters: { type: 'object', properties: { reason: { type: 'string', maxLength: maxReason, description: 'Why no reply is needed, for the console record only.' } },
    additionalProperties: false } } };
/** The same contract for the system prompt of a turn that offers the tool. */
export const staySilentInstructions = ` If no reply is needed, call ${staySilentName}: it ends this turn and nothing is sent. Any text you write is posted as your answer, so never write a note such as "no reply needed" or explain that you are staying silent.`;

/**
 * Answers one stay_silent call. `required` is true once the turn must answer: a message merged into it mentions the assistant
 * (or is a private message), as that message on its own would need an answer. Then the call is refused and the turn goes on.
 */
export function staySilent(args: unknown, required: boolean): Json {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Json : null;
  if (!input || Object.keys(input).some(key => key !== 'reason') || input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > maxReason))
    return { error: 'invalid_arguments', detail: `${staySilentName} takes only an optional reason of at most ${maxReason} characters.` };
  if (required) return { error: 'reply_required', detail: 'A message in this turn is addressed to you and needs an answer; nothing ends silently now. Answer it.' };
  return { silent: true, reason: String(input.reason ?? '').trim() };
}
