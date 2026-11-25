import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { managementFixture, query, command } from '../../../fixtures/management-fixture.mjs';
import { RuleService } from '../../../../dist/rules/service.js';
import { MAX_SKILL_BUNDLES } from '../../../../dist/roles/skill-library.js';

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function skillMd(name, description = 'Skill description for API tests.', body = '# Body\n\nSteps.\n') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

async function startFakeGitHub(t, { defaultBranch = 'main', sha, tree, blobs, onBlobRequest }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/user') return json(200, { id: 9001, login: 'bot-user' });
    if (url.pathname === '/repositories/101' || url.pathname === '/repos/acme/alpha') return json(200, { id: 101, full_name: 'acme/alpha', default_branch: defaultBranch, owner: { id: 10, login: 'acme' } });
    if (url.pathname === `/repos/acme/alpha/git/ref/heads/${defaultBranch}`) return json(200, { object: { sha } });
    if (url.pathname === `/repos/acme/alpha/git/commits/${sha}`) return json(200, { sha, tree: { sha: 'tree-' + sha } });
    if (url.pathname === `/repos/acme/alpha/git/trees/tree-${sha}`) return json(200, { sha: 'tree-' + sha, truncated: false, tree });
    const blobMatch = /^\/repos\/acme\/alpha\/git\/blobs\/([^/]+)$/.exec(url.pathname);
    if (blobMatch && blobs.has(blobMatch[1])) {
      const send = () => json(200, { sha: blobMatch[1], encoding: 'base64', content: blobs.get(blobMatch[1]).toString('base64') });
      if (onBlobRequest) { Promise.resolve(onBlobRequest(blobMatch[1])).then(send, () => json(500, { message: 'hook_error' })); return; }
      return send();
    }
    json(404, { message: 'not found: ' + url.pathname });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

test('project skill library REST API enforces roles.edit, project isolation, >1 MiB payload upload, live trusted-branch whole-directory import, and in-use deletion protection', async t => {
  const sha = 'a'.repeat(40);
  const blobs = new Map([
    ['b1', Buffer.from(skillMd('deploy-ops', 'Trusted branch deploy skill.'), 'utf8')],
    ['b2', Buffer.from('# Runbook\nCheck canary metrics.\n', 'utf8')],
    ['b3', Buffer.from('#!/bin/sh\necho deploy-ok\n', 'utf8')],
    ['b4', Buffer.from(PNG_1X1_BASE64, 'base64')],
  ]);
  const tree = [
    { path: '.agents/skills/deploy-ops/SKILL.md', type: 'blob', mode: '100644', sha: 'b1', size: blobs.get('b1').length },
    { path: '.agents/skills/deploy-ops/references/runbook.md', type: 'blob', mode: '100644', sha: 'b2', size: blobs.get('b2').length },
    { path: '.agents/skills/deploy-ops/scripts/run.sh', type: 'blob', mode: '100755', sha: 'b3', size: blobs.get('b3').length },
    { path: '.agents/skills/deploy-ops/assets/diagram.png', type: 'blob', mode: '100644', sha: 'b4', size: blobs.get('b4').length },
  ];
  const githubUrl = await startFakeGitHub(t, { sha, tree, blobs });

  const { h, admin, member } = await managementFixture(t, { githubUrl });
  // Update repo 101 full_name to acme/alpha so fake GitHub routes match cleanly
  h.store.run("UPDATE repositories SET full_name='acme/alpha' WHERE id='101'");

  const projectAdmin = await member('proj-admin', { repository_ids: ['101'] });
  const otherAdmin = await member('other-admin', { repository_ids: ['201'] });
  const readonlyViewer = await member('viewer', {});
  const viewerPrincipal = h.store.get('SELECT id FROM principals WHERE user_id=?', readonlyViewer.id).id;
  assert.equal((await admin('/api/identity/grants', 'POST', {
    principal_id: viewerPrincipal,
    tenant_id: 'github.com:10',
    project_id: '101',
    capabilities: ['tasks.read', 'knowledge.read'],
  })).status, 201);

  // GET lists 5 built-in skills by default and rejects invalid query params cleanly
  const initialList = await projectAdmin.client('/api/repositories/101/skills');
  assert.equal(initialList.status, 200);
  assert.equal(initialList.value.can_edit, true);
  assert.equal(initialList.value.skills.filter(s => s.origin === 'builtin').length, 5);
  assert.equal((await projectAdmin.client('/api/repositories/101/skills?limit=0')).status, 400);
  assert.equal((await projectAdmin.client('/api/repositories/101/skills?include_builtin=maybe')).status, 400);

  // Readonly viewer can read but cannot mutate (403 capability_forbidden)
  const viewerList = await readonlyViewer.client('/api/repositories/101/skills');
  assert.equal(viewerList.status, 200);
  assert.equal(viewerList.value.can_edit, false);
  const viewerCreate = await readonlyViewer.client('/api/repositories/101/skills', 'POST', {
    slug: 'denied',
    files: [{ path: 'SKILL.md', content: skillMd('denied') }],
  });
  assert.equal(viewerCreate.status, 403);

  // Create a >1 MiB console skill (tests raised 12 MiB HTTP body ceiling for /skills)
  const largeConsole = await projectAdmin.client('/api/repositories/101/skills', 'POST', {
    slug: 'large-guide',
    files: [
      { path: 'SKILL.md', content: skillMd('large-guide', 'Multi-file console skill exceeding 1 MiB.') },
      { path: 'references/part1.md', content: 'A'.repeat(450 * 1024) },
      { path: 'references/part2.md', content: 'B'.repeat(450 * 1024) },
      { path: 'references/part3.md', content: 'C'.repeat(300 * 1024) },
      { path: 'assets/logo.png', content: PNG_1X1_BASE64, encoding: 'base64' },
    ],
  });
  assert.equal(largeConsole.status, 201, JSON.stringify(largeConsole.value));
  const skillId = largeConsole.value.skill.id;
  assert.equal(skillId, 'console:101:large-guide');
  assert.equal(largeConsole.value.version.version, 1);

  // Edit console skill -> v2, and read version history + exact v1
  const edited = await projectAdmin.client(`/api/repositories/101/skills/${encodeURIComponent(skillId)}`, 'PUT', {
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: skillMd('large-guide', 'Updated description v2.', '# v2\n') }],
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.value.created, true);
  assert.equal(edited.value.version.version, 2);

  const v1 = await projectAdmin.client(`/api/repositories/101/skills/${encodeURIComponent(skillId)}?version=1`);
  assert.equal(v1.status, 200);
  assert.equal(v1.value.version.version, 1);
  assert.equal(v1.value.version.file_count, 5);

  const versions = await projectAdmin.client(`/api/repositories/101/skills/${encodeURIComponent(skillId)}/versions`);
  assert.equal(versions.status, 200);
  assert.deepEqual(versions.value.versions.map(v => v.version), [2, 1]);

  // Cross-project administrator cannot read or edit project 101's skills
  assert.equal((await otherAdmin.client(`/api/repositories/101/skills/${encodeURIComponent(skillId)}`)).status, 403);
  assert.equal((await otherAdmin.client(`/api/repositories/201/skills/${encodeURIComponent(skillId)}`)).status, 404);

  // Live whole-directory import from trusted base branch via fake GitHub
  const imported = await projectAdmin.client('/api/repositories/101/skills/import', 'POST', { path: 'deploy-ops', source: 'live' });
  assert.equal(imported.status, 201, JSON.stringify(imported.value));
  assert.equal(imported.value.commit, sha);
  assert.equal(imported.value.branch, 'main');
  assert.equal(imported.value.imported.length, 1);
  assert.equal(imported.value.imported[0].skill.id, 'repository:101:deploy-ops');
  assert.equal(imported.value.imported[0].version.file_count, 4);
  // Import response strips bulk file content bodies
  assert.equal('content' in imported.value.imported[0].version.files[0], false);

  // Importing an untrusted/mismatched commit SHA fails closed with 409
  const badSha = await projectAdmin.client('/api/repositories/101/skills/import', 'POST', { path: 'deploy-ops', commit: 'f'.repeat(40), source: 'live' });
  assert.equal(badSha.status, 409);
  assert.equal(badSha.value.error, 'skill_source_commit_unavailable');

  // Repository-origin skill is read-only for console PUT
  const repoPut = await projectAdmin.client(`/api/repositories/101/skills/${encodeURIComponent('repository:101:deploy-ops')}`, 'PUT', {
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: skillMd('deploy-ops', 'Attempted overwrite') }],
  });
  assert.equal(repoPut.status, 403);
  assert.equal(repoPut.value.error, 'skill_read_only');

  // Bind console skill into a library-backed role bundle -> DELETE blocked with 409 skill_in_use
  const rolesBefore = (await query(admin, 'get_effective_config', { project_id: '101' })).value.roles;
  const bindRes = await admin('/api/repositories/101/roles', 'PUT', {
    expected_revision: rolesBefore.revision,
    skills: [{ id: 'ops-kit', source: { type: 'library', items: [{ skill_id: skillId, version: 2 }, { skill_id: 'repository:101:deploy-ops', version: 1 }] } }],
    roles: [{ role_id: 'dev', skill_bundle_ref: { id: 'ops-kit' } }],
  });
  assert.equal(bindRes.status, 200, JSON.stringify(bindRes.value));

  const delInUse = await projectAdmin.client(`/api/repositories/101/skills/${encodeURIComponent(skillId)}`, 'DELETE', { expected_version: 2 });
  assert.equal(delInUse.status, 409);
  assert.equal(delInUse.value.error, 'skill_in_use');

  // Unbind and delete succeeds
  const unbindRes = await admin('/api/repositories/101/roles', 'PUT', {
    expected_revision: bindRes.value.configuration.revision,
    skills: [],
    roles: [{ role_id: 'dev', skill_bundle_ref: null }],
  });
  assert.equal(unbindRes.status, 200);
  const delOk = await projectAdmin.client(`/api/repositories/101/skills/${encodeURIComponent(skillId)}`, 'DELETE', { expected_version: 2 });
  assert.equal(delOk.status, 200);
  assert.equal(delOk.value.deleted, true);
});

test('management assistant queries and commands manage the skill library and support the unified 32-bundle cap in roles.update', async t => {
  const { h, admin } = await managementFixture(t);
  const project = { project_id: '101' };

  // Seed trusted rule cache for cache-mode skill.import
  const rules = new RuleService(h.store);
  const sha = 'c'.repeat(40);
  rules.cache('101', sha, {
    '.agents/skills/pr-checklist/SKILL.md': skillMd('pr-checklist', 'PR checklist from repo.'),
    '.agents/skills/pr-checklist/references/rules.md': '# Rules\n',
  });

  // list_skills query shows built-ins and discoverable trusted repository sources
  const listBefore = await query(admin, 'list_skills', project);
  assert.equal(listBefore.status, 201);
  assert.equal(listBefore.value.skills.filter(s => s.origin === 'builtin').length, 5);
  assert.equal(listBefore.value.repository_sources.commit, sha);
  assert.equal(listBefore.value.repository_sources.skills[0].slug, 'pr-checklist');

  // skill.save creates v1 console skill; receipt omits raw file bodies
  const created = await command(admin, 'skill.save', project, {
    slug: 'triage-guide',
    files: [{ path: 'SKILL.md', content: skillMd('triage-guide', 'Issue triage steps.') }],
  }, 'skill-create-1', listBefore.value.revision);
  assert.equal(created.status, 201, JSON.stringify(created.value));
  assert.equal(created.value.state, 'succeeded');
  assert.equal(created.value.result.skill.id, 'console:101:triage-guide');
  assert.equal('content' in created.value.result.version.files[0], false);

  // skill.import imports whole directory from trusted cache; invalid path fails cleanly as 'failed' (not 'unknown')
  const revAfterSave = (await query(admin, 'list_skills', project)).value.revision;
  const badImport = await command(admin, 'skill.import', project, { path: 'nonexistent', source: 'cache' }, 'skill-import-bad', revAfterSave);
  assert.equal(badImport.status, 201);
  assert.equal(badImport.value.state, 'failed');
  assert.equal(badImport.value.result.error, 'skill_source_not_found');

  const okImport = await command(admin, 'skill.import', project, { path: 'pr-checklist', source: 'cache' }, 'skill-import-ok', revAfterSave);
  assert.equal(okImport.status, 201, JSON.stringify(okImport.value));
  assert.equal(okImport.value.state, 'succeeded');
  assert.equal(okImport.value.result.imported[0].skill.id, 'repository:101:pr-checklist');
  assert.equal(okImport.value.result.imported[0].version.file_count, 2);

  // get_skill and list_skill_versions work via management_query
  const detail = await query(admin, 'get_skill', project, { id: 'console:101:triage-guide' });
  assert.equal(detail.status, 201);
  assert.match(detail.value.version.files[0].content, /Issue triage steps/);

  // Update via skill.save -> v2
  const updated = await command(admin, 'skill.save', project, {
    id: 'console:101:triage-guide',
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: skillMd('triage-guide', 'Issue triage steps v2.') }],
  }, 'skill-update-2', detail.value.revision);
  assert.equal(updated.status, 201);
  assert.equal(updated.value.state, 'succeeded');
  assert.equal(updated.value.result.version.version, 2);

  const hist = await query(admin, 'list_skill_versions', project, { id: 'console:101:triage-guide' });
  assert.equal(hist.status, 201);
  assert.deepEqual(hist.value.versions.map(v => v.version), [2, 1]);

  // Unified 32-bundle cap works end-to-end through management_command roles.update (previously 16 in definition.ts vs 32 in catalog.ts)
  const eff = (await query(admin, 'get_effective_config', project)).value;
  assert.ok(eff.skill_library.some(s => s.id === 'console:101:triage-guide' && s.latest_version === 2));
  const bundles32 = Array.from({ length: MAX_SKILL_BUNDLES }, (_, i) => ({
    id: `kit-${i}`,
    source: i === 0
      ? { type: 'library', items: [{ skill_id: 'console:101:triage-guide', version: 2 }] }
      : { type: 'inline', files: [{ path: 'guide.md', content: `Kit ${i}` }] },
  }));
  const rolesSaved = await command(admin, 'roles.update', project, {
    expected_revision: eff.roles.revision,
    skills: bundles32,
  }, 'roles-32-bundles', eff.revision);
  assert.equal(rolesSaved.status, 201, JSON.stringify(rolesSaved.value));
  assert.equal(rolesSaved.value.state, 'succeeded');
  assert.equal(rolesSaved.value.result.configuration.skills.length, 32);

  // skill.delete deletes unreferenced repo skill cleanly
  const revForDelete = (await query(admin, 'list_skills', project)).value.revision;
  const del = await command(admin, 'skill.delete', project, { id: 'repository:101:pr-checklist', expected_version: 1 }, 'skill-del-1', revForDelete);
  assert.equal(del.status, 201);
  assert.equal(del.value.state, 'succeeded');
  assert.equal(del.value.result.deleted, true);
});

test('in-flight skill.import marks command executing and ignores concurrent resume instead of duplicating GitHub fetches', async t => {
  const sha = 'e'.repeat(40);
  const blobs = new Map([
    ['b1', Buffer.from(skillMd('live-gated', 'Gated live skill import.'), 'utf8')],
  ]);
  const tree = [
    { path: '.agents/skills/live-gated/SKILL.md', type: 'blob', mode: '100644', sha: 'b1', size: blobs.get('b1').length },
  ];
  let blobRequests = 0;
  let releaseBlob;
  let blobEntered;
  const blobEnteredPromise = new Promise(resolve => { blobEntered = resolve; });
  const blobGate = new Promise(resolve => { releaseBlob = resolve; });
  const githubUrl = await startFakeGitHub(t, {
    sha,
    tree,
    blobs,
    onBlobRequest: async () => {
      blobRequests++;
      blobEntered();
      await blobGate;
    },
  });
  const { h, admin } = await managementFixture(t, { githubUrl });
  h.store.run("UPDATE repositories SET full_name='acme/alpha' WHERE id='101'");
  const project = { project_id: '101' };
  const rev = (await query(admin, 'list_skills', project)).value.revision;

  const pendingImport = command(admin, 'skill.import', project, { path: 'live-gated', source: 'live' }, 'skill-import-inflight', rev);
  await blobEnteredPromise;

  const cmdRow = h.store.get("SELECT id,state FROM management_commands WHERE idempotency_key='skill-import-inflight'");
  assert.equal(cmdRow.state, 'executing');

  // Concurrent resume while the first import is awaiting GitHub must return the executing receipt without starting a second fetch
  const resumed = await admin(`/api/management/commands/${cmdRow.id}/resume`, 'POST', {});
  assert.equal(resumed.status, 201, JSON.stringify(resumed.value));
  assert.equal(resumed.value.state, 'executing');
  assert.equal(blobRequests, 1);

  releaseBlob();
  const done = await pendingImport;
  assert.equal(done.status, 201, JSON.stringify(done.value));
  assert.equal(done.value.state, 'succeeded');
  assert.equal(done.value.result.imported[0].skill.id, 'repository:101:live-gated');
  assert.equal(blobRequests, 1);
});
