import { login } from '../helpers/channel-console-login.mjs';
import { test, expect } from '@playwright/test';
import { channelFixture, boundGroup, repositoryAssistant, scriptedModel, inGroup, post, finished } from '../../fixtures/channel-fixture.mjs';

// The console prints a measured duration in milliseconds or, above one second, in tenths of a second.
const shownMs = text => {
  const seconds = /耗时 ([0-9.]+) 秒/.exec(text); if (seconds) return Math.round(Number(seconds[1]) * 1000);
  const millis = /耗时 ([0-9.]+) 毫秒/.exec(text); if (millis) return Number(millis[1]);
  return text.includes('耗时不足 1 毫秒') ? 0 : null;
};

test('two calls of one tool show their own durations, and a step recorded without timing says so (#1313)', async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f); const group = await boundGroup(f);
    // The assistant calls the same tool twice in a row: only a per-call identity keeps the two steps apart.
    scriptedModel(f, [['list_projects', {}], ['list_projects', {}], '两次范围都核对完了。']);
    const receipt = await post(f.h, f.id, inGroup('连续核对两次项目范围。', 'ou_bob'));
    expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    const turn = f.h.store.get('SELECT * FROM channel_service_turns WHERE chat_id=?', group.id);
    // A step recorded before the timing columns existed: no call id, no clock readings.
    f.h.store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'tool_call','list_projects',?)", turn.id, Date.now());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, f, '#/conversations/' + group.id);
    await page.getByText('查看执行过程', { exact: true }).click();
    const calls = page.locator('.channel-step').filter({ hasText: '调用工具 · 查看项目范围' });
    await expect(calls).toHaveCount(3);
    const texts = await calls.allInnerTexts();
    // The old step never claims a duration; the two real calls each show their own.
    expect(texts.filter(text => text.includes('耗时未记录'))).toHaveLength(1);
    const shown = texts.filter(text => !text.includes('耗时未记录')).map(shownMs);
    expect(shown.every(ms => ms !== null), JSON.stringify(texts)).toBe(true);
    const events = (await f.admin(`/api/channels/chats/${group.id}/turns/${turn.id}`)).value.events
      .filter(event => event.type === 'tool_call' && event.duration_ms !== null);
    expect(events).toHaveLength(2); expect(new Set(events.map(event => event.call_id)).size).toBe(2);
    // Each line is its own call's measured time (tenths of a second round by up to 50 ms), and together they cover the window.
    for (const ms of shown) expect(events.some(event => Math.abs(event.duration_ms - ms) <= 50), `${ms} vs ${events.map(event => event.duration_ms)}`).toBe(true);
    const own = events.map(event => f.h.store.get("SELECT started_at,(SELECT ended_at FROM channel_service_events WHERE call_id=? AND ended_at IS NOT NULL) ended_at FROM channel_service_events WHERE turn_id=? AND call_id=? AND type='tool_call'", event.call_id, turn.id, event.call_id));
    const window = Math.max(...own.map(row => row.ended_at)) - Math.min(...own.map(row => row.started_at));
    expect(Math.abs(shown.reduce((sum, ms) => sum + ms, 0) - window)).toBeLessThanOrEqual(100);
    // A step line ends at its duration: no tool arguments, results or model reasoning follow it.
    for (const text of texts.filter(text => !text.includes('耗时未记录'))) expect(text).toMatch(/ · 调用工具 · 查看项目范围 · 耗时[^·]*$/);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await calls.first().scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      await expect(calls).toHaveCount(3);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
