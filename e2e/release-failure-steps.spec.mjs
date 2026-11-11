import { test, expect } from '@playwright/test';
import { releaseFixture } from '../test/release-fixtures.mjs';

// A failed release record has to say which step failed and quote that step's own error; a published one has no such
// block. The attempt line may not claim a retry happened after the failure: `run_attempt` is the number of the stored
// workflow snapshot and outlives an earlier retry, so a post-CI failure can carry attempt 2 with no retry of its own.
// Only `expected_attempt` above `run_attempt` proves a rerun was requested and not yet observed. Every record is
// inserted directly: this spec reads the page, it does not drive GitHub.
const SHA = 'a'.repeat(40), NOW = '2026-11-11T00:00:00Z';

test('a failed release names the failing step and its error text, a published one has no such block', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    const actor = f.h.store.get('SELECT id FROM users LIMIT 1').id;
    const insert = (id, version, stage, data) => f.h.store.run(
      'INSERT INTO project_releases(id,repository_id,version,target_sha,actor_id,stage,active,revision,data,next_poll,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id, '101', version, SHA, actor, stage, 0, 1, JSON.stringify(data), 0, NOW, NOW);
    insert('rel-failed', 'v1.0.1', 'failed', { failure_step: 'save_draft', error: 'draft_save_forbidden', detail: '保存草稿正文时被拒绝：权限不足（HTTP 403）。', run_attempt: 2, expected_attempt: null });
    insert('rel-rerun', 'v1.0.2', 'failed', { failure_step: 'publishing', error: 'publish_rejected', detail: '发布时 GitHub 拒绝了请求（HTTP 422）。', run_attempt: 2, expected_attempt: 3 });
    insert('rel-published', 'v1.0.0', 'published', { failure_step: null, error: null, detail: '', run_attempt: 1, expected_attempt: 1 });
    await page.goto(f.h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', exact: true })).toBeVisible();
    const failed = page.locator('[data-release-failure="save_draft"]');
    await expect(failed).toHaveCount(1);
    await failed.locator('summary').click();
    await expect(failed).toContainText('失败步骤');
    await expect(failed).toContainText('保存草稿正文');
    await expect(failed).toContainText('保存草稿正文时被拒绝：权限不足（HTTP 403）。');
    await expect(failed).toContainText('当前运行快照为第 2 次 attempt（该工作流曾重跑过）');
    await expect(failed).not.toContainText('之后有重试记录');
    const rerun = page.locator('[data-release-failure="publishing"]');
    await expect(rerun).toHaveCount(1);
    await rerun.locator('summary').click();
    await expect(rerun).toContainText('已请求重跑到第 3 次运行');
    const published = page.locator('.release-record').filter({ hasText: 'v1.0.0' });
    await expect(published).toHaveCount(1);
    await expect(published.locator('[data-release-failure]')).toHaveCount(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
