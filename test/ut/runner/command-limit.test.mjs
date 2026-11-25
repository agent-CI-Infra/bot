import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../../../runner/command.mjs';
import { INLINE_ARGV_COMMAND_LIMIT, commandLimit, runnerRequestLimit } from '../../../runner/command-policy.mjs';
import { commandTool } from '../../../dist/agent/command.js';

// Commands up to 1 MiB are accepted by the runner; commands above INLINE_ARGV_COMMAND_LIMIT (64 KiB) execute via a
// private temporary script file so Linux's 128 KiB MAX_ARG_STRLEN never rejects `/bin/sh -c`. Over-limit commands are
// refused by name with both numbers.
const limit = commandLimit;
const head = 'printf ok # ';
const singleLine = bytes => { assert.ok(bytes > head.length); return head + 'x'.repeat(bytes - head.length); };
const runner = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runner', 'runner.mjs');
const directory = () => mkdtempSync(join(tmpdir(), 'command-limit-'));

// The real runner under local execution via `--stdin`: what LocalManager and the daemon executor deliver.
function run(value, workspace) {
  // A per-call id: a repeated id makes the runner replay its journal instead of running the command again.
  const request = { type: 'command', operation_id: randomBytes(24).toString('hex'), command: value };
  return JSON.parse(execFileSync(process.execPath, [runner, '--stdin'],
    { cwd: workspace, input: JSON.stringify(request), encoding: 'utf8', timeout: 60000, env: { ...process.env, BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: workspace, BOT_PROJECT_ENV_KEYS: '' } }));
}

test('a 33 KiB single-line command runs via legacy argv and a 128 KiB command runs via temp script with closed stdin', t => {
  const workspace = directory(); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const smallReq = { type: 'command', operation_id: randomBytes(24).toString('hex'), command: singleLine(33 * 1024) };
  const legacyAnswer = JSON.parse(execFileSync(process.execPath, [runner, Buffer.from(JSON.stringify(smallReq)).toString('base64url')],
    { cwd: workspace, encoding: 'utf8', timeout: 60000, env: { ...process.env, BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: workspace, BOT_PROJECT_ENV_KEYS: '' } }));
  assert.equal(legacyAnswer.ok, true, JSON.stringify(legacyAnswer));
  assert.equal(legacyAnswer.result.exit_code, 0);
  assert.equal(legacyAnswer.result.output, 'ok');

  // >64 KiB and >128 KiB Linux MAX_ARG_STRLEN: materialized as a 0600 temp script with stdin closed (/dev/null).
  const checkHead = 'test -z "$(cat)" && printf stdin-closed # ';
  const bigScript = checkHead + 'x'.repeat(128 * 1024 - checkHead.length);
  assert.ok(Buffer.byteLength(bigScript) > INLINE_ARGV_COMMAND_LIMIT);
  const bigAnswer = run(bigScript, workspace);
  assert.equal(bigAnswer.ok, true, JSON.stringify(bigAnswer));
  assert.equal(bigAnswer.result.exit_code, 0);
  assert.equal(bigAnswer.result.output, 'stdin-closed');
});

test('a command exactly at the 1 MiB limit runs, and one byte over is refused with the limit and its length', t => {
  assert.equal(limit, 1024 * 1024);
  const workspace = directory(); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const atLimit = run(singleLine(limit), workspace);
  assert.equal(atLimit.ok, true, JSON.stringify(atLimit));
  assert.equal(atLimit.result.exit_code, 0);
  assert.equal(atLimit.result.output, 'ok');
  const over = run(singleLine(limit + 1), workspace);
  assert.equal(over.ok, false);
  assert.equal(over.error, 'command_too_long');
  assert.equal(over.limit, limit);
  assert.equal(over.length, limit + 1);
  assert.match(String(over.detail), new RegExp(String(limit)));
  assert.match(String(over.detail), /heredoc|script file/i);
});

test('command() itself refuses over the limit with the limit and the actual length', async t => {
  const workspace = directory(); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  assert.throws(() => command(singleLine(limit + 1), workspace, 30000),
    error => error.code === 'command_too_long' && error.limit === limit && error.length === limit + 1);
});

test('the run_command schema tells the model the command length limit', () => {
  const field = commandTool(null).function.parameters.properties.command;
  assert.equal(field.type, 'string');
  assert.match(String(field.description), new RegExp(String(limit)));
  assert.match(String(field.description), /byte/i);
});

test('the manager transport can carry a request whose command is at the 1 MiB limit even when dense with escapes', async () => {
  const { runnerRequestLimit: exportedLimit } = await import('../../../manager/docker.mjs');
  assert.equal(exportedLimit, runnerRequestLimit);
  assert.equal(exportedLimit, 8 * 1024 * 1024);
  const request = { operation_id: 'a'.repeat(48), generation: 1,
    request: { type: 'workspace_command', command: '"'.repeat(limit), timeout_ms: null, keep_background: false, workspace_id: 'b'.repeat(48) } };
  const json = JSON.stringify(request);
  assert.ok(Buffer.byteLength(json) <= exportedLimit, `${Buffer.byteLength(json)} > ${exportedLimit}`);
});
