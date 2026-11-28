import type { Store, Row } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { isBotPrOpen, recordEvent, rootIssueOfBotPr, type EventInput } from '../dispatch/store.js';

const ACTIVE_DEV_TASK_STATUSES = [
  'queued',
  'retry_wait',
  'waiting_coordination',
  'waiting_event',
  'waiting_configuration',
  'waiting_environment',
  'waiting_permission',
  'waiting_publication',
  'waiting_pr_head',
  'paused',
  'running',
  'preparing',
  'implementing',
  'validating',
  'publishing',
  'result_ready',
] as const;

export interface ActiveDevTaskSummary {
  task_id: string;
  status: string;
  kind: string;
  object_type: 'issue' | 'pr' | null;
  object_number: number | null;
  target_ref: string | null;
  summary: string;
  bot_pr_number: number | null;
  root_issue_number: number | null;
  created_at: string;
}

export interface OpenBotPrSummary {
  number: number;
  branch: string;
  head_sha: string;
  base_ref: string | null;
  title: string | null;
  html_url: string | null;
  draft: boolean;
  root_issue_number: number | null;
  source_task_id: string | null;
  source_task_status: string | null;
}

export interface RepositoryActiveWork {
  active_development_tasks: ActiveDevTaskSummary[];
  open_bot_pull_requests: OpenBotPrSummary[];
}

export interface ReviewOverlapReport {
  issue_number?: number;
  bot_pr_number?: number;
  task_id?: string;
  reason: string;
}

const clip = (value: unknown, limit: number): string => {
  const s = String(value ?? '').trim();
  return s.length > limit ? s.slice(0, limit) + '…' : s;
};

const sha40 = (value: unknown): string | null => {
  const s = String(value ?? '').trim();
  return /^[a-f0-9]{40}$/i.test(s) ? s.toLowerCase() : null;
};

const parseJson = (raw: unknown): any => {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
};

function stripCodeBlocksAndInlineCode(text: string): string {
  // Linear-time O(N) fence and inline-code stripper (avoids regex backtracking on untrusted PR bodies).
  const keptLines: string[] = [];
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trimStart();
    if (fenceChar) {
      let count = 0;
      while (count < trimmed.length && trimmed[count] === fenceChar) count++;
      if (count >= fenceLen && trimmed.slice(count).trim() === '') {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const ch = trimmed[0] as '`' | '~';
      let count = 0;
      while (count < trimmed.length && trimmed[count] === ch) count++;
      if (count >= 3 && (ch === '~' || !trimmed.slice(count).includes('`'))) {
        fenceChar = ch;
        fenceLen = count;
        continue;
      }
    }
    // Strip inline `...` code spans linearly on this line.
    let out = '';
    let i = 0;
    while (i < rawLine.length) {
      if (rawLine[i] === '`') {
        const end = rawLine.indexOf('`', i + 1);
        if (end !== -1) {
          out += ' ';
          i = end + 1;
          continue;
        }
      }
      out += rawLine[i];
      i++;
    }
    keptLines.push(out);
  }
  return keptLines.join('\n');
}

const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;
const SINGLE_ISSUE_REF_RE = /^(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#][^\s,)\]]*)?|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))(?=$|[\s,.;:)!?\]])/;

function advanceSeparator(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i >= text.length) return -1;
  const ch = text[i];
  if (ch === ',' || ch === '&') {
    i++;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    if (ch === ',' && /^and(?=[ \t])/i.test(text.slice(i))) {
      i += 3;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    }
    return i;
  }
  if (i > pos && /^and(?=[ \t])/i.test(text.slice(i))) {
    i += 3;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    return i;
  }
  return -1;
}

/**
 * Extracts same-repository Issue numbers referenced by GitHub closing keywords
 * (`Closes/Fixes/Resolves #N`, `owner/repo#N`, or full same-repo issue URLs).
 * Cross-repository references, code blocks, inline code, and `excludeNumber` (self) are ignored.
 */
export function extractLinkedIssueNumbers(
  text: string | null | undefined,
  repoFullName?: string | null,
  excludeNumber?: number | null,
): number[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const cleaned = stripCodeBlocksAndInlineCode(text);
  const normalizedRepo = typeof repoFullName === 'string' && repoFullName.trim() ? repoFullName.trim().toLowerCase() : null;
  const seen = new Set<number>();
  const out: number[] = [];

  const recordRef = (match: RegExpExecArray) => {
    const urlRepo = match[1];
    const urlNum = match[2];
    const slugRepo = match[3];
    const slugNum = match[4];
    const localNum = match[5];
    const explicitRepo = urlRepo ?? slugRepo ?? null;
    if (explicitRepo) {
      if (!normalizedRepo || explicitRepo.toLowerCase() !== normalizedRepo) return;
    }
    const num = Number(urlNum ?? slugNum ?? localNum);
    if (!Number.isSafeInteger(num) || num < 1) return;
    if (excludeNumber != null && num === excludeNumber) return;
    if (seen.has(num)) return;
    seen.add(num);
    out.push(num);
  };

  CLOSING_KEYWORD_RE.lastIndex = 0;
  let kw: RegExpExecArray | null;
  while ((kw = CLOSING_KEYWORD_RE.exec(cleaned)) !== null) {
    let cursor = kw.index + kw[0].length;
    const beforeSep = cursor;
    while (cursor < cleaned.length && (cleaned[cursor] === ' ' || cleaned[cursor] === '\t')) cursor++;
    let hasColon = false;
    if (cleaned[cursor] === ':') {
      hasColon = true;
      cursor++;
      while (cursor < cleaned.length && (cleaned[cursor] === ' ' || cleaned[cursor] === '\t')) cursor++;
    }
    if (!hasColon && cursor === beforeSep) continue;
    const first = SINGLE_ISSUE_REF_RE.exec(cleaned.slice(cursor));
    if (!first) continue;
    recordRef(first);
    cursor += first[0].length;
    for (;;) {
      const nextCursor = advanceSeparator(cleaned, cursor);
      if (nextCursor < 0) break;
      const next = SINGLE_ISSUE_REF_RE.exec(cleaned.slice(nextCursor));
      if (!next) break;
      recordRef(next);
      cursor = nextCursor + next[0].length;
    }
  }
  return out;
}

/** Queries compact summaries of active development tasks and open bot PRs in a repository. */
export function queryRepositoryActiveWork(
  store: Store,
  repositoryId: string,
  excludePrNumber?: number | null,
): RepositoryActiveWork {
  const statusMarks = ACTIVE_DEV_TASK_STATUSES.map(() => '?').join(',');
  const taskRows = store.all(
    `SELECT t.id, t.kind, t.status, t.summary, t.object_number, t.input, t.created_at
     FROM tasks t
     WHERE t.repository_id = ?
       AND t.status IN (${statusMarks})
       AND (
         t.kind IN ('development.issue', 'development.pr', 'task.development')
         OR (
           t.kind = 'task.request'
           AND EXISTS (
             SELECT 1 FROM task_write_grants g
             WHERE g.task_id = t.id
               AND json_valid(g.writes)
               AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value = 'pull_request')
           )
         )
       )
     ORDER BY t.created_at DESC, t.rowid DESC
     LIMIT 20`,
    repositoryId,
    ...ACTIVE_DEV_TASK_STATUSES,
  );

  const openBotPrs: OpenBotPrSummary[] = [];
  const prBySourceTask = new Map<string, OpenBotPrSummary>();
  const rootIssueByPr = new Map<number, number | null>();

  if (store.hasTable('bot_pull_requests')) {
    const hasStates = store.hasTable('bot_pr_states');
    const prRows = hasStates
      ? store.all(
          `SELECT p.number, p.branch, p.sha, p.source_task_id,
                  s.state AS pr_state, s.draft AS pr_draft, s.base_ref, s.head_sha, s.title, s.html_url,
                  t.status AS source_task_status
           FROM bot_pull_requests p
           LEFT JOIN bot_pr_states s ON s.repository_id = p.repository_id AND s.number = p.number
           LEFT JOIN tasks t ON t.id = p.source_task_id
           WHERE p.repository_id = ?
           ORDER BY p.number DESC
           LIMIT 40`,
          repositoryId,
        )
      : store.all(
          `SELECT p.number, p.branch, p.sha, p.source_task_id,
                  t.status AS source_task_status
           FROM bot_pull_requests p
           LEFT JOIN tasks t ON t.id = p.source_task_id
           WHERE p.repository_id = ?
           ORDER BY p.number DESC
           LIMIT 40`,
          repositoryId,
        );

    for (const row of prRows) {
      const prNum = Number(row.number);
      if (!Number.isSafeInteger(prNum) || prNum < 1) continue;
      if (excludePrNumber != null && prNum === excludePrNumber) continue;
      if (!isBotPrOpen(store, repositoryId, prNum)) continue;
      const rootIssue = rootIssueOfBotPr(store, repositoryId, prNum);
      rootIssueByPr.set(prNum, rootIssue);
      const summary: OpenBotPrSummary = {
        number: prNum,
        branch: String(row.branch ?? ''),
        head_sha: String(row.head_sha || row.sha || ''),
        base_ref: row.base_ref ? String(row.base_ref) : null,
        title: row.title ? clip(row.title, 200) : null,
        html_url: row.html_url ? String(row.html_url) : null,
        draft: Number(row.pr_draft || 0) === 1,
        root_issue_number: rootIssue,
        source_task_id: row.source_task_id ? String(row.source_task_id) : null,
        source_task_status: row.source_task_status ? String(row.source_task_status) : null,
      };
      if (openBotPrs.length < 20) openBotPrs.push(summary);
      if (summary.source_task_id && !prBySourceTask.has(summary.source_task_id)) {
        prBySourceTask.set(summary.source_task_id, summary);
      }
    }
  }

  const activeTasks: ActiveDevTaskSummary[] = [];
  for (const row of taskRows) {
    const input = parseJson(row.input);
    const kind = String(row.kind ?? '');
    const targetTypeRaw = input?.target?.type;
    const objectType: 'issue' | 'pr' | null =
      targetTypeRaw === 'issue' || kind === 'development.issue'
        ? 'issue'
        : targetTypeRaw === 'pr' || kind === 'development.pr'
          ? 'pr'
          : null;
    const rawNumber = input?.target?.number ?? row.object_number;
    const parsedNum = rawNumber != null ? Number(rawNumber) : NaN;
    const objectNumber = Number.isSafeInteger(parsedNum) && parsedNum >= 1 ? parsedNum : null;
    const ownedPr = prBySourceTask.get(String(row.id));
    const botPrNumber =
      ownedPr?.number ??
      (Number.isSafeInteger(Number(input?.pr_number)) && Number(input.pr_number) >= 1
        ? Number(input.pr_number)
        : Number.isSafeInteger(Number(input?.bot_pr?.number)) && Number(input.bot_pr.number) >= 1
          ? Number(input.bot_pr.number)
          : objectType === 'pr'
            ? objectNumber
            : null);
    if (excludePrNumber != null && botPrNumber === excludePrNumber && objectType === 'pr') continue;
    const rootIssueNumber =
      objectType === 'issue'
        ? objectNumber
        : ownedPr?.root_issue_number ??
          (botPrNumber != null
            ? (rootIssueByPr.has(botPrNumber)
                ? rootIssueByPr.get(botPrNumber)!
                : rootIssueOfBotPr(store, repositoryId, botPrNumber))
            : null);
    const targetRef =
      typeof input?.target?.ref === 'string' && input.target.ref.trim()
        ? input.target.ref.trim()
        : typeof input?.base_branch === 'string' && input.base_branch.trim()
          ? input.base_branch.trim()
          : null;
    activeTasks.push({
      task_id: String(row.id),
      status: String(row.status),
      kind,
      object_type: objectType,
      object_number: objectNumber,
      target_ref: targetRef,
      summary: clip(row.summary, 200),
      bot_pr_number: botPrNumber,
      root_issue_number: rootIssueNumber,
      created_at: String(row.created_at),
    });
  }

  return {
    active_development_tasks: activeTasks,
    open_bot_pull_requests: openBotPrs,
  };
}

export const hasRepositoryActiveWork = (work: RepositoryActiveWork): boolean =>
  work.active_development_tasks.length > 0 || work.open_bot_pull_requests.length > 0;

function prFactsForOverlap(pr: any) {
  return {
    number: Number(pr?.number),
    title: clip(pr?.title, 300),
    state: pr?.state ?? 'open',
    author: pr?.user?.login ?? null,
    labels: (pr?.labels || []).map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
    body_excerpt: clip(pr?.body, 1500),
    draft: pr?.draft === true,
    head: sha40(pr?.head?.sha),
    base: typeof pr?.base?.ref === 'string' ? pr.base.ref : null,
    url: pr?.html_url ?? null,
  };
}

/**
 * Emits companion `issue.linked_pull_request` events to linked Issues' Manager threads when a non-bot open non-draft PR
 * explicitly links (`Closes/Fixes/Resolves #M`) an Issue that currently has an active development task or an open bot PR.
 * Returns `[]` with zero extra work when the repository has neither active dev tasks nor open bot PRs.
 */
export function linkedIssuePullRequestEvents(
  store: Store,
  repositoryId: string,
  event: string,
  payload: Json,
  delivery: string,
  isBotOwnPr: (pr: any) => boolean,
): EventInput[] {
  if (event !== 'pull_request') return [];
  const p = payload as any;
  const action = String(p?.action ?? '');
  if (!['opened', 'ready_for_review', 'edited'].includes(action)) return [];
  const pr = p?.pull_request;
  const prNumber = Number(pr?.number);
  const head = sha40(pr?.head?.sha);
  if (!pr || pr.state !== 'open' || pr.draft === true || !Number.isSafeInteger(prNumber) || prNumber < 1 || !head) {
    return [];
  }
  if (action === 'edited' && p?.changes && p.changes.body === undefined && p.changes.title === undefined) {
    return [];
  }
  if (isBotOwnPr(pr)) return [];

  const activeWork = queryRepositoryActiveWork(store, repositoryId, prNumber);
  if (!hasRepositoryActiveWork(activeWork)) return [];

  const repoFullName = store.get('SELECT full_name FROM repositories WHERE id=?', repositoryId)?.full_name ?? null;
  const linkedIssues = extractLinkedIssueNumbers(
    `${String(pr.title ?? '')}\n${String(pr.body ?? '')}`,
    repoFullName ? String(repoFullName) : null,
    prNumber,
  );
  if (!linkedIssues.length) return [];

  const actor = String(p?.sender?.login ?? pr.user?.login ?? '');
  const basePrFacts = prFactsForOverlap(pr);
  const out: EventInput[] = [];

  for (const issueNumber of linkedIssues) {
    const matchedTasks = activeWork.active_development_tasks.filter(
      t => (t.object_type === 'issue' && t.object_number === issueNumber) || t.root_issue_number === issueNumber,
    );
    const matchedBotPrs = activeWork.open_bot_pull_requests.filter(
      bp => bp.root_issue_number === issueNumber,
    );
    if (!matchedTasks.length && !matchedBotPrs.length) continue;

    const eventKey = `${repositoryId}:issue.linked_pull_request:${issueNumber}:pr:${prNumber}`;
    out.push({
      repositoryId,
      key: eventKey,
      type: 'issue.linked_pull_request',
      source: 'github',
      summary: `关联 PR #${prNumber}（${actor || '外部'}）指向 Issue #${issueNumber}：${clip(pr.title, 100)}`,
      object: { type: 'issue', number: issueNumber },
      delivery,
      facts: {
        event,
        action,
        actor,
        linked_pull_request: {
          ...basePrFacts,
          matched_by: 'closing_keyword',
          linked_issue_number: issueNumber,
        },
        active_development_tasks: matchedTasks,
        open_bot_pull_requests: matchedBotPrs,
      },
      options: [
        {
          id: 'compare',
          work: 'task.request',
          title: `核对关联 PR #${prNumber} 与 Issue #${issueNumber} 的 bot 开发/PR 改动`,
          spec: { type: 'generic' },
        },
      ],
      // head is intentionally null so continue_task never overwrites a bot PR task's move_to_sha with the human PR head.
      merge: {
        key: eventKey,
        data: {
          reason: 'linked_pull_request',
          issue_number: issueNumber,
          linked_pull_request: {
            number: prNumber,
            title: basePrFacts.title,
            author: basePrFacts.author,
            url: basePrFacts.url,
            head: basePrFacts.head,
            base: basePrFacts.base,
          },
        },
        trigger: { reason: 'linked_pull_request', pr_number: prNumber, actor },
        head: null,
        kinds: ['development.issue', 'development.pr'],
      },
    });
  }

  return out;
}

/**
 * Emits `issue.linked_pull_request` convergence events when a human PR reviewer reports implicit overlap via
 * `post_review.overlapping_work`. Validates every reported item against live DB active development tasks and open
 * bot PRs so fabricated or already-closed references never wake the Manager.
 */
export function emitReviewOverlapEvents(
  store: Store,
  task: Row,
  input: any,
  overlappingWork: ReadonlyArray<ReviewOverlapReport>,
): number {
  if (!Array.isArray(overlappingWork) || !overlappingWork.length) return 0;
  const repositoryId = String(task.repository_id);
  const policy = store.get('SELECT enabled FROM policies WHERE repository_id=?', repositoryId);
  if (!policy?.enabled) return 0;

  const pr = input?.object;
  const prNumber = Number(pr?.number ?? input?.target?.number ?? task.object_number);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return 0;
  if (store.hasTable('bot_pull_requests') && store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber)) {
    return 0;
  }

  const activeWork = queryRepositoryActiveWork(store, repositoryId, prNumber);
  if (!hasRepositoryActiveWork(activeWork)) return 0;

  type Group = {
    key: string;
    object: { type: 'issue' | 'pr'; number: number } | null;
    issueNumber: number | null;
    botPrNumber: number | null;
    tasks: Map<string, ActiveDevTaskSummary>;
    botPrs: Map<number, OpenBotPrSummary>;
    reasons: Set<string>;
  };
  const groups = new Map<string, Group>();
  const ensureGroup = (key: string, object: { type: 'issue' | 'pr'; number: number } | null, issueNumber: number | null, botPrNumber: number | null) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, object, issueNumber, botPrNumber, tasks: new Map(), botPrs: new Map(), reasons: new Set() };
      groups.set(key, g);
    }
    return g;
  };

  for (const item of overlappingWork) {
    if (!item || typeof item !== 'object') continue;
    const reasonText = clip(item.reason, 400);
    if (!reasonText) continue;

    const matchedTasks = new Map<string, ActiveDevTaskSummary>();
    const matchedBotPrs = new Map<number, OpenBotPrSummary>();

    if (typeof item.task_id === 'string' && item.task_id.trim()) {
      const found = activeWork.active_development_tasks.find(t => t.task_id === item.task_id!.trim());
      if (found) matchedTasks.set(found.task_id, found);
    }
    if (Number.isSafeInteger(item.bot_pr_number) && Number(item.bot_pr_number) >= 1) {
      const found = activeWork.open_bot_pull_requests.find(bp => bp.number === Number(item.bot_pr_number));
      if (found) {
        matchedBotPrs.set(found.number, found);
        for (const t of activeWork.active_development_tasks) {
          if (t.bot_pr_number === found.number || (found.source_task_id && t.task_id === found.source_task_id)) {
            matchedTasks.set(t.task_id, t);
          }
        }
      }
    }
    if (Number.isSafeInteger(item.issue_number) && Number(item.issue_number) >= 1) {
      const issueNum = Number(item.issue_number);
      for (const t of activeWork.active_development_tasks) {
        if ((t.object_type === 'issue' && t.object_number === issueNum) || t.root_issue_number === issueNum) {
          matchedTasks.set(t.task_id, t);
        }
      }
      for (const bp of activeWork.open_bot_pull_requests) {
        if (bp.root_issue_number === issueNum) matchedBotPrs.set(bp.number, bp);
      }
    }

    if (!matchedTasks.size && !matchedBotPrs.size) continue;

    const resolvedIssue =
      (Number.isSafeInteger(item.issue_number) && Number(item.issue_number) >= 1 ? Number(item.issue_number) : null) ??
      [...matchedBotPrs.values()].find(bp => bp.root_issue_number != null)?.root_issue_number ??
      [...matchedTasks.values()].find(t => t.root_issue_number != null)?.root_issue_number ??
      null;

    if (resolvedIssue != null) {
      // Include all live active tasks / open bot PRs for that Issue so the Manager has the full picture.
      const g = ensureGroup(
        `${repositoryId}:issue.linked_pull_request:${resolvedIssue}:pr:${prNumber}`,
        { type: 'issue', number: resolvedIssue },
        resolvedIssue,
        null,
      );
      for (const t of activeWork.active_development_tasks) {
        if ((t.object_type === 'issue' && t.object_number === resolvedIssue) || t.root_issue_number === resolvedIssue) {
          g.tasks.set(t.task_id, t);
        }
      }
      for (const bp of activeWork.open_bot_pull_requests) {
        if (bp.root_issue_number === resolvedIssue) g.botPrs.set(bp.number, bp);
      }
      for (const t of matchedTasks.values()) g.tasks.set(t.task_id, t);
      for (const bp of matchedBotPrs.values()) g.botPrs.set(bp.number, bp);
      g.reasons.add(reasonText);
      continue;
    }

    const standalonePr = [...matchedBotPrs.values()][0]?.number ?? null;
    if (standalonePr != null) {
      const g = ensureGroup(
        `${repositoryId}:pr.linked_pull_request:${standalonePr}:pr:${prNumber}`,
        { type: 'pr', number: standalonePr },
        null,
        standalonePr,
      );
      for (const t of matchedTasks.values()) g.tasks.set(t.task_id, t);
      for (const bp of matchedBotPrs.values()) g.botPrs.set(bp.number, bp);
      g.reasons.add(reasonText);
      continue;
    }

    const standaloneTask = [...matchedTasks.values()][0];
    if (standaloneTask) {
      const g = ensureGroup(
        `${repositoryId}:task.linked_pull_request:${standaloneTask.task_id}:pr:${prNumber}`,
        null,
        null,
        null,
      );
      for (const t of matchedTasks.values()) g.tasks.set(t.task_id, t);
      g.reasons.add(reasonText);
    }
  }

  const basePrFacts = pr ? prFactsForOverlap(pr) : {
    number: prNumber,
    title: clip(input?.target_meta?.title ?? task.summary, 300),
    state: 'open',
    author: null,
    labels: [],
    body_excerpt: '',
    draft: false,
    head: sha40(input?.target_meta?.head_sha ?? task.head_sha),
    base: typeof input?.target_meta?.base_ref === 'string' ? input.target_meta.base_ref : null,
    url: null,
  };

  let created = 0;
  for (const g of groups.values()) {
    const reasons = [...g.reasons];
    const targetLabel = g.issueNumber != null
      ? `Issue #${g.issueNumber}`
      : g.botPrNumber != null
        ? `bot PR #${g.botPrNumber}`
        : `在研任务 ${[...g.tasks.keys()][0]}`;
    created += recordEvent(store, {
      repositoryId,
      key: g.key,
      type: 'issue.linked_pull_request',
      source: 'review',
      summary: `检视发现 PR #${prNumber} 与 ${targetLabel} 重叠：${clip(reasons[0] || basePrFacts.title, 100)}`,
      object: g.object,
      delivery: task.source_delivery_id ? String(task.source_delivery_id) : null,
      facts: {
        event: 'review_overlap',
        review_task_id: String(task.id),
        overlap_reasons: reasons,
        linked_pull_request: {
          ...basePrFacts,
          matched_by: 'review_overlap',
          ...(g.issueNumber != null ? { linked_issue_number: g.issueNumber } : {}),
        },
        active_development_tasks: [...g.tasks.values()],
        open_bot_pull_requests: [...g.botPrs.values()],
      },
      options: [
        {
          id: 'compare',
          work: 'task.request',
          title: `核对重叠 PR #${prNumber} 与当前 bot 开发/PR 改动`,
          spec: { type: 'generic' },
        },
      ],
      ...(g.object
        ? {
            merge: {
              key: g.key,
              data: {
                reason: 'linked_pull_request',
                matched_by: 'review_overlap',
                review_task_id: String(task.id),
                overlap_reasons: reasons,
                linked_pull_request: {
                  number: prNumber,
                  title: basePrFacts.title,
                  author: basePrFacts.author,
                  url: basePrFacts.url,
                  head: basePrFacts.head,
                  base: basePrFacts.base,
                },
              },
              trigger: { reason: 'linked_pull_request', pr_number: prNumber, matched_by: 'review_overlap' },
              head: null,
              kinds: ['development.issue', 'development.pr'],
            },
          }
        : {}),
    });
  }
  return created;
}
