import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { icodeProductId, readAcpProduct, workswarmProductId, type AcpProductManifest } from '../../runner/acp-products.mjs';
import { TaskError, stop } from '../agent/common.js';
import type { RuntimeModel } from '../agent/model.js';
import type { AgentSpec } from '../agent/runtime.js';
import { executionModel } from '../tasks/configuration.js';
import { traceEvent } from '../tasks/trace.js';
import { contentHash } from '../roles/protocol.js';
import { DEFAULT_AGENT_TOOLS_ROOT } from './agent-tools.js';
import { withContainerHarnessSession, type RunningContainerHarness } from './container-session.js';
import type { HarnessEvent } from './session.js';

export const containerAcpId = 'container_acp';
const maxOutputBytes = 8 * 1024 * 1024;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

export async function prepareAcp<T>(spec: AgentSpec<T>, backend = containerAcpId): Promise<AcpProductManifest> {
  const id = backend === icodeProductId || backend === workswarmProductId ? backend : process.env.BOT_ACP_PRODUCT ?? containerAcpId;
  let product: AcpProductManifest;
  try {
    product = readAcpProduct(process.env.BOT_AGENT_TOOLS_DIR ?? DEFAULT_AGENT_TOOLS_ROOT, id);
  } catch (error) {
    return stop('acp_product_not_installed', 'waiting_configuration', `无法读取容器 ACP 产品版本（${(error as NodeJS.ErrnoException).code ?? (error as Error).message}）。`);
  }
  spec.harnessPreparation = product;
  spec.harnessBinding = { harness_revision: `${backend}:${product.id}@${product.version}:${contentHash(product)}`, cli_version: product.version };
  return product;
}

export function acpHarness<T>(spec: AgentSpec<T>, backend = containerAcpId): NonNullable<AgentSpec<T>['adapter']> {
  return async () => {
    const product = spec.harnessPreparation as AcpProductManifest | undefined ?? await prepareAcp(spec, backend);
    const access = spec.harnessAccess;
    if (access && product.launch.access === 'full' && (!access.commands || (access.fileTools ?? access.workspace) !== 'write')) {
      return stop('harness_permission_mismatch', 'waiting_configuration', '此 ACP 产品要求运行命令和写入文件的权限。');
    }
    if (access?.trustedCheckout === false && !product.launch.untrustedCheckout) {
      return stop('harness_permission_mismatch', 'waiting_configuration', '此 ACP 产品未声明可在外部 PR 或未合入分支中执行。');
    }
    const model = (spec.model ?? executionModel(spec.store, spec.task)) as RuntimeModel;
    const workswarm = product.id === workswarmProductId;
    if (workswarm && model.protocol?.interface_type === 'openai-responses') {
      return stop('workswarm_model_protocol_unsupported', 'waiting_configuration', '请选择支持 Chat Completions 或 Anthropic Messages 的 WorkSwarm 模型。');
    }
    const revision = spec.harnessBinding?.harness_revision ?? contentHash(product);
    const binding = spec.harnessState?.value;
    const resumeId = binding?.harness === backend && binding.revision === revision && typeof binding.sessionId === 'string' &&
      spec.roleRun?.recovery_mode !== 'rebuilt_from_task_records' ? binding.sessionId : undefined;
    const rebuilding = Boolean(resumeId || binding?.sessionId || spec.runContext?.()?.resume_from_run_id || spec.roleRun?.recovery_mode === 'rebuilt_from_task_records');
    const signal = spec.executionSignal ?? new AbortController().signal;
    const ready = deferred<{session_id: string; recoveryMode: string}>();
    const turn = deferred<string>();
    const fault = deferred<never>();
    fault.promise.catch(() => {});
    const decoder = new StringDecoder('utf8');
    let buffer = '', text = '', bytes = 0, prompting = false;
    let active: RunningContainerHarness<T> | undefined;
    let cancelReason: unknown;
    let cancelling: Promise<void> | undefined;
    const emit = (event: HarnessEvent) => {
      const cleaned = spec.redactor.clean(event);
      traceEvent(spec.store, spec.task.id, 'harness_event', cleaned, spec.task.trace_run_id, 'harness');
      spec.onHarnessEvent?.(cleaned);
    };
    const cancel = (reason: unknown) => {
      cancelReason ??= reason;
      if (!active) return;
      const session = active;
      cancelling ??= (async () => {
        await session.interrupt('graceful', 1250);
        await Promise.race([session.waitExit().catch(() => {}), delay(1500, undefined, { ref: false })]);
        fault.reject(cancelReason);
      })();
    };
    const onData = (chunk: Buffer) => {
      try {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) throw new TaskError('agent_context_too_large', 'needs_replan');
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (frame.type === 'ready') ready.resolve(frame);
          else if (frame.type === 'fault') {
            const state = ['icode_protocol_unsupported', 'workswarm_protocol_unsupported'].includes(frame.code) ? 'needs_help' : 'retry_wait';
            fault.reject(new TaskError(frame.code, state, spec.redactor.text(String(frame.message))));
          }
          else if (frame.type === 'turn') turn.resolve(frame.stop_reason);
          else if (frame.type === 'event') {
            emit(frame.event);
            if (prompting && frame.event.type === 'message' && frame.event.channel === 'assistant') text += frame.event.text;
          }
        }
      } catch (error) { fault.reject(error); }
    };
    try {
      return await withContainerHarnessSession(workswarm
        ? { ...spec, containerOptions: { ...spec.containerOptions, keepRawTools: true } }
        : spec, {
        cli: containerAcpId, backendId: backend, acpProduct: product, primaryModel: model, model: model.model,
        resume: rebuilding, sessionId: resumeId, sessionKey: spec.harnessSessionKey ?? spec.roleRun?.instance_id,
        manualCancel: cancel,
      }, signal, onData, async session => {
        active = session;
        if (cancelReason) cancel(cancelReason);
        const exited = session.waitExit().then(exit => {
          throw cancelReason ?? new TaskError(exit.error ?? 'acp_process_exited', 'retry_wait', exit.stderr_tail);
        });
        const bound = await Promise.race([ready.promise, fault.promise, exited]);
        if (cancelReason) { await cancelling; throw cancelReason; }
        spec.harnessState?.save({ harness: backend, sessionId: bound.session_id, revision });
        emit({ type: 'session_bound', session_id: bound.session_id, recoveryMode: bound.recoveryMode, version: session.cliVersion, model: model.model, workspace_id: session.workspaceId });
        const submission = spec.finish ? '\nUse the offered bot MCP submission tool to submit the result before ending the turn.' : '';
        const trustedRules = access?.trustedCheckout === false && access.trustedAgentsMd ? `\n\nTrusted repository instructions:\n${access.trustedAgentsMd}` : '';
        const recovery = bound.recoveryMode === 'rebuilt_from_task_records' ? '\nRebuild context from the supplied task records. Check confirmed results before repeating work.' : '';
        const original = bound.recoveryMode !== 'native_resume' && spec.harnessInitialPrompt !== undefined ? `${spec.harnessInitialPrompt}\n\n` : '';
        const input = `${spec.system}${submission}${recovery}${trustedRules}\n\n${original}${spec.prompt}`;
        prompting = true;
        await Promise.race([session.writeStdin(JSON.stringify({ text: input }) + '\n'), fault.promise, exited]);
        const stopReason = await Promise.race([turn.promise, fault.promise, exited]);
        if (cancelReason) { await cancelling; throw cancelReason; }
        await session.closeStdin();
        const exit = await Promise.race([session.waitExit().catch(() => null), delay(2500, null, { ref: false })]);
        if (cancelReason) { await cancelling; throw cancelReason; }
        // A session cancelled by the runner watchdog can report a cancelled turn before its lease outcome arrives.
        if (exit?.error === 'acp_lease_expired') stop('acp_lease_expired', 'retry_wait');
        if (stopReason === 'cancelled') stop('harness_cancelled', 'cancelled');
        await spec.guard();
        emit({ type: 'turn', stop_reason: stopReason, session_id: bound.session_id });
        if (session.dispatcher.submitted) return session.dispatcher.result as T;
        if (spec.onTurnEnd) return spec.onTurnEnd({ text: spec.redactor.text(text), session_id: bound.session_id });
        if (spec.validate && !spec.finish) return spec.validate(spec.redactor.text(text));
        return stop('role_submission_required', 'retry_wait', 'ACP 会话结束时未提交通过校验的角色结果。');
      });
    } catch (error) {
      if (cancelReason || signal.aborted || (error instanceof TaskError && error.state === 'cancelled')) spec.harnessState?.save({});
      throw cancelReason ?? error;
    }
  };
}
