import type { Store, Row } from '../storage/database.js';
import { fail } from '../core/security.js';
import { defaultLimits, type Limits, type Plan } from './types.js';

export const categoryOf = (plan: Plan): string => plan.workflow === 'report.daily' ? 'report' : 'development';
export const terminalRunStates = "('succeeded','completed','failed','cancelled','blocked','budget_exhausted','dead')";
export function budgetScopes(store: Store, row: Row, plan: Plan): { scope: string; id: string; limits: Limits }[] {
  return [{ scope: 'schedule', id: row.schedule_id ?? row.id, limits: plan.limits },
    ...['project', 'tenant'].map(scope => {
      const id = row[scope + '_id'];
      const configured = store.get('SELECT limits FROM schedule_budgets WHERE scope=? AND scope_id=? AND category=?', scope, id, categoryOf(plan));
      return { scope, id, limits: configured ? JSON.parse(configured.limits) as Limits : { ...defaultLimits, concurrency: scope === 'tenant' ? 10 : 3, runs: 1000, notifications_per_minute: 30 } };
    })];
}
/** Called inside the same transaction as claiming a new action. Attempts retain the occurrence's
 * original day; retrying across midnight must never grant a fresh run/model/cost allowance. */
export function reserve(store: Store, row: Row, plan: Plan, now: number, action: 'runs' | 'model_calls' | 'cost_micros', amount = 1): void {
  const day = Math.floor((row.logical_at ?? row.created_at ?? now) / 86400000);
  for (const s of budgetScopes(store, row, plan)) {
    const used = store.get('SELECT * FROM schedule_usage WHERE scope=? AND scope_id=? AND category=? AND day=?', s.scope, s.id, categoryOf(plan), day);
    if (Number(used?.[action] ?? 0) + amount > s.limits[action]) fail(409, 'schedule_budget_exhausted');
  }
  for (const s of budgetScopes(store, row, plan)) store.run(`INSERT INTO schedule_usage(scope,scope_id,category,day,${action}) VALUES(?,?,?,?,?)
    ON CONFLICT(scope,scope_id,category,day) DO UPDATE SET ${action}=${action}+excluded.${action}`, s.scope, s.id, categoryOf(plan), day, amount);
}
export function concurrencyAvailable(store: Store, row: Row, plan: Plan): boolean {
  return budgetScopes(store, row, plan).every(s => {
    const column = s.scope === 'schedule' ? 'schedule_id' : s.scope + '_id';
    const count = store.get(`SELECT count(*) n FROM schedule_occurrences o WHERE ${column}=?
      AND (state='running' OR EXISTS(SELECT 1 FROM schedule_business_runs b WHERE b.occurrence_id=o.id AND b.state NOT IN ${terminalRunStates}))
      AND json_extract(snapshot,'$.plan.workflow') ${categoryOf(plan) === 'report' ? "='report.daily'" : "<>'report.daily'"}`, s.id)!.n;
    return count < s.limits.concurrency;
  });
}
export function notificationSlot(store: Store, row: Row, plan: Plan, now: number): boolean {
  const minute = Math.floor(now / 60000), scopes = budgetScopes(store, row, plan);
  if (scopes.some(s => Number(store.get('SELECT used FROM schedule_notification_slots WHERE scope=? AND scope_id=? AND minute=?', s.scope, s.id, minute)?.used ?? 0) >= s.limits.notifications_per_minute)) return false;
  for (const s of scopes) store.run(`INSERT INTO schedule_notification_slots VALUES(?,?,?,1)
    ON CONFLICT(scope,scope_id,minute) DO UPDATE SET used=used+1`, s.scope, s.id, minute);
  for (const s of scopes) store.run(`INSERT INTO schedule_usage(scope,scope_id,category,day,notifications) VALUES(?,?,?,?,1)
    ON CONFLICT(scope,scope_id,category,day) DO UPDATE SET notifications=notifications+1`, s.scope, s.id, categoryOf(plan), Math.floor(now / 86400000));
  return true;
}
