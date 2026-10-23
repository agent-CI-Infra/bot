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
      // A timeout of 0 waits until Docker answers, for commands that have no time limit.
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('docker_timeout'))); req.on('error', reject); req.end(bytes);
    });
  }
  // Builds an image from a generated Dockerfile (a one-file tar context). Only the manager writes the Dockerfile.
  build(tag, dockerfile, labels, timeout = 30 * 60000) {
    const context = tar('Dockerfile', Buffer.from(dockerfile)), query = new URLSearchParams({ t: tag, labels: JSON.stringify(labels), rm: '1', forcerm: '1' });
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path: '/v1.47/build?' + query, method: 'POST',
        headers: { 'Content-Type': 'application/x-tar', 'Content-Length': context.length } }, res => {
        let text = '';
        res.on('data', b => { text += b; if (text.length > 4 * 1024 * 1024) text = text.slice(-1024 * 1024); });
        res.on('end', () => {
          const lines = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
          const output = lines.map(l => l.stream || (l.status ? l.status + '\n' : '')).join('').slice(-8000), failure = lines.find(l => l.error);
          if (res.statusCode >= 300 || failure) reject(Object.assign(new ManagerError('image_build_failed', 409), { output: `${output}${failure?.error || ''}`.slice(-8000) }));
          else resolve(output);
        });
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(new Error('docker_timeout'))); req.on('error', reject); req.end(context);
    });
  }
  async stats(container) {
    const s = await this.request('GET', `/containers/${encodeURIComponent(container)}/stats?stream=false`, undefined, false, 15000);
    if (!s) return null;
    const cpu = s.cpu_stats || {}, pre = s.precpu_stats || {}, cpuDelta = (cpu.cpu_usage?.total_usage || 0) - (pre.cpu_usage?.total_usage || 0);
    const systemDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0), cpus = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
    const memory = s.memory_stats || {}, io = s.blkio_stats?.io_service_bytes_recursive || [];
    const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0), networks = Object.values(s.networks || {});
    return { cpu_percent: systemDelta > 0 ? Math.round(cpuDelta / systemDelta * cpus * 1000) / 10 : 0,
      memory_bytes: Math.max(0, (memory.usage || 0) - (memory.stats?.inactive_file || 0)), memory_limit_bytes: memory.limit || null, pids: s.pids_stats?.current ?? null,
      net_rx_bytes: sum(networks, 'rx_bytes'), net_tx_bytes: sum(networks, 'tx_bytes'),
      block_read_bytes: io.filter(r => /read/i.test(r.op)).reduce((t, r) => t + r.value, 0), block_write_bytes: io.filter(r => /write/i.test(r.op)).reduce((t, r) => t + r.value, 0) };
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

// Minimal ustar archive with one regular file, enough for a Docker build context.
function tar(name, data) {
  const header = Buffer.alloc(512), field = (value, offset, length) => header.write(value, offset, length, 'ascii');
  field(name, 0, 100); field('0000644\0', 100, 8); field('0000000\0', 108, 8); field('0000000\0', 116, 8);
  field(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); field(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  field('        ', 148, 8); field('0', 156, 1); field('ustar\0', 257, 6); field('00', 263, 2);
  let checksum = 0; for (const byte of header) checksum += byte;
  field(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]);
}
