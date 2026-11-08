import { captureTaskConfiguration } from '../tasks/configuration.js';
import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import type { Redactor } from '../agent/common.js';
import type { PlatformTools } from '../agent/loop.js';
import { randomId } from '../core/security.js';

/**
 * A workflow that runs on an event rather than an Issue or PR: a release run to explain, release notes to draft, an
 * Actions run that failed. Its task runs like every other in the project computer, on a checkout of the commit concerned;
 * the module that owns the event prepares the context, checks the binding still holds, offers its own write tools and
 * takes the finished result back.
 */
export interface EventTarget {
  /** The commit to check out. */
  sha: string;
  /** Context files written next to the checkout (name under ../context/ → content) and their descriptions for the agent. */
  files: Record<string, string>;
  contextFiles: { path: string; content: string }[];
  /** Added to the agent's context: what the event is, the workflow prompt and its name. */
  context: Record<string, unknown>;
}
export interface EventWorkflow {
  prepare(store: Store, github: GitHub, task: Row, input: any, redactor: Redactor): Promise<EventTarget>;
  /** Stops the task when the event it works on has moved on (another attempt, a removed release). */
  validate(store: Store, task: Row, input: any): void;
  /** The module's own write tools; `state` collects what they recorded for finish. */
  tools?(store: Store, task: Row, input: any, writes: string[], state: Record<string, any>): PlatformTools;
  /** Checks the finished result and hands it to the module; returns what the task keeps as its result. */
  finish(store: Store, task: Row, input: any, result: any, state: Record<string, any>): Promise<any> | any;
  /** The task ended without a result (failed or cancelled); the module may record why. */
  ended?(store: Store, task: Row, code: string, detail?: string): void;
}
const registry = new Map<string, EventWorkflow>();
export const registerEventWorkflow = (kind: string, workflow: EventWorkflow) => { registry.set(kind, workflow); };
export const eventWorkflow = (kind: string) => registry.get(kind);

const active = ['queued', 'running', 'preparing', 'retry_wait', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'publishing'];
/** Still to run or running: the module waits for it. */
export const eventTaskActive = (task: Row | undefined) => !!task && active.includes(String(task.status));

/** Queues an event task once per key; returns the task (an existing one for the same key). */
export function enqueueEventTask(store: Store, repositoryId: string, kind: string, key: string, sha: string, input: Record<string, unknown>, summary: string): Row {
  const unique = `${repositoryId}:${kind}:${key}`, existing = store.get('SELECT * FROM tasks WHERE unique_key=?', unique);
  if (existing) return existing;
  const id = randomId(), now = new Date().toISOString();
  store.transaction(() => {
    store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,NULL,?,?,?)`,
      id, repositoryId, kind, summary, unique, JSON.stringify(input), sha, now, now);
    captureTaskConfiguration(store,id);
    store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), id,
      JSON.stringify({ type: 'queued', repository_id: repositoryId, detail: `排队中，等待仓库 ${repositoryId} 的虚拟电脑空闲…` }), now);
  });
  return store.get('SELECT * FROM tasks WHERE id=?', id)!;
}
