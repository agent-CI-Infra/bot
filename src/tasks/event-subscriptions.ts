import type { Store, Row } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { clip, stop } from '../agent/common.js';
import { traceEvent } from './trace.js';
import { insertTaskLog, storedInput } from '../storage/payloads.js';

export type EventSubscriptionState = 'active' | 'matched' | 'timed_out' | 'cancelled';
export type EventWakeReason = 'webhook_matched' | 'manager_assigned' | 'timeout' | 'operator_cancelled';

export interface EventSubscriptionHints {
  run_id?: number;
  workflow?: string;
  head_sha?: string;
  branch?: string;
  object_number?: number;
  action?: string;
  conclusion?: string;
  [key: string]: unknown;
}

export interface EventSubscriptionView {
  id: string;
  repository_id: string;
  task_id: string;
  thread_key: string | null;
  object_type: string | null;
  object_number: number | null;
  events: string[];
  hints: EventSubscriptionHints;
  note: string;
  state: EventSubscriptionState;
  timeout_at: number;
  wake_reason: string | null;
  matched_delivery_id: string | null;
  matched_event: string | null;
  matched_summary: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

let wakeCallback: (() => void) | null = null;
export const onSubscriptionWake = (callback: (() => void) | null) => {
  wakeCallback = callback;
};
const notifyWake = () => {
  if (wakeCallback) queueMicrotask(() => wakeCallback?.());
};

const terminalStatuses = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];
const defaultTimeoutSeconds = 1800;
const minTimeoutSeconds = 5;
const maxTimeoutSeconds = 86400;
const maxActivePerTask = 10;
const completionDefaultEvents = new Set(['workflow_run', 'workflow_job', 'check_suite', 'check_run']);

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});

const hintProperties: Record<string, unknown> = {
  run_id: { type: 'integer', minimum: 1, description: 'Optional Actions workflow_run or check_run id (for example workflow_run_id from github_write dispatch).' },
  workflow: { type: 'string', maxLength: 240, description: 'Optional workflow file name (e.g. ci.yml), path, name, or id.' },
  head_sha: { type: 'string', maxLength: 64, description: 'Optional commit SHA or prefix.' },
  branch: { type: 'string', maxLength: 240, description: 'Optional branch name (without refs/heads/).' },
  object_number: { type: 'integer', minimum: 1, description: 'Optional Issue or PR number.' },
  action: { type: 'string', maxLength: 80, description: 'Optional webhook action (defaults to "completed" for workflow_run/check_suite/check_run when omitted).' },
  conclusion: { type: 'string', maxLength: 80, description: 'Optional expected conclusion (e.g. success, failure).' },
};

export const eventSubscriptionTools = [
  fn(
    'subscribe_event',
    'Register a lightweight repository webhook subscription for this task and (by default) release the current execution slot until a matching GitHub webhook arrives or timeout_seconds elapses. Use this instead of sleeping or polling after starting a workflow, rerunning CI, or waiting for a PR/comment/check update. Hints are optional and loose: exact matches wake the task directly; if a webhook misses the filter fields while active subscriptions exist, the project Manager can still match and continue your task; if timeout_seconds expires first, the task wakes with wake_reason="timeout" so you can inspect current state via github_read / read_job_log.',
    {
      events: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', maxLength: 80 },
        description: 'Coarse GitHub webhook event types to watch, such as ["workflow_run"], ["check_suite", "check_run"], ["pull_request"], ["issue_comment"], ["issues"], ["push"], ["deployment_status"], or ["status"].',
      },
      ...hintProperties,
      hints: {
        type: 'object',
        description: 'Optional loose matching hints object (same optional keys as top-level: run_id, workflow, head_sha, branch, object_number, action, conclusion, or extra context keys).',
      },
      note: {
        type: 'string',
        maxLength: 2000,
        description: 'Natural-language note describing what external event you are waiting for and what to check when woken.',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: minTimeoutSeconds,
        maximum: maxTimeoutSeconds,
        description: `Maximum wait time in seconds before automatic timeout wakeup (${minTimeoutSeconds}..${maxTimeoutSeconds}, default ${defaultTimeoutSeconds}).`,
      },
      release_slot: {
        type: 'boolean',
        description: 'Defaults to true: checkpoints workspace state and releases this task execution slot immediately until woken. Set false only to register multiple subscriptions before releasing.',
      },
    },
    ['events'],
  ),
  fn(
    'list_event_subscriptions',
    'List event subscriptions registered by this task (active and recent resolved) together with any received wakeup events.',
    {
      state: { type: 'string', enum: ['active', 'all'], description: 'Filter by active only or all subscriptions of this task (default all).' },
    },
  ),
  fn(
    'cancel_event_subscription',
    'Cancel an active event subscription belonging to this task.',
    {
      subscription_id: { type: 'string', maxLength: 120, description: 'Subscription id from subscribe_event or list_event_subscriptions.' },
      reason: { type: 'string', maxLength: 500, description: 'Optional reason for cancelling.' },
    },
    ['subscription_id'],
  ),
];

export const eventSubscriptionToolNames = eventSubscriptionTools.map(t => t.function.name);

export const managerEventSubscriptionTool = fn(
  'list_event_subscriptions',
  'Query event_subscriptions in this repository (active waiting task subscriptions by default, or recent resolved ones) to inspect what external GitHub events tasks are waiting for before deciding continue_task, create_task, or ignore_event.',
  {
    state: { type: 'string', enum: ['active', 'all'], description: 'Defaults to active.' },
    task_id: { type: 'string', maxLength: 120, description: 'Optional task_id filter.' },
  },
);

export const eventSubscriptionInstructions =
  ' When waiting for an external GitHub event (such as an Actions workflow_run or check_suite to finish after workflow_dispatch or rerun, or a PR/comment update), never sleep or poll in a loop: call subscribe_event with the coarse event type(s), any known hints (run_id, workflow, head_sha, branch, object_number, note) and timeout_seconds to release the execution slot cleanly. If woken with wake_reason="timeout", use github_read and read_job_log to verify actual state on GitHub before deciding whether to subscribe again, retry, or finish.';

export function eventSubscriptionStorage(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS event_subscriptions(
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      thread_key TEXT,
      object_type TEXT,
      object_number INTEGER,
      events TEXT NOT NULL,
      hints TEXT NOT NULL DEFAULT '{}',
      note TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','matched','timed_out','cancelled')),
      timeout_at INTEGER NOT NULL,
      wake_reason TEXT,
      matched_delivery_id TEXT,
      matched_event TEXT,
      matched_summary TEXT,
      created_by TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS event_subscriptions_repo_active ON event_subscriptions(repository_id, state, timeout_at);
    CREATE INDEX IF NOT EXISTS event_subscriptions_task ON event_subscriptions(task_id, created_at);
    CREATE INDEX IF NOT EXISTS event_subscriptions_due ON event_subscriptions(state, timeout_at);
    CREATE TRIGGER IF NOT EXISTS event_subscriptions_task_ended AFTER UPDATE OF status ON tasks
    WHEN OLD.status<>NEW.status AND NEW.status IN (${terminalStatuses.map(s => `'${s}'`).join(',')}) BEGIN
      UPDATE event_subscriptions
      SET state='cancelled',
          wake_reason='task_'||NEW.status,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE task_id=NEW.id AND state='active';
    END;
  `);
}

function normalizeEventName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const base = trimmed.split('.')[0]!;
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(base)) return null;
  return base === 'issue' ? 'issues' : base === 'pr' ? 'pull_request' : base;
}

function parseRow(row: Row): EventSubscriptionView {
  let events: string[] = [];
  let hints: EventSubscriptionHints = {};
  try { events = JSON.parse(String(row.events || '[]')); } catch { events = []; }
  try { hints = JSON.parse(String(row.hints || '{}')); } catch { hints = {}; }
  return {
    id: String(row.id),
    repository_id: String(row.repository_id),
    task_id: String(row.task_id),
    thread_key: row.thread_key ? String(row.thread_key) : null,
    object_type: row.object_type ? String(row.object_type) : null,
    object_number: row.object_number != null ? Number(row.object_number) : null,
    events,
    hints,
    note: String(row.note ?? ''),
    state: String(row.state) as EventSubscriptionState,
    timeout_at: Number(row.timeout_at),
    wake_reason: row.wake_reason ? String(row.wake_reason) : null,
    matched_delivery_id: row.matched_delivery_id ? String(row.matched_delivery_id) : null,
    matched_event: row.matched_event ? String(row.matched_event) : null,
    matched_summary: row.matched_summary ? String(row.matched_summary) : null,
    created_by: String(row.created_by ?? 'agent'),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    resolved_at: row.resolved_at ? String(row.resolved_at) : null,
  };
}

function inferTaskObject(task: Row): { object_type: string | null; object_number: number | null; thread_key: string | null } {
  let parsedInput: any = {};
  try { parsedInput = JSON.parse(String(task.input || '{}')); } catch { parsedInput = {}; }
  const targetType = parsedInput?.target?.type === 'pr' || String(task.kind || '').endsWith('.pr')
    ? 'pr'
    : parsedInput?.target?.type === 'issue' || String(task.kind || '').endsWith('.issue')
      ? 'issue'
      : null;
  const number = Number.isSafeInteger(parsedInput?.target?.number)
    ? Number(parsedInput.target.number)
    : Number.isSafeInteger(task.object_number)
      ? Number(task.object_number)
      : null;
  const thread_key = targetType && number ? `${task.repository_id}:${targetType}:${number}` : null;
  return { object_type: targetType, object_number: number, thread_key };
}

function sanitizeHints(rawArgs: Record<string, unknown>): { hints: EventSubscriptionHints; implicitAction?: string } | { error: string; detail: string } {
  const merged: Record<string, unknown> = {};
  if (rawArgs.hints !== undefined) {
    if (!rawArgs.hints || typeof rawArgs.hints !== 'object' || Array.isArray(rawArgs.hints)) {
      return { error: 'invalid_arguments', detail: 'hints must be a JSON object when provided.' };
    }
    for (const [k, v] of Object.entries(rawArgs.hints as Record<string, unknown>)) {
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    }
  }
  for (const key of ['run_id', 'workflow', 'head_sha', 'branch', 'object_number', 'action', 'conclusion']) {
    if (rawArgs[key] !== undefined && rawArgs[key] !== null && rawArgs[key] !== '') merged[key] = rawArgs[key];
  }

  const out: EventSubscriptionHints = {};
  if (merged.run_id !== undefined) {
    const n = Number(merged.run_id);
    if (!Number.isSafeInteger(n) || n < 1) return { error: 'invalid_arguments', detail: 'run_id must be a positive integer.' };
    out.run_id = n;
  }
  if (merged.object_number !== undefined) {
    const n = Number(merged.object_number);
    if (!Number.isSafeInteger(n) || n < 1) return { error: 'invalid_arguments', detail: 'object_number must be a positive integer.' };
    out.object_number = n;
  }
  if (merged.workflow !== undefined) {
    const s = String(merged.workflow).trim();
    if (s.length > 240) return { error: 'invalid_arguments', detail: 'workflow hint exceeds 240 characters.' };
    if (s) out.workflow = s;
  }
  if (merged.head_sha !== undefined) {
    const s = String(merged.head_sha).trim().toLowerCase();
    if (!/^[a-f0-9]{4,40}$/.test(s)) return { error: 'invalid_arguments', detail: 'head_sha hint must be a 4-to-40 character hex commit SHA/prefix.' };
    out.head_sha = s;
  }
  if (merged.branch !== undefined) {
    const s = String(merged.branch).trim().replace(/^refs\/heads\//, '');
    if (s.length > 240) return { error: 'invalid_arguments', detail: 'branch hint exceeds 240 characters.' };
    if (s) out.branch = s;
  }
  if (merged.action !== undefined) {
    const s = String(merged.action).trim().toLowerCase();
    if (s.length > 80) return { error: 'invalid_arguments', detail: 'action hint exceeds 80 characters.' };
    if (s) out.action = s;
  }
  if (merged.conclusion !== undefined) {
    const s = String(merged.conclusion).trim().toLowerCase();
    if (s.length > 80) return { error: 'invalid_arguments', detail: 'conclusion hint exceeds 80 characters.' };
    if (s) out.conclusion = s;
  }
  for (const [key, value] of Object.entries(merged)) {
    if (Object.hasOwn(out, key) || ['run_id', 'workflow', 'head_sha', 'branch', 'object_number', 'action', 'conclusion'].includes(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      out[key.slice(0, 64)] = typeof value === 'string' ? value.slice(0, 240) : value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 8192) {
    return { error: 'invalid_arguments', detail: 'hints exceed 8 KiB.' };
  }
  return { hints: out };
}

export function hasActiveEventSubscriptions(store: Store, taskId: string): boolean {
  if (!store.hasTable('event_subscriptions')) return false;
  return !!store.get("SELECT 1 FROM event_subscriptions WHERE task_id=? AND state='active' LIMIT 1", taskId);
}

export function nextEventSubscriptionTimeout(store: Store, taskId: string): number | null {
  if (!store.hasTable('event_subscriptions')) return null;
  const row = store.get("SELECT min(timeout_at) AS next_timeout FROM event_subscriptions WHERE task_id=? AND state='active'", taskId);
  return row?.next_timeout != null ? Number(row.next_timeout) : null;
}

export function taskEventSubscriptionsDetail(store: Store, taskId: string): EventSubscriptionView[] {
  if (!store.hasTable('event_subscriptions')) return [];
  return store
    .all('SELECT * FROM event_subscriptions WHERE task_id=? ORDER BY CASE WHEN state=\'active\' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 30', taskId)
    .map(parseRow);
}

export function taskEventSubscriptionContext(store: Store, taskId: string): Record<string, unknown> | undefined {
  if (!store.hasTable('event_subscriptions')) return undefined;
  const subs = taskEventSubscriptionsDetail(store, taskId);
  const taskRow = store.get('SELECT input FROM tasks WHERE id=?', taskId);
  let wakeups: any[] = [];
  try {
    const parsed = JSON.parse(String(taskRow?.input || '{}'));
    if (Array.isArray(parsed.event_wakeups)) wakeups = parsed.event_wakeups;
  } catch {
    wakeups = [];
  }
  if (!subs.length && !wakeups.length) return undefined;
  const latest = wakeups.at(-1);
  const timedOut = latest?.wake_reason === 'timeout';
  return {
    instruction: timedOut
      ? 'One or more event subscriptions timed out before a matching webhook arrived. Do not assume the external workflow or action succeeded or failed: use github_read and read_job_log to inspect the actual current state on GitHub, then decide whether to subscribe again, retry, or finish and report.'
      : wakeups.length
        ? 'Subscribed repository event(s) woke this task (see wakeups). Inspect actual outcome, logs or artifacts as needed and continue the task.'
        : 'Current event subscriptions registered on this task.',
    active: subs.filter(s => s.state === 'active'),
    recent: subs.filter(s => s.state !== 'active').slice(0, 10),
    wakeups: wakeups.slice(-10),
  };
}

export function executeTaskSubscriptionTool(
  store: Store,
  task: Row,
  name: string,
  rawArgs: unknown,
  options: { actor?: string; log?: (entry: any) => void } = {},
): any {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : null;
  if (!args) return { error: 'invalid_arguments' };
  const actor = options.actor ?? (task.active_role ? 'role:' + String(task.active_role) : 'agent');

  if (name === 'list_event_subscriptions') {
    if (Object.keys(args).some(k => k !== 'state') || (args.state !== undefined && !['active', 'all'].includes(String(args.state)))) {
      return { error: 'invalid_arguments' };
    }
    const all = taskEventSubscriptionsDetail(store, String(task.id));
    const filtered = args.state === 'active' ? all.filter(s => s.state === 'active') : all;
    const ctx = taskEventSubscriptionContext(store, String(task.id));
    return {
      subscriptions: filtered,
      wakeups: (ctx?.wakeups as any[] | undefined) ?? [],
    };
  }

  if (name === 'cancel_event_subscription') {
    if (
      Object.keys(args).some(k => !['subscription_id', 'reason'].includes(k)) ||
      typeof args.subscription_id !== 'string' ||
      !args.subscription_id.trim() ||
      (args.reason !== undefined && typeof args.reason !== 'string')
    ) {
      return { error: 'invalid_arguments' };
    }
    return cancelTaskEventSubscription(store, String(task.id), args.subscription_id.trim(), actor, typeof args.reason === 'string' ? args.reason.trim() : undefined);
  }

  if (name !== 'subscribe_event') return { error: 'tool_not_allowed' };

  const allowedKeys = new Set(['events', 'hints', 'note', 'timeout_seconds', 'release_slot', 'run_id', 'workflow', 'head_sha', 'branch', 'object_number', 'action', 'conclusion']);
  if (Object.keys(args).some(k => !allowedKeys.has(k))) {
    return { error: 'invalid_arguments', detail: 'Unsupported field in subscribe_event.' };
  }
  if (!Array.isArray(args.events) || args.events.length < 1 || args.events.length > 10) {
    return { error: 'invalid_arguments', detail: 'events must be a non-empty array of 1..10 GitHub webhook event names.' };
  }
  const events: string[] = [];
  for (const rawEvent of args.events) {
    const normalized = normalizeEventName(rawEvent);
    if (!normalized) return { error: 'invalid_arguments', detail: `Invalid webhook event name: ${JSON.stringify(rawEvent)}` };
    const dotAction = typeof rawEvent === 'string' && rawEvent.includes('.') ? rawEvent.split('.').slice(1).join('.').trim().toLowerCase() : '';
    if (dotAction && args.action === undefined && !(args.hints && typeof args.hints === 'object' && 'action' in (args.hints as any))) {
      args.action = dotAction;
    }
    if (!events.includes(normalized)) events.push(normalized);
  }

  const parsedHints = sanitizeHints(args);
  if ('error' in parsedHints) return parsedHints;
  const hints = parsedHints.hints;

  const note = args.note === undefined ? '' : typeof args.note === 'string' ? args.note.trim() : null;
  if (note === null || note.length > 2000) {
    return { error: 'invalid_arguments', detail: 'note must be a string of up to 2000 characters.' };
  }

  const timeoutSeconds = args.timeout_seconds === undefined ? defaultTimeoutSeconds : Number(args.timeout_seconds);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < minTimeoutSeconds || timeoutSeconds > maxTimeoutSeconds) {
    return { error: 'invalid_arguments', detail: `timeout_seconds must be an integer between ${minTimeoutSeconds} and ${maxTimeoutSeconds}.` };
  }
  if (args.release_slot !== undefined && typeof args.release_slot !== 'boolean') {
    return { error: 'invalid_arguments', detail: 'release_slot must be a boolean.' };
  }
  const releaseSlot = args.release_slot !== false;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timeoutAt = nowMs + timeoutSeconds * 1000;
  const meta = inferTaskObject(task);
  const eventsJson = JSON.stringify(events);
  const hintsJson = JSON.stringify(hints);

  const created = store.transaction(() => {
    const duplicate = store.get(
      "SELECT * FROM event_subscriptions WHERE task_id=? AND state='active' AND events=? AND hints=? AND note=? LIMIT 1",
      String(task.id),
      eventsJson,
      hintsJson,
      note,
    );
    if (duplicate) {
      store.run('UPDATE event_subscriptions SET timeout_at=?,updated_at=? WHERE id=?', timeoutAt, nowIso, duplicate.id);
      return { row: parseRow({ ...duplicate, timeout_at: timeoutAt, updated_at: nowIso }), replayed: true };
    }
    const activeCount = Number(store.get("SELECT count(*) AS n FROM event_subscriptions WHERE task_id=? AND state='active'", String(task.id))?.n ?? 0);
    if (activeCount >= maxActivePerTask) {
      return { error: 'event_subscription_limit', detail: `A task may hold at most ${maxActivePerTask} active subscriptions at once. Cancel an existing subscription first.` };
    }
    const id = randomId();
    store.run(
      `INSERT INTO event_subscriptions(
        id,repository_id,task_id,thread_key,object_type,object_number,events,hints,note,state,timeout_at,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
      id,
      String(task.repository_id),
      String(task.id),
      meta.thread_key,
      meta.object_type,
      meta.object_number,
      eventsJson,
      hintsJson,
      note,
      timeoutAt,
      actor,
      nowIso,
      nowIso,
    );
    const saved = parseRow(store.get('SELECT * FROM event_subscriptions WHERE id=?', id)!);
    traceEvent(
      store,
      String(task.id),
      'event_subscribed',
      {
        subscription_id: id,
        events,
        hints,
        note: note || null,
        timeout_at: new Date(timeoutAt).toISOString(),
        release_slot: releaseSlot,
      },
      task.trace_run_id ?? null,
      actor,
    );
    return { row: saved, replayed: false };
  });

  if ('error' in created) return created;

  const summary = formatSubscriptionWaitSummary(created.row);
  if (options.log) {
    options.log({
      type: 'event_subscribed',
      subscription_id: created.row.id,
      events,
      hints,
      note: note || null,
      timeout_at: new Date(timeoutAt).toISOString(),
      release_slot: releaseSlot,
      detail: summary,
    });
  } else {
    insertTaskLog(
      store,
      task,
      JSON.stringify({
        type: 'event_subscribed',
        subscription_id: created.row.id,
        events,
        hints,
        note: note || null,
        timeout_at: new Date(timeoutAt).toISOString(),
        release_slot: releaseSlot,
        detail: summary,
      }),
    );
  }

  if (releaseSlot) {
    return stop('event_subscription_pending', 'waiting_event', summary);
  }

  return {
    subscribed: true,
    replayed: created.replayed,
    released_slot: false,
    subscription: created.row,
  };
}

function formatSubscriptionWaitSummary(sub: EventSubscriptionView): string {
  const hintParts: string[] = [];
  if (sub.hints.run_id) hintParts.push(`run_id=${sub.hints.run_id}`);
  if (sub.hints.workflow) hintParts.push(`workflow=${sub.hints.workflow}`);
  if (sub.hints.head_sha) hintParts.push(`head_sha=${String(sub.hints.head_sha).slice(0, 12)}`);
  if (sub.hints.branch) hintParts.push(`branch=${sub.hints.branch}`);
  if (sub.hints.object_number) hintParts.push(`#${sub.hints.object_number}`);
  if (sub.hints.action) hintParts.push(`action=${sub.hints.action}`);
  if (sub.hints.conclusion) hintParts.push(`conclusion=${sub.hints.conclusion}`);
  const timeoutIso = new Date(sub.timeout_at).toISOString().replace('.000Z', 'Z');
  return `等待事件 ${sub.events.join(' / ')}${hintParts.length ? `（${hintParts.join('，')}）` : ''}${sub.note ? `：${sub.note.slice(0, 160)}` : ''}；超时唤醒时间 ${timeoutIso}。`;
}

export function cancelTaskEventSubscription(
  store: Store,
  taskId: string,
  subscriptionId: string,
  actor: string,
  reason?: string,
): { ok?: boolean; cancelled?: boolean; error?: string; subscription?: EventSubscriptionView; task_woken?: boolean } {
  if (!store.hasTable('event_subscriptions')) return { error: 'subscription_not_found' };
  let wokeTask = false;
  const out = store.transaction(() => {
    const existing = store.get('SELECT * FROM event_subscriptions WHERE id=? AND task_id=?', subscriptionId, taskId);
    if (!existing) return { error: 'subscription_not_found' };
    if (existing.state !== 'active') {
      return { ok: true, cancelled: false, subscription: parseRow(existing) };
    }
    const nowIso = new Date().toISOString();
    store.run(
      "UPDATE event_subscriptions SET state='cancelled',wake_reason=?,updated_at=?,resolved_at=? WHERE id=? AND state='active'",
      actor.startsWith('user:') ? 'operator_cancelled' : 'agent_cancelled',
      nowIso,
      nowIso,
      subscriptionId,
    );
    const updated = parseRow(store.get('SELECT * FROM event_subscriptions WHERE id=?', subscriptionId)!);
    traceEvent(
      store,
      taskId,
      'event_subscription_cancelled',
      { subscription_id: subscriptionId, reason: reason ?? null, actor },
      null,
      actor,
    );
    if (actor.startsWith('user:') && !hasActiveEventSubscriptions(store, taskId)) {
      const task = store.get('SELECT * FROM tasks WHERE id=?', taskId);
      if (task?.status === 'waiting_event') {
        wokeTask = wakeTaskFromSubscription(store, task, {
          subscription_id: subscriptionId,
          wake_reason: 'operator_cancelled',
          woken_at: nowIso,
          delivery_id: null,
          event: null,
          action: null,
          summary: reason ? `人工取消事件订阅：${reason}` : '人工取消了最后一条等待中的事件订阅，任务恢复排队。',
          note: updated.note || null,
          hints: updated.hints,
          payload_excerpt: null,
        });
      }
    }
    return { ok: true, cancelled: true, subscription: updated, task_woken: wokeTask };
  });
  if (wokeTask) notifyWake();
  return out;
}

interface ExtractedWebhookFacts {
  event: string;
  action: string | null;
  route: string;
  run_id: number | null;
  workflow_candidates: string[];
  head_sha: string | null;
  branch: string | null;
  object_numbers: number[];
  conclusion: string | null;
  summary: string;
  excerpt: Record<string, unknown>;
}

function basenameOf(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  const parts = path.trim().split('/');
  return parts.at(-1) || null;
}

export function extractWebhookSubscriptionFacts(event: string, payload: Json): ExtractedWebhookFacts {
  const p = payload as any;
  const action = typeof p?.action === 'string' && p.action ? p.action.toLowerCase() : null;
  const normalizedEvent = event === 'issue' ? 'issues' : event;
  const route = normalizedEvent + (action ? `.${action}` : '');

  const runIdRaw = p?.workflow_run?.id ?? p?.workflow_job?.run_id ?? p?.check_run?.id ?? null;
  const run_id = Number.isSafeInteger(Number(runIdRaw)) && Number(runIdRaw) > 0 ? Number(runIdRaw) : null;

  const workflowCandidatesRaw = [
    p?.workflow_run?.name,
    p?.workflow_run?.path,
    basenameOf(p?.workflow_run?.path),
    p?.workflow_run?.workflow_id != null ? String(p.workflow_run.workflow_id) : null,
    p?.workflow?.name,
    p?.workflow?.path,
    basenameOf(p?.workflow?.path),
    p?.workflow?.id != null ? String(p.workflow.id) : null,
    p?.workflow_job?.workflow_name,
    p?.workflow_job?.name,
    p?.check_run?.name,
    p?.check_suite?.app?.slug,
    p?.check_suite?.app?.name,
  ];
  const workflow_candidates = [...new Set(workflowCandidatesRaw.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim().toLowerCase()))];

  const shaRaw =
    p?.workflow_run?.head_sha ??
    p?.workflow_job?.head_sha ??
    p?.check_suite?.head_sha ??
    p?.check_run?.head_sha ??
    p?.pull_request?.head?.sha ??
    p?.deployment?.sha ??
    p?.sha ??
    (typeof p?.after === 'string' && !/^0+$/.test(p.after) ? p.after : null);
  const head_sha = typeof shaRaw === 'string' && /^[a-f0-9]{7,40}$/i.test(shaRaw.trim()) ? shaRaw.trim().toLowerCase() : null;

  const branchRaw =
    p?.workflow_run?.head_branch ??
    p?.workflow_job?.head_branch ??
    p?.check_suite?.head_branch ??
    p?.pull_request?.head?.ref ??
    (typeof p?.ref === 'string' && p.ref.startsWith('refs/heads/') ? p.ref.slice(11) : null);
  const branch = typeof branchRaw === 'string' && branchRaw.trim() ? branchRaw.trim().toLowerCase() : null;

  const nums = new Set<number>();
  for (const candidate of [
    p?.issue?.number,
    p?.pull_request?.number,
    ...(Array.isArray(p?.workflow_run?.pull_requests) ? p.workflow_run.pull_requests.map((pr: any) => pr?.number) : []),
    ...(Array.isArray(p?.check_suite?.pull_requests) ? p.check_suite.pull_requests.map((pr: any) => pr?.number) : []),
    ...(Array.isArray(p?.check_run?.check_suite?.pull_requests) ? p.check_run.check_suite.pull_requests.map((pr: any) => pr?.number) : []),
  ]) {
    if (Number.isSafeInteger(Number(candidate)) && Number(candidate) > 0) nums.add(Number(candidate));
  }
  const object_numbers = [...nums];

  const conclusionRaw =
    p?.workflow_run?.conclusion ??
    p?.workflow_job?.conclusion ??
    p?.check_suite?.conclusion ??
    p?.check_run?.conclusion ??
    p?.deployment_status?.state ??
    p?.state ??
    null;
  const conclusion = typeof conclusionRaw === 'string' && conclusionRaw.trim() ? conclusionRaw.trim().toLowerCase() : null;

  let summary = route;
  if (normalizedEvent === 'workflow_run' && p?.workflow_run) {
    summary = `workflow_run.${action ?? 'event'} ${p.workflow_run.name || p.workflow_run.path || '#' + p.workflow_run.id} (${p.workflow_run.conclusion || p.workflow_run.status || 'unknown'})`;
  } else if (normalizedEvent === 'check_suite' && p?.check_suite) {
    summary = `check_suite.${action ?? 'event'} (${p.check_suite.conclusion || p.check_suite.status || 'unknown'}) on ${(head_sha || '').slice(0, 12)}`;
  } else if (normalizedEvent === 'check_run' && p?.check_run) {
    summary = `check_run.${action ?? 'event'} ${p.check_run.name || '#' + p.check_run.id} (${p.check_run.conclusion || p.check_run.status || 'unknown'})`;
  } else if (p?.pull_request?.number) {
    summary = `${route} PR #${p.pull_request.number}: ${String(p.pull_request.title || '').slice(0, 120)}`;
  } else if (p?.issue?.number) {
    summary = `${route} #${p.issue.number}: ${String(p.issue.title || '').slice(0, 120)}`;
  }

  const excerpt: Record<string, unknown> = {
    event: normalizedEvent,
    action,
    ...(run_id ? { run_id } : {}),
    ...(head_sha ? { head_sha } : {}),
    ...(branch ? { branch } : {}),
    ...(object_numbers.length ? { object_numbers } : {}),
    ...(conclusion ? { conclusion } : {}),
    ...(p?.sender?.login ? { sender: String(p.sender.login) } : {}),
  };
  if (p?.workflow_run) {
    excerpt.workflow_run = {
      id: p.workflow_run.id,
      name: p.workflow_run.name ?? null,
      path: p.workflow_run.path ?? null,
      workflow_id: p.workflow_run.workflow_id ?? null,
      run_number: p.workflow_run.run_number ?? null,
      run_attempt: p.workflow_run.run_attempt ?? null,
      event: p.workflow_run.event ?? null,
      status: p.workflow_run.status ?? null,
      conclusion: p.workflow_run.conclusion ?? null,
      head_branch: p.workflow_run.head_branch ?? null,
      head_sha: p.workflow_run.head_sha ?? null,
      html_url: p.workflow_run.html_url ?? null,
    };
  }
  if (p?.check_suite) {
    excerpt.check_suite = {
      id: p.check_suite.id,
      status: p.check_suite.status ?? null,
      conclusion: p.check_suite.conclusion ?? null,
      head_branch: p.check_suite.head_branch ?? null,
      head_sha: p.check_suite.head_sha ?? null,
      app: p.check_suite.app?.slug ?? p.check_suite.app?.name ?? null,
    };
  }
  if (p?.check_run) {
    excerpt.check_run = {
      id: p.check_run.id,
      name: p.check_run.name ?? null,
      status: p.check_run.status ?? null,
      conclusion: p.check_run.conclusion ?? null,
      head_sha: p.check_run.head_sha ?? null,
      html_url: p.check_run.html_url ?? null,
    };
  }
  if (p?.comment) {
    excerpt.comment = {
      id: p.comment.id,
      author: p.comment.user?.login ?? null,
      html_url: p.comment.html_url ?? null,
      body: clip(p.comment.body, 1500),
    };
  }
  if (p?.review) {
    excerpt.review = {
      id: p.review.id,
      state: p.review.state ?? null,
      author: p.review.user?.login ?? null,
      html_url: p.review.html_url ?? null,
      body: clip(p.review.body, 1500),
    };
  }
  if (p?.pull_request) {
    excerpt.pull_request = {
      number: p.pull_request.number,
      state: p.pull_request.state ?? null,
      merged: p.pull_request.merged ?? null,
      draft: p.pull_request.draft ?? null,
      title: String(p.pull_request.title ?? '').slice(0, 240),
      head_sha: p.pull_request.head?.sha ?? null,
      head_ref: p.pull_request.head?.ref ?? null,
      base_ref: p.pull_request.base?.ref ?? null,
      html_url: p.pull_request.html_url ?? null,
    };
  } else if (p?.issue) {
    excerpt.issue = {
      number: p.issue.number,
      state: p.issue.state ?? null,
      title: String(p.issue.title ?? '').slice(0, 240),
      html_url: p.issue.html_url ?? null,
    };
  }

  return {
    event: normalizedEvent,
    action,
    route,
    run_id,
    workflow_candidates,
    head_sha,
    branch,
    object_numbers,
    conclusion,
    summary: summary.slice(0, 300),
    excerpt,
  };
}

function isBotCommentEcho(store: Store, repositoryId: string, event: string, payload: Json): boolean {
  const p = payload as any;
  let body = '';
  let authorId: string | null = null;
  if (event === 'issue_comment' || event === 'pull_request_review_comment') {
    body = String(p?.comment?.body ?? '');
    authorId = p?.comment?.user?.id != null ? String(p.comment.user.id) : p?.sender?.id != null ? String(p.sender.id) : null;
  } else if (event === 'pull_request_review') {
    body = String(p?.review?.body ?? '');
    authorId = p?.review?.user?.id != null ? String(p.review.user.id) : p?.sender?.id != null ? String(p.sender.id) : null;
  } else {
    return false;
  }

  // Verify against recorded effects/writes or the repository's own authenticated bot actor (never a bare spoofable HTML comment).
  const botActor = store.hasTable('github_actors')
    ? store.get('SELECT a.actor_id FROM repositories r JOIN github_actors a ON a.account_id=r.account_id WHERE r.id=?', repositoryId)?.actor_id
    : null;
  if (botActor != null && authorId !== null && String(botActor) === authorId) return true;

  for (const match of body.matchAll(/<!-- dept-bot:([a-f0-9]{48}) -->/g)) {
    if (
      store.hasTable('github_effects') &&
      store.get('SELECT 1 FROM github_effects e JOIN tasks t ON t.id=e.task_id WHERE e.id=? AND t.repository_id=?', match[1]!, repositoryId)
    ) {
      return true;
    }
  }
  for (const match of body.matchAll(/<!-- dept-bot-write:([a-f0-9]{24}) -->/g)) {
    if (store.hasTable('github_writes') && store.get('SELECT 1 FROM github_writes WHERE marker=? AND repository_id=?', match[1]!, repositoryId)) {
      return true;
    }
  }
  return false;
}

function subscriptionDirectlyMatches(sub: EventSubscriptionView, facts: ExtractedWebhookFacts): boolean {
  const eventMatched = sub.events.includes('*') || sub.events.includes(facts.event);
  if (!eventMatched) return false;

  const expectedAction = typeof sub.hints.action === 'string' && sub.hints.action ? sub.hints.action.toLowerCase() : null;
  if (expectedAction && expectedAction !== '*') {
    if (facts.action !== expectedAction) return false;
  } else if (completionDefaultEvents.has(facts.event)) {
    if (facts.action !== 'completed') return false;
  }

  if (sub.hints.run_id !== undefined && facts.run_id !== Number(sub.hints.run_id)) return false;

  if (sub.hints.workflow !== undefined) {
    const wanted = String(sub.hints.workflow).trim().toLowerCase();
    const wantedBase = basenameOf(wanted) ?? wanted;
    const matchedWorkflow = facts.workflow_candidates.some(candidate => candidate === wanted || candidate === wantedBase || basenameOf(candidate) === wantedBase);
    if (!matchedWorkflow) return false;
  }

  if (sub.hints.head_sha !== undefined) {
    const wantedSha = String(sub.hints.head_sha).trim().toLowerCase();
    if (!facts.head_sha || !facts.head_sha.startsWith(wantedSha)) return false;
  }

  if (sub.hints.branch !== undefined) {
    const wantedBranch = String(sub.hints.branch).trim().replace(/^refs\/heads\//, '').toLowerCase();
    if (facts.branch !== wantedBranch) return false;
  }

  if (sub.hints.object_number !== undefined) {
    if (!facts.object_numbers.includes(Number(sub.hints.object_number))) return false;
  }

  if (sub.hints.conclusion !== undefined) {
    if (facts.conclusion !== String(sub.hints.conclusion).trim().toLowerCase()) return false;
  }

  return true;
}

function wakeTaskFromSubscription(
  store: Store,
  task: Row,
  wakeup: {
    subscription_id: string;
    wake_reason: EventWakeReason;
    woken_at: string;
    delivery_id: string | null;
    event: string | null;
    action: string | null;
    summary: string;
    note: string | null;
    hints: EventSubscriptionHints;
    payload_excerpt: Record<string, unknown> | null;
  },
): boolean {
  let input: Record<string, any> = {};
  try { input = JSON.parse(String(task.input || '{}')); } catch { input = {}; }
  const existingWakeups = Array.isArray(input.event_wakeups) ? input.event_wakeups : [];
  const nextWakeups = [...existingWakeups, wakeup].slice(-20);
  const nextInput = storedInput(store, { ...input, event_wakeups: nextWakeups }, task.repository_id);
  store.run('UPDATE tasks SET input=?,updated_at=? WHERE id=?', nextInput, wakeup.woken_at, task.id);

  traceEvent(
    store,
    String(task.id),
    wakeup.wake_reason === 'timeout' ? 'event_subscription_timed_out' : 'event_subscription_woken',
    wakeup,
    null,
    'framework',
  );
  insertTaskLog(
    store,
    task,
    JSON.stringify({
      type: 'event_wakeup',
      subscription_id: wakeup.subscription_id,
      wake_reason: wakeup.wake_reason,
      event: wakeup.event,
      action: wakeup.action,
      detail:
        wakeup.wake_reason === 'timeout'
          ? `事件订阅已达超时时间，自动唤醒任务核对最新状态：${wakeup.summary}`
          : wakeup.wake_reason === 'manager_assigned'
            ? `Manager 将仓库事件关联到该订阅并唤醒任务：${wakeup.summary}`
            : wakeup.wake_reason === 'operator_cancelled'
              ? wakeup.summary
              : `命中订阅事件，自动唤醒任务继续执行：${wakeup.summary}`,
    }),
  );

  // Only transition to queued immediately if the task is currently parked in waiting_event.
  // If the task is still tearing down its runner (status='running') or already queued/running,
  // TaskEngine.run catch & resumeExpiredEventSubscriptions will observe the wakeup cleanly.
  if (task.status === 'waiting_event') {
    const targetPhase = task.phase === 'prepare' ? 'prepare' : 'model';
    const resumed = store.run(
      `UPDATE tasks
       SET status='queued',
           phase=?,
           error_code=NULL,
           next_run_at=0,
           wait_count=0,
           attempt=attempt+1,
           updated_at=?
       WHERE id=? AND status='waiting_event'`,
      targetPhase,
      wakeup.woken_at,
      task.id,
    );
    return Number(resumed.changes) > 0;
  }
  return false;
}

export function matchWebhookSubscriptions(
  store: Store,
  repositoryId: string,
  event: string,
  payload: Json,
  deliveryRecordId: string,
  now = Date.now(),
): { matched: string[]; tasksWoken: string[] } {
  if (!store.hasTable('event_subscriptions') || isBotCommentEcho(store, repositoryId, event, payload)) {
    return { matched: [], tasksWoken: [] };
  }
  const activeRows = store
    .all(
      "SELECT * FROM event_subscriptions WHERE repository_id=? AND state='active' AND timeout_at>? ORDER BY created_at ASC, rowid ASC",
      repositoryId,
      now,
    )
    .map(parseRow);
  if (!activeRows.length) return { matched: [], tasksWoken: [] };

  const facts = extractWebhookSubscriptionFacts(event, payload);
  const matched: string[] = [];
  const tasksWoken = new Set<string>();
  const nowIso = new Date(now).toISOString();

  for (const sub of activeRows) {
    if (!subscriptionDirectlyMatches(sub, facts)) continue;
    const task = store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?', sub.task_id, repositoryId);
    if (!task || terminalStatuses.includes(String(task.status))) {
      store.run(
        "UPDATE event_subscriptions SET state='cancelled',wake_reason='task_inactive',updated_at=?,resolved_at=? WHERE id=? AND state='active'",
        nowIso,
        nowIso,
        sub.id,
      );
      continue;
    }
    const changed = store.run(
      `UPDATE event_subscriptions
       SET state='matched',
           wake_reason='webhook_matched',
           matched_delivery_id=?,
           matched_event=?,
           matched_summary=?,
           updated_at=?,
           resolved_at=?
       WHERE id=? AND state='active'`,
      deliveryRecordId,
      facts.route,
      facts.summary,
      nowIso,
      nowIso,
      sub.id,
    );
    if (!changed.changes) continue;
    matched.push(sub.id);
    if (
      wakeTaskFromSubscription(store, task, {
        subscription_id: sub.id,
        wake_reason: 'webhook_matched',
        woken_at: nowIso,
        delivery_id: deliveryRecordId,
        event: facts.event,
        action: facts.action,
        summary: facts.summary,
        note: sub.note || null,
        hints: sub.hints,
        payload_excerpt: facts.excerpt,
      })
    ) {
      tasksWoken.add(String(task.id));
    }
  }

  if (tasksWoken.size) notifyWake();
  return { matched, tasksWoken: [...tasksWoken] };
}

export function shouldFallbackWebhookToManager(
  store: Store,
  repositoryId: string,
  event: string,
  payload: Json,
  now = Date.now(),
): boolean {
  if (!store.hasTable('event_subscriptions') || isBotCommentEcho(store, repositoryId, event, payload)) return false;
  const activeRows = store
    .all("SELECT * FROM event_subscriptions WHERE repository_id=? AND state='active' AND timeout_at>?", repositoryId, now)
    .map(parseRow);
  if (!activeRows.length) return false;

  const normalizedEvent = event === 'issue' ? 'issues' : event;
  const action = typeof (payload as any)?.action === 'string' ? String((payload as any).action).toLowerCase() : null;
  if (completionDefaultEvents.has(normalizedEvent) && action !== 'completed') {
    const wantsNonTerminal = activeRows.some(sub => {
      const a = typeof sub.hints.action === 'string' ? sub.hints.action.toLowerCase() : null;
      return a === '*' || (a !== null && a === action);
    });
    if (!wantsNonTerminal) return false;
  }
  return true;
}

export function activeRepositorySubscriptions(store: Store, repositoryId: string, now = Date.now()) {
  if (!store.hasTable('event_subscriptions')) return [];
  return store
    .all(
      `SELECT s.*, t.summary AS task_summary, t.status AS task_status, t.kind AS task_kind
       FROM event_subscriptions s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.repository_id=? AND s.state='active' AND s.timeout_at>?
         AND t.status NOT IN (${terminalStatuses.map(v => `'${v}'`).join(',')})
       ORDER BY s.created_at ASC, s.rowid ASC
       LIMIT 30`,
      repositoryId,
      now,
    )
    .map(row => {
      const parsed = parseRow(row);
      return {
        subscription_id: parsed.id,
        task_id: parsed.task_id,
        task_kind: String(row.task_kind),
        task_status: String(row.task_status),
        task_summary: String(row.task_summary).slice(0, 200),
        object: parsed.object_number ? { type: parsed.object_type, number: parsed.object_number } : null,
        events: parsed.events,
        hints: parsed.hints,
        note: parsed.note || null,
        timeout_at: new Date(parsed.timeout_at).toISOString(),
        created_at: parsed.created_at,
      };
    });
}

export function listRepositorySubscriptionsForManager(store: Store, repositoryId: string, rawArgs: unknown): Json {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  if (Object.keys(args).some(k => !['state', 'task_id'].includes(k))) return { error: 'invalid_arguments' };
  const stateFilter = args.state === 'all' ? 'all' : 'active';
  const taskId = typeof args.task_id === 'string' && args.task_id.trim() ? args.task_id.trim() : null;
  if (!store.hasTable('event_subscriptions')) return { subscriptions: [] };

  const clauses = ['s.repository_id=?'];
  const sqlArgs: (string | number)[] = [repositoryId];
  if (stateFilter === 'active') {
    clauses.push("s.state='active' AND s.timeout_at>?");
    sqlArgs.push(Date.now());
  }
  if (taskId) {
    clauses.push('s.task_id=?');
    sqlArgs.push(taskId);
  }
  const rows = store.all(
    `SELECT s.*, t.summary AS task_summary, t.status AS task_status, t.kind AS task_kind
     FROM event_subscriptions s
     JOIN tasks t ON t.id = s.task_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY CASE WHEN s.state='active' THEN 0 ELSE 1 END, s.created_at DESC, s.rowid DESC
     LIMIT 50`,
    ...sqlArgs,
  );
  return {
    subscriptions: rows.map(row => {
      const parsed = parseRow(row);
      return {
        subscription_id: parsed.id,
        task_id: parsed.task_id,
        task_kind: String(row.task_kind),
        task_status: String(row.task_status),
        task_summary: String(row.task_summary).slice(0, 200),
        state: parsed.state,
        events: parsed.events,
        hints: parsed.hints,
        note: parsed.note || null,
        timeout_at: new Date(parsed.timeout_at).toISOString(),
        wake_reason: parsed.wake_reason,
        matched_event: parsed.matched_event,
        created_at: parsed.created_at,
        resolved_at: parsed.resolved_at,
      };
    }),
  };
}

export function resolveSubscriptionsByManager(store: Store, taskId: string, dispatchEvent: Row, reason: string): boolean {
  if (!store.hasTable('event_subscriptions')) return false;
  const task = store.get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!task) return false;
  const active = store
    .all("SELECT * FROM event_subscriptions WHERE task_id=? AND state='active' ORDER BY created_at ASC, rowid ASC", taskId)
    .map(parseRow);
  const nowIso = new Date().toISOString();
  let eventFacts: Record<string, unknown> = {};
  try { eventFacts = JSON.parse(String(dispatchEvent.facts || '{}')); } catch { eventFacts = {}; }

  if (active.length) {
    // Prefer subscriptions whose event type matches the webhook, else resolve the oldest active subscription on this task.
    const webhookEvent = String((eventFacts as any)?.webhook_event ?? dispatchEvent.type ?? '').split('.')[0]!;
    const matching = active.filter(s => s.events.includes('*') || s.events.includes(webhookEvent));
    const targets = matching.length ? matching : [active[0]!];
    for (const sub of targets) {
      store.run(
        `UPDATE event_subscriptions
         SET state='matched',
             wake_reason='manager_assigned',
             matched_delivery_id=?,
             matched_event=?,
             matched_summary=?,
             updated_at=?,
             resolved_at=?
         WHERE id=? AND state='active'`,
        dispatchEvent.delivery_id ?? null,
        String(dispatchEvent.type),
        String(dispatchEvent.summary).slice(0, 300),
        nowIso,
        nowIso,
        sub.id,
      );
      wakeTaskFromSubscription(store, task, {
        subscription_id: sub.id,
        wake_reason: 'manager_assigned',
        woken_at: nowIso,
        delivery_id: dispatchEvent.delivery_id ? String(dispatchEvent.delivery_id) : null,
        event: String(dispatchEvent.type),
        action: typeof (eventFacts as any)?.action === 'string' ? String((eventFacts as any).action) : null,
        summary: `${String(dispatchEvent.summary)}（Manager：${reason.slice(0, 200)}）`,
        note: sub.note || null,
        hints: sub.hints,
        payload_excerpt: eventFacts,
      });
    }
    const freshTask = store.get('SELECT * FROM tasks WHERE id=?', taskId);
    if (freshTask?.status === 'queued') notifyWake();
    return true;
  }

  if (task.status === 'waiting_event') {
    const woke = wakeTaskFromSubscription(store, task, {
      subscription_id: 'manager:' + String(dispatchEvent.id),
      wake_reason: 'manager_assigned',
      woken_at: nowIso,
      delivery_id: dispatchEvent.delivery_id ? String(dispatchEvent.delivery_id) : null,
      event: String(dispatchEvent.type),
      action: null,
      summary: `${String(dispatchEvent.summary)}（Manager：${reason.slice(0, 200)}）`,
      note: null,
      hints: {},
      payload_excerpt: eventFacts,
    });
    if (woke) notifyWake();
    return woke;
  }
  return false;
}

export function resumeExpiredEventSubscriptions(store: Store, active: (taskId: string) => boolean, now = Date.now()): string[] {
  if (!store.hasTable('event_subscriptions')) return [];
  const woken: string[] = [];
  const nowIso = new Date(now).toISOString();

  const expired = store
    .all("SELECT * FROM event_subscriptions WHERE state='active' AND timeout_at<=? ORDER BY timeout_at ASC, rowid ASC LIMIT 100", now)
    .map(parseRow);

  for (const sub of expired) {
    if (active(sub.task_id)) continue;
    store.transaction(() => {
      const task = store.get('SELECT * FROM tasks WHERE id=?', sub.task_id);
      if (!task || terminalStatuses.includes(String(task.status))) {
        store.run(
          "UPDATE event_subscriptions SET state='cancelled',wake_reason='task_inactive',updated_at=?,resolved_at=? WHERE id=? AND state='active'",
          nowIso,
          nowIso,
          sub.id,
        );
        return;
      }
      const changed = store.run(
        `UPDATE event_subscriptions
         SET state='timed_out',
             wake_reason='timeout',
             matched_summary=?,
             updated_at=?,
             resolved_at=?
         WHERE id=? AND state='active'`,
        `等待 ${sub.events.join('/')} 超时`,
        nowIso,
        nowIso,
        sub.id,
      );
      if (!changed.changes) return;
      if (
        wakeTaskFromSubscription(store, task, {
          subscription_id: sub.id,
          wake_reason: 'timeout',
          woken_at: nowIso,
          delivery_id: null,
          event: sub.events[0] ?? null,
          action: null,
          summary: formatSubscriptionWaitSummary(sub),
          note: sub.note || null,
          hints: sub.hints,
          payload_excerpt: null,
        })
      ) {
        woken.push(String(task.id));
      }
    });
  }

  // Safety net: if a webhook matched while a task was still finishing its runner teardown into waiting_event,
  // resume any waiting_event task that no longer holds an active subscription.
  for (const stranded of store.all(
    `SELECT * FROM tasks t
     WHERE t.status='waiting_event'
       AND NOT EXISTS (SELECT 1 FROM event_subscriptions s WHERE s.task_id=t.id AND s.state='active')
     LIMIT 100`,
  )) {
    if (active(String(stranded.id))) continue;
    store.transaction(() => {
      const targetPhase = stranded.phase === 'prepare' ? 'prepare' : 'model';
      const changed = store.run(
        `UPDATE tasks
         SET status='queued',
             phase=?,
             error_code=NULL,
             next_run_at=0,
             wait_count=0,
             attempt=attempt+1,
             updated_at=?
         WHERE id=? AND status='waiting_event'`,
        targetPhase,
        nowIso,
        stranded.id,
      );
      if (changed.changes) woken.push(String(stranded.id));
    });
  }

  return woken;
}

export function pruneEventSubscriptions(store: Store, repositoryId: string, beforeIso: string, limit = 500): number {
  if (!store.hasTable('event_subscriptions')) return 0;
  return Number(
    store.run(
      `DELETE FROM event_subscriptions
       WHERE rowid IN (
         SELECT rowid FROM event_subscriptions
         WHERE repository_id=? AND state<>'active' AND COALESCE(resolved_at, updated_at)<?
         ORDER BY updated_at ASC
         LIMIT ?
       )`,
      repositoryId,
      beforeIso,
      limit,
    ).changes,
  );
}
