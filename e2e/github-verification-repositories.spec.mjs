import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { consoleNavigate } from './console-navigation.mjs';

// #866: the permission check ended, but reading the projects it just changed failed. The reader must not be left with the
// old list and no word: the line says the list could not be read and offers to read it again; a read that comes back
// draws the new projects and takes the notice away.
//
// One read, one recovery: the redraw that puts the finished check on screen must not read the list again (that would draw
// fresh rows beside a notice saying the read failed, and offer a second retry for one read). The recovery is a read of the
// whole list — the notice's button — because the project picker stands for the whole list while the list page reads one
// page of it (offset, limit 51, maybe a filter). A page or filtered read is a slice: the notice and the picker stay put.
const output = '.tmp/ui-866';
const noOverflow = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

// The check is held at its first installation read, so the page can be put where the failure will happen before it ends.
async function checkedConsole(page, f) {
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  // The next project-list read is armed to fail the way a control plane that is down answers; every later read goes
  // through to the service. render() reads /api/repositories?<params>, so the glob carries the star — without it the stub
  // would miss the very read under test and the "failure" would be a read that succeeded.
  let failNext = false;
  const listReads = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repositories') listReads.push(request.url()); });
  await page.route('**/api/repositories*', route => {
    if (!failNext) return route.continue();
    failNext = false;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) });
  });
  await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
  const line = page.locator('#github-verification');
  await expect(line).toBeVisible();
  const picker = page.locator('#console-project option', { hasText: 'fixture/project-101' });
  await expect(picker).toHaveCount(0);
  return { release, arm: () => { listReads.length = 0; failNext = true; release(); }, listReads, line, picker };
}

test('项目页上核验完成而列表读取失败：只读一次、不出现第二个重试，只有整份列表的读取才清提示', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  mkdirSync(output, { recursive: true });
  const c = await checkedConsole(page, f);
  const rows = page.locator('#rows'), retry = c.line.getByRole('button', { name: '重新读取项目列表' });
  const shots = async name => {
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      // The notice and its button stay inside the width the reader has, at every one of them.
      if (await retry.isVisible()) {
        const box = await retry.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.height).toBeGreaterThan(0);
      }
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  try {
    // The failure lands on the page that shows the list.
    await consoleNavigate(page, '项目');
    c.arm();
    await expect(c.line).toHaveText('权限核验已完成，但项目列表读取失败。重新读取项目列表');
    await expect(c.line).toHaveAttribute('data-state', 'failed');
    await expect(c.picker).toHaveCount(0);
    // The list says the read failed, with no retry of its own: the notice above is the one recovery.
    await expect(rows).toContainText('项目列表未能读取');
    await expect(rows.locator('[role=alert]')).toContainText('权限核验已完成');
    await expect(rows.locator('[data-testid=console-state-retry]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新读取项目列表' })).toHaveCount(1);
    await expect(rows).not.toContainText('正在核验 GitHub 权限');
    expect(c.listReads, 'the redraw does not read the failed endpoint again').toHaveLength(1);
    await shots('repositories-failed');
    // Leaving for the identity page reads no project list, and its root no longer keeps the "after the check" placeholder.
    await consoleNavigate(page, '身份与权限');
    await expect(page.locator('#identity-panel')).not.toContainText('核验完成后显示你的 GitHub 连接与授权来源');
    await expect(c.line).toBeVisible();
    expect(c.listReads).toHaveLength(1);
    // Coming back reads one page of the list. A page cannot stand for the whole list, so the notice stays and the picker
    // stays empty: the page's own retry belongs to the console state below, not to this read.
    await consoleNavigate(page, '项目');
    await expect(rows).toContainText('fixture/project-101');
    await expect(c.line).toHaveText('权限核验已完成，但项目列表读取失败。重新读取项目列表');
    await expect(c.line).toHaveAttribute('data-state', 'failed');
    await expect(c.picker).toHaveCount(0);
    expect(c.listReads).toHaveLength(2);
    // The one recovery reads the whole list, and only then does the notice go and the picker follow it.
    await retry.click();
    await expect(c.line).toBeHidden();
    await expect(c.picker).toHaveCount(1);
    // The button read the whole list (no query), and the redraw it caused read the page that is on screen again.
    expect(c.listReads).toHaveLength(4);
    expect(new URL(c.listReads[2]).search, 'the recovery read the whole list').toBe('');
    await shots('repositories-read');
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; c.release(); await f.close(); }
});

test('身份页上核验完成而列表读取失败：行内按钮重读一次即恢复列表与项目切换器', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  const c = await checkedConsole(page, f);
  const retry = c.line.getByRole('button', { name: '重新读取项目列表' });
  try {
    // The GitHub login lands on the identity page, which is where the check ends.
    c.arm();
    await expect(c.line).toHaveAttribute('data-state', 'failed');
    await expect(c.picker).toHaveCount(0);
    expect(c.listReads).toHaveLength(1);
    // The only recovery reads the list, fills the picker and clears the notice.
    await retry.click();
    await expect(c.line).toBeHidden();
    await expect(c.picker).toHaveCount(1);
    expect(c.listReads).toHaveLength(2);
    // The project list the check was for now names the project, without reloading the page.
    await consoleNavigate(page, '项目');
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page).toHaveURL(/#\/projects$/);
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; c.release(); await f.close(); }
});

// #945: while the notice is up, the header's refresh runs start() again. That start() reads the same list, and it can fail
// the same way — the console that is already on screen must keep the notice and its one retry (the only retry a reader has
// there) instead of being swapped for the boot card. Once the endpoint answers again, the same refresh reads the whole
// list, so it counts as the recovery #866 describes: the notice goes and the picker follows.
test('故障期间点刷新：提示行与唯一重试不消失；端点恢复后刷新即算恢复', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  // The endpoint can be made to fail, and one read can be held in flight, so the state of the page during the refresh is
  // readable instead of guessed from the state after it.
  let failing = false, heldAgain = false, releaseHeld = null;
  const listReads = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repositories') listReads.push(request.url()); });
  await page.route('**/api/repositories*', async route => {
    if (!failing) return route.continue();
    if (heldAgain) { heldAgain = false; await new Promise(resolve => { releaseHeld = resolve; }); }
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) });
  });
  // The check is held at its first installation read, so the page is on the project list before the failure lands.
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  const listRead = () => page.waitForRequest(request => new URL(request.url()).pathname === '/api/repositories');
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    const line = page.locator('#github-verification'), rows = page.locator('#rows'), boot = page.locator('#boot');
    const picker = page.locator('#console-project option', { hasText: 'fixture/project-101' });
    const retry = page.getByRole('button', { name: '重新读取项目列表' });
    await expect(line).toBeVisible();
    await expect(picker).toHaveCount(0);
    await consoleNavigate(page, '项目');
    failing = true; listReads.length = 0; release();
    await expect(line).toHaveText('权限核验已完成，但项目列表读取失败。重新读取项目列表');
    await expect(rows).toContainText('项目列表未能读取');
    // The refresh re-reads the whole list. Its read is held in flight here: the notice and its one retry must already be
    // untouched while the read is out, or the reader is left with no retry the moment the console is rebuilt.
    heldAgain = true;
    const [inFlight] = await Promise.all([listRead(), page.locator('#refresh').click()]);
    expect(new URL(inFlight.url()).search, 'the refresh reads the whole list').toBe('');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-state', 'failed');
    await expect(line).toHaveText('权限核验已完成，但项目列表读取失败。重新读取项目列表');
    await expect(retry).toHaveCount(1);
    // The read fails like the one before it: the console stays, the notice stays, and the boot card does not take over.
    const card = await page.evaluateHandle(() => document.querySelector('#rows').firstElementChild);
    releaseHeld();
    await page.waitForFunction(node => document.querySelector('#rows').firstElementChild !== node, card);
    await expect(boot).toBeHidden();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-state', 'failed');
    await expect(retry).toHaveCount(1);
    await expect(rows).toContainText('项目列表未能读取');
    await expect(rows).not.toContainText('正在核验 GitHub 权限');
    // The endpoint is back: the same refresh reads the whole list, which is the recovery — notice gone, picker filled,
    // and the page on screen redrawn from it.
    failing = false;
    await page.locator('#refresh').click();
    await expect(line).toBeHidden();
    await expect(picker).toHaveCount(1);
    await expect(rows).toContainText('fixture/project-101');
    expect(new URL(listReads.at(-2)).search, 'the refresh read the whole list').toBe('');
    expect(new URL(listReads.at(-1)).search, 'the redraw read the page on screen').not.toBe('');
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; release(); releaseHeld?.(); await f.close(); }
});
