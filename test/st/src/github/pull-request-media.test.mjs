import assert from 'node:assert/strict';
import { request } from 'node:http';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { blobSha, Redactor, sha } from '../../../../dist/agent/common.js';
import { browserEvidenceDir } from '../../../../dist/browser/runtime.js';
import { browserEvidenceRoot, runBrowserTool } from '../../../../dist/browser/tools.js';
import { assertMediaOutsideCode, collectPullRequestMedia, planPullRequestMedia, publishPullRequestMedia, pullRequestSummaryForProgress } from '../../../../dist/github/pull-request-media.js';
import { Publisher } from '../../../../dist/github/publisher.js';
import { hostedMediaUrl } from '../../../../dist/github/hosted-pr-media.js';
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
    ['![A](workspace:../browser/evidence/nested/x.png)', ['../browser/evidence/nested/x.png']],
    ['![A](workspace:../browser/evidence/step-1.jpg)', ['../browser/evidence/step-1.jpg']],
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

test('collects only this task’s recorded screenshots from the control-plane evidence directory', async t => {
  const { store } = await harness(t);
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  store.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
  const tasks = ['current', 'other'].map(taskId => {
    store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?, 'r','task.request','running','Browser fixture',?)",
      taskId, JSON.stringify({ browser: { origins: ['https://example.test'] } }));
    return store.get('SELECT * FROM tasks WHERE id=?', taskId);
  });
  const [task, other] = tasks;
  const workspace = { store, task, redactor: new Redactor(), async guard() {},
    async deliver() { assert.fail('Control-plane evidence is never read through the runner file export'); },
  };
  async function capture(owner, n, bytes = png) {
    const file = `step-${n}.png`;
    await runBrowserTool(store, owner, { action: 'screenshot' }, {
      workspace: { async call() { return { ok: true, step: { id: file, n }, screenshot: { file, base64: bytes.toString('base64') } }; } },
    });
  }
  await capture(task, 1);
  await capture(other, 2);
  const evidence = part => '../browser/evidence/' + part;
  const dir = browserEvidenceDir(browserEvidenceRoot(store), task.id);
  const [file] = await collectPullRequestMedia(workspace, [evidence('step-1.png')]);
  assert.equal(file.source, evidence('step-1.png'));
  assert.equal(file.path, `${sha(png)}.png`);
  assert.deepEqual(Buffer.from(store.trajectories.getBlob(file.content.$blob), 'base64'), png);

  await writeFile(join(dir, 'step-3.png'), png);
  for (const name of ['step-2.png', 'step-3.png', '../other/step-2.png'])
    await assert.rejects(collectPullRequestMedia(workspace, [evidence(name)]), { code: 'pull_request_media_invalid' });
  const outside = join(browserEvidenceDir(browserEvidenceRoot(store), other.id), 'step-2.png');
  await rm(join(dir, 'step-1.png'));
  await symlink(outside, join(dir, 'step-1.png'));
  await assert.rejects(collectPullRequestMedia(workspace, [evidence('step-1.png')]), { code: 'pull_request_media_invalid' });
  await rm(join(dir, 'step-1.png'));
  await link(outside, join(dir, 'step-1.png'));
  await assert.rejects(collectPullRequestMedia(workspace, [evidence('step-1.png')]), { code: 'pull_request_media_invalid' });
  await capture(task, 4, Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
  await assert.rejects(collectPullRequestMedia(workspace, [evidence('step-4.png')]), { code: 'pull_request_media_invalid' });
  await capture(task, 5, Buffer.concat([png, Buffer.from('sk-' + 'testOnlyCredential0123456789')]));
  await assert.rejects(collectPullRequestMedia(workspace, [evidence('step-5.png')]), { code: 'pull_request_media_invalid' });
  await capture(task, 6);
  const tampered = Buffer.from(png);
  tampered[tampered.length - 1] ^= 1;
  await writeFile(join(dir, 'step-6.png'), tampered);
  await assert.rejects(collectPullRequestMedia(workspace, [evidence('step-6.png')]), { code: 'pull_request_media_invalid' });
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
