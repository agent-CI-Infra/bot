import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConsole} from './console-page.mjs';

// #643: the chart's axis is data a person reads as a number, so it has to be exact and readable: a token count is a
// whole number (abbreviated 万/亿 once it gets long), a cost keeps two decimals, and the top tick is never below the
// tallest bar. Before this the page printed `1,439,074.45` for tokens because the ceiling was `max * 1.1`.
const page = () => loadConsole(['static/app.js', 'static/metrics.js', 'static/costs.js'], () => [200, {}]);

const axisOf = (value, tokens) => page().run(`costAxis(${value},${tokens})`);

test('token axis labels are whole numbers, start at zero and reach the data', () => {
  const axis = axisOf(1439074.45, true);
  assert.equal(axis.labels.length, 5, 'four segments means five labels');
  assert.equal(axis.labels[0], '0');
  assert.ok(axis.ceiling >= 1439074.45, `ceiling ${axis.ceiling} covers the data`);
  for (const label of axis.labels) assert.ok(!label.includes('.'), `token label ${label} is whole`);
  const ticks = [...axis.ticks];
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b), 'ticks ascend');
  assert.equal(axis.labels.length, 5);
  // Long counts are abbreviated instead of being spelled out to six decimals.
  assert.match(axis.labels[1], /万$/);
});

test('cost axis keeps two decimals and every ceiling covers its maximum', () => {
  const cost = axisOf(1234.567, false);
  assert.equal(cost.labels.length, 5);
  // Two decimals, and a thousand separator once the amount is long enough to need one.
  for (const label of cost.labels) assert.match(label, /^(0|[1-9]\d{0,2}(,\d{3})*)\.\d{2}$/, `cost label ${label} has two decimals and no lost separator`);
  assert.ok(cost.ceiling >= 1234.567);
  // 1,500,000 used to render as 1500000.00: the separator is part of reading a large amount.
  const big = axisOf(1500000, false);
  assert.ok(big.labels.includes('1,500,000.00'), `big cost label reads 1,500,000.00, got ${big.labels.join(' | ')}`);
  assert.ok(!big.labels.includes('1500000.00'), 'no unseparated large amount');
  for (const value of [1, 3, 7, 42, 999, 12345, 987654, 1e9, 0.004]) {
    for (const tokens of [true, false]) {
      const axis = axisOf(value, tokens);
      assert.ok(axis.ceiling >= value, `${tokens ? 'token' : 'cost'} ceiling ${axis.ceiling} covers ${value}`);
      assert.equal(axis.labels.length, 5);
      if (tokens) for (const label of axis.labels) assert.ok(!label.includes('.'), `token label ${label} for ${value}`);
    }
  }
});

const unpriced = {from: '2026-11-10', to: '2026-11-11', currency: 'USD', collection_started_at: null,
  summary: {cost: 0, requests: 2, unpriced_requests: 2, usage_missing_requests: 0, input_tokens: 1400000, output_tokens: 39074, cached_input_tokens: 0},
  days: [{date: '2026-11-10', repository_id: '101', full_name: 'fixture/project', cost: 0, requests: 2, unpriced_requests: 2, input_tokens: 1400000, output_tokens: 39074, cached_input_tokens: 0}]};

const costsPage = role => {
  const p = loadConsole(['static/app.js', 'static/metrics.js', 'static/costs.js'], () => [200, JSON.parse(JSON.stringify(unpriced))]);
  p.run(`me={id:'admin',role:'${role}'};tab='costs';costState={from:'2026-11-10',to:'2026-11-11',currency:'USD'};document.createTextNode=text=>element('span',text);document.createElementNS=(_ns,tag)=>document.createElement(tag);`);
  return p;
};
const text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');

test('an all-unpriced range names the reason and offers the next step to a super admin', () => {
  const p = costsPage('super_admin');
  return p.run('loadCosts(0)').then(() => {
    const card = p.$('cost-body').querySelector('[data-metric=cost]');
    assert.match(text(card), /未定价/);
    assert.match(text(card), /还没有为这些模型设置单价/);
    const link = card.querySelectorAll('a').find(node => text(node).includes('去设置模型单价'));
    assert.ok(link, 'a super admin gets a link to the price settings');
    assert.equal(link.href, '#/settings/models');
  });
});

test('a project admin is told who can set the price instead of getting a dead end', () => {
  const p = costsPage('project_admin');
  return p.run('loadCosts(0)').then(() => {
    const card = p.$('cost-body').querySelector('[data-metric=cost]');
    assert.match(text(card), /还没有为这些模型设置单价/);
    assert.match(text(card), /请联系管理员/);
    assert.equal(card.querySelectorAll('a').length, 0, 'no settings link for someone who cannot open it');
  });
});
