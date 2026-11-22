import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInteractiveCardAction,
  buildFeishuCard,
  FeishuCardTurn,
  renderFeishuCard,
  sanitizeCardMarkdown,
} from '../../../../dist/channels/cards.js';
import { cardText } from '../../../../dist/channels/format.js';

test('buildFeishuCard validates and compiles rich Card JSON 2.0 with table, chart, column_set, collapsible_panel, note and open_url', () => {
  const staged = buildFeishuCard({
    card: {
      header: {
        title: 'Multi-section Overview',
        subtitle: 'Updated just now',
        template: 'blue',
        text_tag_list: [{ text: 'Live', color: 'turquoise' }],
        icon: { tag: 'standard_icon', token: 'chart_outlined', color: 'blue' },
      },
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'bisect',
          columns: [
            { tag: 'column', width: 'weighted', weight: 1, background_style: 'grey-100', elements: [{ tag: 'markdown', content: '**Open**\n12' }] },
            { tag: 'column', width: 'weighted', weight: 1, background_style: 'grey-100', elements: [{ tag: 'markdown', content: '**Closed**\n34' }] },
          ],
        },
        {
          tag: 'table',
          page_size: 5,
          row_height: 'low',
          freeze_first_column: true,
          columns: [
            { name: 'item', display_name: 'Item', data_type: 'lark_md', width: 'auto' },
            { name: 'state', display_name: 'State', data_type: 'options', width: '100px' },
            { name: 'score', display_name: 'Score', data_type: 'number', format: { precision: 1 } },
            { name: 'when', display_name: 'Date', data_type: 'date', date_format: 'YYYY-MM-DD' },
          ],
          rows: [
            { item: '[#42](/#/tasks/42)', state: [{ text: 'Ready', color: 'green' }], score: 98.5, when: '2026-11-22T00:00:00Z' },
          ],
        },
        {
          tag: 'chart',
          aspect_ratio: '16:9',
          color_theme: 'brand',
          chart_spec: {
            type: 'bar',
            title: { text: 'Distribution' },
            data: { values: [{ k: 'A', v: 10 }, { k: 'B', v: 20 }] },
            xField: 'k',
            yField: 'v',
          },
        },
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: 'Extra notes' },
          elements: [
            { tag: 'markdown', content: 'Detail line with [link](https://github.com/acme/repo)' },
            { tag: 'button', text: 'Open Console', type: 'primary', url: '/#/management' },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: 'Footer hint' }] },
      ],
    },
  }, { origin: 'https://console.example.test' });

  assert.equal(staged.interactive, false);
  assert.equal(staged.rendered.schema, '2.0');
  assert.equal(staged.rendered.config.update_multi, true);
  assert.equal(staged.rendered.config.width_mode, 'fill');
  assert.ok(staged.bytes > 0 && staged.bytes <= 28000);
  assert.ok(staged.element_count > 0 && staged.element_count <= 190);
  const body = staged.rendered.body.elements;
  assert.equal(body[1].tag, 'table');
  assert.equal(body[1].rows[0].item, '[#42](https://console.example.test/#/tasks/42)');
  assert.equal(body[2].tag, 'chart');
  assert.equal(body[3].elements[1].behaviors[0].default_url, 'https://console.example.test/#/management');
  assert.equal(body[4].tag, 'markdown');
  assert.equal(body[4].text_size, 'notation');
  assert.match(cardText(staged.rendered), /Multi-section Overview/);
  assert.match(cardText(staged.rendered), /\[图表：Distribution\]/);
});

test('buildFeishuCard blocks unsafe URLs, forged img_key, raw callbacks, nested tables, bad charts and size overflows', () => {
  const expectError = (args, code) => {
    assert.throws(() => buildFeishuCard(args, { origin: 'https://console.example.test' }), err => err.code === code, `expected ${code}`);
  };

  expectError({ card: { elements: [{ tag: 'button', text: 'Bad', url: 'javascript:alert(1)' }] } }, 'card_url_not_allowed');
  expectError({ card: { elements: [{ tag: 'button', text: 'Creds', url: 'https://user:pass@example.com' }] } }, 'card_url_not_allowed');
  expectError({ card: { elements: [{ tag: 'button', text: 'Hook', behaviors: [{ type: 'callback', value: { evil: 1 } }] }] } }, 'card_callback_not_allowed');
  expectError({ card: { elements: [{ tag: 'select_static', options: [] }] } }, 'card_callback_not_allowed');
  expectError({ card: { elements: [{ tag: 'img', img_key: 'img_v2_forged' }] } }, 'card_img_key_forbidden');
  expectError({ card: { header: { title: 'Hi', icon: { tag: 'custom_icon', img_key: 'img_v2_x' } }, elements: [{ tag: 'hr' }] } }, 'card_img_key_forbidden');
  expectError({
    card: {
      elements: [{
        tag: 'column_set',
        columns: [{ tag: 'column', elements: [{ tag: 'table', columns: [{ name: 'a' }], rows: [] }] }],
      }],
    },
  }, 'card_table_nesting_forbidden');
  expectError({
    card: {
      elements: Array.from({ length: 6 }, (_, i) => ({ tag: 'table', columns: [{ name: 'c' + i }], rows: [] })),
    },
  }, 'card_table_limit_exceeded');
  expectError({
    card: {
      elements: [{
        tag: 'chart',
        chart_spec: { type: 'bar', data: { values: [] }, bar: { style: { texture: 'circle' } } },
      }],
    },
  }, 'card_chart_invalid');
  expectError({
    card: {
      elements: [{
        tag: 'chart',
        chart_spec: { type: 'bar', data: { values: [] }, fill: { gradient: 'conical' } },
      }],
    },
  }, 'card_chart_invalid');
  expectError({
    card: {
      elements: [{
        tag: 'chart',
        chart_spec: { type: 'bar', data: { values: [{ x: '<svg onload=1>' }] } },
      }],
    },
  }, 'card_chart_invalid');
  expectError({
    card: {
      elements: Array.from({ length: 4 }, () => ({ tag: 'markdown', content: 'A'.repeat(10000) })),
    },
  }, 'card_size_exceeded');

  const md = sanitizeCardMarkdown('![secret](img_v2_abc) ![titled](img_v2_def "t") [bad](javascript:x) [ok](https://example.com) <img src="x"> <at id=all></at> <font color="red">hi</font>');
  assert.ok(!md.includes('img_v2_abc'));
  assert.ok(!md.includes('img_v2_def'));
  assert.ok(!md.includes('javascript:'));
  assert.ok(!md.includes('<at '));
  assert.match(md, /\[ok\]\(https:\/\/example\.com\/\)/);
  assert.match(md, /&lt;img/);
  assert.match(md, /&lt;at id=all&gt;/);
  assert.match(md, /<font color='red'>hi<\/font>/);

  // paginated_list title, empty_text, item title, badges and footerNote must never leak forged img_key or raw <at> tags
  const forged = buildFeishuCard({
    card: {
      elements: [{
        tag: 'paginated_list',
        id: 'l',
        display: 'items',
        title: '![forged](img_v2_secret_key) <at id=all></at>',
        empty_text: '![empty](img_v2_empty) <at id=all></at>',
        items: [{
          title: '![item](img_v2_other) <at id=all></at>',
          content: 'OK',
          badges: [
            { text: '<at id=all></at>', color: 'blue' },
            { text: '![b](img_v2_badge)', color: 'red' },
          ],
        }],
      }],
    },
  });
  const renderedForged = renderFeishuCard(forged.spec, forged.state, 'b'.repeat(48), {
    footerNote: '定时任务「<at id=all></at> ![x](img_v2_footer)」',
  });
  const serializedForged = JSON.stringify(renderedForged.card);
  assert.ok(!serializedForged.includes('img_v2_'), serializedForged);
  assert.ok(!serializedForged.includes('<at '), serializedForged);

  const emptyList = buildFeishuCard({
    card: {
      elements: [{
        tag: 'paginated_list',
        id: 'e',
        display: 'items',
        empty_text: '![empty](img_v2_empty) <at id=all></at>',
        items: [],
      }],
    },
  });
  const renderedEmpty = renderFeishuCard(emptyList.spec, emptyList.state, 'c'.repeat(48));
  const serializedEmpty = JSON.stringify(renderedEmpty.card);
  assert.ok(!serializedEmpty.includes('img_v2_'), serializedEmpty);
  assert.ok(!serializedEmpty.includes('<at '), serializedEmpty);
});

test('interactive card engine supports views, paginated_list filtering/paging, followup actions and redaction', () => {
  const redactor = s => s.replace(/TOP_SECRET_TOKEN/g, '[REDACTED]');
  const turn = new FeishuCardTurn('https://console.example.test', redactor);
  const res = turn.execute({
    card: {
      header: { title: 'Items for TOP_SECRET_TOKEN', template: 'indigo' },
      elements: [{ tag: 'markdown', content: 'Shared banner' }],
      default_view: 'list',
      views: [
        {
          id: 'list',
          label: 'List',
          elements: [{
            tag: 'paginated_list',
            id: 'entries',
            title: 'Entries',
            display: 'table',
            page_size: 2,
            filters: [{ field: 'status', label: 'Status' }],
            columns: [
              { name: 'name', display_name: 'Name', data_type: 'text' },
              { name: 'status', display_name: 'Status', data_type: 'options' },
            ],
            items: [
              { name: 'Alpha TOP_SECRET_TOKEN', status: [{ text: 'Open', color: 'blue' }] },
              { name: 'Beta', status: [{ text: 'Done', color: 'green' }] },
              { name: 'Gamma', status: [{ text: 'Open', color: 'blue' }] },
            ],
          }],
        },
        {
          id: 'chart',
          label: 'Chart',
          elements: [{
            tag: 'chart',
            chart_spec: { type: 'pie', data: { values: [{ k: 'Open', v: 2 }, { k: 'Done', v: 1 }] }, categoryField: 'k', valueField: 'v' },
          }],
        },
      ],
      actions: [
        { id: 'refresh', label: 'Refresh', prompt: 'Re-check latest TOP_SECRET_TOKEN state', type: 'primary' },
      ],
    },
  });

  assert.equal(res.staged, true);
  assert.equal(res.interactive, true);
  assert.ok(!JSON.stringify(turn.staged).includes('TOP_SECRET_TOKEN'));

  const cardId = 'a'.repeat(48);
  let state = turn.staged.state;
  const page1 = renderFeishuCard(turn.staged.spec, state, cardId);
  assert.equal(page1.card.body.elements.find(e => e.tag === 'table').rows.length, 2);

  // Page next
  const next = applyInteractiveCardAction(turn.staged.spec, state, cardId, 'p:entries:next');
  assert.equal(next.kind, 'update');
  state = next.nextState;
  const page2 = renderFeishuCard(turn.staged.spec, state, cardId);
  assert.equal(page2.card.body.elements.find(e => e.tag === 'table').rows.length, 1);
  assert.equal(page2.card.body.elements.find(e => e.tag === 'table').rows[0].name, 'Gamma');

  // Filter by status=Open resets to page 0 and keeps Alpha & Gamma
  const filtered = applyInteractiveCardAction(turn.staged.spec, state, cardId, 'f:entries:status', 'Open');
  assert.equal(filtered.kind, 'update');
  state = filtered.nextState;
  const filteredRender = renderFeishuCard(turn.staged.spec, state, cardId);
  const filteredRows = filteredRender.card.body.elements.find(e => e.tag === 'table').rows;
  assert.deepEqual(filteredRows.map(r => r.name), ['Alpha [REDACTED]', 'Gamma']);

  // Invalid filter option rejected
  const badFilter = applyInteractiveCardAction(turn.staged.spec, state, cardId, 'f:entries:status', 'InjectedOption');
  assert.equal(badFilter.kind, 'invalid');

  // Switch view to chart
  const switched = applyInteractiveCardAction(turn.staged.spec, state, cardId, 'v:chart');
  assert.equal(switched.kind, 'update');
  state = switched.nextState;
  const chartRender = renderFeishuCard(turn.staged.spec, state, cardId);
  assert.ok(chartRender.card.body.elements.some(e => e.tag === 'chart'));
  assert.ok(!chartRender.card.body.elements.some(e => e.tag === 'table'));

  // Follow-up action returns sanitized prompt
  const follow = applyInteractiveCardAction(turn.staged.spec, state, cardId, 'a:refresh');
  assert.equal(follow.kind, 'followup');
  assert.equal(follow.prompt, 'Re-check latest [REDACTED] state');

  // Clearing staged card works
  assert.equal(turn.execute({ clear: true }).cleared, true);
  assert.equal(turn.staged, null);
});
