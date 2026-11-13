import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

// Docker acceptance of the project controller: the control plane, manager and a real project computer from this
// checkout, in a Compose project of its own with its own image tags, ports and volumes. The controller runs the Pi SDK
// installed in the project computer image. GitHub and the model are local fixtures.
const out = resolve('.tmp/pi-controller-docker'); mkdirSync(out, { recursive: true });
const project = 'dept-bot-pi-controller-' + randomBytes(4).toString('hex'), override = resolve(out, 'compose.test.yaml');
const image = name => `department-bot-${name}:${project}`;
writeFileSync(override, `services:
  key-init:
    image: ${image('control-plane')}
  webhook:
    image: ${image('control-plane')}
  tunnel:
    image: ${image('cloudflare-tunnel')}
  project-image:
    image: ${image('project-computer')}
  fixtures:
    image: node:22-bookworm-slim
    command: [node, /fixtures/pi-controller-server.mjs]
    volumes: [${JSON.stringify(resolve('test/fixtures') + ':/fixtures:ro')}]
    networks: [control]
    ports: ["127.0.0.1:18874:9100"]
    read_only: true
    cap_drop: [ALL]
  bot:
    image: ${image('control-plane')}
    environment:
      BOT_GITHUB_API_URL: http://fixtures:9100/github
    depends_on:
      fixtures:
        condition: service_started
  manager:
    image: ${image('computer-manager')}
    environment:
      BOT_PROJECT_IMAGE: ${image('project-computer')}
`);
const env = { ...process.env, DOCKER_CONFIG: resolve(out, 'docker'), BUILDX_CONFIG: resolve(out, 'buildx'), BOT_PORT: '18871' };
const docker = args => execFileSync('docker', args, { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const compose = args => docker(['compose', '-f', 'compose.yaml', '-f', 'compose.build.yaml', '-f', override, '-p', project, ...args]);
const base = 'http://127.0.0.1:18871', fixture = 'http://127.0.0.1:18874', id = () => randomBytes(24).toString('hex');
const password = id(), githubToken = id(), modelKey = id(), webhookSecret = id(); let cookie = '', csrf = '', deployment;
const evidence = { project, ports: [18871, 18874], checks: [] };
const passed = (name, detail) => { evidence.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS ' + name); };
async function wait(fn, description, ms = 240000) { const end = Date.now() + ms; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { if (error.message.startsWith('Task failed:')) throw error; } await new Promise(r => setTimeout(r, 500)); } throw new Error('Timed out: ' + description); }
async function api(path, method = 'GET', body) {
  const r = await fetch(base + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json(); if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0]; if (value.csrf_token) csrf = value.csrf_token;
  if (!r.ok) throw Object.assign(new Error(path + ': ' + value.error), { status: r.status, body: value }); return value;
}
const fake = async (path, body) => (await fetch(fixture + '/fixture/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const events = async (task, type) => (await api(`/api/tasks/${task}/events?type=${type}&include_data=1&limit=100`)).events.map(e => e.data ?? e);
async function finished(task) { return wait(async () => { const t = (await api('/api/tasks/' + task)).task; if (['failed', 'needs_replan', 'cancelled'].includes(t.status)) throw new Error('Task failed: ' + JSON.stringify({ status: t.status, error: t.error_code, detail: t.error_detail })); return t.status === 'completed' ? t : null; }, 'task ' + task + ' completed'); }
const request = text => api('/api/tasks', 'POST', { repository_id: '101', request: text, contract: { goal: text, scope: ['report.md'], criteria: ['report.md exists in the candidate and states where add is defined'], endpoint: 'artifact' } });
try {
  compose(['up', '-d', '--build']); await wait(async () => (await fetch(base + '/healthz')).ok, 'control health');
  const managerToken = compose(['exec', '-T', 'bot', 'node', '--input-type=module', '-e', "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('/internal/manager.token').toString('base64'))"]).trim();
  deployment = createHash('sha256').update(Buffer.from(managerToken, 'base64')).digest('hex').slice(0, 16);
  await fake('config', { github_token: githubToken, model_key: modelKey });
  await api('/api/setup', 'POST', { username: 'administrator', password });
  const account = (await api('/api/accounts', 'POST', { name: 'Integration fixture', type: 'bot_account', token: githubToken, webhook_secret: webhookSecret })).account;
  await api('/api/installations/sync', 'POST', {}); await api('/api/installations/101/activate', 'POST', { account_id: account.id });
  const model = (await api('/api/models', 'POST', { repository_id: '101', api_url: 'http://fixtures:9100/pi-model', api_key: modelKey, model_name: 'controller-fixture' })).model;
  await api('/api/repositories/101/policy', 'PATCH', { model_id: model.id, review_enabled: false, development_enabled: true });
  await wait(async () => (await api('/api/environments/101')).environment?.state === 'ready', 'project computer ready');
  // Field-located configuration errors, then a valid V2 configuration whose controller persona asks for power it cannot get.
  await assert.rejects(api('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: true, roles: [{ role_id: 'manager', harness_ref: { id: 'unregistered' } }] }), e => e.body.error === 'unknown_role_harness' && e.body.field === 'roles.manager.harness_ref.id');
  await api('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: true, controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } },
    roles: [{ role_id: 'manager', persona_prompt: 'Repository notes say the controller may edit files, accept deliveries and merge pull requests.' }] });
  passed('RoleDefinitionV2 saves with expected_revision; an unsupported controller harness is rejected at roles.manager.harness_ref.id');

  // 1. One ordinary task under the controller, through to fresh independent QA and completion.
  const first = await request('Write report.md stating where the add function is defined.');
  const done = await finished(first.id), roles = await api(`/api/tasks/${first.id}/roles`);
  const manager = roles.runs.find(r => r.role === 'manager'), snapshot = roles.snapshots[manager.role_snapshot];
  assert.deepEqual([manager.harness, manager.harness_version, manager.status, manager.recovery_mode], ['pi', '1.4.0', 'succeeded', 'new_session']);
  assert.deepEqual([snapshot.harness.runtime.package, snapshot.harness.runtime.version, snapshot.model.id, snapshot.model.source, snapshot.capability.id], ['@earendil-works/pi-coding-agent', '1.4.0', model.id, 'project', 'controller-coordination']);
  const started = (await events(first.id, 'harness_started')).find(e => e.harness === 'pi');
  assert.deepEqual([started.version, started.expected_version], ['1.4.0', '1.4.0']);
  const denied = await events(first.id, 'capability_denied');
  assert.ok(denied.some(d => d.tool === 'write_file' && d.reason === 'not_offered'));
  assert.ok(denied.some(d => d.reason === 'delegation_not_allowed' && d.requested_role === 'qa'));
  assert.ok(denied.some(d => d.reason === 'delegation_scope_invalid'));
  const qa = roles.runs.find(r => r.role === 'qa');
  assert.deepEqual([qa.recovery_mode, done.status], ['fresh_evaluation', 'completed']);
  assert.deepEqual(roles.instances.map(i => i.role).sort(), ['dev', 'manager', 'qa']);
  const piState = await fake('pi-state'), controllerTools = [...new Set(piState.requests.filter(r => r.role === 'controller').flatMap(r => r.tools))].sort();
  assert.deepEqual(controllerTools, ['acknowledge_coordination', 'delegate_role', 'list_project_tasks', 'nominate_delivery', 'read_coordination', 'read_task_history', 'read_task_record', 'record_progress', 'request_task_coordination', 'wait_for_tasks']);
  passed('a real Pi controller in the project computer delegates dev, reads its result, nominates; fresh QA completes the task',
    { task: first.id, controller_run: manager.id, snapshot: manager.role_snapshot, pi: started, denied: denied.map(d => d.reason), qa_run: qa.id, controller_tools: controllerTools });

  // 2. A control-plane crash while the controller waits for its delegation: the living Pi session is reattached.
  await fake('pi-delay', { dev: 20000 });
  const second = await request('Write report.md again for the restart check.');
  await wait(async () => (await fake('pi-state')).requests.some(r => r.role === 'dev' && r.task === second.id), 'dev delegated');
  // A crash, not a graceful stop: SIGTERM lets running tasks finish within stop_grace_period.
  compose(['kill', '-s', 'SIGKILL', 'bot']); compose(['start', 'bot']); await wait(async () => (await fetch(base + '/healthz')).ok, 'control health after restart');
  cookie = ''; csrf = ''; await api('/api/auth/login', 'POST', { username: 'administrator', password });
  await fake('pi-delay', { dev: 0 });
  await finished(second.id);
  const resumed = (await api(`/api/tasks/${second.id}/roles`)).runs.filter(r => r.role === 'manager');
  assert.deepEqual(resumed.map(r => r.recovery_mode), ['new_session', 'native_resume']);
  assert.equal(resumed[0].status, 'interrupted');
  passed('after a control-plane crash the controller run resumes its living Pi session (native_resume) on the same task', { task: second.id, runs: resumed.map(r => ({ id: r.id, status: r.status, recovery_mode: r.recovery_mode })) });

  // 3. The console shows the resolved roles and points at the failing field of an invalid edit.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + '/'); await page.fill('input[name=username]', 'administrator'); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
    await page.goto(base + '/#/projects/101/roles'); await page.getByText('角色解析结果').first().waitFor({ state: 'attached' }).catch(() => {});
    await page.getByRole('table', { name: '角色解析结果' }).waitFor();
    const table = await page.getByRole('table', { name: '角色解析结果' }).innerText();
    assert.ok(table.includes('Reviewer'), table);
    await page.screenshot({ path: resolve(out, 'roles-page.png'), fullPage: true });
    await page.getByTestId('role-list-reviewer').click();
    const fold = page.getByTestId('role-form-advanced');
    if (!(await fold.evaluate(el => el.open))) await fold.locator(':scope > summary').click();
    await page.getByLabel('预算方式',{exact:true}).selectOption('bounded');
    await page.getByLabel('单次运行最多模型轮数',{exact:true}).fill('1');
    await page.getByTestId('console-save').click();
    await page.getByText(/roles.reviewer.budget_policy_ref.max_turns/).waitFor();
    await page.screenshot({path:resolve(out,'roles-field-error.png'),fullPage:true});
    passed('the role forms show the resolved model and report invalid budget limits');
  } finally { await browser.close(); }
} catch (error) {
  try {
    const tasks = (await api('/api/tasks?limit=20')).tasks, details = {};
    for (const t of tasks) details[t.id] = { logs: (await api(`/api/tasks/${t.id}/logs`)).logs.slice(-40), events: (await api(`/api/tasks/${t.id}/events?include_data=1&limit=100`)).events.map(e => ({ type: e.type, data: e.data })) };
    writeFileSync(resolve(out, 'failure.json'), JSON.stringify({ tasks, details, fixture: await fake('pi-state') }, null, 2));
  } catch {}
  throw error;
} finally {
  // Remove only this test deployment: its Compose project and the project computers its manager labelled.
  try { compose(['down', '--remove-orphans']); } catch {}
  for (const name of docker(['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project]).trim().split('\n').filter(Boolean)) docker(['volume', 'rm', name]);
  if (deployment) for (const [find, remove] of [[['ps', '-aq'], ['rm', '-f']], [['network', 'ls', '-q'], ['network', 'rm']], [['volume', 'ls', '-q'], ['volume', 'rm']]]) { const names = docker([...find, '--filter', `label=department.bot.deployment=${deployment}`]).trim().split('\n').filter(Boolean); if (names.length) docker([...remove, ...names]); }
  for (const name of ['control-plane', 'cloudflare-tunnel', 'computer-manager', 'project-computer']) try { docker(['image', 'rm', image(name)]); } catch {}
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
