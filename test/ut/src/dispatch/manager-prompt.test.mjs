// #1123: the built-in Manager prompt is six scenario chapters, each one sentence, one flowchart and three to five
// boundary rules, so the console's reading view shows how the bot works and the assistant can redraw one chapter at a
// time. The rules the Manager already followed must survive the regrouping word for word where something quotes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../../../../docs/prompts/manager-dispatch.md', import.meta.url), 'utf8');
const chapters = text.split(/^## /m).slice(1).map(chunk => {
  const [title, ...rest] = chunk.split('\n'), body = rest.join('\n').split(/^### /m)[0];
  return { title, body, blocks: body.match(/^```mermaid\n[\s\S]*?^```$/gm) ?? [], rules: body.match(/^- /gm)?.length ?? 0 };
});

test('the built-in Manager prompt is six scenario chapters of one sentence, one flowchart and three to five rules', () => {
  assert.match(text, /^# Event dispatch\n/);
  assert.deepEqual(chapters.map(chapter => chapter.title), [
    '1. Repository Q&A and research（代码仓问答与调研）',
    '2. Issue and PR daily management（Issue/PR 日常管理）',
    '3. Issue and PR review（Issue/PR 检视）',
    '4. Feature development and bug fixes（特性开发与缺陷修复）',
    '5. Branch and PR testing（分支/PR 自主测试）',
    '6. CI failures and scheduled checks（CI 失败与定时主动发现）',
  ]);
  for (const chapter of chapters) {
    const lead = chapter.body.trim().split('\n\n')[0];
    assert.match(lead, /^[A-Z][^\n]*\.$/, chapter.title + ': opens with one sentence');
    assert.equal(lead.split(/\.\s/).length, 1, chapter.title + ': the capability is a single sentence');
    assert.equal(chapter.blocks.length, 1, chapter.title + ': one flowchart');
    assert.match(chapter.blocks[0], /^```mermaid\nflowchart TD\n/, chapter.title);
    assert.ok(chapter.rules >= 3 && chapter.rules <= 5, `${chapter.title}: ${chapter.rules} rules`);
  }
});

test('the regrouped prompt keeps the rules other code and older tasks rely on', () => {
  const flat = text.replace(/\s+/g, ' ');
  // A project_rule basis quotes this sentence exactly; tasks started on it name it in their basis.
  assert.match(flat, /This is a project rule: The bot may develop an Issue on its own when the latest published review concludes ready_for_development, confirmed the problem, recommends a bounded change that is clearly better than the alternatives, leaves no question for a person and finds no conflict with an existing feature, and nobody else has claimed the Issue\./);
  assert.match(text, /^### Starting development$/m);
  for (const rule of [
    "Merging follows the project's auto-merge policy in the fixed tool rules",
    "`dev` never merges the pull request it delivers",
    'choose only labels that already exist in the repository, never create, rename or invent one',
    'A standing rule never starts development.',
    "The bot's own pull requests and its own pushes do not come here",
    'when someone else has claimed the Issue (unless handed over by label or maintainer request)',
    'when another review bot keeps asking after the bot already revised for it and no person joined, answer it instead of revising again',
    'respect `file_issues` on scheduled checks',
  ]) assert.ok(flat.includes(rule), rule);
});

test('every pull_request development goes to the Task Manager team and open bot PRs continue the same task across rounds (#1250, #1331)', () => {
  const flat = text.replace(/\s+/g, ' ');
  assert.ok(flat.includes("Every `pull_request` development task goes to the Task Manager's team: `create_task` without `role`, and the Task Manager runs `dev`, an independent `reviewer` and, when behaviour changes, `test` before QA (skipping observers only for trivial wording, comment or docs edits with `checks_note`), since nobody reviews the bot's pull request after it opens."));
  assert.ok(flat.includes("nobody reviews them once they open, so their development reviews them first (scenario 4)."));
  assert.ok(flat.includes('(`role` omitted: the Task Manager runs the team, mandatory for every `pull_request` development task)'));
  assert.ok(flat.includes('each open bot PR is one continuous multi-round development task: prioritize `continue_task` on its resumable task in `work.continue`'));
  const flow = chapters.find(chapter => chapter.title.startsWith('4.')).blocks[0];
  assert.match(flow, /basis -->\|是\| team\["Task Manager 团队开发：<br>dev 实现，按需派<br>独立 reviewer \/ test"\]/);
  assert.match(flow, /talk -->\|续接同一任务下一轮\| pr/);
});

test('built-in Manager prompt defines internal pull_request.patrol boundaries and re-evaluation on environment changes (#1316)', () => {
  const flat = text.replace(/\s+/g, ' ');
  for (const phrase of [
    'pull_request.patrol',
    'never trigger external chat notifications',
    'facts.changes_since_last_check',
    'facts.environment_changes',
    'workflow_changes_not_confirmed',
    'unresolved `CHANGES_REQUESTED`',
    '`ignore_event` silently without commenting',
    'post one concise comment on the PR explaining the background and recommending closure only if you have not already explained it',
  ]) {
    assert.ok(flat.includes(phrase), `missing patrol contract phrase: ${phrase}`);
  }
});
