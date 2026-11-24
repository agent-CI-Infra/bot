import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../../../runner/command.mjs';
import { commandTool } from '../../../dist/agent/command.js';

// A command's length is bounded because the manager hands the whole request to `docker exec` as one argv
// (manager/docker.mjs); the tool must say the bound, refuse over it by name with both numbers, and keep the bound
// wide enough for the heredoc a task writes a file with.
const limit = 65536;
const head = 'printf ok # ';
const singleLine = bytes => { assert.ok(bytes > head.length); return head + 'x'.repeat(bytes - head.length); };
const runner = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runner', 'runner.mjs');
const directory = () => mkdtempSync(join(tmpdir(), 'command-limit-'));

// The real runner under local execution: what the manager and the model receive, not only what command() throws.
function run(value, workspace) {
  // A per-call id: a repeated id makes the runner replay its journal instead of running the command again.
  const request = { type: 'command', operation_id: randomBytes(24).toString('hex'), command: value };
  return JSON.parse(execFileSync(process.execPath, [runner, Buffer.from(JSON.stringify(request)).toString('base64url')],
    { cwd: workspace, encoding: 'utf8', timeout: 60000, env: { ...process.env, BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: workspace, BOT_PROJECT_ENV_KEYS: '' } }));
}

test('a 33 KiB single-line command runs instead of being refused as invalid', t => {
  const workspace = directory(); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const answer = run(singleLine(33 * 1024), workspace);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.result.exit_code, 0);
  assert.equal(answer.result.output, 'ok');
});

test('a command exactly at the limit runs, and one byte over is refused with the limit and its length', t => {
  const workspace = directory(); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const atLimit = run(singleLine(limit), workspace);
  assert.equal(atLimit.ok, true, JSON.stringify(atLimit));
  assert.equal(atLimit.result.exit_code, 0);
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

test('the manager transport can carry a request whose command is at the limit', async () => {
  const { runnerRequestLimit } = await import('../../../manager/docker.mjs');
  assert.ok(Number.isSafeInteger(runnerRequestLimit), 'manager/docker.mjs must export runnerRequestLimit');
  const request = { operation_id: 'a'.repeat(48), generation: 1,
    request: { type: 'workspace_command', command: singleLine(limit), timeout_ms: null, keep_background: false, workspace_id: 'b'.repeat(48) } };
  const json = JSON.stringify(request);
  assert.ok(Buffer.byteLength(json) <= runnerRequestLimit, `${Buffer.byteLength(json)} > ${runnerRequestLimit}`);
  // The same request travels base64url inside one docker exec argument, and Linux refuses one argument at 128 KiB.
  assert.ok(Buffer.byteLength(Buffer.from(json).toString('base64url')) < 128 * 1024);
});
