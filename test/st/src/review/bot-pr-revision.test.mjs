import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRepositoryFixture } from '../../../fixtures/empty-repository-helpers.mjs';

// A revision of the bot's own pull request that people asked for (#1104), through the real engine: it carries their comments
// instead of review findings, and answers them on the pull request even when it changes nothing.
const commit = 'a'.repeat(40);
const pull = { id: 123, number: 1, state: 'open', draft: false, title: 'Fix the parser', body: 'Fixes the parser.', user: { id: 999 },
  head: { sha: commit, ref: 'bot/issue-9-source', repo: { id: 101 } }, base: { ref: 'main' }, html_url: 'https://github.invalid/pull/1' };
const request = { type: 'comment', id: '301', author: 'alice', author_id: '5', author_type: 'User', url: 'https://github.invalid/pull/1#issuecomment-301',
  body: 'Why does parse() reject an empty line?' };

test('a revision people asked for runs without review findings, sees their comments and answers them when nothing changed', async t => {
  const config = [];
  const h = await emptyRepositoryFixture(t, { taskKind: 'development.pr',
    github(path, send) { if (path.endsWith('/pulls/1')) { send(pull); return true; } if (/\/pulls\/1\/(files|reviews|comments)$/.test(path)) { send([]); return true; } },
    execute(request) {
      if (request.type === 'workspace_agent_config') config.push(Buffer.from(request.base64, 'base64'));
      if (request.type === 'workspace_agent_start') return { ok: true, result: { started: true } };
      if (request.type === 'workspace_agent_poll') {
        // The revision decides the comment is a question: it answers in its summary and leaves the tree unchanged.
        if (!h.answered) { h.answered = true; return { ok: true, result: { state: 'running', tool_requests: [{ id: 'd'.repeat(48), kind: 'pull_request', name: 'create_pull_request',
          arguments: { summary: 'An empty line ends the record by design (README, "Records"); no change.', test_command: 'node --test' } }] } }; }
        return { ok: true, result: { state: 'completed', result: { summary: 'Answered.' } } };
      }
      if (request.type === 'workspace_finalize') return { ok: true, result: { tree_sha: 'b'.repeat(40), files: [] } };
    } });
  h.setBranch('ready');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('source','101','development.issue','pr_opened','source',?,9)",
    JSON.stringify({ manager: { brief: { goal: 'Keep the last line of CRLF files.' } } }));
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',1,'123','999','101','bot/issue-9-source',?,'source',0)", commit);
  // What the Manager created from the comment: no review findings, only the request it quotes.
  h.store.run('UPDATE tasks SET input=?,head_sha=? WHERE id=?', JSON.stringify({ revision: { source: 'request', requests: [request] } }), commit, h.taskId);
  const task = await h.run();
  const logs = h.store.all('SELECT content FROM task_logs WHERE task_id=?', h.taskId).map(row => row.content);
  assert.ok(['completed', 'succeeded'].includes(task.status), JSON.stringify([task.status, task.error_code, logs.slice(-3)]));
  assert.ok(!logs.some(line => /revision_scope_unconfirmed/.test(line)));
  // The revision's context carries the comment with its author, and the goal of the development that opened the pull request.
  const prompt = JSON.parse(JSON.parse(Buffer.concat(config).toString()).prompt);
  assert.deepEqual(prompt.revision_requests.map(r => [r.author, r.body]), [['alice', request.body]]);
  assert.equal(prompt.implementation_goal, 'Keep the last line of CRLF files.');
  assert.deepEqual(prompt.actionable_findings, []);
  // The answer reaches the person on the pull request (the fixture serves the conversation of #1).
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0].body, /^Answering @alice \(https:\/\/github\.invalid\/pull\/1#issuecomment-301\): no code change\.\n\nAn empty line ends the record by design/);
});
