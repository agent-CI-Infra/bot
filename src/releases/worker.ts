import type { ReleaseService } from './service.js';
import type { GitHub } from '../github/client.js';
import { digest } from '../core/security.js';
import { stop, type Redactor } from '../agent/common.js';
import { tag, releaseRedactor, withGitHub } from './github.js';

export class ReleaseWorker {
  constructor(readonly service: ReleaseService) {}
  async effect(row: any, kind: string, request: any, send: () => Promise<any>, probe: () => Promise<any | null>, redactor: Redactor) {
    const store = this.service.store, id = row.id + ':' + kind, hash = digest(JSON.stringify(request));
    let saved = store.get('SELECT * FROM release_effects WHERE id=?', id);
    if (saved && saved.request_hash !== hash) return stop('release_operation_changed', 'failed', '已登记的发布写入内容发生变化。');
    if (saved?.state === 'sent') return JSON.parse(saved.response);
    const known = await probe();
    if (known) {
      const now = new Date().toISOString();
      store.run(`INSERT INTO release_effects VALUES(?,?,?,?,'sent',?,?,?) ON CONFLICT(id) DO UPDATE SET state='sent',response=excluded.response,updated_at=excluded.updated_at`,
        id, row.id, kind, hash, JSON.stringify(redactor.clean(known)), now, now);
      return known;
    }
    if (saved && ['inflight', 'unknown'].includes(saved.state)) return stop('release_write_unknown', 'write_unknown', `${kind} 写入结果尚未查明，未重复发送。请在 GitHub 查证后刷新或继续查询。`);
    const now = new Date().toISOString();
    store.run(`INSERT INTO release_effects VALUES(?,?,?,?,'pending',NULL,?,?) ON CONFLICT(id) DO NOTHING`, id, row.id, kind, hash, now, now);
    await this.service.guard(row);
    store.run("UPDATE release_effects SET state='inflight',updated_at=? WHERE id=?", now, id);
    try {
      const response = await send();
      store.run("UPDATE release_effects SET state='sent',response=?,updated_at=? WHERE id=?", JSON.stringify(redactor.clean(response)), new Date().toISOString(), id);
      return response;
    } catch (error) {
      const code = (error as any).code || '';
      const uncertain = code === 'github_response_unknown' || code === 'github_invalid_response';
      store.run('UPDATE release_effects SET state=?,updated_at=? WHERE id=?', uncertain ? 'unknown' : 'pending', new Date().toISOString(), id);
      // A timeout or ref conflict can still have succeeded. Read the remote result before deciding anything else.
      if (uncertain || code === 'github_http_422') {
        const found = await probe();
        if (found) { store.run("UPDATE release_effects SET state='sent',response=? WHERE id=?", JSON.stringify(redactor.clean(found)), id); return found; }
      }
      if (uncertain) return stop('release_write_unknown', 'write_unknown', `${kind} 写入结果尚未确认，未重复发送。`);
      throw error;
    }
  }
  async checkedTag(github: GitHub, row: any) {
    const value = await tag(github, row.version);
    if (value && value.commit !== row.target_sha) return stop('release_tag_conflict', 'failed', `标签 ${row.version} 指向 ${value.commit}，确认的提交是 ${row.target_sha}；不会移动或删除标签。`);
    return value;
  }
  async process(id: string) {
    let row: any; try { row = this.service.claim(id); } catch { return; }
    const redactor = releaseRedactor(this.service.store, row.repository_id);
    try {
      await withGitHub(this.service.store, row.repository_id, this.service.apiUrl, row.stage === 'tagging' ? { contents: 'write' } : {}, redactor,
        async github => { if (row.stage === 'tagging') await this.tagging(github, row, redactor); }, () => this.service.guard(row));
    } catch (error) { this.failed(row, error, redactor); }
    finally { this.service.unlock(row); }
  }
  failed(row: any, error: any, redactor: Redactor) {
    const stage = error.state === 'waiting_permission' ? 'waiting_permission' : error.state === 'write_unknown' ? 'write_unknown' : 'failed';
    this.service.save(row, { failure_step: row.stage, error: error.code || 'release_failed', detail: redactor.text(error.detail || '发布步骤失败，请检查接入和 GitHub 状态。') }, stage);
  }
  async tagging(github: GitHub, row: any, redactor: Redactor) {
    let existing = await this.checkedTag(github, row);
    if (existing) { this.service.save(row, { tag_object_sha: existing.object_sha, reused_tag: true, tagged_at: null }, 'waiting_run'); return; }
    const object = await this.effect(row, 'tag_object', { tag: row.version, message: row.version, object: row.target_sha, type: 'commit' },
      () => github.request('POST', github.path('/git/tags'), { tag: row.version, message: row.version, object: row.target_sha, type: 'commit' }),
      async () => { const found = await this.checkedTag(github, row); return found ? { sha: found.object_sha } : null; }, redactor);
    const data = JSON.parse(row.data), taggedAt = data.tagged_at || new Date().toISOString();
    this.service.save(row, { tag_object_sha: object.sha, tagged_at: taggedAt });
    await this.effect(row, 'tag_ref', { ref: 'refs/tags/' + row.version, sha: object.sha },
      () => github.request('POST', github.path('/git/refs'), { ref: 'refs/tags/' + row.version, sha: object.sha }),
      async () => { const found = await this.checkedTag(github, row); return found ? { object: { sha: found.object_sha } } : null; }, redactor);
    existing = await this.checkedTag(github, row);
    if (!existing) return stop('release_write_unknown', 'write_unknown', '标签引用写入后仍不可见，请先查证。');
    this.service.save(row, { tag_object_sha: existing.object_sha, reused_tag: false, wait_started_at: Date.now() }, 'waiting_run');
  }
}
