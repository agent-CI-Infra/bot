import type { Row } from '../storage/database.js';
import { fail, HttpError, type Json } from '../core/security.js';
import type { ScheduleService } from './service.js';

/** The plan state a retired daily report keeps: it stays readable, but no longer runs, resumes or saves (#1027). */
const stopped = (migrated: boolean) => migrated ? 'migrated_to_chat_schedule' : 'daily_report_retired';
const minute = 60000;

/** What a migrated timer asks the chat's assistant: the old report's window, its facts, and nothing more. */
function prompt(repository: string, windowMs: number): string {
  const span = windowMs % 3600000 === 0 ? `${windowMs / 3600000} 小时` : `${Math.round(windowMs / minute)} 分钟`;
  return `汇报项目 ${repository} 过去 ${span}的情况：这段时间更新过的任务和它们现在的状态，失败的任务和原因，CI 与 GitHub Actions 的失败。`
    + '只写查到的事实并附上链接，查不到的写明没有记录，不要推测；只汇报，不要提 Issue、评论或修改任何东西。';
}

/**
 * #1027: a project no longer sends scheduled messages to Feishu. Each daily report plan becomes a timer on the chat it
 * was sent to, run by that chat's own assistant (the owner's management assistant in a private chat, the group's assistant
 * in a group), and the plan stops: paused with a reason, its saved spec kept as it was so it can be read back. Every
 * daily report plan gets one row in schedule_migrations, the migration report, whether it moved, failed or was skipped;
 * a plan with a row is never touched again, so this runs at every start and in every process without repeating itself.
 */
export function migrateDailyReports(service: ScheduleService): Row[] {
  const { store, channels } = service, report: Row[] = [];
  const plans = store.all(`SELECT id FROM schedules WHERE json_extract(spec,'$.workflow')='report.daily'
    AND NOT EXISTS(SELECT 1 FROM schedule_migrations m WHERE m.schedule_id=schedules.id) ORDER BY created_at,id`);
  for (const { id } of plans) store.transaction(() => {
    const plan = store.get('SELECT * FROM schedules WHERE id=?', id)!;
    if (store.get('SELECT 1 FROM schedule_migrations WHERE schedule_id=?', id)) return; // Another process got here first.
    const spec = JSON.parse(plan.spec), now = service.clock(), notes: string[] = [];
    const repository = store.get('SELECT full_name FROM repositories WHERE id=?', plan.project_id)?.full_name ?? String(plan.project_id);
    const windowMs = Number.isSafeInteger(spec.parameters?.window_ms) ? Number(spec.parameters.window_ms) : 86400000;
    const timer: Json = { name: `${spec.name}（${repository}）`.slice(0, 100), prompt: prompt(repository, windowMs), timezone: spec.timezone, enabled: plan.state === 'active' };
    if (spec.cron) timer.cron = spec.cron;
    else {
      // A chat timer runs at least five minutes apart, in whole minutes, and counts its interval from now.
      const minutes = Math.max(5, Math.ceil(Number(spec.interval_ms) / minute));
      if (minutes * minute !== spec.interval_ms) notes.push('interval_rounded');
      timer.interval_minutes = minutes;
    }
    if (spec.end_at !== undefined) notes.push('end_at_not_carried');
    let outcome = 'migrated', reason: string | null = null, chat: Row | undefined, created: Row | undefined;
    if (plan.state === 'deleted' || plan.state === 'expired') { outcome = 'skipped'; reason = 'plan_' + plan.state; }
    else try {
      // The destination registration names the chat; its registrant owns a private chat's timer.
      const registration = store.get('SELECT * FROM channel_outbox WHERE id=?', spec.destination_id);
      if (!registration) fail(404, 'schedule_destination_unavailable');
      const payload = store.secrets.open(registration!.payload, 'channel-outbox:' + registration!.id), protection = (payload.protection ?? {}) as Json;
      const event = payload.event as Json;
      chat = store.get('SELECT * FROM channel_chats WHERE id=?', String(protection.chat_id ?? ''))
        ?? store.get('SELECT * FROM channel_chats WHERE app_id=? AND installation_tenant=? AND chat_id=?', String(event?.app_id ?? ''), String(event?.installation_tenant ?? ''), String(event?.chat_id ?? ''));
      if (!chat) fail(404, 'channel_chat_not_found');
      const p2p = chat!.chat_type === 'p2p', by = String(p2p ? protection.principal_id : plan.owner_id);
      if (p2p && !store.get('SELECT 1 FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', chat!.id, by)) fail(409, 'channel_schedule_owner_unavailable');
      if (!p2p && !store.get('SELECT 1 FROM channel_service_bindings WHERE chat_id=?', chat!.id)) fail(409, 'channel_service_binding_missing');
      created = channels.schedules.adopt(chat!, by, timer);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      outcome = 'failed'; reason = error.code;
    }
    if (outcome !== 'skipped') {
      store.run('UPDATE schedules SET state=\'paused\',reason=?,revision=revision+1,updated_at=? WHERE id=?', stopped(outcome === 'migrated'), now, plan.id);
      store.run("UPDATE notification_outbox SET state='blocked',last_error='schedule_notifications_retired' WHERE schedule_id=? AND state IN ('pending','retry')", plan.id);
    }
    const detail = { timer, notes, plan_revision: plan.revision, plan_reason: plan.reason ?? null, plan_kind: plan.kind, plan_owner_id: plan.owner_id, author_id: created?.created_by ?? null };
    store.run(`INSERT INTO schedule_migrations(schedule_id,project_id,plan_name,plan_state,destination_id,chat_id,chat_type,channel_schedule_id,outcome,reason,detail,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, plan.id, plan.project_id, spec.name, plan.state, spec.destination_id ?? null, chat?.id ?? null, chat?.chat_type ?? null,
      created?.id ?? null, outcome, reason, JSON.stringify(detail), now);
    service.audit(store.get('SELECT * FROM schedules WHERE id=?', plan.id)!, 'migration.' + outcome, null, 'migration:1027',
      { channel_schedule_id: created?.id ?? null, chat_id: chat?.id ?? null, reason });
    report.push(store.get('SELECT * FROM schedule_migrations WHERE schedule_id=?', plan.id)!);
  });
  return report;
}
