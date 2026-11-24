import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { managerFixture } from '../../../fixtures/project-manager-fixture.mjs';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { Store } from '../../../../dist/storage/database.js';
import { ManagementService } from '../../../../dist/management/service.js';
import { ManagementAgent } from '../../../../dist/management/agent.js';
import { RuleService } from '../../../../dist/rules/service.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { ChannelService } from '../../../../dist/channels/service.js';
import { AssistantComputerService } from '../../../../dist/service-roles/assistant-computers.js';
import { MemoryConsolidationService } from '../../../../dist/memory/consolidation-engine.js';
import { getConsolidationState, listConsolidationRuns, personalScopeId } from '../../../../dist/memory/consolidation-storage.js';
import { RetentionCleanup } from '../../../../dist/storage/retention.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';
import { releaseModel } from '../../../../dist/service-roles/roles.js';
import { resolvePrincipalActor } from '../../../../dist/identity/authorization.js';

function seedFeishuGroup(store, adminUserId, repoId, modelId, chatHex) {
  const connId = 'a'.repeat(48), credId = 'b'.repeat(48), chatId = chatHex || 'c'.repeat(48);
  const bindingId = 'd'.repeat(48), bindPrincipal = 'p-group-' + chatId.slice(0, 8);
  const now = Date.now();
  store.run('INSERT OR IGNORE INTO channel_credentials VALUES(?,?)', credId, store.secrets.seal({ app_secret: 'sec' }, 'channel-credential:' + credId));
  store.run(`INSERT OR IGNORE INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at,owner_tenant,created_by)
    VALUES(?,'feishu','cli_app','tenant_1','ou_bot','enterprise','websocket',?,1,1,?,'',?)`, connId, credId, now, adminUserId);
  store.run(`INSERT OR IGNORE INTO channel_chats(id,connector_id,provider,app_id,installation_tenant,chat_id,chat_type,state,display_name,context_revision,revision,retained_after,created_at,last_received_at)
    VALUES(?,?,'feishu','cli_app','tenant_1','oc_group_1','group','active','研发协作群',1,1,0,?,?)`, chatId, connId, now, now);
  store.run("INSERT OR IGNORE INTO principals(id,kind,active,authorization_revision,maintenance) VALUES(?,'service',1,1,?)", bindPrincipal, 'channel-binding:' + chatId);
  const tenantId = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', repoId)?.tenant_id || 't1';
  store.run(`INSERT OR IGNORE INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,permissions,model_id,prompt,harness,enabled,revision,created_at,updated_at)
    VALUES(?,?,'group-assistant','repositories',?,?,?,'mentions',?,?,?,'pi',1,1,?,?)`,
    bindingId, chatId, bindPrincipal, adminUserId, adminUserId,
    JSON.stringify({ github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read', project_tasks: 'read', project_memory: 'read', project_configuration: 'none', schedules: 'none', delegation: 'deny' }),
    modelId, '', now, now);
  store.run(`INSERT OR IGNORE INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,?,?,'project','service',?,'explicit_delegation',?,'channel_service_binding',?,?)`,
    'grant-' + chatId.slice(0, 8), bindPrincipal, tenantId, repoId, JSON.stringify(['tasks.read', 'knowledge.read']), adminUserId, 'channel:' + chatId, now);
  return { connId, chatId, bindingId, bindPrincipal };
}

test('scheduler runs all three tracks with zero activity gate, respects overrides, defers to real-time work, and never silently downgrades models', async t => {
  const homesDir = mkdtempSync(join(tmpdir(), 'mc-sched-homes-'));
  const notesRoot = mkdtempSync(join(tmpdir(), 'mc-sched-notes-'));
  const mf = await managerFixture({ after: fn => t.after(fn) });
  t.after(() => {
    rmSync(homesDir, { recursive: true, force: true });
    rmSync(notesRoot, { recursive: true, force: true });
  });

  // Fixed clock inside default 02:00-05:00 Asia/Shanghai window (03:00 CST = 19:00 UTC prev day)
  const clockMs = Date.parse('2026-06-15T19:00:00Z');
  const executed = [];
  let consolidation;
  const h = await harness(t, mf.manager, {
    assistantHomes: homesDir,
    consolidation: {
      automatic: false,
      clock: () => clockMs,
      runner: async ctx => {
        executed.push({ kind: ctx.scope_kind, id: ctx.scope_id, model: ctx.model.id });
        // Exercise write tools on each track
        if (ctx.scope_kind === 'project') {
          await ctx.execute('save_project_note', { path: 'INDEX.md', content: '# Project Index\nConsolidated.' });
        } else {
          await ctx.execute('write_file', { path: '~/memory/INDEX.md', content: '# Private Index\nConsolidated.' });
        }
        return { summary: `Done ${ctx.scope_kind}` };
      },
    },
    onConsolidation: svc => { consolidation = svc; },
  });

  const { admin } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');
  // Seed a shared model (with API key) and assign to project 101 + management assistant + group binding
  const shared = (await admin('/api/models', 'POST', {
    provider_name: 'Fixture', api_url: 'http://127.0.0.1:9999/v1', model_name: 'shared-nightly', api_key: 'sk-shared-key-123456',
  })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: shared.id });
  const roleRow = h.store.get("SELECT revision FROM service_roles WHERE id='management-assistant'");
  const roleRes = await admin('/api/service-roles/management-assistant', 'PATCH', {
    name: '管理助手', responsibility: 'test', prompt: '', model_id: shared.id, expected_revision: roleRow.revision,
  });
  assert.equal(roleRes.status, 200, JSON.stringify(roleRes));

  const adminPrincipal = h.store.get("SELECT id FROM principals WHERE kind='human' LIMIT 1").id;
  const { chatId } = seedFeishuGroup(h.store, adminPrincipal, '101', shared.id);

  // Set concurrency high enough for all 3 tracks, keep zero tasks/messages/conversations (NO activity gate!)
  await admin('/api/memory/consolidation/settings', 'PUT', { max_concurrency: 4 });

  // Simulate real-time activity on group chat -> group should defer while project & personal run
  h.store.run(`INSERT INTO channel_service_turns(id,chat_id,binding_id,binding_revision,service_role_id,source_message,fence,state,created_at,updated_at)
    VALUES('turn-1',?,?,1,'group-assistant','m1','f1','running',?,?)`, chatId, 'd'.repeat(48), Date.now(), Date.now());

  const firstTick = await consolidation.tick();
  assert.equal(firstTick.deferred, 1, 'active group turn defers nightly consolidation: ' + JSON.stringify({ firstTick, candidates: consolidation.enumerateCandidates() }));
  assert.equal(firstTick.launched, 2, 'project and personal tracks launch with zero incremental activity: ' + JSON.stringify({ firstTick, candidates: consolidation.enumerateCandidates(), runs: listConsolidationRuns(h.store) }));
  await Promise.allSettled([...consolidation.active.values()].map(e => e.promise));

  assert.ok(executed.some(e => e.kind === 'project' && e.id === '101'));
  assert.ok(executed.some(e => e.kind === 'personal_assistant' && e.id === personalScopeId(adminPrincipal, '')));
  assert.ok(!executed.some(e => e.kind === 'group_assistant'));

  // Finish the real-time group turn -> next tick launches the deferred group track
  h.store.run("UPDATE channel_service_turns SET state='completed' WHERE id='turn-1'");
  const secondTick = await consolidation.tick();
  assert.equal(secondTick.launched, 1);
  await Promise.allSettled([...consolidation.active.values()].map(e => e.promise));
  assert.ok(executed.some(e => e.kind === 'group_assistant' && e.id === chatId));

  // Verify third tick on same logical day launches 0 (once per logical day)
  const thirdTick = await consolidation.tick();
  assert.equal(thirdTick.launched, 0);

  // Verify explicit scope model with revoked API key is skipped (NO silent downgrade to shared model!)
  const unkeyed = (await admin('/api/models', 'POST', {
    provider_name: 'NoKey', api_url: 'http://127.0.0.1:9999/v1', model_name: 'revoked-model', api_key: 'sk-temp-123456',
  })).value.model;
  h.store.run('UPDATE models SET api_key=NULL WHERE id=?', unkeyed.id);
  await admin('/api/repositories/101/memory-consolidation', 'PUT', { model_id: unkeyed.id });
  const manualRes = await admin('/api/repositories/101/memory-consolidation/run', 'POST', {});
  assert.equal(manualRes.status, 201);
  assert.equal(manualRes.value.run.status, 'skipped');
  assert.equal(manualRes.value.run.error_code, 'model_unavailable');

  // Releasing a deleted model clears both global & per-scope consolidation model references
  await admin('/api/memory/consolidation/settings', 'PUT', { model_id: shared.id });
  releaseModel(h.store, shared.id, adminPrincipal);
  assert.equal((await admin('/api/memory/consolidation/settings')).value.settings.model_id, null);
  releaseModel(h.store, unkeyed.id, adminPrincipal);
  assert.equal(getConsolidationState(h.store, 'project', '101').model_id, null);
});

test('real Pi SDK runs project consolidation end-to-end with full-history tools, redaction, soft-delete restore, billing, and zero git checkout', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mc-real-pi-'));
  const store = new Store(':memory:', Buffer.alloc(32, 9));
  const manager = new LocalManager('101', root);
  const requests = [];
  let step = 0;
  const secretToken = 'ghp_RealPiConsolidationSecret987654321';

  const mockProvider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    step++;
    res.setHeader('Content-Type', 'application/json');
    const reply = message => {
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        const chunk = {
          id: 'chatcmpl-' + step,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: message.tool_calls
              ? { role: 'assistant', tool_calls: message.tool_calls.map((tc, i) => ({ index: i, ...tc })) }
              : { role: 'assistant', content: message.content },
            finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
          }],
        };
        const usageChunk = {
          id: 'chatcmpl-' + step,
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 45 },
        };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usageChunk)}\n\ndata: [DONE]\n\n`);
      } else {
        res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 120, completion_tokens: 45 } }));
      }
    };

    if (step === 1) {
      return reply({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'list_project_tasks', arguments: JSON.stringify({ limit: 10 }) } },
          { id: 'call_2', type: 'function', function: { name: 'list_dispatch_threads', arguments: JSON.stringify({ limit: 10 }) } },
        ],
      });
    }
    if (step === 2) {
      return reply({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_3', type: 'function', function: { name: 'read_project_task', arguments: JSON.stringify({ task_id: 'task-hist-1' }) } },
          { id: 'call_4', type: 'function', function: { name: 'list_task_records', arguments: JSON.stringify({ task_id: 'task-hist-1', limit: 20 }) } },
        ],
      });
    }
    if (step === 3) {
      return reply({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_5', type: 'function', function: { name: 'save_project_note', arguments: JSON.stringify({ path: 'INDEX.md', content: `# Project Memory\n\n- Port moved to 8791 (2026-06-15)\n- Branch v2 note preserved\n- Accidental secret: ${secretToken}\n` }) } },
          { id: 'call_6', type: 'function', function: { name: 'delete_project_note', arguments: JSON.stringify({ path: 'obsolete.md' }) } },
        ],
      });
    }
    return reply({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_7', type: 'function', function: { name: 'finish_consolidation', arguments: JSON.stringify({ summary: 'Updated INDEX.md from task-hist-1 and removed obsolete.md.', changed_files: ['INDEX.md'], deleted_files: ['obsolete.md'] }) } },
      ],
    });
  });

  mockProvider.listen(0, '127.0.0.1');
  await once(mockProvider, 'listening');
  t.after(async () => {
    await manager.recover();
    await new Promise(r => { mockProvider.close(r); mockProvider.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')",
    store.secrets.seal({ token: secretToken }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/real-pi','10','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m1','101',?,'pi-consolidation-model',?,'now')",
    `http://127.0.0.1:${mockProvider.address().port}/v1`, store.secrets.seal({ value: 'sk-pi-test-key' }, 'model:m1'));
  store.run("INSERT INTO policies(repository_id,enabled,model_id) VALUES('101',1,'m1')");

  // Seed historical task, task_history, dispatch_thread, and initial project notes
  store.run(`INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,result,created_at,updated_at)
    VALUES('task-hist-1','101','task.request','completed','done','Migrated listener to port 8791','{}','{"summary":"Single port 8791 verified"}','2026-06-14T10:00:00Z','2026-06-14T11:00:00Z')`);
  store.run(`INSERT INTO task_history(task_id,type,data,created_at) VALUES('task-hist-1','note',?,'2026-06-14T10:30:00Z')`,
    JSON.stringify({ detail: 'Verified port 8791 in production config' }));
  store.db.exec(`CREATE TABLE IF NOT EXISTS dispatch_threads(thread_key TEXT PRIMARY KEY,repository_id TEXT NOT NULL,object_type TEXT NOT NULL,object_number INTEGER NOT NULL,messages TEXT NOT NULL,summary TEXT,active_task_id TEXT,updated_at TEXT NOT NULL)`);
  store.run(`INSERT INTO dispatch_threads VALUES('issue:42','101','issue',42,?,'Port 8791 confirmed',NULL,'2026-06-14T12:00:00Z')`,
    JSON.stringify([{ role: 'user', content: 'Confirm port 8791 on main and keep branch-v2 notes.' }]));

  await manager.call('POST', '/v1/projects/101/file-tree', { path: 'obsolete.md', content: 'Temporary scratchpad', actor: 'user:1' });
  await manager.call('POST', '/v1/projects/101/file-tree', { path: 'branch-v2.md', content: 'Branch v2 uses feature flag X', actor: 'user:1' });

  const managerCalls = [];
  const trackedManager = {
    call: async (method, path, body) => {
      managerCalls.push({ method, path, request: body?.request ?? null });
      return manager.call(method, path, body);
    },
  };
  const rules = new RuleService(store, trackedManager);
  const taskCommands = new TaskCommands(store);
  const management = new ManagementService(store, rules, taskCommands, trackedManager);
  const consolidation = new MemoryConsolidationService({ store, manager: trackedManager, management });

  const started = consolidation.triggerManual('project', '101');
  assert.equal(started.status, 'running');
  await Promise.allSettled([...consolidation.active.values()].map(e => e.promise));

  // Verify run completed cleanly with ground-truth changed_files & deleted_files
  const runs = listConsolidationRuns(store, { scope_kind: 'project', scope_id: '101' }).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed', JSON.stringify(runs[0]));
  assert.ok(runs[0].summary.includes('INDEX.md'));
  assert.equal(runs[0].changed_files.length, 1);
  assert.equal(runs[0].changed_files[0].path, 'INDEX.md');
  assert.ok(runs[0].changed_files[0].id);
  assert.equal(runs[0].deleted_files.length, 1);
  assert.equal(runs[0].deleted_files[0].path, 'obsolete.md');
  const deletedFileId = runs[0].deleted_files[0].id;
  assert.ok(deletedFileId);

  // Verify NO native bash/file/git tools were sent to the model & NO git worktree was created
  assert.ok(requests.length >= 4);
  const offeredTools = new Set(requests[0].tools.map(tool => tool.function.name));
  assert.ok(offeredTools.has('list_project_tasks'));
  assert.ok(offeredTools.has('read_task_record'));
  assert.ok(offeredTools.has('save_project_note'));
  assert.ok(offeredTools.has('delete_project_note'));
  assert.ok(offeredTools.has('finish_consolidation'));
  for (const forbidden of ['run_command', 'bash', 'edit', 'write', 'read', 'github_write', 'create_pull_request']) {
    assert.equal(offeredTools.has(forbidden), false, `Pi consolidation must not offer ${forbidden}`);
  }
  const executeCalls = managerCalls.filter(call => call.path.endsWith('/execute'));
  const executeTypes = executeCalls.map(call => call.request?.type).filter(Boolean);
  assert.ok(executeTypes.includes('workspace_init'), 'expected workspace_init for Pi session sandbox');
  assert.equal(
    executeTypes.every(type => type === 'workspace_init' || type === 'reap' || type.startsWith('workspace_agent_')),
    true,
    `project consolidation must only invoke workspace_init, workspace_agent_*, and reap runner calls, got: ${[...new Set(executeTypes)].join(', ')}`,
  );
  assert.equal(
    managerCalls.some(call => call.path.includes('/worktree')),
    false,
    'project consolidation must not invoke any worktree endpoint',
  );
  const configChunks = executeCalls
    .filter(call => call.request?.type === 'workspace_agent_config')
    .sort((a, b) => Number(a.request.offset ?? 0) - Number(b.request.offset ?? 0))
    .map(call => Buffer.from(String(call.request.base64 ?? ''), 'base64'));
  assert.ok(configChunks.length > 0, 'expected workspace_agent_config sent to Pi runner');
  const wireConfig = JSON.parse(Buffer.concat(configChunks).toString('utf8'));
  assert.deepEqual(
    {
      workspace: wireConfig.native_access?.workspace,
      fileTools: wireConfig.native_access?.fileTools,
      commands: wireConfig.native_access?.commands,
      network: wireConfig.native_access?.network,
    },
    { workspace: 'none', fileTools: 'none', commands: false, network: false },
  );
  assert.deepEqual(wireConfig.capabilities?.workspace, { read: false, write: false, notes: false, shell: false });

  // Verify written INDEX.md was redacted and branch-v2.md preserved
  const indexRes = await manager.call('GET', `/v1/projects/101/file-tree/${encodeURIComponent(runs[0].changed_files[0].id)}`);
  const indexNote = indexRes.file ?? indexRes;
  assert.ok(indexNote.content.includes('Port moved to 8791'));
  assert.ok(!indexNote.content.includes(secretToken), 'secret must be redacted before writing to ../notes/');
  const branchListing = await manager.call('GET', '/v1/projects/101/file-tree?directory=&query=branch-v2&include_deleted=0&deleted_only=0&recursive=1&preview=0');
  const branchRes = await manager.call('GET', `/v1/projects/101/file-tree/${encodeURIComponent(branchListing.files[0].id)}`);
  const branchNote = branchRes.file ?? branchRes;
  assert.ok(branchNote.content.includes('Branch v2'));

  // Verify soft-deleted obsolete.md can be restored cleanly from .write-history
  const versions = await manager.call('GET', `/v1/projects/101/file-tree/${encodeURIComponent(deletedFileId)}/versions`);
  assert.ok(versions.versions.some(v => v.deleted === true));
  const restoreRes = await manager.call('POST', `/v1/projects/101/file-tree/${encodeURIComponent(deletedFileId)}/restore`, {
    revision: 1, expected_revision: 2, actor: 'user:1',
  });
  const restore = restoreRes.file ?? restoreRes;
  assert.equal(restore.deleted, false);
  assert.equal(restore.content, 'Temporary scratchpad');

  // Verify model_requests recorded billable usage for memory.consolidation
  const billed = store.all("SELECT * FROM model_requests WHERE repository_id='101' AND role_id='memory-consolidation'");
  assert.ok(billed.length >= 4, 'every Pi gateway model request is billed to model_requests');
});

test('console APIs enforce permissions, ~/memory/ redaction, retention pruning, group unbind and project deletion cascade cleanup', async t => {
  const homesDir = mkdtempSync(join(tmpdir(), 'mc-api-homes-'));
  const mf = await managerFixture({ after: fn => t.after(fn) });
  t.after(() => rmSync(homesDir, { recursive: true, force: true }));

  const h = await harness(t, mf.manager, {
    assistantHomes: homesDir,
    consolidation: { automatic: false },
  });
  const { admin } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');
  const shared = (await admin('/api/models', 'POST', {
    provider_name: 'Shared', api_url: 'http://127.0.0.1:9999/v1', model_name: 'shared-m', api_key: 'sk-secret-api-key-abcdef123456',
  })).value.model;

  // 1. Personal ~/memory/ CRUD + automatic redaction + path traversal rejection
  const secretValue = acc.token;
  const putMem = await admin('/api/identity/memory-files/content', 'PUT', {
    path: 'prefs/style.md',
    content: `# My Style\nNever store ${secretValue}`,
  });
  assert.equal(putMem.status, 200);
  const listMem = await admin('/api/identity/memory-files');
  assert.equal(listMem.status, 200);
  assert.equal(listMem.value.available, true);
  assert.equal(listMem.value.files.length, 1);
  assert.equal(listMem.value.files[0].path, 'prefs/style.md');

  const getMem = await admin('/api/identity/memory-files/content?path=' + encodeURIComponent('prefs/style.md'));
  assert.equal(getMem.status, 200);
  assert.ok(!getMem.value.content.includes(secretValue), 'personal ~/memory/ API write must redact secrets');
  assert.ok(getMem.value.content.includes('# My Style'));

  // Traversal and sensitive path rejected
  const badPath = await admin('/api/identity/memory-files/content', 'PUT', { path: '../outside.md', content: 'nope' });
  assert.equal(badPath.status, 400);
  const badSensitive = await admin('/api/identity/memory-files/content', 'PUT', { path: '.env', content: 'A=1' });
  assert.equal(badSensitive.status, 400);

  // Deleting works
  const delMem = await admin('/api/identity/memory-files/content', 'DELETE', { path: 'prefs/style.md' });
  assert.equal(delMem.status, 200);
  assert.equal(delMem.value.deleted, true);

  // 2. Group ~/memory/ + group consolidation settings + disable cascade cleanup
  const adminPrincipal = h.store.get("SELECT id FROM principals WHERE kind='human' LIMIT 1").id;
  const { chatId } = seedFeishuGroup(h.store, adminPrincipal, '101', shared.id);

  const groupSettings = await admin(`/api/channels/chats/${chatId}/memory-consolidation`, 'PUT', {
    enabled_override: true, model_id: shared.id,
  });
  assert.equal(groupSettings.status, 200);
  assert.equal(groupSettings.value.state.enabled_override, true);

  const groupPut = await admin(`/api/channels/chats/${chatId}/memory-files/content`, 'PUT', {
    path: 'INDEX.md', content: 'Group memory index',
  });
  assert.equal(groupPut.status, 200);
  const groupList = await admin(`/api/channels/chats/${chatId}/memory-files`);
  assert.equal(groupList.value.files.length, 1);

  // Disabling the group binding cascades to delete its consolidation state/runs
  const disableRes = await admin(`/api/channels/chats/${chatId}/service-binding`, 'PUT', {
    enabled: false, expected_revision: 1,
  });
  assert.equal(disableRes.status, 200);
  assert.equal(h.store.get("SELECT 1 FROM memory_consolidation_state WHERE scope_kind='group_assistant' AND scope_id=?", chatId), undefined);

  // 3. RetentionCleanup prunes project-notes history and old memory_consolidation_runs
  await admin('/api/repositories/101/knowledge-files', 'POST', { name: 'history.md', content: 'v1' });
  const fileId = (await admin('/api/repositories/101/knowledge-files')).value.files[0].id;
  await admin(`/api/repositories/101/knowledge-files/${encodeURIComponent(fileId)}`, 'PUT', { content: 'v2', expected_revision: 1 });
  await admin(`/api/repositories/101/knowledge-files/${encodeURIComponent(fileId)}`, 'PUT', { content: 'v3', expected_revision: 2 });

  const retentionSave = await admin('/api/storage/retention', 'PUT', {
    trajectory_days: 30, manager_payload_days: 2, workspace_finished_days: 1, workspace_failed_days: 7,
    webhook_payload_days: 14, project_notes_keep_versions: 1, project_notes_keep_days: 1, trajectory_days_by_project: {},
  });
  assert.equal(retentionSave.status, 200);
  assert.equal(retentionSave.value.settings.project_notes_keep_versions, 1);
  assert.equal(retentionSave.value.settings.project_notes_keep_days, 1);

  // Insert an aged finished consolidation run older than 30 days
  h.store.run(`INSERT INTO memory_consolidation_runs(id,scope_kind,scope_id,logical_day,trigger,status,started_at,finished_at)
    VALUES('old-run','project','101','2025-01-01','nightly','completed','2025-01-01T02:00:00Z','2025-01-01T02:05:00Z')`);
  const cleanup = new RetentionCleanup(h.store, mf.manager);
  const summary = await cleanup.pass();
  assert.equal(summary.memory_consolidation_runs.count, 1);
  assert.equal(h.store.get("SELECT 1 FROM memory_consolidation_runs WHERE id='old-run'"), undefined);

  // 4. Project deletion cascade cleans up memory_consolidation_state & runs
  await admin('/api/repositories/101/memory-consolidation', 'PUT', { enabled_override: false });
  assert.ok(h.store.get("SELECT 1 FROM memory_consolidation_state WHERE scope_kind='project' AND scope_id='101'"));
  deleteProjectRecords(h.store, '101', { files: false });
  assert.equal(h.store.get("SELECT 1 FROM memory_consolidation_state WHERE scope_kind='project' AND scope_id='101'"), undefined);
});
