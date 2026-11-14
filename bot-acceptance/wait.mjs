#!/usr/bin/env node
// Blocks until the bot has finished reacting, so the test AI does not spend its own turns polling.
//
//   node bot-acceptance/wait.mjs --number 12            tasks for Issue/PR #12 have appeared and none is still queued or running
//   node bot-acceptance/wait.mjs --number 7 --allow-none   also settles when the bot never starts a task (e.g. a draft PR)
//   node bot-acceptance/wait.mjs --since 2026-11-14T08:00:00Z --kind development
//
// "Settled" means no matching task is queued or running and the matching tasks have not changed for --settle seconds
// (default 60: a review may still trigger a follow-up). Exit 0 when settled, 2 on --timeout (default 30 minutes);
// either way it prints one JSON summary of the matching tasks.
import { pathToFileURL } from 'node:url';
import { signedIn } from './lib/console.mjs';
import { stateDir } from './lib/state.mjs';

// The statuses the console counts as running and queued (src/app/project-activity.ts taskGroupSQL); a test keeps them equal.
export const BUSY = ['running', 'preparing', 'implementing', 'validating', 'publishing', 'result_ready', 'queued'];

export function parse(argv) {
  const options = { number: null, since: null, kind: null, allowNone: false, settleMs: 60_000, timeoutMs: 30 * 60_000, intervalMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${flag} needs a value`); return next; };
    if (flag === '--number') options.number = Number(value());
    else if (flag === '--since') options.since = new Date(value()).toISOString();
    else if (flag === '--kind') options.kind = value();
    else if (flag === '--allow-none') options.allowNone = true;
    else if (flag === '--settle') options.settleMs = Number(value()) * 1000;
    else if (flag === '--timeout') options.timeoutMs = Number(value()) * 60_000;
    else throw new Error(`unknown option ${flag}`);
  }
  if (options.number !== null && !Number.isSafeInteger(options.number)) throw new Error('--number must be an Issue or PR number');
  if (![options.settleMs, options.timeoutMs].every(Number.isFinite)) throw new Error('--settle and --timeout take numbers');
  return options;
}

/** The tasks a wait is about, newest first, in the compact shape the summary prints. */
export function matching(tasks, options) {
  return tasks.filter(task => (options.number === null || task.object_number === options.number)
    && (!options.kind || task.kind.startsWith(options.kind)) && (!options.since || task.created_at >= options.since))
    .map(task => ({ id: task.id, kind: task.kind, status: task.status, phase: task.phase, object_number: task.object_number,
      error_code: task.error_code, created_at: task.created_at, updated_at: task.updated_at, summary: task.result?.summary || task.summary,
      links: (task.result?.outputs || []).map(output => output?.html_url).filter(Boolean),
      tokens: task.metrics ? { input: task.metrics.input_tokens, output: task.metrics.output_tokens } : null }));
}

export async function waitFor(client, repositoryId, options, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const started = now(); let fingerprint = '', quietSince = null, tasks = [];
  for (;;) {
    const listed = [];
    // Newest first; three pages cover far more than one run creates.
    for (let offset = 0; offset < 300; offset += 100) {
      const page = (await client.request('GET', `/api/tasks?repository_id=${encodeURIComponent(repositoryId)}&limit=100&offset=${offset}`)).tasks;
      listed.push(...page); if (page.length < 100) break;
    }
    tasks = matching(listed, options);
    const idle = (tasks.length > 0 || options.allowNone) && !tasks.some(task => BUSY.includes(task.status));
    const current = JSON.stringify(tasks.map(task => [task.id, task.status]));
    if (!idle || current !== fingerprint) { fingerprint = current; quietSince = idle ? now() : null; }
    const waited = Math.round((now() - started) / 1000);
    if (quietSince !== null && now() - quietSince >= options.settleMs) return { settled: true, waited_seconds: waited, tasks };
    if (now() - started >= options.timeoutMs) return { settled: false, waited_seconds: waited, tasks };
    await sleep(options.intervalMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const options = parse(process.argv.slice(2)), { client, target } = await signedIn(stateDir(), 'operator');
    const result = await waitFor(client, target.repository.id, options);
    console.log(JSON.stringify(result, null, 2)); process.exit(result.settled ? 0 : 2);
  } catch (error) { console.error(error.message); process.exit(1); }
}
