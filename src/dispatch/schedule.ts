import type { Store } from '../storage/database.js';
import type { ScheduleService } from '../schedules/service.js';
import { workActive } from '../work/settings.js';
import { workType } from '../work/catalog.js';
import { recordEvent } from './store.js';

// A scheduled Manager check: a plan of this kind becomes an event when it is due, and the Manager decides, following its
// "定时检查" (schedule) section, whether to start an ordinary read-only task. The plan's parameters.instruction says what to
// check; the plan's service identity is the task's actor, so its permissions are checked like any request's.
export const scheduledCheck = 'manager.check';
const workOfPlan = (plan: string) => plan === scheduledCheck ? 'task.request' : plan;

/** A due plan runs while its work type is on (other handlers: while the project is on). */
export function scheduleGateOpen(store: Store, projectId: string, plan: string) {
  const work = workOfPlan(plan);
  return workType(work) ? workActive(store, projectId, work) : !!store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1', projectId);
}
export function registerScheduledChecks(schedules: ScheduleService) {
  schedules.register(scheduledCheck, {
    capability: 'tasks.write',
    dispatch(trigger, actor, guard) {
      guard();
      const instruction = String((trigger.parameters as any)?.instruction ?? '').trim().slice(0, 4000);
      recordEvent(schedules.store, { repositoryId: trigger.project_id, key: `${trigger.project_id}:schedule.due:${trigger.occurrence_id}`, type: 'schedule.due', source: 'schedule',
        summary: `定时检查到期${instruction ? '：' + instruction.slice(0, 100) : ''}`,
        facts: { occurrence_id: trigger.occurrence_id, logical_at: new Date(trigger.logical_at).toISOString(), instruction: instruction || null },
        options: [{ id: 'check', work: 'task.request', title: '定时检查', spec: { type: 'request', key: trigger.occurrence_id,
          request: instruction || '按 Manager 提示词「定时检查」章节检查这个项目，只报告发现。', principal: { principal_id: actor.principal_id, tenant_id: trigger.tenant_id } } }] });
      // The occurrence's business run is handing the check to the Manager, done here; a task it starts runs on its own.
      return { run_id: trigger.run_id, state: 'succeeded' };
    }
  });
}
