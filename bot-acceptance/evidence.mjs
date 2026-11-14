#!/usr/bin/env node
// Copies what the bot recorded during the run into <state>/evidence/ for the report and the uploaded artifact: version,
// the project row, every task with its detail and public log, webhook deliveries and costs. It signs in as the super
// administrator bootstrap created, so it works even when the operator account was never made.
//
//   node bot-acceptance/evidence.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signedIn } from './lib/console.mjs';
import { stateDir, writeJson } from './lib/state.mjs';

export async function collect(dir = stateDir(), { log = message => console.error(message) } = {}) {
  const { client, target } = await signedIn(dir, 'admin'), out = join(dir, 'evidence'), repo = target.repository?.id;
  mkdirSync(join(out, 'tasks'), { recursive: true });
  // One failed read must not lose the rest of the evidence; it is recorded instead.
  const errors = [], read = async (path, fallback = null) => {
    try { return await client.request('GET', path); } catch (error) { errors.push(error.message); return fallback; }
  };
  writeJson(out, 'version.json', await read('/api/version'));
  writeJson(out, 'onboarding.json', await read('/api/onboarding'));
  if (!repo) { writeJson(out, 'errors.json', [...errors, 'bootstrap never started the project']); return { tasks: 0, errors: errors.length + 1 }; }
  writeJson(out, 'installation.json', (await read(`/api/installations?repository_id=${repo}`))?.repositories ?? null);
  writeJson(out, 'policy.json', await read(`/api/repositories/${repo}/policy`));
  const tasks = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await read(`/api/tasks?repository_id=${repo}&limit=100&offset=${offset}`))?.tasks ?? [];
    tasks.push(...page); if (page.length < 100) break;
  }
  writeJson(out, 'tasks.json', tasks);
  for (const task of tasks) {
    writeJson(join(out, 'tasks'), `${task.id}.json`, await read(`/api/tasks/${task.id}`));
    // The log API pages backwards from the newest entry; keep paging until the first one.
    const logs = []; let before = null;
    for (let page = 0; page < 50; page++) {
      const result = await read(`/api/tasks/${task.id}/logs?limit=100${before === null ? '' : `&before=${before}`}`);
      if (!result) break;
      logs.unshift(...(result.logs || []));
      if (!result.log_page?.has_older) break;
      before = result.log_page.first_sequence;
    }
    writeJson(join(out, 'tasks'), `${task.id}.logs.json`, logs);
  }
  writeJson(out, 'events.json', (await read(`/api/events?repository_id=${repo}&limit=100`))?.events ?? null);
  writeJson(out, 'costs.json', await read('/api/costs?timezone=UTC'));
  writeJson(out, 'errors.json', errors);
  log(`evidence: ${tasks.length} tasks, ${errors.length} read errors -> ${out}`);
  return { tasks: tasks.length, errors: errors.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify(await collect())); }
  catch (error) { console.error(`evidence failed: ${error.message}`); process.exit(1); }
}
