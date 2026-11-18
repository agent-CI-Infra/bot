import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account } from './helpers.mjs';
import { PublicBoards } from '../../dist/public-board/service.js';
import { commitInstallationProjection } from '../../dist/installations/projection.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
export async function publicBoardFixture(t, collector) {
  // extraRuns, jobs (by run id), checkRuns (by check suite id), artifacts (by run id) and blobs (by artifact id): what
  // a test adds to the one CI run every fixture repository has, such as scheduled runs and the results they report.
  const state = { stars: 1, private: false, requests: [], tokens: 0, revoked: 0, fail: false, runs: true,
    extraRuns: [], jobs: {}, checkRuns: {}, artifacts: {}, blobs: {} };
  const meta = () => ({ id: 101, full_name: 'octo/hello', name: 'hello', owner: { id: 10, login: 'octo' },
    private: state.private, visibility: state.private ? 'private' : 'public', default_branch: 'main',
    html_url: 'https://github.com/octo/hello', stargazers_count: state.stars, forks_count: 0, open_issues_count: 0,
    created_at: '2026-01-01T00:00:00Z', updated_at: new Date().toISOString(), subscribers_count: 0 });
  const github = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fake').pathname;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ path, method: req.method, body });
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(value == null ? '' : JSON.stringify(value)); };
    if (path === '/installation/token') { state.revoked++; return send(204); }
    if (state.fail) return send(503, {});
    if (path === '/repos/octo/hello/installation') return send(200, { id: 1, account: { id: 10, login: 'octo' },
      permissions: { contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', metadata: 'read' } });
    if (path === '/app/installations/1/access_tokens') { state.tokens++; return send(201, { token: 'ghs_fixture_read', expires_at: '2099-01-01T00:00:00Z', permissions: body.permissions }); }
    if (path === '/repositories/101' || path === '/repos/octo/hello') return send(200, meta());
    if (path.endsWith('/actions/runs')) {
      const runs = [...(state.runs ? [{ id: 900, name: 'CI', workflow_id: 12, event: 'push', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'a'.repeat(40), run_attempt: 1, created_at: new Date().toISOString(), run_started_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: 'https://github.com/octo/hello/actions/runs/900', pull_requests: [] }] : []), ...state.extraRuns];
      return send(200, { total_count: runs.length, workflow_runs: runs });
    }
    const runOf = /\/actions\/runs\/(\d+)\//.exec(path)?.[1], suite = /\/check-suites\/(\d+)\/check-runs$/.exec(path)?.[1], blob = /\/actions\/artifacts\/(\d+)\/zip$/.exec(path)?.[1];
    if (suite) return send(200, { total_count: (state.checkRuns[suite] || []).length, check_runs: state.checkRuns[suite] || [] });
    if (blob && state.blobs[blob]) { res.writeHead(302, { Location: `http://127.0.0.1:${github.address().port}/blob/${blob}` }); return res.end(); }
    if (path.startsWith('/blob/') && state.blobs[path.slice(6)]) { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(state.blobs[path.slice(6)]); }
    if (path.endsWith('/jobs')) return send(200, { jobs: state.jobs[runOf] || [] });
    if (path.endsWith('/artifacts')) return send(200, { total_count: (state.artifacts[runOf] || []).length, artifacts: state.artifacts[runOf] || [] });
    if (path.endsWith('/actions/workflows')) return send(200, { workflows: [] });
    if (path.endsWith('/actions/artifacts')) return send(200, { total_count: 0, artifacts: [] });
    if (path.endsWith('/issues') || path.endsWith('/pulls') || path.endsWith('/contributors') || path.endsWith('/releases') || path.endsWith('/branches') || path.endsWith('/commits')) return send(200, []);
    return send(404, {});
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  t.after(() => new Promise(resolve => { github.close(resolve); github.closeAllConnections(); }));
  const api = `http://127.0.0.1:${github.address().port}`;
  const directory = mkdtempSync(join(tmpdir(), 'public-boards-'));
  let boards;
  const h = await harness(t, undefined, store => ({ githubUrl: api,
    boards: boards = new PublicBoards(store, directory, api, collector) }));
  const stop = h.stop; h.stop = async () => { await boards.close(); await stop(); };
  // A service restart preserves snapshots; remove them only when the entire test finishes.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { admin, password } = await setup(h), owner = await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey, token: undefined });
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,?,0,1,?)`, owner.id, '101', '1', 'octo/hello', '10', 'octo', new Date().toISOString());
  // These publication tests start with an already verified installation, including across database reopen.
  commitInstallationProjection(h.store, h.store.get('SELECT * FROM accounts WHERE id=?', owner.id),
    [{ id: 1, account: { id: 10, login: 'octo', type: 'User' }, repository_selection: 'selected', permissions: {}, events: [] }],
    h.store.all('SELECT * FROM installed_repositories WHERE account_id=?', owner.id), new Date().toISOString());
  h.store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: h.webhook }));
  const hook = (id, headers) => h.hook(owner.path, owner.secret, id, { repository: { id: 101, full_name: 'octo/hello', private: state.private } }, { 'X-GitHub-Event': 'push', ...headers });
  const get = async path => { const response = await fetch(h.webhook + path); return { status: response.status, data: await response.json() }; };
  return { h, boards, owner, admin, password, state, hook, get };
}

// A scheduled workflow with a run a day that reports its totals in a check run table, one run started by hand and one
// failed run: what the board charts for a repository's Nightly (#938).
export function scheduledNightly(state, count = 8) {
  for (let i = 0; i < count; i++) {
    const id = 7000 + i, suite = 8000 + i, started = new Date(Date.now() - (count - i) * 86400_000).toISOString(), failed = i === count - 3;
    state.extraRuns.push({ id, name: 'Nightly', workflow_id: 40, event: i === count - 2 ? 'workflow_dispatch' : 'schedule', status: 'completed',
      conclusion: failed ? 'failure' : 'success', head_branch: 'main', head_sha: String(i).repeat(40), run_attempt: 1, created_at: started, run_started_at: started,
      updated_at: new Date(Date.parse(started) + (1500 + i * 40) * 1000).toISOString(), check_suite_id: suite, html_url: `https://github.com/octo/hello/actions/runs/${id}`, pull_requests: [] });
    const tests = 1180 + i * 6, fail = failed ? 3 : 0;
    state.checkRuns[suite] = [{ id: suite, name: 'unit', output: { summary: `| tests | pass | fail | duration |\n|---|---|---|---|\n| ${tests} | ${tests - fail} | ${fail} | ${1400 + i * 35}s |` } }];
    state.jobs[id] = [{ name: 'unit', status: 'completed', conclusion: failed ? 'failure' : 'success', started_at: started, completed_at: new Date(Date.parse(started) + (1400 + i * 35) * 1000).toISOString(),
      steps: failed ? [{ name: 'npm test', conclusion: 'failure' }] : [] }];
  }
}
