// Screenshot evidence generator for #224 slice 1 (design tokens + component/state samples).
// Not a test: Playwright only collects *.spec.mjs, so this file never runs in CI. It starts the real
// control plane through test/helpers.mjs, signs in with a fixture account and captures the real console
// pages at the viewports the PR body compares. Run it from the repository root on the base SHA and on
// the tip SHA, then diff the two directories; `design.diff.mjs` does the pixel comparison.
//
//   node e2e/design.evidence.mjs .local/evidence/before
//
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

const out = resolve(process.argv[2] || '.tmp/design-evidence');
mkdirSync(out, { recursive: true });

// The three viewports the PR compares, plus the two widths where the shell reflows.
const viewports = [[390, 844], [768, 1024], [1024, 900], [1440, 1000], [1920, 1080]];
// Real product pages, not a prototype: the projects list, the global settings category, the task board and the
// component/state catalog this PR adds (absent on the base SHA, where the address falls back to the projects page).
const pages = [['projects', '#/projects'], ['settings', '#/settings/users'], ['board', '#/board'], ['design', '#/design']];

const h = await harness();
const browser = await chromium.launch();
try {
  const { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  // The console prints a user id on the users page; registration mints a random one, so pin it and the two captures agree.
  // Setup already opened a session that references the old id; sign in again below, so drop it first.
  h.store.run('DELETE FROM sessions');
  h.store.run("UPDATE users SET id='user-fixture-0001' WHERE username='administrator'");
  for (const [id, status, summary] of [['t1', 'running', '检视 issue #12'], ['t2', 'succeeded', '开发 issue #9'], ['t3', 'waiting_permission', '开发 issue #10']])
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,head_sha,attempt) VALUES(?,?,?,?,?,?,?,?,1)",
      id, '101', id === 't1' ? 'review.issue' : 'development.issue', status, summary, 12, id === 't1' ? 'model' : 'done', 'a'.repeat(40));
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const shot = await context.newPage();
  // Sign in once; the session cookie carries every viewport.
  await shot.setViewportSize({ width: viewports[0][0], height: viewports[0][1] });
  await shot.goto(h.admin + '/');
  await shot.getByLabel('用户名', { exact: true }).fill('administrator');
  await shot.getByLabel('密码', { exact: true }).fill(password);
  await shot.getByRole('button', { name: '登录', exact: true }).click();
  // main's shell marks the signed-in console on <body>; #tabs stays hidden on the new shell, so wait for the shell.
  await shot.waitForFunction(() => document.body.classList.contains('console-ready'));
  for (const [width, height] of viewports) {
    await shot.setViewportSize({ width, height });
    for (const [name, address] of pages) {
      await shot.goto(h.admin + '/' + address);
      await shot.waitForLoadState('networkidle').catch(() => {});
      await shot.waitForTimeout(150);
      await shot.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
    }
  }
  await context.close();
} finally { await browser.close(); await h.stop(); }
console.log('wrote screenshots to ' + out);
