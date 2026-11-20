import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceFixture } from '../../../fixtures/acceptance-fixture.mjs';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { configureDispatch } from '../../../../dist/dispatch/worker.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { ingest } from '../../../../dist/app/webhook.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';
import { roleConfiguration, saveConfiguration } from '../../../../dist/roles/definition.js';
import {
  executeTaskSubscriptionTool,
  matchWebhookSubscriptions,
  pruneEventSubscriptions,
  resumeExpiredEventSubscriptions,
  taskEventSubscriptionsDetail,
} from '../../../../dist/tasks/event-subscriptions.js';

// Exercise the real Manager dispatch loop for subscription fallback checks.
configureDispatch(null);

const gitObjHash = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

async function createSubscriptionFixture(t, modelHandler) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const putBlob = content => {
    const bytes = Buffer.from(content);
    const sha = gitObjHash('blob', bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const fileSha = putBlob('export const status = "ok";\n');
  const entries = [{ path: 'index.mjs', name: 'index.mjs', mode: '100644', type: 'blob', sha: fileSha, size: 28 }];
  const treeBuf = Buffer.concat([Buffer.from(`100644 index.mjs\0`), Buffer.from(fileSha, 'hex')]);
  const treeSha = gitObjHash('tree', treeBuf);
  trees.set(treeSha, entries);
  const headSha = gitObjHash('commit', Buffer.from(JSON.stringify({ treeSha })));
  commits.set(headSha, { sha: headSha, tree: { sha: treeSha }, parents: [] });

  const state = {
    headSha,
    handlerError: null,
    workflowRun: { id: 7001, status: 'in_progress', conclusion: null, html_url: 'https://github.invalid/101/actions/runs/7001' },
  };
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://github.fixture');
    const path = decodeURIComponent(url.pathname);
    const body = raw ? JSON.parse(raw) : {};
    const send = (val, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(val));
    };

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      try {
        const reply = await modelHandler(body);
        return send({
          id: 'chatcmpl-1168',
          choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 60, completion_tokens: 30, total_tokens: 90 },
        });
      } catch (err) {
        state.handlerError ??= err;
        return send({ error: { message: err.message } }, 400);
      }
    }
    if (path === '/app') return send({ id: 77, slug: 'dept-bot', name: 'dept-bot' });
    if (path === '/users/dept-bot[bot]') return send({ id: 9001, login: 'dept-bot[bot]', type: 'Bot' });
    if (path === '/repos/fixture/project-101/installation') {
      return send({
        id: 55,
        account: { id: 10, login: 'fixture' },
        permissions: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write', checks: 'read', statuses: 'read', metadata: 'read' },
        events: ['issues', 'pull_request', 'issue_comment', 'workflow_run', 'check_suite'],
      });
    }
    if (path === '/app/installations/55/access_tokens' && req.method === 'POST') {
      return send({
        token: 'ghs_fixture_' + Math.random().toString(36).slice(2, 10),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: body.permissions || { metadata: 'read' },
      }, 201);
    }
    if (path === '/installation/token' && req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }
    if (path === '/repositories/101') {
      return send({ id: 101, name: 'project-101', full_name: 'fixture/project-101', default_branch: 'main', owner: { id: 10, login: 'fixture' }, clone_url: '' });
    }
    if (path === '/repos/fixture/project-101/git/ref/heads/main') return send({ ref: 'refs/heads/main', object: { sha: headSha } });
    const commitMatch = /^\/repos\/fixture\/project-101\/git\/commits\/([a-f0-9]{40})$/.exec(path);
    if (commitMatch) return send(commits.get(commitMatch[1]));
    const treeMatch = /^\/repos\/fixture\/project-101\/git\/trees\/([a-f0-9]{40})$/.exec(path);
    if (treeMatch) return send({ sha: treeMatch[1], truncated: false, tree: trees.get(treeMatch[1]) });
    const blobMatch = /^\/repos\/fixture\/project-101\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (blobMatch) return send({ sha: blobMatch[1], encoding: 'base64', content: blobs.get(blobMatch[1]).toString('base64') });
    if (path === '/repos/fixture/project-101/actions/workflows/ci.yml/dispatches' && req.method === 'POST') {
      return send({ workflow_run_id: 7001, run_url: `http://127.0.0.1:${server.address().port}/repos/fixture/project-101/actions/runs/7001`, html_url: state.workflowRun.html_url });
    }
    if (path === '/repos/fixture/project-101/actions/runs/7001') {
      return send(state.workflowRun);
    }
    send({ message: 'Not Found: ' + path }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'sub-ws-'));
  const localManager = new LocalManager('101', workspaceRoot);
  await localManager.call('PUT', '/v1/projects/101');
  let engine;
  const h = await harness(undefined, localManager, store => ({
    engine: engine = new TaskEngine(store, localManager, apiUrl, undefined, acceptanceFixture),
  }));

  t.after(async () => {
    await engine.close();
    await localManager.recover();
    await h.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(h.directory, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const acc = await account(admin, { name: 'app-1168', type: 'github_app', app_id: '77', private_key: privateKey, token: undefined });
  const webhookSecret = acc.secret;
  const ep = acc.endpoints[0];
  await repository(admin, acc.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: apiUrl + '/v1', api_key: 'test-model-key', model_name: 'fixture-model' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id, task_concurrency: 1 });
  h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");
  saveConfiguration(
    h.store,
    '101',
    {
      expected_revision: roleConfiguration(h.store, '101').revision,
      enabled: true,
      roles: [
        { role_id: 'manager', harness_ref: { id: 'native' } },
        { role_id: 'test', harness_ref: { id: 'native' } },
      ],
    },
    'fixture',
  );
  engine.start();

  const operator = { id: 'administrator', role: 'super_admin', repositories: [] };
  const commands = new TaskCommands(h.store);
  const createTask = body => {
    const { id } = commands.api(operator, 'POST', new URL('http://local/api/tasks'), { repository_id: '101', ...body });
    authorizeKnowledgeTask(h.store, id);
    engine.tick();
    return id;
  };

  let seq = 0;
  const sendWebhook = async (event, payload) => {
    const raw = Buffer.from(JSON.stringify({ repository: { id: 101, full_name: 'fixture/project-101', owner: { id: 10 } }, ...payload }));
    const sig = 'sha256=' + createHmac('sha256', webhookSecret).update(raw).digest('hex');
    return ingest(
      h.store,
      acc.id,
      ep.id,
      { 'x-github-delivery': `deliv-1168-${++seq}`, 'x-github-event': event, 'x-hub-signature-256': sig },
      raw,
      true,
      apiUrl,
    );
  };

  const waitFor = async (predicate, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.handlerError) throw state.handlerError;
      const value = await predicate();
      if (value) return value;
      engine.tick();
      engine.dispatcher.tick();
      await new Promise(r => setTimeout(r, 40));
    }
    const snapshot = h.store.all('SELECT id,status,phase,error_code FROM tasks');
    const logs = h.store.all('SELECT task_id,content FROM task_logs ORDER BY rowid DESC LIMIT 10');
    const dispatchRows = h.store.all('SELECT * FROM dispatch_events');
    throw new Error(`Timed out waiting for condition; tasks=${JSON.stringify(snapshot)} logs=${JSON.stringify(logs)} dispatch=${JSON.stringify(dispatchRows)}`);
  };

  return { h, admin, engine, state, headSha, createTask, sendWebhook, waitFor };
}

test('task registers subscribe_event, releases execution slot so another task can run, and resumes on direct webhook match (#1168)', async t => {
  const promptsSeen = [];
  const f = await createSubscriptionFixture(t, async body => {
    const userMsg = body.messages.findLast(m => m.role === 'user')?.content || '';
    const parsed = (() => { try { return JSON.parse(userMsg); } catch { return {}; } })();
    promptsSeen.push(parsed);

    // Secondary task runs while Task A is parked in waiting_event
    if (String(parsed.request || '').includes('Secondary quick check')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_secondary_done',
          type: 'function',
          function: {
            name: 'submit_report',
            arguments: JSON.stringify({
              summary: 'Secondary task executed immediately because waiting_event freed the concurrency=1 slot.',
              artifacts: [],
              evidence: [{ source: 'index.mjs', result: 'ok' }],
            }),
          },
        }],
      };
    }

    // Primary task: on first attempt, subscribe_event and release slot; after wakeup, submit_report!
    if (!parsed.event_subscriptions?.wakeups?.length) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_sub_1',
          type: 'function',
          function: {
            name: 'subscribe_event',
            arguments: JSON.stringify({
              events: ['workflow_run'],
              run_id: 7001,
              workflow: 'ci.yml',
              head_sha: f.headSha.slice(0, 12),
              note: 'Wait for dispatched ci.yml run #7001 to finish.',
              timeout_seconds: 600,
            }),
          },
        }],
      };
    }

    const wakeup = parsed.event_subscriptions.wakeups.at(-1);
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_primary_done',
        type: 'function',
        function: {
          name: 'submit_report',
          arguments: JSON.stringify({
            summary: `Woken by ${wakeup.wake_reason}: conclusion=${wakeup.payload_excerpt?.conclusion}`,
            artifacts: [],
            evidence: [{ source: 'webhook', result: wakeup.summary }],
          }),
        },
      }],
    };
  });

  const taskA = f.createTask({
    request: 'Dispatch CI and wait for workflow_run 7001',
    executor_role: 'test',
    contract: { goal: 'Wait for workflow_run 7001', scope: ['index.mjs'], criteria: ['Report CI outcome'], endpoint: 'report' },
  });

  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskA)?.status === 'waiting_event');

  // Task Detail API exposes the active subscription with hints, note and timeout_at
  const detailBefore = (await f.admin(`/api/tasks/${taskA}`)).value;
  assert.equal(detailBefore.task.status, 'waiting_event');
  assert.equal(detailBefore.event_subscriptions.length, 1);
  assert.equal(detailBefore.event_subscriptions[0].state, 'active');
  assert.deepEqual(detailBefore.event_subscriptions[0].events, ['workflow_run']);
  assert.equal(detailBefore.event_subscriptions[0].hints.run_id, 7001);
  assert.match(detailBefore.event_subscriptions[0].note, /7001/);

  // Prove slot release: repository task_concurrency is 1, yet Task B runs and completes while Task A waits!
  const taskB = f.createTask({
    request: 'Secondary quick check while Task A waits',
    executor_role: 'test',
    contract: { goal: 'Secondary quick check', scope: ['index.mjs'], criteria: ['Done'], endpoint: 'report' },
  });
  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskB)?.status === 'completed');
  assert.equal(f.h.store.get('SELECT status FROM tasks WHERE id=?', taskA)?.status, 'waiting_event');

  // Non-terminal workflow_run.in_progress does NOT prematurely wake a completion subscription or queue Manager fallback
  const inProgressRes = await f.sendWebhook('workflow_run', {
    action: 'in_progress',
    sender: { id: 9001, login: 'dept-bot[bot]', type: 'Bot' },
    workflow_run: { id: 7001, name: 'CI', path: '.github/workflows/ci.yml', status: 'in_progress', conclusion: null, head_sha: f.headSha, head_branch: 'main' },
  });
  assert.equal(inProgressRes.response.subscriptions_matched, undefined);
  assert.equal(inProgressRes.response.subscription_fallback_queued, undefined);
  assert.equal(f.h.store.get('SELECT status FROM tasks WHERE id=?', taskA)?.status, 'waiting_event');

  // Bot-dispatched workflow_run.completed matches directly even when sender.type === 'Bot'
  const completedRes = await f.sendWebhook('workflow_run', {
    action: 'completed',
    sender: { id: 9001, login: 'dept-bot[bot]', type: 'Bot' },
    workflow_run: {
      id: 7001,
      name: 'CI',
      path: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
      head_sha: f.headSha,
      head_branch: 'main',
      html_url: 'https://github.invalid/101/actions/runs/7001',
    },
  });
  assert.equal(completedRes.response.subscriptions_matched, 1);

  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskA)?.status === 'completed');
  const finalResult = JSON.parse(f.h.store.get('SELECT result FROM tasks WHERE id=?', taskA).result);
  assert.match(finalResult.summary, /Woken by webhook_matched: conclusion=success/);

  const subsAfter = taskEventSubscriptionsDetail(f.h.store, taskA);
  assert.equal(subsAfter[0].state, 'matched');
  assert.equal(subsAfter[0].wake_reason, 'webhook_matched');
});

test('when webhook misses filter hints on a repository with active subscriptions, Manager AI fallback queries subscriptions and continues the task (#1168)', async t => {
  let managerQueriedSubscriptions = false;
  const f = await createSubscriptionFixture(t, async body => {
    const sys = body.messages[0]?.content || '';
    const lastMsg = body.messages.at(-1);

    // Manager dispatch turn
    if (sys.includes('# Project Manager prompt')) {
      if (lastMsg.role === 'user') {
        const payload = JSON.parse(lastMsg.content);
        assert.equal(payload.pending_subscriptions?.length, 1);
        const waitingTaskId = payload.pending_subscriptions[0].task_id;
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'mgr_list_subs',
            type: 'function',
            function: { name: 'list_event_subscriptions', arguments: JSON.stringify({ state: 'active', task_id: waitingTaskId }) },
          }],
        };
      }
      if (lastMsg.role === 'tool') {
        const listed = JSON.parse(lastMsg.content);
        managerQueriedSubscriptions = listed.subscriptions?.length === 1;
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'mgr_continue',
            type: 'function',
            function: {
              name: 'continue_task',
              arguments: JSON.stringify({
                task_id: listed.subscriptions[0].task_id,
                reason: 'Webhook workflow Nightly E2E corresponds to the task waiting on loosely-named nightly hint.',
              }),
            },
          }],
        };
      }
    }

    // Worker task turn
    const parsed = JSON.parse(body.messages.findLast(m => m.role === 'user').content);
    if (!parsed.event_subscriptions?.wakeups?.length) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'sub_imprecise',
          type: 'function',
          function: {
            name: 'subscribe_event',
            arguments: JSON.stringify({
              events: ['workflow_run'],
              workflow: 'imprecise-nightly-hint',
              note: 'Waiting for nightly E2E workflow on main.',
              timeout_seconds: 600,
            }),
          },
        }],
      };
    }

    const wakeup = parsed.event_subscriptions.wakeups.at(-1);
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'done_after_mgr',
        type: 'function',
        function: {
          name: 'submit_report',
          arguments: JSON.stringify({
            summary: `Resumed via ${wakeup.wake_reason}`,
            artifacts: [],
            evidence: [{ source: 'manager', result: wakeup.summary }],
          }),
        },
      }],
    };
  });

  const taskId = f.createTask({
    request: 'Wait for nightly workflow with imprecise name hint',
    executor_role: 'test',
    contract: { goal: 'Verify nightly', scope: ['index.mjs'], criteria: ['Verify'], endpoint: 'report' },
  });

  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status === 'waiting_event');

  // Webhook arrives with workflow name "Nightly E2E" (.github/workflows/e2e.yml) — misses 'imprecise-nightly-hint'!
  const res = await f.sendWebhook('workflow_run', {
    action: 'completed',
    workflow_run: {
      id: 8802,
      name: 'Nightly E2E',
      path: '.github/workflows/e2e.yml',
      status: 'completed',
      conclusion: 'failure',
      head_sha: f.headSha,
      head_branch: 'main',
    },
  });
  assert.equal(res.response.subscriptions_matched, undefined);
  assert.equal(res.response.subscription_fallback_queued, 1);

  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status === 'completed');
  assert.equal(managerQueriedSubscriptions, true);
  const result = JSON.parse(f.h.store.get('SELECT result FROM tasks WHERE id=?', taskId).result);
  assert.equal(result.summary, 'Resumed via manager_assigned');
  const sub = taskEventSubscriptionsDetail(f.h.store, taskId)[0];
  assert.equal(sub.state, 'matched');
  assert.equal(sub.wake_reason, 'manager_assigned');
});

test('expired timeout_at wakes waiting task with wake_reason="timeout" so agent inspects real GitHub state (#1168)', async t => {
  let checkedGithubAfterTimeout = false;
  const f = await createSubscriptionFixture(t, async body => {
    const readRunReply = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'read_run_state');
    const parsed = JSON.parse(body.messages.findLast(m => m.role === 'user').content);

    if (!parsed.event_subscriptions?.wakeups?.length) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'sub_timeout',
          type: 'function',
          function: {
            name: 'subscribe_event',
            arguments: JSON.stringify({
              events: ['workflow_run'],
              run_id: 7001,
              note: 'Wait for run 7001 or inspect on timeout',
              timeout_seconds: 60,
            }),
          },
        }],
      };
    }

    assert.equal(parsed.event_subscriptions.wakeups.at(-1).wake_reason, 'timeout');
    assert.match(parsed.event_subscriptions.instruction, /timed out/i);

    if (!readRunReply) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'read_run_state',
          type: 'function',
          function: { name: 'github_read', arguments: JSON.stringify({ path: '/actions/runs/7001' }) },
        }],
      };
    }

    const runState = JSON.parse(readRunReply.content);
    checkedGithubAfterTimeout = runState.conclusion === 'success';
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'done_timeout',
        type: 'function',
        function: {
          name: 'submit_report',
          arguments: JSON.stringify({
            summary: `Timeout fallback checked GitHub directly: run ${runState.id} ${runState.conclusion}`,
            artifacts: [],
            evidence: [{ source: '/actions/runs/7001', result: runState.conclusion }],
          }),
        },
      }],
    };
  });

  const taskId = f.createTask({
    request: 'Wait for run 7001 with timeout fallback',
    executor_role: 'test',
    contract: { goal: 'Check run 7001', scope: ['index.mjs'], criteria: ['Check'], endpoint: 'report' },
  });

  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status === 'waiting_event');

  // Simulate missed webhook: run finished on GitHub, and subscription timeout_at elapsed
  f.state.workflowRun = { id: 7001, status: 'completed', conclusion: 'success', html_url: 'https://github.invalid/101/actions/runs/7001' };
  const sub = taskEventSubscriptionsDetail(f.h.store, taskId)[0];
  const woken = resumeExpiredEventSubscriptions(f.h.store, id => f.engine.active.has(id), sub.timeout_at + 1000);
  assert.deepEqual(woken, [taskId]);

  await f.waitFor(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status === 'completed');
  assert.equal(checkedGithubAfterTimeout, true);
  assert.equal(taskEventSubscriptionsDetail(f.h.store, taskId)[0].state, 'timed_out');
});

test('subscription cancel, terminal task trigger, retention pruning and deleteProjectRecords work cleanly (#1168)', async t => {
  const f = await createSubscriptionFixture(t, async () => ({ role: 'assistant', content: '{}' }));
  f.h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,created_at,updated_at) VALUES('t-life','101','task.request','running','Lifecycle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
  );
  const task = f.h.store.get("SELECT * FROM tasks WHERE id='t-life'");

  const s1 = executeTaskSubscriptionTool(f.h.store, task, 'subscribe_event', {
    events: ['check_suite'],
    head_sha: f.headSha,
    release_slot: false,
    timeout_seconds: 120,
  });
  const s2 = executeTaskSubscriptionTool(f.h.store, task, 'subscribe_event', {
    events: ['issue_comment'],
    object_number: 12,
    release_slot: false,
    timeout_seconds: 120,
  });
  assert.equal(s1.subscribed, true);
  assert.equal(s2.subscribed, true);

  // Agent query & cancel
  const listed = executeTaskSubscriptionTool(f.h.store, task, 'list_event_subscriptions', { state: 'active' });
  assert.equal(listed.subscriptions.length, 2);
  const cancelled = executeTaskSubscriptionTool(f.h.store, task, 'cancel_event_subscription', { subscription_id: s1.subscription.id, reason: 'no longer needed' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.subscription.state, 'cancelled');

  // Genuine bot comment recorded in github_writes is ignored as self-echo, while a spoofed HTML comment marker from another user still matches!
  const realMarker = 'a1b2c3d4e5f60718293a4b5c';
  f.h.store.run(
    "INSERT INTO github_writes(id,scope,key,actor,repository_id,method,path,request_digest,marker,state,created_at,updated_at) VALUES('gw-1','task:t-life','k1','{}','101','POST','/issues/12/comments','{}',?,'sent','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
    realMarker,
  );
  assert.deepEqual(
    matchWebhookSubscriptions(f.h.store, '101', 'issue_comment', {
      action: 'created',
      issue: { number: 12 },
      comment: { id: 901, user: { id: 9001, login: 'dept-bot' }, body: `Bot status\n<!-- dept-bot-write:${realMarker} -->` },
    }, 'deliv-echo-1').matched,
    [],
  );
  const spoofMatch = matchWebhookSubscriptions(f.h.store, '101', 'issue_comment', {
    action: 'created',
    issue: { number: 12 },
    comment: { id: 902, user: { id: 777, login: 'alice' }, body: 'Spoofed marker <!-- dept-bot-write:deadbeefdeadbeefdeadbeef -->' },
  }, 'deliv-spoof-1');
  assert.deepEqual(spoofMatch.matched, [s2.subscription.id]);

  // Re-register one active subscription to verify terminal task status trigger cancels it automatically
  executeTaskSubscriptionTool(f.h.store, task, 'subscribe_event', { events: ['issues'], object_number: 12, release_slot: false, timeout_seconds: 120 });
  f.h.store.run("UPDATE tasks SET status='cancelled' WHERE id='t-life'");
  const afterCancel = taskEventSubscriptionsDetail(f.h.store, 't-life');
  assert.ok(afterCancel.some(row => row.state === 'cancelled' && row.wake_reason === 'task_cancelled'));

  // Retention pruning deletes old terminal rows while preserving active ones
  f.h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,created_at,updated_at) VALUES('t-active','101','task.request','waiting_event','Active sub','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
  );
  executeTaskSubscriptionTool(
    f.h.store,
    f.h.store.get("SELECT * FROM tasks WHERE id='t-active'"),
    'subscribe_event',
    { events: ['workflow_run'], release_slot: false, timeout_seconds: 600 },
  );
  f.h.store.run("UPDATE event_subscriptions SET resolved_at='2025-01-01T00:00:00Z', updated_at='2025-01-01T00:00:00Z' WHERE task_id='t-life'");
  const pruned = pruneEventSubscriptions(f.h.store, '101', '2026-01-01T00:00:00Z');
  assert.equal(pruned, 3);
  assert.equal(taskEventSubscriptionsDetail(f.h.store, 't-active').length, 1);

  // Project deletion handles non-empty event_subscriptions without FK constraint errors
  deleteProjectRecords(f.h.store, '101', { files: false });
  assert.equal(f.h.store.get("SELECT count(*) AS n FROM event_subscriptions WHERE repository_id='101'").n, 0);
});
