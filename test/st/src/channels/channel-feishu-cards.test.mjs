import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelFixture, envelope, post, until, finished, inGroup, boundGroup, privateChat, scriptedModel, cardEvent, repositoryAssistant,
} from '../../../fixtures/channel-fixture.mjs';

function interactiveClick(cardId, act, { message = 'remote-1', actor = 'ou_alice', chat = 'oc_group', option } = {}) {
  const e = envelope();
  e.header.event_type = 'card.action.trigger';
  e.event = {
    operator: { open_id: actor, tenant_key: 'actor-tenant' },
    context: { open_chat_id: chat, open_message_id: message },
    action: { tag: option !== undefined ? 'select_static' : 'button', value: { card: cardId, act }, ...(option !== undefined ? { option } : {}) },
  };
  return e;
}

const sampleRichCard = {
  card: {
    header: { title: '通用信息总览', subtitle: '结构化展示示例', template: 'blue', text_tag_list: [{ text: '实时', color: 'turquoise' }] },
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'bisect',
        columns: [
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**指标 A**\n10' }] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**指标 B**\n20' }] },
        ],
      },
      {
        tag: 'table',
        page_size: 5,
        freeze_first_column: true,
        columns: [
          { name: 'name', display_name: '条目', data_type: 'lark_md' },
          { name: 'status', display_name: '状态', data_type: 'options' },
        ],
        rows: [
          { name: '[任务 #1](https://github.com/acme/alpha/issues/1)', status: [{ text: '进行中', color: 'blue' }] },
        ],
      },
      {
        tag: 'chart',
        aspect_ratio: '16:9',
        chart_spec: {
          type: 'bar',
          title: { text: '分类分布' },
          data: { values: [{ cat: 'A', val: 10 }, { cat: 'B', val: 20 }] },
          xField: 'cat',
          yField: 'val',
        },
      },
      {
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: '补充说明' },
        elements: [{ tag: 'markdown', content: '详细说明与 [控制台链接](/#/management)' }],
      },
    ],
  },
};

test('group assistant reads feishu-cards skill, sends Card JSON 2.0, records readable timeline and degrades to post on HTTP 400 rejection', async t => {
  const f = await channelFixture(t);
  await repositoryAssistant(f);
  const group = await boundGroup(f, ['101'], 'oc_group_cards');

  // 1) Normal rich Card JSON 2.0 send + read_skill
  scriptedModel(f, [
    ['read_skill', { path: 'feishu-cards/SKILL.md' }],
    ['set_feishu_card', sampleRichCard],
    '已为你整理结构化卡片。',
  ]);
  const msg1 = inGroup('帮我整理一下当前状态', 'ou_alice');
  msg1.event.message.chat_id = 'oc_group_cards';
  const r1 = await post(f.h, f.id, msg1);
  assert.equal((await finished(f.h, r1.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 1);

  const sentCard = f.wire.sent[0];
  assert.equal(sentCard.msg_type, 'interactive');
  assert.equal(sentCard.content.schema, '2.0');
  assert.equal(sentCard.content.config.update_multi, true);
  assert.equal(sentCard.content.config.width_mode, 'fill');
  assert.equal(sentCard.content.header.title.content, '通用信息总览');
  assert.ok(sentCard.content.body.elements.some(e => e.tag === 'table'));
  assert.ok(sentCard.content.body.elements.some(e => e.tag === 'chart'));

  // Local ledger & console timeline parse Card JSON 2.0 via cardText
  const timeline = (await f.admin(`/api/channels/chats/${group.id}/timeline`)).value;
  const botMsg = timeline.messages.find(m => m.sender_type === 'app' && m.message_type === 'interactive');
  assert.ok(botMsg, 'bot card message should appear in ledger');
  assert.match(botMsg.content, /通用信息总览/);
  assert.match(botMsg.content, /\[图表：分类分布\]/);
  assert.match(botMsg.content, /任务 #1/);

  // 2) Graceful fallback to native post Markdown when Feishu rejects interactive card with HTTP 400 / 200860
  let rejectedOnce = false;
  f.wire.state.sendHandler = (_url, _init, req) => {
    if (req.msg_type === 'interactive' && !rejectedOnce) {
      rejectedOnce = true;
      return Response.json({ code: 200860, msg: 'Card content exceeds limit' }, { status: 400 });
    }
    return null;
  };
  scriptedModel(f, [
    ['set_feishu_card', { ...sampleRichCard, fallback_text: '降级后的完整 Markdown 内容' }],
    '卡片已准备。',
  ]);
  const msg2 = inGroup('再来一份状态卡', 'ou_alice');
  msg2.event.message.chat_id = 'oc_group_cards';
  const r2 = await post(f.h, f.id, msg2);
  assert.equal((await finished(f.h, r2.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 2);
  assert.equal(rejectedOnce, true);
  assert.equal(f.wire.sent[1].msg_type, 'post');
  assert.match(JSON.stringify(f.wire.sent[1].content), /降级后的完整 Markdown 内容/);
});

test('interactive card handles view switch, paginated_list filter/page, followup action, and authorization fences', async t => {
  const f = await channelFixture(t);
  await repositoryAssistant(f);
  const group = await boundGroup(f, ['101'], 'oc_group_interactive');

  scriptedModel(f, [
    ['set_feishu_card', {
      card: {
        header: { title: '交互式多视图卡片', template: 'indigo' },
        default_view: 'items',
        views: [
          {
            id: 'items',
            label: '明细列表',
            elements: [{
              tag: 'paginated_list',
              id: 'rows',
              title: '条目',
              display: 'table',
              page_size: 2,
              filters: [{ field: 'kind', label: '类型' }],
              columns: [
                { name: 'name', display_name: '名称', data_type: 'text' },
                { name: 'kind', display_name: '类型', data_type: 'options' },
              ],
              items: [
                { name: 'Item 1', kind: [{ text: 'A', color: 'blue' }] },
                { name: 'Item 2', kind: [{ text: 'B', color: 'green' }] },
                { name: 'Item 3', kind: [{ text: 'A', color: 'blue' }] },
              ],
            }],
          },
          {
            id: 'trend',
            label: '趋势图',
            elements: [{
              tag: 'chart',
              chart_spec: { type: 'line', data: { values: [{ d: '1', n: 3 }, { d: '2', n: 6 }] }, xField: 'd', yField: 'n' },
            }],
          },
        ],
        actions: [
          { id: 'refresh', label: '刷新数据', prompt: '请重新查询并刷新最新结果', type: 'primary' },
        ],
      },
    }],
    '交互卡片已发送。',
  ]);

  const msg = inGroup('给我发个可交互的汇总', 'ou_alice');
  msg.event.message.chat_id = 'oc_group_interactive';
  const r = await post(f.h, f.id, msg);
  assert.equal((await finished(f.h, r.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 1);

  const initial = f.wire.sent[0];
  assert.equal(initial.msg_type, 'interactive');
  const cardRow = f.h.store.get('SELECT * FROM channel_interactive_cards WHERE chat_id=?', group.id);
  assert.ok(cardRow && cardRow.remote_message_id === 'remote-1');

  // 1) Page next -> returns toast AND updated Card JSON 2.0 synchronously (no async PATCH wait)
  const pageRes = await post(f.h, f.id, interactiveClick(cardRow.id, 'p:rows:next', { message: 'remote-1', chat: 'oc_group_interactive' }));
  assert.equal(pageRes.status, 200);
  assert.equal(pageRes.value.toast.type, 'info');
  assert.match(pageRes.value.toast.content, /第 2 页/);
  assert.equal(pageRes.value.card.type, 'raw');
  assert.equal(pageRes.value.card.data.schema, '2.0');
  assert.equal(pageRes.value.card.data.body.elements.find(e => e.tag === 'table').rows[0].name, 'Item 3');
  assert.equal(f.wire.sent.filter(s => s.method === 'PATCH').length, 0);
  const ledgerAfterPage = f.service.ledger.query(group.id, { message_id: 'remote-1' }).messages[0];
  assert.match(ledgerAfterPage.content, /Item 3/);

  // 2) Filter via select_static option -> synchronous card response shows only kind=A rows
  const filterRes = await post(f.h, f.id, interactiveClick(cardRow.id, 'f:rows:kind', { message: 'remote-1', chat: 'oc_group_interactive', option: 'A' }));
  assert.equal(filterRes.value.toast.content, '类型：A');
  assert.equal(filterRes.value.card.type, 'raw');
  assert.deepEqual(filterRes.value.card.data.body.elements.find(e => e.tag === 'table').rows.map(r => r.name), ['Item 1', 'Item 3']);

  // 3) Switch view to trend via WebSocket long-connection path -> synchronous card response renders VChart
  f.h.store.run("UPDATE channel_connectors SET transport='websocket' WHERE id=?", f.id);
  const switchRes = f.service.receiveLongConnection(f.id, interactiveClick(cardRow.id, 'v:trend', { message: 'remote-1', chat: 'oc_group_interactive' }));
  f.h.store.run("UPDATE channel_connectors SET transport='http' WHERE id=?", f.id);
  assert.equal(switchRes.toast.content, '已切换至「趋势图」');
  assert.equal(switchRes.card.type, 'raw');
  assert.equal(switchRes.card.data.schema, '2.0');
  assert.ok(switchRes.card.data.body.elements.some(e => e.tag === 'chart'));
  assert.equal(f.wire.sent.filter(s => s.method === 'PATCH').length, 0);

  // 4) Follow-up action -> runs standard turn attributed to clicking user (ou_bob) and sends reply
  let seenFollowup = '';
  scriptedModel(f, [
    (_done, ctx) => { seenFollowup = ctx.request; return '已按你的点击重新查询完成。'; },
  ]);
  const followRes = await post(f.h, f.id, interactiveClick(cardRow.id, 'a:refresh', { message: 'remote-1', actor: 'ou_bob', chat: 'oc_group_interactive' }));
  assert.equal(followRes.value.toast.type, 'success');
  assert.match(followRes.value.toast.content, /刷新数据/);
  assert.equal(followRes.value.card, undefined);
  await until(() => f.wire.sent.some(s => s.msg_type === 'post' && JSON.stringify(s.content).includes('已按你的点击重新查询完成')));
  assert.equal(seenFollowup, '[卡片操作：刷新数据] 请重新查询并刷新最新结果');

  // 5) Authorization fence: disabling group binding invalidates old interactive card
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', group.id);
  const disable = await f.admin(`/api/channels/chats/${group.id}/service-binding`, 'PUT', {
    service_role_id: binding.service_role_id, scope: { kind: 'repositories', repositories: ['101'] }, enabled: false, expected_revision: binding.revision,
  });
  assert.equal(disable.status, 200);
  const blocked = await post(f.h, f.id, interactiveClick(cardRow.id, 'v:items', { message: 'remote-1', chat: 'oc_group_interactive' }));
  assert.equal(blocked.value.toast.type, 'error');
  assert.match(blocked.value.toast.content, /失效/);
  assert.equal(blocked.value.card, undefined);

  // 6) Legacy card tokens still resolve to channel_card_stale
  const legacy = await post(f.h, f.id, cardEvent('legacy-token', 'remote-legacy', 'ou_alice', 'oc_group_interactive'));
  assert.equal((await finished(f.h, legacy.value.operation_id)).error, 'channel_card_stale');
});

test('private chat supports rich interactive cards with owner isolation, Web console omits card tool, and schedules send cards directly', async t => {
  const f = await channelFixture(t);
  const chat = await privateChat(f, 'ou_alice', f.principal, 'oc_private_cards');

  // 1) Web console conversation does NOT expose set_feishu_card or feishu-cards skill
  let webTools = [];
  f.modelState.respond = async (body, res) => {
    webTools = body.tools.map(tool => tool.function.name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '网页回复。' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  };
  const conv = (await f.admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const webMsg = (await f.admin(`/api/management/conversations/${conv}/messages`, 'POST', { source_message: 'web-1', content: '你好' })).value;
  await until(async () => (await f.admin(`/api/management/conversations/${conv}`)).value.messages.find(m => m.id === webMsg.id)?.state === 'completed');
  assert.ok(!webTools.includes('set_feishu_card'));

  // 2) Feishu private chat exposes set_feishu_card and sends interactive Card JSON 2.0
  let p2pTools = [];
  f.modelState.respond = async (body, res) => {
    p2pTools = body.tools.map(tool => tool.function.name);
    const hasToolResult = body.messages.some(m => m.role === 'tool');
    const message = !hasToolResult
      ? {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'card-1', type: 'function',
            function: {
              name: 'set_feishu_card',
              arguments: JSON.stringify({
                card: {
                  header: { title: '私聊交互卡', template: 'green' },
                  views: [
                    { id: 'a', label: '视图A', elements: [{ tag: 'markdown', content: '内容A' }] },
                    { id: 'b', label: '视图B', elements: [{ tag: 'markdown', content: '内容B' }] },
                  ],
                },
              }),
            },
          }],
        }
      : { role: 'assistant', content: '已生成私聊卡片。' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  };
  const dm = envelope('发个私聊卡片', { sender: { sender_id: { open_id: 'ou_alice' } }, message: { chat_id: 'oc_private_cards', chat_type: 'p2p' } });
  const dmRes = await post(f.h, f.id, dm);
  assert.equal((await finished(f.h, dmRes.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 1);
  assert.ok(p2pTools.includes('set_feishu_card'));
  assert.equal(f.wire.sent[0].msg_type, 'interactive');
  assert.equal(f.wire.sent[0].content.schema, '2.0');

  const p2pCard = f.h.store.get('SELECT * FROM channel_interactive_cards WHERE chat_id=?', chat.id);
  assert.ok(p2pCard);

  // Another user (ou_bob) cannot interact with ou_alice's private card
  const stranger = await post(f.h, f.id, interactiveClick(p2pCard.id, 'v:b', { message: 'remote-1', actor: 'ou_bob', chat: 'oc_private_cards' }));
  assert.equal(stranger.value.toast.type, 'error');
  assert.match(stranger.value.toast.content, /无权/);

  // Owner (ou_alice) can switch views on their private card synchronously
  const ownerClick = await post(f.h, f.id, interactiveClick(p2pCard.id, 'v:b', { message: 'remote-1', actor: 'ou_alice', chat: 'oc_private_cards' }));
  assert.equal(ownerClick.value.toast.type, 'info');
  assert.equal(ownerClick.value.card.type, 'raw');
  assert.equal(ownerClick.value.card.data.schema, '2.0');
  assert.match(JSON.stringify(ownerClick.value.card.data), /内容B/);

  // Expired card (> 14 days) is rejected cleanly
  f.h.store.run('UPDATE channel_interactive_cards SET expires_at=? WHERE id=?', Date.now() - 1000, p2pCard.id);
  const expired = await post(f.h, f.id, interactiveClick(p2pCard.id, 'v:a', { message: 'remote-1', actor: 'ou_alice', chat: 'oc_private_cards' }));
  assert.equal(expired.value.card, undefined);
  assert.equal(expired.value.toast.type, 'warning');
  assert.match(expired.value.toast.content, /14 天/);

  // 3) Scheduled group task delivers staged Card JSON 2.0 directly with schedule footer note
  await repositoryAssistant(f);
  const group = await boundGroup(f, ['101'], 'oc_group_sched');
  const created = (await f.admin(`/api/channels/chats/${group.id}/schedules`, 'POST', {
    name: '定时检查', prompt: '生成状态卡', interval_minutes: 30, timezone: 'Asia/Shanghai',
  })).value;
  scriptedModel(f, [
    ['set_feishu_card', sampleRichCard],
    '定时检查完成。',
  ]);
  const sentBefore = f.wire.sent.length;
  const runRes = await f.admin(`/api/channels/schedules/${created.schedule.id}/run`, 'POST', {});
  assert.equal(runRes.status, 201);
  await until(() => f.wire.sent.length > sentBefore);
  const schedMsg = f.wire.sent.at(-1);
  assert.equal(schedMsg.msg_type, 'interactive');
  assert.equal(schedMsg.content.schema, '2.0');
  assert.match(JSON.stringify(schedMsg.content), /定时任务「定时检查」/);

  // 4) stay_silent discards a previously staged card during a timer run
  scriptedModel(f, [
    ['set_feishu_card', sampleRichCard],
    ['stay_silent', { reason: 'nothing to report after recheck' }],
  ]);
  const sentBeforeSilent = f.wire.sent.length;
  const silentRun = (await f.admin(`/api/channels/schedules/${created.schedule.id}/run`, 'POST', {})).value;
  await until(() => f.h.store.get('SELECT state FROM channel_schedule_runs WHERE id=?', silentRun.run.id)?.state === 'silent');
  assert.equal(f.wire.sent.length, sentBeforeSilent);

  // 5) Personal scheduled task delivers staged Card JSON 2.0 directly
  const pSched = (await f.admin(`/api/channels/chats/${chat.id}/schedules`, 'POST', {
    name: '私聊巡检', prompt: '发一张个人汇总卡', interval_minutes: 30, timezone: 'Asia/Shanghai',
  })).value;
  scriptedModel(f, [
    ['set_feishu_card', sampleRichCard],
    '个人巡检完成。',
  ]);
  const sentBeforePersonal = f.wire.sent.length;
  const pRun = await f.admin(`/api/channels/schedules/${pSched.schedule.id}/run`, 'POST', {});
  assert.equal(pRun.status, 201);
  await until(() => f.wire.sent.length > sentBeforePersonal);
  const pSchedMsg = f.wire.sent.at(-1);
  assert.equal(pSchedMsg.msg_type, 'interactive');
  assert.equal(pSchedMsg.content.schema, '2.0');
  assert.match(JSON.stringify(pSchedMsg.content), /定时任务「私聊巡检」/);
});
