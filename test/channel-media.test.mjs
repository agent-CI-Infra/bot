import test from 'node:test';
import { operationRequestText, operationResult } from '../dist/storage/payloads.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelFixture, envelope, post, until, finished, privateChat, boundGroup, inGroup } from './channel-fixture.mjs';
import { feishuMarkdown, markdownPosts, postText } from '../dist/channels/format.js';
import { MediaTurn, incomingFiles, inboundBytes, safeFilename } from '../dist/channels/media.js';
import { ChannelService } from '../dist/channels/service.js';
import { ServiceComputers } from '../dist/service-roles/resources.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { Redactor } from '../dist/agent/common.js';
import { randomWorkspaceId } from './helpers.mjs';
import { digest } from '../dist/core/security.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const say = (res, content) => answer(res, { role: 'assistant', content });
const answer = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const call = (res, name, args) => answer(res, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const results = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const delivered = (f, source) => until(() => f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', source), r => r && r.state === 'sent');
const fileEvent = (key, chat = 'oc_private', name = 'notes.txt') => envelope('', { message: { chat_id: chat, message_type: 'file', content: JSON.stringify({ file_key: key, file_name: name }) } });
async function group(f) {
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
  await f.admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: role.revision, model_id: f.assistantModel.id });
  return boundGroup(f);
}
function localTurn(f, chat, event) {
  const revision = f.h.store.get('SELECT context_revision FROM channel_chats WHERE id=?', chat.id).context_revision;
  const guard = () => { f.service.source(event); assert.equal(f.h.store.get('SELECT context_revision FROM channel_chats WHERE id=?', chat.id).context_revision, revision); };
  return new MediaTurn(f.service.media, chat.id, event.message_id, guard, {}, () => {}, undefined, 'fixture-fence');
}

test('native Markdown preserves common GFM and converts unsupported constructs without mentions, remote image keys or unsafe links', () => {
  const sample = 'Title\n=====\n\nA **bold** *italic* ~~removed~~ `code` [link](/#/board).\n\n> quoted\n> second\n\n1. first\n   - nested\n   - [x] done\n\n| Name | Value |\n| --- | --- |\n| A | **B** |\n\n---\n\n    indented code\n\n```js\nconsole.log("ok")\n```\n\n![remote](https://example.test/a.png) ![forged](img_secret)\n\n<at user_id="all">everyone</at> <script>alert(1)</script> [bad](javascript:alert)\n\n```mermaid\ngraph TD; A-->B\n```';
  const out = feishuMarkdown(sample, 'https://console.example.test');
  for (const part of ['# Title', '**bold** *italic* ~~removed~~ `code`', 'https://console.example.test/#/board', '> quoted', '1. first', '- nested', '[x] done', '| Name | Value |', '| A | **B** |', '```\nindented code', '```js\nconsole.log("ok")', '流程图源码']) assert.ok(out.includes(part), part + '\n' + out);
  assert.ok(!out.includes('<at')); assert.ok(!out.includes('<script')); assert.ok(!out.includes('javascript:')); assert.ok(!out.includes('](img_secret)')); assert.ok(!out.includes('![remote]'));
  assert.match(out, /图片：remote/);
});

test('long UTF-8 replies are complete, split below the serialized post request budget and do not split surrogate pairs', () => {
  const value = ('段落 😀 **完整内容**\n\n').repeat(5000) + 'FINAL-TAIL';
  const posts = markdownPosts(value);
  assert.ok(posts.length > 5);
  for (const content of posts) assert.ok(Buffer.byteLength(JSON.stringify({ receive_id: 'oc_destination', msg_type: 'post', content: JSON.stringify(content), uuid: 'x'.repeat(50) })) < 30000);
  const text = posts.map(p => p.zh_cn.content[0][0].text).join('\n\n');
  assert.equal(text, feishuMarkdown(value)); assert.ok(!text.includes('\ufffd')); assert.ok(text.endsWith('FINAL-TAIL'));
  const huge = '```\n' + '单'.repeat(30000) + '\n```';
  assert.equal(markdownPosts(huge).map(p => p.zh_cn.content[0][0].text).join(''), feishuMarkdown(huge));
});

test('post ingress keeps styles, paragraphs, code, links, mentions and content_v2 image references', () => {
  const post = { zh_cn: { title: 'Title', content: [[{ tag: 'text', text: ' important ', style: ['bold', 'italic', 'lineThrough'] }, { tag: 'a', href: 'https://example.test', text: 'link' }, { tag: 'at', user_id: '@_user_1' }], [{ tag: 'code_block', language: 'js', text: 'a()' }], [{ tag: 'hr' }], [{ tag: 'md', text: '| A | B |\n| --- | --- |\n| 1 | 2 |\n![one](img_v3_one)' }], [{ tag: 'img', image_key: 'img_v3_two' }, { tag: 'img', image_key: 'img_v3_two' }]] } };
  const text = postText(post);
  for (const part of ['Title\n', '**', '~~important~~', '[link](https://example.test/)', '@_user_1', '````js\na()\n````', '\n---\n', '| A | B |', '[图片]']) assert.ok(text.includes(part), text);
  assert.deepEqual(incomingFiles('post', JSON.stringify(post)).map(f => f.key), ['img_v3_one', 'img_v3_two']);
  assert.deepEqual(incomingFiles('file', '{"file_key":"../../outside"}'), []);
  assert.ok(!safeFilename('../../a\u0000\n\\b.txt').includes('/'));
});

test('a bound private chat reads real file bytes and sends a rich reply with multiple native files through the management assistant', async t => {
  const f = await channelFixture(t); let seen = '';
  f.wire.state.resources.set('file_notes', { data: Buffer.from('Actual inbound contents: verified 42.\n'), mime: 'text/plain' });
  f.modelState.respond = async (body, res) => {
    const observations = results(body), step = observations.length;
    if (!step) return call(res, 'list_message_resources', {});
    if (step === 1) { seen = observations[0].resources[0].resource_id; assert.ok(!JSON.stringify(observations).includes('file_notes')); return call(res, 'read_message_resource', { resource_id: seen }); }
    if (step === 2) { assert.match(observations[1].text, /verified 42/); return call(res, 'attach_message_resource', { resource_id: seen }); }
    if (step === 3) return call(res, 'create_reply_file', { name: '../result.txt', content: 'Processed actual input: 42' });
    return say(res, '# Result\n\n**42** is verified.\n\n| Item | Result |\n| --- | --- |\n| input | readable |');
  };
  const event = fileEvent('file_notes'), receipt = await post(f.h, f.id, event), source = receipt.value.operation_id;
  assert.equal((await finished(f.h, source)).state, 'completed'); await delivered(f, source);
  assert.equal(f.wire.state.resourceRequests.length, 1);
  assert.match(f.wire.state.resourceRequests[0].url, new RegExp('/' + event.event.message.message_id + '/resources/file_notes\\?type=file$'));
  assert.equal(f.wire.sent[0].msg_type, 'post'); assert.match(f.wire.sent[0].content.zh_cn.content[0][0].text, /\*\*42\*\*/);
  assert.deepEqual(f.wire.sent.map(s => s.msg_type), ['post', 'file', 'file']);
  assert.deepEqual(f.wire.state.uploads.map(u => u.data.toString()), ['Actual inbound contents: verified 42.\n', 'Processed actual input: 42']);
  assert.ok(f.wire.sent.every(s => s.receive_id === 'oc_private'));
  assert.ok(f.wire.state.uploads.every(u => !u.name.includes('/')));
  const resource = f.h.store.get('SELECT * FROM channel_resources WHERE id=?', seen);
  assert.ok(!resource.payload.includes('verified 42')); assert.ok(!JSON.stringify(f.requests).includes('fixture-feishu-app-secret'));
  const local = (await f.admin('/api/channels/chats/' + resource.chat_id + '/messages')).value;
  assert.equal(local.messages[0].resources[0].state, 'ready'); assert.ok(!JSON.stringify(local).includes('file_notes'));
});

test('a bound group inspects a real post image through the model and sends previews and files in the source thread', async t => {
  const f = await channelFixture(t), chat = await group(f); let ids;
  for (const key of ['img_v3_one', 'img_v3_two']) f.wire.state.resources.set(key, { data: png, mime: 'image/png' });
  f.modelState.respond = async (body, res) => {
    const observations = results(body), step = observations.length;
    if (!step) return call(res, 'list_message_resources', {});
    if (step === 1) { ids = observations[0].resources.map(r => r.resource_id); assert.equal(ids.length, 2); return call(res, 'view_message_image', { resource_id: ids[0] }); }
    if (step === 2) {
      const image = body.messages.find(m => Array.isArray(m.content))?.content.find(p => p.type === 'image_url');
      assert.equal(image.image_url.url, 'data:image/png;base64,' + png.toString('base64'));
      return call(res, 'attach_message_resource', { resource_id: ids[0] });
    }
    if (step === 3) return call(res, 'attach_message_resource', { resource_id: ids[1] });
    if (step === 4) return call(res, 'create_reply_file', { name: 'report.md', content: '# Two image resources inspected through the supported input path' });
    return say(res, '**Image received**\n\n- [x] available\n\n```txt\nfixture pixels\n```');
  };
  const event = inGroup(''), message = event.event.message;
  Object.assign(message, { message_type: 'post', thread_id: 'omt_source', content: '{"text":"legacy lost structure"}', content_v2: JSON.stringify({ title: 'Inspect images', content: [[{ tag: 'md', text: 'A **styled** request' }], [{ tag: 'img', image_key: 'img_v3_one' }, { tag: 'img', image_key: 'img_v3_two' }]] }) });
  const receipt = await post(f.h, f.id, event), source = receipt.value.operation_id;
  assert.equal((await finished(f.h, source)).state, 'completed'); await delivered(f, source);
  assert.deepEqual(f.wire.sent.map(s => s.msg_type), ['post', 'image', 'image', 'file']);
  assert.ok(f.wire.sent.every(s => s.url.endsWith('/' + message.message_id + '/reply') && s.reply_in_thread));
  assert.equal(f.wire.state.uploads.filter(u => u.image).length, 2);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_messages WHERE chat_id=? AND sender_type='app'", chat.id).n, 4);
  assert.equal(new Set(f.wire.sent.map(s => s.uuid)).size, 4);
});

test('partial/ambiguous delivery survives a channel worker restart without resending successful parts; expired uncertainty fails closed', async t => {
  const f = await channelFixture(t); let fail = true;
  f.modelState.respond = async (body, res) => {
    const n = results(body).length;
    if (n < 2) return call(res, 'create_reply_file', { name: 'part-' + n + '.txt', content: 'Attachment number ' + n });
    return say(res, 'Send both files once.');
  };
  f.wire.state.mediaHandler = async url => {
    if (url.endsWith('/files') && f.wire.state.uploads.length === 2 && fail) { fail = false; return Response.json({ code: 999 }, { status: 503 }); }
  };
  const receipt = await post(f.h, f.id, envelope('Create two files')), source = receipt.value.operation_id;
  const retry = await until(() => f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', source), r => r?.state === 'retry');
  assert.deepEqual(f.wire.sent.map(s => s.msg_type), ['post', 'file']);
  f.service.close(); await f.service.drain();
  const reopened = new ChannelService(f.h.store, f.service.management, f.service.options); t.after(() => reopened.close());
  f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', retry.id);
  f.wire.state.lostSendResponses = 1; await reopened.tick();
  assert.equal(f.wire.sent.length, 3); assert.equal(f.h.store.get('SELECT state FROM channel_outbox WHERE id=?', retry.id).state, 'retry');
  const uploads = f.wire.state.uploads.length;
  f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', retry.id); await reopened.tick();
  assert.equal(f.h.store.get('SELECT state FROM channel_outbox WHERE id=?', retry.id).state, 'sent');
  assert.equal(f.wire.sent.length, 3); assert.equal(f.wire.state.uploads.length, uploads);
  assert.deepEqual(f.h.store.all('SELECT state FROM channel_outbox_parts WHERE outbox_id=?', retry.id).map(p => p.state), ['sent', 'sent', 'sent']);
  // A crash after remote acceptance and before the local receipt is indistinguishable after Feishu's one-hour window.
  f.h.store.run("UPDATE channel_outbox_parts SET state='sending',first_attempt=? WHERE outbox_id=? AND part=2", Date.now() - 3600001, retry.id);
  f.h.store.run("UPDATE channel_outbox SET state='retry',next_attempt=0 WHERE id=?", retry.id); await reopened.tick();
  assert.equal(f.h.store.get('SELECT last_error FROM channel_outbox WHERE id=?', retry.id).last_error, 'channel_delivery_unknown');
  assert.equal(f.wire.sent.length, 3); assert.equal(f.wire.state.uploads.length, uploads);
});

test('resources are isolated by chat, bounded on streaming download, and erased on recall and retention including delayed history', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  const event = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_local'));
  f.service.ledger.accept(event); const turn = localTurn(f, chat, event);
  const id = (await turn.execute('list_message_resources', {})).resources[0].resource_id;
  const other = await privateChat(f, 'ou_alice', f.principal, 'oc_other');
  const foreign = new MediaTurn(f.service.media, other.id, event.message_id, () => {}, {}, () => {});
  await assert.rejects(foreign.execute('read_message_resource', { resource_id: id }), /channel_resource_unavailable/);
  await assert.rejects(turn.execute('read_message_resource', { resource_id: 'https://internal.test/secret' }), /channel_resource_unavailable/);
  f.wire.state.mediaHandler = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(inboundBytes)); c.enqueue(new Uint8Array(1)); c.close(); } }), { headers: { 'Content-Type': 'application/octet-stream' } });
  await assert.rejects(turn.execute('read_message_resource', { resource_id: id }), /channel_resource_too_large/);
  assert.ok(!f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_resources WHERE id=?', id).payload, 'channel-resource:' + id).data);
  f.wire.state.mediaHandler = null; f.wire.state.resources.set('file_local', { data: Buffer.from('retained contents'), mime: 'text/plain' });
  assert.equal((await turn.execute('read_message_resource', { resource_id: id })).text, 'retained contents');
  f.service.ledger.accept({ ...event, kind: 'message_recalled', updated_at: Date.now() });
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE id=?', id).n, 0);
  await assert.rejects(turn.execute('read_message_resource', { resource_id: id }));
  f.service.ledger.accept(event); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE id=?', id).n, 0);
  const next = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_next')); f.service.ledger.accept(next);
  const current = f.h.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id);
  f.service.ledger.cleanup(chat.id, Date.now(), current.revision);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE chat_id=?', chat.id).n, 0);
});

test('missing resource scope is actionable and a recall racing a download cannot save or return its bytes', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  const event = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_scope')); f.service.ledger.accept(event);
  const turn = localTurn(f, chat, event), id = (await turn.execute('list_message_resources', {})).resources[0].resource_id;
  f.wire.state.mediaHandler = async () => Response.json({ code: 99991672 }, { status: 403 });
  await assert.rejects(turn.execute('read_message_resource', { resource_id: id }), /channel_resource_permission_required/);
  let release, started = false; const gate = new Promise(r => { release = r; });
  f.wire.state.mediaHandler = async () => { started = true; await gate; return new Response('late bytes', { headers: { 'Content-Type': 'text/plain' } }); };
  const read = turn.execute('read_message_resource', { resource_id: id });
  const rejected = assert.rejects(read); await until(() => started);
  f.service.ledger.accept({ ...event, kind: 'message_recalled', updated_at: Date.now() }); release(); await rejected;
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE id=?', id).n, 0);
});

test('real isolated workspace import/export preserves binary bytes, rejects unsafe paths/symlinks and rechecks project access', async t => {
  const f = await channelFixture(t), directory = mkdtempSync(join(tmpdir(), 'channel-computer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = new LocalManager('101', directory), store = f.h.store; let authorized = true;
  const project = selected => { assert.ok(authorized, 'access revoked'); assert.ok(['101', 'agent-test-zone/admin-fixture-101'].includes(selected)); return store.get('SELECT * FROM repositories WHERE id=?', '101'); };
  const computers = new ServiceComputers(store, manager, randomWorkspaceId(), 'media-test', new Redactor(), async () => { assert.ok(authorized, 'access revoked'); }, project);
  t.after(() => computers.close());
  assert.equal((await computers.importFile('101', 'input.png', png)).size, png.length);
  const file = await computers.exportFile('101', 'input.png', inboundBytes); assert.deepEqual(file.data, png); assert.equal(file.project, '101');
  for(const op of store.all('SELECT * FROM service_role_operations')){
    const saved=operationRequestText(store,'service_role_operations',op);
    assert.ok(!saved.includes('base64'));assert.ok(!saved.includes(png.toString('base64')));
    if(op.result)assert.ok(!JSON.stringify(operationResult(store,'service_role_operations',op)).includes('base64'));
  }
  await computers.execute('run_command', { repository: '101', command: 'ln -s input.png alias.png' });
  await assert.rejects(computers.exportFile('101', 'alias.png', inboundBytes), /channel_artifact_regular_file_required/);
  for (const path of ['/etc/passwd', '../outside', 'https://example.test/a']) await assert.rejects(computers.exportFile('101', path, inboundBytes));
  authorized = false; await assert.rejects(computers.exportFile('101', 'input.png', inboundBytes), /access revoked/);
});

test('a revoked group binding during upload blocks the image send and cross-project artifact selection is refused', async t => {
  const f=await channelFixture(t),chat=await group(f);
  f.wire.state.resources.set('img_revoke',{data:png,mime:'image/png'});
  f.modelState.respond=async(body,res)=>{
    const observed=results(body);
    if(!observed.length)return call(res,'list_message_resources',{});
    if(observed.length===1)return call(res,'attach_message_resource',{resource_id:observed[0].resources[0].resource_id});
    return say(res,'Image follows.');
  };
  f.wire.state.mediaHandler=async url=>{
    if(url.endsWith('/images'))f.h.store.run('UPDATE channel_service_bindings SET enabled=0,revision=revision+1 WHERE chat_id=?',chat.id);
  };
  const event=inGroup('');Object.assign(event.event.message,{message_type:'image',content:'{"image_key":"img_revoke"}'});
  const receipt=await post(f.h,f.id,event),source=receipt.value.operation_id;
  await until(()=>f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?',source),r=>r?.state==='failed');
  assert.ok(f.wire.sent.every(s=>s.msg_type!=='image'));
  const resource=f.h.store.get("SELECT * FROM channel_resources WHERE chat_id=? AND kind='incoming'",chat.id);
  f.h.store.run("UPDATE channel_resources SET kind='artifact',project_id='201',fence='scope' WHERE id=?",resource.id);
  const foreign=new MediaTurn(f.service.media,chat.id,event.event.message.message_id,()=>{},{},()=>{throw new Error('project out of scope');},undefined,'scope');
  await assert.rejects(foreign.execute('attach_message_resource',{resource_id:resource.id}),/project out of scope/);
});

test('unsupported binary/images and limits return explicit tool outcomes without fetching model-provided addresses', async t=>{
  const f=await channelFixture(t),chat=await privateChat(f);
  const event=f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_binary','oc_private','data.bin'));f.service.ledger.accept(event);
  const turn=localTurn(f,chat,event),id=(await turn.execute('list_message_resources',{})).resources[0].resource_id;
  f.wire.state.resources.set('file_binary',{data:Buffer.from([0,1,2,3]),mime:'application/octet-stream'});
  assert.equal((await turn.execute('read_message_resource',{resource_id:id})).error,'channel_binary_requires_computer');
  await assert.rejects(turn.execute('view_message_image',{resource_id:id}),/channel_image_format_unsupported/);
  assert.equal(f.wire.state.resourceRequests.length,1);
  for(let i=0;i<20;i++)await turn.execute('create_reply_file',{name:'report-'+i+'.txt',content:'text'});
  await assert.rejects(turn.execute('create_reply_file',{name:'overflow.txt',content:'text'}),/channel_attachment_limit/);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_resources WHERE kind='artifact'").n,20);
});

test('a legacy pending send retains its original interactive payload and UUID; historical metadata is materialized without a download',async t=>{
  const f=await channelFixture(t),chat=await privateChat(f);clearInterval(f.service.timer);
  const event=f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_historical'));f.service.ledger.accept(event);
  f.h.store.run('DELETE FROM channel_resources WHERE chat_id=?',chat.id);
  const local=f.service.ledger.query(chat.id,{message_id:event.message_id});
  assert.equal(local.messages[0].resources.length,1);assert.equal(f.wire.state.resourceRequests.length,0);
  const out=f.service.post(chat,'Legacy card','legacy-message','legacy-source',{});
  const row=f.h.store.get('SELECT * FROM channel_outbox WHERE id=?',out),payload=f.h.store.secrets.open(row.payload,'channel-outbox:'+out);
  // Unprotected informational card, as stored before the new parts table existed.
  delete payload.protection;
  delete payload.delivery.format_version;
  f.h.store.run("UPDATE channel_outbox SET attempts=1,state='retry',payload=?,next_attempt=0 WHERE id=?",f.h.store.secrets.seal(payload,'channel-outbox:'+out),out);
  await f.service.tick();
  assert.equal(f.wire.sent.length,1);assert.equal(f.wire.sent[0].msg_type,'interactive');assert.equal(f.wire.sent[0].uuid,digest(out).slice(0,50));
  // A new send interrupted before part initialization is still modern, even with attempts > 0.
  const modern=f.service.post(chat,'**Modern reply**','modern-message','modern-source',{}),current=f.h.store.get('SELECT * FROM channel_outbox WHERE id=?',modern);
  const queued=f.h.store.secrets.open(current.payload,'channel-outbox:'+modern);delete queued.protection;
  f.h.store.run("UPDATE channel_outbox SET attempts=1,state='retry',payload=?,next_attempt=0 WHERE id=?",f.h.store.secrets.seal(queued,'channel-outbox:'+modern),modern);
  await f.service.tick();assert.equal(f.wire.sent[1].msg_type,'post');
});

test('long private input is read from the ledger and a long rich reply reaches Feishu in order without truncation',async t=>{
  const f=await channelFixture(t),input='A'.repeat(20000)+'INPUT-TAIL',output=('**完整回答** 😀\n\n').repeat(5000)+'OUTPUT-TAIL';
  f.modelState.respond=async(body,res)=>{
    const seen=results(body);
    if(!seen.length){assert.match(JSON.parse(body.messages[1].content).request,/长消息/);return call(res,'read_message_text',{offset:20000});}
    assert.equal(seen[0].text,'INPUT-TAIL');return say(res,output);
  };
  const receipt=await post(f.h,f.id,envelope(input));await delivered(f,receipt.value.operation_id);
  const parts=f.wire.sent.map(s=>s.content.zh_cn.content[0][0].text);
  assert.ok(parts.length>5);assert.equal(parts.join('\n\n'),feishuMarkdown(output)+'\n\n[登录后台查看](https://console.example.test/#/management)');
  assert.ok(f.wire.sent.every(s=>s.msg_type==='post'));
});

test('a provider refusing image input gives an explicit image diagnostic instead of claiming the image was inspected',async t=>{
  const f=await channelFixture(t);f.wire.state.resources.set('img_no_vision',{data:png,mime:'image/png'});
  f.modelState.respond=async(body,res)=>{
    const seen=results(body);
    if(!seen.length)return call(res,'list_message_resources',{});
    if(seen.length===1)return call(res,'view_message_image',{resource_id:seen[0].resources[0].resource_id});
    res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'This model accepts text only'}}));
  };
  const event=envelope('',{message:{message_type:'image',content:'{"image_key":"img_no_vision"}'}}),receipt=await post(f.h,f.id,event),source=receipt.value.operation_id;
  assert.equal((await finished(f.h,source)).state,'failed');await delivered(f,source);
  assert.ok(JSON.stringify(f.wire.sent).includes('未能查看图片'));
  assert.equal(JSON.parse(f.h.store.get("SELECT data FROM management_events WHERE type='error' ORDER BY sequence DESC LIMIT 1").data).error,'channel_image_model_unsupported');
});
