import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { channelFixture, envelope, post, until, finished, privateChat, boundGroup, inGroup, shareAssistantModel } from '../../../fixtures/channel-fixture.mjs';
import { feishuMarkdown, markdownPosts, postText } from '../../../../dist/channels/format.js';
import { MediaTurn, artifactBytes, channelResourcePath, incomingFiles, inboundBytes, safeFilename, sweepOrphanChannelResources } from '../../../../dist/channels/media.js';
import { ChannelService } from '../../../../dist/channels/service.js';
import { AssistantComputerService } from '../../../../dist/service-roles/assistant-computers.js';
import { assistantManager } from '../../../fixtures/assistant-computer-fixture.mjs';
import { digest } from '../../../../dist/core/security.js';
import { RetentionCleanup } from '../../../../dist/storage/retention.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const say = (res, content) => answer(res, { role: 'assistant', content });
const answer = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const call = (res, name, args) => answer(res, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const results = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const delivered = (f, source) => until(() => f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', source), r => r && r.state === 'sent');
const fileEvent = (key, chat = 'oc_private', name = 'notes.txt') => envelope('', { message: { chat_id: chat, message_type: 'file', content: JSON.stringify({ file_key: key, file_name: name }) } });
async function group(f) {
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
  await f.admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: role.revision, model_id: f.assistantModel.id }); await shareAssistantModel(f);
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
  f.wire.state.mediaHandler = async () => {
    const mib = new Uint8Array(1024 * 1024);
    let sent = 0;
    return new Response(new ReadableStream({
      pull(c) {
        if (sent < inboundBytes) { c.enqueue(mib); sent += mib.length; }
        else if (sent === inboundBytes) { c.enqueue(new Uint8Array(1)); sent++; }
        else c.close();
      }
    }), { headers: { 'Content-Type': 'application/octet-stream' } });
  };
  await assert.rejects(turn.execute('read_message_resource', { resource_id: id }), /channel_resource_too_large/);
  assert.ok(!existsSync(channelResourcePath(f.h.store, id)));
  assert.ok(!f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_resources WHERE id=?', id).payload, 'channel-resource:' + id).data);
  f.wire.state.mediaHandler = null; f.wire.state.resources.set('file_local', { data: Buffer.from('retained contents'), mime: 'text/plain' });
  assert.equal((await turn.execute('read_message_resource', { resource_id: id })).text, 'retained contents');
  assert.ok(existsSync(channelResourcePath(f.h.store, id)));
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resource_data WHERE resource_id=?', id).n, 0);
  f.service.ledger.accept({ ...event, kind: 'message_recalled', updated_at: Date.now() });
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE id=?', id).n, 0);
  assert.ok(!existsSync(channelResourcePath(f.h.store, id)));
  await assert.rejects(turn.execute('read_message_resource', { resource_id: id }));
  f.service.ledger.accept(event); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE id=?', id).n, 0);
  // Retention removes messages strictly before its cutoff; fast storage may otherwise finish in the same millisecond.
  const retained = fileEvent('file_next'); retained.event.message.create_time = String(Date.now() - 1000);
  const next = f.service.adapter(f.service.connector(f.id)).normalize(retained); f.service.ledger.accept(next);
  const nextTurn = localTurn(f, chat, next), nextId = (await nextTurn.execute('list_message_resources', {})).resources[0].resource_id;
  f.wire.state.resources.set('file_next', { data: Buffer.from('cleanup target'), mime: 'text/plain' });
  assert.equal((await nextTurn.execute('read_message_resource', { resource_id: nextId })).text, 'cleanup target');
  assert.ok(existsSync(channelResourcePath(f.h.store, nextId)));
  const current = f.h.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id);
  f.service.ledger.cleanup(chat.id, Date.now(), current.revision);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resources WHERE chat_id=?', chat.id).n, 0);
  assert.ok(!existsSync(channelResourcePath(f.h.store, nextId)));
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
  assert.ok(!existsSync(channelResourcePath(f.h.store, id)));
});

test('the assistant computer imports and exports binary bytes in HOME and /tmp, refusing symlinks and host paths', async t => {
  const f = await channelFixture(t), m = await assistantManager(t), store = f.h.store; let authorized = true;
  const service = new AssistantComputerService(store, m.manager, m.homes);
  const computer = service.turn({ owner: { kind: 'group', subject: 'media-chat', tenant: '' }, turn: 'media-turn', fence: () => 'a'.repeat(64),
    check: () => { assert.ok(authorized, 'access revoked'); }, facts: () => ({ repositories: ['101'] }), commands: () => true, eligible: () => {} });
  for (const path of ['~/input.png', '/tmp/input.png']) {
    assert.equal((await computer.importFile(path, png)).size, png.length);
    const file = await computer.exportFile(path, inboundBytes); assert.deepEqual(file.data, png); assert.equal(file.name, 'input.png');
  }
  // The bytes travel to the computer in its own calls, never through a sealed tool receipt.
  assert.equal(store.get("SELECT count(*) n FROM service_role_operations").n, 0);
  await computer.execute('run_command', { command: 'ln -s input.png ~/alias.png && ln -s /tmp/input.png tmp-alias.png' });
  for (const path of ['~/alias.png', 'tmp-alias.png']) await assert.rejects(computer.exportFile(path, inboundBytes), /invalid_path|regular_file_required/, path);
  for (const path of ['/etc/passwd', '~/../outside', 'https://example.test/a', '~']) await assert.rejects(computer.exportFile(path, inboundBytes), undefined, path);
  authorized = false; await assert.rejects(computer.exportFile('/tmp/input.png', inboundBytes), /access revoked/);
  await computer.close();
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

test('encrypted file storage seals bytes with AAD and SHA-256, keeps SQLite clean, and reads legacy channel_resource_data rows', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  const eventA = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_alpha', 'oc_private', 'alpha.txt'));
  const eventB = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_beta', 'oc_private', 'beta.txt'));
  f.service.ledger.accept(eventA); f.service.ledger.accept(eventB);
  const turnA = localTurn(f, chat, eventA), turnB = localTurn(f, chat, eventB);
  const idA = (await turnA.execute('list_message_resources', {})).resources[0].resource_id;
  const idB = (await turnB.execute('list_message_resources', {})).resources[0].resource_id;
  f.wire.state.resources.set('file_alpha', { data: Buffer.from('secret-alpha-payload'), mime: 'text/plain' });
  f.wire.state.resources.set('file_beta', { data: Buffer.from('secret-beta-payload'), mime: 'text/plain' });

  assert.equal((await turnA.execute('read_message_resource', { resource_id: idA })).text, 'secret-alpha-payload');
  assert.equal((await turnB.execute('read_message_resource', { resource_id: idB })).text, 'secret-beta-payload');
  assert.equal(f.wire.state.resourceRequests.length, 2);
  // Second read hits disk cache, zero rows in SQLite channel_resource_data.
  assert.equal((await turnA.execute('read_message_resource', { resource_id: idA })).text, 'secret-alpha-payload');
  assert.equal(f.wire.state.resourceRequests.length, 2);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resource_data').n, 0);

  const fileA = channelResourcePath(f.h.store, idA), fileB = channelResourcePath(f.h.store, idB);
  const rawA = readFileSync(fileA);
  assert.equal(rawA.subarray(0, 4).toString(), 'SBX1');
  assert.ok(!rawA.includes(Buffer.from('secret-alpha-payload')));
  assert.equal(statSync(fileA).mode & 0o777, 0o600);

  // Artifact replies also seal to disk without touching channel_resource_data.
  const artifact = await turnA.execute('create_reply_file', { name: 'out.txt', content: 'artifact-body' });
  const artifactFile = channelResourcePath(f.h.store, artifact.resource_id);
  assert.ok(existsSync(artifactFile));
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resource_data').n, 0);
  assert.equal((await turnA.bytes(artifact.resource_id)).data.toString(), 'artifact-body');

  // Transplanting resource B's ciphertext onto resource A's path must fail AAD verification.
  const rawB = readFileSync(fileB);
  writeFileSync(fileA, rawB);
  await assert.rejects(turnA.execute('read_message_resource', { resource_id: idA }), /channel_resource_integrity/);
  // Bit flip in sealed ciphertext must fail GCM authentication.
  const tampered = Buffer.from(rawA); tampered[tampered.length - 1] ^= 0xff;
  writeFileSync(fileA, tampered);
  await assert.rejects(turnA.execute('read_message_resource', { resource_id: idA }), /channel_resource_integrity/);
  // Replacing the encrypted file with a symlink must be refused via O_NOFOLLOW.
  const linkTarget = join(dirname(fileA), 'outside.txt'); writeFileSync(linkTarget, rawA);
  writeFileSync(fileA, rawA);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(fileA); symlinkSync(linkTarget, fileA);
  await assert.rejects(turnA.execute('read_message_resource', { resource_id: idA }), /channel_resource_integrity/);
  unlinkSync(fileA); unlinkSync(linkTarget); writeFileSync(fileA, rawA);

  // Legacy SQLite channel_resource_data records (both incoming and artifact) stay readable without re-download.
  const legacyEvent = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_legacy', 'oc_private', 'legacy.txt'));
  f.service.ledger.accept(legacyEvent);
  const legacyTurn = localTurn(f, chat, legacyEvent);
  const legacyId = (await legacyTurn.execute('list_message_resources', {})).resources[0].resource_id;
  const legacyBytes = Buffer.from('legacy-sqlite-bytes');
  const legacySha = createHash('sha256').update(legacyBytes).digest('hex');
  const oldMeta = f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_resources WHERE id=?', legacyId).payload, 'channel-resource:' + legacyId);
  f.h.store.run('UPDATE channel_resources SET payload=? WHERE id=?',
    f.h.store.secrets.seal({ ...oldMeta, mime: 'text/plain', size: legacyBytes.length, sha256: legacySha, state: 'ready', error: null }, 'channel-resource:' + legacyId), legacyId);
  f.h.store.run('INSERT INTO channel_resource_data VALUES(?,?)', legacyId,
    f.h.store.secrets.seal({ data: legacyBytes.toString('base64') }, 'channel-resource-data:' + legacyId));
  assert.ok(!existsSync(channelResourcePath(f.h.store, legacyId)));
  const reqBefore = f.wire.state.resourceRequests.length;
  assert.equal((await legacyTurn.execute('read_message_resource', { resource_id: legacyId })).text, 'legacy-sqlite-bytes');
  assert.equal(f.wire.state.resourceRequests.length, reqBefore, 'legacy SQLite row read does not re-download');
  // Tampered legacy row fails with channel_resource_integrity.
  f.h.store.run('UPDATE channel_resource_data SET payload=? WHERE resource_id=?',
    f.h.store.secrets.seal({ data: Buffer.from('wrong-bytes').toString('base64') }, 'channel-resource-data:' + legacyId), legacyId);
  await assert.rejects(legacyTurn.execute('read_message_resource', { resource_id: legacyId }), /channel_resource_integrity/);
});

test('retention cleanup, transaction rollbacks, message edits and orphan sweep handle encrypted resource files safely', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  const now = Date.now(), oldTime = now - 10 * 86400_000;
  const oldEnvelope = fileEvent('file_old', 'oc_private', 'old.txt'); oldEnvelope.event.message.create_time = String(oldTime);
  const keepEnvelope = fileEvent('file_keep', 'oc_private', 'keep.txt'); keepEnvelope.event.message.create_time = String(now);
  const oldEv = f.service.adapter(f.service.connector(f.id)).normalize(oldEnvelope);
  const keepEv = f.service.adapter(f.service.connector(f.id)).normalize(keepEnvelope);
  f.service.ledger.accept(oldEv); f.service.ledger.accept(keepEv);
  f.wire.state.resources.set('file_old', { data: Buffer.from('expired-body'), mime: 'text/plain' });
  f.wire.state.resources.set('file_keep', { data: Buffer.from('active-body'), mime: 'text/plain' });

  const oldTurn = localTurn(f, chat, oldEv), keepTurn = localTurn(f, chat, keepEv);
  const oldId = (await oldTurn.execute('list_message_resources', {})).resources[0].resource_id;
  const keepId = (await keepTurn.execute('list_message_resources', {})).resources[0].resource_id;
  await oldTurn.execute('read_message_resource', { resource_id: oldId });
  const oldArtifact = await oldTurn.execute('create_reply_file', { name: 'old-art.txt', content: 'old-art' });
  await keepTurn.execute('read_message_resource', { resource_id: keepId });
  assert.ok(existsSync(channelResourcePath(f.h.store, oldId)));
  assert.ok(existsSync(channelResourcePath(f.h.store, oldArtifact.resource_id)));
  assert.ok(existsSync(channelResourcePath(f.h.store, keepId)));

  // A rolled-back transaction must NOT delete files scheduled via afterCommit.
  assert.throws(() => f.h.store.transaction(() => {
    f.service.ledger.accept({ ...keepEv, kind: 'message_recalled', updated_at: now + 1 });
    throw new Error('simulated_rollback');
  }), /simulated_rollback/);
  assert.ok(existsSync(channelResourcePath(f.h.store, keepId)), 'rolled-back recall kept file on disk');

  // Message edit removing an attachment deletes the stale encrypted file while preserving kept attachments.
  const editEnv = inGroup('');
  Object.assign(editEnv.event.message, {
    chat_id: 'oc_private', chat_type: 'p2p', message_type: 'post',
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'img', image_key: 'img_keep' }, { tag: 'img', image_key: 'img_drop' }]] } }),
  });
  const editEv = f.service.adapter(f.service.connector(f.id)).normalize(editEnv);
  f.service.ledger.accept(editEv);
  f.wire.state.resources.set('img_keep', { data: png, mime: 'image/png' });
  f.wire.state.resources.set('img_drop', { data: png, mime: 'image/png' });
  const editTurn = localTurn(f, chat, editEv);
  const [keepImg, dropImg] = (await editTurn.execute('list_message_resources', {})).resources.map(r => r.resource_id);
  await editTurn.bytes(keepImg); await editTurn.bytes(dropImg);
  assert.ok(existsSync(channelResourcePath(f.h.store, keepImg)));
  assert.ok(existsSync(channelResourcePath(f.h.store, dropImg)));
  f.service.ledger.accept({ ...editEv, updated_at: editEv.updated_at + 10, raw_content: JSON.stringify({ zh_cn: { content: [[{ tag: 'img', image_key: 'img_keep' }]] } }) });
  assert.ok(existsSync(channelResourcePath(f.h.store, keepImg)));
  assert.ok(!existsSync(channelResourcePath(f.h.store, dropImg)));

  // Scheduled retention cleanup deletes expired incoming + artifact files while preserving newer ones.
  const rev = f.h.store.get('SELECT revision FROM channel_chats WHERE id=?', chat.id).revision;
  f.service.ledger.retain(chat.id, 3, rev);
  f.service.historySync.close();
  // Run a fresh sync tick with history disabled (connector disabled won't sync history, retention still runs).
  const { ChannelHistorySync } = await import('../../../../dist/channels/history-sync.js');
  const sync = new ChannelHistorySync(f.h.store, f.service.ledger, (c, g) => f.service.adapter(c, g));
  f.h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', f.id);
  await sync.tick(now);
  f.h.store.run('UPDATE channel_connectors SET enabled=1 WHERE id=?', f.id);
  assert.ok(!existsSync(channelResourcePath(f.h.store, oldId)));
  assert.ok(!existsSync(channelResourcePath(f.h.store, oldArtifact.resource_id)));
  assert.ok(existsSync(channelResourcePath(f.h.store, keepId)));

  // Orphan sweep removes old unreferenced .enc/.tmp files and preserves live + fresh files.
  const orphanId = 'deadbeef'.repeat(6), orphanPath = channelResourcePath(f.h.store, orphanId);
  const freshOrphanId = 'cafebabe'.repeat(6), freshOrphanPath = channelResourcePath(f.h.store, freshOrphanId);
  const staleTmp = orphanPath + '.abcdef012345.tmp';
  mkdirSync(dirname(orphanPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(freshOrphanPath), { recursive: true, mode: 0o700 });
  writeFileSync(orphanPath, Buffer.from('stale-orphan'));
  writeFileSync(staleTmp, Buffer.from('stale-tmp'));
  writeFileSync(freshOrphanPath, Buffer.from('fresh-orphan'));
  const oldDate = new Date(now - 2 * 3600_000);
  utimesSync(orphanPath, oldDate, oldDate);
  utimesSync(staleTmp, oldDate, oldDate);
  const swept = sweepOrphanChannelResources(f.h.store, now, 3600_000);
  assert.equal(swept.count, 2); assert.equal(swept.failed, 0);
  assert.ok(!existsSync(orphanPath)); assert.ok(!existsSync(staleTmp));
  assert.ok(existsSync(freshOrphanPath), 'fresh file within grace window is preserved');
  assert.ok(existsSync(channelResourcePath(f.h.store, keepId)), 'live referenced file is preserved');

  // RetentionCleanup also runs the channel-resources orphan sweep.
  utimesSync(freshOrphanPath, oldDate, oldDate);
  const retention = new RetentionCleanup(f.h.store, undefined, { now: () => now });
  const pass = await retention.run();
  assert.equal(pass.channel_resources.count, 1);
  assert.ok(!existsSync(freshOrphanPath));
});

test('inbound limit aligns with Feishu 100 MiB while keeping outbound limits (10 MiB image -> file, 30 MiB file)', async t => {
  assert.equal(inboundBytes, 100 * 1024 * 1024);
  assert.equal(artifactBytes, 30 * 1024 * 1024);
  const f = await channelFixture(t), chat = await privateChat(f);
  const event = f.service.adapter(f.service.connector(f.id)).normalize(fileEvent('file_big', 'oc_private', 'large.bin'));
  f.service.ledger.accept(event);
  const turn = localTurn(f, chat, event);
  const id = (await turn.execute('list_message_resources', {})).resources[0].resource_id;

  // Content-Length above 100 MiB is rejected immediately.
  f.wire.state.mediaHandler = async () => new Response(new Uint8Array(1), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(inboundBytes + 1) } });
  await assert.rejects(turn.execute('read_message_resource', { resource_id: id }), /channel_resource_too_large/);
  assert.ok(!existsSync(channelResourcePath(f.h.store, id)));

  // An inbound file over the old 20 MiB cap (21 MiB) downloads, seals to disk (not SQLite), and reads back intact.
  const large = Buffer.alloc(21 * 1024 * 1024, 0x41);
  f.wire.state.mediaHandler = null;
  f.wire.state.resources.set('file_big', { data: large, mime: 'application/octet-stream' });
  const loaded = await turn.bytes(id);
  assert.equal(loaded.data.length, 21 * 1024 * 1024);
  assert.equal(loaded.image, false);
  assert.ok(existsSync(channelResourcePath(f.h.store, id)));
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_resource_data').n, 0);

  // Outbound image > 10 MiB automatically downgrades to file upload (image: false); > 30 MiB fails with 413.
  const bigPng = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
  const imgEvent = f.service.adapter(f.service.connector(f.id)).normalize(envelope('', { message: { chat_id: 'oc_private', message_type: 'image', content: '{"image_key":"img_large"}' } }));
  f.service.ledger.accept(imgEvent);
  const imgTurn = localTurn(f, chat, imgEvent), imgId = (await imgTurn.execute('list_message_resources', {})).resources[0].resource_id;
  f.wire.state.resources.set('img_large', { data: bigPng, mime: 'image/png' });
  const loadedImg = await imgTurn.bytes(imgId);
  assert.equal(loadedImg.mime, 'image/png');
  assert.equal(loadedImg.image, false, 'images over 10 MiB switch to file upload');
  await assert.rejects(f.service.adapter(f.service.connector(f.id)).upload(Buffer.alloc(30 * 1024 * 1024 + 1), 'too-big.bin', 'application/octet-stream', false), /channel_resource_too_large/);
});

test('bound group reads inbound interactive cards with embedded images and post media resources end-to-end', async t => {
  const f = await channelFixture(t); await group(f);
  f.wire.state.resources.set('img_card_chart', { data: png, mime: 'image/png' });
  f.wire.state.resources.set('file_post_vid', { data: Buffer.from('video-transcript-text'), mime: 'text/plain' });
  let seenPrompt = '', seenResources = [];
  f.modelState.respond = async (body, res) => {
    const observations = results(body), step = observations.length;
    if (!step) { seenPrompt = JSON.stringify(body.messages); return call(res, 'list_message_resources', {}); }
    if (step === 1) { seenResources = observations[0].resources; return call(res, 'view_message_image', { resource_id: seenResources[0].resource_id }); }
    return say(res, '已读取卡片表格与内嵌图片。');
  };
  const card = {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '发布告警卡片' }, subtitle: { tag: 'plain_text', content: '生产集群' } },
    body: {
      elements: [
        { tag: 'markdown', content: '**状态**：延迟升高\n![趋势图](img_card_chart)' },
        { tag: 'table', columns: [{ name: 'svc', display_name: '服务' }, { name: 'p99', display_name: 'P99' }], rows: [{ svc: 'gateway', p99: '420ms' }] },
        { tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '排查建议' } }, elements: [{ tag: 'markdown', content: '检查上游连接池' }] },
        { tag: 'button', text: { tag: 'plain_text', content: '查看面板' }, behaviors: [{ type: 'open_url', default_url: 'https://monitor.example.test/p99' }] },
      ],
    },
  };
  const event = inGroup('');
  Object.assign(event.event.message, { message_type: 'interactive', content: JSON.stringify(card) });
  const receipt = await post(f.h, f.id, event), source = receipt.value.operation_id;
  assert.equal((await finished(f.h, source)).state, 'completed'); await delivered(f, source);
  for (const expected of ['发布告警卡片', '生产集群', '延迟升高', '| 服务 | P99 |', '| gateway | 420ms |', '排查建议', '检查上游连接池', 'https://monitor.example.test/p99']) {
    assert.ok(seenPrompt.includes(expected), 'expected card text in model prompt: ' + expected);
  }
  assert.ok(!seenPrompt.includes('暂不支持的消息类型'));
  assert.equal(seenResources.length, 1);

  // Post embedded media resource extraction (file_key + image_key cover).
  const postEvent = inGroup('');
  Object.assign(postEvent.event.message, {
    message_type: 'post',
    content: JSON.stringify({ zh_cn: { title: '录屏反馈', content: [[{ tag: 'media', file_key: 'file_post_vid', image_key: 'img_card_chart', file_name: 'repro.mp4' }]] } }),
  });
  const normalizedPost = f.service.adapter(f.service.connector(f.id)).normalize(postEvent);
  const chat = f.service.ledger.accept(normalizedPost);
  const postTurn = localTurn(f, chat, normalizedPost);
  const postResources = (await postTurn.execute('list_message_resources', {})).resources;
  assert.equal(postResources.length, 2);
  assert.ok(postResources.some(r => r.name === 'repro.mp4'));
  assert.equal((await postTurn.execute('read_message_resource', { resource_id: postResources.find(r => r.name === 'repro.mp4').resource_id })).text, 'video-transcript-text');
});
