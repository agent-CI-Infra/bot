import type { Store, Row } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { captureTaskConfiguration } from '../tasks/configuration.js';
import { TaskRecords } from '../tasks/service.js';
import { enqueue } from '../review/queue.js';
import { enqueueEventTask } from '../work/events.js';
import { workOffered, workPermissions } from '../work/settings.js';
import { narrowWrites, workType } from '../work/catalog.js';

/**
 * Manager dispatch. Every event that passes the control plane's filters is written here once (event_key is unique) with
 * what the control plane allows for it: the tasks it may create (create options, each a complete, deterministic task
 * spec) and how it joins a running task (merge). The Manager then decides once: create, continue one offered task, or
 * ignore, always with a reason. The decision is applied in one transaction with the event's new state, so a restart can
 * decide again without creating anything twice: task specs carry unique keys and continuations are keyed by event.
 *
 * Modules that own an event (releases, Actions failures, gate onboarding, schedules) name a hook on their option; the hook
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
    CREATE TABLE IF NOT EXISTS task_events(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,event_id TEXT NOT NULL,relation TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(task_id,event_id));
    CREATE INDEX IF NOT EXISTS task_events_event ON task_events(event_id);
  `);
}

/** A task the control plane would create for this event, fully specified before the Manager sees it. */
export type CreateSpec =
  // An Issue or pull request task through the review queue's enqueue (its conditions and unique keys).
  | { type: 'object'; kind: string; number: number; head: string | null; input: Json; delivery: string | null; source_task?: string | null; comment_id?: string | null;
      update_id?: string | null; requests?: Json[] }
  // A reply task (the work type of former custom workflows) on an Issue or pull request.
  | { type: 'reply'; kind: 'workflow.issue' | 'workflow.pr'; number: number; head: string | null; input: Json; key: string; delivery: string | null }
  // A task on an event the owning module tracks (release, Actions run, gate turn).
  | { type: 'event'; kind: string; key: string; sha: string; input: Json; summary: string }
  // An ordinary request (a scheduled check): no GitHub writes; the Manager's brief becomes its contract.
  | { type: 'request'; key: string; request: string; principal: { principal_id: string; tenant_id: string } | null };
export interface CreateOption { id: string; work: string; title: string; spec: CreateSpec; hook?: string; ref?: Json;
  /** What the control plane did before #207 for this event; only the rule decider used in tests reads it, never the Manager. */
  default?: boolean }
export interface EventInput {
  repositoryId: string; key: string; type: string; source: string; summary: string; facts: Json;
  object?: { type: 'issue' | 'pr'; number: number } | null; delivery?: string | null; options: CreateOption[];
  /** How the event joins a running task of these kinds: as an update its agent answers before publication. */
  merge?: { key: string; data: Json; trigger: Json; head?: string | null; kinds: string[] } | null;
}
export interface ContinueOption { id: string; task_id: string; kind: string; status: string; summary: string; created_at: string }
export interface Decision { decision: 'create' | 'continue' | 'ignore'; option_ids: string[]; reason: string; brief?: { goal: string; criteria: string[] } | null; writes?: string[] | null; model?: string | null;
  /** The continue options the decision was made with; a running task that appeared since means deciding again. */
  seen?: string[] }
export interface DispatchContext { event: Row; facts: Json; options: CreateOption[]; continuations: ContinueOption[]; related: Json[] }

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
  const options = input.options.filter(option => workOffered(store, input.repositoryId, option.work, input.type));
  if (!options.length && !(input.merge && continuations(store, { repository_id: input.repositoryId, object_number: input.object?.number ?? null, merge: JSON.stringify(input.merge) }).length)) {
    // Modules still hear that nothing will run for their event.
    for (const option of input.options) if (option.hook) hooks.get(option.hook)?.declined(store, { repository_id: input.repositoryId, type: input.type }, 'work_inactive', option.ref ?? null);
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
 * Tasks the event may join: on the same object, of a kind that answers updates, publication not started, the same head for
 * a PR. Of the running ones only the most recently claimed counts (older runs are about to be replaced), then the waiting
 * ones, as updates were always merged.
 */
export function continuations(store: Store, event: Record<string, any>): ContinueOption[] {
  const merge = event.merge ? JSON.parse(String(event.merge)) : null;
  if (!merge?.kinds?.length || !event.object_number) return [];
  const active = store.all(`SELECT t.* FROM tasks t WHERE t.repository_id=? AND t.object_number=? AND t.kind IN (${merge.kinds.map(() => '?').join(',')})
    AND t.status IN (${activeStates.map(() => '?').join(',')})
    ORDER BY CASE WHEN t.status IN ('running','preparing','publishing','result_ready') THEN 0 ELSE 1 END,(SELECT claimed_at FROM task_claims WHERE task_id=t.id) DESC,t.created_at DESC,t.rowid DESC`,
    String(event.repository_id), Number(event.object_number), ...merge.kinds, ...activeStates);
  const running = (task: Row) => ['running', 'preparing', 'publishing', 'result_ready'].includes(String(task.status));
  const fits = (task: Row) => !task.publication_started && (!String(task.kind).endsWith('.pr') || !merge.head || task.head_sha === merge.head);
  const latest = active.find(running);
  return [...(latest && fits(latest) ? [latest] : []), ...active.filter(task => !running(task) && fits(task))].slice(0, 5)
    .map(task => ({ id: 'continue:' + task.id, task_id: String(task.id), kind: String(task.kind), status: String(task.status), summary: String(task.summary), created_at: String(task.created_at) }));
}
/** What the Manager reads: the event, the offered options and the tasks already on the same object. */
export function dispatchContext(store: Store, event: Row): DispatchContext {
  const options = (JSON.parse(event.options) as CreateOption[]).filter(option => workOffered(store, event.repository_id, option.work, event.type));
  const related = event.object_number ? store.all(`SELECT id,kind,status,summary,error_code,created_at,updated_at,result FROM tasks WHERE repository_id=? AND object_number=?
    AND kind NOT IN ('release.observe','release.notes','actions.failures','gate.onboarding','task.request') ORDER BY created_at DESC,rowid DESC LIMIT 8`, event.repository_id, event.object_number).map(task => {
    let outcome: unknown = null; try { const result = JSON.parse(task.result || 'null'); outcome = result?.summary ? String(result.summary).slice(0, 300) : result?.pr_url ?? null; } catch { outcome = null; }
    return { id: task.id, kind: task.kind, status: task.status, summary: task.summary, error_code: task.error_code ?? null, created_at: task.created_at, outcome };
  }) : [];
  return { event, facts: JSON.parse(event.facts), options, continuations: continuations(store, event), related };
}

export class InvalidDecision extends Error { constructor(readonly code: string, message: string) { super(message); } }
/** A decision may only choose what was offered; the brief and writes are bounded, never widened. */
export function checkDecision(store: Store, context: DispatchContext, value: any): Decision {
  const fail = (code: string, message: string): never => { throw new InvalidDecision(code, message); };
  if (!value || typeof value !== 'object') fail('dispatch_decision_invalid', 'The decision must be an object.');
  const decision = value.decision, ids = Array.isArray(value.option_ids) ? value.option_ids.map(String) : null;
  if (!['create', 'continue', 'ignore'].includes(decision) || !ids) fail('dispatch_decision_invalid', 'decision must be create, continue or ignore, with option_ids.');
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason) fail('dispatch_reason_required', 'Give the reason for the decision.');
  if (new Set(ids).size !== ids.length) fail('dispatch_decision_invalid', 'option_ids repeat an option.');
  if (decision === 'ignore' && ids.length) fail('dispatch_decision_invalid', 'ignore takes no option_ids.');
  if (decision === 'create' && (!ids.length || ids.length > 3 || ids.some((id: string) => !context.options.some(option => option.id === id))))
    fail('dispatch_option_not_offered', 'create needs one to three ids of the offered create options.');
  if (decision === 'continue' && (ids.length !== 1 || !context.continuations.some(option => option.id === ids[0])))
    fail('dispatch_option_not_offered', 'continue needs exactly one id of the offered continue options.');
  let writes: string[] | null = null;
  if (value.writes !== undefined && value.writes !== null) {
    if (decision !== 'create' || !Array.isArray(value.writes) || value.writes.some((write: unknown) => typeof write !== 'string')) fail('dispatch_writes_invalid', 'writes narrows the writes of created tasks: a list of write ids.');
    const allowed = new Set(context.options.filter(option => ids.includes(option.id)).flatMap(option => workPermissions(store, context.event.repository_id, option.work).writes));
    writes = value.writes;
    if (writes!.some(write => !allowed.has(write))) fail('dispatch_writes_not_allowed', 'writes may only keep writes the project allows for these tasks.');
  }
  let brief: Decision['brief'] = null;
  if (value.brief !== undefined && value.brief !== null) {
    const goal = typeof value.brief?.goal === 'string' ? value.brief.goal.trim() : '', criteria = Array.isArray(value.brief?.criteria) ? value.brief.criteria.filter((c: unknown) => typeof c === 'string' && c.trim()).map((c: string) => c.trim().slice(0, 500)) : [];
    if (decision !== 'create' || !goal) fail('dispatch_brief_invalid', 'brief belongs to create and needs a goal.');
    brief = { goal: goal.slice(0, 2000), criteria: criteria.slice(0, 10) };
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
    // Requests a bot pull request revision carries are done once it is queued; otherwise later reviews list them again.
    if (spec.kind === 'development.pr' && spec.requests?.length) {
      const now = new Date().toISOString();
      // A request another revision already carried stays done.
      for (const r of spec.requests as any[]) store.run(`INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,number,source_type,source_id)
        DO UPDATE SET state=CASE WHEN bot_pr_requests.state='done' THEN 'done' ELSE excluded.state END,task_id=CASE WHEN bot_pr_requests.state='done' THEN bot_pr_requests.task_id ELSE excluded.task_id END`,
        repo, spec.number, r.type, r.id, r.author, r.author_id, r.author_type, r.url, id ? 'done' : 'pending', id, now);
      if (!id && spec.source_task) log(store, spec.source_task, { type: 'revision_deferred', detail: `PR #${spec.number} 已有排队或执行中的修订；这次的修改请求先记下，之后对这个 PR 的检视会再列出它们。` });
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
  const goal = decision.brief?.goal || spec.request, contract = { goal, scope: [spec.request.slice(0, 2000)], criteria: decision.brief?.criteria?.length ? decision.brief.criteria : ['Report what was checked, with evidence; change nothing outside the task workspace.'],
    endpoint: 'report', source: { type: 'schedule', event_id: event.id }, completeness: 'explicit' };
  const id = randomId(), now = new Date().toISOString();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,created_at,updated_at) VALUES(?,?,'task.request','queued',?,?,?,?,?)",
    id, repo, goal.slice(0, 160), key, JSON.stringify({ request: spec.request, contract, manager }), now, now);
  new TaskRecords(store).contract(id, contract as any);
  store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ request: spec.request, contract: new TaskRecords(store).get(id).contract, manager }), id);
  captureTaskConfiguration(store, id);
  if (spec.principal) store.run('INSERT INTO task_authorizations VALUES(?,?,?,?,?)', id, spec.principal.principal_id, spec.principal.tenant_id, repo, 'tasks.write');
  return id;
}
/** Adds the event to a running task: an update it answers before publication, and a reference in its facts. */
function join(store: Store, event: Row, taskId: string, decision: Decision) {
  const merge = JSON.parse(event.merge), task = store.get('SELECT * FROM tasks WHERE id=?', taskId)!;
  const inserted = store.run('INSERT OR IGNORE INTO review_updates(task_id,event_key,data) VALUES(?,?,?)', taskId, merge.key, JSON.stringify(merge.data));
  if (inserted.changes) {
    const input = JSON.parse(task.input || '{}');
    store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ ...input, merged_updates: [...(input.merged_updates || []), merge.trigger] }), taskId);
  }
  log(store, taskId, { type: 'dispatch', relation: 'continued', event_id: event.id, event_type: event.type, reason: decision.reason, detail: `Manager 把事件「${event.summary}」续接到这个任务：${decision.reason}` });
}

/**
 * Applies a decision in one transaction. `lease` fences the dispatcher's claim (null for the immediate test decider).
 * Throws InvalidDecision when a continuation target is no longer running: the event is decided again.
 */
export function applyDecision(store: Store, event: Row, decision: Decision, lease: string | null): { created: string[]; continued: string[] } {
  return store.transaction(() => {
    const current = store.get('SELECT * FROM dispatch_events WHERE id=?', event.id);
    if (!current || (lease ? current.state !== 'dispatching' || current.lease !== lease : current.state !== 'pending')) throw new InvalidDecision('dispatch_lease_lost', 'The event was decided or claimed elsewhere.');
    const context = dispatchContext(store, current), checked = checkDecision(store, context, decision);
    // A review that started meanwhile (another event of the object) changes the choice: create may now duplicate it.
    if (decision.seen && context.continuations.some(option => !decision.seen!.includes(option.id))) throw new InvalidDecision('dispatch_context_changed', 'A task the event could join appeared after the decision.');
    const options = JSON.parse(current.options) as CreateOption[], created: string[] = [], continued: string[] = [], declined: string[] = [], now = new Date().toISOString();
    if (checked.decision === 'create') for (const id of checked.option_ids) {
      const option = options.find(entry => entry.id === id)!, task = create(store, current, option, checked);
      if (!task) { declined.push(id); continue; }
      created.push(task);
      store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', task, current.id, 'created', now);
      log(store, task, { type: 'dispatch', relation: 'created', event_id: current.id, event_type: current.type, reason: checked.reason, detail: `Manager 因事件「${current.summary}」新建这个任务：${checked.reason}` });
      if (option.hook) hooks.get(option.hook)?.created(store, store.get('SELECT * FROM tasks WHERE id=?', task)!, option.ref ?? null, current);
    }
    if (checked.decision === 'continue') {
      const target = context.continuations.find(option => option.id === checked.option_ids[0])!;
      join(store, current, target.task_id, checked); continued.push(target.task_id);
      store.run('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)', target.task_id, current.id, 'continued', now);
    }
    // Options the Manager did not take (or whose own conditions refused them now) end their module's wait.
    for (const option of options) if (option.hook && !checked.option_ids.includes(option.id) || option.hook && declined.includes(option.id))
      hooks.get(option.hook!)?.declined(store, current, checked.decision === 'ignore' ? checked.reason : declined.includes(option.id) ? 'option_refused' : checked.reason, option.ref ?? null);
    store.run(`UPDATE dispatch_events SET state='decided',decision=?,reason=?,brief=?,result=?,model=?,lease=NULL,lease_until=NULL,error=NULL,decided_at=? WHERE id=?`,
      checked.decision, checked.reason, checked.brief ? JSON.stringify(checked.brief) : null, JSON.stringify({ created, continued, declined, ...(checked.writes ? { writes: checked.writes } : {}) }),
      checked.model ?? decision.model ?? null, now, current.id);
    return { created, continued };
  });
}

/** The Manager's decision (and the events) behind a task, for task details. */
export function taskDispatch(store: Store, taskId: string) {
  return store.all(`SELECT e.id,e.type,e.summary,e.decision,e.reason,e.brief,e.decided_at,e.created_at,te.relation FROM task_events te JOIN dispatch_events e ON e.id=te.event_id
    WHERE te.task_id=? ORDER BY e.created_at,e.id`, taskId).map(row => ({ event_id: row.id, type: row.type, summary: row.summary, relation: row.relation, decision: row.decision,
    reason: row.reason, brief: row.brief ? JSON.parse(row.brief) : null, created_at: row.created_at, decided_at: row.decided_at }));
}
