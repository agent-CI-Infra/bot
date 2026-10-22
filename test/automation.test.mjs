import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';
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
