import type { Store, Row } from '../storage/database.js';
import { stop, TaskError, type Redactor } from '../agent/common.js';
import type { Workspace } from '../agent/workspace.js';
import { GitHub } from '../github/client.js';
import { hostedMediaUrl } from '../github/hosted-pr-media.js';
import { collectPullRequestMedia, commentMediaSchema, planMarkdownMedia, publishHostedMedia, type StoredMedia } from '../github/pull-request-media.js';
import { githubWrite, type WriteResource, type WriteOperation } from '../github/write.js';
import { githubWriteAllowed } from '../roles/permissions.js';
import { taskActingRole, taskRolePolicies, sourcePolicies } from './management.js';
import { effectiveWrites } from './grants.js';
import { pullRequestRefusal } from './pull-request.js';
import { scheduledIssueOperationAllowed } from './schedule-write.js';
import { Publisher, publicationScope } from '../github/publisher.js';
import { inlineLocation, reviewConclusions } from '../review/findings.js';
import { classificationLabels, hasLabelName, needsHumanIssueLabel, repositoryLabels, reviewNeedsHuman } from '../review/labels.js';
import { behaviorPath, projectLabels } from '../rules/service.js';
import { reviewLanguage } from '../github/text.js';
import { covers, projectCeiling, ceilingMessage } from '../projects/ceiling.js';
import type { ReviewOverlapReport } from '../review/pr-overlap.js';

export function taskWriteAllowed(store: Store, task: Row, resource: WriteResource, operation?: WriteOperation): boolean {
  const scheduled = scheduledIssueOperationAllowed(task, resource, operation);
  if (scheduled !== null) return scheduled;
  return taskRolePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation));
}

export function taskGithubWrite(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string, getWorkspace?: () => Workspace | undefined) {
  const scope = 'task:' + publicationScope(task);
  return (args: unknown) => {
    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    const workspace = getWorkspace?.();
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
        ...(workspace ? { collectMedia: (paths: string[]) => collectPullRequestMedia(workspace, paths) } : {}),
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
          requires_human_decision: {
            type: 'boolean',
            description: 'True when a person must decide or act. When true, explain the background in body; when more than one viable option exists, present concrete candidate options with one recommended option and each option\'s pros and cons (for a single-path action, state it directly without inventing alternatives).',
          },
          human_action: {
            type: 'string',
            description: 'When requires_human_decision is true: one concise sentence stating what a person must decide or do (and, when comparing options, your recommended option).',
          },
          comment_id: { type: 'integer', minimum: 1 },
          selection_reason: { type: 'string' },
        },
      },
    },
    resolved_comments: { type: 'array', items: { type: 'integer', minimum: 1 } },
    labels: { type: 'array', items: { type: 'string' } },
    media: commentMediaSchema,
    recommendation: { type: 'string' },
    conclusion: { type: 'string', enum: [...reviewConclusions] },
    overlapping_work: {
      type: 'array',
      maxItems: 10,
      description: 'Optional. Only on human PR reviews when repository_active_work is provided and this PR substantively overlaps an active bot development task or open bot PR in this repository: report each overlapping item so the control plane routes a convergence event to its Manager thread.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['reason'],
        properties: {
          issue_number: { type: 'integer', minimum: 1 },
          bot_pr_number: { type: 'integer', minimum: 1 },
          task_id: { type: 'string', maxLength: 120 },
          reason: { type: 'string', maxLength: 500 },
        },
      },
    },
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
  media_paths?: string[];
  media?: StoredMedia[];
  recommendation?: string;
  conclusion?: string;
  overlapping_work?: ReviewOverlapReport[];
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
  'media',
  'recommendation',
  'conclusion',
  'overlapping_work',
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
  let mediaPaths: string[] = [];
  const reviewTexts = [summaryRaw.trim(), ...rawFindings.map(f => String(f.body || ''))];
  if (args.media !== undefined || reviewTexts.some(text => text.includes('workspace:'))) {
    try { mediaPaths = planMarkdownMedia(reviewTexts, args.media).paths; }
    catch (error) {
      if (error instanceof TaskError) return { ok: false, error: { error: error.code, detail: error.detail } };
      throw error;
    }
  }

  let overlappingWork: ReviewOverlapReport[] = [];
  if (args.overlapping_work !== undefined) {
    if (!Array.isArray(args.overlapping_work) || args.overlapping_work.length > 10) {
      return { ok: false, error: { error: 'invalid_arguments', detail: 'overlapping_work must be an array of at most 10 overlap entries. Nothing was sent.' } };
    }
    const allowedOverlapKeys = new Set(['issue_number', 'bot_pr_number', 'task_id', 'reason']);
    for (const rawItem of args.overlapping_work) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem) || Object.keys(rawItem).some(k => !allowedOverlapKeys.has(k))) {
        return { ok: false, error: { error: 'invalid_arguments', detail: 'Each overlapping_work entry may only include issue_number, bot_pr_number, task_id, and reason. Nothing was sent.' } };
      }
      const itemReason = typeof rawItem.reason === 'string' ? rawItem.reason.trim() : '';
      if (!itemReason || itemReason.length > 500) {
        return { ok: false, error: { error: 'invalid_arguments', detail: 'Each overlapping_work entry requires a non-empty reason (<= 500 chars). Nothing was sent.' } };
      }
      const issueNum = rawItem.issue_number !== undefined ? Number(rawItem.issue_number) : undefined;
      const botPrNum = rawItem.bot_pr_number !== undefined ? Number(rawItem.bot_pr_number) : undefined;
      const taskId = rawItem.task_id !== undefined ? (typeof rawItem.task_id === 'string' ? rawItem.task_id.trim() : '') : undefined;
      if (issueNum !== undefined && (!Number.isSafeInteger(issueNum) || issueNum < 1)) {
        return { ok: false, error: { error: 'invalid_arguments', detail: 'overlapping_work.issue_number must be a positive integer. Nothing was sent.' } };
      }
      if (botPrNum !== undefined && (!Number.isSafeInteger(botPrNum) || botPrNum < 1)) {
        return { ok: false, error: { error: 'invalid_arguments', detail: 'overlapping_work.bot_pr_number must be a positive integer. Nothing was sent.' } };
      }
      if (taskId !== undefined && (!taskId || taskId.length > 120)) {
        return { ok: false, error: { error: 'invalid_arguments', detail: 'overlapping_work.task_id must be a non-empty string (<= 120 chars). Nothing was sent.' } };
      }
      if (issueNum === undefined && botPrNum === undefined && taskId === undefined) {
        return { ok: false, error: { error: 'invalid_arguments', detail: 'Each overlapping_work entry must specify at least one of issue_number, bot_pr_number, or task_id. Nothing was sent.' } };
      }
      overlappingWork.push({
        ...(issueNum !== undefined ? { issue_number: issueNum } : {}),
        ...(botPrNum !== undefined ? { bot_pr_number: botPrNum } : {}),
        ...(taskId !== undefined ? { task_id: taskId } : {}),
        reason: itemReason,
      });
    }
  }

  return {
    ok: true,
    value: {
      target,
      key: typeof args.key === 'string' && args.key.trim() ? args.key.trim() : null,
      summary: summaryRaw.trim(),
      findings: rawFindings,
      resolved_comments: resolved,
      labels,
      ...(mediaPaths.length ? { media_paths: mediaPaths } : {}),
      ...(typeof args.recommendation === 'string' && args.recommendation.trim() ? { recommendation: args.recommendation.trim() } : {}),
      ...(typeof args.conclusion === 'string' && args.conclusion.trim() ? { conclusion: args.conclusion.trim() } : {}),
      ...(overlappingWork.length ? { overlapping_work: overlappingWork } : {}),
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
    let renderedSummary = normalized.summary;
    let renderedFindings = normalized.findings;
    if (normalized.media?.length) {
      let hosted;
      try { hosted = publishHostedMedia(github, normalized.media); }
      catch (error) {
        if (error instanceof TaskError) return { error: error.code, detail: error.detail };
        throw error;
      }
      const plan = planMarkdownMedia([normalized.summary, ...normalized.findings.map(f => String(f.body || ''))], normalized.media.map(file => file.source));
      const bySource = new Map(normalized.media.map(file => [file.source, file.path]));
      let missingUrl = false;
      const rendered = plan.renderAll(source => {
        const url = hostedMediaUrl(hosted, bySource.get(source) ?? '');
        if (!url) { missingUrl = true; return ''; }
        return url;
      });
      if (missingUrl) return { error: 'pull_request_media_unconfirmed', detail: 'The hosted media has no confirmed URL.' };
      renderedSummary = rendered[0]!;
      renderedFindings = normalized.findings.map((f, index) => ({ ...f, body: rendered[index + 1]! }));
    }
    const reviewPayload = {
      summary: renderedSummary,
      findings: renderedFindings,
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
      ...(normalized.overlapping_work?.length ? { overlapping_work: normalized.overlapping_work } : {}),
      outputs,
    };
  } finally {
    await github.revokeTokens('review');
  }
}

/**
 * Checks whether a `github_write` call targets strictly this task's own bot PR lifecycle (allowed under a `pull_request`
 * grant even when the task does not hold full `github` write):
 * - `POST /pulls` whose `body.head` is a `bot/*` branch owned by this task in `bot_branches`
 * - `PATCH /pulls/:n`, `POST /issues/:n/comments`, `POST|DELETE /issues/:n/labels[/:label]` on a bot PR owned by this task.
 * Never permits merge (`PUT /pulls/:n/merge`), Issues creation/edits, human PR edits, `/contents/*`, `/git/*`, or Actions.
 */
function checkScopedPullRequestWrite(
  store: Store,
  task: Row,
  repository: Row,
  args: any,
): { allowed: true } | { allowed: false; detail: string } {
  const method = String(args?.method ?? '').toUpperCase();
  const path = typeof args?.path === 'string' ? args.path.trim() : '';
  const repoId = String(task.repository_id);
  const taskId = String(task.id);
  const taskInput = (() => { try { return JSON.parse(String(task.input || '{}')); } catch { return {}; } })();
  const adoptedPrNumber = Number.isSafeInteger(Number(taskInput?.bot_pr?.number)) ? Number(taskInput.bot_pr.number) : null;
  const adoptedBranch = typeof taskInput?.bot_pr?.head?.ref === 'string' ? taskInput.bot_pr.head.ref.trim() : null;

  if (method === 'POST' && path === '/pulls') {
    const rawHead = typeof args?.body?.head === 'string' ? args.body.head.trim() : '';
    if (!rawHead) {
      return { allowed: false, detail: 'Under the pull_request grant (without full github write), POST /pulls requires body.head naming a bot/* branch pushed by this task via push_bot_branch.' };
    }
    const repoOwner = String(repository.full_name || '').split('/')[0] || '';
    let headBranch = rawHead.replace(/^refs\/heads\//, '');
    if (headBranch.includes(':')) {
      const [prefix, rest] = headBranch.split(':', 2);
      if (!repoOwner || prefix!.toLowerCase() !== repoOwner.toLowerCase() || !rest) {
        return { allowed: false, detail: 'Cross-repository head references are not allowed under the pull_request grant; push to this repository\'s bot/* branch first.' };
      }
      headBranch = rest.replace(/^refs\/heads\//, '');
    }
    const ownedBranch = headBranch.startsWith('bot/') && Boolean(
      (adoptedBranch && headBranch === adoptedBranch)
      || (store.hasTable('bot_branches') && store.get('SELECT 1 FROM bot_branches WHERE repository_id=? AND branch=? AND task_id=?', repoId, headBranch, taskId)),
    );
    if (!ownedBranch) {
      return {
        allowed: false,
        detail: `Under the pull_request grant (without full github write), POST /pulls may only open a pull request from a bot/* branch pushed by this task via push_bot_branch ("${headBranch}" is not registered to this task).`,
      };
    }
    return { allowed: true };
  }

  const prMatch =
    (method === 'PATCH' && /^\/pulls\/([1-9]\d{0,9})$/.exec(path))
    || (method === 'POST' && /^\/issues\/([1-9]\d{0,9})\/comments$/.exec(path))
    || ((method === 'POST' || method === 'DELETE') && /^\/issues\/([1-9]\d{0,9})\/labels(?:\/[^/]+)?$/.exec(path));
  if (prMatch) {
    const prNumber = Number(prMatch[1]);
    const prRow = store.hasTable('bot_pull_requests')
      ? store.get('SELECT source_task_id,branch FROM bot_pull_requests WHERE repository_id=? AND number=?', repoId, prNumber)
      : undefined;
    const ownsPr = Boolean(
      (adoptedPrNumber !== null && prNumber === adoptedPrNumber)
      || (prRow && (
        String(prRow.source_task_id) === taskId
        || (typeof prRow.branch === 'string' && store.hasTable('bot_branches') && store.get('SELECT 1 FROM bot_branches WHERE repository_id=? AND branch=? AND task_id=?', repoId, prRow.branch, taskId))
      )),
    );
    if (ownsPr) return { allowed: true };
    return {
      allowed: false,
      detail: `Under the pull_request grant (without full github write), github_write is restricted to this task's own bot pull request (#${prNumber} is not owned by this task).`,
    };
  }

  return {
    allowed: false,
    detail: 'Under the pull_request grant (without full github write), github_write is restricted to opening/updating this task\'s own bot pull request (POST /pulls from its pushed bot/* branch, PATCH /pulls/{n}, and comments/labels on that bot PR); merging, Issues, contents, refs, and other PRs require their own grant/policy.',
  };
}

export function grantedTaskWrite(
  store: Store,
  task: Row,
  redactor: Redactor,
  guard: () => Promise<void>,
  apiUrl?: string,
  getWorkspace?: () => Workspace | undefined,
  options?: { onPullRequestWritten?: (event: { method: string; path: string; result: any }) => void },
) {
  const scope = 'task:' + publicationScope(task);
  return async (name: string, args: any) => {
    const effective = effectiveWrites(store, task, sourcePolicies(store, task));
    const write = name === 'post_review' ? 'review' : name === 'rerun_failed_run' ? 'actions_rerun' : 'github';
    const refused = (missingWrite = write) => ({
      error: 'delivery_not_granted',
      tool: name,
      missing: 'grant:' + missingWrite,
      message: `This task does not hold the ${missingWrite} write now, so nothing was sent. Ask the Manager to grant it (grant_writes), or report what is missing.`,
    });

    const hasFullGithub = name === 'github_write' && effective.includes('github');
    const hasScopedPrWrite = name === 'github_write' && effective.includes('pull_request');
    if (name === 'github_write') {
      if (!hasFullGithub && !hasScopedPrWrite) return refused('github');
    } else if (!effective.includes(write)) {
      return refused();
    }

    const ceiling = projectCeiling(store, String(task.repository_id));
    if (!covers(ceiling, 'comment')) {
      return { error: 'capability_ceiling', needed: 'comment', ceiling, detail: ceilingMessage('comment', ceiling) };
    }

    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    const workspace = getWorkspace?.();
    if (name === 'github_write') {
      const scopedCheck = hasScopedPrWrite ? checkScopedPullRequestWrite(store, task, repository, args) : { allowed: false as const, detail: '' };
      if (!hasFullGithub) {
        const prRefusal = pullRequestRefusal(store, task);
        if (prRefusal) {
          return { error: prRefusal.code, tool: 'github_write', missing: prRefusal.missing, message: prRefusal.message };
        }
        if (!scopedCheck.allowed) {
          return { error: 'github_write_scope_forbidden', tool: 'github_write', detail: scopedCheck.detail };
        }
      }
      const context = {
        store,
        repository,
        redactor,
        guard,
        apiUrl,
        scope,
        actor: { kind: 'task' as const, role: taskActingRole(store, task), task_id: String(task.id) },
        allowed: (resource: string, operation?: 'create' | 'reply' | 'labels') => {
          const liveEffective = effectiveWrites(store, task, sourcePolicies(store, task));
          if (liveEffective.includes('github') && sourcePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation))) {
            return true;
          }
          if (liveEffective.includes('pull_request') && resource === 'pull_requests' && !pullRequestRefusal(store, task) && scopedCheck.allowed) {
            return true;
          }
          return false;
        },
        ...(workspace ? { collectMedia: (paths: string[]) => collectPullRequestMedia(workspace, paths) } : {}),
      };
      const result = await githubWrite(context, args);
      if (result && !result.error && options?.onPullRequestWritten) {
        const m = String(args?.method ?? '').toUpperCase();
        const p = typeof args?.path === 'string' ? args.path.trim() : '';
        if ((m === 'POST' && p === '/pulls') || (m === 'PATCH' && /^\/pulls\/\d+$/.test(p))) {
          options.onPullRequestWritten({ method: m, path: p, result });
        }
      }
      return result;
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
    let delivery = checked.value;
    if (delivery.media_paths?.length) {
      if (!workspace) return { error: 'github_write_media_unavailable', detail: 'This post_review caller has no task workspace to read workspace media files.' };
      try {
        const media = await collectPullRequestMedia(workspace, delivery.media_paths);
        delivery = { ...delivery, ...(media ? { media } : {}) };
      } catch (error) {
        if (error instanceof TaskError) return { error: error.code, detail: error.detail };
        throw error;
      }
    }
    return publishReviewDelivery(store, task, delivery, redactor, guard, () => {}, apiUrl);
  };
}
