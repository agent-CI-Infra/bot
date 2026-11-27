import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { blobSha, Redactor, sha } from '../../../../dist/agent/common.js';
import { assertMediaOutsideCode, bytesMatch, collectPullRequestMedia, detectHostedMediaFormat, normalizeAssistantMediaPath, planMarkdownMedia, planPullRequestMedia, publishHostedMedia, publishPullRequestMedia, pullRequestSummaryForProgress } from '../../../../dist/github/pull-request-media.js';
import { Publisher } from '../../../../dist/github/publisher.js';
import { hostedMediaUrl } from '../../../../dist/github/hosted-pr-media.js';
import { githubWrite, githubWriteTool, scopedGithubWriteTool } from '../../../../dist/github/write.js';
import { publishReviewDelivery, validateReviewDelivery } from '../../../../dist/tasks/github-write.js';
import { harness } from '../../../fixtures/helpers.mjs';
import { Store } from '../../../../dist/storage/database.js';
import { workspace as runWorkspace } from '../../../../runner/workspace.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZkAAAAASUVORK5CYII=', 'base64');
const id = 'a'.repeat(48);

test('rewrites selected Markdown destinations and preserves other content', () => {
  const summary = '## Results\n\n> ![Screen](workspace:.tmp/step%201.png "Title")\n\n- [Replay](<workspace:.tmp/demo.mp4>)\n- [Docs](./docs/a.md)\n\n`![Unrelated](workspace:x.png)`\n\n![Remote](https://example.test/old.png)';
  const plan = planPullRequestMedia(summary, ['.tmp/step 1.png', '.tmp/demo.mp4']);
  assert.equal(plan.render(path => `https://example.test/${path.endsWith('.png') ? 'image' : 'video'}`),
    summary.replace('workspace:.tmp/step%201.png', 'https://example.test/image').replace('workspace:.tmp/demo.mp4', 'https://example.test/video'));
  assert.equal(plan.render(), summary.replace('![Screen](workspace:.tmp/step%201.png "Title")', 'Screen').replace('[Replay](<workspace:.tmp/demo.mp4>)', 'Replay'));
  assert.equal(planPullRequestMedia('See ![repo image](assets/diagram.png).', undefined).render(), 'See ![repo image](assets/diagram.png).');
  assert.equal(planPullRequestMedia('![A](workspace:x.png)\n\n![A](workspace:x.png)', ['x.png']).render(() => 'url'), '![A](url)\n\n![A](url)');
  assert.equal(planPullRequestMedia('![A](./x.png)', ['x.png']).render(() => 'url'), '![A](url)');
  assert.throws(() => planPullRequestMedia(undefined, []), { code: 'pull_request_media_invalid' });
});

test('rejects unselected, wrong Markdown type, unsupported and out-of-scope media', () => {
  for (const [summary, paths] of [
    ['![A](workspace:x.png)', undefined], ['No reference', ['x.png']], ['![A](workspace:x.mp4)', ['x.mp4']],
    ['[A](workspace:x.png)', ['x.png']], ['![A](workspace:x.svg)', ['x.svg']], ['![A](workspace:../notes/x.png)', ['../notes/x.png']],
    ['![A](workspace:/tmp/x.png)', ['/tmp/x.png']], ['![A](workspace:.git/x.png)', ['.git/x.png']],
    ['![A](workspace:../browser/evidence/step-1.png)', ['../browser/evidence/step-1.png']],
    ['![A](workspace:../browser/evidence/nested/x.png)', ['../browser/evidence/nested/x.png']],
    ['![A][x]\n\n[x]: workspace:x.png', ['x.png']], ['`![A](workspace:x.png)`\n\n![A](workspace:x.png)', ['x.png']],
  ]) assert.throws(() => planPullRequestMedia(summary, paths), { code: 'pull_request_media_invalid' });
  const diff = [{ path: 'x.png', mode: '100644', sha: 'new' }];
  assert.throws(() => assertMediaOutsideCode(['x.png'], diff, []), { code: 'pull_request_media_invalid' });
  assert.doesNotThrow(() => assertMediaOutsideCode(['x.png'], diff, diff));
});

function database(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 1));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  store.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
  return store;
}

test('the publisher uses hosted media URLs, requires confirmed media and keeps existing lines on revision', async t => {
  const store = database(t);
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES ('create','r','development.issue','publishing','Add screenshots',4),('revise','r','development.pr','publishing','Revise PR',7)");
  const task = id => store.get('SELECT * FROM tasks WHERE id=?', id);
  const firstHead = 'a'.repeat(40), secondHead = 'b'.repeat(40), origin = 'https://files.example.test';
  const branch = 'bot/issue-4-create', fullName = 'fixture/r';
  const media = [{ source: '.tmp/shot.png', path: `${'e'.repeat(64)}.png` }, { source: '.tmp/demo.mp4', path: `${'f'.repeat(64)}.mp4` }];
  const summary = '![Screenshot](workspace:.tmp/shot.png)\n\n[Recording](workspace:.tmp/demo.mp4)';
  const hosted = { origin, tokens: { [media[0].path]: 'a'.repeat(64), [media[1].path]: 'b'.repeat(64) } };
  const pinned = `![Screenshot](${origin}/pr-media/${'a'.repeat(64)})\n\n[Recording](${origin}/pr-media/${'b'.repeat(64)})`;
  const writes = [];
  let head = firstHead;
  const pr = () => ({ id: 55, number: 7, user: { id: 42 }, head: { sha: head, ref: branch, repo: { id: 'r' } } });
  const github = {
    fullName, actorId: '42', path: suffix => suffix, object: async () => pr(),
    async request(method, path, body) {
      this.beforeWrite?.();
      writes.push({ method, path, body });
      return { ...pr(), title: body.title, body: body.body };
    },
  };
  const create = new Publisher(store, github, task('create'), async () => {}, [0]);
  const candidate = { branch, base_branch: 'main', summary, change_title: 'Add screenshots', media, remote_sha: firstHead };
  await assert.rejects(create.pullRequest(candidate, firstHead), { code: 'pull_request_media_unconfirmed' });
  assert.deepEqual(writes, []);
  assert.equal(pullRequestSummaryForProgress(candidate), 'Screenshot\n\nRecording');

  await create.pullRequest({ ...candidate, hosted_media: hosted }, firstHead);
  assert.deepEqual([writes[0].method, writes[0].path], ['POST', '/pulls']);
  assert.ok(writes[0].body.body.startsWith(pinned + '\n\n'));
  assert.doesNotMatch(writes[0].body.body, /workspace:/);

  head = secondHead;
  const revise = new Publisher(store, github, task('revise'), async () => {}, [0]);
  const added = { source: '.tmp/revision.png', path: `${'1'.repeat(64)}.png` };
  const newToken = 'c'.repeat(64);
  const revision = {
    pr_number: 7, summary: 'Revision notes\n\n' + pinned + `\n\n![New screenshot](workspace:${added.source})`,
    change_title: 'Revise screenshots', remote_sha: secondHead, media: [added], hosted_media: { origin, tokens: { [added.path]: newToken } },
  };
  await revise.pullRequest(revision, secondHead);
  assert.deepEqual([writes[1].method, writes[1].path], ['PATCH', '/pulls/7']);
  const nextPinned = `![New screenshot](${origin}/pr-media/${newToken})`;
  assert.ok(writes[1].body.body.startsWith('Revision notes\n\n' + pinned + '\n\n' + nextPinned + '\n\n'));
  assert.doesNotMatch(writes[1].body.body, /workspace:/);
});

test('runner reads only selected regular files in the task checkout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pull-request-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, id, 'repo');
  await mkdir(repo, { recursive: true });
  await mkdir(join(repo, 'directory.png'));
  await writeFile(join(repo, 'shot.png'), png);
  await writeFile(join(root, 'outside.png'), png);
  await symlink(root, join(repo, 'other'));
  await symlink(join(root, 'outside.png'), join(repo, 'symlink.png'));
  await link(join(root, 'outside.png'), join(repo, 'hardlink.png'));
  await writeFile(join(repo, 'fake.png'), 'HTML pretending to be an image');
  await writeFile(join(repo, 'large.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await writeFile(join(repo, 'secret.png'), Buffer.concat([png, Buffer.from('sk-' + 'testOnlyCredential0123456789')]));
  const calls = [];
  const workspace = { store: database(t), task: { repository_id: 'r' }, redactor: new Redactor(),
    async deliver(request) {
      calls.push(request);
      try { return await runWorkspace({ ...request, workspace_id: id }, root); }
      catch (error) { return { error: error.code || error.message }; }
    },
  };
  const files = await collectPullRequestMedia(workspace, ['shot.png']);
  assert.deepEqual(files.map(file => file.path), [`${sha(png)}.png`]);
  assert.equal(calls.filter(call => call.type === 'workspace_export').length, 1);
  for (const path of ['other/outside.png', 'symlink.png', 'hardlink.png', 'directory.png', 'fake.png', 'large.png', 'secret.png', 'missing.png'])
    await assert.rejects(collectPullRequestMedia(workspace, [path]), { code: 'pull_request_media_invalid' });
});

function rawRequest(origin, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const req = request({ host: target.hostname, port: target.port, path, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('hosting issues independent random links with private bytes and exposes only exact single-file reads', async t => {
  const monitoredPaths = [];
  const h = await harness(t, undefined, { stalls: { request(_method, path) { monitoredPaths.push(path); return () => {}; } } });
  const store = h.store;
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  store.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
  store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://files.example.test' }));
  const github = { store, repository: { id: 'r' }, redactor: new Redactor(), installationPermissions: { contents: 'write' },
    permissions: { contents: 'write', pull_requests: 'write' } };
  const video = Buffer.from('00000018667479706d70343200000000', 'hex');
  const asset = (bytes, format) => ({ source: `asset.${format}`, path: `${sha(bytes)}.${format}`, blob: blobSha(bytes),
    content: store.trajectories.putBlob(bytes.toString('base64'), 'r') });
  const imageAsset = asset(png, 'png'), videoAsset = asset(video, 'mp4');
  const hosted = publishPullRequestMedia(github, [imageAsset, imageAsset, videoAsset]);
  const another = publishPullRequestMedia(github, [imageAsset]);
  assert.equal(Object.keys(hosted.tokens).length, 2);
  const token = hosted.tokens[imageAsset.path], videoToken = hosted.tokens[videoAsset.path];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, sha(png));
  assert.notEqual(token, videoToken);
  assert.notEqual(token, another.tokens[imageAsset.path]);
  assert.equal(hostedMediaUrl(hosted, imageAsset.path), `https://files.example.test/pr-media/${token}`);
  assert.equal(store.get('SELECT COUNT(*) AS count FROM trajectory_blobs').count, 2);
  assert.equal(store.get('SELECT token_hash FROM hosted_pr_media WHERE token_hash=?', token), undefined);

  const path = `/pr-media/${token}`;
  const image = await rawRequest(h.admin, path);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['cache-control'], 'private, no-store');
  assert.equal(image.headers['referrer-policy'], 'no-referrer');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(image.bytes, png);
  const head = await rawRequest(h.admin, path, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(png.length));
  assert.equal(head.bytes.length, 0);
  const download = await rawRequest(h.admin, `/pr-media/${videoToken}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'video/mp4');
  assert.equal(download.headers['content-disposition'], 'attachment; filename="recording.mp4"');
  assert.deepEqual(download.bytes, video);

  for (const invalid of ['/pr-media', '/pr-media/', `/pr-media/${sha(png)}`, path + '/', path + '?download=1',
    `/pr-media/../pr-media/${token}`, `/pr-media/%2e%2e/pr-media/${token}`, `/pr-media/%2f${token}`, `/pr-media/%252e%252e/${token}`]) {
    assert.equal((await rawRequest(h.admin, invalid)).status, 404);
  }
  assert.equal((await rawRequest(h.admin, path, 'POST')).status, 404);
  assert.deepEqual([...new Set(monitoredPaths)], ['/pr-media']);
  store.run("INSERT INTO repositories VALUES('other','fixture/other','1','a')");
  assert.throws(() => publishPullRequestMedia({ ...github, repository: { id: 'other' } }, [imageAsset]), { code: 'pull_request_media_corrupt' });
  github.permissions.contents = 'read';
  assert.throws(() => publishPullRequestMedia(github, [imageAsset]), { code: 'pull_request_media_permission' });
  github.permissions.contents = 'write';
  store.run("UPDATE settings SET value=? WHERE key='onboarding.public'", JSON.stringify({ origin: 'http://127.0.0.1' }));
  assert.throws(() => publishPullRequestMedia(github, [imageAsset]), { code: 'pull_request_media_origin_missing' });
  store.run("DELETE FROM repositories WHERE id='r'");
  assert.equal((await rawRequest(h.admin, path)).status, 404);
});

test('github_write and post_review attach hosted workspace media to Issue/PR comments and reviews', async t => {
  const h = await harness(t);
  const store = h.store;
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-bot-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  store.run("INSERT INTO policies(repository_id,enabled,review_enabled,development_enabled,capability_ceiling) VALUES('r',1,1,0,'comment')");
  store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://files.example.test' }));

  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const reqPath = new URL(req.url, 'http://fixture').pathname, body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: reqPath, body });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (reqPath === '/user') return send({ id: 99, login: 'fixture-bot' });
    if (reqPath === '/repositories/r') return send({ id: 'r', owner: { id: '10' }, full_name: 'fixture/r', default_branch: 'main' });
    if (reqPath === '/repos/fixture/r/issues/12') return send({ number: 12, title: 'UI Issue', body: 'Need screenshot', labels: [] });
    if (reqPath === '/repos/fixture/r/issues/12/comments' && req.method === 'POST') return send({ id: 301, html_url: 'https://github.com/fixture/r/issues/12#issuecomment-301', body: body.body }, 201);
    if (reqPath === '/repos/fixture/r/issues/12/comments' && req.method === 'GET') return send([]);
    if (reqPath === '/repos/fixture/r/pulls/7') return send({ number: 7, title: 'UI PR', body: 'Changed layout', head: { sha: 'a'.repeat(40) }, labels: [] });
    if (reqPath === '/repos/fixture/r/pulls/7/files') return send([{ filename: 'ui.js', status: 'modified', patch: '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n' }]);
    if (reqPath === '/repos/fixture/r/pulls/7/reviews' && req.method === 'POST') return send({ id: 401, html_url: 'https://github.com/fixture/r/pull/7#pullrequestreview-401', body: body.body }, 200);
    if (reqPath === '/repos/fixture/r/issues/7/comments' && req.method === 'POST') return send({ id: 402, html_url: 'https://github.com/fixture/r/pull/7#issuecomment-402', body: body.body }, 201);
    if (reqPath === '/repos/fixture/r/issues/7/comments' && req.method === 'GET') return send([]);
    if (reqPath === '/repos/fixture/r/pulls/7/comments' && req.method === 'GET') return send([]);
    if (reqPath === '/repos/fixture/r/issues/7/labels') return send(req.method === 'POST' ? (body.labels || []).map(name => ({ name })) : []);
    if (reqPath === '/repos/fixture/r/labels') return send([]);
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const apiUrl = 'http://127.0.0.1:' + server.address().port;
  const repository = store.get("SELECT * FROM repositories WHERE id='r'");

  const workspace = {
    store, task: { repository_id: 'r' }, redactor: new Redactor(),
    async deliver(request) {
      if (request.type === 'workspace_export') return request.path === '.tmp/shot.png' ? { sha: blobSha(png), size: png.length } : { error: 'not_found' };
      if (request.type === 'workspace_blob') return { size: png.length, base64: png.toString('base64') };
      throw new Error('unexpected ' + request.type);
    },
  };
  let collectCalls = 0;
  const collectMedia = async paths => { collectCalls++; return collectPullRequestMedia(workspace, paths); };

  // 1. Issue comment with media succeeds at comment ceiling with only issues: write!
  const write = (args, withWorkspace = true) => githubWrite({
    store, repository, redactor: new Redactor(), guard: async () => {}, apiUrl,
    scope: 'task:comment-media', actor: { kind: 'task', role: 'reviewer', task_id: 't1' },
    allowed: resource => resource === 'issues' || resource === 'pull_requests',
    ...(withWorkspace ? { collectMedia } : {}),
  }, args);

  const commentRes = await write({
    method: 'POST', path: '/issues/12/comments', key: 'shot-comment',
    body: { body: 'Verified UI:\n\n![Shot](workspace:.tmp/shot.png)' },
    media: ['.tmp/shot.png'],
  });
  assert.equal(commentRes.status, 201);
  const postedComment = requests.find(r => r.method === 'POST' && r.path === '/repos/fixture/r/issues/12/comments');
  const match = /https:\/\/files\.example\.test(\/pr-media\/[a-f0-9]{64})/.exec(postedComment.body.body);
  assert.ok(match, 'comment body rewrote workspace: link to hosted /pr-media URL');
  assert.doesNotMatch(postedComment.body.body, /workspace:/);
  const served = await rawRequest(h.admin, match[1]);
  assert.equal(served.status, 200);
  assert.deepEqual(served.bytes, png);

  // Replay with same key returns cached response without re-collecting or minting another token.
  const tokenCountBefore = store.get('SELECT COUNT(*) c FROM hosted_pr_media').c;
  const replay = await write({
    method: 'POST', path: '/issues/12/comments', key: 'shot-comment',
    body: { body: 'Verified UI:\n\n![Shot](workspace:.tmp/shot.png)' },
    media: ['.tmp/shot.png'],
  });
  assert.equal(replay.replayed, true);
  assert.equal(collectCalls, 1);
  assert.equal(store.get('SELECT COUNT(*) c FROM hosted_pr_media').c, tokenCountBefore);

  // 2. PR review via github_write supports media referenced in both review body and inline comment body.
  const reviewRes = await write({
    method: 'POST', path: '/pulls/7/reviews', key: 'shot-review',
    body: { event: 'COMMENT', body: 'Summary:\n![S1](workspace:.tmp/shot.png)', comments: [{ path: 'ui.js', line: 2, body: 'Inline:\n![S2](workspace:.tmp/shot.png)' }] },
    media: ['.tmp/shot.png'],
  });
  assert.equal(reviewRes.status, 200);
  const postedReview = requests.find(r => r.method === 'POST' && r.path === '/repos/fixture/r/pulls/7/reviews');
  assert.match(postedReview.body.body, /https:\/\/files\.example\.test\/pr-media\/[a-f0-9]{64}/);
  assert.match(postedReview.body.comments[0].body, /https:\/\/files\.example\.test\/pr-media\/[a-f0-9]{64}/);

  // 3. Error cases: unsupported route, no workspace, unlisted workspace link, missing public origin.
  assert.equal((await write({ method: 'POST', path: '/issues/12/labels', key: 'bad-route', body: { labels: ['bug'] }, media: ['.tmp/shot.png'] })).error, 'github_write_media_unsupported_route');
  assert.equal((await write({ method: 'POST', path: '/issues/12/comments', key: 'no-ws', body: { body: '![Shot](workspace:.tmp/shot.png)' }, media: ['.tmp/shot.png'] }, false)).error, 'github_write_media_unavailable');
  assert.equal((await write({ method: 'POST', path: '/issues/12/comments', key: 'unlisted', body: { body: '![Shot](workspace:.tmp/shot.png)' } })).error, 'pull_request_media_invalid');

  // 4. post_review validation & publication with media.
  const now = new Date().toISOString();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('rev-media','r','task.request','running','Review',?,7,?,?,?)",
    JSON.stringify({ generic: true, target: { type: 'pr', number: 7 } }), 'a'.repeat(40), now, now);
  const reviewTask = store.get("SELECT * FROM tasks WHERE id='rev-media'");
  const badReview = validateReviewDelivery(reviewTask, { pull_number: 7, summary: '![Shot](workspace:.tmp/shot.png)' });
  assert.equal(badReview.ok, false);
  assert.equal(badReview.error.error, 'pull_request_media_invalid');
  const checkedReview = validateReviewDelivery(reviewTask, { pull_number: 7, summary: 'Review evidence:\n![ReviewShot](workspace:.tmp/shot.png)', media: ['.tmp/shot.png'] });
  assert.equal(checkedReview.ok, true);
  assert.deepEqual(checkedReview.value.media_paths, ['.tmp/shot.png']);
  const reviewMedia = await collectPullRequestMedia(workspace, checkedReview.value.media_paths);
  const published = await publishReviewDelivery(store, reviewTask, { ...checkedReview.value, media: reviewMedia }, new Redactor(), async () => {}, () => {}, apiUrl);
  assert.equal(published.ok, true);
  const reviewSummaryComment = requests.find(r => r.method === 'POST' && r.path === '/repos/fixture/r/issues/7/comments');
  assert.match(reviewSummaryComment.body.body, /https:\/\/files\.example\.test\/pr-media\/[a-f0-9]{64}/);
  assert.doesNotMatch(reviewSummaryComment.body.body, /workspace:/);

  // 5. Missing public origin refuses comment media cleanly without posting.
  const commentCountBefore = requests.filter(r => r.path === '/repos/fixture/r/issues/12/comments').length;
  store.run("UPDATE settings SET value=? WHERE key='onboarding.public'", JSON.stringify({ origin: 'http://127.0.0.1' }));
  assert.equal((await write({ method: 'POST', path: '/issues/12/comments', key: 'no-origin', body: { body: '![Shot](workspace:.tmp/shot.png)' }, media: ['.tmp/shot.png'] })).error, 'pull_request_media_origin_missing');
  assert.equal(requests.filter(r => r.path === '/repos/fixture/r/issues/12/comments').length, commentCountBefore);

  // Also check planMarkdownMedia & publishHostedMedia directly for issue-only permission.
  assert.equal(planMarkdownMedia(['a', '![x](workspace:.tmp/shot.png)'], ['.tmp/shot.png']).paths.length, 1);
  store.run("UPDATE settings SET value=? WHERE key='onboarding.public'", JSON.stringify({ origin: 'https://files.example.test' }));
  const hostedByIssuesOnly = publishHostedMedia({ store, repository: { id: 'r' }, redactor: new Redactor(), installationPermissions: { issues: 'write' }, permissions: { issues: 'write' } }, reviewMedia);
  assert.ok(hostedMediaUrl(hostedByIssuesOnly, reviewMedia[0].path));
});

test('F1 caller isolation keeps task workspaces strictly repo-relative while assistant mode supports resource: and assistant paths', async t => {
  const store = database(t);
  store.run("INSERT INTO policies(repository_id,enabled,review_enabled,development_enabled,capability_ceiling) VALUES('r',1,1,0,'comment')");
  store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://files.example.test' }));
  const repository = store.get("SELECT * FROM repositories WHERE id='r'");

  // 1. Task workspace mode strictly refuses resource:, /tmp, ~/, ../, and workspace: prefixes.
  for (const [text, media] of [
    ['![Shot](resource:res_1234)', ['resource:res_1234']],
    ['![Shot](workspace:/tmp/shot.png)', ['/tmp/shot.png']],
    ['![Shot](workspace:~/shot.png)', ['~/shot.png']],
    ['![Shot](workspace:../shot.png)', ['../shot.png']],
    ['![Shot](workspace:.tmp/shot.png)', ['workspace:.tmp/shot.png']],
  ]) {
    assert.throws(() => planMarkdownMedia([text], media), { code: 'pull_request_media_invalid' }, JSON.stringify(media));
  }

  // 2. githubWrite structurally locks task/manager actors to task_workspace mode even if mediaMode:'assistant' is passed.
  for (const kind of ['task', 'manager']) {
    for (const [body, media] of [
      ['![Shot](resource:res_1234)', ['resource:res_1234']],
      ['![Shot](workspace:/tmp/shot.png)', ['workspace:/tmp/shot.png']],
      ['![Shot](workspace:~/shot.png)', ['workspace:~/shot.png']],
    ]) {
      const res = await githubWrite({
        store, repository, redactor: new Redactor(), guard: async () => {},
        scope: `iso:${kind}`, actor: { kind, role: 'dev', task_id: 't-iso' },
        allowed: () => true,
        mediaMode: 'assistant',
        collectMedia: async () => { throw new Error('must not collect out-of-scope media'); },
      }, { method: 'POST', path: '/issues/12/comments', key: `iso-${kind}-${media[0]}`, body: { body }, media });
      assert.equal(res.error, 'pull_request_media_invalid', `${kind} must reject ${media[0]}`);
    }
  }

  // 3. Assistant mode accepts resource:<id> and normalized /workspace, /tmp, ~/ paths, and enforces format via assertFormats.
  assert.equal(normalizeAssistantMediaPath('frames/key.png'), '/workspace/frames/key.png');
  assert.equal(normalizeAssistantMediaPath('/workspace/frames/key.png'), '/workspace/frames/key.png');
  assert.equal(normalizeAssistantMediaPath('/tmp/frame.png'), '/tmp/frame.png');
  assert.equal(normalizeAssistantMediaPath('/home/assistant/shots/a.png'), '~/shots/a.png');
  assert.equal(normalizeAssistantMediaPath('~/shots/a.png'), '~/shots/a.png');
  for (const bad of ['/etc/passwd', '../escape.png', '/tmp/../etc/passwd', '/workspace/.runner-journal/a.png', '~', '~/', 'http://example.test/a.png']) {
    assert.throws(() => normalizeAssistantMediaPath(bad), { code: 'pull_request_media_invalid' }, bad);
  }

  const plan = planMarkdownMedia(
    ['![Feishu](resource:res_img_1)\n[Clip](resource:res_vid_2)\n![Frame](workspace:/tmp/key.png)\n![Home](workspace:/home/assistant/shot.png)'],
    ['resource:res_img_1', 'resource:res_vid_2', '/tmp/key.png', 'workspace:~/shot.png'],
    { mode: 'assistant' },
  );
  assert.deepEqual(plan.paths, ['resource:res_img_1', 'resource:res_vid_2', 'workspace:/tmp/key.png', 'workspace:~/shot.png']);
  assert.doesNotThrow(() => plan.assertFormats(new Map([
    ['resource:res_img_1', 'png'],
    ['resource:res_vid_2', 'mp4'],
    ['workspace:/tmp/key.png', 'png'],
    ['workspace:~/shot.png', 'png'],
  ])));
  // Image syntax on an MP4 resource_id or link syntax on a PNG resource_id must be refused by assertFormats.
  assert.throws(() => plan.assertFormats(new Map([
    ['resource:res_img_1', 'mp4'],
    ['resource:res_vid_2', 'mp4'],
    ['workspace:/tmp/key.png', 'png'],
    ['workspace:~/shot.png', 'png'],
  ])), { code: 'pull_request_media_invalid' });
  assert.throws(() => plan.assertFormats(new Map([
    ['resource:res_img_1', 'png'],
    ['resource:res_vid_2', 'png'],
    ['workspace:/tmp/key.png', 'png'],
    ['workspace:~/shot.png', 'png'],
  ])), { code: 'pull_request_media_invalid' });

  // 4. MP4/WebM magic-byte detection allowlists MP4 video brands and excludes image/QuickTime/audio/3GP ISOBMFF brands.
  const mp4 = Buffer.from('00000018667479706d70343200000000', 'hex');
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), Buffer.alloc(16)]);
  const avif = Buffer.from('00000018667479706176696600000000', 'hex');
  const heic = Buffer.from('00000018667479706865696300000000', 'hex');
  const mov = Buffer.from('00000018667479707174202000000000', 'hex');
  const m4a = Buffer.from('00000018667479704d34412000000000', 'hex');
  const threeGp = Buffer.from('00000018667479703367703400000000', 'hex');
  assert.equal(detectHostedMediaFormat(mp4), 'mp4');
  assert.equal(detectHostedMediaFormat(webm), 'webm');
  for (const rejected of [avif, heic, mov, m4a, threeGp]) {
    assert.equal(bytesMatch(rejected, 'mp4'), false);
    assert.equal(detectHostedMediaFormat(rejected), null);
  }

  // 5. Scoped assistant github_write tool advertises resource:/workspace: guidance while task github_write stays task-workspace only.
  assert.match(scopedGithubWriteTool.function.description, /resource:<resource_id>/);
  assert.match(scopedGithubWriteTool.function.description, /workspace:<path>/);
  assert.doesNotMatch(githubWriteTool.function.description, /resource:/);
});
