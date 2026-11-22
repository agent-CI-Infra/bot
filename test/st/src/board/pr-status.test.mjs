import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  return { h, admin, a };
}

function seedPr(store, repo, number, title, { state = 'open', draft = 0, lastSeen = '2026-11-20T10:00:00.000Z' } = {}) {
  store.run(
    `INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,title_at,state_at,draft_at,last_seen)
     VALUES(?,'pr',?,?,?,?,?,?,?,?)
     ON CONFLICT(repository_id,object_type,object_number) DO UPDATE SET title=excluded.title,github_state=excluded.github_state,draft=excluded.draft,last_seen=excluded.last_seen`,
    repo, number, title, state, draft, lastSeen, lastSeen, lastSeen, lastSeen,
  );
}

test('board prs projects all 6 statuses, Bot PR source Issue link, CI checks, filters, detail chain and scope isolation (#1222)', async t => {
  const { h, admin } = await fixture(t);
  const store = h.store;

  // #10: reviewed Bot PR with source Issue #1 and passing CI
  seedPr(store, '101', 10, 'Fix cache eviction crash', { lastSeen: '2026-11-20T11:30:00.000Z' });
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES('t-iss-1','101','development.issue','pr_opened','开发 Issue #1','{}',?,1,'2026-11-20T09:00:00.000Z','2026-11-20T09:30:00.000Z')`,
    JSON.stringify({ pr_number: 10, pr_url: 'https://github.com/org/repo/pull/10' }),
  );
  store.run(
    `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',10,'pr-10','999','101','bot/issue-1','1111111111111111111111111111111111111111','t-iss-1',1)`,
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('101','1111111111111111111111111111111111111111','ci:unit','unit','completed','success','https://github.com/org/repo/runs/1','2026-11-20T11:25:00.000Z')`,
  );
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,head_sha,created_at,updated_at) VALUES('t-pr-rev-10','101','task.request','succeeded','检视 PR #10',?,?,10,'1111111111111111111111111111111111111111','2026-11-20T11:00:00.000Z','2026-11-20T11:20:00.000Z')`,
    JSON.stringify({ target: { type: 'pr', number: 10 }, executor_role: 'reviewer', delivery: 'review' }),
    JSON.stringify({ review_delivery: { conclusion: 'ready_for_development', recommendation: 'LGTM, all checks green.' } }),
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-pr-rev-10', JSON.stringify(['review']), '2026-11-20T11:00:00.000Z');

  // #11: revising (Bot PR actively being revised)
  seedPr(store, '101', 11, 'Add retry backoff option', { lastSeen: '2026-11-20T11:20:00.000Z' });
  store.run(
    `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',11,'pr-11','999','101','bot/issue-2','2222222222222222222222222222222222222222','t-iss-2',0)`,
  );
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES('t-pr-dev-11','101','task.request','implementing','跟进修改 PR #11',?,11,'2026-11-20T11:10:00.000Z','2026-11-20T11:20:00.000Z')`,
    JSON.stringify({ target: { type: 'pr', number: 11 }, executor_role: 'dev', intent: 'development' }),
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-pr-dev-11', JSON.stringify(['pull_request']), '2026-11-20T11:10:00.000Z');

  // #12: reviewing (external PR currently being reviewed)
  seedPr(store, '101', 12, 'Refactor logging format', { lastSeen: '2026-11-20T11:15:00.000Z' });
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at) VALUES('t-pr-rev-12','101','review.pr','running','检视 PR #12',12,'2026-11-20T11:10:00.000Z','2026-11-20T11:15:00.000Z')`,
  );

  // #13: needs_attention via failed CI on external PR
  seedPr(store, '101', 13, 'Update dependencies', { lastSeen: '2026-11-20T11:10:00.000Z' });
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,head_sha,created_at,updated_at) VALUES('t-pr-rev-13','101','review.pr','succeeded','检视 PR #13',?,13,'3333333333333333333333333333333333333333','2026-11-20T11:00:00.000Z','2026-11-20T11:05:00.000Z')`,
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Code looks fine.' }),
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('101','3333333333333333333333333333333333333333','ci:e2e','e2e','completed','failure','https://github.com/org/repo/runs/3','2026-11-20T11:10:00.000Z')`,
  );

  // #14: needs_attention via human_decision_required review (and later routine reviewer reply must NOT flip it)
  seedPr(store, '101', 14, 'Change public API response', { lastSeen: '2026-11-20T11:05:00.000Z' });
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES('t-pr-rev-14','101','task.request','succeeded','检视 PR #14',?,?,14,'2026-11-20T10:40:00.000Z','2026-11-20T10:50:00.000Z')`,
    JSON.stringify({ target: { type: 'pr', number: 14 }, executor_role: 'reviewer', delivery: 'review' }),
    JSON.stringify({
      conclusion: 'human_decision_required',
      recommendation: 'Breaking schema change.',
      findings: [{ id: 'F1', format: 'discussion', body: 'Breaks v1', requires_human_decision: true, human_action: '请确认是否保留兼容字段' }],
    }),
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-pr-rev-14', JSON.stringify(['review']), '2026-11-20T10:40:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES('t-pr-reply-14','101','task.request','succeeded','回复 PR 评论',?,?,14,'2026-11-20T11:00:00.000Z','2026-11-20T11:05:00.000Z')`,
    JSON.stringify({ target: { type: 'pr', number: 14 }, executor_role: 'reviewer' }),
    JSON.stringify({ summary: 'Thanks.' }),
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-pr-reply-14', JSON.stringify(['github']), '2026-11-20T11:00:00.000Z');

  // #15: draft PR
  seedPr(store, '101', 15, 'WIP experimental parser', { draft: 1, lastSeen: '2026-11-20T10:30:00.000Z' });

  // #16: pending PR (never reviewed)
  seedPr(store, '101', 16, 'Add unit test for utils', { lastSeen: '2026-11-20T10:20:00.000Z' });

  // #17: closed PR (excluded by default)
  seedPr(store, '101', 17, 'Merged old PR', { state: 'closed', lastSeen: '2026-11-20T09:00:00.000Z' });

  // #20 on repo 202
  seedPr(store, '202', 20, 'Foreign repo PR', { lastSeen: '2026-11-20T10:00:00.000Z' });

  const list = await admin('/api/board/prs?repository_id=101');
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.counts, {
    all: 7,
    needs_attention: 2,
    revising: 1,
    reviewing: 1,
    reviewed: 1,
    draft: 1,
    pending: 1,
    bot_pr: 2,
  });

  const byNum = new Map(list.value.prs.map(p => [p.number, p]));
  assert.equal(byNum.get(10).status, 'reviewed');
  assert.equal(byNum.get(10).is_bot_pr, true);
  assert.equal(byNum.get(10).bot_pr.source_issue_number, 1);
  assert.equal(byNum.get(10).checks.passed, 1);
  assert.equal(byNum.get(11).status, 'revising');
  assert.equal(byNum.get(11).is_bot_pr, true);
  assert.equal(byNum.get(12).status, 'reviewing');
  assert.equal(byNum.get(13).status, 'needs_attention');
  assert.match(byNum.get(13).reason, /1 项失败/);
  assert.equal(byNum.get(14).status, 'needs_attention');
  assert.match(byNum.get(14).reason, /保留兼容字段/);
  assert.equal(byNum.get(15).status, 'draft');
  assert.equal(byNum.get(16).status, 'pending');

  // bot_only filter
  const botOnly = await admin('/api/board/prs?repository_id=101&bot_only=1');
  assert.equal(botOnly.status, 200);
  assert.deepEqual(botOnly.value.prs.map(p => p.number).sort((a, b) => a - b), [10, 11]);
  assert.equal(botOnly.value.counts.all, 2);

  // include_closed, status filter & search
  assert.equal((await admin('/api/board/prs?repository_id=101&include_closed=1')).value.counts.all, 8);
  assert.deepEqual((await admin('/api/board/prs?repository_id=101&status=draft')).value.prs.map(p => p.number), [15]);
  assert.deepEqual((await admin('/api/board/prs?repository_id=101&q=%2314')).value.prs.map(p => p.number), [14]);
  assert.deepEqual((await admin('/api/board/prs?repository_id=101&q=eviction')).value.prs.map(p => p.number), [10]);

  // Detail chain
  const detail = await admin('/api/board/prs/101/14');
  assert.equal(detail.status, 200);
  assert.equal(detail.value.pr.status, 'needs_attention');
  assert.equal(detail.value.tasks_total, 2);
  assert.equal(detail.value.tasks_truncated, false);
  assert.equal(detail.value.dispatch_events_total, 0);
  assert.equal(detail.value.dispatch_events_truncated, false);

  // Invalid inputs
  assert.equal((await admin('/api/board/prs?status=bogus')).status, 400);
  assert.equal((await admin('/api/board/prs?bot_only=maybe')).status, 400);
  assert.equal((await admin('/api/board/prs/101/999')).status, 404);

  // Scope isolation & revocation
  const password = testPassword();
  const user = (await admin('/api/users', 'POST', { username: 'pr-member', password, repository_ids: ['101'] })).value.user;
  const member = h.client();
  await member('/api/auth/login', 'POST', { username: 'pr-member', password });
  assert.equal((await member('/api/board/prs?repository_id=101')).status, 200);
  assert.equal((await member('/api/board/prs?repository_id=202')).status, 403);
  assert.equal((await member('/api/board/prs/202/20')).status, 403);
  await admin('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: [] });
  assert.equal((await member('/api/board/prs?repository_id=101')).status, 403);

  // Project deletion cleans up board_pr_tasks
  assert.ok(store.get("SELECT count(*) n FROM board_pr_tasks WHERE repository_id='101'").n > 0);
  deleteProjectRecords(store, '101', { files: false });
  assert.equal(store.get("SELECT count(*) n FROM board_pr_tasks WHERE repository_id='101'").n, 0);
});

test('board prs reflects newer completed revision as pending re-review and selects CI checks from the newest head SHA (#1222)', async t => {
  const { h, admin } = await fixture(t);
  const store = h.store;

  // #30: review finished with human_decision_required at 09:10, then revision task succeeded at 09:40 -> pending re-review
  seedPr(store, '101', 30, 'Fix race after review feedback', { lastSeen: '2026-11-20T09:40:00.000Z' });
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-30-rev','101','review.pr','succeeded','检视 PR #30',?,30,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-11-20T09:00:00.000Z','2026-11-20T09:10:00.000Z')`,
    JSON.stringify({ conclusion: 'human_decision_required', recommendation: 'Needs changes.' }),
  );
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-30-dev','101','development.pr','succeeded','修订 PR #30',30,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','2026-11-20T09:20:00.000Z','2026-11-20T09:40:00.000Z')`,
  );

  // #31: older development.pr failed CI on head cccc..., newer review.pr succeeded on head dddd... with green CI -> reviewed, passed=1
  seedPr(store, '101', 31, 'Adopt latest head checks on re-review', { lastSeen: '2026-11-20T10:30:00.000Z' });
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-31-dev','101','development.pr','succeeded','修订 PR #31',31,'cccccccccccccccccccccccccccccccccccccccc','2026-11-20T10:00:00.000Z','2026-11-20T10:10:00.000Z')`,
  );
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-31-rev','101','review.pr','succeeded','检视 PR #31',?,31,'dddddddddddddddddddddddddddddddddddddddd','2026-11-20T10:20:00.000Z','2026-11-20T10:30:00.000Z')`,
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Looks good on latest head.' }),
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES
      ('101','cccccccccccccccccccccccccccccccccccccccc','ci:unit','unit','completed','failure','https://github.com/org/repo/runs/10','2026-11-20T10:11:00.000Z'),
      ('101','dddddddddddddddddddddddddddddddddddddddd','ci:unit','unit','completed','success','https://github.com/org/repo/runs/11','2026-11-20T10:31:00.000Z')`,
  );

  const list = await admin('/api/board/prs?repository_id=101');
  assert.equal(list.status, 200);
  const byNum = new Map(list.value.prs.map(p => [p.number, p]));

  assert.equal(byNum.get(30).status, 'pending');
  assert.match(byNum.get(30).reason, /等待重新检视/);

  assert.equal(byNum.get(31).status, 'reviewed');
  assert.equal(byNum.get(31).checks.failed, 0);
  assert.equal(byNum.get(31).checks.passed, 1);
  assert.match(byNum.get(31).reason, /Looks good on latest head/);
});
