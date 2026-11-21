import type { GitHub } from './client.js';
import { stop } from '../agent/common.js';

export interface CandidateFileEntry {
  path: string;
  sha?: string;
  mode?: string;
}

/** Whether a repository-relative path lies under GitHub's `.github/workflows/` directory (case-insensitive). */
export const isWorkflowPath = (path: unknown): boolean =>
  typeof path === 'string' && /^\.github\/workflows(?:\/|$)/i.test(path.replace(/^\/+/, ''));

/** Whether a task carries a project administrator's explicit `workflow_changes` confirmation. */
export function hasWorkflowChangesConfirmation(task: { input?: unknown }): boolean {
  try {
    return !!JSON.parse(String(task.input || '{}')).workflow_changes?.confirmed_by;
  } catch {
    return false;
  }
}

/**
 * Returns sorted `.github/workflows/` paths added, modified (content SHA or mode changed), or deleted relative to
 * `snapshotFiles`. Unchanged workflow files already present in the baseline snapshot are excluded.
 */
export function changedWorkflowPaths(
  files: ReadonlyArray<CandidateFileEntry> = [],
  snapshotFiles: ReadonlyArray<CandidateFileEntry> = [],
): string[] {
  const upstream = new Map(snapshotFiles.map(file => [file.path, file]));
  const current = new Set(files.map(file => file.path));
  const touched = new Set<string>();
  for (const file of files) {
    const previous = upstream.get(file.path);
    if ((previous?.sha !== file.sha || previous?.mode !== file.mode) && isWorkflowPath(file.path)) {
      touched.add(file.path);
    }
  }
  for (const file of snapshotFiles) {
    if (!current.has(file.path) && isWorkflowPath(file.path)) {
      touched.add(file.path);
    }
  }
  return [...touched].sort();
}

export function formatWorkflowPaths(paths: ReadonlyArray<string>): string {
  return paths.length <= 10 ? paths.join('、') : `${paths.slice(0, 10).join('、')} 等共 ${paths.length} 个文件`;
}

export function workflowChangesNotConfirmedDetail(paths: ReadonlyArray<string>): string {
  return `候选改动涉及 ${formatWorkflowPaths(paths)}，但当前任务未经项目管理员在控制台确认允许修改 .github/workflows/（重试原任务不会生效），请由项目管理员在控制台新建勾选「允许修改 .github/workflows/（CI 改动）」的任务，或在控制台管理助手确认卡片后发起；若不需 Bot 改 workflow，请改由维护人手动修改。`;
}

export function workflowsPermissionMissingDetail(paths: ReadonlyArray<string>, isApp = true): string {
  const listed = formatWorkflowPaths(paths);
  return isApp
    ? `候选改动涉及 ${listed}，但当前 GitHub App 安装缺少 Workflows: Read and write 权限（或签发令牌未获授 workflows: write），请管理员在 GitHub App 权限与仓库安装中开通后重试。`
    : `候选改动涉及 ${listed}，但当前 GitHub 凭据缺少修改 .github/workflows/ 所需的 Workflows: Read and write（或令牌 workflow）权限，请管理员在 GitHub App 权限与仓库安装中开通（或为机器人令牌授予 workflow 权限）后重试。`;
}

export function workflowChangesSubmissionError(
  paths: ReadonlyArray<string>,
  tool: 'create_pull_request' | 'open_pull_request' | 'submit_delivery',
) {
  const listed = formatWorkflowPaths(paths);
  const guidance =
    tool === 'open_pull_request'
      ? 'Revert the .github/workflows/ changes and call open_pull_request again, or deliver a report via submit_report explaining that a project administrator must create a CI-confirmed task in the console (checking 「允许修改 .github/workflows/（CI 改动）」).'
      : `Revert the .github/workflows/ changes and call ${tool} again (or submit without workflow changes and explain in the summary that a project administrator must create a CI-confirmed task in the console checking 「允许修改 .github/workflows/（CI 改动）」).`;
  return {
    error: 'workflow_changes_not_confirmed' as const,
    files: [...paths],
    message: `Cannot publish changes under .github/workflows/ (${listed}) because this task was not confirmed by a project administrator for CI changes (workflow_changes). ${guidance}`,
  };
}

/**
 * Verifies before sending Git tree/ref writes to GitHub that any candidate change touching `.github/workflows/`
 * (addition, modification, or deletion) has both task-level `workflow_changes` confirmation and `workflows: write`
 * granted to the GitHub App installation and minted token. Returns the touched workflow paths when authorized.
 */
export function assertWorkflowChangesAuthorized(
  task: { input?: unknown },
  github: Partial<Pick<GitHub, 'installationPermissions' | 'permissions'>>,
  candidate: { files?: ReadonlyArray<CandidateFileEntry>; snapshot_files?: ReadonlyArray<CandidateFileEntry> },
): string[] {
  const workflowFiles = changedWorkflowPaths(candidate.files ?? [], candidate.snapshot_files ?? []);
  if (!workflowFiles.length) return [];
  if (!hasWorkflowChangesConfirmation(task)) {
    stop('workflow_changes_not_confirmed', 'waiting_permission', workflowChangesNotConfirmedDetail(workflowFiles));
  }
  const installationPermissions = github.installationPermissions;
  const tokenPermissions = github.permissions && typeof github.permissions === 'object' ? github.permissions : {};
  const hasTokenScope = Object.keys(tokenPermissions).length > 0;
  const hasAppScope = installationPermissions != null || hasTokenScope;
  if (hasAppScope) {
    const installationAllows = !installationPermissions || installationPermissions.workflows === 'write';
    const tokenAllows = !hasTokenScope || tokenPermissions.workflows === 'write';
    if (!installationAllows || !tokenAllows) {
      stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
    }
  }
  return workflowFiles;
}
