import { type Workspace } from './workspace.js';
import { listWorktrees, reusableWorktrees, taskPlan, taskWorktree, type WorktreePlan } from '../projects/worktrees.js';

/*
 * The tools that choose a task's workspace (#769). A task prepared through the computer's git store holds no worktree until
 * it first needs its files (Workspace.plan). Its controller, or its agent when the project has no role team, may choose
 * first: an existing worktree of the computer, a new one, or none. Without a choice the system's applies at the first
 * repository read or command, so a task that never chooses costs no extra turn. The system keeps the guarantees: one
 * writer per worktree, the runner's check of HEAD, tree and changes at every handover, and no change discarded without
 * reset (which saves it as a patch first).
 */
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
export const workspaceTools = [
  tool('list_workspaces', 'List this project\'s worktrees on the project computer: id, HEAD, whether it is at this task\'s commit, changed files, last use, and the unfinished tasks holding it (read or write). Also shows this task\'s commit and what the system would give it.', {}),
  tool('use_workspace', 'Take an existing worktree from list_workspaces as this task\'s checkout, before your first repository read or command. read shares it with other readers; write needs one no unfinished task holds. A worktree with changes or at another commit needs on_changes: reset saves its changes as a patch under ../context/ and restores it to this task\'s commit, keeping ignored files such as installed dependencies; keep_changes (write, same commit) works on top of its changes. Answers the exact HEAD, tree and changed files.',
    { worktree_id: { type: 'string' }, mode: { type: 'string', enum: ['read', 'write'] }, on_changes: { type: 'string', enum: ['reset', 'keep_changes'] } }, ['worktree_id']),
  tool('create_workspace', 'Make a new worktree of this task\'s commit as its checkout instead of reusing one.', { mode: { type: 'string', enum: ['read', 'write'] } }),
  tool('no_workspace', 'Work without repository files: no worktree is made or taken. ../context/ and ../notes/ stay readable. Not for tasks that change files.', { reason: { type: 'string' } }, ['reason']),
];
export const workspaceToolNames = workspaceTools.map(t => t.function.name);

/** The system prompt's rule for an agent offered the tools. */
export const workspaceInstructions = 'Repository workspace: this task holds no worktree until it first needs repository files (see context.workspace). The first repository read or command binds the system\'s choice. To choose yourself, do it before that: use_workspace or create_workspace (list_workspaces shows the computer\'s worktrees), or no_workspace when the task needs no repository files.';
/** The same rule for a task's controller, given with its workspace in the prompt: its roles work in the worktree it chooses. */
export const controllerWorkspaceInstructions = 'This task holds no worktree yet. The first repository read or command of the task, yours or a delegated role\'s, binds the system\'s choice above, which suits most tasks. To choose instead, do it before delegating: use_workspace or create_workspace (list_workspaces shows the computer\'s worktrees), or no_workspace when the task needs no repository files. Delegated roles work in the worktree you choose and cannot choose one themselves.';

/** What the prompt tells about the task's workspace while it holds none: the system's choice to come, or none chosen. */
export function workspaceContext(plan: Pick<WorktreePlan, 'head_sha' | 'mode'> & Partial<Pick<WorktreePlan, 'state' | 'reason'>>) {
  if (plan.state === 'none') return { commit: plan.head_sha, mode: plan.mode, worktree: 'none', reason: plan.reason ?? null };
  return { commit: plan.head_sha, mode: plan.mode, worktree: 'not_bound',
    binding: plan.mode === 'read' ? 'The first repository read or command binds an unchanged worktree of this commit that no task holds, or a new one.' : 'The first repository read or command binds a new worktree of this commit.' };
}

/** A review's coverage as published: a task that chose to work without files says so, and who chose, instead of naming a checkout. */
export function workspaceCoverage(workspace: Workspace, coverage: string[] = []) {
  const plan = workspace.plannedWorktree?.();
  if (plan?.state !== 'none') return coverage;
  const chose = plan.decided_by === 'agent' ? 'the agent worked' : `the controller (${plan.decided_by}) chose to work`;
  return coverage.map(line => line.startsWith('Checkout:') ? `No checkout: ${chose} without the repository files (${plan.reason})` : line);
}

// The worktree the system would give the task now.
function systemChoice(workspace: Workspace, plan: WorktreePlan) {
  if (plan.mode === 'read') {
    const reuse = reusableWorktrees(workspace.store, String(workspace.task.repository_id), Number(workspace.task.generation), plan.head_sha).find(row => row.tree_sha === plan.tree_sha);
    if (reuse) return { action: 'use', worktree_id: reuse.id, mode: 'read' };
  }
  return { action: 'create', mode: plan.mode };
}

/** list_workspaces: the registry's worktrees of this computer, with what the runner sees in each now. */
export async function listWorkspaces(workspace: Workspace) {
  const { store, task } = workspace, plan = taskPlan(store, task), repo = String(task.repository_id);
  if (!plan) return { error: 'workspace_not_selectable', message: 'This task\'s workspace was prepared without the computer\'s git store; it cannot be chosen.' };
  const rows = listWorktrees(store, repo, Number(task.generation));
  const inspected = rows.length ? await workspace.deliver({ type: 'workspace_worktree_inspect', worktree_ids: rows.map(row => row.id) }) : { worktrees: [] };
  const live = new Map<string, any>((Array.isArray(inspected?.worktrees) ? inspected.worktrees : []).map((entry: any) => [entry.worktree_id, entry]));
  const held = taskWorktree(store, task);
  return {
    task: { commit: plan.head_sha, tree_sha: plan.tree_sha, mode: plan.mode, holds: held ? { worktree_id: held.worktree_id, mode: held.mode } : plan.state === 'none' ? 'none' : null,
      system_choice: held || plan.state === 'none' ? null : systemChoice(workspace, plan) },
    ...(inspected?.error ? { inspection: { error: inspected.error, detail: inspected.detail ?? null } } : {}),
    worktrees: rows.map(row => {
      const now = live.get(row.id), head = now?.head ?? row.head_sha, tree = now?.tree_sha ?? row.tree_sha;
      return { worktree_id: row.id, head, at_task_commit: head === plan.head_sha && tree === plan.tree_sha, made_for: row.mode,
        ...(row.state === 'ready' ? {} : { system_offers: false, state_reason: row.state_reason }),
        ...(now?.present === false ? { present: false } : { changed_count: now?.changed_count ?? null, ...(now?.changed?.length ? { changed: now.changed } : {}) }),
        last_used: now?.used_at ?? row.used_at,
        holders: row.holders.map(holder => {
          const other = store.get('SELECT kind,object_number,status FROM tasks WHERE id=?', holder.task_id);
          return { task_id: holder.task_id, kind: other?.kind ?? null, object_number: other?.object_number ?? null, mode: holder.mode, running: ['running', 'publishing'].includes(String(other?.status)), ...(holder.task_id === task.id ? { this_task: true } : {}) };
        }) };
    }) };
}

/** Runs one of the tools for the task; `by` is who chose (the controller's role id, or 'agent'). */
export async function workspaceTool(workspace: Workspace, name: string, args: any, by: string, callId?: string) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'list_workspaces') return listWorkspaces(workspace);
  if (name === 'use_workspace') return workspace.choose('use', input, by, callId);
  if (name === 'create_workspace') return workspace.choose('create', input, by, callId);
  if (name === 'no_workspace') return workspace.choose('none', input, by, callId);
  return { error: 'tool_not_allowed' };
}
