import type { Store, Row } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { publicationScope } from '../github/publisher.js';

/** Visible outcome for one scheduled check occurrence; unknown codes stay in technical fields only. */
const occurrenceTexts: Record<string, string> = {
  pending: '待执行',
  retry: '等待重试',
  running: '执行中',
  dispatched: '已交给检查任务',
  queued: '待执行',
  succeeded: '已交接，尚无检查任务',
  failed: '执行失败',
  skipped: '已跳过',
  cancelled: '已取消',
  blocked: '未能执行',
  unsupported: '这项执行内容还不能运行',
  budget_exhausted: '已达到运行限额',
  dead: '多次重试仍未执行'
};

const reasonTexts: Record<string, string> = {
  overlap: '上次检查还在进行，本次已跳过',
  misfire: '错过触发时间，已跳过',
  trigger_handler_not_registered: '这项执行内容还不能运行',
  schedule_budget_exhausted: '已达到当天运行次数或费用上限',
  runtime_budget_exhausted: '运行时间超出限制，已停止',
  schedule_not_active: '计划已暂停或已删除，本次未执行',
  schedule_workflow_gate_closed: '项目尚未开放这项执行内容',
  retry_budget_exhausted: '已用完自动重试次数，本次未执行'
};

const taskStatusTexts: Record<string, string> = {
  queued: '排队中',
  paused: '已暂停',
  running: '执行中',
  dispatched: '执行中',
  preparing: '准备中',
  implementing: '开发中',
  validating: '测试中',
  publishing: '发布中',
  result_ready: '待发布',
  succeeded: '已完成',
  completed: '已完成',
  pr_opened: '已打开拉取请求',
  retry_wait: '等待重试',
  waiting_configuration: '配置待补',
  waiting_environment: '等待环境',
  waiting_permission: '权限待处理',
  waiting_publication: '发布待确认',
  waiting_pr_head: '等待 PR 更新',
  waiting_coordination: '等待协调',
  needs_help: '需要帮助',
  needs_replan: '需重新规划',
  superseded: '已被后续任务取代',
  failed: '失败',
  cancelled: '已取消',
  blocked: '已阻止'
};

/** Visible result of the check itself; the occurrence hand-off state stays in technical fields. */
const taskOutcomeTexts: Record<string, string> = {
  queued: '已交给检查任务',
  paused: '已暂停',
  running: '执行中',
  dispatched: '执行中',
  preparing: '准备中',
  implementing: '开发中',
  validating: '测试中',
  publishing: '发布中',
  result_ready: '待发布',
  succeeded: '检查完成',
  completed: '检查完成',
  pr_opened: '检查完成',
  retry_wait: '等待重试',
  waiting_configuration: '配置待补',
  waiting_environment: '等待环境',
  waiting_permission: '权限待处理',
  waiting_publication: '发布待确认',
  waiting_pr_head: '等待 PR 更新',
  waiting_coordination: '等待协调',
  needs_help: '需要帮助',
  needs_replan: '需重新规划',
  superseded: '已被后续检查取代',
  failed: '检查失败',
  cancelled: '已取消',
  blocked: '已阻止'
};

// Finished task.request states the maps already cover. An unmapped code outside this set
// is treated as still in progress: show the occurrence hand-off wording, not 状态未知.
const terminalTaskStatuses = new Set(['succeeded', 'completed', 'pr_opened', 'failed', 'cancelled', 'superseded', 'blocked']);

function visibleTaskText(map: Record<string, string>, status: string, row: Row, unknown: string): string {
  if (map[status]) return map[status];
  if (!terminalTaskStatuses.has(status)) return occurrenceTexts[String(row.state)] || unknown;
  return unknown;
}

const writeRefusalTexts: Record<string, string> = {
  github_resource_forbidden: '没有在这个仓库创建或评论 Issue 的权限',
  schedule_issue_write_disabled: '此计划未允许创建 Issue，只报告发现',
  github_write_route_unsupported: '这次写入方式不受支持',
  github_write_target_missing: '要评论的 Issue 已不存在',
  github_write_token_scope_invalid: 'GitHub 权限与本次写入不符，没有发出请求',
  capability_ceiling: '项目的能力上限阻止了 Issue 写入，需要把上限提升到评论级别'
};

const issueUrl = (value: unknown): string | null =>
  typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+(#[\w./-]*)?$/.test(value) ? value : null;

function planOf(row: Row): { workflow?: string; parameters?: Record<string, unknown> } | null {
  try {
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    return snapshot?.plan ?? null;
  } catch {
    return null;
  }
}

/** Plain-language result of one manager.check occurrence, joined from the check task and github_writes. */
export function checkOccurrenceRecord(store: Store, row: Row): Json | null {
  const plan = planOf(row);
  if (plan?.workflow !== 'manager.check') return null;
  const fileIssues = plan.parameters?.file_issues;
  const uniqueKey = `${row.project_id}:task.request:${row.id}`;
  const task = store.get('SELECT id,repository_id,status,input FROM tasks WHERE unique_key=?', uniqueKey) ?? null;
  const record: Record<string, unknown> = {
    outcome: row.state,
    outcome_text: task
      ? visibleTaskText(taskOutcomeTexts, String(task.status), row, '状态未知')
      : (occurrenceTexts[String(row.state)] || '状态未知'),
    reason: row.reason ?? null,
    reason_text: row.reason ? (reasonTexts[String(row.reason)] ?? null) : null,
    file_issues: typeof fileIssues === 'boolean' ? fileIssues : null,
    task_id: task?.id ?? null,
    task_status: task?.status ?? null,
    task_status_text: task ? visibleTaskText(taskStatusTexts, String(task.status), row, '状态未知') : null,
    issues: [] as Json[],
    write_refusal: null
  };

  if (task) {
    const scope = 'task:' + publicationScope(task);
    const scopes = [...new Set([scope, 'task:' + String(task.id)])];
    const writes = store.all(
      `SELECT method,path,state,status,html_url,error,response FROM github_writes
        WHERE scope IN (${scopes.map(() => '?').join(',')})
        ORDER BY rowid`,
      ...scopes
    );
    const issues: Json[] = [];
    for (const write of writes) {
      if (write.state === 'sent') {
        let title: string | null = null, number: number | null = null;
        try {
          const response = JSON.parse(String(write.response ?? 'null'));
          if (typeof response?.title === 'string' && response.title.trim()) title = response.title.trim().slice(0, 200);
          if (Number.isSafeInteger(response?.number)) number = Number(response.number);
        } catch { /* the stored response is only used for number and title */ }
        const url = issueUrl(write.html_url);
        if (url || number != null) issues.push({
          url,
          number,
          title,
          kind: write.method === 'POST' && write.path === '/issues' ? 'created' : 'updated'
        });
      }
      if ((write.state === 'refused' || write.state === 'failed') && !record.write_refusal) {
        const code = String(write.error || 'github_resource_forbidden');
        const text = fileIssues === false && code === 'github_resource_forbidden'
          ? writeRefusalTexts.schedule_issue_write_disabled
          : (writeRefusalTexts[code] || '创建或评论 Issue 被拒绝');
        record.write_refusal = { code, text };
      }
    }
    record.issues = issues;
  }

  if (fileIssues === false && !record.write_refusal && !(record.issues as Json[]).length)
    record.write_refusal = { code: 'schedule_issue_write_disabled', text: writeRefusalTexts.schedule_issue_write_disabled };

  return record;
}
