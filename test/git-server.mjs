import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';

// Git's own smart HTTP server (git http-backend) for the bare repositories under `root`. Every request must carry the
// installation token as GitHub expects it; `requests` records each one so tests can tell whether GitHub was contacted.
// version0 drops the client's protocol request, so the server answers in protocol v0, which refuses unadvertised commits.
export async function gitServer(t, root, token, { version0 = false } = {}) {
  const requests = [], expected = 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://git'); requests.push({ method: req.method, path: url.pathname + url.search });
    if (req.headers.authorization !== expected) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); res.end(); return; }
    const child = spawn('git', ['http-backend'], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'fixture', REMOTE_ADDR: '127.0.0.1',
      HTTP_GIT_PROTOCOL: version0 ? '' : req.headers['git-protocol'] || '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    req.pipe(child.stdin); child.stdin.on('error', () => {});
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', () => {
      // CGI output: header lines, a blank line, then the body.
      const output = Buffer.concat(chunks), end = output.indexOf('\r\n\r\n'), split = end >= 0 ? end : output.indexOf('\n\n'), skip = end >= 0 ? 4 : 2;
      const headers = {}; let status = 200;
      for (const line of output.subarray(0, split).toString().split(/\r?\n/)) {
        const at = line.indexOf(':'); if (at < 0) continue;
        const name = line.slice(0, at).trim(), value = line.slice(at + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10); else headers[name] = value;
      }
      res.writeHead(status, headers); res.end(output.subarray(split + skip));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
// Runs git with no user or system configuration and a fixed identity.
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' } }).toString().trim();
}
