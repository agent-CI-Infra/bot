import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialExamples, maskedExamples } from '../../../fixtures/public-credentials.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { githubWrite, writeRoute } from '../../../../dist/github/write.js';
import { defaultPermissions, githubWriteAllowed, permissionTools, updatePermissions } from '../../../../dist/roles/permissions.js';

// github_write starts a workflow (#1072): POST /actions/workflows/{file or id}/dispatches is an Actions write that needs the
// comment ceiling and the role's Actions write, and always asks GitHub for the run it started.
async function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 2)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-bot-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  store.run("INSERT INTO policies(repository_id,enabled,review_enabled,development_enabled) VALUES('r',1,1,0)");
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path, body });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (path === '/repositories/r') return send({ id: 'r', owner: { id: '10' }, full_name: 'fixture/r', default_branch: 'main' });
    const match = /^\/repos\/fixture\/r\/actions\/workflows\/([^/]+)\/dispatches$/.exec(path);
    if (match && req.method === 'POST') {
      // A GitHub without return_run_details answers 204; a workflow without workflow_dispatch is refused with 422.
      if (match[1] === 'legacy.yml') { res.writeHead(204); return res.end(); }
      if (match[1] === 'push-only.yml') return send({ message: "Workflow does not have 'workflow_dispatch' trigger" }, 422);
      return send({ workflow_run_id: 77, run_url: 'https://api.github.com/repos/fixture/r/actions/runs/77', html_url: 'https://github.com/fixture/r/actions/runs/77' });
    }
    const actionRun = /^\/repos\/fixture\/r\/actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs|rerun-pending-jobs|cancel|force-cancel)$/.exec(path);
    if (actionRun && req.method === 'POST') {
      res.writeHead(actionRun[2].includes('cancel') ? 202 : 201, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    const actionJob = /^\/repos\/fixture\/r\/actions\/jobs\/(\d+)\/rerun$/.exec(path);
    if (actionJob && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let role = defaultPermissions('manager', 'controller');
  const repository = store.get("SELECT * FROM repositories WHERE id='r'");
  const write = args => githubWrite({ store, repository, redactor: new Redactor(), guard: async () => {}, apiUrl: 'http://127.0.0.1:' + server.address().port,
    scope: 'task:dispatch', actor: { kind: 'task', role: 'manager', task_id: 'dispatch' }, allowed: (resource, operation) => githubWriteAllowed(role, resource, operation) }, args);
  const dispatches = () => requests.filter(r => r.method === 'POST' && r.path.endsWith('/dispatches'));
  const actionWrites = () => requests.filter(r => r.method === 'POST' && r.path.includes('/actions/'));
  return { store, write, dispatches, actionWrites, setRole: value => { role = value; }, setCeiling: level => store.run("UPDATE policies SET capability_ceiling=? WHERE repository_id='r'", level) };
}

test('Actions dispatch, rerun and cancel routes are Actions writes; Actions write follows Issues write by default (#1072, #1168)', () => {
  for (const path of [
    '/actions/workflows/nightly.yml/dispatches',
    '/actions/workflows/1234/dispatches',
    '/actions/runs/7/rerun',
    '/actions/runs/7/rerun-failed-jobs',
    '/actions/runs/7/rerun-pending-jobs',
    '/actions/runs/7/cancel',
    '/actions/runs/7/force-cancel',
    '/actions/jobs/88/rerun',
  ]) assert.equal(writeRoute('POST', path)?.resource, 'actions', path);
  for (const [method, path] of [['PUT', '/actions/workflows/nightly.yml/dispatches'], ['DELETE', '/actions/runs/7'], ['POST', '/actions/workflows/nightly.yml/enable']])
    assert.equal(writeRoute(method, path), null, method + ' ' + path);
  const manager = defaultPermissions('manager', 'controller');
  assert.equal(manager.github_actions, 'write');
  assert.equal(defaultPermissions('dev', 'writer').github_actions, 'read');
  // Actions write alone offers github_write; without it the route is refused for that role.
  const actionsOnly = updatePermissions(defaultPermissions('dev', 'writer'), { github_actions: 'write' });
  assert.ok(permissionTools(actionsOnly).includes('github_write'));
  assert.deepEqual(['issues', 'actions'].map(resource => githubWriteAllowed(actionsOnly, resource)), [false, true]);
  assert.equal(githubWriteAllowed(updatePermissions(manager, { github_actions: 'read' }), 'actions'), false);
});

test('github_write starts a workflow at the comment ceiling, returns the run once per key and leaves the rest to GitHub (#1072)', async t => {
  const f = await fixture(t), body = { ref: 'main', inputs: { suite: 'full' } };
  // read: refused before anything is sent, naming the level needed.
  f.setCeiling('read');
  const refused = await f.write({ method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body });
  assert.deepEqual([refused.error, refused.needed, refused.ceiling], ['capability_ceiling', 'comment', 'read']);
  assert.equal(f.dispatches().length, 0);
  // comment: sent, always asking for the run's details (even when the agent asked not to), and the run comes back.
  f.setCeiling('comment');
  const started = await f.write({ method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body: { ...body, return_run_details: false } });
  assert.deepEqual(started, { workflow_run_id: 77, run_url: 'https://api.github.com/repos/fixture/r/actions/runs/77', html_url: 'https://github.com/fixture/r/actions/runs/77', status: 200 });
  assert.deepEqual(f.dispatches().map(r => r.body), [{ ref: 'main', inputs: { suite: 'full' }, return_run_details: true }]);
  // The same key never starts a second run; another body under it is a conflict.
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body: { ...body, return_run_details: false } }), { ...started, replayed: true });
  assert.equal((await f.write({ method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body: { ref: 'release' } })).error, 'github_write_key_conflict');
  assert.equal(f.dispatches().length, 1);
  const sent = f.store.get("SELECT * FROM github_writes WHERE state='sent'");
  assert.deepEqual([sent.key, sent.method, sent.path, sent.status, sent.html_url], ['nightly', 'POST', '/actions/workflows/nightly.yml/dispatches', 200, 'https://github.com/fixture/r/actions/runs/77']);
  assert.equal(JSON.parse(sent.response).workflow_run_id, 77);
  assert.ok(f.store.get("SELECT 1 FROM audit WHERE action='github.write.sent' AND resource_id LIKE '%/actions/runs/77'"));
  // GitHub without run details answers 204: sent, no run to report. A workflow without workflow_dispatch is GitHub's 422.
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/workflows/legacy.yml/dispatches', key: 'legacy', body: { ref: 'main' } }), { status: 204 });
  const refusedByGitHub = await f.write({ method: 'POST', path: '/actions/workflows/push-only.yml/dispatches', key: 'push-only', body: { ref: 'main' } });
  assert.equal(refusedByGitHub.error, 'github_http_422'); assert.match(refusedByGitHub.detail, /workflow_dispatch/);
  assert.equal(f.store.get("SELECT state FROM github_writes WHERE key='push-only'").state, 'failed');
  // A role without Actions write is refused before GitHub.
  f.setRole(updatePermissions(defaultPermissions('manager', 'controller'), { github_actions: 'read' }));
  assert.equal((await f.write({ method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'again', body })).error, 'github_resource_forbidden');
  assert.equal(f.dispatches().length, 3);
});

test('a workflow input carrying a self-identifying token reaches GitHub without it', async t => {
  const f = await fixture(t); f.setCeiling('comment');
  const started = await f.write({ method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'token', body: { ref: 'main', inputs: { note: `use ${credentialExamples}.`, suite: 'ghs_prefix' } } });
  assert.equal(started.workflow_run_id, 77);
  assert.deepEqual(f.dispatches().map(r => r.body.inputs), [{ note: `use ${maskedExamples}.`, suite: 'ghs_prefix' }]);
});

test('github_write supports native Actions run and job reruns and cancellations with ceiling, permission and idempotency checks (#1168)', async t => {
  const f = await fixture(t);
  f.setCeiling('read');
  assert.equal((await f.write({ method: 'POST', path: '/actions/runs/91/rerun-failed-jobs', key: 'rerun-91' })).error, 'capability_ceiling');
  assert.equal(f.actionWrites().length, 0);

  f.setCeiling('comment');
  const rerunFailed = await f.write({ method: 'POST', path: '/actions/runs/91/rerun-failed-jobs', key: 'rerun-91', body: { enable_debug_logging: true } });
  assert.deepEqual(rerunFailed, { status: 201 });
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/runs/91/rerun-failed-jobs', key: 'rerun-91', body: { enable_debug_logging: true } }), { status: 201, replayed: true });
  assert.equal((await f.write({ method: 'POST', path: '/actions/runs/91/rerun-failed-jobs', key: 'rerun-91', body: { enable_debug_logging: false } })).error, 'github_write_key_conflict');

  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/runs/91/rerun', key: 'rerun-all-91' }), { status: 201 });
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/runs/91/rerun-pending-jobs', key: 'rerun-pending-91' }), { status: 201 });
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/runs/91/cancel', key: 'cancel-91' }), { status: 202 });
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/runs/91/force-cancel', key: 'force-cancel-91' }), { status: 202 });
  assert.deepEqual(await f.write({ method: 'POST', path: '/actions/jobs/404/rerun', key: 'rerun-job-404' }), { status: 201 });
  assert.equal(f.actionWrites().length, 6);

  f.setRole(updatePermissions(defaultPermissions('manager', 'controller'), { github_actions: 'read' }));
  assert.equal((await f.write({ method: 'POST', path: '/actions/runs/91/cancel', key: 'denied-cancel' })).error, 'github_resource_forbidden');
});
