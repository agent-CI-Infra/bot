import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { ChannelLedger } from '../../../../dist/channels/ledger.js';
import {
  formatReplyTargetObservation,
  messageRelationFields,
  ReplyTargetTurn,
  resolveReplyTarget,
  revalidateReplyTarget,
} from '../../../../dist/channels/reply-target.js';
import { FeishuCardTurn } from '../../../../dist/channels/cards.js';
import { stageMessage } from '../../../../dist/service-roles/stage-messages.js';

function createLedgerFixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 7));
  const ledger = new ChannelLedger(store);
  t.after(() => store.close());
  store.run(`INSERT INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at)
    VALUES('conn','feishu','cli_app','tenant','ou_bot','enterprise','http','cred',1,1,0)`);
  const baseEvent = (chatId = 'oc_main', overrides = {}) => ({
    provider: 'feishu', connector_id: 'conn', connector_revision: 1, app_id: 'cli_app', installation_tenant: 'tenant',
    actor_tenant: 'tenant', actor_id: 'ou_alice', chat_id: chatId, chat_type: 'group', kind: 'message',
    event_id: 'ev_' + Math.random(), message_id: 'om_' + Math.random(), thread_id: '', parent_id: '', root_id: '',
    content: 'hello', created_at: Date.now(), ...overrides,
  });
  const chat = ledger.chat(baseEvent('oc_main'));
  const otherChat = ledger.chat(baseEvent('oc_other'));
  const put = (targetChat, id, extra = {}) => ledger.merge(targetChat, {
    message_id: id, sender_id: 'ou_alice', sender_tenant: 'tenant', sender_type: 'user', message_type: 'text',
    created_at: extra.created_at ?? 1000, updated_at: extra.updated_at ?? extra.created_at ?? 1000,
    content: extra.content ?? id, raw_content: JSON.stringify({ text: extra.content ?? id }),
    parent_id: extra.parent_id ?? '', root_id: extra.root_id ?? '', thread_id: extra.thread_id ?? '',
    deleted: !!extra.deleted,
  }, 'live');
  return { store, ledger, chat, otherChat, put };
}

test('messageRelationFields omits empty values and mirrors non-empty parent_id as reply_to_message_id', () => {
  assert.deepEqual(messageRelationFields({ parent_id: '', root_id: '', thread_id: '' }), {});
  assert.deepEqual(messageRelationFields({ parent_id: ' om_p ', root_id: 'om_r', thread_id: 'omt_1' }), {
    parent_id: 'om_p',
    reply_to_message_id: 'om_p',
    root_id: 'om_r',
    thread_id: 'omt_1',
  });
});

test('resolveReplyTarget validates ownership, visibility, recall, sensitivity, card-act-*, and thread consistency', t => {
  const { store, chat, otherChat, put } = createLedgerFixture(t);
  put(chat, 'om_main', { created_at: 100 });
  put(chat, 'om_thread_root', { created_at: 200, thread_id: 'omt_a' });
  put(chat, 'om_thread_reply', { created_at: 210, parent_id: 'om_thread_root', root_id: 'om_thread_root', thread_id: 'omt_a' });
  put(chat, 'om_late_root', { created_at: 300 }); // Root existed before thread started
  put(chat, 'om_late_child', { created_at: 310, parent_id: 'om_late_root', root_id: 'om_late_root', thread_id: 'omt_b' });
  put(chat, 'om_recalled', { created_at: 400, deleted: true });
  put(chat, 'om_sensitive', { created_at: 410, content: '/confirm secret-token-value' });
  put(chat, 'om_recalled_root', { created_at: 500, thread_id: 'omt_c', deleted: true });
  put(chat, 'om_active_child', { created_at: 510, parent_id: 'om_recalled_root', root_id: 'om_recalled_root', thread_id: 'omt_c' });
  put(chat, 'om_dead_thread_msg', { created_at: 600, thread_id: 'omt_dead', deleted: true });
  put(chat, 'om_hidden_fence', { created_at: 700 });
  store.run('INSERT INTO channel_message_scopes VALUES(?,?,?,?)', chat.id, 'om_hidden_fence', 'binding:old', 'old-fence');
  put(otherChat, 'om_foreign', { created_at: 800, thread_id: 'omt_foreign' });

  // No fields -> main stream (null)
  assert.deepEqual(resolveReplyTarget(store, chat.id, {}), { target: null });
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_in_thread: false }), { target: null });

  // Quote reply vs thread reply by message_id
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_main' }), {
    target: { reply_to: 'om_main', reply_in_thread: false },
  });
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_main', reply_in_thread: true }), {
    target: { reply_to: 'om_main', reply_in_thread: true },
  });
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_thread_reply', reply_in_thread: true }), {
    target: { reply_to: 'om_thread_reply', reply_in_thread: true, thread_id: 'omt_a' },
  });
  // Explicit reply_in_thread: false (or omitted) on a thread message stays quote-reply without forcing thread
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_thread_reply' }), {
    target: { reply_to: 'om_thread_reply', reply_in_thread: false },
  });

  // Resolve by thread_id: prefers thread root, handles pre-thread root, skips recalled root
  assert.deepEqual(resolveReplyTarget(store, chat.id, { thread_id: 'omt_a' }), {
    target: { reply_to: 'om_thread_root', reply_in_thread: true, thread_id: 'omt_a' },
  });
  assert.deepEqual(resolveReplyTarget(store, chat.id, { thread_id: 'omt_b' }), {
    target: { reply_to: 'om_late_root', reply_in_thread: true, thread_id: 'omt_b' },
  });
  assert.deepEqual(resolveReplyTarget(store, chat.id, { thread_id: 'omt_c' }), {
    target: { reply_to: 'om_active_child', reply_in_thread: true, thread_id: 'omt_c' },
  });

  // Matching message_id + thread_id (both direct child and pre-thread root)
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_thread_reply', thread_id: 'omt_a' }), {
    target: { reply_to: 'om_thread_reply', reply_in_thread: true, thread_id: 'omt_a' },
  });
  assert.deepEqual(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_late_root', thread_id: 'omt_b' }), {
    target: { reply_to: 'om_late_root', reply_in_thread: true, thread_id: 'omt_b' },
  });

  // Error cases
  assert.equal(resolveReplyTarget(store, chat.id, { reply_in_thread: true }).error, 'invalid_reply_target');
  assert.equal(resolveReplyTarget(store, chat.id, { thread_id: 'omt_a', reply_in_thread: false }).error, 'reply_target_conflict');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_main', thread_id: 'omt_a' }).error, 'reply_target_conflict');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_thread_reply', thread_id: 'omt_b' }).error, 'reply_target_conflict');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'card-act-123' }).error, 'invalid_reply_target');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_missing' }).error, 'reply_target_not_found');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_foreign' }).error, 'reply_target_not_found');
  assert.equal(resolveReplyTarget(store, chat.id, { thread_id: 'omt_foreign' }).error, 'reply_target_not_found');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_recalled' }).error, 'reply_target_unavailable');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_sensitive' }).error, 'reply_target_unavailable');
  assert.equal(resolveReplyTarget(store, chat.id, { thread_id: 'omt_dead' }).error, 'reply_target_unavailable');
  assert.equal(resolveReplyTarget(store, chat.id, { reply_to_message_id: 'om_hidden_fence' }, { projects: ['binding:current'], fence: 'cur-fence' }).error, 'reply_target_not_found');
});

test('ReplyTargetTurn, FeishuCardTurn shortcut, stageMessage and revalidateReplyTarget maintain atomic state', async t => {
  const { store, chat, put } = createLedgerFixture(t);
  put(chat, 'om_1', { created_at: 100 });
  put(chat, 'om_t1', { created_at: 200, thread_id: 'omt_1' });
  put(chat, 'om_t2', { created_at: 210, parent_id: 'om_t1', root_id: 'om_t1', thread_id: 'omt_1' });

  const turn = new ReplyTargetTurn(store, chat.id);
  const card = new FeishuCardTurn('https://console.example.test', s => s, turn);
  const timerCard = new FeishuCardTurn('https://console.example.test', s => s);

  assert.equal(turn.execute({}).error, 'invalid_reply_target');
  assert.equal(turn.execute({ clear: true, reply_to_message_id: 'om_1' }).error, 'invalid_arguments');

  const setRes = turn.execute({ reply_to_message_id: 'om_1' });
  assert.equal(setRes.set, true);
  assert.deepEqual(setRes.reply_target, { reply_to_message_id: 'om_1', reply_in_thread: false });
  assert.deepEqual(turn.current, { reply_to: 'om_1', reply_in_thread: false });

  // Staging a card without target fields preserves prior set_reply_target
  const cardRes = card.execute({ card: { elements: [{ tag: 'markdown', content: 'Hello' }] } });
  assert.equal(cardRes.staged, true);
  assert.deepEqual(cardRes.reply_target, formatReplyTargetObservation(turn.current));

  // Invalid target on set_feishu_card fails atomically without replacing card or target
  const badTarget = card.execute({ card: { elements: [{ tag: 'markdown', content: 'New' }] }, reply_to_message_id: 'om_nope' });
  assert.equal(badTarget.error, 'reply_target_not_found');
  assert.match(card.staged.summary, /Hello/);
  assert.deepEqual(turn.current, { reply_to: 'om_1', reply_in_thread: false });

  // Invalid card with valid target shortcut fails atomically without mutating turn.current
  const badCard = card.execute({ card: { elements: [] }, thread_id: 'omt_1' });
  assert.equal(badCard.error, 'card_invalid');
  assert.deepEqual(turn.current, { reply_to: 'om_1', reply_in_thread: false });

  // Valid shortcut updates both card and shared ReplyTargetTurn
  const shortcut = card.execute({ card: { elements: [{ tag: 'markdown', content: 'Updated' }] }, thread_id: 'omt_1' });
  assert.equal(shortcut.staged, true);
  assert.deepEqual(shortcut.reply_target, { reply_to_message_id: 'om_t1', reply_in_thread: true, thread_id: 'omt_1' });
  assert.deepEqual(turn.current, { reply_to: 'om_t1', reply_in_thread: true, thread_id: 'omt_1' });

  // Timer FeishuCardTurn refuses reply target fields
  assert.equal(timerCard.execute({ card: { elements: [{ tag: 'markdown', content: 'Timer' }] }, thread_id: 'omt_1' }).error, 'invalid_arguments');

  // Clear resets target
  assert.equal(turn.execute({ clear: true }).cleared, true);
  assert.equal(turn.current, null);

  // stageMessage validates target before consuming a slot
  const posted = [];
  const badStage = await stageMessage({ text: '进度', reply_to_message_id: 'om_nope' }, 0, (text, seq, target) => posted.push({ text, seq, target }), s => s, 10, input => turn.resolve(input));
  assert.equal(badStage.error, 'reply_target_not_found');
  assert.equal(posted.length, 0);

  const okStage = await stageMessage({ text: '进度', thread_id: 'omt_1' }, 0, (text, seq, target) => posted.push({ text, seq, target }), s => s, 10, input => turn.resolve(input));
  assert.equal(okStage.sent, true);
  assert.deepEqual(okStage.reply_target, { reply_to_message_id: 'om_t1', reply_in_thread: true, thread_id: 'omt_1' });
  assert.deepEqual(posted[0].target, { reply_to: 'om_t1', reply_in_thread: true, thread_id: 'omt_1' });

  // revalidateReplyTarget re-anchors thread if original root is recalled, and falls back to undefined if non-thread target is recalled
  store.run("UPDATE channel_messages SET deleted=1 WHERE chat_id=? AND message_id='om_t1'", chat.id);
  assert.deepEqual(revalidateReplyTarget(store, chat.id, { reply_to: 'om_t1', reply_in_thread: true, thread_id: 'omt_1' }), {
    reply_to: 'om_t2', reply_in_thread: true, thread_id: 'omt_1',
  });
  store.run("UPDATE channel_messages SET deleted=1 WHERE chat_id=? AND message_id='om_1'", chat.id);
  assert.equal(revalidateReplyTarget(store, chat.id, { reply_to: 'om_1', reply_in_thread: false }), undefined);
});
