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

export function workflowsPermissionMissingDetail(paths: ReadonlyArray<string>, isApp = true): string {
  const listed = formatWorkflowPaths(paths);
  return isApp
    ? `候选改动涉及 ${listed}，但当前 GitHub App 安装缺少 Workflows: Read and write 权限（或签发令牌未获授 workflows: write），请管理员在 GitHub App 权限与仓库安装中开通后重试。`
    : `候选改动涉及 ${listed}，但当前 GitHub 凭据缺少修改 .github/workflows/ 所需的 Workflows: Read and write（或令牌 workflow）权限，请管理员在 GitHub App 权限与仓库安装中开通（或为机器人令牌授予 workflow 权限）后重试。`;
}

/**
 * Verifies before sending Git tree/ref writes to GitHub that any candidate change touching `.github/workflows/`
 * (addition, modification, or deletion) is allowed by the GitHub App installation's granted `workflows: write`
 * permission. Returns the touched workflow paths when authorized.
 */
export function assertWorkflowChangesAuthorized(
  github: Partial<Pick<GitHub, 'installationPermissions' | 'permissions' | 'isAppInstallation'>>,
  candidate: { files?: ReadonlyArray<CandidateFileEntry>; snapshot_files?: ReadonlyArray<CandidateFileEntry> },
): string[] {
  const workflowFiles = changedWorkflowPaths(candidate.files ?? [], candidate.snapshot_files ?? []);
  if (!workflowFiles.length) return [];
  const installationPermissions = github.installationPermissions;
  const tokenPermissions = github.permissions && typeof github.permissions === 'object' ? github.permissions : {};
  const hasTokenScope = Object.keys(tokenPermissions).length > 0;
  if (installationPermissions != null && installationPermissions.workflows !== 'write') {
    stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
  }
  if (!github.isAppInstallation && hasTokenScope && tokenPermissions.workflows !== 'write') {
    stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
  }
  return workflowFiles;
}
