import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCategory, applyReleaseCategory } from '../dist/github/release-label.js';

function github(extra = {}) {
  const state = { labels: [], reads: [], writes: [], ...extra };
  return { state, fullName: 'openJiuwen-ai/sciencediscovery', defaultBranch: 'main', path: s => s,
    pages: async () => state.labels.map(name => ({ name })),
    request: async (method, path, body) => {
      if (method === 'GET') { state.reads.push(path); return { encoding: 'base64', content: Buffer.from(path.includes('release.yml') ? 'changelog:\n  categories:\n    - labels: [release:fix, release:internal]\n  exclude:\n    labels: [release:skip]\n' : 'Current contribution and category selection rules').toString('base64') }; }
      state.writes.push({ path, body }); if (state.denied) throw new Error('Permission denied');
      if (!state.noApply) state.labels.push(...body.labels);
      if (state.conflict) state.labels.push('release:internal');
    } };
}

test('target-specific contribution contract reads current files and validates the selected category', async () => {
  const g = github(); assert.equal(await releaseCategory(g, 'release:fix'), 'release:fix'); assert.equal(g.state.reads.length, 3);
  await assert.rejects(releaseCategory(g, 'release:invented'), { code: 'pr_release_category_required' });
  await assert.rejects(releaseCategory(g, undefined), { code: 'pr_release_category_required' });
  assert.equal(await releaseCategory({ fullName: 'fixture/project' }, undefined), null);
});
test('release label is read back and failure or conflict remains incomplete', async () => {
  const g = github(); await applyReleaseCategory(g, 1, 'release:fix'); await applyReleaseCategory(g, 1, 'release:fix'); assert.equal(g.state.writes.length, 1);
  for (const change of [{ denied: true }, { noApply: true }, { conflict: true }]) await assert.rejects(applyReleaseCategory(github(change), 1, 'release:fix'), { code: 'pr_release_label_incomplete' });
  const conflict = github({ labels: ['release:internal'] }); await assert.rejects(applyReleaseCategory(conflict, 1, 'release:fix'), { code: 'pr_release_label_conflict' }); assert.equal(conflict.state.writes.length, 0);
});
