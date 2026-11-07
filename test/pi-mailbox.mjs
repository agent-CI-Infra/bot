import { randomBytes } from 'node:crypto';
// A project-computer manager that answers the runner mailbox operations in process. Each workspace holds a minimal
// stand-in for the Pi loop: it sends the configured system/prompt/tools as model requests, runs control-plane tools
// through the control mailbox, ends on a Pi-native finish tool or a control-plane finish, and refuses unknown tools the
// way Pi does. It exercises the control-plane side of the Pi harness deterministically; test/pi-controller.test.mjs
// runs the real Pi SDK.
export function fakeRunner({ version = '1.4.0' } = {}) {
  const spaces = new Map(), operations = [];
  const space = id => { if (!spaces.has(id)) spaces.set(id, { id, config: [], state: 'missing', pending: null, alive: true, configs: 0, starts: 0, result: null, chunks: new Map(), events: [] }); return spaces.get(id); };
  const ask = (sp, kind, payload) => new Promise(resolve => { sp.pending = { kind, id: randomBytes(24).toString('hex'), ...payload, resolve }; });
  async function loop(sp) {
    const c = JSON.parse(Buffer.concat(sp.config).toString('utf8')); sp.parsed = c;
    const messages = [{ role: 'system', content: c.system }, { role: 'user', content: c.prompt }];
    const control = new Set(c.control_tools || []), finish = new Set(c.finish_tools || []), offered = new Set(c.tools.map(t => t.function.name));
    sp.state = 'running';
    for (let turn = 0; turn < 64; turn++) {
      const message = await ask(sp, 'request', { body: { messages: structuredClone(messages), tools: c.tools, stream: false } });
      if (!sp.alive) return;
      messages.push(message);
      // Like Pi, report each model turn as an event, including the provider's private reasoning.
      sp.events.push({ type: 'model', step: turn + 1, reasoning: 'PRIVATE_FAKE_REASONING', tool_calls: (message.tool_calls || []).map(c => ({ name: c.function.name })) });
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
      case 'reap': sp.alive = false; return {};
      case 'workspace_agent_runtime': return { agent: 'pi', package: '@earendil-works/pi-coding-agent', version, node: process.version };
      case 'workspace_agent_config': if (request.offset === 0) { sp.config = []; sp.configs++; } sp.config.push(Buffer.from(request.base64, 'base64')); return { written: true };
      case 'workspace_agent_start':
        if (sp.state !== 'missing') return sp.alive ? { started: true } : { error: 'agent_interrupted' };
        sp.starts++; void loop(sp); return { started: true };
      case 'workspace_agent_poll': {
        // A session whose process is gone reads as interrupted, whatever it last did.
        const p = sp.pending, state = !sp.alive ? 'interrupted' : sp.state;
        const offset = request.offset || 0, events = sp.events.slice(offset, offset + 20);
        return { state, pid: 1, result: sp.result, events, offset: offset + events.length, has_more: offset + events.length < sp.events.length,
          request: sp.alive && p?.kind === 'request' ? { id: p.id, body: p.body } : null,
          control_tool: sp.alive && p?.kind === 'control_tool' ? { id: p.id, name: p.name, arguments: p.arguments } : null };
      }
      case 'workspace_agent_reply': case 'workspace_agent_control_tool': {
        if (sp.pending?.id !== request.request_id) throw new Error('agent_request_changed');
        const value = collect(sp, request); if (!value) return { written: true };
        const p = sp.pending; sp.pending = null;
        p.resolve(request.type === 'workspace_agent_reply' ? JSON.parse(value.body).choices[0].message : value); return { written: true };
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
