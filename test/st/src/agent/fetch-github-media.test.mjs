import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from '../../../fixtures/release-fixtures.mjs';
import { randomWorkspaceId } from '../../../fixtures/helpers.mjs';
import { RepositoryExplorer, workspaceRepositoryTools } from '../../../../dist/agent/exploration.js';
import { ReadTokens } from '../../../../dist/agent/read-token.js';
import { blobSha, Redactor, sha } from '../../../../dist/agent/common.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { registerHostedMedia } from '../../../../dist/github/hosted-pr-media.js';
import {
  classifyGitHubMediaUrl,
  decodeHtmlAttr,
  GITHUB_MEDIA_MAX_IMAGE_BYTES,
  GITHUB_MEDIA_MAX_VIDEO_BYTES,
  isPrivateIp,
} from '../../../../dist/github/fetch-media.js';
import { RUNNER_TRANSFER_CHUNK_BYTES } from '../../../../runner/command-policy.mjs';
import { workspace as runnerWorkspace } from '../../../../runner/workspace.mjs';
import { sanitizeTrajectoryInput } from '../../../../manager/projects.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZkAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const publicLookup = async () => [{ address: '140.82.121.4', family: 4 }];

function setupTaskWorkspace(f, workspaceId) {
  const wsRoot = join(f.h.directory, 'runner-tasks');
  const gitRoot = join(f.h.directory, 'runner-git');
  const notesRoot = join(f.h.directory, 'runner-notes');
  const worktreesRoot = join(f.h.directory, 'runner-worktrees');
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(notesRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(join(wsRoot, workspaceId, 'repo'), { recursive: true });
  f.h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,generation,workspace_id) VALUES(?,'101','task.request','running','Fetch media',1,?)",
    'task-' + workspaceId.slice(0, 8),
    workspaceId,
  );
  const task = f.h.store.get('SELECT * FROM tasks WHERE workspace_id=?', workspaceId);
  const manager = {
    async call(_method, _path, { request }) {
      try {
        return { ok: true, result: await runnerWorkspace(request, wsRoot, gitRoot, notesRoot, worktreesRoot) };
      } catch (error) {
        return { ok: false, error: 'runner_operation_failed', detail: String(error?.message || error) };
      }
    },
  };
  const redactor = new Redactor();
  const workspace = new Workspace(f.h.store, manager, task, redactor, async () => {}, () => {});
  return { wsRoot, workspace, redactor };
}

test('fetch_github_media Path A maps same-repo /pr-media/<token> locally with zero outbound network, enforcing repo/installation/scope isolation', async t => {
  const f = await releaseFixture(t);
  assert.ok(workspaceRepositoryTools.some(tool => tool.function.name === 'fetch_github_media'));
  f.h.store.run("INSERT OR REPLACE INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.example.test' }));

  // Register hosted image and video for repo 101, and a second hosted image for another repo 202.
  const imgBlob = f.h.store.trajectories.putBlob(png.toString('base64'), '101').$blob;
  const vidBlob = f.h.store.trajectories.putBlob(mp4.toString('base64'), '101').$blob;
  const imgToken = registerHostedMedia(f.h.store, '101', imgBlob, 'png', png.length);
  const vidToken = registerHostedMedia(f.h.store, '101', vidBlob, 'mp4', mp4.length);

  // Repo 202 is already registered by releaseFixture; attach a hosted blob owned by repo 202.
  const otherBlob = f.h.store.trajectories.putBlob(png.toString('base64'), '202').$blob;
  const otherToken = registerHostedMedia(f.h.store, '202', otherBlob, 'png', png.length);

  // Switch repo 101 to a bot_account and leave GitHub API completely unreachable (proves zero network + no github_read_token).
  f.h.store.run("INSERT INTO accounts VALUES('pat-acc','pat','bot_account',NULL,?,'now')", f.h.store.secrets.seal({ token: 'pat-secret' }, 'account:pat-acc'));
  f.h.store.run("UPDATE repositories SET account_id='pat-acc' WHERE id='101'");

  const workspaceId = randomWorkspaceId();
  const { wsRoot, workspace, redactor } = setupTaskWorkspace(f, workspaceId);
  const repo = f.h.store.get("SELECT * FROM repositories WHERE id='101'");
  let scopes = ['actions']; // Missing issues / pull_requests / contents
  const tokens = new ReadTokens(f.h.store, repo, redactor, async () => {}, 'http://127.0.0.1:1', ['issues', 'pull_requests', 'contents', 'actions'], () => scopes);
  let writable = false;
  const explorer = new RepositoryExplorer(tokens, redactor, async () => {}, undefined, {
    writeChunk: (targetPath, data, offset, final) => workspace.writeMediaChunk(targetPath, data, offset, final),
    truncate: targetPath => workspace.truncateMedia(targetPath),
    canWriteCheckout: () => writable,
    fetchImpl: async () => { throw new Error('Path A must never perform outbound network fetch'); },
    lookup: async () => { throw new Error('Path A must never perform DNS lookup'); },
  });

  // 1. Denied without issues/pull_requests/contents scope.
  assert.deepEqual(await explorer.execute('fetch_github_media', { url: `https://bot.example.test/pr-media/${imgToken}` }), { error: 'github_resource_forbidden' });

  // 2. Grant issues read scope: absolute and relative /pr-media/ both map locally into ../context/media/ without github_read_token.
  scopes = ['issues'];
  const absRes = await explorer.execute('fetch_github_media', { url: `https://bot.example.test/pr-media/${imgToken}` });
  assert.equal(absRes.source, 'hosted_local');
  assert.equal(absRes.mime, 'image/png');
  assert.equal(absRes.format, 'png');
  assert.equal(absRes.size_bytes, png.length);
  assert.equal(absRes.sha256, sha(png));
  assert.match(absRes.path, /^\.\.\/context\/media\/[a-f0-9]{16}\.png$/);
  assert.deepEqual(readFileSync(join(wsRoot, workspaceId, 'context', absRes.path.slice('../context/'.length))), png);

  const tmpVideoPath = `/tmp/media/local-video-${workspaceId.slice(0, 8)}.mp4`;
  t.after(() => rmSync(tmpVideoPath, { force: true }));
  const relRes = await explorer.execute('fetch_github_media', { url: `/pr-media/${vidToken}`, path: tmpVideoPath });
  assert.equal(relRes.source, 'hosted_local', JSON.stringify(relRes));
  assert.equal(relRes.mime, 'video/mp4');
  assert.equal(relRes.path, tmpVideoPath);
  assert.deepEqual(readFileSync(tmpVideoPath), mp4);

  // 3. Read-only role cannot write into repository checkout (even via traversal), and ../notes or /workspace/project-notes is always forbidden.
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}`, path: 'docs/shot.png' })).error, 'workspace_write_not_allowed');
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}`, path: '../context/../repo/shot.png' })).error, 'workspace_write_not_allowed');
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}`, path: '/tmp/../workspace/worktrees/other/shot.png' })).error, 'invalid_media_path');
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}`, path: '../notes/shot.png' })).error, 'invalid_media_path');
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}`, path: '../context/../notes/shot.png' })).error, 'invalid_media_path');
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}`, path: '/workspace/project-notes/shot.png' })).error, 'invalid_media_path');

  // 4. Cross-repository hosted token is strictly rejected.
  assert.equal((await explorer.execute('fetch_github_media', { url: `https://bot.example.test/pr-media/${otherToken}` })).error, 'hosted_media_not_found');

  // 5. Invalid/malformed /pr-media/ path on own origin is rejected without falling through to Path B.
  assert.equal((await explorer.execute('fetch_github_media', { url: `https://bot.example.test/pr-media/${imgToken}?x=1` })).error, 'hosted_media_not_found');

  // 6. Byte-length mismatch fails closed.
  f.h.store.run('UPDATE hosted_pr_media SET bytes=? WHERE repository_id=?', png.length + 10, '101');
  assert.equal((await explorer.execute('fetch_github_media', { url: `/pr-media/${imgToken}` })).error, 'hosted_media_not_found');
});

test('fetch_github_media Path B enforces GitHub domain allowlist, SSRF/redirect/auth rules, private HTML resolution, Contents raw API and F2 streaming limits', async t => {
  const f = await releaseFixture(t);
  const workspaceId = randomWorkspaceId();
  const { wsRoot, workspace, redactor } = setupTaskWorkspace(f, workspaceId);
  const repo = f.h.store.get("SELECT * FROM repositories WHERE id='101'");

  // Pure SSRF IP & URL classifier checks.
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.5', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isPrivateIp(ip), true, `expected private IP: ${ip}`);
  }
  assert.equal(isPrivateIp('140.82.121.4'), false);
  assert.equal(classifyGitHubMediaUrl('http://github.com/user-attachments/assets/abc', 'fixture/project-101').kind, 'error');
  assert.equal(classifyGitHubMediaUrl('https://evil.example/a.png', 'fixture/project-101').error, 'github_media_url_forbidden');
  assert.equal(classifyGitHubMediaUrl('https://169.254.169.254/latest/meta-data', 'fixture/project-101').error, 'github_media_url_forbidden');
  assert.equal(classifyGitHubMediaUrl('https://raw.githubusercontent.com/other/repo/main/a.png', 'fixture/project-101').error, 'github_media_repository_mismatch');
  assert.equal(classifyGitHubMediaUrl('https://github.com/other/repo/assets/1/a', 'fixture/project-101').error, 'github_media_repository_mismatch');
  // Single-pass HTML attribute entity decoding: must never double-unescape &amp;lt; / &amp;quot; / &amp;#39;.
  assert.equal(decodeHtmlAttr('&amp;lt;&amp;quot;&amp;#39;&amp;gt;&amp;amp;'), '&lt;&quot;&#39;&gt;&amp;');
  assert.equal(decodeHtmlAttr('&lt;&quot;&#39;&gt;&amp;'), '<"\'>&');

  // Mock GitHub API routes for private source_path HTML resolution and Contents raw API.
  const apiHits = [];
  f.state.custom = async ({ req, path, url, res, send }) => {
    const accept = req.headers.accept || '';
    apiHits.push({ path, search: url.search, accept });
    if (path === '/repos/fixture/project-101/issues/12' && accept.includes('html+json')) {
      send({
        number: 12,
        body_html: '<p><img src="https://private-user-images.githubusercontent.com/999/private-uuid-123.png?jwt=signed-token-xyz&amp;tag=&amp;quot;&amp;lt;1" data-canonical-src="https://github.com/user-attachments/assets/private-uuid-123"></p>',
      });
      return true;
    }
    if (path === '/repos/fixture/project-101/contents/docs/shot.png' && url.search === '?ref=main' && accept.includes('raw+json')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
      res.end(png);
      return true;
    }
    return false;
  };

  const fetchCalls = [];
  let dnsRecords = [{ address: '140.82.121.4', family: 4 }];
  const mockFetch = async (input, init = {}) => {
    const url = String(input);
    const headers = init.headers || {};
    fetchCalls.push({ url, auth: headers.Authorization || headers.authorization || null });
    if (url === 'https://github.com/user-attachments/assets/public-uuid-1') {
      return new Response(null, { status: 302, headers: { Location: 'https://objects.githubusercontent.com/github-production-user-asset-6210df/public-uuid-1.png' } });
    }
    if (url === 'https://objects.githubusercontent.com/github-production-user-asset-6210df/public-uuid-1.png') {
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
    }
    if (url === 'https://github.com/user-attachments/assets/private-uuid-123') {
      return new Response(null, { status: 302, headers: { Location: 'https://github.com/login?return_to=...' } });
    }
    if (url === 'https://private-user-images.githubusercontent.com/999/private-uuid-123.png?jwt=signed-token-xyz&tag=&quot;&lt;1') {
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
    }
    if (url === 'https://github.com/user-attachments/assets/bad-redirect') {
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal.png' } });
    }
    if (url === 'https://github.com/user-attachments/assets/loop-redirect') {
      return new Response(null, { status: 302, headers: { Location: 'https://github.com/user-attachments/assets/loop-redirect' } });
    }
    if (url === 'https://github.com/user-attachments/assets/html-spoof') {
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url === 'https://github.com/user-attachments/assets/too-large-header') {
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(GITHUB_MEDIA_MAX_IMAGE_BYTES + 1) } });
    }
    if (url === 'https://github.com/user-attachments/assets/too-large-video-header') {
      return new Response(mp4, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(GITHUB_MEDIA_MAX_VIDEO_BYTES + 1) } });
    }
    if (url === 'https://github.com/user-attachments/assets/stream-overflow-png') {
      // Chunked stream (no Content-Length) that starts with valid PNG magic bytes then exceeds 20 MiB.
      const chunkSize = RUNNER_TRANSFER_CHUNK_BYTES;
      let sent = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (sent === 0) {
            const first = Buffer.alloc(chunkSize, 0x55);
            png.copy(first, 0);
            controller.enqueue(first);
            sent += first.length;
          } else if (sent <= GITHUB_MEDIA_MAX_IMAGE_BYTES) {
            controller.enqueue(Buffer.alloc(chunkSize, 0x55));
            sent += chunkSize;
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url === 'https://github.com/user-attachments/assets/multi-chunk-video') {
      // 2.5 MiB valid MP4 streamed in 512 KiB chunks.
      const total = Math.floor(2.5 * RUNNER_TRANSFER_CHUNK_BYTES);
      const full = Buffer.alloc(total, 0x33);
      mp4.copy(full, 0);
      let pos = 0;
      const step = 512 * 1024;
      const stream = new ReadableStream({
        pull(controller) {
          if (pos >= full.length) { controller.close(); return; }
          controller.enqueue(full.subarray(pos, Math.min(pos + step, full.length)));
          pos += step;
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
    }
    return new Response('not found', { status: 404 });
  };

  let scopes = ['issues', 'pull_requests'];
  const writeCalls = [];
  const tokens = new ReadTokens(f.h.store, repo, redactor, async () => {}, f.apiUrl, ['issues', 'pull_requests', 'contents'], () => scopes);
  t.after(() => tokens.revoke());
  const explorer = new RepositoryExplorer(tokens, redactor, async () => {}, undefined, {
    writeChunk: (targetPath, data, offset, final) => {
      writeCalls.push({ targetPath, bytes: data.length, offset, final });
      return workspace.writeMediaChunk(targetPath, data, offset, final);
    },
    truncate: targetPath => workspace.truncateMedia(targetPath),
    canWriteCheckout: () => false,
    fetchImpl: mockFetch,
    lookup: async () => dnsRecords,
  });

  // 1. Public attachment with 302 redirect to objects.githubusercontent.com; Authorization is never sent.
  const pubRes = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/public-uuid-1' });
  assert.equal(pubRes.source, 'github_download');
  assert.equal(pubRes.format, 'png');
  assert.equal(pubRes.size_bytes, png.length);
  assert.equal(pubRes.sha256, sha(png));
  assert.ok(fetchCalls.every(c => c.auth === null), 'Authorization header must never be sent to attachment/redirect hosts');
  assert.deepEqual(readFileSync(join(wsRoot, workspaceId, 'context', pubRes.path.slice('../context/'.length))), png);

  // 2. Private attachment redirecting to /login: without source_path returns github_media_auth_required;
  // with source_path resolves signed private-user-images URL via HTML API and downloads cleanly without auth header.
  const needAuth = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/private-uuid-123' });
  assert.equal(needAuth.error, 'github_media_auth_required');
  const privRes = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/private-uuid-123', source_path: '/issues/12' });
  assert.equal(privRes.source, 'github_download', JSON.stringify(privRes));
  assert.equal(privRes.format, 'png');
  assert.deepEqual(readFileSync(join(wsRoot, workspaceId, 'context', privRes.path.slice('../context/'.length))), png);
  assert.ok(apiHits.some(h => h.path === '/repos/fixture/project-101/issues/12' && h.accept.includes('html+json')));
  assert.ok(fetchCalls.every(c => c.auth === null));

  // 3. Current-repo raw.githubusercontent.com requires contents scope, then succeeds via Contents raw API.
  assert.equal((await explorer.execute('fetch_github_media', { url: 'https://raw.githubusercontent.com/fixture/project-101/main/docs/shot.png' })).error, 'github_resource_forbidden');
  scopes = ['issues', 'pull_requests', 'contents'];
  const rawRes = await explorer.execute('fetch_github_media', { url: 'https://raw.githubusercontent.com/fixture/project-101/main/docs/shot.png' });
  assert.equal(rawRes.source, 'github_download', JSON.stringify(rawRes));
  assert.equal(rawRes.format, 'png');
  assert.equal(rawRes.sha256, sha(png));

  // 4. Redirect & DNS SSRF defenses.
  assert.equal((await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/bad-redirect' })).error, 'github_media_redirect_forbidden');
  assert.equal((await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/loop-redirect' })).error, 'github_media_redirect_limit');
  dnsRecords = [{ address: '10.0.0.42', family: 4 }];
  assert.equal((await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/public-uuid-1' })).error, 'github_media_ssrf_blocked');
  dnsRecords = [{ address: '140.82.121.4', family: 4 }];

  // 5. Non-media SVG/HTML bytes rejected with zero workspace writes.
  const writesBeforeSpoof = writeCalls.length;
  assert.equal((await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/html-spoof' })).error, 'github_media_invalid_format');
  assert.equal(writeCalls.length, writesBeforeSpoof);

  // 6. F2: Content-Length pre-check (both 100 MiB video ceiling and 20 MiB image ceiling) rejects before writing byte 0.
  const writesBeforeOversize = writeCalls.length;
  const overImgHeader = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/too-large-header' });
  assert.equal(overImgHeader.error, 'github_media_too_large');
  assert.equal(overImgHeader.max_bytes, GITHUB_MEDIA_MAX_IMAGE_BYTES);
  assert.equal(overImgHeader.size_bytes, GITHUB_MEDIA_MAX_IMAGE_BYTES + 1);
  const overVidHeader = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/too-large-video-header' });
  assert.equal(overVidHeader.error, 'github_media_too_large');
  assert.equal(overVidHeader.max_bytes, GITHUB_MEDIA_MAX_VIDEO_BYTES);
  assert.equal(writeCalls.length, writesBeforeOversize, 'Content-Length overflow writes zero bytes');

  // 7. F2: Chunked mid-stream overflow > 20 MiB aborts stream, truncates partial file to 0 bytes, and uses bounded chunks.
  const overflowTarget = '../context/media/overflow-test.png';
  const writesBeforeStream = writeCalls.length;
  const streamOver = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/stream-overflow-png', path: overflowTarget });
  assert.equal(streamOver.error, 'github_media_too_large');
  assert.equal(streamOver.max_bytes, GITHUB_MEDIA_MAX_IMAGE_BYTES);
  assert.ok(streamOver.size_bytes > GITHUB_MEDIA_MAX_IMAGE_BYTES);
  const overflowWrites = writeCalls.slice(writesBeforeStream);
  assert.ok(overflowWrites.length >= 10, 'writes streamed incrementally in bounded chunks');
  assert.ok(overflowWrites.every(w => w.bytes <= RUNNER_TRANSFER_CHUNK_BYTES));
  assert.equal(statSync(join(wsRoot, workspaceId, 'context/media/overflow-test.png')).size, 0, 'partial file truncated on overflow');

  // 8. Multi-chunk 2.5 MiB MP4 streams across 3 chunks and matches exact SHA-256.
  const writesBeforeVideo = writeCalls.length;
  const vidRes = await explorer.execute('fetch_github_media', { url: 'https://github.com/user-attachments/assets/multi-chunk-video' });
  assert.equal(vidRes.source, 'github_download');
  assert.equal(vidRes.format, 'mp4');
  assert.equal(vidRes.size_bytes, Math.floor(2.5 * RUNNER_TRANSFER_CHUNK_BYTES));
  const savedVideo = readFileSync(join(wsRoot, workspaceId, 'context', vidRes.path.slice('../context/'.length)));
  assert.equal(savedVideo.length, vidRes.size_bytes);
  assert.equal(createHash('sha256').update(savedVideo).digest('hex'), vidRes.sha256);
  const videoChunkWrites = writeCalls.slice(writesBeforeVideo);
  assert.equal(videoChunkWrites.length, 3);
  assert.ok(videoChunkWrites.every(w => w.bytes <= RUNNER_TRANSFER_CHUNK_BYTES));

  // 9. Manager trajectory redaction strips base64 from workspace_context / workspace_write / workspace_artifact_stage.
  for (const type of ['workspace_context', 'workspace_write', 'workspace_artifact_stage']) {
    const cleaned = sanitizeTrajectoryInput({ request: { type, path: 'media/a.mp4', base64: 'AAAA'.repeat(100), offset: 0 } });
    assert.equal(cleaned.request.base64, '[redacted]', `${type} base64 must be redacted from manager trajectory`);
  }
});
