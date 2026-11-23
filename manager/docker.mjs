import http from 'node:http';
import { posix } from 'node:path';
import { hostname } from 'node:os';

export class ManagerError extends Error {
  constructor(code, status = 409) { super(code); this.status = status; }
}
export class Docker {
  constructor(socketPath = '/var/run/docker.sock') { this.socketPath = socketPath; }
  // Resolve a directory on the manager's persistent mount to the Docker host's path. A local bind-backed named
  // volume exposes those same bytes to project computers; the manager never starts a helper container to edit notes.
  async volumeSource(directory) {
    const self = await this.request('GET', `/containers/${encodeURIComponent(hostname())}/json`);
    const mount = self?.Mounts?.filter(m => directory.startsWith(m.Destination + '/') && m.RW).sort((a,b) => b.Destination.length-a.Destination.length)[0];
    if (!mount || !posix.isAbsolute(mount.Source)) throw new ManagerError('notes_storage_mount_missing', 503);
    return posix.join(mount.Source, posix.relative(mount.Destination, directory));
  }
  // The name of the Docker volume mounted at `destination` in the manager's own container (the assistant HOME volume, which
  // Compose names after its project); null when there is none.
  async volumeName(destination) {
    const self = await this.request('GET', `/containers/${encodeURIComponent(hostname())}/json`);
    return self?.Mounts?.find(m => m.Type === 'volume' && m.Destination === destination)?.Name || null;
  }
  request(method, path, body, raw = false, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ socketPath: this.socketPath, path: '/v1.47' + path, method,
        headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {} }, res => {
        const chunks = []; let size = 0;
        res.on('data', b => { size += b.length; if (size > 4 * 1024 * 1024) req.destroy(new Error('docker_response_too_large')); else chunks.push(b); });
        res.on('end', () => {
          if (res.statusCode === 404) { resolve(null); return; }
          if (res.statusCode >= 300) {
            // Docker explains a refusal in its body ({"message": ...}); it is kept for the manager's log, never for callers.
            let reason = ''; try { reason = String(JSON.parse(Buffer.concat(chunks).toString()).message || ''); } catch {}
            reject(Object.assign(new ManagerError('docker_operation_failed', 503), { detail: `${method} ${path.split('?')[0]} → HTTP ${res.statusCode}${reason ? ': ' + reason.slice(0, 500) : ''}` })); return;
          }
          const result = Buffer.concat(chunks);
          try { resolve(raw ? result : result.length ? JSON.parse(result.toString()) : {}); } catch { reject(new ManagerError('docker_protocol_failed', 503)); }
        });
        res.on('error', reject);
      });
      // A timeout of 0 waits until Docker answers, for commands that have no time limit.
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('docker_timeout'))); req.on('error', reject); req.end(bytes);
    });
  }
  // Builds an image from a generated Dockerfile and optional extra context files (tar archive).
  // Only the manager writes the Dockerfile; setup scripts are injected as separate tar entries rather than interpolated.
  // Supports resource caps (memory/memswap/cpuquota), isolated networkmode, streaming output callbacks, no timeout (0),
  // and AbortSignal cancellation.
  build(tag, dockerfile, labels, optionsOrTimeout = 0) {
    const opts = typeof optionsOrTimeout === 'number' ? { timeout: optionsOrTimeout } : (optionsOrTimeout || {});
    const timeout = opts.timeout ?? 0, outputLimit = opts.outputLimit ?? 32768;
    const entries = [{ name: 'Dockerfile', data: Buffer.from(dockerfile) }];
    for (const [name, content] of Object.entries(opts.files || {})) {
      entries.push({ name, data: Buffer.isBuffer(content) ? content : Buffer.from(String(content)) });
    }
    const context = tarFiles(entries);
    const params = { t: tag, labels: JSON.stringify(labels || {}), rm: '1', forcerm: '1' };
    if (opts.memory) { params.memory = String(opts.memory); params.memswap = String(opts.memswap ?? opts.memory); }
    if (opts.cpuquota) { params.cpuquota = String(opts.cpuquota); params.cpuperiod = String(opts.cpuperiod ?? 100000); }
    if (opts.networkmode) params.networkmode = String(opts.networkmode);
    const query = new URLSearchParams(params);
    return new Promise((resolve, reject) => {
      let output = '', remainder = '', failure = null, settled = false;
      const finish = (err, value) => {
        if (settled) return; settled = true;
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(value);
      };
      const append = text => {
        if (!text) return;
        output = (output + text).slice(-outputLimit);
        try { opts.onOutput?.(text, output); } catch {}
      };
      const processLine = line => {
        if (!line.trim()) return;
        let entry; try { entry = JSON.parse(line); } catch { return; }
        const chunk = entry.stream || (entry.status ? entry.status + '\n' : '');
        if (chunk) append(chunk);
        if (entry.error) failure = entry.error;
      };
      if (opts.signal?.aborted) {
        finish(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output: '' }));
        return;
      }
      const req = http.request({ socketPath: this.socketPath, path: '/v1.47/build?' + query, method: 'POST',
        headers: { 'Content-Type': 'application/x-tar', 'Content-Length': context.length } }, res => {
        res.on('data', b => {
          remainder += b.toString('utf8');
          let index;
          while ((index = remainder.indexOf('\n')) !== -1) {
            processLine(remainder.slice(0, index));
            remainder = remainder.slice(index + 1);
          }
        });
        res.on('end', () => {
          if (remainder) processLine(remainder);
          if (opts.signal?.aborted) {
            finish(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output }));
            return;
          }
          if (res.statusCode >= 300 || failure) {
            finish(Object.assign(new ManagerError('image_build_failed', 409), { output: `${output}${failure || ''}`.slice(-outputLimit) }));
          } else {
            finish(null, output);
          }
        });
        res.on('error', err => {
          if (opts.signal?.aborted) finish(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output }));
          else finish(err);
        });
      });
      const onAbort = () => {
        req.destroy();
        finish(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output }));
      };
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      if (timeout > 0) req.setTimeout(timeout, () => req.destroy(new Error('docker_timeout')));
      req.on('error', err => {
        if (opts.signal?.aborted) finish(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output }));
        else finish(err);
      });
      req.end(context);
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
  async runner(container, input, timeout = 90000, extraEnv = []) {
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new ManagerError('runner_request_too_large', 413);
    const exec = await this.request('POST', `/containers/${encodeURIComponent(container)}/exec`, { AttachStdout: true, AttachStderr: true,
      User: '10001:10001', WorkingDir: '/workspace', Env: [`BOT_OPERATION_ID=${input.operation_id}`, ...(Array.isArray(extraEnv) ? extraEnv : [])],
      Cmd: ['node', '/opt/runner/runner.mjs', Buffer.from(JSON.stringify(input)).toString('base64url')] });
    if (!exec) throw new ManagerError('container_missing');
    const raw = await this.request('POST', `/exec/${exec.Id}/start`, { Detach: false, Tty: false }, true, timeout);
    let offset = 0;const stdout = [];
    while (offset + 8 <= raw.length) {
      const size = raw.readUInt32BE(offset + 4); if (offset + 8 + size > raw.length) throw new ManagerError('runner_protocol_failed');
      if (raw[offset] === 1) stdout.push(raw.subarray(offset + 8, offset + 8 + size)); offset += size + 8;
    }
    const state = await this.request('GET', `/exec/${exec.Id}/json`);
    if (state?.Running || state?.ExitCode !== 0) throw new ManagerError('runner_failed');
    try { return JSON.parse(Buffer.concat(stdout).toString('utf8')); } catch { throw new ManagerError('runner_protocol_failed'); }
  }
}

// Minimal ustar archive builder supporting one or more regular files for a Docker build context.
export function tarFiles(entries) {
  const parts = [];
  const nowOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  for (const { name, data, mode = '0000644' } of entries) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.alloc(512), field = (value, offset, length) => header.write(value, offset, length, 'ascii');
    field(name, 0, 100); field(mode + '\0', 100, 8); field('0000000\0', 108, 8); field('0000000\0', 116, 8);
    field(buf.length.toString(8).padStart(11, '0') + '\0', 124, 12); field(nowOctal, 136, 12);
    field('        ', 148, 8); field('0', 156, 1); field('ustar\0', 257, 6); field('00', 263, 2);
    let checksum = 0; for (const byte of header) checksum += byte;
    field(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(header, buf, Buffer.alloc((512 - buf.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
