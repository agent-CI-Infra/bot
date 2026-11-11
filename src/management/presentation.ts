/** Public explanations contain no request data; detailed codes remain in the authenticated trace. */
export function managementFailure(code:string):string {
  if(code==='service_role_model_not_configured')return '管理助手尚未配置模型，请超级管理员在控制台「全局设置 → 服务角色」中为它选择共享模型。';
  if(code==='service_role_budget_exhausted')return '管理助手的用量预算已用完，请超级管理员在「全局设置 → 服务角色」中检查预算。';
  if(code==='service_role_budget_usage_unknown')return '管理助手有无法计价的用量，预算无法核对，已暂停调用；请超级管理员在「全局设置 → 服务角色」中检查模型价格和预算。';
  if(/^service_role_/.test(code))return '管理助手当前不可用，请超级管理员在「全局设置 → 服务角色」中检查配置。';
  if(/^(model_|management_model_|task_models_)/.test(code))return '管理助手的模型配置或服务暂不可用，请在控制台检查模型设置后重试。';
  if(/authorization_changed|conversation_source_changed|channel_message_changed|channel_sensitive_message/.test(code))return '身份、权限或来源消息已变化，请核对当前范围后重新说明请求。';
  if(/binding|principal_inactive/.test(code))return '当前飞书身份尚未有效绑定，请在私聊发送“绑定”或“重新认证”。';
  if(/forbidden|scope|required.*permission/.test(code))return '当前账户或会话没有访问此对象或执行此操作的权限，请检查身份与权限。';
  if(/revision_conflict/.test(code))return '对象已被其他操作更新，请重新查询并确认后再修改。';
  if(/out_of_order/.test(code))return '消息到达顺序已变化，请重新发送本次请求。';
  if(/budget/.test(code))return '当前项目的用量预算已达限制，请检查预算设置。';
  return '本次请求未完成，请登录控制台查看执行记录；已有操作以回执为准。';
}
/** What a group sees when its assistant cannot answer: who can fix it and where, without request data or internal IDs. */
export function serviceFailure(code:string,role:string):string {
  if(code==='service_role_model_not_configured')return `群助手「${role}」尚未配置模型，请超级管理员在控制台「全局设置 → 服务角色」中为它选择共享模型。`;
  if(code==='service_role_budget_exhausted')return `群助手「${role}」的用量预算已用完，请超级管理员在「全局设置 → 服务角色」中检查预算。`;
  if(code==='service_role_budget_usage_unknown')return `群助手「${role}」有无法计价的用量，预算无法核对，已暂停调用；请超级管理员在「全局设置 → 服务角色」中检查模型价格和预算。`;
  if(code==='service_role_unavailable'||code==='service_role_not_bindable')return `群助手「${role}」已停用或不能用于群聊，请维护人在控制台「身份与权限 → 飞书群聊助手」为本群重新选择服务角色。`;
  if(/^(model_|service_model_)/.test(code))return `群助手「${role}」的模型服务暂不可用，请稍后重试；持续失败时请超级管理员检查模型设置。`;
  if(/conversation_source_changed|channel_service_binding|channel_sensitive_message|channel_source_message/.test(code))return '本群助手的配置或来源消息刚刚变化，本次回答已停止，请重新发送请求。';
  return `群助手本次未完成（${code}），请稍后重试，或请维护人在控制台检查本群助手的配置。`;
}
export const managementStates:Record<string,string>={pending:'等待处理',running:'处理中',completed:'处理完成',succeeded:'已执行',failed:'未完成',unknown:'执行结果待确认，请先对账，勿重复提交',rejected:'审批已拒绝',interrupted:'服务重启中断，请检查已有回执',stopped:'已停止后续调用',executing:'正在执行'};
