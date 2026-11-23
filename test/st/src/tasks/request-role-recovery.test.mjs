import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { configureModelRetry } from '../../../../dist/agent/runtime.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { server as github } from '../../../fixtures/agent-server.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { nativeRoles } from '../../../fixtures/native-roles.mjs';

const pass = { outcome: 'pass', reason: 'Reviewed the fixed candidate and its evidence.', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function fixture(t, respond) {
  configureModelRetry({ baseMs: 1 });
  t.after(() => configureModelRetry(null));
  const root = mkdtempSync(join(tmpdir(), 'bot-request-role-recovery-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  github.listen(0, '127.0.0.1');
  await once(github, 'listening');
  t.after(async () => {
    await manager.recover();
    store.close();
    rmSync(root, { recursive: true, force: true });
    github.closeAllConnections();
    await new Promise(resolve => github.close(resolve));
  });
  const gh = 'http://127.0.0.1:' + github.address().port;
  await fetch(gh + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'fixture-github-token', model_key: 'fixture-model-key' }) });

  const modelErrors = [];
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    try {
      const message = await respond(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } catch (error) {
      // Keep diagnostics in the test process only; never echo error details to the client.
      modelErrors.push(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture_model_error' } }));
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => {
    if (modelErrors.length) throw modelErrors[0];
    return new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
  });

  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'fixture-github-token' }, 'account:a'), 'now');
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  nativeRoles(store, '101');
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:' + model.address().port + '/v1', 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,'comment')");
  const engine = new TaskEngine(store, manager, gh + '/github');
  t.after(async () => {
    await engine.close();
  });

  const addTask = (input, kind = 'task.request') => {
    const id = randomBytes(24).toString('hex');
    store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,created_at,updated_at) VALUES(?,'101',?,'queued','prepare','fixture',?,datetime('now'),datetime('now'))", id, kind, JSON.stringify(input));
    authorizeKnowledgeTask(store, id);
    setGrant(store, { id, repository_id: '101' }, Array.isArray(input.writes) ? input.writes : [], 'owner', null);
    return id;
  };
  const tick = async () => {
    engine.tick();
    await Promise.all(engine.active.values());
  };
  const due = id => store.run('UPDATE tasks SET next_run_at=0 WHERE id=?', id);
  return { store, engine, addTask, tick, due, gh };
}

const reviewInput = () => ({
  generic: true,
  executor_role: 'reviewer',
  target: { type: 'pr', number: 42 },
  delivery: 'review',
  request: 'Review pull request #42',
  writes: ['review'],
  contract: { goal: 'Review pull request #42', scope: ['calc.mjs'], criteria: ['Assess the arithmetic change'], endpoint: 'review', source: 'request' },
});

test('#1261 single-role reviewer records role_candidate and recovers after QA returns', { timeout: 90000 }, async t => {
  let reviewerRuns = 0, qaRuns = 0;
  const h = await fixture(t, body => {
    const tools = (body.tools || []).map(tool => tool.function.name);
    if (tools.includes('submit_acceptance')) {
      qaRuns++;
      if (qaRuns === 1) return call('submit_acceptance', { ...pass, outcome: 'return', reason: 'Explain the observed arithmetic change.', gaps: ['State the observed arithmetic change.'], core_complete: false, required_evidence_complete: false, acceptable_risk: false });
      return call('submit_acceptance', pass);
    }
    if (tools.includes('post_review')) {
      reviewerRuns++;
      return call('post_review', { pull_number: 42, summary: `Round ${reviewerRuns}: the arithmetic change is consistent with its tests.` });
    }
    if (tools.includes('submit_report')) {
      return call('submit_report', { summary: 'Reviewed pull request #42.', artifacts: [], evidence: [], unknowns: [] });
    }
    throw new Error('unexpected model request: ' + tools.join(','));
  });

  const id = h.addTask(reviewInput());
  await h.tick();
  const afterFirst = h.store.get('SELECT status,phase,error_code,input FROM tasks WHERE id=?', id);
  assert.notEqual(afterFirst.status, 'waiting_configuration', JSON.stringify(h.store.all('SELECT content FROM task_logs WHERE task_id=?', id)));
  const candidates = h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='role_candidate' ORDER BY id", id).map(row => JSON.parse(row.data));
  assert.ok(candidates.some(candidate => candidate.role === 'reviewer' && /^[a-f0-9]{40}$/.test(String(candidate.sha)) && /^[a-f0-9]{40}$/.test(String(candidate.version))), 'the single-role reviewer run must record its source candidate with a 40-hex sha and version');
  assert.equal(reviewerRuns, 1);
  assert.equal(qaRuns, 1);

  h.due(id);
  await h.tick();
  const done = h.store.get('SELECT status,phase,error_code FROM tasks WHERE id=?', id);
  assert.deepEqual([done.status, done.phase, done.error_code], ['succeeded', 'done', null], JSON.stringify(h.store.all('SELECT content FROM task_logs WHERE task_id=?', id)));
  assert.equal(reviewerRuns, 2, 'QA return must start a second reviewer run');
  assert.equal(qaRuns, 2);
  const state = await (await fetch(h.gh + '/fixture/state')).json();
  const reviewComments = state.comments.filter(comment => comment.number === 42);
  assert.equal(reviewComments.length, 1, 'the second round updates the review summary comment rather than duplicating it');
  assert.match(reviewComments[0].body, /Round 2:/, 'the published review must contain the second round delivery');
});

test('#1261 a consumed move_to_sha is not written back, so retries keep the workspace and back off', { timeout: 90000 }, async t => {
  let preparationRuns = 0;
  const h = await fixture(t, body => {
    const tools = (body.tools || []).map(tool => tool.function.name);
    if (tools.includes('post_review')) {
      return call('post_review', { pull_number: 42, summary: 'Invalid anchor on purpose.', comments: [{ path: 'calc.mjs', line: 999, body: 'Not in the diff.' }] });
    }
    throw new Error('unexpected model request: ' + tools.join(','));
  });

  // Move the contributor branch ahead, then ask the review task to review that exact new head.
  const moved = await (await fetch(h.gh + '/fixture/ref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository_id: '101', branch: 'contributor' }) })).json();
  assert.match(moved.sha, /^[a-f0-9]{40}$/);
  const input = { ...reviewInput(), move_to_sha: moved.sha };
  const id = h.addTask(input);
  await h.tick();

  const phaseStarts = () => h.store.all("SELECT id FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='phase' AND json_extract(content,'$.phase')='prepare'", id);
  preparationRuns = phaseStarts().length;
  assert.equal(preparationRuns, 1);
  const first = h.store.get('SELECT status,phase,error_code,wait_count,input FROM tasks WHERE id=?', id);
  assert.equal(first.status, 'retry_wait', JSON.stringify(h.store.all('SELECT content FROM task_logs WHERE task_id=?', id)));
  // The invalid inline anchor is retried until the reviewer run reaches its turn limit, which is the retryable failure
  // this fixture actually produces.
  assert.equal(first.error_code, 'agent_turn_limit', 'the fixture review must stop on the failure its invalid inline anchor causes');
  assert.equal(first.wait_count, 0);
  assert.equal(JSON.parse(first.input).move_to_sha, undefined, 'the consumed move_to_sha must not be persisted again');

  h.due(id);
  await h.tick();
  const second = h.store.get('SELECT status,phase,error_code,wait_count,input FROM tasks WHERE id=?', id);
  assert.equal(second.status, 'retry_wait');
  assert.equal(second.error_code, first.error_code);
  assert.equal(second.wait_count, 1, 'the same failure must increment the backoff count instead of resetting it');
  assert.equal(phaseStarts().length, preparationRuns, 'a retry must reuse the prepared workspace instead of preparing it again');
  assert.equal(JSON.parse(second.input).move_to_sha, undefined);
});

test('#1261 a different move_to_sha requested during the reviewer run is synced and used by the next preparation', { timeout: 120000 }, async t => {
  let id;
  let firstSha;
  let secondSha;
  let reviewerRuns = 0, qaRuns = 0;
  let requestedNewHead = false;
  const h = await fixture(t, async body => {
    const tools = (body.tools || []).map(tool => tool.function.name);
    if (tools.includes('submit_acceptance')) {
      qaRuns++;
      if (qaRuns === 1) return call('submit_acceptance', { ...pass, outcome: 'return', reason: 'Explain the observed arithmetic change.', gaps: ['State the observed arithmetic change.'], core_complete: false, required_evidence_complete: false, acceptable_risk: false });
      return call('submit_acceptance', pass);
    }
    if (tools.includes('post_review')) {
      reviewerRuns++;
      if (!requestedNewHead) {
        requestedNewHead = true;
        // Another event moves the pull request head while this reviewer run is still executing, so the live task input
        // asks for a head the run has not consumed. syncConcurrentInput must carry it into the persisted input.
        const moved = await (await fetch(h.gh + '/fixture/ref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository_id: '101', branch: 'contributor' }) })).json();
        secondSha = moved.sha;
        assert.match(secondSha, /^[a-f0-9]{40}$/);
        assert.notEqual(secondSha, firstSha, 'the newly requested head must differ from the consumed one');
        const live = JSON.parse(String(h.store.get('SELECT input FROM tasks WHERE id=?', id).input));
        live.move_to_sha = secondSha;
        h.store.run('UPDATE tasks SET input=?, updated_at=? WHERE id=?', JSON.stringify(live), new Date().toISOString(), id);
      }
      return call('post_review', { pull_number: 42, summary: `Round ${reviewerRuns}: the arithmetic change is consistent with its tests.` });
    }
    if (tools.includes('submit_report')) {
      return call('submit_report', { summary: 'Reviewed pull request #42.', artifacts: [], evidence: [], unknowns: [] });
    }
    throw new Error('unexpected model request: ' + tools.join(','));
  });

  const initial = await (await fetch(h.gh + '/fixture/ref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository_id: '101', branch: 'contributor' }) })).json();
  firstSha = initial.sha;
  assert.match(firstSha, /^[a-f0-9]{40}$/);
  id = h.addTask({ ...reviewInput(), move_to_sha: firstSha });
  await h.tick();

  const afterFirst = h.store.get('SELECT status,phase,head_sha,input FROM tasks WHERE id=?', id);
  assert.notEqual(afterFirst.status, 'waiting_configuration', JSON.stringify(h.store.all('SELECT content FROM task_logs WHERE task_id=?', id)));
  assert.equal(afterFirst.head_sha, firstSha, 'the first preparation targets the consumed move_to_sha');
  assert.equal(JSON.parse(afterFirst.input).move_to_sha, secondSha, 'a different move_to_sha requested during the run must be synced and persisted');
  assert.equal(reviewerRuns, 1);
  assert.equal(qaRuns, 1);

  h.due(id);
  await h.tick();
  const done = h.store.get('SELECT status,phase,head_sha,error_code,input FROM tasks WHERE id=?', id);
  assert.deepEqual([done.status, done.phase, done.error_code], ['succeeded', 'done', null], JSON.stringify(h.store.all('SELECT content FROM task_logs WHERE task_id=?', id)));
  assert.equal(done.head_sha, secondSha, 'the next preparation must target the newly requested head');
  assert.equal(JSON.parse(done.input).move_to_sha, undefined, 'the newly requested move_to_sha is consumed by that preparation');
  assert.equal(reviewerRuns, 2);
  assert.equal(qaRuns, 2);
});
