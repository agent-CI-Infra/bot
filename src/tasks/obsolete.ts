import type { Store, Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { failureCause, type FailureCause } from '../agent/failures.js';
import { traceEvent } from './trace.js';

// #713: a task waiting for a person stays in 待处理 until someone acts, even when nobody ever needs to: a newer task of the
// same work took over, the Issue or PR was closed or merged, or it failed for a platform reason long ago and nothing
// happened since. This sweep moves such tasks out of the list into a state that is not a request for a person (as the bot's
// own stop is since #655), keeps everything they recorded, and leaves them retryable by hand.

export type ObsoleteRule = 'superseded' | 'closed' | 'expired';
// Every rule leaves `cancelled`, the state of the bot's own stop (#655), with its reason code. The board then shows a
// card whose newest task was dismissed where the newest task that was not stopped this way left it (settledStatusSQL),
// so a dismissed failure newer by updated_at than the review that took over shows that review, not 未检视 as
// `superseded` would.
export const obsoleteOutcomes: Record<ObsoleteRule, { status: 'cancelled', code: string }> = {
  superseded: { status: 'cancelled', code: 'obsolete_superseded' },
  closed: { status: 'cancelled', code: 'obsolete_closed' },
  expired: { status: 'cancelled', code: 'obsolete_expired' },
};
// States in 待处理 that the engine never resumes by itself. `paused` is a person's own hold and is never swept;
// waiting_configuration, waiting_environment, waiting_pr_head and retry_wait resume on their own and are left to it.
// A wait for a person (a permission, a publication whose GitHub write is unconfirmed, a help request or a new plan) goes
// only when a newer task took the work over or its object is closed; only a plain failure expires with age.
const swept = ['failed', 'waiting_permission', 'waiting_publication', 'needs_replan', 'needs_help'];
// Causes of a failure that belong to the platform or were transient (failures.ts), not to the work or a person's setting:
// GitHub rate limits and outages, conflicts after a crash, context and response limits, model and runtime faults.
const platformCauses = new Set<FailureCause>(['external', 'model', 'environment', 'bot']);
// The catalog files a context over the request limit under the repository's content, since rules and prompt files can cause
// it; an old one is a context limit all the same, and the bot's own handling of those has changed since (#278, #279).
const platformCodes = new Set(['agent_context_too_large']);
// The work kinds whose object_number is an Issue or PR number.
const objectKind = /\.(issue|pr)$/;

/** Days after which a platform failure with no activity since leaves 待处理: BOT_OBSOLETE_FAILURE_DAYS, 7 by default. */
export function obsoleteAfterDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.BOT_OBSOLETE_FAILURE_DAYS ?? 7);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

export type ObsoleteDecision = { task: Row, rule: ObsoleteRule, evidence: Record<string, unknown> };
type Work = { repository_id: string, kind: string, object_number: number | null };

export class ObsoleteSweep {
  // Facts that never change for a task: the object a follow-up came from, and a failure's code (a new failure changes
  // updated_at). Reading them reads a whole tasks row, whose input (about 1 MB in production) comes before them.
  private readonly sources = new Map<string, { repository_id: string, type: string, number: number, via: string } | null>();
  private readonly codes = new Map<string, { updated_at: string, code: string | null }>();
  private first: ReturnType<typeof setTimeout> | undefined; private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly store: Store, readonly options: { batch?: number, days?: number, firstDelayMs?: number, intervalMs?: number, log?: (line: string) => void } = {}) {}
  start() {
    this.first = setTimeout(() => this.run(), this.options.firstDelayMs ?? 2 * 60_000); this.first.unref();
    this.timer = setInterval(() => this.run(), this.options.intervalMs ?? 15 * 60_000); this.timer.unref();
  }
  close() { clearTimeout(this.first); clearInterval(this.timer); }
  // One background round: at most `batch` tasks, the oldest first; the next round goes on where this one stopped.
  run(work?: Work) {
    try {
      const moved = this.sweep({ work });
      if (moved.length) (this.options.log ?? console.log)(`[obsolete] moved ${moved.length} task(s) out of 待处理: `
        + moved.map(d => `${d.task.id.slice(0, 8)} ${d.task.status}->${obsoleteOutcomes[d.rule].status} (${obsoleteOutcomes[d.rule].code})`).join(', '));
      return moved;
    } catch (error) { console.error('[obsolete] sweep failed:', error); return []; }
  }
  /** Moves the obsolete tasks found among `work` (or every project) out of 待处理, at most `batch`, and returns them. */
  sweep({ work, now = Date.now() }: { work?: Work, now?: number } = {}): ObsoleteDecision[] {
    const moved: ObsoleteDecision[] = [], batch = this.options.batch ?? 25;
    for (const decision of this.candidates({ work, now })) {
      if (moved.length >= batch) break;
      if (this.dismiss(decision, now)) moved.push(decision);
    }
    return moved;
  }
  /** The tasks in 待处理 that are obsolete now, oldest first, with the rule and its evidence. */
  candidates({ work, now = Date.now() }: { work?: Work, now?: number } = {}): ObsoleteDecision[] {
    // Only columns of board_task_cover, read from it alone (without the hint, the per-work read takes board_task_object
    // and reads each row's input to reach updated_at); the rows themselves are read only for the few facts it lacks.
    const filter = work ? ' AND kind=? AND repository_id=? AND object_number IS ?' : '';
    const rows = this.store.all(`SELECT id,repository_id,kind,object_number,status,created_at,updated_at FROM tasks INDEXED BY board_task_cover
      WHERE status IN (${swept.map(() => '?').join(',')})${filter} ORDER BY created_at,id`,
      ...swept, ...(work ? [work.kind, work.repository_id, work.object_number] : []));
    const cutoff = new Date(now - (this.options.days ?? obsoleteAfterDays()) * 86400_000).toISOString(), out: ObsoleteDecision[] = [];
    for (const task of rows) {
      const decision = this.superseded(task) ?? this.closed(task) ?? this.expired(task, cutoff, now);
      if (decision) out.push(decision);
    }
    return out;
  }
  // 1. A newer task of the same kind on the same Issue or PR exists that the bot did not stop by itself (#655's cancelled).
  private superseded(task: Row): ObsoleteDecision | null {
    if (task.object_number == null || !objectKind.test(String(task.kind))) return null;
    const newer = this.store.get(`SELECT id,status,created_at FROM tasks INDEXED BY board_task_cover WHERE kind=? AND repository_id=? AND object_number=?
      AND (created_at>? OR created_at=? AND id>?) AND status<>'cancelled' ORDER BY created_at DESC,id DESC LIMIT 1`,
      task.kind, task.repository_id, task.object_number, task.created_at, task.created_at, task.id);
    return newer ? { task, rule: 'superseded', evidence: { newer_task_id: newer.id, newer_status: newer.status, newer_created_at: newer.created_at } } : null;
  }
  // 2. The Issue or PR is closed or merged, as the webhook events recorded it; for a follow-up without an object of its own,
  // the one the task it came from works on. An object never seen closed stays.
  private closed(task: Row): ObsoleteDecision | null {
    const object = this.objectOf(task); if (!object) return null;
    const seen = this.store.get('SELECT github_state,state_at FROM board_objects WHERE repository_id=? AND object_type=? AND object_number=?', object.repository_id, object.type, object.number);
    if (seen?.github_state !== 'closed') return null;
    return { task, rule: 'closed', evidence: { object: `${object.type === 'pr' ? 'PR' : 'Issue'} #${object.number}`, github_state: 'closed', state_at: seen.state_at || null,
      ...(object.via ? { via_task_id: object.via } : {}) } };
  }
  private objectOf(task: Row) {
    if (task.object_number != null) return objectKind.test(String(task.kind)) ? { repository_id: String(task.repository_id), type: String(task.kind).endsWith('.pr') ? 'pr' : 'issue', number: Number(task.object_number), via: '' } : null;
    if (!this.sources.has(task.id)) {
      // A follow-up's source may itself be a follow-up: follow a short chain to the first task with an Issue or PR.
      let found = null, current = this.store.get('SELECT source_task_id FROM tasks WHERE id=?', task.id)?.source_task_id;
      for (let depth = 0; current && depth < 5 && !found; depth++) {
        const source = this.store.get('SELECT id,repository_id,kind,object_number,source_task_id FROM tasks WHERE id=?', current);
        if (source?.object_number != null && objectKind.test(String(source.kind)))
          found = { repository_id: String(source.repository_id), type: String(source.kind).endsWith('.pr') ? 'pr' : 'issue', number: Number(source.object_number), via: String(source.id) };
        current = source?.source_task_id;
      }
      this.sources.set(task.id, found);
    }
    return this.sources.get(task.id) ?? null;
  }
  // 3. A failure for a platform or transient reason, older than the configured days, with nothing done to the task since.
  private expired(task: Row, cutoff: string, now: number): ObsoleteDecision | null {
    const at = String(task.updated_at || task.created_at || '');
    if (task.status !== 'failed' || !at || at >= cutoff) return null;
    let known = this.codes.get(task.id);
    if (known?.updated_at !== at) { known = { updated_at: at, code: this.store.get('SELECT error_code FROM tasks WHERE id=?', task.id)?.error_code ?? null }; this.codes.set(task.id, known); }
    const cause = known.code ? failureCause(known.code, 'failed') : null;
    if (!cause || !platformCauses.has(cause) && !platformCodes.has(String(known.code))) return null;
    return { task, rule: 'expired', evidence: { failed_at: at, age_days: Math.floor((now - Date.parse(at)) / 86400_000), cause, error_code: known.code } };
  }
  /** Moves one task out of 待处理 if it is still in the state it was found in; false when it changed meanwhile. */
  dismiss(decision: ObsoleteDecision, now = Date.now()): boolean {
    const { task, rule, evidence } = decision, { status, code } = obsoleteOutcomes[rule], at = new Date(now).toISOString();
    return this.store.transaction(() => {
      const current = this.store.get('SELECT status,error_code FROM tasks WHERE id=?', task.id);
      if (current?.status !== task.status || this.store.get('SELECT 1 FROM task_claims WHERE task_id=?', task.id)) return false;
      // updated_at stays: the board takes the newest task of each object by it, and a dismissed old task must not become that.
      this.store.run('UPDATE tasks SET status=?,error_code=? WHERE id=? AND status=?', status, code, task.id, task.status);
      // The state it left and its failure stay on record next to the reason, for the timeline and for a retry by hand.
      const record = { rule, previous_status: current!.status, previous_error_code: current!.error_code ?? null, status, code, ...evidence };
      traceEvent(this.store, task.id, 'obsolete_dismissed', record, null, 'framework');
      this.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), task.id,
        JSON.stringify({ type: 'obsolete', ...record, detail: obsoleteDetail(record) }), at);
      return true;
    });
  }
}
// One sentence for the task's timeline.
function obsoleteDetail(record: Record<string, any>) {
  const was = `原状态 ${record.previous_status}${record.previous_error_code ? `（${record.previous_error_code}）` : ''}`;
  if (record.rule === 'superseded') return `同一对象上已有更新的同类任务 ${String(record.newer_task_id).slice(0, 8)}（${record.newer_status}），已自动移出待处理；${was}，可手动重试。`;
  if (record.rule === 'closed') return `${record.object} 已关闭或合入${record.via_task_id ? `（来源任务 ${String(record.via_task_id).slice(0, 8)} 的对象）` : ''}，已自动移出待处理；${was}，可手动重试。`;
  return `${record.age_days} 天前的平台类失败，之后没有新的动静，已自动移出待处理；${was}，可手动重试。`;
}
/** The state a task left when the sweep dismissed it, for a retry by hand; null for a task the sweep did not move. */
export function obsoleteOrigin(store: Store, task: Row): { status: string, error_code: string | null } | null {
  if (task.status !== 'cancelled' || !String(task.error_code || '').startsWith('obsolete_')) return null;
  const row = store.get("SELECT data FROM task_history WHERE task_id=? AND type='obsolete_dismissed' ORDER BY id DESC LIMIT 1", task.id);
  const data = row ? JSON.parse(row.data) : null;
  return data?.previous_status ? { status: String(data.previous_status), error_code: data.previous_error_code ?? null } : null;
}
