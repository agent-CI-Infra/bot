import { traceSnapshot } from '../tasks/trace.js';
import type { Store, Row } from '../storage/database.js';
import { beginModelRequest, finishModelRequest } from '../metrics/accounting.js';
import { errorBody, networkReason, type Redactor, stop, TaskError } from './common.js';
import { modelEndpoints, selectedModel } from './model.js';
import { modelIdleMs, readModelResponse, type ModelDelta } from './model-stream.js';

export type AgentModel = ReturnType<typeof selectedModel>;
export interface ModelRequest {
  store: Store;
  task: Row;
  model: AgentModel;
  redactor: Redactor;
  body: Record<string, any>;
  requestId: string;
  guard?: () => Promise<void>;
  maxOutputTokens?: number;
  onToken?: (delta?: ModelDelta) => Promise<void>;
  executionSignal?: AbortSignal;
}

/** The single provider boundary. Credentials stay here, never in task tools or prompts.
 * Returns provider data to the trusted adapter, which validates/redacts its domain output.
 */
export async function requestModel(input: ModelRequest): Promise<{ value: any; status: number; model: AgentModel; request_log_id: string }> {
  const { store, task, model, redactor, body, requestId } = input;
  await input.guard?.();
  redactor.add(model.key);
  // A service role run may only use the shared model its role is configured with right now; a project run uses a model
  // the project owns or was granted.
  const current = task.service_role_id && !task.repository_id
    ? store.get('SELECT m.* FROM models m JOIN service_roles s ON s.model_id=m.id WHERE m.id=? AND m.repository_id IS NULL AND s.id=? AND s.enabled=1', model.id, task.service_role_id)
    : store.get(`SELECT m.* FROM models m WHERE m.id=? AND
    (m.repository_id=? OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?)))`,
    model.id, task.repository_id, task.repository_id);
  if (!current?.api_key) return stop('model_not_available', 'waiting_configuration', task.service_role_id && !task.repository_id ? '服务角色的模型已被更换、删除或撤销凭据。' : '任务模型已被删除或撤销项目访问权限。');
  const currentKey = String(store.secrets.open(current.api_key, `model:${current.id}`).value || '');
  if (Number(current.version) !== model.version || String(current.api_url) !== model.url || String(current.model_name) !== model.model || currentKey !== model.key)
    return stop('model_configuration_changed', 'waiting_configuration', '任务运行期间模型配置已变化，请重新启动任务。');
  if (!body || !Array.isArray(body.messages) || Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
    return stop('model_request_invalid', undefined, '模型请求缺少 messages 数组，或请求内容超过 2 MiB 上限。');
  const outputTokens=input.maxOutputTokens??8192;
  if(!Number.isSafeInteger(outputTokens)||outputTokens<1||outputTokens>32768)return stop('agent_limits_invalid','waiting_configuration','模型输出预算配置无效。');
  const endpoint = modelEndpoints(model.url).chat_url;
  const target = `模型 ${model.model}（${(() => { try { return new URL(endpoint).host; } catch { return '地址无效'; } })()}）`;
  const { stream_options: _streamOptions, max_tokens: _maxTokens, max_completion_tokens: _maxCompletionTokens, ...requestBody } = body;
  const limit = 'max_tokens' in body && !('max_completion_tokens' in body) ? 'max_tokens' : 'max_completion_tokens';
  // Release/inspection runs may have a domain record rather than a tasks FK. They still
  // enter the same repository/model ledger; the request identity retains their provenance.
  const ledgerTask = { ...task, id: task.id && store.get('SELECT id FROM tasks WHERE id=?', task.id) ? task.id : null };
  const requestLog = beginModelRequest(store, ledgerTask, `${task.kind}:${task.id ?? 'run'}:${requestId}`, model);
  // Bodies go to the trajectory file of the run (or conversation turn, or dispatch): a request as the messages added
  // since the previous one. The row keeps refs. Without a file to put them in, the row keeps snapshots as before.
  const scope=store.trajectories.scopeOf(task);
  const snapshot=(value:unknown,part:string)=>task.conversation_id?store.secrets.seal({snapshot:traceSnapshot(value)},'conversation-model-'+part+':'+requestLog):traceSnapshot(value);
  const respond=(value:unknown)=>{
    if(scope)store.run('UPDATE model_requests SET response_ref=? WHERE id=?',store.trajectories.append(scope,'model_response',requestLog,value),requestLog);
    else store.run('UPDATE model_requests SET response_snapshot=? WHERE id=?',snapshot(value,'response'),requestLog);
  };
  const captured=redactor.clean({ ...requestBody, model: model.model, [limit]: outputTokens, stream: true, stream_options: { include_usage: true } });
  if(scope)store.run('UPDATE model_requests SET run_id=?,request_ref=? WHERE id=?',task.trace_run_id??null,store.trajectories.appendModelRequest(scope,requestLog,captured),requestLog);
  else store.run('UPDATE model_requests SET run_id=?,request_snapshot=? WHERE id=?',task.trace_run_id??null,snapshot(captured,'request'),requestLog);
  const controller = new AbortController();
  const abort=()=>controller.abort();
  input.executionSignal?.addEventListener('abort',abort,{once:true});
  if(input.executionSignal?.aborted)controller.abort();
  let callbackFailed = false;
  let lastGuard = -Infinity;
  let idle = false, timer: ReturnType<typeof setTimeout> | undefined, response: Response | undefined, value: any;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; controller.abort(); }, modelIdleMs); };
  reset();
  try {
    response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + model.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(redactor.clean({ ...requestBody, model: model.model, [limit]: outputTokens, stream: true, stream_options: { include_usage: true } }))
    });
    value = response.ok ? await readModelResponse(response, async delta => {
      reset();
      try {
        // Full guards can call the workspace manager. Check the first token and
        // then at most once a second, while retaining per-token idle/progress updates.
        const now = Date.now();
        if (now - lastGuard >= 1000) { lastGuard = now; await input.guard?.(); }
        await input.onToken?.(delta);
      }
      catch (error) { callbackFailed = true; throw error; }
    }) : await errorBody(response);
  } catch (error) {
    respond({error:callbackFailed?'guard_failed':error instanceof TaskError?error.code:'transport_error'});
    finishModelRequest(store, requestLog, null, response?.status ?? null, callbackFailed ? 'guard_failed' : error instanceof TaskError ? 'invalid_response' : 'transport_error');
    if (callbackFailed || error instanceof TaskError) throw error;
    return stop('model_unavailable', 'retry_wait', redactor.text(`${target}请求失败：${idle ? '连续 90 秒没有 token 输出' : networkReason(error, modelIdleMs)}。`));
  } finally { clearTimeout(timer); input.executionSignal?.removeEventListener('abort',abort); }
  try { await input.guard?.(); }
  catch(error){
    respond({error:'guard_failed'});
    finishModelRequest(store,requestLog,value?.usage,response.status,'guard_failed');throw error;
  }
  respond(redactor.clean(value));
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
  return { value, status: response.status, model, request_log_id: requestLog };
}
