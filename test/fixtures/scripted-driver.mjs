// A test-only role driver (#1256). In-process tests of role and task mechanics run their scripted fake model through it.
// It is registered in the test process only, so no project, role or console can ever choose it. It keeps its own model
// and tool exchange, the process driver's worker loop (runner/role-worker.mjs) without the child process, and never runs
// the control-plane tool loop that #1257 removes.
// The store first: entered at roles/harness.js, the module graph would run tasks/followups.js before tasks/priority.js
// has finished (a test file may import this fixture before anything else).
import '../../dist/storage/database.js';
import { registerRoleHarness, completeTranscript } from '../../dist/roles/harness.js';
import { submissionFeedback } from '../../dist/roles/submission-feedback.js';
import { toolArguments, toolCallsProblem, finalizationReserve } from '../../dist/agent/tool-context.js';
import { stop } from '../../dist/agent/common.js';
import { traceEvent } from '../../dist/tasks/trace.js';
import { consumePendingTaskUpdates } from '../../dist/review/bot-pr-wake.js';

export const scriptedHarness = 'scripted';
registerRoleHarness({ id: scriptedHarness, version: 'test', session: 'checkpoint_transcript', events: 'tool_observations',
  kinds: ['controller', 'writer', 'observer', 'evaluator'], structured_output: ['tool_call', 'text_json'],
  capabilities: { raw_evidence: 'control_plane_tools', cancel: 'abort_signal', isolation: 'none', version_binding: true, output_validation: true,
    fresh_context: true, recovery: ['checkpoint_restore', 'rebuilt_from_task_records'] } },
spec => services => run(spec, services));

async function run(spec, services) {
  const maxTurns = spec.maxTurns ?? 16, finishes = spec.finish ? spec.finish.names ?? [spec.finish.name] : [];
  const closingNames = spec.finalizationTools ?? finishes, reserve = finalizationReserve(maxTurns), offeredTools = spec.tools ?? [];
  const messages = spec.session?.messages.length ? [...spec.session.messages, { role: 'user', content: spec.prompt }]
    : [{ role: 'system', content: spec.system }, { role: 'user', content: spec.prompt }];
  // A transcript whose every call has its result is a safe point to end a run, as for the process driver.
  const save = async () => { spec.session?.save(spec.redactor.clean(messages)); if (spec.checkpoint && completeTranscript(messages)) await spec.checkpoint(); };
  for (let turn = 0; turn < maxTurns; turn++) {
    await services.guard(); await save();
    const continued = turn > 0 && spec.task.id ? consumePendingTaskUpdates(spec.store, String(spec.task.id)) : [];
    if (continued.length) messages.push({ role: 'user', content: 'New events continued into this task while it was running; incorporate these facts before finishing (recorded contract and authority remain binding):\n' + JSON.stringify(spec.redactor.clean(continued)) });
    const closing = !!spec.finish && turn >= maxTurns - reserve, tools = closing ? offeredTools.filter(t => closingNames.includes(t.function.name)) : offeredTools;
    if (spec.finish && turn === maxTurns - reserve) messages.push({ role: 'user', content: `Execution has ${reserve} turns left. Save the bounded artifact and call ${finishes.join(' or ')}.` });
    const { value, request_log_id } = await services.request({ messages, tools, tool_choice: tools.length ? 'auto' : 'none' }, `turn:${turn}`);
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
