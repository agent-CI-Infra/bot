import http from 'node:http';

export class ManagerError extends Error {
  constructor(code, status = 409) { super(code); this.status = status; }
}
export class Docker {
  constructor(socketPath = '/var/run/docker.sock') { this.socketPath = socketPath; }
  request(method, path, body, raw = false, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ socketPath: this.socketPath, path: '/v1.47' + path, method,
        headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {} }, res => {
        const chunks = []; let size = 0;
        res.on('data', b => { size += b.length; if (size > 4 * 1024 * 1024) req.destroy(new Error('docker_response_too_large')); else chunks.push(b); });
        res.on('end', () => {
          if (res.statusCode === 404) { resolve(null); return; }
          if (res.statusCode >= 300) { reject(new ManagerError('docker_operation_failed', 503)); return; }
          const result = Buffer.concat(chunks);
          try { resolve(raw ? result : result.length ? JSON.parse(result.toString()) : {}); } catch { reject(new ManagerError('docker_protocol_failed', 503)); }
        });
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(new Error('docker_timeout'))); req.on('error', reject); req.end(bytes);
    });
  }
  async runner(container, input, timeout = 90000) {
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new ManagerError('runner_request_too_large', 413);
    const exec = await this.request('POST', `/containers/${encodeURIComponent(container)}/exec`, { AttachStdout: true, AttachStderr: true,
      User: '10001:10001', WorkingDir: '/workspace', Cmd: ['node', '/opt/runner/runner.mjs', Buffer.from(JSON.stringify(input)).toString('base64url')] });
    if (!exec) throw new ManagerError('container_missing');
    const raw = await this.request('POST', `/exec/${exec.Id}/start`, { Detach: false, Tty: false }, true, timeout);
    let offset = 0, stdout = '';
    while (offset + 8 <= raw.length) {
      const size = raw.readUInt32BE(offset + 4); if (offset + 8 + size > raw.length) throw new ManagerError('runner_protocol_failed');
      if (raw[offset] === 1) stdout += raw.subarray(offset + 8, offset + 8 + size).toString(); offset += size + 8;
    }
    const state = await this.request('GET', `/exec/${exec.Id}/json`);
    if (state?.Running || state?.ExitCode !== 0) throw new ManagerError('runner_failed');
    try { return JSON.parse(stdout); } catch { throw new ManagerError('runner_protocol_failed'); }
  }
}
