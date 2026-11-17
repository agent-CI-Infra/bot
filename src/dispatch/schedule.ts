import type { Store } from '../storage/database.js';
import type { ScheduleService } from '../schedules/service.js';
import { workActive } from '../work/settings.js';
import { workType } from '../work/catalog.js';
import { recordEvent, type Decision, type DispatchContext } from './store.js';

// A scheduled Manager check: a plan of this kind becomes an event when it is due. When the plan already has an
// instruction, the offered option is the default and dispatch starts the ordinary request without waiting on the
// Manager. Without an instruction, the Manager follows its Scheduled check section, or ignores the event. The plan's
// service identity is the task's actor. `parameters.file_issues` is authoritative: true allows Issue create/reply,
// false denies them, and an absent flag falls back to the executing role.
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
      const file_issues = typeof (trigger.parameters as any)?.file_issues === 'boolean' ? Boolean((trigger.parameters as any).file_issues) : undefined;
      recordEvent(schedules.store, { repositoryId: trigger.project_id, key: `${trigger.project_id}:schedule.due:${trigger.occurrence_id}`, type: 'schedule.due', source: 'schedule',
        summary: `定时检查到期${instruction ? '：' + instruction.slice(0, 100) : ''}`,
        facts: { occurrence_id: trigger.occurrence_id, logical_at: new Date(trigger.logical_at).toISOString(), instruction: instruction || null, ...(file_issues !== undefined ? { file_issues } : {}) },
        options: [{ id: 'check', work: 'task.request', title: '定时检查', default: Boolean(instruction),
          spec: { type: 'request', key: trigger.occurrence_id, request: instruction || '按 Manager 提示词「定时检查」章节检查这个项目，只报告发现。',
            principal: { principal_id: actor.principal_id, tenant_id: trigger.tenant_id }, ...(file_issues !== undefined ? { file_issues } : {}) } }] });
      // The occurrence's business run is handing the check to the Manager, done here; a task it starts runs on its own.
      return { run_id: trigger.run_id, state: 'succeeded' };
    }
  });
}

/** When a due check already has an instruction, start it; otherwise leave the decision to the Manager. */
export function scheduledCheckDecision(context: DispatchContext): Decision | null {
  if (String(context.event.type) !== 'schedule.due') return null;
  const chosen = context.options.filter(option => option.default);
  if (!chosen.length) return null;
  return { decision: 'create', option_ids: chosen.map(option => option.id), reason: '到期检查已写明内容，按计划发起定时检查。', model: 'rule' };
}
