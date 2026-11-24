import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { OwnTasks } from '../../../../dist/service-roles/own-tasks.js';

// #532: an own task is visible to the conversation that started it. The first page is a page, not the whole set: a task
// older than the newest twenty is still listed by offset, and can be read by the id its host already holds.
test('own tasks past the first page stay listed by offset and readable by id (#532)', async t => {
  const s = new Store(':memory:', Buffer.alloc(32, 2)); t.after(() => s.close());
  const tasks = new OwnTasks(s);
  const owner = { service_role_id: 'repository-assistant', kind: 'channel', owner_id: 'chat-a', principal_id: 'binding-a', fence: 'v1' };
  const host = { owner, system: 'Scope', tools: () => [], check() {}, redact: v => v, execute() { throw Error('Unexpected tool'); },
    run: async () => 'done' };
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await tasks.invoke('start_own_task', { title: `own ${i}`, instruction: `do ${i}` }, host)).task_id);

  const first = await tasks.invoke('list_own_tasks', {}, host);
  assert.equal(first.total, 21);
  assert.equal(first.own_tasks.length, 20);
  assert.equal(first.next_offset, 20);
  assert.equal(first.own_tasks.some(row => row.task_id === ids[0]), false);

  const second = await tasks.invoke('list_own_tasks', { offset: 20 }, host);
  assert.deepEqual(second.own_tasks.map(row => row.task_id), [ids[0]]);
  assert.equal(second.next_offset, null);

  assert.equal((await tasks.invoke('read_own_task', { task_id: ids[0] }, host)).history[0].conclusion, 'done');
});

// #532: 8,000 characters is not a conclusion boundary. An own task's whole answer reaches the host and stays readable;
// only the list preview keeps its display size.
test('an own-task conclusion longer than 8,000 characters is returned and kept whole (#532)', async t => {
  const s = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => s.close());
  const tasks = new OwnTasks(s);
  const owner = { service_role_id: 'repository-assistant', kind: 'channel', owner_id: 'chat-long', principal_id: 'binding-long', fence: 'v1' };
  const long = '结'.repeat(9000);
  const host = { owner, system: 'Scope', tools: () => [], check() {}, redact: v => v, execute() { throw Error('Unexpected tool'); },
    run: async () => long };
  const started = await tasks.invoke('start_own_task', { title: 'long answer', instruction: 'answer at length' }, host);
  assert.equal(started.conclusion.length, 9000);
  const read = await tasks.invoke('read_own_task', { task_id: started.task_id }, host);
  assert.equal(read.history[0].conclusion.length, 9000);
  assert.equal(read.history[0].conclusion, long);
  const listed = await tasks.invoke('list_own_tasks', {}, host);
  assert.equal(listed.own_tasks[0].last_conclusion.length, 2000);
});
