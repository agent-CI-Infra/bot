import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { harness } from './helpers.mjs';

test('the console serves a favicon without a 404', async (t) => {
  const h = await harness();
  t.after(async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); });
  const ico = await fetch(h.admin + '/favicon.ico');
  assert.equal(ico.status, 200);
  assert.match(ico.headers.get('content-type'), /^image\/x-icon$/);
  const bytes = Buffer.from(await ico.arrayBuffer());
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const svg = await fetch(h.admin + '/favicon.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(await svg.text(), /launchpad/);
});

test('console eyebrows are complete Chinese phrases, not English labels', () => {
  const sources = ['static/shell.js', 'static/workspace.js', 'static/task-create.js'].map(path => readFileSync(path, 'utf8')).join('\n');
  for (const label of ['NEEDS ATTENTION', 'PROJECT OVERVIEW', 'NEW TASK']) assert.equal(sources.includes(label), false, label);
  assert.match(sources, /element\('p', '工作区', 'eyebrow'\)/);
  assert.match(sources, /element\('p', '需要关注', 'eyebrow'\)/);
  assert.match(sources, /element\('p', '总览', 'eyebrow'\)/);
  assert.match(sources, /element\('p', '新任务', 'eyebrow'\)/);
  assert.doesNotMatch(sources, /element\('p', 'WORKSPACE', 'eyebrow'\)/);
});
