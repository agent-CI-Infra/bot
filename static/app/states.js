function consoleState(title, text, { tone = '', retry } = {}) {
  const box = element('div', '', 'console-state' + (tone ? ' console-state-' + tone : ''));
  box.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  box.append(element('h2', title), element('p', text));
  if (retry) box.append(button('重新加载', retry)); return box;
}
const states = {
  accepted:['已接收','success'], invalid_signature:['签名无效','danger'], invalid_payload:['正文无效','danger'], payload_too_large:['正文过大','danger'],
  unknown_endpoint:['入口不存在','danger'], missing_event_or_delivery:['投递信息不全','danger'],
  queued:['待执行','info'], running:['执行中','info'], preparing:['准备中','info'], implementing:['开发中','info'], validating:['测试中','info'], publishing:['发布中','info'],
  succeeded:['已完成','success'], completed:['已完成','success'], pr_opened:['已创建 PR','success'], failed:['失败','danger'],
  waiting_configuration:['配置待补','warning'], waiting_environment:['等待环境','warning'], waiting_permission:['权限待处理','warning'],
  waiting_pr_head:['等待 PR 更新','info'], waiting_publication:['发布待确认','warning'], retry_wait:['等待重试','warning'], needs_replan:['需重新规划','warning'], paused:['已暂停','warning'], cancelled:['已取消',''], superseded:['已过时',''],
  ready:['就绪','success'], busy:['执行中','info'], stopped:['已停止',''], provisioning:['创建中','info'], recovering:['恢复中','info'], resetting:['重置中','warning'], reset_failed:['重置失败','danger'], unavailable:['不可用','danger'], result_ready:['待发布','info'], deleted:['已移除','']
};
function state(value) { const [caption,tone]=states[value]||[value,'']; const badge=element('span',caption,'status'+(tone?' status-'+tone:''));badge.title=value;return badge; }
