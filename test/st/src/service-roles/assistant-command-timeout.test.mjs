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
