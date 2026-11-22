import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, scope } from '../app/auth.js';
import { fail, type Json } from '../core/security.js';
import { explainFailure } from '../agent/failures.js';
import { readDispatchThread } from '../dispatch/store.js';

export type PrProgressStatus =
  | 'needs_attention'
  | 'revising'
  | 'reviewing'
  | 'reviewed'
  | 'draft'
  | 'pending';

export const prProgressStatuses: { id: PrProgressStatus; name: string; tone: string }[] = [
  { id: 'needs_attention', name: '需人工处理', tone: 'danger' },
  { id: 'revising', name: '跟进修改中', tone: 'info' },
  { id: 'reviewing', name: '检视中', tone: 'info' },
  { id: 'reviewed', name: '已检视', tone: 'success' },
  { id: 'draft', name: '草稿', tone: 'neutral' },
  { id: 'pending', name: '待检视', tone: 'neutral' },
];

const validFilters = new Set(['all', ...prProgressStatuses.map(s => s.id)]);
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
const autoStopCodes = new Set(['object_closed_or_draft', 'obsolete_closed', 'obsolete_superseded', 'obsolete_expired', 'user_cancel']);
const devStateNames: Record<string, string> = {
  queued: '排队中', running: '执行中', preparing: '准备环境', implementing: '修改代码',
  validating: '运行验证', publishing: '准备推送更新', retry_wait: '等待自动重试',
  waiting_pr_head: '等待 PR 更新', result_ready: '等待发布', waiting_coordination: '等待协作', waiting_event: '等待事件',
};

function clip(value: unknown, limit = 240): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  running: number;
}

interface BotPrInfo {
  branch: string | null;
  sha: string | null;
  revisions: number;
  source_task_id: string | null;
  source_issue_number: number | null;
}

function checkSummaryLabel(checks: CheckSummary | null): string {
  if (!checks || checks.total === 0) return '';
  if (checks.failed > 0) return `CI ${checks.failed} 项失败`;
  if (checks.running > 0) return 'CI 运行中';
  return `CI ${checks.passed}/${checks.total} 通过`;
}

function derivePrRow(
  obj: Row,
  review: Row | undefined,
  dev: Row | undefined,
  botPr: BotPrInfo | null,
  checks: CheckSummary | null,
  reviewDispatch: Row | undefined,
  intakeDispatch: Row | undefined,
): Json {
  const repoId = String(obj.repository_id);
  const fullName = String(obj.full_name || '');
  const number = Number(obj.object_number);
  const prUrl = /^[\w.-]+\/[\w.-]+$/.test(fullName) ? `https://github.com/${fullName}/pull/${number}` : null;
  const sourceIssueUrl = botPr?.source_issue_number && /^[\w.-]+\/[\w.-]+$/.test(fullName)
    ? `https://github.com/${fullName}/issues/${botPr.source_issue_number}`
    : null;
  const isDraft = Number(obj.draft) === 1;
  const isClosed = String(obj.github_state || 'open') === 'closed';

  const devStatus = dev ? String(dev.status) : '';
  const reviewStatus = review ? String(review.status) : '';
  const reviewTime = review ? String(review.updated_at || review.created_at || '') : '';
  const devTime = dev ? String(dev.updated_at || dev.created_at || '') : '';
  const reviewCreatedAt = review ? String(review.created_at || '') : '';
  const activeReviewDispatch = reviewDispatch && (!reviewCreatedAt || String(reviewDispatch.decided_at || reviewDispatch.created_at || '') >= reviewCreatedAt)
    ? reviewDispatch
    : undefined;
  const governingDispatch = review ? activeReviewDispatch : intakeDispatch;

  const devBlocked = !!dev && (
    attentionStates.has(devStatus)
    || (devStatus === 'cancelled' && !autoStopCodes.has(String(dev.error_code ?? '')))
  );
  const reviewBlocked = !!review && attentionStates.has(reviewStatus);
  const reviewNeedsHuman = !!review && doneStates.has(reviewStatus) && (
    ['needs_information', 'human_decision_required'].includes(String(review.conclusion ?? ''))
    || (!!review.human_action && !['ready_for_development', 'no_code_change'].includes(String(review.conclusion ?? '')))
  );

  let status: PrProgressStatus = isDraft ? 'draft' : 'pending';
  let reason = isDraft ? '草稿 PR，bot 默认不触发自动检视' : '尚未开始检视';
  let nextStep: string | null = null;

  if (dev && activeDevStates.has(devStatus)) {
    status = 'revising';
    const stageText = devStateNames[devStatus] || devStatus;
    reason = `正在跟进修改 PR（${stageText}）`;
  } else if (review && activeReviewStates.has(reviewStatus)) {
    status = 'reviewing';
    reason = '正在检视 PR 改动与测试证据';
  } else if (devBlocked && dev) {
    status = 'needs_attention';
    const cause = explainFailure(dev.error_code, devStatus);
    reason = cause?.label || `PR 跟进修改受阻（${devStatus}）`;
    nextStep = cause?.action || '打开跟进任务查看原因并决定是否重试';
  } else if (reviewBlocked && review) {
    status = 'needs_attention';
    const cause = explainFailure(review.error_code, reviewStatus);
    reason = cause?.label || `PR 检视受阻（${reviewStatus}）`;
    nextStep = cause?.action || '打开检视任务查看原因并处理';
  } else if (reviewNeedsHuman && review) {
    status = 'needs_attention';
    const humanAction = review.human_action ? clip(review.human_action, 220) : '';
    const rec = review.recommendation ? clip(review.recommendation, 220) : '';
    reason = humanAction || rec || 'PR 检视指出需要人工决定或补充说明';
    nextStep = '在 PR 中确认方案或处理检视意见';
  } else if (!isClosed && !isDraft && checks && checks.failed > 0) {
    status = 'needs_attention';
    reason = `必需检查存在 ${checks.failed} 项失败（共 ${checks.total} 项）`;
    nextStep = botPr ? '查看失败日志，可由维护者处理或指示 bot 继续修复' : '查看 GitHub Actions 失败检查并推送修复提交';
  } else if (review && doneStates.has(reviewStatus)) {
    status = 'reviewed';
    const rec = review.recommendation ? clip(review.recommendation, 200) : '';
    const ciLabel = checkSummaryLabel(checks);
    reason = rec
      ? (ciLabel ? `${rec}（${ciLabel}）` : rec)
      : (ciLabel ? `已完成检视（${ciLabel}）` : '已完成检视');
    if (isDraft) nextStep = '草稿 PR 转为 Ready for review 后将按最新提交继续检视';
  } else if (isDraft) {
    status = 'draft';
    reason = '草稿 PR，bot 默认不触发自动检视';
  } else if (dev && doneStates.has(devStatus)) {
    status = 'reviewed';
    const ciLabel = checkSummaryLabel(checks);
    reason = ciLabel ? `已完成跟进修改（${ciLabel}）` : '已完成跟进修改';
  } else if (dev && devStatus === 'cancelled' && autoStopCodes.has(String(dev.error_code ?? ''))) {
    status = 'pending';
    reason = String(dev.error_code ?? '') === 'user_cancel' ? '跟进任务已由人工取消' : '跟进任务已自动停止';
  } else if (intakeDispatch && String(intakeDispatch.state) === 'filtered') {
    status = 'pending';
    reason = clip(intakeDispatch.reason, 220) || '事件被项目过滤，未启动检视';
  } else if (intakeDispatch && String(intakeDispatch.decision) === 'ignore') {
    status = 'pending';
    reason = clip(intakeDispatch.reason, 220) || 'Manager 暂未启动检视';
  }

  const lastActivity = [obj.last_seen, reviewTime, devTime, governingDispatch?.decided_at || governingDispatch?.created_at]
    .filter((v): v is string => typeof v === 'string' && !!v)
    .sort()
    .at(-1) || String(obj.last_seen || '');

  return {
    repository_id: repoId,
    full_name: fullName,
    number,
    title: obj.title ? String(obj.title) : null,
    url: prUrl,
    github_state: obj.github_state ? String(obj.github_state) : 'open',
    draft: isDraft,
    status,
    reason,
    next_step: nextStep,
    last_activity: lastActivity,
    is_bot_pr: !!botPr,
    bot_pr: botPr
      ? {
          branch: botPr.branch,
          sha: botPr.sha,
          revisions: botPr.revisions,
          source_issue_number: botPr.source_issue_number,
          source_issue_url: sourceIssueUrl,
        }
      : null,
    checks,
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
    dispatch: governingDispatch
      ? {
          event_id: String(governingDispatch.id),
          type: String(governingDispatch.type),
          state: String(governingDispatch.state),
          decision: governingDispatch.decision ? String(governingDispatch.decision) : null,
          reason: governingDispatch.reason ? String(governingDispatch.reason) : null,
          decided_at: governingDispatch.decided_at ? String(governingDispatch.decided_at) : String(governingDispatch.created_at),
        }
      : null,
  };
}

function loadPrContextMaps(store: Store, repoIds: string[]) {
  const uniqueRepos = [...new Set(repoIds)];
  const latestReview = new Map<string, Row>();
  const latestDev = new Map<string, Row>();
  const botPrMap = new Map<string, BotPrInfo>();
  const checksByPr = new Map<string, CheckSummary>();
  const latestReviewDispatch = new Map<string, Row>();
  const latestIntakeDispatch = new Map<string, Row>();
  if (!uniqueRepos.length) return { latestReview, latestDev, botPrMap, checksByPr, latestReviewDispatch, latestIntakeDispatch };

  const marks = uniqueRepos.map(() => '?').join(',');

  if (store.hasTable('board_pr_tasks')) {
    const taskRows = store.all(
      `SELECT * FROM (
         SELECT t.*, row_number() OVER (
           PARTITION BY t.repository_id, t.object_number, t.role_kind
           ORDER BY t.updated_at DESC, t.created_at DESC, t.rowid DESC
         ) AS rn
         FROM board_pr_tasks t
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

  const shaByPr = new Map<string, { repoId: string; sha: string }>();
  if (store.hasTable('bot_pull_requests')) {
    const hasIssueTasks = store.hasTable('board_issue_tasks');
    const botRows = store.all(
      hasIssueTasks
        ? `SELECT p.repository_id, p.number, p.branch, p.sha, p.revisions, p.source_task_id, it.object_number AS source_issue_number
           FROM bot_pull_requests p
           LEFT JOIN board_issue_tasks it ON it.task_id=p.source_task_id AND it.role_kind='development'
           WHERE p.repository_id IN (${marks})`
        : `SELECT p.repository_id, p.number, p.branch, p.sha, p.revisions, p.source_task_id, NULL AS source_issue_number
           FROM bot_pull_requests p
           WHERE p.repository_id IN (${marks})`,
      ...uniqueRepos,
    );
    for (const r of botRows) {
      const key = `${r.repository_id}:${r.number}`;
      const sha = r.sha ? String(r.sha) : null;
      botPrMap.set(key, {
        branch: r.branch ? String(r.branch) : null,
        sha,
        revisions: Number(r.revisions ?? 0),
        source_task_id: r.source_task_id ? String(r.source_task_id) : null,
        source_issue_number: r.source_issue_number ? Number(r.source_issue_number) : null,
      });
      if (sha) shaByPr.set(key, { repoId: String(r.repository_id), sha });
    }
  }

  // Fallback head SHA from latest PR review/dev task when not a bot PR
  for (const [key, row] of [...latestDev.entries(), ...latestReview.entries()]) {
    if (shaByPr.has(key)) continue;
    if (row.head_sha && typeof row.head_sha === 'string') {
      shaByPr.set(key, { repoId: String(row.repository_id), sha: row.head_sha });
    }
  }

  const shas = [...new Set([...shaByPr.values()].map(v => v.sha))];
  if (shas.length && store.hasTable('commit_checks')) {
    const shaMarks = shas.map(() => '?').join(',');
    const checksBySha = new Map<string, CheckSummary>();
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
    for (const [key, { repoId, sha }] of shaByPr.entries()) {
      const found = checksBySha.get(`${repoId}:${sha}`);
      if (found) checksByPr.set(key, found);
    }
  }

  if (store.hasTable('dispatch_events')) {
    const dispatchRows = store.all(
      `SELECT id, repository_id, object_number, type, state, decision, reason, summary, created_at, decided_at, bucket
       FROM (
         SELECT id, repository_id, object_number, type, state, decision, reason, summary, created_at, decided_at,
           CASE WHEN type='review.published' THEN 'review' ELSE 'intake' END AS bucket,
           row_number() OVER (
             PARTITION BY repository_id, object_number, CASE WHEN type='review.published' THEN 'review' ELSE 'intake' END
             ORDER BY coalesce(nullif(decided_at,''), created_at) DESC, created_at DESC, rowid DESC
           ) AS rn
         FROM dispatch_events
         WHERE repository_id IN (${marks}) AND object_type='pr' AND object_number IS NOT NULL
           AND type IN ('review.published','pull_request.opened','pull_request.reopened','pull_request.ready_for_review','pull_request.synchronize')
       ) WHERE rn=1`,
      ...uniqueRepos,
    );
    for (const row of dispatchRows) {
      const key = `${row.repository_id}:${row.object_number}`;
      if (row.bucket === 'review') latestReviewDispatch.set(key, row);
      else latestIntakeDispatch.set(key, row);
    }
  }

  return { latestReview, latestDev, botPrMap, checksByPr, latestReviewDispatch, latestIntakeDispatch };
}

export function listBoardPrs(store: Store, user: Actor, url: URL): Json {
  const repoId = url.searchParams.get('repository_id')?.trim() || '';
  if (repoId) repository(store, user, repoId);

  const statusFilter = url.searchParams.get('status')?.trim() || 'all';
  if (!validFilters.has(statusFilter)) fail(400, 'invalid_pr_status');

  const rawClosed = url.searchParams.get('include_closed')?.trim() || '';
  if (rawClosed && !['0', '1', 'true', 'false'].includes(rawClosed)) fail(400, 'invalid_include_closed');
  const includeClosed = rawClosed === '1' || rawClosed === 'true';

  const rawBotOnly = url.searchParams.get('bot_only')?.trim() || '';
  if (rawBotOnly && !['0', '1', 'true', 'false'].includes(rawBotOnly)) fail(400, 'invalid_bot_only');
  const botOnly = rawBotOnly === '1' || rawBotOnly === 'true';

  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const limit = Number(url.searchParams.get('limit') || 20);
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    fail(400, 'invalid_pagination');
  }

  return store.transaction(() => {
    const access = scope(user, 'o.repository_id');
    const clauses: string[] = [access.sql, "o.object_type='pr'"];
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
      `SELECT o.repository_id, o.object_number, o.title, o.github_state, o.draft, o.last_seen, r.full_name
       FROM board_objects o
       JOIN repositories r ON r.id=o.repository_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY o.last_seen DESC, o.repository_id, o.object_number DESC`,
      ...args,
    );

    const maps = loadPrContextMaps(store, objects.map(o => String(o.repository_id)));
    const allDerived = objects.map(obj => {
      const key = `${obj.repository_id}:${obj.object_number}`;
      return derivePrRow(
        obj,
        maps.latestReview.get(key),
        maps.latestDev.get(key),
        maps.botPrMap.get(key) ?? null,
        maps.checksByPr.get(key) ?? null,
        maps.latestReviewDispatch.get(key),
        maps.latestIntakeDispatch.get(key),
      );
    });

    const botScoped = botOnly ? allDerived.filter(item => item.is_bot_pr === true) : allDerived;
    const counts: Record<string, number> = {
      all: 0,
      needs_attention: 0,
      revising: 0,
      reviewing: 0,
      reviewed: 0,
      draft: 0,
      pending: 0,
      bot_pr: allDerived.filter(item => item.is_bot_pr === true).length,
    };
    for (const item of botScoped) {
      const st = String(item.status) as PrProgressStatus;
      counts.all = (counts.all ?? 0) + 1;
      counts[st] = (counts[st] ?? 0) + 1;
    }

    botScoped.sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')) || Number(b.number) - Number(a.number));
    const filtered = statusFilter === 'all' ? botScoped : botScoped.filter(item => item.status === statusFilter);
    const page = filtered.slice(offset, offset + limit);

    return {
      prs: page,
      counts,
      total: filtered.length,
      has_more: offset + page.length < filtered.length,
      limit,
      offset,
      sampled_at: new Date().toISOString(),
    };
  });
}

export function boardPrDetail(store: Store, user: Actor, repoId: string, prNumber: number): Json {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) fail(400, 'invalid_object_number');
  repository(store, user, repoId);

  return store.transaction(() => {
    const obj = store.get(
      `SELECT o.repository_id, o.object_number, o.title, o.github_state, o.draft, o.last_seen, r.full_name
       FROM board_objects o
       JOIN repositories r ON r.id=o.repository_id
       WHERE o.repository_id=? AND o.object_type='pr' AND o.object_number=?`,
      repoId, prNumber,
    );
    if (!obj) return fail(404, 'board_pr_not_found');

    const maps = loadPrContextMaps(store, [repoId]);
    const key = `${repoId}:${prNumber}`;
    const pr = derivePrRow(
      obj,
      maps.latestReview.get(key),
      maps.latestDev.get(key),
      maps.botPrMap.get(key) ?? null,
      maps.checksByPr.get(key) ?? null,
      maps.latestReviewDispatch.get(key),
      maps.latestIntakeDispatch.get(key),
    );

    const roleByTask = new Map<string, string>();
    if (store.hasTable('board_pr_tasks')) {
      for (const r of store.all('SELECT task_id, role_kind FROM board_pr_tasks WHERE repository_id=? AND object_number=?', repoId, prNumber)) {
        roleByTask.set(String(r.task_id), String(r.role_kind));
      }
    }

    const taskWhere = `repository_id=? AND object_number=?
      AND (kind IN ('review.pr','development.pr','workflow.pr')
        OR (kind='task.request' AND json_valid(input) AND json_extract(input,'$.target.type')='pr'))`;
    const tasksTotal = Number(store.get(`SELECT count(*) AS n FROM tasks WHERE ${taskWhere}`, repoId, prNumber)?.n ?? 0);
    const tasks = store.all(
      `SELECT id, kind, status, summary, error_code, created_at, updated_at
       FROM tasks
       WHERE ${taskWhere}
       ORDER BY created_at DESC, rowid DESC
       LIMIT 20`,
      repoId, prNumber,
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

    const tKey = `${repoId}:pr:${prNumber}`;
    const dispatchEventsTotal = store.hasTable('dispatch_events')
      ? Number(store.get(
          `SELECT count(*) AS n FROM dispatch_events WHERE repository_id=? AND (thread_key=? OR (object_type='pr' AND object_number=?))`,
          repoId, tKey, prNumber,
        )?.n ?? 0)
      : 0;
    const dispatchEvents = store.hasTable('dispatch_events')
      ? store.all(
          `SELECT id, type, source, state, decision, reason, summary, created_at, decided_at
           FROM dispatch_events
           WHERE repository_id=? AND (thread_key=? OR (object_type='pr' AND object_number=?))
           ORDER BY created_at DESC, rowid DESC
           LIMIT 20`,
          repoId, tKey, prNumber,
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
      pr,
      tasks,
      tasks_total: tasksTotal,
      tasks_truncated: tasksTotal > tasks.length,
      dispatch_events: dispatchEvents,
      dispatch_events_total: dispatchEventsTotal,
      dispatch_events_truncated: dispatchEventsTotal > dispatchEvents.length,
      thread_summary: thread.summary,
    };
  });
}
