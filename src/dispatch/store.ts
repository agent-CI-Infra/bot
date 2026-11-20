import type { Store, Row } from '../storage/database.js';
import { randomId, HttpError, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { captureTaskConfiguration, taskPermissions } from '../tasks/configuration.js';
import { TaskRecords } from '../tasks/service.js';
import { enqueue, enqueueRefusal } from '../review/queue.js';
import { continueFinishedReview } from '../review/continuation.js';
import { enqueueEventTask } from '../tasks/event-adapters.js';
import { covers, projectCeiling, type Ceiling } from '../projects/ceiling.js';
import { projectRefusal, setGrant } from '../tasks/grants.js';
import { normalizeTaskTarget, type NormalizedTaskTarget } from '../tasks/commands.js';
import { roleConfiguration } from '../roles/definition.js';
import { githubWriteAllowed } from '../roles/permissions.js';
import { assertManagedTask, assertTaskCaller, createManagedTask, eventTaskCaller } from '../tasks/management.js';
import { ownIssue, recordBasis, type Basis } from './basis.js';
import { scheduledCheckCriteria } from '../tasks/schedule-write.js';
import { legacyKindName } from '../projects/legacy-kinds.js';
import { actionsDevelopmentAllowed } from '../actions/safety.js';

/**
 * Unified Object Manager dispatch (#1122).
 *
 * - Events on the same root Issue (including any bot PR opened from that Issue) or standalone PR share a persistent
 *   `dispatch_threads` record, serialized per `thread_key`.
 * - Fixed work-type option lock-in (`dispatch_option_not_offered`) is retired: the Manager (or a standing rule) creates
 *   generic `task.request` tasks bound to `target` (`issue` / `pr` / `branch` / `commit`), `executor_role` (`reviewer`,
 *   `dev`, `test`, or `null` for team coordination), and `writes` (`pull_request`, `review`, `github`, `actions_rerun`),
 *   all bounded by `capability_ceiling` and `manager` role permissions.
 * - Release observation, release notes, and scheduled checks retain their domain hooks. Actions failure events use ordinary
 *   commit-targeted tasks with run context.
 */
export function dispatchStorage(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_events(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,type TEXT NOT NULL,
      source TEXT NOT NULL,object_type TEXT,object_number INTEGER,delivery_id TEXT,summary TEXT NOT NULL,facts TEXT NOT NULL,options TEXT NOT NULL,
      merge TEXT,state TEXT NOT NULL DEFAULT 'pending',decision TEXT,reason TEXT,brief TEXT,result TEXT,model TEXT,attempts INTEGER NOT NULL DEFAULT 0,
      lease TEXT,lease_until INTEGER,next_run_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,decided_at TEXT);
    CREATE INDEX IF NOT EXISTS dispatch_events_due ON dispatch_events(state,next_run_at);
    CREATE INDEX IF NOT EXISTS dispatch_events_repository ON dispatch_events(repository_id,created_at);
    CREATE INDEX IF NOT EXISTS dispatch_events_object ON dispatch_events(repository_id,object_type,object_number);
    CREATE TABLE IF NOT EXISTS dispatch_threads(thread_key TEXT PRIMARY KEY,repository_id TEXT NOT NULL,object_type TEXT NOT NULL,
      object_number INTEGER,messages TEXT NOT NULL DEFAULT '[]',summary TEXT,active_task_id TEXT,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS dispatch_threads_repository ON dispatch_threads(repository_id,updated_at);
    CREATE TABLE IF NOT EXISTS dispatch_retries(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES dispatch_events(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL,previous_attempts INTEGER NOT NULL,previous_error TEXT);
    CREATE INDEX IF NOT EXISTS dispatch_retries_event ON dispatch_retries(event_id);
    CREATE TABLE IF NOT EXISTS dispatch_failures(event_id TEXT NOT NULL REFERENCES dispatch_events(id) ON DELETE CASCADE,attempt INTEGER NOT NULL,created_at TEXT NOT NULL,error TEXT NOT NULL,next_run_at INTEGER NOT NULL,report INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,attempt));
    CREATE INDEX IF NOT EXISTS dispatch_failures_created ON dispatch_failures(created_at);
    CREATE TABLE IF NOT EXISTS task_events(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,event_id TEXT NOT NULL,relation TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(task_id,event_id));
    CREATE INDEX IF NOT EXISTS task_events_event ON task_events(event_id);
  `);
  const cols = new Set(store.all('PRAGMA table_info(dispatch_events)').map(c => String(c.name)));
  if (!cols.has('refusals')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN refusals TEXT');
  if (!cols.has('rule')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN rule TEXT');
  if (!cols.has('answer_round')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN answer_round INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('thread_key')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN thread_key TEXT');
  store.db.exec('CREATE INDEX IF NOT EXISTS dispatch_events_thread ON dispatch_events(thread_key,state,created_at)');
}

export interface ThreadTurn {
  event_id: string;
  event_type: string;
  object: { type: string; number: number | null };
  summary: string;
  decision: 'create' | 'continue' | 'ignore';
  role: string | null;
  writes: string[] | null;
  created: string[];
  continued: string[];
  reason: string;
  rule: string | null;
  at: string;
}

export interface DispatchThread {
  thread_key: string;
  repository_id: string;
  object_type: string;
  object_number: number | null;
  messages: ThreadTurn[];
  summary: string | null;
  active_task_id: string | null;
  updated_at: string | null;
}

/** Resolves the root Issue number for a bot PR opened from an Issue development task, if any. */
export function rootIssueOfBotPr(store: Store, repositoryId: string, prNumber: number): number | null {
  if (!store.hasTable('bot_pull_requests') || !Number.isSafeInteger(prNumber) || prNumber < 1) return null;
  const root = store.get(
    `SELECT t.object_number FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
     WHERE p.repository_id=? AND p.number=? AND t.object_number IS NOT NULL
     AND (t.kind='development.issue' OR json_extract(t.input,'$.target.type')='issue') LIMIT 1`,
    repositoryId,
    prNumber,
  );
  return root?.object_number ? Number(root.object_number) : null;
}

/** Resolves bot PR numbers opened from an Issue development task on `issueNumber`. */
export function botPullRequestsOfIssue(store: Store, repositoryId: string, issueNumber: number): number[] {
  if (!store.hasTable('bot_pull_requests') || !Number.isSafeInteger(issueNumber) || issueNumber < 1) return [];
  return store.all(
    `SELECT p.number FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
     WHERE p.repository_id=? AND t.object_number=?
     AND (t.kind='development.issue' OR json_extract(t.input,'$.target.type')='issue') ORDER BY p.number DESC`,
    repositoryId,
    issueNumber,
  ).map(r => Number(r.number));
}

/**
 * Deterministic Object Manager thread key (#1122):
 * - Root Issue: `<repo>:issue:<number>`
 * - Bot PR opened from a root Issue: linked back to `<repo>:issue:<rootIssue>` so Issue + bot PR share one Manager thread!
 * - Standalone PR: `<repo>:pr:<number>`
 * - Domain events: `<repo>:release:<version>`, `<repo>:actions:<workflow>`, `<repo>:schedule:<id>`
 */
export function threadKey(store: Store, event: Record<string, any>): string {
  if (typeof event.thread_key === 'string' && event.thread_key) return event.thread_key;
  const repo = String(event.repository_id);
  const objectType = event.object_type ? String(event.object_type) : null;
  const objectNumber = event.object_number != null ? Number(event.object_number) : null;
  if (objectType === 'issue' && objectNumber) return `${repo}:issue:${objectNumber}`;
  if (objectType === 'pr' && objectNumber) {
    const rootIssue = rootIssueOfBotPr(store, repo, objectNumber);
    if (rootIssue) return `${repo}:issue:${rootIssue}`;
    return `${repo}:pr:${objectNumber}`;
  }
  let facts: any = {};
  try { facts = typeof event.facts === 'string' ? JSON.parse(event.facts) : event.facts ?? {}; } catch { facts = {}; }
  if (event.source === 'release' || event.type === 'release.manual') {
    return `${repo}:release:${String(facts?.release?.version ?? event.event_key ?? event.id)}`;
  }
  if (event.source === 'actions' || event.type === 'actions.run_failed') {
    return `${repo}:actions:${String(facts?.run?.workflow ?? facts?.run?.id ?? event.event_key ?? event.id)}`;
  }
  if (event.source === 'schedule' || event.type === 'schedule.due') {
    return `${repo}:schedule:${String(facts?.schedule_id ?? facts?.occurrence_id ?? event.event_key ?? event.id)}`;
  }
  return `${repo}:event:${String(event.event_key ?? event.id)}`;
}

export function readDispatchThread(store: Store, key: string, repositoryId = ''): DispatchThread {
  if (!store.hasTable('dispatch_threads')) {
    return { thread_key: key, repository_id: repositoryId, object_type: 'event', object_number: null, messages: [], summary: null, active_task_id: null, updated_at: null };
  }
  const row = store.get('SELECT * FROM dispatch_threads WHERE thread_key=?', key);
  if (!row) {
    const parts = key.split(':');
    return {
      thread_key: key,
      repository_id: repositoryId || parts[0] || '',
      object_type: parts[1] || 'event',
      object_number: parts[2] && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null,
      messages: [],
      summary: null,
      active_task_id: null,
      updated_at: null,
    };
  }
  let messages: ThreadTurn[] = [];
  try { messages = JSON.parse(String(row.messages || '[]')); } catch { messages = []; }
  return {
    thread_key: String(row.thread_key),
    repository_id: String(row.repository_id),
    object_type: String(row.object_type),
    object_number: row.object_number != null ? Number(row.object_number) : null,
    messages,
    summary: row.summary ? String(row.summary) : null,
    active_task_id: row.active_task_id ? String(row.active_task_id) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
}

function appendDispatchThread(store: Store, event: Row, checked: Decision, created: string[], continued: string[], now: string) {
  if (!store.hasTable('dispatch_threads')) return;
  const key = threadKey(store, event);
  const current = readDispatchThread(store, key, String(event.repository_id));
  const turn: ThreadTurn = {
    event_id: String(event.id),
    event_type: String(event.type),
    object: { type: String(event.object_type ?? current.object_type), number: event.object_number != null ? Number(event.object_number) : null },
    summary: String(event.summary).slice(0, 240),
    decision: checked.decision,
    role: checked.role ?? null,
    writes: checked.writes ?? null,
    created,
    continued,
    reason: checked.reason.slice(0, 400),
    rule: checked.rule?.id ?? null,
    at: now,
  };
  const all = [...current.messages.filter(m => m.event_id !== turn.event_id), turn];
  let summary = current.summary;
  let kept = all;
  if (all.length > 20) {
    const folded = all.slice(0, all.length - 14);
    kept = all.slice(all.length - 14);
    const lines = folded.map(item => `[${item.at.slice(0, 19)}] ${item.event_type} -> ${item.decision}${item.role ? `(${item.role})` : ''}: ${item.reason.slice(0, 120)}`);
    summary = [summary, ...lines].filter(Boolean).join('\n').slice(-4000);
  }
  const activeTaskId = created[0] ?? continued[0] ?? current.active_task_id;
  store.run(
    `INSERT INTO dispatch_threads(thread_key,repository_id,object_type,object_number,messages,summary,active_task_id,updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(thread_key) DO UPDATE SET messages=excluded.messages,summary=excluded.summary,active_task_id=excluded.active_task_id,updated_at=excluded.updated_at`,
    key,
    String(event.repository_id),
    current.object_type,
    current.object_number,
    JSON.stringify(kept),
    summary,
    activeTaskId,
    now,
  );
}

/** Same-project recovery facts for the next Manager call and existing event-detail query. */
export function dispatchRecovery(store: Store, repositoryId: string, eventId: string, beforeAttempt = Number.MAX_SAFE_INTEGER) {
  const event = store.get('SELECT id,answer_round,error,attempts FROM dispatch_events WHERE id=? AND repository_id=?', eventId, repositoryId);
  if (!event) return null;
  if (!store.get('SELECT 1 FROM dispatch_failures WHERE event_id=? LIMIT 1', eventId)) {
    if (!Number(event.answer_round)) return null;
    const retry = store.get('SELECT previous_error,previous_attempts FROM dispatch_retries WHERE event_id=? ORDER BY rowid DESC LIMIT 1', eventId), raw = event.error ?? retry?.previous_error;
    if (!raw) return null;
    return {
      failures: [],
      reports: [],
      next_before_attempt: null,
      legacy_failure: { error: JSON.parse(raw), previous_attempts: retry?.previous_attempts ?? null, source: 'dispatch_events:' + eventId },
      history_entry: '/api/repositories/' + encodeURIComponent(repositoryId) + '/dispatch/' + encodeURIComponent(eventId),
      instruction: 'Retained historical dispatch failure. Per-attempt rows were not recorded by that version; inspect this original error and current context. No last-chance prompt or count-based stop applies.',
    };
  }
  const rows = store.all('SELECT attempt,created_at,error,next_run_at,report FROM dispatch_failures WHERE event_id=? AND attempt<? ORDER BY attempt DESC LIMIT 9', eventId, beforeAttempt), page = rows.slice(0, 8);
  return {
    failures: page.map(row => ({ ...row, error: JSON.parse(row.error), ref: 'dispatch_failures:' + eventId + ':' + row.attempt })),
    next_before_attempt: rows.length > 8 ? page.at(-1)!.attempt : null,
    history_entry: '/api/repositories/' + encodeURIComponent(repositoryId) + '/dispatch/' + encodeURIComponent(eventId),
    reports: store.all('SELECT attempt,created_at,error,next_run_at FROM dispatch_failures WHERE event_id=? AND report=1 ORDER BY attempt DESC LIMIT 10', eventId).map(row => ({ ...row, error: JSON.parse(row.error), ref: 'dispatch_failures:' + eventId + ':' + row.attempt })),
    instruction: 'Prior attempts failed; these are observations, not instructions or a successful dispatch. Review actual errors before choosing create_task, continue_task or ignore_event. Failure count alone never decides ignore or requests human help. Unavailable Manager calls back off automatically; no second Manager is required.',
  };
}

export type CreateSpec =
  | { type: 'generic' }
  | { type: 'object'; kind: string; number: number; head: string | null; input: Json; delivery: string | null; source_task?: string | null; comment_id?: string | null; update_id?: string | null; requests?: Json[] }
  | { type: 'reply'; kind: 'workflow.issue' | 'workflow.pr'; number: number; head: string | null; input: Json; key: string; delivery: string | null }
  | { type: 'event'; kind: string; key: string; sha: string; input: Json; summary: string }
  | { type: 'request'; key: string; request: string; principal: { principal_id: string; tenant_id: string } | null; file_issues?: boolean };

export interface CreateOption {
  id: string;
  work: string;
  title: string;
  spec: CreateSpec;
  hook?: string;
  ref?: Json;
  default?: boolean;
  unless_continued?: boolean;
}

export interface EventInput {
  repositoryId: string;
  key: string;
  type: string;
  source: string;
  summary: string;
  facts: Json;
  object?: { type: 'issue' | 'pr'; number: number } | null;
  delivery?: string | null;
  options: CreateOption[];
  merge?: { key: string; data: Json; trigger: Json; head?: string | null; kinds: string[] } | null;
}

export interface ContinueOption {
  id: string;
  task_id: string;
  kind: string;
  status: string;
  summary: string;
  created_at: string;
}

export interface Decision {
  decision: 'create' | 'continue' | 'ignore';
  option_ids: string[];
  role?: string | null;
  writes?: string[] | null;
  target?: NormalizedTaskTarget | null;
  reason: string;
  brief?: { goal: string; criteria: string[] } | null;
  model?: string | null;
  basis?: Basis | null;
  rule?: { id: string; revision: number } | null;
  seen?: string[];
  /** Internal test-only flag set by `ruleDecider` for legacy fixture compatibility. */
  legacyKinds?: boolean;
}

export interface UnavailableWork { id: string; work: string; title: string; code: string; reason: string }
export interface DispatchContext {
  event: Row;
  thread: DispatchThread;
  facts: Json;
  options: CreateOption[];
  unavailable: UnavailableWork[];
  continuations: ContinueOption[];
  related: Json[];
}
export interface Refusal { work: string; code: string; reason: string; task_id?: string }

export interface DispatchHook {
  created(store: Store, task: Row, ref: Json | null, event: Row): void;
  declined(store: Store, event: Row, reason: string, ref: Json | null): void;
}
const hooks = new Map<string, DispatchHook>();
export const registerDispatchHook = (name: string, hook: DispatchHook) => { hooks.set(name, hook); };
export const dispatchHook = (name: string) => hooks.get(name);

type SyncDecider = (context: DispatchContext) => Decision;
let immediate: SyncDecider | null = null;
export const decideImmediately = (decider: SyncDecider | null) => { immediate = decider; };
let wake: (() => void) | null = null;
export const onDispatchEvent = (callback: (() => void) | null) => { wake = callback; };

const activeStates = ['queued', 'retry_wait', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'running', 'preparing', 'implementing', 'validating', 'publishing', 'result_ready'];

function neededCeilingForOption(work: string): Ceiling {
  if (work === 'development.issue' || work === 'development.pr' || work === 'task.development') return 'develop';
  if (work.startsWith('review.') || work === 'reply') return 'comment';
  return 'read';
}

function optionCeilingRefusal(store: Store, repositoryId: string, work: string, eventType?: string): { code: string; reason: string } | null {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  if (!policy?.enabled) return { code: 'project_disabled', reason: '项目已停用。' };
  if (eventType === 'actions.run_failed' && !policy.actions_failures_enabled) {
    return { code: 'actions_failures_disabled', reason: '项目已关闭 Actions 失败处理。' };
  }
  const ceiling = projectCeiling(store, repositoryId, policy);
  const needed = eventType === 'actions.run_failed' ? 'comment' : neededCeilingForOption(work);
  if (!covers(ceiling, needed)) {
    return {
      code: 'capability_ceiling',
      reason: needed === 'develop'
        ? `项目当前能力上限为 ${ceiling}，不到「可开发并开 PR」（develop），不能新建代码开发任务。`
        : `项目当前能力上限为 ${ceiling}，不到「可评论和打标签」（comment），不能对外发布检视或评论。`,
    };
  }
  if (eventType === 'issue.opened' && work === 'review.issue' && !policy.review_issues) {
    return { code: 'event_filter_off', reason: '项目已关闭 Issue 检视开关。' };
  }
  if ((eventType === 'pull_request.opened' || eventType === 'pull_request.synchronize') && work === 'review.pr' && !policy.review_pull_requests) {
    return { code: 'event_filter_off', reason: '项目已关闭 PR 检视开关。' };
  }
  return null;
}

function optionOffered(store: Store, repositoryId: string, work: string, eventType: string): boolean {
  const refusal = optionCeilingRefusal(store, repositoryId, work, eventType);
  if (!refusal) return true;
  // Explicit human requests (mentions, development labels) still reach the Manager so it can explain capability ceiling limits (#815).
  if (refusal.code === 'capability_ceiling' && (eventType.endsWith('.mention') || eventType === 'issue.labeled' || eventType === 'pull_request.labeled')) {
    return covers(projectCeiling(store, repositoryId), 'comment');
  }
  return false;
}

/**
 * Writes an event once. Returns the number of tasks created when tests decide immediately, otherwise 1 for a new event
 * and 0 for one already written.
 */
export function recordEvent(store: Store, input: EventInput): number {
  const options = input.options;
  const offered = options.filter(option => optionOffered(store, input.repositoryId, option.work, input.type));
  if (!offered.length && !(input.merge && continuations(store, { repository_id: input.repositoryId, object_type: input.object?.type ?? null, object_number: input.object?.number ?? null, merge: JSON.stringify(input.merge) }).length)) {
    for (const option of input.options) if (option.hook) hooks.get(option.hook)?.declined(store, { repository_id: input.repositoryId, type: input.type }, 'work_inactive', option.ref ?? null);
    const reasons = options.map(option => optionCeilingRefusal(store, input.repositoryId, option.work, input.type)?.reason).filter(Boolean);
    recordFiltered(store, { ...input, code: 'work_inactive', reason: reasons.length ? [...new Set(reasons)].join(' ') : '这个事件没有项目允许的工作，也没有可以续接的任务。' });
    return 0;
  }
  const id = randomId(), now = new Date().toISOString();
  const computedThreadKey = threadKey(store, {
    repository_id: input.repositoryId,
    object_type: input.object?.type ?? null,
    object_number: input.object?.number ?? null,
    source: input.source,
    type: input.type,
    event_key: input.key,
    facts: input.facts,
    id,
  });
  const inserted = store.run(
    `INSERT OR IGNORE INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,delivery_id,summary,facts,options,merge,thread_key,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, input.repositoryId, input.key, input.type, input.source, input.object?.type ?? null, input.object?.number ?? null, input.delivery ?? null,
    input.summary.slice(0, 300), JSON.stringify(input.facts), JSON.stringify(options), input.merge ? JSON.stringify(input.merge) : null, computedThreadKey, now,
  );
  if (!inserted.changes) return 0;
  if (immediate) {
    const event = store.get('SELECT * FROM dispatch_events WHERE id=?', id)!;
    return applyDecision(store, event, immediate(dispatchContext(store, event)), null).created.length;
  }
  queueMicrotask(() => wake?.());
  return 1;
}

/**
 * Tasks the event may join on the same object (#770, #1122): both generic `task.request` tasks and historical tasks,
 * including active development linked across a root Issue and its bot PR.
 */
export function continuations(store: Store, event: Record<string, any>): ContinueOption[] {
  const merge = event.merge ? JSON.parse(String(event.merge)) : null;
  if (!merge?.kinds?.length || !event.object_number) return [];
  const repo = String(event.repository_id);
  const objectNumber = Number(event.object_number);
  const allKinds = [...new Set([...merge.kinds, 'task.request'])];
  const marks = allKinds.map(() => '?').join(',');
  const objectType = event.object_type ? String(event.object_type) : (String(merge.kinds[0] || '').endsWith('.pr') ? 'pr' : 'issue');
  const preferDev = String(merge.kinds[0] || '').startsWith('development.');
  const active = store.all(
    `SELECT t.id,t.kind,t.status,t.summary,t.created_at,t.input FROM tasks t
     WHERE t.repository_id=? AND t.object_number=? AND t.kind IN (${marks})
     AND (t.kind<>'task.request' OR json_extract(t.input,'$.target.type') IS NULL OR json_extract(t.input,'$.target.type')=?)
     AND t.status IN (${activeStates.map(() => '?').join(',')})
     ORDER BY CASE WHEN t.status IN ('running','preparing','implementing','validating','publishing','result_ready') THEN 0 ELSE 1 END,
       (SELECT claimed_at FROM task_claims WHERE task_id=t.id) DESC,t.created_at DESC,t.rowid DESC`,
    repo, objectNumber, ...allKinds, objectType, ...activeStates,
  );
  const seenIds = new Set(active.map(t => String(t.id)));
  if (objectType === 'pr') {
    const rootIssue = rootIssueOfBotPr(store, repo, objectNumber);
    if (rootIssue) {
      const linkedIssueDev = store.all(
        `SELECT t.id,t.kind,t.status,t.summary,t.created_at,t.input FROM tasks t
         WHERE t.repository_id=? AND t.object_number=?
         AND (t.kind='development.issue' OR (t.kind='task.request' AND json_extract(t.input,'$.target.type')='issue'
           AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))))
         AND t.status IN (${activeStates.map(() => '?').join(',')})
         ORDER BY t.created_at DESC,t.rowid DESC`,
        repo, rootIssue, ...activeStates,
      );
      for (const row of linkedIssueDev) if (!seenIds.has(String(row.id))) { seenIds.add(String(row.id)); active.push(row); }
    }
  } else if (objectType === 'issue') {
    const botPrs = botPullRequestsOfIssue(store, repo, objectNumber);
    if (botPrs.length) {
      const prMarks = botPrs.map(() => '?').join(',');
      const linkedPrDev = store.all(
        `SELECT t.id,t.kind,t.status,t.summary,t.created_at,t.input FROM tasks t
         WHERE t.repository_id=? AND t.object_number IN (${prMarks})
         AND (t.kind='development.pr' OR (t.kind='task.request' AND json_extract(t.input,'$.target.type')='pr'
           AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))))
         AND t.status IN (${activeStates.map(() => '?').join(',')})
         ORDER BY t.created_at DESC,t.rowid DESC`,
        repo, ...botPrs, ...activeStates,
      );
      for (const row of linkedPrDev) if (!seenIds.has(String(row.id))) { seenIds.add(String(row.id)); active.push(row); }
    }
  }
  // Sort so preferred family (development vs review) comes first among active tasks
  active.sort((a, b) => {
    const aRun = ['running', 'preparing', 'implementing', 'validating', 'publishing', 'result_ready'].includes(String(a.status)) ? 0 : 1;
    const bRun = ['running', 'preparing', 'implementing', 'validating', 'publishing', 'result_ready'].includes(String(b.status)) ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    const aDev = String(a.kind).startsWith('development.') || (a.kind === 'task.request' && taskPermissions(store, a).writes.includes('pull_request'));
    const bDev = String(b.kind).startsWith('development.') || (b.kind === 'task.request' && taskPermissions(store, b).writes.includes('pull_request'));
    if (aDev !== bDev) return (preferDev ? (aDev ? -1 : 1) : (aDev ? 1 : -1));
    return 0;
  });
  const running = (task: Row) => ['running', 'preparing', 'implementing', 'validating', 'publishing', 'result_ready'].includes(String(task.status));
  const latest = active.find(running);
  const joinable = [...(latest ? [latest] : []), ...active.filter(task => !running(task))].slice(0, 5);
  if (!joinable.length) {
    const finished = store.get(
      `SELECT t.id,t.kind,t.status,t.summary,t.created_at FROM tasks t
       WHERE t.repository_id=? AND t.object_number=? AND t.status='succeeded'
       AND ((t.kind IN (${marks}) AND t.kind LIKE 'review.%')
         OR (t.kind='task.request' AND (json_extract(t.input,'$.target.type') IS NULL OR json_extract(t.input,'$.target.type')=?)
           AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='review'))))
       ORDER BY t.updated_at DESC,t.rowid DESC LIMIT 1`,
      repo, objectNumber, ...allKinds, objectType,
    );
    if (finished) joinable.push(finished);
  }
  return joinable.map(task => ({
    id: 'continue:' + task.id,
    task_id: String(task.id),
    kind: String(task.kind),
    status: String(task.status),
    summary: String(task.summary),
    created_at: String(task.created_at),
  }));
}

export function dispatchContext(store: Store, event: Row): DispatchContext {
  const joinable = continuations(store, event), options: CreateOption[] = [], unavailable: UnavailableWork[] = [];
  for (const saved of JSON.parse(event.options) as CreateOption[]) {
    // Pending events from earlier versions keep their selection id and use the new task path.
    const option = event.type === 'actions.run_failed' && saved.work === 'actions.failures'
      ? { ...saved, work: 'task.request', spec: { type: 'generic' as const } }
      : saved;
    if (option.unless_continued && joinable.length) continue;
    const refusal = optionCeilingRefusal(store, event.repository_id, option.work, event.type);
    if (refusal) unavailable.push({ id: option.id, work: option.work, title: option.title, ...refusal });
    else options.push(option);
  }
  const relatedNumbers = event.object_number
    ? [
        ...new Set([
          Number(event.object_number),
          ...(event.object_type === 'pr'
            ? [rootIssueOfBotPr(store, String(event.repository_id), Number(event.object_number))].filter((n): n is number => !!n)
            : event.object_type === 'issue'
              ? botPullRequestsOfIssue(store, String(event.repository_id), Number(event.object_number))
              : []),
        ]),
      ]
    : [];
  const related = relatedNumbers.length
    ? store.all(
        `SELECT id,kind,status,summary,error_code,created_at,updated_at,result FROM tasks
         WHERE repository_id=? AND object_number IN (${relatedNumbers.map(() => '?').join(',')})
         AND kind NOT IN ('release.observe','release.notes','actions.failures')
         ORDER BY created_at DESC,rowid DESC LIMIT 8`,
        event.repository_id,
        ...relatedNumbers,
      ).map(task => {
        let outcome: unknown = null;
        try {
          const result = JSON.parse(task.result || 'null');
          outcome = result?.summary ? String(result.summary).slice(0, 300) : result?.pr_url ?? null;
        } catch { outcome = null; }
        return { id: task.id, kind: task.kind, status: task.status, summary: task.summary, error_code: task.error_code ?? null, created_at: task.created_at, outcome };
      })
    : [];
  const tKey = threadKey(store, event);
  return {
    event,
    thread: readDispatchThread(store, tKey, String(event.repository_id)),
    facts: JSON.parse(event.facts),
    options,
    unavailable,
    continuations: joinable,
    related,
  };
}

export function optionRefusal(store: Store, context: DispatchContext, id: string): Refusal | null {
  const unavailable = context.unavailable.find(work => work.id === id || work.work === id);
  if (unavailable) return { work: unavailable.work, code: unavailable.code, reason: unavailable.reason };
  const option = context.options.find(entry => entry.id === id || entry.work === id);
  if (!option) return null;
  const spec = option.spec, repo = String(context.event.repository_id);
  const refusal = (code: string, reason: string, task?: Row) => ({ work: option.work, code, reason, ...(task ? { task_id: String(task.id) } : {}) });
  if (spec.type === 'object') {
    const refused = enqueueRefusal(store, repo, spec.kind, spec.number, spec.head, spec.input, spec.comment_id ?? null, spec.update_id ?? null);
    return refused ? { work: option.work, ...refused } : null;
  }
  const key = spec.type === 'reply' ? `${repo}:reply:${spec.number}:${spec.key}` : spec.type === 'request' ? `${repo}:task.request:${spec.key}` : null;
  const existing = key ? store.get('SELECT id FROM tasks WHERE unique_key=?', key) : null;
  return existing ? refusal('task_already_created', '这个事件要建的任务已经建过了。', existing) : null;
}

export const deferredRefusals = ['task_already_created'];

export const managerRefusal = (store: Store, context: DispatchContext, id: string) => {
  const refusal = optionRefusal(store, context, id);
  return refusal && !deferredRefusals.includes(refusal.code) ? refusal : null;
};

export function findActiveObjectDevelopment(
  store: Store,
  repo: string,
  targetType: 'issue' | 'pr',
  targetNumber: number,
): { id: string; status: string; code: 'development_active' | 'revision_active' } | null {
  const queryOne = (type: 'issue' | 'pr', num: number) =>
    store.get(
      `SELECT t.id,t.status FROM tasks t WHERE t.repository_id=? AND t.object_number=?
       AND (t.kind=? OR (t.kind='task.request' AND json_extract(t.input,'$.target.type')=? AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))))
       AND t.status IN (${activeStates.map(() => '?').join(',')},'waiting_pr_head') LIMIT 1`,
      repo,
      num,
      type === 'pr' ? 'development.pr' : 'development.issue',
      type,
      ...activeStates,
    );
  const direct = queryOne(targetType, targetNumber);
  if (direct) {
    return { id: String(direct.id), status: String(direct.status), code: targetType === 'pr' ? 'revision_active' : 'development_active' };
  }
  if (targetType === 'pr') {
    const rootIssue = rootIssueOfBotPr(store, repo, targetNumber);
    const linked = rootIssue ? queryOne('issue', rootIssue) : undefined;
    if (linked) return { id: String(linked.id), status: String(linked.status), code: 'development_active' };
  } else {
    for (const prNum of botPullRequestsOfIssue(store, repo, targetNumber)) {
      const linked = queryOne('pr', prNum);
      if (linked) return { id: String(linked.id), status: String(linked.status), code: 'revision_active' };
    }
  }
  return null;
}

/** Checks whether creating a generic `task.request` with `(role, writes, target)` is currently allowed by ceiling & object state. */
export function genericRefusal(
  store: Store,
  context: DispatchContext,
  role: string | null | undefined,
  writes: string[],
  target: NormalizedTaskTarget | null | undefined,
): Refusal | null {
  const repo = String(context.event.repository_id);
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repo);
  if (!policy?.enabled) return { work: role ?? 'task.request', code: 'project_disabled', reason: '项目已停用。' };
  if (context.event.type === 'actions.run_failed') {
    const refusal = optionCeilingRefusal(store, repo, 'task.request', 'actions.run_failed');
    if (refusal) return { work: 'task.request', ...refusal };
  }
  for (const write of writes) {
    const refused = projectRefusal(store, repo, write);
    if (refused) return { work: write, code: refused.code, reason: refused.message };
  }
  const managerRole = roleConfiguration(store, repo).roles.find(r => r.role_id === 'manager' && r.enabled);
  if (!managerRole) return { work: role ?? 'task.request', code: 'task_role_unavailable', reason: 'Manager 角色已停用。' };
  for (const write of writes) {
    const ok = write === 'pull_request'
      ? githubWriteAllowed(managerRole.permissions, 'contents') && githubWriteAllowed(managerRole.permissions, 'pull_requests')
      : write === 'review'
        ? githubWriteAllowed(managerRole.permissions, 'pull_requests') || githubWriteAllowed(managerRole.permissions, 'issues')
        : write === 'actions_rerun'
          ? githubWriteAllowed(managerRole.permissions, 'actions')
          : githubWriteAllowed(managerRole.permissions, 'issues') || githubWriteAllowed(managerRole.permissions, 'pull_requests');
    if (!ok) return { work: write, code: 'task_external_write_forbidden', reason: `Manager 角色当前未持有授予 ${write} 所需的 GitHub 写权限。` };
  }
  if (role) {
    const targetRole = roleConfiguration(store, repo).roles.find(r => r.role_id === role && r.enabled);
    if (!targetRole || targetRole.kind === 'evaluator' || role === 'coordinator') {
      return { work: role, code: 'task_executor_unavailable', reason: `角色「${role}」不存在、已停用或不可作为执行角色。` };
    }
  }
  if (writes.includes('pull_request') && target && (target.type === 'issue' || target.type === 'pr') && target.number) {
    if (target.type === 'issue' && !actionsDevelopmentAllowed(store, repo, target.number)) {
      return { work: 'pull_request', code: 'actions_development_not_allowed', reason: '这是 Actions 失败提报的 Issue，项目已关闭 Actions 失败处理或能力上限不到 develop。' };
    }
    const active = findActiveObjectDevelopment(store, repo, target.type, target.number);
    if (active) {
      return {
        work: 'pull_request',
        code: active.code,
        task_id: active.id,
        reason: `这个 ${target.type === 'pr' ? 'PR' : 'Issue'} 已有进行中的开发/修订任务（${active.status}），请用 continue_task 续接。`,
      };
    }
  }
  return null;
}

export function recordRefusal(store: Store, eventId: string, refusal: Refusal & { tool?: string }) {
  const row = store.get('SELECT refusals FROM dispatch_events WHERE id=?', eventId);
  if (!row) return;
  let list: Json[] = [];
  try { list = JSON.parse(String(row.refusals || '[]')); } catch { list = []; }
  store.run('UPDATE dispatch_events SET refusals=? WHERE id=?', JSON.stringify([...list, { ...refusal, at: new Date().toISOString() }].slice(-20)), eventId);
}

export function recordFiltered(store: Store, input: {
  repositoryId: string; key: string; type: string; source?: string; summary: string;
  object?: { type: 'issue' | 'pr'; number: number } | null; delivery?: string | null; facts?: Json; code: string; reason: string;
}) {
  const now = new Date().toISOString(), id = randomId();
  const computedThreadKey = threadKey(store, {
    repository_id: input.repositoryId,
    object_type: input.object?.type ?? null,
    object_number: input.object?.number ?? null,
    source: input.source ?? 'github',
    type: input.type,
    event_key: input.key,
    facts: input.facts ?? {},
    id,
  });
  store.run(
    `INSERT OR IGNORE INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,delivery_id,summary,facts,options,thread_key,state,decision,reason,result,created_at,decided_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'[]',?,'filtered','ignore',?,?,?,?)`,
    id, input.repositoryId, input.key, input.type, input.source ?? 'github', input.object?.type ?? null,
    input.object?.number ?? null, input.delivery ?? null, input.summary.slice(0, 300), JSON.stringify(input.facts ?? {}),
    computedThreadKey, input.reason.slice(0, 1000), JSON.stringify({ filtered: input.code }), now, now,
  );
}

export const filteredRetentionMs = 30 * 86400000;
export const pruneFiltered = (store: Store, now = Date.now()) =>
  store.run("DELETE FROM dispatch_events WHERE state='filtered' AND created_at<?", new Date(now - filteredRetentionMs).toISOString()).changes;

export const dispatchLeaseMs = 5 * 60000;
export function renewDispatchLease(store: Store, event: Row): boolean {
  return store.run("UPDATE dispatch_events SET lease_until=? WHERE id=? AND lease=? AND state='dispatching'", Date.now() + dispatchLeaseMs, event.id, event.lease).changes > 0;
}

export class InvalidDecision extends Error { constructor(readonly code: string, message: string) { super(message); } }

const allowedGenericWrites = new Set(['pull_request', 'review', 'github', 'actions_rerun']);

function mapShorthandWork(shorthand: string): { role: string; writes: string[] } | null {
  if (shorthand === 'review' || shorthand === 'review.issue' || shorthand === 'review.pr') return { role: 'reviewer', writes: ['review'] };
  if (shorthand === 'reply' || shorthand === 'workflow.issue' || shorthand === 'workflow.pr') return { role: 'reviewer', writes: ['github'] };
  if (shorthand === 'development' || shorthand === 'development.issue' || shorthand === 'development.pr') return { role: 'dev', writes: ['pull_request'] };
  if (shorthand === 'test') return { role: 'test', writes: [] };
  if (shorthand === 'report' || shorthand === 'task.request') return { role: 'reviewer', writes: [] };
  return null;
}

function defaultEventTarget(context: DispatchContext): NormalizedTaskTarget | null {
  const event = context.event;
  if (event.type === 'actions.run_failed') {
    const sha = (context.facts as any)?.run?.head_sha;
    return typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) ? { type: 'commit', ref: sha } : null;
  }
  if (!event.object_type || !event.object_number) return null;
  const type = event.object_type === 'pr' ? 'pr' : 'issue';
  const head = (context.facts as any)?.object?.head ?? (context.facts as any)?.push?.after ?? null;
  return {
    type,
    number: Number(event.object_number),
    ...(type === 'pr' && typeof head === 'string' && /^[a-f0-9]{40}$/.test(head) ? { ref: head } : {}),
  };
}

/** Validates a Manager or rule decision; removes `dispatch_option_not_offered` lock-in in favor of generic task dispatch. */
export function checkDecision(store: Store, context: DispatchContext, value: any): Decision {
  const failDecision = (code: string, message: string): never => { throw new InvalidDecision(code, message); };
  if (!value || typeof value !== 'object') failDecision('dispatch_decision_invalid', 'The decision must be an object.');
  const decision = value.decision;
  const ids = Array.isArray(value.option_ids) ? value.option_ids.map(String) : [];
  if (!['create', 'continue', 'ignore'].includes(decision)) {
    failDecision('dispatch_decision_invalid', 'decision must be create, continue or ignore.');
  }
  if (decision !== 'ignore') {
    try { assertTaskCaller(store, eventTaskCaller(store, String(context.event.repository_id), String(context.event.id)), true); }
    catch (error) { if (error instanceof HttpError) throw new TaskError(error.code, 'waiting_configuration'); throw error; }
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason) failDecision('dispatch_reason_required', 'Give the reason for the decision.');
  if (new Set(ids).size !== ids.length) failDecision('dispatch_decision_invalid', 'option_ids repeat an option.');
  if (decision === 'ignore' && ids.length) failDecision('dispatch_decision_invalid', 'ignore takes no option_ids.');

  if (decision === 'continue') {
    const normalizedId = ids[0] ? (ids[0].startsWith('continue:') ? ids[0] : 'continue:' + ids[0]) : '';
    if (ids.length !== 1 || !context.continuations.some(option => option.id === normalizedId)) {
      failDecision('dispatch_continuation_unavailable', 'continue needs an active or resumable task id from continuations.');
    }
    return { decision: 'continue', option_ids: [normalizedId], reason: reason.slice(0, 1000), model: typeof value.model === 'string' ? value.model : null };
  }

  if (decision === 'ignore') {
    return { decision: 'ignore', option_ids: [], reason: reason.slice(0, 1000), model: typeof value.model === 'string' ? value.model : null };
  }

  // Parse brief
  let brief: Decision['brief'] = null;
  if (value.brief !== undefined && value.brief !== null) {
    const goal = typeof value.brief?.goal === 'string' ? value.brief.goal.trim() : '', criteria = value.brief?.criteria ?? [];
    if (!goal) failDecision('dispatch_brief_invalid', 'brief belongs to create and needs a goal.');
    if (!Array.isArray(criteria) || criteria.some((c: unknown) => typeof c !== 'string' || !c.trim())) {
      failDecision('dispatch_brief_invalid', 'brief.criteria must be an array of nonempty strings; no criteria are discarded.');
    }
    brief = { goal, criteria: criteria.map((c: string) => c.trim()) };
  }

  // Test-only legacy `ruleDecider` path
  const actionsEvent = context.event.type === 'actions.run_failed';
  if (value.legacyKinds === true && !actionsEvent) {
    if (!ids.length) failDecision('dispatch_decision_invalid', 'create needs at least one option id.');
    return {
      decision: 'create',
      option_ids: ids,
      reason: reason.slice(0, 1000),
      brief,
      writes: Array.isArray(value.writes) ? value.writes.map(String) : null,
      model: typeof value.model === 'string' ? value.model : null,
      basis: value.basis ?? null,
      legacyKinds: true,
    };
  }

  // Domain event adapter options (`observe`, `notes`, `check`) keep their module hook binding
  const allEventOptions: (CreateOption | UnavailableWork)[] = [...context.options, ...context.unavailable];
  const domainMatches: CreateOption[] = [];
  for (const id of ids) {
    const found = context.options.find(o => (o.id === id || o.work === id) && (o.spec.type === 'event' || o.spec.type === 'request'));
    if (found) domainMatches.push(found);
  }
  if (domainMatches.length > 0 && domainMatches.length === ids.length) {
    let writes: string[] | null = null;
    if (value.writes !== undefined && value.writes !== null) {
      if (!Array.isArray(value.writes) || value.writes.some((w: unknown) => typeof w !== 'string')) {
        failDecision('dispatch_writes_invalid', 'writes must be an array of write ids.');
      }
      writes = value.writes.map((w: string) => (w === 'issue' ? 'github' : w));
    }
    return {
      decision: 'create',
      option_ids: domainMatches.map((o: CreateOption) => o.id),
      reason: reason.slice(0, 1000),
      brief,
      writes,
      model: typeof value.model === 'string' ? value.model : null,
    };
  }

  // When a single domain option exists, retain its hook binding for a create without explicit work.
  const singleDomain = !ids.length && context.options.length === 1 && (context.options[0]!.spec.type === 'event' || context.options[0]!.spec.type === 'request')
    ? context.options[0]
    : undefined;
  if (singleDomain && !context.event.object_number) {
    return {
      decision: 'create',
      option_ids: [singleDomain.id],
      role: typeof value.role === 'string' ? value.role : null,
      writes: Array.isArray(value.writes) ? value.writes.map(String) : null,
      reason: reason.slice(0, 1000),
      brief,
      model: typeof value.model === 'string' ? value.model : null,
    };
  }

  // Generic `task.request` creation: resolve role, writes, target
  let role: string | null = typeof value.role === 'string' && value.role.trim() ? value.role.trim() : null;
  let writes: string[] | null = null;
  if (value.writes !== undefined && value.writes !== null) {
    if (!Array.isArray(value.writes) || value.writes.some((w: unknown) => typeof w !== 'string')) {
      failDecision('dispatch_writes_invalid', 'writes must be an array of write ids.');
    }
    // Map legacy write aliases ('reply' -> 'review'/'github', 'labels' -> 'review', 'issue' -> 'github') cleanly
    const mapped = new Set<string>();
    for (const rawWrite of value.writes as string[]) {
      if (allowedGenericWrites.has(rawWrite)) mapped.add(rawWrite);
      else if (rawWrite === 'reply' || rawWrite === 'labels') mapped.add(ids.includes('reply') ? 'github' : 'review');
      else if (rawWrite === 'issue') mapped.add('github');
      else failDecision('dispatch_writes_not_allowed', `Unsupported task write "${rawWrite}". Use pull_request, review, github, or actions_rerun.`);
    }
    writes = [...mapped];
  }

  if (ids.length > 0) {
    // Support legacy `work` shorthand array (`['review']`, `['reply']`, `['development']`, or role names)
    const combinedWrites = new Set<string>(writes ?? []);
    for (const id of ids) {
      if (actionsEvent && (id === 'analysis' || id === 'actions.failures')) {
        role ??= 'dev';
        continue;
      }
      const mapped = mapShorthandWork(id);
      if (mapped) {
        role ??= mapped.role;
        if (writes === null) for (const w of mapped.writes) combinedWrites.add(w);
        continue;
      }
      const matchingOption = allEventOptions.find((o: CreateOption | UnavailableWork) => o.id === id || o.work === id);
      if (matchingOption) {
        const optMapped = mapShorthandWork(matchingOption.work) ?? mapShorthandWork(matchingOption.id);
        if (optMapped) {
          role ??= optMapped.role;
          if (writes === null) for (const w of optMapped.writes) combinedWrites.add(w);
          continue;
        }
      }
      const roleMatch = roleConfiguration(store, String(context.event.repository_id)).roles.find(r => r.role_id === id && r.enabled && r.kind !== 'evaluator' && id !== 'coordinator');
      if (roleMatch) {
        role ??= roleMatch.role_id;
        continue;
      }
      failDecision('dispatch_decision_invalid', `Unknown work or role "${id}". Pass role (e.g. reviewer, dev, test) and writes.`);
    }
    writes = [...combinedWrites];
  } else {
    writes ??= role === 'reviewer' ? ['review'] : [];
  }

  if (role !== null) {
    const configRoles = roleConfiguration(store, String(context.event.repository_id)).roles;
    const found = configRoles.find(r => r.role_id === role);
    if (!found || found.kind === 'evaluator' || role === 'coordinator') {
      failDecision('dispatch_role_invalid', `Role "${role}" is not an available worker role in this project.`);
    }
  }

  let target: NormalizedTaskTarget | null = null;
  if (value.target !== undefined && value.target !== null) {
    try { target = normalizeTaskTarget(value.target) ?? null; }
    catch { failDecision('dispatch_target_invalid', 'target must be {type:"issue"|"pr",number} or {type:"branch"|"commit",ref}.'); }
  } else {
    target = defaultEventTarget(context);
  }

  // Developing an Issue requires an explicit brief (goal + criteria)
  const isIssueDev = writes.includes('pull_request') && target?.type === 'issue';
  if (isIssueDev && !brief) {
    failDecision('dispatch_brief_required', 'Developing an Issue requires a brief with goal and acceptance criteria.');
  }

  return {
    decision: 'create',
    option_ids: actionsEvent ? [] : ids,
    role,
    writes,
    target,
    reason: reason.slice(0, 1000),
    brief,
    model: typeof value.model === 'string' ? value.model : null,
    basis: value.basis ?? null,
    rule: value.rule ?? null,
  };
}

const log = (store: Store, taskId: string, value: Json) =>
  store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), taskId, JSON.stringify(value), new Date().toISOString());

/** Creates a generic `task.request` task from a Manager event decision. */
function createGenericDispatchedTask(store: Store, event: Row, checked: Decision, executor: string | null): string | null {
  const repo = String(event.repository_id);
  const target = checked.target ?? undefined;
  const writes = checked.writes ?? [];
  const uniqueSuffix = `${executor ?? 'team'}:${[...writes].sort().join(',')}:${target ? `${target.type}:${target.number ?? target.ref ?? ''}` : 'none'}`;
  const key = `${repo}:dispatch:${event.event_key}:${uniqueSuffix}`;
  if (store.get('SELECT 1 FROM tasks WHERE unique_key=?', key)) return null;

  const isReview = writes.includes('review') && !writes.includes('pull_request');
  const isPrDev = writes.includes('pull_request');
  const facts = (() => { try { return JSON.parse(String(event.facts || '{}')); } catch { return {}; } })();
  const rawOptions = (() => { try { return JSON.parse(String(event.options || '[]')) as CreateOption[]; } catch { return []; } })();
  const objectOption = rawOptions.find(o => (o.spec.type === 'object' || o.spec.type === 'reply') && (checked.option_ids.includes(o.id) || checked.option_ids.includes(o.work)))
    ?? rawOptions.find(o => o.spec.type === 'object' && (isReview ? o.spec.kind.startsWith('review.') : isPrDev ? o.spec.kind.startsWith('development.') : true))
    ?? rawOptions.find(o => o.spec.type === 'object' || o.spec.type === 'reply');
  const webhookPayload = objectOption && 'input' in objectOption.spec && typeof objectOption.spec.input === 'object' && objectOption.spec.input
    ? (objectOption.spec.input as Record<string, unknown>)
    : {};

  const objectNumber = target && (target.type === 'issue' || target.type === 'pr') ? target.number ?? null : (event.object_number != null ? Number(event.object_number) : null);
  const headSha = (target?.type === 'pr' || target?.type === 'commit') && target.ref && /^[a-f0-9]{40}$/.test(target.ref)
    ? target.ref
    : typeof facts?.object?.head === 'string' && /^[a-f0-9]{40}$/.test(facts.object.head)
      ? facts.object.head
      : null;
  const defaultGoal = isReview
    ? `Review ${target?.type === 'pr' ? `PR #${objectNumber}` : `Issue #${objectNumber}`}: ${String(facts?.object?.title || event.summary).slice(0, 300)}`
    : isPrDev
      ? `${target?.type === 'pr' ? `Revise bot PR #${objectNumber}` : `Implement Issue #${objectNumber}`}: ${String(facts?.object?.title || event.summary).slice(0, 300)}`
      : String(event.summary);
  const goal = checked.brief?.goal || defaultGoal;
  const criteria = checked.brief?.criteria?.length
    ? checked.brief.criteria
    : isReview
      ? ['Inspect the actual repository diff and discussion context, then publish a grounded review via post_review.']
      : isPrDev
        ? ['Implement the requested change, pass project verification, and deliver via open_pull_request.']
        : ['Complete the requested analysis with verifiable repository evidence and deliver via submit_report.'];
  const endpoint = isPrDev ? 'reviewable_pull_request' : isReview ? 'review' : 'report';
  const contract = {
    goal,
    scope: [goal.slice(0, 2000)],
    criteria,
    endpoint,
    source: { type: 'dispatch', event_id: String(event.id), ...(objectNumber ? { object_number: objectNumber } : {}) },
    completeness: 'explicit' as const,
  };
  const manager = {
    event_id: event.id,
    reason: checked.reason,
    ...(checked.brief ? { brief: checked.brief } : {}),
    ...(writes.length ? { writes } : {}),
  };

  // Capture any bot PR revision requests from the event options so `bot_pr_requests` stays accurate (#1104)
  const devPrOption = rawOptions.find(o => o.spec.type === 'object' && o.spec.kind === 'development.pr');
  const revisionRequests = isPrDev && target?.type === 'pr' && devPrOption?.spec.type === 'object' && Array.isArray(devPrOption.spec.requests)
    ? devPrOption.spec.requests
    : undefined;

  const id = randomId(), now = new Date().toISOString();
  const savedInput = {
    ...webhookPayload,
    ...(event.type === 'actions.run_failed' ? {
      run_id: facts.run?.id,
      actions_failure: { attempt: facts.run?.attempt, head_sha: facts.run?.head_sha },
      context_files: { 'run.json': JSON.stringify({ run: facts.run, failed_jobs: facts.failed_jobs }, null, 2) },
    } : {}),
    generic: true,
    delivery: null,
    request: goal,
    contract,
    manager,
    ...(target ? { target } : {}),
    ...(executor ? { executor_role: executor } : {}),
    ...(revisionRequests?.length ? { revision: { source: 'request', requests: revisionRequests }, revision_requests: revisionRequests } : {}),
  };

  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,source_delivery_id,created_at,updated_at)
     VALUES(?,?,'task.request','queued',?,?,?,?,?,?,?,?)`,
    id, repo, goal.slice(0, 160), key, JSON.stringify(savedInput), objectNumber, headSha, event.delivery_id ?? null, now, now,
  );
  new TaskRecords(store).contract(id, contract as any);
  store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ ...savedInput, contract: new TaskRecords(store).get(id).contract }), id);
  setGrant(store, { id, repository_id: repo }, writes, 'role:manager', null);
  captureTaskConfiguration(store, id);
  if (revisionRequests?.length && objectNumber) {
    for (const r of revisionRequests as any[]) {
      store.run(
        `INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(repository_id,number,source_type,source_id) DO UPDATE SET state='done',task_id=excluded.task_id`,
        repo, objectNumber, r.type, r.id, r.author, r.author_id, r.author_type, r.url, 'done', id, now,
      );
    }
  }
  log(store, id, { type: 'queued', repository_id: repo, detail: `排队中，等待仓库 ${repo} 的虚拟电脑空闲…` });
  return id;
}

/** Creates one domain-adapter or legacy-fixture option's task. */
function createOptionTask(store: Store, event: Row, option: CreateOption, decision: Decision): string | null {
  const manager = {
    event_id: event.id,
    reason: decision.reason,
    ...(decision.brief ? { brief: decision.brief } : {}),
    ...(decision.writes ? { writes: decision.writes } : {}),
  };
  const spec = option.spec, repo = String(event.repository_id);
  if (spec.type === 'object') {
    let input: any = { ...(spec.input as any), manager };
    if (spec.kind.startsWith('review.')) {
      const publishing = store.get(`SELECT id FROM tasks WHERE repository_id=? AND kind=? AND object_number=? AND publication_started=1 AND status IN (${activeStates.map(() => '?').join(',')}) LIMIT 1`,
        repo, spec.kind, spec.number, ...activeStates);
      if (publishing && (spec.comment_id || spec.update_id)) input = { ...input, wait_for_review: publishing.id };
    }
    const id = enqueue(store, repo, spec.kind, spec.number, spec.head, input, spec.delivery, spec.source_task ?? null, spec.comment_id ?? null, spec.update_id ?? null);
    if (id && spec.kind === 'development.pr' && spec.requests?.length) {
      const now = new Date().toISOString();
      for (const r of spec.requests as any[]) {
        store.run(`INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,number,source_type,source_id)
          DO UPDATE SET state='done',task_id=excluded.task_id`, repo, spec.number, r.type, r.id, r.author, r.author_id, r.author_type, r.url, 'done', id, now);
      }
    }
    return id;
  }
  if (spec.type === 'reply') {
    const key = `${repo}:reply:${spec.number}:${spec.key}`;
    if (store.get('SELECT 1 FROM tasks WHERE unique_key=?', key)) return null;
    const id = randomId(), now = new Date().toISOString();
    store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,source_delivery_id,created_at,updated_at)
      VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?)`, id, repo, spec.kind, `${legacyKindName('reply') ?? '通用回复'} #${spec.number}`, key, JSON.stringify({ ...(spec.input as any), manager }), spec.number, spec.head, spec.delivery, now, now);
    captureTaskConfiguration(store, id);
    log(store, id, { type: 'queued', repository_id: repo, detail: `排队中，等待仓库 ${repo} 的虚拟电脑空闲…` });
    return id;
  }
  if (spec.type === 'generic') return null;
  if (spec.type === 'event') {
    return String(enqueueEventTask(store, repo, spec.kind, spec.key, spec.sha, { ...(spec.input as any), manager }, spec.summary).id);
  }
  const key = `${repo}:task.request:${spec.key}`;
  if (store.get('SELECT 1 FROM tasks WHERE unique_key=?', key)) return null;
  const file_issues = spec.file_issues === true ? true : spec.file_issues === false ? false : undefined;
  const issueFlag = file_issues !== undefined ? { file_issues } : {};
  const goal = decision.brief?.goal || spec.request;
  const contract = {
    goal,
    scope: [spec.request.slice(0, 2000)],
    criteria: decision.brief?.criteria?.length ? decision.brief.criteria : scheduledCheckCriteria(file_issues),
    endpoint: 'report',
    source: { type: 'schedule', event_id: event.id, ...issueFlag },
    completeness: 'explicit',
  };
  const id = randomId(), now = new Date().toISOString();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,created_at,updated_at) VALUES(?,?,'task.request','queued',?,?,?,?,?)",
    id, repo, goal.slice(0, 160), key, JSON.stringify({ request: spec.request, contract, manager, ...issueFlag }), now, now);
  new TaskRecords(store).contract(id, contract as any);
  store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ request: spec.request, contract: new TaskRecords(store).get(id).contract, manager, ...issueFlag }), id);
  captureTaskConfiguration(store, id);
  if (spec.principal) store.run('INSERT INTO task_authorizations VALUES(?,?,?,?,?)', id, spec.principal.principal_id, spec.principal.tenant_id, repo, 'tasks.write');
  return id;
}

function join(store: Store, event: Row, taskId: string, decision: Decision) {
  const merge = JSON.parse(event.merge), task = store.get('SELECT * FROM tasks WHERE id=?', taskId)!;
  const inserted = store.run('INSERT OR IGNORE INTO review_updates(task_id,event_key,data) VALUES(?,?,?)', taskId, merge.key, JSON.stringify({ ...merge.data, at: event.created_at ?? new Date().toISOString() }));
  if (inserted.changes) {
    const input = JSON.parse(task.input || '{}');
    const isDevWithPr = task.kind === 'development.pr' || task.kind === 'development.issue' || (task.kind === 'task.request' && (input.target?.type === 'pr' || input.target?.type === 'issue') && taskPermissions(store, task).writes.includes('pull_request'));
    const request = isDevWithPr ? merge.data?.revision_request : null, known = (input.revision?.requests || []) as any[];
    const revision = request && !known.some(r => r.type === request.type && String(r.id) === String(request.id))
      ? { revision: { ...(input.revision || {}), source: input.revision?.source || 'request', requests: [...known, request] } }
      : {};
    const pushedHead = typeof merge.head === 'string' && /^[a-f0-9]{40}$/.test(merge.head) ? merge.head : null;
    const headMove = task.kind === 'task.request' && input.target?.type === 'pr' && pushedHead && pushedHead !== task.head_sha
      ? { move_to_sha: pushedHead, target: { ...input.target, ref: pushedHead } }
      : {};
    store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ ...input, ...revision, ...headMove, merged_updates: [...(input.merged_updates || []), merge.trigger] }), taskId);
    if (request) {
      const prNumber = event.object_type === 'pr' && event.object_number ? Number(event.object_number) : Number(task.object_number);
      store.run(`INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,number,source_type,source_id)
        DO UPDATE SET state='done',task_id=excluded.task_id`, task.repository_id, prNumber, request.type, request.id, request.author, request.author_id,
        request.author_type, request.url, 'done', taskId, new Date().toISOString());
    }
  }
  log(store, taskId, { type: 'dispatch', relation: 'continued', event_id: event.id, event_type: event.type, reason: decision.reason, detail: `Manager 把事件「${event.summary}」续接到这个任务：${decision.reason}` });
  if (task.status === 'succeeded') continueFinishedReview(store, taskId);
  const facts = JSON.parse(String(event.facts || '{}'));
  const isIssueDev = task.kind === 'development.issue' || (task.kind === 'task.request' && JSON.parse(task.input || '{}')?.target?.type === 'issue');
  if (isIssueDev && task.status === 'waiting_permission' && task.error_code === 'development_not_approved' && event.type === 'issue.labeled' && facts.development?.label
    && store.run("UPDATE tasks SET status='queued',error_code=NULL,next_run_at=0,retry_count=0,wait_count=0,retry_error_code=NULL,retry_cycle_started_at=NULL WHERE id=? AND status='waiting_permission'", taskId).changes) {
    log(store, taskId, { type: 'resumed', reason: 'development_label_added', event_id: event.id, detail: `开发标签重新加上（${String(facts.label ?? facts.development.label)}），Manager 续接，开发继续。` });
  }
}

export function applyDecision(store: Store, event: Row, decision: Decision, lease: string | null): { created: string[]; continued: string[] } {
  try {
    return store.transaction(() => {
      const current = store.get('SELECT * FROM dispatch_events WHERE id=?', event.id);
      if (!current || (lease ? current.state !== 'dispatching' || current.lease !== lease : current.state !== 'pending')) {
        throw new InvalidDecision('dispatch_lease_lost', 'The event was decided or claimed elsewhere.');
      }
      const context = dispatchContext(store, current), checked = checkDecision(store, context, decision);
      if (decision.seen && context.continuations.some(option => !decision.seen!.includes(option.id))) {
        throw new InvalidDecision('dispatch_context_changed', 'A task the event could join appeared after the decision.');
      }
      const options = JSON.parse(current.options) as CreateOption[];
      const created: string[] = [], continued: string[] = [], declined: string[] = [], now = new Date().toISOString();
      const caller = checked.decision === 'ignore' ? null : eventTaskCaller(store, String(current.repository_id), String(current.id));

      if (checked.decision === 'create') {
        const domainOptions = checked.option_ids
          .map(id => options.find(entry => entry.id === id && (checked.legacyKinds || entry.spec.type === 'event' || entry.spec.type === 'request')))
          .filter((entry): entry is CreateOption => !!entry);

        if (domainOptions.length > 0 && domainOptions.length === checked.option_ids.length) {
          for (const option of domainOptions) {
            const refused = managerRefusal(store, context, option.id);
            if (refused) { recordRefusal(store, String(current.id), refused); declined.push(option.id); continue; }
            const development = option.spec.type === 'object' && option.spec.kind === 'development.issue';
            const basis = development ? decision.basis ?? ownIssue(store, String(current.repository_id), Number((option.spec as any).number)) : null;
            if (development && !basis) {
              recordRefusal(store, String(current.id), { work: option.work, code: 'development_basis_required', reason: '开发这个 Issue 需要依据（开发标签、维护者的要求或 Manager 提示词里的规则），这次决定没有给出。' });
              declined.push(option.id);
              continue;
            }
            const requestedExecutor = option.spec.type === 'request' ? undefined : (checked.role ?? 'dev');
            const task = createManagedTask(store, caller!, requestedExecutor, () => createOptionTask(store, current, option, checked));
            if (!task) { declined.push(option.id); continue; }
            if (basis) recordBasis(store, task, basis);
            created.push(task);
            store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', task, current.id, 'created', now);
            log(store, task, { type: 'dispatch', relation: 'created', event_id: current.id, event_type: current.type, reason: checked.reason, detail: `Manager 因事件「${current.summary}」新建这个任务：${checked.reason}` });
            if (option.hook) hooks.get(option.hook)?.created(store, store.get('SELECT * FROM tasks WHERE id=?', task)!, option.ref ?? null, current);
          }
        } else {
          // Generic `task.request` creation (#1122)
          const writes = checked.writes ?? [];
          const refused = genericRefusal(store, context, checked.role, writes, checked.target);
          if (refused) {
            recordRefusal(store, String(current.id), refused);
            declined.push(checked.role ?? 'task.request');
          } else {
            const isIssueDev = writes.includes('pull_request') && checked.target?.type === 'issue' && !!checked.target.number;
            const basis = isIssueDev ? decision.basis ?? ownIssue(store, String(current.repository_id), Number(checked.target!.number)) : null;
            if (isIssueDev && !basis) {
              recordRefusal(store, String(current.id), { work: 'pull_request', code: 'development_basis_required', reason: '开发这个 Issue 需要依据（开发标签、维护者的要求或 Manager 提示词里的规则），这次决定没有给出。' });
              declined.push('pull_request');
            } else {
              const requestedExecutor = checked.role === null ? undefined : checked.role;
              const task = createManagedTask(store, caller!, requestedExecutor, executor => {
                const effectiveExecutor = checked.role === null ? null : executor;
                return createGenericDispatchedTask(store, current, checked, effectiveExecutor);
              });
              if (task) {
                if (checked.role === null) store.run('UPDATE task_origins SET executor_role=NULL WHERE task_id=?', task);
                if (basis) recordBasis(store, task, basis);
                created.push(task);
                store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', task, current.id, 'created', now);
                log(store, task, { type: 'dispatch', relation: 'created', event_id: current.id, event_type: current.type, role: checked.role ?? null, writes, reason: checked.reason, detail: `Manager 因事件「${current.summary}」新建任务（${checked.role ?? 'team'}）：${checked.reason}` });
              } else {
                declined.push(checked.option_ids[0] ?? checked.role ?? 'task.request');
              }
            }
          }
        }
      }

      if (checked.decision === 'continue') {
        const target = context.continuations.find(option => option.id === checked.option_ids[0])!;
        assertManagedTask(store, caller!, target.task_id, true);
        join(store, current, target.task_id, checked);
        continued.push(target.task_id);
        store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', target.task_id, current.id, 'continued', now);
      }

      for (const option of options) {
        if (option.hook && (!checked.option_ids.includes(option.id) || declined.includes(option.id))) {
          hooks.get(option.hook)?.declined(store, current, checked.decision === 'ignore' ? checked.reason : declined.includes(option.id) ? 'option_refused' : checked.reason, option.ref ?? null);
        }
      }

      store.run(
        `UPDATE dispatch_events SET state='decided',decision=?,reason=?,brief=?,result=?,model=?,rule=?,lease=NULL,lease_until=NULL,error=NULL,decided_at=? WHERE id=?`,
        checked.decision,
        checked.reason,
        checked.brief ? JSON.stringify(checked.brief) : null,
        JSON.stringify({ created, continued, declined, ...(checked.role ? { role: checked.role } : {}), ...(checked.writes ? { writes: checked.writes } : {}) }),
        checked.model ?? decision.model ?? null,
        decision.rule ? JSON.stringify(decision.rule) : null,
        now,
        current.id,
      );
      appendDispatchThread(store, current, { ...checked, rule: decision.rule ?? checked.rule ?? null }, created, continued, now);
      return { created, continued };
    });
  } catch (error) {
    if (error instanceof HttpError) throw new TaskError(error.code, 'waiting_configuration');
    throw error;
  }
}

export function taskDispatch(store: Store, taskId: string) {
  return store.all(
    `SELECT e.id,e.type,e.summary,e.decision,e.reason,e.brief,e.decided_at,e.created_at,e.thread_key,te.relation
     FROM task_events te JOIN dispatch_events e ON e.id=te.event_id
     WHERE te.task_id=? ORDER BY e.created_at,e.id`,
    taskId,
  ).map(row => ({
    event_id: row.id,
    type: row.type,
    summary: row.summary,
    relation: row.relation,
    decision: row.decision,
    reason: row.reason,
    brief: row.brief ? JSON.parse(row.brief) : null,
    thread_key: row.thread_key ?? null,
    created_at: row.created_at,
    decided_at: row.decided_at,
  }));
}

export function pruneDispatchFailures(store: Store, repositoryId: string, before: string, limit = 500) {
  return Number(
    store.run(
      'DELETE FROM dispatch_failures WHERE rowid IN (SELECT f.rowid FROM dispatch_failures f JOIN dispatch_events e ON e.id=f.event_id WHERE e.repository_id=? AND f.created_at<? ORDER BY f.created_at LIMIT ?)',
      repositoryId,
      before,
      limit,
    ).changes,
  );
}

export function pruneDispatchThreads(store: Store, repositoryId: string, before: string, limit = 500) {
  if (!store.hasTable('dispatch_threads')) return 0;
  const activeMarks = activeStates.map(() => '?').join(',');
  return Number(
    store.run(
      `DELETE FROM dispatch_threads WHERE rowid IN (
        SELECT dt.rowid FROM dispatch_threads dt
        WHERE dt.repository_id=? AND dt.updated_at<?
          AND NOT EXISTS (SELECT 1 FROM dispatch_events e WHERE e.repository_id=dt.repository_id AND e.thread_key=dt.thread_key AND e.state IN ('pending','dispatching'))
          AND (dt.active_task_id IS NULL OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=dt.active_task_id AND t.status IN (${activeMarks},'waiting_pr_head')))
          AND (dt.object_number IS NULL OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.repository_id=dt.repository_id AND t.object_number=dt.object_number AND t.status IN (${activeMarks},'waiting_pr_head')))
        ORDER BY dt.updated_at LIMIT ?
      )`,
      repositoryId,
      before,
      ...activeStates,
      ...activeStates,
      limit,
    ).changes,
  );
}
