import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../manager/projects.mjs';
import { RunEnvironments } from '../manager/run-environments.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { ManagerClient } from '../dist/projects/service.js';
import { RunEnvironmentClient, provisionRunEnvironment, verifyRunEnvironment } from '../dist/projects/run-environment.js';
const id = () => randomBytes(24).toString('hex');

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'run-env-unit-'));
  const docker = new FakeDocker(), projects = new Projects({ database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  // A configured project variable must never reach a run environment.
  await projects.register('101'); await projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { env: { NPM_TOKEN: 'project-secret-value' } } });
  const runs = new RunEnvironments(projects);
  t.after(() => { projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, docker, projects, runs };
}
const spec = (run = id(), extra = {}) => ({ run_id: run, task_id: 't1', lease_epoch: 3, profile: 'observer', ...extra });

test('a run environment is its own hardened container: no mounts, private tmpfs workspace and HOME, no network, no project variables', async t => {
  const f = await fixture(t), run = id();
  const described = await f.runs.create('101', spec(run));
  const name = f.runs.names('101', run).container, created = f.docker.containers.get(name);
  const host = created.HostConfig;
  assert.deepEqual([created.Config.User, host.ReadonlyRootfs, host.CapDrop, host.SecurityOpt, host.Privileged, host.NetworkMode, host.Mounts, host.Init], ['10001:10001', true, ['ALL'], ['no-new-privileges:true'], false, 'none', [], true]);
  assert.equal(host.Memory, host.MemorySwap, 'no swap beyond the memory limit');
  assert.ok(host.PidsLimit > 0 && host.NanoCpus > 0);
  assert.match(host.Tmpfs['/workspace'], /size=\d+.*uid=10001/);
  for(const path of ['/workspace','/tmp']){
    const options=host.Tmpfs[path].split(',');
    for(const option of ['rw','exec','nosuid','nodev'])assert.ok(options.includes(option),`${path}: ${option}`);
    assert.ok(!options.includes('noexec'));assert.match(host.Tmpfs[path],/size=\d+/);
  }
  assert.deepEqual(created.Config.Env, ['HOME=/workspace/home', 'LANG=C.UTF-8']);
  assert.ok(!JSON.stringify(created).includes('project-secret-value') && !JSON.stringify(created).includes('docker.sock') && !JSON.stringify(created).includes('-notes'));
  assert.equal(created.Config.Labels['department.bot.kind'], 'run'); assert.equal(created.Config.Labels['department.bot.run'], run);
  // The project computer is not touched; its own container stays as it was.
  assert.ok(f.docker.containers.has(f.projects.names('101', 1).container));
  // The control plane's own check of these facts passes; the same call is idempotent.
  assert.deepEqual(verifyRunEnvironment(described, { run_id: run, network: 'none' }), { verified: true, violations: [] });
  const checkNames=env_names=>verifyRunEnvironment({...described,container:{...described.container,env_names}},{run_id:run,network:'none'});
  assert.equal(checkNames(['PATH','HOME','SSH_AUTH_SOCK','XAUTHORITY','DOCKER_VERSION','AWS_REGION','OPENAI_BASE_URL','BOT_LOG_LEVEL','PRIVATE_NETWORK','AUTH_SERVER','MAX_TOKENS']).verified,true);
  for(const name of ['GITHUB_TOKEN','GH_TOKEN','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','NPM_TOKEN','BOT_PASSWORD','DOCKER_AUTHORIZATION','CREDENTIALS','custom_key','SERVICE_PASSWD'])
    assert.deepEqual(checkNames(['HOME',name]).violations,['credential_environment:'+name]);
  assert.equal((await f.runs.create('101', spec(run))).run_id, run);
  await assert.rejects(f.runs.create('101', spec(run, { lease_epoch: 4 })), /run_id_conflict/);
  // An egress profile gets a bridge network of its own, never the project computer's.
  const egress = id(); const withNetwork = await f.runs.create('101', spec(egress, { network: 'egress' }));
  assert.equal(f.docker.containers.get(f.runs.names('101', egress).container).HostConfig.NetworkMode, f.runs.names('101', egress).network);
  assert.notEqual(f.runs.names('101', egress).network, f.projects.names('101', 1).network);
  assert.equal(verifyRunEnvironment(withNetwork, { run_id: egress, network: 'egress' }).verified, true);
});

test('operations act only on the run\'s own workspace and allowlisted types; release, deadlines and restarts remove the container', async t => {
  const f = await fixture(t), run = id();
  await f.runs.create('101', spec(run, { limits: { timeout_ms: 10_000 } }));
  await assert.rejects(f.runs.execute('101', run, { operation_id: id(), request: { type: 'workspace_command', workspace_id: id(), command: 'cat ../*/home/secret' } }), /cross_run_workspace/);
  for (const type of ['workspace_acceptance', 'workspace_agent_start', 'workspace_restore', 'git_store_reset'])
    await assert.rejects(f.runs.execute('101', run, { operation_id: id(), request: { type, workspace_id: run } }), /invalid_runner_request/, type);
  await assert.rejects(f.runs.execute('101', run, { operation_id: id(), request: { type: 'command', command: 'true', source_workspace_id: id() } }), /invalid_runner_request/);
  const ran = await f.runs.execute('101', run, { operation_id: id(), request: { type: 'workspace_command', workspace_id: run, command: 'true', timeout_ms: 999_999_999 } });
  assert.equal(ran.ok, true);
  assert.ok(f.docker.runs.at(-1).timeout_ms <= 10_000, 'a command never outlives the run deadline');
  const runInterrupted = await f.runs.execute('101', run, { operation_id: id(), request: { type: 'workspace_harness_interrupt', workspace_id: run, mode: 'graceful', grace_ms: 1500 } });
  assert.equal(runInterrupted.ok, true);
  assert.equal(f.docker.runs.at(-1).grace_ms, 1500);
  const projectInterrupted = await f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_harness_interrupt', workspace_id: run, mode: 'graceful', grace_ms: 1500 } });
  assert.equal(projectInterrupted.ok, true);
  assert.equal(f.docker.runs.at(-1).grace_ms, 1500);
  for (const badGrace of [0, -1, 1.5, '1500']) {
    await assert.rejects(f.runs.execute('101', run, { operation_id: id(), request: { type: 'workspace_harness_interrupt', workspace_id: run, mode: 'graceful', grace_ms: badGrace } }), /invalid_runner_request/);
    await assert.rejects(f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_harness_interrupt', workspace_id: run, mode: 'graceful', grace_ms: badGrace } }), /invalid_runner_request/);
  }
  await assert.rejects(f.runs.create('101', { ...spec(), limits: { memory_mb: 999999 } }), /invalid_run_limits/);
  await assert.rejects(f.runs.create('101', { ...spec(), mounts: ['/var/run/docker.sock'] }), /invalid_run/);
  await assert.rejects(f.runs.create('202', spec()), /environment_not_ready/);
  const released = await f.runs.release('101', run);
  assert.deepEqual([released.state, released.reason], ['released', 'released']);
  assert.ok(f.docker.calls.includes(`DELETE /containers/${f.runs.names('101', run).container}?force=true`));
  await assert.rejects(f.runs.execute('101', run, { operation_id: id(), request: { type: 'health' } }), /run_environment_released/);
  await assert.rejects(f.runs.create('101', spec(run, { limits: { timeout_ms: 10_000 } })), /run_environment_released/);
  // Past the deadline the periodic check removes it; after a manager restart every leftover one is removed.
  const late = id(); await f.runs.create('101', spec(late, { limits: { timeout_ms: 10_000 } }));
  f.projects.db.prepare('UPDATE run_environments SET deadline=? WHERE run_id=?').run(Date.now() - 1, late);
  assert.equal(await f.runs.reap(), 1);
  assert.equal(f.projects.db.prepare('SELECT release_reason FROM run_environments WHERE run_id=?').get(late).release_reason, 'deadline');
  const left = id(); await f.runs.create('101', spec(left));
  assert.equal(await f.runs.reap({ all: true }), 1);
  assert.equal(f.projects.db.prepare('SELECT release_reason FROM run_environments WHERE run_id=?').get(left).release_reason, 'manager_restart');
});

test('the manager API serves run environments to the control-plane client, which refuses an environment that fails verification', async t => {
  const f = await fixture(t), token = randomBytes(32);
  const { server, recovered } = createManagerServer({ projects: f.projects, token, runs: f.runs });
  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); await recovered;
  t.after(() => new Promise(r => server.close(r)));
  const client = new RunEnvironmentClient(new ManagerClient('http://127.0.0.1:' + server.address().port, token), '101');
  const run = id(), env = await provisionRunEnvironment(client, { run_id: run, task_id: 't1', lease_epoch: 0, profile: 'writer' });
  assert.deepEqual([env.facts.verified, env.facts.isolation, env.facts.evidence], [true, 'run_container', 'run_environments:' + run]);
  assert.equal((await client.call(run, { type: 'health' })).ready, true);
  await env.release();
  assert.equal((await client.inspect(run)).state, 'released');
  // A manager that hands out a weaker container is caught by the control plane's own check and the container is released.
  const original = f.docker.request.bind(f.docker);
  f.docker.request = async (method, path, body) => { if (path.startsWith('/containers/create')) body = { ...body, HostConfig: { ...body.HostConfig, Binds: ['/var/run/docker.sock:/var/run/docker.sock'] } }; return original(method, path, body); };
  const weak = id(), refused = await provisionRunEnvironment(client, { run_id: weak, task_id: 't1', lease_epoch: 0, profile: 'observer' });
  assert.equal(refused.facts.verified, false); assert.deepEqual(refused.facts.detail.violations, ['external_mount', 'docker_socket']);
  assert.equal((await client.inspect(weak)).state, 'released');
});

import {Store} from '../dist/storage/database.js';
import {ResultSession,resultScope} from '../dist/agent/tool-results.js';
test('isolated run output uses its run-scoped read API and persists before releasing the run',async t=>{
  const f=await fixture(t),run=id(),token=randomBytes(32),store=new Store(':memory:',randomBytes(32));t.after(()=>store.close());
  const {server,recovered}=createManagerServer({projects:f.projects,token,runs:f.runs});server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));await recovered;t.after(()=>new Promise(r=>server.close(r)));
  const client=new RunEnvironmentClient(new ManagerClient(`http://127.0.0.1:${server.address().port}`,token),'101');await client.create(spec(run));
  let commands=0,reads=0;const original=f.docker.runner.bind(f.docker),text='HEAD\n'+'中😀'.repeat(300000)+'\nTAIL\n',bytes=Buffer.from(text);
  f.docker.runner=async(name,input)=>{
    if(input.type==='workspace_command'){commands++;return {ok:true,result:{exit_code:0,truncated:true,head:'HEAD',tail:'TAIL',output_file:'/runner/private'}};}
    if(input.type==='tail'){reads++;let end=Math.min(input.offset+65536,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;return {ok:true,result:{data:bytes.subarray(input.offset,end).toString('utf8'),offset:end,size:bytes.length}};}
    return original(name,input);
  };
  const session=new ResultSession(store,resultScope(store,{id:'turn',conversation_id:'run-conversation'}),()=> 'run-owner',()=>{});
  const result=await session.execute('run_command',{},()=>client.call(run,{type:'workspace_command',command:'large output'}));
  assert.equal(result.error,undefined);assert.ok(result.file);assert.equal(result.output_file,undefined);assert.equal(result.bytes,bytes.length);await client.release(run);
  assert.match((await session.read({file:result.file})).content,/^HEAD/);assert.equal(commands,1);assert.ok(reads>1);
});

test('run environment creation leaves no orphan database row if agentToolsVolume fails and validates harness poll fields', async t => {
  const f = await fixture(t), run = id();
  const originalTools = f.projects.agentToolsVolume.bind(f.projects);
  let failVolume = true;
  f.projects.agentToolsVolume = async () => {
    if (failVolume) throw new Error('docker_volume_inspect_failed');
    return originalTools();
  };
  await assert.rejects(f.runs.create('101', spec(run)), /docker_volume_inspect_failed/);
  assert.equal(f.projects.db.prepare('SELECT count(*) n FROM run_environments WHERE run_id=?').get(run).n, 0);

  failVolume = false;
  const created = await f.runs.create('101', spec(run));
  assert.equal(created.run_id, run);

  const inst = id(), toolId = id();
  const polled = await f.runs.execute('101', run, {
    operation_id: id(),
    request: {
      type: 'workspace_harness_poll',
      workspace_id: run,
      offset: 0,
      instance_id: inst,
      wait_ms: 150,
      known_tool_ids: [toolId],
      known_token_ids: [],
      known_model_ids: [],
    },
  });
  assert.equal(polled.ok, true);
  assert.equal(f.docker.runs.at(-1).instance_id, inst);
  assert.equal(f.docker.runs.at(-1).wait_ms, 150);

  for (const bad of [
    { instance_id: 'not-48-hex' },
    { wait_ms: -1 },
    { wait_ms: 1001 },
    { known_tool_ids: ['short'] },
  ]) {
    await assert.rejects(
      f.runs.execute('101', run, { operation_id: id(), request: { type: 'workspace_harness_poll', workspace_id: run, ...bad } }),
      /invalid_runner_request/,
    );
    await assert.rejects(
      f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_harness_poll', workspace_id: run, ...bad } }),
      /invalid_runner_request/,
    );
  }
});

test('a run environment accepts workspace_browser keys and rejects a malformed policy or action', async t => {
  const f = await fixture(t), run = id();
  await f.runs.create('101', spec(run));
  const policy = { origins: ['http://127.0.0.1:9'], allow_destructive: false, timeout_ms: 5000 };
  const request = { type: 'workspace_browser', action: 'open', args: { url: 'http://127.0.0.1:9/' }, policy, workspace_id: run };
  const ran = await f.runs.execute('101', run, { operation_id: id(), request });
  assert.equal(ran.ok, true);
  assert.equal(f.docker.runs.at(-1).type, 'workspace_browser');
  for (const bad of [
    { type: 'workspace_browser', workspace_id: run },
    { type: 'workspace_browser', action: 'launch', policy, workspace_id: run },
    { type: 'workspace_browser', action: 'open', policy: { origins: [] }, workspace_id: run }
  ]) await assert.rejects(f.runs.execute('101', run, { operation_id: id(), request: bad }), /invalid_runner_request/, JSON.stringify(bad));
});


import { computerResultOwner } from '../runner/result-owner.mjs';
import { AssistantComputers } from '../manager/assistant-computers.mjs';
test('project, assistant and isolated computers mount only their own results read-only without repeated drift',async t=>{
  const f=await fixture(t),root=join(f.directory,'results'),name='fixture-tool-results';
  f.projects.resultsMount=root;
  f.docker.volumes.set(name,{Name:name,Labels:{'department.bot.kind':'tool-results'}});
  const original=f.docker.volumeName.bind(f.docker);
  f.docker.volumeName=async path=>path===root?name:path===null?'fixture-assistant-homes':original(path);
  const project=computerResultOwner('project','101'),other=computerResultOwner('project','102'),run=id(),isolated=computerResultOwner('run',run),assistantId='a'.repeat(32),assistant=computerResultOwner('assistant',assistantId);
  for(const owner of [project,other,isolated,assistant])mkdirSync(join(root,owner),{recursive:true});
  await f.projects.provision('101');const made=f.docker.created;await f.projects.provision('101');assert.equal(f.docker.created,made,'correct mount does not rebuild again');
  const projectMount=f.docker.containers.get(f.projects.names('101',1).container).HostConfig.Mounts.find(m=>m.Target==='/results');
  assert.equal(projectMount.ReadOnly,true);assert.equal(projectMount.VolumeOptions.Subpath,project);
  assert.notEqual((await f.projects.resultMount(other))[0].VolumeOptions.Subpath,project);
  const facts=await f.runs.create('101',spec(run));assert.equal(verifyRunEnvironment(facts,{run_id:run,network:'none'}).verified,true);
  const mount=facts.container.mounts.find(m=>m.destination==='/results');assert.equal(mount.rw,false);assert.equal(mount.subpath,isolated);
  mount.subpath=project;assert.ok(verifyRunEnvironment(facts,{run_id:run,network:'none'}).violations.includes('external_mount'));
  const assistants=new AssistantComputers({docker:f.docker,db:f.projects.db,deployment:'fixture',image:'approved',homes:null,resultMount:owner=>f.projects.resultMount(computerResultOwner('assistant',owner))});
  await assistants.acquire(assistantId,{turn:'turn',fence:'f'.repeat(64),home_generation:1,home_mode:'rw'});
  const assistantMount=f.docker.containers.get(assistants.name(assistantId)).HostConfig.Mounts.find(m=>m.Target==='/results');
  assert.equal(assistantMount.ReadOnly,true);assert.equal(assistantMount.VolumeOptions.Subpath,assistant);
  await assistants.shutdown();
  await assert.rejects(f.projects.resultMount(computerResultOwner('run','missing')),/tool_result_directory_missing/);
  f.projects.resultsMount=null;assert.deepEqual(await f.projects.resultMount(project),[],'unconfigured deployments keep file pagination without mounting');
});
