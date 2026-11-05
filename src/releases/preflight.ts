import { randomId, digest } from '../core/security.js';
import { sha, stop } from '../agent/common.js';
import { versionPattern, validVersion, prerelease, compareVersions, nextVersions } from './version.js';
import { releaseWorkflow } from './workflow.js';
import { file, tag, releases, skillPath } from './github.js';
import type { GitHub } from '../github/client.js';
import { previousTag, newCommits } from './range.js';
export const noCI = '这个仓库还没有接入发布用的 CI。请先在「接入门禁」中创建门禁 PR。';
export const noRelease = '已接入门禁，但默认分支没有由版本标签触发的 Release 工作流，发版本不可用。';
export const versionNotHigher = (version: string, previous: string) =>
  `版本 ${version} 不高于上一枚版本标签 ${previous}，不能发布。请填写更高的版本，例如 ${nextVersions(previous).join(' 或 ')}。`;
export const builtinRule = 'release-notes-v1: list only verified commits and merged pull requests with source links; never infer features, tests or performance.';
// consolePrompt: the release.notes workflow's console prompt, used when the repository has no release-notes skill.
export async function inspect(github: GitHub, version: string, consolePrompt?: string | null) {
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
  // The new version must rank above the previous reachable tag in SemVer order (a prerelease ranks below its stable version).
  const suggested = previous ? nextVersions(previous.name) : [];
  const behind = previous !== null && validVersion(version) && compareVersions(version, previous.name) <= 0;
  const checks = [{ ok: !!(config && ci), message: config && ci ? '已接入发布用的 CI' : noCI },
    { ok: !!(workflow?.matched && workflowId), message: workflow?.matched && workflowId ? '版本标签可触发 Release 工作流' : noRelease, reason },
    { ok: !noChanges, message: noChanges ? '没有新变更，跳过本次发布；不会创建标签或 Release。' : previous ? '本次范围有新增提交' : '首次发布，从仓库历史起算' },
    !previous ? { ok: true, message: '还没有上一枚版本标签，不比较版本号' }
      : !validVersion(version) ? { ok: false, message: `版本号需要高于上一枚版本标签 ${previous.name}，例如 ${suggested.join(' 或 ')}` }
      : { ok: !behind, message: behind ? versionNotHigher(version, previous.name) : `版本 ${version} 高于上一枚版本标签 ${previous.name}` }];
  return { available: checks.every(c => c.ok) && validVersion(version) && (!existingTag || existingTag.commit === target),
    checks, version, version_valid: validVersion(version), version_pattern: versionPattern, prerelease: prerelease(version), target_sha: target,
    target_title: String(commit.commit?.message || '').split('\n')[0], target_url: commit.html_url, default_branch: github.defaultBranch,
    workflow_id: workflowId, workflow, files: { config: config?.sha, ci: ci?.sha, release: workflowFile?.sha },
    previous_tag: previous, no_changes: noChanges, version_behind: behind, suggested_versions: suggested, existing_tag: existingTag, existing_release: existingRelease ? { id: existingRelease.id, draft: existingRelease.draft, url: existingRelease.html_url } : null,
    skill: skill ? { source: 'repository', path: skillPath, sha: target, hash: sha(skill.content), version: null, content: skill.content }
      : consolePrompt ? { source: 'console', path: null, sha: target, hash: sha(consolePrompt), version: null, content: consolePrompt }
      : { source: 'builtin', path: null, sha: target, hash: sha(builtinRule), version: 'release-notes-v1', content: builtinRule } };
}
export const fingerprint = (preview: unknown) => digest(JSON.stringify(preview));
export const preflightToken = () => randomId();
