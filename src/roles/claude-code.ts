import type { AgentSpec, AgentServices } from '../agent/runtime.js';
import { runClaudeCode } from '../harness/claude-code.js';
import { taskToolServer } from './task-tools.js';
import { traceEvent } from '../tasks/trace.js';
import { toolReceipts } from './role-run.js';

/** RoleRun owns prepare/start/events/checkpoint/cancel/collect/recover; this adapter owns only the native CLI transport. */
export function claudeCodeHarness<T>(spec: AgentSpec<T>) {
  return async (services: AgentServices): Promise<T> => {
    const bridge = await taskToolServer(spec);
    try {
      const ctx = spec.runContext?.(), receipts = ctx?.resume_from_run_id ? toolReceipts(spec.store, ctx.resume_from_run_id) : null;
      return await runClaudeCode({ ...spec, guard: services.guard, prompt: spec.prompt + '\nRun context: ' + JSON.stringify(ctx) + '\nPrevious tool receipts: ' + JSON.stringify(receipts) }, bridge, spec.executionSignal!, event => {
        if (event.type === 'session_bound' && spec.task.trace_run_id) spec.store.run('UPDATE task_runs SET recovery_mode=? WHERE id=?', String(event.recoveryMode), spec.task.trace_run_id);
        traceEvent(spec.store, spec.task.id, 'harness_event', spec.redactor.clean(event), spec.task.trace_run_id, 'harness');
        spec.onHarnessEvent?.(spec.redactor.clean(event));
      });
    } finally { await bridge.close(); }
  };
}
