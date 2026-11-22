import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });
  await admin('/api/repositories/202/policy', 'PATCH', { capability_ceiling: 'comment' });
  return { h, admin, a };
}

function seedIssue(store, repo, number, title, state = 'open', lastSeen = '2026-11-20T10:00:00.000Z') {
  store.run(
    `INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,title_at,state_at,draft_at,last_seen)
     VALUES(?,'issue',?,?,?,0,?,?,?,?)
     ON CONFLICT(repository_id,object_type,object_number) DO UPDATE SET title=excluded.title,github_state=excluded.github_state,last_seen=excluded.last_seen`,
    repo, number, title, state, lastSeen, lastSeen, lastSeen, lastSeen,
  );
}

test('board issues projects all 7 statuses across legacy tasks and #1122 task.request, with counts, filters and detail chain', async t => {
  const { h, admin } = await fixture(t);
  const store = h.store;

  // #1: pr_opened via #1122 task.request + pull_request grant + bot_pull_requests + commit_checks
  seedIssue(store, '101', 1, 'Fix cache eviction crash', 'open', '2026-11-20T11:00:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-rev-1', '101', 'task.request', 'succeeded', '检视 Issue #1',
    JSON.stringify({ target: { type: 'issue', number: 1 }, executor_role: 'reviewer' }),
    JSON.stringify({ review_delivery: { conclusion: 'ready_for_development', recommendation: 'Clear bug with bounded fix.' } }),
    1, '2026-11-20T10:00:00.000Z', '2026-11-20T10:05:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-rev-1', JSON.stringify(['review']), '2026-11-20T10:00:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-dev-1', '101', 'task.request', 'pr_opened', '开发 Issue #1',
    JSON.stringify({ target: { type: 'issue', number: 1 }, executor_role: 'dev' }),
    JSON.stringify({ pr_number: 88, pr_url: 'https://github.com/org/repo/pull/88' }),
    1, '2026-11-20T10:10:00.000Z', '2026-11-20T10:30:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-dev-1', JSON.stringify(['pull_request']), '2026-11-20T10:10:00.000Z');
  store.run(
    `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',88,'pr-88','999','101','bot/issue-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','t-dev-1',0)`,
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('101','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ci:unit','unit','completed','success','https://github.com/org/repo/runs/1','2026-11-20T10:35:00.000Z')`,
  );

  // #2: developing via #1122 task.request + issue_development_progress plan milestone
  seedIssue(store, '101', 2, 'Add retry backoff option', 'open', '2026-11-20T10:50:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-dev-2', '101', 'task.request', 'implementing', '开发 Issue #2',
    JSON.stringify({ target: { type: 'issue', number: 2 }, executor_role: 'dev' }),
    2, '2026-11-20T10:40:00.000Z', '2026-11-20T10:50:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-dev-2', JSON.stringify(['pull_request']), '2026-11-20T10:40:00.000Z');
  store.run(
    `INSERT INTO issue_development_progress(task_id,repository_id,number,language,label,milestones,created_at,updated_at) VALUES('t-dev-2','101',2,'zh','bot-developing',?, '2026-11-20T10:40:00.000Z','2026-11-20T10:50:00.000Z')`,
    JSON.stringify({ plan: { conclusion: '在重试调度器中补充指数退避上限配置' } }),
  );

  // #3: needs_information via review.issue
  seedIssue(store, '101', 3, 'Save fails sometimes', 'open', '2026-11-20T10:45:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)`,
    't-rev-3', '101', 'review.issue', 'succeeded', '检视 Issue #3',
    JSON.stringify({
      conclusion: 'needs_information',
      recommendation: 'Missing exact payload that triggers save failure.',
      findings: [{ id: 'F1', format: 'discussion', body: 'Need failing JSON sample', requires_human_decision: true, human_action: '请提供触发保存失败的请求样本与版本' }],
    }),
    3, '2026-11-20T10:40:00.000Z', '2026-11-20T10:45:00.000Z',
  );

  // #4: human_decision_required via #1122 task.request review
  seedIssue(store, '101', 4, 'Change default API error format', 'open', '2026-11-20T10:40:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-rev-4', '101', 'task.request', 'succeeded', '检视 Issue #4',
    JSON.stringify({ target: { type: 'issue', number: 4 }, executor_role: 'reviewer' }),
    JSON.stringify({
      conclusion: 'human_decision_required',
      recommendation: 'Breaking API change requires maintainer sign-off.',
      findings: [{ id: 'F1', format: 'discussion', body: 'Breaks v1 clients', requires_human_decision: true, human_action: '确认是否破坏兼容或新增 v2 端点' }],
    }),
    4, '2026-11-20T10:35:00.000Z', '2026-11-20T10:40:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-rev-4', JSON.stringify(['review']), '2026-11-20T10:35:00.000Z');

  // #5: blocked (development failed without PR)
  seedIssue(store, '101', 5, 'Update workflow checks', 'open', '2026-11-20T10:35:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,error_code,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-dev-5', '101', 'development.issue', 'waiting_permission', '开发 Issue #5', 'workflow_changes_not_confirmed',
    5, '2026-11-20T10:20:00.000Z', '2026-11-20T10:35:00.000Z',
  );
  store.run(
    `INSERT INTO issue_development_progress(task_id,repository_id,number,language,label,milestones,created_at,updated_at) VALUES('t-dev-5','101',5,'zh','bot-developing',?,'2026-11-20T10:20:00.000Z','2026-11-20T10:35:00.000Z')`,
    JSON.stringify({ stopped: { reason: '改动触及 .github/workflows/，需要管理员显式确认', human_action: '在控制台确认 CI 改动权限后重试' } }),
  );

  // #6: skipped (ready_for_development, but Manager ignored because already claimed)
  seedIssue(store, '101', 6, 'Refactor config loader', 'open', '2026-11-20T10:30:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-rev-6', '101', 'review.issue', 'succeeded', '检视 Issue #6',
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Clear refactoring; assigned to @alice.' }),
    6, '2026-11-20T10:25:00.000Z', '2026-11-20T10:28:00.000Z',
  );
  store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,decision,reason,created_at,decided_at)
     VALUES('ev-6','101','k-6','review.published','review','issue',6,'Issue 检视已发布：#6','{}','[]','101:issue:6','decided','ignore','已指派给 @alice，由人工跟进，bot 不重复开发','2026-11-20T10:28:00.000Z','2026-11-20T10:30:00.000Z')`,
  );

  // #7: pending (never reviewed)
  seedIssue(store, '101', 7, 'New incoming issue', 'open', '2026-11-20T10:20:00.000Z');

  // #8: closed issue (excluded by default, included with include_closed=1)
  seedIssue(store, '101', 8, 'Old closed issue', 'closed', '2026-11-20T09:00:00.000Z');

  // #9 on repo 202 (capability_ceiling = comment -> skipped due to ceiling)
  seedIssue(store, '202', 9, 'Repo 202 ready issue', 'open', '2026-11-20T10:15:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-rev-9', '202', 'review.issue', 'succeeded', '检视 Issue #9',
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Bounded fix.' }),
    9, '2026-11-20T10:10:00.000Z', '2026-11-20T10:15:00.000Z',
  );

  const list = await admin('/api/board/issues?repository_id=101');
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.counts, {
    all: 7,
    pr_opened: 1,
    developing: 1,
    needs_human: 3,
    needs_information: 1,
    human_decision_required: 1,
    blocked: 1,
    skipped: 1,
    pending: 1,
  });
  const byNum = new Map(list.value.issues.map(i => [i.number, i]));
  assert.equal(byNum.get(1).status, 'pr_opened');
  assert.equal(byNum.get(1).pr.number, 88);
  assert.equal(byNum.get(1).pr.checks.passed, 1);
  assert.equal(byNum.get(2).status, 'developing');
  assert.match(byNum.get(2).reason, /指数退避上限配置/);
  assert.equal(byNum.get(3).status, 'needs_information');
  assert.match(byNum.get(3).reason, /触发保存失败的请求样本/);
  assert.equal(byNum.get(4).status, 'human_decision_required');
  assert.match(byNum.get(4).reason, /破坏兼容或新增 v2/);
  assert.equal(byNum.get(5).status, 'blocked');
  assert.match(byNum.get(5).reason, /\.github\/workflows\//);
  assert.match(byNum.get(5).next_step, /CI 改动权限/);
  assert.equal(byNum.get(6).status, 'skipped');
  assert.match(byNum.get(6).reason, /@alice/);
  assert.equal(byNum.get(7).status, 'pending');

  // Filter: needs_human aggregates needs_information + human_decision_required + blocked
  const needsHuman = await admin('/api/board/issues?repository_id=101&status=needs_human');
  assert.equal(needsHuman.status, 200);
  assert.deepEqual(needsHuman.value.issues.map(i => i.number).sort((a, b) => a - b), [3, 4, 5]);
  assert.equal(needsHuman.value.counts.all, 7);

  // Sub-filter & search & include_closed & pagination
  assert.deepEqual((await admin('/api/board/issues?repository_id=101&status=blocked')).value.issues.map(i => i.number), [5]);
  assert.deepEqual((await admin('/api/board/issues?repository_id=101&q=%234')).value.issues.map(i => i.number), [4]);
  assert.deepEqual((await admin('/api/board/issues?repository_id=101&q=eviction')).value.issues.map(i => i.number), [1]);
  assert.equal((await admin('/api/board/issues?repository_id=101&include_closed=1')).value.counts.all, 8);
  const paged = await admin('/api/board/issues?repository_id=101&limit=2&offset=0');
  assert.equal(paged.value.issues.length, 2);
  assert.equal(paged.value.has_more, true);

  // Repo 202 with ceiling=comment reports skipped due to capability ceiling
  const repo202 = await admin('/api/board/issues?repository_id=202');
  assert.equal(repo202.value.issues[0].status, 'skipped');
  assert.match(repo202.value.issues[0].reason, /能力上限/);

  // Single issue detail returns tasks + dispatch events without leaking raw input/facts
  const detail = await admin('/api/board/issues/101/6');
  assert.equal(detail.status, 200);
  assert.equal(detail.value.issue.status, 'skipped');
  assert.equal(detail.value.tasks.length, 1);
  assert.equal(detail.value.tasks[0].id, 't-rev-6');
  assert.equal(detail.value.dispatch_events.length, 1);
  assert.equal(detail.value.dispatch_events[0].decision, 'ignore');
  assert.equal(JSON.stringify(detail.value).includes('"facts"'), false);

  // Invalid inputs return 400
  assert.equal((await admin('/api/board/issues?status=bogus')).status, 400);
  assert.equal((await admin('/api/board/issues?limit=101')).status, 400);
  assert.equal((await admin('/api/board/issues/101/999')).status, 404);

  // Project scope isolation & revocation
  const password = testPassword();
  const user = (await admin('/api/users', 'POST', { username: 'issue-member', password, repository_ids: ['101'] })).value.user;
  const member = h.client();
  await member('/api/auth/login', 'POST', { username: 'issue-member', password });
  assert.equal((await member('/api/board/issues?repository_id=101')).status, 200);
  assert.equal((await member('/api/board/issues?repository_id=202')).status, 403);
  assert.equal((await member('/api/board/issues/202/9')).status, 403);
  assert.ok((await member('/api/board/issues')).value.issues.every(i => i.repository_id === '101'));
  await admin('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: [] });
  assert.equal((await member('/api/board/issues?repository_id=101')).status, 403);
  assert.deepEqual((await member('/api/board/issues')).value.issues, []);

  // Project deletion cleans up board_issue_tasks
  assert.ok(store.get("SELECT count(*) n FROM board_issue_tasks WHERE repository_id='101'").n > 0);
  deleteProjectRecords(store, '101', { files: false });
  assert.equal(store.get("SELECT count(*) n FROM board_issue_tasks WHERE repository_id='101'").n, 0);
});

test('board issues ignores unrelated reviewer reply tasks, ignored comments, and treats user_cancel as skipped (#1215)', async t => {
  const { h, admin } = await fixture(t);
  const store = h.store;

  // #11: real needs_information review + later routine reviewer reply (writes=['github'], no review grant or conclusion) -> stays needs_information
  seedIssue(store, '101', 11, 'Needs repro steps', 'open', '2026-11-20T12:00:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-rev-11', '101', 'task.request', 'succeeded', '检视 Issue #11',
    JSON.stringify({ target: { type: 'issue', number: 11 }, executor_role: 'reviewer', delivery: 'review' }),
    JSON.stringify({ review_delivery: { conclusion: 'needs_information', recommendation: 'Need stack trace.' } }),
    11, '2026-11-20T11:00:00.000Z', '2026-11-20T11:05:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-rev-11', JSON.stringify(['review']), '2026-11-20T11:00:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-reply-11', '101', 'task.request', 'succeeded', '回复感谢评论',
    JSON.stringify({ target: { type: 'issue', number: 11 }, executor_role: 'reviewer' }),
    JSON.stringify({ summary: 'Thanks for the update.' }),
    11, '2026-11-20T11:30:00.000Z', '2026-11-20T11:35:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-reply-11', JSON.stringify(['github']), '2026-11-20T11:30:00.000Z');

  // #12: ready_for_development review + pending review.published + later ignored thank-you comment -> stays pending (comment ignore never flips it)
  seedIssue(store, '101', 12, 'Ready feature request', 'open', '2026-11-20T12:10:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-rev-12', '101', 'review.issue', 'succeeded', '检视 Issue #12',
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Bounded feature.' }),
    12, '2026-11-20T11:00:00.000Z', '2026-11-20T11:05:00.000Z',
  );
  store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,decision,reason,created_at,decided_at)
     VALUES('ev-rev-12','101','k-rev-12','review.published','review','issue',12,'Issue 检视已发布：#12','{}','[]','101:issue:12','pending',NULL,NULL,'2026-11-20T11:06:00.000Z',NULL)`,
  );
  store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,decision,reason,created_at,decided_at)
     VALUES('ev-cmt-12','101','k-cmt-12','issue.commented','webhook','issue',12,'Issue #12 新评论','{}','[]','101:issue:12','decided','ignore','普通感谢评论，无需处理','2026-11-20T12:00:00.000Z','2026-11-20T12:01:00.000Z')`,
  );

  // #13: user_cancel development -> skipped (not blocked / not needs_human)
  seedIssue(store, '101', 13, 'Cancelled by human', 'open', '2026-11-20T12:20:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,error_code,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-dev-13', '101', 'development.issue', 'cancelled', '开发 Issue #13', 'user_cancel',
    13, '2026-11-20T12:15:00.000Z', '2026-11-20T12:20:00.000Z',
  );

  const list = await admin('/api/board/issues?repository_id=101');
  assert.equal(list.status, 200);
  const byNum = new Map(list.value.issues.map(i => [i.number, i]));
  assert.equal(byNum.get(11).status, 'needs_information');
  assert.equal(byNum.get(11).review.task_id, 't-rev-11');
  assert.equal(byNum.get(12).status, 'pending');
  assert.match(byNum.get(12).reason, /等待 Manager 分派/);
  assert.equal(byNum.get(13).status, 'skipped');
  assert.match(byNum.get(13).reason, /人工取消/);
  assert.equal(list.value.counts.blocked, 0);
  assert.equal(list.value.counts.needs_human, 1);

  // Detail exposes explicit total & truncation flags
  const detail = await admin('/api/board/issues/101/12');
  assert.equal(detail.status, 200);
  assert.equal(detail.value.tasks_total, 1);
  assert.equal(detail.value.tasks_truncated, false);
  assert.equal(detail.value.dispatch_events_total, 2);
  assert.equal(detail.value.dispatch_events_truncated, false);
});
