import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from './release-fixtures.mjs';
import { RepositoryExplorer, repositoryTools } from '../dist/agent/exploration.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { Redactor } from '../dist/agent/common.js';
import { agentLoop } from '../dist/agent/loop.js';
import { Workspace } from '../dist/agent/workspace.js';
import { workspaceProfile } from '../dist/agent/profiles.js';
import { agentOperation } from '../runner/agent.mjs';

async function explorerFixture(t) {
  const f = await releaseFixture(t), redactor = new Redactor(), repo = f.h.store.get("SELECT * FROM repositories WHERE id='101'");
  const tokens = new ReadTokens(f.h.store, repo, redactor, async () => {}, f.apiUrl);
  t.after(() => tokens.revoke());
  const explorer = new RepositoryExplorer(tokens, redactor, async () => {});
  f.state.custom = async ({ path, url, send }) => {
    if (path.endsWith('/contents/src/build.ts')) { send({ encoding: 'base64', content: Buffer.from('export const packageName = "compiler";').toString('base64') }); return true; }
    if (path.endsWith('/issues/42/comments')) { send([{ body: 'Related discussion: dependency renamed.' }]); return true; }
    if (path.endsWith('/pulls/9/files')) { send([{ filename: 'src/build.ts', patch: 'dependency renamed' }]); return true; }
    if (path === '/search/issues') { assert.match(url.searchParams.get('q'), /^repo:fixture\/project-101 /); send({ total_count: 1, items: [{ number: 42, repository_url: f.apiUrl + '/repos/fixture/project-101', title: 'Earlier failure' }] }); return true; }
    return false;
  };
  return { ...f, explorer, tokens, redactor };
}

test('the shared explorer reads code, unrelated Issue/PR discussions, search pages and related Actions logs', async t => {
  const f = await explorerFixture(t), before = f.state.requests.length;
  assert.equal((await f.explorer.execute('github_read', { path: '/contents/src/build.ts' })).error, 'github_read_token_required');
  const grant = await f.explorer.execute('github_read_token', {});
  assert.equal(grant.repository, 'fixture/project-101'); assert.ok(!Object.hasOwn(grant, 'token'));
  assert.ok(Object.values(grant.permissions).every(value => value === 'read'));
  const file = await f.explorer.execute('github_read', { path: '/contents/src/build.ts?ref=' + 'a'.repeat(40) });
  assert.equal(file.encoding, 'utf-8'); assert.match(file.content, /compiler/);
  assert.match(JSON.stringify(await f.explorer.execute('github_read', { path: '/issues/42/comments?page=2' })), /Related discussion/);
  assert.match(JSON.stringify(await f.explorer.execute('github_read', { path: '/pulls/9/files' })), /src\/build.ts/);
  assert.equal((await f.explorer.execute('github_search', { query: 'is:issue dependency', page: 2 })).items[0].number, 42);
  f.state.jobs = [{ id: 2, run_id: 801, run_attempt: 3, name: 'Earlier build', html_url: 'https://github.com/fixture/project-101/actions/runs/801/job/2' }];
  f.state.logs[2] = 'Build setup\nError: old dependency\n';
  const log = await f.explorer.execute('read_job_log', { job_id: 2, start_line: 2 });
  assert.equal(log.run_id, 801); assert.equal(log.attempt, 3); assert.match(log.content, /old dependency/);
  assert.ok(f.state.requests.slice(before).filter(r => !r.path.endsWith('/access_tokens')).every(r => r.method === 'GET'));
  assert.equal(f.state.tokens.at(-1).repository_ids[0], 101);
});

test('read tools reject URL/path escapes, cross-repository search and writes before sending requests', async t => {
  const f = await explorerFixture(t); await f.explorer.execute('github_read_token', {});
  const before = f.state.requests.length;
  for (const path of ['https://evil.invalid/contents/a', '//evil.invalid/a', '/repos/other/private/issues', '/contents/../../repos/other/private', '/contents/%2e%2e/issues', '/contents/%252e%252e/issues', '/issues/1%2f../../other', '/contents/a\\b', '/actions/jobs/1/logs', '/installation/token'])
    assert.equal((await f.explorer.execute('github_read', { path })).error, 'invalid_arguments', path);
  assert.equal((await f.explorer.execute('github_read', { path: '/issues', method: 'POST' })).error, 'invalid_arguments');
  assert.equal((await f.explorer.execute('github_search', { query: 'repo:other/private secret' })).error, 'invalid_arguments');
  assert.equal((await f.explorer.execute('github_search', { query: 'org:other is:pr' })).error, 'invalid_arguments');
  assert.equal((await f.explorer.execute('rerun', {})).error, 'tool_not_allowed');
  assert.equal(f.state.requests.length, before);
  f.state.custom = async ({ path, send }) => { if (path !== '/search/issues') return false; send({ items: [{ repository_url: f.apiUrl + '/repos/other/private', body: 'foreign' }] }); return true; };
  assert.deepEqual(await f.explorer.execute('github_search', { query: 'dependency' }), { error: 'github_search_repository_mismatch' });
});

test('decoded repository text is redacted, permission errors are explicit and a revoked guard stops exploration', async t => {
  const f = await explorerFixture(t); f.redactor.add('exploration-secret'); await f.explorer.execute('github_read_token', {});
  f.state.custom = async ({ path, send }) => { if (!path.includes('/contents/')) return false; send({ encoding: 'base64', content: Buffer.from('code exploration-secret').toString('base64') }); return true; };
  assert.equal((await f.explorer.execute('github_read', { path: '/contents/a' })).content, 'code [REDACTED]');
  f.state.deny = '/repos/fixture/project-101/issues/42';
  assert.equal((await f.explorer.execute('github_read', { path: '/issues/42' })).error, 'github_permission_403');
  const denied = new RepositoryExplorer(f.tokens, f.redactor, async () => { throw new Error('disabled'); });
  await assert.rejects(denied.execute('github_read_token', {}), /disabled/);
});

test('serialized UTF-8 results use the existing 2 MiB capacity without truncating JSON or imposing a smaller quota', async t => {
  const f = await explorerFixture(t), limit = 2 * 1024 * 1024;
  await f.explorer.execute('github_read_token', {});
  let data;
  f.state.custom = async ({ path, send }) => {
    if (!path.includes('/git/trees/') && path !== '/search/issues') return false;
    send(data); return true;
  };
  for (const size of [600000, limit, limit + 1]) {
    const length = size - Buffer.byteLength(JSON.stringify({ content: '' }));
    data = { content: '仓'.repeat(Math.floor(length / 3)) + 'x'.repeat(length % 3) };
    assert.equal(Buffer.byteLength(JSON.stringify(data)), size);
    const result = await f.explorer.execute('github_read', { path: '/git/trees/' + 'a'.repeat(40) + '?recursive=1' });
    if (size <= limit) assert.deepEqual(result, data);
    else { assert.equal(result.error, 'repository_result_too_large'); assert.match(result.detail, /path.*recursive.*page/); }
    if (size === limit) {
      const root = join(f.h.directory, 'exact-mailbox'), dir = join(root, 'agent'), id = 'a'.repeat(48), reply = Buffer.from(JSON.stringify(result));
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'repository-request.json'), JSON.stringify({ id }));
      for (let offset = 0; offset < reply.length; offset += 30000) await agentOperation({ type: 'workspace_agent_repository_tool', request_id: id, base64: reply.subarray(offset, offset + 30000).toString('base64'), offset, final: offset + 30000 >= reply.length }, root);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'repository-reply-' + id + '.json'))), data);
    }
  }
  data = { items: [{ repository_url: f.apiUrl + '/repos/fixture/project-101', body: 'x'.repeat(limit) }] };
  assert.equal((await f.explorer.execute('github_search', { query: 'dependency' })).error, 'repository_result_too_large');
});

test('review and development Pi adapters execute the same repository tools through the control plane', async t => {
  const f = await explorerFixture(t);
  const model = (await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'exploration-model-key', model_name: 'fixture' })).value.model;
  await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  for (const kind of ['review.issue', 'review.pr', 'development.issue', 'development.pr']) {
    const profile = workspaceProfile(kind, {});
    assert.ok(repositoryTools.every(tool => profile.tools.includes(tool))); assert.match(profile.system, /not the boundary of evidence/);
  }
  const id = 'exploration'; f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES(?,'101','review.issue','running','Explore',1)", id);
  const task = f.h.store.get('SELECT * FROM tasks WHERE id=?', id), replies = [], requests = [
    { name: 'github_read', arguments: { path: '/contents/src/build.ts' } },
    { name: 'github_read', arguments: { path: '/issues/42/comments' } },
    { name: 'github_read', arguments: { path: '/pulls/9/files' } }
  ];
  let authorized = false, index = 0, reply = [];
  const workspace = { log() {}, async call(_key, input) {
    if (input.type !== 'workspace_agent_poll') return { written: true, started: true };
    if (!authorized) return { state: 'running', token_request: { id: 'a'.repeat(48) } };
    if (index < requests.length) return { state: 'running', repository_tool: { id: String(index).padStart(48, 'b'), ...requests[index] } };
    return { state: 'completed', result: { summary: 'Read related evidence.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' } };
  }, async deliver(input) {
    if (input.type === 'workspace_agent_token') authorized = true;
    if (input.type === 'workspace_agent_repository_tool') { reply.push(Buffer.from(input.base64, 'base64')); if (input.final) { replies.push(JSON.parse(Buffer.concat(reply))); reply = []; index++; } }
    return { written: true };
  } };
  const result = await agentLoop(f.h.store, task, workspace, f.redactor, async () => {}, {}, f.tokens);
  assert.match(result.summary, /related/); assert.match(replies[0].content, /compiler/); assert.match(replies[1][0].body, /Related/); assert.equal(replies[2][0].filename, 'src/build.ts');
  assert.ok(!JSON.stringify(replies).includes('fixture-installation-'));
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.path === '/installation/token'));
  // The runner can survive a control-plane restart and go straight to a read with its cached grant.
  const issued = f.state.tokens.length; index = 0; replies.length = 0;
  await agentLoop(f.h.store, task, workspace, f.redactor, async () => {}, {}, f.tokens);
  assert.match(replies[0].content, /compiler/); assert.equal(f.state.tokens.length, issued + 1);
});

test('runner repository-tool mailbox binds replies to the current request and preserves chunk order', async t => {
  const f = await releaseFixture(t), root = join(f.h.directory, 'exploration'), dir = join(root, 'agent'); mkdirSync(dir, { recursive: true });
  const id = 'a'.repeat(48); writeFileSync(join(dir, 'repository-request.json'), JSON.stringify({ id, name: 'github_read', arguments: { path: '/issues/42' } }));
  assert.equal((await agentOperation({ type: 'workspace_agent_poll' }, root)).repository_tool.name, 'github_read');
  await assert.rejects(agentOperation({ type: 'workspace_agent_repository_tool', request_id: 'b'.repeat(48), base64: '', offset: 0 }, root), /agent_request_changed/);
  const reply = Buffer.from(JSON.stringify({ content: '仓库内容'.repeat(100) }));
  for (let offset = 0; offset < reply.length; offset += 25) await agentOperation({ type: 'workspace_agent_repository_tool', request_id: id, base64: reply.subarray(offset, offset + 25).toString('base64'), offset, final: offset + 25 >= reply.length }, root);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'repository-reply-' + id + '.json'))), JSON.parse(reply));
});

test('real Workspace delivery ignores only abandoned repository replies, including runner-wrapped errors', async t => {
  const f = await explorerFixture(t);
  const model = (await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'late-reply-model', model_name: 'fixture' })).value.model;
  await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  f.state.custom = async ({ path, send }) => {
    if (!path.endsWith('/issues/42/comments')) return false;
    send([{ body: 'Related evidence. '.repeat(4000) }]); return true;
  };
  const cases = [
    { error: 'agent_request_changed', continues: true },
    { error: 'runner_operation_failed', detail: 'workspace_agent_repository_tool: agent_request_changed', continues: true },
    { error: 'agent_reply_offset' },
    { error: 'runner_operation_failed', detail: 'workspace_agent_repository_tool: agent_reply_offset' },
    { error: 'runner_operation_failed' },
    { error: 'runner_operation_failed', detail: 'workspace_agent_progress: agent_request_changed' },
    { error: 'runner_operation_failed', detail: 'workspace_agent_repository_tool: agent_request_changed unexpectedly' }
  ];
  for (const [index, { continues, ...failure }] of cases.entries()) await t.test(JSON.stringify(failure), async () => {
    const id = 'late-' + index;
    f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,'101','review.issue','running','Read')", id);
    const task = f.h.store.get('SELECT * FROM tasks WHERE id=?', id), deliveries = [];
    const manager = { async call(_method, _path, { request }) {
      if (request.type === 'workspace_agent_repository_tool') {
        deliveries.push(request); return { ok: false, ...failure };
      }
      if (request.type !== 'workspace_agent_poll') return { ok: true, result: {} };
      return { ok: true, result: deliveries.length
        ? { state: 'completed', result: { summary: 'Continued after the read.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' } }
        : { state: 'running', repository_tool: { id: 'a'.repeat(48), name: 'github_read', arguments: { path: '/issues/42/comments' } } } };
    } };
    const workspace = new Workspace(f.h.store, manager, task, f.redactor, async () => {}, () => {});
    const running = agentLoop(f.h.store, task, workspace, f.redactor, async () => {}, {}, f.tokens);
    if (continues) assert.match((await running).summary, /Continued/);
    else await assert.rejects(running, { code: 'execution_interrupted' });
    assert.equal(deliveries.length, 1, 'stop sending chunks after the first rejected delivery');
    assert.equal(deliveries[0].offset, 0); assert.equal(deliveries[0].final, false);
    assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.path === '/installation/token'));
  });
});
