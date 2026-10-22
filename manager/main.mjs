import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Docker, ManagerError } from './docker.mjs';
import { Projects } from './projects.mjs';

process.umask(0o077);
const token = readFileSync(process.env.BOT_MANAGER_TOKEN_FILE), bearer = 'Bearer ' + token.toString('base64');
const projects = new Projects({ database: process.env.BOT_MANAGER_DATABASE || '/data/manager.sqlite', docker: new Docker(),
  deployment: createHash('sha256').update(token).digest('hex').slice(0, 16), image: process.env.BOT_PROJECT_IMAGE || 'department-bot-project:local',
  egress: process.env.BOT_PROJECT_EGRESS !== 'false' });
await projects.recover();
let checking = false;
const timer = setInterval(async () => { if (checking) return; checking = true; try { await projects.check(); } finally { checking = false; } }, 5000);
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const auth = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(bearer);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw new ManagerError('unauthorized', 401);
    const url = new URL(req.url, 'http://manager'), path = url.pathname, output = /^\/v1\/projects\/([1-9]\d{0,19})\/output\/([a-f0-9]{48})$/.exec(path);
    let result;
    if (req.method === 'GET' && path === '/v1/projects') result = projects.list();
    else if (req.method === 'GET' && output) result = await projects.output(output[1], output[2], Number(url.searchParams.get('offset') || 0));
    else {
      const match = /^\/v1\/projects\/([1-9]\d{0,19})(?:\/(start|stop|reset|delete|execute))?$/.exec(path);
      if (!match) throw new ManagerError('not_found', 404);
      if (req.method === 'GET' && !match[2]) result = projects.describe(match[1]);
      else if (req.method === 'PUT' && !match[2]) result = await projects.register(match[1]);
      else if (req.method === 'POST' && match[2]) {
        let bytes = ''; for await (const chunk of req) { bytes += chunk; if (Buffer.byteLength(bytes) > 1500000) throw new ManagerError('payload_too_large', 413); }
        let input; try { input = JSON.parse(bytes); } catch { throw new ManagerError('invalid_json', 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['operation_id','generation','request'].includes(k))) throw new ManagerError('invalid_input', 400);
        result = await projects.operate(match[1], match[2], input);
      } else throw new ManagerError('not_found', 404);
    }
    res.end(JSON.stringify({ result }));
  } catch (error) { res.statusCode = error instanceof ManagerError ? error.status : 503; res.end(JSON.stringify({ error: error instanceof ManagerError ? error.message : 'manager_unavailable' })); }
});
server.requestTimeout = 10000; server.headersTimeout = 5000; server.listen(8793, '0.0.0.0');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(async () => { await projects.shutdown(); process.exit(0); }); });
