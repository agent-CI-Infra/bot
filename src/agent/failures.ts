// Every task stop belongs to one cause, so a reader can tell a passing outage from a setting someone has to change
// and from a defect in the bot itself. The fault detail says what happened; the cause says whose move it is.
export type FailureCause = 'external'|'github_access'|'github_rejected'|'model'|'environment'|'repository'|'task_changed'|'publication'|'bot';

const causes: Record<FailureCause,{label:string,codes:string[]}> = {
  external: { label:'外部服务或网络波动', codes:['github_unavailable','github_response_unknown','github_rate_limited','model_unavailable'] },
  github_access: { label:'GitHub 权限或配置', codes:['github_permissions_insufficient','github_installation_owner_changed','github_token_missing',
    'github_credentials_missing','github_account_missing','github_repository_scope_changed','github_actor_invalid','github_repository_invalid',
    'github_app_required','github_read_token_unavailable','github_read_token_not_read_only','branch_not_owned'] },
  github_rejected: { label:'GitHub 拒绝了请求', codes:[] },
  model: { label:'模型服务或模型配置', codes:['model_not_configured','model_key_missing','model_authentication_failed','model_response_invalid',
    'model_response_too_large','model_finding_invalid','model_review_invalid','create_pull_request_required','create_pull_request_not_allowed'] },
  environment: { label:'项目电脑或运行环境', codes:['environment_not_ready','environment_generation_changed','execution_interrupted','workspace_init_failed',
    'workspace_write_failed','workspace_snapshot_mismatch','candidate_unavailable','candidate_blob_unavailable'] },
  repository: { label:'仓库内容或规则', codes:['repository_has_no_commit','credential_in_repository','unsafe_repository_path','repository_path_conflict',
    'unsupported_blob_encoding','unsafe_bot_rule','pull_request_file_limit','agent_context_too_large','github_pagination_limit'] },
  task_changed: { label:'任务条件已变化', codes:['object_closed_or_draft','pull_request_head_changed','branch_head_changed','branch_disappeared',
    'task_claim_revoked','repository_policy_disabled','review_requires_human_decision','issue_needs_replan','development_not_approved',
    'base_branch_changed','bot_branch_history_changed','revision_scope_unconfirmed','pr_head_pending','bot_pr_identity_changed',
    'bot_pr_author_changed','bot_pr_head_repository_changed','bot_pr_branch_changed','bot_pr_ownership_unconfirmed'] },
  publication: { label:'GitHub 写入结果未知', codes:['github_publication_unknown'] },
  bot: { label:'Bot 自身问题', codes:['task_runtime_failure','tool_operation_conflict','pi_execution_failed','model_request_invalid','github_read_token_limit',
    'github_tree_mismatch','github_commit_tree_mismatch','github_blob_mismatch','candidate_blob_mismatch','candidate_blob_invalid','branch_not_confirmed',
    'github_invalid_response','github_invalid_page','github_response_too_large','repository_blob_invalid','repository_tree_invalid','repository_blob_limit_or_hash'] },
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
const automatic = new Set(['retry_wait','waiting_configuration','waiting_environment','waiting_pr_head']);
const ended = new Set(['cancelled','superseded']);
const retry = '改好后点「重试」。';
const codeActions: Record<string,string> = {
  repository_has_no_commit:'向仓库推送第一个提交后自动继续。',
  pr_head_pending:'正在等待 GitHub 把 PR head 更新到刚推送的提交，确认后自动继续。',
  object_closed_or_draft:'Issue 或 PR 已关闭或转为草稿，任务已结束，无需处理。',
  task_claim_revoked:'任务已被取消或由其他执行接管，无需处理。',
  repository_policy_disabled:'仓库已停用这类任务，任务已结束；需要时在项目设置里重新开启。',
  pull_request_head_changed:'PR 有了新的提交，这个任务已被取代，无需处理。',
  branch_head_changed:'分支被推送了其他提交，这个任务已被取代，无需处理。',
  branch_disappeared:'待更新的分支已被删除，这个任务已被取代，无需处理。',
  review_requires_human_decision:'检视认为需要人先确认需求：在 Issue 下补充说明后提及 bot 重新检视。重试这个任务不会改变结论。',
  issue_needs_replan:'Issue 的标题或正文在检视后被修改：在 Issue 下提及 bot 重新检视。重试这个任务不会改变结论。',
  development_not_approved:'重新加上开发标签、并确认没有其他人接手后点「重试」。',
  base_branch_changed:'点「重试」会基于最新的基础分支重新规划。',
  bot_branch_history_changed:'点「重试」会基于当前分支重新规划。',
  revision_scope_unconfirmed:'在 PR 上给出明确的修改意见后点「重试」。',
  create_pull_request_required:'模型没有通过 create_pull_request 提交修改。点「重试」会重新开始一次尝试；反复出现可换用更强的模型。',
  agent_context_too_large:'减少仓库 bot 规则或提示文件的大小后点「重试」。',
  pull_request_file_limit:'PR 改动文件过多，bot 无法确认完整差异。拆小 PR 后会重新检视。',
};
const causeActions: Record<FailureCause,(state:string)=>string> = {
  external: state => automatic.has(state) ? '不是配置问题，bot 会自动重试，一般无需处理。'
    : '已自动重试 5 次仍失败。先看 GitHub 状态页、模型服务和网络是否正常；都正常而同一个请求反复返回 502/504 时，多半是请求太大或太慢（GitHub 处理单个请求超过 10 秒会中止），请把任务链接反馈给 bot 维护者。恢复后点「重试」。',
  github_access: () => '按说明核对 GitHub App 是否安装到该仓库、授权的权限和仓库范围、账号凭据是否有效，' + retry,
  github_rejected: () => 'GitHub 收到了请求但不接受，通常是仓库当前状态与请求冲突（例如分支或 PR 已存在、分支保护规则）。按说明核对仓库后点「重试」；无法解释时请反馈给 bot 维护者。',
  model: () => '检查项目的模型地址、模型名和 API Key；模型输出不符合要求时可以点「重试」，或换用其他模型。',
  environment: state => automatic.has(state) ? '通常会自行恢复，恢复后任务自动继续；长时间不恢复请在项目页检查虚拟电脑。'
    : '请在项目页检查虚拟电脑后点「重试」。',
  repository: () => '按说明修改仓库内容或 bot 规则后点「重试」。',
  task_changed: () => '按说明处理后点「重试」。',
  publication: () => 'GitHub 没有确认这次写入，bot 也没在 GitHub 上找到它。点「重试」会先再查一次，确实没有才重新发送，不会重复发布。',
  bot: () => '这是 bot 内部校验失败或运行异常，与外部服务和权限无关。可以先点「重试」；反复出现请把任务链接和上面的说明反馈给 bot 维护者。',
};

export function explainFailure(code: string|null|undefined, state = 'failed') {
  if (!code) return null;
  const cause = failureCause(code, state);
  const action = codeActions[code] || (ended.has(state) ? '任务已结束，无需处理。' : causeActions[cause](state));
  return { cause, label: causes[cause].label, action, automatic: automatic.has(state) };
}
