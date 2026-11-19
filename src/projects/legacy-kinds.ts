/**
 * Read-only display labels and historical `tasks.kind` groupings (#1122).
 * Fixed work types (`src/work/*`) are retired; all newly dispatched tasks run as `kind = 'task.request'`.
 * Historical finished rows retain their stored `kind` so board, task detail, activity and cost views stay readable.
 */
export interface LegacyTaskCategory {
  id: string;
  name: string;
  kinds: string[];
}

export const legacyTaskCategories: LegacyTaskCategory[] = [
  { id: 'task.request', name: '通用任务', kinds: ['task.request'] },
  { id: 'review.issue', name: '检视 Issue', kinds: ['review.issue'] },
  { id: 'review.pr', name: '检视 PR', kinds: ['review.pr'] },
  { id: 'development.issue', name: '开发 Issue', kinds: ['development.issue'] },
  { id: 'development.pr', name: '跟进 bot PR', kinds: ['development.pr'] },
  { id: 'reply', name: '通用回复', kinds: ['workflow.issue', 'workflow.pr'] },
  { id: 'release.observe', name: 'CI 观察', kinds: ['release.observe'] },
  { id: 'release.notes', name: '生成发行说明', kinds: ['release.notes'] },
  { id: 'actions.failures', name: 'Actions 失败处理', kinds: ['actions.failures'] },
  { id: 'task.development', name: '开发任务', kinds: ['task.development'] },
  { id: 'gate.onboarding', name: '接入门禁', kinds: ['gate.onboarding'] },
];

export function legacyKindName(kindOrWorkflow: string): string | undefined {
  const normalized = kindOrWorkflow === 'workflow.issue' || kindOrWorkflow === 'workflow.pr' ? 'reply' : kindOrWorkflow;
  return legacyTaskCategories.find(c => c.id === normalized || c.kinds.includes(kindOrWorkflow))?.name;
}
