import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { concurrencyValue } from '../app/settings.js';
import { randomId, fail, type Json } from '../core/security.js';
import type { Manager } from './service.js';

/** Single-repository development backend. Commands run as the current host user. */
export class LocalManager implements Manager {
  private state: any = null;
  private readonly file: string;
  private readonly runner: string;
  constructor(readonly repositoryId: string, readonly root: string) {
    if (!/^[1-9]\d*$/.test(repositoryId) || !root.startsWith('/')) throw new Error('invalid_local_project');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(root + '/project-notes', { recursive: true, mode: 0o700 });
    this.file = root + '/local-state.json';
    this.runner = resolve(import.meta.dirname, '../../runner/runner.mjs');
    try { this.state = JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  private save() { writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
  private register() {
    if (!this.state) { this.state = { repository_id: this.repositoryId, generation: 1, revision: 1, state: 'ready', desired: 'ready', parallel: 1,
      started_at: new Date().toISOString(), error: null, computer: { backend: 'local', isolation: 'host-user', inherited: ['cpus','memory_mb','pids','tmp_mb'], packages: [], env: {}, setup_script: '', egress: true } }; this.save(); }
    return this.state;
  }
  async execute(input: any, timeoutMs = 90000): Promise<any> {
    if (!/^[a-f0-9]{48}$/.test(input.operation_id || '')) fail(400, 'invalid_operation_id');
    return new Promise((resolveResult, reject) => {
      // Deliberately do not inherit the control plane's environment or credentials.
      const child = spawn(process.execPath, [this.runner, Buffer.from(JSON.stringify(input)).toString('base64url')], {
        env: { PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: this.root },
        stdio: ['ignore','pipe','pipe'] });
      let out = '', err = '';
      const timer = timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('local_runner_timeout')); }, timeoutMs) : undefined;
      child.stdout.on('data', chunk => { out += chunk; if (out.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', chunk => { err = (err + chunk).slice(-1000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code !== 0) { reject(new Error('local_runner_failed:' + code + ':' + err)); return; }
        try { resolveResult(JSON.parse(out)); } catch { reject(new Error('local_runner_invalid_response')); } });
    });
  }
  async recover() {
    // Only known workspace processes can be stopped; never use an unscoped host reap.
    let ids: string[] = []; try { ids = readdirSync(this.root + '/tasks').filter(id => /^[a-f0-9]{48}$/.test(id)); } catch {}
    for (const workspace_id of ids) { const result = await this.execute({ operation_id: randomId(), type: 'reap', workspace_id }); if (!result.ok) throw new Error('local_recovery_failed'); }
  }
  async call(method: string, path: string, input?: Json, timeoutMs = 90000): Promise<any> {
    const match = /^\/v1\/projects\/([1-9]\d*)(?:\/(parallel|execute|start|stop|configure|refresh))?$/.exec(path);
    if (!match || match[1] !== this.repositoryId) return fail(404, 'local_project_not_found');
    const action = match[2];
    if (!action && method === 'GET') return this.state;
    if (!action && method === 'PUT') return this.register();
    const state = this.register();
    if (action === 'parallel' && method === 'PUT') { const tasks = concurrencyValue(input?.tasks); state.parallel = tasks; this.save(); return { parallel: tasks }; }
    if (Number(input?.generation) !== state.generation) fail(409, 'stale_generation');
    if (action === 'execute' && method === 'POST') {
      const request = input?.request as any;
      if (state.state !== 'ready') fail(409, 'local_project_stopped');
      if (!request || typeof request.type !== 'string' || !/^(workspace_|git_)/.test(request.type) && !['health','reap','tail','usage','prune','tasks_list','tasks_remove'].includes(request.type)) fail(400, 'unsupported_local_request');
      if (request.type === 'reap' && !/^[a-f0-9]{48}$/.test(request.workspace_id || '')) fail(400, 'local_reap_requires_workspace');
      return this.execute({ ...request, operation_id: input!.operation_id }, timeoutMs);
    }
    if (action === 'stop' && method === 'POST') { await this.recover(); state.state = 'stopped'; state.desired = 'stopped'; }
    else if (action === 'start' && method === 'POST') { state.state = 'ready'; state.desired = 'ready'; }
    else if (action === 'configure' && method === 'POST') { if (Object.keys((input?.request as object) || {}).length) fail(409, 'local_computer_configuration_unsupported'); }
    else if (action !== 'refresh') return fail(404, 'local_operation_unsupported');
    state.revision++; this.save(); return state;
  }
}
