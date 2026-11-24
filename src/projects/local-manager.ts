import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { concurrencyValue } from '../app/settings.js';
import { randomId, fail, type Json } from '../core/security.js';
import type { Manager } from './service.js';
import { FileTree } from '../../manager/file-tree.mjs';

/** Single-repository development backend. Commands run as the current host user. */
export class LocalManager implements Manager {
  private state: any = null;
  private readonly file: string;
  private readonly runner: string;
  constructor(readonly repositoryId: string, readonly root: string) {
    if (!/^[1-9]\d*$/.test(repositoryId) || !root.startsWith('/')) throw new Error('invalid_local_project');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(root + '/project-notes', { recursive: true, mode: 0o700 });
    mkdirSync(root + '/home', { recursive: true, mode: 0o700 });
    mkdirSync(root + '/tmp', { recursive: true, mode: 0o700 });
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
        env: {
          PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          BOT_LOCAL_EXECUTION: 'true',
          BOT_LOCAL_WORKSPACE: this.root,
          ...(process.env.BOT_AGENT_TOOLS_DIR ? { BOT_AGENT_TOOLS_DIR: process.env.BOT_AGENT_TOOLS_DIR } : {}),
          ...(process.env.BOT_REAL_GH_BIN ? { BOT_REAL_GH_BIN: process.env.BOT_REAL_GH_BIN } : {}),
          ...(process.env.BOT_BROWSER_EXECUTABLE ? { BOT_BROWSER_EXECUTABLE: process.env.BOT_BROWSER_EXECUTABLE } : {}),
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        },
        stdio: ['ignore','pipe','pipe'] });
      let out = '', err = '';
      const timer = timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('local_runner_timeout')); }, timeoutMs) : undefined;
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
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
    const url = new URL(path, 'http://local');
    const pruneMatch = /^\/v1\/projects\/([1-9]\d*)\/file-tree\/prune$/.exec(url.pathname);
    if (pruneMatch && pruneMatch[1] === this.repositoryId && method === 'POST') {
      const body = (input ?? {}) as Record<string, any>;
      const tree = new FileTree(this.root + '/project-notes');
      return await tree.pruneHistory({
        keepVersions: body.keep_versions === undefined ? 50 : body.keep_versions,
        keepDays: body.keep_days === undefined ? 30 : body.keep_days,
        now: body.now === undefined ? Date.now() : Number(body.now),
      });
    }
    const fileTreeMatch = /^\/v1\/projects\/([1-9]\d*)\/file-tree(?:\/([^/]+))?(?:\/(versions|restore|move))?$/.exec(url.pathname);
    if (fileTreeMatch && fileTreeMatch[1] === this.repositoryId) {
      let id: string | undefined;
      if (fileTreeMatch[2] !== undefined) {
        try { id = decodeURIComponent(fileTreeMatch[2]); } catch { fail(400, 'invalid_note_id'); }
      }
      const action = fileTreeMatch[3], directories = id === 'directories', body = (input ?? {}) as Record<string, any>;
      const actor = typeof body.actor === 'string' ? body.actor : 'console';
      const tree = new FileTree(this.root + '/project-notes');
      try {
        if (directories && method === 'POST') return await tree.createDirectory(body.path);
        if (directories && method === 'DELETE') return await tree.deleteDirectory(body.path);
        if (id === undefined && method === 'GET') return await tree.list({ directory: url.searchParams.get('directory') ?? '', query: url.searchParams.get('query') ?? '', includeDeleted: url.searchParams.get('include_deleted') === '1', deletedOnly: url.searchParams.get('deleted_only') === '1', recursive: url.searchParams.get('recursive') === '1', preview: url.searchParams.get('preview') === '1' });
        if (id === undefined && method === 'POST') return await tree.create(body.path, body.content, actor, { createParents: body.create_parents === true });
        if (id !== undefined && method === 'GET' && action === 'versions') return await tree.versions(id);
        if (id !== undefined && method === 'GET' && !action) return await tree.read(id, url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined);
        if (id !== undefined && method === 'PUT' && !action) return await tree.save(id, body.content, body.expected_revision, actor);
        if (id !== undefined && method === 'DELETE' && !action) return await tree.delete(id, body.expected_revision, actor);
        if (id !== undefined && method === 'POST' && action === 'restore') return await tree.restore(id, body.revision, body.expected_revision, actor);
        if (id !== undefined && method === 'POST' && action === 'move') return await tree.move(id, body.path, body.expected_revision, actor);
        return fail(405, 'method_not_allowed');
      } catch (error: any) {
        if (error?.code === 'ENOENT') fail(404, 'note_not_found');
        if (error?.code === 'EACCES' || error?.code === 'EPERM') fail(503, 'note_permission_denied');
        if (error?.message === 'unsupported_note_format') fail(415, error.message);
        if (error?.message === 'note_revision_changed') fail(409, error.message);
        if (/^(?:invalid_note|notes_|note_(?:path_conflict|not_found|move_)|directory_)/.test(String(error?.message || ''))) fail(error.status ?? 400, error.message);
        throw error;
      }
    }
    if (method === 'GET' && url.pathname === '/v1/project-tools/mounts') return { mounts: [] };
    const toolsMatch = /^\/v1\/projects\/([1-9]\d*)\/tools$/.exec(url.pathname);
    if (method === 'PUT' && toolsMatch && toolsMatch[1] === this.repositoryId) {
      const state = this.register();
      const rev = input?.revision === null || input?.revision === undefined ? null : Number(input.revision);
      state.computer.tools_revision = rev;
      state.computer.applied_tools_revision = rev;
      state.computer.tools_pending = false;
      this.save();
      return state;
    }
    const output=/^\/v1\/projects\/([1-9]\d*)\/output\/([a-f0-9]{48})\?offset=(\d+)$/.exec(path);
    if(method==='GET'&&output&&output[1]===this.repositoryId){const response=await this.execute({type:'tail',operation_id:output[2],offset:Number(output[3])});if(!response.ok)fail(503,'output_unavailable');return response.result;}
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
      if (!request || typeof request.type !== 'string' || !/^(workspace_|git_)/.test(request.type) && !['health','reap','tail','usage','prune','tasks_list','tasks_remove','worktrees_list','worktrees_remove'].includes(request.type)) fail(400, 'unsupported_local_request');
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
