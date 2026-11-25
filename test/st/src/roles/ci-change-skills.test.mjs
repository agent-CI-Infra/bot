import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { runRole } from '../../../../dist/roles/run.js';
import { roleConfiguration, saveConfiguration } from '../../../../dist/roles/definition.js';
import { pullRequestPermissions, workflowChanges } from '../../../../dist/tasks/pull-request.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { scriptedHarness } from '../../../fixtures/scripted-driver.mjs';
import { rolePool } from '../../../../dist/roles/pool.js';

// #1359: layered-ci-gates is now explicitly bound via the built-in `ci-gates` bundle (Manager, Dev, Reviewer) instead of
// hidden dynamic injection, while `workflowChanges()` / `pullRequestPermissions()` continue to guard `workflows: write`
// token issuance deterministically from task contract, PR diff files, or parent development candidates (#1269).
const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const call = (name, args, id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function fixture(t, input, summary = 'implement feature') {
  const s = new Store(':memory:', randomBytes(32)), requests = [];
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/ci','o','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running',?,?)", summary, JSON.stringify(input));
  new TaskRecords(s).contract('t', { goal: 'Update code', scope: ['src/'], criteria: ['Tests pass'], endpoint: 'artifact' });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    const names = body.tools.map(t => t.function.name), seen = body.messages.filter(m => m.role === 'tool');
    const message = names.includes('read_skill') && !seen.length
      ? call('read_skill', { path: 'defaults/layered-ci-gates/SKILL.md' }, 'read')
      : call('finish', { summary: 'done' }, 'finish');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', 'r', 'http://127.0.0.1:' + server.address().port + '/v1', 'fixture', s.secrets.seal({ value: 'fixture-key' }, 'model:m'), 'now');
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
  // Switch built-in V2 roles onto the in-process scripted harness while keeping default built-in skill bundles intact.
  saveConfiguration(s, 'r', {
    expected_revision: 0,
    roles: rolePool.map(r => ({ role_id: r.id, harness_ref: { id: scriptedHarness } })),
  }, 'fixture');
  t.after(() => new Promise(resolve => { s.close(); server.close(resolve); server.closeAllConnections(); }));
  const task = s.get("SELECT * FROM tasks WHERE id='t'");
  return { s, requests, spec: { store: s, task, redactor: new Redactor(), guard: async () => {}, system: 'Task execution', prompt: '{}', tools: [tool('finish')], finish: { name: 'finish', validate: v => v }, maxTurns: 4 } };
}

test('Dev and Reviewer read layered-ci-gates from explicit ci-gates bundle; unbinding removes read_skill (#1359)', async t => {
  const ci = await fixture(t, { request: 'Layer the CI in .github/workflows/ci.yml', contract: { goal: 'Layer CI', scope: ['.github/workflows/ci.yml'], criteria: ['Passes'], endpoint: 'reviewable_pull_request' } }, 'layer the CI');
  await runRole(ci.spec, 'dev');
  const first = ci.requests[0], context = JSON.parse(first.messages.at(-1).content).role_context;
  assert.ok(first.tools.some(t => t.function.name === 'read_skill'));
  assert.equal(context.skills.bundle, '@role-skills/dev');
  assert.ok(context.skills.files.some(f => f.path === 'defaults/layered-ci-gates/references/github-setup.md'));
  assert.ok(context.skills.files.some(f => f.path === 'defaults/test-driven-development/SKILL.md'));
  const result = JSON.parse(ci.requests[1].messages.find(m => m.role === 'tool').content);
  assert.equal(result.path, 'defaults/layered-ci-gates/SKILL.md');
  assert.match(result.content, /# Layered CI gates/);
  assert.ok(ci.s.get("SELECT 1 FROM task_history WHERE type='skill_read' AND json_extract(data,'$.path')='defaults/layered-ci-gates/SKILL.md'"));

  // Unbinding all bundles from Dev removes read_skill completely even for a workflow-touching task.
  const rev = roleConfiguration(ci.s, 'r').revision;
  saveConfiguration(ci.s, 'r', { expected_revision: rev, roles: [{ role_id: 'dev', skill_bundle_refs: [] }] }, 'fixture');
  const unbound = await fixture(t, { request: 'Layer the CI in .github/workflows/ci.yml', contract: { goal: 'Layer CI', scope: ['.github/workflows/ci.yml'], criteria: ['Passes'], endpoint: 'reviewable_pull_request' } }, 'layer the CI');
  saveConfiguration(unbound.s, 'r', { expected_revision: roleConfiguration(unbound.s, 'r').revision, roles: [{ role_id: 'dev', skill_bundle_refs: [] }] }, 'fixture');
  await runRole(unbound.spec, 'dev');
  assert.ok(!unbound.requests[0].tools.some(t => t.function.name === 'read_skill'));
  assert.equal(JSON.parse(unbound.requests[0].messages.at(-1).content).role_context.skills, undefined);
});

test('workflowChanges and pullRequestPermissions still detect .github/workflows/ deterministically from contract, PR diff, or parent candidate (#1269)', async t => {
  const s = new Store(':memory:', randomBytes(32));
  t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/ci','o','a')");

  // 1. PR diff files touching .github/workflows/ci.yml
  s.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,summary,input) VALUES('t1','r','development.pr',201,'running','修订 PR #201',?)", JSON.stringify({
    request: 'Revise bot PR #201: fix unit test',
    files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }],
  }));
  assert.equal(workflowChanges(s.get("SELECT * FROM tasks WHERE id='t1'"), s), true);

  // 2. Linked parent development_candidates touching workflow
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('parent-ci','r','task.request','pr_opened','Add checks','{}')");
  s.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('r',202,'PR_202','901','r','bot/task-parent-ci','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','parent-ci')");
  s.run("INSERT INTO development_candidates(task_id,data) VALUES('parent-ci',?)", JSON.stringify({
    files: [{ path: '.github/workflows/ci.yml', mode: '100644', sha: '2'.repeat(40) }],
    snapshot_files: [{ path: '.github/workflows/ci.yml', mode: '100644', sha: '1'.repeat(40) }],
  }));
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t2','r','task.request','running','修订 PR #202',?)", JSON.stringify({
    request: 'Revise bot PR #202: address review comment',
    target: { type: 'pr', number: 202 },
  }));
  assert.equal(workflowChanges(s.get("SELECT * FROM tasks WHERE id='t2'"), s), true);
  assert.deepEqual(
    pullRequestPermissions({
      files: [{ path: '.github/workflows/ci.yml', mode: '100644', sha: '2'.repeat(40) }],
      snapshot_files: [{ path: '.github/workflows/ci.yml', mode: '100644', sha: '1'.repeat(40) }],
    }),
    { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
  );

  // 3. Ordinary non-workflow PR revision
  s.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,summary,input) VALUES('t3','r','development.pr',203,'running','修订 PR #203',?)", JSON.stringify({
    request: 'Revise bot PR #203: fix typo',
    files: [{ filename: 'README.md', status: 'modified' }],
  }));
  assert.equal(workflowChanges(s.get("SELECT * FROM tasks WHERE id='t3'"), s), false);
  assert.equal(
    pullRequestPermissions({
      files: [{ path: 'README.md', mode: '100644', sha: '2'.repeat(40) }],
      snapshot_files: [{ path: 'README.md', mode: '100644', sha: '1'.repeat(40) }],
    }),
    undefined,
  );
});
