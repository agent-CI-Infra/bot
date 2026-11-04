import type { Store, Row } from '../storage/database.js';
import { type Redactor, stop } from './common.js';
import { selectedModel } from './model.js';
import { requestModel, type AgentModel } from './gateway.js';

export interface AgentServices {
  model: AgentModel;
  guard: () => Promise<void>;
  request: (body: Record<string, any>, requestId: string, onToken?: () => Promise<void>) => ReturnType<typeof requestModel>;
}
export interface AgentSpec<T> {
  store: Store;
  task: Row;
  redactor: Redactor;
  guard: () => Promise<void>;
  system: string;
  prompt: string;
  tools?: any[];
  maxTurns?: number;
  maxOutputChars?: number;
  execute?: (name: string, args: any) => Promise<any>;
  validate?: (content: string) => T | Promise<T>;
  /** A transport adapter (for example Pi in a workspace), not a task-kind switch. */
  adapter?: (services: AgentServices) => Promise<T>;
}

/** Common lifecycle and model boundary for container and control-plane agents.
 * Task-specific prompts, allowlisted tools and validators are supplied by callers.
 * The runtime never obtains permissions from model output or untrusted task text.
 */
export async function runAgent<T>(spec: AgentSpec<T>): Promise<T> {
  await spec.guard();
  const tools = spec.tools ?? [];
  if (!Array.isArray(tools) || tools.some(tool => !tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name) ||
    new Set(tools.map(tool => tool.function.name)).size !== tools.length)
    return stop('agent_tools_invalid', 'waiting_configuration', 'Agent 工具配置无效或重复。');
  const allowed = new Map(tools.map(tool => [tool.function.name, tool]));
  const model = selectedModel(spec.store, spec.task.repository_id, spec.task.kind);
  spec.redactor.add(model.key);
  const services: AgentServices = {
    model, guard: spec.guard,
    request: (body, requestId, onToken) => {
      if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool: any) => !tool || tool.type !== 'function' || !allowed.has(tool.function?.name))))
        return stop('agent_tool_not_allowed', 'failed', 'Agent 请求使用未授权的工具。');
      const choice = body.tool_choice;
      if (choice && typeof choice === 'object' && !allowed.has(choice.function?.name))
        return stop('agent_tool_not_allowed', 'failed', 'Agent 请求使用未授权的工具。');
      const tools = body.tools?.map((tool: any) => allowed.get(tool.function.name));
      return requestModel({ ...spec, model, body: { ...body, ...(tools ? { tools } : {}) }, requestId, onToken });
    }
  };
  const result = spec.adapter ? await spec.adapter(services) : await runTools(spec, services);
  await spec.guard();
  return result;
}

async function runTools<T>(spec: AgentSpec<T>, services: AgentServices): Promise<T> {
  const maxTurns = spec.maxTurns ?? 16, maxOutput = spec.maxOutputChars ?? 32768;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 256 || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 2 * 1024 * 1024)
    return stop('agent_limits_invalid', 'waiting_configuration', 'Agent 运行限制配置无效。');
  const tools = spec.tools ?? [], names = new Set(tools.map(tool => tool.function?.name));
  const messages: any[] = [{ role: 'system', content: spec.system }, { role: 'user', content: spec.prompt }];
  for (let turn = 0; turn < maxTurns; turn++) {
    await services.guard();
    const { value } = await services.request({ tools, tool_choice: tools.length ? 'auto' : 'none', messages }, `turn:${turn}`);
    const message = value?.choices?.[0]?.message;
    if (!message || JSON.stringify(message).length > 2 * 1024 * 1024) return stop('agent_output_invalid', undefined, 'Agent 没有返回有效结果。');
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (!tools.length || message.tool_calls.length > 8 || new Set(message.tool_calls.map((call: any) => call.id)).size !== message.tool_calls.length ||
        message.tool_calls.some((call: any) => !/^[\w-]{1,128}$/.test(call.id || '') || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string'))
        return stop('agent_tool_calls_invalid', undefined, 'Agent 工具请求格式无效或超限。');
      messages.push(spec.redactor.clean({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: message.tool_calls }));
      for (const call of message.tool_calls) {
        await services.guard();
        let args: any; try { args = JSON.parse(call.function.arguments); } catch { args = null; }
        // The model cannot call an unadvertised tool, even if an executor happens to support it.
        const result = names.has(call.function.name) && spec.execute ? await spec.execute(call.function.name, args) : { error: 'tool_not_allowed' };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(spec.redactor.clean(result)) });
      }
      continue;
    }
    if (typeof message.content !== 'string' || message.content.length > maxOutput)
      return stop('agent_output_invalid', undefined, 'Agent 返回内容无效或超过输出上限。');
    // Validators see raw content to reject (rather than silently save) sensitive output.
    return spec.validate ? await spec.validate(message.content) : spec.redactor.text(message.content) as T;
  }
  return stop('agent_turn_limit', 'failed', `Agent 达到 ${maxTurns} 轮上限，请检查已取得的证据后继续。`);
}
