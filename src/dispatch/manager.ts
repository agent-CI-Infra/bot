import { roleConfiguration, rolePrompt } from '../roles/definition.js';
import { permitsTool } from '../roles/permissions.js';
import type { Store } from '../storage/database.js';
import { Redactor, TaskError } from '../agent/common.js';
import { requestModel } from '../agent/gateway.js';
import { selectedModel } from '../agent/model.js';
import { managerPrompt, parseSections, workPermissions } from '../work/settings.js';
import { section, workType, workTypes } from '../work/catalog.js';
import { checkDecision, InvalidDecision, type Decision, type DispatchContext } from './store.js';

// The Manager's duties come from its editable role template and event-dispatch prompt.

const tool = { type: 'function', function: { name: 'dispatch', description: 'Record your decision for this event.', parameters: { type: 'object', additionalProperties: false,
  required: ['decision', 'option_ids', 'reason'], properties: {
    decision: { type: 'string', enum: ['create', 'continue', 'ignore'] },
    option_ids: { type: 'array', items: { type: 'string' }, description: 'create: ids of offered create options (1-3); continue: the id of one offered continue option; ignore: empty' },
    reason: { type: 'string', description: 'Why, in one or two sentences of Simplified Chinese' },
    brief: { type: 'object', additionalProperties: false, required: ['goal'], description: 'Only with create: the goal and acceptance criteria of the new work',
      properties: { goal: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } } } },
    writes: { type: 'array', items: { type: 'string' }, description: 'Only with create, optional: keep only these of the offered writes for the created tasks' } } } } };
const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text;

/** The complete editable dispatch prompt. Older projects retain their instructions until this text is first saved. */
export function dispatchPrompt(store: Store, repositoryId: string) {
  const saved = store.get('SELECT content FROM manager_dispatch_prompts WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId);
  if (saved) return String(saved.content);
  const parsed = parseSections(managerPrompt(store, repositoryId).content), parts: string[] = [];
  if (parsed.preamble) parts.push(parsed.preamble);
  parts.push(parsed.sections.get('dispatch')?.body ?? section('dispatch')!.builtin());
  // The project's own chapters say what each kind of work needs; built-in chapters are summarized by the work type list.
  let room = 40000;
  for (const [id, entry] of parsed.sections) if (id !== 'dispatch' && room > 0) { const text = clip(`## ${entry.title}\n${entry.body}`, room); parts.push(text); room -= text.length; }
  return parts.join('\n\n');
}

/** One bounded model call: the event, the options and the related tasks in, a checked decision out (one correction allowed). */
export async function managerDecision(store: Store, context: DispatchContext): Promise<Decision> {
  const event = context.event, repositoryId = String(event.repository_id), model = selectedModel(store, repositoryId, 'manager');
  const redactor = new Redactor(); redactor.add(model.key);
  const role = roleConfiguration(store, repositoryId).roles.find(role => role.role_id === 'manager')!;
  if (!permitsTool(role.permissions, 'dispatch')) throw new TaskError('role_authority_revoked', 'waiting_configuration', 'manager：事件分派权限已拒绝。');
  const system = rolePrompt(role);
  const work = workTypes.filter(type => context.options.some(option => option.work === type.id)).map(type => `- ${type.id}（${type.name}）：${type.description}`);
  const messages: any[] = [
    { role: 'system', content: `${system}\n\n# Project Manager prompt\n\n${dispatchPrompt(store, repositoryId)}\n\n# Offered work types\n${work.join('\n') || '- (none: only continue or ignore)'}` },
    { role: 'user', content: JSON.stringify({
      event: { id: event.id, type: event.type, source: event.source, summary: event.summary, object: event.object_number ? { type: event.object_type, number: event.object_number } : null, facts: context.facts },
      related_tasks: context.related,
      options: {
        create: context.options.map(option => ({ id: option.id, work: option.work, work_name: workType(option.work)?.name ?? option.work, title: option.title,
          writes: workPermissions(store, repositoryId, option.work).writes })),
        continue: context.continuations } }) }
  ];
  const task = { id: null, repository_id: repositoryId, kind: 'manager.dispatch' };
  for (let round = 0; round < 2; round++) {
    const { value } = await requestModel({ store, task, model, redactor, body: { messages, tools: [tool], tool_choice: { type: 'function', function: { name: 'dispatch' } } },
      requestId: `${event.id}:${event.attempts}:${round}`, maxOutputTokens: 2048 });
    const message = value?.choices?.[0]?.message, call = Array.isArray(message?.tool_calls) ? message.tool_calls.find((c: any) => c?.function?.name === 'dispatch') : null;
    let args: any = null;
    try { args = JSON.parse(call ? call.function.arguments || '{}' : String(message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { args = null; }
    const liveRole = roleConfiguration(store, repositoryId).roles.find(role => role.role_id === 'manager');
    if (!liveRole || !permitsTool(liveRole.permissions, 'dispatch')) throw new TaskError('role_authority_revoked', 'waiting_configuration', 'manager：事件分派权限已拒绝。');
    try { return { ...checkDecision(store, context, args), model: model.model }; }
    catch (error) {
      if (!(error instanceof InvalidDecision) || round === 1) throw error;
      // One correction in the same bounded call: the model sees why its decision was refused.
      messages.push(call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: String(message?.content ?? '') });
      messages.push(call ? { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: error.code, message: error.message }) }
        : { role: 'user', content: `Call the dispatch tool. ${error.message}` });
    }
  }
  throw new TaskError('dispatch_decision_invalid', 'failed');
}
