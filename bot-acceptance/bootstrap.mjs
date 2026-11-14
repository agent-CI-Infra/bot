#!/usr/bin/env node
// Sets up a freshly started bot for one acceptance run, using only the console API the setup wizard uses, then checks it
// is ready (playbook section 4). It refuses an instance that is already initialized: every run starts from empty data.
//
// Environment (the workflow maps its secrets onto these names; nothing here is printed):
//   ACCEPTANCE_BOT_URL           console on this machine, default http://127.0.0.1:8791
//   ACCEPTANCE_PUBLIC_ORIGIN     the HTTPS entry GitHub delivers webhooks to
//   ACCEPTANCE_TUNNEL_TOKEN      optional: Cloudflare Tunnel token, handed to the bot's own tunnel service
//   ACCEPTANCE_APP_ID, ACCEPTANCE_APP_PRIVATE_KEY, ACCEPTANCE_APP_WEBHOOK_SECRET   the acceptance GitHub App
//   ACCEPTANCE_BOT_MODEL_URL, ACCEPTANCE_BOT_MODEL_NAME, ACCEPTANCE_BOT_MODEL_API_KEY   the model the bot under test uses
//   ACCEPTANCE_REPOSITORY        default agent-CI-Infra/bot-acceptance-fixture
//   ACCEPTANCE_GITHUB_API_URL    default https://api.github.com
//   ACCEPTANCE_ENVIRONMENT_TIMEOUT_MINUTES   how long the first project computer may take to start, default 20
import { createSign, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Console, until } from './lib/console.mjs';
import { readOptional, stateDir, writeJson } from './lib/state.mjs';

export const FIXTURE = 'agent-CI-Infra/bot-acceptance-fixture';
// The project settings every run starts from (playbook section 3).
export const BASELINE_POLICY = { review_enabled: true, development_enabled: true, actions_failures_enabled: true,
  test_command: 'sh scripts/test.sh', task_concurrency: 3 };
// What the scenarios need from the App beyond the bot's own permission check: gate onboarding commits workflows (S8, R1)
// and Actions failure handling listens to workflow_run (S7).
export const SCENARIO_NEEDS = { permissions: { workflows: 'write', actions: 'write' }, events: ['workflow_run'] };

const secret = () => randomBytes(24).toString('base64url');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export async function bootstrap(options, { dir = stateDir(), log = message => console.error(message) } = {}) {
  const o = { repository: FIXTURE, githubApiUrl: 'https://api.github.com', startTimeoutMs: 5 * 60_000, addressTimeoutMs: 3 * 60_000,
    syncTimeoutMs: 3 * 60_000, environmentTimeoutMs: 20 * 60_000, intervalMs: 5000, waitEnvironment: true, ...options };
  const wait = (label, check, timeoutMs, intervalMs = o.intervalMs) => until(label, check, { timeoutMs, intervalMs, log });
  const target = { bot_url: o.botUrl, public_origin: o.publicOrigin, started_at: new Date().toISOString(), fixture: readOptional(dir, 'fixture.json') };
  const save = () => writeJson(dir, 'target.json', target);
  save();

  const bot = new Console(o.botUrl);
  const setup = await wait('control plane', () => bot.request('GET', '/api/setup'), o.startTimeoutMs);
  if (setup.initialized) throw new Error('the bot is already initialized; bootstrap only sets up a fresh instance');
  const admin = { username: 'acceptance-admin', password: secret() };
  // Saved before use, so evidence collection can still sign in when a later step fails.
  writeJson(dir, 'admin.json', admin, { secret: true });
  await bot.setup(admin.username, admin.password);
  writeJson(dir, 'admin.session.json', bot.session(), { secret: true });
  log('bootstrap: super administrator created');

  // Public entry: a tunnel token goes to the bot's own tunnel service, which must publish this host to the webhook gateway.
  if (o.tunnelToken) {
    await bot.request('POST', '/api/onboarding/tunnel', { token: o.tunnelToken });
    const host = new URL(o.publicOrigin).hostname;
    await wait('tunnel route', async () => {
      const { tunnel } = await bot.request('GET', '/api/onboarding');
      return tunnel.state === 'connected' && tunnel.routes.some(route => route.hostname === host && route.webhook_route);
    }, o.addressTimeoutMs);
  }
  // The bot fetches a one-time proof from itself through the public origin: this proves GitHub can reach it too.
  await wait('public address', () => bot.request('POST', '/api/onboarding/address', { origin: o.publicOrigin }), o.addressTimeoutMs, 10_000);
  log(`bootstrap: public address ${o.publicOrigin} verified`);

  const app = await checkApp(o);
  const { account } = await bot.request('POST', '/api/accounts', { name: app.slug, type: 'github_app', app_id: String(o.app.id),
    private_key: o.app.privateKey, webhook_secret: o.app.webhookSecret });
  // Points the App's webhook at this instance: /hooks/github/<account>/<endpoint> is new in every run.
  const used = await bot.request('POST', '/api/onboarding/use-app', { account_id: account.id, update_webhook: true });
  const permissions = await bot.request('GET', `/api/accounts/${account.id}/permissions`);
  if (!permissions.ok) throw new Error(`App ${app.slug} is missing ${JSON.stringify({ permissions: permissions.app?.missing, events: permissions.app?.missing_events })}`);
  Object.assign(target, { account_id: account.id, app: { slug: app.slug, bot_login: `${app.slug}[bot]`, webhook_url: used.app.webhook_url } });
  save(); log(`bootstrap: App ${app.slug} registered and its webhook points here`);

  const { model } = await bot.request('POST', '/api/models', { api_url: o.model.url, api_key: o.model.apiKey, model_name: o.model.name });
  const probe = await bot.request('POST', `/api/models/${model.id}/test`, {});
  if (!probe.ok) throw new Error(`model test failed: ${probe.error || probe.status} ${probe.message || ''}`.trim());
  await bot.request('POST', '/api/onboarding/model', { model_id: model.id });
  target.model = { id: model.id, name: o.model.name }; save();

  // Installation sync discovers the fixture through the App; then it is started with the shared model.
  const row = await wait('installation sync', async () => {
    await bot.request('POST', '/api/installations/sync', {});
    const { repositories } = await bot.request('GET', '/api/installations');
    return repositories.find(item => same(item.full_name, o.repository) && item.installed);
  }, o.syncTimeoutMs);
  await wait('project start', () => bot.request('POST', `/api/installations/${row.id}/activate`,
    { account_id: account.id, model_id: model.id, development_enabled: true }), o.syncTimeoutMs);
  await bot.request('PATCH', `/api/repositories/${row.id}/policy`, BASELINE_POLICY);
  await bot.request('POST', '/api/onboarding/complete', {});
  target.repository = { id: row.id, full_name: row.full_name }; save();
  log(`bootstrap: ${row.full_name} started`);

  // The test AI acts as an administrator of this one project, never as the super administrator.
  const operator = { username: 'acceptance-operator', password: secret() };
  await bot.request('POST', '/api/users', { ...operator, role: 'project_admin', repository_ids: [row.id] });
  writeJson(dir, 'operator.json', operator, { secret: true });

  await preflight(bot, o, target, wait);
  target.ready_at = new Date().toISOString(); save();
  log('bootstrap: ready');
  return target;
}

// Playbook section 4, on the fresh instance: status, the project row, rate limits and the version under test.
async function preflight(bot, o, target, wait) {
  const status = await bot.request('GET', '/api/status');
  const down = Object.entries(status).filter(([, value]) => value !== true).map(([key]) => key);
  if (down.length) throw new Error(`capabilities unavailable: ${down.join(', ')}`);
  const row = await wait('project computer', async () => {
    const { repositories } = await bot.request('GET', `/api/installations?repository_id=${target.repository.id}`);
    const item = repositories.find(entry => entry.id === target.repository.id);
    if (!item?.enabled) throw new Error('project not enabled');
    if (item.access_gaps?.length) throw new Error(`access gaps: ${JSON.stringify(item.access_gaps)}`);
    return !o.waitEnvironment || item.environment_state === 'ready' ? item : null;
  }, o.environmentTimeoutMs, 10_000);
  target.environment_state = row.environment_state;
  target.version = await bot.request('GET', '/api/version');
  const { accounts } = await bot.request('GET', '/api/github/rate-limits');
  const remaining = accounts.flatMap(account => account.buckets).filter(bucket => bucket.kind === 'installation')
    .flatMap(bucket => bucket.windows).filter(window => window.resource === 'core').map(window => window.remaining);
  target.github_core_remaining = remaining.length ? Math.min(...remaining) : null;
}

// Reads the App with its own JWT before the bot does, to fail with a plain message when it lacks what scenarios need.
async function checkApp(o) {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(o.app.id) })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(o.app.privateKey).toString('base64url')}`;
  const response = await fetch(o.githubApiUrl.replace(/\/$/, '') + '/app', { redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GET /app with the App key -> ${response.status}; check ACCEPTANCE_APP_ID and the private key`);
  const app = await response.json(), rank = { read: 1, write: 2, admin: 3 };
  const permissions = Object.entries(SCENARIO_NEEDS.permissions).filter(([name, level]) => (rank[app.permissions?.[name]] || 0) < rank[level]).map(([name]) => name);
  const events = SCENARIO_NEEDS.events.filter(name => !(app.events || []).includes(name));
  if (permissions.length || events.length) throw new Error(`App ${app.slug} lacks ${JSON.stringify({ permissions, events })}`);
  return app;
}

export function optionsFromEnv(env = process.env) {
  const required = name => { const value = env[name]; if (!value) throw new Error(`${name} is not set`); return value; };
  const minutes = Number(env.ACCEPTANCE_ENVIRONMENT_TIMEOUT_MINUTES || 20);
  return {
    botUrl: env.ACCEPTANCE_BOT_URL || 'http://127.0.0.1:8791', publicOrigin: required('ACCEPTANCE_PUBLIC_ORIGIN'),
    tunnelToken: env.ACCEPTANCE_TUNNEL_TOKEN || undefined, repository: env.ACCEPTANCE_REPOSITORY || FIXTURE,
    githubApiUrl: env.ACCEPTANCE_GITHUB_API_URL || 'https://api.github.com', environmentTimeoutMs: minutes * 60_000,
    app: { id: required('ACCEPTANCE_APP_ID'), privateKey: required('ACCEPTANCE_APP_PRIVATE_KEY'), webhookSecret: required('ACCEPTANCE_APP_WEBHOOK_SECRET') },
    model: { url: required('ACCEPTANCE_BOT_MODEL_URL'), name: required('ACCEPTANCE_BOT_MODEL_NAME'), apiKey: required('ACCEPTANCE_BOT_MODEL_API_KEY') },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { const target = await bootstrap(optionsFromEnv()); console.log(JSON.stringify(target, null, 2)); }
  catch (error) { console.error(`bootstrap failed: ${error.message}`); process.exit(1); }
}
