import type { Store, Row } from '../storage/database.js';
import { fail, fields, HttpError, randomId, text, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { traceClean } from '../tasks/trace.js';
import { boundedBatch, chatContextBytes, toolArguments, toolCallsProblem, ToolTranscript } from '../agent/tool-context.js';

// A service role's own independent tasks (#312): it works one question through in a separate context, with the same tools
// and permissions as the conversation that started it, and only the conclusion returns to that conversation. They are not
// project tasks (no repository, no board, no executor), take no configuration and never widen what the host conversation may do.
const fn = (name: string, description: string, properties: Json, required: string[] = []) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const instruction = { type: 'string', maxLength: 8000 };
export const ownTaskTools = [
  fn('start_own_task', 'Start one of your own independent tasks: work one question through in a separate context with the same tools and permissions as this conversation, and get back only its conclusion. Use it to keep this conversation tidy. It never widens your permissions.',
    { title: { type: 'string', maxLength: 200 }, instruction }, ['title', 'instruction']),
  fn('continue_own_task', 'Continue one of your own independent tasks of this conversation with a further instruction; it sees its earlier instructions and conclusions.',
    { task_id: { type: 'string' }, instruction }, ['task_id', 'instruction']),
  fn('list_own_tasks', 'List your own independent tasks of this conversation, newest first, with their latest conclusions.', {}),
];
export const ownTaskNames: readonly string[] = ownTaskTools.map(t => t.function.name);
const steps = 8, rounds = 20;
const suffix = '\n\nYou are now working on one of your own independent tasks, separate from the main conversation. Work only on the instruction below with the offered tools, then reply with a concise conclusion for the main conversation: findings, evidence (links, numbers, paths) and open points. Do not address the users directly and do not start further own tasks.';

/** Whose task it is. A changed fence (authorization or binding scope) hides older tasks, like the host's own history. */
export interface OwnTaskOwner { service_role_id: string; kind: 'management' | 'channel'; owner_id: string; principal_id: string; fence: string }
/** What the host lends a task: its system prompt, tools and executor, model request, guard and output cleaning (redaction;
 * the task bounds each result itself). */
export interface OwnTaskHost {
  owner: OwnTaskOwner; system: string; tools: () => Json[];
  request: (body: Json, label: string) => Promise<{ value?: any }>;
  execute: (name: string, args: unknown, key: string) => Promise<unknown>;
  check: () => unknown; redact: (value: string) => string; clean: (value: unknown) => unknown;
}

export class OwnTasks {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS service_role_own_tasks(id TEXT PRIMARY KEY,service_role_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('management','channel')),owner_id TEXT NOT NULL,principal_id TEXT NOT NULL,fence TEXT NOT NULL,
      title TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','completed','failed')),rounds INTEGER NOT NULL DEFAULT 0,history TEXT NOT NULL,
      error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS service_role_own_task_owner ON service_role_own_tasks(owner_kind,owner_id,updated_at)`);
    // A process restart cannot resume a model loop; the conclusion so far stays readable.
    store.run("UPDATE service_role_own_tasks SET state='failed',error='own_task_interrupted',updated_at=? WHERE state='running'", Date.now());
  }
  private history(row: Row): { instruction: string; conclusion: string; at: number }[] {
    return (this.store.secrets.open(row.history, 'own-task:' + row.id) as Json).rounds as any[];
  }
  private visible(owner: OwnTaskOwner): Row[] {
    return this.store.all(`SELECT * FROM service_role_own_tasks WHERE owner_kind=? AND owner_id=? AND service_role_id=? AND principal_id=? AND fence=?
      ORDER BY updated_at DESC,rowid DESC LIMIT 20`, owner.kind, owner.owner_id, owner.service_role_id, owner.principal_id, owner.fence);
  }
  list(owner: OwnTaskOwner): Json {
    return { own_tasks: this.visible(owner).map(row => ({ task_id: row.id, title: row.title, state: row.state, rounds: row.rounds, error: row.error ?? null,
      updated_at: row.updated_at, last_conclusion: (this.history(row).at(-1)?.conclusion ?? '').slice(0, 2000) })) };
  }
  /** Runs one own-task tool for the host. Failures are observations for the host model; a stopped host still stops. */
  async invoke(name: string, args: unknown, host: OwnTaskHost): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'invalid_arguments' };
    const input = args as Json;
    let row: Row | undefined;
    try {
      if (name === 'list_own_tasks') { fields(input, []); return this.list(host.owner); }
      if (name === 'start_own_task') {
        fields(input, ['title', 'instruction']);
        const id = randomId(), time = Date.now(), title = text(input.title, 200).trim() || '独立任务';
        this.store.run(`INSERT INTO service_role_own_tasks(id,service_role_id,owner_kind,owner_id,principal_id,fence,title,state,history,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'running',?,?,?)`, id, host.owner.service_role_id, host.owner.kind, host.owner.owner_id, host.owner.principal_id, host.owner.fence,
          title, this.store.secrets.seal({ rounds: [] }, 'own-task:' + id), time, time);
        row = this.store.get('SELECT * FROM service_role_own_tasks WHERE id=?', id)!;
      } else if (name === 'continue_own_task') {
        fields(input, ['task_id', 'instruction']);
        row = this.visible(host.owner).find(r => r.id === text(input.task_id, 100));
        if (!row) return { error: 'own_task_not_found', detail: '只能继续本会话当前可见的独立任务；授权或绑定变化后，旧的独立任务不再可见。' };
        if (row.state === 'running') return { error: 'own_task_running' };
        if (row.rounds >= rounds) return { error: 'own_task_round_limit', detail: '这个独立任务已达到轮次上限，请新建一个独立任务。' };
        this.store.run("UPDATE service_role_own_tasks SET state='running',error=NULL,updated_at=? WHERE id=?", Date.now(), row.id);
      } else return { error: 'tool_not_allowed' };
      return await this.work(row!, text(input.instruction, 8000), host);
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof TaskError)) throw error;
      if (row) this.store.run("UPDATE service_role_own_tasks SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'", error.code, Date.now(), row.id);
      await host.check();
      return { error: error.code, ...(row ? { task_id: row.id } : {}) };
    }
  }
  private async work(row: Row, request: string, host: OwnTaskHost): Promise<Json> {
    const previous = this.history(row), round = previous.length;
    // Own tasks run with the host's tools minus the own-task tools themselves: no recursion, nothing the host may not do.
    const tools = () => host.tools().filter(t => !ownTaskNames.includes((t as any).function.name));
    const messages: any[] = [{ role: 'system', content: host.system + suffix },
      { role: 'user', content: JSON.stringify({ own_task: { title: row.title, previous_rounds: previous }, instruction: request }) }];
    const transcript = new ToolTranscript(messages, chatContextBytes);
    for (let step = 0; step < steps; step++) {
      await host.check();
      const offered = tools(), body = { messages, tools: offered, tool_choice: offered.length ? 'auto' : 'none' };
      transcript.fit(body);
      const { value } = await host.request(body, 'own:' + row.id + ':' + round + ':' + step);
      const message = value?.choices?.[0]?.message;
      if (!message) fail(502, 'own_task_model_invalid');
      const calls = message.tool_calls ?? [];
      if (toolCallsProblem(calls)) fail(502, 'own_task_model_invalid');
      if (!calls.length) {
        const conclusion = host.redact(String(message.content ?? '')).slice(0, 8000);
        if (!conclusion.trim()) fail(502, 'own_task_reply_invalid');
        await host.check();
        this.store.run("UPDATE service_role_own_tasks SET state='completed',rounds=rounds+1,history=?,error=NULL,updated_at=? WHERE id=? AND state='running'",
          this.store.secrets.seal({ rounds: [...previous, { instruction: request, conclusion, at: Date.now() }] }, 'own-task:' + row.id), Date.now(), row.id);
        return { task_id: row.id, title: row.title, state: 'completed', round: round + 1, conclusion };
      }
      messages.push(traceClean(message));
      const results: unknown[] = [];
      for (const call of calls) {
        const name = call.function.name;
        results.push(host.clean(!tools().some(t => (t as any).function.name === name) ? { error: 'tool_not_allowed' }
          : await host.execute(name, toolArguments(call), 'own:' + row.id + ':' + round + ':' + step + ':' + call.id)));
      }
      boundedBatch(results).forEach((result, i) => messages.push({ role: 'tool', tool_call_id: calls[i].id, content: JSON.stringify(result) }));
    }
    return fail(502, 'own_task_turn_limit');
  }
}
