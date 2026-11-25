import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { executeSubmitFeedback } from '../../../dist/feedback/tool.js';
import { defaultPermissions } from '../../../dist/roles/permissions.js';

const checkContrast = async (page, rootSelector) => page.evaluate(sel => {
  const parseRgb = str => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(str || '');
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  };
  const lum = ({ r, g, b }) => {
    const c = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const effectiveBg = el => {
    let cur = el;
    while (cur) {
      const bg = parseRgb(getComputedStyle(cur).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const root = document.querySelector(sel);
  if (!root) return [{ text: `missing ${sel}`, ratio: 0 }];
  const fails = [];
  for (const el of root.querySelectorAll('h2,h3,h4,p,li,strong,code,th,td,dt,dd,label,button,a,summary,.fb-badge,.fb-nav-badge')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const fg = parseRgb(getComputedStyle(el).color);
    if (!fg || fg.a < 0.5) continue;
    const bg = effectiveBg(el);
    const l1 = Math.max(lum(fg), lum(bg)), l2 = Math.min(lum(fg), lum(bg));
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    if (ratio < 4.5) fails.push({ tag: el.tagName, cls: el.className, text: txt.slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
  }
  return fails;
}, rootSelector);

test('super-admin feedback box full lifecycle, XSS sanitization, snapshot, triage, delete, project_admin denial, and light/dark responsive AA contrast', async ({ page, browser }) => {
  const h = await harness();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    const { admin, password } = await setup(h);
    const acc = await account(admin);
    await repository(admin, acc.id, '101');
    const now = new Date().toISOString();
    h.store.run(
      "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,head_sha,attempt,created_at,updated_at) VALUES('task-fb-1','101','task.request','succeeded','Fixture task',12,'done',?,1,?,?)",
      'a'.repeat(40), now, now,
    );

    // Entry 1: Untrusted PR context + XSS payload + markdown headings + rich snapshot + task link
    const fbUntrusted = executeSubmitFeedback({
      store: h.store,
      idempotencyScope: 'e2e:1',
      snapshot: () => ({
        source_kind: 'project_role',
        untrusted_context: true,
        repository_id: '101',
        repository_full_name: 'fixture/project-101',
        role: {
          role_id: 'reviewer',
          role_name: 'Reviewer',
          kind: 'observer',
          config_revision: 4,
          role_revision: 2,
          system_prompt: 'You are the Reviewer role. Inspect carefully.',
          permissions: defaultPermissions('reviewer', 'observer'),
          offered_tools: ['read_file', 'github_read', 'submit_feedback'],
        },
        model: { id: 'm1', name: 'gpt-5-mini', version: 1, source: 'project', api_url: 'https://api.example.invalid/v1', interface_type: 'chat_completions' },
        harness: { id: 'claude_code', version: '2.1.319', cli_version: '2.1.319', environment: 'project_computer', model_source: 'gateway' },
        skills: {
          bundle: { id: 'bundle-1', revision: 3, content_hash: 'c'.repeat(64), files: [{ path: '.agents/skills/pr-review/SKILL.md', sha256: 'd'.repeat(64), bytes: 512 }] },
          skills_read: ['.agents/skills/pr-review/SKILL.md'],
        },
        execution: {
          task_id: 'task-fb-1',
          task_kind: 'task.request',
          task_status: 'succeeded',
          run_id: 'run-fb-1',
          attempt: 1,
          elapsed_ms: 14500,
          recent_tools: [{ name: 'read_file', outcome: 'ok', at: now }],
        },
      }),
    }, {
      title: 'PR review skill missing monorepo guidance',
      category: 'skill',
      severity: 'high',
      context: '# Heading One\nRunning PR review.\n<script>window.__fb_xss=1;</script><img src=x onerror="window.__fb_xss=2">',
      problem: '##### Deep Heading\nSkill omits workspace build steps and contains [evil](javascript:alert(1)) link.',
      suggestion: 'Document `npm run check` and [safe docs](https://example.com/docs).',
      target_ref: '.agents/skills/pr-review/SKILL.md',
      evidence_refs: ['task:task-fb-1', 'run:run-fb-1'],
    });
    expect(fbUntrusted.accepted).toBe(true);

    // Entry 2: Deleted project retained entry (to verify deleted repo marker & filtering)
    const fbDeletedRepo = executeSubmitFeedback({
      store: h.store,
      idempotencyScope: 'e2e:2',
      snapshot: () => ({
        source_kind: 'management_assistant',
        untrusted_context: false,
        repository_id: '999',
        repository_full_name: 'legacy/archived-repo',
        role: { role_id: 'management-assistant', role_name: '管理助手', kind: 'service', system_prompt: 'Assistant prompt', offered_tools: ['management_query', 'submit_feedback'] },
        model: { name: 'claude-sonnet' },
        harness: { id: 'pi', version: '0.1.0' },
        execution: { conversation_id: 'mgmt-conv-1', own_task_id: 'own-99' },
      }),
    }, {
      title: 'Assistant tool result pagination hint unclear',
      category: 'tool',
      severity: 'low',
      context: 'Querying large task output from management assistant.',
      problem: 'Truncated preview did not specify page size.',
      suggestion: 'Include default limit in the truncation hint.',
    });
    expect(fbDeletedRepo.accepted).toBe(true);

    // Login as super admin
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/settings/feedback');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    // List view, nav unread badge, global settings fold
    await expect(page.getByTestId('feedback-list-card')).toBeVisible();
    await expect(page.getByTestId('feedback-open-badge')).toHaveText('2');
    await expect(page.getByTestId('feedback-entries-list')).toContainText('PR review skill missing monorepo guidance');
    await expect(page.getByTestId('feedback-entries-list')).toContainText('不可信检出');
    await expect(page.getByTestId('feedback-entries-list')).toContainText('legacy/archived-repo（已删除）');

    // Update global settings inside settings fold and confirm persistence
    const fold = page.getByTestId('feedback-settings-fold');
    await fold.locator('summary').click();
    await fold.locator('input[name="max_per_run"]').fill('6');
    await fold.getByRole('button', { name: '保存意见箱设置', exact: true }).click();
    await expect(fold).toContainText('意见箱设置已保存。');
    await expect(fold.locator('summary')).toContainText('单次运行上限 6 条');

    // Multi-dimensional filters: untrusted=1 narrows to 1 item
    const filters = page.getByTestId('feedback-filters');
    await filters.locator('select[name="untrusted"]').selectOption('1');
    await filters.getByRole('button', { name: '筛选', exact: true }).click();
    await expect(page.locator('.fb-item')).toHaveCount(1);
    await expect(page.locator('.fb-item')).toContainText('PR review skill missing monorepo guidance');

    // Contrast & zero overflow on list view across light/dark and 1440/390
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `list ${scheme} ${vp.width}px overflow`).toBe(false);
        expect(await checkContrast(page, '[data-testid="feedback-list-card"]'), `list ${scheme} ${vp.width}px contrast`).toEqual([]);
      }
    }

    // Deep-link directly to detail page and confirm nav unread badge populates on direct navigation too
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/settings/feedback/' + fbUntrusted.feedback_id);
    await expect(page.getByTestId('feedback-detail-card')).toBeVisible();
    await expect(page.getByTestId('feedback-open-badge')).toHaveText('2');
    await expect(page.getByTestId('feedback-untrusted-banner')).toBeVisible();
    await expect(page.getByTestId('feedback-task-link')).toHaveAttribute('href', '#/tasks/task-fb-1');

    // Verify XSS sanitization & heading demotion (no <script>, no <img>, no javascript: href, unbroken heading order)
    const xssCheck = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="feedback-body-card"]');
      const headings = [...document.querySelectorAll('#settings-panel h1, #settings-panel h2, #settings-panel h3, #settings-panel h4, #settings-panel h5, #settings-panel h6')]
        .filter(n => n.getBoundingClientRect().width > 0)
        .map(n => Number(n.tagName.slice(1)));
      let skipped = false;
      for (let i = 1; i < headings.length; i++) {
        if (headings[i] - headings[i - 1] > 1) skipped = true;
      }
      return {
        xssGlobal: window.__fb_xss ?? null,
        scripts: body.querySelectorAll('script').length,
        imgs: body.querySelectorAll('img').length,
        unsafeLinks: [...body.querySelectorAll('a[href]')].filter(a => {
          const href = (a.getAttribute('href') || '').trim();
          try {
            return !['https:', 'http:', 'mailto:'].includes(new URL(href, location.href).protocol);
          } catch {
            return true;
          }
        }).length,
        safeLinks: [...body.querySelectorAll('a[href]')].filter(a => a.getAttribute('href') === 'https://example.com/docs' && a.rel.includes('noopener')).length,
        h4Count: body.querySelectorAll('.fb-markdown h4').length,
        skipped,
      };
    });
    expect(xssCheck).toEqual({ xssGlobal: null, scripts: 0, imgs: 0, unsafeLinks: 0, safeLinks: 1, h4Count: 2, skipped: false });

    // Expand full snapshot & verify server-authoritative fields
    const snapFold = page.getByTestId('feedback-snapshot-fold');
    await snapFold.locator(':scope > summary').click();
    await expect(snapFold).toContainText('claude_code');
    await expect(snapFold).toContainText('.agents/skills/pr-review/SKILL.md');
    await snapFold.getByTestId('feedback-system-prompt-fold').locator(':scope > summary').click();
    await expect(snapFold).toContainText('You are the Reviewer role. Inspect carefully.');

    // Copy Markdown button announces result cleanly
    await page.getByTestId('feedback-copy-md').click();
    await expect(page.getByTestId('feedback-detail-card')).toContainText(/Markdown \/ Issue 草稿/);

    // Contrast & overflow on detail page (with snapshot expanded) across light/dark and 1440/390
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `detail ${scheme} ${vp.width}px overflow`).toBe(false);
        expect(await checkContrast(page, '#settings-panel .project-content'), `detail ${scheme} ${vp.width}px contrast`).toEqual([]);
      }
    }

    // Short screen 390x640: triage save button is reachable and unobstructed via elementFromPoint
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 640 });
    const saveTriage = page.getByTestId('feedback-triage-save');
    await saveTriage.scrollIntoViewIfNeeded();
    const hitSelf = await saveTriage.evaluate(btn => {
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === btn || btn.contains(top);
    });
    expect(hitSelf).toBe(true);

    // Triage status open -> triaged and verify badge decrements from 2 -> 1
    await page.setViewportSize({ width: 1440, height: 900 });
    const triageCard = page.getByTestId('feedback-triage-card');
    await triageCard.locator('select[name="status"]').selectOption('triaged');
    await triageCard.locator('textarea[name="triage_note"]').fill('Verified and scheduled for next sprint.');
    await page.getByTestId('feedback-triage-save').click();
    await expect(triageCard).toContainText('分诊结果已保存。');
    await expect(page.getByTestId('feedback-detail-status')).toHaveText('已分诊');
    await expect(page.getByTestId('feedback-open-badge')).toHaveText('1');

    // Two-step inline delete removes entry and returns to list
    await page.getByTestId('feedback-delete-start').click();
    await page.getByTestId('feedback-delete-confirm').click();
    await expect(page).toHaveURL(/#\/settings\/feedback$/);
    await expect(page.getByTestId('feedback-entries-list')).not.toContainText('PR review skill missing monorepo guidance');

    // Confirm existing costs page remains readable under OS dark preference (no global dark regression)
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(h.admin + '/#/costs');
    await expect(page.locator('#costs-panel')).toBeVisible();
    expect(await checkContrast(page, '#costs-panel'), 'costs page contrast under OS dark preference').toEqual([]);

    // Non-super-admin (project_admin) cannot see nav entry or access feedback routes or API
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'projmember', password: memberPassword, role: 'project_admin', repository_ids: ['101'] });
    const memberCtx = await browser.newContext();
    const memberPage = await memberCtx.newPage();
    try {
      await memberPage.goto(h.admin + '/#/settings/feedback');
      await memberPage.getByLabel('用户名', { exact: true }).fill('projmember');
      await memberPage.getByLabel('密码', { exact: true }).fill(memberPassword);
      await memberPage.getByRole('button', { name: '登录', exact: true }).click();
      await expect(memberPage.locator('#tabs [aria-current=page]')).toHaveText('项目');
      await expect(memberPage.locator('#settings-panel')).toBeHidden();
      await memberPage.goto(h.admin + '/#/settings/feedback/' + fbDeletedRepo.feedback_id);
      await expect(memberPage.locator('#tabs [aria-current=page]')).toHaveText('项目');
      await expect(memberPage.getByTestId('feedback-detail-card')).toHaveCount(0);
      await memberPage.goto(h.admin + '/#/settings/storage');
      await expect(memberPage.locator('.project-nav a[href="#/settings/feedback"]')).toHaveCount(0);
    } finally {
      await memberCtx.close();
    }

    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
