import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { command, query } from '../../../fixtures/management-fixture.mjs';
import { parameterHash } from '../../../../dist/management/service.js';

test('configuration.pr is retired (410 configuration_pr_removed) in favor of the normal PR development flow while legacy unknown receipts still reconcile (#1171)', async t => {
  const prs = [], tokens = [];
  let tokenRevocations = 0;
  const gh = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), path = url.pathname;
    let raw = '';
    for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : {};
    const send = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (path === '/repos/agent-test-zone/admin-config/installation') return send({ id: 77, account: { id: 10 }, permissions: { contents: 'write', pull_requests: 'write' } });
    if (path === '/app/installations/77/access_tokens') { tokens.push(body); return send({ token: 'fixture-installation-write-token', permissions: body.permissions }); }
    if (path === '/repositories/101') return send({ id: 101, full_name: 'agent-test-zone/admin-config', owner: { id: 10 }, default_branch: 'main' });
    if (path === '/installation/token' && req.method === 'DELETE') { tokenRevocations++; return send({}); }
    if (path.endsWith('/pulls') && req.method === 'GET') return send(prs);
    send({}, 404);
  });
  gh.listen(0, '127.0.0.1');
  await once(gh, 'listening');
  t.after(() => new Promise(r => { gh.close(r); gh.closeAllConnections(); }));

  const h = await harness(t, undefined, { githubUrl: `http://127.0.0.1:${gh.address().port}` }), { admin } = await setup(h);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const a = await account(admin, { type: 'github_app', token: undefined, app_id: '123', private_key: privateKey });
  await repository(admin, a.id, '101');
  h.store.run("UPDATE repositories SET full_name='agent-test-zone/admin-config' WHERE id='101'");
  h.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', 'a'.repeat(40), JSON.stringify({ '.agents/skills/review/SKILL.md': 'Original prompt' }), 'now');

  const target = { project_id: '101' };

  // 1. Capabilities no longer advertise the retired configuration.pr shortcut.
  const capabilities = (await query(admin, 'get_capabilities', target)).value;
  assert.ok(!capabilities.commands.some(c => c.operation === 'configuration.pr'));
  assert.ok(capabilities.commands.some(c => c.operation === 'task.create'));

  // 2. Submitting configuration.pr answers 410 configuration_pr_removed and directs callers to task.create, without touching GitHub.
  const sent = await admin('/api/management/commands', 'POST', {
    operation: 'configuration.pr',
    target,
    arguments: { path: '.agents/skills/review/SKILL.md', content: 'Revised prompt' },
    expected_revision: 'r',
    idempotency_key: 'retired-config-pr',
    source_conversation: 'test-conv',
    source_message: 'msg-1',
  });
  assert.equal(sent.status, 410, JSON.stringify(sent.value));
  assert.equal(sent.value.error, 'configuration_pr_removed');
  assert.match(sent.value.detail, /task\.create/);
  assert.equal(tokens.length, 0);

  // 3. Effective configuration continues to expose repository skills under .agents/skills/ and unified Manager prompt.
  const cfg = (await query(admin, 'get_effective_config', target)).value;
  assert.equal(cfg.workflows, undefined);
  assert.ok(typeof cfg.manager?.prompt?.effective === 'string');
  h.store.run("UPDATE repository_rule_sources SET files=? WHERE repository_id='101'",
    JSON.stringify({ '.agents/skills/review/SKILL.md': 'Original prompt', '.agents/skills/release-notes/SKILL.md': 'Release notes skill text.' }));
  const updatedCfg = (await query(admin, 'get_effective_config', target)).value;
  assert.equal(updatedCfg.skills.length, 2);
  assert.ok(updatedCfg.skills.every(s => s.path.startsWith('.agents/skills/')));

  // 4. A pre-upgrade unknown configuration.pr receipt in management_commands still reconciles cleanly via /resume.
  const legacyId = 'deadbeef00001171';
  prs.push({
    number: 7,
    html_url: 'https://github.com/agent-test-zone/admin-config/pull/7',
    head: { ref: 'bot/configuration-' + legacyId },
    body: 'Update `.agents/skills/review/SKILL.md`.\n\n<!-- bot-management:' + legacyId + ' -->',
  });
  const seed = await command(admin, 'project.update', target, { review_language: 'zh' }, 'seed-cmd');
  assert.equal(seed.value.state, 'succeeded');
  const seedRow = h.store.get('SELECT * FROM management_commands WHERE id=?', seed.value.id);
  const rev = (await query(admin, 'get_effective_config', target)).value.revision;
  const legacyArgs = { path: '.agents/skills/review/SKILL.md', content: 'Revised prompt' };
  const cmdPayload = {
    operation: 'configuration.pr',
    target,
    arguments: legacyArgs,
    expected_revision: rev,
    idempotency_key: 'legacy-unknown-key',
    source_conversation: 'legacy-conv',
    source_message: 'legacy-msg',
  };
  h.store.run(
    `INSERT INTO management_commands(id,principal_id,tenant_id,project_id,channel,operation,target,arguments,expected_revision,idempotency_key,parameter_hash,authorization_revision,execution_fence,source_conversation,source_message,state,before_revision,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    legacyId,
    seedRow.principal_id,
    seedRow.tenant_id,
    '101',
    seedRow.channel,
    'configuration.pr',
    JSON.stringify(target),
    JSON.stringify(legacyArgs),
    rev,
    'legacy-unknown-key',
    parameterHash(cmdPayload),
    seedRow.authorization_revision,
    seedRow.execution_fence,
    'legacy-conv',
    'legacy-msg',
    'unknown',
    rev,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );

  const reconciled = await admin('/api/management/commands/' + legacyId + '/resume', 'POST', {});
  assert.equal(reconciled.status, 201, JSON.stringify(reconciled.value));
  assert.equal(reconciled.value.state, 'succeeded');
  assert.equal(reconciled.value.result.pr_number, 7);
  assert.equal(reconciled.value.result.state, 'pending_merge');
  assert.equal(reconciled.value.result.effective, false);
  assert.equal(tokens.length, 1);
  assert.deepEqual(tokens[0].repository_ids, [101]);
  assert.deepEqual(tokens[0].permissions, { contents: 'write', pull_requests: 'write' });
  assert.equal(tokenRevocations, 1);
});
