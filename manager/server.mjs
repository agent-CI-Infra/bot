import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ManagerError } from './docker.mjs';
import { logFailure } from './projects.mjs';

// Listen during recovery so callers can distinguish startup from an unreachable manager. Project APIs stay fenced
// until every saved project has stopped uncertain work and been recovered according to its desired state.
export function createManagerServer({ projects, token, runs = null }) {
  const bearer = 'Bearer ' + token.toString('base64');
  let ready = false;
  // Run environments left from before a restart belong to runs whose outcome is unknown; they are removed, never reused.
  const recovered = Promise.resolve().then(() => projects.recover()).then(() => runs?.reap({ all: true })).then(() => { ready = true; });
  // General operations retain their transport bound; note contents have no application size limit.
  async function json(req, limit = 1500000) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new ManagerError('payload_too_large', 413); chunks.push(chunk); }
    let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ManagerError('invalid_json', 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ManagerError('invalid_input', 400);
    return input;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(req.url, 'http://manager'), path = url.pathname;
      // This unauthenticated probe reports readiness only, never project data.
      if (req.method === 'GET' && path === '/ready') {
        res.statusCode = ready ? 200 : 503; res.end(JSON.stringify({ ready })); return;
      }
      const auth = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(bearer);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw new ManagerError('unauthorized', 401);
      if (!ready) throw new ManagerError('manager_not_ready', 503);
      const output = /^\/v1\/projects\/([1-9]\d{0,19})\/output\/([a-f0-9]{48})$/.exec(path);
      let result;
      if (req.method === 'GET' && path === '/v1/projects') result = projects.list();
      else if (req.method === 'GET' && path === '/v1/defaults') result = await projects.defaultsView();
      else if (req.method === 'PUT' && path === '/v1/defaults') result = await projects.setDefaults(await json(req));
      else if (req.method === 'GET' && output) result = await projects.output(output[1], output[2], Number(url.searchParams.get('offset') || 0));
      else if (/^\/v1\/projects\/[1-9]\d{0,19}\/files(?:\/[^/]+)?(?:\/(?:versions|restore))?$/.test(path)) {
        const parts = path.split('/'); let name;
        try { if (parts[5] !== undefined) name = decodeURIComponent(parts[5]); } catch { throw new ManagerError('invalid_note_name', 400); }
        result = await projects.files(parts[3], req.method, name, parts[6], ['PUT','POST','DELETE'].includes(req.method) ? await json(req, req.method === 'PUT' ? Infinity : undefined) : {}, Object.fromEntries(url.searchParams));
      }
      else if (/^\/v1\/projects\/[1-9]\d{0,19}\/notes(?:\/[^/]+)?$/.test(path)) {
        const parts = path.split('/');
        let name; try { if (parts[5] !== undefined) name = decodeURIComponent(parts[5]); } catch { throw new ManagerError('invalid_note_name', 400); }
        result = await projects.notes(parts[3], req.method, name, req.method === 'PUT' ? await json(req, Infinity) : {});
      }
      else if (req.method === 'GET' && /^\/v1\/projects\/[1-9]\d{0,19}\/stats$/.test(path)) result = await projects.stats(path.split('/')[3]);
      else if (req.method === 'PUT' && /^\/v1\/projects\/[1-9]\d{0,19}\/parallel$/.test(path)) {
        const input = await json(req);
        if (Object.keys(input).some(k => k !== 'tasks')) throw new ManagerError('invalid_input', 400);
        result = projects.parallelism(path.split('/')[3], input.tasks);
      } else if (runs && /^\/v1\/projects\/[1-9]\d{0,19}\/runs(?:\/[a-f0-9]{48}(?:\/execute)?)?$/.test(path)) {
        // Per-run environments of RoleRun (run-environments.mjs).
        const [, , , repo, , run, action] = path.split('/');
        if (req.method === 'POST' && !run) { const input = await json(req); if (Object.keys(input).some(k => k !== 'run')) throw new ManagerError('invalid_input', 400); result = await runs.create(repo, input.run); }
        else if (req.method === 'GET' && run && !action) result = await runs.inspect(repo, run);
        else if (req.method === 'POST' && run && action === 'execute') result = await runs.execute(repo, run, await json(req));
        else if (req.method === 'DELETE' && run && !action) result = await runs.release(repo, run, 'released');
        else throw new ManagerError('not_found', 404);
      } else {
        const match = /^\/v1\/projects\/([1-9]\d{0,19})(?:\/(start|stop|reset|delete|execute|configure|refresh))?$/.exec(path);
        if (!match) throw new ManagerError('not_found', 404);
        if (req.method === 'GET' && !match[2]) result = projects.describe(match[1]);
        else if (req.method === 'PUT' && !match[2]) result = await projects.register(match[1]);
        else if (req.method === 'POST' && match[2]) {
          const input = await json(req);
          if (Object.keys(input).some(k => !['operation_id','generation','request'].includes(k))) throw new ManagerError('invalid_input', 400);
          result = await projects.operate(match[1], match[2], input);
        } else throw new ManagerError('not_found', 404);
      }
      res.end(JSON.stringify({ result }));
    } catch (error) {
      // A refusal is answered with its code; an unexpected error or a Docker failure is also logged with the request.
      if (!(error instanceof ManagerError) || error.status >= 500 && error.message !== 'manager_not_ready') logFailure(`${req.method} ${new URL(req.url, 'http://manager').pathname}`, error);
      res.statusCode = error instanceof ManagerError ? error.status : 503; res.end(JSON.stringify({ error: error instanceof ManagerError ? error.message : 'manager_unavailable' }));
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  return { server, recovered };
}
