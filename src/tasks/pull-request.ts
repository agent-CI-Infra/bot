import { integratedPublication } from './integration.js';
import type { Store, Row } from '../storage/database.js';
import { stop, sha, type Redactor } from '../agent/common.js';
import { GitHub } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { roleConfiguration } from '../roles/definition.js';
import { permitsTool } from '../roles/permissions.js';
import { assertManagedExecution, assertTaskExternalEffect, sourcePolicies, taskToolAllowed } from './management.js';
import { grantedWrites, projectRefusal, sourceRefusal } from './grants.js';
import { taskPermissions } from './configuration.js';
import { TaskRecords } from './service.js';
import { stopAboveCeiling } from '../projects/ceiling.js';

export const isRequestedTask = (task: { kind?: unknown }) => ['task.request', 'task.development'].includes(String(task.kind ?? ''));

export const workflowChanges = (task: Row) => !!JSON.parse(task.input || '{}').workflow_changes?.confirmed_by;

export const pullRequestPermissions = (task: Row): Record<string, string> | undefined =>
  workflowChanges(task) ? { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' } : undefined;

export const genericTask = (task: Row) => task.kind === 'task.request' && JSON.parse(task.input || '{}').generic === true;

export const softwareRequest = (task: Row) => {
  const input = JSON.parse(task.input || '{}');
  return isRequestedTask(task) && (genericTask(task) ? input.delivery === 'pull_request' : input.contract?.endpoint === 'reviewable_pull_request');
};

export function pullRequestRefusal(store: Store, task: Row): { code: string; state: 'waiting_permission' | 'waiting_configuration'; message: string; missing: string } | null {
  const origin = assertManagedExecution(store, task);
  const project = projectRefusal(store, String(task.repository_id), 'pull_request');
  if (project) {
    return {
      code: project.code,
      state: project.code === 'capability_ceiling' ? 'waiting_permission' : 'waiting_configuration',
      message: project.message,
      missing: project.code === 'capability_ceiling' ? 'capability_ceiling:develop' : 'development_switch',
    };
  }
  if (!(grantedWrites(store, String(task.id)) ?? []).includes('pull_request')) {
    return {
      code: 'delivery_not_granted',
      state: 'waiting_permission',
      message: '这个任务没有被授予开 PR（pull_request）；Manager 可以用 grant_writes 授予，或改为 submit_report 交报告。',
      missing: 'grant:pull_request',
    };
  }
  const source = sourceRefusal(sourcePolicies(store, task), 'pull_request');
  if (source) return { ...source, state: 'waiting_permission', missing: 'source:pull_request' };
  if (origin?.executor_role) {
    const executor = roleConfiguration(store, task.repository_id).roles.find(r => r.role_id === origin.executor_role && r.enabled);
    if (!executor || !(permitsTool(executor.permissions, 'write_file') && taskToolAllowed(store, task, executor.role_id, 'write_file'))) {
      return {
        code: 'task_pull_request_forbidden',
        state: 'waiting_permission',
        message: '执行角色必须能修改虚拟电脑中的代码；任务管理或委派不能增加这项能力。',
        missing: 'executor:write_file',
      };
    }
  }
  return null;
}

export function assertRequestPullRequest(store: Store, task: Row): void {
  if (genericTask(task)) {
    const refusal = pullRequestRefusal(store, task);
    if (refusal) stop(refusal.code, refusal.state, refusal.message);
    return;
  }
  const origin = assertManagedExecution(store, task);
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', task.repository_id);
  if (!softwareRequest(task) || !policy?.enabled) stop('task_software_disabled', 'waiting_configuration');
  stopAboveCeiling(store, task.repository_id, 'develop');
  const writes = taskPermissions(store, task).writes;
  if (!writes.includes('code') || !writes.includes('pull_request')) {
    stop('task_pull_request_forbidden', 'waiting_permission', '这类任务的写入被收窄为不含修改代码和交付 PR。');
  }
  if (origin?.executor_role) {
    const executor = roleConfiguration(store, task.repository_id).roles.find(r => r.role_id === origin.executor_role && r.enabled);
    if (!executor || !(permitsTool(executor.permissions, 'write_file') && taskToolAllowed(store, task, executor.role_id, 'write_file'))) {
      stop('task_pull_request_forbidden', 'waiting_permission', '执行角色必须能修改虚拟电脑中的代码；任务管理或委派不能增加这项能力。');
    }
  }
  assertTaskExternalEffect(store, task, 'pull_request');
}

export function requestPolicyHash(store: Store, task: Row): string {
  return sha(String(store.get('SELECT test_command FROM policies WHERE repository_id=?', task.repository_id)?.test_command || ''));
}

export async function publishRequestPullRequest(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, log: (value: any) => void, apiUrl?: string) {
  const validate = async () => { await guard(); check(); };
  const check = () => {
    assertRequestPullRequest(store, task);
    const record = new TaskRecords(store).get(task.id);
    const accepted = record.pending;
    const code = record.candidate?.artifacts.find(a => a.kind === 'code');
    const saved = store.get('SELECT data FROM development_candidates WHERE task_id=?', task.id);
    const candidate = saved && JSON.parse(saved.data);
    if (
      !accepted ||
      !['pass', 'pass_with_issues'].includes(accepted.outcome) ||
      accepted.candidate_id !== record.candidate?.id ||
      accepted.revision !== record.revision ||
      accepted.policy_hash !== requestPolicyHash(store, task) ||
      !code ||
      code.version !== candidate?.tree_sha ||
      (code.content as any)?.branch !== candidate.branch ||
      (code.content as any)?.base_sha !== candidate.base_sha
    ) {
      stop('acceptance_required', 'retry_wait', '当前软件候选必须先通过独立 QA 与当前项目验证策略。');
    }
  };
  await validate();
  const repo = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
  const github = new GitHub(store, repo, redactor, validate, apiUrl);
  github.purpose = 'pull_request';
  github.beforeWrite = check;
  try {
    await github.connect(true, undefined, pullRequestPermissions(task));
    const candidate = JSON.parse(store.get('SELECT data FROM development_candidates WHERE task_id=?', task.id)!.data);
    const publisher = new Publisher(store, github, task, validate, undefined, log);
    const commit = await publisher.branch(candidate);
    const pr = await publisher.pullRequest(candidate, commit);
    await validate();
    integratedPublication(store, task, commit);
    return {
      summary: candidate.summary,
      test_command: candidate.test_command,
      pr_number: pr.number,
      pr_url: pr.html_url,
      branch: candidate.branch,
      sha: commit,
      tree_sha: candidate.published_tree_sha || candidate.tree_sha,
      local_sha: candidate.local_sha,
      validation: candidate.validation,
    };
  } finally {
    await github.revokeTokens('pull_request');
  }
}
