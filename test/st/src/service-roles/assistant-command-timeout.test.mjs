import test from 'node:test';
import assert from 'node:assert/strict';

// #534: the assistant computer's run_command stopped at 600 seconds whatever the deployment allowed, and its prompt said
// so. It follows the same BOT_COMMAND_TIMEOUT_MAX_SECONDS ceiling as the task workspace tools now. The default is not
// moved: without the setting the ceiling is still 600, and 601 is still refused.
const load = async limit => {
  if (limit === undefined) delete process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS;
  else process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = String(limit);
  return import(`../../../../dist/service-roles/assistant-computers.js?limit=${limit ?? 'default'}`);
};
const runTool = module => module.assistantComputerTools.find(entry => entry.function.name === 'run_command');
const timeoutField = module => runTool(module).function.parameters.properties.timeout_seconds;

test('the assistant computer run_command keeps its 600 second default ceiling and follows a raised deployment ceiling', async t => {
  t.after(() => delete process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS);
  const base = await load();
  assert.equal(timeoutField(base).maximum, 600, 'without the setting the ceiling stays 600 seconds');
  assert.match(runTool(base).function.description, /default 120, at most 600/);

  // A deployment that raises the ceiling states and accepts the larger value, and its refusal states that ceiling.
  const raised = await load(1800);
  assert.equal(timeoutField(raised).maximum, 1800, 'the schema follows the configured ceiling');
  assert.match(runTool(raised).function.description, /at most 1800/);
  assert.equal(raised.assistantCommandTimeout(1200), 1200, 'a request above the old 600 is accepted once the ceiling is raised');
  assert.equal(raised.assistantCommandTimeout(1800), 1800);
  assert.throws(() => raised.assistantCommandTimeout(1801), error => error.code === 'invalid_timeout_seconds' && /between 1 and 1800/.test(String(error.detail?.message ?? '')));

  // The default is not moved: without the setting a value above 600 is still refused, and its message states 600.
  delete process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS;
  const plain = await load();
  assert.equal(plain.assistantCommandTimeout(), 120, 'without timeout_seconds the entry default stays 120 seconds');
  assert.equal(plain.assistantCommandTimeout(600), 600);
  assert.throws(() => plain.assistantCommandTimeout(601), error => error.status === 400 && error.code === 'invalid_timeout_seconds' && /between 1 and 600/.test(String(error.detail?.message ?? '')));
});

test('a ceiling below the 120 second entry default lowers the default instead of refusing every command', async t => {
  t.after(() => delete process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS);
  // BOT_COMMAND_TIMEOUT_MAX_SECONDS accepts 1..2147363, so a deployment may set a ceiling under the 120 second entry
  // default. Without timeout_seconds the call must then take the ceiling, not 120 and a refusal.
  const low = await load(60);
  assert.equal(timeoutField(low).maximum, 60, 'the schema follows the lowered ceiling');
  assert.equal(low.assistantCommandTimeout(), 60, 'without timeout_seconds the effective default is the lowered ceiling');
  assert.equal(low.assistantCommandTimeout(60), 60);
  assert.throws(() => low.assistantCommandTimeout(61), error => error.status === 400 && error.code === 'invalid_timeout_seconds' && /between 1 and 60/.test(String(error.detail?.message ?? '')));
});

test('the assistant computer run_command accepts the declared 64 KiB command limit and refuses a longer command by name', async () => {
  // #1320 review: the assistant tool described the same 64 KiB limit as the task workspace, but its execution path
  // stopped at 16000 characters with a generic invalid_field, so the declared bound was never the real one. The
  // refusal must be the same named answer the runner gives, with the limit and the actual byte length.
  const { AssistantComputer } = await import('../../../../dist/service-roles/assistant-computers.js');
  const instance = new AssistantComputer({}, {});
  const requests = [];
  instance.run = async request => { requests.push(request); return { ok: true, result: { exit_code: 0 } }; };
  const atLimit = 'x'.repeat(65536);
  await instance.execute('run_command', { command: atLimit });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, atLimit, 'a command at the declared limit reaches the computer unchanged');
  const over = await instance.execute('run_command', { command: atLimit + 'x' });
  assert.deepEqual([over.error, over.limit, over.length], ['command_too_long', 65536, 65537]);
  assert.match(String(over.detail), /65536 bytes/);
  assert.match(String(over.detail), /script file/);
  assert.equal(requests.length, 1, 'a refused command never reaches the computer');
});
