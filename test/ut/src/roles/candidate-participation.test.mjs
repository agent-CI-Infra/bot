// #1250: the bot's pull request is not reviewed again once it opens (#1107), so code changes default to the Task Manager's
// team with an independent review before QA. Built-in guidance says so; the facts below show who produced results for
// the candidate. Neither is a gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { traceEvent } from '../../../../dist/tasks/trace.js';
import { candidateParticipation, acceptanceParticipation } from '../../../../dist/roles/participation.js';
import { rolePrompts, dispatchInstructions } from '../../../../dist/roles/pool.js';
import { nominationSchema } from '../../../../dist/roles/catalog.js';

function fixture(t) {
  const s = new Store(':memory:', Buffer.alloc(32, 9)); t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')"); s.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','t','{}')");
  const result = role => traceEvent(s, 't', 'role_result', { role, result: { summary: role } });
  return { s, result };
}

test('a dev result nobody else inspected is "dev only", and a later reviewer or test inspected that candidate', t => {
  const { s, result } = fixture(t);
  assert.equal(candidateParticipation(s, 't'), undefined, 'no role results, no facts');
  const dev = result('dev');
  assert.deepEqual(candidateParticipation(s, 't'), { candidate_ref: dev, dev_results: 1, inspected_by: [], earlier_candidates_only: [],
    summary: 'dev only: no independent role inspected this candidate' });
  const review = result('reviewer'); result('manager'); result('qa');
  const test = result('test');
  const facts = candidateParticipation(s, 't');
  assert.deepEqual(facts.inspected_by, [{ role: 'reviewer', ref: review }, { role: 'test', ref: test }]);
  assert.equal(facts.summary, 'dev, then reviewer and test on this candidate');
});

test('a review of an earlier candidate does not count for the revised one; results without dev are named as such', t => {
  const { s, result } = fixture(t);
  result('reviewer');
  assert.equal(candidateParticipation(s, 't').summary, 'no dev result in this task; results from reviewer');
  result('dev'); result('reviewer'); const revised = result('dev');
  const facts = candidateParticipation(s, 't');
  assert.equal(facts.candidate_ref, revised); assert.equal(facts.dev_results, 2);
  assert.deepEqual(facts.earlier_candidates_only, ['reviewer']);
  assert.equal(facts.summary, 'dev only on this candidate: reviewer inspected an earlier candidate, not this one');
});

test('QA sees what the Manager nominated with and its note, until a newer worker result replaces that candidate', t => {
  const { s, result } = fixture(t);
  result('dev');
  assert.equal(acceptanceParticipation(s, 't').summary, 'dev only: no independent role inspected this candidate', 'a single executing role has no nomination');
  traceEvent(s, 't', 'delivery_nominated', { candidate_participation: candidateParticipation(s, 't'), checks_note: 'Wording-only change.' });
  result('manager');
  assert.deepEqual([acceptanceParticipation(s, 't').summary, acceptanceParticipation(s, 't').checks_note], ['dev only: no independent role inspected this candidate', 'Wording-only change.']);
  result('reviewer');
  assert.equal(acceptanceParticipation(s, 't').checks_note, undefined, 'the note belonged to the nomination before this result');
  assert.equal(acceptanceParticipation(s, 't').summary, 'dev, then reviewer on this candidate');
});

test('built-in guidance sends code changes through the team with an independent review and says why', () => {
  const manager = rolePrompts.manager.replace(/\s+/g, ' ');
  assert.ok(manager.includes("For a code change, delegate an independent `reviewer` on the dev candidate before `nominate_delivery`, and add `test` when behaviour changes and the developer's tests do not independently cover it; skip them only for a trivial change such as wording, comments or docs, and say why in `checks_note`."));
  assert.ok(manager.includes("After `open_pull_request` the platform does not review the bot's pull request again, so this review and QA are the only independent checks before a person looks."));
  assert.ok(manager.includes('`candidate_participation` lists which roles produced results for the current candidate.'));
  // Dynamic coordination stays: no fixed stage list is introduced.
  assert.ok(manager.includes('Dynamically coordinate without rigid stage gates.'));
  assert.ok(manager.includes('On round 2+ of a continuous PR task (`continuation.mode === "pull_request_development"`), delegate the original `dev` instance first'));
  assert.ok(dispatchInstructions.includes("Every verified pull_request development task goes to the Task Manager's team: omit the role"));
  assert.ok(dispatchInstructions.includes('On an open bot PR, prefer continue_task on its resumable task in work.continue'));
  assert.ok(!dispatchInstructions.includes('dev for verified development'));
  assert.match(nominationSchema.properties.checks_note.description, /^Optional, not published\. When no independent reviewer \(or test, where behaviour changed\) inspected this code candidate, say why that is enough/);
  assert.deepEqual(nominationSchema.required, ['result_ref']);
});
