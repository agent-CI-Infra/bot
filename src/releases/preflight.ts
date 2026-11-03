import { randomId, digest } from '../core/security.js';
import { sha, stop } from '../agent/common.js';
import { versionPattern, validVersion, prerelease } from './version.js';
import { releaseWorkflow } from './workflow.js';
import { file, tag, releases, skillPath } from './github.js';
import type { GitHub } from '../github/client.js';
import { previousTag, newCommits } from './range.js';
export const noCI = '这个仓库还没有接入发布用的 CI。请先在「公共配置」接入门禁。';
export const noRelease = '已接入门禁，但默认分支没有由版本标签触发的 Release 工作流，发版本不可用。';
export const builtinRule = 'release-notes-v1: list only verified commits and merged pull requests with source links; never infer features, tests or performance.';
export async function inspect(github: GitHub, version: string) {
  const ref = await github.ref(github.defaultBranch), target = ref?.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(target)) stop('release_empty_repository', 'failed', '默认分支还没有可发布的提交。');
  const commit = await github.request('GET', github.path('/commits/' + target));
  const config = await file(github, target, '.github/ci-gates.json', true);
  const ci = await file(github, target, '.github/workflows/ci.yml', true) ?? await file(github, target, '.github/workflows/ci-gates.yml', true);
  const workflowFile = await file(github, target, '.github/workflows/release.yml');
  let workflow: any = null, reason = '', workflowId: number | null = null;
  if (workflowFile) {
    try { workflow = releaseWorkflow(workflowFile.content, version); reason = workflow.reason; }
    catch (error) { reason = (error as Error).message; }
    if (workflow?.matched) {
      const value = await github.request('GET', github.path('/actions/workflows/release.yml'), undefined, true);
      if (value?.path === '.github/workflows/release.yml' && value.state === 'active') workflowId = value.id;
      else reason = 'Release workflow 尚未注册或已停用';
    }
  } else reason = '缺少 .github/workflows/release.yml';
  const skill = await file(github, target, skillPath);
  const existingTag = validVersion(version) ? await tag(github, version) : null;
  const existingRelease = validVersion(version) ? await releases(github, version) : null;
  const previous = await previousTag(github, target, version);
  const noChanges = previous !== null && (await newCommits(github, target, previous)).length === 0;
  const checks = [{ ok: !!(config && ci), message: config && ci ? '已接入发布用的 CI' : noCI },
    { ok: !!(workflow?.matched && workflowId), message: workflow?.matched && workflowId ? '版本标签可触发 Release 工作流' : noRelease, reason },
    { ok: !noChanges, message: noChanges ? '没有新变更，跳过本次发布；不会创建标签或 Release。' : previous ? '本次范围有新增提交' : '首次发布，从仓库历史起算' }];
  return { available: checks.every(c => c.ok) && validVersion(version) && (!existingTag || existingTag.commit === target),
    checks, version, version_valid: validVersion(version), version_pattern: versionPattern, prerelease: prerelease(version), target_sha: target,
    target_title: String(commit.commit?.message || '').split('\n')[0], target_url: commit.html_url, default_branch: github.defaultBranch,
    workflow_id: workflowId, workflow, files: { config: config?.sha, ci: ci?.sha, release: workflowFile?.sha },
    previous_tag: previous, no_changes: noChanges, existing_tag: existingTag, existing_release: existingRelease ? { id: existingRelease.id, draft: existingRelease.draft, url: existingRelease.html_url } : null,
    skill: { source: skill ? 'repository' : 'builtin', path: skill ? skillPath : null, sha: target, hash: sha(skill?.content ?? builtinRule), version: skill ? null : 'release-notes-v1', content: skill?.content ?? builtinRule } };
}
export const fingerprint = (preview: unknown) => digest(JSON.stringify(preview));
export const preflightToken = () => randomId();
