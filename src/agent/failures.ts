// Every task stop belongs to one cause, so a reader can tell a passing outage from a setting someone has to change
// and from a defect in the bot itself. The fault detail says what happened; the cause says whose move it is.
export type FailureCause = 'external'|'github_access'|'github_rejected'|'model'|'environment'|'repository'|'task_changed'|'publication'|'role_configuration'|'bot';

const causes: Record<FailureCause,{label:string,codes:string[]}> = {
  external: { label:'外部服务或网络波动', codes:['github_unavailable','github_response_unknown','github_rate_limited','model_unavailable','release_actions_incomplete','github_log_download_failed','github_artifact_download_failed',
    'actions_scan_incomplete','actions_completion_time_missing','claude_gateway_unavailable','claude_rate_limited','claude_transport_error','agent_tool_download_failed'] },
  github_access: { label:'GitHub 权限或配置', codes:['github_permissions_insufficient','github_installation_owner_changed','github_installation_access_revoked','github_token_missing',
    'github_credentials_missing','github_account_missing','github_repository_scope_changed','github_actor_invalid','github_repository_invalid',
    'github_app_required','github_read_token_unavailable','github_read_token_not_read_only','github_read_token_not_allowed','branch_not_owned','release_uninstalled','release_app_required',
    'actions_app_required','actions_permission_missing','actions_workflow_run_subscription_missing','pull_request_media_permission','pull_request_media_origin_missing'] },
  github_rejected: { label:'GitHub 拒绝了请求', codes:[] },
  model: { label:'模型服务或模型配置', codes:['agent_compaction_failed','harness_model_transport_invalid','harness_direct_protocol_unsupported','role_nomination_stages_incomplete','role_submission_required','acp_submission_required','codex_submission_required','codex_authentication_failed','codex_model_unavailable','codex_model_mismatch','codex_model_rerouted','codex_resume_incompatible','codex_turn_failed','codex_subagent_refused','role_delivery_invalid','role_result_invalid','role_nomination_invalid','role_nomination_required','acceptance_unavailable','acceptance_output_invalid','acceptance_budget_exhausted','model_not_configured','service_role_model_not_configured','channel_service_model_unavailable','service_role_unavailable','task_models_invalid','model_not_available','model_configuration_changed','model_key_missing','model_authentication_failed','model_response_invalid',
    'model_response_too_large','model_finding_invalid','model_review_invalid','review_inline_out_of_diff','model_url_insecure','create_pull_request_required','create_pull_request_not_allowed','pull_request_labels_refused','delivery_refused','conflict_not_integrated',
    'release_notes_model_failed','release_notes_invalid','release_notes_dispatch_failed','manager_dispatch_failed','dispatch_decision_invalid','dispatch_model_invalid','release_observation_failed','release_observation_invalid','actions_classification_invalid','agent_tool_not_allowed','agent_output_invalid','agent_output_budget_exhausted','agent_tool_calls_invalid','agent_turn_limit','gate_agent_output_invalid',
    'claude_submission_required','claude_authentication_failed','claude_model_unavailable','claude_execution_failed','claude_budget_exhausted','claude_output_limit','claude_provider_credential_unavailable','provider_credential_unavailable'] },
  environment: { label:'项目电脑或运行环境', codes:['harness_environment_required','integration_unavailable','pi_runtime_unavailable','controller_workspace_unavailable','container_workspace_required','acp_not_configured','acp_configuration_invalid','acp_protocol_unsupported','acp_mcp_http_unsupported','harness_timeout','acp_turn_incomplete','acp_execution_failed',
    'codex_not_configured','codex_configuration_invalid','codex_execution_failed','codex_output_limit',
    'codex_version_unsupported','codex_home_unexpected','codex_unauthorized_tool_servers','codex_task_tools_unavailable','codex_task_tools_mismatch','codex_protocol_invalid','codex_connection_lost','codex_connection_closed','acp_output_limit','codex_builtin_tools_enabled','codex_builtin_tool_refused','codex_resume_failed','codex_turn_interrupted','codex_thread_ownership_mismatch','role_snapshot_unavailable','checkpoint_unavailable','acceptance_snapshot_unavailable','environment_not_ready','environment_generation_changed','execution_interrupted','workspace_init_failed',
    'workspace_write_failed','workspace_snapshot_mismatch','conversation_workspace_unavailable','workspace_unavailable','candidate_unavailable','candidate_blob_unavailable',
    'run_candidate_export_failed','run_candidate_import_failed','run_candidate_mismatch',
    'claude_not_configured','claude_configuration_invalid','claude_restricted_gateway_required','claude_platform_unsupported','claude_binary_unavailable','claude_state_directory_invalid','claude_version_unsupported',
    'claude_protocol_incompatible','claude_gateway_scope_unverified','claude_gateway_protocol_invalid','claude_timeout','claude_stream_interrupted','claude_stream_truncated','claude_process_exit','claude_result_missing','claude_capability_mismatch',
    // #671: the data disk of the control plane or the manager is full; a repeated call whose stored result was removed.
    'disk_full','operation_result_expired',
    // #705: read-only /opt/agent-tools CLI volume availability, compatibility and archive integrity.
    'agent_tools_volume_missing','cli_not_installed','cli_version_incompatible','platform_arch_unsupported','agent_tool_invalid','agent_tool_hash_mismatch','agent_tool_archive_invalid'] },
  repository: { label:'仓库内容或规则', codes:['repository_has_no_commit','credential_in_repository','unsafe_repository_path','repository_path_conflict',
    'unsupported_blob_encoding','unsafe_skill_file','pull_request_file_limit','agent_context_too_large','github_pagination_limit','pull_request_media_invalid',
    // The repository's .agents/skills/ are the repository's to fix.
    'too_many_bot_skills','invalid_skill_file','invalid_rule_content','skill_file_too_large',
    // Raised only by versions that still read .bot/ files (before #935) or limited their sizes; tasks may still wait on them.
    'bot_rule_too_large','invalid_bot_rule_file','invalid_bot_label','invalid_bot_computer','unsafe_bot_rule',
    'release_file_invalid','release_tag_invalid','release_sensitive_body','release_notes_too_large','release_empty_repository','release_ci_unsuccessful',
    'actions_scan_window_overflow','actions_report_sensitive'] },
  task_changed: { label:'任务条件已变化', codes:['obsolete_superseded','obsolete_closed','obsolete_expired','manager_deferred','manager_needs_help','task_coordination_requested','task_coordination_pending','coordination_source_cancelled','coordination_claim_revoked','role_revision_checkpoint','harness_cancelled','harness_run_closed','team_no_progress','role_nomination_stale','acceptance_publication_changed','acceptance_context_changed','checkpoint_context_changed','acceptance_return','acceptance_insufficient_evidence','acceptance_needs_human','acceptance_no_progress','object_closed_or_draft','pull_request_head_changed','branch_head_changed','branch_disappeared',
    'task_claim_revoked','task_actor_permission_revoked','release_actor_permission_revoked','repository_policy_disabled','review_requires_human_decision','issue_needs_replan','development_not_approved',
    'target_branch_not_found','target_commit_not_found',
    'base_branch_changed','bot_branch_history_changed','revision_scope_unconfirmed','pr_head_pending','bot_pr_identity_changed',
    'bot_pr_author_changed','bot_pr_head_repository_changed','bot_pr_branch_changed','bot_pr_ownership_unconfirmed',
    'release_disabled','release_run_changed','release_attempt_changed','release_duplicate','release_range_changed','release_record_changed',
    'release_lease_lost','release_tag_conflict','release_run_ambiguous','release_run_missing','release_rerun_unavailable','release_tag_missing','release_ci_evidence_changed',
    'actions_failures_disabled','actions_lease_lost','actions_run_identity_changed','actions_rerun_identity_changed','actions_attempt_identity_changed',
    'actions_jobs_identity_changed','actions_development_disabled','actions_development_not_approved','actions_analysis_not_succeeded','write_not_allowed',
    // A work type switched off while its task waited or ran (workflow_* before #207).
    'work_disabled','workflow_disabled','workflow_not_found','task_software_disabled',
    // A work type removed from the bot (gate onboarding, #931): its unfinished tasks end at the upgrade.
    'work_removed',
    // #850: the project's capability ceiling is below what the step needs, or was lowered while the task waited or ran.
    'capability_ceiling','capability_ceiling_lowered',
    // The workflow assistant's run was stopped by the person who started it.
    'assistant_cancelled',
    // A RoleRun whose lease was taken over, whose fixed candidate changed, or a second run of one assignment.
    'candidate_writer_busy','required_stages_incomplete','lease_epoch_stale','candidate_changed','role_run_already_active','run_token_revoked','run_token_expired',
    // A role at its concurrency limit: nothing ran, so the queue retries it without spending an attempt.
    'role_capacity','task_children_pending','event_subscription_pending','manager_execution_stopped',
    // #735: the install named a CLI version (or Node runtime) an active run is still executing; it waits for that run.
    'agent_tool_version_in_use'] },
  // The project's RoleDefinitionV2 configuration: a pinned reference became unusable, or an authority was withdrawn.
  role_configuration: { label:'角色配置', codes:['stage_budget_exhausted','stage_policy_changed','stage_retry_exhausted','stage_plan_stale','role_configuration_changed','unknown_role','role_disabled','unknown_role_harness','agent_backend_unavailable','harness_version_unavailable','harness_role_unsupported',
    'task_pull_request_forbidden','delivery_not_granted','task_external_write_forbidden','role_model_not_available','role_model_profile_changed','role_submission_forbidden','skill_bundle_unavailable','role_authority_revoked','harness_version_mismatch',
    'harness_model_api_unsupported','harness_tool_calls_required','harness_structured_output_unsupported','harness_model_profile_unsupported',
    // RoleRun admission, budgets and recovery (#169): fail closed instead of downgrading or switching silently.
    'unsupported_capability','role_budget_exhausted','role_usage_unknown','conversation_harness_context_required','model_revision_changed','role_recovery_unsupported','claude_usage_budget_unknown','claude_tool_name_unsupported','claude_submission_tool_required',
    'subscription_mode_not_implemented'] },
  publication: { label:'GitHub 写入结果未知', codes:['github_publication_unknown','release_write_unknown','actions_report_write_unknown','pr_release_label_incomplete'] },
  bot: { label:'Bot 自身问题', codes:['harness_permission_mismatch','pi_environment_required','external_harness_model_request','acceptance_required','task_runtime_failure','agent_limits_invalid','agent_tools_invalid','tool_operation_conflict','pi_execution_failed','model_request_invalid','github_read_token_limit',
    'github_tree_mismatch','github_commit_tree_mismatch','github_blob_mismatch','candidate_blob_mismatch','candidate_blob_invalid','branch_not_confirmed','publication_receipt_mismatch',
    'pull_request_media_corrupt','pull_request_media_unconfirmed',
    'github_invalid_response','github_invalid_page','github_response_too_large','repository_blob_invalid','repository_tree_invalid','repository_blob_limit_or_hash','release_operation_changed',
    'github_log_redirect_invalid','github_log_too_large','github_log_job_invalid','github_artifact_redirect_invalid','github_artifact_too_large','github_artifact_invalid','actions_report_identity_missing',
    'role_run_protocol_invalid','role_run_secret_rejected','role_run_operation_used','role_run_unknown','role_checkpoint_not_found','role_run_handle_unknown','role_run_not_started','role_recovery_scope_mismatch','role_run_cursor_invalid',
    'run_token_ttl_invalid','run_token_invalid','run_token_scope_mismatch','run_token_capability_denied','run_candidate_invalid','claude_prepare_required','claude_run_context_required','claude_session_scope_mismatch','claude_tool_denied',
    // A recorded result or trajectory record that fails its hash check; replaying the call could repeat its effect.
    'trajectory_unreadable'] },
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

// A next attempt can succeed with nobody changing anything when the stop came from a passing outage, the model, the
// project computer or the bot itself (an unexpected error, an operation left over from an interrupted run). Such a stop
// that would end the task as failed waits for an automatic retry instead: after 5 s, 15 s, 45 s and 135 s, then every eight
// hours once the same stop has repeated five times. Stops that need a person keep their state: permissions, configuration,
// repository content, a changed task, a GitHub write whose outcome is unconfirmed, a request GitHub refused.
const selfHealing = new Set<FailureCause>(['external','model','environment','bot']);
export function automaticState(code: string, state: string): string {
  if(state==='needs_help')return state;
  if(['stage_budget_exhausted','role_budget_exhausted'].includes(code))return 'retry_wait';
  if(state==='needs_replan')return ['development_not_approved','actions_development_not_approved'].includes(code)?'waiting_permission':'retry_wait';
  // A provider that refused the request itself (HTTP 4xx other than 408/429) answers the same again, like a GitHub 4xx.
  if (/^model_http_4\d\d$/.test(code) && failureCause(code, state) === 'model') return state;
  return state === 'failed' && selfHealing.has(failureCause(code, state)) ? 'retry_wait' : state;
}

// These states are polled by the engine and continue on their own; every other paused or failed state waits for 重试.
const automatic = new Set(['queued','retry_wait','waiting_coordination','waiting_event','waiting_configuration','waiting_environment','waiting_pr_head']);
// A wait the engine ends by itself once its condition is gone, in a state that otherwise waits for a person.
const resumedWaits = new Set(['github_installation_access_revoked']);
const environmentFailures = new Set(['execution_interrupted','workspace_init_failed','workspace_write_failed',
  'workspace_snapshot_mismatch','candidate_unavailable','candidate_blob_unavailable','operation_result_expired']);
// waiting_environment covers both unmet conditions and failed attempts. Only the latter consume the retry burst;
// configuration/PR-head waits and manager availability checks keep polling on their own schedule.
// Waits the control plane ends by itself once the outside condition clears: they are not failed attempts, so they do not
// consume the retry burst. A role at its concurrency limit is one of them — nothing about the run was tried. A pull request
// that got new commits (#770) is not a failure either: the task prepares the new head with its work kept.
const capacityWaits = new Set(['manager_deferred','github_rate_limited','role_capacity','task_children_pending','event_subscription_pending','manager_execution_stopped','pull_request_head_changed']);
export function isAttemptFailure(code: string|null|undefined, state: string) {
  return state==='retry_wait'&&!capacityWaits.has(code||'')||state==='waiting_environment'&&environmentFailures.has(code||'');
}
const ended = new Set(['cancelled','superseded']);
const retry = '改好后点「重试」。';
const codeActions: Record<string,string> = {
  // #713: tasks moved out of 待处理 because nobody needs to act on them; their original failure stays in the timeline.
  obsolete_superseded:'同一 Issue 或 PR 上已有更新的同类任务接手，这个旧任务已自动移出待处理，无需处理。原来的失败保留在时间线里；仍需要时可以点「重试」。',
  obsolete_closed:'Issue 或 PR（或这个任务来源的那个）已关闭或合入，任务已自动移出待处理，无需处理。原来的失败保留在时间线里；仍需要时可以点「重试」。',
  obsolete_expired:'这是很久以前因平台或临时原因（限流、服务不可用、上下文或响应超限、运行异常等）留下的失败，之后没有新的动静，已自动移出待处理，无需处理。原来的失败保留在时间线里；仍需要时可以点「重试」。',
  task_children_pending:'正在等待子任务返回；任一结果到达后由父任务 Manager 自动继续协调，无需人工重试。',
  event_subscription_pending:'正在等待已订阅的仓库事件触发；匹配事件到达或到达超时时间后任务会自动唤醒继续执行，期间不占用执行槽位，无需人工重试。',
  manager_execution_stopped:'Manager 已停止本次角色执行；已有产物和证据保留，接下来由 Manager 决定恢复或调整安排。',
  stage_policy_changed:'阶段策略已变化，任务已暂停。等到安全检查点后采用新配置，旧 run 和证据保留为历史。',
  stage_plan_stale:'阶段计划的合同版本已过期，任务已暂停。显式重试或采用当前配置并重新规划后继续。',
  required_stages_incomplete:'必需阶段缺少当前候选的合格证据。读取阶段等待原因，安排原角色修复或补证后再提名；阶段齐备仍需独立 QA。',
  stage_retry_exhausted:'这是旧版本留下的阶段次数上限记录；当前版本将次数阈值作为 Manager 提醒。检查最近运行和提醒，由 Manager 决定如何继续。',
  stage_budget_exhausted:'这个阶段的累计预算已用尽，恢复运行不会重开预算。保留产物和证据，调整策略并采用新配置后继续。',
  candidate_writer_busy:'同一候选已有写者或只读检视运行。等待当前运行收集结束后继续，不同时修改被检视内容。',
  role_capacity:'这个角色已达到项目设定的并发上限，任务在队列里等一个运行结束；不消耗尝试次数，也不要手动重试。',
  role_nomination_stages_incomplete:'主控需先读取阶段计划并委派尚未完成的必需阶段；提名不能替代阶段证据或 QA。',
  task_coordination_requested:'协调请求或显式任务依赖已持久化，框架会在结果可用后自动续接；不占用执行名额。',
  task_coordination_pending:'协调上下文已变化，读取通知并记录处理意见后重新提交给独立 QA；旧验收不会认证新上下文。',
  acp_not_configured:'ACP 外部后端已下线；请在项目「角色」页改用 Pi、Claude Code 或 Codex 并保存配置后重试。',
  acp_configuration_invalid:'ACP 外部后端已下线；请在项目「角色」页改用 Pi、Claude Code 或 Codex 并保存配置后重试。',
  acp_protocol_unsupported:'ACP 外部后端已下线；请在项目「角色」页改用 Pi、Claude Code 或 Codex 并保存配置后重试。',
  acp_mcp_http_unsupported:'ACP 外部后端已下线；请在项目「角色」页改用 Pi、Claude Code 或 Codex 并保存配置后重试。',
  subscription_mode_not_implemented:'供应商订阅模式接口当前仅作预留，尚未实现；请在「角色」页将模型来源切回「平台网关」后再试。',
  container_workspace_required:'Claude Code 与 Codex 需要项目容器或隔离运行容器工作区；请确认已配置虚拟电脑或隔离运行环境后再试。',
  agent_tools_volume_missing:'未挂载只读 CLI 工具卷 /opt/agent-tools；请确认已配置 agent-tools 卷并由管理员通过 POST /api/agent-tools/install 安装对应 CLI。',
  cli_not_installed:'只读工具卷 /opt/agent-tools 中尚未安装该执行后端所需的 CLI；请管理员通过管理接口 POST /api/agent-tools/install 安装后重试。',
  cli_version_incompatible:'只读工具卷 /opt/agent-tools 中已安装的 CLI 版本不满足兼容范围；请管理员通过管理接口 POST /api/agent-tools/install 安装兼容版本后重试。',
  claude_not_configured:'请确认只读工具卷 /opt/agent-tools 已安装兼容的 Claude Code，且角色、工作类型或项目已配置可用模型；不会读取个人登录态。',
  claude_configuration_invalid:'请部署操作人检查 Claude Code 配置：只接受兼容版本范围、完整模型 ID、独立状态目录和受控网关/服务凭据引用；外部 gatewayUrl、任意环境变量或启动参数都不支持。',
  claude_authentication_failed:'容器内模型中转网关拒绝了本轮运行身份令牌或上游凭据。请检查运行令牌、租约与项目模型授权，不要提供个人订阅登录态。',
  claude_provider_credential_unavailable:'控制面网关无法读取供应商服务凭据：请部署操作人提供仅所有者可读的普通凭据文件，或在项目模型中配置有效 API Key。供应商密钥留在控制面，不传给容器或 CLI。',
  claude_model_unavailable:'容器内模型中转网关没有授权配置中的目标模型；请核对角色或项目的模型配置后重试，平台不会静默换模型。',
  claude_gateway_scope_unverified:'当前只支持通过控制面验证本轮身份令牌的容器内模型中转；外部未受控网关暂不支持。',
  claude_version_unsupported:'只读工具卷 /opt/agent-tools 中的 Claude Code 版本不在兼容范围内；请部署操作人安装兼容版本后重试。',
  claude_protocol_incompatible:'Claude Code 输出不符合兼容协议要求，结果未采纳；请检查实际 CLI 版本和模型中转响应。',
  claude_submission_required:'CLI 已结束，但没有通过 stdio MCP 管理工具提交有效角色报告。查看工具观察与报告校验错误，不能用 CLI 自报成功代替实际证据。',
  claude_usage_budget_unknown:'原生运行缺少预算所需的完整用量，不能证明还有累计额度。运行已停止，已有产物保留；请核对用量、预算和网关后再继续，不会把未知消耗当成零。',
  claude_budget_exhausted:'Claude Code 达到本次运行上限，已有产物保留，任务等待重新规划，不自动重试。检查累计用量及检查点，调整范围或预算后再显式重试。',
  codex_not_configured:'请确认只读工具卷 /opt/agent-tools 已安装兼容的 Codex CLI，且角色、工作类型或项目已配置可用模型。',
  codex_configuration_invalid:'请部署操作人按失败详情修正 Codex 的启动配置或模型配置。',
  codex_execution_failed:'容器内 Codex app-server 进程异常退出；请检查项目电脑状态、资源上限与运行日志后重试。',
  codex_output_limit:'Codex app-server 输出超过安全上限，运行已停止；请缩小单轮输出或检查命令输出量后重试。',
  codex_submission_required:'Codex app-server 本轮已结束，但没有通过 stdio MCP 管理工具提交有效角色报告；请检查工具观察与报告校验错误后重试。',
  codex_version_unsupported:'只读工具卷 /opt/agent-tools 中的 Codex CLI 版本不在兼容范围内；请部署操作人安装兼容版本后重试。',
  codex_home_unexpected:'Codex app-server 没有使用容器内的角色专用 CODEX_HOME；检查启动环境，不要共用宿主或跨角色 Codex 配置。',
  codex_unauthorized_tool_servers:'Codex 会话中出现了平台 stdio MCP 服务（bot）以外的外部工具服务或插件；移除后重试，平台不会把它们当作角色能力。',
  codex_task_tools_unavailable:'Codex 未能连接本轮 stdio MCP 平台管理工具（bot）；查看运行记录中的 MCP 状态后重试。',
  codex_authentication_failed:'容器内模型中转或上游模型认证失败；请检查本轮运行令牌与项目模型 API Key 后重试。',
  codex_model_unavailable:'所选模型在容器内模型中转中不可用；请核对角色或项目模型配置后重试。',
  codex_model_mismatch:'app-server 实际使用的模型/供应商与本轮受控模型中转配置不同；修正配置，平台不会静默换模型。',
  codex_model_rerouted:'app-server 把本轮改路由到未配置的模型，已停止；确认模型策略后重试。',
  codex_resume_incompatible:'恢复或重建的 thread 会换成另一模型或供应商，已停止；保持原模型重试，或暂停任务并执行 adopt-config 按新配置重建角色会话。',
  codex_builtin_tools_enabled:'Codex app-server 启用了当前运行策略禁止的特性或联网工具，运行未开始；检查 CLI 版本与项目网络策略后重试。',
  codex_builtin_tool_refused:'Codex 在禁止出网的运行环境中调用了联网搜索等受限能力，运行已停止；检查项目网络策略后重试。',
  codex_subagent_refused:'Codex 子 agent 调用被策略拒绝，运行已停止；查看运行日志后重试。',
  codex_resume_failed:'恢复 Codex thread 时出错，原绑定已保留；问题消失后重试即可续接同一 thread。',
  codex_thread_ownership_mismatch:'恢复的 thread 不属于这个角色实例，已拒绝；检查容器内会话状态目录是否被替换。',
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
  github_installation_access_revoked:'GitHub App 安装已暂停、卸载、仓库被移出安装，或安装范围正在核实。安装同步确认仓库可以访问后任务自动继续，无需点「重试」；安装确实被撤销时，先在 GitHub 恢复安装或把仓库加回安装范围。',
  object_closed_or_draft:'Issue 或 PR 已关闭或转为草稿，任务已结束，无需处理。',
  task_claim_revoked:'任务已被取消或由其他执行接管，无需处理。',
  repository_policy_disabled:'仓库已停用这类任务，任务已结束；需要时在项目设置里重新开启。',
  work_disabled:'项目策略关闭了这类工作，任务已结束；请项目管理员在管理对话中调整策略后重新提交任务。',
  workflow_disabled:'这条工作流已关闭或删除，任务已结束。',
  workflow_not_found:'这条工作流已删除，任务已结束。',
  work_removed:'这类工作已从 bot 中删除，未完成的任务在升级时结束，无需处理。',
  github_read_token_not_allowed:'启动这个子 agent 时关掉了 GitHub 读取；主 agent 仍可读取，需要时让它不带 github_read:false 再启动子 agent。',
  pull_request_head_changed:'PR 有了新的提交：检视转到新提交继续，开发保存已有改动后按新提交重新准备，无需处理。',
  branch_head_changed:'发布分支与预期不一致；Manager 可查询 read_publication_context 和原始记录，再决定重试、协调、集成或求助。',
  branch_disappeared:'待更新的分支已被删除，这个任务已被取代，无需处理。',
  target_branch_not_found:'任务指定的目标分支在仓库中不存在或已被删除；请确认分支名后重新创建任务。',
  target_commit_not_found:'任务指定的目标提交在仓库中不存在；请确认 commit SHA 后重新创建任务。',
  review_inline_out_of_diff:'内联检视评论指向了 PR diff 之外的行号；请改为 diff 内的新增或上下文行，或改用整体讨论发现。',
  review_requires_human_decision:'检视认为需要人先确认需求：在 Issue 下补充说明后提及 bot 重新检视。重试这个任务不会改变结论。',
  issue_needs_replan:'早期版本在开发期间 Issue 被修改时会停下；现在修改作为更新交给开发。点「重试」由 Manager 决定怎样继续。',
  development_not_approved:'开发标签被去掉了（或这个 Actions 提报的 Issue 已指派给别人）。Manager 会收到这件事并回应；重新加上开发标签后，Manager 续接，开发继续。',
  actions_development_disabled:'Actions 失败处理或开发已关闭，任务已停止；需要时在项目设置重新开启，并保留人工批准。',
  actions_development_not_approved:'确认原 Issue 仍开放、无人指派、人工开发标签仍在，且检视明确确认产品缺陷；条件不满足时先重新检视。',
  actions_permission_missing:'该仓库使用的 App 安装没有 Actions 权限：App 管理员在 Permissions & events 把 Actions 设为「Read and write」（读取运行只需只读，重跑需要写），再由安装所有者接受新权限。不需要 Workflows 权限。',
  actions_workflow_run_subscription_missing:'请 App 管理员在该仓库实际使用的 App 的 Permissions & events → Subscribe to events 勾选「Workflow run」并保存。这是 Webhook 事件订阅，只要求 Actions 读权限，不需要 Workflows 权限；安装设置出现待批准的变更时接受即可。',
  actions_report_write_unknown:'提报写入结果不明，本功能只通过原 Issue 或评论 marker 对账，不盲目重发。',
  delivery_refused:'执行者多次调用了这个任务现在不能用的交付工具（没有授权、项目上限或开关、来源上限），什么都没写；点「重试」重新执行，或由 Manager 用 grant_writes 授予后再重试。',
  conflict_not_integrated:'执行者在解决 PR 合并冲突时多次提交了未真正合并目标分支变更或仍含冲突标记的工作区树，什么都没写；点「重试」重新执行并完成分支合并与测试验证。',
  task_external_write_forbidden:'创建或委派这个任务的角色（或群的档位）没有要做的这项写入，不能借给任务；由项目管理员调整来源的权限，或改为交报告。',
  delivery_not_granted:'这个任务没有被授予要做的交付（例如开 PR），什么都没写。需要时由 Manager 用 grant_writes 或在任务详情里授予，再点「重试」；不需要时可以取消。',
  pull_request_labels_refused:'模型多次给 PR 选了仓库里没有或保留的标签；点「重试」重新执行，必要时在仓库的贡献规则或 skill 里写清要用的标签。',
  base_branch_changed:'版本差异已记录，Manager 可查看原始证据并决定验证、集成或继续交付。',
  bot_branch_history_changed:'点「重试」会基于当前分支重新规划。',
  revision_scope_unconfirmed:'在 PR 上给出明确的修改意见后点「重试」。',
  create_pull_request_required:'模型没有通过 create_pull_request 提交修改。点「重试」会重新开始一次尝试；反复出现可换用更强的模型。',
  agent_context_too_large:'Pi 压缩会话并重试后，请求仍超过模型的上下文窗口；原因见故障详情。点「重试」会新开会话，按任务记录和上一轮结论重新开始；仍超限时精简 Manager 提示词的规则章节或仓库 skill，或换用上下文更大的模型。',
  agent_compaction_failed:'Pi 压缩会话时失败了（通常是生成摘要的模型请求出错），原因见故障详情。任务会自动重试并续接同一会话；反复出现时检查模型服务。',
  // Codes of the .bot/ files, which are no longer read (#935): what they stopped on is gone.
  ...Object.fromEntries(['bot_rule_too_large','invalid_bot_rule_file','invalid_bot_label','invalid_bot_computer','unsafe_bot_rule'].map(code=>[code,'仓库的 .bot/ 规则文件已不再读取（规则已迁入 Manager 提示词、项目设置和机器配置），点「重试」即可继续。'])),
  invalid_skill_file:'.agents/skills/ 下的文件必须是普通文件（不能是符号链接或子模块）：修正后提交到默认分支，再点「重试」。',
  unsafe_skill_file:'.agents/skills/ 下包含符号链接：换成普通文件后提交，再点「重试」。',
  too_many_bot_skills:'.agents/skills/ 下最多 32 个 SKILL.md（共最多 256 个文件）：合并或删掉一些，提交到默认分支后点「重试」。',
  skill_file_too_large:'.agents/skills/ 下单文件最多 512 KiB、总计最多 1 MiB：精简体积后提交到默认分支，再点「重试」。',
  pull_request_file_limit:'PR 改动文件过多，bot 无法确认完整差异。拆小 PR 后会重新检视。',
  capability_ceiling:'项目能力上限不够这一步（详情写明需要的档位），任务已停下，已有改动保留。需要时由项目管理员在「项目设置 → 监听与触发」调高上限后点「重试」。',
  capability_ceiling_lowered:'项目能力上限已调低，任务在下一个工具调用前停下，已有改动保留，没有取消。调回足够的档位后点「重试」继续；不再需要时可以取消。',
  task_software_disabled:'项目未开启开发或普通事项。核对项目开关与普通事项配置后重试；报告终点不会因此变为 PR 交付。',
  task_pull_request_forbidden:'核对普通事项的 code／pull_request 写集合，以及来源与当前执行角色修改代码的能力（PR 本身是框架交付，不需要角色的 GitHub 写权限）。任务管理和委派不会增加写权限；旧请求的授权上限不会因后来加权而自动扩大。',
  role_authority_revoked:'角色或其权限在运行中被收回，后续能力调用已停止。恢复相应角色及权限配置后点「重试」继续。',
  role_revision_checkpoint:'角色在安全检查点结束本次运行，同一任务和角色实例会带新 revision 自动续接。',
  unsupported_capability:'角色选用的执行后端或运行环境缺少这个阶段要求的能力（例如隔离、原始证据、取消或固定候选），运行没有启动，也不会换用其他后端。到「角色」页改用满足要求的执行后端或环境，保存后任务自动继续。',
  role_budget_exhausted:'这个角色在本任务中的累计预算已用尽，运行已取消，已有产物和检查点保留。确认用量后在「角色」页提高该角色的预算策略并保存；已开始的任务固定了启动时的配置，用 POST /api/tasks/:id/roles/apply 把新 revision 应用到这个角色后再重试。不会换模型重开预算。',
  model_revision_changed:'恢复运行时同一角色版本解析出的模型变了。为避免静默换模型，运行没有继续：恢复原模型，或在「角色」页明确保存新的模型配置。',
  conversation_harness_context_required:'当前非任务会话入口尚未提供所选外部后端的协议上下文，不能自动替换后端。请维护人查看角色配置与当前支持范围。',
  workspace_unavailable:'项目电脑上建不出这个任务要用的 worktree（#769），执行 CLI 没有启动。检查项目电脑的连接、工作卷空间和 runner 版本后重试。',
  conversation_workspace_unavailable:'连续会话无法在项目电脑建立所选后端的空工作区。本轮没有完成；检查项目电脑连接、环境状态和 runner 版本后再继续。',
  role_usage_unknown:'当前资源上限要求的用量无法完整核验，不能把未知当成零继续调用。核对缺失用量后，再按当前授权继续。',
  lease_epoch_stale:'这次运行的租约已被更新的运行接管，它迟到的结果和调用都不再被接受；以接管它的运行为准，无需处理。',
  candidate_changed:'检视期间固定候选已变化，旧结论不能认证新内容；新的委派会针对当前候选重新执行。',
  harness_version_mismatch:'项目电脑里的 Pi 版本与角色配置固定的版本不同：升级或回退项目电脑镜像，或按新版本重新保存角色配置。',
  pi_runtime_unavailable:'项目电脑的 runner 太旧，不支持 Pi 运行时查询。同步升级控制面和项目电脑镜像后会自动继续。',
  disk_full:'数据盘剩余空间不足（控制面、manager 或项目电脑的工作卷写不下，或剩余低于任务开始所需），任务停在等待环境，不会写坏数据，也不会把写满导致的命令失败当成测试失败。请管理员在全局设置的「存储」一节查看占用并清理磁盘；有了空间后任务自动继续，无需点「重试」。',
  operation_result_expired:'这次调用在 manager 里保存的结果已过保留期被删除，无法确认原结果；任务会用新的尝试重新开始，不会采用不确定的结果。',
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
  return { cause, label: causes[cause].label, action, automatic: automatic.has(state) || state === 'waiting_permission' && resumedWaits.has(code), attempt_retry };
}
