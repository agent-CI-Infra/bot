import type { Store, Row } from '../storage/database.js';
import { fail, fields, HttpError, randomId, text, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { assertCurrent, authorize, restrictActor, revision, type ActorContext } from '../identity/authorization.js';
import { localParts, nextTime, parseCron, previewTimes } from '../schedules/time.js';
import type { ChannelService } from './service.js';

// Prompt-driven timers mounted on a Feishu chat (#330). A private chat's timer runs its owner's management assistant; a bound
// group's timer runs the group's service role. The prompt is only the task: tools, projects and permissions stay the chat's own
// and are rechecked when the timer fires, before every tool call and before the reply is sent. Model usage and budget belong to
// that service role, as for any message in the chat.

const minute = 60000;
/** A timer whose occurrence is older than this when the worker sees it (the process was down) skips it instead of running late. */
const grace = 10 * minute;
const code = (error: unknown) => error instanceof HttpError || error instanceof TaskError ? error.code : 'channel_schedule_failed';
/** Lost authority or configuration (4xx) pauses the timer with that reason; a model or network fault only fails the one run. */
const authority = (error: unknown) => error instanceof HttpError && error.status === 403 || error instanceof TaskError && error.state === 'waiting_configuration';

interface Timing { timezone: string; cron?: string; interval_ms?: number; start_at: number }
const timing = (row: Row): Timing => ({ timezone: row.timezone, start_at: row.start_at, ...(row.cron ? { cron: row.cron } : { interval_ms: row.interval_ms }) });

export class ChannelSchedules {
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(readonly store: Store, readonly host: ChannelService, readonly clock = () => Date.now()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS channel_schedules(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES channel_chats(id),
      kind TEXT NOT NULL CHECK(kind IN ('personal','group')),owner_id TEXT,created_by TEXT NOT NULL,name TEXT NOT NULL,prompt TEXT NOT NULL,
      timezone TEXT NOT NULL,cron TEXT,interval_ms INTEGER,start_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','paused','deleted')),
      reason TEXT,revision INTEGER NOT NULL,conversation_id TEXT,next_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_schedules_due ON channel_schedules(state,next_at);
      CREATE INDEX IF NOT EXISTS channel_schedules_chat ON channel_schedules(chat_id,created_at);
      CREATE TABLE IF NOT EXISTS channel_schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES channel_schedules(id),
      logical_key TEXT NOT NULL,trigger TEXT NOT NULL CHECK(trigger IN ('timer','manual')),scheduled_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','completed','silent','failed','skipped')),error TEXT,schedule_revision INTEGER NOT NULL,
      message_id TEXT,turn_id TEXT,outbox_id TEXT,started_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(schedule_id,logical_key));
      CREATE INDEX IF NOT EXISTS channel_schedule_runs_recent ON channel_schedule_runs(schedule_id,created_at)`);
    // A restarted process cannot resume a model turn: the run is recorded as interrupted and never replayed.
    store.run("UPDATE channel_schedule_runs SET state='failed',error='channel_schedule_interrupted',updated_at=? WHERE state='running'", clock());
  }
  close(): void { this.stopped = true; }
  async drain(): Promise<void> { await Promise.allSettled([...this.running.values()]); }

  // --- Authority -------------------------------------------------------------------------------------------------------
  /** A private chat's owner whose Feishu binding for this chat's app is still active. */
  owner(chat: Row, principal: string): Row {
    const owner = this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', chat.id, principal);
    if (!owner) return fail(403, 'channel_schedule_forbidden');
    this.host.employees.feishuIdentity(chat, principal, { actor: owner.actor_id, tenant: owner.actor_tenant });
    if (!revision(this.store, principal)) fail(403, 'principal_inactive');
    return owner;
  }
  /** Who may change a chat's timers: a private chat's bound owner; for a group, whoever may manage its assistant binding. */
  private manage(actor: ActorContext, chat: Row): void {
    assertCurrent(actor);
    if (chat.chat_type === 'p2p') { this.owner(chat, actor.principal_id); return; }
    const binding = this.host.serviceBindings.canView(actor, chat.id);
    if (!binding?.enabled) fail(403, 'channel_schedule_forbidden');
    this.host.serviceBindings.assertUsable(binding!);
  }
  private platform(actor: ActorContext): boolean {
    try { authorize(actor, 'platform.manage'); return true; } catch (error) { if (!(error instanceof HttpError)) throw error; return false; }
  }
  /** Readers: the chat's managers, and platform managers for diagnosis (who may also pause a timer). */
  private readable(actor: ActorContext, chat: Row): boolean {
    try { this.manage(actor, chat); return true; } catch (error) { if (!(error instanceof HttpError) || !this.platform(actor)) throw error; return false; }
  }
  private schedule(id: string): Row {
    const row = this.store.get("SELECT * FROM channel_schedules WHERE id=? AND state<>'deleted'", id);
    if (!row) return fail(404, 'channel_schedule_not_found');
    return row;
  }

  // --- Configuration ---------------------------------------------------------------------------------------------------
  private spec(input: Json): { name: string; prompt: string; timezone: string; cron: string | null; interval_ms: number | null } {
    const name = text(input.name, 100), prompt = text(input.prompt, 8000), timezone = text(input.timezone, 64);
    localParts(this.clock(), timezone);
    const cron = input.cron === undefined || input.cron === null || input.cron === '' ? null : text(input.cron, 120);
    const minutes = input.interval_minutes === undefined || input.interval_minutes === null ? null : Number(input.interval_minutes);
    if ((cron === null) === (minutes === null)) fail(400, 'channel_schedule_recurrence_required');
    if (cron !== null) parseCron(cron);
    // At least five minutes apart: every run is a billable model conversation.
    if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 31 * 24 * 60)) fail(400, 'channel_schedule_interval_invalid');
    return { name, prompt, timezone, cron, interval_ms: minutes === null ? null : minutes * minute };
  }
  private next(row: Row, after: number): number | null { return nextTime(timing(row), after); }
  private prompt(row: Row): string { return String((this.store.secrets.open(row.prompt, 'channel-schedule:' + row.id) as Json).prompt); }
  view(row: Row, manageable = true): Json {
    const runs = this.store.all('SELECT * FROM channel_schedule_runs WHERE schedule_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5', row.id);
    return { id: row.id, chat_id: row.chat_id, kind: row.kind, name: row.name, prompt: this.prompt(row), timezone: row.timezone, cron: row.cron,
      interval_minutes: row.interval_ms ? row.interval_ms / minute : null, state: row.state, reason: row.reason, revision: row.revision,
      next_at: row.state === 'active' ? row.next_at : null, future: row.state === 'active' ? previewTimes(timing(row), this.clock(), 3) : [],
      runs: runs.map(r => ({ id: r.id, trigger: r.trigger, scheduled_at: r.scheduled_at, state: r.state, error: r.error, created_at: r.created_at, updated_at: r.updated_at })),
      can_manage: manageable, created_at: row.created_at, updated_at: row.updated_at };
  }
  list(actor: ActorContext, chatId: string): Json {
    const chat = this.host.employees.chat(chatId), manageable = this.readable(actor, chat);
    return { can_manage: manageable, schedules: this.store.all("SELECT * FROM channel_schedules WHERE chat_id=? AND state<>'deleted' ORDER BY created_at,rowid", chat.id).map(row => this.view(row, manageable)) };
  }
  preview(input: Json): Json {
    fields(input, ['name', 'prompt', 'timezone', 'cron', 'interval_minutes']);
    const spec = this.spec({ name: 'preview', prompt: 'preview', ...input });
    return { future: previewTimes({ timezone: spec.timezone, start_at: this.clock(), ...(spec.cron ? { cron: spec.cron } : { interval_ms: spec.interval_ms! }) }, this.clock(), 5) };
  }
  create(actor: ActorContext, chatId: string, input: Json): Json {
    fields(input, ['name', 'prompt', 'timezone', 'cron', 'interval_minutes', 'enabled']);
    const chat = this.host.employees.chat(chatId); this.manage(actor, chat);
    const spec = this.spec(input), id = randomId(), now = this.clock(), enabled = input.enabled !== false;
    const row = { ...spec, start_at: now };
    this.store.run(`INSERT INTO channel_schedules(id,chat_id,kind,owner_id,created_by,name,prompt,timezone,cron,interval_ms,start_at,state,reason,revision,next_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)`, id, chat.id, chat.chat_type === 'p2p' ? 'personal' : 'group', chat.chat_type === 'p2p' ? actor.principal_id : null,
      actor.principal_id, spec.name, this.store.secrets.seal({ prompt: spec.prompt }, 'channel-schedule:' + id), spec.timezone, spec.cron, spec.interval_ms, now,
      enabled ? 'active' : 'paused', enabled ? this.next(row, now) : null, now, now);
    this.store.audit(actor.principal_id, 'channel.schedule.created', id, chat.id);
    return { schedule: this.view(this.schedule(id)) };
  }
  update(actor: ActorContext, id: string, input: Json): Json {
    fields(input, ['expected_revision', 'name', 'prompt', 'timezone', 'cron', 'interval_minutes', 'enabled']);
    const old = this.schedule(id), chat = this.host.employees.chat(old.chat_id);
    if (input.expected_revision !== old.revision) fail(409, 'channel_schedule_revision_conflict');
    // Pausing is the one change a platform manager may make to someone else's timer.
    const pauseOnly = Object.keys(input).every(key => key === 'expected_revision' || key === 'enabled') && input.enabled === false;
    if (!(pauseOnly && this.platform(actor))) this.manage(actor, chat);
    const now = this.clock(), enabled = input.enabled === undefined ? old.state === 'active' : input.enabled === true;
    const spec = Object.keys(input).some(key => ['name', 'prompt', 'timezone', 'cron', 'interval_minutes'].includes(key)) ? this.spec(input) : undefined;
    // A new rhythm starts counting from this save; a resumed timer continues from now, never from missed occurrences.
    const row: Row = spec ? { ...old, ...spec, start_at: now } : old;
    this.store.run(`UPDATE channel_schedules SET name=?,prompt=?,timezone=?,cron=?,interval_ms=?,start_at=?,state=?,reason=?,revision=revision+1,next_at=?,updated_at=? WHERE id=?`,
      row.name, spec ? this.store.secrets.seal({ prompt: spec.prompt }, 'channel-schedule:' + id) : old.prompt, row.timezone, row.cron ?? null, row.interval_ms ?? null, row.start_at,
      enabled ? 'active' : 'paused', enabled ? null : old.state === 'active' ? 'user_paused' : old.reason, enabled ? this.next(row, now) : null, now, id);
    this.store.audit(actor.principal_id, 'channel.schedule.' + (spec ? 'updated' : enabled ? 'resumed' : 'paused'), id, chat.id);
    return { schedule: this.view(this.schedule(id)) };
  }
  remove(actor: ActorContext, id: string, input: Json): Json {
    fields(input, ['expected_revision']);
    const old = this.schedule(id); this.manage(actor, this.host.employees.chat(old.chat_id));
    if (input.expected_revision !== old.revision) fail(409, 'channel_schedule_revision_conflict');
    this.store.run("UPDATE channel_schedules SET state='deleted',next_at=NULL,revision=revision+1,updated_at=? WHERE id=?", this.clock(), id);
    this.store.audit(actor.principal_id, 'channel.schedule.deleted', id, old.chat_id);
    return { id, state: 'deleted' };
  }
  /** Run once now, whatever the timer's rhythm; one run of a timer at a time. */
  runNow(actor: ActorContext, id: string, input: Json): Json {
    fields(input, []);
    const row = this.schedule(id); this.manage(actor, this.host.employees.chat(row.chat_id));
    if (this.running.has(id)) fail(409, 'channel_schedule_running');
    const run = this.claim(row, 'manual:' + randomId(), this.clock(), 'manual', actor.principal_id);
    this.start(row, run!);
    return { run: { id: run, state: 'running' }, schedule: this.view(this.schedule(id)) };
  }

  // --- Firing ----------------------------------------------------------------------------------------------------------
  /** One run per logical occurrence: UNIQUE(schedule_id, logical_key) holds across restarts and concurrent workers. */
  private claim(row: Row, key: string, at: number, trigger: 'timer' | 'manual', by: string | null, state = 'running', error: string | null = null): string | null {
    const id = randomId(), now = this.clock();
    const result = this.store.run(`INSERT OR IGNORE INTO channel_schedule_runs(id,schedule_id,logical_key,trigger,scheduled_at,state,error,schedule_revision,started_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, row.id, key, trigger, at, state, error, row.revision, by, now, now);
    return Number(result.changes) ? id : null;
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.clock();
    for (const row of this.store.all("SELECT * FROM channel_schedules WHERE state='active' AND next_at IS NOT NULL AND next_at<=? ORDER BY next_at LIMIT 20", now)) {
      if (this.stopped) return;
      const due = row.next_at, late = now - due > grace, previous = this.running.has(row.id);
      // A group's live answer finishes first; the occurrence stays due until then (within the grace period).
      if (!late && !previous && row.kind === 'group' && this.host.chatBusy(row.chat_id)) continue;
      const claimed = this.store.transaction(() => {
        if (this.store.get('SELECT next_at FROM channel_schedules WHERE id=? AND state=?', row.id, 'active')?.next_at !== due) return null;
        this.store.run('UPDATE channel_schedules SET next_at=?,updated_at=? WHERE id=?', this.next(row, now), now, row.id);
        return this.claim(row, 'timer:' + due, due, 'timer', null, late || previous ? 'skipped' : 'running',
          late ? 'channel_schedule_missed' : previous ? 'channel_schedule_previous_run_active' : null);
      });
      if (claimed && !late && !previous) this.start(row, claimed);
    }
  }
  private start(row: Row, run: string): void {
    const work = this.execute(row, run).catch(error => {
      if (this.stopped) return; // Shutdown: restart records the run as interrupted.
      const reason = code(error);
      this.store.run("UPDATE channel_schedule_runs SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'", reason, this.clock(), run);
      if (authority(error)) this.store.run("UPDATE channel_schedules SET state='paused',reason=?,next_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND state='active'", reason, this.clock(), row.id);
    }).finally(() => this.running.delete(row.id));
    this.running.set(row.id, work);
  }
  /** Before the run, every tool call and the send: the timer still exists unchanged and the chat's authority still holds. */
  private guard(id: string, run: string): void {
    if (this.stopped) fail(409, 'channel_stopped');
    const row = this.store.get('SELECT * FROM channel_schedules WHERE id=?', id), current = this.store.get('SELECT * FROM channel_schedule_runs WHERE id=?', run);
    if (!row || row.state === 'deleted' || !current || current.schedule_revision !== row.revision) fail(409, 'channel_schedule_changed');
    if (current!.state !== 'running') fail(409, 'channel_schedule_run_inactive');
    const chat = this.host.employees.chat(row!.chat_id);
    if (row!.kind === 'personal') { this.owner(chat, row!.owner_id); return; }
    const binding = this.host.serviceBindings.active(chat.id);
    if (!binding) fail(403, 'channel_service_binding_disabled');
    this.host.serviceBindings.assertUsable(binding!);
  }
  private finish(run: string, state: 'completed' | 'silent' | 'failed', error: string | null, outbox?: string): void {
    this.store.run('UPDATE channel_schedule_runs SET state=?,error=?,outbox_id=?,updated_at=? WHERE id=? AND state=?', state, error, outbox ?? null, this.clock(), run, 'running');
  }
  private async execute(row: Row, run: string): Promise<void> {
    const guard = () => this.guard(row.id, run);
    guard();
    const chat = this.host.employees.chat(row.chat_id), prompt = this.prompt(row);
    if (row.kind === 'personal') await this.personal(row, chat, run, prompt, guard);
    else await this.group(row, chat, run, prompt, guard);
  }
  private frame(row: Row, prompt: string): string {
    return `本条由本会话的定时任务「${row.name}」在 ${new Date(this.clock()).toLocaleString('zh-CN', { timeZone: row.timezone })}（${row.timezone}）触发，不是新发来的消息。请在当前权限内完成下面的任务并给出结果；如果任务说明允许在没有需要报告的内容时保持安静，而且确实没有，请只回复空内容。\n\n${prompt}`;
  }
  /** The owner's management assistant in a conversation of this timer, under the owner's current authority only. */
  private async personal(row: Row, chat: Row, run: string, prompt: string, guard: () => void): Promise<void> {
    const owner = this.owner(chat, row.owner_id);
    const actor = restrictActor(this.host.personalActor(owner.principal_id, chat, 'api'), guard), management = this.host.management;
    let conversation = row.conversation_id as string | null;
    if (!conversation || !this.store.get('SELECT 1 FROM management_conversations WHERE id=? AND principal_id=?', conversation, actor.principal_id)) {
      conversation = String((management.create(actor, { scope: this.host.personalScope(actor) }).conversation as Json).id);
      this.store.run('UPDATE channel_schedules SET conversation_id=? WHERE id=?', conversation, row.id);
    }
    const sent = management.send(actor, conversation, { content: this.frame(row, prompt), source_message: 'schedule:' + run });
    this.store.run('UPDATE channel_schedule_runs SET message_id=? WHERE id=?', String(sent.id), run);
    await management.active.get(String(sent.id))?.work;
    guard();
    const message = this.store.get('SELECT * FROM management_messages WHERE id=?', String(sent.id))!;
    const answer = this.store.get("SELECT data FROM management_events WHERE message_id=? AND type='reply' ORDER BY sequence DESC LIMIT 1", message.id);
    const operations = this.store.get('SELECT count(*) n FROM management_commands WHERE source_conversation=? AND source_message=?', conversation, message.source_message)!.n;
    if (message.state === 'completed' && !operations && !String(answer ? JSON.parse(answer.data).text ?? '' : '').trim()) { this.finish(run, 'silent', null); return; }
    const error = this.store.get("SELECT data FROM management_events WHERE message_id=? AND type='error' ORDER BY sequence DESC LIMIT 1", message.id);
    const outbox = this.host.post(chat, `定时任务「${row.name}」\n\n${this.host.personalReply(actor, message)}`, 'channel-schedule:' + run, 'schedule:' + run,
      { kind: 'channel_schedule', schedule_id: row.id, run_id: run, chat_id: chat.id, principal_id: actor.principal_id, authorization_revision: actor.authorization_revision });
    this.finish(run, message.state === 'completed' ? 'completed' : 'failed', message.state === 'completed' ? null : error ? JSON.parse(error.data).error : message.state, outbox);
  }
  /** One turn of the group's bound service role, with the group's scope and permissions; the group's live answers wait. */
  private async group(row: Row, chat: Row, run: string, prompt: string, guard: () => void): Promise<void> {
    const binding = this.host.serviceBindings.active(chat.id);
    if (!binding) return fail(403, 'channel_service_binding_disabled');
    const result = await this.host.exclusive(chat.id, () => this.host.serviceSessions.run({ chat, binding, source_message: 'schedule:' + run,
      request: this.frame(row, prompt), allowSilence: true, schedule: { name: row.name, guard } }));
    this.store.run('UPDATE channel_schedule_runs SET turn_id=? WHERE id=?', result.id, run);
    guard();
    if (!result.message.trim()) { this.finish(run, 'silent', null); return; }
    const outbox = this.host.post(chat, `定时任务「${row.name}」\n\n${result.message}`, 'channel-schedule:' + run, 'schedule:' + run,
      { kind: 'channel_schedule', schedule_id: row.id, run_id: run, chat_id: chat.id, binding_id: binding.id, binding_revision: binding.revision, turn_id: result.id, source_fence: result.fence });
    this.finish(run, 'completed', null, outbox);
  }

  // --- Checks for other paths ------------------------------------------------------------------------------------------
  /** Sending a timer's result: the timer still exists and the chat's authority is unchanged since the run. */
  guardDelivery(protection: Json): void {
    const row = this.store.get('SELECT * FROM channel_schedules WHERE id=?', String(protection.schedule_id));
    if (!row || row.state === 'deleted') fail(409, 'channel_schedule_changed');
    const chat = this.host.employees.chat(String(protection.chat_id));
    if (row!.chat_id !== chat.id) fail(409, 'channel_schedule_changed');
    if (row!.kind === 'personal') {
      this.owner(chat, String(protection.principal_id));
      if (revision(this.store, String(protection.principal_id)) !== protection.authorization_revision) fail(409, 'authorization_changed');
      return;
    }
    const binding = this.host.serviceBindings.get(chat.id);
    if (!binding || binding.id !== protection.binding_id || binding.revision !== protection.binding_revision) fail(409, 'conversation_source_changed');
    this.host.serviceBindings.assertUsable(binding!);
    const turn = this.store.get('SELECT state,fence FROM channel_service_turns WHERE id=?', String(protection.turn_id));
    if (turn?.state !== 'completed' || turn.fence !== protection.source_fence || this.host.serviceBindings.fence(chat.id) !== protection.source_fence) fail(409, 'conversation_source_changed');
  }
  /** A command a group's timer run submits: the run is live and belongs to this group, as a message source would. */
  sourceOfCommand(command: Row, run: string): void {
    const current = this.store.get("SELECT r.*,s.chat_id FROM channel_schedule_runs r JOIN channel_schedules s ON s.id=r.schedule_id WHERE r.id=? AND s.kind='group'", run);
    if (!current || current.chat_id !== command.source_conversation) fail(403, 'channel_command_source_required');
    this.guard(current!.schedule_id, run);
  }
}
