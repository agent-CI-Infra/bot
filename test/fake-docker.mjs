import { ManagerError } from '../manager/docker.mjs';

// A Docker stand-in for the manager: containers, volumes and networks in memory. Every request is recorded in `calls`
// as "METHOD path", so a test can tell which resources were removed.
export class FakeDocker {
  containers = new Map(); volumes = new Map(); networks = new Map(); starts = 0; failNetwork = false;
  images = new Map([['approved', { Id: 'sha256:fixture', Config: { Labels: { 'department.bot.toolchain': 'fixture toolchain' } } }]]); builds = []; runs = [];
  calls = [];
  async request(method, path, body) {
    this.calls.push(method + ' ' + path);
    if (path.startsWith('/images/')) return this.images.get(decodeURIComponent(path.split('/')[2])) || null;
    const [kind, name] = path.slice(1).split('/');
    if (kind === 'volumes') {
      if (method === 'POST') { this.volumes.set(body.Name, { Labels: body.Labels }); return {}; }
      return this.volumes.get(name) || null;
    }
    if (kind === 'networks') {
      if (method === 'POST') { if (this.failNetwork) throw new ManagerError('injected_network_failure'); this.networks.set(body.Name, { Labels: body.Labels, Internal: body.Internal }); return {}; }
      if (method === 'DELETE') { this.networks.delete(name); return {}; }
      return this.networks.get(name) || null;
    }
    if (path.startsWith('/containers/create')) { this.containers.set(new URL('http://docker' + path).searchParams.get('name'), { Config: body, HostConfig: body.HostConfig, Image: body.Image, State: { Running: false, StartedAt: '' } }); this.created = (this.created || 0) + 1; return {}; }
    if (kind === 'containers') {
      const row = this.containers.get(name);
      if (method === 'GET') return row || null;
      if (path.endsWith('/start')) { row.State = { Running: true, StartedAt: String(++this.starts) }; return {}; }
      if (path.includes('/stop')) { row.State.Running = false; return {}; }
      if (method === 'DELETE') { this.containers.delete(name); return {}; }
    }
    throw new Error('Unexpected fake Docker call');
  }
  async build(tag, dockerfile) { this.builds.push(dockerfile); if (dockerfile.includes('broken-package')) throw Object.assign(new ManagerError('image_build_failed'), { output: 'E: Unable to locate package' });
    this.images.set(tag, { Id: 'sha256:' + tag.split(':')[1] }); return 'built'; }
  async runner(container, input, wait) { this.runs.push({ ...input, wait }); return { ok: true, result: { ready: true, exit_code: 0, output: 'setup output' } }; }
}
