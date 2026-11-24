import type { Store, Row } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { roleKind } from './catalog.js';
import { entryEnabled, roleConfiguration, type RoleConfiguration } from './definition.js';
import { memoryAuthorize, type MemoryAccess } from '../memory/access.js';
import { traceClean } from '../tasks/trace.js';

/** Attributes a due `queued` task under controller or direct executor-role dispatch. */
export function attributeControllerQueuedRole(task: Row, config: RoleConfiguration, origin?: Row | null): string | null {
  const enabled = new Set(config.roles.filter(r => r.enabled).map(r => r.role_id));
  if (task.phase === 'acceptance') return enabled.has('qa') ? 'qa' : null;
  const explicitRole = typeof origin?.executor_role === 'string' && origin.executor_role
    ? origin.executor_role
    : (() => { const r = parseJson(task.input)?.executor_role; return typeof r === 'string' && r ? r : null; })();
  if (explicitRole) {
    return enabled.has(explicitRole) ? explicitRole : null;
  }
  const kind = String(task.kind ?? '');
  let target: string | null = null;
  if (kind === 'development.issue' || kind === 'development.pr' || kind === 'task.development') {
    target = entryEnabled(config, 'development') ? config.controller.role : 'dev';
  } else if (kind === 'task.request') {
    target = entryEnabled(config, 'request') ? config.controller.role : 'dev';
  } else if (kind === 'review.issue' || kind === 'review.pr') {
    target = enabled.has('reviewer') ? 'reviewer' : entryEnabled(config, 'review') ? config.controller.role : 'dev';
  } else if (kind === 'actions.failures') {
    target = entryEnabled(config, 'actions') ? config.controller.role : 'dev';
  } else if (kind.startsWith('workflow.') || kind === 'release.observe' || kind === 'release.notes') {
    target = 'dev';
  }
  return target && enabled.has(target) ? target : null;
}

/** Resolves the exact role whose concurrency limit blocked a `status='retry_wait' & error_code='role_capacity'` task (#283). */
export function attributeCapacityWaitingRole(store: Store, taskId: string, config: RoleConfiguration): string | null {
  const enabled = new Set(config.roles.filter(r => r.enabled).map(r => r.role_id));
  const stoppedRun = store.get("SELECT role FROM task_runs WHERE task_id=? AND stop_reason='role_capacity' AND role IS NOT NULL ORDER BY rowid DESC LIMIT 1", taskId);
  if (stoppedRun?.role && enabled.has(String(stoppedRun.role))) return String(stoppedRun.role);
  const admission = store.get("SELECT json_extract(data,'$.role') AS role FROM task_history WHERE task_id=? AND type='role_run_admission' ORDER BY id DESC LIMIT 1", taskId);
  if (admission?.role && enabled.has(String(admission.role))) return String(admission.role);
  const fault = store.get("SELECT json_extract(content,'$.detail') AS detail FROM task_logs WHERE task_id=? AND length(content)<=4096 AND json_valid(content) AND json_extract(content,'$.type')='fault' AND json_extract(content,'$.code')='role_capacity' ORDER BY rowid DESC LIMIT 1", taskId);
  const prefix = typeof fault?.detail === 'string' ? /^([^：:\s]+)[：:]/.exec(fault.detail)?.[1] : null;
  return prefix && enabled.has(prefix) ? prefix : null;
}

function overlapObserverRuns(a: Row, b: Row): boolean {
  if (a.role === b.role) return false;
  if (a.candidate_version && b.candidate_version && a.candidate_version === b.candidate_version) return true;
  const aStart = Date.parse(String(a.started_at ?? ''));
  const bStart = Date.parse(String(b.started_at ?? ''));
  const aEnd = a.ended_at ? Date.parse(String(a.ended_at)) : Infinity;
  if (!Number.isNaN(aStart) && !Number.isNaN(bStart)) {
    return bStart <= aEnd + 1500;
  }
  return false;
}

function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function clipText(value: unknown, max = 140): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

interface BuiltFlow {
  flow: Json;
  blocks: Record<string, any>[];
}

function buildTaskFlow(
  store: Store,
  task: Record<string, any>,
  config: RoleConfiguration,
  runs: Row[],
  snapshots: Map<string, any>,
  historyRows: Row[],
  origin: Row | null,
  logCounts: Map<string, number>,
): BuiltFlow {
  const roleDefs = new Map(config.roles.map(r => [r.role_id, r]));
  const controllerRole = config.controller.role;
  const activeWorkerRun = runs.find(r => r.status === 'running' && r.role !== controllerRole) ?? null;

  const resultByRun = new Map<string, any>();
  const resultByAssignment = new Map<string, any>();
  const handoffByAssignment = new Map<string, any>();
  const handoffsByRun = new Map<string, any[]>();
  const nominatedRuns = new Set<string>();
  const dispositionByRun = new Map<string, any>();
  const acceptanceByRun = new Map<string, any>();
  let latestAcceptance: any = null;

  for (const row of historyRows) {
    const data = parseJson(row.data);
    if (!data) continue;
    const runId = row.run_id ? String(row.run_id) : null;
    if (row.type === 'role_result') {
      if (runId) resultByRun.set(runId, data);
      if (data.assignment_id) resultByAssignment.set(String(data.assignment_id), data);
    } else if (row.type === 'role_handoff') {
      if (data.assignment_id) handoffByAssignment.set(String(data.assignment_id), data);
      if (runId) {
        const list = handoffsByRun.get(runId) ?? [];
        list.push(data);
        handoffsByRun.set(runId, list);
      }
    } else if (row.type === 'delivery_nominated' && runId) {
      nominatedRuns.add(runId);
    } else if (row.type === 'manager_disposition' && runId) {
      dispositionByRun.set(runId, data);
    } else if (row.type === 'acceptance' || row.type === 'acceptance_evaluated') {
      latestAcceptance = data;
      if (runId) acceptanceByRun.set(runId, data);
    }
  }

  // Group runs into sequential stages, merging adjacent overlapping observer runs into parallel groups.
  const groups: Row[][] = [];
  for (const run of runs) {
    const kind = roleDefs.get(String(run.role))?.kind ?? roleKind(String(run.role));
    const prev = groups.at(-1);
    if (kind === 'observer' && prev && prev.every(p => (roleDefs.get(String(p.role))?.kind ?? roleKind(String(p.role))) === 'observer') && prev.some(p => overlapObserverRuns(p, run))) {
      prev.push(run);
    } else {
      groups.push([run]);
    }
  }

  let devSeq = 0;
  const stages: { parallel: boolean; nodes: Record<string, any>[] }[] = [];
  const blocks: Record<string, any>[] = [];

  groups.forEach((group, groupIdx) => {
    const stageNum = groupIdx + 1;
    const isParallel = group.length > 1;
    const stageNodes: Record<string, any>[] = [];

    group.forEach((run, subIdx) => {
      const runId = String(run.id);
      const role = String(run.role);
      const def = roleDefs.get(role);
      const kind = def?.kind ?? roleKind(role);
      const snap = run.role_snapshot ? snapshots.get(String(run.role_snapshot)) : null;
      const indexLabel = isParallel ? `${stageNum}${String.fromCharCode(97 + subIdx)}` : `${stageNum}`;
      const name = (snap?.name ?? def?.name) || role;
      if (role === 'dev') devSeq++;
      const currentDevRound = role === 'dev' ? devSeq : 0;

      const roleRes = resultByRun.get(runId) ?? (run.assignment_id ? resultByAssignment.get(String(run.assignment_id)) : null);
      const handoff = run.assignment_id ? handoffByAssignment.get(String(run.assignment_id)) : null;
      const resBody = roleRes?.result ?? null;
      const findings = Array.isArray(resBody?.findings) ? resBody.findings : [];
      const acc = kind === 'evaluator' ? (acceptanceByRun.get(runId) ?? latestAcceptance) : null;
      const gaps = Array.isArray(acc?.gaps) ? acc.gaps : [];

      const isDelegatedController = role === controllerRole && run.status === 'running' && !!activeWorkerRun;
      const isLastRun = run === runs.at(-1);
      const taskPausedState = ['paused', 'waiting_configuration', 'waiting_permission', 'waiting_environment', 'needs_help'].includes(String(task.status));

      let state: string;
      let badge: string;
      let verdictBadge: string;

      if (isDelegatedController) {
        state = 'delegated';
        badge = '✓';
        verdictBadge = '已委派';
      } else if (run.status === 'running') {
        state = 'running';
        badge = kind === 'controller' ? '规划中' : kind === 'observer' ? (role === 'test' ? '测试中' : '检视中') : kind === 'evaluator' ? '验收中' : currentDevRound > 1 ? '返工中' : '实现中';
        verdictBadge = '正在执行';
      } else if (run.status === 'succeeded') {
        if (kind === 'observer' && findings.length > 0) {
          state = 'returned';
          badge = `↩ ${findings.length}问题`;
          verdictBadge = `退回 ${findings.length} 项问题`;
        } else if (kind === 'observer') {
          state = 'completed';
          badge = '✓';
          verdictBadge = '通过 · 0 问题';
        } else if (kind === 'evaluator' && acc && ['fail', 'blocked'].includes(String(acc.outcome))) {
          state = 'returned';
          badge = gaps.length ? `↩ ${gaps.length}差距` : '↩ 未通过';
          verdictBadge = gaps.length ? `验收退回 · ${gaps.length} 项差距` : '验收未通过';
        } else if (kind === 'evaluator') {
          state = 'completed';
          badge = '✓';
          verdictBadge = '验收通过';
        } else if (kind === 'writer') {
          state = 'completed';
          badge = '✓';
          verdictBadge = currentDevRound > 1 ? `返工候选 v${currentDevRound}` : '已交回候选';
        } else {
          state = 'completed';
          badge = '✓';
          verdictBadge = nominatedRuns.has(runId) ? '已提名交付' : '已完成';
        }
      } else if (isLastRun && taskPausedState) {
        state = 'paused';
        badge = task.status === 'paused' ? '暂停' : '待处理';
        verdictBadge = task.status === 'paused' ? '已暂停' : '等待介入';
      } else if (run.stop_reason === 'role_revision_checkpoint') {
        state = 'completed';
        badge = '✓';
        verdictBadge = '配置热续接';
      } else {
        state = 'failed';
        badge = '✕ 中断';
        verdictBadge = run.stop_reason ? `中断 · ${run.stop_reason}` : '执行中断';
      }

      let summary: string | null = null;
      if (kind === 'observer') {
        summary = clipText(resBody?.summary) ?? clipText(handoff?.purpose);
      } else if (kind === 'writer') {
        summary = clipText(resBody?.summary ?? resBody?.overview) ?? clipText(handoff?.purpose);
      } else if (kind === 'evaluator') {
        summary = clipText(acc?.reason ?? acc?.summary);
      } else if (kind === 'controller') {
        const disp = dispositionByRun.get(runId);
        const handoffs = handoffsByRun.get(runId) ?? [];
        if (nominatedRuns.has(runId)) summary = '已完成各棒审查并提名候选进入独立 QA 验收';
        else if (disp?.reason) summary = clipText(disp.reason);
        else if (handoffs.length) {
          const rolesList = [...new Set(handoffs.map((h: any) => roleDefs.get(h.role)?.name || h.role))].join(' → ');
          const firstPurpose = clipText(handoffs.at(-1)?.purpose, 90);
          summary = `已派发 ${rolesList}${firstPurpose ? '：' + firstPurpose : ''}`;
        } else {
          summary = state === 'running' ? '正在分析任务目标与规划角色分工' : '已完成任务主控编排';
        }
      }

      const startMs = Date.parse(String(run.started_at ?? ''));
      // When Manager is waiting on delegated child runs, show its planning lead-time up to the first child run rather than ticking alongside the worker.
      let endIso = run.ended_at ? String(run.ended_at) : null;
      if (isDelegatedController) {
        const firstChild = runs.find(r => r.role !== controllerRole && Date.parse(String(r.started_at ?? '')) >= startMs);
        if (firstChild?.started_at) endIso = String(firstChild.started_at);
      }
      const endMs = endIso ? Date.parse(endIso) : Date.now();
      const durationMs = !Number.isNaN(startMs) && !Number.isNaN(endMs) ? Math.max(0, endMs - startMs) : null;
      const harness = String(snap?.harness?.id ?? run.harness ?? def?.harness_ref?.id ?? '');
      const model = snap?.model?.name && snap.model.name !== 'external' ? String(snap.model.name) : null;

      const node = {
        key: runId,
        run_id: runId,
        index_label: indexLabel,
        role,
        name: role === 'dev' && currentDevRound > 1 ? `${name} (v${currentDevRound})` : name,
        full_name: role === 'dev' && currentDevRound > 1 ? `${name}（返工修复 v${currentDevRound}）` : name,
        kind,
        state,
        badge,
        findings_count: kind === 'evaluator' ? gaps.length : findings.length,
        summary,
      };
      stageNodes.push(node);

      blocks.push({
        run_id: runId,
        assignment_id: run.assignment_id ?? null,
        index_label: indexLabel,
        parallel_group: isParallel ? stageNum : null,
        role,
        name: node.full_name,
        short_name: name,
        kind,
        state,
        verdict_badge: verdictBadge,
        summary,
        purpose: clipText(handoff?.purpose, 300),
        findings_count: node.findings_count,
        findings: kind === 'observer' ? findings.slice(0, 10) : kind === 'evaluator' ? gaps.slice(0, 10) : [],
        harness: harness || null,
        model,
        started_at: run.started_at,
        ended_at: run.ended_at ?? null,
        duration_ms: durationMs,
        default_open: state === 'running',
        log_count: logCounts.get(runId) ?? 0,
      });
    });

    stages.push({ parallel: isParallel, nodes: stageNodes });
  });

  // Append queued / capacity-waiting node if currently queued
  const status = String(task.status ?? '');
  if (status === 'queued' || (status === 'retry_wait' && task.error_code === 'role_capacity')) {
    const targetRole = status === 'retry_wait'
      ? attributeCapacityWaitingRole(store, String(task.id), config)
      : attributeControllerQueuedRole(task as Row, config, origin);
    if (targetRole) {
      const def = roleDefs.get(targetRole);
      stages.push({
        parallel: false,
        nodes: [{
          key: `queued:${targetRole}`,
          run_id: null,
          index_label: null,
          role: targetRole,
          name: def?.name || targetRole,
          full_name: def?.name || targetRole,
          kind: def?.kind ?? roleKind(targetRole),
          state: 'queued',
          badge: status === 'retry_wait' ? '等槽位' : '排队中',
          findings_count: 0,
          summary: status === 'retry_wait' ? '等待角色并发限额空闲槽位' : '等待调度器拉起执行',
        }],
      });
    }
  }

  // Append mandatory independent QA gate for development tasks when still ahead
  const terminalCancel = ['cancelled', 'superseded', 'obsolete'].includes(status);
  if (!terminalCancel) {
    const isDevTask = ['development.issue', 'development.pr', 'task.development'].includes(String(task.kind ?? '')) || task.phase === 'acceptance';
    const qaRanPass = runs.some(r => String(r.role) === 'qa' && r.status === 'succeeded') && (!latestAcceptance || ['pass', 'pass_with_issues'].includes(String(latestAcceptance.outcome)));
    const alreadyQueuedQa = stages.some(s => s.nodes.some(n => n.role === 'qa'));
    if (isDevTask && !qaRanPass && !alreadyQueuedQa && !['succeeded', 'pr_opened', 'completed'].includes(status)) {
      const qaDef = roleDefs.get('qa');
      stages.push({
        parallel: false,
        nodes: [{
          key: 'pending:qa',
          run_id: null,
          index_label: null,
          role: 'qa',
          name: qaDef?.name || 'qa',
          full_name: qaDef?.name || 'qa',
          kind: 'evaluator',
          state: 'pending',
          badge: '验收',
          findings_count: 0,
          summary: '待提交候选后执行独立验收',
        }],
      });
    }
  }

  const prNumber = Number.isSafeInteger(task.result?.pr_number) && task.result.pr_number > 0 ? Number(task.result.pr_number) : null;
  if (prNumber && ['pr_opened', 'completed', 'succeeded'].includes(status)) {
    stages.push({
      parallel: false,
      nodes: [{
        key: `pr:${prNumber}`,
        run_id: null,
        index_label: null,
        role: 'pr',
        name: `PR #${prNumber}`,
        full_name: `Pull Request #${prNumber}`,
        kind: 'delivery',
        state: 'completed',
        badge: '✓',
        findings_count: 0,
        summary: typeof task.result?.pr_url === 'string' ? task.result.pr_url : null,
      }],
    });
  }

  const activeNode = stages.flatMap(s => s.nodes).find(n => n.state === 'running') ?? null;
  return {
    flow: {
      stages,
      active_role: activeNode?.role ?? null,
      active_run_id: activeNode?.run_id ?? null,
      has_runs: runs.length > 0,
    },
    blocks,
  };
}

/** Batch-attaches `role_flow` onto a list of public task rows with zero N+1 queries. */
export function attachTaskRoleFlows<T extends Record<string, any>>(store: Store, tasks: T[]): (T & { role_flow: Json })[] {
  if (!tasks.length) return [];
  const ids = tasks.map(t => String(t.id));
  const placeholders = ids.map(() => '?').join(',');

  const configsByRepo = new Map<string, RoleConfiguration>();
  for (const task of tasks) {
    const repoId = String(task.repository_id ?? '');
    if (repoId && !configsByRepo.has(repoId)) configsByRepo.set(repoId, roleConfiguration(store, repoId));
  }

  const runsByTask = new Map<string, Row[]>();
  const snapshotIds = new Set<string>();
  if (store.hasTable('task_runs')) {
    const cols = new Set(store.all('PRAGMA table_info(task_runs)').map(r => String(r.name)));
    if (cols.has('role')) {
      const rows = store.all(`SELECT r.id,r.task_id,r.kind,r.status,r.started_at,r.ended_at,r.stop_reason,r.role,r.assignment_id,r.role_snapshot,r.harness,
        ${store.hasTable('role_assignments') ? '(SELECT a.candidate_version FROM role_assignments a WHERE a.id=r.assignment_id)' : 'NULL'} AS candidate_version
        FROM task_runs r WHERE r.task_id IN (${placeholders}) AND r.role IS NOT NULL AND r.stop_reason IS NOT 'role_capacity' ORDER BY r.rowid ASC`, ...ids);
      for (const row of rows) {
        const list = runsByTask.get(String(row.task_id)) ?? [];
        list.push(row);
        runsByTask.set(String(row.task_id), list);
        if (row.role_snapshot) snapshotIds.add(String(row.role_snapshot));
      }
    }
  }

  const snapshots = new Map<string, any>();
  if (snapshotIds.size && store.hasTable('role_snapshots')) {
    const snapList = [...snapshotIds];
    for (const row of store.all(`SELECT id,snapshot FROM role_snapshots WHERE id IN (${snapList.map(() => '?').join(',')})`, ...snapList)) {
      snapshots.set(String(row.id), parseJson(row.snapshot));
    }
  }

  const historyByTask = new Map<string, Row[]>();
  if (store.hasTable('task_history')) {
    for (const row of store.all(`SELECT id,task_id,type,run_id,created_at,CASE WHEN length(data)<=32768 THEN data END AS data
      FROM task_history WHERE task_id IN (${placeholders})
      AND type IN ('role_result','role_handoff','delivery_nominated','manager_disposition','acceptance','acceptance_evaluated')
      ORDER BY id ASC`, ...ids)) {
      const list = historyByTask.get(String(row.task_id)) ?? [];
      list.push(row);
      historyByTask.set(String(row.task_id), list);
    }
  }

  const originsByTask = new Map<string, Row>();
  if (store.hasTable('task_origins')) {
    for (const row of store.all(`SELECT task_id,source_kind,executor_role FROM task_origins WHERE task_id IN (${placeholders})`, ...ids)) {
      originsByTask.set(String(row.task_id), row);
    }
  }

  const emptyLogCounts = new Map<string, number>();
  return tasks.map(task => {
    const id = String(task.id);
    const config = configsByRepo.get(String(task.repository_id ?? ''))!;
    const { flow } = buildTaskFlow(
      store,
      task,
      config,
      runsByTask.get(id) ?? [],
      snapshots,
      historyByTask.get(id) ?? [],
      originsByTask.get(id) ?? null,
      emptyLogCounts,
    );
    return { ...task, role_flow: flow };
  });
}

function canReadPrivateRunEvents(access: MemoryAccess | undefined, repoId: string): boolean {
  if (!access?.actor) return true;
  try { memoryAuthorize(access, repoId, true); return true; } catch { return false; }
}

/**
 * #1207: `model_requests.state` is not a success flag. A request accounted for by the executor is a completed call,
 * several states are real failures, and anything else stays unknown instead of being reported as a failure.
 */
function modelRequestStepStatus(state: string): 'ok' | 'error' | 'unknown' {
  if (state === 'received' || state === 'external_received' || state === 'external_usage_unknown') return 'ok';
  if (state === 'http_error' || state === 'transport_error' || state === 'invalid_response'
    || state === 'guard_failed' || state === 'interrupted') return 'error';
  return 'unknown';
}

/** Builds normalized per-run step summaries for non-`task_logs` harnesses (`process`, `claude_code`, `codex`, and runs recorded on the retired `native`) while enforcing memory ACLs. */
function buildHistoryStepsForRun(
  store: Store,
  _repoId: string,
  runId: string,
  events: Row[],
  allowPrivate: boolean,
  _access?: MemoryAccess,
): Json[] {
  const safe = (v: any) => traceClean(v);
  const steps: Json[] = [];
  const observationsByCall = new Map<string, { row: Row; data: any; oversize?: boolean }>();

  for (const row of events) {
    if (row.type !== 'tool_observation') continue;
    const data = parseJson(row.data);
    if (!data) {
      // A masked observation still proves the call finished, and its body is read on demand from its own source.
      const callId = row.oversize_call_id ? String(row.oversize_call_id) : '';
      if (callId) observationsByCall.set(callId, { row, data: null, oversize: true });
      continue;
    }
    if (data?.call_id) observationsByCall.set(String(data.call_id), { row, data });
  }

  // A run with native tool rows already lists every call as its own step, so a harness `role_run_event` tool call
  // would duplicate it; its model messages must still appear (#1207).
  const hasNativeTools = events.some(row => row.type === 'tool_started' && !!parseJson(row.data));
  for (const row of events) {
    const data = parseJson(row.data);
    if (!data) {
      // A body over 64 KiB is not shipped with the task detail: keep a placeholder step that reads it on demand.
      const callId = row.oversize_call_id ? String(row.oversize_call_id) : '';
      if (row.type === 'tool_started') {
        // #1207: the call itself stays a step; its arguments and a masked observation are read through their sources
        // instead of the whole call disappearing or claiming a finished call is still running.
        const obs = callId ? observationsByCall.get(callId) : undefined;
        const obsOversize = !!obs?.oversize;
        const obsError = !!(obs?.row as any)?.oversize_error;
        const obsPayload = obsOversize ? null : (obs?.data?.observation?.data ?? obs?.data?.observation ?? null);
        steps.push({
          id: `hist:${row.id}`,
          kind: 'tool',
          tool: row.oversize_name ? String(row.oversize_name) : 'tool',
          created_at: row.created_at,
          status: !obs ? 'unknown' : obsError ? 'error' : 'ok',
          source_ref: obs ? `task_history:${obs.row.id}` : `task_history:${row.id}`,
          input_source: `task_history:${row.id}`,
          output_source: obs ? `task_history:${obs.row.id}` : null,
          arguments: null,
          output: allowPrivate && obsPayload !== null ? safe(obsPayload) : null,
          input_omitted: true,
          output_omitted: obsOversize,
          oversize: true,
          body_omitted: !allowPrivate,
        });
      } else if (row.type === 'role_run_event' || row.type === 'model_request') {
        steps.push({
          id: `hist:${row.id}`,
          kind: 'event',
          tool: null,
          created_at: row.created_at,
          status: 'ok',
          source_ref: `task_history:${row.id}`,
          arguments: null,
          output: null,
          body_omitted: true,
          oversize: true,
        });
      }
      continue;
    }
    if (row.type === 'tool_started') {
      const callId = String(data.call_id ?? row.id);
      const name = String(data.name ?? 'tool');
      const obs = observationsByCall.get(callId);
      const obsOversize = !!obs?.oversize;
      const obsPayload = obsOversize ? null : (obs?.data?.observation?.data ?? obs?.data?.observation ?? null);
      const isError = !!(obs?.row as any)?.oversize_error
        || !!(obsPayload && typeof obsPayload === 'object' && obsPayload.error);
      steps.push({
        id: `hist:${row.id}`,
        kind: 'tool',
        tool: name,
        created_at: row.created_at,
        status: !obs ? 'running' : isError ? 'error' : 'ok',
        source_ref: obs ? `task_history:${obs.row.id}` : `task_history:${row.id}`,
        input_source: `task_history:${row.id}`,
        output_source: obs ? `task_history:${obs.row.id}` : null,
        arguments: allowPrivate ? safe(data.arguments ?? {}) : null,
        output: allowPrivate && obsPayload !== null ? safe(obsPayload) : null,
        output_omitted: obsOversize,
        oversize: obsOversize,
        body_omitted: !allowPrivate,
      });
    } else if (row.type === 'model_request') {
      // #1207: the recorded request/response pair is this step's input and output. Their bodies stay in the
      // trajectory and are read through their own sources, so a prompt is never sliced into the list payload.
      const requestId = String(data.request_id ?? '');
      const state = String(data.state ?? '');
      const requestSource = typeof data.request_source === 'string' ? data.request_source
        : requestId ? `model_requests:${requestId}:request` : null;
      const responseSource = typeof data.response_source === 'string' ? data.response_source
        : requestId ? `model_requests:${requestId}:response` : null;
      steps.push({
        id: `hist:${row.id}`,
        kind: 'model',
        tool: null,
        created_at: row.created_at,
        status: modelRequestStepStatus(state),
        source_ref: `task_history:${row.id}`,
        input_source: allowPrivate ? requestSource : null,
        output_source: allowPrivate ? responseSource : null,
        input_omitted: true,
        output_omitted: true,
        model: row.model_name ? String(row.model_name) : null,
        arguments: null,
        output: null,
        body_omitted: !allowPrivate,
      });
    } else if (row.type === 'role_run_event') {
      const evType = String(data.type ?? '');
      const evData = data.data && typeof data.data === 'object' ? data.data : {};
      if (evType === 'tool_call' && evData.harness_event === 'tool') {
        if (hasNativeTools) continue;
        steps.push({
          id: `hist:${row.id}`,
          kind: 'tool',
          tool: String(evData.name ?? evData.title ?? 'tool'),
          created_at: row.created_at,
          status: evData.status === 'failed' ? 'error' : 'ok',
          source_ref: `task_history:${row.id}`,
          input_source: `task_history:${row.id}`,
          output_source: `task_history:${row.id}`,
          arguments: allowPrivate && evData.input !== undefined ? safe(evData.input) : null,
          output: allowPrivate && evData.output !== undefined ? safe(evData.output) : null,
          body_omitted: !allowPrivate,
        });
      } else if (evType === 'message' && typeof evData.text === 'string' && evData.text.trim()) {
        const text = String(safe(evData.text));
        // The visible text is a preview; the row keeps the whole message and is read on demand when it was cut.
        const truncated = text.length > 6000;
        steps.push({
          id: `hist:${row.id}`,
          kind: 'model',
          tool: null,
          created_at: row.created_at,
          status: 'ok',
          source_ref: `task_history:${row.id}`,
          input_missing: true,
          arguments: null,
          output: allowPrivate ? text.slice(0, 6000) : null,
          output_truncated: allowPrivate && truncated,
          output_source: allowPrivate && truncated ? `task_history:${row.id}` : null,
          body_omitted: !allowPrivate,
        });
      }
    } else if (row.type === 'role_result') {
      steps.push({
        id: `hist:${row.id}`,
        kind: 'role_result',
        tool: 'submit_role_result',
        created_at: row.created_at,
        status: Array.isArray(data.result?.findings) && data.result.findings.length > 0 ? 'returned' : 'ok',
        source_ref: `task_history:${row.id}`,
        arguments: null,
        output: safe(data.result ?? data),
        body_omitted: false,
      });
    } else if (row.type === 'delivery_nominated') {
      steps.push({
        id: `hist:${row.id}`,
        kind: 'nomination',
        tool: 'nominate_delivery',
        created_at: row.created_at,
        status: 'ok',
        source_ref: `task_history:${row.id}`,
        arguments: null,
        output: safe(data),
        body_omitted: false,
      });
    } else if (row.type === 'acceptance' || row.type === 'acceptance_evaluated') {
      steps.push({
        id: `hist:${row.id}`,
        kind: 'acceptance',
        tool: 'acceptance',
        created_at: row.created_at,
        status: ['pass', 'pass_with_issues'].includes(String(data.outcome)) ? 'ok' : 'returned',
        source_ref: `task_history:${row.id}`,
        arguments: null,
        output: safe(data),
        body_omitted: false,
      });
    }
  }
  return steps;
}

/** Detailed role flow + per-role execution blocks (including non-`task_logs` harness steps) for `GET /api/tasks/:id/roles` & `GET /api/tasks/:id`. */
export function taskRoleTrace(store: Store, task: Record<string, any>, access?: MemoryAccess): { role_flow: Json; role_runs: Json[] } {
  const taskId = String(task.id);
  const repoId = String(task.repository_id);
  const config = roleConfiguration(store, repoId);

  const runs = store.hasTable('task_runs')
    ? store.all(`SELECT r.id,r.task_id,r.kind,r.status,r.started_at,r.ended_at,r.stop_reason,r.role,r.assignment_id,r.role_snapshot,r.harness,
        ${store.hasTable('role_assignments') ? '(SELECT a.candidate_version FROM role_assignments a WHERE a.id=r.assignment_id)' : 'NULL'} AS candidate_version
        FROM task_runs r WHERE r.task_id=? AND r.role IS NOT NULL AND r.stop_reason IS NOT 'role_capacity' ORDER BY r.rowid ASC`, taskId)
    : [];

  const snapshots = new Map<string, any>();
  const snapIds = [...new Set(runs.map(r => r.role_snapshot).filter(Boolean))];
  if (snapIds.length && store.hasTable('role_snapshots')) {
    for (const row of store.all(`SELECT id,snapshot FROM role_snapshots WHERE id IN (${snapIds.map(() => '?').join(',')})`, ...snapIds)) {
      snapshots.set(String(row.id), parseJson(row.snapshot));
    }
  }

  const historyRows = store.hasTable('task_history')
    ? (() => {
        const structural = store.all(
          `SELECT id,task_id,type,run_id,created_at,CASE WHEN length(data)<=65536 THEN data END AS data
           FROM task_history WHERE task_id=?
           AND type IN ('role_result','role_handoff','delivery_nominated','manager_disposition','acceptance','acceptance_evaluated')
           ORDER BY id ASC`,
          taskId,
        );
        const stepRows = store.all(
          `SELECT id,task_id,type,run_id,created_at,CASE WHEN length(data)<=65536 THEN data END AS data,
             CASE WHEN length(data)>65536 THEN json_extract(data,'$.call_id') END AS oversize_call_id,
             CASE WHEN length(data)>65536 THEN json_extract(data,'$.name') END AS oversize_name,
             CASE WHEN length(data)>65536 THEN COALESCE(json_extract(data,'$.observation.data.error'),
               json_extract(data,'$.observation.error')) END AS oversize_error,
             (SELECT m.model_name FROM model_requests m WHERE m.id=json_extract(task_history.data,'$.request_id')) AS model_name
           FROM task_history WHERE task_id=?
           AND type IN ('tool_started','tool_observation','role_run_event','model_request')
           ORDER BY id DESC LIMIT 500`,
          taskId,
        );
        stepRows.reverse();
        return [...structural, ...stepRows].sort((a, b) => Number(a.id) - Number(b.id));
      })()
    : [];

  const origin = store.hasTable('task_origins')
    ? (store.get('SELECT task_id,source_kind,executor_role FROM task_origins WHERE task_id=?', taskId) ?? null)
    : null;

  const logCounts = new Map<string, number>();
  if (runs.length && store.hasTable('task_logs')) {
    for (const row of store.all('SELECT run_id,COUNT(*) AS n FROM task_logs WHERE task_id=? AND run_id IS NOT NULL GROUP BY run_id', taskId)) {
      logCounts.set(String(row.run_id), Number(row.n));
    }
  }

  const { flow, blocks } = buildTaskFlow(store, task, config, runs, snapshots, historyRows, origin, logCounts);
  const allowPrivate = canReadPrivateRunEvents(access, repoId);

  const eventsByRun = new Map<string, Row[]>();
  for (const row of historyRows) {
    if (!row.run_id) continue;
    const key = String(row.run_id);
    const list = eventsByRun.get(key) ?? [];
    list.push(row);
    eventsByRun.set(key, list);
  }

  const safeFindings = (items: any[]) => traceClean(items);
  const role_runs = blocks.map(block => {
    const runEvents = eventsByRun.get(String(block.run_id)) ?? [];
    const historySteps = buildHistoryStepsForRun(store, repoId, String(block.run_id), runEvents, allowPrivate, access);
    return {
      ...block,
      summary: block.summary ? traceClean(block.summary) : null,
      purpose: block.purpose ? traceClean(block.purpose) : null,
      findings: safeFindings(block.findings),
      history_steps: historySteps,
    };
  });

  return { role_flow: flow, role_runs };
}
