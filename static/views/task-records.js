// Reads a task route that pages with `next_after` (oldest first) until the server says there is no more, so the newest
// records (the delegation running now) are never cut off. If the cursor stops moving forward, reading stops and the
// result is marked incomplete; callers must then not claim to know what is happening now.
async function pagedTaskRecords(path, key, after = 0) {
  let first = null, rows = [], complete = true;
  for (;;) {
    const value = await api(`${path}${path.includes('?') ? '&' : '?'}limit=100&after=${after}`), page = Array.isArray(value[key]) ? value[key] : [];
    first ||= value; rows = rows.concat(page);
    if (value.next_after == null) break;
    if (!page.length || !(Number(value.next_after) > after)) { complete = false; break; }
    after = Number(value.next_after);
  }
  return first && { ...first, [key]: rows, complete };
}
const taskRoleView = id => pagedTaskRecords(`/api/tasks/${encodeURIComponent(id)}/roles`, 'assignments').catch(() => null);
const runCaptions = { running: '进行中', completed: '已结束', succeeded: '已结束', fault: '中止', failed: '失败', interrupted: '中断', stopped: '已停止', cancelled: '已取消' };
const stopReasons = { role_revision_checkpoint: '换到新 revision', engine_restart: '控制面重启', cancel_timeout: '取消超时' };
const recoveryModes = { new_session: '新会话', checkpoint_transcript: '从检查点续接', native_resume: '原会话恢复', rebuilt_from_task_records: '按任务记录重建', fresh_evaluation: '全新验收' };
// A task's role records (GET /api/tasks/:id/roles). Each delegation keeps the runs that actually executed it, with the
// harness each run used, and the role's name and responsibility from the snapshot its latest run started with: a role
// instance may be rebound to another harness or definition later, which must not rewrite the past. Only a delegation
// that has not run yet takes the instance's current snapshot; one whose run has no readable snapshot (role_snapshot may
// be null) is marked as having no historical definition rather than borrowing today's.
// Null when the records cannot be read, so the page says so instead of guessing how the task ran.
function roleRecords(value) {
  if (!value || !Array.isArray(value.instances)) return null;
  const byInstance = new Map(value.instances.map(instance => [instance.id, instance])), runs = Array.isArray(value.runs) ? value.runs : [];
  const snapshots = value.snapshots && typeof value.snapshots === 'object' ? value.snapshots : {}, snapshot = id => id && Object.hasOwn(snapshots, id) ? snapshots[id] : null;
  return { instances: value.instances, runs, snapshot, complete: value.complete !== false,
    assignments: (Array.isArray(value.assignments) ? value.assignments : []).map(a => {
      const instance = byInstance.get(a.instance_id), mine = runs.filter(run => run.assignment_id === a.id);
      // Before its first run a delegation can only name the harness and definition its instance is bound to now.
      const harnesses = mine.length ? mine.map(run => run.harness).filter(Boolean).filter((id, at, list) => id !== list[at - 1]) : [instance?.harness].filter(Boolean);
      const definition = mine.length ? snapshot(mine.at(-1).role_snapshot) : snapshot(instance?.snapshot_id);
      return { ...a, role: instance?.role, name: definition?.name, responsibility: definition?.responsibility, definitionMissing: mine.length > 0 && !definition, runs: mine, harnesses, harness: harnesses.at(-1) };
    }) };
}
// The purpose the controller wrote for each delegation lives in its handoff event. Handoff events only accumulate, so
// later refreshes read only the events after the last one read, and only while some delegation has not been matched.
let handoffPurposes = { task: null, after: 0, purposes: {} };
async function rolePurposes(id, roles) {
  if (!roles?.assignments.length) return {};
  if (handoffPurposes.task !== id) handoffPurposes = { task: id, after: 0, purposes: {} };
  const cache = handoffPurposes;
  if (roles.assignments.every(a => Object.hasOwn(cache.purposes, a.id))) return cache.purposes;
  const page = await pagedTaskRecords(`/api/tasks/${encodeURIComponent(id)}/events?type=role_handoff&include_data=1`, 'events', cache.after).catch(() => null);
  for (const event of page?.events || []) {
    if (event.data?.assignment_id) cache.purposes[event.data.assignment_id] = typeof event.data.purpose === 'string' ? event.data.purpose : null;
    if (Number(event.id) > cache.after) cache.after = Number(event.id);
  }
  return cache.purposes;
}
const controllerOf = roles => roles?.instances.find(instance => instance.role === 'manager') || null;
// One sentence: who is doing what right now. Only recorded facts are used: the task's status and phase, its fault
// cause, the runs and delegations still running (with the purpose the controller handed over) and the next action it
// recorded. Independent QA is named only when a running QA run was read: development and review start QA from inside
// their executor without changing the task's phase, and phase acceptance alone does not mean a QA run is going on.
// Delegations are listed oldest first, so the one at work can only be told once all of them are read; until then the
// sentence names nobody.
function taskNextStep(task, record, roles, purposes = {}) {
  const caption = (states[task.status] || [task.status])[0], cause = task.error_cause, next = record?.progress?.next_action;
  if (['succeeded', 'completed', 'pr_opened'].includes(task.status)) {
    const accepted = record?.acceptance && ['pass', 'pass_with_issues'].includes(record.acceptance.outcome) && record.candidate?.id === record.acceptance.candidate_id && record.revision === record.acceptance.revision;
    return `${caption}：${accepted ? '独立 QA 对当前候选的验收已通过。' : '没有读取到当前候选的有效独立 QA 通过记录，请核对任务事实。'}${task.status === 'pr_opened' ? 'PR 已创建，合入与 GitHub CI 状态需分别核对。' : '任务执行已结束。'}`;
  }
  if (task.status === 'cancelled') return '已取消，没有下一步。';
  if (task.status === 'superseded') return '已过时：同一对象有更新的任务接手，这个任务不再继续。';
  if (task.status === 'failed') return '已失败' + (cause ? `：${cause.label}。${cause.action}` : `（${task.error_code || '没有错误码'}）。`);
  if (task.status === 'queued') return '排队中：等这个仓库的项目电脑空闲后开始。';
  if (task.status.startsWith('waiting_') || ['retry_wait', 'needs_replan', 'needs_help', 'paused'].includes(task.status))
    return `已暂停（${caption}）` + (cause ? `：${cause.label}。${cause.action}` : task.error_code ? `：${task.error_code}。` : '。');
  if (task.status === 'publishing' || task.phase === 'publish') return '控制面正在把验收通过的结果发布到 GitHub。';
  if (roles?.runs.some(run => run.role === 'qa' && run.status === 'running')) return `独立 QA 正在新的上下文里验收候选 ${shortId(record?.candidate?.id)}。`;
  if (roles && !roles.complete) return `委派记录没有读完（已读 ${roles.assignments.length} 条），现在说不清是谁在处理。`;
  const working = roles?.assignments.filter(a => a.status === 'running' && !['manager', 'qa'].includes(a.role)).at(-1);
  if (working) return `${roleLabel(working.role, working.name)}（${harnessName(working.harness)}）${task.origin?.source_kind === 'role' ? '正在处理任务' : '正在做主控交给它的工作'}` + (purposes[working.id] ? `：${clipText(purposes[working.id], 160)}` : '。');
  if (task.phase === 'prepare') return '控制面正在准备工作区：拉取固定提交，写入项目电脑。';
  if (task.phase === 'validate') return '控制面正在项目电脑里运行仓库测试。';
  // Without any role records the page cannot tell who is at work, and does not pretend to.
  if (!roles) return `正在执行（${phaseLabels[task.phase] || task.phase || '阶段未知'}）；读不到角色记录，说不清现在是谁在处理。`;
  // All records read, the acceptance phase, and no QA run going on: QA has not started yet or has already returned.
  if (task.phase === 'acceptance') return '任务处在独立验收阶段，但现在没有正在运行的 QA：控制面还没开始这次验收，或者正在处理验收结论。';
  if (task.origin?.source_kind === 'role' && task.origin.executor_role) return `角色 ${task.origin.executor_role} 正在处理` + (next ? `：${next}` : '。');
  if (controllerOf(roles)) return '主控 Manager 正在读任务记录，决定下一步委派谁' + (next ? `；它记下的下一步：${next}` : '。');
  return '执行器正在处理' + (next ? `：${next}` : '。');
}
