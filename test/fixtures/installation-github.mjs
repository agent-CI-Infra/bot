import { createServer } from 'node:http';
import { appPermissions, appEvents } from '../../dist/github/client.js';

// Local-only GitHub fixture for the isolated installation-archive Compose acceptance.
const target = { id: 10, login: 'agent-test-zone', type: 'Organization' };
const state = { selection: 'all', suspended: false, repository_ids: [101], failure: 0 };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture'), path = url.pathname;
  const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
  if (path === '/fixture') {
    if (req.method === 'POST') { let body = ''; for await (const bytes of req) body += bytes; Object.assign(state, JSON.parse(body)); }
    return send(state);
  }
  const installation = { id: 77, app_id: 123, account: target, repository_selection: state.selection,
    permissions: appPermissions, events: appEvents, suspended_at: state.suspended ? '2026-11-07T01:00:00Z' : null };
  if (path === '/app') return send({ slug: 'fixture-app', owner: target, permissions: appPermissions, events: appEvents });
  if (path === '/rate_limit') return send({});
  if (path === '/app/installations') return send([installation]);
  if (path === '/app/installations/77') return send(installation);
  if (path === '/app/installations/77/access_tokens') return send({ token: 'fixture-installation-token' }, 201);
  if (path === '/installation/token') return send(undefined, 204);
  if (path === '/installation/repositories') {
    if (state.failure) return send({ message: 'fixture failure' }, state.failure);
    const repositories = state.repository_ids.map(id => ({ id, full_name: 'agent-test-zone/project-' + id, owner: target, private: true }));
    const page = Number(url.searchParams.get('page') || 1);
    return send({ total_count: repositories.length, repositories: repositories.slice((page - 1) * 100, page * 100) });
  }
  return send({}, 404);
});
server.listen(8080, '0.0.0.0');
