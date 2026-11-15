import { isAbsolute, resolve } from 'node:path';

// Local execution is opt-in. Container defaults stay unchanged.
export const local = process.env.BOT_LOCAL_EXECUTION === 'true';
if (local && (!process.env.BOT_LOCAL_WORKSPACE || !isAbsolute(process.env.BOT_LOCAL_WORKSPACE))) throw new Error('local_workspace_required');
export const workspaceRoot = local ? resolve(process.env.BOT_LOCAL_WORKSPACE) : '/workspace';
export const runnerRoot = local ? import.meta.dirname : '/opt/runner';
export const tasksDirectory = workspaceRoot + '/tasks';
// The computer's git worktrees (#769): each is /workspace/worktrees/<id>, a worktree of the store, and a task uses one
// through the link /workspace/tasks/<workspace id>/repo. A worktree can serve several tasks, one after another.
export const worktreesDirectory = workspaceRoot + '/worktrees';
export const localEnvironment = local ? { BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: workspaceRoot } : {};
// An assistant computer (#457, manager/assistant-computers.mjs) keeps HOME on its own persistent mount; /workspace and /tmp
// are temporary. Project computers keep HOME in the work volume.
export const assistant = !local && process.env.BOT_COMPUTER_KIND === 'assistant';
export const homeDirectory = assistant ? '/home/assistant' : workspaceRoot + '/home';
