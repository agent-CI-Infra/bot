import type { Store } from '../storage/database.js';
import { githubProof } from '../identity/github.js';
import { pendingInstalledRepositories } from '../identity/github-status.js';

const reauthorize='你的 GitHub 授权已失效（可能已在 GitHub 上撤销，或需要重新授权），平台暂时无法确认你在仓库上的权限。请登录控制台并用 GitHub 重新登录，完成后再发消息。';

// Only gateway and provider faults mean the model service or its configuration is unavailable. An answer the loop could
// not use and a context over the request limit are different failures with different fixes (#333). Assistant turns have no
// step limit since #435: they end with an answer, a stop or a loss of authorization.
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
  if(/^service_role_/.test(code))return '管理助手当前不可用，请超级管理员在「全局设置 → 服务角色」中检查配置。';
  if(modelFault.test(code))return '管理助手的模型配置或服务暂不可用，请在控制台检查模型设置后重试。';
  if(outputFault.test(code))return '管理助手的模型返回了无法处理的结果，本次未完成；请重试，持续出现时请在控制台查看执行记录。';
  if(contextFault.test(code))return '本次请求需要的上下文超过模型请求上限，请缩小范围（例如指定项目或时间段）后重试。';
  if(/authorization_changed|conversation_source_changed|channel_message_changed|channel_sensitive_message/.test(code))return '身份、权限或来源消息已变化，请核对当前范围后重新说明请求。';
  if(code==='github_reauthorization_required')return reauthorize;
  // A start request decided in a private chat (#933): someone else decided first, or it lapsed.
  if(code==='onboarding_request_closed')return '这份启动申请已经有人处理过，或者已经失效（仓库移出了安装、项目已经启动或组织已受信任），请在控制台「待处理」查看。';
  if(code==='onboarding_apply_running')return '这个仓库正在应用另一份接入方案，请等它结束后再同意。';
  if(code==='channel_application_tenant_forbidden')return'这个飞书机器人属于一个 GitHub 组织，经它只能使用你在该组织内的权限，而你在该组织还没有可访问的项目。请改用其他机器人，或请组织管理员为你授权。';
  if(/binding|principal_inactive/.test(code))return '当前飞书身份尚未有效绑定，请在私聊发送“绑定”或“重新认证”。';
  if(/forbidden|scope|required.*permission/.test(code))return '当前账户或会话没有访问此对象或执行此操作的权限，请检查身份与权限。';
  if(/revision_conflict/.test(code))return '对象已被其他操作更新，请重新查询并确认后再修改。';
  if(/out_of_order/.test(code))return '消息到达顺序已变化，请重新发送本次请求。';
  if(/budget/.test(code))return '当前角色的资源上限已达到，请检查角色配置。';
  return '本次请求未完成，请登录控制台查看执行记录；已有操作以回执为准。';
}
/** What a group sees when its assistant cannot answer: who can fix it and where, without request data or internal IDs. */
export function serviceFailure(code:string,role:string,detail?:string):string {
  if(/^channel_(resource|image|binary)/.test(code))return managementFailure(code);
  if(code==='service_role_model_not_configured')return `群助手「${role}」尚未配置模型，请维护人在控制台为它选择模型（全局角色在「全局设置 → 服务角色」，项目角色在「个人设置 → 飞书绑定」）。`;
  // #849: the model must serve every project the group reads; detail names the projects it does not. Never another model.
  if(code==='channel_service_model_unavailable')return `群助手「${role}」的模型不可用：${detail??'它没有授权给本群范围内的全部项目。'}请项目管理员在控制台「个人设置 → 飞书绑定」为本群换一个对范围内每个项目都可用的助手角色，或调整范围。`;
  if(code==='service_role_unavailable'||code==='service_role_not_bindable')return `群助手「${role}」已停用或不能用于群聊，请维护人在控制台「个人设置 → 飞书绑定」点击本群「配置仓库与权限」重新选择服务角色。`;
  if(modelFault.test(code))return `群助手「${role}」的模型服务暂不可用，请稍后重试；持续失败时请超级管理员检查模型设置。`;
  if(outputFault.test(code))return `群助手「${role}」的模型返回了无法处理的结果，本次未完成；请重试，持续出现时请维护人在控制台查看本群助手的会话记录。`;
  if(contextFault.test(code))return `本次问题需要的上下文超过群助手「${role}」的模型请求上限，请缩小范围（例如指定仓库）后重试。`;
  if(code==='conversation_stopped')return `群助手「${role}」的本次回答已在控制台停止，不再发送最终回答；已经发出的进展消息保留。`;
  if(/conversation_source_changed|channel_service_binding|channel_sensitive_message|channel_source_message/.test(code))return '本群助手的配置或来源消息刚刚变化，本次回答已停止，请重新发送请求。';
  return `群助手本次未完成（${code}），请稍后重试，或请维护人在控制台检查本群助手的配置。`;
}
/** What the management assistant answers a person who can open no project (#846): why, as GitHub's latest check tells it. */
export function noProjectsReply(store:Store,principal:string):string {
  const proof=githubProof(store,principal);
  if(proof?.state==='reauthorize')return reauthorize;
  if(proof?.state==='pending')return '暂时无法在 GitHub 上核验你的仓库权限，平台会自动重试；请稍后再发消息。持续出现时，请在控制台「身份与权限」点击「重新验证 GitHub 权限」。';
  const pending=proof?pendingInstalledRepositories(store,principal).length:0;
  if(pending)return `你在 GitHub 上管理的 ${pending} 个仓库已安装，但还没有被超级管理员启动，所以当前没有可访问的项目。请联系超级管理员在控制台启动这些仓库。`;
  if(proof)return 'GitHub 的最新核验显示，你在已接入的仓库上没有可用的权限，所以当前没有可访问的项目。如果刚在 GitHub 上调整过权限，请联系仓库管理员；详情见控制台「身份与权限」。';
  return '当前账户没有可访问的项目。身份绑定不会增加项目权限；请先在身份与权限页面检查授权，或联系项目管理员。';
}
/**
 * Why a group's repositories are paused (#846): per grantor whose authority no longer covers them, who they are and what has
 * to happen, so that the group is not left with an assistant that silently sees nothing.
 */
export function pausedGroupNotice(store:Store,paused:{full_name:string;grantor_id:string}[]):string {
  const byGrantor=new Map<string,string[]>();
  for(const project of paused)byGrantor.set(project.grantor_id,[...byGrantor.get(project.grantor_id)??[],project.full_name]);
  return [...byGrantor].map(([grantor,repositories])=>{
    const proof=githubProof(store,grantor),name=proof?.login||store.get('SELECT username FROM users WHERE id=?',grantor)?.username||'本群的授权人';
    const list=repositories.slice(0,3).join('、')+(repositories.length>3?` 等 ${repositories.length} 个仓库`:'');
    if(!store.get('SELECT 1 FROM principals p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.active=1 AND u.active=1',grantor))
      return `${list} 暂停使用：本群的授权人 ${name} 的账号已停用。请项目管理员在控制台「个人设置 → 飞书绑定」重新配置本群。`;
    if(proof?.state==='reauthorize')return `${list} 暂停使用：本群的授权人 ${name} 的 GitHub 授权已失效。请 ${name} 登录控制台并用 GitHub 重新登录，本群随后自动恢复。`;
    if(proof?.state==='pending')return `${list} 暂停使用：暂时无法在 GitHub 上核验本群授权人 ${name} 的权限，平台会自动重试；持续出现时，请 ${name} 登录控制台查看「身份与权限」。`;
    return `${list} 暂停使用：本群的授权人 ${name} 在这些仓库上已没有配置权限。请有权限的项目管理员在控制台「个人设置 → 飞书绑定」重新配置本群。`;
  }).join('\n');
}
export const managementStates:Record<string,string>={pending:'等待处理',running:'处理中',completed:'处理完成',succeeded:'已执行',failed:'未完成',unknown:'执行结果待确认，请先对账，勿重复提交',rejected:'审批已拒绝',interrupted:'服务重启中断，请检查已有回执',stopped:'已停止后续调用',executing:'正在执行'};
