import { knowledgeFilesApi } from './projects/knowledge-files.js';
import { memoryApi } from './memory/api.js';
import { registerKnowledge } from './memory/management.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readStaticAsset } from './console/modules.js';
import { type Store } from './storage/database.js';
import { actor, publicActor, session, sessionToken } from './app/auth.js';
import { management } from './app/management.js';
import { models } from './app/models.js';
import { queries } from './app/queries.js';
import { boardApi } from './board/api.js';
import { costsApi } from './metrics/api.js';
import { ingest } from './app/webhook.js';
import { type ProjectService } from './projects/service.js';
import { type TaskEngine } from './agent/engine.js';
import type { AutomationConfig } from './automation/config.js';
import { ExternalService } from './external/service.js';
import { type InstallationSync, installationApi } from './app/installations.js';
import { githubAppInstallUrl } from './identity/github-status.js';
import { Onboarding } from './onboarding/service.js';
import { type IntegrationChecker } from './projects/integrations.js';
import { type GateOnboarding } from './projects/gate-onboarding.js';
import { integrationsApi } from './app/integrations.js';
import { gateOnboardingApi } from './app/gate-onboarding.js';
import { RuleService } from './rules/service.js';
import { managerApi } from './work/api.js';
import { settingsApi } from './app/settings.js';
import { StorageReport } from './app/storage.js';
import { serviceRolesApi } from './service-roles/api.js';
import { ProjectRemoval } from './projects/removal.js';
import { ReleaseService } from './releases/service.js';
import { HttpError, digest, fail, fields, hashPassword, object, password, randomId, text, verifyPassword, type Json } from './core/security.js';

import { PublicBoards } from './public-board/service.js';
import { InstallationSetup, githubSetupReturnPath } from './installations/setup.js';
import { type GitHubIdentity, type GitHubOAuthConfig } from './identity/github.js';
import { GitHubLogin } from './identity/github-login.js';
import { identityApi } from './identity/api.js';
import { assertCurrent, authorize } from './identity/authorization.js';
import { resolveActor } from './identity/authorization.js';
import { ManagementService } from './management/service.js';
import { ManagementApi } from './management/api.js';
import { TaskCommands } from './tasks/commands.js';
import { ConfigurationPR } from './management/configuration-pr.js';
import { ChannelService, type ChannelOptions } from './channels/service.js';
import { ChannelApi } from './channels/api.js';
import { ChannelConnections } from './channels/connections.js';
import { ScheduleService } from './schedules/service.js';
import { Scheduler } from './schedules/worker.js';
import { registerScheduledChecks } from './dispatch/schedule.js';
import type { StallMonitor } from './core/stalls.js';
import { loginBucket } from './core/client-address.js';
import { AssistantComputerService, assistantComputersApi } from './service-roles/assistant-computers.js';

interface Options { store: Store; staticDirectory: string; secureCookies?: boolean;
  // BOT_PUBLIC_ORIGIN: the deployment's own origin, always a valid Origin for writes; the wizard's verified address takes over URLs.
  publicOrigin?: string; maxBodyBytes?: number; projects?: ProjectService; engine?: TaskEngine;
  repositoryConfigs?: ReadonlyMap<string, AutomationConfig>; installations?: InstallationSync; external?: ExternalService; onboarding?: Onboarding;
  integrations?: IntegrationChecker; gateOnboarding?: GateOnboarding; githubUrl?: string; releases?: ReleaseService;
  // BOT_IMAGE_TAG of the running deployment; unset when the control plane runs from a source checkout.
  imageTag?: string; boards?: PublicBoards;
  /** Where the assistant computers' HOME volume is mounted (#457); without it they are not offered. */
  assistantHomes?: string; installationSetup?: InstallationSetup; githubOAuth?: GitHubOAuthConfig; githubIdentity?: GitHubIdentity; githubLogin?: GitHubLogin;
  /** Times requests and reports a blocked event loop with the requests in flight. */
  stalls?: StallMonitor;
  // The storage page's report; main.ts starts its background refresh, otherwise the first view refreshes it.
  storage?: StorageReport;
  channels?: ChannelOptions; onChannels?: (service: ChannelService) => void;
  schedules?: { clock?: () => number; automatic?: boolean }; onSchedules?: (scheduler: Scheduler) => void; }
async function body(req: IncomingMessage, limit: number): Promise<{ bytes: Buffer; complete: boolean }> {
  const chunks: Buffer[] = []; let size = 0, complete = true;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk), remaining = limit - size;
    if (bytes.length > remaining) complete = false;
    if (remaining > 0) { chunks.push(bytes.subarray(0, remaining)); size += Math.min(bytes.length, remaining); }
  }
  return { bytes: Buffer.concat(chunks), complete };
}
function respond(res: ServerResponse, status: number, value: Json): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
// Deployment-level trust for the password-login limit, kept out of the shared options object: only the login route
// reads it, and it never travels with requests into the rest of the control plane.
export function createControlPlane(options: Options, security: { trustedProxies?: readonly string[] } = {}) {
  const { store } = options;
  const external = options.external || new ExternalService(store);
  const githubLogin = options.githubLogin || new GitHubLogin(store, {
    identity: options.githubIdentity, environment: () => options.githubOAuth, defaultOrigin: options.publicOrigin,
    apiUrl: options.githubUrl || options.githubOAuth?.apiUrl, webUrl: options.githubOAuth?.webUrl,
  });
  const onboarding = options.onboarding || new Onboarding(store);
  onboarding.options.githubLogin = githubLogin;
  const installationSetup = options.installationSetup || new InstallationSetup(store, {
    verifyInstallation: (session, installation) => githubLogin.identity?.verifyInstallation(session, installation) || Promise.resolve(null),
  });
  const rules = options.engine?.rules || new RuleService(store, options.projects?.manager);
  const taskCommands = new TaskCommands(store,{active:id=>!!options.engine?.active.has(id),tick:()=>{ if(options.engine)queueMicrotask(()=>options.engine!.tick()); }});
  const sharedManagement = new ManagementService(store,rules,taskCommands,options.projects?.manager??options.engine?.manager,options.githubUrl);
  const assistants = new AssistantComputerService(store, options.projects?.manager ?? options.engine?.manager, options.assistantHomes);
  sharedManagement.assistants = assistants;
  registerKnowledge(sharedManagement,options.githubUrl);
  sharedManagement.register('configuration.pr',new ConfigurationPR(sharedManagement,options.githubUrl));
  const managementApi = new ManagementApi(sharedManagement);
  const channels = new ChannelService(store, managementApi.agent, { ...options.channels, githubUrl:options.channels?.githubUrl??options.githubUrl, manager:options.channels?.manager??options.projects?.manager??options.engine?.manager, get origin() { return options.channels?.origin || githubLogin.origin || options.publicOrigin; } });
  const channelApi = new ChannelApi(channels), channelConnections = new ChannelConnections(channels);
  options.onChannels?.(channels);
  const schedules = new ScheduleService(store, sharedManagement, channels, options.schedules?.clock);
  registerScheduledChecks(schedules);
  const scheduler = new Scheduler(schedules); options.onSchedules?.(scheduler);
  const removal = new ProjectRemoval(store, options.installations, options.projects, options.engine);
  const storage = options.storage ?? new StorageReport(store, options.projects?.manager);
  const releases = options.releases || new ReleaseService(store, options.githubUrl);
  const loginAttempts = new Map<string, { n: number; until: number }>();
  const requestOrigin = (req: IncomingMessage) => `${options.secureCookies ? 'https' : 'http'}://${req.headers.host}`;
  const deploymentOrigin = (req: IncomingMessage) => options.publicOrigin || requestOrigin(req);
  const loopback = (req: IncomingMessage) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL('http://' + req.headers.host).hostname); } catch { return false; } };
  // Writes come from the deployment origin, the single public entry, or a console address saved before the single entry.
  // A browser on this machine stays writable even when those name another address: DNS rebinding cannot send a loopback Host.
  const writableOrigins = (req: IncomingMessage) => [deploymentOrigin(req), githubLogin.entry, githubLogin.savedOrigin, ...(loopback(req) ? [requestOrigin(req)] : [])];
  const secureCookie = (req: IncomingMessage) => {
    if (options.secureCookies) return true;
    // Login/logout POSTs have already passed the Origin fence; a new alias must not change local recovery cookies.
    if (req.method === 'POST' && req.headers.origin) return req.headers.origin.startsWith('https:');
    return options.publicOrigin?.startsWith('https:') ||
      [githubLogin.entry, githubLogin.savedOrigin].some(origin => origin?.startsWith('https:') && new URL(origin).host === req.headers.host);
  };
  const cookie = (req: IncomingMessage, token: string, age = 43200) => `bot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secureCookie(req) ? '; Secure' : ''}`;
  const browserCookie = (req: IncomingMessage, token: string) => `bot_oauth=${token}; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=600${secureCookie(req) ? '; Secure' : ''}`;
  const browserToken = (req: IncomingMessage) => req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('bot_oauth='))?.slice(10) || '';
  const initialized = () => !!store.get("SELECT 1 FROM settings WHERE key='initialized'");
  // Errors contain stable codes only: never echo a request, credential, SQL statement or stack.
  const wrap = (fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => async (req: IncomingMessage, res: ServerResponse) => {
    const done = options.stalls?.request(req.method || 'GET', req.url); if (done) res.on('close', done);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' https://avatars.githubusercontent.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com");
    try { await fn(req, res); }
    catch (error) {
      if (!res.headersSent) respond(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.code : 'service_unavailable', ...(error instanceof HttpError && error.field ? { field: error.field } : {}) });
      else res.end();
    }
  };
  // The single business listener. GitHub and Feishu deliveries, external executors and public boards come first: each
  // authenticates itself (signature, token or published board) and never needs a browser session, Origin or CSRF token.
  // The console, OAuth and App callbacks follow with their own checks; manager and tunnel interfaces are never served here.
  const server = createServer(wrap(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost'), path = url.pathname, method = req.method || 'GET';
    if (method === 'GET' && path === '/.well-known/bot-webhook-probe') { respond(res, 200, onboarding.probe(url.searchParams.get('nonce') || '')); return; }
    if (options.boards && /^\/(dashboard|boards)(\/|$)/.test(path)) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self' https://api.github.com; frame-ancestors 'none'; base-uri 'none'");
      if (await options.boards.serve(req, res, url)) return;
    }
    if (req.method === 'GET' && path === '/healthz') { store.get('SELECT 1'); respond(res, 200, { ok: true }); return; }
    const feishu = /^\/hooks\/feishu\/([a-f0-9]{48})$/.exec(path);
    if (req.method === 'POST' && feishu) {
      const raw = await body(req, 2 * 1024 * 1024); if (!raw.complete) fail(413, 'payload_too_large');
      respond(res, 200, channels.receiveHTTP(feishu[1]!, req.headers, raw.bytes)); return;
    }
    if(req.method==='GET'&&path==='/external/events'){
      if(url.search)fail(400,'unexpected_query');
      await external.events.poll(String(req.headers.authorization||''),value=>new Promise<void>((resolve,reject)=>{
        if(res.destroyed){reject(new Error('response_closed'));return;}
        const cleanup=()=>{res.off('finish',finish);res.off('close',close);res.off('error',close);};
        const finish=()=>{cleanup();resolve();},close=()=>{cleanup();reject(new Error('response_closed'));};
        res.once('finish',finish);res.once('close',close);res.once('error',close);
        respond(res,200,value);
      }));return;
    }
    if(req.method==='POST'&&['/external/token','/external/revoke'].includes(path)){
      if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'json_required');
      const input=await body(req,16384);if(!input.complete)fail(413,'payload_too_large');
      let value:Json;try{value=object(JSON.parse(input.bytes.toString('utf8')));}catch{return fail(400,'invalid_json');}
      respond(res,200,await external.publicApi(path,value,String(req.headers.authorization||'')));return;
    }
    const match = /^\/hooks\/github\/([a-f0-9]{48})\/([a-f0-9]{48})$/.exec(path);
    if (method === 'POST' && match) {
      const input = await body(req, options.maxBodyBytes ?? 2 * 1024 * 1024);
      const result = await ingest(store, match[1]!, match[2]!, req.headers, input.bytes, input.complete, options.repositoryConfigs, options.githubUrl);
      respond(res, result.status, result.response);
      // Installation changes are already recorded; a full listing follows outside the delivery path.
      if (result.status === 200 && 'sync' in result && result.sync) options.installations?.schedule(match[1]!);
      return;
    }
    const githubIdentity = githubLogin.identity;
    if (method === 'GET' && path === '/api/auth/github/status') { respond(res, 200, { enabled: !!githubIdentity }); return; }
    if (method === 'GET' && path === '/auth/channels/start') {
      const challenge = text(url.searchParams.get('challenge'));
      channels.bindings.request(challenge);
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
      res.writeHead(303, { Location: '/#/identity/feishu?challenge=' + encodeURIComponent(challenge) }); res.end(); return;
    }
    if (method === 'GET' && path === '/auth/github/start') {
      if (!initialized()) return fail(409, 'local_recovery_setup_required');
      if (!githubIdentity) return fail(503, 'github_login_not_configured');
      const channelChallenge = url.searchParams.get('channel_challenge');
      if (channelChallenge !== null) channels.bindings.request(text(channelChallenge));
      const browser = randomId(), result = githubIdentity.begin(browser, 'login');
      if (channelChallenge !== null) channels.bindings.associateOAuth(channelChallenge, new URL(result.url).searchParams.get('state')!);
      res.setHeader('Set-Cookie', browserCookie(req, browser)); res.writeHead(303, { Location: result.url }); res.end(); return;
    }
    if (method === 'GET' && path === '/auth/github/callback') {
      if (!githubIdentity) return fail(503, 'github_login_not_configured');
      res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        const result = await githubIdentity.callback(browserToken(req), url.searchParams.get('state') || '', url.searchParams.get('code') || '', sessionToken(req));
        const credentials = store.transaction(() => {
          if (githubLogin.identity !== githubIdentity) return fail(409, 'github_login_configuration_changed');
          return session(store, result.principal_id, result.identity_id);
        });
        const channelBinding = await channels.bindings.githubAuthenticated(url.searchParams.get('state') || '', credentials.token);
        if (result.setup_state) installationSetup.bindIdentity(result.setup_state, githubIdentity.sessionReference(credentials.token));
        res.setHeader('Set-Cookie', [cookie(req, credentials.token), browserCookie(req, '')]); res.writeHead(303, { Location: channelBinding ? '/?github_auth=1#/identity/feishu' : '/?github_auth=1#/identity' }); res.end();
      } catch (error) {
        const code = error instanceof HttpError ? error.code : 'github_oauth_unavailable';
        res.writeHead(303, { Location: '/?auth_error=' + encodeURIComponent(code) + '#/identity' }); res.end();
      } return;
    }
    if (method === 'GET' && path === '/onboarding/github/callback') {
      await onboarding.callback(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
      // The App now exists; continue with user-login configuration inside global settings.
      res.writeHead(303, { Location: '/#/settings/onboarding/2' }); res.end(); return;
    }
    if (method === 'GET' && path === '/onboarding/github/setup') {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      const result = await installationSetup.callback(url.searchParams.get('state') || '', url.searchParams.get('installation_id') || '', url.searchParams.get('setup_action') || 'install');
      const status = result && typeof result === 'object' && !Array.isArray(result) && typeof (result as { status?: unknown }).status === 'string' ? (result as { status: string }).status : 'ready';
      res.writeHead(303, { Location: githubSetupReturnPath(status) }); res.end(); return;
    }
    const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/locale-boot.js': ['locale-boot.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/i18n.js': ['i18n.js', 'text/javascript'], '/channels.js': ['channels.js', 'text/javascript'], '/feishu-setup.js': ['feishu-setup.js', 'text/javascript'], '/identity.js': ['identity.js', 'text/javascript'], '/management.js': ['management.js','text/javascript'], '/schedules.js': ['schedules.js','text/javascript'], '/subscriptions.js':['subscriptions.js','text/javascript'], '/subscriptions.css':['subscriptions.css','text/css'], '/schedule-records.js':['schedule-records.js','text/javascript'], '/schedule-records.css':['schedule-records.css','text/css'], '/style.css': ['style.css', 'text/css'],
      '/views.js': ['views.js', 'text/javascript'], '/gate-onboarding.js': ['gate-onboarding.js', 'text/javascript'], '/views.css': ['views.css', 'text/css'], '/board.js': ['board.js', 'text/javascript'], '/board.css': ['board.css', 'text/css'], '/metrics.js':['metrics.js','text/javascript'], '/costs.js':['costs.js','text/javascript'], '/costs.css':['costs.css','text/css'],'/design.js':['design.js','text/javascript'], '/design.css':['design.css','text/css'], '/external.js':['external.js','text/javascript'], '/release.js':['release.js','text/javascript'], '/release.css':['release.css','text/css'], '/project.js': ['project.js', 'text/javascript'], '/manager.js': ['manager.js', 'text/javascript'], '/roles.js': ['roles.js', 'text/javascript'], '/settings.js': ['settings.js', 'text/javascript'], '/onboarding.js': ['onboarding.js', 'text/javascript'],
      '/knowledge.js':['knowledge.js','text/javascript'], '/knowledge.css':['knowledge.css','text/css'],
      '/channel-console.js': ['channel-console.js', 'text/javascript'], '/channel-console.css': ['channel-console.css', 'text/css'],
      '/schedules.css': ['schedules.css','text/css'],
      '/access.css': ['access.css', 'text/css'],
      '/gates.css': ['gates.css','text/css'],
      '/workspace.js': ['workspace.js', 'text/javascript'], '/workspace.css': ['workspace.css', 'text/css'],
      '/task-create.js': ['task-create.js', 'text/javascript'], '/task-create.css': ['task-create.css', 'text/css'],
      '/shell.js': ['shell.js', 'text/javascript'], '/shell.css': ['shell.css', 'text/css'], '/models.css': ['models.css', 'text/css'], '/management.css': ['management.css', 'text/css'], '/vendor/marked.js': ['../node_modules/marked/lib/marked.umd.js', 'text/javascript'], '/vendor/purify.js': ['../node_modules/dompurify/dist/purify.min.js', 'text/javascript'],
      '/docs/external-token-api.md': ['../docs/external-token-api.md', 'text/plain'], '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    if (method === 'GET' && assets[path]) {
      const [name, mime] = assets[path]; const bytes = await readStaticAsset(options.staticDirectory, name);
      const type = mime.startsWith('image/') ? mime : `${mime}; charset=utf-8`;
      res.writeHead(200, { 'Content-Type': type }); res.end(bytes); return;
    }
    if (!path.startsWith('/api/')) return fail(404, 'not_found');
    if (path === '/api/setup' && method === 'GET') { respond(res, 200, { initialized: initialized() }); return; }
    const mutation = !['GET', 'HEAD'].includes(method);
    if (mutation && req.headers.origin) {
      if (!writableOrigins(req).includes(req.headers.origin)) fail(403, 'origin_forbidden');
    }
    if (path === '/api/setup' && method === 'POST' && initialized()) fail(409, 'already_initialized');
    const publicRequest = path === '/api/setup' && method === 'POST' || path === '/api/auth/login' && method === 'POST';
    let user = publicRequest ? null : actor(store, req);
    if (user && mutation && req.headers['x-csrf-token'] !== user.csrf) fail(403, 'csrf_required');
    let input: Json = {};
    if (mutation) {
      if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'json_required');
      // Notes and the Manager prompt are written as administrators write them, without a size limit of their own.
      const noteWrite = (['PUT','POST'].includes(method) && /^\/api\/repositories\/[^/]+\/knowledge-files(?:\/[^/]+)?$/.test(path)) || method === 'PUT' && (/^\/api\/repositories\/[^/]+\/notes\/[^/]+$/.test(path) || /^\/api\/repositories\/[^/]+\/manager$/.test(path));
      const raw = await body(req, noteWrite ? Infinity : 1024 * 1024);
      if (!raw.complete) fail(413, 'payload_too_large');
      try { input = object(JSON.parse(raw.bytes.toString('utf8'))); }
      catch (error) { if (error instanceof HttpError) throw error; fail(400, 'invalid_json'); }
    }
    if (path === '/api/setup' && method === 'POST') {
      fields(input, ['username', 'password']);
      const username = text(input.username, 100), encoded = await hashPassword(password(input.password)), id = randomId();
      const credentials = store.transaction(() => {
        // Recheck after the asynchronous hash, under SQLite's write lock.
        if (initialized() || store.get("SELECT 1 FROM users WHERE role='super_admin'")) fail(409, 'already_initialized');
        store.run("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,'super_admin')", id, username, encoded);
        store.run("INSERT INTO settings VALUES('initialized','1')");
        store.audit(id, 'system.initialized', id);
        return session(store, id);
      });
      res.setHeader('Set-Cookie', cookie(req, credentials.token)); respond(res, 201, { ok: true, csrf_token: credentials.csrf }); return;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      fields(input, ['username', 'password']);
      const username = text(input.username, 100), value = password(input.password);
      // A reverse proxy hides every client behind its own address; the configured proxies name the real one.
      const key = loginBucket(req, security.trustedProxies || []);
      const now = Date.now();
      for (const [ip, count] of loginAttempts) if (count.until <= now) loginAttempts.delete(ip);
      const attempt = loginAttempts.get(key) || { n: 0, until: now + 15 * 60_000 };
      if (attempt.n >= 20 || loginAttempts.size > 10000) fail(429, 'login_rate_limited');
      attempt.n++; loginAttempts.set(key, attempt);
      const row = store.get('SELECT * FROM users WHERE username=? AND active=1', username);
      const valid = row ? await verifyPassword(value, row.password_hash) : (await hashPassword(value), false);
      if (!valid) fail(401, 'invalid_login');
      // A concurrent administrator may have disabled this user during hashing.
      if (!store.get('SELECT id FROM users WHERE id=? AND active=1', row!.id)) fail(401, 'invalid_login');
      const credentials = store.transaction(() => session(store, row!.id)); loginAttempts.delete(key);
      // Signing in to an account bound to GitHub checks its GitHub permissions again (#708). A failed check only leaves its
      // derived grants pending; super administrators and accounts with explicit delegation are never checked.
      try { await githubIdentity?.renew(row!.id); } catch { /* the session stands; the background refresh tries again */ }
      res.setHeader('Set-Cookie', cookie(req, credentials.token)); respond(res, 200, { ok: true, csrf_token: credentials.csrf }); return;
    }
    if (!user) return fail(401, 'login_required');
    if (path === '/api/auth/me' && method === 'GET') { respond(res, 200, publicActor(user)); return; }
    if (path === '/api/identity/github/bind' && method === 'POST') {
      fields(input, ['setup_state']);
      if (!githubIdentity) return fail(503, 'github_login_not_configured');
      const browser = randomId(), result = githubIdentity.begin(browser, 'bind', sessionToken(req), input.setup_state === undefined ? null : text(input.setup_state));
      res.setHeader('Set-Cookie', [cookie(req, sessionToken(req)), browserCookie(req, browser)]); respond(res, 201, result); return;
    }
    if (path === '/api/identity/github/install' && method === 'POST') {
      fields(input, []);
      if (!githubIdentity) return fail(503, 'github_login_not_configured');
      const installUrl = githubAppInstallUrl(store);
      const raw = store.get('SELECT value FROM settings WHERE key=?', 'onboarding.app')?.value;
      let accountId: string | undefined;
      if (typeof raw === 'string' && raw) {
        try {
          const saved = JSON.parse(raw) as { account_id?: unknown };
          if (typeof saved.account_id === 'string' && saved.account_id) accountId = saved.account_id;
        } catch { /* malformed onboarding state is treated as unconfigured */ }
      }
      if (!installUrl || !accountId) return fail(409, 'github_app_not_configured');
      const intent = installationSetup.begin(accountId);
      installationSetup.bindIdentity(intent.state, githubIdentity.sessionReference(sessionToken(req)));
      const url = new URL(installUrl);
      url.searchParams.set('state', intent.state);
      respond(res, 201, { url: url.href }); return;
    }
    if (path === '/api/identity/refresh' && method === 'POST') {
      fields(input, []);
      let status: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (githubIdentity) {
          // Bound so a stalled GitHub call cannot leave the console on "正在验证…" with no result.
          status = await Promise.race([
            githubIdentity.reverify(user.id),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, 'github_verification_unavailable')), 20_000); })
          ]);
        }
        respond(res, 200, { ok: true, status: status ?? null }); return;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      fields(input, []);
      const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('bot_session='))?.slice(12) || '';
      store.run('DELETE FROM sessions WHERE token_hash=?', digest(token));
      res.setHeader('Set-Cookie', cookie(req, '', 0)); respond(res, 200, { ok: true }); return;
    }
    if (path === '/api/channels/bindings/confirm' && method === 'POST') {
      fields(input, ['code', 'connector_id']);
      const result = await channels.bindings.confirmCode(text(input.code, 100), text(input.connector_id), sessionToken(req));
      respond(res, 201, { state: 'bound', ...result }); return;
    }
    if (path === '/api/channels/bindings/issue' && method === 'POST') {
      fields(input, ['connector_id']);
      // The console writes a one-time code for the chosen bot; the private-chat message carrying it completes the binding.
      respond(res, 201, channels.bindings.issue(text(input.connector_id, 48), sessionToken(req))); return;
    }
    const bindingRequest = /^\/api\/channels\/bindings\/requests\/([a-f0-9]{64})$/.exec(path);
    if (bindingRequest && method === 'GET') {
      respond(res, 200, channels.bindings.requestStatus(bindingRequest[1]!, sessionToken(req))); return;
    }
    if (path === '/api/channels/bindings/claim' && method === 'POST') {
      fields(input, ['challenge']);
      // Binding proves the platform session; repository grants and GitHub availability are unrelated to association.
      await channels.bindings.authenticate(text(input.challenge), sessionToken(req));
      respond(res, 201, { state: 'pending_confirmation' }); return;
    }
    if (path === '/api/status' && method === 'GET') {
      respond(res, 200, { review_available: true, development_available: true, project_environments_available: true, model_calls_available: true }); return;
    }
    if (path.startsWith('/api/environments') && !options.projects) fail(503, 'manager_not_configured');
    // Writes are decided against the stored grants (#708): only a principal whose GitHub proof lapsed verifies, once, joining
    // a check already in flight. Everyone else's write sends nothing to GitHub.
    if (mutation && githubIdentity && await githubIdentity.renewIfLapsed(user.id)) user = actor(store, req);
    const current = user, context = current.context!;
    if (path.startsWith('/api/channels/')) {
      const result = await channelApi.api(context, method, url, input);
      if (mutation && options.channels?.longConnections !== false) channelConnections.reconcile();
      respond(res, method === 'POST' ? 201 : 200, result); return;
    }
    if(path.startsWith('/api/management/')){
      const managementActor=resolveActor(store,sessionToken(req),{channel:path.includes('/conversations')?'web':'api'});
      if(method==='GET'&&url.searchParams.get('stream')==='1')await managementApi.stream(managementActor,url,res);
      else respond(res,method==='POST'?201:200,(await managementApi.api(managementActor,method,url,input))!);
      return;
    }
    let resourceProject = /^\/api\/repositories\/([^/]+)/.exec(path)?.[1];
    const taskId = /^\/api\/tasks\/([^/]+)/.exec(path)?.[1];
    if (taskId) resourceProject = store.get('SELECT repository_id FROM tasks WHERE id=?', taskId)?.repository_id;
    const capability = /\/releases(?:\/|$)/.test(path) ? 'release.manage' : /\/roles(?:\/|$)/.test(path) ? 'roles.edit'
      : /\/(?:memory|memories|knowledge|knowledge-files|knowledge-directories|notes)(?:\/|$)/.test(path) ? 'knowledge.write' : path.startsWith('/api/tasks') ? 'tasks.write' : 'config.write';
    // Every write and GitHub call rechecks the current grants (#521): the guard authorizes the target project, and
    // assertCurrent replays whatever else this request was authorized for once the principal has lost some authority.
    const guard = () => {
      assertCurrent(context);
      if (mutation) {
        if (resourceProject) {
          if (current.role !== 'super_admin' && !current.repositories.includes(resourceProject)) fail(403, 'repository_forbidden');
          authorize(context, capability, { project_id: resourceProject });
        }
        for (const field of ['repository_id', 'project_id']) if (typeof input[field] === 'string') authorize(context, capability, { project_id: input[field] as string });
      }
    };
    guard();
    const result = await store.withAuthorizationGuard(guard, async () => identityApi(store, current, sessionToken(req), method, url, input) ?? await releases.api(user,method,url,input) ?? await settingsApi(store,user,method,path,input,options.imageTag,options.projects?.manager,assistants) ?? await assistantComputersApi(assistants,user,method,path) ?? await storage.api(user,method,path,input) ?? serviceRolesApi(store,user,method,path,input) ?? boardApi(store,user,method,url,input) ?? await onboarding.api(user,method,url,input, mutation && req.headers.origin || deploymentOrigin(req)) ?? await managementApi.manager(context,method,url,input) ?? await managementApi.task(context,method,url,input) ?? await managerApi(store,rules,user,method,url,input) ?? await rules.api(user,method,url,input) ?? external.api(user,method,url,input) ?? await knowledgeFilesApi(store,options.projects?.manager,user,method,url,input,options.githubUrl) ?? await memoryApi(store,user,method,url,input,options.githubUrl) ?? await options.engine?.api(user,method,url,input) ?? taskCommands.api(user,method,url,input) ?? await removal.api(user,method,url,input) ?? await installationApi(store, options.installations, user, method, url, input, githubIdentity ? { verifyInstallation: (_ref, installation) => githubIdentity.verifyInstallation(sessionToken(req), installation) } : undefined) ?? await options.projects?.api(user, method, url, input) ?? (options.integrations ? await integrationsApi(store, options.integrations, user, method, url, input) : undefined) ?? await gateOnboardingApi(options.gateOnboarding, user, method, url, input) ?? await management(store, user, method, url, input) ?? await models(store, user, method, url, input)
      ?? (method === 'GET' ? costsApi(store,user,url) ?? queries(store, user, url) : undefined));
    if (!result) return fail(404, 'not_found');
    // List visibility, board publication and notes never change the desired state of a project computer.
    const consoleOnly = /^\/api\/installations\/[1-9]\d*(?:\/(?:restore|board))?$/.test(path) || /^\/api\/repositories\/[^/]+\/(?:notes|knowledge-files|knowledge-directories|releases)(?:\/.*)?$/.test(path);
    if (mutation && !consoleOnly && (path.startsWith('/api/repositories') || path.startsWith('/api/installations') || path === '/api/settings')) void options.projects?.reconcile().catch(() => {});
    respond(res, method === 'POST' ? 201 : 200, result);
  }));
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  let connectionTimer: ReturnType<typeof setInterval>;
  server.once('listening', () => {
    channels.start(); assistants.start();
    if (options.schedules?.automatic !== false) scheduler.start();
    if (options.channels?.longConnections !== false) {
      channelConnections.reconcile();
      connectionTimer = setInterval(() => channelConnections.reconcile(), 1000); connectionTimer.unref();
    }
  });
  let drained:Promise<unknown>=Promise.resolve();
  server.once('close',()=>{ clearInterval(connectionTimer); channels.close(); channelConnections.close(); drained=Promise.allSettled([channels.drain(),assistants.close(),scheduler.close(),managementApi.agent.close()]); });
  const close=server.close.bind(server);
  // The caller may close SQLite after this callback; every background consumer must have finished first.
  server.close=((callback?: (error?:Error)=>void)=>close(error=>{void drained.then(()=>callback?.(error));})) as typeof server.close;
  return { server };
}
