import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #1106: a review task's goal quotes the pull request body. The task view kept it on one line and showed the bot's hidden
// `<!-- dept-bot:… -->` marker, which GitHub never shows. The goal now keeps its line breaks and leaves HTML comments out.
const scripts = ['static/app/state.js', 'static/app/api.js', 'static/views/status-text.js', 'static/views/widgets.js', 'static/views/task-session.js'];

test('#1106: the task goal keeps its line breaks and leaves out HTML comments such as the bot markers', () => {
  const page = loadConsole(scripts, async () => [200, {}]);
  const goal = 'review.pr: Fix add. Requested result: ## What changed\n\nAdd rejects negatives.   \n\n\n\n### Tests\n\n```\nnpm test\n```\n\n<!-- dept-bot:'
    + 'a'.repeat(48) + ' -->\n\n<!-- dept-bot:' + 'b'.repeat(48) + ' -->';
  page.run(`renderTaskSummaryBody({ id: 't', status: 'running', summary: 'Fix add', structured: { contract: { goal: ${JSON.stringify(goal)}, criteria: [] } } }, {})`);
  const [label, text] = page.$('task-goal-box').children[0].children;
  assert.equal(label.textContent, '任务目标：');
  // The span is the one styled white-space: pre-wrap (static/views.css), so the breaks show as written.
  assert.equal(text.className, 'task-goal-text');
  assert.equal(text.textContent, 'review.pr: Fix add. Requested result: ## What changed\n\nAdd rejects negatives.\n\n### Tests\n\n```\nnpm test\n```');
  // A comment the stored goal cut off ends the text; a goal that is only a comment falls back to the task's own label.
  assert.equal(page.run(`goalText('Body\\n<!-- dept-bot:abc')`), 'Body');
  assert.equal(page.run(`goalText('<!-- dept-bot:abc -->')`), '');
  assert.equal(page.run(`goalText('a <b> c')`), 'a <b> c');
});
