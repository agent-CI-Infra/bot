// Every task stop belongs to one cause, so a reader can tell a passing outage from a setting someone has to change
// and from a defect in the bot itself. The fault detail says what happened; the cause says whose move it is.
export type FailureCause = 'external'|'github_access'|'github_rejected'|'model'|'environment'|'repository'|'task_changed'|'publication'|'role_configuration'|'bot';

const causes: Record<FailureCause,{label:string,codes:string[]}> = {
  external: { label:'外部服务或网络波动', codes:['github_unavailable','github_response_unknown','github_rate_limited','model_unavailable','release_actions_incomplete','github_log_download_failed',
    'actions_scan_incomplete','actions_completion_time_missing','claude_gateway_unavailable','claude_rate_limited','claude_transport_error'] },
  github_access: { label:'GitHub 权限或配置', codes:['github_permissions_insufficient','github_installation_owner_changed','github_installation_access_revoked','github_token_missing',
    'github_credentials_missing','github_account_missing','github_repository_scope_changed','github_actor_invalid','github_repository_invalid',
    'github_app_required','github_read_token_unavailable','github_read_token_not_read_only','github_read_token_not_allowed','branch_not_owned','release_uninstalled','release_app_required',
    'actions_app_required','actions_workflow_run_subscription_missing','gate_repository_unreadable'] },
  github_rejected: { label:'GitHub 拒绝了请求', codes:[] },
  model: { label:'模型服务或模型配置', codes:['role_nomination_stages_incomplete','role_submission_required','acp_submission_required','role_delivery_invalid','role_result_invalid','role_nomination_invalid','role_nomination_required','acceptance_unavailable','acceptance_output_invalid','acceptance_budget_exhausted','model_not_configured','task_models_invalid','model_not_available','model_configuration_changed','model_key_missing','model_authentication_failed','model_response_invalid',
    'model_response_too_large','model_finding_invalid','model_review_invalid','create_pull_request_required','create_pull_request_not_allowed',
    'release_notes_model_failed','release_notes_invalid','release_notes_dispatch_failed','manager_dispatch_failed','dispatch_decision_invalid','release_observation_failed','release_observation_invalid','actions_classification_invalid','agent_tool_not_allowed','agent_output_invalid','agent_output_budget_exhausted','agent_tool_calls_invalid','agent_turn_limit','gate_agent_output_invalid',
    'claude_submission_required','claude_authentication_failed','claude_model_unavailable','claude_execution_failed','claude_budget_exhausted','claude_output_limit','claude_provider_credential_unavailable'] },
  environment: { label:'项目电脑或运行环境', codes:['integration_unavailable','pi_runtime_unavailable','controller_workspace_unavailable','acp_not_configured','acp_configuration_invalid','acp_protocol_unsupported','acp_mcp_http_unsupported','harness_timeout','acp_turn_incomplete','acp_execution_failed','role_snapshot_unavailable','checkpoint_unavailable','acceptance_snapshot_unavailable','environment_not_ready','environment_generation_changed','execution_interrupted','workspace_init_failed',
    'workspace_write_failed','workspace_snapshot_mismatch','candidate_unavailable','candidate_blob_unavailable',
    'run_candidate_export_failed','run_candidate_import_failed','run_candidate_mismatch',
    'claude_not_configured','claude_configuration_invalid','claude_restricted_gateway_required','claude_platform_unsupported','claude_binary_unavailable','claude_state_directory_invalid','claude_version_unsupported',
    'claude_protocol_incompatible','claude_gateway_scope_unverified','claude_gateway_protocol_invalid','claude_timeout','claude_stream_interrupted','claude_stream_truncated','claude_process_exit','claude_result_missing','claude_capability_mismatch'] },
  repository: { label:'仓库内容或规则', codes:['repository_has_no_commit','credential_in_repository','unsafe_repository_path','repository_path_conflict',
    'unsupported_blob_encoding','unsafe_bot_rule','pull_request_file_limit','agent_context_too_large','github_pagination_limit',
    // The repository's .bot/ rule files and .agents/skills/ are the repository's to fix.
    'bot_rule_too_large','too_many_bot_skills','invalid_bot_rule_file','invalid_rule_content','invalid_bot_label','invalid_bot_computer',
    'release_file_invalid','release_tag_invalid','release_sensitive_body','release_notes_too_large','release_empty_repository','release_ci_unsuccessful',
    'actions_scan_window_overflow','actions_report_sensitive','pr_contributing_contract_missing','pr_release_config_invalid','pr_release_category_required'] },
  task_changed: { label:'任务条件已变化', codes:['task_coordination_requested','task_coordination_pending','coordination_source_cancelled','coordination_claim_revoked','role_revision_checkpoint','harness_cancelled','team_no_progress','role_nomination_stale','acceptance_publication_changed','acceptance_context_changed','checkpoint_context_changed','acceptance_return','acceptance_insufficient_evidence','acceptance_needs_human','acceptance_no_progress','object_closed_or_draft','pull_request_head_changed','branch_head_changed','branch_disappeared',
    'task_claim_revoked','task_actor_permission_revoked','release_actor_permission_revoked','repository_policy_disabled','review_requires_human_decision','issue_needs_replan','development_not_approved',
    'base_branch_changed','bot_branch_history_changed','revision_scope_unconfirmed','pr_head_pending','bot_pr_identity_changed',
    'bot_pr_author_changed','bot_pr_head_repository_changed','bot_pr_branch_changed','bot_pr_ownership_unconfirmed',
    'release_disabled','release_run_changed','release_attempt_changed','release_duplicate','release_range_changed','release_record_changed',
    'release_lease_lost','release_tag_conflict','release_run_ambiguous','release_run_missing','release_rerun_unavailable','release_tag_missing','release_ci_evidence_changed',
    'actions_failures_disabled','actions_lease_lost','actions_run_identity_changed','actions_rerun_identity_changed','actions_attempt_identity_changed',
    'actions_jobs_identity_changed','actions_development_disabled','actions_development_not_approved','pr_release_label_conflict',
    // A work type switched off while its task waited or ran (workflow_* before #207).
    'work_disabled','workflow_disabled','workflow_not_found',
    // A newer gate onboarding conversation, or a repository stopped while the agent was answering.
    'gate_session_superseded','gate_repository_stopped',
    // The workflow assistant's run was stopped by the person who started it.
    'assistant_cancelled',
    // A RoleRun whose lease was taken over, whose fixed candidate changed, or a second run of one assignment.
    'candidate_writer_busy','required_stages_incomplete','lease_epoch_stale','candidate_changed','role_run_already_active','run_token_revoked','run_token_expired'] },
  // The project's RoleDefinitionV2 configuration: a pinned reference became unusable, or an authority was withdrawn.
  role_configuration: { label:'角色配置', codes:['stage_budget_exhausted','stage_policy_changed','stage_retry_exhausted','stage_plan_stale','role_configuration_changed','unknown_role','role_disabled','unknown_role_harness','agent_backend_unavailable','harness_version_unavailable','harness_role_unsupported',
    'role_model_not_available','role_model_profile_changed','capability_policy_unavailable','skill_bundle_unavailable','role_authority_revoked','harness_version_mismatch',
    'harness_model_api_unsupported','harness_tool_calls_required','harness_structured_output_unsupported','harness_model_profile_unsupported',
    // RoleRun admission, budgets and recovery (#169): fail closed instead of downgrading or switching silently.
    'unsupported_capability','role_budget_exhausted','model_revision_changed','role_recovery_unsupported','claude_cost_budget_unsupported','claude_usage_budget_unknown','claude_tool_name_unsupported','claude_submission_tool_required'] },
  publication: { label:'GitHub 写入结果未知', codes:['github_publication_unknown','release_write_unknown','actions_report_write_unknown','pr_release_label_incomplete'] },
  bot: { label:'Bot 自身问题', codes:['pi_environment_required','external_harness_model_request','acceptance_required','task_runtime_failure','agent_limits_invalid','agent_tools_invalid','tool_operation_conflict','pi_execution_failed','model_request_invalid','github_read_token_limit',
    'github_tree_mismatch','github_commit_tree_mismatch','github_blob_mismatch','candidate_blob_mismatch','candidate_blob_invalid','branch_not_confirmed',
    'github_invalid_response','github_invalid_page','github_response_too_large','repository_blob_invalid','repository_tree_invalid','repository_blob_limit_or_hash','release_operation_changed',
    'github_log_redirect_invalid','github_log_too_large','github_log_job_invalid','actions_report_identity_missing',
    'role_run_protocol_invalid','role_run_secret_rejected','role_run_operation_used','role_run_unknown','role_checkpoint_not_found','role_run_handle_unknown','role_run_not_started','role_recovery_scope_mismatch','role_run_cursor_invalid',
    'run_token_ttl_invalid','run_token_invalid','run_token_scope_mismatch','run_token_capability_denied','run_candidate_invalid','claude_prepare_required','claude_run_context_required','claude_session_scope_mismatch','claude_tool_denied'] },
};
const byCode = new Map(Object.entries(causes).flatMap(([cause,{codes}]) => codes.map(code => [code, cause as FailureCause])));
export const classifiedCodes = new Set(byCode.keys());

export function failureCause(code: string, state?: string): FailureCause {
  // A crash while talking to the project computer is the environment's; any other uncaught error is ours.
  if (code === 'task_runtime_failure') return state === 'waiting_environment' ? 'environment' : 'bot';
  const known = byCode.get(code); if (known) return known;
  if (/^github_permission_\d+$/.test(code)) return 'github_access';
  if (/^(github|model)_http_(408|429|5\d\d)$/.test(code)) return 'external';
  if (/^github_http_\d+$/.test(code)) return 'github_rejected';
  if (/^model_http_\d+$/.test(code)) return 'model';
  return 'bot';
}

// These states are polled by the engine and continue on their own; every other paused or failed state waits for 重试.
const automatic = new Set(['queued','retry_wait','waiting_coordination','waiting_configuration','waiting_environment','waiting_pr_head']);
const environmentFailures = new Set(['execution_interrupted','workspace_init_failed','workspace_write_failed',
  'workspace_snapshot_mismatch','candidate_unavailable','candidate_blob_unavailable']);
// waiting_environment covers both unmet conditions and failed attempts. Only the latter consume the retry burst;
// configuration/PR-head waits and manager availability checks keep polling on their own schedule.
export function isAttemptFailure(code: string|null|undefined, state: string) {
  return state==='retry_wait'&&code!=='github_rate_limited'||state==='waiting_environment'&&environmentFailures.has(code||'');
}
const ended = new Set(['cancelled','superseded']);
const retry = '改好后点「重试」。';
const codeActions: Record<string,string> = {
  stage_policy_changed:'阶段策略已变化，任务已暂停。等到安全检查点后采用新配置，旧 run 和证据保留为历史。',
  stage_plan_stale:'阶段计划的合同版本已过期，任务已暂停。显式重试或采用当前配置并重新规划后继续。',
  required_stages_incomplete:'必需阶段缺少当前候选的合格证据。读取阶段等待原因，安排原角色修复或补证后再提名；阶段齐备仍需独立 QA。',
  stage_retry_exhausted:'这个阶段已达到有限重试上限。检查失败记录，修正阶段策略或运行环境后采用新配置继续。',
  stage_budget_exhausted:'这个阶段的累计预算已用尽，恢复运行不会重开预算。保留产物和证据，调整策略并采用新配置后继续。',
  candidate_writer_busy:'同一候选已有写者或只读检视运行。等待当前运行收集结束后继续，不同时修改被检视内容。',
  role_nomination_stages_incomplete:'主控需先读取阶段计划并委派尚未完成的必需阶段；提名不能替代阶段证据或 QA。',
  task_coordination_requested:'协调请求或显式任务依赖已持久化，框架会在结果可用后自动续接；不占用执行名额。',
  task_coordination_pending:'协调上下文已变化，读取通知并记录处理意见后重新提交给独立 QA；旧验收不会认证新上下文。',
  acp_not_configured:'请部署操作人配置 BOT_ACP_CONFIG 并安装、认证对应 ACP 执行器。',
  acp_configuration_invalid:'请部署操作人修正 ACP 启动配置。',
  acp_protocol_unsupported:'请选择支持当前 ACP v1 协议的执行器版本。',
  acp_mcp_http_unsupported:'当前执行器不支持 Bot 任务工具所需的 MCP HTTP；请更换支持的桥接版本。',
  claude_not_configured:'请部署操作人设置 BOT_CLAUDE_CODE_CONFIG，固定 CLI 版本、模型和可验证本轮能力令牌的受控网关；不会读取个人登录态。',
  claude_configuration_invalid:'请部署操作人检查 Claude Code 配置：只接受锁定版本、完整模型 ID、独立状态目录和 provider 服务凭据引用；外部 gatewayUrl、任意环境变量或启动参数都不支持。',
  claude_authentication_failed:'受控网关拒绝了本轮凭据。请检查运行令牌、租约与模型授权，不要提供管理员个人订阅。',
  claude_provider_credential_unavailable:'内置网关无法读取供应商服务凭据：请部署操作人提供仅所有者可读的普通凭据文件。供应商密钥留在控制面，不传给 CLI，也不使用个人登录态。',
  claude_model_unavailable:'受控网关没有授权配置中的精确 Claude 模型；不会换模型或使用项目的 OpenAI-compatible 配置。',
  claude_gateway_scope_unverified:'当前只支持在控制面进程内验证本轮令牌的模型网关；请改用 provider 配置，外部网关暂不支持。',
  claude_version_unsupported:'Claude Code 二进制版本与锁定协议不符。请安装 package-lock.json 固定的版本，升级须重新验证协议。',
  claude_protocol_incompatible:'Claude Code 输出不符合固定版本的结构化协议，结果未采纳；请检查实际 CLI 版本和网关响应。',
  claude_submission_required:'CLI 已结束，但没有通过控制面提交有效角色报告。查看工具观察与报告校验错误，不能用 CLI 自报成功代替实际证据。',
  claude_cost_budget_unsupported:'当前 Claude Code 网关没有确定金额账本，无法执行金额预算；本次未启动 CLI。请配置支持该预算的后端或明确调整预算策略。',
  claude_usage_budget_unknown:'原生运行缺少预算所需的完整用量，不能证明还有累计额度。运行已停止，已有产物保留；请核对用量、预算和网关后再继续，不会把未知消耗当成零。',
  claude_budget_exhausted:'Claude Code 达到本次运行上限，已有产物保留，任务等待重新规划，不自动重试。检查累计用量及检查点，调整范围或预算后再显式重试。',
  task_actor_permission_revoked:'发起人的当前任务权限已撤销或待验证。重新验证或由管理员恢复有效委派后重试。',
  release_actor_permission_revoked:'发起人的当前发布权限已撤销或待验证。由仍有权限的管理员处理；个人 GitHub 写权限不是发布前提。',
  acceptance_return:'执行 Agent 将根据结构化验收缺口修订候选，再次提交验收。',
  acceptance_insufficient_evidence:'执行 Agent 将补齐所缺证据，并重新验收。',
  acceptance_publication_changed:'已有 GitHub 成果被保留。请查看验收缺口，针对已有 PR 安排修订；其他任务继续。',
  acceptance_unavailable:'验收器连续未产生有效结论，候选与故障证据已保留。检查模型或验收配置后重试。',
  acceptance_needs_human:'查看结构化验收记录中的具体问题，补充决定或授权后继续；其他任务不受影响。',
  acceptance_no_progress:'自动修订已达到有限退出条件。查看候选和每轮缺口，调整任务或补充信息后重试。',
  task_models_invalid:'在项目模型设置中重新保存任务模型映射，修复后任务自动继续。',
  model_not_available:'任务所选模型已不可用。请重新授权该项目使用模型或选择其他任务模型，修复后自动继续。',
  model_configuration_changed:'模型配置在运行期间变化，本次请求已停止；任务会按最新配置重新开始。',
  acceptance_budget_exhausted:'独立验收尚未形成结论，候选与观察已保留；系统将有限重试，不把它记为成果不合格。',
  agent_output_budget_exhausted:'模型耗尽本次输出预算，尚未提交有效结果。请从持久化事实重建精简上下文后重试。',
  agent_turn_limit:'Agent 已达到本次运行轮次上限。先检查已有结果，再调整任务范围或运行限制后重试。',
  repository_has_no_commit:'向仓库推送第一个提交后自动继续。',
  pr_head_pending:'正在等待 GitHub 把 PR head 更新到刚推送的提交，确认后自动继续。',
  object_closed_or_draft:'Issue 或 PR 已关闭或转为草稿，任务已结束，无需处理。',
  task_claim_revoked:'任务已被取消或由其他执行接管，无需处理。',
  repository_policy_disabled:'仓库已停用这类任务，任务已结束；需要时在项目设置里重新开启。',
  work_disabled:'项目配置里关闭了这类工作，任务已结束；需要时在「Manager 与角色」页重新开启。',
  workflow_disabled:'这条工作流已关闭或删除，任务已结束。',
  workflow_not_found:'这条工作流已删除，任务已结束。',
  github_read_token_not_allowed:'启动这个子 agent 时关掉了 GitHub 读取；主 agent 仍可读取，需要时让它不带 github_read:false 再启动子 agent。',
  pull_request_head_changed:'PR 有了新的提交，这个任务已被取代，无需处理。',
  branch_head_changed:'分支被推送了其他提交，这个任务已被取代，无需处理。',
  branch_disappeared:'待更新的分支已被删除，这个任务已被取代，无需处理。',
  review_requires_human_decision:'检视认为需要人先确认需求：在 Issue 下补充说明后提及 bot 重新检视。重试这个任务不会改变结论。',
  issue_needs_replan:'Issue 的标题或正文在检视后被修改：在 Issue 下提及 bot 重新检视。重试这个任务不会改变结论。',
  development_not_approved:'重新加上开发标签、并确认没有其他人接手后点「重试」。',
  actions_development_disabled:'Actions 失败处理或开发已关闭，任务已停止；需要时在项目设置重新开启，并保留人工批准。',
  actions_development_not_approved:'确认原 Issue 仍开放、无人指派、人工开发标签仍在，且检视明确确认产品缺陷；条件不满足时先重新检视。',
  actions_workflow_run_subscription_missing:'请 App 管理员为该仓库实际使用的 App 订阅 workflow_run；仅增加事件订阅不要求重新批准已有权限。',
  actions_report_write_unknown:'提报写入结果不明，本功能只通过原 Issue 或评论 marker 对账，不盲目重发。',
  pr_release_label_incomplete:'PR 已存在，但 release:* 标签未完成；维护者按当前贡献约定补齐唯一类别后再重试，不要重复开 PR。',
  pr_release_label_conflict:'PR 上已有其他 release:* 类别，请维护者按当前贡献约定核对唯一类别。',
  pr_release_category_required:'按当前 CONTRIBUTING、release.yml 和 create-github-pr skill 选择一个 release:* 类别，再提交发布请求。',
  base_branch_changed:'点「重试」会基于最新的基础分支重新规划。',
  bot_branch_history_changed:'点「重试」会基于当前分支重新规划。',
  revision_scope_unconfirmed:'在 PR 上给出明确的修改意见后点「重试」。',
  create_pull_request_required:'模型没有通过 create_pull_request 提交修改。点「重试」会重新开始一次尝试；反复出现可换用更强的模型。',
  agent_context_too_large:'压缩后仍超过请求上限。点「重试」会用空检视会话重新读取最新讨论；仍超限时减少仓库 bot 规则或提示文件。',
  // Raised only by versions that still limited rule file sizes.
  bot_rule_too_large:'规则文件和 skill 已不再限制大小，点「重试」即可继续。',
  too_many_bot_skills:'.agents/skills/ 下最多 32 个 SKILL.md：合并或删掉一些，提交到默认分支后点「重试」。',
  pull_request_file_limit:'PR 改动文件过多，bot 无法确认完整差异。拆小 PR 后会重新检视。',
  role_authority_revoked:'角色的权限、角色本身或角色协作在运行中被收回，后续能力调用已停止。恢复角色协调或相应权限配置后点「重试」继续。',
  role_revision_checkpoint:'角色在安全检查点结束本次运行，同一任务和角色实例会带新 revision 自动续接。',
  unsupported_capability:'角色选用的执行后端或运行环境缺少这个阶段要求的能力（例如隔离、原始证据、取消或固定候选），运行没有启动，也不会换用其他后端。到「角色」页改用满足要求的执行后端或环境，保存后任务自动继续。',
  role_budget_exhausted:'这个角色在本任务中的累计预算已用尽，运行已取消，已有产物和检查点保留。确认用量后在「角色」页提高该角色的预算策略并保存；已开始的任务固定了启动时的配置，用 POST /api/tasks/:id/roles/apply 把新 revision 应用到这个角色后再重试。不会换模型重开预算。',
  model_revision_changed:'恢复运行时同一角色版本解析出的模型变了。为避免静默换模型，运行没有继续：恢复原模型，或在「角色」页明确保存新的模型配置。',
  lease_epoch_stale:'这次运行的租约已被更新的运行接管，它迟到的结果和调用都不再被接受；以接管它的运行为准，无需处理。',
  candidate_changed:'检视期间固定候选已变化，旧结论不能认证新内容；新的委派会针对当前候选重新执行。',
  harness_version_mismatch:'项目电脑里的 Pi 版本与角色配置固定的版本不同：升级或回退项目电脑镜像，或按新版本重新保存角色配置。',
  pi_runtime_unavailable:'项目电脑的 runner 太旧，不支持 Pi 运行时查询。同步升级控制面和项目电脑镜像后会自动继续。',
};
const causeActions: Record<FailureCause,(state:string)=>string> = {
  external: state => automatic.has(state) ? '不是配置问题，bot 会自动重试，一般无需处理。'
    : '已自动重试 5 次仍失败。先看 GitHub 状态页、模型服务和网络是否正常；都正常而同一个请求反复返回 502/504 时，多半是请求太大或太慢（GitHub 处理单个请求超过 10 秒会中止），请把任务链接反馈给 bot 维护者。恢复后点「重试」。',
  github_access: () => '按说明核对 GitHub App 是否安装到该仓库、授权的权限和仓库范围、账号凭据是否有效，' + retry,
  github_rejected: () => 'GitHub 收到了请求但不接受，通常是仓库当前状态与请求冲突（例如分支或 PR 已存在、分支保护规则）。按说明核对仓库后点「重试」；无法解释时请反馈给 bot 维护者。',
  model: () => '检查项目的模型地址、模型名和 API Key；模型输出不符合要求时可以点「重试」，或换用其他模型。',
  environment: state => automatic.has(state) ? 'bot 会自动重试；长时间不恢复请在项目页检查虚拟电脑。'
    : '请在项目页检查虚拟电脑后点「重试」。',
  repository: () => '按说明修改仓库内容或 bot 规则后点「重试」。',
  task_changed: () => '按说明处理后点「重试」。',
  role_configuration: state => '说明里写明了出错的角色配置字段。到项目「角色」页按字段修正并保存（需带当前 revision），'+(automatic.has(state)?'修复后任务会自动继续；不会换用其他模型、技能或执行后端。':retry),
  publication: () => 'GitHub 没有确认这次写入，bot 也没在 GitHub 上找到它。点「重试」会先再查一次，确实没有才重新发送，不会重复发布。',
  bot: () => '这是 bot 内部校验失败或运行异常，与外部服务和权限无关。可以先点「重试」；反复出现请把任务链接和上面的说明反馈给 bot 维护者。',
};

export function explainFailure(code: string|null|undefined, state = 'failed', detail?: string, retryCycleStartedAt?: number|null) {
  if (!code) return null;
  const cause = failureCause(code, state), attempt_retry = isAttemptFailure(code,state);
  if(retryCycleStartedAt!=null&&attempt_retry)return {
    cause,label:code==='model_unavailable'&&detail?.includes('连续 90 秒没有 token 输出')?'模型连续 90 秒没有 token 输出':causes[cause].label,
    action:'同一种失败已连续出现 5 次，已进入每 8 小时一次的自动重试周期；下次大约 8 小时后再试，也可以点「重试」立即尝试。',automatic:true,retry_cycle:true,attempt_retry,
  };
  // Only token inactivity gets this explanation; DNS, connection failures and old logs keep their cause.
  if (code === 'model_unavailable' && detail?.includes('连续 90 秒没有 token 输出')) return {
    cause, label: '模型连续 90 秒没有 token 输出', automatic: automatic.has(state), attempt_retry,
    action: ended.has(state) ? '任务已结束，无需处理。' : automatic.has(state) ? '模型连续 90 秒没有 token 输出，bot 会自动重试。'
      : '模型连续 90 秒没有 token 输出，已自动重试 5 次仍失败。请检查模型服务的输出是否中断，恢复后点「重试」。',
  };
  const action = codeActions[code] || (ended.has(state) ? '任务已结束，无需处理。' : causeActions[cause](state));
  return { cause, label: causes[cause].label, action, automatic: automatic.has(state), attempt_retry };
}
