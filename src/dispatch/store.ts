import type { Store, Row } from '../storage/database.js';
import { randomId, HttpError, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { captureTaskConfiguration } from '../tasks/configuration.js';
import { TaskRecords } from '../tasks/service.js';
import { enqueue, enqueueRefusal } from '../review/queue.js';
import { continueFinishedReview } from '../review/continuation.js';
import { enqueueEventTask } from '../work/events.js';
import { workOffered, workPermissions, workRefusal } from '../work/settings.js';
import { narrowWrites, workType } from '../work/catalog.js';
import { assertManagedTask, assertTaskCaller, createManagedTask, eventTaskCaller } from '../tasks/management.js';
import { ownIssue, recordBasis, type Basis } from './basis.js';
import { scheduledCheckCriteria } from '../tasks/schedule-write.js';

/**
 * Manager dispatch. Every event that passes the control plane's filters is written here once (event_key is unique) with
 * what the control plane allows for it: the tasks it may create (create options, each a complete, deterministic task
 * spec) and how it joins a running task (merge). The Manager then decides once: create, continue one offered task, or
 * ignore, always with a reason. The decision is applied in one transaction with the event's new state, so a restart can
 * decide again without creating anything twice: task specs carry unique keys and continuations are keyed by event.
 *
 * Modules that own an event (releases, Actions failures, schedules) name a hook on their option; the hook
 * hears in the same transaction that the task was created, or that the Manager decided otherwise.
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
    CREATE TABLE IF NOT EXISTS dispatch_retries(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES dispatch_events(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL,previous_attempts INTEGER NOT NULL,previous_error TEXT);
    CREATE INDEX IF NOT EXISTS dispatch_retries_event ON dispatch_retries(event_id);
    CREATE TABLE IF NOT EXISTS dispatch_failures(event_id TEXT NOT NULL REFERENCES dispatch_events(id) ON DELETE CASCADE,attempt INTEGER NOT NULL,created_at TEXT NOT NULL,error TEXT NOT NULL,next_run_at INTEGER NOT NULL,report INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,attempt)); CREATE INDEX IF NOT EXISTS dispatch_failures_created ON dispatch_failures(created_at);
    CREATE TABLE IF NOT EXISTS task_events(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,event_id TEXT NOT NULL,relation TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(task_id,event_id));
    CREATE INDEX IF NOT EXISTS task_events_event ON task_events(event_id);
  `);
  // #815: what the control plane refused when the Manager tried to create work for the event, in order.
  if (!store.all('PRAGMA table_info(dispatch_events)').some(column => column.name === 'refusals')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN refusals TEXT');
  // The standing rule (id and revision) that decided the event without a model call (#815).
  if (!store.all('PRAGMA table_info(dispatch_events)').some(column => column.name === 'rule')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN rule TEXT');
  // 1 once the event's attempts ran out and it went back to the Manager for one more round to answer the person (#815).
  if (!store.all('PRAGMA table_info(dispatch_events)').some(column => column.name === 'answer_round')) store.db.exec('ALTER TABLE dispatch_events ADD COLUMN answer_round INTEGER NOT NULL DEFAULT 0');
}

/** Same-project recovery facts for the next Manager call and existing event-detail query. */
export function dispatchRecovery(store:Store,repositoryId:string,eventId:string,beforeAttempt=Number.MAX_SAFE_INTEGER){
 const event=store.get('SELECT id,answer_round,error,attempts FROM dispatch_events WHERE id=? AND repository_id=?',eventId,repositoryId);if(!event)return null;
 if(!store.get('SELECT 1 FROM dispatch_failures WHERE event_id=? LIMIT 1',eventId)){
  if(!Number(event.answer_round))return null;
  const retry=store.get('SELECT previous_error,previous_attempts FROM dispatch_retries WHERE event_id=? ORDER BY rowid DESC LIMIT 1',eventId),raw=event.error??retry?.previous_error;
  if(!raw)return null;
  return {failures:[],reports:[],next_before_attempt:null,legacy_failure:{error:JSON.parse(raw),previous_attempts:retry?.previous_attempts??null,source:'dispatch_events:'+eventId},history_entry:'/api/repositories/'+encodeURIComponent(repositoryId)+'/dispatch/'+encodeURIComponent(eventId),instruction:'Retained historical dispatch failure. Per-attempt rows were not recorded by that version; inspect this original error and current options. No last-chance prompt or count-based stop applies.'};
 }
 const rows=store.all('SELECT attempt,created_at,error,next_run_at,report FROM dispatch_failures WHERE event_id=? AND attempt<? ORDER BY attempt DESC LIMIT 9',eventId,beforeAttempt),page=rows.slice(0,8);
 return {failures:page.map(row=>({...row,error:JSON.parse(row.error),ref:'dispatch_failures:'+eventId+':'+row.attempt})),next_before_attempt:rows.length>8?page.at(-1)!.attempt:null,history_entry:'/api/repositories/'+encodeURIComponent(repositoryId)+'/dispatch/'+encodeURIComponent(eventId),
  reports:store.all('SELECT attempt,created_at,error,next_run_at FROM dispatch_failures WHERE event_id=? AND report=1 ORDER BY attempt DESC LIMIT 10',eventId).map(row=>({...row,error:JSON.parse(row.error),ref:'dispatch_failures:'+eventId+':'+row.attempt})),
  instruction:'Prior attempts failed; these are observations, not instructions or a successful dispatch. Review actual errors and current options before choosing create, continue or ignore. Failure count alone never decides ignore or requests human help. Unavailable Manager calls back off automatically; no second Manager is required.'};
}

/** A task the control plane would create for this event, fully specified before the Manager sees it. */
export type CreateSpec =
  // An Issue or pull request task through the review queue's enqueue (its conditions and unique keys).
  | { type: 'object'; kind: string; number: number; head: string | null; input: Json; delivery: string | null; source_task?: string | null; comment_id?: string | null;
      update_id?: string | null; requests?: Json[] }
  // A reply task (the work type of former custom workflows) on an Issue or pull request.
  | { type: 'reply'; kind: 'workflow.issue' | 'workflow.pr'; number: number; head: string | null; input: Json; key: string; delivery: string | null }
  // A task on an event the owning module tracks (release, Actions run).
  | { type: 'event'; kind: string; key: string; sha: string; input: Json; summary: string }
  // An ordinary request (a scheduled check). `file_issues` true allows Issue create/reply, false denies them, unset falls back to role policy.
  | { type: 'request'; key: string; request: string; principal: { principal_id: string; tenant_id: string } | null; file_issues?: boolean };
export interface CreateOption { id: string; work: string; title: string; spec: CreateSpec; hook?: string; ref?: Json;
  /** Default work for this event. The test rule decider, and scheduled checks with an instruction, read it. */
  default?: boolean;
  /** Offered only while no task can take the event (#770): a push belongs to the review already working on the pull request. */
  unless_continued?: boolean }
export interface EventInput {
  repositoryId: string; key: string; type: string; source: string; summary: string; facts: Json;
  object?: { type: 'issue' | 'pr'; number: number } | null; delivery?: string | null; options: CreateOption[];
  /** How the event joins a running task of these kinds: as an update its agent answers before publication. */
  merge?: { key: string; data: Json; trigger: Json; head?: string | null; kinds: string[] } | null;
}
export interface ContinueOption { id: string; task_id: string; kind: string; status: string; summary: string; created_at: string }
export interface Decision { decision: 'create' | 'continue' | 'ignore'; option_ids: string[]; reason: string; brief?: { goal: string; criteria: string[] } | null; writes?: string[] | null; model?: string | null;
  /** The checked basis of a development of an Issue the bot did not open (#815), kept with the task. */
  basis?: Basis | null;
  /** The standing rule that made this decision without a model call (#815). */
  rule?: { id: string; revision: number } | null;
  /** The continue options the decision was made with; a running task that appeared since means deciding again. */
  seen?: string[] }
/** Work the event has an object for, but that the project does not allow now (#815): shown to the Manager with the reason. */
export interface UnavailableWork { id: string; work: string; title: string; code: string; reason: string }
export interface DispatchContext { event: Row; facts: Json; options: CreateOption[]; unavailable: UnavailableWork[]; continuations: ContinueOption[]; related: Json[] }
/** Why the control plane refused to create work the Manager chose (#815); kept on the event and returned to the Manager. */
export interface Refusal { work: string; code: string; reason: string; task_id?: string }

/** Module hooks: told in the deciding transaction what became of their option. */
export interface DispatchHook { created(store: Store, task: Row, ref: Json | null, event: Row): void; declined(store: Store, event: Row, reason: string, ref: Json | null): void }
const hooks = new Map<string, DispatchHook>();
export const registerDispatchHook = (name: string, hook: DispatchHook) => { hooks.set(name, hook); };
export const dispatchHook = (name: string) => hooks.get(name);

// Tests (and only tests) may decide synchronously, at the moment an event is written; production always asks the Manager.
type SyncDecider = (context: DispatchContext) => Decision;
let immediate: SyncDecider | null = null;
export const decideImmediately = (decider: SyncDecider | null) => { immediate = decider; };
/** Wakes the dispatcher when an event is written (set by the running Dispatcher). */
let wake: (() => void) | null = null;
export const onDispatchEvent = (callback: (() => void) | null) => { wake = callback; };

const activeStates = ['queued', 'retry_wait', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'running', 'preparing', 'publishing', 'result_ready'];

/**
 * Writes an event once. Returns the number of tasks created when tests decide immediately, otherwise 1 for a new event
 * and 0 for one already written. An event with nothing to offer never reaches the Manager.
 */
export function recordEvent(store: Store, input: EventInput): number {
  // Every work the event has an object for is kept: what the project does not allow now is shown with its reason (#815).
  const options = input.options, offered = options.filter(option => workOffered(store, input.repositoryId, option.work, input.type));
  if (!offered.length && !(input.merge && continuations(store, { repository_id: input.repositoryId, object_number: input.object?.number ?? null, merge: JSON.stringify(input.merge) }).length)) {
    // Modules still hear that nothing will run for their event, and the event keeps why (#815).
    for (const option of input.options) if (option.hook) hooks.get(option.hook)?.declined(store, { repository_id: input.repositoryId, type: input.type }, 'work_inactive', option.ref ?? null);
    const reasons = options.map(option => workRefusal(store, input.repositoryId, option.work, input.type)?.reason).filter(Boolean);
    recordFiltered(store, { ...input, code: 'work_inactive', reason: reasons.length ? [...new Set(reasons)].join(' ') : '这个事件没有项目允许的工作，也没有可以续接的任务。' });
    return 0;
  }
  const id = randomId(), now = new Date().toISOString();
  const inserted = store.run(`INSERT OR IGNORE INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,delivery_id,summary,facts,options,merge,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.repositoryId, input.key, input.type, input.source, input.object?.type ?? null, input.object?.number ?? null, input.delivery ?? null,
    input.summary.slice(0, 300), JSON.stringify(input.facts), JSON.stringify(options), input.merge ? JSON.stringify(input.merge) : null, now);
  if (!inserted.changes) return 0;
  if (immediate) {
    const event = store.get('SELECT * FROM dispatch_events WHERE id=?', id)!;
    return applyDecision(store, event, immediate(dispatchContext(store, event)), null).created.length;
  }
  queueMicrotask(() => wake?.());
  return 1;
}

/**
 * Tasks the event may join: on the same object, of a kind that answers updates (#770). A running or waiting task takes it
 * as an update, a new pull request head included (the task moves to it instead of being replaced); one that is publishing
 * finishes that publication first. The event's first kind comes first (an Issue edit: its development, #815); of the
 * running ones only the most recently claimed counts (older runs are about to be replaced), then the waiting ones. With none of them, the object's last finished review takes it as its next round.
 */
export function continuations(store: Store, event: Record<string, any>): ContinueOption[] {
  const merge = event.merge ? JSON.parse(String(event.merge)) : null;
  if (!merge?.kinds?.length || !event.object_number) return [];
  const kinds = merge.kinds.map(() => '?').join(',');
  const active = store.all(`SELECT t.id,t.kind,t.status,t.summary,t.created_at FROM tasks t WHERE t.repository_id=? AND t.object_number=? AND t.kind IN (${kinds})
    AND t.status IN (${activeStates.map(() => '?').join(',')})
    ORDER BY CASE WHEN t.kind=? THEN 0 ELSE 1 END,CASE WHEN t.status IN ('running','preparing','publishing','result_ready') THEN 0 ELSE 1 END,(SELECT claimed_at FROM task_claims WHERE task_id=t.id) DESC,t.created_at DESC,t.rowid DESC`,
    String(event.repository_id), Number(event.object_number), ...merge.kinds, ...activeStates, merge.kinds[0]);
  const running = (task: Row) => ['running', 'preparing', 'publishing', 'result_ready'].includes(String(task.status));
  const latest = active.find(running);
  const joinable = [...(latest ? [latest] : []), ...active.filter(task => !running(task))].slice(0, 5);
  if (!joinable.length) {
    // The most recently finished review: its next round reopens its Pi session (#1040).
    const finished = store.get(`SELECT id,kind,status,summary,created_at FROM tasks t WHERE repository_id=? AND object_number=? AND kind IN (${kinds}) AND kind LIKE 'review.%'
      AND status='succeeded' ORDER BY updated_at DESC,rowid DESC LIMIT 1`,
      String(event.repository_id), Number(event.object_number), ...merge.kinds);
    if (finished) joinable.push(finished);
  }
  return joinable.map(task => ({ id: 'continue:' + task.id, task_id: String(task.id), kind: String(task.kind), status: String(task.status), summary: String(task.summary), created_at: String(task.created_at) }));
}
/** What the Manager reads: the event, the work it can create, the work the project does not allow now, and the tasks on the object. */
export function dispatchContext(store: Store, event: Row): DispatchContext {
  const joinable = continuations(store, event), options: CreateOption[] = [], unavailable: UnavailableWork[] = [];
  for (const option of JSON.parse(event.options) as CreateOption[]) {
    // A push belongs to the review already working on the pull request; it is not new work then.
    if (option.unless_continued && joinable.length) continue;
    const refusal = workRefusal(store, event.repository_id, option.work, event.type);
    if (refusal) unavailable.push({ id: option.id, work: option.work, title: option.title, ...refusal }); else options.push(option);
  }
  const related = event.object_number ? store.all(`SELECT id,kind,status,summary,error_code,created_at,updated_at,result FROM tasks WHERE repository_id=? AND object_number=?
    AND kind NOT IN ('release.observe','release.notes','actions.failures','task.request','task.development') ORDER BY created_at DESC,rowid DESC LIMIT 8`, event.repository_id, event.object_number).map(task => {
    let outcome: unknown = null; try { const result = JSON.parse(task.result || 'null'); outcome = result?.summary ? String(result.summary).slice(0, 300) : result?.pr_url ?? null; } catch { outcome = null; }
    return { id: task.id, kind: task.kind, status: task.status, summary: task.summary, error_code: task.error_code ?? null, created_at: task.created_at, outcome };
  }) : [];
  return { event, facts: JSON.parse(event.facts), options, unavailable, continuations: joinable, related };
}

/**
 * Why the control plane would not create the work `id` now (#815), null when it would: work the project does not allow,
 * work the event has no object for, or the task's own conditions (an active development of the object, a task already
 * created for the event). The same conditions decide the creation itself.
 */
export function optionRefusal(store: Store, context: DispatchContext, id: string): Refusal | null {
  const unavailable = context.unavailable.find(work => work.id === id);
  if (unavailable) return { work: unavailable.work, code: unavailable.code, reason: unavailable.reason };
  const option = context.options.find(entry => entry.id === id);
  if (!option) return { work: id, code: 'work_not_offered', reason: `这个事件没有可以新建的工作「${id}」。` };
  const spec = option.spec, repo = String(context.event.repository_id), refusal = (code: string, reason: string, task?: Row) => ({ work: option.work, code, reason, ...(task ? { task_id: String(task.id) } : {}) });
  if (spec.type === 'object') { const refused = enqueueRefusal(store, repo, spec.kind, spec.number, spec.head, spec.input, spec.comment_id ?? null, spec.update_id ?? null); return refused ? { work: option.work, ...refused } : null; }
  const key = spec.type === 'reply' ? `${repo}:reply:${spec.number}:${spec.key}` : spec.type === 'request' ? `${repo}:task.request:${spec.key}` : null;
  const existing = key ? store.get('SELECT id FROM tasks WHERE unique_key=?', key) : null;
  return existing ? refusal('task_already_created', '这个事件要建的任务已经建过了。', existing) : null;
}
/**
 * Outcomes the creation itself handles without refusing the Manager: a task the event already created (a decision taken
 * again after a restart). A revision that finds another one running is refused, so the Manager can continue that one (#1104).
 */
export const deferredRefusals = ['task_already_created'];
/** A refusal the Manager hears at create_task and the event keeps (#815); null also for deferred outcomes. */
export const managerRefusal = (store: Store, context: DispatchContext, id: string) => {
  const refusal = optionRefusal(store, context, id);
  return refusal && !deferredRefusals.includes(refusal.code) ? refusal : null;
};
/** Keeps a refusal on the event (the last 20), for the console and for the Manager's answer to the person. */
export function recordRefusal(store: Store, eventId: string, refusal: Refusal & { tool?: string }) {
  const row = store.get('SELECT refusals FROM dispatch_events WHERE id=?', eventId); if (!row) return;
  let list: Json[] = []; try { list = JSON.parse(String(row.refusals || '[]')); } catch { list = []; }
  store.run('UPDATE dispatch_events SET refusals=? WHERE id=?', JSON.stringify([...list, { ...refusal, at: new Date().toISOString() }].slice(-20)), eventId);
}

/**
 * An event the control plane's filters stopped before the Manager (#815): kept as a decided record with the reason, so the
 * console can say why nothing happened. Kept for filteredRetentionMs, then pruned; never dispatched.
 */
export function recordFiltered(store: Store, input: { repositoryId: string; key: string; type: string; source?: string; summary: string;
  object?: { type: 'issue' | 'pr'; number: number } | null; delivery?: string | null; facts?: Json; code: string; reason: string }) {
  const now = new Date().toISOString();
  store.run(`INSERT OR IGNORE INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,delivery_id,summary,facts,options,state,decision,reason,result,created_at,decided_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'[]','filtered','ignore',?,?,?,?)`, randomId(), input.repositoryId, input.key, input.type, input.source ?? 'github', input.object?.type ?? null,
    input.object?.number ?? null, input.delivery ?? null, input.summary.slice(0, 300), JSON.stringify(input.facts ?? {}), input.reason.slice(0, 1000), JSON.stringify({ filtered: input.code }), now, now);
}
export const filteredRetentionMs = 30 * 86400000;
/** Drops filtered records older than the retention (decided events are kept as before). */
export const pruneFiltered = (store: Store, now = Date.now()) =>
  store.run("DELETE FROM dispatch_events WHERE state='filtered' AND created_at<?", new Date(now - filteredRetentionMs).toISOString()).changes;

/** How long a dispatcher's claim on an event lasts; the Manager's turn renews it before every step. */
export const dispatchLeaseMs = 5 * 60000;
/** Extends a claim the caller still holds; false when the event was claimed again (or decided) meanwhile. */
export function renewDispatchLease(store: Store, event: Row): boolean {
  return store.run("UPDATE dispatch_events SET lease_until=? WHERE id=? AND lease=? AND state='dispatching'", Date.now() + dispatchLeaseMs, event.id, event.lease).changes > 0;
}
export class InvalidDecision extends Error { constructor(readonly code: string, message: string) { super(message); } }
/** A decision may only choose what was offered; the brief and writes are bounded, never widened. */
export function checkDecision(store: Store, context: DispatchContext, value: any): Decision {
  const fail = (code: string, message: string): never => { throw new InvalidDecision(code, message); };
  if (!value || typeof value !== 'object') fail('dispatch_decision_invalid', 'The decision must be an object.');
  const decision = value.decision, ids = Array.isArray(value.option_ids) ? value.option_ids.map(String) : null;
  if (!['create', 'continue', 'ignore'].includes(decision) || !ids) fail('dispatch_decision_invalid', 'decision must be create, continue or ignore, with option_ids.');
  if (decision !== 'ignore') {
    try { assertTaskCaller(store,eventTaskCaller(store,String(context.event.repository_id),String(context.event.id)),true); }
    catch (error) { if (error instanceof HttpError) throw new TaskError(error.code, 'waiting_configuration'); throw error; }
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason) fail('dispatch_reason_required', 'Give the reason for the decision.');
  if (new Set(ids).size !== ids.length) fail('dispatch_decision_invalid', 'option_ids repeat an option.');
  if (decision === 'ignore' && ids.length) fail('dispatch_decision_invalid', 'ignore takes no option_ids.');
  if (decision === 'create' && (!ids.length || ids.length > 3 || ids.some((id: string) => !context.options.some(option => option.id === id) && !context.unavailable.some(work => work.id === id))))
    fail('dispatch_option_not_offered', 'create needs one to three ids of the work this event can create.');
  if (decision === 'continue' && (ids.length !== 1 || !context.continuations.some(option => option.id === ids[0])))
    fail('dispatch_option_not_offered', 'continue needs exactly one id of the offered continue options.');
  let writes: string[] | null = null;
  if (value.writes !== undefined && value.writes !== null) {
    if (decision !== 'create' || !Array.isArray(value.writes) || value.writes.some((write: unknown) => typeof write !== 'string')) fail('dispatch_writes_invalid', 'writes narrows the writes of created tasks: a list of write ids.');
    const allowed = new Set([...context.options, ...context.unavailable].filter(option => ids.includes(option.id)).flatMap(option => workPermissions(store, context.event.repository_id, option.work).writes));
    writes = value.writes;
    if (writes!.some(write => !allowed.has(write))) fail('dispatch_writes_not_allowed', 'writes may only keep writes the project allows for these tasks.');
  }
  let brief: Decision['brief'] = null;
  if (value.brief !== undefined && value.brief !== null) {
    const goal = typeof value.brief?.goal === 'string' ? value.brief.goal.trim() : '', criteria = value.brief?.criteria ?? [];
    if (decision !== 'create' || !goal) fail('dispatch_brief_invalid', 'brief belongs to create and needs a goal.');
    if (!Array.isArray(criteria) || criteria.some((c: unknown) => typeof c !== 'string' || !c.trim())) fail('dispatch_brief_invalid', 'brief.criteria must be an array of nonempty strings; no criteria are discarded.');
    brief = { goal, criteria: criteria.map((c: string) => c.trim()) };
  }
  // An Issue development without a reviewed implementation goal works to the Manager's brief, so it needs one.
  const unscoped = decision === 'create' && context.options.some(option => ids.includes(option.id) && option.spec.type === 'object' && option.spec.kind === 'development.issue'
    && !String((option.spec.input as any)?.review?.implementation_goal || '').trim());
  if (unscoped && !brief) fail('dispatch_brief_required', 'Develop Issue has no reviewed implementation goal here: add a brief with the goal and the acceptance criteria.');
  return { decision, option_ids: ids, reason: reason.slice(0, 1000), brief, writes, model: typeof value.model === 'string' ? value.model : null };
}

const log = (store: Store, taskId: string, value: Json) => store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), taskId, JSON.stringify(value), new Date().toISOString());
/** Creates one option's task; null when its own conditions refuse it now (an active development, an existing key). */
function create(store: Store, event: Row, option: CreateOption, decision: Decision): string | null {
  const manager = { event_id: event.id, reason: decision.reason, ...(decision.brief ? { brief: decision.brief } : {}),
    ...(decision.writes ? { writes: narrowWrites(workPermissions(store, event.repository_id, option.work).writes, decision.writes, option.work) } : {}) };
  const spec = option.spec, repo = String(event.repository_id);
  if (spec.type === 'object') {
    let input: any = { ...(spec.input as any), manager };
    // A review that waits for the publishing review of the same object, as updates always did.
    if (spec.kind.startsWith('review.')) {
      const publishing = store.get(`SELECT id FROM tasks WHERE repository_id=? AND kind=? AND object_number=? AND publication_started=1 AND status IN (${activeStates.map(() => '?').join(',')}) LIMIT 1`,
        repo, spec.kind, spec.number, ...activeStates);
      if (publishing && (spec.comment_id || spec.update_id)) input = { ...input, wait_for_review: publishing.id };
    }
    const id = enqueue(store, repo, spec.kind, spec.number, spec.head, input, spec.delivery, spec.source_task ?? null, spec.comment_id ?? null, spec.update_id ?? null);
    // The requests a bot pull request revision carries (#1104): each comment revises once, and another review bot's count
    // feeds the loop guard (queue.ts otherBotLoop).
    if (id && spec.kind === 'development.pr' && spec.requests?.length) {
      const now = new Date().toISOString();
      for (const r of spec.requests as any[]) store.run(`INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,number,source_type,source_id)
        DO UPDATE SET state='done',task_id=excluded.task_id`, repo, spec.number, r.type, r.id, r.author, r.author_id, r.author_type, r.url, 'done', id, now);
    }
    return id;
  }
  if (spec.type === 'reply') {
    const key = `${repo}:reply:${spec.number}:${spec.key}`;
    if (store.get('SELECT 1 FROM tasks WHERE unique_key=?', key)) return null;
    const id = randomId(), now = new Date().toISOString();
    store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,source_delivery_id,created_at,updated_at)
      VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?)`, id, repo, spec.kind, `${workType('reply')!.name} #${spec.number}`, key, JSON.stringify({ ...(spec.input as any), manager }), spec.number, spec.head, spec.delivery, now, now);
    captureTaskConfiguration(store, id);
    log(store, id, { type: 'queued', repository_id: repo, detail: `排队中，等待仓库 ${repo} 的虚拟电脑空闲…` });
    return id;
  }
  if (spec.type === 'event') return String(enqueueEventTask(store, repo, spec.kind, spec.key, spec.sha, { ...(spec.input as any), manager }, spec.summary).id);
  // A scheduled check: the Manager's brief is the contract of an ordinary request; without a brief there is nothing to do.
  const key = `${repo}:task.request:${spec.key}`;
  if (store.get('SELECT 1 FROM tasks WHERE unique_key=?', key)) return null;
  const file_issues = spec.file_issues === true ? true : spec.file_issues === false ? false : undefined;
  const issueFlag = file_issues !== undefined ? { file_issues } : {};
  const goal = decision.brief?.goal || spec.request, contract = { goal, scope: [spec.request.slice(0, 2000)], criteria: decision.brief?.criteria?.length ? decision.brief.criteria : scheduledCheckCriteria(file_issues),
    endpoint: 'report', source: { type: 'schedule', event_id: event.id, ...issueFlag }, completeness: 'explicit' };
  const id = randomId(), now = new Date().toISOString();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,created_at,updated_at) VALUES(?,?,'task.request','queued',?,?,?,?,?)",
    id, repo, goal.slice(0, 160), key, JSON.stringify({ request: spec.request, contract, manager, ...issueFlag }), now, now);
  new TaskRecords(store).contract(id, contract as any);
  store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ request: spec.request, contract: new TaskRecords(store).get(id).contract, manager, ...issueFlag }), id);
  captureTaskConfiguration(store, id);
  if (spec.principal) store.run('INSERT INTO task_authorizations VALUES(?,?,?,?,?)', id, spec.principal.principal_id, spec.principal.tenant_id, repo, 'tasks.write');
  return id;
}
/**
 * Adds the event to a task: an update it answers at its next turn (or after the publication it is in), and a reference in
 * its facts. A finished review takes it as its next round (#770).
 */
function join(store: Store, event: Row, taskId: string, decision: Decision) {
  const merge = JSON.parse(event.merge), task = store.get('SELECT * FROM tasks WHERE id=?', taskId)!;
  // `at`: when the event came, which the Manager of a review reads with the update (#1100).
  const inserted = store.run('INSERT OR IGNORE INTO review_updates(task_id,event_key,data) VALUES(?,?,?)', taskId, merge.key, JSON.stringify({ ...merge.data, at: event.created_at ?? new Date().toISOString() }));
  if (inserted.changes) {
    const input = JSON.parse(task.input || '{}');
    store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ ...input, merged_updates: [...(input.merged_updates || []), merge.trigger] }), taskId);
  }
  log(store, taskId, { type: 'dispatch', relation: 'continued', event_id: event.id, event_type: event.type, reason: decision.reason, detail: `Manager 把事件「${event.summary}」续接到这个任务：${decision.reason}` });
  if (task.status === 'succeeded') continueFinishedReview(store, taskId);
  // A development that stopped because the development label was removed resumes when a person adds the label again and
  // the Manager continues it with that labeling (#815); the engine checks the label again before it publishes.
  const facts = JSON.parse(String(event.facts || '{}'));
  if (task.kind === 'development.issue' && task.status === 'waiting_permission' && task.error_code === 'development_not_approved' && event.type === 'issue.labeled' && facts.development?.label
    && store.run("UPDATE tasks SET status='queued',error_code=NULL,next_run_at=0,retry_count=0,wait_count=0,retry_error_code=NULL,retry_cycle_started_at=NULL WHERE id=? AND status='waiting_permission'", taskId).changes)
    log(store, taskId, { type: 'resumed', reason: 'development_label_added', event_id: event.id, detail: `开发标签重新加上（${String(facts.label ?? facts.development.label)}），Manager 续接，开发继续。` });
}

/**
 * Applies a decision in one transaction. `lease` fences the dispatcher's claim (null for the immediate test decider).
 * Throws InvalidDecision when a continuation target is no longer running: the event is decided again.
 */
export function applyDecision(store: Store, event: Row, decision: Decision, lease: string | null): { created: string[]; continued: string[] } {
  try { return store.transaction(() => {
    const current = store.get('SELECT * FROM dispatch_events WHERE id=?', event.id);
    if (!current || (lease ? current.state !== 'dispatching' || current.lease !== lease : current.state !== 'pending')) throw new InvalidDecision('dispatch_lease_lost', 'The event was decided or claimed elsewhere.');
    const context = dispatchContext(store, current), checked = checkDecision(store, context, decision);
    // A review that started meanwhile (another event of the object) changes the choice: create may now duplicate it.
    if (decision.seen && context.continuations.some(option => !decision.seen!.includes(option.id))) throw new InvalidDecision('dispatch_context_changed', 'A task the event could join appeared after the decision.');
    const options = JSON.parse(current.options) as CreateOption[], created: string[] = [], continued: string[] = [], declined: string[] = [], now = new Date().toISOString();
    const caller = checked.decision === 'ignore' ? null : eventTaskCaller(store,String(current.repository_id),String(current.id));
    if (checked.decision === 'create') for (const id of checked.option_ids) {
      // The project or the object changed since the Manager decided: that work is refused and the event keeps why.
      const refused = managerRefusal(store, context, id);
      if (refused) { recordRefusal(store, String(current.id), refused); declined.push(id); continue; }
      const option = options.find(entry => entry.id === id)!;
      // A development of an Issue the bot did not open starts only on a basis the Manager stated and the control plane checked.
      const development = option.spec.type === 'object' && option.spec.kind === 'development.issue';
      const basis = development ? decision.basis ?? ownIssue(store, String(current.repository_id), Number((option.spec as any).number)) : null;
      if (development && !basis) { recordRefusal(store, String(current.id), { work: option.work, code: 'development_basis_required', reason: '开发这个 Issue 需要依据（开发标签、维护者的要求或 Manager 提示词里的规则），这次决定没有给出。' }); declined.push(id); continue; }
      const task = createManagedTask(store,caller!,option.spec.type==='request'?undefined:'dev',()=>create(store, current, option, checked));
      if (!task) { declined.push(id); continue; }
      if (basis) recordBasis(store, task, basis);
      created.push(task);
      store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', task, current.id, 'created', now);
      log(store, task, { type: 'dispatch', relation: 'created', event_id: current.id, event_type: current.type, reason: checked.reason, detail: `Manager 因事件「${current.summary}」新建这个任务：${checked.reason}` });
      if (option.hook) hooks.get(option.hook)?.created(store, store.get('SELECT * FROM tasks WHERE id=?', task)!, option.ref ?? null, current);
    }
    if (checked.decision === 'continue') {
      const target = context.continuations.find(option => option.id === checked.option_ids[0])!;
      assertManagedTask(store,caller!,target.task_id,true);
      join(store, current, target.task_id, checked); continued.push(target.task_id);
      store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', target.task_id, current.id, 'continued', now);
    }
    // Options the Manager did not take (or whose own conditions refused them now) end their module's wait.
    for (const option of options) if (option.hook && !checked.option_ids.includes(option.id) || option.hook && declined.includes(option.id))
      hooks.get(option.hook!)?.declined(store, current, checked.decision === 'ignore' ? checked.reason : declined.includes(option.id) ? 'option_refused' : checked.reason, option.ref ?? null);
    store.run(`UPDATE dispatch_events SET state='decided',decision=?,reason=?,brief=?,result=?,model=?,rule=?,lease=NULL,lease_until=NULL,error=NULL,decided_at=? WHERE id=?`,
      checked.decision, checked.reason, checked.brief ? JSON.stringify(checked.brief) : null, JSON.stringify({ created, continued, declined, ...(checked.writes ? { writes: checked.writes } : {}) }),
      checked.model ?? decision.model ?? null, decision.rule ? JSON.stringify(decision.rule) : null, now, current.id);
    return { created, continued };
  }); } catch (error) { if (error instanceof HttpError) throw new TaskError(error.code, 'waiting_configuration'); throw error; }
}

/** The Manager's decision (and the events) behind a task, for task details. */
export function taskDispatch(store: Store, taskId: string) {
  return store.all(`SELECT e.id,e.type,e.summary,e.decision,e.reason,e.brief,e.decided_at,e.created_at,te.relation FROM task_events te JOIN dispatch_events e ON e.id=te.event_id
    WHERE te.task_id=? ORDER BY e.created_at,e.id`, taskId).map(row => ({ event_id: row.id, type: row.type, summary: row.summary, relation: row.relation, decision: row.decision,
    reason: row.reason, brief: row.brief ? JSON.parse(row.brief) : null, created_at: row.created_at, decided_at: row.decided_at }));
}

export function pruneDispatchFailures(store:Store,repositoryId:string,before:string,limit=500){
 return Number(store.run('DELETE FROM dispatch_failures WHERE rowid IN (SELECT f.rowid FROM dispatch_failures f JOIN dispatch_events e ON e.id=f.event_id WHERE e.repository_id=? AND f.created_at<? ORDER BY f.created_at LIMIT ?)',repositoryId,before,limit).changes);
}
