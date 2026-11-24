// A test-only role driver (#1256). In-process tests of role and task mechanics run their scripted fake model through it.
// It is registered in the test process only and as unlisted (`listed: false`), so no production process has it and no
// backend listing offers it, even in a long-lived test process such as a Playwright worker. It keeps its own model
// and tool exchange and never runs the control-plane tool loop that #1257 removes: a role run keeps a checkpointed
// transcript in process (the loop of the Process driver, removed in #1338), a service assistant's turn follows Pi.
// The store first: entered at roles/harness.js, the module graph would run tasks/followups.js before tasks/priority.js
// has finished (a test file may import this fixture before anything else).
import '../../dist/storage/database.js';
import { registerRoleHarness } from '../../dist/roles/harness.js';
import { submissionFeedback } from '../../dist/roles/submission-feedback.js';
import { toolArguments, toolCallsProblem, finalizationReserve } from '../../dist/agent/tool-context.js';
import { stop } from '../../dist/agent/common.js';
import { traceEvent } from '../../dist/tasks/trace.js';
import { consumePendingTaskUpdates } from '../../dist/review/bot-pr-wake.js';
import { createTaskToolDispatcher } from '../../dist/roles/task-tools.js';

export const scriptedHarness = 'scripted';
registerRoleHarness({ id: scriptedHarness, version: 'test', listed: false, session: 'checkpoint_transcript', events: 'tool_observations',
  kinds: ['controller', 'writer', 'observer', 'evaluator'],
  capabilities: { raw_evidence: 'control_plane_tools', cancel: 'abort_signal', isolation: 'none', version_binding: true, output_validation: true,
    fresh_context: true, recovery: ['checkpoint_restore', 'rebuilt_from_task_records'] }, steered_turns: true },
spec => services => serviceTurn(spec) ? runServiceTurn(spec, services) : run(spec, services));

// serviceHarnessTurn's run context is the only one with the assistant environment profile.
const serviceTurn = spec => spec.runContext?.()?.execution_context?.environment_profile === 'assistant';

/**
 * A service assistant's turn (#1256), as Pi works it (runner/pi-entry.mjs with src/agent/pi.ts), so in-process tests of the
 * management and group assistants check what production runs. Tools run through the harness tool dispatcher: a
 * correctable refusal comes back to the model as an observation, results are bounded and tool images return with them. An
 * answer in text ends the turn; a finishing call (finish, or stay_silent when the turn may stay silent) ends it with its
 * submission. With the steering serviceHarnessTurn gives a driver declaring `steered_turns` (spec.pi.service), messages
 * taken before the first request and at each boundary after a tool batch join as user messages, the answer streams, and
 * each response says whether it called tools. An edit throws from the steering or a tool call, and serviceHarnessTurn
 * starts the turn again.
 */
async function runServiceTurn(spec, services) {
  const steering = spec.pi?.service, maxTurns = spec.maxTurns ?? 32, tools = spec.tools ?? [];
  const messages = [{ role: 'system', content: spec.system }, { role: 'user', content: spec.prompt }];
  const join = added => { for (const content of added ?? []) messages.push({ role: 'user', content }); };
  if (steering) join(steering.steer());
  const onToken = steering && (async delta => { if (typeof delta?.content === 'string' && delta.content) await steering.text(spec.redactor.text(delta.content)); });
  const dispatcher = createTaskToolDispatcher(spec, { includeSubmissionDetails: true });
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      await services.guard();
      // Each model step as it starts, as Pi's runner reports it for a service turn (#1296).
      spec.onHarnessEvent?.({ type: 'model_start', step: turn + 1 });
      const { value } = await services.request({ messages, tools, tool_choice: tools.length ? 'auto' : 'none' }, `turn:${turn}`, onToken);
      const message = value?.choices?.[0]?.message;
      if (!message) stop('agent_output_invalid');
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      steering?.responded(calls.length > 0);
      if (!calls.length) return spec.onTurnEnd({ text: spec.redactor.text(typeof message.content === 'string' ? message.content : '') });
      if (toolCallsProblem(calls)) stop('agent_tool_calls_invalid');
      messages.push(spec.redactor.clean({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: calls }));
      for (const call of calls) {
        await services.guard();
        const args = toolArguments(call);
        // Arguments that are not a JSON object come back for the model to correct, as Pi's own validation does.
        const out = args === null || typeof args !== 'object' || Array.isArray(args) ? { observation: { error: 'invalid_arguments', detail: 'Tool arguments must be a JSON object.' } }
          : await dispatcher.call(dispatcher.token, { id: call.id, name: call.function.name, arguments: args, transport: 'mailbox' });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.observation) });
        if (out.submitted) return dispatcher.result;
        if (out.images?.length) messages.push({ role: 'user', content: out.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })) });
      }
      if (steering) join((await steering.boundary()).messages);
    }
    stop('agent_turn_limit', 'failed', `Agent 达到 ${maxTurns} 轮上限，请检查已取得的证据后继续。`);
  } finally { await dispatcher.close(); }
}

const completeTranscript = messages => {
  const last = messages.findLastIndex(m => m?.role === 'assistant');
  if (last < 0 || !messages[last].tool_calls?.length) return true;
  const answered = new Set(messages.slice(last + 1).filter(m => m?.role === 'tool').map(m => m.tool_call_id));
  return messages[last].tool_calls.every(c => answered.has(c.id));
};
async function run(spec, services) {
  const maxTurns = spec.maxTurns ?? 32, finishes = spec.finish ? spec.finish.names ?? [spec.finish.name] : [];
  const closingNames = spec.finalizationTools ?? finishes, reserve = finalizationReserve(maxTurns), offeredTools = spec.tools ?? [];
  const messages = spec.session?.messages.length ? [...spec.session.messages, { role: 'user', content: spec.prompt }]
    : [{ role: 'system', content: spec.system }, { role: 'user', content: spec.prompt }];
  // A transcript whose every call has its result is a safe point to end a run.
  const save = async () => { spec.session?.save(spec.redactor.clean(messages)); if (spec.checkpoint && completeTranscript(messages)) await spec.checkpoint(); };
  for (let turn = 0; turn < maxTurns; turn++) {
    await services.guard(); await save();
    const continued = turn > 0 && spec.task.id ? consumePendingTaskUpdates(spec.store, String(spec.task.id)) : [];
    if (continued.length) messages.push({ role: 'user', content: 'New events continued into this task while it was running; incorporate these facts before finishing (recorded contract and authority remain binding):\n' + JSON.stringify(spec.redactor.clean(continued)) });
    const closing = !!spec.finish && turn >= maxTurns - reserve, tools = closing ? offeredTools.filter(t => closingNames.includes(t.function.name)) : offeredTools;
    // The process worker's closing turns: the finalization notice, then on the last turn a forced single submission.
    const last = closing && turn === maxTurns - 1;
    if (spec.finish && turn === maxTurns - reserve) messages.push({ role: 'user', content: `Execution has ${reserve} turns left. ${spec.finish.finalizationMessage ?? 'Save the bounded artifact and submit the honest current result. Reuse existing evidence; do not invent verification.'}` });
    if (last) messages.push({ role: 'user', content: `This is the last turn. Call ${finishes.join(' or ')} to submit now.` });
    const toolChoice = last && finishes.length === 1 ? { type: 'function', function: { name: spec.finish.name } } : tools.length ? 'auto' : 'none';
    const { value, request_log_id } = await services.request({ messages, tools, tool_choice: toolChoice }, `turn:${turn}`);
    const message = value?.choices?.[0]?.message;
    if (!message) stop('agent_output_invalid');
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (toolCallsProblem(message.tool_calls)) stop('agent_tool_calls_invalid');
      messages.push(spec.redactor.clean({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: message.tool_calls }));
      for (const call of message.tool_calls) {
        await services.guard();
        const name = call.function.name, args = toolArguments(call), offered = tools.some(t => t.function.name === name);
        const started = spec.task.trace_run_id ? traceEvent(spec.store, spec.task.id, 'tool_started', { call_id: call.id, name, arguments: spec.redactor.clean(args), model_request_id: request_log_id }, spec.task.trace_run_id, 'agent') : null;
        let result;
        if (args === null) result = { error: 'invalid_tool_arguments' };
        else if (!offered) { spec.onDenied?.(name, 'not_offered'); result = { error: 'tool_not_allowed' }; }
        else if (finishes.includes(name)) {
          try {
            const submitted = await spec.finish.validate(args, name);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ submitted: true }) });
            for (const pending of message.tool_calls.slice(message.tool_calls.indexOf(call) + 1)) messages.push({ role: 'tool', tool_call_id: pending.id, content: JSON.stringify({ skipped: 'execution_submitted' }) });
            await save(); return submitted;
          } catch (error) { result = submissionFeedback(spec, error); if (!result) throw error; }
        } else { spec.screen?.(name, args); result = spec.execute ? await spec.execute(name, args) : { error: 'tool_not_allowed' }; }
        if (started) traceEvent(spec.store, spec.task.id, 'tool_observation', { call_id: call.id, name, observation: spec.redactor.clean(result) }, spec.task.trace_run_id, 'tool', [started]);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(spec.redactor.clean(result)) });
      }
      continue;
    }
    const text = typeof message.content === 'string' ? message.content : '';
    if (spec.finish && !spec.validate) {
      messages.push({ role: 'assistant', content: spec.redactor.text(text) }, { role: 'user', content: `A text response is not a submission. Call ${finishes.join(' or ')} with the structured result.` });
      continue;
    }
    try { const result = spec.validate ? await spec.validate(text) : spec.redactor.text(text); messages.push({ role: 'assistant', content: spec.redactor.text(text) }); await save(); return result; }
    catch (error) {
      const feedback = submissionFeedback(spec, error); if (!feedback) throw error;
      messages.push({ role: 'assistant', content: spec.redactor.text(text) }, { role: 'user', content: JSON.stringify(feedback) });
    }
  }
  stop('agent_turn_limit', 'failed', `Agent 达到 ${maxTurns} 轮上限，请检查已取得的证据后继续。`);
}
