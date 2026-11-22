import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const modelId = '1c0de000000000000000000000000001';
const agentId = '1c0de000000000000000000000000002';
const noInput = '无人可答，请按任务自行判断';

export function icodeAnswer(params) {
  if (!Array.isArray(params?.questions)) return { cancelled: true };
  return { answers: params.questions.map(() => ({ values: [noInput], note: '' })), cancelled: false };
}

export async function configureICode(config, env) {
  const home = env.HOME;
  const directory = join(home, '.chrys');
  const access = config.execution_access;
  const files = access?.fileTools ?? access?.workspace ?? 'write';
  const commands = access?.commands ?? true;
  const trusted = access?.trustedCheckout !== false;
  const model = config.acp_model;
  const anthropic = model.interface_type === 'anthropic-messages';
  const builtins = ['ask_user', 'todo'];
  if (files !== 'none') builtins.push('filesystem.read', 'search');
  if (files === 'write') builtins.push('filesystem.write');
  if (commands) builtins.push('shell');

  const documents = {
    'settings.yaml': {
      project: { config_enabled: false, hooks_enabled: false, skills_enabled: trusted && files !== 'none' },
    },
    'models/launchpad.yaml': {
      id: modelId, name: 'Launchpad', model_id: config.model,
      provider: anthropic ? 'anthropic' : 'openai',
      api_style: model.interface_type === 'openai-responses' ? 'responses' : 'chat_completions',
      base_url: env.BOT_ACP_RELAY_URL + (anthropic ? '' : '/v1'),
      api_key: '{{BOT_RUN_TOKEN}}', bypass_proxy: true, stream: true,
      max_context_tokens: model.context_window, max_output_tokens: model.max_output_tokens,
      vision: model.image_input,
    },
    'agents/launchpad.yaml': {
      id: agentId, name: 'Launchpad', description: 'Launchpad project computer agent',
      instructions: 'Complete the platform task within the assigned checkout. Use the offered platform tools for task results.',
      tools: { builtins },
      model: { profile_id: modelId },
      memory: { files: trusted && files !== 'none' ? ['AGENTS.md'] : [] },
      skills: { auto_load_user_agents_skills: false, auto_load_cwd_agents_skills: trusted && files !== 'none',
        ...(commands ? {} : { script_extensions: [] }) },
    },
  };
  await Promise.all(['agents', 'models'].map(path => mkdir(join(directory, path), { recursive: true, mode: 0o700 })));
  // JSON is also valid YAML and keeps model names and endpoint strings literal.
  await Promise.all(Object.entries(documents).map(([path, value]) =>
    writeFile(join(directory, path), JSON.stringify(value), { flag: 'wx', mode: 0o600 })));
}
