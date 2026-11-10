#!/usr/bin/env node
// Protocol fixture only. This executable is not Claude Code and is never used as live-model evidence.
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (process.argv.includes('--version')) { console.log('2.1.319 (Claude Code)'); process.exit(); }
const sid = arg('--resume') ?? arg('--session-id');
const send = value => process.stdout.write(JSON.stringify({ session_id: sid, ...value }) + '\n');
let running = false;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); process.exit(); }
  if (m.type !== 'user' || running) continue;
  running = true;
  const prompt = m.message.content[0].text, mode = /"fixture_mode":"([a-z0-9_-]+)"/.exec(prompt)?.[1] ?? 'normal';
  const tools = arg('--allowedTools').split(',');
  const url = JSON.parse(arg('--mcp-config')).mcpServers.bot.url;
  if (mode === 'malformed') { process.stdout.write('{no\n'); continue; }
  if (mode === 'invalid_utf8') { process.stdout.write(Buffer.from([0xff, 0x0a])); continue; }
  if (mode === 'truncated') { process.stdout.write('{"type":'); process.exit(); }
  const persisted = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture'); mkdirSync(persisted, { recursive: true }); writeFileSync(join(persisted, sid + '.jsonl'), '{}\n');
  writeFileSync(join(process.env.HOME, 'launch.json'), JSON.stringify({ args: process.argv.slice(2), env_names: Object.keys(process.env), cwd: process.cwd(), resumed: process.argv.includes('--resume') }));
  send({ type: 'system', subtype: 'init', model: arg('--model'), tools: mode === 'extra_tool' ? [...tools, 'Bash'] : tools, mcp_servers: [{ name: 'bot', status: 'connected' }] });
  if (['auth_error', 'model_error', 'rate_error', 'transport_error'].includes(mode)) {
    if (mode === 'rate_error') { const reply = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: arg('--model'), max_tokens: 256, messages: [{ role: 'user', content: 'fixture rate limit probe' }], tools: [] }) }); await reply.text(); }
    const error = ({ auth_error: 'authentication_failed', model_error: 'invalid_request', rate_error: 'rate_limit', transport_error: 'server_error' })[mode];
    send({ type: 'system', subtype: 'api_retry', attempt: 1, error });
    send({ type: 'assistant', error, message: { id: 'fault-1', content: [{ type: 'text', text: 'Fixture provider failure' }] } });
    send({ type: 'result', subtype: 'success', is_error: true, num_turns: 0 }); process.exitCode = 1; break;
  }
  if (mode === 'wait' || mode === 'late') { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); writeFileSync(join(process.env.HOME, 'child.pid'), String(child.pid)); if (mode === 'wait') continue; await new Promise(r => setTimeout(r, 800)); }
  const call = async (name, args) => {
    const id = 'rpc-' + name + '-' + Math.random().toString(36).slice(2);
    send({ type: 'assistant', message: { id: id, content: [{ type: 'thinking', thinking: 'PRIVATE_FIXTURE_REASONING' }, { type: 'tool_use', id, name: 'mcp__bot__' + name, input: args }], ...(mode === 'unknown_usage' ? {} : { usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 2 } }) } });
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json();
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'PRIVATE_RAW_OBSERVATION' }] } });
    return body.result?.content ? JSON.parse(body.result.content[0].text) : body;
  };
  if (mode === 'permission') send({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'gh pr create' } } });
  if(mode==='conversation'){
    const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'content-type':'application/json'},
      body:JSON.stringify({model:arg('--model'),max_tokens:256,messages:[{role:'user',content:'Fixture provider request'}],tools:[]})});
    await response.json();await call('search_conversation_history',{});await call('finish',{message:'A source-bound response'});
    send({type:'result',subtype:'success',is_error:false,num_turns:2,usage:{input_tokens:22,output_tokens:14}});continue;
  }
  const record = await call('read_task_record', { ref: 'task:t' });
  if (mode === 'wrong_ref') await call('read_task_record', { ref: 'task:o' });
  if (mode === 'exit') process.exit(4);
  if (mode === 'no_result') process.exit();
  if (mode === 'fragmented') {
    const b = Buffer.from(JSON.stringify({ type: 'assistant', session_id: sid, message: { id: 'text-1', content: [{ type: 'text', text: '核对通过' }], usage: { input_tokens: 1, output_tokens: 3 } } }) + '\n');
    for (const byte of b) process.stdout.write(Buffer.from([byte]));
  }
  if (mode === 'long_text') send({ type: 'assistant', message: { id: 'long-1', content: [{ type: 'text', text: 'x'.repeat(70_000) }], usage: { input_tokens: 1, output_tokens: 3 } } });
  if (mode !== 'no_submit') await call('finish', { summary: mode === 'bad_report' ? '' : 'read through gateway', fact: record.task?.contract?.goal ?? record.contract?.goal ?? 'read' });
  const result = { type: 'result', subtype: mode === 'budget' ? 'error_max_turns' : 'success', is_error: mode === 'budget', num_turns: 2, ...(mode === 'unknown_usage' ? {} : { usage: { input_tokens: 22, output_tokens: 14, cache_read_input_tokens: 4 } }) };
  send(result); if (result.is_error) { process.exitCode = 1; break; }
  if (mode === 'after_result') send({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: 'late' }] } });
  // The driver closes stdin after result; leave it open here to exercise that handshake.
}
