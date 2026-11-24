import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { RuleService } from '../../../../dist/rules/service.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { ManagementService } from '../../../../dist/management/service.js';
import { ProjectToolsService } from '../../../../dist/projects/tools.js';
import {
  executeProjectToolsAssistantTool,
  projectToolsListName,
  projectToolsPublishName,
  projectToolsRollbackName,
  projectToolsAssistantNames,
} from '../../../../dist/projects/tools-assistant.js';
import { serviceTools } from '../../../../dist/channels/service-session.js';
import { assistantFile } from '../../../../runner/assistant-files.mjs';
import { resolvePrincipalActor } from '../../../../dist/identity/authorization.js';
import { identityProjection } from '../../../../dist/identity/storage.js';

function createFixtureStore(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 9));
  t.after(() => store.close());
  const now = new Date().toISOString();
  store.run("INSERT INTO accounts VALUES('acc-1','acct','bot_account',NULL,'{}',?)", now);
  store.run("INSERT INTO repositories VALUES('101','acme/alpha','10','acc-1')");
  store.run("INSERT INTO repositories VALUES('202','acme/beta','10','acc-1')");
  store.run("INSERT INTO policies(repository_id,review_enabled,development_enabled,enabled) VALUES('101',1,1,1)");
  store.run("INSERT INTO policies(repository_id,review_enabled,development_enabled,enabled) VALUES('202',1,1,1)");
  store.run("INSERT INTO users(id,username,password_hash,role,active) VALUES('u-super','admin','x','super_admin',1)");
  store.run("INSERT INTO users(id,username,password_hash,role,active) VALUES('u-padmin','padmin','x','project_admin',1)");
  store.run("INSERT INTO project_admin_assignments VALUES('u-padmin','101')");
  identityProjection(store);
  return store;
}

/** Wires a real runner/assistant-files.mjs backed computer stub for packArchiveStream + readFileStream. */
function makeAssistantComputerStub(wsRoot, tmpRoot) {
  const translate = p => {
    if (p === '/workspace') return wsRoot;
    if (p.startsWith('/workspace/')) return join(wsRoot, p.slice('/workspace/'.length));
    if (p === '/tmp') return tmpRoot;
    if (p.startsWith('/tmp/')) return join(tmpRoot, p.slice('/tmp/'.length));
    return p;
  };
  const runOp = input => assistantFile(
    input.path ? { ...input, path: translate(input.path) } : input,
    { workspaceRoot: wsRoot, tmpRoot, homeRoot: tmpRoot },
  );
  return {
    async packArchiveStream(path, maxBytes) {
      const packId = 'a'.repeat(48);
      const packed = await runOp({ type: 'assistant_archive_pack', pack_id: packId, path, max_bytes: maxBytes });
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await runOp({ type: 'assistant_archive_cleanup', pack_id: packId }).catch(() => {});
      };
      const stream = (async function* () {
        try {
          let offset = 0;
          while (offset < packed.size) {
            const part = await runOp({ type: 'assistant_archive_read', pack_id: packId, offset, limit: 64 * 1024 });
            const buf = Buffer.from(part.base64, 'base64');
            if (!buf.length) break;
            offset += buf.length;
            yield buf;
          }
        } finally {
          await cleanup();
        }
      })();
      return { kind: packed.kind, name: packed.name, executable: packed.executable, size: packed.size, stream, cleanup };
    },
    readFileStream(path, maxBytes) {
      return (async function* () {
        let offset = 0;
        for (;;) {
          const part = await runOp({ type: 'assistant_read', path, offset, limit: 64 * 1024 });
          if (part.size > maxBytes) throw new Error('project_tools_quota_exceeded');
          const buf = Buffer.from(part.base64, 'base64');
          if (buf.length) { yield buf; offset += buf.length; }
          if (!buf.length || offset >= part.size) break;
        }
      })();
    },
  };
}

test('management assistant publishes from /workspace dir and Feishu message_resource, rolls back, enforces RBAC, and group assistant gets no write tools', async t => {
  // Group chat assistant must NEVER expose project_tools write tools
  for (const name of projectToolsAssistantNames) {
    assert.equal(serviceTools.some(tool => tool.function.name === name), false, `group assistant must not expose ${name}`);
  }

  const store = createFixtureStore(t);
  const dir = await mkdtemp(join(tmpdir(), 'pt-asst-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ptRoot = join(dir, 'project-tools');
  const wsRoot = join(dir, 'workspace');
  const tmpRoot = join(dir, 'tmp');
  await mkdir(ptRoot, { recursive: true });
  await mkdir(join(wsRoot, 'my-bundle', 'bin'), { recursive: true });
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(join(wsRoot, 'my-bundle', 'bin', 'custom-cli'), '#!/bin/sh\necho from-ws\n');
  await chmod(join(wsRoot, 'my-bundle', 'bin', 'custom-cli'), 0o755);
  await writeFile(join(wsRoot, 'my-bundle', 'README.txt'), 'tool docs\n');

  const projectTools = new ProjectToolsService(store, { root: ptRoot });
  const service = new ManagementService(store, new RuleService(store), new TaskCommands(store));
  service.projectTools = projectTools;
  const padminActor = resolvePrincipalActor(store, 'u-padmin', 'github.com:10', undefined, 'feishu');
  const computer = makeAssistantComputerStub(wsRoot, tmpRoot);
  const media = {
    async bytes(id) {
      if (id !== 'res-feishu-1') throw new Error('missing');
      return { data: Buffer.from('#!/bin/sh\necho from-feishu\n'), mime: 'application/octet-stream', name: 'feishu-bin', image: false };
    },
  };
  const ctx = { store, actor: padminActor, service, projectTools, computer, media, guard: async () => {} };

  // 1. Publish prepared directory from assistant computer /workspace/my-bundle into authorized acme/alpha
  const pubDir = await executeProjectToolsAssistantTool(ctx, projectToolsPublishName, {
    repository: 'acme/alpha',
    source: 'computer',
    source_path: '/workspace/my-bundle',
    mode: 'replace',
    note: 'verified in assistant computer',
  });
  assert.equal(pubDir.revision, 1);
  assert.equal(pubDir.files_count, 2);
  const binStat = await lstat(join(ptRoot, '101', 'rev-1', 'bin', 'custom-cli'));
  assert.equal(binStat.mode & 0o777, 0o755, '+x bit preserved from workspace directory');
  assert.equal(await readFile(join(ptRoot, '101', 'rev-1', 'README.txt'), 'utf8'), 'tool docs\n');

  // 2. Publish Feishu attachment via source="message_resource" in merge mode
  const pubFeishu = await executeProjectToolsAssistantTool(ctx, projectToolsPublishName, {
    repository: 'acme/alpha',
    source: 'message_resource',
    resource_id: 'res-feishu-1',
    mode: 'merge',
    target_path: 'bin/feishu-cli',
    executable: true,
    note: 'from feishu private chat',
  });
  assert.equal(pubFeishu.revision, 2);
  assert.equal(pubFeishu.files_count, 3);
  assert.equal((await lstat(join(ptRoot, '101', 'rev-2', 'bin', 'feishu-cli'))).mode & 0o777, 0o755);

  // 3. List project tools
  const listed = await executeProjectToolsAssistantTool(ctx, projectToolsListName, { repository: 'acme/alpha' });
  assert.equal(listed.active_revision, 2);
  assert.equal(listed.can_manage, true);
  assert.equal(listed.revisions.length, 2);

  // 4. Rollback to rev-1
  const rb = await executeProjectToolsAssistantTool(ctx, projectToolsRollbackName, { repository: 'acme/alpha', revision: 1 });
  assert.equal(rb.revision, 1);
  assert.equal(rb.state.active_revision, 1);

  // 5. Unauthorized project (acme/beta) is strictly refused for list, publish, and rollback!
  await assert.rejects(
    () => executeProjectToolsAssistantTool(ctx, projectToolsPublishName, {
      repository: 'acme/beta', source: 'message_resource', resource_id: 'res-feishu-1', mode: 'replace',
    }),
    err => err?.status === 403,
  );
  await assert.rejects(
    () => executeProjectToolsAssistantTool(ctx, projectToolsRollbackName, { repository: 'acme/beta', revision: 1 }),
    err => err?.status === 403,
  );
  await assert.rejects(
    () => executeProjectToolsAssistantTool(ctx, projectToolsListName, { repository: 'acme/beta' }),
    err => err?.status === 403,
  );
});
