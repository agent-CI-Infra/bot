import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createTokenExchange} from './token-exchange.mjs';

export async function startCredentialHelperServer({ agentDir, runToken, addSecret, signal }) {
  const helperSecret = randomBytes(32).toString('base64url');
  const secretBytes = Buffer.from(helperSecret, 'utf8');
  const exchange = createTokenExchange(agentDir, { token: runToken });
  const cacheByPurpose = new Map();
  const inflightByPurpose = new Map();

  const obtainGrant = async purpose => {
    const cached = cacheByPurpose.get(purpose);
    if (cached && cached.token && Date.parse(cached.expires_at) - Date.now() >= 10 * 60_000) {
      return cached;
    }
    let pending = inflightByPurpose.get(purpose);
    if (!pending) {
      pending = (async () => {
        const reply = await exchange(signal, { token: runToken, purpose });
        if (reply && !reply.error && !reply.structured_only && typeof reply.token === 'string' && reply.token) {
          addSecret(reply.token);
          cacheByPurpose.set(purpose, reply);
        } else if (cached && Date.parse(cached.expires_at) <= Date.now()) {
          cacheByPurpose.delete(purpose);
        }
        return reply;
      })().finally(() => {
        inflightByPurpose.delete(purpose);
      });
      inflightByPurpose.set(purpose, pending);
    }
    return pending;
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const presented = typeof req.headers['x-bot-helper-secret'] === 'string' ? req.headers['x-bot-helper-secret'] : '';
    const presentedBytes = Buffer.from(presented, 'utf8');
    if (presentedBytes.length !== secretBytes.length || !timingSafeEqual(presentedBytes, secretBytes)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/github-read-token') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const purpose = url.searchParams.get('purpose') === 'gh' ? 'gh' : 'git';
    try {
      const reply = await obtainGrant(purpose);
      if (!reply || reply.error || reply.structured_only || !reply.token) {
        res.writeHead(403);
        res.end(JSON.stringify({
          error: reply?.error || (reply?.structured_only ? 'structured_tools_only' : 'github_read_token_unavailable'),
          ...(reply?.instruction ? { instruction: reply.instruction } : {}),
        }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        token: reply.token,
        expires_at: reply.expires_at,
        repository: reply.repository,
      }));
    } catch {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'github_read_token_failed' }));
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const close = async () => {
    server.closeAllConnections?.();
    await new Promise(r => server.close(() => r()));
  };
  return { url: `http://127.0.0.1:${port}`, secret: helperSecret, close };
}
