import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagerError } from '../../manager/docker.mjs';
import { deleteCliConfig, inspectCliConfigs, writeCliConfig } from '../../runner/cli-config.mjs';

// A Docker stand-in for the manager: containers, volumes and networks in memory. Every request is recorded in `calls`
// as "METHOD path", so a test can tell which resources were removed.
export class FakeDocker {
  containers = new Map(); volumes = new Map(); networks = new Map(); starts = 0; failNetwork = false;
  // Default realistic 16-CPU / 64 GiB host; tests simulating small or broken /info override docker.info explicitly.
  info = { NCPU: 16, MemTotal: 64 * 1024 ** 3 };
  images = new Map([['approved', { Id: 'sha256:fixture', Config: { Labels: { 'department.bot.toolchain': 'fixture toolchain' } } }]]); builds = []; buildCalls = []; runs = [];
  calls = []; onBuild = null;
  // The raw GET /system/df payload (#671): the same answer the manager parses in readDockerUsage(), not a shape of its own.
  // A request carrying `type` gets only the lists it asked for, as Docker answers it (#680); one without gets all of them.
  df = { LayersSize: 0, Images: [], Containers: [], Volumes: [], BuildCache: [] };
  // A path substring whose /system/df read fails, the way a stuck socket or a timeout does (#680), and the limit each
  // read passed, so a test can tell the container read from the quick one.
  dfFailure = null; timeouts = [];
  async volumeSource(directory) { return directory; }
  // The manager's own mounts: the assistant HOME volume (#457) and the read-only CLI tool volume (#705).
  async volumeName(destination) {
    if (destination === this.homesMount) return this.homesVolumeName ?? 'fixture-assistant-homes';
    if (destination === this.toolsMount) return this.toolsVolumeName ?? 'fixture-agent-tools';
    return null;
  }
  async request(method, path, body, raw, timeout = 90000) {
    this.calls.push(method + ' ' + path);
    if (path === '/info') return this.info;
    if (path.startsWith('/system/df')) {
      this.timeouts.push({ path, timeout });
      if (this.dfFailure && path.includes(this.dfFailure)) throw new Error('docker_timeout');
      const types = new URL('http://docker' + path).searchParams.getAll('type'), df = this.df || {};
      if (!types.length) return df;
      return { LayersSize: types.includes('image') ? df.LayersSize : 0,
        Images: types.includes('image') ? df.Images ?? [] : [], Containers: types.includes('container') ? df.Containers ?? [] : [],
        BuildCache: types.includes('build-cache') ? df.BuildCache ?? [] : [], Volumes: types.includes('volume') ? df.Volumes ?? [] : [] };
    }
    if (path.startsWith('/images/')) {
      const target = decodeURIComponent(path.split('/')[2].split('?')[0]);
      if (method === 'DELETE') { this.images.delete(target); return {}; }
      return this.images.get(target) || null;
    }
    const [kind, named] = path.slice(1).split('?')[0].split('/'), name = named ? decodeURIComponent(named.split('?')[0]) : undefined;
    if (kind === 'volumes' && !named) {
      // Docker's volume listing with label filters, as the manager reads it to find notes volumes.
      const filters = JSON.parse(new URL('http://docker' + path).searchParams.get('filters') || '{}').label || [];
      return { Volumes: [...this.volumes].filter(([, row]) => filters.every(label => { const [k, v] = label.split('='); return row.Labels?.[k] === v; }))
        .map(([name, row]) => ({ Name: name, Labels: row.Labels, CreatedAt: 'fixture' })) };
    }
    if (kind === 'volumes') {
      if (method === 'POST') { this.volumes.set(body.Name, { Labels: body.Labels, Options: body.DriverOpts }); return {}; }
      if (method === 'DELETE') { if (this.failVolume) throw new ManagerError('injected_volume_failure'); this.volumes.delete(name); return {}; }
      if (this.volumes.has(name)) return this.volumes.get(name);
      if (this.toolsMount && name === (this.toolsVolumeName ?? 'fixture-agent-tools')) {
        return { Name: name, Labels: this.toolsVolumeLabels ?? { 'com.docker.compose.volume': 'agent-tools', 'department.bot.kind': 'agent-tools' } };
      }
      return null;
    }
    if (kind === 'networks') {
      if (method === 'POST') { if (this.failNetwork) throw new ManagerError('injected_network_failure'); this.networks.set(body.Name, { Labels: body.Labels, Internal: body.Internal, Options: body.Options }); return {}; }
      if (method === 'DELETE') { this.networks.delete(name); return {}; }
      return this.networks.get(name) || null;
    }
    if (path.startsWith('/containers/json')) {
      const labels = JSON.parse(new URL('http://docker' + path).searchParams.get('filters') || '{}').label || [];
      return [...this.containers].filter(([, row]) => labels.every(l => { const [k, v] = l.split('='); return row.Config.Labels?.[k] === v; })).map(([name, row]) => ({ Id: name, Names: ['/' + name], Labels: row.Config.Labels }));
    }
    if (path.startsWith('/containers/create')) {
      if (this.failCreate) throw new ManagerError('docker_operation_failed', 503);
      const mounts = (body.HostConfig?.Mounts ?? []).map(m => ({ Type: m.Type, Name: m.Source, Source: m.Source, Destination: m.Target, RW: m.ReadOnly === false || m.ReadOnly === undefined }));
      this.containers.set(new URL('http://docker' + path).searchParams.get('name'), { Config: body, HostConfig: body.HostConfig, Mounts: mounts, Image: body.Image, State: { Running: false, StartedAt: '' } });
      this.created = (this.created || 0) + 1; return {}; }
    if (kind === 'containers') {
      const row = this.containers.get(name);
      if (method === 'GET' && path.includes('/logs')) return Buffer.from(this.installerLogs ?? 'ok\n');
      if (method === 'GET') return row || null;
      if (path.endsWith('/start')) { row.State = { Running: true, StartedAt: String(++this.starts) }; return {}; }
      if (path.includes('/wait')) {
        row.State.Running = false;
        return { StatusCode: this.installerExitCode ?? 0 };
      }
      if (path.includes('/stop')) { row.State.Running = false; return {}; }
      if (method === 'DELETE') { this.containers.delete(name); return {}; }
    }
    throw new Error('Unexpected fake Docker call');
  }
  async build(tag, dockerfile, labels, options) {
    this.builds.push(dockerfile);
    this.buildCalls.push({ tag, dockerfile, labels, options });
    if (options?.signal?.aborted) throw Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output: '' });
    if (this.onBuild) return await this.onBuild({ tag, dockerfile, labels, options, docker: this });
    if (dockerfile.includes('broken-package') || String(options?.files?.['setup.sh'] || '').includes('broken-setup')) {
      throw Object.assign(new ManagerError('image_build_failed', 409), { output: 'E: Unable to locate package' });
    }
    options?.onOutput?.('Step 1/2 : building\n', 'Step 1/2 : building\n');
    this.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 1024 * 1024 });
    return 'built';
  }
  async runner(container, input, wait, extraEnv = []) {
    this.runs.push({ ...input, wait, ...(extraEnv?.length ? { extraEnv } : {}) });
    if (this.cliConfigRoot && ['cli_config_status', 'cli_config_write', 'cli_config_delete'].includes(input?.type)) {
      const workspaceRoot = join(this.cliConfigRoot, container.replace(/[^a-zA-Z0-9._-]/g, '_'));
      await mkdir(workspaceRoot, { recursive: true });
      try {
        if (input.type === 'cli_config_status') return { ok: true, result: await inspectCliConfigs(workspaceRoot) };
        if (input.type === 'cli_config_write') {
          const envEntry = Array.isArray(extraEnv) ? extraEnv.find(e => typeof e === 'string' && e.startsWith('BOT_CLI_CONFIG_B64=')) : undefined;
          const content = envEntry !== undefined ? Buffer.from(envEntry.slice('BOT_CLI_CONFIG_B64='.length), 'base64').toString('utf8') : input.content;
          return { ok: true, result: await writeCliConfig(workspaceRoot, input.cli, input.file, content) };
        }
        return { ok: true, result: await deleteCliConfig(workspaceRoot, input.cli, input.file) };
      } catch (err) {
        return { ok: false, error: String(err?.message || 'cli_config_failed') };
      }
    }
    return { ok: true, result: { ready: true, exit_code: 0, output: 'setup output' } };
  }
}
