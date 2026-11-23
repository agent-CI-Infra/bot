// #1040: a role instance's Pi session is bound explicitly (session and file in harness_state), kept in a task directory of
// its own, and opened again by the next run; a session over the limit is not reopened, and a fault carries the runner's
// reason. The runner mailbox is answered in process: test/st/src/roles/pi-controller.test.mjs drives the real Pi SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor, TaskError } from '../../../../dist/agent/common.js';
import { roleHarness } from '../../../../dist/roles/harness.js';
import { persistentCliStateWorkspaceId } from '../../../../dist/harness/container-session.js';

const hex48 = () => randomBytes(24).toString('hex');
const runAccess = () => { const token = 'rrt_' + randomBytes(16).toString('hex'); return { token, check(presented) { if (presented !== token) throw new TaskError('run_token_invalid', 'failed'); } }; };

// One Pi role run whose runner reports `events` and then `final` (a runner state). Returns what the control plane sent and
// recorded.
async function run(t, { binding = {}, events = [], final }) {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}','now')"); store.run("INSERT INTO repositories VALUES('101','fixture/pi','o','a')");
  const workspace_id = hex48();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t1','101','review.issue','running','review','{}',1,1,?)", workspace_id);
  store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role_instance_id,role,recovery_mode) VALUES('run-1','t1','role',1,1,'now','running','{}','{}','inst-1','dev','rebuilt_from_task_records')");
  const task = { ...store.get("SELECT * FROM tasks WHERE id='t1'"), trace_run_id: 'run-1' };
  const saved = [], logs = [], config = [];
  let polled = false;
  const poll = () => { if (polled) return final; polled = true; return { state: 'running', events, offset: events.length }; };
  const workspace = { task, log: event => logs.push(event), async deliver(request) {
    if (request.type === 'workspace_agent_poll') return poll();
    return {};
  }, async call(_key, request) {
    if (request.type === 'workspace_agent_config') { config.push(Buffer.from(request.base64, 'base64')); return { written: true }; }
    if (request.type === 'workspace_agent_start') return { started: true };
    if (request.type === 'workspace_agent_poll') return poll();
    return {};
  } };
  const spec = { store, task, redactor: new Redactor(), guard: async () => {}, runAccess: runAccess(), system: 's', prompt: 'p', tools: [],
    roleRun: { instance_id: 'inst-1', role: 'dev', version: '1', harness: 'pi', recovery_mode: 'rebuilt_from_task_records' },
    harnessAccess: { workspace: 'read', fileTools: 'read', commands: false, network: false, github: { repository: null, scopes: [] } },
    harnessState: { value: binding, save: value => saved.push(value) }, containerOptions: { modelTransport: 'gateway' }, pi: { workspace } };
  const outcome = await roleHarness('pi').adapter(spec)({ guard: async () => {}, model: { id: 'm', model: 'test' }, request: async () => ({ value: {} }) }).then(value => ({ value }), error => ({ error }));
  return { store, outcome, saved, logs, config: JSON.parse(Buffer.concat(config).toString('utf8')), workspace_id };
}
const bound = (id, file, recoveryMode) => ({ type: 'session_bound', session_id: id, transcript: file, recoveryMode, messages: 0 });

test('a Pi role run opens its bound session from the instance\'s own task directory and records that it resumed', async t => {
  const store = persistentCliStateWorkspaceId('inst-1'), file = `/workspace/tasks/${store}/cli-state/pi/inst-1/sessions/2026_s1.jsonl`;
  const r = await run(t, { binding: { harness: 'pi', sessionId: 's1', transcript: file }, events: [bound('s1', file, 'native_resume')], final: { state: 'completed', result: { submitted: true }, offset: 1 } });
  // The runner is told which session to open and where the instance's sessions live, whatever workspace it runs in.
  assert.deepEqual(r.config.native_session, { id: 's1', file }); assert.equal(r.config.session_store, store); assert.equal(r.config.session_key, 'inst-1');
  assert.notEqual(r.config.session_store, r.workspace_id);
  // The session directory is the task's: workspace cleanup keeps it as long as the task's other directories.
  assert.ok(r.store.get("SELECT 1 FROM task_workspaces WHERE task_id='t1' AND workspace_id=?", store));
  // The binding is saved again with the session the runner opened, and the run records native_resume.
  assert.deepEqual(r.saved.at(-1), { harness: 'pi', sessionId: 's1', transcript: file, recoveryMode: 'native_resume', workspaceId: r.workspace_id, stateWorkspaceId: store });
  assert.equal(r.store.get("SELECT recovery_mode FROM task_runs WHERE id='run-1'").recovery_mode, 'native_resume');
});

test('a run without a binding starts a new session and binds it; a run whose session file is gone records the rebuild', async t => {
  const first = await run(t, { events: [bound('s2', '/x/s2.jsonl', 'new_session')], final: { state: 'completed', result: { submitted: true }, offset: 1 } });
  assert.equal(first.config.native_session, undefined);
  assert.equal(first.saved.at(-1).sessionId, 's2');
  // A new session keeps the start mode the run was prepared with (here a later run of the instance: rebuilt).
  assert.equal(first.store.get("SELECT recovery_mode FROM task_runs WHERE id='run-1'").recovery_mode, 'rebuilt_from_task_records');
  const gone = await run(t, { binding: { harness: 'pi', sessionId: 's1', transcript: '/x/s1.jsonl' }, events: [bound('s3', '/x/s3.jsonl', 'rebuilt_from_task_records')], final: { state: 'completed', result: { submitted: true }, offset: 1 } });
  assert.deepEqual([gone.saved.at(-1).sessionId, gone.saved.at(-1).recoveryMode], ['s3', 'rebuilt_from_task_records']);
  // Another backend's state on the instance is no Pi binding.
  const other = await run(t, { binding: { sessionId: 'thread-1' }, final: { state: 'completed', result: { submitted: true }, offset: 0 } });
  assert.equal(other.config.native_session, undefined);
});

test('a session over the limit after Pi\'s own recovery fails with the runner\'s reason and is not reopened', async t => {
  const detail = 'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.';
  const r = await run(t, { binding: { harness: 'pi', sessionId: 's1', transcript: '/x/s1.jsonl' }, events: [bound('s1', '/x/s1.jsonl', 'native_resume')],
    final: { state: 'failed', error: 'agent_context_too_large', detail, offset: 1 } });
  assert.ok(r.outcome.error instanceof TaskError);
  assert.deepEqual([r.outcome.error.code, r.outcome.error.state], ['agent_context_too_large', 'failed']);
  assert.match(r.outcome.error.detail, /Context overflow recovery failed after one compact-and-retry attempt/);
  // The runner's own reason is in the task log too, before the stop.
  assert.deepEqual(r.logs.find(event => event.type === 'agent_failure'), { type: 'agent_failure', error: 'agent_context_too_large', detail });
  // The binding saved when the session started is dropped, so a retry starts a new session from task records.
  assert.equal(r.saved.at(-2).sessionId, 's1'); assert.deepEqual(r.saved.at(-1), {});
});

test('a failed compaction keeps its own reason and the session, and is retried', async t => {
  const detail = 'Context overflow recovery failed: 503 temporarily unavailable';
  const r = await run(t, { binding: { harness: 'pi', sessionId: 's1', transcript: '/x/s1.jsonl' }, events: [bound('s1', '/x/s1.jsonl', 'native_resume')],
    final: { state: 'failed', error: 'agent_compaction_failed', detail, offset: 1 } });
  assert.deepEqual([r.outcome.error.code, r.outcome.error.state], ['agent_compaction_failed', 'retry_wait']);
  assert.match(r.outcome.error.detail, /503 temporarily unavailable/);
  assert.deepEqual(r.saved.map(value => value.sessionId), ['s1'], 'the binding stays for the retry');
});
