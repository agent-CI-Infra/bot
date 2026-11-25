import { randomBytes } from 'node:crypto';
// A project-computer manager that answers the runner mailbox operations in process. Each workspace holds a minimal
// stand-in for the Pi loop: it sends the configured system/prompt/tools to the control-plane passthrough model gateway,
// runs control-plane tools through the control mailbox, ends on a Pi-native finish tool or a control-plane finish, and
// refuses unknown tools the way Pi does. It exercises the control-plane side of the Pi harness deterministically;
// test/st/src/roles/pi-controller.test.mjs runs the real Pi SDK.
function parseChatSseMessage(text) {
  let content = '';
  const calls = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) };
}

export function fakeRunner({ version = '1.4.0', reapKills = true } = {}) {
  const spaces = new Map(), operations = [];
  const space = id => { if (!spaces.has(id)) spaces.set(id, { id, config: [], gateway: null, wakeGateway: null, state: 'missing', pending: null, alive: true, configs: 0, starts: 0, result: null, error: null, detail: null, chunks: new Map(), events: [] }); return spaces.get(id); };
  const ask = (sp, kind, payload) => new Promise(resolve => { sp.pending = { kind, id: randomBytes(24).toString('hex'), ...payload, resolve }; });
  async function waitForGateway(sp, c) {
    while (sp.alive && !(sp.gateway?.model_gateway_url || c.model_gateway_url)) {
      await new Promise(resolve => { sp.wakeGateway = resolve; setTimeout(resolve, 20); });
    }
    return {
      url: sp.gateway?.model_gateway_url ?? c.model_gateway_url,
      token: sp.gateway?.run_token ?? c.run_token,
    };
  }
  async function requestModel(sp, c, messages) {
    const gw = await waitForGateway(sp, c);
    if (!sp.alive || !gw.url) throw new Error('fake_runner_missing_model_gateway_url');
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(gw.token ? { authorization: `Bearer ${gw.token}` } : {}),
      },
      body: JSON.stringify({ model: c.model_name || 'fixture', messages: structuredClone(messages), tools: c.tools, stream: false }),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw;
      try { const j = JSON.parse(raw); msg = j?.error?.message || raw; } catch {}
      throw Object.assign(new Error(msg || `HTTP ${res.status}`), { status: res.status });
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream') || raw.trimStart().startsWith('data:')) return parseChatSseMessage(raw);
    return JSON.parse(raw).choices[0].message;
  }
  async function loop(sp) {
    const c = JSON.parse(Buffer.concat(sp.config).toString('utf8')); sp.parsed = c;
    const messages = [{ role: 'system', content: c.system }, { role: 'user', content: c.prompt }];
    const control = new Set(c.control_tools || []), finish = new Set(c.finish_tools || []), offered = new Set((c.tools || []).map(t => t.function.name));
    sp.state = 'running';
    for (let turn = 0; turn < 64; turn++) {
      let message;
      try {
        message = await requestModel(sp, c, messages);
      } catch (err) {
        if (!sp.alive) return;
        sp.state = 'failed';
        sp.error = 'model_request_failed';
        sp.detail = String(err?.message || err);
        return;
      }
      if (!sp.alive) return;
      messages.push(message);
      // Like Pi, report each model turn as an event, including the provider's private reasoning.
      sp.events.push({ type: 'model', step: turn + 1, reasoning: 'PRIVATE_FAKE_REASONING', tool_calls: (message.tool_calls || []).map(call => ({ name: call.function.name })) });
      if (!message.tool_calls?.length) { sp.state = 'completed'; sp.result = null; return; }
      for (const call of message.tool_calls) {
        const name = call.function.name, args = JSON.parse(call.function.arguments || '{}'); let result;
        if (control.has(name)) { const reply = await ask(sp, 'control_tool', { name, arguments: args }); if (!sp.alive) return; result = reply.result; if (reply.finish) { sp.state = 'completed'; sp.result = reply.result; return; } }
        else if (finish.has(name)) { sp.state = 'completed'; sp.result = args; return; }
        else result = { error: offered.has(name) ? 'fake_runner_tool' : `Tool ${name} not found` };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    sp.state = 'failed';
  }
  const collect = (sp, request) => {
    const key = request.type + ':' + request.request_id, parts = sp.chunks.get(key) ?? []; parts.push(Buffer.from(request.base64, 'base64')); sp.chunks.set(key, parts);
    if (!request.final) return null; sp.chunks.delete(key); return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  function execute(request) {
    const sp = space(request.workspace_id); operations.push({ type: request.type, workspace_id: request.workspace_id });
    switch (request.type) {
      case 'workspace_init': return { initialized: true };
      // Releasing a workspace ends its processes, as the real runner does.
      case 'reap': if (reapKills) { sp.alive = false; sp.wakeGateway?.(); } return {};
      case 'workspace_agent_runtime': return { agent: 'pi', package: '@earendil-works/pi-coding-agent', version, node: process.version };
      case 'workspace_agent_config': if (request.offset === 0) { sp.config = []; sp.configs++; } sp.config.push(Buffer.from(request.base64, 'base64')); return { written: true };
      case 'workspace_agent_gateway': {
        sp.gateway = { ...(sp.gateway || {}), ...JSON.parse(Buffer.from(request.base64, 'base64').toString('utf8')) };
        sp.wakeGateway?.();
        return { written: true };
      }
      case 'workspace_agent_start':
        if (sp.state !== 'missing') return sp.alive ? { started: true } : { error: 'agent_interrupted' };
        sp.starts++; void loop(sp); return { started: true };
      case 'workspace_agent_poll': {
        // A session whose process is gone reads as interrupted, whatever it last did.
        const p = sp.pending, state = !sp.alive ? 'interrupted' : sp.state;
        const offset = request.offset || 0, events = sp.events.slice(offset, offset + 20);
        return { state, pid: 1, result: sp.result, ...(sp.error ? { error: sp.error, detail: sp.detail } : {}), events, offset: offset + events.length, has_more: offset + events.length < sp.events.length,
          tool_requests: sp.alive && p?.kind === 'control_tool' ? [{ id: p.id, kind: 'control', name: p.name, arguments: p.arguments }] : [] };
      }
      case 'workspace_agent_tool': {
        if (sp.pending?.id !== request.request_id) throw new Error('agent_request_changed');
        const value = collect(sp, request); if (!value) return { written: true };
        const p = sp.pending; sp.pending = null;
        p.resolve(value); return { written: true };
      }
      default: throw new Error('fake runner does not implement ' + request.type);
    }
  }
  return {
    spaces, operations, space,
    manager: { async call(method, path, input) {
      if (method !== 'POST' || !/\/execute$/.test(path)) throw new Error('unexpected manager call ' + method + ' ' + path);
      try { return { ok: true, result: execute(input.request) }; } catch (error) { return { ok: false, error: 'runner_operation_failed', detail: input.request.type + ': ' + error.message }; }
    } }
  };
}
