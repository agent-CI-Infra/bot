import { HttpError } from '../core/security.js';

/**
 * Routes of features that were removed. They answer 410 with what replaces them, so an old console tab or script learns
 * where to go instead of getting a bare 404. They read nothing and change nothing.
 */
const retired: { pattern: RegExp; code: string; detail: string }[] = [
  // Gate onboarding (#931): CI changes are ordinary development tasks that end in a bot pull request.
  { pattern: /^\/api\/(?:projects\/[^/]+\/gate-onboarding|gate-onboarding(?:\/.*)?)$/, code: 'gate_onboarding_removed',
    detail: '「接入门禁」已删除。要改 CI，请为项目创建一个开发任务写明要改什么（POST /api/tasks，intent 为 development）；bot 在任务里修改 workflow 并开 PR，由人检视合并。项目管理员创建任务时用 workflow_changes: true 确认允许修改 .github/workflows/。' },
  // Repository onboarding (#1133): merged into the management assistant (#/management and #/projects/<id>/management).
  { pattern: /^\/api\/management\/onboarding\/[1-9]\d*(?:\/.*)?$/, code: 'repository_onboarding_merged',
    detail: '独立「仓库接入」页面已合并到管理助手（#/management 或 #/projects/<id>/management）：直接在管理助手对话中分析仓库、启动或提交启动申请，并应用配置。' },
  // Rule-table automation (#1122): routine events use Manager standing rules and custom logic runs as generic tasks.
  { pattern: /^\/api\/automation(?:\/.*)?$/, code: 'automation_removed',
    detail: '规则表自动化（/api/automation）已退役（#1122）。例行事件请使用项目 Manager 的常设规则（standing_rules），其它协作逻辑请通过 Manager 提示词或通用任务（POST /api/tasks）处理。' },
];

export function retiredApi(url: URL): undefined {
  const entry = retired.find(item => item.pattern.test(url.pathname));
  if (entry) throw Object.assign(new HttpError(410, entry.code), { detail: entry.detail });
  return undefined;
}
