import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { harness, setup, account, repository } from './helpers.mjs';
import { ReleaseService } from '../dist/releases/service.js';

export const target = 'a'.repeat(40), previous = 'b'.repeat(40), other = 'c'.repeat(40), tagObject = 'd'.repeat(40);
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
export const workflow = "name: Release\non:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo release\n";
export async function releaseFixture(t) {
  const state = { files: { '.github/ci-gates.json': '{}', '.github/workflows/ci.yml': 'name: CI', '.github/workflows/release.yml': workflow },
    head: target, tags: {}, releases: [], runs: [], jobs: [], requests: [], tokens: [], unknown: '', deny: '', registered: true,
    commits: [{ sha: target, commit: { message: 'Add release lane' }, html_url: 'https://github.com/fixture/project-101/commit/' + target },
      { sha: previous, commit: { message: 'Initial commit' }, html_url: 'https://github.com/fixture/project-101/commit/' + previous }], prs: {}, pages: {}, custom: null };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, url = new URL(req.url, 'http://local'), path = decodeURIComponent(url.pathname), method = req.method;
    state.requests.push({ method, path, query: url.search, body, token: req.headers.authorization });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const done = (value, status = 200) => { if (state.unknown === path) { req.socket.destroy(); return; } send(value, status); };
    const repo = { id: 101, full_name: 'fixture/project-101', owner: { id: 10 }, default_branch: 'main' };
    if (state.custom && await state.custom({ method, path, body, url, send, req, res })) return;
    if (state.deny === path) return send({ message: 'fixture permission denied' }, 403);
    if (path === '/repos/fixture/project-101/installation') return send({ id: 55, account: { id: 10 }, permissions: { contents: 'write', actions: 'write', pull_requests: 'read' } });
    if (path === '/app/installations/55/access_tokens') { state.tokens.push(body); return send({ token: 'fixture-installation-' + state.tokens.length, permissions: body.permissions }, 201); }
    if (path === '/installation/token') return send({});
    if (path === '/repositories/101') return send(repo);
    const prefix = '/repos/fixture/project-101', suffix = path.slice(prefix.length);
    if (!path.startsWith(prefix)) return send({ message: 'unexpected fixture request' }, 500);
    if (suffix === '/git/ref/heads/main') return send({ object: { sha: state.head, type: 'commit' } });
    if (suffix.startsWith('/git/trees/')) return send({ tree: Object.entries(state.files).map(([path, content]) => ({ path, type: 'blob', mode: '100644', size: content.length, sha: createHash('sha1').update(content).digest('hex') })) });
    if (suffix.startsWith('/git/blobs/')) { const entry = Object.values(state.files).find(content => createHash('sha1').update(content).digest('hex') === suffix.split('/').at(-1)); return entry === undefined ? send({}, 404) : send({ encoding: 'base64', content: Buffer.from(entry).toString('base64') }); }
    if (suffix === '/actions/workflows/release.yml') return state.registered ? send({ id: 77, path: '.github/workflows/release.yml', state: 'active' }) : send({}, 404);
    if (/^\/commits\/[a-f0-9]{40}$/.test(suffix)) return send({ ...state.commits[0], sha: suffix.split('/').at(-1) });
    if (suffix === '/commits') { const items = url.searchParams.get('sha') === previous ? state.commits.filter(c => c.sha === previous) : state.commits; return send(state.pages[url.search] ?? (Number(url.searchParams.get('page')) > 1 ? [] : items)); }
    if (suffix.endsWith('/pulls')) return send(Number(url.searchParams.get('page')) > 1 ? [] : (state.prs[suffix.split('/')[2]] || []));
    if (suffix === '/tags') return send(Number(url.searchParams.get('page')) > 1 ? [] : Object.entries(state.tags).map(([name, value]) => ({ name, commit: { sha: value.commit || value.sha } })));
    if (suffix.startsWith('/git/ref/tags/')) { const value = state.tags[suffix.slice('/git/ref/tags/'.length)]; return value ? send({ object: { sha: value.sha, type: value.type } }) : send({}, 404); }
    if (suffix.startsWith('/git/tags/') && method === 'GET') { const value = Object.values(state.tags).find(v => v.sha === suffix.split('/').at(-1)); return send({ object: { type: 'commit', sha: value?.commit || target } }); }
    if (suffix === '/git/tags' && method === 'POST') return done({ sha: tagObject }, 201);
    if (suffix === '/git/refs' && method === 'POST') { const version = body.ref.slice('refs/tags/'.length); if (state.tags[version]) return send({}, 422); state.tags[version] = { sha: body.sha, type: 'tag', commit: target }; return done({ ref: body.ref, object: { sha: body.sha, type: 'tag' } }, 201); }
    if (suffix === '/actions/workflows/77/runs') return send({ total_count: state.runs.length, workflow_runs: Number(url.searchParams.get('page')) > 1 ? [] : state.runs });
    let match;
    if ((match = /^\/actions\/runs\/(\d+)(?:\/attempts\/(\d+)\/jobs)?$/.exec(suffix))) {
      if (match[2]) return send({ total_count: state.jobs.length, jobs: Number(url.searchParams.get('page')) > 1 ? [] : state.jobs.filter(j => !j.run_attempt || j.run_attempt === Number(match[2])) });
      const run = state.runs.find(r => r.id === Number(match[1])); return run ? send(run) : send({}, 404);
    }
    if ((match = /^\/actions\/runs\/(\d+)\/rerun$/.exec(suffix)) && method === 'POST') { const run = state.runs.find(r => r.id === Number(match[1])); run.run_attempt++; run.status = 'queued'; run.conclusion = null; return done({}, 201); }
    if (suffix === '/releases' && method === 'GET') return send(Number(url.searchParams.get('page')) > 1 ? [] : state.releases);
    if (suffix === '/releases' && method === 'POST') { const release = { ...body, id: 900 + state.releases.length, html_url: 'https://github.com/fixture/project-101/releases/tag/' + body.tag_name, updated_at: new Date().toISOString() }; state.releases.push(release); return done(release, 201); }
    if ((match = /^\/releases\/(\d+)$/.exec(suffix))) { const release = state.releases.find(r => r.id === Number(match[1])); if (!release) return send({}, 404); if (method === 'PATCH') { Object.assign(release, body, { updated_at: new Date().toISOString() }); return done(release); } return send(release); }
    send({ message: 'unexpected fixture request: ' + method + ' ' + suffix }, 500);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  let service;
  const h = await harness(t, undefined, store => { service = new ReleaseService(store, apiUrl); return { releases: service }; });
  const { admin, password } = await setup(h), owner = await account(admin, { type: 'github_app', app_id: '123', private_key: key, token: undefined });
  await repository(admin, owner.id, '101'); await repository(admin, owner.id, '202');
  return { h, admin, password, state, apiUrl, get service() { return service; }, endpoint: '/api/repositories/101/releases',
    async preview(version = 'v1.2.3') { return (await admin('/api/repositories/101/releases/preflight?version=' + version)).value; },
    async create(version = 'v1.2.3') { const p = await this.preview(version); return admin(this.endpoint, 'POST', { version, target_sha: p.target_sha, credential: p.credential }); } };
}
export const writes = state => state.requests.filter(r => r.method !== 'GET' && r.path !== '/installation/token' && !r.path.endsWith('/access_tokens'));
export function run(overrides = {}) { return { id: 800, workflow_id: 77, path: '.github/workflows/release.yml', name: 'Release', event: 'push', head_sha: target, head_branch: 'v1.2.3',
  repository: { id: 101 }, run_attempt: 1, run_number: 21, status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: 'https://github.com/fixture/project-101/actions/runs/800', ...overrides }; }
