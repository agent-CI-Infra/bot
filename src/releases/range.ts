import type { GitHub } from '../github/client.js';
import { validVersion, compareVersions } from './version.js';
import { resolveObject } from './github.js';
import { stop } from '../agent/common.js';

export async function history(github: GitHub, sha: string) {
  return github.pages(github.path('/commits?sha=' + sha));
}
export async function previousTag(github: GitHub, target: string, version: string) {
  const commits = await history(github, target), reachable = new Set(commits.map(c => c.sha));
  const refs = (await github.pages(github.path('/tags'))).filter(t => t.name !== version && validVersion(t.name))
    .sort((a, b) => compareVersions(b.name, a.name));
  for (const candidate of refs) {
    const ref = await github.request('GET', github.path('/git/ref/tags/' + encodeURIComponent(candidate.name)));
    const resolved = await resolveObject(github, ref.object);
    if (reachable.has(resolved.commit)) return { name: String(candidate.name), sha: resolved.commit };
  }
  return null;
}
export type Source = { id: string; kind: 'commit' | 'pr'; sha: string; title: string; url: string; number?: number };
export async function sources(github: GitHub, target: string, previous: { name: string; sha: string } | null): Promise<Source[]> {
  const all = await history(github, target), before = new Set(previous ? (await history(github, previous.sha)).map(c => c.sha) : []);
  if (previous && !all.some(c => c.sha === previous.sha)) stop('release_range_changed', 'failed', '已冻结的上一枚标签提交不在本次历史内。');
  const commits = [...new Map(all.filter(c => !before.has(c.sha)).map(c => [c.sha, c])).values()], included = new Set(commits.map(c => c.sha));
  const result: Source[] = commits.map(c => ({ id: c.sha, kind: 'commit', sha: c.sha, title: String(c.commit?.message || '').split('\n')[0]!, url: c.html_url }));
  const prs = new Map<number, Source>();
  for (const commit of commits) {
    for (const pr of await github.pages(github.path('/commits/' + commit.sha + '/pulls'))) {
      if (pr.merged_at && included.has(pr.merge_commit_sha) && String(pr.base?.repo?.id) === String(github.repository.id))
        prs.set(pr.number, { id: 'pr:' + pr.number, kind: 'pr', sha: pr.merge_commit_sha, number: pr.number, title: pr.title, url: pr.html_url });
    }
  }
  return [...result, ...prs.values()];
}
