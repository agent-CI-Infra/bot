// Built-in prompts and tool schemas require structured decision context (background, candidate options with a
// recommendation, and pros/cons when multiple viable paths exist; direct action without invented alternatives for
// single-path blockers) whenever the bot asks humans for input or a decision (#1306).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { resolveRole } from '../../../../dist/roles/definition.js';
import { systemInstructions, rolePrompts } from '../../../../dist/roles/pool.js';
import { workspaceProfile } from '../../../../dist/agent/profiles.js';
import { tools } from '../../../../dist/agent/model.js';
import { postReviewTool } from '../../../../dist/tasks/github-write.js';
import { milestoneTool } from '../../../../dist/review/progress.js';

const readPrompt = name => readFileSync(new URL(`../../../../docs/prompts/${name}`, import.meta.url), 'utf8');
const readDist = rel => readFileSync(new URL(`../../../../dist/${rel}`, import.meta.url), 'utf8');

// Require all four decision elements (background, options, recommendation, pros and cons) within the same paragraph/block
// so unrelated words elsewhere in a file cannot satisfy the check.
const structuredDecisionClause = /background.{0,280}options?.{0,180}recommend(?:ed|ation)?.{0,180}pros and cons/i;
const singlePathDistinction = /single-path|without inventing alternatives|omit alternatives|omit for single-path/i;

function assertDecisionClause(text, label) {
  const blocks = text.split(/\n\s*\n/).map(block => block.replace(/\s+/g, ' '));
  assert.ok(blocks.some(block => structuredDecisionClause.test(block)), `${label}: must require background, candidate options with a recommendation, and pros/cons in the same paragraph`);
}

test('docs/prompts files with human decision points require background, recommended options, and pros/cons within size budgets', () => {
  const files = [
    'issue-review.md',
    'pr-review.md',
    'issue-development.md',
    'manager-dispatch.md',
    'manager-flows.md',
    'onboarding.md',
    'actions-failures.md',
    'release-observe.md',
  ];
  for (const file of files) {
    const text = readPrompt(file);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 16384, `${file} must stay within the 16 KiB rule budget`);
    assertDecisionClause(text, `docs/prompts/${file}`);
  }
  // issue-development.md is injected into the workspace development agent, which offers create_pull_request (not submit_report).
  assert.doesNotMatch(readPrompt('issue-development.md'), /\bsubmit_report\b/, 'issue-development.md must not instruct calling submit_report');
  // Blocker-capable prompts distinguish multi-option choices from single-path blockers.
  for (const file of ['issue-review.md', 'pr-review.md', 'issue-development.md', 'manager-dispatch.md', 'actions-failures.md', 'release-observe.md']) {
    assert.match(readPrompt(file).replace(/\s+/g, ' '), singlePathDistinction, `docs/prompts/${file} must avoid forcing invented options on single-path blockers`);
  }
  // late-schedules intentionally recommends a single two-part plan rather than alternatives.
  assert.match(readPrompt('late-schedules.md').replace(/\s+/g, ' '), /Recommend one plan with two parts that go together, not alternatives/);
});

test('resolved project roles, workspace profiles, and delivery tool schemas enforce structured human-decision guidance', t => {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','fixture/r','o','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','http://127.0.0.1:9/v1','fixture',?,'now')", store.secrets.seal({ value: 'fixture-key' }, 'model:m'));
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,review_enabled) VALUES('r','m',1,1,1)");

  assertDecisionClause(systemInstructions, 'roles/pool.ts systemInstructions');
  assert.match(systemInstructions, singlePathDistinction, 'systemInstructions must distinguish single-path blockers');
  for (const roleId of ['manager', 'dev', 'reviewer', 'test', 'ux', 'qa']) {
    const resolved = resolveRole(store, 'r', roleId, 'task.request', { persist: false });
    assertDecisionClause(resolved.system, `resolveRole(${roleId}).system`);
  }
  // Role templates stay cohesive without duplicating the full shared systemInstructions clause.
  assert.match(rolePrompts.manager, /needs_help.*pros\/cons/i);
  assert.match(rolePrompts.reviewer, /requires_human_decision.*human_action/i);
  assert.match(rolePrompts.dev, /stopped.*options/i);

  for (const kind of ['review.issue', 'review.pr', 'development.issue']) {
    const profile = workspaceProfile(kind, {});
    assertDecisionClause(profile.system, `workspaceProfile(${kind})`);
    assert.match(profile.system, singlePathDistinction, `workspaceProfile(${kind}) must distinguish single-path blockers`);
  }

  const finishReview = tools({ workspaceWrite: false, completion: 'review' }).find(tool => tool.function.name === 'finish_review');
  assert.ok(finishReview, 'finish_review tool must be offered in review mode');
  const finishFindingProps = finishReview.function.parameters.properties.findings.items.properties;
  assertDecisionClause(finishFindingProps.requires_human_decision.description, 'finish_review.findings.requires_human_decision');
  assert.match(finishFindingProps.requires_human_decision.description, singlePathDistinction);
  assert.match(finishFindingProps.human_action.description, /recommended option/i);

  const postFindingProps = postReviewTool.function.parameters.properties.findings.items.properties;
  assertDecisionClause(postFindingProps.requires_human_decision.description, 'post_review.findings.requires_human_decision');
  assert.match(postFindingProps.requires_human_decision.description, singlePathDistinction);
  assert.match(postFindingProps.human_action.description, /recommended option/i);

  const milestoneProps = milestoneTool.function.parameters.properties;
  assert.match(milestoneProps.reason.description, /background/i);
  assert.ok(milestoneProps.options, 'report_development_milestone must expose optional structured options for stopped milestones');
  assertDecisionClause(`${milestoneProps.reason.description}, ${milestoneProps.options.description}`, 'report_development_milestone stopped');
  assert.match(milestoneProps.options.description, singlePathDistinction);
});

test('compiled runtime modules for dispatch, team coordination, recovery, request reports, management assistant, and group assistant include structured human-decision clauses', () => {
  for (const rel of [
    'dispatch/manager.js',
    'roles/team.js',
    'roles/manager-recovery.js',
    'tasks/request.js',
    'management/agent.js',
    'channels/service-session.js',
  ]) {
    const content = readDist(rel);
    assertDecisionClause(content, `dist/${rel}`);
    assert.match(content, singlePathDistinction, `dist/${rel} must distinguish single-path blockers`);
  }
  assert.match(readDist('tasks/request.js'), /post_review.*requires_human_decision:\s*true/i, 'submit_report must defer formal reviews to post_review');
});
