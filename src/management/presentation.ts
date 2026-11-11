// Only gateway and provider faults mean the model service or its configuration is unavailable. An answer the loop could
// not use, a context over the request limit or too many steps are different failures with different fixes (#333).
const modelFault=/^(model_unavailable|model_http_|model_authentication_failed|model_not_available|model_not_configured|model_key_missing|model_configuration_changed|task_models_)/;
const outputFault=/^(management_model_invalid|service_model_invalid|own_task_model_invalid|model_response_invalid|model_response_too_large|conversation_reply_invalid)$/;
const contextFault=/^(agent_context_too_large|model_request_invalid)$/;
const stepFault=/^(management|service)_turn_limit$/;

/** Public explanations contain no request data; detailed codes remain in the authenticated trace. */
export function managementFailure(code:string):string {
  if(code==='service_role_model_not_configured')return '管理助手尚未配置模型，请超级管理员在控制台「全局设置 → 服务角色」中为它选择共享模型。';
  if(code==='service_role_budget_exhausted')return '管理助手的用量预算已用完，请超级管理员在「全局设置 → 服务角色」中检查预算。';
  if(code==='service_role_budget_usage_unknown')return '管理助手有无法计价的用量，预算无法核对，已暂停调用；请超级管理员在「全局设置 → 服务角色」中检查模型价格和预算。';
  if(/^service_role_/.test(code))return '管理助手当前不可用，请超级管理员在「全局设置 → 服务角色」中检查配置。';
  if(modelFault.test(code))return '管理助手的模型配置或服务暂不可用，请在控制台检查模型设置后重试。';
  if(outputFault.test(code))return '管理助手的模型返回了无法处理的结果，本次未完成；请重试，持续出现时请在控制台查看执行记录。';
  if(contextFault.test(code))return '本次请求需要的上下文超过模型请求上限，请缩小范围（例如指定项目或时间段）后重试。';
  if(stepFault.test(code))return '本次请求需要的步骤过多，未能在一次回答内完成；请拆分或缩小范围后重试。';
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
  if(modelFault.test(code))return `群助手「${role}」的模型服务暂不可用，请稍后重试；持续失败时请超级管理员检查模型设置。`;
  if(outputFault.test(code))return `群助手「${role}」的模型返回了无法处理的结果，本次未完成；请重试，持续出现时请维护人在控制台查看本群助手的会话记录。`;
  if(contextFault.test(code))return `本次问题需要的上下文超过群助手「${role}」的模型请求上限，请缩小范围（例如指定仓库）后重试。`;
  if(stepFault.test(code))return `群助手「${role}」本次需要的步骤过多，未能完成；请拆分问题或指定仓库后重试。`;
  if(/conversation_source_changed|channel_service_binding|channel_sensitive_message|channel_source_message/.test(code))return '本群助手的配置或来源消息刚刚变化，本次回答已停止，请重新发送请求。';
  return `群助手本次未完成（${code}），请稍后重试，或请维护人在控制台检查本群助手的配置。`;
}
export const managementStates:Record<string,string>={pending:'等待处理',running:'处理中',completed:'处理完成',succeeded:'已执行',failed:'未完成',unknown:'执行结果待确认，请先对账，勿重复提交',rejected:'审批已拒绝',interrupted:'服务重启中断，请检查已有回执',stopped:'已停止后续调用',executing:'正在执行'};
