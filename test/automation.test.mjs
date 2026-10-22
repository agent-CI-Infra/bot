import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository } from './helpers.mjs';
import { loadRepositoryConfigs, parseRepositoryConfig, repositoryConfigMap } from '../dist/automation/repository-config.js';
import { DispatchWorker, matchesDispatch } from '../dist/automation/dispatch.js';
import { DEFAULT_AUTOMATION, AutomationConfigError, loadAutomationConfig, parseAutomationConfig } from '../dist/automation/config.js';
import { planAutomation } from '../dist/automation/engine.js';
import { labelLint, prStatus } from '../dist/automation/modules/labels.js';
import { gate } from '../dist/automation/modules/gate.js';
import { eligible, mergeQueue, order } from '../dist/automation/modules/merge-queue.js';

const context = (event, action, payload, { facts = {}, config = DEFAULT_AUTOMATION } = {}) => ({
  event: { repositoryId: '101', event, action, payload, deliveryId: 'delivery' },
  config,
  facts,
});

const issuePayload = labels => ({ action: 'opened', issue: { number: 5, labels: labels.map(name => ({ name })) } });
const prPayload = (labels, extra = {}) => ({
  action: 'synchronize',
  pull_request: { number: 9, draft: false, labels: labels.map(name => ({ name })), head: { sha: 'a'.repeat(40) } },
  ...extra,
});

test('config defaults to dry-run and a disabled merge queue', () => {
  assert.deepEqual(parseAutomationConfig({}), DEFAULT_AUTOMATION);
  assert.equal(DEFAULT_AUTOMATION.dryRun, true);
  assert.equal(DEFAULT_AUTOMATION.merge.enabled, false);
  assert.equal(parseAutomationConfig({ merge: { enabled: true } }).merge.enabled, true);
  assert.deepEqual(loadAutomationConfig('not json').problem, 'automation_config_invalid');
});

test('config rejects unknown keys and bad values instead of ignoring them', () => {
  assert.throws(() => parseAutomationConfig({ dry_run: true }), AutomationConfigError);
  assert.throws(() => parseAutomationConfig({ gate: { ready_label: 'ready' } }), AutomationConfigError);
  assert.throws(() => parseAutomationConfig({ gate: { requiredChecks: [] } }), AutomationConfigError);
  assert.throws(() => parseAutomationConfig({ labels: { lint: { triageLabel: 'Bad Label' } } }), AutomationConfigError);
});

test('config derives the label manifest from axes and rejects bad axis names', () => {
  const config = parseAutomationConfig({ labels: { axes: { type: ['bug', 'docs'], priority: ['high'] } } });
  assert.deepEqual(config.labels.manifest, ['type/bug', 'type/docs', 'priority/high']);
  assert.throws(() => parseAutomationConfig({ labels: { axes: { Type: ['bug'] } } }), AutomationConfigError);
  assert.throws(() => parseAutomationConfig({ labels: { axes: { type: ['Bug Label'] } } }), AutomationConfigError);
});

test('the CI stage catalog must cover every required check', () => {
  const stage = (id, required) => ({ id, workflow: `${id}.yml`, runnerLabels: ['self-hosted'], required });
  const config = parseAutomationConfig({
    gate: { requiredChecks: ['check'] },
    ci: { stages: [stage('check', true), stage('review', false)] },
  });
  assert.deepEqual(config.ci.stages.map(item => item.id), ['check', 'review']);
  assert.throws(() => parseAutomationConfig({
    gate: { requiredChecks: ['check'] }, ci: { stages: [stage('check', false)] },
  }), AutomationConfigError);
});

test('a repository YAML declares its own labels, gate and CI stages', () => {
  const config = parseRepositoryConfig(`
labels:
  axes:
    type: [bug, docs]
    source: [user]
    priority: [high, low]
  manifest: [blocker]
  lint:
    require: [type, source]
    exactly_one: [priority]
    triage: status/triage
  pr_status:
    ready: pr/ready
    no_issue: pr/no-issue
gate:
  ready_label: ready
  required_checks: [check]
  maintainer_roles: [admin]
ci:
  stages:
    - id: check
      workflow: ci.yml
      runner_labels: [self-hosted, cn-check]
      required: true
`, 'owner/repo');
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.labels.manifest, ['type/bug', 'type/docs', 'source/user', 'priority/high', 'priority/low', 'blocker']);
  assert.deepEqual(config.ci.stages, [{ id: 'check', workflow: 'ci.yml', runnerLabels: ['self-hosted', 'cn-check'], required: true }]);
  assert.throws(() => parseRepositoryConfig('labelz: {}', 'owner/repo'), AutomationConfigError);
  assert.throws(() => parseRepositoryConfig('labels:\n  lint:\n    triage_label: status/triage\n', 'owner/repo'), AutomationConfigError);
});

test('repository files map by owner__repo and reject duplicate or malformed names', t => {
  const directory = mkdtempSync(join(tmpdir(), 'repository-configs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'Acme__Widget.yml'), 'labels:\n  axes:\n    type: [bug]\n');
  writeFileSync(join(directory, 'Acme__Gadget.yaml'), 'dry_run: false\n');
  writeFileSync(join(directory, 'notes.txt'), 'ignored');
  const entries = loadRepositoryConfigs(directory);
  assert.deepEqual(entries.map(entry => entry.fullName), ['Acme/Gadget', 'Acme/Widget']);
  assert.ok(repositoryConfigMap(entries).has('acme/widget'));
  assert.equal(loadRepositoryConfigs(join(directory, 'missing')).length, 0);
  writeFileSync(join(directory, 'Acme__Widget.yaml'), 'labels: {}\n');
  assert.throws(() => loadRepositoryConfigs(directory), AutomationConfigError);
  rmSync(join(directory, 'Acme__Widget.yaml'));
  writeFileSync(join(directory, 'not-a-repo.yml'), 'labels: {}\n');
  assert.throws(() => loadRepositoryConfigs(directory), AutomationConfigError);
});

test('a repository YAML config drives the plan when policy automation is unset', async t => {
  const config = parseRepositoryConfig('labels:\n  lint:\n    require: [type, source, priority]\n', 'fixture/project-202');
  const h = await harness(t, undefined, { repositoryConfigs: repositoryConfigMap([{ fullName: 'fixture/project-202', path: 'memory', config }]) });
  const { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '202');
  const sent = await h.hook(a.path, a.secret, 'delivery-yaml-config', {
    repository: { id: 202 }, action: 'opened', issue: { number: 7, labels: [{ name: 'type/bug' }] },
  });
  assert.equal(sent.status, 200);
  const run = h.store.get('SELECT * FROM automation_runs');
  assert.match(run.actions, /status\/triage/);
});

test('dispatch matches event routes and optional labels', () => {
  assert.equal(matchesDispatch({ target: 'laptop', events: ['pull_request.*'], labels: [] }, 'pull_request', 'opened', []), true);
  assert.equal(matchesDispatch({ target: 'laptop', events: ['pull_request.*'], labels: ['ready'] }, 'pull_request', 'opened', ['ready']), true);
  assert.equal(matchesDispatch({ target: 'laptop', events: ['pull_request.*'], labels: ['ready'] }, 'pull_request', 'opened', []), false);
  assert.equal(matchesDispatch({ target: 'laptop', events: ['issues'], labels: [] }, 'issues', 'opened', []), true);
  assert.equal(matchesDispatch({ target: 'laptop', events: ['pull_request.synchronize'], labels: [] }, 'pull_request', 'opened', []), false);
});

test('a matching event is queued, signed and delivered to its target', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  const created = await admin('/api/dispatch-targets', 'POST', {
    name: 'maintainer laptop', url: 'https://laptop.example/hooks/review', webhook_secret: 's'.repeat(32),
  });
  assert.equal(created.status, 201);
  await repository(admin, a.id, '203');
  const patched = await admin('/api/repositories/203/policy', 'PATCH', {
    automation: { dispatch: [{ target: created.value.target.id, events: ['pull_request.*'], labels: [] }] },
  });
  assert.equal(patched.status, 200);
  const sent = await h.hook(a.path, a.secret, 'delivery-dispatch', {
    repository: { id: 203 }, action: 'opened', pull_request: { number: 11, labels: [] },
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(sent.status, 200);
  assert.equal(h.store.all('SELECT * FROM dispatch_deliveries').length, 1);
  let request;
  const worker = new DispatchWorker(h.store, async value => { request = value; return { status: 204 }; }, 60_000);
  assert.equal(await worker.tick(), 1);
  assert.equal(h.store.get('SELECT state FROM dispatch_deliveries').state, 'delivered');
  assert.equal(request.headers['X-Bot-Event'], 'pull_request.opened');
  assert.equal(request.headers['X-Bot-Signature-256'], `sha256=${createHmac('sha256', 's'.repeat(32)).update(request.body).digest('hex')}`);
  assert.equal(JSON.parse(request.body).payload.pull_request.number, 11);
});

test('a delegated token publishes a review as the bot exactly once', async t => {
  const calls = [];
  const h = await harness(t, undefined, {
    publishReview: async (...args) => { calls.push(args); return { id: '42', url: 'https://github.com/fixture/project-204/pull/9#pullrequestreview-42' }; },
  });
  const { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '204');
  const issued = await admin('/api/repositories/204/agent-tokens', 'POST', { subject: 'maintainer laptop', scopes: ['review:submit'] });
  assert.equal(issued.status, 201);
  assert.match(issued.value.token, /^botagent_[a-f0-9]{48}$/);
  const submit = async (token, body) => {
    const response = await fetch(h.admin + '/api/agent/reviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const payload = { pull_number: 9, head_sha: 'a'.repeat(40), body: 'Reviewed; one finding.' };
  const first = await submit(issued.value.token, payload);
  assert.equal(first.status, 201);
  assert.equal(first.value.state, 'sent');
  const again = await submit(issued.value.token, payload);
  assert.equal(again.value.duplicate, true);
  assert.equal(calls.length, 1);
  const invalid = await submit(`botagent_${'0'.repeat(48)}`, payload);
  assert.equal(invalid.status, 401);
  const revokedToken = await admin(`/api/agent-tokens/${issued.value.id}`, 'DELETE', {});
  assert.equal(revokedToken.status, 200);
  const revoked = await submit(issued.value.token, payload);
  assert.equal(revoked.status, 401);
});

test('label bootstrap derives areas and becomes the repository config', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '205');
  const generated = await admin('/api/repositories/205/labels/bootstrap', 'POST', { areas: ['src/api', 'src/runtime', 'src/api'], apply: true });
  assert.equal(generated.status, 201);
  assert.equal(generated.value.source, 'generated');
  assert.equal(generated.value.applied, true);
  assert.deepEqual(generated.value.config.labels.axes.area, ['src-api', 'src-runtime']);
  assert.match(generated.value.yaml, /area:/);
  assert.match(generated.value.labeling, /area\/src-api/);
  const policy = await admin('/api/repositories/205');
  assert.deepEqual(JSON.parse(policy.value.policy.automation).labels.axes.area, ['src-api', 'src-runtime']);
  const second = await admin('/api/repositories/205/labels/bootstrap', 'POST', {});
  assert.equal(second.value.source, 'repository');
  assert.equal(second.value.applied, false);
});

test('label-lint marks an issue that misses an axis and clears it when complete', () => {
  const missing = labelLint.plan(context('issues', 'opened', issuePayload(['type/bug'])));
  assert.deepEqual(missing.actions.map(action => action.type), ['label.add', 'comment.upsert']);
  assert.equal(missing.actions[0].label, 'status/triage');
  const complete = labelLint.plan(context('issues', 'edited', issuePayload(['type/bug', 'source/user', 'priority/high', 'status/triage'])));
  assert.deepEqual(complete.actions, [{ type: 'label.remove', label: 'status/triage' }]);
});

test('pr-status adds pr/ready on ready and removes it on draft', () => {
  const ready = prStatus.plan(context('pull_request', 'ready_for_review', { pull_request: { number: 9, labels: [] } }));
  assert.deepEqual(ready.actions, [{ type: 'label.add', label: 'pr/ready' }]);
  const draft = prStatus.plan(context('pull_request', 'converted_to_draft', prPayload(['pr/ready'])));
  assert.deepEqual(draft.actions, [{ type: 'label.remove', label: 'pr/ready' }]);
});

test('gate fails closed when facts are missing', () => {
  const plan = gate.plan(context('pull_request_target', 'labeled', { label: { name: 'ready' }, pull_request: { number: 9, labels: [] } }));
  assert.deepEqual(plan.actions.map(action => action.type), ['status.post']);
  assert.equal(plan.actions[0].state, 'pending');
});

test('gate refuses ready from a non-maintainer and accepts a verified head', () => {
  const refused = gate.plan(context('pull_request_target', 'labeled', { label: { name: 'ready' }, pull_request: { number: 9, labels: [] } }, {
    facts: { gate: { maintainer: false, conflict: false, headChecksPassed: true, reviewAnswered: true } },
  }));
  assert.deepEqual(refused.actions.map(action => action.type), ['label.remove', 'comment.upsert']);
  const accepted = gate.plan(context('pull_request_target', 'labeled', { label: { name: 'ready' }, pull_request: { number: 9, labels: [] } }, {
    facts: { gate: { maintainer: true, conflict: false, headChecksPassed: true, reviewAnswered: true } },
  }));
  assert.deepEqual(accepted.actions.map(action => action.type), ['status.post']);
});

test('gate drops ready when the head moves', () => {
  const plan = gate.plan(context('pull_request_target', 'synchronize', prPayload(['ready'])));
  assert.deepEqual(plan.actions.map(action => action.type), ['label.remove', 'comment.upsert', 'status.post']);
});

test('merge queue is oldest first and skips drafts, conflicts and holds', () => {
  const candidates = [
    { number: 3, createdAt: '2026-01-03', draft: false, conflict: false, labels: [], gate: 'success' },
    { number: 1, createdAt: '2026-01-01', draft: false, conflict: false, labels: [], gate: 'success' },
    { number: 2, createdAt: '2026-01-02', draft: true, conflict: false, labels: [], gate: 'success' },
    { number: 4, createdAt: '2026-01-04', draft: false, conflict: true, labels: [], gate: 'success' },
    { number: 5, createdAt: '2026-01-05', draft: false, conflict: false, labels: ['pr/hold'], gate: 'success' },
    { number: 6, createdAt: '2026-01-06', draft: false, conflict: false, labels: [], gate: 'pending' },
  ];
  assert.equal(eligible(candidates[2], ['pr/hold']), false);
  assert.deepEqual(order(candidates, true).map(candidate => candidate.number), [1, 2, 3, 4, 5, 6]);
  const enabled = { ...DEFAULT_AUTOMATION, merge: { ...DEFAULT_AUTOMATION.merge, enabled: true } };
  const plan = mergeQueue.plan({ event: {}, config: enabled, facts: { mergeQueue: candidates } });
  assert.deepEqual(plan.actions, [{ type: 'merge', number: 1, method: 'merge' }, { type: 'merge', number: 3, method: 'merge' }]);
});

test('engine deduplicates actions and survives a failing module', () => {
  const duplicate = { id: 'duplicate', plan: () => ({ actions: [{ type: 'label.add', label: 'status/triage' }], notes: [] }) };
  const broken = { id: 'broken', plan: () => { throw new Error('boom'); } };
  const outcome = planAutomation(context('issues', 'opened', issuePayload([])), [duplicate, duplicate, broken]);
  assert.deepEqual(outcome.actions, [{ type: 'label.add', label: 'status/triage' }]);
  assert.ok(outcome.notes.some(note => note.startsWith('broken: failed')));
});

test('ingestion records a dry-run plan without changing the delivery outcome', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const patched = await admin('/api/repositories/101/policy', 'PATCH', { automation: { dryRun: true } });
  assert.equal(patched.status, 200);
  const sent = await h.hook(a.path, a.secret, 'delivery-automation', {
    repository: { id: 101 }, action: 'opened', issue: { number: 5, labels: [{ name: 'type/bug' }] },
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.value.ok, true);
  const runs = h.store.all('SELECT * FROM automation_runs');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].dry_run, 1);
  assert.match(runs[0].actions, /status\/triage/);
  const listed = await admin('/api/automation');
  assert.equal(listed.status, 200);
  assert.equal(listed.value.runs.length, 1);
});

test('policy rejects an unknown automation field', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const rejected = await admin('/api/repositories/101/policy', 'PATCH', { automation: { dryNow: true } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.value.error, 'invalid_automation_config');
  const enabled = await admin('/api/repositories/101/policy', 'PATCH', { automation: { merge: { enabled: true } } });
  assert.equal(enabled.status, 200);
  assert.equal(JSON.parse(enabled.value.policy.automation).merge.enabled, true);
});
