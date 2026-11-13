import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { AssistantComputerService, ownerId } from '../dist/service-roles/assistant-computers.js';
import { assistantManager } from './assistant-computer-fixture.mjs';

const gib = 1024 ** 3;
async function fixture(t) {
  const m = await assistantManager(t), store = new Store(':memory:', Buffer.alloc(32, 7)); t.after(() => store.close());
  const service = new AssistantComputerService(store, m.manager, m.homes);
  let fence = 'a'.repeat(64);
  const notices = [];
  const turn = (id, extra = {}) => service.turn({ owner: { kind: 'group', subject: 'chat-a', tenant: 't' }, turn: id, fence: () => fence, check: () => {},
    facts: () => ({ binding: 'binding-1', role: 'role-1', repositories: ['101', '102'] }), commands: () => true, eligible: () => {}, notify: text => notices.push(text), ...extra });
  return { ...m, store, service, turn, notices, setFence: value => { fence = value; }, owner: ownerId({ kind: 'group', subject: 'chat-a', tenant: 't' }) };
}
const created = f => f.docker.created || 0;

test('HOME is served without a computer when a turn may not run commands, and a symlink never leads out of it', async t => {
  const f = await fixture(t), turn = f.turn('turn-1', { commands: () => false });
  assert.deepEqual(await turn.execute('write_file', { path: '~/notes/a.txt', content: '群里的数据' }), { path: '~/notes/a.txt', written: true });
  assert.equal((await turn.execute('read_file', { path: '/home/assistant/notes/a.txt' })).content, '群里的数据');
  assert.equal(created(f), 0, 'file access alone starts no computer');
  const home = join(f.homes, f.owner, 'home-1');
  assert.equal(readFileSync(join(home, 'notes/a.txt'), 'utf8'), '群里的数据');
  await assert.rejects(turn.execute('read_file', { path: '/tmp/x' }), { code: 'assistant_computer_requires_commands' });
  await assert.rejects(turn.execute('run_command', { command: 'true' }), { code: 'assistant_computer_requires_commands' });
  // Another owner's data, reached through a symlink a command could have left in this HOME, or through '..'.
  const other = join(f.homes, 'b'.repeat(32), 'home-1'); mkdirSync(other, { recursive: true }); writeFileSync(join(other, 'secret.txt'), 'other group');
  symlinkSync(join(other, 'secret.txt'), join(home, 'link.txt')); symlinkSync(other, join(home, 'dir'));
  for (const path of ['~/link.txt', '~/dir/secret.txt', '~/../../' + 'b'.repeat(32) + '/home-1/secret.txt'])
    await assert.rejects(turn.execute('read_file', { path }), { code: 'invalid_path' }, path);
  for (const path of ['~/dir/secret.txt', '~/dir/new.txt', '~/link.txt'])
    await assert.rejects(turn.execute('write_file', { path, content: 'overwritten' }), { code: 'invalid_path' }, path);
  assert.equal(readFileSync(join(other, 'secret.txt'), 'utf8'), 'other group');
  assert.ok(!existsSync(join(other, 'new.txt')));
  // Deleting the link removes the link only.
  assert.deepEqual(await turn.execute('delete_file', { path: '~/dir' }), { path: '~/dir', deleted: true, directory: false });
  assert.ok(existsSync(join(other, 'secret.txt')));
  await turn.close();
  assert.equal(created(f), 0);
});

test('commands run on the owner\'s computer, created at first use and reused by the next turn; a changed fence removes it', async t => {
  const f = await fixture(t), first = f.turn('turn-1');
  await first.execute('write_file', { path: '~/keep.txt', content: 'kept' });
  assert.equal(created(f), 0);
  const ran = await first.execute('run_command', { command: 'cat ~/keep.txt; echo temp > scratch.txt' });
  assert.deepEqual([ran.exit_code, ran.output], [0, 'kept']);
  assert.equal((await first.execute('write_file', { path: '/tmp/work.txt', content: 'tmp data' })).written, true);
  assert.equal((await first.execute('read_file', { path: 'scratch.txt' })).content, 'temp\n');
  assert.equal(created(f), 1);
  assert.equal(f.computers.leases.get(f.owner).state, 'busy');
  await first.close();
  assert.equal(f.computers.leases.get(f.owner).state, 'idle', 'the turn ended: idle, not removed');
  // The next turn within the idle time reuses it and sees the earlier /tmp.
  const second = f.turn('turn-2');
  assert.equal((await second.execute('read_file', { path: '/tmp/work.txt' })).content, 'tmp data');
  assert.equal(created(f), 1);
  // A turn that ends because what the group may see changed removes the computer at once; HOME stays.
  f.setFence('b'.repeat(64)); await second.close(true);
  await Promise.all([...f.computers.removing.values()]);
  assert.ok(!f.computers.leases.has(f.owner));
  const third = f.turn('turn-3');
  assert.equal((await third.execute('read_file', { path: '~/keep.txt' })).content, 'kept');
  assert.equal((await third.execute('read_file', { path: '/tmp/work.txt' })).error, 'file_not_found');
  assert.equal(created(f), 2);
  await third.close();
});

test('HOME generations: a narrower scope, another binding or role seals the old one; members and a wider scope keep it', async t => {
  const f = await fixture(t);
  let facts = { binding: 'binding-1', role: 'role-1', repositories: ['101', '102'] };
  const use = async (id, change) => { if (change) facts = { ...facts, ...change }; const turn = f.turn(id, { facts: () => facts }); await turn.execute('write_file', { path: `~/${id}.txt`, content: id }); await turn.close(); return f.store.get('SELECT * FROM assistant_homes WHERE owner=?', f.owner); };
  assert.equal((await use('t1')).generation, 1);
  assert.equal((await use('t2', { repositories: ['101', '102', '103'] })).generation, 1, 'a wider scope keeps the HOME');
  f.setFence('c'.repeat(64));
  assert.equal((await use('t3')).generation, 1, 'a changed fence (for example a new member) keeps the HOME');
  assert.equal((await use('t4', { repositories: ['101', '102'] })).generation, 2, 'a narrower scope starts a new generation');
  assert.equal((await use('t5', { role: 'role-2' })).generation, 3);
  assert.equal((await use('t6', { binding: 'binding-2' })).generation, 4);
  assert.deepEqual(f.store.all('SELECT generation,reason FROM assistant_home_sealed WHERE owner=? ORDER BY generation', f.owner).map(r => ({ ...r })),
    [{ generation: 1, reason: 'scope_narrowed' }, { generation: 2, reason: 'service_role_changed' }, { generation: 3, reason: 'binding_changed' }]);
  // Only the current generation is visible (and mounted): earlier data stays sealed until retention removes it.
  const turn = f.turn('t7', { facts: () => facts });
  await assert.rejects(turn.execute('read_file', { path: '~/t1.txt' }), { code: 'file_not_found' });
  assert.equal((await turn.execute('read_file', { path: '~/t6.txt' })).content, 't6');
  await turn.execute('run_command', { command: 'true' });
  assert.equal(f.docker.containers.get(f.computers.name(f.owner)).HostConfig.Mounts[0].VolumeOptions.Subpath, `${f.owner}/home-4`);
  assert.ok(existsSync(join(f.homes, f.owner, 'home-1', 't1.txt')));
  await turn.close();
});

test('the soft limit mounts an over-limit HOME read-only for the next turn; deleting brings it back', async t => {
  const f = await fixture(t), first = f.turn('turn-1');
  await first.execute('write_file', { path: '~/big.bin', content: 'x' });
  await first.execute('run_command', { command: 'true' });
  // Measured after the turn: pretend the HOME holds 6 GB.
  const usage = f.service.homes.usage.bind(f.service.homes); f.service.homes.usage = async () => ({ bytes: 6 * gib, files: 1, complete: true });
  await first.close(); await f.service.homes.measure(f.owner);
  assert.equal(f.store.get('SELECT over_limit FROM assistant_homes WHERE owner=?', f.owner).over_limit, 1);
  const second = f.turn('turn-2');
  const read = await second.execute('read_file', { path: '~/big.bin' });
  assert.deepEqual([read.content, read.home_read_only], ['x', true]);
  await assert.rejects(second.execute('write_file', { path: '~/more.txt', content: 'y' }), { code: 'assistant_home_read_only' });
  // The idle read-write computer is replaced by one that mounts HOME read-only.
  assert.equal((await second.execute('run_command', { command: 'true' })).home_read_only, true);
  assert.equal(f.docker.containers.get(f.computers.name(f.owner)).HostConfig.Mounts[0].ReadOnly, true);
  // A read-only HOME cannot change under the control plane, so it deletes directly.
  assert.equal((await second.execute('delete_file', { path: '~/big.bin' })).deleted, true);
  f.service.homes.usage = usage; await second.close(); await f.service.homes.measure(f.owner);
  const third = f.turn('turn-3');
  assert.equal((await third.execute('write_file', { path: '~/more.txt', content: 'z' })).written, true);
  await third.close();
});

test('the first sweep after a start does not end a turn whose computer is still being created', async t => {
  const f = await fixture(t), request = f.docker.request;
  // The container create waits until the sweep's reconcile has removed the lease being created.
  let created, creating = new Promise(resolve => { created = resolve; }), reached;
  const atCreate = new Promise(resolve => { reached = resolve; });
  f.docker.request = async (method, path, body) => {
    if (method === 'POST' && path.startsWith('/containers/create') && created) { reached(); await creating; }
    return request(method, path, body);
  };
  const turn = f.turn('turn-1'), ran = turn.execute('run_command', { command: 'echo ok' });
  await atCreate;
  // The turn is not among the turns the control plane holds yet, so the reconcile removes its lease.
  await f.service.sweep();
  const release = created; created = null; release();
  const result = await ran;
  assert.deepEqual([result.exit_code, result.output], [0, 'ok\n'], JSON.stringify(result));
  assert.equal(f.computers.leases.get(f.owner)?.state, 'busy');
  await turn.close();
  // It is taken again once only: a turn whose computer is removed again while being created (here by a direct removal,
  // as a console clear or retention does) ends instead of trying forever.
  await f.service.remove(f.owner); await Promise.all([...f.computers.removing.values()]);
  let creates = 0;
  f.docker.request = async (method, path, body) => {
    if (method === 'POST' && path.startsWith('/containers/create')) { creates++; await f.service.remove(f.owner); }
    return request(method, path, body);
  };
  await assert.rejects(f.turn('turn-2').execute('run_command', { command: 'echo again' }), { code: 'assistant_computer_released' });
  assert.equal(creates, 2);
});

test('retention removes inactive HOMEs and sealed generations; the sweep removes computers whose fence changed', async t => {
  const f = await fixture(t), day = 86400_000;
  // The first sweep after a start reconciles: no computer of an earlier control plane survives it.
  await f.service.sweep();
  const turn = f.turn('turn-1');
  await turn.execute('run_command', { command: 'echo data > ~/a.txt' }); await turn.close();
  f.service.resolve('group', () => 'a'.repeat(64));
  await f.service.sweep();
  assert.ok(f.computers.leases.has(f.owner), 'an unchanged fence keeps the computer');
  f.service.resolve('group', () => 'd'.repeat(64));
  await f.service.sweep(); await Promise.all([...f.computers.removing.values()]);
  assert.ok(!f.computers.leases.has(f.owner), 'a changed fence removes it');
  // 31 days without a turn: the HOME goes.
  f.store.run('UPDATE assistant_homes SET active_at=?', Date.now() - 31 * day);
  f.store.run("INSERT INTO assistant_home_sealed VALUES(?,7,?,'scope_narrowed',10)", f.owner, Date.now() - 31 * day);
  mkdirSync(join(f.homes, f.owner, 'home-7'));
  await f.service.retain();
  assert.ok(!existsSync(join(f.homes, f.owner)));
  assert.equal(f.store.get('SELECT count(*) n FROM assistant_homes').n, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM assistant_home_sealed').n, 0);
});

test('a full capacity queues the turn and tells the conversation once; a failed creation is an error, never a fallback', async t => {
  const f = await fixture(t);
  await f.service.saveSettings({ max_containers: 1 });
  const other = f.service.turn({ owner: { kind: 'person', subject: 'principal-1', tenant: '' }, turn: 'person-turn', fence: () => 'e'.repeat(64), check: () => {},
    facts: () => ({ repositories: ['101'] }), commands: () => true, eligible: () => {} });
  await other.execute('run_command', { command: 'true' });
  const waiting = f.turn('group-turn').execute('run_command', { command: 'echo after' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(f.notices, ['助手电脑繁忙，正在排队（第 1 位），轮到后继续。']);
  await other.close();
  assert.equal((await waiting).output, 'after\n');
  assert.equal(f.notices.length, 1);
  // Docker refuses to create the computer: the tool says so, nothing runs elsewhere.
  f.docker.failCreate = true;
  const failing = f.service.turn({ owner: { kind: 'person', subject: 'principal-2', tenant: '' }, turn: 'failing', fence: () => 'f'.repeat(64), check: () => {},
    facts: () => ({ repositories: [] }), commands: () => true, eligible: () => {} });
  await f.service.saveSettings({ max_containers: 5 });
  await assert.rejects(failing.execute('run_command', { command: 'true' }), { code: 'assistant_computer_unavailable' });
  // Without the right to use a computer nothing is prepared.
  const refused = f.turn('refused', { eligible: () => { throw Object.assign(new Error('capability_forbidden'), { code: 'capability_forbidden' }); } });
  await assert.rejects(refused.execute('write_file', { path: '~/x', content: 'x' }), { code: 'capability_forbidden' });
});

test('a person\'s private chat and console turns share one HOME; another person or a group never sees it', async t => {
  const f = await fixture(t);
  const person = (subject, id) => f.service.turn({ owner: { kind: 'person', subject, tenant: '' }, turn: id, fence: () => 'e'.repeat(64), check: () => {},
    facts: () => ({ repositories: ['101'] }), commands: () => true, eligible: () => {} });
  const feishu = person('alice', 'feishu-turn'); await feishu.execute('write_file', { path: '~/plan.md', content: 'alice' }); await feishu.close();
  const console_ = person('alice', 'console-turn');
  assert.equal((await console_.execute('read_file', { path: '~/plan.md' })).content, 'alice'); await console_.close();
  const bob = person('bob', 'bob-turn');
  await assert.rejects(bob.execute('read_file', { path: '~/plan.md' }), { code: 'file_not_found' }); await bob.close();
  const group = f.turn('group-turn');
  await assert.rejects(group.execute('read_file', { path: '~/plan.md' }), { code: 'file_not_found' }); await group.close();
  assert.equal(new Set(f.store.all('SELECT owner FROM assistant_homes').map(r => r.owner)).size, 3);
});

test('a HOME cleared under a running turn turns its file calls into observations, not failures of the turn', async t => {
  const f = await fixture(t), turn = f.turn('turn-1', { commands: () => false });
  await turn.execute('write_file', { path: '~/a/b.txt', content: 'x' });
  await f.service.clear(f.owner);
  await assert.rejects(turn.execute('write_file', { path: '~/a/c.txt', content: 'y' }), error => error.status === 400 && error.code === 'file_not_writable');
  await assert.rejects(turn.execute('read_file', { path: '~/a/b.txt' }), error => error.status === 400 && error.code === 'file_not_found');
  await turn.close();
  // The next turn prepares the HOME again, empty.
  const next = f.turn('turn-2', { commands: () => false });
  assert.equal((await next.execute('write_file', { path: '~/again.txt', content: 'z' })).written, true);
  await next.close();
});

test('shutdown cancels startup maintenance and waits for an already running retention pass', async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const service=new AssistantComputerService({});service.available=()=>true;
  let sweeps=0,retentions=0,finish;
  service.sweep=async()=>{sweeps++;};
  service.retain=async()=>{retentions++;await new Promise(resolve=>{finish=resolve;});};
  service.start();t.mock.timers.tick(1000);
  assert.equal(sweeps,1);assert.equal(retentions,1);
  let closed=false;const closing=service.close().then(()=>{closed=true;});
  await Promise.resolve();assert.equal(closed,false,'storage must stay open while retention still runs');
  finish();await closing;
  t.mock.timers.tick(3600_000);assert.equal(sweeps,1);assert.equal(retentions,1);
  service.start();await service.close();t.mock.timers.tick(1000);
  assert.equal(sweeps,1);assert.equal(retentions,1,'closing before startup cancels its deferred pass');
});

import {ResultSession,resultScope} from '../dist/agent/tool-results.js';
test('assistant command results are copied before turn release and remain readable without starting a computer',async t=>{
  const f=await fixture(t),turn=f.turn('turn-pages'),source='HEAD\n'+'中😀'.repeat(300000)+'\nTAIL\n',data=Buffer.from(source),original=f.docker.runner.bind(f.docker);let commands=0,pages=0;
  f.docker.runner=async(name,input)=>{
    if(input.type==='command'){commands++;return {ok:true,result:{exit_code:0,truncated:true,head:'HEAD',tail:'TAIL',output_file:'/runner/private'}};}
    if(input.type==='tail'){pages++;let end=Math.min(input.offset+65536,data.length);while(end<data.length&&(data[end]&0xc0)===0x80)end--;return {ok:true,result:{data:data.subarray(input.offset,end).toString('utf8'),offset:end,size:data.length}};}
    return original(name,input);
  };
  const session=new ResultSession(f.store,resultScope(f.store,{id:'turn-pages',conversation_id:'chat'}),()=> 'group-owner',()=>{});
  const result=await session.execute('run_command',{},()=>turn.execute('run_command',{command:'large result'}));
  assert.equal(result.error,undefined);assert.ok(result.file);assert.equal(result.output_file,undefined);await turn.close();
  const before=f.docker.runs.length;assert.equal((await session.read({file:result.file})).content,source.slice(0,(await session.read({file:result.file})).content.length));
  assert.equal(f.docker.runs.length,before);assert.equal(commands,1);assert.ok(pages>1);
});
