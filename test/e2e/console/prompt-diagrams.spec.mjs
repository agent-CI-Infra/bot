// #1123: Manager prompts open in a reading view whose ```mermaid blocks are drawn as flow diagrams. The diagram source is
// untrusted, so the page must stay inert whatever the block says, and the drawing must fit 390 / 768 / 1440 widths.
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { goRolePage } from '../helpers/open-role-advanced.mjs';
import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

const fence = body => '```mermaid\n' + body + '\n```';
const flow = fence('flowchart LR\n  A[Issue 带开发请求] --> B{依据充分?}\n  B -->|是| C[派给 Dev 开发]\n  B -->|否| D[评论说明缺什么]\n  C --> E[开 PR] --> F[独立 QA 验收]');
// A block Mermaid accepts that tries to leave the drawing: a directive asking for a loose security level, HTML labels
// and a theme stylesheet; HTML and script in labels; a javascript: link, a callback and its own colours. It is drawn,
// but none of it may run or reach the page as markup or inline style.
const attack = fence([
  '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": "body{display:none}"}}%%',
  'flowchart TD',
  '  X["<img src=x onerror=window.diagramAttack=1>"] --> Y["<b>粗体</b><script>window.diagramAttack=2</script>"]',
  '  click X href "javascript:window.diagramAttack=3"',
  '  click Y call alert(1)',
  '  classDef evil fill:#f00,stroke:#f00',
  '  class X evil',
  '  linkStyle 0 stroke:#f00'
].join('\n'));
const prompt = ['## ④ 特性开发与缺陷修复', '', '有明确开发请求的 Issue 才派开发。', '', flow, '', '- 依据不足时先评论，不派开发', '', '## 渲染安全', '', attack, '', '## 写错的图', '', fence('flowchart TD\n  A -->')].join('\n');

test('the Manager prompt reads as text with drawn diagrams, stays inert on hostile blocks and edits with a live preview', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push('dialog: ' + dialog.message()); void dialog.dismiss(); });
  mkdirSync('.tmp/prompt-diagrams', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const saved = (await admin('/api/repositories/101/manager')).value.manager.prompt.revision;
    expect((await admin('/api/repositories/101/manager', 'PUT', { expected_revision: saved, prompt })).status).toBe(200);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await goRolePage(page, { role: 'Manager' });

    // The reading view is the default; the textarea the form saves is there but hidden.
    const reading = page.getByRole('region', { name: 'Manager 提示词阅读视图', exact: true });
    await expect(reading.getByRole('heading', { name: '④ 特性开发与缺陷修复', exact: true })).toBeVisible();
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toBeHidden();
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toHaveValue(prompt);
    const figures = reading.locator('figure.diagram');
    await expect(figures).toHaveCount(3);
    await expect(figures.nth(0)).toHaveAttribute('data-diagram', 'ready', { timeout: 20000 });
    await expect(figures.nth(0).locator('svg text').filter({ hasText: '依据充分?' })).toHaveCount(1);
    await expect(figures.nth(0).locator('svg .node')).toHaveCount(6);
    // A block Mermaid cannot parse keeps its source open instead of a broken drawing.
    await expect(figures.nth(2)).toHaveAttribute('data-diagram', 'failed');
    await expect(figures.nth(2).locator('details.diagram-source')).toHaveAttribute('open', '');
    await expect(figures.nth(2)).toContainText('语法有误');

    // The hostile block is drawn, and nothing executable, styled or linked reached the page.
    await expect(figures.nth(1)).toHaveAttribute('data-diagram', 'ready', { timeout: 20000 });
    await expect(figures.nth(1).locator('svg text').filter({ hasText: '粗体' })).toHaveCount(1);
    const inert = await reading.evaluate(node => ({
      markup: node.querySelectorAll('figure.diagram :is(script, style, foreignObject, a, image, use, img, iframe)').length,
      inline: node.querySelectorAll('figure.diagram svg [style]').length,
      handlers: [...node.querySelectorAll('figure.diagram *')].flatMap(el => [...el.attributes].map(attr => attr.name)).filter(name => /^on|href$/i.test(name)),
      fills: [...node.querySelectorAll('figure.diagram svg *')].map(el => el.getAttribute('fill') || '').filter(fill => fill.includes('url(http'))
    }));
    expect(inert).toEqual({ markup: 0, inline: 0, handlers: [], fills: [] });
    for (const label of ['粗体', 'img']) await figures.nth(1).locator('svg .node').filter({ hasText: label }).dispatchEvent('click');
    expect(await page.evaluate(() => window.diagramAttack)).toBeUndefined();
    // The block's own colours stay out: its nodes are filled from the shared tokens like every other node.
    const fills = await reading.evaluate(node => [...node.querySelectorAll('figure.diagram')].slice(0, 2).map(figure => getComputedStyle(figure.querySelector('svg .node rect')).fill));
    expect(fills[1]).toBe(fills[0]);
    await expect(page.locator('body')).toBeVisible();

    // Each width: the page never scrolls sideways; a chart wider than the column scrolls inside its own frame.
    for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await figures.nth(0).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await figures.nth(0).locator('.diagram-canvas').evaluate(node => ({ client: node.clientWidth, page: innerWidth, right: node.getBoundingClientRect().right }));
      expect(box.right).toBeLessThanOrEqual(box.page);
      await page.screenshot({ path: `.tmp/prompt-diagrams/reading-${width}.png` });
    }

    // 编辑源码: the same textarea, with a preview that follows typing.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Manager 提示词：编辑源码', exact: true }).click();
    const editor = page.getByLabel('Manager 提示词', { exact: true });
    await expect(editor).toBeVisible(); await expect(editor).toBeFocused();
    const preview = page.getByRole('region', { name: 'Manager 提示词实时预览', exact: true });
    await editor.fill('## 新流程\n\n' + fence('flowchart TD\n  P[收到 PR] --> Q[检视]'));
    await expect(preview.getByRole('heading', { name: '新流程', exact: true })).toBeVisible();
    await expect(preview.locator('figure.diagram')).toHaveAttribute('data-diagram', 'ready', { timeout: 20000 });
    await expect(preview.locator('svg text').filter({ hasText: '检视' })).toHaveCount(1);
    await page.screenshot({ path: '.tmp/prompt-diagrams/edit-1440.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/prompt-diagrams/edit-390.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Manager 提示词：阅读视图', exact: true }).click();
    await expect(reading.getByRole('heading', { name: '新流程', exact: true })).toBeVisible();
    // The preview and the reading view now hold the same cached drawing: each copy has its own ids, and every
    // arrowhead points into its own SVG.
    await expect(reading.locator('figure.diagram')).toHaveAttribute('data-diagram', 'ready');
    const references = await page.evaluate(() => {
      const seen = new Set(), twice = [], dangling = [];
      for (const el of document.querySelectorAll('figure.diagram svg[id], figure.diagram svg [id]')) { if (seen.has(el.id)) twice.push(el.id); seen.add(el.id); }
      for (const el of document.querySelectorAll('figure.diagram svg [marker-end]')) {
        const id = /url\(#([^)]+)\)/.exec(el.getAttribute('marker-end'))?.[1];
        if (!id || !el.closest('svg').querySelector('#' + CSS.escape(id))) dangling.push(id);
      }
      return { twice, dangling, copies: document.querySelectorAll('figure.diagram svg').length };
    });
    expect(references).toMatchObject({ twice: [], dangling: [] }); expect(references.copies).toBeGreaterThanOrEqual(2);

    // 用对话改流程 leaves the unsaved draft only after asking, then prefills the project's assistant without sending.
    await page.getByRole('button', { name: 'Manager 提示词：在管理助手中用对话改流程', exact: true }).click();
    await page.getByRole('button', { name: '打开管理助手', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects\/101\/management$/);
    await expect(page.getByLabel('管理消息', { exact: true })).toHaveValue(/^我想调整 Manager 提示词里的协作流程。/);
    expect((await admin('/api/repositories/101/manager')).value.manager.prompt.content).toBe(prompt);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

const chunk = (res, delta, finish = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
// An assistant answer streams its diagram in pieces: the half-written block waits as source, the finished one is drawn
// once, and the answer fits a 390px screen.
test('a streamed management answer draws its finished diagram and keeps the page within the screen', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  const answer = '当前流程：\n\n' + fence('flowchart TD\n  A[收到 CI 失败] --> B{已有 Issue?}\n  B -->|有| C[补充评论]\n  B -->|没有| D[新建 Issue]') + '\n\n确认后再保存。';
  const cut = answer.indexOf('B{');
  f.modelState.respond = async (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { content: answer.slice(0, cut) }); await gate;
    chunk(res, { content: answer.slice(cut) }); chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n');
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await switchConsoleProject(page, '101');
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await page.getByLabel('管理消息', { exact: true }).fill('CI 失败现在怎么处理？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const figure = feed.locator('figure.diagram');
    await expect(figure).toHaveAttribute('data-diagram', /pending|failed/);
    await expect(figure.locator('svg')).toHaveCount(0);
    release();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    await expect(figure).toHaveAttribute('data-diagram', 'ready', { timeout: 20000 });
    await expect(figure.locator('svg text').filter({ hasText: '新建 Issue' })).toHaveCount(1);
    await expect(feed.getByText('确认后再保存。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await figure.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.tmp/prompt-diagrams/management-390.png' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await figure.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.tmp/prompt-diagrams/management-1440.png' });
    expect(errors).toEqual([]);
  } finally { release(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
