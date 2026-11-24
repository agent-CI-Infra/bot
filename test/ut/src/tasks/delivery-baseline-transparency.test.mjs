import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { attachChild, childTaskContext } from '../../../../dist/tasks/children.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { boundedCandidate } from '../../../../dist/tasks/evidence.js';
import {
  buildDeliveryContext,
  buildDeliveryHandoff,
  checkWorkspaceHeadDrift,
  summarizeFileChanges,
} from '../../../../dist/tasks/delivery-context.js';
import { deterministicCandidateIssues, isTestFixturePath } from '../../../../dist/tasks/acceptance.js';
import { nominationSchema } from '../../../../dist/roles/catalog.js';
import { validateNominationResult } from '../../../../dist/roles/nomination.js';
import { runTeam } from '../../../../dist/roles/team.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { SubmissionError } from '../../../../dist/roles/submission-error.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { renderProgress, reportMilestone, startProgress } from '../../../../dist/review/progress.js';
import { applyDecision, recordEvent } from '../../../../dist/dispatch/store.js';
import { workspace as runnerWorkspace } from '../../../../runner/workspace.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

function makeStore(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 9));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','1','a')");
  store.run("INSERT INTO policies(repository_id,enabled,development_enabled,capability_ceiling) VALUES('101',1,1,'develop')");
  return store;
}

test('summarizeFileChanges reports added/modified/deleted with truncation and workflow flags', () => {
  const snapshot = [
    { path: 'src/keep.ts', sha: '1'.repeat(40), mode: '100644' },
    { path: 'src/edit.ts', sha: '2'.repeat(40), mode: '100644' },
    { path: 'src/gone.ts', sha: '3'.repeat(40), mode: '100644' },
    { path: 'scripts/run.sh', sha: '4'.repeat(40), mode: '100644' },
  ];
  const current = [
    { path: 'src/keep.ts', sha: '1'.repeat(40), mode: '100644' },
    { path: 'src/edit.ts', sha: '9'.repeat(40), mode: '100644' },
    { path: 'scripts/run.sh', sha: '4'.repeat(40), mode: '100755' },
    { path: '.github/workflows/ci.yml', sha: '5'.repeat(40), mode: '100644' },
    { path: 'src/new-a.ts', sha: '6'.repeat(40), mode: '100644' },
    { path: 'src/new-b.ts', sha: '7'.repeat(40), mode: '100644' },
  ];
  const full = summarizeFileChanges(current, snapshot, 100);
  assert.equal(full.total, 6);
  assert.equal(full.added_count, 3);
  assert.equal(full.modified_count, 2);
  assert.equal(full.deleted_count, 1);
  assert.deepEqual(full.added, ['.github/workflows/ci.yml', 'src/new-a.ts', 'src/new-b.ts']);
  assert.deepEqual(full.modified, ['scripts/run.sh', 'src/edit.ts']);
  assert.deepEqual(full.deleted, ['src/gone.ts']);
  assert.equal(full.truncated, false);
  assert.equal(full.touches_workflows, true);
  assert.deepEqual(full.workflow_files, ['.github/workflows/ci.yml']);

  const capped = summarizeFileChanges(current, snapshot, 1);
  assert.equal(capped.truncated, true);
  assert.equal(capped.added_count, 3);
  assert.equal(capped.added.length, 1);
  assert.equal(capped.total, 6);
});

test('buildDeliveryContext and buildDeliveryHandoff stay intact even when boundedCandidate folds huge file lists', t => {
  const store = makeStore(t);
  const baseSha = 'a'.repeat(40);
  const snapshotFiles = Array.from({ length: 400 }, (_, i) => ({
    path: `src/pkg/module-${String(i).padStart(4, '0')}.ts`,
    mode: '100644',
    sha: String(i).padStart(40, '1'),
  }));
  const currentFiles = [
    ...snapshotFiles.slice(1),
    { path: 'src/pkg/module-0001.ts', mode: '100644', sha: 'f'.repeat(40) },
    { path: '.github/workflows/release.yml', mode: '100644', sha: 'e'.repeat(40) },
  ].filter((f, idx, arr) => arr.findIndex(x => x.path === f.path) === idx || f.sha === 'f'.repeat(40))
    .reduce((acc, f) => {
      const i = acc.findIndex(x => x.path === f.path);
      if (i >= 0) acc[i] = f; else acc.push(f);
      return acc;
    }, []);

  const input = {
    generic: true,
    delivery: 'pull_request',
    target: { type: 'issue', number: 42, ref: 'release/v2' },
    target_meta: { type: 'issue', number: 42, title: 'Fix release branch', base_ref: 'release/v2', ref: 'release/v2', base_sha: baseSha },
    base_branch: 'release/v2',
    default_branch: 'main',
    snapshot_sha: baseSha,
    workspace_base_head_sha: baseSha,
    snapshot_files: snapshotFiles,
  };
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,head_sha,created_at,updated_at) VALUES('t-handoff','101','task.request','running','acceptance','Fix release branch',?,42,?,'2026-01-01','2026-01-01')",
    JSON.stringify(input),
    baseSha,
  );
  setGrant(store, { id: 't-handoff', repository_id: '101' }, ['pull_request'], 'user:op', null);
  const records = new TaskRecords(store);
  records.contract('t-handoff', { goal: 'Fix bug on release/v2', scope: ['src/pkg/module-0001.ts'], criteria: ['tests pass'], endpoint: 'reviewable_pull_request', completeness: 'explicit' });
  store.run(
    "INSERT INTO task_history(task_id,type,data,created_at) VALUES('t-handoff','delivery_nominated',?,'2026-01-01')",
    JSON.stringify({
      result_ref: 'task_history:7',
      is_child_task: false,
      delivery: 'pull_request',
      change_title: 'fix: release branch bug',
      summary: 'Fixed release/v2 module-0001 and updated workflow.',
      checks_note: 'Reviewed by independent reviewer',
      sources: [{ task_id: 't-handoff', ref: 'task_history:7' }],
    }),
  );

  const task = store.get("SELECT * FROM tasks WHERE id='t-handoff'");
  const ctx = buildDeliveryContext(store, task);
  assert.equal(ctx.base_branch, 'release/v2');
  assert.equal(ctx.base_sha, baseSha);
  assert.equal(ctx.intended_delivery, 'pull_request');
  assert.deepEqual(ctx.writes, ['pull_request']);
  assert.match(ctx.pr_base_semantics, /release\/v2/);
  assert.match(ctx.pr_base_semantics, /Do NOT run git checkout/);

  const candidate = {
    id: 'cand-1',
    revision: 1,
    created_at: '2026-01-01',
    claims: { summary: 'Fixed release/v2', change_title: 'fix: release branch bug' },
    evidence: [],
    artifacts: [
      {
        kind: 'code',
        reference: 'task:t-handoff:candidate',
        version: 'b'.repeat(40),
        content: {
          files: currentFiles,
          snapshot_files: snapshotFiles,
          base_branch: 'release/v2',
          base_sha: baseSha,
          expected_head_sha: baseSha,
          head_sha: baseSha,
          head_matches_baseline: true,
          change_title: 'fix: release branch bug',
          summary: 'Fixed release/v2 module-0001 and updated workflow.',
        },
      },
    ],
  };
  // Verify boundedCandidate folds the large files/snapshot_files arrays...
  const folded = boundedCandidate(candidate);
  assert.equal(folded.artifacts[0].content.files.omitted, true);
  assert.equal(folded.artifacts[0].content.snapshot_files.omitted, true);
  // ...while top-level delivery_handoff preserves complete baseline, changes, and nomination metadata!
  const handoff = buildDeliveryHandoff(store, task, candidate);
  assert.equal(handoff.goal, 'Fix bug on release/v2');
  assert.equal(handoff.intended_delivery, 'pull_request');
  assert.equal(handoff.actual_delivery, 'pull_request');
  assert.deepEqual(handoff.baseline, {
    base_branch: 'release/v2',
    base_sha: baseSha,
    workspace_head_sha: baseSha,
    head_matches_baseline: true,
  });
  assert.equal(handoff.changes.total, 3);
  assert.deepEqual(handoff.changes.added, ['.github/workflows/release.yml']);
  assert.deepEqual(handoff.changes.modified, ['src/pkg/module-0001.ts']);
  assert.deepEqual(handoff.changes.deleted, ['src/pkg/module-0000.ts']);
  assert.equal(handoff.changes.touches_workflows, true);
  assert.deepEqual(handoff.changes.workflow_files, ['.github/workflows/release.yml']);
  assert.equal(handoff.nomination.source_ref, 'task_history:7');
  assert.equal(handoff.nomination.is_child_task, false);
  assert.equal(handoff.nomination.change_title, 'fix: release branch bug');
  assert.equal(handoff.nomination.checks_note, 'Reviewed by independent reviewer');
});

test('read_child_tasks (childTaskContext) exposes target, base_branch, delivery, and pr_url', t => {
  const store = makeStore(t);
  const records = new TaskRecords(store);
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('parent','101','task.request','running','parent','{}')");
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,result) VALUES('child-pr','101','task.request','running','child pr',?,?)",
    JSON.stringify({ target: { type: 'issue', number: 12, ref: 'release/v2' }, base_branch: 'release/v2', delivery: 'pull_request' }),
    JSON.stringify({ summary: 'Opened PR', delivery: 'pull_request', pr_number: 88, pr_url: 'https://github.invalid/fixture/repo/pull/88' }),
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,result) VALUES('child-rep','101','task.request','running','child report',?,?)",
    JSON.stringify({ target: { type: 'branch', ref: 'dev' }, base_branch: 'dev', delivery: 'report' }),
    JSON.stringify({ summary: 'Diagnosis report', delivery: 'report' }),
  );
  for (const id of ['parent', 'child-pr', 'child-rep']) {
    records.contract(id, { goal: id, scope: [id], criteria: ['done'], endpoint: 'report' });
  }
  store.run("UPDATE tasks SET status='pr_opened' WHERE id='child-pr'");
  store.run("UPDATE tasks SET status='completed' WHERE id='child-rep'");
  attachChild(store, 'parent', 'child-pr');
  attachChild(store, 'parent', 'child-rep');

  const ctx = childTaskContext(store, 'parent');
  const prChild = ctx.children.find(c => c.id === 'child-pr');
  const repChild = ctx.children.find(c => c.id === 'child-rep');
  assert.deepEqual(prChild.target, { type: 'issue', number: 12, ref: 'release/v2' });
  assert.equal(prChild.base_branch, 'release/v2');
  assert.equal(prChild.delivery, 'pull_request');
  assert.equal(prChild.pr_url, 'https://github.invalid/fixture/repo/pull/88');
  assert.deepEqual(repChild.target, { type: 'branch', ref: 'dev' });
  assert.equal(repChild.base_branch, 'dev');
  assert.equal(repChild.delivery, 'report');
  assert.equal(repChild.pr_url, null);
});

test('dispatch store deduplication key includes target.ref for issue tasks', t => {
  const store = makeStore(t);
  recordEvent(store, {
    repositoryId: '101',
    key: 'evt:issue:42:ref-test',
    type: 'issue.comment',
    source: 'github',
    summary: 'Comment on #42',
    facts: { object: { title: 'Fix bug' } },
    object: { type: 'issue', number: 42 },
    options: [{ id: 'review', work: 'review.issue', title: 'Review', spec: { type: 'generic' } }],
  });
  const ev = store.get("SELECT * FROM dispatch_events WHERE event_key='evt:issue:42:ref-test'");
  const first = applyDecision(store, ev, {
    decision: 'create',
    option_ids: [],
    role: 'reviewer',
    writes: [],
    target: { type: 'issue', number: 42, ref: 'release/v1' },
    reason: 'Inspect on release/v1',
  }, null);
  assert.equal(first.created.length, 1);
  const firstKey = store.get('SELECT unique_key FROM tasks WHERE id=?', first.created[0]).unique_key;
  assert.match(firstKey, /issue:42@release\/v1$/);

  // Reset event to pending and dispatch same event with a DIFFERENT target.ref -> must not collide!
  store.run("UPDATE dispatch_events SET state='pending' WHERE id=?", ev.id);
  const second = applyDecision(store, ev, {
    decision: 'create',
    option_ids: [],
    role: 'reviewer',
    writes: [],
    target: { type: 'issue', number: 42, ref: 'release/v2' },
    reason: 'Inspect on release/v2',
  }, null);
  assert.equal(second.created.length, 1);
  const secondKey = store.get('SELECT unique_key FROM tasks WHERE id=?', second.created[0]).unique_key;
  assert.match(secondKey, /issue:42@release\/v2$/);
  assert.notEqual(firstKey, secondKey);
});

test('nominationSchema exposes delivery and validateNominationResult validates against target tool name', async () => {
  assert.deepEqual(nominationSchema.properties.delivery.enum, ['pull_request', 'review', 'report']);
  const seen = [];
  const spec = {
    finish: {
      name: 'submit_report',
      validate: (value, toolName) => {
        seen.push(toolName);
        if (toolName === 'open_pull_request' && !value.change_title) throw new Error('missing_change_title');
        return { ...value, delivery: toolName === 'open_pull_request' ? 'pull_request' : 'report' };
      },
    },
  };
  const prOut = await validateNominationResult(spec, { summary: 'ok', change_title: 'fix: x', artifacts: [] }, 'open_pull_request');
  assert.equal(prOut.delivery, 'pull_request');
  assert.deepEqual(seen, ['open_pull_request']);

  await assert.rejects(
    validateNominationResult(spec, { summary: 'ok', artifacts: [] }, 'open_pull_request'),
    e => e instanceof SubmissionError && e.clues.target_tool === 'open_pull_request',
  );
});

test('runTeam enforces nomination delivery semantics, child PR aggregation, and passes delivery_context/candidate_changes', async t => {
  const store = makeStore(t);
  let script = () => { throw new Error('unscripted'); };
  const bodies = [];
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const message = script(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }));
  store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'key' }, 'model:m'), 'now',
  );
  store.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");
  roleApi(store, { id: 'owner', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), {
    expected_revision: 0,
    enabled: true,
    roles: ['manager', 'dev', 'reviewer', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'native' } })),
  });

  const call = (name, args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c_' + randomBytes(4).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  const baseSha = 'a'.repeat(40);
  const snapshotFiles = [{ path: 'src/a.ts', mode: '100644', sha: '1'.repeat(40) }];
  const changedFiles = [
    { path: 'src/a.ts', mode: '100644', sha: '2'.repeat(40) },
    { path: 'src/b.ts', mode: '100644', sha: '3'.repeat(40) },
  ];

  const setupParent = (id, contractEndpoint = 'reviewable_pull_request', writes = ['pull_request']) => {
    store.run(
      "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,head_sha,attempt,created_at,updated_at) VALUES(?,'101','task.request','running','model','Parent task',?,?,1,'2026-01-01','2026-01-01')",
      id,
      JSON.stringify({ generic: true, target: { type: 'issue', number: 7, ref: 'release/v2' }, base_branch: 'release/v2', snapshot_sha: baseSha, snapshot_files: snapshotFiles }),
      baseSha,
    );
    setGrant(store, { id, repository_id: '101' }, writes, 'user:op', null);
    new TaskRecords(store).contract(id, { goal: 'Ship feature on release/v2', scope: ['src/'], criteria: ['pass'], endpoint: contractEndpoint, completeness: 'explicit' });
    return store.get('SELECT * FROM tasks WHERE id=?', id);
  };
  const addAcceptedChild = (parentId, childId, childResult) => {
    store.run(
      "INSERT INTO tasks(id,repository_id,kind,status,summary,input,result) VALUES(?,'101','task.request','running','child',?,?)",
      childId, JSON.stringify({ generic: true }), JSON.stringify(childResult),
    );
    const records = new TaskRecords(store);
    records.contract(childId, { goal: 'child goal', scope: ['src/'], criteria: ['pass'], endpoint: 'report' });
    const rev = records.get(childId).revision;
    store.run("UPDATE tasks SET status=? WHERE id=?", childResult.pr_url ? 'pr_opened' : 'completed', childId);
    store.run(
      "UPDATE task_records SET candidate=?,acceptance=? WHERE task_id=?",
      JSON.stringify({ id: 'c-' + childId, revision: rev, artifacts: [{ kind: 'report', reference: 'r', version: 'v' }] }),
      JSON.stringify({ outcome: 'pass', revision: rev, candidate_id: 'c-' + childId }),
      childId,
    );
    attachChild(store, parentId, childId);
  };

  const makeSpec = (task, finishedTools) => ({
    store,
    task,
    redactor: new Redactor(),
    guard: async () => {},
    system: 'Execute',
    prompt: JSON.stringify({ delivery_context: buildDeliveryContext(store, task) }),
    tools: [
      { type: 'function', function: { name: 'open_pull_request', description: 'open pr', parameters: { type: 'object', properties: { summary: { type: 'string' }, change_title: { type: 'string' }, artifacts: { type: 'array' } }, required: ['summary', 'change_title', 'artifacts'] } } },
      { type: 'function', function: { name: 'submit_report', description: 'report', parameters: { type: 'object', properties: { summary: { type: 'string' }, artifacts: { type: 'array' } }, required: ['summary', 'artifacts'] } } },
    ],
    finish: {
      name: 'submit_report',
      names: ['submit_report', 'open_pull_request', 'post_review'],
      validate: (value, toolName) => {
        finishedTools.push(toolName);
        if (toolName === 'open_pull_request' && !value.change_title) throw new Error('change_title_required');
        return { ...value, delivery: toolName === 'open_pull_request' ? 'pull_request' : toolName === 'post_review' ? 'review' : 'report' };
      },
    },
    finalizationTools: ['submit_report', 'open_pull_request'],
    validate: v => JSON.parse(v),
    execute: async () => ({ ok: true }),
  });

  // Scenario 1: Parent requires reviewable_pull_request; nominating a child WITHOUT pr_url and WITHOUT delivery is rejected,
  // then explicit delivery:'pull_request' validates through open_pull_request (not hardcoded submit_report!).
  const p1 = setupParent('p1', 'reviewable_pull_request', ['pull_request']);
  addAcceptedChild('p1', 'c1-nopr', { summary: 'Child analysis', change_title: 'fix: child change', artifacts: [], delivery: 'report' });
  const tools1 = [];
  let sawRejection1 = false;
  script = body => {
    const prompt = JSON.parse(body.messages[1].content);
    assert.equal(prompt.delivery_context.base_branch, 'release/v2');
    assert.equal(prompt.delivery_context.intended_delivery, 'pull_request');
    const toolMsgs = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (!toolMsgs.length) return call('nominate_delivery', { result_ref: 'task:c1-nopr' });
    sawRejection1 = toolMsgs.some(m => m.reason === 'child_nomination_requires_explicit_delivery');
    return call('nominate_delivery', { result_ref: 'task:c1-nopr', delivery: 'pull_request' });
  };
  const out1 = await runTeam(makeSpec(p1, tools1), { prepare: async () => undefined });
  assert.equal(sawRejection1, true, 'must reject silent downgrade of reviewable_pull_request parent when child has no pr_url');
  assert.deepEqual(tools1, ['open_pull_request']);
  assert.equal(out1.delivery, 'pull_request');

  // Scenario 2: Child ALREADY opened a PR (pr_url present); parent defaults to 'report' with child PR linkage, no duplicate PR!
  const p2 = setupParent('p2', 'reviewable_pull_request', ['pull_request']);
  addAcceptedChild('p2', 'c2-pr', {
    summary: 'Child PR delivered',
    change_title: 'feat: child',
    artifacts: [],
    delivery: 'pull_request',
    pr_number: 55,
    pr_url: 'https://github.invalid/fixture/repo/pull/55',
    branch: 'bot/task-c2-pr',
  });
  const tools2 = [];
  script = () => call('nominate_delivery', { result_ref: 'task:c2-pr' });
  const out2 = await runTeam(makeSpec(p2, tools2), { prepare: async () => undefined });
  assert.deepEqual(tools2, ['submit_report']);
  assert.equal(out2.delivery, 'report');
  assert.equal(out2.pr_url, 'https://github.invalid/fixture/repo/pull/55');
  assert.deepEqual(out2.child_pull_requests, [{ task_id: 'c2-pr', pr_number: 55, pr_url: 'https://github.invalid/fixture/repo/pull/55', branch: 'bot/task-c2-pr' }]);

  // Scenario 3: Dev + Reviewer delegation exposes delivery & changed_files_count to Manager and candidate_changes to Reviewer!
  const p3 = setupParent('p3', 'reviewable_pull_request', ['pull_request']);
  const tools3 = [];
  let delegateReturn = null;
  let reviewerPrompt = null;
  const fakeWorkspace = { artifact: async () => ({ tree_sha: 'b'.repeat(40), local_sha: 'c'.repeat(40), files: changedFiles }) };
  script = body => {
    const toolNames = (body.tools ?? []).map(x => x.function.name);
    if (toolNames.includes('nominate_delivery')) {
      const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      if (results.length === 0) return call('delegate_role', { role: 'dev', purpose: 'Implement change', refs: [] });
      if (results.length === 1) {
        delegateReturn = results[0];
        return call('delegate_role', { role: 'reviewer', purpose: 'Review change', refs: [results[0].result_ref] });
      }
      return call('nominate_delivery', { result_ref: results[0].result_ref });
    }
    if (toolNames.includes('submit_role_result')) {
      reviewerPrompt = JSON.parse(body.messages[1].content);
      return call('submit_role_result', { summary: 'Looks good', findings: [], inspected_scope: ['src/a.ts', 'src/b.ts'], unknowns: [] });
    }
    return call('open_pull_request', { summary: 'Implemented change', change_title: 'feat: change', artifacts: [] });
  };
  await runTeam(makeSpec(p3, tools3), { workspace: fakeWorkspace, prepare: async () => undefined });
  assert.equal(delegateReturn.delivery, 'pull_request');
  assert.equal(delegateReturn.changed_files_count, 2);
  assert.equal(reviewerPrompt.delivery_context.base_branch, 'release/v2');
  assert.equal(reviewerPrompt.candidate_changes.total, 2);
  assert.deepEqual(reviewerPrompt.candidate_changes.added, ['src/b.ts']);
  assert.deepEqual(reviewerPrompt.candidate_changes.modified, ['src/a.ts']);
});

test('isTestFixturePath and deterministicCandidateIssues relax privateKeyBlock only for test paths while keeping credentials, dirty paths, and HEAD drift strict', async t => {
  const store = makeStore(t);
  for (const p of [
    'test/crypto.mjs',
    'packages/core/tests/test_engine_redact.py',
    'apps/web/src/__tests__/auth.ts',
    'backend/spec/signer.rb',
    'backend/specs/signer.rb',
    'pkg/auth/signer_test.go',
    'pkg/auth/test_signer.py',
    'src/auth.test.ts',
    'src/auth.spec.mjs',
  ]) assert.equal(isTestFixturePath(p), true, `should recognize test path: ${p}`);
  for (const p of [
    'src/attestation/key.ts',
    'src/contest/pem.ts',
    'src/latest_data.ts',
    'src/testament.ts',
    'src/crypto.ts',
  ]) assert.equal(isTestFixturePath(p), false, `must not misclassify non-test path: ${p}`);

  const fakePem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEFAKEKEYDATA\n-----END RSA PRIVATE KEY-----\n';
  const realSecret = 'ghs_RealRegisteredSecretToken1234567890';
  const redactor = new Redactor();
  redactor.add(realSecret);
  const baseSha = 'a'.repeat(40);
  const driftedSha = 'd'.repeat(40);

  // 1. Nested test file with synthetic private key block passes preflight
  const cleanTestCandidate = {
    claims: {},
    artifacts: [{
      kind: 'code',
      content: {
        base_branch: 'main',
        base_sha: baseSha,
        expected_head_sha: baseSha,
        head_sha: baseSha,
        snapshot_files: [],
        files: [{ path: 'packages/core/tests/test_engine_redact.py', sha: '1'.repeat(40), base64: Buffer.from(fakePem).toString('base64') }],
      },
    }],
  };
  assert.deepEqual(await deterministicCandidateIssues(store, { id: 't1' }, {}, cleanTestCandidate, redactor), []);

  // 2. Non-test file with private key block, dirty .pem inside tests/, real secret inside tests/, and HEAD drift are all blocked!
  const badCandidate = {
    claims: {},
    artifacts: [{
      kind: 'code',
      content: {
        base_branch: 'main',
        base_sha: baseSha,
        expected_head_sha: baseSha,
        head_sha: driftedSha,
        snapshot_files: [],
        files: [
          { path: 'src/attestation/key.ts', sha: '1'.repeat(40), base64: Buffer.from(fakePem).toString('base64') },
          { path: 'packages/core/tests/fixture.pem', sha: '2'.repeat(40), base64: Buffer.from('not-even-a-key').toString('base64') },
          { path: 'packages/core/tests/test_leak.py', sha: '3'.repeat(40), base64: Buffer.from(`token = "${realSecret}"\n`).toString('base64') },
        ],
      },
    }],
  };
  const issues = await deterministicCandidateIssues(store, { id: 't1' }, {}, badCandidate, redactor);
  assert.ok(issues.some(i => i.includes('Workspace HEAD') && i.includes(driftedSha.slice(0, 12))), JSON.stringify(issues));
  assert.ok(issues.some(i => i.includes('Private key block found in src/attestation/key.ts')), JSON.stringify(issues));
  assert.ok(issues.some(i => i.includes('Forbidden or dirty file') && i.includes('packages/core/tests/fixture.pem')), JSON.stringify(issues));
  assert.ok(issues.some(i => i.includes('Registered secret/credential leaked in packages/core/tests/test_leak.py')), JSON.stringify(issues));

  // 3. Valid conflict rebase/merge exempts HEAD drift
  assert.equal(checkWorkspaceHeadDrift(baseSha, driftedSha).drifted, true);
  assert.equal(checkWorkspaceHeadDrift(baseSha, driftedSha, { conflictResolved: true }).drifted, false);
  assert.equal(checkWorkspaceHeadDrift(baseSha, driftedSha, { rebased: true }).drifted, false);
});

test('runner workspace_finalize reports actual head_sha and detects git checkout drift', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-head-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wsId = 'b'.repeat(48);
  const tasksRoot = join(dir, 'tasks');
  const repo = join(tasksRoot, wsId, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'bot@example.com']);
  git(['config', 'user.name', 'bot']);
  writeFileSync(join(repo, 'app.txt'), 'main-v1\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'main-v1']);
  const mainSha = git(['rev-parse', 'HEAD']);

  git(['checkout', '-q', '-b', 'other']);
  writeFileSync(join(repo, 'app.txt'), 'other-v1\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'other-v1']);
  const otherSha = git(['rev-parse', 'HEAD']);

  git(['checkout', '-q', '--detach', mainSha]);
  const onBase = await runnerWorkspace({ type: 'workspace_finalize', workspace_id: wsId, expected_head_sha: mainSha }, tasksRoot, join(dir, 'store'));
  assert.equal(onBase.head_sha, mainSha);
  assert.equal(onBase.head_matches_baseline, true);

  git(['checkout', '-q', 'other']);
  const drifted = await runnerWorkspace({ type: 'workspace_finalize', workspace_id: wsId, expected_head_sha: mainSha }, tasksRoot, join(dir, 'store'));
  assert.equal(drifted.head_sha, otherSha);
  assert.equal(drifted.head_matches_baseline, false);
});

test('issue progress renders completed/succeeded without PR as Ended (no pull request) and shows non-default base branch', t => {
  const store = makeStore(t);
  const now = new Date().toISOString();
  const makeTask = (id, status, input, result) => {
    store.run(
      "INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,'101','task.request',?,'dev',?,?,5,?,?)",
      id, status, JSON.stringify(input), result ? JSON.stringify(result) : null, now, now,
    );
    return store.get('SELECT * FROM tasks WHERE id=?', id);
  };

  // Chinese Issue with non-default base branch & completed report (no PR)
  const zhTask = makeTask(
    'prog-zh',
    'completed',
    { base_branch: 'release/v2', default_branch: 'main', manager: { brief: { goal: '修复发布分支问题' } } },
    { delivery: 'report', summary: '仅需更新配置，无需改动代码（含 secret-token-xyz）。' },
  );
  startProgress(store, zhTask, { number: 5, title: '发布分支异常', body: '请排查。' }, { baseBranch: 'release/v2', defaultBranch: 'main' });
  const zhRow = store.get("SELECT * FROM issue_development_progress WHERE task_id='prog-zh'");
  const zhRedactor = new Redactor();
  zhRedactor.add('secret-token-xyz');
  const zhBody = renderProgress(zhRow, zhTask, zhRedactor);
  assert.match(zhBody, /\*\*状态\*\*：已结束（未开出 PR）/);
  assert.match(zhBody, /\*\*基线分支\*\*：`release\/v2`/);
  assert.match(zhBody, /仅需更新配置，无需改动代码（含 \[REDACTED\]）。/);
  assert.doesNotMatch(zhBody, /开发失败/);
  assert.doesNotMatch(zhBody, /点「重试」/);

  // m.stopped.reason takes priority over result.summary
  reportMilestone(store, 'prog-zh', { milestone: 'stopped', reason: '需要维护者确认是否合入主干。', human_action: '请确认目标分支。' });
  const zhWithStopped = renderProgress(store.get("SELECT * FROM issue_development_progress WHERE task_id='prog-zh'"), zhTask);
  assert.match(zhWithStopped, /\*\*原因\*\*：需要维护者确认是否合入主干。/);
  assert.match(zhWithStopped, /\*\*需要人做的\*\*：请确认目标分支。/);

  // English Issue on default branch ('main') with succeeded & no summary
  const enTask = makeTask(
    'prog-en',
    'succeeded',
    { base_branch: 'main', default_branch: 'main', manager: { brief: { goal: 'Investigate build issue' } } },
    {},
  );
  startProgress(store, enTask, { number: 5, title: 'Build issue', body: 'Please investigate.' }, { baseBranch: 'main', defaultBranch: 'main' });
  const enRow = store.get("SELECT * FROM issue_development_progress WHERE task_id='prog-en'");
  const enBody = renderProgress(enRow, enTask);
  assert.match(enBody, /\*\*Status\*\*: Ended \(no pull request\)/);
  assert.doesNotMatch(enBody, /\*\*Base branch\*\*/);
  assert.match(enBody, /ended normally without opening a pull request/);
  assert.doesNotMatch(enBody, /development failed/i);
  assert.doesNotMatch(enBody, /press Retry/i);
});
