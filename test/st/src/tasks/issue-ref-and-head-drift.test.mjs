import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { treeHash } from '../../../fixtures/agent-server.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';

const gitObjHash = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c_' + randomBytes(5).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function createMultiBranchGitHub() {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map(), tags = new Map();
  const state = { prs: [], comments: [], labels: new Map(), refWrites: [], nextPr: 20, nextComment: 100 };

  const putBlob = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const sha = gitObjHash('blob', bytes);
    blobs.set(sha, bytes);
    return { sha, size: bytes.length };
  };
  const putCommit = (filesMap, parent = null, message = 'commit') => {
    const entries = Object.entries(filesMap).map(([path, content]) => {
      const { sha, size } = putBlob(content);
      return { path, mode: '100644', type: 'blob', sha, size };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const treeSha = treeHash(entries);
    trees.set(treeSha, entries);
    const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ treeSha, parent, message, n: commits.size })));
    commits.set(sha, { sha, tree: { sha: treeSha }, parents: parent ? [{ sha: parent }] : [] });
    return sha;
  };

  const mainSha = putCommit({
    'app.txt': 'main-version\n',
    'AGENTS.md': 'TRUSTED_MAIN_AGENTS_1308\n',
    '.agents/skills/trusted-ops/SKILL.md': '---\nname: trusted-ops\ndescription: Trusted main skill.\n---\nTRUSTED_MAIN_SKILL_1308\n',
  }, null, 'main');
  const releaseSha = putCommit({
    'app.txt': 'release-v2-version\n',
    'AGENTS.md': 'UNTRUSTED_RELEASE_AGENTS_1308\n',
    '.agents/skills/evil-release/SKILL.md': '---\nname: evil-release\ndescription: Untrusted release skill.\n---\nUNTRUSTED_RELEASE_SKILL_1308\n',
  }, mainSha, 'release/v2');
  const tagSha = putCommit({
    'app.txt': 'tag-v1-version\n',
    'AGENTS.md': 'UNTRUSTED_TAG_AGENTS_1308\n',
  }, mainSha, 'v1.0.0');
  const existingPrHeadSha = putCommit({
    'app.txt': 'existing-bot-pr-head\n',
    'AGENTS.md': 'TRUSTED_MAIN_AGENTS_1308\n',
  }, releaseSha, 'existing bot pr');

  refs.set('main', mainSha);
  refs.set('release/v2', releaseSha);
  refs.set('bot/issue-9', existingPrHeadSha);
  // PR #100 claims this head, so the ref must really exist: a delivery that reuses it has to see the branch.
  refs.set('bot/issue-10', existingPrHeadSha);
  tags.set('v1.0.0', tagSha);

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://fixture');
    const path = decodeURIComponent(url.pathname);
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/repo', default_branch: 'main' });

    const repo = '/repos/fixture/repo';
    if (!path.startsWith(repo)) return send({ message: 'Not Found' }, 404);
    const sub = path.slice(repo.length);

    if (sub === '/labels' && req.method === 'GET') return send([]);
    if (sub === '/labels' && req.method === 'POST') return send(body, 201);
    if (sub.startsWith('/labels/') && req.method === 'GET') return send({ message: 'Not Found' }, 404);

    const issueMatch = /^\/issues\/(\d+)$/.exec(sub);
    if (issueMatch && req.method === 'GET') {
      const num = Number(issueMatch[1]);
      return send({ number: num, title: `Issue #${num} fix`, body: 'Fix app.txt on target branch', state: 'open', labels: [] });
    }
    const issueComments = /^\/issues\/(\d+)\/comments$/.exec(sub);
    if (issueComments) {
      if (req.method === 'GET') return send(state.comments.filter(c => c.issue === Number(issueComments[1])));
      const comment = { id: state.nextComment++, issue: Number(issueComments[1]), body: body.body, user: { id: 999 } };
      state.comments.push(comment);
      return send(comment, 201);
    }
    const editComment = /^\/issues\/comments\/(\d+)$/.exec(sub);
    if (editComment && req.method === 'PATCH') {
      const found = state.comments.find(c => c.id === Number(editComment[1]));
      if (!found) return send({ message: 'Not Found' }, 404);
      found.body = body.body;
      return send(found);
    }
    const issueLabels = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(sub);
    if (issueLabels) return send([]);

    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(sub);
    if (refMatch && req.method === 'GET') {
      const sha = refs.get(refMatch[1]);
      return sha ? send({ ref: 'refs/heads/' + refMatch[1], object: { sha } }) : send({ message: 'Not Found' }, 404);
    }
    if (sub === '/git/refs' && req.method === 'POST') {
      const name = String(body.ref || '').replace(/^refs\/heads\//, '');
      state.refWrites.push({ ref: body.ref, sha: body.sha, created: !refs.has(name) });
      // Real GitHub answers 422 instead of moving a branch that already exists.
      if (refs.has(name)) return send({ message: 'Reference already exists', documentation_url: 'https://docs.github.com/rest/git/refs#create-a-reference' }, 422);
      refs.set(name, body.sha);
      return send({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    const refPatch = /^\/git\/refs\/heads\/(.+)$/.exec(sub);
    if (refPatch && req.method === 'PATCH') {
      refs.set(refPatch[1], body.sha);
      state.refWrites.push({ ref: 'refs/heads/' + refPatch[1], sha: body.sha });
      return send({ ref: 'refs/heads/' + refPatch[1], object: { sha: body.sha } });
    }

    const commitMatch = /^\/git\/commits\/([a-f0-9]{40})$/.exec(sub);
    if (commitMatch && req.method === 'GET') {
      const c = commits.get(commitMatch[1]);
      return c ? send(c) : send({ message: 'Not Found' }, 404);
    }
    if (sub === '/git/commits' && req.method === 'POST') {
      const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ tree: body.tree, parents: body.parents, message: body.message, n: commits.size })));
      commits.set(sha, { sha, tree: { sha: body.tree }, parents: (body.parents || []).map(p => ({ sha: p })) });
      return send({ sha, tree: { sha: body.tree } }, 201);
    }

    const restCommitMatch = /^\/commits\/(.+)$/.exec(sub);
    if (restCommitMatch && req.method === 'GET') {
      const refName = restCommitMatch[1];
      const sha = commits.has(refName) ? refName : tags.get(refName) ?? refs.get(refName);
      return sha ? send({ sha }) : send({ message: 'Not Found' }, 404);
    }

    const treeMatch = /^\/git\/trees\/([a-f0-9]{40})$/.exec(sub);
    if (treeMatch && req.method === 'GET') {
      const entries = trees.get(treeMatch[1]);
      return entries ? send({ sha: treeMatch[1], tree: entries, truncated: false }) : send({ message: 'Not Found' }, 404);
    }
    if (sub === '/git/trees' && req.method === 'POST') {
      const baseEntries = body.base_tree ? [...(trees.get(body.base_tree) ?? [])] : [];
      const byPath = new Map(baseEntries.map(e => [e.path, e]));
      for (const item of body.tree ?? []) {
        if (item.sha === null) byPath.delete(item.path);
        else byPath.set(item.path, { path: item.path, mode: item.mode, type: 'blob', sha: item.sha, size: blobs.get(item.sha)?.length ?? 0 });
      }
      const nextEntries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
      const sha = treeHash(nextEntries);
      trees.set(sha, nextEntries);
      return send({ sha, tree: nextEntries }, 201);
    }

    const blobMatch = /^\/git\/blobs\/([a-f0-9]{40})$/.exec(sub);
    if (blobMatch && req.method === 'GET') {
      const data = blobs.get(blobMatch[1]);
      return data ? send({ encoding: 'base64', content: data.toString('base64'), size: data.length }) : send({ message: 'Not Found' }, 404);
    }
    if (sub === '/git/blobs' && req.method === 'POST') {
      const data = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const { sha } = putBlob(data);
      return send({ sha }, 201);
    }

    if (sub === '/pulls' && req.method === 'GET') {
      const head = url.searchParams.get('head');
      const filtered = head ? state.prs.filter(p => `fixture:${p.head.ref}` === head) : state.prs;
      return send(filtered);
    }
    if (sub === '/pulls' && req.method === 'POST') {
      const pr = {
        id: 1000 + state.nextPr,
        number: state.nextPr++,
        state: 'open',
        title: body.title,
        body: body.body,
        html_url: `https://github.invalid/fixture/repo/pull/${state.nextPr - 1}`,
        head: { ref: body.head, sha: refs.get(body.head), repo: { id: 101 } },
        base: { ref: body.base, sha: refs.get(body.base) },
        user: { id: 999 },
      };
      state.prs.push(pr);
      return send(pr, 201);
    }
    const prMatch = /^\/pulls\/(\d+)$/.exec(sub);
    if (prMatch && req.method === 'GET') {
      const pr = state.prs.find(p => p.number === Number(prMatch[1]));
      return pr ? send(pr) : send({ message: 'Not Found' }, 404);
    }
    if (prMatch && req.method === 'PATCH') {
      const pr = state.prs.find(p => p.number === Number(prMatch[1]));
      if (!pr) return send({ message: 'Not Found' }, 404);
      Object.assign(pr, body);
      return send(pr);
    }

    send({ message: `Unhandled ${req.method} ${sub}` }, 404);
  });

  return { server, state, shas: { mainSha, releaseSha, tagSha, existingPrHeadSha } };
}

test('Issue target.ref selects non-default base branch while keeping trusted skills from main, enforces ref validation, and preserves existing bot_pr precedence', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-issue-ref-1308-'));
  const store = new Store(':memory:', randomBytes(32));
  const computer = new LocalManager('101', root);
  const gh = createMultiBranchGitHub();
  gh.server.listen(0, '127.0.0.1');
  await once(gh.server, 'listening');
  const ghUrl = 'http://127.0.0.1:' + gh.server.address().port;

  let qaHandoff = null;
  let devPromptSeen = null;
  let driftRefusalSeen = null;
  let mode = 'release_with_drift';
  let driftedOnce = false;
  let restoredBase = false;

  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(x => x.function.name);
    const msgs = body.messages;
    const names = msgs.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(c => c.function.name);
    const toolMsgs = msgs.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return { raw: m.content }; } });
    let message;

    if (tools.includes('submit_acceptance')) {
      const qaPrompt = JSON.parse(msgs[1].content);
      qaHandoff = qaPrompt.delivery_handoff;
      message = call('submit_acceptance', { pass: true, issues: [] });
    } else if (mode === 'readonly_sha') {
      if (!names.includes('read_file')) {
        message = call('read_file', { path: 'app.txt' });
      } else {
        const fileContent = toolMsgs.find(r => typeof r.content === 'string')?.content ?? '';
        message = call('submit_report', { summary: `Checked out: ${fileContent.trim()}`, artifacts: [] });
      }
    } else if (mode === 'deliver') {
      if (!devPromptSeen) devPromptSeen = JSON.parse(msgs[1].content);
      if (!names.includes('run_command')) {
        message = call('run_command', { command: 'printf "issue-10-release-v2-fixed\\n" > app.txt' });
      } else {
        message = call('open_pull_request', { summary: 'Fix Issue #10 on release/v2', change_title: 'fix: issue 10 on release v2', artifacts: [{ path: 'app.txt', description: 'fixed app.txt' }] });
      }
    } else if (mode === 'existing_bot_pr') {
      devPromptSeen = JSON.parse(msgs[1].content);
      message = call('submit_report', { summary: `Base=${devPromptSeen.delivery_context.base_branch} Sha=${devPromptSeen.delivery_context.base_sha}`, artifacts: [] });
    } else {
      // mode === 'release_with_drift'
      if (!devPromptSeen) devPromptSeen = JSON.parse(msgs[1].content);
      if (!driftedOnce) {
        driftedOnce = true;
        // Simulate an agent erroneously switching HEAD to another commit inside the worktree!
        message = call('run_command', { command: 'git checkout -q -b rogue && printf "rogue\\n" > app.txt && git -c user.name=bot -c user.email=bot@example.invalid -c commit.gpgsign=false commit -qam rogue' });
      } else if (!names.includes('open_pull_request')) {
        message = call('open_pull_request', { summary: 'Attempt on drifted HEAD', change_title: 'fix: release v2', artifacts: [{ path: 'app.txt', description: 'updated' }] });
      } else if (!restoredBase) {
        restoredBase = true;
        driftRefusalSeen = msgs.filter(m => ['tool', 'user'].includes(m.role)).map(m => JSON.stringify(m.content)).find(s => s.includes('workspace_head_drifted'));
        // Restore HEAD back to the recorded initial commit (HEAD~1) and make a clean working-tree edit!
        message = call('run_command', { command: 'git checkout -q --detach HEAD~1 && printf "release-v2-fixed\\n" > app.txt' });
      } else {
        message = call('open_pull_request', { summary: 'Fixed app.txt on release/v2', change_title: 'fix: release v2', artifacts: [{ path: 'app.txt', description: 'fixed app.txt' }] });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');

  const engine = new TaskEngine(store, computer, ghUrl);
  t.after(async () => {
    await engine.close();
    await computer.recover();
    await new Promise(r => { model.close(r); model.closeAllConnections(); });
    await new Promise(r => { gh.server.close(r); gh.server.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'gh-token' }, 'account:a'), 'now');
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'model-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,'develop')");
  scriptedRoles(store, '101');

  const commands = new TaskCommands(store);
  const operator = { id: 'op', role: 'project_admin', repositories: ['101'] };
  const runTask = async body => {
    const id = commands.api(operator, 'POST', new URL('http://local/api/tasks'), { repository_id: '101', executor_role: 'dev', ...body }).id;
    store.run("UPDATE tasks SET status='running',claim_token='claim' WHERE id=?", id);
    store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", id);
    authorizeKnowledgeTask(store, id);
    await engine.run(id, 'claim').catch(() => {});
    return store.get('SELECT * FROM tasks WHERE id=?', id);
  };

  // 1. Issue target.ref = 'release/v2' + HEAD drift guardrail + QA delivery_handoff + trusted main skills boundary
  const t1 = await runTask({
    request: 'Fix app.txt on release/v2',
    target: { type: 'issue', number: 1, ref: 'release/v2' },
    writes: ['pull_request'],
    contract: { goal: 'Fix app.txt on release/v2', scope: ['app.txt'], criteria: ['app.txt fixed'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t1.status, 'pr_opened', JSON.stringify({ status: t1.status, error: t1.error_code, detail: t1.error_detail }));
  const t1Input = JSON.parse(t1.input);
  assert.equal(t1Input.base_branch, 'release/v2');
  assert.equal(t1Input.snapshot_sha, gh.shas.releaseSha);
  assert.equal(t1Input.checkout_trusted, false, 'non-default branch checkout must be marked untrusted');
  assert.match(t1Input.trusted_agents_md, /TRUSTED_MAIN_AGENTS_1308/, 'AGENTS.md must load strictly from trusted main');
  assert.doesNotMatch(t1Input.trusted_agents_md, /UNTRUSTED_RELEASE_AGENTS_1308/);
  assert.equal(devPromptSeen.delivery_context.base_branch, 'release/v2');
  assert.equal(devPromptSeen.delivery_context.base_sha, gh.shas.releaseSha);
  assert.ok(driftRefusalSeen, 'open_pull_request must reject drifted HEAD in-turn with workspace_head_drifted');
  assert.equal(gh.state.prs.length, 1);
  assert.equal(gh.state.prs[0].base.ref, 'release/v2', 'PR base must target release/v2');
  assert.equal(qaHandoff.intended_delivery, 'pull_request');
  assert.equal(qaHandoff.actual_delivery, 'pull_request');
  assert.equal(qaHandoff.baseline.base_branch, 'release/v2');
  assert.equal(qaHandoff.baseline.head_matches_baseline, true);
  assert.deepEqual(qaHandoff.changes.modified, ['app.txt']);
  const issue1Progress = gh.state.comments.find(c => c.issue === 1);
  assert.ok(issue1Progress && /\*\*Base branch\*\*: `release\/v2`/.test(issue1Progress.body), 'Issue progress comment shows non-default base branch');

  // 2. Non-existent branch ref on Issue fails explicitly with target_branch_not_found (no silent fallback to main!)
  const t2 = await runTask({
    request: 'Fix on missing branch',
    target: { type: 'issue', number: 2, ref: 'release/does-not-exist' },
    writes: ['pull_request'],
    contract: { goal: 'Fix', scope: ['app.txt'], criteria: ['ok'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t2.status, 'waiting_configuration');
  assert.equal(t2.error_code, 'target_branch_not_found');

  // 3. Bare commit SHA or tag on Issue with pull_request write fails with target_ref_not_branch
  const t3Sha = await runTask({
    request: 'Develop on bare SHA',
    target: { type: 'issue', number: 3, ref: gh.shas.tagSha },
    writes: ['pull_request'],
    contract: { goal: 'Fix', scope: ['app.txt'], criteria: ['ok'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t3Sha.status, 'waiting_configuration');
  assert.equal(t3Sha.error_code, 'target_ref_not_branch');

  const t3Tag = await runTask({
    request: 'Develop on tag',
    target: { type: 'issue', number: 4, ref: 'v1.0.0' },
    writes: ['pull_request'],
    contract: { goal: 'Fix', scope: ['app.txt'], criteria: ['ok'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t3Tag.status, 'waiting_configuration');
  assert.equal(t3Tag.error_code, 'target_ref_not_branch');

  // 4. Bare commit SHA on Issue WITHOUT pull_request write (read-only/report) succeeds!
  mode = 'readonly_sha';
  const t4 = await runTask({
    request: 'Diagnose tag commit',
    target: { type: 'issue', number: 5, ref: gh.shas.tagSha },
    writes: [],
    contract: { goal: 'Diagnose', scope: ['app.txt'], criteria: ['reported'], endpoint: 'report' },
  });
  assert.equal(t4.status, 'completed', JSON.stringify({ status: t4.status, error: t4.error_code, detail: t4.error_detail }));
  assert.match(JSON.parse(t4.result).summary, /tag-v1-version/);

  // 5. With no branch named, an existing open bot_pr on the Issue is still continued (#1314 keeps this unchanged)
  mode = 'existing_bot_pr';
  devPromptSeen = null;
  gh.state.prs.push({
    id: 9009,
    number: 99,
    state: 'open',
    title: 'Existing Bot PR',
    body: 'Existing',
    html_url: 'https://github.invalid/fixture/repo/pull/99',
    head: { ref: 'bot/issue-9', sha: gh.shas.existingPrHeadSha, repo: { id: 101 } },
    base: { ref: 'release/v2', sha: gh.shas.releaseSha },
    user: { id: 999 },
  });
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES('prev-issue-9','101','task.request','pr_opened','prev',?,9,'2026-01-01','2026-01-01')",
    JSON.stringify({ target: { type: 'issue', number: 9 } }),
  );
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('101',99,'9009','999','101','bot/issue-9',?,'prev-issue-9')",
    gh.shas.existingPrHeadSha,
  );
  const t5 = await runTask({
    request: 'Continue Issue #9',
    target: { type: 'issue', number: 9 },
    writes: ['pull_request'],
    contract: { goal: 'Continue', scope: ['app.txt'], criteria: ['ok'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t5.status, 'completed', JSON.stringify({ status: t5.status, error: t5.error_code, detail: t5.error_detail }));
  assert.equal(JSON.parse(t5.input).base_branch, 'release/v2', 'an existing open bot_pr is continued when the task names no branch');
  assert.equal(JSON.parse(t5.input).snapshot_sha, gh.shas.existingPrHeadSha, 'existing open bot_pr head.sha takes precedence');
  assert.equal(devPromptSeen.delivery_context.pr_number, 99);

  // 6. An explicit branch on the Issue wins over an existing open bot_pr on another branch (#1314, #290 gap 2)
  //    and really delivers: a PR is opened on release/v2 from a per-baseline branch, PR #100 keeps its base/head.
  mode = 'deliver';
  devPromptSeen = null;
  const prsBefore = gh.state.prs.length;
  gh.state.prs.push({
    id: 9010,
    number: 100,
    state: 'open',
    title: 'Existing main PR',
    body: 'Existing',
    html_url: 'https://github.invalid/fixture/repo/pull/100',
    head: { ref: 'bot/issue-10', sha: gh.shas.existingPrHeadSha, repo: { id: 101 } },
    base: { ref: 'main', sha: gh.shas.mainSha },
    user: { id: 999 },
  });
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES('prev-issue-10','101','task.request','pr_opened','prev',?,10,'2026-01-01','2026-01-01')",
    JSON.stringify({ target: { type: 'issue', number: 10 } }),
  );
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('101',100,'9010','999','101','bot/issue-10',?,'prev-issue-10')",
    gh.shas.existingPrHeadSha,
  );
  store.run(
    "INSERT INTO bot_branches(repository_id,branch,task_id) VALUES('101','bot/issue-10','prev-issue-10')",
  );
  const t6 = await runTask({
    request: 'Fix Issue #10 on release/v2',
    target: { type: 'issue', number: 10, ref: 'refs/heads/release/v2' },
    writes: ['pull_request'],
    contract: { goal: 'Fix on release/v2', scope: ['app.txt'], criteria: ['ok'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t6.status, 'pr_opened', JSON.stringify({ status: t6.status, error: t6.error_code, detail: t6.error_detail }));
  const t6Input = JSON.parse(t6.input);
  assert.equal(t6Input.base_branch, 'release/v2', 'the branch the task names wins over the existing PR base');
  assert.equal(t6Input.snapshot_sha, gh.shas.releaseSha);
  assert.equal(devPromptSeen.delivery_context.base_branch, 'release/v2');
  assert.equal(devPromptSeen.delivery_context.pr_number, undefined, 'the default-branch PR is not taken over');
  const opened = gh.state.prs.slice(prsBefore).filter(p => p.number !== 100);
  assert.equal(opened.length, 1, 'exactly one new PR is opened on the named baseline');
  assert.equal(opened[0].base.ref, 'release/v2', 'the new PR targets release/v2');
  assert.equal(opened[0].head.ref, 'bot/issue-10-release-v2', 'the publication branch is derived from the baseline, not the branch PR #100 owns');
  const unchanged = gh.state.prs.find(p => p.number === 100);
  assert.equal(unchanged.base.ref, 'main', 'PR #100 keeps its base');
  assert.equal(unchanged.head.ref, 'bot/issue-10', 'PR #100 keeps its head branch');
  assert.equal(unchanged.head.sha, gh.shas.existingPrHeadSha, 'PR #100 keeps its head commit');
  assert.equal(gh.state.refWrites.some(w => w.ref === 'refs/heads/bot/issue-10'), false, 'the branch PR #100 owns is never moved');
  assert.ok(gh.state.refWrites.some(w => w.ref === 'refs/heads/bot/issue-10-release-v2' && w.created), 'the per-baseline branch is created');

  // 7. Naming the branch the existing PR already targets still reuses that PR (the `===` arm of the gate).
  mode = 'existing_bot_pr';
  devPromptSeen = null;
  gh.state.prs.push({
    id: 9011,
    number: 101,
    state: 'open',
    title: 'Existing main PR for #11',
    body: 'Existing',
    html_url: 'https://github.invalid/fixture/repo/pull/101',
    head: { ref: 'bot/issue-11', sha: gh.shas.existingPrHeadSha, repo: { id: 101 } },
    base: { ref: 'main', sha: gh.shas.mainSha },
    user: { id: 999 },
  });
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES('prev-issue-11','101','task.request','pr_opened','prev',?,11,'2026-01-01','2026-01-01')",
    JSON.stringify({ target: { type: 'issue', number: 11 } }),
  );
  store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('101',101,'9011','999','101','bot/issue-11',?,'prev-issue-11')",
    gh.shas.existingPrHeadSha,
  );
  const t7 = await runTask({
    request: 'Continue Issue #11 on the branch it already targets',
    target: { type: 'issue', number: 11, ref: 'refs/heads/main' },
    writes: ['pull_request'],
    contract: { goal: 'Continue on main', scope: ['app.txt'], criteria: ['ok'], endpoint: 'reviewable_pull_request' },
  });
  assert.equal(t7.status, 'completed', JSON.stringify({ status: t7.status, error: t7.error_code, detail: t7.error_detail }));
  const t7Input = JSON.parse(t7.input);
  assert.equal(t7Input.base_branch, 'main');
  assert.equal(t7Input.snapshot_sha, gh.shas.existingPrHeadSha, 'the named branch equals the PR base, so its head is checked out');
  assert.equal(devPromptSeen.delivery_context.pr_number, 101, 'an open PR on the named branch is still reused');
  assert.equal(devPromptSeen.delivery_context.base_branch, 'main');
});
