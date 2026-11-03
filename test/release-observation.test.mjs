import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFixture, run, writes, other } from './release-fixtures.mjs';

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const final = advice => ({ content: JSON.stringify({ job_ids: [1], advice }) });
const invoke = (...calls) => ({ content: null, tool_calls: calls });
async function fixture(t) {
  const f = await releaseFixture(t); f.state.runs = [run({ conclusion: 'failure' })];
  f.state.jobs = [{ id: 1, run_id: 800, run_attempt: 1, name: 'release', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/800/job/1', steps: [{ number: 1, name: 'Build', conclusion: 'failure' }] }];
  const created = await f.create(); for (let i = 0; i < 2; i++) await f.service.worker.process(created.value.release.id);
  const m = await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'observation-fixture-secret', model_name: 'fixture' });
  await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: m.value.model.id });
  const record = () => f.h.store.get('SELECT * FROM project_releases WHERE id=?', created.value.release.id);
  return Object.assign(f, { record, analyze: async () => (await f.admin(f.endpoint + '/' + created.value.release.id + '/observe', 'POST', { revision: record().revision })).value.release });
}
test('observation actively exchanges an Actions-only token, reads redacted log windows and revokes it', async t => {
  const f = await fixture(t), requests = []; let turn = 0;
  f.state.custom = async ({ path, body, send, req, res }) => {
    if (path.endsWith('/actions/jobs/1/logs')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Build started\nError: missing release script\nobservation-fixture-secret\n' + req.headers.authorization.slice(7)); return true; }
    if (path !== '/v1/chat/completions') return false;
    requests.push(body); const reply = [invoke(call('token', 'github_read_token')), invoke(call('log', 'read_job_log', { job_id: 1, start_line: 2, max_lines: 3 })), final('release job 第 2 行显示缺少 release script，请检查构建脚本。')][turn++];
    send({ choices: [{ message: reply }] }); return true;
  };
  const before = f.state.tokens.length, result = await f.analyze(); assert.equal(result.stage, 'failed'); assert.equal(result.observation.logs.length, 1);
  const grant = f.state.tokens.slice(before).find(t => !t.permissions.contents); assert.deepEqual(grant, { repository_ids: [101], permissions: { actions: 'read', metadata: 'read' } });
  const read = f.state.requests.find(r => r.path.endsWith('/actions/jobs/1/logs')), token = read.token.slice(7);
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.path === '/installation/token' && r.token === 'Bearer ' + token));
  const transcript = JSON.stringify(requests); assert.ok(!transcript.includes(token)); assert.ok(!transcript.includes('observation-fixture-secret')); assert.match(transcript, /missing release script/); assert.match(transcript, /REDACTED/);
  assert.deepEqual(requests[0].tools.map(t => t.function.name), ['github_read_token', 'read_job_log']);
  assert.equal(result.observation.logs[0].first_line, 2); assert.equal(result.observation.logs[0].last_line, 4);
  assert.ok(!JSON.stringify(f.h.store.all('SELECT data FROM project_releases')).includes(token));
  assert.ok(writes(f.state).filter(r => r.path !== '/v1/chat/completions').every(r => r.path.endsWith('/git/tags') || r.path.endsWith('/git/refs')));
});
test('observation rejects jobs outside the bound attempt, arbitrary paths and write tools', async t => {
  const f = await fixture(t); let turn = 0, last;
  f.state.custom = async ({ path, body, send }) => {
    if (path !== '/v1/chat/completions') return false; last = body;
    const reply = [invoke(call('t', 'github_read_token')), invoke(call('foreign', 'read_job_log', { job_id: 999 }), call('path', 'read_job_log', { job_id: 1, path: '/releases' }), call('write', 'rerun', {})), final('越界读取已被拒绝，未改变运行。')][turn++];
    send({ choices: [{ message: reply }] }); return true;
  };
  const result = await f.analyze(); assert.equal(result.stage, 'failed'); assert.deepEqual(result.observation.logs, []);
  assert.ok(!f.state.requests.some(r => /\/jobs\/.*\/logs/.test(r.path)));
  const replies = last.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.ok(replies.some(r => r.error === 'job_outside_bound_attempt')); assert.ok(replies.some(r => r.error === 'invalid_arguments')); assert.ok(replies.some(r => r.error === 'tool_not_allowed'));
});
test('a rerun during observation stops log reads from the old attempt and still revokes the token', async t => {
  const f = await fixture(t); let turn = 0;
  f.state.custom = async ({ path, send }) => {
    if (path !== '/v1/chat/completions') return false;
    if (turn++ === 0) send({ choices: [{ message: invoke(call('t', 'github_read_token')) }] });
    else { f.state.runs[0].run_attempt = 2; f.state.jobs[0].run_attempt = 2; send({ choices: [{ message: invoke(call('log', 'read_job_log', { job_id: 1 })) }] }); }
    return true;
  };
  const result = await f.analyze(); assert.equal(result.stage, 'failed'); assert.match(result.observation_error, /attempt/);
  assert.ok(!f.state.requests.some(r => r.path.endsWith('/jobs/1/logs')));
  const token = 'Bearer fixture-installation-' + f.state.tokens.length;
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.token === token));
});
test('log redirects are fetched without authorization and temporary URLs never reach the model', async t => {
  const f = await fixture(t); let turn = 0, transcript = '';
  f.state.custom = async ({ path, body, req, res, send }) => {
    if (path.endsWith('/actions/jobs/1/logs')) { res.writeHead(302, { Location: f.apiUrl + '/signed-log?signature=private-download-signature' }); res.end(); return true; }
    if (path === '/signed-log') { assert.equal(req.headers.authorization, undefined); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Build failed: missing compiler'); return true; }
    if (path !== '/v1/chat/completions') return false; transcript += JSON.stringify(body);
    const reply = [invoke(call('t', 'github_read_token')), invoke(call('log', 'read_job_log', { job_id: 1 })), final('日志显示缺少编译器。')][turn++]; send({ choices: [{ message: reply }] }); return true;
  };
  const result = await f.analyze(); assert.equal(result.observation.logs.length, 1, JSON.stringify(result)); assert.equal(result.observation.logs[0].content, 'Build failed: missing compiler');
  assert.ok(!transcript.includes('private-download-signature')); assert.ok(!JSON.stringify(result).includes('signed-log'));
});
test('unavailable logs and a later model failure preserve CI facts and revoke issued tokens', async t => {
  const f = await fixture(t); let turn = 0, last;
  f.state.custom = async ({ path, body, send }) => {
    if (path !== '/v1/chat/completions') return false; last = body;
    const reply = [invoke(call('t', 'github_read_token')), invoke(call('log', 'read_job_log', { job_id: 1 })), final('日志暂不可用，请查看 Actions。')][turn++]; send({ choices: [{ message: reply }] }); return true;
  };
  const result = await f.analyze(); assert.equal(result.stage, 'failed'); assert.equal(result.run.conclusion, 'failure');
  assert.ok(last.messages.some(m => m.role === 'tool' && JSON.parse(m.content).error === 'github_permission_404'));
  turn = 0; f.state.custom = async ({ path, send }) => { if (path !== '/v1/chat/completions') return false; if (turn++ === 0) send({ choices: [{ message: invoke(call('t', 'github_read_token')) }] }); else send({}, 503); return true; };
  const failed = await f.analyze(); assert.equal(failed.stage, 'failed'); assert.match(failed.observation_error, /503/);
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.token === 'Bearer fixture-installation-' + f.state.tokens.length));
});
test('an unexpectedly writable observation token is refused and revoked before any log read', async t => {
  const f = await fixture(t); let turn = 0, last;
  f.state.custom = async ({ path, body, send }) => {
    if (path.endsWith('/access_tokens') && body.permissions.metadata === 'read' && !body.permissions.contents) {
      send({ token: 'unexpected-write-token', permissions: { actions: 'write', metadata: 'read' } }, 201); return true;
    }
    if (path !== '/v1/chat/completions') return false; last = body;
    send({ choices: [{ message: turn++ === 0 ? invoke(call('t', 'github_read_token')) : final('只读令牌校验失败，无法读取日志。') }] }); return true;
  };
  const result = await f.analyze(); assert.equal(result.stage, 'failed'); assert.deepEqual(result.observation.logs, []);
  assert.ok(last.messages.some(m => m.role === 'tool' && JSON.parse(m.content).error === 'github_read_token_not_read_only'));
  assert.ok(!JSON.stringify(last).includes('unexpected-write-token'));
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.token === 'Bearer unexpected-write-token'));
  assert.ok(!f.state.requests.some(r => r.path.endsWith('/jobs/1/logs')));
});
test('unsafe redirects and oversized logs produce diagnostics instead of leaking partial content', async t => {
  for (const fault of ['redirect', 'oversize']) {
    const f = await fixture(t); let turn = 0, last;
    f.state.custom = async ({ path, body, send, res }) => {
      if (path.endsWith('/actions/jobs/1/logs')) {
        if (fault === 'redirect') { res.writeHead(302, { Location: 'file:///private-log' }); res.end(); }
        else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('x'.repeat(8 * 1024 * 1024 + 1)); }
        return true;
      }
      if (path !== '/v1/chat/completions') return false; last = body;
      const reply = [invoke(call('t', 'github_read_token')), invoke(call('log', 'read_job_log', { job_id: 1 })), final('日志无法安全读取，请在 Actions 查看。')][turn++]; send({ choices: [{ message: reply }] }); return true;
    };
    const result = await f.analyze(); assert.equal(result.stage, 'failed'); assert.deepEqual(result.observation.logs, []);
    assert.ok(last.messages.some(m => m.role === 'tool' && JSON.parse(m.content).error === (fault === 'redirect' ? 'github_log_redirect_invalid' : 'github_log_too_large')));
    assert.ok(!JSON.stringify(last).includes('file:///private-log'));
  }
});
test('observation does not hold the publishing lease or overwrite concurrent control-plane state', async t => {
  const f = await fixture(t); let resume, started;
  const held = new Promise(resolve => { resume = resolve; }), ready = new Promise(resolve => { started = resolve; });
  f.state.custom = async ({ path, send }) => { if (path !== '/v1/chat/completions') return false; started(); await held; send({ choices: [{ message: final('仍以控制面状态为准。') }] }); return true; };
  const pending = f.analyze(); await ready;
  try {
    const before = f.record(); assert.equal(before.lease, null); assert.equal(before.active, 0);
    const writer = f.service.claim(before.id); f.service.save(writer, { detail: '控制面继续更新状态' }, 'failed'); f.service.unlock(writer);
    // A second version needs a new commit; the previous tag's ancestry stays unchanged.
    f.state.histories[f.state.head] = [...f.state.commits]; f.state.head = other;
    f.state.commits.unshift({ sha: other, commit: { message: 'Follow-up change' }, html_url: 'https://github.com/fixture/project-101/commit/' + other });
    const next = await f.create('v1.2.4'); assert.equal(next.status, 201); assert.notEqual(next.value.release.id, before.id);
  } finally { resume(); }
  const result = await pending; assert.equal(result.stage, 'failed'); assert.equal(result.detail, '控制面继续更新状态'); assert.ok(result.observation);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM release_observers').n, 0);
});
