import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computerResultOwner } from '../runner/result-owner.mjs';
import { CasCache, SyncClient } from '../runner/sync-client.mjs';

/**
 * Node-side file synchronization manager built strictly on top of #1377's `CasCache` and `SyncClient`.
 * Requests short-lived per-scope `bsync_...` tokens from `/cluster/nodes/sync-token` using the node's
 * `bnsess_...` session credential and pulls/pushes all 6 namespaces cleanly without duplicating sync logic.
 */
export class NodeSyncManager {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.getSessionToken = options.getSessionToken;
    this.getNodeId = options.getNodeId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cas = options.cas instanceof CasCache ? options.cas : new CasCache(options.cacheDir || '/data/sync-cache');
    this.roots = {
      agentTools: options.roots?.agentTools ? resolve(options.roots.agentTools) : null,
      skillStore: options.roots?.skillStore ? resolve(options.roots.skillStore) : null,
      projectTools: options.roots?.projectTools ? resolve(options.roots.projectTools) : null,
      toolResults: options.roots?.toolResults ? resolve(options.roots.toolResults) : null,
      projectNotes: options.roots?.projectNotes ? resolve(options.roots.projectNotes) : null,
      assistantHomes: options.roots?.assistantHomes ? resolve(options.roots.assistantHomes) : null,
    };
    this._tokenCache = new Map(); // `${namespace}:${scope}:${mode}` -> { token, expiresAt }
  }

  invalidateTokens() {
    this._tokenCache.clear();
  }

  async requestSyncToken(namespace, scope, mode) {
    const key = `${namespace}:${scope}:${mode}`;
    const cached = this._tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return cached.token;
    }
    const sessionToken = this.getSessionToken?.();
    const nodeId = this.getNodeId?.();
    if (!sessionToken || !nodeId) {
      throw Object.assign(new Error('node_not_authenticated'), { code: 'node_not_authenticated', status: 401 });
    }
    const res = await this.fetchImpl(`${this.baseUrl}/cluster/nodes/sync-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ namespace, scope, mode, node_id: nodeId }),
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok || !body.token) {
      throw Object.assign(new Error(body.error || `sync_token_request_failed_${res.status}`), {
        code: body.error || 'sync_token_request_failed',
        status: res.status || 502,
      });
    }
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 10 * 60_000;
    this._tokenCache.set(key, { token: String(body.token), expiresAt });
    return String(body.token);
  }

  async _client(namespace, scope, mode, targetDir) {
    const token = await this.requestSyncToken(namespace, scope, mode);
    const nodeId = this.getNodeId?.() || 'remote';
    return new SyncClient({
      baseUrl: this.baseUrl,
      token,
      namespace,
      scope,
      targetDir,
      cas: this.cas,
      actorTag: `node-${nodeId}`,
      fetchImpl: this.fetchImpl,
    });
  }

  async pullNamespace(namespace, scope, mode, targetDir, options = {}) {
    await mkdir(targetDir, { recursive: true, mode: 0o755 });
    const client = await this._client(namespace, scope, mode, targetDir);
    return client.pull({ mode, ...options });
  }

  async pushNamespace(namespace, scope, targetDir, options = {}) {
    await mkdir(targetDir, { recursive: true, mode: 0o755 });
    const client = await this._client(namespace, scope, 'rw', targetDir);
    return client.push({ mode: 'background', ...options });
  }

  projectNotesDir(repoId) {
    if (!this.roots.projectNotes) return null;
    return join(this.roots.projectNotes, String(repoId));
  }

  assistantHomeDir(owner, generation) {
    if (!this.roots.assistantHomes) return null;
    return join(this.roots.assistantHomes, String(owner), `home-${Number(generation)}`);
  }

  assistantMemoryDir(owner, generation) {
    const home = this.assistantHomeDir(owner, generation);
    return home ? join(home, 'memory') : null;
  }

  async syncAgentTools(archOrScope = 'default') {
    if (!this.roots.agentTools) return null;
    let scope = String(archOrScope || 'default').trim();
    if (scope === 'amd64' || scope === 'x64') scope = 'linux/x64';
    else if (scope === 'arm64') scope = 'linux/arm64';
    return this.pullNamespace('agent-tools', scope, 'ro', this.roots.agentTools);
  }

  async syncSkillStore(scope) {
    if (!this.roots.skillStore) return null;
    const targetDir = join(this.roots.skillStore, ...String(scope).split('/'));
    return this.pullNamespace('skill-store', scope, 'ro', targetDir);
  }

  async syncProjectTools(repoId, revision) {
    if (!this.roots.projectTools) return null;
    const scope = revision ? `${repoId}@rev-${revision}` : String(repoId);
    const targetDir = revision
      ? join(this.roots.projectTools, String(repoId), `rev-${revision}`)
      : join(this.roots.projectTools, String(repoId));
    return this.pullNamespace('project-tools', scope, 'ro', targetDir);
  }

  async syncToolResults(ownerScope) {
    if (!this.roots.toolResults) return null;
    const targetDir = join(this.roots.toolResults, ownerScope);
    // Ensure owner directory always exists before Docker resultMount() inspects it, even when empty.
    await mkdir(targetDir, { recursive: true, mode: 0o755 });
    return this.pullNamespace('tool-results', ownerScope, 'ro', targetDir);
  }

  async pullProjectNotes(repoId, options = {}) {
    const dir = this.projectNotesDir(repoId);
    if (!dir) return null;
    return this.pullNamespace('project-notes', String(repoId), 'rw', dir, options);
  }

  async flushProjectNotes(repoId, options = {}) {
    const dir = this.projectNotesDir(repoId);
    if (!dir) return null;
    return this.pushNamespace('project-notes', String(repoId), dir, options);
  }

  async pullAssistantHome(owner, generation, options = {}) {
    const homeDir = this.assistantHomeDir(owner, generation);
    const memoryDir = this.assistantMemoryDir(owner, generation);
    if (!homeDir || !memoryDir) return null;
    await mkdir(join(this.roots.assistantHomes, String(owner)), { recursive: true, mode: 0o750 });
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    return this.pullNamespace('assistant-homes', `${owner}:${Number(generation)}`, 'rw', memoryDir, options);
  }

  async flushAssistantHome(owner, generation, options = {}) {
    const memoryDir = this.assistantMemoryDir(owner, generation);
    if (!memoryDir) return null;
    return this.pushNamespace('assistant-homes', `${owner}:${Number(generation)}`, memoryDir, options);
  }

  async clearLocalProjectCache(repoId) {
    const id = String(repoId);
    const resultOwner = computerResultOwner('project', id);
    if (this.roots.projectNotes) {
      await rm(join(this.roots.projectNotes, id), { recursive: true, force: true }).catch(() => {});
    }
    if (this.roots.projectTools) {
      await rm(join(this.roots.projectTools, id), { recursive: true, force: true }).catch(() => {});
    }
    if (this.roots.skillStore) {
      await rm(join(this.roots.skillStore, 'projects', id), { recursive: true, force: true }).catch(() => {});
    }
    if (this.roots.toolResults) {
      await rm(join(this.roots.toolResults, resultOwner), { recursive: true, force: true }).catch(() => {});
    }
    for (const key of [...this._tokenCache.keys()]) {
      if (
        key.includes(`:${id}:`) ||
        key.includes(`:${id}@`) ||
        key.includes(`:${resultOwner}:`) ||
        key.includes(`projects/${id}`)
      ) {
        this._tokenCache.delete(key);
      }
    }
  }
}
