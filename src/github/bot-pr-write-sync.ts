import { randomId } from '../core/security.js';
import { computeBotPrBranchCleanupPlan, ensureBotPrBranchCleanupColumns, resolveBotPrBranchCleanupConfig } from '../review/bot-pr-branch-cleanup.js';
import type { Store, Row } from '../storage/database.js';
import type { WriteActor } from './write.js';

function upsertBotPrStateRow(store: Store, repositoryId: string, prNumber: number, owned: Row, value: any): void {
  if (!store.hasTable('bot_pr_states')) return;
  ensureBotPrBranchCleanupColumns(store);
  const prev = store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
  const normSha = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{40}$/i.test(s) ? s.toLowerCase() : null;
  const state = typeof value?.state === 'string' && value.state ? value.state : String(prev?.state ?? 'open');
  const draft = value?.draft !== undefined ? (value.draft === true ? 1 : 0) : Number(prev?.draft ?? 0);
  const baseRef = typeof value?.base?.ref === 'string' && value.base.ref ? value.base.ref : (prev?.base_ref ? String(prev.base_ref) : null);
  const baseSha = normSha(value?.base?.sha) ?? (prev?.base_sha ? String(prev.base_sha) : null);
  const headSha = normSha(value?.head?.sha) ?? (prev?.head_sha ? String(prev.head_sha) : normSha(owned.sha));
  const mergeable = value?.mergeable === true ? 1 : value?.mergeable === false ? 0 : value?.mergeable === null ? null : (prev?.mergeable ?? null);
  const mergeableState = typeof value?.mergeable_state === 'string' && value.mergeable_state
    ? value.mergeable_state
    : (prev?.mergeable_state ? String(prev.mergeable_state) : null);
  const title = typeof value?.title === 'string' && value.title ? value.title.slice(0, 400) : (prev?.title ? String(prev.title) : null);
  const htmlUrl = typeof value?.html_url === 'string' && /^https?:\/\//i.test(value.html_url)
    ? value.html_url
    : (prev?.html_url ? String(prev.html_url) : null);
  const clearSuppression = state !== 'open' || draft === 1 ? 1 : 0;
  const cleanupCfg = resolveBotPrBranchCleanupConfig();
  const nowMs = cleanupCfg.now();
  const nowIso = new Date(nowMs).toISOString();
  const cleanupPlan = computeBotPrBranchCleanupPlan(prev, state, value, nowIso, nowMs, cleanupCfg.retentionMs);
  store.run(
    `INSERT INTO bot_pr_states(
       repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,html_url,updated_at,
       merged,closed_at,branch_delete_due_at,branch_cleanup_status,branch_cleanup_reason,branch_cleanup_at,branch_cleanup_attempts
     )
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repository_id,number) DO UPDATE SET
       state=excluded.state,
       draft=excluded.draft,
       base_ref=coalesce(excluded.base_ref,bot_pr_states.base_ref),
       base_sha=coalesce(excluded.base_sha,bot_pr_states.base_sha),
       head_sha=coalesce(excluded.head_sha,bot_pr_states.head_sha),
       mergeable=excluded.mergeable,
       mergeable_state=excluded.mergeable_state,
       title=coalesce(excluded.title,bot_pr_states.title),
       html_url=coalesce(excluded.html_url,bot_pr_states.html_url),
       updated_at=excluded.updated_at,
       merged=excluded.merged,
       closed_at=excluded.closed_at,
       branch_delete_due_at=excluded.branch_delete_due_at,
       branch_cleanup_status=excluded.branch_cleanup_status,
       branch_cleanup_reason=excluded.branch_cleanup_reason,
       branch_cleanup_at=excluded.branch_cleanup_at,
       branch_cleanup_attempts=excluded.branch_cleanup_attempts,
       conflict_suppressed_head_sha=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_head_sha END,
       conflict_suppressed_env=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_env END,
       conflict_suppressed_at=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_at END,
       conflict_suppressed_reason=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_reason END`,
    repositoryId, prNumber, state, draft, baseRef, baseSha, headSha, mergeable, mergeableState, title, htmlUrl, nowIso,
    cleanupPlan.merged, cleanupPlan.closedAt, cleanupPlan.branchDeleteDueAt, cleanupPlan.branchCleanupStatus,
    cleanupPlan.branchCleanupReason, cleanupPlan.branchCleanupAt, cleanupPlan.branchCleanupAttempts,
    clearSuppression, clearSuppression, clearSuppression, clearSuppression,
  );
  if (cleanupPlan.cancelledPending) {
    store.audit(
      'system',
      'bot_pr.branch_cleanup_cancelled',
      `pr#${prNumber}:${String(owned.branch || 'unknown').slice(0, 200)}:reopened`,
      repositoryId,
    );
  }
}

/** Synchronizes local bot PR ownership, state, and residual tasks after a successful GitHub REST write. */
export function syncBotPullRequestAfterWrite(store: Store, repository: Row, actor: WriteActor, method: string, path: string, value: any): void {
  if (!value || typeof value !== 'object') return;
  const repositoryId = String(repository.id);
  const mergeMatch = method === 'PUT' ? /^\/pulls\/(\d+)\/merge$/.exec(path) : null;
  if (mergeMatch && value.merged === true) {
    const mergedPrNumber = Number(mergeMatch[1]);
    const owned = Number.isSafeInteger(mergedPrNumber) && mergedPrNumber >= 1 && store.hasTable('bot_pull_requests')
      ? store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, mergedPrNumber)
      : undefined;
    if (owned) {
      const nowIso = new Date(resolveBotPrBranchCleanupConfig().now()).toISOString();
      upsertBotPrStateRow(store, repositoryId, mergedPrNumber, owned, {
        number: mergedPrNumber,
        state: 'closed',
        merged: true,
        merged_at: nowIso,
        closed_at: nowIso,
        ...(owned.sha ? { head: { ref: owned.branch, sha: owned.sha } } : {}),
      });
      cancelResidualTasksOnBotPrClosed(store, repositoryId, mergedPrNumber, owned, actor);
    }
    return;
  }
  const prNumber = Number(value.number);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return;

  if (method === 'POST' && path === '/pulls') {
    const headBranch = typeof value.head?.ref === 'string' ? value.head.ref.trim() : '';
    const headRepoId = value.head?.repo?.id != null ? String(value.head.repo.id) : repositoryId;
    const branchRow = headBranch && store.hasTable('bot_branches')
      ? store.get('SELECT task_id FROM bot_branches WHERE repository_id=? AND branch=?', repositoryId, headBranch)
      : undefined;
    if (headRepoId === repositoryId && headBranch && (branchRow || headBranch.startsWith('bot/'))) {
      const sourceTaskId = String(actor.task_id || branchRow?.task_id || '');
      const authorId = String(
        value.user?.id
        ?? (store.hasTable('github_actors') ? store.get('SELECT actor_id FROM github_actors WHERE account_id=?', repository.account_id)?.actor_id : '')
        ?? '',
      );
      const headSha = typeof value.head?.sha === 'string' ? value.head.sha : '';
      if (store.hasTable('bot_pull_requests')) {
        store.run(
          `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions)
           VALUES(?,?,?,?,?,?,?,?,0)
           ON CONFLICT(repository_id,number) DO UPDATE SET
             sha=CASE WHEN excluded.sha<>'' THEN excluded.sha ELSE bot_pull_requests.sha END,
             source_task_id=CASE WHEN bot_pull_requests.source_task_id='' AND excluded.source_task_id<>'' THEN excluded.source_task_id ELSE bot_pull_requests.source_task_id END`,
          repositoryId,
          prNumber,
          String(value.id ?? prNumber),
          authorId,
          headRepoId,
          headBranch,
          headSha,
          sourceTaskId,
        );
      }
      if (sourceTaskId && store.hasTable('bot_branches')) {
        store.run('INSERT INTO bot_branches(repository_id,branch,task_id) VALUES(?,?,?) ON CONFLICT DO NOTHING', repositoryId, headBranch, sourceTaskId);
      }
      const owned = store.hasTable('bot_pull_requests')
        ? store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber)
        : undefined;
      if (owned) upsertBotPrStateRow(store, repositoryId, prNumber, owned, value);
    }
    return;
  }

  if (method === 'PATCH' && (/^\/pulls\/\d+$/.test(path) || /^\/issues\/\d+$/.test(path))) {
    const owned = store.hasTable('bot_pull_requests')
      ? store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber)
      : undefined;
    if (!owned) return;
    const headSha = typeof value.head?.sha === 'string' && value.head.sha ? value.head.sha : null;
    if (headSha && headSha !== owned.sha) {
      store.run('UPDATE bot_pull_requests SET sha=? WHERE repository_id=? AND number=?', headSha, repositoryId, prNumber);
    }
    upsertBotPrStateRow(store, repositoryId, prNumber, owned, {
      ...value,
      number: prNumber,
      ...(headSha ? {} : owned.sha ? { head: { ...(value.head ?? {}), ref: owned.branch, sha: owned.sha } } : {}),
    });
    if (String(value.state || '').toLowerCase() === 'closed') {
      cancelResidualTasksOnBotPrClosed(store, repositoryId, prNumber, owned, actor);
    }
  }
}

const TERMINAL_STATUSES_SQL = "'succeeded','pr_opened','completed','cancelled','superseded'";

function cancelResidualTasksOnBotPrClosed(
  store: Store,
  repositoryId: string,
  prNumber: number,
  owned: Row,
  actor: WriteActor,
): void {
  const now = new Date().toISOString();
  const skipTaskId = actor.kind === 'task' && actor.task_id ? String(actor.task_id) : null;
  const skipEventId = actor.event_id ? String(actor.event_id) : null;
  store.transaction(() => {
    if (store.hasTable('review_objects')) {
      store.run(
        "UPDATE review_objects SET closed_at=COALESCE(closed_at,?) WHERE repository_id=? AND kind='review.pr' AND object_number=?",
        now,
        repositoryId,
        prNumber,
      );
    }
    if (store.hasTable('tasks')) {
      const targetRows = store.all(
        `SELECT id,status FROM tasks
         WHERE repository_id=?
           AND status NOT IN (${TERMINAL_STATUSES_SQL})
           AND (
             (object_number=? AND (kind LIKE '%.pr' OR (kind='task.request' AND json_extract(input,'$.target.type')='pr')))
             OR (?<>'' AND id=?)
           )`,
        repositoryId,
        prNumber,
        String(owned.source_task_id ?? ''),
        String(owned.source_task_id ?? ''),
      );
      for (const row of targetRows) {
        const taskId = String(row.id);
        if (skipTaskId && taskId === skipTaskId) continue;
        if (store.hasTable('task_claims')) store.run('DELETE FROM task_claims WHERE task_id=?', taskId);
        store.run(
          "UPDATE tasks SET status='cancelled',claim_token=NULL,error_code='bot_pr_closed',retry_cycle_started_at=NULL,retry_error_code=NULL,retry_count=0,updated_at=? WHERE id=?",
          now,
          taskId,
        );
        if (store.hasTable('task_runs')) {
          store.run("UPDATE task_runs SET status='interrupted',ended_at=?,stop_reason='bot_pr_closed' WHERE task_id=? AND status='running'", now, taskId);
        }
        if (store.hasTable('task_logs')) {
          store.run(
            'INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',
            randomId(),
            taskId,
            JSON.stringify({
              type: 'cancelled',
              error_code: 'bot_pr_closed',
              pr_number: prNumber,
              actor_kind: actor.kind,
              ...(actor.event_id ? { event_id: actor.event_id } : {}),
              detail: `bot PR #${prNumber} 已通过 github_write 关闭，关联残留任务已自动取消。`,
            }),
            now,
          );
        }
      }
    }
    if (store.hasTable('dispatch_events')) {
      if (skipEventId) {
        store.run(
          "UPDATE dispatch_events SET state='decided',decision='ignore',reason=?,lease=NULL,lease_until=NULL,decided_at=? WHERE repository_id=? AND object_type='pr' AND object_number=? AND state IN ('pending','failed') AND id<>?",
          `bot PR #${prNumber} 已关闭，待分派事件已自动取消。`,
          now,
          repositoryId,
          prNumber,
          skipEventId,
        );
      } else {
        store.run(
          "UPDATE dispatch_events SET state='decided',decision='ignore',reason=?,lease=NULL,lease_until=NULL,decided_at=? WHERE repository_id=? AND object_type='pr' AND object_number=? AND state IN ('pending','failed')",
          `bot PR #${prNumber} 已关闭，待分派事件已自动取消。`,
          now,
          repositoryId,
          prNumber,
        );
      }
    }
  });
}
