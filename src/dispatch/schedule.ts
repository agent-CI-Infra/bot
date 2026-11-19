import type { Store } from '../storage/database.js';
import type { ScheduleService } from '../schedules/service.js';
import { recordEvent, type Decision, type DispatchContext } from './store.js';

export const scheduledCheck = 'manager.check';

/** A due plan runs while the project is enabled (#1122: work-type switches are retired). */
export function scheduleGateOpen(store: Store, projectId: string, _plan?: string) {
  return !!store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1', projectId);
}

export function registerScheduledChecks(schedules: ScheduleService) {
  schedules.register(scheduledCheck, {
    capability: 'tasks.write',
    dispatch(trigger, actor, guard) {
      guard();
      const instruction = String((trigger.parameters as any)?.instruction ?? '').trim().slice(0, 4000);
      const file_issues = typeof (trigger.parameters as any)?.file_issues === 'boolean' ? Boolean((trigger.parameters as any).file_issues) : undefined;
      recordEvent(schedules.store, {
        repositoryId: trigger.project_id,
        key: `${trigger.project_id}:schedule.due:${trigger.occurrence_id}`,
        type: 'schedule.due',
        source: 'schedule',
        summary: `定时检查到期${instruction ? '：' + instruction.slice(0, 100) : ''}`,
        facts: {
          ...(trigger.schedule_id ? { schedule_id: trigger.schedule_id } : {}),
          occurrence_id: trigger.occurrence_id,
          logical_at: new Date(trigger.logical_at).toISOString(),
          instruction: instruction || null,
          ...(file_issues !== undefined ? { file_issues } : {}),
        },
        options: [
          {
            id: 'check',
            work: 'task.request',
            title: '定时检查',
            default: Boolean(instruction),
            spec: {
              type: 'request',
              key: trigger.occurrence_id,
              request: instruction || '按 Manager 提示词对本项目执行定时检查，只报告发现。',
              principal: { principal_id: actor.principal_id, tenant_id: trigger.tenant_id },
              ...(file_issues !== undefined ? { file_issues } : {}),
            },
          },
        ],
      });
      return { run_id: trigger.run_id, state: 'succeeded' };
    },
  });
}

export function scheduledCheckDecision(context: DispatchContext): Decision | null {
  if (String(context.event.type) !== 'schedule.due') return null;
  const chosen = context.options.filter(option => option.default);
  if (!chosen.length) return null;
  return { decision: 'create', option_ids: chosen.map(option => option.id), reason: '到期检查已写明内容，按计划发起定时检查。', model: 'rule' };
}
