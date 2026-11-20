import { ManagerError } from './docker.mjs';
import { normalizePolicy } from '../runner/browser-policy.mjs';

const runnerTypes = ['command','read','write','workspace_init','workspace_source','workspace_tree','workspace_restore','workspace_integrate','workspace_integration_check','workspace_checkout','workspace_advance','workspace_context','git_have','git_pack','git_import','git_export','workspace_write','workspace_snapshot','workspace_read','workspace_export','workspace_command','workspace_browser','workspace_finalize','workspace_blob','workspace_worktree_create','workspace_worktree_bind','workspace_worktree_inspect','workspace_agent_boundary','workspace_agent_continue','workspace_agent_config','workspace_agent_start','workspace_agent_poll','workspace_agent_reply','workspace_agent_progress','workspace_agent_token','workspace_agent_tool','workspace_agent_model_request','workspace_agent_model_reply','workspace_agent_live','workspace_agent_runtime','workspace_agent_result','workspace_harness_config','workspace_harness_start','workspace_harness_stdin','workspace_harness_poll','workspace_harness_interrupt','reap','tasks_list','tasks_remove','worktrees_list','worktrees_remove'];
const runnerKeys = ['type','command','path','content','timeout_ms','keep_background','workspace_id','source_workspace_id','worktree_id','worktree_ids','on_changes','base_tree','base64','offset','author_email','final','mode','grace_ms','instance_id','wait_ms','known_tool_ids','known_token_ids','known_model_ids','snapshot','sha','tree_sha','config','request_id','sequence','idle','pack_id','commits','entries','status','headers','error','action','args','policy','url','name','selector','text','label'];

// The control plane's workspace cleanup: list the task directories or shared worktrees, remove a few of them per call
// (runner/task-dirs.mjs).
const cleanupTypes = ['tasks_list', 'tasks_remove', 'worktrees_list', 'worktrees_remove'];
export function isCleanupCall(type) {
  return cleanupTypes.includes(type);
}

function validIdArray(value) {
  return Array.isArray(value) && value.length <= 512 && value.every(id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id));
}
// A runner request is checked before it can touch the computer, so a malformed one never interrupts other tasks.
function validateBrowserCall(call) {
  const actions = ['open', 'see', 'click', 'type', 'screenshot', 'close'];
  if (!actions.includes(String(call.action || ''))) throw new ManagerError('invalid_runner_request', 400);
  if (call.action !== 'close' && !normalizePolicy(call.policy)) throw new ManagerError('invalid_runner_request', 400);
  if (call.args !== undefined && (!call.args || typeof call.args !== 'object' || Array.isArray(call.args))) throw new ManagerError('invalid_runner_request', 400);
}
export function validateCall(call) {
  if (!call || !runnerTypes.includes(call.type) || Object.keys(call).some(k => !runnerKeys.includes(k))) throw new ManagerError('invalid_runner_request', 400);
  if (call.type === 'workspace_browser') validateBrowserCall(call);
  if (call.type === 'workspace_agent_result' && (!/^[a-f0-9]{48}$/.test(call.request_id??'') || !Number.isSafeInteger(call.offset) || call.offset<0)) throw new ManagerError('invalid_runner_request',400);
  if (call.workspace_id !== undefined && !/^[a-f0-9]{48}$/.test(call.workspace_id) || call.idle !== undefined && call.idle !== true) throw new ManagerError('invalid_runner_request', 400);
  // The three-way integration the control plane starts when a branch fell behind main names the workspace it integrates
  // from (src/tasks/integration.ts:52); runner/workspace.mjs refuses a snapshot without a 40-hex sha, tree and base tree
  // and a source other than its own workspace, so the manager refuses it before the call reaches the computer.
  // An observer's or evaluator's worktree (#769) may name the task directory whose context it copies.
  const sourced = ['workspace_restore','workspace_integrate'], mayName = [...sourced, 'workspace_worktree_create', 'workspace_worktree_bind'];
  if (call.source_workspace_id !== undefined && (!mayName.includes(call.type) || !/^[a-f0-9]{48}$/.test(call.source_workspace_id))) throw new ManagerError('invalid_runner_request', 400);
  if (sourced.includes(call.type) && !/^[a-f0-9]{48}$/.test(call.source_workspace_id || '')) throw new ManagerError('invalid_runner_request', 400);
  if (call.type === 'workspace_integrate' && (![call.sha,call.tree_sha,call.base_tree].every(value => /^[a-f0-9]{40}$/.test(value || '')) || call.source_workspace_id === call.workspace_id)) throw new ManagerError('invalid_runner_request', 400);
  // A shared worktree (#769) is named only by the calls that create or bind it, by its 48-hex id.
  const worktreeCalls = ['workspace_worktree_create', 'workspace_worktree_bind'];
  if (worktreeCalls.includes(call.type) !== (call.worktree_id !== undefined) || call.worktree_id !== undefined && !/^[a-f0-9]{48}$/.test(call.worktree_id)) throw new ManagerError('invalid_runner_request', 400);
  // Taking a worktree with changes or at another commit is a choice the call names; listing names at most 30 worktrees.
  if (call.on_changes !== undefined && (call.type !== 'workspace_worktree_bind' || !['reset', 'keep_changes'].includes(call.on_changes))) throw new ManagerError('invalid_runner_request', 400);
  if ((call.type === 'workspace_worktree_inspect') !== (call.worktree_ids !== undefined) || call.worktree_ids !== undefined && (!validIdArray(call.worktree_ids) || call.worktree_ids.length > 30)) throw new ManagerError('invalid_runner_request', 400);
  if (call.timeout_ms != null && !(Number.isFinite(call.timeout_ms) && call.timeout_ms > 0)) throw new ManagerError('invalid_runner_request', 400);
  if (call.grace_ms != null && !(Number.isSafeInteger(call.grace_ms) && call.grace_ms > 0)) throw new ManagerError('invalid_runner_request', 400);
  if (call.instance_id !== undefined && !/^[a-f0-9]{48}$/.test(call.instance_id)) throw new ManagerError('invalid_runner_request', 400);
  if (call.wait_ms !== undefined && !(Number.isSafeInteger(call.wait_ms) && call.wait_ms >= 0 && call.wait_ms <= 1000)) throw new ManagerError('invalid_runner_request', 400);
  for (const key of ['known_tool_ids', 'known_token_ids', 'known_model_ids']) {
    if (call[key] !== undefined && !validIdArray(call[key])) throw new ManagerError('invalid_runner_request', 400);
  }
  // A cleanup call names task directories only by their ids, at most 20 at a time, and carries nothing else.
  if (isCleanupCall(call.type) ? Object.keys(call).some(k => !['type', 'entries'].includes(k)) || (call.type.endsWith('_list') ? call.entries !== undefined
    : !Array.isArray(call.entries) || !call.entries.length || call.entries.length > 20 || call.entries.some(entry => !entry || typeof entry !== 'object'
      || Object.keys(entry).some(k => !['name', 'active_at'].includes(k)) || !/^[a-f0-9]{48}$/.test(entry.name) || !Number.isSafeInteger(entry.active_at) || entry.active_at < 0))
    : call.entries !== undefined) throw new ManagerError('invalid_runner_request', 400);
}
