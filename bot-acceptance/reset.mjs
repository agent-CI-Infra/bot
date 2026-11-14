#!/usr/bin/env node
// Resets the acceptance fixture repository to its seed before a run (playbook section 4). Run it before the App's webhook
// points at the new instance, so the closes and pushes here do not become tasks of the run.
//
//   ACCEPTANCE_GITHUB_TOKEN   the tester's token (Administration, Contents, Issues, Pull requests, Workflows write)
//   ACCEPTANCE_GITHUB_API_URL default https://api.github.com
//   node bot-acceptance/reset.mjs [--dry-run]
//
// It only ever touches the fixture: the repository name is fixed here, not taken from the environment.
import { pathToFileURL } from 'node:url';
import { GitHub } from './lib/github.mjs';
import { stateDir, writeJson } from './lib/state.mjs';
import { FIXTURE } from './bootstrap.mjs';

const NOTE = 'Closed by the acceptance reset.';
const ref = name => name.split('/').map(encodeURIComponent).join('/');

export async function resetFixture(github, { dryRun = false, log = message => console.error(message) } = {}) {
  const repo = `/repos/${FIXTURE}`, act = async (label, run) => { log(`${dryRun ? 'would ' : ''}${label}`); if (!dryRun) await run(); };
  const result = { repository: FIXTURE, rulesets: [], pulls: [], issues: [], branches: [] };

  // Rulesets and classic protection first: a merge queue rule blocks the force push below.
  for (const ruleset of await github.request('GET', `${repo}/rulesets?includes_parents=false`)) {
    result.rulesets.push(ruleset.name);
    await act(`delete ruleset ${ruleset.name}`, () => github.request('DELETE', `${repo}/rulesets/${ruleset.id}`));
  }
  const protection = await github.request('GET', `${repo}/branches/main/protection`).catch(error => { if (error.status === 404) return null; throw error; });
  if (protection) await act('remove classic protection of main', () => github.request('DELETE', `${repo}/branches/main/protection`));

  // Pull requests before branches, so closing them does not race their head branch disappearing.
  for (const pull of await github.all(`${repo}/pulls?state=open`)) {
    result.pulls.push(pull.number);
    await act(`close pull request #${pull.number}`, async () => {
      await github.request('POST', `${repo}/issues/${pull.number}/comments`, { body: NOTE });
      await github.request('PATCH', `${repo}/pulls/${pull.number}`, { state: 'closed' });
    });
  }
  for (const issue of await github.all(`${repo}/issues?state=open`)) {
    if (issue.pull_request) continue;
    result.issues.push(issue.number);
    await act(`close issue #${issue.number}`, async () => {
      await github.request('POST', `${repo}/issues/${issue.number}/comments`, { body: NOTE });
      await github.request('PATCH', `${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'not_planned' });
    });
  }
  for (const branch of await github.all(`${repo}/branches`)) {
    if (branch.name === 'main') continue;
    result.branches.push(branch.name);
    await act(`delete branch ${branch.name}`, () => github.request('DELETE', `${repo}/git/refs/heads/${ref(branch.name)}`));
  }

  // main goes back to the seed commit. Tags and releases stay: release versions are never reused (playbook section 4).
  const tag = await github.request('GET', `${repo}/git/ref/tags/seed`);
  const seed = tag.object.type === 'tag' ? (await github.request('GET', `${repo}/git/tags/${tag.object.sha}`)).object.sha : tag.object.sha;
  await act(`force main to seed ${seed.slice(0, 12)}`, () => github.request('PATCH', `${repo}/git/refs/heads/main`, { sha: seed, force: true }));
  return { ...result, seed_sha: seed, reset_at: new Date().toISOString(), dry_run: dryRun };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const github = new GitHub(process.env.ACCEPTANCE_GITHUB_TOKEN, { apiUrl: process.env.ACCEPTANCE_GITHUB_API_URL || undefined });
    const dryRun = process.argv.includes('--dry-run'), result = await resetFixture(github, { dryRun });
    if (!dryRun) writeJson(stateDir(), 'fixture.json', result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`reset failed: ${error.message}`); process.exit(1); }
}
