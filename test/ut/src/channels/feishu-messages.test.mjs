import test from 'node:test';
import assert from 'node:assert/strict';
import { cardText, postText } from '../../../../dist/channels/format.js';
import { FeishuAdapter, messageText } from '../../../../dist/channels/feishu.js';
import { incomingFiles } from '../../../../dist/channels/media.js';

const mentions = [
  { key: '@_user_1', actor_id: 'ou_bot', name: 'HelperBot', is_self: true },
  { key: '@_user_2', actor_id: 'ou_alice', name: 'Alice', is_self: false },
];

test('interactive cards parse Card JSON 2.0, Card JSON 1.0, 2D received cards, wrapped cards, i18n and templates with embedded images', () => {
  const card2 = {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: '上线审批' },
      subtitle: { tag: 'plain_text', content: 'v2.3.0' },
      text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: 'P1' } }],
    },
    card_link: { url: 'https://ops.example.test/release/230' },
    body: {
      elements: [
        { tag: 'markdown', content: '请 @_user_1 和 @_user_2 复核\n![拓扑](img_v3_topo)' },
        {
          tag: 'column_set',
          columns: [
            { tag: 'column', elements: [{ tag: 'markdown', content: '**负责人**：Alice' }] },
            { tag: 'column', elements: [{ tag: 'img', img_key: 'img_v3_col', alt: { tag: 'plain_text', content: '变更图' } }] },
          ],
        },
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'plain_text', content: '回滚预案' } },
          elements: [{ tag: 'markdown', content: '执行 `rollback.sh`' }],
        },
        {
          tag: 'table',
          columns: [{ name: 'env', display_name: '环境' }, { name: 'status', display_name: '状态' }],
          rows: [{ env: 'staging', status: '通过' }, { env: 'prod', status: '待发布' }],
        },
        { tag: 'img_combination', img_list: [{ img_key: 'img_v3_c1' }, { img_key: 'img_v3_c2' }] },
        { tag: 'button', text: { tag: 'plain_text', content: '打开变更单' }, behaviors: [{ type: 'open_url', default_url: 'https://ops.example.test/cr/1' }] },
        { tag: 'button', text: { tag: 'plain_text', content: '危险链接' }, url: 'javascript:alert(1)' },
      ],
    },
  };
  const text2 = messageText('interactive', JSON.stringify(card2), mentions);
  for (const part of [
    '上线审批 [P1]', 'v2.3.0', '@HelperBot 和 @Alice', '**负责人**：Alice', '[图片：变更图]',
    '**回滚预案**', '执行 `rollback.sh`', '| 环境 | 状态 |', '| staging | 通过 |', '| prod | 待发布 |',
    '[图片组（2 张）]', '[打开变更单](https://ops.example.test/cr/1)', '[按钮：危险链接]', '[卡片链接](https://ops.example.test/release/230)',
  ]) assert.ok(text2.includes(part), `missing ${part} in:\n${text2}`);
  assert.ok(!text2.includes('javascript:'));
  assert.ok(!messageText('interactive', JSON.stringify(card2), mentions, true).includes('@HelperBot'));
  assert.deepEqual(incomingFiles('interactive', JSON.stringify(card2)).map(f => [f.type, f.key]), [
    ['image', 'img_v3_topo'], ['image', 'img_v3_col'], ['image', 'img_v3_c1'], ['image', 'img_v3_c2'],
  ]);

  // Card JSON 1.0 with div fields, extra image, note image and action multi_url.
  const card1 = {
    card: {
      header: { title: { tag: 'plain_text', content: '告警摘要' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '服务 **API** 异常' }, fields: [{ text: { tag: 'lark_md', content: '错误率：5%' } }], extra: { tag: 'img', img_key: 'img_v3_extra' } },
        { tag: 'note', elements: [{ tag: 'img', img_key: 'img_v3_note' }, { tag: 'plain_text', content: '自动巡检' }] },
        { tag: 'hr' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '日志' }, multi_url: { pc_url: 'https://logs.example.test/1' } }] },
      ],
    },
  };
  const text1 = cardText(card1);
  for (const part of ['告警摘要', '服务 **API** 异常', '错误率：5%', '[图片]', '自动巡检', '---', '[日志](https://logs.example.test/1)']) {
    assert.ok(text1.includes(part), text1);
  }
  assert.deepEqual(incomingFiles('interactive', JSON.stringify(card1)).map(f => f.key), ['img_v3_extra', 'img_v3_note']);

  // Simplified received interactive card with 2D elements array.
  const received2D = {
    title: '审批提醒',
    elements: [
      [{ tag: 'text', text: '申请人：' }, { tag: 'at', user_id: 'ou_alice', user_name: 'Alice' }, { tag: 'a', text: '详情', href: 'https://flow.example.test/9' }],
      [{ tag: 'img', image_key: 'img_v3_2d' }, { tag: 'button', text: '立即处理', url: 'https://flow.example.test/act' }],
    ],
  };
  const text2D = messageText('interactive', JSON.stringify(received2D), mentions);
  for (const part of ['审批提醒', '申请人：@Alice', '[详情](https://flow.example.test/9)', '[图片]', '[立即处理](https://flow.example.test/act)']) {
    assert.ok(text2D.includes(part), text2D);
  }
  assert.deepEqual(incomingFiles('interactive', JSON.stringify(received2D)).map(f => f.key), ['img_v3_2d']);

  // Card template fallback.
  const tpl = { type: 'template', data: { template_id: 'AAq123', template_variable: { title: '日报', count: 7 } } };
  const tplText = messageText('interactive', JSON.stringify(tpl));
  assert.match(tplText, /卡片模板：AAq123/); assert.match(tplText, /日报/); assert.match(tplText, /count: 7/);
});

test('post media and emotion, audio, media, merge_forward, share_chat, share_user, sticker, location, system and unknown types parse without unsupported placeholders', async () => {
  const richPost = {
    zh_cn: {
      title: '演示',
      content: [[
        { tag: 'text', text: '看视频 ' },
        { tag: 'media', file_key: 'file_v3_clip', image_key: 'img_v3_poster', file_name: 'clip.mp4' },
        { tag: 'emotion', emoji_type: 'THUMBSUP' },
      ]],
    },
  };
  const pText = postText(richPost);
  assert.ok(pText.includes('[视频附件：clip.mp4]'), pText);
  assert.ok(pText.includes('[表情：THUMBSUP]'), pText);
  assert.deepEqual(incomingFiles('post', JSON.stringify(richPost)), [
    { key: 'file_v3_clip', type: 'file', name: 'clip.mp4' },
    { key: 'img_v3_poster', type: 'image', name: 'media-cover-2' },
  ]);

  assert.equal(messageText('audio', JSON.stringify({ file_key: 'file_a', duration: 4200 })), '[语音附件（4秒）]');
  assert.equal(messageText('media', JSON.stringify({ file_key: 'file_v', image_key: 'img_v', file_name: 'demo.mp4', duration: 9800 })), '[视频附件：demo.mp4（10秒）]');
  assert.deepEqual(incomingFiles('media', JSON.stringify({ file_key: 'file_v', image_key: 'img_v', file_name: 'demo.mp4' })), [
    { key: 'file_v', type: 'file', name: 'demo.mp4' },
    { key: 'img_v', type: 'image', name: 'video-cover' },
  ]);

  // Official Feishu merge_forward plain string body must not throw.
  assert.equal(messageText('merge_forward', 'Merged and Forwarded Message'), '[合并转发消息]');
  const structuredForward = messageText('merge_forward', JSON.stringify({
    title: '事故复盘',
    messages: [{ msg_type: 'text', body: { content: JSON.stringify({ text: '根因已定位' }) } }],
  }));
  assert.match(structuredForward, /\[合并转发消息：事故复盘\]/);
  assert.match(structuredForward, /根因已定位/);

  assert.equal(messageText('share_chat', JSON.stringify({ chat_id: 'oc_123', name: '核心研发' })), '[分享群聊：核心研发（oc_123）]');
  assert.equal(messageText('share_chat', JSON.stringify({ chat_id: 'oc_123' })), '[分享群聊：oc_123]');
  assert.equal(messageText('share_user', JSON.stringify({ user_id: 'ou_999', name: 'Bob' })), '[分享联系人：Bob（ou_999）]');
  assert.equal(messageText('share_user', JSON.stringify({ user_id: 'ou_999' })), '[分享联系人：ou_999]');

  assert.equal(messageText('sticker', JSON.stringify({ file_key: 'sticker_1' })), '[表情包]');
  assert.deepEqual(incomingFiles('sticker', JSON.stringify({ file_key: 'sticker_1' })), []);

  assert.equal(
    messageText('location', JSON.stringify({ name: '总部大楼', address: '海淀区', latitude: '39.98', longitude: '116.31' })),
    '[位置：总部大楼 · 海淀区（39.98, 116.31）]',
  );

  assert.equal(
    messageText('system', JSON.stringify({
      template: '{from_user} 邀请 {to_chatters} 加入了群聊',
      from_user: ['张三'],
      to_chatters: ['李四', '王五'],
    })),
    '[系统消息] 张三 邀请 李四、王五 加入了群聊',
  );
  assert.equal(
    messageText('system', JSON.stringify({ divider_text: { text: 'New messages', i18n_text: { zh_cn: '以下是新消息' } } })),
    '[系统消息] 以下是新消息',
  );

  assert.equal(messageText('hongbao', JSON.stringify({ text: '恭喜发财' })), '[红包：恭喜发财]');
  assert.equal(messageText('share_calendar_event', JSON.stringify({ summary: '架构评审', start_time: '10:00', end_time: '11:00' })), '[日程：架构评审 10:00 - 11:00]');
  assert.equal(messageText('video_chat', JSON.stringify({ topic: '故障应急会' })), '[视频会议：故障应急会]');
  assert.equal(messageText('todo', JSON.stringify({ summary: '补齐压测报告' })), '[任务：补齐压测报告]');
  assert.equal(messageText('vote', JSON.stringify({ topic: '发布时间', options: ['今晚', '明早'] })), '[投票：发布时间；选项：今晚 / 明早]');

  // Unknown future type produces readable summary and extracts valid resource keys, never "暂不支持的消息类型".
  const unknownRaw = JSON.stringify({ title: '审批流', description: '待 @_user_2 确认', url: 'https://app.example.test/flow/7', image_key: 'img_v3_future', file_key: 'file_v3_future', file_name: 'spec.pdf' });
  const unknownText = messageText('custom_widget', unknownRaw, mentions);
  assert.ok(!unknownText.includes('暂不支持'));
  assert.match(unknownText, /\[custom_widget消息\]/);
  assert.ok(unknownText.includes('审批流'));
  assert.ok(unknownText.includes('待 @Alice 确认'));
  assert.ok(unknownText.includes('https://app.example.test/flow/7'));
  assert.deepEqual(incomingFiles('custom_widget', unknownRaw), [
    { key: 'img_v3_future', type: 'image', name: 'image-1' },
    { key: 'file_v3_future', type: 'file', name: 'spec.pdf' },
  ]);

  // Verify FeishuAdapter.normalize() and FeishuAdapter.history() accept merge_forward plain text & system & interactive cleanly.
  const connector = { id: 'c1', app_id: 'cli_test', installation_tenant: 't_install', bot_open_id: 'ou_bot', app_name: 'HelperBot', application_type: 'enterprise', revision: 1 };
  const adapter = new FeishuAdapter(connector, { app_secret: 'sec' }, async url => {
    if (String(url).includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'tok' });
    return Response.json({
      code: 0,
      data: {
        has_more: false,
        items: [
          { message_id: 'm_mf', msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' }, sender: { id: 'ou_alice', sender_type: 'user', tenant_key: 't_install' }, create_time: '1700000000000' },
          { message_id: 'm_sys', msg_type: 'system', body: { content: JSON.stringify({ template: '{from_user} 修改了群名称', from_user: ['Alice'] }) }, sender: { id: 'system', sender_type: 'app', tenant_key: 't_install' }, create_time: '1700000001000' },
          { message_id: 'm_card', msg_type: 'interactive', body: { content: JSON.stringify({ title: '巡检', elements: [[{ tag: 'text', text: '全部通过' }]] }) }, sender: { id: 'ou_bot2', sender_type: 'app', tenant_key: 't_install' }, create_time: '1700000002000' },
        ],
      },
    });
  });
  const liveEvent = adapter.normalize({
    header: { event_id: 'ev_mf', event_type: 'im.message.receive_v1', create_time: '1700000000000', app_id: 'cli_test', tenant_key: 't_install' },
    event: {
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 't_install' },
      message: { message_id: 'om_mf', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'merge_forward', content: 'Merged and Forwarded Message', create_time: '1700000000000' },
    },
  });
  assert.equal(liveEvent.content, '[合并转发消息]');

  const page = await adapter.history({ container_type: 'chat', container_id: 'oc_1', start_time: 0, end_time: 2000000000 });
  assert.deepEqual(page.items.map(i => i.content), ['[合并转发消息]', '[系统消息] Alice 修改了群名称', '巡检\n\n全部通过']);
});
