import { isAbsolute, resolve } from 'node:path';

// Local execution is opt-in. Container defaults stay unchanged.
export const local = process.env.BOT_LOCAL_EXECUTION === 'true';
if (local && (!process.env.BOT_LOCAL_WORKSPACE || !isAbsolute(process.env.BOT_LOCAL_WORKSPACE))) throw new Error('local_workspace_required');
export const workspaceRoot = local ? resolve(process.env.BOT_LOCAL_WORKSPACE) : '/workspace';
export const runnerRoot = local ? import.meta.dirname : '/opt/runner';
export const tasksDirectory = workspaceRoot + '/tasks';
export const localEnvironment = local ? { BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: workspaceRoot } : {};
// An assistant computer (#457, manager/assistant-computers.mjs) keeps HOME on its own persistent mount; /workspace and /tmp
// are temporary. Project computers keep HOME in the work volume.
export const assistant = !local && process.env.BOT_COMPUTER_KIND === 'assistant';
export const homeDirectory = assistant ? '/home/assistant' : workspaceRoot + '/home';
