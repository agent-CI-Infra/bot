import { captureTaskConfiguration } from './configuration.js';
import { setGrant } from './grants.js';
import { TaskRecords } from './service.js';
import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import type { Redactor } from '../agent/common.js';
import type { PlatformTools } from '../agent/loop.js';
import { randomId } from '../core/security.js';

export interface EventTarget {
  sha: string;
  files: Record<string, string>;
  contextFiles: { path: string; content: string }[];
  context: Record<string, unknown>;
}

export interface EventWork {
  prepare(store: Store, github: GitHub, task: Row, input: any, redactor: Redactor): Promise<EventTarget>;
  validate(store: Store, task: Row, input: any): void;
  tools?(store: Store, task: Row, input: any, writes: string[], state: Record<string, any>): PlatformTools;
  checkResult?(store: Store, task: Row, input: any, result: any): void;
  finish(store: Store, task: Row, input: any, result: any, state: Record<string, any>): Promise<any> | any;
  ended?(store: Store, task: Row, code: string, detail?: string): void;
}

const registry = new Map<string, EventWork>();
export const registerEventWork = (adapterId: string, work: EventWork) => { registry.set(adapterId, work); };

export function eventAdapterId(task: Row | { kind?: unknown; input?: unknown }): string | null {
  const kind = String(task.kind ?? '');
  if (registry.has(kind)) return kind;
  if (typeof task.input === 'string' && task.input.includes('event_adapter')) {
    try {
      const adapter = JSON.parse(task.input)?.event_adapter;
      if (typeof adapter === 'string' && registry.has(adapter)) return adapter;
    } catch { /* ignore */ }
  }
  return null;
}

export const eventWork = (taskOrId: Row | string) =>
  typeof taskOrId === 'string' ? registry.get(taskOrId) : (() => { const id = eventAdapterId(taskOrId); return id ? registry.get(id) : undefined; })();

const active = ['queued', 'running', 'preparing', 'retry_wait', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'publishing'];
export const eventTaskActive = (task: Row | undefined) => !!task && active.includes(String(task.status));

/** Queues a generic event-bound task (`kind = 'task.request'`) once per key. */
export function enqueueEventTask(
  store: Store,
  repositoryId: string,
  adapterId: string,
  key: string,
  sha: string,
  input: Record<string, unknown>,
  summary: string,
  options: { writes?: string[]; kind?: string } = {},
): Row {
  const unique = `${repositoryId}:${adapterId}:${key}`, existing = store.get('SELECT * FROM tasks WHERE unique_key=?', unique);
  if (existing) return existing;
  const id = randomId(), now = new Date().toISOString(), kind = options.kind ?? adapterId;
  const payload = kind === 'task.request'
    ? { ...input, generic: true, event_adapter: adapterId, target: { type: 'commit', ref: sha } }
    : input;
  const contract = {
    goal: summary,
    scope: [adapterId],
    criteria: ['Deliver verified structured analysis using actual commit and log evidence.'],
    endpoint: 'report',
    source: { type: 'event', adapter: adapterId },
    completeness: 'explicit' as const,
  };
  store.transaction(() => {
    store.run(
      `INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,NULL,?,?,?)`,
      id, repositoryId, kind, summary, unique, JSON.stringify(kind === 'task.request' ? { ...payload, contract } : payload), sha, now, now,
    );
    new TaskRecords(store).contract(id, contract as any);
    if (kind === 'task.request' && options.writes) {
      setGrant(store, { id, repository_id: repositoryId }, options.writes, 'role:manager', null);
    }
    captureTaskConfiguration(store, id);
    store.run(
      'INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',
      randomId(), id, JSON.stringify({ type: 'queued', repository_id: repositoryId, detail: `排队中，等待仓库 ${repositoryId} 的虚拟电脑空闲…` }), now,
    );
  });
  return store.get('SELECT * FROM tasks WHERE id=?', id)!;
}
