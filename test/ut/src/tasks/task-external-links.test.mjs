import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { attachExternalLinks, parseTaskTargetMeta, taskTargetSelectSQL } from '../../../../dist/tasks/external-links.js';

function createFixture(t) {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => { try { store.close(); } catch {} });
  store.run("INSERT INTO accounts VALUES('acc-1','fixture','bot_account',NULL,'{}','2026-11-24T00:00:00Z')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','owner-1','acc-1')");
  store.run("INSERT INTO repositories VALUES('202','fixture/project-202','owner-1','acc-1')");
  return store;
}

function taskRow(store, id) {
  const row = store.get(
    `SELECT *, (SELECT full_name FROM repositories WHERE id=tasks.repository_id) AS full_name,
      (SELECT json_extract(data,'$.remote_sha') FROM development_candidates WHERE task_id=tasks.id) AS pushed_sha,
      ${taskTargetSelectSQL()} AS target_meta
     FROM tasks WHERE id=?`,
    id,
  );
  return {
    ...row,
    target: parseTaskTargetMeta(row.target_meta),
    result: row.result ? JSON.parse(row.result) : null,
  };
}

test('taskTargetSelectSQL + parseTaskTargetMeta normalize valid targets and isolate malformed input JSON', t => {
  const store = createFixture(t);
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-pr','101','task.request','queued','Revise PR',?)",
    JSON.stringify({ target: { type: 'pull_request', number: 1325, ref: 'a'.repeat(40) }, context_files: { 'huge.txt': 'x'.repeat(2048) } }),
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-issue','101','task.request','queued','Implement Issue',?)",
    JSON.stringify({ target: { type: 'issue', number: 1237, ref: 'release/v2' } }),
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-branch','101','task.request','queued','Audit branch',?)",
    JSON.stringify({ target: { type: 'branch', ref: 'main' } }),
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-bad','101','task.request','queued','Corrupt input','{not-valid-json')",
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-empty','101','task.request','queued','No target','{}')",
  );

  const rows = store.all(`SELECT id, ${taskTargetSelectSQL()} AS target_meta FROM tasks ORDER BY id`);
  const byId = Object.fromEntries(rows.map(r => [r.id, parseTaskTargetMeta(r.target_meta)]));
  assert.deepEqual(byId['t-pr'], { type: 'pr', number: 1325, ref: 'a'.repeat(40) });
  assert.deepEqual(byId['t-issue'], { type: 'issue', number: 1237, ref: 'release/v2' });
  assert.deepEqual(byId['t-branch'], { type: 'branch', ref: 'main' });
  assert.equal(byId['t-bad'], null);
  assert.equal(byId['t-empty'], null);
});

test('attachExternalLinks resolves task.request PR targets before push and reverse-looks up bot PR root Issues', t => {
  const store = createFixture(t);
  const sha1 = '1'.repeat(40);
  const sha2 = '2'.repeat(40);
  const sha3 = '3'.repeat(40);
  const sha4 = '4'.repeat(40);
  const sha5 = '5'.repeat(40);

  // Board objects for issues & PRs
  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','issue',1237,'Support incremental sync','open',0,'2026-11-24T08:00:00Z')");
  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','issue',1100,'Legacy issue title','open',0,'2026-11-24T08:00:00Z')");
  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',1325,'fix(#1237): incremental sync','open',0,'2026-11-24T08:10:00Z')");
  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',1105,'fix(#1100): legacy fix','open',1,'2026-11-24T08:10:00Z')");
  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',1400,'chore: bump deps','open',0,'2026-11-24T08:10:00Z')");

  // Commit checks for sha1 (PR #1325)
  store.run(
    "INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('101',?,'check:unit','unit','completed','success','https://github.com/fixture/project-101/runs/1','2026-11-24T08:15:00Z')",
    sha1,
  );

  // Source tasks that created bot PRs:
  // 1) Modern `task.request` targeting Issue #1237 -> bot PR #1325
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input) VALUES('t-src-req','101','task.request','pr_opened','Implement #1237',1237,?)",
    JSON.stringify({ target: { type: 'issue', number: 1237 } }),
  );
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',1325,'pr-1325','99','101','bot/issue-1237',?,'t-src-req',0)",
    sha1,
  );

  // 2) Legacy `development.issue` targeting Issue #1100 -> bot PR #1105
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input) VALUES('t-src-legacy','101','development.issue','pr_opened','Legacy dev #1100',1100,'{}')",
  );
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',1105,'pr-1105','99','101','bot/issue-1100',?,'t-src-legacy',0)",
    sha2,
  );

  // 3) Standalone `task.request` (branch target, no Issue) -> bot PR #1399
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-src-branch','101','task.request','pr_opened','Refactor scripts',?)",
    JSON.stringify({ target: { type: 'branch', ref: 'main' } }),
  );
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',1399,'pr-1399','99','101','bot/refactor-scripts',?,'t-src-branch',0)",
    sha3,
  );

  // Subject tasks:
  // A. Queued task.request revising bot PR #1325 (no result, no development_candidates, no input.bot_pr yet)
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,input) VALUES('t-queued-bot-pr','101','task.request','queued','Address review feedback',1325,?,?)",
    sha1,
    JSON.stringify({ target: { type: 'pr', number: 1325, ref: sha1 } }),
  );

  // B. Running task.request revising bot PR #1105 with input.bot_pr already fetched (newer sha/branch) and non-issue source_task_id
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input) VALUES('t-rev-review','101','review.pr','succeeded','Prior PR review',1105,'{}')",
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,source_task_id,input) VALUES('t-running-legacy-bot-pr','101','task.request','running','Fix review comments',1105,'t-rev-review',?)",
    JSON.stringify({
      target: { type: 'pr', number: 1105 },
      bot_pr: { number: 1105, head: { ref: 'bot/issue-1100-rebased', sha: sha4 }, state: 'open', draft: true },
    }),
  );

  // C. Running task.request revising standalone bot PR #1399 (must NOT fabricate a root Issue)
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input) VALUES('t-standalone-bot-pr','101','task.request','running','Update scripts PR',1399,?)",
    JSON.stringify({ target: { type: 'pr', number: 1399 } }),
  );

  // D. Running task.request reviewing external non-bot PR #1400 (no bot_pull_requests row, only target + input.object)
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,input) VALUES('t-ext-pr','101','task.request','running','Inspect dependency update',1400,?,?)",
    sha5,
    JSON.stringify({
      target: { type: 'pr', number: 1400, ref: sha5 },
      object: { number: 1400, title: 'chore: bump deps', state: 'open', draft: false, head: { ref: 'chore/deps', sha: sha5 }, html_url: 'https://github.com/fixture/project-101/pull/1400' },
    }),
  );

  // E. Corrupted JSON input in the same batch must not break sibling tasks
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t-corrupt','101','task.request','queued','Corrupt row','{bad-json')",
  );

  const attached = attachExternalLinks(store, [
    taskRow(store, 't-queued-bot-pr'),
    taskRow(store, 't-running-legacy-bot-pr'),
    taskRow(store, 't-standalone-bot-pr'),
    taskRow(store, 't-ext-pr'),
    taskRow(store, 't-corrupt'),
  ]);
  const byId = Object.fromEntries(attached.map(item => [item.id, item.external]));

  // A: Queued bot PR task resolves PR #1325 + branch + root Issue #1237 + Actions checks immediately before push
  assert.deepEqual(byId['t-queued-bot-pr'].pull_request, {
    number: 1325,
    title: 'fix(#1237): incremental sync',
    state: 'open',
    draft: false,
    branch: 'bot/issue-1237',
    head_sha: sha1,
    url: 'https://github.com/fixture/project-101/pull/1325',
  });
  assert.deepEqual(byId['t-queued-bot-pr'].issue, {
    number: 1237,
    title: 'Support incremental sync',
    state: 'open',
    url: 'https://github.com/fixture/project-101/issues/1237',
  });
  assert.equal(byId['t-queued-bot-pr'].actions.head_sha, sha1);
  assert.equal(byId['t-queued-bot-pr'].actions.status, 'passing');
  assert.equal(byId['t-queued-bot-pr'].actions.total, 1);

  // B: Running bot PR task prefers live input.bot_pr head ref/sha and falls through non-issue source_task_id to legacy root Issue #1100
  assert.deepEqual(byId['t-running-legacy-bot-pr'].pull_request, {
    number: 1105,
    title: 'fix(#1100): legacy fix',
    state: 'open',
    draft: true,
    branch: 'bot/issue-1100-rebased',
    head_sha: sha4,
    url: 'https://github.com/fixture/project-101/pull/1105',
  });
  assert.deepEqual(byId['t-running-legacy-bot-pr'].issue, {
    number: 1100,
    title: 'Legacy issue title',
    state: 'open',
    url: 'https://github.com/fixture/project-101/issues/1100',
  });
  assert.equal(byId['t-running-legacy-bot-pr'].actions.head_sha, sha4);

  // C: Standalone bot PR has PR metadata and no fabricated Issue
  assert.equal(byId['t-standalone-bot-pr'].pull_request.number, 1399);
  assert.equal(byId['t-standalone-bot-pr'].pull_request.branch, 'bot/refactor-scripts');
  assert.equal(byId['t-standalone-bot-pr'].pull_request.head_sha, sha3);
  assert.equal(byId['t-standalone-bot-pr'].issue, null);

  // D: Non-bot external PR resolves PR #1400 with branch/sha/url and leaves issue null (never #1400)
  assert.deepEqual(byId['t-ext-pr'].pull_request, {
    number: 1400,
    title: 'chore: bump deps',
    state: 'open',
    draft: false,
    branch: 'chore/deps',
    head_sha: sha5,
    url: 'https://github.com/fixture/project-101/pull/1400',
  });
  assert.equal(byId['t-ext-pr'].issue, null);
  assert.equal(byId['t-ext-pr'].actions.head_sha, sha5);
  assert.equal(byId['t-ext-pr'].actions.url, 'https://github.com/fixture/project-101/pull/1400/checks');

  // E: Corrupt JSON input degrades cleanly
  assert.equal(byId['t-corrupt'].issue, null);
  assert.equal(byId['t-corrupt'].pull_request, null);
});

test('attachExternalLinks handles task.request Issue targets (before and with bot_pr), post-push overrides, and legacy PR kinds', t => {
  const store = createFixture(t);
  const baseSha = 'a'.repeat(40);
  const botSha = 'b'.repeat(40);
  const pushedSha = 'c'.repeat(40);

  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','issue',1500,'Add export command','open',0,'2026-11-24T08:00:00Z')");
  store.run("INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',1505,'feat(#1500): add export','open',0,'2026-11-24T08:10:00Z')");

  // 1. Fresh task.request on Issue #1500 (no PR yet): head_sha is base branch and MUST NOT leak into actions.head_sha
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,input) VALUES('t-issue-fresh','101','task.request','running','Implement #1500',1500,?,?)",
    baseSha,
    JSON.stringify({ target: { type: 'issue', number: 1500 } }),
  );

  // 2. task.request on Issue #1500 that already attached existing open bot_pr #1505 before pushing a new commit
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',1505,'pr-1505','99','101','bot/issue-1500',?,'t-issue-fresh',1)",
    botSha,
  );
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,input) VALUES('t-issue-with-bot-pr','101','task.request','running','Continue #1500',1500,?,?)",
    baseSha,
    JSON.stringify({
      target: { type: 'issue', number: 1500 },
      bot_pr: { number: 1505, head: { ref: 'bot/issue-1500', sha: botSha }, state: 'open', draft: false },
    }),
  );

  // 3. Post-push task.request on PR #1505: pushed_sha + result override pre-push bot_pr head
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,input,result) VALUES('t-pr-pushed','101','task.request','completed','Done #1505',1505,?,?,?)",
    botSha,
    JSON.stringify({
      target: { type: 'pr', number: 1505 },
      bot_pr: { number: 1505, head: { ref: 'bot/issue-1500', sha: botSha }, state: 'open' },
    }),
    JSON.stringify({ pr_number: 1505, branch: 'bot/issue-1500', sha: pushedSha, merged: true }),
  );

  // 4. Legacy development.pr with source_task_id pointing to a task.request Issue task
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,source_task_id,head_sha,input) VALUES('t-legacy-dev-pr','101','development.pr','running','Revise #1505',1505,'t-issue-fresh',?,'{}')",
    botSha,
  );

  const attached = attachExternalLinks(store, [
    taskRow(store, 't-issue-fresh'),
    taskRow(store, 't-issue-with-bot-pr'),
    taskRow(store, 't-pr-pushed'),
    taskRow(store, 't-legacy-dev-pr'),
  ]);
  const byId = Object.fromEntries(attached.map(item => [item.id, item.external]));

  // Fresh Issue task has issue #1500, no PR (Wait: t-issue-fresh IS source_task_id of bot_pull_requests 1505 above, so let's test an unlinked Issue separately below!)
  assert.equal(byId['t-issue-fresh'].issue.number, 1500);
  // Check an Issue task with no bot_pull_requests row at all:
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,input) VALUES('t-issue-unlinked','101','task.request','running','Implement #1501',1501,?,?)",
    baseSha,
    JSON.stringify({ target: { type: 'issue', number: 1501 } }),
  );
  const unlinked = attachExternalLinks(store, [taskRow(store, 't-issue-unlinked')])[0].external;
  assert.equal(unlinked.issue.number, 1501);
  assert.equal(unlinked.pull_request, null);
  assert.equal(unlinked.actions.head_sha, null);

  // Issue task with input.bot_pr shows BOTH Issue #1500 and PR #1505
  assert.equal(byId['t-issue-with-bot-pr'].issue.number, 1500);
  assert.equal(byId['t-issue-with-bot-pr'].pull_request.number, 1505);
  assert.equal(byId['t-issue-with-bot-pr'].pull_request.branch, 'bot/issue-1500');
  assert.equal(byId['t-issue-with-bot-pr'].pull_request.head_sha, botSha);
  assert.equal(byId['t-issue-with-bot-pr'].actions.head_sha, botSha);

  // Post-push result overrides pre-push bot_pr sha & merged state
  assert.equal(byId['t-pr-pushed'].pull_request.head_sha, pushedSha);
  assert.equal(byId['t-pr-pushed'].pull_request.state, 'merged');
  assert.equal(byId['t-pr-pushed'].issue.number, 1500);

  // Legacy development.pr resolves both PR #1505 and root Issue #1500 (from task.request source task)
  assert.equal(byId['t-legacy-dev-pr'].pull_request.number, 1505);
  assert.equal(byId['t-legacy-dev-pr'].issue.number, 1500);
});
