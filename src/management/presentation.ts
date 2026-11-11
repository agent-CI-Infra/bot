/** Public explanations contain no request data; detailed codes remain in the authenticated trace. */
export function managementFailure(code:string):string {
  if(/^(model_|management_model_|task_models_)/.test(code))return '管理助手的模型配置或服务暂不可用，请在控制台检查模型设置后重试。';
  if(/authorization_changed|conversation_source_changed|channel_message_changed|channel_sensitive_message/.test(code))return '身份、权限或来源消息已变化，请核对当前范围后重新说明请求。';
  if(/binding|principal_inactive/.test(code))return '当前飞书身份尚未有效绑定，请在私聊发送“绑定”或“重新认证”。';
  if(/forbidden|scope|required.*permission/.test(code))return '当前账户或会话没有访问此对象或执行此操作的权限，请检查身份与权限。';
  if(/revision_conflict/.test(code))return '对象已被其他操作更新，请重新查询并确认后再修改。';
  if(/out_of_order/.test(code))return '消息到达顺序已变化，请重新发送本次请求。';
  if(/budget/.test(code))return '当前项目的用量预算已达限制，请检查预算设置。';
  return '本次请求未完成，请登录控制台查看执行记录；已有操作以回执为准。';
}
export const managementStates:Record<string,string>={pending:'等待处理',running:'处理中',completed:'处理完成',succeeded:'已执行',awaiting_approval:'等待审批，尚未执行',failed:'未完成',unknown:'执行结果待确认，请先对账，勿重复提交',rejected:'审批已拒绝',interrupted:'服务重启中断，请检查已有回执',stopped:'已停止后续调用',executing:'正在执行'};
