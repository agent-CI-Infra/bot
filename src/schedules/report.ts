import type { Store } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { localParts } from './time.js';

export interface ReportEvidence { id: string; kind: string; status: string; url: string; }
export interface DailyReport extends Json {
  text: string; window: { start: number; end: number; timezone: string }; evidence: ReportEvidence[];
  counts: Record<string, number>; missing: string[]; model: string;
}
/** The first report template is deterministic. A future model can select evidence IDs for emphasis;
 * arbitrary model prose cannot become a new status, count or success assertion. */
export class ReportService {
  constructor(readonly store: Store, readonly origin = '') {}
  render(project: string, logicalAt: number, timezone: string, windowMs = 86400000): DailyReport {
    const start = logicalAt - windowMs, end = logicalAt, from = new Date(start).toISOString(), to = new Date(end).toISOString();
    const repo = this.store.get('SELECT full_name FROM repositories WHERE id=?', project)!;
    const base = 'https://github.com/' + repo.full_name, evidence: ReportEvidence[] = [];
    const counts: Record<string, number> = {}, missing: string[] = [];
    const add = (id: string, kind: string, status: string, url: string) => {
      evidence.push({ id, kind, status, url }); const key = kind + ':' + status; counts[key] = (counts[key] ?? 0) + 1;
    };
    for (const t of this.store.all(`SELECT id,status FROM tasks WHERE repository_id=? AND coalesce(nullif(updated_at,''),created_at)>=?
      AND coalesce(nullif(updated_at,''),created_at)<? ORDER BY id`, project, from, to))
      add('task:' + t.id, 'task', t.status, this.origin + '/#/projects/' + project + '/activity?task=' + t.id);
    for (const p of this.store.all("SELECT object_number,github_state FROM board_objects WHERE repository_id=? AND object_type='pr' AND last_seen>=? AND last_seen<? ORDER BY object_number", project, from, to))
      add('pr:' + p.object_number, 'pr', p.github_state ?? 'unknown', base + '/pull/' + p.object_number);
    for (const c of this.store.all(`SELECT id,state FROM management_commands WHERE project_id=? AND created_at>=? AND created_at<?
      AND (state='awaiting_approval' OR EXISTS(SELECT 1 FROM management_approvals a WHERE a.command_id=management_commands.id)) ORDER BY id`, project, from, to))
      add('approval:' + c.id, 'approval', c.state, this.origin + '/api/management/commands/' + c.id);
    const checks = new Map<string, { source: string; status: string; url: string }>();
    for (const delivery of this.store.all(`SELECT id,event,payload FROM deliveries WHERE repository_id=? AND status='accepted' AND duplicate=0
      AND event IN ('workflow_run','check_run','check_suite') AND received_at>=? AND received_at<? ORDER BY received_at,id`, project, from, to)) {
      const body = JSON.parse(Buffer.from(delivery.payload).toString('utf8')), check = body[delivery.event];
      if (!check || !Number.isSafeInteger(check.id)) continue;
      checks.set(`${delivery.event}:${check.id}:${check.run_attempt ?? 1}`, { source: delivery.id, status: check.conclusion ?? check.status ?? 'unknown',
        url: delivery.event === 'workflow_run' ? base + '/actions/runs/' + check.id : base + '/actions' });
    }
    for (const [key, c] of checks) add('delivery:' + c.source + ':' + key, 'ci', c.status, c.url);
    for (const f of this.store.all('SELECT id,run_id,state FROM actions_failure_reports WHERE repository_id=? ORDER BY id', project)) {
      // This table has no trustworthy observation timestamp. Disclose it as a current snapshot,
      // rather than attributing all historical failures to today's window.
      add('actions_failure_report:' + f.id, 'failure_snapshot', f.state, base + '/actions/runs/' + f.run_id);
    }
    const sources: [string, string][] = [['task', '任务'], ['pr', 'PR'], ['approval', '审批'], ['ci', 'CI 检查']];
    for (const [kind, label] of sources) if (!evidence.some(e => e.kind === kind)) missing.push(label + '在该窗口无本地观测，不能据此判定全部成功');
    const running = evidence.filter(e => e.kind === 'task' && !['failed', 'completed', 'succeeded', 'pr_opened', 'cancelled', 'superseded'].includes(e.status)).length;
    const local = (at: number) => { const p = localParts(at, timezone); return `${p[0]}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')} ${String(p[3]).padStart(2, '0')}:${String(p[4]).padStart(2, '0')}`; };
    return { window: { start, end, timezone }, evidence, counts, missing, model: 'deterministic_no_model',
      text: [`项目日报 · ${repo.full_name}`, `时间窗口 [${local(start)}, ${local(end)}) · ${timezone}（实际 ${windowMs / 3600000} 小时）`,
        '统计口径：窗口内最后更新的本地任务/PR 快照、创建的审批、收到的 CI 事件；不是 GitHub 全量实时扫描。失败报告为当前快照，不计作窗口内新故障。',
        ...Object.entries(counts).map(([key, count]) => `${key}: ${count}`), `仍未结束的任务：${running}；不计作成功。`,
        ...missing.map(v => '缺数：' + v), '摘要：确定性统计，未调用模型；模型不可用不影响事实读取。',
        ...evidence.map(e => `${e.kind} · ${e.status} · ${e.url} [${e.id}]`)].join('\n') };
  }
}
