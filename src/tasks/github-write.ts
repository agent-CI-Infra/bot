import type { Store, Row } from '../storage/database.js';
import { stop, type Redactor } from '../agent/common.js';
import { GitHub } from '../github/client.js';
import { githubWrite, type WriteResource, type WriteOperation } from '../github/write.js';
import { githubWriteAllowed } from '../roles/permissions.js';
import { taskActingRole, taskRolePolicies, sourcePolicies } from './management.js';
import { effectiveWrites } from './grants.js';
import { scheduledIssueOperationAllowed } from './schedule-write.js';
import { Publisher, publicationScope } from '../github/publisher.js';
import { inlineLocation, reviewConclusions } from '../review/findings.js';
import { classificationLabels, hasLabelName, needsHumanIssueLabel, repositoryLabels, reviewNeedsHuman } from '../review/labels.js';
import { behaviorPath, projectLabels } from '../rules/service.js';
import { reviewLanguage } from '../github/text.js';
import { covers, projectCeiling, ceilingMessage } from '../projects/ceiling.js';

export function taskWriteAllowed(store: Store, task: Row, resource: WriteResource, operation?: WriteOperation): boolean {
  const scheduled = scheduledIssueOperationAllowed(task, resource, operation);
  if (scheduled !== null) return scheduled;
  return taskRolePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation));
}

export function taskGithubWrite(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string) {
  const scope = 'task:' + publicationScope(task);
  return (args: unknown) => {
    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    return githubWrite(
      {
        store,
        repository,
        redactor,
        guard,
        apiUrl,
        scope,
        actor: { kind: 'task', role: taskActingRole(store, task), task_id: String(task.id) },
        allowed: (resource, operation) => taskWriteAllowed(store, task, resource, operation),
      },
      args,
    );
  };
}

const fn = (name: string, description: string, properties: any, required: string[]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

/**
 * Unified formal review delivery tool (#814, #1122): works for both Pull Requests and Issues, validates diff line anchors
 * before any GitHub request, updates the single summary comment (`review_summaries`) in-place across rounds, resolves
 * fixed bot inline threads (`resolved_comments`), and applies `review_label` + valid `labels`.
 */
export const postReviewTool = fn(
  'post_review',
  'Publish a formal review on a Pull Request or Issue of this repository via Publisher.review: always a COMMENT review (never approves or requests changes), validates inline diff line anchors before sending, edits the existing bot summary comment in-place on follow-up reviews, and resolves fixed bot inline threads. Pass pull_number or issue_number (or omit to use the task target), summary (or body), optional inline comments or structured findings, optional resolved_comments / labels / conclusion / recommendation, and an optional idempotency key.',
  {
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'number'],
      properties: {
        type: { type: 'string', enum: ['issue', 'pr'] },
        number: { type: 'integer', minimum: 1 },
      },
    },
    pull_number: { type: 'integer', minimum: 1 },
    issue_number: { type: 'integer', minimum: 1 },
    body: { type: 'string' },
    summary: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'body'],
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          start_line: { type: 'integer', minimum: 1 },
          side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          start_side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          body: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['body', 'format'],
        properties: {
          id: { type: 'string' },
          body: { type: 'string' },
          format: { type: 'string', enum: ['inline', 'discussion'] },
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          start_line: { type: 'integer', minimum: 1 },
          side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          start_side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          actionable: { type: 'boolean' },
          within_goal: { type: 'boolean' },
          requires_human_decision: { type: 'boolean' },
          human_action: { type: 'string' },
          comment_id: { type: 'integer', minimum: 1 },
          selection_reason: { type: 'string' },
        },
      },
    },
    resolved_comments: { type: 'array', items: { type: 'integer', minimum: 1 } },
    labels: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
    conclusion: { type: 'string', enum: [...reviewConclusions] },
    key: { type: 'string', maxLength: 120 },
  },
  [],
);

/** Controlled single rerun of a failed Actions run (#1122). */
export const rerunFailedRunTool = fn(
  'rerun_failed_run',
  'Request a controlled single rerun of failed jobs for a GitHub Actions workflow run when every failed job failed due to an external/transient cause. Enforces a single rerun budget per run and capability_ceiling >= comment.',
  {
    run_id: { type: 'integer', minimum: 1 },
    job_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
    reason: { type: 'string' },
    evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
    key: { type: 'string', maxLength: 120 },
  },
  ['job_ids', 'reason', 'evidence'],
);

const validInlineComment = (c: any) =>
  c &&
  typeof c === 'object' &&
  typeof c.path === 'string' &&
  !!c.path.trim() &&
  Number.isSafeInteger(c.line) &&
  c.line >= 1 &&
  typeof c.body === 'string' &&
  !!c.body.trim() &&
  (c.start_line === undefined || (Number.isSafeInteger(c.start_line) && c.start_line >= 1)) &&
  (c.side === undefined || ['LEFT', 'RIGHT'].includes(c.side)) &&
  (c.start_side === undefined || ['LEFT', 'RIGHT'].includes(c.start_side));

const validFinding = (f: any) =>
  f &&
  typeof f === 'object' &&
  typeof f.body === 'string' &&
  !!f.body.trim() &&
  ['inline', 'discussion'].includes(f.format) &&
  (f.format !== 'inline' ||
    f.comment_id !== undefined ||
    (typeof f.path === 'string' && !!f.path.trim() && Number.isSafeInteger(f.line) && f.line >= 1));

export interface NormalizedReviewDelivery {
  target: { type: 'issue' | 'pr'; number: number };
  key: string | null;
  summary: string;
  findings: any[];
  resolved_comments: number[];
  labels: string[];
  recommendation?: string;
  conclusion?: string;
}

const allowedReviewKeys = new Set([
  'target',
  'pull_number',
  'issue_number',
  'body',
  'summary',
  'comments',
  'findings',
  'resolved_comments',
  'labels',
  'recommendation',
  'conclusion',
  'key',
]);

/**
 * Pure structural + diff-anchor check for `post_review`. Runs BEFORE any GitHub write is attempted; when `files` are
 * supplied for a PR target, rejects any inline comment/finding whose path/line is not in the diff hunks so GitHub never 422s.
 */
export function validateReviewDelivery(
  task: Row,
  args: any,
  files?: any[],
): { ok: true; value: NormalizedReviewDelivery } | { ok: false; error: Record<string, any> } {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !allowedReviewKeys.has(k))) {
    return { ok: false, error: { error: 'invalid_arguments', detail: 'post_review received unknown or malformed arguments. Nothing was sent.' } };
  }
  const summaryRaw = typeof args.summary === 'string' && args.summary.trim() ? args.summary : typeof args.body === 'string' ? args.body : '';
  if (!summaryRaw.trim()) {
    return { ok: false, error: { error: 'invalid_arguments', detail: 'post_review requires a non-empty summary (or body). Nothing was sent.' } };
  }
  if (args.pull_number !== undefined && args.issue_number !== undefined) {
    return { ok: false, error: { error: 'invalid_arguments', detail: 'Specify either pull_number or issue_number, not both.' } };
  }
  let target: { type: 'issue' | 'pr'; number: number } | null = null;
  if (args.target !== undefined) {
    if (
      !args.target ||
      typeof args.target !== 'object' ||
      (args.target.type !== 'issue' && args.target.type !== 'pr') ||
      !Number.isSafeInteger(args.target.number) ||
      args.target.number < 1
    ) {
      return { ok: false, error: { error: 'invalid_arguments', detail: 'target must be { type: "issue" | "pr", number: positive integer }.' } };
    }
    target = { type: args.target.type, number: Number(args.target.number) };
  } else if (args.pull_number !== undefined) {
    if (!Number.isSafeInteger(args.pull_number) || args.pull_number < 1) {
      return { ok: false, error: { error: 'invalid_arguments', detail: 'pull_number must be a positive integer.' } };
    }
    target = { type: 'pr', number: Number(args.pull_number) };
  } else if (args.issue_number !== undefined) {
    if (!Number.isSafeInteger(args.issue_number) || args.issue_number < 1) {
      return { ok: false, error: { error: 'invalid_arguments', detail: 'issue_number must be a positive integer.' } };
    }
    target = { type: 'issue', number: Number(args.issue_number) };
  } else {
    try {
      const taskInput = JSON.parse(String(task.input || '{}'));
      if ((taskInput.target?.type === 'pr' || taskInput.target?.type === 'issue') && Number.isSafeInteger(taskInput.target.number) && taskInput.target.number >= 1) {
        target = { type: taskInput.target.type, number: Number(taskInput.target.number) };
      }
    } catch { /* ignore */ }
    if (!target && Number.isSafeInteger(task.object_number) && Number(task.object_number) >= 1) {
      target = { type: String(task.kind ?? '').endsWith('.pr') ? 'pr' : 'issue', number: Number(task.object_number) };
    }
  }
  if (!target) {
    return { ok: false, error: { error: 'invalid_arguments', detail: 'post_review requires pull_number, issue_number, or a task bound to a PR/Issue target.' } };
  }
  if (args.comments !== undefined && (!Array.isArray(args.comments) || !args.comments.every(validInlineComment))) {
    return { ok: false, error: { error: 'invalid_arguments', detail: 'comments must be an array of { path, line, body } with positive integer line numbers. Nothing was sent.' } };
  }
  if (args.findings !== undefined && (!Array.isArray(args.findings) || !args.findings.every(validFinding))) {
    return { ok: false, error: { error: 'invalid_arguments', detail: 'findings must be an array of { body, format } where inline findings include path and positive integer line.' } };
  }
  if (target.type === 'issue' && ((args.comments?.length ?? 0) > 0 || (args.findings ?? []).some((f: any) => f.format === 'inline'))) {
    return { ok: false, error: { error: 'inline_line_not_in_diff', detail: 'Issues have no diff; use discussion findings or summary only. Nothing was sent.' } };
  }

  const rawFindings: any[] = [];
  let seq = 1;
  for (const c of args.comments ?? []) {
    rawFindings.push({
      id: `F${seq++}`,
      body: String(c.body).trim(),
      format: 'inline',
      path: String(c.path),
      line: Number(c.line),
      side: c.side ?? 'RIGHT',
      ...(c.start_line !== undefined ? { start_line: Number(c.start_line), start_side: c.start_side ?? c.side ?? 'RIGHT' } : {}),
      actionable: true,
      requires_human_decision: false,
    });
  }
  for (const f of args.findings ?? []) {
    rawFindings.push({
      id: typeof f.id === 'string' && f.id.trim() ? f.id.trim() : `F${seq++}`,
      body: String(f.body).trim(),
      format: f.format,
      ...(f.path !== undefined ? { path: String(f.path) } : {}),
      ...(f.line !== undefined ? { line: Number(f.line) } : {}),
      ...(f.side !== undefined ? { side: f.side } : f.format === 'inline' ? { side: 'RIGHT' } : {}),
      ...(f.start_line !== undefined ? { start_line: Number(f.start_line), start_side: f.start_side ?? f.side ?? 'RIGHT' } : {}),
      ...(f.comment_id !== undefined ? { comment_id: Number(f.comment_id) } : {}),
      actionable: Boolean(f.actionable),
      requires_human_decision: Boolean(f.requires_human_decision),
      ...(typeof f.human_action === 'string' ? { human_action: f.human_action } : {}),
    });
  }

  if (target.type === 'pr' && Array.isArray(files)) {
    for (const f of rawFindings) {
      if (f.format === 'inline' && f.comment_id === undefined) {
        const loc = inlineLocation(f, files);
        if (!loc) {
          return {
            ok: false,
            error: {
              error: 'inline_line_not_in_diff',
              path: f.path,
              line: f.line,
              side: f.side ?? 'RIGHT',
              message: `Inline comment at ${f.path}:${f.line} (${f.side ?? 'RIGHT'}) is outside the Pull Request diff hunks. Point to an added (+) or context line in the diff, or switch format to "discussion". Nothing was written to GitHub.`,
            },
          };
        }
      }
    }
  }

  const resolved = Array.isArray(args.resolved_comments)
    ? args.resolved_comments.filter((n: unknown) => Number.isSafeInteger(n) && Number(n) >= 1).map(Number)
    : [];
  const labels = Array.isArray(args.labels) ? args.labels.filter((l: unknown) => typeof l === 'string' && l.trim()).map((l: string) => l.trim()) : [];

  return {
    ok: true,
    value: {
      target,
      key: typeof args.key === 'string' && args.key.trim() ? args.key.trim() : null,
      summary: summaryRaw.trim(),
      findings: rawFindings,
      resolved_comments: resolved,
      labels,
      ...(typeof args.recommendation === 'string' && args.recommendation.trim() ? { recommendation: args.recommendation.trim() } : {}),
      ...(typeof args.conclusion === 'string' && args.conclusion.trim() ? { conclusion: args.conclusion.trim() } : {}),
    },
  };
}

/**
 * Publishes a validated review delivery through `Publisher.review` (diff anchor verification, `review_summaries` in-place
 * summary update, `resolveFixed` thread resolution, and `review_label` + `classificationLabels`).
 */
export async function publishReviewDelivery(
  store: Store,
  task: Row,
  normalized: NormalizedReviewDelivery,
  redactor: Redactor,
  guard: () => Promise<void>,
  log: (value: any) => void = () => {},
  apiUrl?: string,
): Promise<Record<string, any>> {
  const repo = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
  const github = new GitHub(store, repo, redactor, guard, apiUrl);
  github.purpose = 'review';
  try {
    await github.connect(true, undefined, { issues: 'write', pull_requests: 'write' });
    const targetObj = await github.object(normalized.target.type === 'pr' ? 'review.pr' : 'review.issue', normalized.target.number);
    const files = normalized.target.type === 'pr' ? await github.pages(github.path(`/pulls/${normalized.target.number}/files`)) : [];

    // Verify inline diff positions against live PR files before sending ANY GitHub write.
    if (normalized.target.type === 'pr') {
      for (const f of normalized.findings) {
        if (f.format === 'inline' && f.comment_id === undefined && !inlineLocation(f, files)) {
          return {
            error: 'inline_line_not_in_diff',
            path: f.path,
            line: f.line,
            side: f.side ?? 'RIGHT',
            message: `Inline comment at ${f.path}:${f.line} (${f.side ?? 'RIGHT'}) is outside the Pull Request diff hunks. Nothing was written to GitHub.`,
          };
        }
      }
    }

    if (task.object_number == null) {
      store.run('UPDATE tasks SET object_number=? WHERE id=?', normalized.target.number, task.id);
      task.object_number = normalized.target.number;
    }

    const taskInput = (() => { try { return JSON.parse(String(task.input || '{}')); } catch { return {}; } })();
    const reviewedSha = normalized.target.type === 'pr' ? String(targetObj.head?.sha || task.head_sha || 'HEAD') : String(task.head_sha || 'HEAD');
    const setting = store.get('SELECT review_language FROM policies WHERE repository_id=?', task.repository_id)?.review_language;
    const language = reviewLanguage(setting, `${targetObj?.title ?? ''}\n${targetObj?.body ?? ''}\n${normalized.summary}`);
    const scope = normalized.key ? `${publicationScope(task)}:review:${normalized.key}` : publicationScope(task);
    const publisher = new Publisher(store, github, task, guard, undefined, log, undefined, scope);

    const behaviorChanges =
      normalized.target.type === 'pr'
        ? [
            ...new Set([
              ...(Array.isArray(taskInput.behavior_changes) ? taskInput.behavior_changes.map(String) : []),
              ...files
                .filter((f: any) => behaviorPath(String(f.filename ?? '')) || (f.previous_filename && behaviorPath(String(f.previous_filename))))
                .map((f: any) => String(f.filename)),
            ]),
          ]
        : [];
    const reviewPayload = {
      summary: normalized.summary,
      findings: normalized.findings,
      resolved_comments: normalized.resolved_comments,
      reviewed_sha: reviewedSha,
      reviewed_heads: Array.isArray(taskInput.reviewed_heads) ? taskInput.reviewed_heads : [],
      coverage: normalized.target.type === 'pr'
        ? [`PR #${normalized.target.number}`, `${files.length} changed file(s)`]
        : [`Issue #${normalized.target.number}`],
      ...(behaviorChanges.length ? { behavior_changes: behaviorChanges } : {}),
      ...(normalized.recommendation ? { recommendation: normalized.recommendation } : {}),
      ...(normalized.conclusion ? { conclusion: normalized.conclusion } : {}),
    };

    const outputs = await publisher.review(reviewPayload, files, { language, target: normalized.target });

    const labelsCfg = projectLabels(store, String(task.repository_id));
    const rLabel = labelsCfg.review_label;
    const nhLabelDef = normalized.target.type === 'issue' ? needsHumanIssueLabel(labelsCfg.needs_human_label) : null;
    const wantNeedsHuman = !!nhLabelDef && reviewNeedsHuman(reviewPayload);
    const hasNeedsHuman = !!nhLabelDef && hasLabelName(targetObj?.labels ?? [], nhLabelDef.name);
    let appliedLabels: string[] = [];
    if (rLabel || normalized.labels.length || wantNeedsHuman) {
      const available = normalized.labels.length ? repositoryLabels(await github.pages(github.path('/labels'))) : [];
      const chosen = classificationLabels(
        normalized.labels,
        available,
        targetObj?.labels ?? [],
        [labelsCfg.review_label, labelsCfg.development_label, labelsCfg.developing_label, labelsCfg.needs_human_label],
      );
      if (wantNeedsHuman && nhLabelDef) await publisher.ensureLabel(nhLabelDef);
      appliedLabels = [...(rLabel ? [rLabel] : []), ...(wantNeedsHuman && nhLabelDef ? [nhLabelDef.name] : []), ...chosen];
      if (appliedLabels.length) await publisher.labels(appliedLabels, normalized.target.number);
    }
    if (nhLabelDef && !wantNeedsHuman && hasNeedsHuman) {
      await publisher.removeLabel(nhLabelDef.name, normalized.target.number);
    }

    const summaryCommentOut = outputs.at(-1);
    return {
      ok: true,
      target: normalized.target,
      reviewed_sha: reviewedSha,
      review_id: outputs.length > 1 ? outputs[0]?.id ?? null : null,
      summary_comment_id: summaryCommentOut?.id ?? null,
      summary_url: summaryCommentOut?.html_url ?? null,
      resolved_threads: summaryCommentOut?.resolved_threads ?? [],
      labels_applied: appliedLabels,
      outputs,
    };
  } finally {
    await github.revokeTokens('review');
  }
}

export function grantedTaskWrite(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string) {
  const scope = 'task:' + publicationScope(task);
  return async (name: string, args: any) => {
    const write = name === 'post_review' ? 'review' : name === 'rerun_failed_run' ? 'actions_rerun' : 'github';
    const refused = () => ({
      error: 'delivery_not_granted',
      tool: name,
      missing: 'grant:' + write,
      message: `This task does not hold the ${write} write now, so nothing was sent. Ask the Manager to grant it (grant_writes), or report what is missing.`,
    });
    if (!effectiveWrites(store, task, sourcePolicies(store, task)).includes(write)) return refused();

    const ceiling = projectCeiling(store, String(task.repository_id));
    if (!covers(ceiling, 'comment')) {
      return { error: 'capability_ceiling', needed: 'comment', ceiling, detail: ceilingMessage('comment', ceiling) };
    }

    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    if (name === 'github_write') {
      const context = {
        store,
        repository,
        redactor,
        guard,
        apiUrl,
        scope,
        actor: { kind: 'task' as const, role: taskActingRole(store, task), task_id: String(task.id) },
        allowed: (resource: string, operation?: 'create' | 'reply' | 'labels') =>
          effectiveWrites(store, task, sourcePolicies(store, task)).includes('github') &&
          sourcePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation)),
      };
      return githubWrite(context, args);
    }

    if (name === 'rerun_failed_run') {
      if (
        !args ||
        typeof args !== 'object' ||
        !Array.isArray(args.job_ids) ||
        !args.job_ids.length ||
        args.job_ids.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 1) ||
        typeof args.reason !== 'string' ||
        !args.reason.trim() ||
        !Array.isArray(args.evidence) ||
        !args.evidence.length ||
        args.evidence.some((e: unknown) => typeof e !== 'string' || !e.trim())
      ) {
        return { error: 'invalid_arguments', detail: 'rerun_failed_run requires job_ids, reason, and evidence log lines.' };
      }
      const taskInput = (() => { try { return JSON.parse(String(task.input || '{}')); } catch { return {}; } })();
      const runId = args.run_id !== undefined ? Number(args.run_id) : Number(taskInput.run_id ?? 0);
      if (!Number.isSafeInteger(runId) || runId < 1) {
        return { error: 'invalid_arguments', detail: 'rerun_failed_run requires a positive integer run_id.' };
      }
      const failure = taskInput.actions_failure;
      if (failure && runId !== taskInput.run_id) return { error: 'actions_run_identity_changed', detail: 'The requested run differs from the failure assigned to this task.' };
      const canRerun = () => effectiveWrites(store, task, sourcePolicies(store, task)).includes('actions_rerun');
      const alreadyRerun = () => store.get(
        `SELECT 1 FROM github_effects e JOIN tasks t ON t.id=e.task_id
         WHERE t.repository_id=? AND e.kind='rerun' AND e.state IN ('inflight','unknown','recheck','sent') AND json_extract(e.request,'$.run_id')=?
         UNION ALL
         SELECT 1 FROM actions_failure_runs WHERE repository_id=? AND run_id=? AND retry_state IN ('sending','sent','unknown','denied')
         LIMIT 1`,
        task.repository_id, runId, task.repository_id, runId,
      );
      const spent = () => ({ error: 'rerun_budget_exhausted', run_id: runId, detail: `Run ${runId} already used its single rerun budget.` });
      if (alreadyRerun()) return spent();
      const github = new GitHub(store, repository, redactor, guard, apiUrl);
      github.purpose = 'actions_rerun';
      try {
        await github.connect(true, undefined, { actions: 'write' });
        if (failure) {
          const live = await github.request('GET', github.path(`/actions/runs/${runId}`));
          if (live.id !== runId || live.run_attempt !== failure.attempt || live.head_sha !== failure.head_sha ||
              live.status !== 'completed' || live.conclusion !== 'failure') {
            return { error: 'actions_attempt_identity_changed', run_id: runId, detail: 'The assigned attempt is no longer the latest completed failure.' };
          }
        }
        if (alreadyRerun()) return spent();
        const publisher = new Publisher(store, github, task, guard, undefined, () => {}, () => {
          if (!canRerun()) stop('delivery_not_granted', 'waiting_permission');
        }, scope);
        const path = github.path(`/actions/runs/${runId}/rerun-failed-jobs`);
        await publisher.effect(
          `rerun:${runId}`,
          'rerun',
          { run_id: runId, job_ids: args.job_ids, reason: args.reason.trim() },
          () => github.request('POST', path, {}),
          async () => null,
        );
        store.audit('role:' + taskActingRole(store, task), 'actions.rerun', String(runId), String(task.repository_id));
        return { ok: true, run_id: runId, rerun_requested: true };
      } finally {
        await github.revokeTokens('actions_rerun');
      }
    }

    // post_review: validate arguments before opening any GitHub connection!
    const checked = validateReviewDelivery(task, args);
    if (!checked.ok) return checked.error;
    if (!sourcePolicies(store, task).every(p => githubWriteAllowed(p, checked.value.target.type === 'pr' ? 'pull_requests' : 'issues', 'reply'))) {
      return { error: 'task_external_write_forbidden', detail: 'Source policy does not permit publishing reviews.' };
    }
    return publishReviewDelivery(store, task, checked.value, redactor, guard, () => {}, apiUrl);
  };
}
