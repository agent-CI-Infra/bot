import { codeActions } from './failure-actions.js';

// Every task stop belongs to one cause, so a reader can tell a passing outage from a setting someone has to change
// and from a defect in the bot itself. The fault detail says what happened; the cause says whose move it is.
export type FailureCause = 'external'|'github_access'|'github_rejected'|'model'|'environment'|'repository'|'task_changed'|'publication'|'role_configuration'|'bot';

const causes: Record<FailureCause,{label:string,codes:string[]}> = {
  external: { label:'外部服务或网络波动', codes:['github_unavailable','github_response_unknown','github_rate_limited','model_unavailable','release_actions_incomplete','github_log_download_failed','github_artifact_download_failed',
    'actions_scan_incomplete','actions_completion_time_missing','claude_gateway_unavailable','claude_rate_limited','claude_transport_error','agent_tool_download_failed'] },
  github_access: { label:'GitHub 权限或配置', codes:['github_permissions_insufficient','github_installation_owner_changed','github_installation_access_revoked','github_token_missing',
    'github_credentials_missing','github_account_missing','github_repository_scope_changed','github_actor_invalid','github_repository_invalid',
    'github_app_required','github_read_token_unavailable','github_read_token_not_read_only','github_read_token_not_allowed','branch_not_owned','release_uninstalled','release_app_required',
    'actions_app_required','actions_permission_missing','actions_workflow_run_subscription_missing','pull_request_media_permission','pull_request_media_origin_missing','workflow_changes_not_confirmed','github_workflows_permission_missing'] },
  github_rejected: { label:'GitHub 拒绝了请求', codes:[] },
  model: { label:'模型服务或模型配置', codes:['agent_compaction_failed','model_protocol_mismatch','harness_model_transport_invalid','harness_direct_protocol_unsupported','role_nomination_stages_incomplete','role_submission_required','acp_submission_required','codex_submission_required','codex_authentication_failed','codex_model_unavailable','codex_model_mismatch','codex_model_rerouted','codex_resume_incompatible','codex_turn_failed','codex_subagent_refused','role_delivery_invalid','role_result_invalid','role_nomination_invalid','role_nomination_required','acceptance_unavailable','acceptance_output_invalid','acceptance_budget_exhausted','model_not_configured','service_role_model_not_configured','channel_service_model_not_configured','channel_service_model_unavailable','service_role_unavailable','task_models_invalid','model_not_available','model_configuration_changed','model_key_missing','model_authentication_failed','model_response_invalid',
    'model_response_too_large','model_finding_invalid','model_review_invalid','review_inline_out_of_diff','model_url_insecure','create_pull_request_required','create_pull_request_not_allowed','pull_request_labels_refused','delivery_refused','conflict_not_integrated','workspace_head_drifted','unpushed_workspace_changes',
    'release_notes_model_failed','release_notes_invalid','release_notes_dispatch_failed','manager_dispatch_failed','dispatch_decision_invalid','dispatch_model_invalid','release_observation_failed','release_observation_invalid','actions_classification_invalid','agent_tool_not_allowed','agent_output_invalid','agent_output_budget_exhausted','agent_tool_calls_invalid','agent_turn_limit','gate_agent_output_invalid',
    'claude_submission_required','claude_authentication_failed','claude_model_unavailable','claude_execution_failed','claude_budget_exhausted','claude_output_limit','claude_provider_credential_unavailable','provider_credential_unavailable'] },
  environment: { label:'项目电脑或运行环境', codes:['harness_environment_required','integration_unavailable','pi_runtime_unavailable','controller_workspace_unavailable','container_workspace_required','acp_not_configured','acp_configuration_invalid','acp_protocol_unsupported','acp_mcp_http_unsupported','harness_timeout','acp_turn_incomplete','acp_execution_failed',
    'acp_product_not_installed','icode_protocol_unsupported','workswarm_protocol_unsupported','workswarm_model_protocol_unsupported','acp_invalid_launch_variable','acp_protocol_version_unsupported','acp_invalid_frame','acp_frame_too_large','acp_rpc_error','acp_invalid_response','acp_invalid_session','acp_invalid_prompt_response',
    'acp_process_failed','acp_process_exited','acp_connection_closed','acp_request_timeout','acp_sidecar_unhealthy','acp_lease_expired','acp_runtime_failed',
    'codex_not_configured','codex_configuration_invalid','codex_execution_failed','codex_output_limit',
    'codex_version_unsupported','codex_home_unexpected','codex_unauthorized_tool_servers','codex_task_tools_unavailable','codex_task_tools_mismatch','codex_protocol_invalid','codex_connection_lost','codex_connection_closed','acp_output_limit','codex_builtin_tools_enabled','codex_builtin_tool_refused','codex_resume_failed','codex_turn_interrupted','codex_thread_ownership_mismatch','role_snapshot_unavailable','checkpoint_unavailable','acceptance_snapshot_unavailable','environment_not_ready','environment_generation_changed','execution_interrupted','workspace_init_failed',
    'workspace_write_failed','workspace_snapshot_mismatch','conversation_workspace_unavailable','workspace_unavailable','candidate_unavailable','candidate_blob_unavailable',
    'run_candidate_export_failed','run_candidate_import_failed','run_candidate_mismatch',
    'claude_not_configured','claude_configuration_invalid','claude_restricted_gateway_required','claude_platform_unsupported','claude_binary_unavailable','claude_state_directory_invalid','claude_version_unsupported',
    'claude_protocol_incompatible','claude_gateway_scope_unverified','claude_gateway_protocol_invalid','claude_timeout','claude_stream_interrupted','claude_stream_truncated','claude_process_exit','claude_result_missing','claude_capability_mismatch',
    // #671: the data disk of the control plane or the manager is full; a repeated call whose stored result was removed.
    'disk_full','operation_result_expired',
    // #705/#1260: read-only /opt/agent-tools volume availability, compatibility, archive integrity and isolated installer.
    'agent_tools_volume_missing','cli_not_installed','cli_version_incompatible','platform_arch_unsupported','agent_tool_invalid','agent_tool_hash_mismatch','agent_tool_archive_invalid','agent_tool_isolated_installer_required','agent_tool_version_unverified'] },
  repository: { label:'仓库内容或规则', codes:['repository_has_no_commit','credential_in_repository','unsafe_repository_path','repository_path_conflict',
    'unsupported_blob_encoding','unsafe_skill_file','pull_request_file_limit','agent_context_too_large','github_pagination_limit','pull_request_media_invalid',
    // The repository's .agents/skills/ are the repository's to fix.
    'too_many_bot_skills','invalid_skill_file','invalid_rule_content','skill_file_too_large',
    // Raised only by versions that still read .bot/ files (before #935) or limited their sizes; tasks may still wait on them.
    'bot_rule_too_large','invalid_bot_rule_file','invalid_bot_label','invalid_bot_computer','unsafe_bot_rule',
    'release_file_invalid','release_tag_invalid','release_sensitive_body','release_notes_too_large','release_empty_repository','release_ci_unsuccessful',
    'actions_scan_window_overflow','actions_report_sensitive'] },
  task_changed: { label:'任务条件已变化', codes:['obsolete_superseded','obsolete_closed','obsolete_expired','manager_deferred','manager_needs_help','manager_cancel','manager_pause','bot_pr_closed','task_coordination_requested','task_coordination_pending','coordination_source_cancelled','coordination_claim_revoked','role_revision_checkpoint','harness_cancelled','harness_run_closed','team_no_progress','role_nomination_stale','acceptance_publication_changed','acceptance_context_changed','checkpoint_context_changed','acceptance_return','acceptance_insufficient_evidence','acceptance_needs_human','acceptance_no_progress','object_closed_or_draft','pull_request_head_changed','branch_head_changed','branch_disappeared',
    'task_claim_revoked','task_actor_permission_revoked','release_actor_permission_revoked','repository_policy_disabled','review_requires_human_decision','issue_needs_replan','development_not_approved',
    'target_branch_not_found','target_commit_not_found','target_ref_not_branch',
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
    // A nightly memory consolidation run was stopped or cancelled while running.
    'consolidation_stopped','consolidation_cancelled',
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
    'subscription_mode_not_implemented','claude_local_config_missing','codex_local_config_missing'] },
  publication: { label:'GitHub 写入结果未知', codes:['github_publication_unknown','release_write_unknown','actions_report_write_unknown','pr_release_label_incomplete'] },
  bot: { label:'Bot 自身问题', codes:['harness_permission_mismatch','pi_environment_required','external_harness_model_request','acceptance_required','task_runtime_failure','agent_limits_invalid','agent_tools_invalid','tool_operation_conflict','invalid_runner_request','pi_execution_failed','model_request_invalid','github_read_token_limit','acp_invalid_prompt',
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
  // An unlisted code in waiting_environment still describes an unmet outside condition (for example an integration's
  // tool-scope denial). Calling it the bot's own fault would also deny the permission cause; keep the wait in the
  // environment family. Unknown codes in failed tasks remain bot faults.
  if (state === 'waiting_environment') return 'environment';
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
  if (code === 'unsupported_capability' && detail?.includes('fixed_candidate_read')) return {
    cause: 'bot', label: causes.bot.label, automatic: automatic.has(state), attempt_retry,
    action: '当前运行缺少平台核验的固定候选记录（fixed_candidate_read），运行没有启动；该记录由平台生成，更换角色模型或执行后端无法补齐，请反馈给 bot 维护者。',
  };
  // An unclassified environment wait still names its own code: do not present it as a cause we recognise, and do not
  // hide the code behind the generic "check the computer" advice.
  if (state === 'waiting_environment' && cause === 'environment' && !byCode.has(code) && code !== 'task_runtime_failure') return {
    cause, label: '未归类的等待原因', automatic: automatic.has(state), attempt_retry,
    action: `已保留原始错误码「${code}」；请按任务说明检查所属环境、权限或外部服务，条件恢复后任务会自动继续。`,
  };
  const action = codeActions[code] || (ended.has(state) ? '任务已结束，无需处理。' : causeActions[cause](state));
  return { cause, label: causes[cause].label, action, automatic: automatic.has(state) || state === 'waiting_permission' && resumedWaits.has(code), attempt_retry };
}
