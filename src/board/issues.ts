import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, scope } from '../app/auth.js';
import { fail, type Json } from '../core/security.js';
import { explainFailure } from '../agent/failures.js';
import { projectCeiling, type Ceiling } from '../projects/ceiling.js';
import { readDispatchThread } from '../dispatch/store.js';

export type IssueDevStatus =
  | 'pr_opened'
  | 'developing'
  | 'needs_information'
  | 'human_decision_required'
  | 'blocked'
  | 'skipped'
  | 'pending';

export const issueDevStatuses: { id: IssueDevStatus; name: string; tone: string }[] = [
  { id: 'pr_opened', name: '已开 PR', tone: 'success' },
  { id: 'developing', name: '开发中', tone: 'info' },
  { id: 'needs_information', name: '需补充信息', tone: 'warning' },
  { id: 'human_decision_required', name: '需人工决定', tone: 'warning' },
  { id: 'blocked', name: '开发受阻', tone: 'danger' },
  { id: 'skipped', name: '无需 / 暂不开发', tone: 'neutral' },
  { id: 'pending', name: '待检视', tone: 'neutral' },
];

const validFilters = new Set(['all', 'needs_human', ...issueDevStatuses.map(s => s.id)]);
const needsHumanSet = new Set<IssueDevStatus>(['needs_information', 'human_decision_required', 'blocked']);
const activeDevStates = new Set([
  'queued', 'running', 'preparing', 'implementing', 'validating', 'publishing',
  'retry_wait', 'waiting_pr_head', 'result_ready', 'waiting_coordination', 'waiting_event',
]);
const activeReviewStates = new Set([
  'queued', 'running', 'preparing', 'implementing', 'validating', 'publishing', 'retry_wait', 'result_ready',
]);
const attentionStates = new Set([
  'failed', 'paused', 'waiting_configuration', 'waiting_environment', 'waiting_permission',
  'waiting_publication', 'needs_replan', 'needs_help',
]);
const doneStates = new Set(['succeeded', 'completed', 'pr_opened']);
const autoStopCodes = new Set(['object_closed_or_draft', 'obsolete_closed', 'obsolete_superseded', 'obsolete_expired']);
const ceilingNames: Record<Ceiling, string> = { read: '只读问答', comment: '可评论和打标签', develop: '可开发并开 PR' };
const devStateNames: Record<string, string> = {
  queued: '排队中', running: '执行中', preparing: '准备环境', implementing: '修改代码',
  validating: '运行验证', publishing: '准备发布 PR', retry_wait: '等待自动重试',
  waiting_pr_head: '等待 PR 更新', result_ready: '等待发布', waiting_coordination: '等待协作', waiting_event: '等待事件',
};

function clip(value: unknown, limit = 240): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

interface PrInfo {
  number: number;
  url: string | null;
  github_state: string | null;
  draft: boolean;
  sha: string | null;
  checks: { total: number; passed: number; failed: number; running: number } | null;
}

function deriveIssueRow(
  obj: Row,
  review: Row | undefined,
  dev: Row | undefined,
  pr: PrInfo | null,
  dispatch: Row | undefined,
  progress: { plan?: any; stopped?: any } | null,
  ceiling: Ceiling,
): Json {
  const repoId = String(obj.repository_id);
  const fullName = String(obj.full_name || '');
  const number = Number(obj.object_number);
  const issueUrl = /^[\w.-]+\/[\w.-]+$/.test(fullName) ? `https://github.com/${fullName}/issues/${number}` : null;

  const devPrNumber = dev?.pr_number ? Number(dev.pr_number) : null;
  const effectivePr: PrInfo | null = pr ?? (devPrNumber
    ? {
        number: devPrNumber,
        url: dev?.pr_url ? String(dev.pr_url) : (/^[\w.-]+\/[\w.-]+$/.test(fullName) ? `https://github.com/${fullName}/pull/${devPrNumber}` : null),
        github_state: null,
        draft: false,
        sha: null,
        checks: null,
      }
    : null);

  let status: IssueDevStatus = 'pending';
  let reason = '尚未开始检视';
  let nextStep: string | null = null;

  const devStatus = dev ? String(dev.status) : '';
  const reviewStatus = review ? String(review.status) : '';
  const reviewTime = review ? String(review.updated_at || review.created_at || '') : '';
  const devTime = dev ? String(dev.updated_at || dev.created_at || '') : '';
  const reviewNewerThanDev = !!review && !!dev && reviewTime > devTime && doneStates.has(reviewStatus) && !!review.conclusion && review.conclusion !== 'ready_for_development';

  const devBlocked = !!dev && !reviewNewerThanDev && (
    attentionStates.has(devStatus)
    || (devStatus === 'completed' && Number(dev.no_changes) === 1 && !effectivePr)
    || (devStatus === 'cancelled' && !autoStopCodes.has(String(dev.error_code ?? '')) && !effectivePr)
  );

  if (dev && activeDevStates.has(devStatus)) {
    status = 'developing';
    const stageText = devStateNames[devStatus] || devStatus;
    reason = progress?.plan?.conclusion
      ? `正在开发（${stageText}）：${clip(progress.plan.conclusion, 180)}`
      : `正在开发（${stageText}）`;
  } else if (effectivePr && !devBlocked) {
    status = 'pr_opened';
    const stateLabel = effectivePr.github_state === 'closed' ? '已关闭/合入' : effectivePr.draft ? '草稿' : '开放中';
    const checkLabel = effectivePr.checks && effectivePr.checks.total > 0
      ? (effectivePr.checks.failed > 0 ? ` · 检查 ${effectivePr.checks.failed} 项失败` : effectivePr.checks.running > 0 ? ' · 检查运行中' : ` · 检查 ${effectivePr.checks.passed}/${effectivePr.checks.total} 通过`)
      : '';
    reason = `已开出 PR #${effectivePr.number}（${stateLabel}${checkLabel}）`;
  } else if (devBlocked && dev) {
    status = 'blocked';
    const stoppedReason = progress?.stopped?.reason ? clip(progress.stopped.reason, 220) : '';
    const stoppedAction = progress?.stopped?.human_action ? clip(progress.stopped.human_action, 200) : '';
    if (stoppedReason) {
      reason = stoppedReason;
      nextStep = stoppedAction || null;
    } else if (devStatus === 'completed' && Number(dev.no_changes) === 1) {
      reason = '开发执行结束但未产生代码改动，未开出 PR';
      nextStep = '查看开发任务结论，确认是否需要补充需求或手动处理';
    } else {
      const cause = explainFailure(dev.error_code, devStatus);
      reason = cause?.label || `开发受阻（${devStatus}）`;
      nextStep = cause?.action || '打开开发任务查看原因并决定是否重试';
    }
  } else if (review && doneStates.has(reviewStatus)) {
    const conclusion = review.conclusion ? String(review.conclusion) : '';
    const humanAction = review.human_action ? clip(review.human_action, 220) : '';
    const rec = review.recommendation ? clip(review.recommendation, 220) : '';
    if (conclusion === 'needs_information') {
      status = 'needs_information';
      reason = humanAction || rec || '检视指出缺少必要信息，暂无法自动开发';
      nextStep = '在 Issue 补充缺失信息后，bot 会重新评估';
    } else if (conclusion === 'human_decision_required' || (humanAction && conclusion !== 'ready_for_development' && conclusion !== 'no_code_change')) {
      status = 'human_decision_required';
      reason = humanAction || rec || '检视指出需要人工决定，暂不自动开发';
      nextStep = '维护者确认方案后，可评论或加上开发标签启动开发';
    } else if (conclusion === 'no_code_change') {
      status = 'skipped';
      reason = rec || '检视结论为无需修改代码';
    } else if (ceiling !== 'develop') {
      status = 'skipped';
      reason = `项目能力上限为「${ceilingNames[ceiling]}」，未开启自动开发`;
      nextStep = '如需自动开发，请在项目「监听与触发」将能力上限调至「可开发并开 PR」';
    } else if (dispatch && String(dispatch.decision) === 'ignore') {
      status = 'skipped';
      reason = clip(dispatch.reason, 220) || 'Manager 决定暂不开发';
    } else if (dispatch && ['pending', 'dispatching'].includes(String(dispatch.state))) {
      status = 'pending';
      reason = '检视结论为可开发，正在等待 Manager 分派';
    } else if (dev && devStatus === 'cancelled' && autoStopCodes.has(String(dev.error_code ?? ''))) {
      status = 'skipped';
      reason = '开发已自动停止（Issue 已关闭或被新任务替代）';
    } else {
      status = 'skipped';
      reason = rec || '已完成检视，暂未启动自动开发';
    }
  } else if (review && attentionStates.has(reviewStatus)) {
    status = 'blocked';
    const cause = explainFailure(review.error_code, reviewStatus);
    reason = cause?.label || `Issue 检视受阻（${reviewStatus}）`;
    nextStep = cause?.action || '打开检视任务查看原因并处理';
  } else if (review && activeReviewStates.has(reviewStatus)) {
    status = 'pending';
    reason = '正在检视 Issue';
  } else if (dispatch && String(dispatch.state) === 'filtered') {
    status = 'pending';
    reason = clip(dispatch.reason, 220) || '事件被项目过滤，未启动检视';
  } else if (dispatch && String(dispatch.decision) === 'ignore') {
    status = 'skipped';
    reason = clip(dispatch.reason, 220) || 'Manager 已忽略，未启动处理';
  }

  const lastActivity = [obj.last_seen, reviewTime, devTime, dispatch?.decided_at || dispatch?.created_at]
    .filter((v): v is string => typeof v === 'string' && !!v)
    .sort()
    .at(-1) || String(obj.last_seen || '');

  return {
    repository_id: repoId,
    full_name: fullName,
    number,
    title: obj.title ? String(obj.title) : null,
    url: issueUrl,
    github_state: obj.github_state ? String(obj.github_state) : 'open',
    status,
    reason,
    next_step: nextStep,
    last_activity: lastActivity,
    pr: effectivePr,
    review: review
      ? {
          task_id: String(review.task_id),
          status: reviewStatus,
          conclusion: review.conclusion ? String(review.conclusion) : null,
          recommendation: review.recommendation ? String(review.recommendation) : null,
          human_action: review.human_action ? String(review.human_action) : null,
          updated_at: String(review.updated_at || review.created_at),
        }
      : null,
    development: dev
      ? {
          task_id: String(dev.task_id),
          status: devStatus,
          error_code: dev.error_code ? String(dev.error_code) : null,
          no_changes: Number(dev.no_changes) === 1,
          updated_at: String(dev.updated_at || dev.created_at),
        }
      : null,
    dispatch: dispatch
      ? {
          event_id: String(dispatch.id),
          type: String(dispatch.type),
          state: String(dispatch.state),
          decision: dispatch.decision ? String(dispatch.decision) : null,
          reason: dispatch.reason ? String(dispatch.reason) : null,
          decided_at: dispatch.decided_at ? String(dispatch.decided_at) : String(dispatch.created_at),
        }
      : null,
  };
}

function loadContextMaps(store: Store, repoIds: string[]) {
  const uniqueRepos = [...new Set(repoIds)];
  const ceilings = new Map<string, Ceiling>();
  const latestReview = new Map<string, Row>();
  const latestDev = new Map<string, Row>();
  const latestPr = new Map<string, PrInfo>();
  const latestDispatch = new Map<string, Row>();
  const progressByTask = new Map<string, { plan?: any; stopped?: any }>();
  if (!uniqueRepos.length) return { ceilings, latestReview, latestDev, latestPr, latestDispatch, progressByTask };

  const marks = uniqueRepos.map(() => '?').join(',');
  for (const row of store.all(`SELECT * FROM policies WHERE repository_id IN (${marks})`, ...uniqueRepos)) {
    ceilings.set(String(row.repository_id), projectCeiling(store, String(row.repository_id), row));
  }
  for (const id of uniqueRepos) {
    if (!ceilings.has(id)) ceilings.set(id, projectCeiling(store, id));
  }

  if (store.hasTable('board_issue_tasks')) {
    const taskRows = store.all(
      `SELECT * FROM (
         SELECT t.*, row_number() OVER (
           PARTITION BY t.repository_id, t.object_number, t.role_kind
           ORDER BY t.updated_at DESC, t.created_at DESC, t.rowid DESC
         ) AS rn
         FROM board_issue_tasks t
         WHERE t.repository_id IN (${marks})
       ) WHERE rn=1`,
      ...uniqueRepos,
    );
    for (const row of taskRows) {
      const key = `${row.repository_id}:${row.object_number}`;
      if (row.role_kind === 'review') latestReview.set(key, row);
      else if (row.role_kind === 'development') latestDev.set(key, row);
    }
  }

  if (store.hasTable('bot_pull_requests') && store.hasTable('board_issue_tasks')) {
    const prRows = store.all(
      `SELECT p.repository_id, t.object_number AS issue_number, p.number AS pr_number, p.sha,
         r.full_name, o.github_state, o.draft
       FROM bot_pull_requests p
       JOIN board_issue_tasks t ON t.task_id=p.source_task_id AND t.role_kind='development'
       JOIN repositories r ON r.id=p.repository_id
       LEFT JOIN board_objects o ON o.repository_id=p.repository_id AND o.object_type='pr' AND o.object_number=p.number
       WHERE p.repository_id IN (${marks})
       ORDER BY p.number DESC`,
      ...uniqueRepos,
    );
    const shas = [...new Set(prRows.map(r => r.sha).filter((s): s is string => typeof s === 'string' && !!s))];
    const checksBySha = new Map<string, { total: number; passed: number; failed: number; running: number }>();
    if (shas.length && store.hasTable('commit_checks')) {
      const shaMarks = shas.map(() => '?').join(',');
      for (const c of store.all(
        `SELECT repository_id, head_sha, status, conclusion FROM commit_checks WHERE repository_id IN (${marks}) AND head_sha IN (${shaMarks})`,
        ...uniqueRepos, ...shas,
      )) {
        const ck = `${c.repository_id}:${c.head_sha}`;
        const acc = checksBySha.get(ck) ?? { total: 0, passed: 0, failed: 0, running: 0 };
        acc.total++;
        const st = String(c.status || '').toLowerCase(), conc = String(c.conclusion || '').toLowerCase();
        if (st !== 'completed') acc.running++;
        else if (['success', 'neutral', 'skipped'].includes(conc)) acc.passed++;
        else acc.failed++;
        checksBySha.set(ck, acc);
      }
    }
    for (const row of prRows) {
      const key = `${row.repository_id}:${row.issue_number}`;
      if (latestPr.has(key)) continue;
      const fullName = String(row.full_name || '');
      const sha = row.sha ? String(row.sha) : null;
      latestPr.set(key, {
        number: Number(row.pr_number),
        url: /^[\w.-]+\/[\w.-]+$/.test(fullName) ? `https://github.com/${fullName}/pull/${row.pr_number}` : null,
        github_state: row.github_state ? String(row.github_state) : null,
        draft: Number(row.draft) === 1,
        sha,
        checks: sha ? (checksBySha.get(`${row.repository_id}:${sha}`) ?? null) : null,
      });
    }
  }

  if (store.hasTable('dispatch_events')) {
    const dispatchRows = store.all(
      `SELECT id, repository_id, object_number, type, state, decision, reason, summary, created_at, decided_at
       FROM (
         SELECT id, repository_id, object_number, type, state, decision, reason, summary, created_at, decided_at,
           row_number() OVER (
             PARTITION BY repository_id, object_number
             ORDER BY coalesce(nullif(decided_at,''), created_at) DESC, created_at DESC, rowid DESC
           ) AS rn
         FROM dispatch_events
         WHERE repository_id IN (${marks}) AND object_type='issue' AND object_number IS NOT NULL
       ) WHERE rn=1`,
      ...uniqueRepos,
    );
    for (const row of dispatchRows) {
      latestDispatch.set(`${row.repository_id}:${row.object_number}`, row);
    }
  }

  const devTaskIds = [...new Set([...latestDev.values()].map(r => String(r.task_id)))];
  if (devTaskIds.length && store.hasTable('issue_development_progress')) {
    const taskMarks = devTaskIds.map(() => '?').join(',');
    for (const row of store.all(`SELECT task_id, milestones FROM issue_development_progress WHERE task_id IN (${taskMarks})`, ...devTaskIds)) {
      const parsed = parseJson(row.milestones);
      if (parsed && typeof parsed === 'object') progressByTask.set(String(row.task_id), { plan: parsed.plan, stopped: parsed.stopped });
    }
  }

  return { ceilings, latestReview, latestDev, latestPr, latestDispatch, progressByTask };
}

export function listBoardIssues(store: Store, user: Actor, url: URL): Json {
  const repoId = url.searchParams.get('repository_id')?.trim() || '';
  if (repoId) repository(store, user, repoId);

  const statusFilter = url.searchParams.get('status')?.trim() || 'all';
  if (!validFilters.has(statusFilter)) fail(400, 'invalid_issue_status');

  const rawClosed = url.searchParams.get('include_closed')?.trim() || '';
  if (rawClosed && !['0', '1', 'true', 'false'].includes(rawClosed)) fail(400, 'invalid_include_closed');
  const includeClosed = rawClosed === '1' || rawClosed === 'true';

  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const limit = Number(url.searchParams.get('limit') || 20);
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    fail(400, 'invalid_pagination');
  }

  return store.transaction(() => {
    const access = scope(user, 'o.repository_id');
    const clauses: string[] = [access.sql, "o.object_type='issue'"];
    const args: (string | number)[] = [...access.args];
    if (repoId) { clauses.push('o.repository_id=?'); args.push(repoId); }
    if (!includeClosed) clauses.push("coalesce(o.github_state,'open')<>'closed'");
    if (q) {
      const numMatch = /^#?([1-9]\d*)$/.exec(q);
      const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
      if (numMatch && Number.isSafeInteger(Number(numMatch[1]))) {
        clauses.push("(o.object_number=? OR o.title LIKE ? ESCAPE '\\')");
        args.push(Number(numMatch[1]), pattern);
      } else {
        clauses.push("o.title LIKE ? ESCAPE '\\'");
        args.push(pattern);
      }
    }

    const objects = store.all(
      `SELECT o.repository_id, o.object_number, o.title, o.github_state, o.last_seen, r.full_name
       FROM board_objects o
       JOIN repositories r ON r.id=o.repository_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY o.last_seen DESC, o.repository_id, o.object_number DESC`,
      ...args,
    );

    const maps = loadContextMaps(store, objects.map(o => String(o.repository_id)));
    const counts: Record<string, number> = {
      all: 0,
      pr_opened: 0,
      developing: 0,
      needs_human: 0,
      needs_information: 0,
      human_decision_required: 0,
      blocked: 0,
      skipped: 0,
      pending: 0,
    };

    const derived = objects.map(obj => {
      const key = `${obj.repository_id}:${obj.object_number}`;
      const dev = maps.latestDev.get(key);
      const item = deriveIssueRow(
        obj,
        maps.latestReview.get(key),
        dev,
        maps.latestPr.get(key) ?? null,
        maps.latestDispatch.get(key),
        dev ? (maps.progressByTask.get(String(dev.task_id)) ?? null) : null,
        maps.ceilings.get(String(obj.repository_id)) ?? 'comment',
      );
      const st = String(item.status) as IssueDevStatus;
      counts.all = (counts.all ?? 0) + 1;
      counts[st] = (counts[st] ?? 0) + 1;
      if (needsHumanSet.has(st)) counts.needs_human = (counts.needs_human ?? 0) + 1;
      return item;
    });

    derived.sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')) || Number(b.number) - Number(a.number));

    const filtered = statusFilter === 'all'
      ? derived
      : statusFilter === 'needs_human'
        ? derived.filter(item => needsHumanSet.has(item.status as IssueDevStatus))
        : derived.filter(item => item.status === statusFilter);

    const page = filtered.slice(offset, offset + limit);
    return {
      issues: page,
      counts,
      total: filtered.length,
      has_more: offset + page.length < filtered.length,
      limit,
      offset,
      sampled_at: new Date().toISOString(),
    };
  });
}

export function boardIssueDetail(store: Store, user: Actor, repoId: string, issueNumber: number): Json {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) fail(400, 'invalid_object_number');
  repository(store, user, repoId);

  return store.transaction(() => {
    const obj = store.get(
      `SELECT o.repository_id, o.object_number, o.title, o.github_state, o.last_seen, r.full_name
       FROM board_objects o
       JOIN repositories r ON r.id=o.repository_id
       WHERE o.repository_id=? AND o.object_type='issue' AND o.object_number=?`,
      repoId, issueNumber,
    );
    if (!obj) return fail(404, 'board_issue_not_found');

    const maps = loadContextMaps(store, [repoId]);
    const key = `${repoId}:${issueNumber}`;
    const dev = maps.latestDev.get(key);
    const issue = deriveIssueRow(
      obj,
      maps.latestReview.get(key),
      dev,
      maps.latestPr.get(key) ?? null,
      maps.latestDispatch.get(key),
      dev ? (maps.progressByTask.get(String(dev.task_id)) ?? null) : null,
      maps.ceilings.get(repoId) ?? 'comment',
    );

    const roleByTask = new Map<string, string>();
    if (store.hasTable('board_issue_tasks')) {
      for (const r of store.all('SELECT task_id, role_kind FROM board_issue_tasks WHERE repository_id=? AND object_number=?', repoId, issueNumber)) {
        roleByTask.set(String(r.task_id), String(r.role_kind));
      }
    }

    const tasks = store.all(
      `SELECT id, kind, status, summary, error_code, created_at, updated_at
       FROM tasks
       WHERE repository_id=? AND object_number=?
         AND (kind IN ('review.issue','development.issue','workflow.issue')
           OR (kind='task.request' AND (NOT json_valid(input) OR json_extract(input,'$.target.type') IS NULL OR json_extract(input,'$.target.type')='issue')))
       ORDER BY created_at DESC, rowid DESC
       LIMIT 20`,
      repoId, issueNumber,
    ).map(t => ({
      id: String(t.id),
      kind: String(t.kind),
      role_kind: roleByTask.get(String(t.id)) ?? (String(t.kind).startsWith('development.') ? 'development' : String(t.kind).startsWith('review.') ? 'review' : null),
      status: String(t.status),
      summary: t.summary ? String(t.summary) : null,
      error_code: t.error_code ? String(t.error_code) : null,
      error_cause: explainFailure(t.error_code, t.status),
      created_at: String(t.created_at),
      updated_at: String(t.updated_at || t.created_at),
    }));

    const tKey = `${repoId}:issue:${issueNumber}`;
    const dispatchEvents = store.hasTable('dispatch_events')
      ? store.all(
          `SELECT id, type, source, state, decision, reason, summary, created_at, decided_at
           FROM dispatch_events
           WHERE repository_id=? AND (thread_key=? OR (object_type='issue' AND object_number=?))
           ORDER BY created_at DESC, rowid DESC
           LIMIT 20`,
          repoId, tKey, issueNumber,
        ).map(e => ({
          id: String(e.id),
          type: String(e.type),
          source: String(e.source),
          state: String(e.state),
          decision: e.decision ? String(e.decision) : null,
          reason: e.reason ? String(e.reason) : null,
          summary: String(e.summary || ''),
          created_at: String(e.created_at),
          decided_at: e.decided_at ? String(e.decided_at) : null,
        }))
      : [];

    const thread = readDispatchThread(store, tKey, repoId);

    return {
      issue,
      tasks,
      dispatch_events: dispatchEvents,
      thread_summary: thread.summary,
    };
  });
}
