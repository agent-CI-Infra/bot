import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { seedInstallation } from '../../../fixtures/identity-fixture.mjs';

// #1039: axe is not a dependency of this repository, so these assertions are the two axe rules that found the defect,
// written as structure: page-has-heading-one (exactly one visible h1 starts the page) and heading-order (no level is
// skipped). Headings inside a hidden panel and the board's display:none page title do not count, exactly as the audit
// measured them in a real browser.
//
// The issue accepts heading-order 0 on settings, not on the four audited list routes, so nothing here is a hand-written
// route list: the settings categories are read from the page's own registry (static/settings/nav.js populates
// `settingsSections`, the same array the navigation bar is built from), and the detail addresses are read from the
// detail links the list cards render. A category or a detail page added later is covered without editing this file.
async function visibleHeadings(page) {
  return page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter(node => {
      if (node.closest('[hidden]') || node.closest('[aria-hidden="true"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map(node => ({ level: Number(node.tagName.slice(1)), text: node.textContent.trim() })));
}
// Every page is judged at once so one red run names every route that fails, not just the first.
async function outlineProblems(page, route) {
  const headings = await visibleHeadings(page), problems = [];
  const h1s = headings.filter(heading => heading.level === 1);
  if (!headings.length) problems.push(`${route}: no visible heading`);
  else {
    if (headings[0].level !== 1) problems.push(`${route}: first heading is h${headings[0].level} "${headings[0].text}"`);
    if (h1s.length !== 1) problems.push(`${route}: ${h1s.length} visible h1 (${h1s.map(heading => `"${heading.text}"`).join(', ') || 'none'})`);
    for (let index = 1; index < headings.length; index++) {
      if (headings[index].level - headings[index - 1].level > 1) {
        problems.push(`${route}: h${headings[index - 1].level} "${headings[index - 1].text}" jumps to h${headings[index].level} "${headings[index].text}"`);
      }
    }
  }
  return { headings, problems };
}
// Settings cards load after the shell. Wait deterministically for the real outline instead of a fixed delay: sample the
// headings inside the panel until the signature is non-empty and unchanged across two consecutive samples, so a slow
// page is never judged while only the page title exists (that outline would pass silently). Exhausting the attempts is a
// failure, not a "use the last sample anyway" success: an outline that never settles cannot be asserted green.
async function settledHeadings(page, attempts = 200) {
  const sample = () => page.evaluate(() => [...document.querySelectorAll('#settings-panel h1, #settings-panel h2, #settings-panel h3, #settings-panel h4, #settings-panel h5, #settings-panel h6')]
    .map(node => `${node.tagName} ${node.textContent.trim()}`).join('\n'));
  let previous = await sample();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.waitForTimeout(25);
    const current = await sample();
    if (current && current === previous) return current;
    previous = current;
  }
  return { settled: false, signature: previous };
}
async function openSettings(page, base, route) {
  await page.goto(base + '/' + route);
  const content = page.locator('#settings-panel .project-content');
  await expect(content).toBeVisible();
  await expect(content).not.toContainText('正在加载…');
  // The settled signature is what openSettings guarantees; outlineProblems re-reads the viewport-visible headings.
  const settled = await settledHeadings(page);
  expect(typeof settled, `${route}: the settings panel headings never settled (last sample: ${JSON.stringify(settled)})`).toBe('string');
  expect(settled.length, `${route}: the settings panel rendered no heading`).toBeGreaterThan(0);
  return content;
}

const viewports = [[390, 844], [768, 1024], [1440, 900]];

for (const [width, height] of viewports) {
  test(`#1039 board, every settings route and identity keep one h1 and an unbroken heading order at ${width}px`, async ({ page }) => {
    test.setTimeout(240000);
    const h = await harness(), { admin, password } = await setup(h);
    try {
      const a = await account(admin);
      await repository(admin, a.id, '101');
      // The installation list only renders a detail link for an installation the deployment knows about.
      seedInstallation(h, a.id, { type: 'Organization', selection: 'selected' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height });
      await page.goto(h.admin);
      await page.getByLabel('用户名', { exact: true }).fill('administrator');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('#workspace')).toBeVisible();
      await expect(page.locator('#page-title')).toHaveText('项目');
      const problems = [], checked = [], detail = [];

      // Project overview PR Progress keeps one visible h1 (the project name in the header) and an unbroken heading order.
      await page.goto(h.admin + '/#/projects/101/overview/prs');
      await expect(page.locator('.workspace-overview')).toBeVisible();
      await expect(page.locator('.workbench-pr-section')).toBeVisible();
      const prs = await outlineProblems(page, '#/projects/101/overview/prs');
      problems.push(...prs.problems);
      checked.push('#/projects/101/overview/prs');

      // The categories come from the registry the settings shell itself uses, so a new section is covered by adding it
      // to static/settings/nav.js and nothing else. The checked list below is what the count at the end asserts on:
      // every section, every detail page the lists render, and the two pages outside settings.
      const sections = await page.evaluate(() => {
        location.hash = '#/settings/work-computers';
        return settingsSections.map(([key]) => key);
      });
      expect(sections.length).toBeGreaterThanOrEqual(14);
      for (const key of sections) {
        const route = '#/settings/' + key, content = await openSettings(page, h.admin, route);
        // A category that cannot read its data still renders its own card or its error card, never a blank page.
        await expect(content.locator('.side-card, .console-state').first()).toBeVisible();
        problems.push(...(await outlineProblems(page, route)).problems);
        checked.push(route);
        // A list card links to its records' detail pages; take one address per category, so a detail page added later
        // (or a new list category) is covered without naming it here.
        const links = await content.locator('a[href]').evaluateAll((nodes, prefix) => nodes.map(node => node.getAttribute('href'))
          .filter(href => href && href.startsWith(prefix + '/')), route);
        if (links.length) detail.push(links[0]);
      }
      // The address without a section falls back to the first registered category (static/settings/nav.js), so that
      // page is covered by the loop above; this only proves the fallback still points at it.
      await openSettings(page, h.admin, '#/settings');
      const fallback = await page.evaluate(() => [...document.querySelectorAll('[aria-current="page"]')]
        .map(node => node.getAttribute('href')).find(href => href?.startsWith('#/settings/')));
      if (fallback !== '#/settings/' + sections[0]) problems.push(`#/settings: falls back to ${fallback}, not #/settings/${sections[0]}`);

      // The three detail pages the issue names must be among them; the walk above also picks up any other address a
      // list card links to (today the Feishu setup step and the hidden-projects page), so nothing reachable is skipped.
      for (const section of ['users', 'installations', 'accounts']) {
        if (!detail.some(route => route.split('/')[2] === section)) problems.push(`#/settings/${section}: its detail page was not found`);
      }
      for (const route of detail) {
        const content = await openSettings(page, h.admin, route);
        await expect(content.locator('.side-card').first()).toBeVisible();
        problems.push(...(await outlineProblems(page, route)).problems);
        checked.push(route);
      }

      // The identity overview is the first card; the cards after it may be h3, the overview itself may not be.
      await page.goto(h.admin + '/#/identity');
      await expect(page.locator('.identity-overview')).toBeVisible();
      const identity = await outlineProblems(page, '#/identity');
      problems.push(...identity.problems);
      checked.push('#/identity');
      if (identity.headings[1] && identity.headings[1].level !== 2) {
        problems.push(`#/identity: the overview card is h${identity.headings[1].level}, not h2`);
      }

      // 14 settings sections + 3 detail pages + board + identity today; the first term grows with the registry.
      expect(checked.length).toBe(sections.length + detail.length + 2);
      expect(problems).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await h.stop(); }
  });
}
