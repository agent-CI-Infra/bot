import type { Store } from '../storage/database.js';
import type { Actor } from '../app/auth.js';
import { repository } from '../app/auth.js';
import { fail, fields, randomId, type Json } from '../core/security.js';
import { stop } from '../agent/common.js';
import { releaseStorage, releaseIdleDrafts } from './storage.js';
import { inspect, fingerprint, preflightToken } from './preflight.js';
import { enabled, releaseRedactor, withGitHub } from './github.js';
import { validVersion } from './version.js';
import { ReleaseWorker } from './worker.js';
import { requestObservation } from './observe.js';
import { managerSection, workActive } from '../work/settings.js';
import { authorize, resolvePrincipalActor } from '../identity/authorization.js';
// The Manager's release notes section; a repository skill still replaces it at preflight.
const releaseNotesPrompt = (store: Store, id: string) => managerSection(store, id, 'release.notes') ?? null;

export class ReleaseService {
  readonly worker: ReleaseWorker;
  private timer?: ReturnType<typeof setInterval>;
  private processing?: Promise<void>;
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com') { releaseStorage(store); this.worker = new ReleaseWorker(this); }
  start() { this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref(); void this.tick(); }
  async close() { clearInterval(this.timer); await this.processing; }
  tick(): Promise<void> {
    if (this.processing) return this.processing;
    this.processing = (async () => {
      for (const row of this.store.all("SELECT id FROM project_releases WHERE active=1 AND stage IN ('tagging','waiting_run','running','preparing_notes','creating_draft','publishing') AND next_poll<=?", Date.now()))
        await this.worker.process(row.id);
    })().finally(() => { this.processing = undefined; });
    return this.processing;
  }
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([^/]+)\/releases(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return undefined;
    const id = match[1]!, action = match[2] || ''; repository(this.store, user, id);
    if (method === 'GET' && action === 'preflight') {
      const version = url.searchParams.get('version') || '', redactor = releaseRedactor(this.store, id);
      try {
        const preview = await withGitHub(this.store, id, this.apiUrl, { pull_requests: 'read' }, redactor, github => inspect(github, version, releaseNotesPrompt(this.store, id)));
        const token = preflightToken();
        this.store.run('DELETE FROM release_preflights WHERE expires_at<?', Date.now());
        this.store.run('INSERT INTO release_preflights VALUES(?,?,?,?,?,?)', token, id, user.id, fingerprint(preview), JSON.stringify(redactor.clean(preview)), Date.now() + 10 * 60_000);
        const { content, ...skill } = preview.skill;
        return redactor.clean({ ...preview, skill, credential: token });
      } catch (error) {
        const e = error as any;
        return { available: false, version, checks: [], error: String(e.code || 'release_check_failed'), detail: redactor.text('暂时无法检查：' + (e.detail || e.message || 'GitHub 连接失败')) };
      }
    }
    if (method === 'GET' && !action) return { releases: this.store.all('SELECT * FROM project_releases WHERE repository_id=? ORDER BY created_at DESC', id).map(row => this.view(row)) };
    if (method === 'GET' && action && !action.includes('/')) return { release: this.view(this.find(id, action)) };
    if (method === 'POST' && !action) {
      fields(input, ['version', 'target_sha', 'credential']);
      if (typeof input.version !== 'string' || !validVersion(input.version)) return fail(400, 'release_invalid_version');
      enabled(this.store, id);
      const existing = this.store.transaction(() => {
        releaseIdleDrafts(this.store);
        const found = this.current(id, input.version as string); if (found) return found;
        if (this.store.get('SELECT id FROM project_releases WHERE repository_id=? AND active=1', id)) return fail(409, 'release_repository_busy');
      });
      if (existing) return { release: this.view(existing) };
      const saved = this.store.get('SELECT * FROM release_preflights WHERE token=? AND repository_id=? AND actor_id=? AND expires_at>?', String(input.credential || ''), id, user.id, Date.now());
      if (!saved || input.target_sha !== JSON.parse(saved.data).target_sha) return fail(409, 'release_preflight_expired');
      const redactor = releaseRedactor(this.store, id);
      const preview = await withGitHub(this.store, id, this.apiUrl, { pull_requests: 'read' }, redactor, github => inspect(github, input.version as string, releaseNotesPrompt(this.store, id)));
      if (preview.target_sha !== input.target_sha || fingerprint(preview) !== saved.fingerprint) return fail(409, 'release_candidate_changed');
      if (preview.no_changes) return fail(409, 'release_no_changes');
      if (preview.version_behind) return fail(409, 'release_version_not_higher');
      if (!preview.available) return fail(409, 'release_preflight_failed');
      const row = this.store.transaction(() => {
        releaseIdleDrafts(this.store);
        const found = this.current(id, input.version as string); if (found) return found;
        if (this.store.get('SELECT id FROM project_releases WHERE repository_id=? AND active=1', id)) return fail(409, 'release_repository_busy');
        const releaseId = randomId(), now = new Date().toISOString();
        const inserted = this.store.run(`INSERT INTO project_releases(id,repository_id,version,target_sha,actor_id,stage,data,created_at,updated_at) VALUES(?,?,?,?,?,'tagging',?,?,?) ON CONFLICT DO NOTHING`,
          releaseId, id, preview.version, preview.target_sha, user.id, JSON.stringify(redactor.clean({ ...preview, body: '', body_revision: 0, failure_step: null })), now, now);
        if (!inserted.changes) return this.current(id, input.version as string) ?? fail(409, 'release_repository_busy');
        this.store.audit(user.id, 'release.confirm', releaseId, id);
        return this.find(id, releaseId);
      });
      return { release: this.view(row) };
    }
    const operation = /^([^/]+)\/(rerun|resume)$/.exec(action);
    if (operation && method === 'POST') {
      fields(input, ['revision']); this.find(id, operation[1]!); enabled(this.store, id);
      if (!Number.isSafeInteger(input.revision)) return fail(400, 'release_revision_required');
      const row = this.claim(operation[1]!, input.revision), redactor = releaseRedactor(this.store, id);
      try {
        if (operation[2] === 'rerun') {
          this.store.audit(user.id, 'release.rerun', row.id, id);
          await withGitHub(this.store, id, this.apiUrl, { actions: 'write' }, redactor, github => this.worker.rerun(github, row, redactor), () => this.guard(row));
        } else {
          const data = JSON.parse(row.data);
          if (!['failed', 'write_unknown', 'waiting_permission'].includes(row.stage) || !['tagging', 'waiting_run', 'running', 'preparing_notes', 'creating_draft', 'rerun', 'save_draft', 'publishing'].includes(data.failure_step) || data.error === 'release_ci_unsuccessful') return fail(409, 'release_resume_unavailable');
          this.store.audit(user.id, 'release.resume', row.id, id);
          if (data.failure_step === 'rerun') await withGitHub(this.store, id, this.apiUrl, {}, redactor, github => this.worker.reconcileRerun(github, row), () => this.guard(row));
          else if (data.failure_step === 'save_draft') await withGitHub(this.store, id, this.apiUrl, {}, redactor, github => this.worker.reconcileSave(github, row, redactor), () => this.guard(row));
          else if (data.failure_step === 'publishing') await withGitHub(this.store, id, this.apiUrl, {}, redactor, github => this.worker.reconcilePublish(github, row, redactor), () => this.guard(row));
          else this.save(row, { error: null, detail: '', failure_step: null }, data.failure_step);
          this.store.run('UPDATE project_releases SET next_poll=0 WHERE id=?', row.id);
        }
      } catch (error) { if ((error as any).status) throw error; this.worker.failed(row, error, redactor, operation[2] === 'rerun' ? 'rerun' : JSON.parse(row.data).failure_step || row.stage); }
      finally { this.unlock(row); }
      return { release: this.view(row) };
    }
    const draft = /^([^/]+)\/draft$/.exec(action);
    if (draft && method === 'PATCH') {
      fields(input, ['revision', 'body_revision', 'body']); this.find(id, draft[1]!); enabled(this.store, id);
      if (!Number.isSafeInteger(input.revision) || !Number.isSafeInteger(input.body_revision) || typeof input.body !== 'string' || Buffer.byteLength(input.body) > 120000 || input.body.includes('\0')) return fail(400, 'release_invalid_draft');
      const row = this.claim(draft[1]!, input.revision), redactor = releaseRedactor(this.store, id);
      try {
        this.store.audit(user.id, 'release.save_draft', row.id, id);
        await withGitHub(this.store, id, this.apiUrl, { contents: 'write' }, redactor, github => this.worker.saveDraft(github, row, input.body as string, input.body_revision, redactor), () => this.guard(row));
      } catch (error) { if ((error as any).status) throw error; this.worker.failed(row, error, redactor, 'save_draft'); }
      finally { this.unlock(row); }
      return { release: this.view(row) };
    }
    const publication = /^([^/]+)\/publish$/.exec(action);
    if (publication && method === 'POST') {
      fields(input, ['revision', 'body_revision']); enabled(this.store, id);
      const found = this.find(id, publication[1]!);
      if (['published', 'externally_published'].includes(found.stage)) return { release: this.view(found) };
      if (!Number.isSafeInteger(input.revision) || !Number.isSafeInteger(input.body_revision)) return fail(400, 'release_revision_required');
      const row = this.claim(found.id, input.revision), redactor = releaseRedactor(this.store, id);
      try {
        this.store.audit(user.id, 'release.publish', row.id, id);
        await withGitHub(this.store, id, this.apiUrl, { contents: 'write' }, redactor, github => this.worker.publish(github, row, user.id, input.body_revision, redactor), () => this.guard(row));
      } catch (error) { if ((error as any).status) throw error; this.worker.failed(row, error, redactor, row.stage === 'running' ? 'running' : 'publishing'); }
      finally { this.unlock(row); }
      return { release: this.view(row) };
    }
    const observation = /^([^/]+)\/observe$/.exec(action);
    if (observation && method === 'POST') {
      fields(input, ['revision']); this.find(id, observation[1]!); enabled(this.store, id);
      if (!Number.isSafeInteger(input.revision)) return fail(400, 'release_revision_required');
      // CI observation can be switched off in the project configuration.
      if (!workActive(this.store, id, 'release.observe')) return fail(409, 'work_disabled');
      // The Manager decides on the request; the release page shows the analysis once its task is done.
      const row = this.find(id, observation[1]!);
      if (row.revision !== input.revision) return fail(409, 'release_revision_conflict');
      if (!JSON.parse(row.data).run_id) return fail(409, 'release_no_bound_run');
      this.store.audit(user.id, 'release.observe', row.id, id);
      requestObservation(this.store, row);
      return { release: this.view(this.find(id, row.id)) };
    }
    return fail(404, 'not_found');
  }
  current(id: string, version: string) {
    return this.store.get('SELECT * FROM project_releases WHERE repository_id=? AND version=?', id, version);
  }
  find(repositoryId: string, id: string) {
    return this.store.get('SELECT * FROM project_releases WHERE id=? AND repository_id=?', id, repositoryId) ?? fail(404, 'release_not_found');
  }
  view(row: any): Json {
    const data = JSON.parse(row.data); if (data.skill) delete data.skill.content;
    const initiator = this.store.get('SELECT username FROM users WHERE id=?',row.actor_id);
    return releaseRedactor(this.store, row.repository_id).clean({ ...data, id: row.id, repository_id: row.repository_id, version: row.version, target_sha: row.target_sha, stage: row.stage, revision: row.revision, initiator: initiator ? { name: initiator.username } : null, created_at: row.created_at, updated_at: row.updated_at });
  }
  save(row: any, patch: any, stage = row.stage, active = !['failed', 'published', 'externally_published'].includes(stage) && (stage !== 'draft' || !!row.lease)) {
    this.store.transaction(() => {
      const latest = this.store.get('SELECT data FROM project_releases WHERE id=?', row.id);
      const data = JSON.stringify({ ...JSON.parse(latest?.data || row.data), ...patch }), now = new Date().toISOString();
      const result = this.store.run('UPDATE project_releases SET data=?,stage=?,active=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND lease IS ?',
        data, stage, active ? 1 : 0, now, row.id, row.revision, row.lease);
      if (!result.changes) return stop('release_record_changed', 'failed', '发布记录已变化，请刷新。');
      Object.assign(row, { data, stage, active: active ? 1 : 0, revision: row.revision + 1, updated_at: now });
    });
  }
  claim(id: string, revision?: unknown): any {
    return this.store.transaction(() => {
      releaseIdleDrafts(this.store);
      const row = this.store.get('SELECT * FROM project_releases WHERE id=?', id); if (!row) return fail(404, 'release_not_found');
      if (revision !== undefined && row.revision !== revision) return fail(409, 'release_revision_conflict');
      if (row.lease_until > Date.now()) return fail(409, 'release_busy');
      const active = this.store.get('SELECT id FROM project_releases WHERE repository_id=? AND active=1 AND id<>?', row.repository_id, row.id);
      if (active) return fail(409, 'release_repository_busy');
      const token = randomId();
      if (!this.store.run('UPDATE OR IGNORE project_releases SET lease=?,lease_until=?,active=1 WHERE id=?', token, Date.now() + 300_000, id).changes)
        return fail(409, 'release_repository_busy');
      return { ...row, lease: token, active: 1 };
    });
  }
  async guard(row: any) {
    const project = this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', row.repository_id);
    try {
      if (!project?.tenant_id) throw new Error('tenant_unknown');
      authorize(resolvePrincipalActor(this.store, row.actor_id, project.tenant_id, row.repository_id), 'release.manage');
    } catch { return stop('release_actor_permission_revoked', 'waiting_permission', '发起人的当前项目发布权限已失效，请由仍有权限的管理员处理。'); }
    const found = this.store.run('UPDATE project_releases SET lease_until=? WHERE id=? AND lease=? AND lease_until>?', Date.now() + 300_000, row.id, row.lease, Date.now());
    if (!found.changes) return stop('release_lease_lost', 'write_unknown', '发布租约已失效，停止写入并等待查证。');
  }
  unlock(row: any) { this.store.run("UPDATE project_releases SET lease=NULL,lease_until=0,active=CASE WHEN stage IN ('draft','failed','published','externally_published') THEN 0 ELSE active END WHERE id=? AND lease=?", row.id, row.lease); }
}
