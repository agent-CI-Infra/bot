import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

const text = node => node ? [node.textContent, ...node.children.flatMap(text)].join(' ') : '';

const eventRow = (over = {}) => ({
  id: over.id || '1',
  delivery_id: over.delivery_id || '4875c790-e0ca-11f1-9a75-04838eee878f',
  full_name: 'open-x-agents/Douya',
  route: 'workflow_run.completed',
  event: 'workflow_run',
  received_at: '2026-11-15T08:58:04.000Z',
  processing_result: 'not_trigger',
  reception: { accepted: true },
  signature: { state: 'verified' },
  source: { reference: 'deliveries:16867282' },
  ...over,
});

test('events list uses plain event names and keeps technical identifiers folded', async () => {
  const page = loadConsole(['static/app.js'], (method, path) => {
    if (path.startsWith('/api/events') && !path.startsWith('/api/events/')) {
      return [200, { events: [eventRow(), eventRow({ id: '2', delivery_id: 'dup-1', route: 'issue.closed', event: 'issues', processing_result: 'duplicate' })] }];
    }
    return [200, {}];
  });
  page.run(`me={id:'birfy',role:'project_admin'};tab='events';projectRoute=()=>null;`);
  await page.run('render()');
  const rows = page.$('rows');
  const firstScreen = node => [...node.querySelectorAll('.row-title, .row-event-time, .row-event-outcome, summary, .status')]
    .map(part => part.textContent).join(' ');
  const body = firstScreen(rows);
  assert.match(body, /工作流已完成/);
  assert.match(body, /Issue 已关闭/);
  assert.match(body, /不会创建任务：这类通知不会启动任务/);
  assert.match(body, /不会再次创建任务：同一条通知已经处理过/);
  assert.doesNotMatch(body, /workflow_run\.completed/);
  assert.doesNotMatch(body, /deliveries:/);
  assert.doesNotMatch(body, /未交给 Manager/);
  assert.equal(body.includes('Manager'), false);
  const first = rows.querySelector('[data-delivery-record=1]');
  assert.equal(first.querySelector('.row-title').textContent, 'open-x-agents/Douya · 工作流已完成');
  const tech = first.querySelector('details.row-tech');
  assert.ok(tech, 'technical details are present');
  assert.match(text(tech), /4875c790-e0ca-11f1-9a75-04838eee878f/);
  assert.match(text(tech), /deliveries:16867282/);
  assert.match(text(tech), /workflow_run\.completed/);
  // Closed details stay in the tree, but the first screen copy the reader sees is the summary + outcome.
  assert.equal(first.querySelector('summary').textContent, '技术信息');
  assert.match(page.$('page-title').textContent, /仓库事件/);
});

test('deliveryEventName falls back to 其他事件 for unknown routes', () => {
  const page = loadConsole(['static/app.js']);
  assert.equal(page.run("deliveryEventName('workflow_run.completed')"), '工作流已完成');
  assert.equal(page.run("deliveryEventName('issue_comment.created')"), 'Issue 有新评论');
  assert.equal(page.run("deliveryEventName('issue_comment')"), 'Issue 有新评论');
  assert.equal(page.run("deliveryEventName('pull_request_review.submitted')"), 'Pull Request 收到检视意见');
  assert.equal(page.run("deliveryEventName('pull_request_review_comment.created')"), 'Pull Request 有行内评论');
  assert.equal(page.run("deliveryEventName('mystery.happened')"), '其他事件');
  assert.equal(page.run("deliveryEventName('', 'issues')"), 'Issue');
});
