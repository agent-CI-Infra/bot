import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../../../../dist/storage/database.js';
import { systemInstructions, rolePrompts } from '../../../../dist/roles/pool.js';
import { githubWriteTool, grantedGithubWriteTool, scopedGithubWriteTool, githubWriteInstructions } from '../../../../dist/github/write.js';
import { pushBotBranchTool } from '../../../../dist/github/git-push.js';

const issueDevPrompt = readFileSync(new URL('../../../../docs/prompts/issue-development.md', import.meta.url), 'utf8');
const managerDispatchPrompt = readFileSync(new URL('../../../../docs/prompts/manager-dispatch.md', import.meta.url), 'utf8');
const managementAgentSrc = readFileSync(new URL('../../../../src/management/agent.ts', import.meta.url), 'utf8');
const serviceSessionSrc = readFileSync(new URL('../../../../src/channels/service-session.ts', import.meta.url), 'utf8');

test('universal bot-owned Issue/PR body maintenance rule is present across all agent prompts and github_write descriptions', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  for (const [label, content] of [
    ['pool.systemInstructions', systemInstructions],
    ['pool.dev', rolePrompts.dev],
    ['pool.manager', rolePrompts.manager],
    ['docs/prompts/issue-development.md', issueDevPrompt],
    ['docs/prompts/manager-dispatch.md', managerDispatchPrompt],
    ['githubWriteTool', githubWriteTool.function.description],
    ['grantedGithubWriteTool', grantedGithubWriteTool.function.description],
    ['scopedGithubWriteTool', scopedGithubWriteTool.function.description],
    ['githubWriteInstructions', githubWriteInstructions('require_request')],
    ['src/management/agent.ts', managementAgentSrc],
    ['src/channels/service-session.ts', serviceSessionSrc],
  ]) {
    const normalized = flat(content);
    assert.match(normalized, /latest complete state/i, `${label}: must require keeping bot-owned PR/Issue body updated to latest complete state`);
  }
});

test('media hosting flexibility and unpushed local SHA rules are explicitly documented in runtime prompts and tool schemas', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  for (const [label, content] of [
    ['pool.systemInstructions', systemInstructions],
    ['pool.dev', rolePrompts.dev],
    ['docs/prompts/issue-development.md', issueDevPrompt],
    ['githubWriteTool', githubWriteTool.function.description],
  ]) {
    const normalized = flat(content);
    assert.match(normalized, /platform-hosted media/i, `${label}: must state default platform-hosted media`);
    assert.match(normalized, /maintainer(?:'s explicit request| explicitly (?:requests|asks))/i, `${label}: must allow following maintainer explicit media location request`);
    assert.match(normalized, /unpushed local commit SHAs|unpushed local SHAs/i, `${label}: must forbid citing unpushed local commit SHAs`);
  }
  assert.match(flat(pushBotBranchTool.function.description), /unpushed local commit SHAs/i);
  assert.match(flat(pushBotBranchTool.function.description), /confirmed `remote_sha`/i);
  assert.match(flat(managementAgentSrc), /default to platform-hosted media/i);
  assert.match(flat(serviceSessionSrc), /default, attach screenshots or recordings.*platform-hosted media/i);
});

test('issue-development prompt respects onboarding size and content invariants', () => {
  assert.ok(Buffer.byteLength(issueDevPrompt, 'utf8') <= 16384, 'issue-development.md must stay <= 16384 bytes');
  assert.doesNotMatch(issueDevPrompt, /modify the working tree/i);
  assert.doesNotMatch(issueDevPrompt, /PPMA|ScienceDiscovery|agent-CI-Infra/);
});

test('human-first duplicate PR convergence and Event Dispatch Manager task tools are reflected in prompts', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  const prReviewPrompt = readFileSync(new URL('../../../../docs/prompts/pr-review.md', import.meta.url), 'utf8');
  for (const [label, content] of [
    ['docs/prompts/manager-dispatch.md', managerDispatchPrompt],
    ['pool.manager', rolePrompts.manager],
  ]) {
    const normalized = flat(content);
    assert.match(normalized, /issue\.linked_pull_request/, `${label}: must document issue.linked_pull_request handling`);
    assert.match(normalized, /manage_task/, `${label}: must document Event Dispatch Manager manage_task tool`);
    assert.match(normalized, /PATCH \/pulls\/<bot_pr>/, `${label}: must instruct closing duplicate bot PR once verified no net-new changes remain`);
  }
  for (const [label, content] of [
    ['docs/prompts/pr-review.md', prReviewPrompt],
    ['pool.reviewer', rolePrompts.reviewer],
  ]) {
    const normalized = flat(content);
    assert.match(normalized, /repository_active_work/, `${label}: must document repository_active_work awareness`);
    assert.match(normalized, /overlapping_work/, `${label}: must document post_review.overlapping_work handoff`);
  }
});
