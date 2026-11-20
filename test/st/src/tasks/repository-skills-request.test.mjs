// #1171: Whole-directory trusted base-branch `.agents/skills/` auto-mounting across generic tasks (Pi & Native roles)
// and Event Dispatch Manager (`read_skill`), with strict path & untrusted-PR/branch boundaries.
const previousModelTransport = process.env.BOT_HARNESS_MODEL_TRANSPORT;
process.env.BOT_HARNESS_MODEL_TRANSPORT = 'gateway';
import test, { after } from 'node:test';
after(() => {
  if (previousModelTransport === undefined) delete process.env.BOT_HARNESS_MODEL_TRANSPORT;
  else process.env.BOT_HARNESS_MODEL_TRANSPORT = previousModelTransport;
});
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { treeHash } from '../../../fixtures/agent-server.mjs';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { configureDispatch, Dispatcher, ruleDecider } from '../../../../dist/dispatch/worker.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import { recordEvent } from '../../../../dist/dispatch/store.js';
import { nativeRoles } from '../../../fixtures/native-roles.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { setGrant } from '../../../../dist/tasks/grants.js';

const gitObjHash = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

function createSkillGitHubFixture() {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const putBlob = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const sha = gitObjHash('blob', bytes);
    blobs.set(sha, bytes);
    return { sha, size: bytes.length };
  };
  const putCommit = (filesMap, parent = null, message = 'commit') => {
    const entries = Object.entries(filesMap).map(([path, spec]) => {
      const normalized = typeof spec === 'string' || Buffer.isBuffer(spec) ? { data: spec, mode: '100644', type: 'blob' } : spec;
      const { sha, size } = putBlob(normalized.data);
      return {
        path,
        mode: normalized.mode || '100644',
        type: normalized.type || 'blob',
        sha,
        size: normalized.size ?? size,
      };
    });
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const treeSha = treeHash(entries);
    trees.set(treeSha, entries);
    const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ treeSha, parent, message, n: commits.size })));
    commits.set(sha, { sha, tree: { sha: treeSha }, parents: parent ? [{ sha: parent }] : [] });
    return sha;
  };

  const trustedFiles = {
    'calc.mjs': 'export const add = (a, b) => a + b;\n',
    'AGENTS.md': '# Trusted Repository Guide\nTRUSTED_MAIN_AGENTS_MD_1171\n',
    '.agents/skills/calc-ops/SKILL.md': [
      '---',
      'name: calc-ops',
      'description: Arithmetic verification workflow; read ./config.json and references/checklist.md.',
      '---',
      '# Calc Ops',
      'Follow ./config.json, references/checklist.md, and scripts/verify.sh.',
    ].join('\n'),
    '.agents/skills/calc-ops/config.json': JSON.stringify({ expected_sum: 5, marker: 'CONFIG_SENTINEL_1171' }),
    '.agents/skills/calc-ops/references/checklist.md': '# Checklist\nCHECKLIST_SENTINEL_1171\n',
    '.agents/skills/calc-ops/scripts/verify.sh': '#!/bin/sh\necho SCRIPT_SENTINEL_1171\n',
    '.agents/skills/plain-guide/SKILL.md': '# Plain Repository Skill\nInspect assets/template.txt when formatting reports.\n',
    '.agents/skills/plain-guide/assets/template.txt': 'ASSET_SENTINEL_1171\n',
    // Business/test SKILL.md files outside `.agents/skills/` (including binary/nested shapes) must be completely ignored by skill loading.
    'plugins/billing/SKILL.md': '---\nname: billing-plugin\ndescription: DO_NOT_MOUNT_PLUGIN_SKILL\n---\nBUSINESS_PLUGIN_SENTINEL\n',
    'tests/fixtures/SKILL.md': 'BUSINESS_TEST_BINARY_SKILL\0DO_NOT_REJECT_OR_MOUNT',
    'harness/demo/SKILL.md': '# Internal harness demo skill\nDO_NOT_MOUNT_HARNESS_SKILL\n',
  };

  const mainSha = putCommit(trustedFiles, null, 'trusted main');
  const untrustedPrSha = putCommit({
    ...trustedFiles,
    'calc.mjs': 'export const add = (a, b) => a - b;\n',
    'AGENTS.md': '# Untrusted PR Injection\nEVIL_PR_AGENTS_MD_1171\n',
    'CLAUDE.md': 'EVIL_PR_CLAUDE_MD_1171\n',
    '.pi/skills/evil-pi/SKILL.md': '---\nname: evil-pi\ndescription: EVIL_PI_SKILL_1171\n---\nEVIL_PI_BODY_1171\n',
    '.agents/skills/calc-ops/SKILL.md': '---\nname: calc-ops\ndescription: EVIL_UNTRUSTED_PR_OVERRIDE\n---\nEVIL_PR_BODY\n',
    '.agents/skills/calc-ops/references/checklist.md': 'EVIL_PR_CHECKLIST\n',
    '.agents/skills/injected/SKILL.md': '---\nname: injected\ndescription: INJECTED_UNTRUSTED_PR_SKILL\n---\nEVIL_INJECTED\n',
  }, mainSha, 'external untrusted PR');

  const state = {
    trustedFiles,
    mainSha,
    untrustedPrSha,
    refs: { main: mainSha, 'feat/untrusted': untrustedPrSha },
    requests: [],
    postedComments: [],
    pulls: new Map([
      [88, {
        id: 5088,
        number: 88,
        title: 'External PR touching calc and skills',
        body: 'Proposed changes from external contributor.',
        state: 'open',
        draft: false,
        user: { id: 800, login: 'external-user' },
        head: { sha: untrustedPrSha, ref: 'feat/untrusted', repo: { id: 101 } },
        base: { sha: mainSha, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.invalid/101/pull/88',
      }],
    ]),
    prFiles: [
      { filename: 'calc.mjs', status: 'modified', patch: '@@ -1 +1 @@\n-export const add = (a, b) => a + b;\n+export const add = (a, b) => a - b;' },
      { filename: 'AGENTS.md', status: 'modified', patch: '@@ -1,2 +1,2 @@\n+EVIL_PR_AGENTS_MD_1171' },
      { filename: '.pi/skills/evil-pi/SKILL.md', status: 'added', patch: '@@ -0,0 +1,4 @@\n+EVIL_PI_BODY_1171' },
      { filename: '.agents/skills/calc-ops/SKILL.md', status: 'modified', patch: '@@ -1,6 +1,4 @@\n+EVIL_PR_BODY' },
      { filename: '.agents/skills/injected/SKILL.md', status: 'added', patch: '@@ -0,0 +1,4 @@\n+EVIL_INJECTED' },
    ],
  };

  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://github.fixture');
    const path = decodeURIComponent(url.pathname);
    const page = Number(url.searchParams.get('page') || 1);
    state.requests.push({ method: req.method, path });
    const send = (val, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(val));
    };

    if (path === '/app') return send({ id: 77, slug: 'dept-bot', name: 'dept-bot' });
    if (path === '/user' || path === '/users/dept-bot[bot]') return send({ id: 999, login: 'dept-bot[bot]' });
    if (path === '/repos/fixture/project-101/installation') {
      return send({
        id: 55,
        account: { id: 10, login: 'fixture' },
        permissions: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'read', checks: 'read', statuses: 'read', metadata: 'read' },
      });
    }
    if (path === '/app/installations/55/access_tokens') {
      const body = raw ? JSON.parse(raw) : {};
      return send({ token: 'ghs_skill_' + randomBytes(6).toString('hex'), expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions || {} }, 201);
    }
    if (path === '/installation/token' && req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }
    if (path === '/repositories/101' || path === '/repos/fixture/project-101') {
      return send({ id: 101, full_name: 'fixture/project-101', owner: { id: 10, login: 'fixture' }, default_branch: 'main' });
    }
    const prefix = '/repos/fixture/project-101';
    if (!path.startsWith(prefix)) return send({ message: 'Not Found' }, 404);
    const sub = path.slice(prefix.length);
    let m;
    if (sub === '/labels') return send([]);
    if ((m = /^\/pulls\/(\d+)$/.exec(sub))) {
      const pr = state.pulls.get(Number(m[1]));
      return send(pr || { message: 'Not Found' }, pr ? 200 : 404);
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(sub))) return send(page === 1 ? state.prFiles : []);
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(sub)) && req.method === 'POST') {
      const bodyObj = raw ? JSON.parse(raw) : {};
      const comment = { id: 9000 + state.postedComments.length + 1, body: bodyObj.body || '', user: { id: 999, login: 'dept-bot[bot]' }, html_url: `https://github.invalid/101/pull/${m[1]}#issuecomment-1` };
      state.postedComments.push(comment);
      return send(comment, 201);
    }
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(sub)) && req.method === 'POST') {
      const bodyObj = raw ? JSON.parse(raw) : {};
      const names = Array.isArray(bodyObj) ? bodyObj : bodyObj.labels || [];
      return send(names.map(name => ({ name })), 200);
    }
    if (/^\/(?:pulls|issues)\/\d+\/(?:comments|reviews)$/.test(sub)) return send([]);
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub))) {
      const sha = state.refs[m[1]];
      return sha ? send({ ref: `refs/heads/${m[1]}`, object: { sha } }) : send({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/commits\/(.+)$/.exec(sub))) {
      const c = commits.get(m[1]);
      return send(c || { message: 'Not Found' }, c ? 200 : 404);
    }
    if ((m = /^\/git\/trees\/(.+)$/.exec(sub))) {
      const tree = trees.get(m[1]);
      return send(tree ? { sha: m[1], tree, truncated: false } : { message: 'Not Found' }, tree ? 200 : 404);
    }
    if ((m = /^\/git\/blobs\/(.+)$/.exec(sub))) {
      const b = blobs.get(m[1]);
      return send(b ? { sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64') } : { message: 'Not Found' }, b ? 200 : 404);
    }
    return send({ message: 'Not Found: ' + path }, 404);
  });

  return { server, state, privateKey, putCommit };
}

const msgText = content =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p?.text ?? '').join('') : '';

const callTool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'tc_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('#1171 Pi role auto-mounts whole .agents/skills/ directory with companion files & plain SKILL.md without manual skill_bundle_ref, ignoring non-.agents SKILL.md', { timeout: 90000 }, async t => {
  configureDispatch(null);
  t.after(() => configureDispatch(ruleDecider));

  const root = mkdtempSync(join(tmpdir(), 'bot-1171-pi-'));
  const computer = new LocalManager('101', root);
  const ghFixture = createSkillGitHubFixture();
  ghFixture.server.listen(0, '127.0.0.1');
  await once(ghFixture.server, 'listening');
  const ghUrl = `http://127.0.0.1:${ghFixture.server.address().port}`;

  const observed = { systemTexts: [], companionConfig: '', checklist: '', plainAsset: '', scriptOut: '', serverError: null };

  const modelServer = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const messages = body.messages || [];
      const tools = (body.tools || []).map(t => t.function.name);
      const sys = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => msgText(m.content)).join('\n');

      if (tools.includes('submit_acceptance')) {
        const qaReply = callTool('submit_acceptance', {
          outcome: 'pass',
          reason: 'Verified report.',
          gaps: [],
          residuals: [],
          core_complete: true,
          required_evidence_complete: true,
          acceptable_risk: true,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: qaReply }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        return;
      }

      observed.systemTexts.push(sys);

      // Extract staged skill locations injected by Pi's DefaultResourceLoader (must come from staged bot-role/repository, never untrusted checkout .agents/skills)
      const calcMatch = /<location>([^<]*\/repository\/calc-ops\/SKILL\.md)<\/location>/.exec(sys);
      const plainMatch = /<location>([^<]*\/repository\/plain-guide\/SKILL\.md)<\/location>/.exec(sys);
      assert.ok(calcMatch, `Pi resource loader must discover staged calc-ops/SKILL.md; sys tail=${sys.slice(-1200)}`);
      assert.ok(plainMatch, `Pi resource loader must discover staged plain-guide/SKILL.md (without frontmatter); sys tail=${sys.slice(-1200)}`);
      assert.ok(!sys.includes('billing-plugin') && !sys.includes('DO_NOT_MOUNT_PLUGIN_SKILL'), 'Business directory SKILL.md must never be mounted');
      assert.ok(!sys.includes('EVIL_UNTRUSTED_PR_OVERRIDE') && !sys.includes('INJECTED_UNTRUSTED_PR_SKILL') && !sys.includes('/injected/SKILL.md'), 'Untrusted PR .agents/skills in checkout must never be loaded by Pi');
      assert.ok(!sys.includes('evil-pi') && !sys.includes('EVIL_PI_SKILL_1171') && !sys.includes('EVIL_PI_BODY_1171'), 'Untrusted PR .pi/skills in checkout must never be loaded by Pi');
      assert.ok(!sys.includes('EVIL_PR_AGENTS_MD_1171') && !sys.includes('EVIL_PR_CLAUDE_MD_1171'), 'Untrusted PR AGENTS.md/CLAUDE.md in checkout must never be loaded by Pi');
      assert.match(sys, /TRUSTED_MAIN_AGENTS_MD_1171/, 'Pi on untrusted PR checkout must still receive trusted base-branch AGENTS.md');

      const calcDir = dirname(calcMatch[1]);
      const plainDir = dirname(plainMatch[1]);
      const calls = messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const toolMsgs = messages.filter(m => m.role === 'tool').map(m => msgText(m.content));

      let reply;
      if (calls.length === 0) {
        reply = callTool('read', { path: join(calcDir, 'config.json') });
      } else if (calls.length === 1) {
        observed.companionConfig = toolMsgs.at(-1) || '';
        reply = callTool('read', { path: join(calcDir, 'references/checklist.md') });
      } else if (calls.length === 2) {
        observed.checklist = toolMsgs.at(-1) || '';
        reply = callTool('read', { path: join(plainDir, 'assets/template.txt') });
      } else if (calls.length === 3) {
        observed.plainAsset = toolMsgs.at(-1) || '';
        reply = callTool('bash', { command: join(calcDir, 'scripts/verify.sh') });
      } else {
        observed.scriptOut = toolMsgs.at(-1) || '';
        reply = callTool('submit_report', {
          summary: 'Verified companion files and executable skill script.',
          artifacts: [],
          evidence: [{ source: '.agents/skills/calc-ops/config.json', result: 'CONFIG_SENTINEL_1171' }],
          unknowns: [],
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: reply }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    } catch (err) {
      observed.serverError = err;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture_model_error' } }));
    }
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');

  let engine;
  const h = await harness(undefined, computer, store => ({ engine: (engine = new TaskEngine(store, computer, ghUrl)) }));
  t.after(async () => {
    await engine.close();
    await computer.recover();
    await h.stop();
    modelServer.closeAllConnections();
    await new Promise(r => modelServer.close(r));
    ghFixture.server.closeAllConnections();
    await new Promise(r => ghFixture.server.close(r));
    rmSync(root, { recursive: true, force: true });
    rmSync(h.directory, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const acc = await account(admin, { type: 'github_app', token: undefined, app_id: '77', private_key: ghFixture.privateKey });
  await repository(admin, acc.id, '101');
  const model = (await admin('/api/models', 'POST', {
    repository_id: '101',
    api_url: `http://127.0.0.1:${modelServer.address().port}/v1`,
    api_key: 'fixture-key',
    model_name: 'fixture-model',
  })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: true, capability_ceiling: 'comment', model_id: model.id });

  const taskId = 'task-pi-1171';
  // Target external untrusted PR #88 so the Pi checkout on disk contains untrusted `.agents/skills/injected/SKILL.md` and modified `calc-ops/SKILL.md`,
  // proving Pi loads ONLY the control-plane staged trusted base-branch skills.
  const contract = { goal: 'Run calc-ops verification report on PR #88', scope: ['calc.mjs'], criteria: ['Read skill companion files'], endpoint: 'report', source: 'request' };
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,created_at,updated_at) VALUES(?,'101','task.request','queued','prepare','Skill test',?,datetime('now'),datetime('now'))",
    taskId,
    JSON.stringify({ generic: true, executor_role: 'test', target: { type: 'pr', number: 88 }, request: 'Verify repository skills on PR #88', contract }),
  );
  authorizeKnowledgeTask(h.store, taskId);
  setGrant(h.store, { id: taskId, repository_id: '101' }, [], 'test', null);

  engine.tick();
  await Promise.all(engine.active.values());

  if (observed.serverError) throw observed.serverError;
  const done = h.store.get('SELECT status,error_code,result FROM tasks WHERE id=?', taskId);
  assert.equal(done.status, 'completed', `unexpected task status: ${JSON.stringify(done)}`);
  assert.match(observed.companionConfig, /CONFIG_SENTINEL_1171/);
  assert.match(observed.checklist, /CHECKLIST_SENTINEL_1171/);
  assert.match(observed.plainAsset, /ASSET_SENTINEL_1171/);
  assert.match(observed.scriptOut, /SCRIPT_SENTINEL_1171/);
});

test('#1171 untrusted PR/branch/commit targets never load untrusted skills; Native roles & Event Dispatch Manager read trusted base-branch skills and companion files; bad .agents/skills/ stops at waiting_configuration', { timeout: 90000 }, async t => {
  configureDispatch(null);
  t.after(() => configureDispatch(ruleDecider));

  const root = mkdtempSync(join(tmpdir(), 'bot-1171-native-'));
  const computer = new LocalManager('101', root);
  const ghFixture = createSkillGitHubFixture();
  ghFixture.server.listen(0, '127.0.0.1');
  await once(ghFixture.server, 'listening');
  const ghUrl = `http://127.0.0.1:${ghFixture.server.address().port}`;

  const seen = {
    dispatchList: null,
    dispatchCompanion: null,
    dispatchWarmSummaries: null,
    dispatchRestrictedTools: null,
    dispatchRestrictedPayload: null,
    prReviewerPrompt: null,
    prSkillList: null,
    prSkillBody: null,
    prCompanion: null,
    prContextCompanion: null,
    branchSkillSummaries: null,
  };

  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages || [];
    const tools = (body.tools || []).map(x => x.function.name);
    const calls = messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
    const toolOutputs = messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });

    let reply;
    if (tools.includes('submit_acceptance')) {
      reply = callTool('submit_acceptance', {
        outcome: 'pass',
        reason: 'Verified report.',
        gaps: [],
        residuals: [],
        core_complete: true,
        required_evidence_complete: true,
        acceptable_risk: true,
      });
    } else if (tools.includes('ignore_event') && tools.includes('create_task') && !tools.includes('submit_report')) {
      const sysText = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => msgText(m.content)).join('\n');
      const userMsg = messages.find(m => m.role === 'user');
      const userPayload = JSON.parse(msgText(userMsg?.content ?? '{}'));
      if (userPayload.event?.summary === 'Restricted warm dispatch event') {
        seen.dispatchRestrictedTools = tools;
        seen.dispatchRestrictedPayload = userPayload;
        seen.dispatchRestrictedSys = sysText;
        reply = callTool('ignore_event', { reason: '无 Contents 读权限时不暴露仓库 skill。' });
      } else if (userPayload.event.summary === 'Warm dispatch event') {
        seen.dispatchWarmSummaries = userPayload.repository_skills;
        reply = callTool('ignore_event', { reason: '已核对缓存的仓库 skill 摘要。' });
      } else if (calls.length === 0) {
        assert.ok(tools.includes('read_skill'), 'dispatch manager must offer read_skill');
        reply = callTool('read_skill', {});
      } else if (calls.length === 1) {
        seen.dispatchList = toolOutputs.at(-1);
        reply = callTool('read_skill', { path: 'calc-ops/references/checklist.md' });
      } else {
        seen.dispatchCompanion = toolOutputs.at(-1);
        reply = callTool('ignore_event', { reason: '已按需读取可信基准分支 skill 及附属文件。' });
      }
    } else {
      // 2. Native worker role turn (reviewer on PR #88 or branch feat/untrusted)
      const promptObj = JSON.parse(msgText(messages[1].content));
      if (promptObj.target?.type === 'branch') {
        seen.branchSkillSummaries = promptObj.role_context?.skills?.summaries;
        reply = callTool('submit_report', {
          summary: 'Checked branch with trusted main skills only.',
          artifacts: [],
          evidence: [],
          unknowns: [],
        });
      } else {
        seen.prReviewerPrompt = promptObj;
        if (calls.length === 0) {
          reply = callTool('read_skill', {});
        } else if (calls.length === 1) {
          seen.prSkillList = toolOutputs.at(-1);
          reply = callTool('read_skill', { path: '.agents/skills/calc-ops/SKILL.md' });
        } else if (calls.length === 2) {
          seen.prSkillBody = toolOutputs.at(-1);
          reply = callTool('read_skill', { path: 'calc-ops/config.json' });
        } else if (calls.length === 3) {
          seen.prCompanion = toolOutputs.at(-1);
          reply = callTool('read_file', { path: '../context/skills/calc-ops/references/checklist.md' });
        } else {
          seen.prContextCompanion = toolOutputs.at(-1);
          reply = callTool('post_review', {
            target: { type: 'pr', number: 88 },
            summary: 'Reviewed external PR using trusted base-branch skills only.',
            findings: [],
          });
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');

  let engine;
  const h = await harness(undefined, computer, store => ({ engine: (engine = new TaskEngine(store, computer, ghUrl)) }));
  t.after(async () => {
    await engine.close();
    await computer.recover();
    await h.stop();
    modelServer.closeAllConnections();
    await new Promise(r => modelServer.close(r));
    ghFixture.server.closeAllConnections();
    await new Promise(r => ghFixture.server.close(r));
    rmSync(root, { recursive: true, force: true });
    rmSync(h.directory, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const acc = await account(admin, { type: 'github_app', token: undefined, app_id: '77', private_key: ghFixture.privateKey });
  await repository(admin, acc.id, '101');
  nativeRoles(h.store, '101');
  const model = (await admin('/api/models', 'POST', {
    repository_id: '101',
    api_url: `http://127.0.0.1:${modelServer.address().port}/v1`,
    api_key: 'fixture-key',
    model_name: 'fixture-model',
  })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: true, capability_ceiling: 'comment', model_id: model.id });

  // A. Cold-cache Event Dispatch Manager lazily fetches trusted `main` skills on `read_skill`, ignoring business SKILL.md.
  h.store.run("DELETE FROM repository_rule_sources WHERE repository_id='101'");
  recordEvent(h.store, {
    repositoryId: '101',
    key: 'cold-dispatch-1171',
    type: 'issue.mention',
    source: 'webhook',
    objectType: 'issue',
    objectNumber: 1,
    summary: 'Cold dispatch event',
    facts: {},
    options: [{ id: 'opt1', work: 'task.request', title: 'Review', spec: { type: 'request', key: 'k1', request: 'Inspect', principal: null } }],
  });
  const dispatcher = new Dispatcher(h.store, (s, ctx) => managerDecision(s, ctx, ghUrl, computer));
  t.after(() => dispatcher.close());
  dispatcher.tick();
  await dispatcher.idle();
  assert.ok(seen.dispatchList, 'cold dispatch event must invoke managerDecision and execute read_skill');
  assert.deepEqual(
    seen.dispatchList.summaries.map(s => s.name),
    ['calc-ops', 'plain-guide'],
    'dispatch read_skill must list only .agents/skills/ from trusted base branch',
  );
  assert.deepEqual(seen.dispatchList.summaries[0].support_files, ['config.json', 'references/checklist.md', 'scripts/verify.sh']);
  assert.match(seen.dispatchCompanion.content, /CHECKLIST_SENTINEL_1171/);

  // B. Warm-cache Event Dispatch Manager exposes repository_skills summary in context with zero GitHub calls when read_skill is not called.
  const ghBeforeWarm = ghFixture.state.requests.length;
  recordEvent(h.store, {
    repositoryId: '101',
    key: 'warm-dispatch-1171',
    type: 'issue.mention',
    source: 'webhook',
    objectType: 'issue',
    objectNumber: 2,
    summary: 'Warm dispatch event',
    facts: {},
    options: [{ id: 'opt2', work: 'task.request', title: 'Review', spec: { type: 'request', key: 'k2', request: 'Inspect', principal: null } }],
  });
  dispatcher.tick();
  await dispatcher.idle();
  assert.equal(ghFixture.state.requests.length, ghBeforeWarm, 'warm dispatch without tool calls must make zero GitHub HTTP requests');
  assert.deepEqual(seen.dispatchWarmSummaries.skills.map(s => s.name), ['calc-ops', 'plain-guide']);

  // B2. Warm-cache Event Dispatch Manager with Contents `none` MUST NOT receive `read_skill` or `repository_skills`.
  const currentRoles = (await admin('/api/repositories/101/roles')).value.configuration;
  const managerDef = currentRoles.roles.find(r => r.role_id === 'manager');
  const savedRestricted = await admin('/api/repositories/101/roles', 'PUT', {
    expected_revision: currentRoles.revision,
    roles: [{
      role_id: 'manager',
      permissions: { ...managerDef.permissions, github_contents: 'none' },
    }],
  });
  assert.equal(savedRestricted.status, 200, JSON.stringify(savedRestricted.value));
  recordEvent(h.store, {
    repositoryId: '101',
    key: 'restricted-warm-dispatch-1171',
    type: 'issue.mention',
    source: 'webhook',
    objectType: 'issue',
    objectNumber: 3,
    summary: 'Restricted warm dispatch event',
    facts: {},
    options: [{ id: 'opt3', work: 'task.request', title: 'Review', spec: { type: 'request', key: 'k3', request: 'Inspect', principal: null } }],
  });
  dispatcher.tick();
  await dispatcher.idle();
  assert.ok(seen.dispatchRestrictedTools && !seen.dispatchRestrictedTools.includes('read_skill'), 'restricted Manager without Contents read must not be offered read_skill');
  assert.equal(seen.dispatchRestrictedPayload?.repository_skills, undefined, 'restricted Manager without Contents read must not receive cached repository_skills');
  assert.ok(!seen.dispatchRestrictedSys.includes('calc-ops') && !seen.dispatchRestrictedSys.includes('plain-guide'), 'restricted Manager harnessResources must not stage cached repository skills');
  const { role_id: _rid, enabled, name, responsibility, persona_prompt, model_profile_ref, skill_bundle_ref, harness_ref, permissions, environment_profile_ref, budget_policy_ref, output_schema_ref } = managerDef;
  await admin('/api/repositories/101/roles', 'PUT', {
    expected_revision: savedRestricted.value.configuration.revision,
    roles: [{ role_id: 'manager', enabled, name, responsibility, persona_prompt, model_profile_ref, skill_bundle_ref, harness_ref, permissions, environment_profile_ref, budget_policy_ref, output_schema_ref }],
  });

  // C. External PR #88 modifies .agents/skills/calc-ops/SKILL.md and adds .agents/skills/injected/SKILL.md:
  // reviewer MUST load trusted main skills, never PR head skills, while flagging behavior_changes.
  const prTaskId = 'task-pr-88';
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,created_at,updated_at) VALUES(?,'101','task.request','queued','prepare','Review PR 88',?,datetime('now'),datetime('now'))",
    prTaskId,
    JSON.stringify({
      generic: true,
      executor_role: 'reviewer',
      target: { type: 'pr', number: 88 },
      request: 'Review PR #88',
      contract: { goal: 'Review PR #88', scope: ['PR #88'], criteria: ['Inspect changes'], endpoint: 'report', source: 'request' },
    }),
  );
  authorizeKnowledgeTask(h.store, prTaskId);
  setGrant(h.store, { id: prTaskId, repository_id: '101' }, ['review'], 'test', null);
  engine.tick();
  await Promise.all(engine.active.values());
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', prTaskId).status, 'succeeded');
  assert.deepEqual(seen.prReviewerPrompt.behavior_changes, [
    'AGENTS.md',
    '.pi/skills/evil-pi/SKILL.md',
    '.agents/skills/calc-ops/SKILL.md',
    '.agents/skills/injected/SKILL.md',
  ]);
  assert.equal(ghFixture.state.postedComments.length, 1, 'post_review must publish summary comment on PR #88');
  assert.match(
    ghFixture.state.postedComments[0].body,
    /These files change the bot's behavior; a maintainer decides whether to accept them: AGENTS\.md, \.pi\/skills\/evil-pi\/SKILL\.md, \.agents\/skills\/calc-ops\/SKILL\.md, \.agents\/skills\/injected\/SKILL\.md/,
  );
  assert.deepEqual(seen.prSkillList.summaries.map(s => s.name), ['calc-ops', 'plain-guide']);
  assert.ok(!JSON.stringify(seen.prSkillList).includes('injected') && !JSON.stringify(seen.prSkillList).includes('EVIL_'));
  assert.ok(!seen.prSkillBody.content.includes('EVIL_PR_BODY'));
  assert.match(seen.prCompanion.content, /CONFIG_SENTINEL_1171/);
  assert.match(seen.prContextCompanion.content, /CHECKLIST_SENTINEL_1171/);

  // D. Untrusted branch target (`feat/untrusted`) also loads skills strictly from trusted `main`, never `feat/untrusted`.
  const branchTaskId = 'task-branch-untrusted';
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,created_at,updated_at) VALUES(?,'101','task.request','queued','prepare','Check branch',?,datetime('now'),datetime('now'))",
    branchTaskId,
    JSON.stringify({
      generic: true,
      executor_role: 'reviewer',
      target: { type: 'branch', ref: 'feat/untrusted' },
      request: 'Inspect branch feat/untrusted',
      contract: { goal: 'Inspect branch', scope: ['feat/untrusted'], criteria: ['Report'], endpoint: 'report', source: 'request' },
    }),
  );
  authorizeKnowledgeTask(h.store, branchTaskId);
  setGrant(h.store, { id: branchTaskId, repository_id: '101' }, [], 'test', null);
  engine.tick();
  await Promise.all(engine.active.values());
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', branchTaskId).status, 'completed');
  assert.deepEqual(seen.branchSkillSummaries.map(s => s.name), ['calc-ops', 'plain-guide']);
  assert.ok(!JSON.stringify(seen.branchSkillSummaries).includes('EVIL_') && !JSON.stringify(seen.branchSkillSummaries).includes('injected'));

  // E. Oversized companion file on trusted `main` stops `runRequest` cleanly in `prepare` with `waiting_configuration` (`skill_file_too_large`).
  ghFixture.state.refs.main = ghFixture.putCommit({
    ...ghFixture.state.trustedFiles,
    '.agents/skills/calc-ops/references/huge.txt': 'x'.repeat(512 * 1024 + 10),
  }, ghFixture.state.mainSha, 'oversized companion');
  const badTaskId = 'task-bad-skill-size';
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,created_at,updated_at) VALUES(?,'101','task.request','queued','prepare','Bad skill check',?,datetime('now'),datetime('now'))",
    badTaskId,
    JSON.stringify({
      executor_role: 'reviewer',
      request: 'Check oversized skill handling',
      contract: { goal: 'Check', scope: ['repo'], criteria: ['Report'], endpoint: 'report', source: 'request' },
    }),
  );
  authorizeKnowledgeTask(h.store, badTaskId);
  engine.tick();
  await Promise.all(engine.active.values());
  const badRow = h.store.get('SELECT status,phase,error_code FROM tasks WHERE id=?', badTaskId);
  assert.deepEqual([badRow.status, badRow.phase, badRow.error_code], ['waiting_configuration', 'prepare', 'skill_file_too_large']);
});
