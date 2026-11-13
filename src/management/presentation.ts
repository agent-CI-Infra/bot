// Only gateway and provider faults mean the model service or its configuration is unavailable. An answer the loop could
// not use and a context over the request limit are different failures with different fixes (#333). Assistant turns have no
// step limit since #435: they end with an answer, a stop or an exhausted service role budget.
const modelFault=/^(model_unavailable|model_http_|model_authentication_failed|model_not_available|model_not_configured|model_key_missing|model_configuration_changed|task_models_)/;
const outputFault=/^(management_model_invalid|service_model_invalid|own_task_model_invalid|model_response_invalid|model_response_too_large|conversation_reply_invalid)$/;
const contextFault=/^(agent_context_too_large|model_request_invalid)$/;

/** Public explanations contain no request data; detailed codes remain in the authenticated trace. */
export function managementFailure(code:string):string {
  if(code==='binding_superseded')return '这条绑定串已被控制台新生成的一条取代，请使用最新一条；旧串不能再完成绑定。';  if(code==='channel_image_model_unsupported')return '当前模型拒绝了本次图片输入，未能查看图片。请选择支持图片输入的模型，或使用已授权项目的电脑工具处理。';
  if(code==='channel_resource_permission_required')return '飞书应用缺少图片与文件权限，请管理员在控制台飞书连接设置中导入完整权限，并在飞书发布生效后重试。';
  if(code==='channel_resource_too_large')return '附件超过本次处理的大小限制，请缩小文件后重试；较大的图片可通过项目电脑处理。';
  if(code==='channel_image_model_limit'||code==='channel_image_format_unsupported'||code==='channel_binary_requires_computer')return '此附件需要通过已授权项目的电脑工具处理，当前模型不能直接查看。';
  if(code==='service_role_model_not_configured')return '管理助手尚未配置模型，请超级管理员在控制台「全局设置 → 服务角色」中为它选择共享模型。';
  if(code==='service_role_budget_exhausted')return '管理助手的用量预算已用完，请超级管理员在「全局设置 → 服务角色」中检查预算。';
  if(code==='service_role_budget_usage_unknown')return '管理助手有无法计价的用量，预算无法核对，已暂停调用；请超级管理员在「全局设置 → 服务角色」中检查模型价格和预算。';
  if(/^service_role_/.test(code))return '管理助手当前不可用，请超级管理员在「全局设置 → 服务角色」中检查配置。';
  if(modelFault.test(code))return '管理助手的模型配置或服务暂不可用，请在控制台检查模型设置后重试。';
  if(outputFault.test(code))return '管理助手的模型返回了无法处理的结果，本次未完成；请重试，持续出现时请在控制台查看执行记录。';
  if(contextFault.test(code))return '本次请求需要的上下文超过模型请求上限，请缩小范围（例如指定项目或时间段）后重试。';
  if(/authorization_changed|conversation_source_changed|channel_message_changed|channel_sensitive_message/.test(code))return '身份、权限或来源消息已变化，请核对当前范围后重新说明请求。';
  if(code==='channel_application_tenant_forbidden')return '这个飞书机器人属于一个 GitHub 组织，经它只能使用你在该组织内的权限，而你在该组织还没有可访问的项目。请改用其他机器人，或请组织管理员为你授权。';
  if(/binding|principal_inactive/.test(code))return '当前飞书身份尚未有效绑定，请在私聊发送“绑定”或“重新认证”。';
  if(/forbidden|scope|required.*permission/.test(code))return '当前账户或会话没有访问此对象或执行此操作的权限，请检查身份与权限。';
  if(/revision_conflict/.test(code))return '对象已被其他操作更新，请重新查询并确认后再修改。';
  if(/out_of_order/.test(code))return '消息到达顺序已变化，请重新发送本次请求。';
  if(/budget/.test(code))return '当前项目的用量预算已达限制，请检查预算设置。';
  return '本次请求未完成，请登录控制台查看执行记录；已有操作以回执为准。';
}
/** What a group sees when its assistant cannot answer: who can fix it and where, without request data or internal IDs. */
export function serviceFailure(code:string,role:string):string {
  if(/^channel_(resource|image|binary)/.test(code))return managementFailure(code);
  if(code==='service_role_model_not_configured')return `群助手「${role}」尚未配置模型，请超级管理员在控制台「全局设置 → 服务角色」中为它选择共享模型。`;
  if(code==='service_role_budget_exhausted')return `群助手「${role}」的用量预算已用完，请超级管理员在「全局设置 → 服务角色」中检查预算。`;
  if(code==='service_role_budget_usage_unknown')return `群助手「${role}」有无法计价的用量，预算无法核对，已暂停调用；请超级管理员在「全局设置 → 服务角色」中检查模型价格和预算。`;
  if(code==='service_role_unavailable'||code==='service_role_not_bindable')return `群助手「${role}」已停用或不能用于群聊，请维护人在控制台「个人设置 → 飞书绑定」点击本群「配置仓库与权限」重新选择服务角色。`;
  if(modelFault.test(code))return `群助手「${role}」的模型服务暂不可用，请稍后重试；持续失败时请超级管理员检查模型设置。`;
  if(outputFault.test(code))return `群助手「${role}」的模型返回了无法处理的结果，本次未完成；请重试，持续出现时请维护人在控制台查看本群助手的会话记录。`;
  if(contextFault.test(code))return `本次问题需要的上下文超过群助手「${role}」的模型请求上限，请缩小范围（例如指定仓库）后重试。`;
  if(code==='conversation_stopped')return `群助手「${role}」的本次回答已在控制台停止，不再发送最终回答；已经发出的进展消息保留。`;
  if(/conversation_source_changed|channel_service_binding|channel_sensitive_message|channel_source_message/.test(code))return '本群助手的配置或来源消息刚刚变化，本次回答已停止，请重新发送请求。';
  return `群助手本次未完成（${code}），请稍后重试，或请维护人在控制台检查本群助手的配置。`;
}
export const managementStates:Record<string,string>={pending:'等待处理',running:'处理中',completed:'处理完成',succeeded:'已执行',failed:'未完成',unknown:'执行结果待确认，请先对账，勿重复提交',rejected:'审批已拒绝',interrupted:'服务重启中断，请检查已有回执',stopped:'已停止后续调用',executing:'正在执行'};
