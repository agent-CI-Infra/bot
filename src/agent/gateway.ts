import type { Store, Row } from '../storage/database.js';
import { beginModelRequest, finishModelRequest } from '../metrics/accounting.js';
import { errorBody, networkReason, type Redactor, stop, TaskError } from './common.js';
import { modelEndpoints, selectedModel } from './model.js';
import { modelIdleMs, readModelResponse } from './model-stream.js';

export type AgentModel = ReturnType<typeof selectedModel>;
export interface ModelRequest {
  store: Store;
  task: Row;
  model: AgentModel;
  redactor: Redactor;
  body: Record<string, any>;
  requestId: string;
  guard?: () => Promise<void>;
  onToken?: () => Promise<void>;
}

/** The single provider boundary. Credentials stay here, never in task tools or prompts.
 * Returns provider data to the trusted adapter, which validates/redacts its domain output.
 */
export async function requestModel(input: ModelRequest): Promise<{ value: any; status: number; model: AgentModel }> {
  const { store, task, model, redactor, body, requestId } = input;
  await input.guard?.();
  redactor.add(model.key);
  const current = store.get(`SELECT m.* FROM models m WHERE m.id=? AND
    (m.repository_id=? OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?)))`,
    model.id, task.repository_id, task.repository_id);
  if (!current?.api_key) return stop('model_not_available', 'waiting_configuration', '任务模型已被删除或撤销项目访问权限。');
  const currentKey = String(store.secrets.open(current.api_key, `model:${current.id}`).value || '');
  if (Number(current.version) !== model.version || String(current.api_url) !== model.url || String(current.model_name) !== model.model || currentKey !== model.key)
    return stop('model_configuration_changed', 'waiting_configuration', '任务运行期间模型配置已变化，请重新启动任务。');
  if (!body || !Array.isArray(body.messages) || Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
    return stop('model_request_invalid', undefined, '模型请求缺少 messages 数组，或请求内容超过 2 MiB 上限。');
  const endpoint = modelEndpoints(model.url).chat_url;
  const target = `模型 ${model.model}（${(() => { try { return new URL(endpoint).host; } catch { return '地址无效'; } })()}）`;
  const { stream_options: _streamOptions, max_tokens: _maxTokens, max_completion_tokens: _maxCompletionTokens, ...requestBody } = body;
  const limit = 'max_tokens' in body && !('max_completion_tokens' in body) ? 'max_tokens' : 'max_completion_tokens';
  // Release/inspection runs may have a domain record rather than a tasks FK. They still
  // enter the same repository/model ledger; the request identity retains their provenance.
  const ledgerTask = { ...task, id: task.id && store.get('SELECT id FROM tasks WHERE id=?', task.id) ? task.id : null };
  const requestLog = beginModelRequest(store, ledgerTask, `${task.kind}:${task.id ?? 'run'}:${requestId}`, model);
  const controller = new AbortController();
  let callbackFailed = false;
  let lastGuard = -Infinity;
  let idle = false, timer: ReturnType<typeof setTimeout> | undefined, response: Response | undefined, value: any;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; controller.abort(); }, modelIdleMs); };
  reset();
  try {
    response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + model.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(redactor.clean({ ...requestBody, model: model.model, [limit]: 8192, stream: true, stream_options: { include_usage: true } }))
    });
    value = response.ok ? await readModelResponse(response, async () => {
      reset();
      try {
        // Full guards can call the workspace manager. Check the first token and
        // then at most once a second, while retaining per-token idle/progress updates.
        const now = Date.now();
        if (now - lastGuard >= 1000) { lastGuard = now; await input.guard?.(); }
        await input.onToken?.();
      }
      catch (error) { callbackFailed = true; throw error; }
    }) : await errorBody(response);
  } catch (error) {
    finishModelRequest(store, requestLog, null, response?.status ?? null, callbackFailed ? 'guard_failed' : error instanceof TaskError ? 'invalid_response' : 'transport_error');
    if (callbackFailed || error instanceof TaskError) throw error;
    return stop('model_unavailable', 'retry_wait', redactor.text(`${target}请求失败：${idle ? '连续 90 秒没有 token 输出' : networkReason(error, modelIdleMs)}。`));
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    finishModelRequest(store, requestLog, null, response.status, 'http_error');
    const error = value?.error, found = [error?.message, error, value?.message, value?.detail, value?.msg].find(item => typeof item === 'string' && item.trim());
    const said = found ? '：' + redactor.text(found).replace(/\s+/g, ' ').trim().slice(0, 320) : '';
    if ([401, 403].includes(response.status)) return stop('model_authentication_failed', 'waiting_configuration', `${target}拒绝认证或访问，HTTP ${response.status}${said}。请检查模型 API Key 和权限。`);
    return stop('model_http_' + response.status, response.status === 429 || response.status >= 500 ? 'retry_wait' : 'failed', `${target}返回 HTTP ${response.status}${said}`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) {
    finishModelRequest(store, requestLog, value?.usage, response.status, 'invalid_response');
    return stop('model_response_too_large', undefined, '模型响应超过 2 MiB 上限。');
  }
  // Billable usage is durable even if a subsequent guard or domain validator rejects the result.
  finishModelRequest(store, requestLog, value?.usage, response.status);
  await input.guard?.();
  return { value, status: response.status, model };
}
