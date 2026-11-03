import type { Store } from '../storage/database.js';
import type { Actor } from '../app/auth.js';
import { repository } from '../app/auth.js';
import { fail, fields, text, type Json } from '../core/security.js';
import { releaseStorage } from './storage.js';
import { inspect, fingerprint, preflightToken } from './preflight.js';
import { releaseRedactor, withGitHub } from './github.js';

export class ReleaseService {
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com') { releaseStorage(store); }
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([^/]+)\/releases(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return undefined;
    const id = match[1]!, action = match[2] || ''; repository(this.store, user, id);
    if (method === 'GET' && action === 'preflight') {
      const version = url.searchParams.get('version') || '', redactor = releaseRedactor(this.store, id);
      try {
        const preview = await withGitHub(this.store, id, this.apiUrl, { pull_requests: 'read' }, redactor, github => inspect(github, version));
        const token = preflightToken();
        this.store.run('DELETE FROM release_preflights WHERE expires_at<?', Date.now());
        this.store.run('INSERT INTO release_preflights VALUES(?,?,?,?,?,?)', token, id, user.id, fingerprint(preview), JSON.stringify(preview), Date.now() + 10 * 60_000);
        const { content, ...skill } = preview.skill;
        return redactor.clean({ ...preview, skill, credential: token });
      } catch (error) {
        const e = error as any;
        return { available: false, version, checks: [], error: String(e.code || 'release_check_failed'), detail: redactor.text('暂时无法检查：' + (e.detail || e.message || 'GitHub 连接失败')) };
      }
    }
    if (method === 'GET' && !action) return { releases: this.store.all('SELECT * FROM project_releases WHERE repository_id=? ORDER BY created_at DESC', id).map(row => this.view(row)) };
    if (method === 'GET' && action && !action.includes('/')) return { release: this.view(this.find(id, action)) };
    return fail(404, 'not_found');
  }
  find(repositoryId: string, id: string) {
    return this.store.get('SELECT * FROM project_releases WHERE id=? AND repository_id=?', id, repositoryId) ?? fail(404, 'release_not_found');
  }
  view(row: any): Json { return { ...JSON.parse(row.data), id: row.id, repository_id: row.repository_id, version: row.version, target_sha: row.target_sha, stage: row.stage, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at }; }
}
