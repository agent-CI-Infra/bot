'use strict';

const STATUS_LABEL = {
  COMPLETED: '通过',
  BLOCKED: '阻塞',
  FAILED: '失败',
  UNKNOWN: '未知',
};

const state = {
  history: null,
  selected: null,
  model: null,
  hashModel: null,
  view: 'cases',
  rangeDays: 0,
  granularity: 'daily',
  tokenVisibility: {
    input_per_request: true,
    output_per_request: true,
    total_per_request: true,
  },
  latencyVisibility: {
    ttft: true,
    tpot: true,
    p95_upper: true,
    p95_lower: true,
  },
  volumeVisibility: {
    calls: true,
    failure: true,
  },
  tokenUnit: 'request',
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function statusClass(status) {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'BLOCKED') return 'blocked';
  if (status === 'FAILED') return 'failed';
  return 'unknown';
}

function stepStatusClass(status) {
  const value = String(status || '').toLowerCase();
  if (['ok', 'pass', 'passed', 'completed', 'success'].includes(value)) return 'ok';
  if (['failed', 'fail', 'error'].includes(value)) return 'failed';
  if (['blocked', 'skipped', 'skip'].includes(value)) return 'blocked';
  return 'unknown';
}

function statusLabel(status) {
  return STATUS_LABEL[status] || status || STATUS_LABEL.UNKNOWN;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

function fmtAxis(ms) {
  if (ms === 0) return '0';
  if (ms >= 60000) {
    const minutes = ms / 60000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-');
}

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const padded = value * 1.08;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const step = magnitude / 2;
  return Math.ceil(padded / step) * step;
}

function entries() {
  return Object.values(state.history?.cases || {});
}

function latestPoint(entry) {
  return entry?.latest || entry?.points?.[entry.points.length - 1] || null;
}

function latestFinished(entry) {
  return entry?.latest?.finished_at || entry?.points?.[entry.points.length - 1]?.finished_at || '';
}

function sortedCases() {
  return entries().sort((a, b) => {
    const at = latestFinished(a);
    const bt = latestFinished(b);
    if (at !== bt) return bt.localeCompare(at);
    return String(a.id).localeCompare(String(b.id));
  });
}

function sparkline(points) {
  const usable = (points || []).filter((point) => Number.isFinite(point.query_ms));
  if (!usable.length) return '<span class="spark spark-empty"></span>';

  const width = 132;
  const height = 24;
  const pad = 3;
  const values = usable.map((point) => point.query_ms);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index) =>
    usable.length === 1
      ? width / 2
      : pad + (index * (width - 2 * pad)) / (usable.length - 1);
  const y = (value) =>
    max === min ? height / 2 : height - pad - ((value - min) / span) * (height - 2 * pad);
  const path = usable
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.query_ms).toFixed(1)}`)
    .join(' ');
  const last = usable[usable.length - 1];
  const lastX = x(usable.length - 1);
  const lastY = y(last.query_ms);

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日查询耗时迷你趋势">
    ${usable.length > 1 ? `<path class="spark-line" d="${path}" />` : ''}
    <circle class="spark-dot ${statusClass(last.status)}" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.6" />
  </svg>`;
}

function renderHeader() {
  const history = state.history;
  const updated = history.updated_at
    ? `更新于 ${fmtDateTime(history.updated_at)}`
    : '暂无更新时间';
  $('updated').textContent = updated + (history.current_day_partial ? ' · 采集当日未结束' : '') + (history.excluded_missing_model ? ` · 未识别模型排除 ${fmtCount(history.excluded_missing_model)} 条` : '');

  const withDevice = sortedCases().find((entry) => entry.latest?.device);
  const device = history.device || withDevice?.latest?.device;
  if (device) {
    const screen = device.screen;
    const resolution =
      screen && screen.width && screen.height ? ` · ${screen.width}×${screen.height}` : '';
    const name = `${device.model || device.target || ''}${resolution}`.trim();
    $('device').textContent = device.kind === 'gateway' ? name : `真机 ${name}`.trim();
  } else {
    $('device').textContent = '设备信息未记录';
  }
}

function renderSummary() {
  const cases = entries();
  const completed = cases.filter((entry) => latestPoint(entry)?.status === 'COMPLETED').length;
  const blocked = cases.filter((entry) => latestPoint(entry)?.status === 'BLOCKED').length;
  const failed = cases.filter((entry) => latestPoint(entry)?.status === 'FAILED').length;
  const queryValues = cases.map((entry) => latestPoint(entry)?.query_ms).filter((value) => Number.isFinite(value));
  const averageQuery = queryValues.length
    ? Math.round(queryValues.reduce((sum, value) => sum + value, 0) / queryValues.length)
    : null;
  const previousQueryValues = cases
    .map((entry) => {
      const points = [...(entry.points || [])]
        .filter((point) => Number.isFinite(point.query_ms))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return points.length > 1 ? points[points.length - 2].query_ms : null;
    })
    .filter((value) => Number.isFinite(value));
  const previousAverageQuery = previousQueryValues.length
    ? Math.round(previousQueryValues.reduce((sum, value) => sum + value, 0) / previousQueryValues.length)
    : null;
  const averageDelta = deltaChip(averageQuery, previousAverageQuery, { lowerIsBetter: true });
  const lastDate = cases
    .flatMap((entry) => entry.points || [])
    .map((point) => point.date)
    .sort()
    .pop();

  $('summary').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">用例</div>
      <div class="stat-value">${cases.length}</div>
      <div class="stat-hint">${lastDate ? `最新数据 ${esc(lastDate)}` : '暂无数据'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最新通过</div>
      <div class="stat-value ok">${completed}</div>
      <div class="stat-hint">${cases.length ? `${Math.round((completed / cases.length) * 100)}% 的用例` : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">阻塞 / 失败</div>
      <div class="stat-value ${blocked ? 'blocked' : failed ? 'failed' : ''}">${blocked} / ${failed}</div>
      <div class="stat-hint">阻塞不等于失败</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最新平均查询耗时</div>
      <div class="stat-value">${fmtDuration(averageQuery)}</div>
      <div class="stat-hint">各用例最近一次 · 不含 E2E 等待</div>
      ${averageDelta ? `<div class="stat-delta">${averageDelta}</div>` : ''}
    </div>
  `;
}

function renderPerfStrip() {
  const target = $('perf-strip');
  if (!target) return;
  target.innerHTML = perfStrip(state.history);
}

function renderCaseList() {
  const cases = sortedCases();
  $('case-count').textContent = `${cases.length} 个`;
  $('case-list').innerHTML = cases
    .map((entry) => {
      const point = latestPoint(entry);
      const status = point?.status || 'UNKNOWN';
      const selected = entry.id === state.selected;
      return `<button class="case ${selected ? 'selected' : ''}" type="button" data-case-id="${esc(entry.id)}" aria-pressed="${selected}">
        <span class="case-top">
          <span class="status-dot ${statusClass(status)}"></span>
          <span class="case-id">${esc(entry.id)}</span>
          <span class="case-dur" title="本轮 query 平均耗时">${fmtDuration(point?.query_ms)}</span>
        </span>
        <span class="case-title">${esc(entry.title || '')}</span>
        ${sparkline(entry.points)}
      </button>`;
    })
    .join('');
}

const STAGE_LABEL = {
  tap: '点击',
  queued: '排队',
  dequeued: '出队',
  wire_send: '发送',
  ack: 'ACK',
  first_text: '首条消息',
  last_text: '消息接收',
  task_done: '任务完成',
  display_done: '展示完成',
};

function outcomeClass(outcome) {
  const value = String(outcome || '').toLowerCase();
  if (value === 'completed' || value === 'ok') return 'ok';
  if (value === 'cancelled') return 'blocked';
  return 'failed';
}

function queryWaterfall(latest) {
  const queries = Array.isArray(latest?.queries) ? latest.queries : [];
  if (!queries.length) {
    return '<p class="empty">本次运行没有 Orbit profiling 查询记录；不使用 E2E 总耗时替代。</p>';
  }
  const max = Math.max(...queries.map((query) => query.duration_ms || 0), 1);
  const latestQuery = queries[queries.length - 1];
  const queryRows = queries
    .map((query, index) => {
      const cls = outcomeClass(query.outcome);
      const percent = Math.max(1, ((query.duration_ms || 0) / max) * 100);
      const title = [
        `Q${index + 1}`,
        query.outcome,
        query.started_at,
        `首条 ${fmtDuration(query.first_text_ms)}`,
        `展示 ${fmtDuration(query.display_ms)}`,
      ].filter(Boolean).join(' · ');
      return `<div class="wf-row ${cls}" title="${esc(title)}">
        <span class="wf-label">Q${index + 1} · ${statusLabel(cls === 'ok' ? 'COMPLETED' : cls === 'blocked' ? 'BLOCKED' : 'FAILED')}</span>
        <span class="wf-bar"><i style="width:${percent.toFixed(2)}%"></i></span>
        <span class="wf-val">${fmtDuration(query.duration_ms)}</span>
      </div>`;
    })
    .join('');

  const stages = (Array.isArray(latestQuery?.stages) ? latestQuery.stages : [])
    .filter((stage) => stage && Number.isFinite(Number(stage.at_ms)) && stage.name !== 'display_done')
    .sort((a, b) => Number(a.at_ms) - Number(b.at_ms));
  const lastText = stages.map((stage) => stage.name).lastIndexOf('last_text');
  const visible = lastText >= 0 ? stages.slice(0, lastText + 1) : stages;
  const base = visible.length ? Number(visible[0].at_ms) : 0;
  const stageRows = visible.map((stage, index) => {
    const start = Math.max(0, Number(stage.at_ms) - base);
    const next = index + 1 < visible.length ? Math.max(0, Number(visible[index + 1].at_ms) - base) : start;
    const duration = Math.max(0, next - start);
    const percent = Math.max(1, (duration / Math.max(latestQuery.duration_ms || 1, 1)) * 100);
    return `<div class="wf-row ok" title="${esc(stage.detail || '')}">
      <span class="wf-label">${esc(STAGE_LABEL[stage.name] || stage.name)}</span>
      <span class="wf-bar"><i style="width:${percent.toFixed(2)}%"></i></span>
      <span class="wf-val">${fmtDuration(duration)}</span>
    </div>`;
  }).join('');

  return `<div class="waterfall">${queryRows}${stageRows ? `<div class="wf-subhead">最近一次查询阶段</div>${stageRows}` : ''}</div>`;
}

function dailyChart(points) {
  const usable = (points || []).filter((point) => Number.isFinite(point.query_ms));
  if (!usable.length) return '<p class="empty">暂无可绘制的查询耗时数据。</p>';

  const { width, height } = chartSize(760, 250, { hostId: 'detail' });
  const pad = { left: 56, right: 18, top: 16, bottom: 38 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...usable.map((point) => point.query_ms), 1));
  const x = (index) =>
    usable.length === 1
      ? pad.left + innerWidth / 2
      : pad.left + (index * innerWidth) / (usable.length - 1);
  const y = (value) => pad.top + innerHeight - (value / max) * innerHeight;
  const ticks = 4;
  const tickValues = Array.from({ length: ticks + 1 }, (_, index) => (max / ticks) * index);

  const grid = tickValues
    .map((value) => {
      const yy = y(value);
      return `<line class="grid-line" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />
        <text class="axis-text" x="${pad.left - 8}" y="${yy + 3}" text-anchor="end">${fmtAxis(value)}</text>`;
    })
    .join('');

  const step = Math.max(1, Math.ceil(usable.length / 8));
  const labelIndexes = new Set([0, usable.length - 1]);
  for (let index = step; index < usable.length - 1; index += step) labelIndexes.add(index);
  const xLabels = [...labelIndexes]
    .sort((a, b) => a - b)
    .map((index) => {
      const point = usable[index];
      return `<text class="axis-text" x="${x(index)}" y="${height - 14}" text-anchor="middle">${esc(point.date.slice(5))}</text>`;
    })
    .join('');

  const path = usable
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.query_ms).toFixed(1)}`)
    .join(' ');
  const dots = usable
    .map((point, index) => {
      const title = `${point.date} · ${statusLabel(point.status)} · 查询 ${fmtDuration(point.query_ms)} · ${point.run_id || ''}`;
      return `<circle class="point ${statusClass(point.status)}" cx="${x(index).toFixed(1)}" cy="${y(point.query_ms).toFixed(1)}" r="4">
        <title>${esc(title)}</title>
      </circle>`;
    })
    .join('');

  const single = usable.length === 1;
  const annotation = single
    ? `<text class="annotation" x="${x(0)}" y="${Math.max(12, y(usable[0].query_ms) - 12)}" text-anchor="middle">首个数据点</text>`
    : '';

  const presentStatuses = [...new Set(usable.map((point) => point.status || 'UNKNOWN'))];
  const statusLegend = presentStatuses.length
    ? `<div class="chart-legend">${presentStatuses
        .map(
          (status) =>
            `<span class="legend-key"><i class="legend-dot ${statusClass(status)}"></i>${esc(statusLabel(status))}</span>`,
        )
        .join('')}</div>`
    : '';

  const zoneWidth = usable.length > 1 ? innerWidth / (usable.length - 1) : innerWidth;
  const zones = usable
    .map((point, index) => {
      const cx = x(index);
      const left = Math.max(pad.left, cx - zoneWidth / 2);
      const right = Math.min(width - pad.right, cx + zoneWidth / 2);
      const tip = [
        point.date,
        `${statusLabel(point.status)} · 查询 ${fmtDuration(point.query_ms)}`,
        point.run_id ? `run ${point.run_id}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return `<rect class="hover-zone" x="${left.toFixed(1)}" y="${pad.top}" width="${(right - left).toFixed(1)}" height="${innerHeight}" data-tip="${esc(tip)}" data-x="${cx.toFixed(1)}" data-y="${y(point.query_ms).toFixed(1)}" />`;
    })
    .join('');

  return `${statusLegend}<div class="chart-wrap">
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(state.selected)} 每日查询耗时曲线">
      ${grid}
      <line class="axis-line" x1="${pad.left}" y1="${pad.top + innerHeight}" x2="${width - pad.right}" y2="${pad.top + innerHeight}" />
      ${usable.length > 1 ? `<path class="series" d="${path}" />` : ''}
      ${dots}
      ${xLabels}
      ${annotation}
      <line class="hover-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerHeight}" hidden />
      <circle class="hover-dot" r="4" cx="0" cy="0" hidden />
      ${zones}
    </svg>
  </div>`;
}

function fmtCount(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  // Intl.NumberFormat construction is expensive; reuse one instance per page.
  fmtCount.formatter ??= new Intl.NumberFormat('zh-CN');
  return fmtCount.formatter.format(value);
}
function fmtTpot(value) {
  return Number.isFinite(value) && value >= 0 ? `${value.toFixed(2)} ms/token` : '—';
}
function benchmarkMetrics(latest) {
  const b = latest?.cloud?.benchmark;
  if (!b || !Array.isArray(b.models)) return '<p class="empty">没有可确认关联的用例模型调用；未匹配的 trace 不纳入统计。</p>';
  if (!b.models.length) {
    const unmatched = Number.isFinite(b.unmatched_calls) && b.unmatched_calls > 0
      ? `；另有 ${fmtCount(b.unmatched_calls)} 次调用无法关联到本次 query`
      : '';
    return `<p class="empty">没有可确认关联的用例模型调用${unmatched}；未匹配的 trace 不纳入统计。</p>`;
  }
  const modelRows = b.models.map((m) => `<tr><td>${esc(m.model || '未知')}</td><td>${fmtCount(m.call_count)}</td><td>${fmtDuration(m.ttft_avg_ms)}（${fmtCount(m.ttft_sample_count)}）</td><td>${fmtTpot(m.tpot_avg_ms)}（${fmtCount(m.tpot_sample_count)}）</td><td>${fmtDuration(m.duration_p95_ms)}（${fmtCount(m.duration_sample_count)} 样本）</td><td>${fmtCount(m.input_tokens)}</td><td>${fmtCount(m.output_tokens)}</td><td>${fmtCount(m.total_tokens)}</td></tr>`).join('');
  const calls = Array.isArray(b.calls) ? b.calls : [];
  const callRows = calls.map((c) => `<tr><td>${esc(c.model || '未知')}</td><td>${esc(c.status || '未知')}</td><td>${fmtDuration(c.duration_ms)}</td><td>${c.stream === true ? fmtDuration(c.ttft_ms) : '—'}</td><td>${c.stream === true && c.output_tokens > 1 ? fmtTpot(c.tpot_ms) : '—'}</td><td>${fmtCount(c.input_tokens)}</td><td>${fmtCount(c.output_tokens)}</td><td>${fmtCount(c.total_tokens)}</td></tr>`).join('');
  const callDetails = calls.length
    ? `<details><summary>单次调用${b.calls_truncated ? '（仅前 200 条）' : ''}</summary><div class="table-wrap"><table class="history-table"><thead><tr><th>模型</th><th>状态</th><th>耗时</th><th>TTFT</th><th>TPOT</th><th>输入</th><th>输出</th><th>总 Token</th></tr></thead><tbody>${callRows}</tbody></table></div></details>`
    : '';
  return `<p class="chart-note">当前用例已关联 ${fmtCount(b.matched_calls)} 次调用；未关联 ${fmtCount(b.unmatched_calls)} 次。P95 至少需要 20 个成功样本；TTFT/TPOT 仅统计已确认的流式成功调用；模型名称为 trace 上报值。</p><div class="table-wrap"><table class="history-table"><thead><tr><th>上报模型</th><th>调用数</th><th>平均 TTFT（样本）</th><th>平均 TPOT（样本）</th><th>耗时 P95（样本）</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th></tr></thead><tbody>${modelRows}</tbody></table></div>${callDetails}`;
}
function productionMetrics(doc) {
  if (!doc || doc.schema !== 'model-request-metrics@1' || doc.scope !== 'classified-production' || !Array.isArray(doc.models)) return '<p class="empty">未配置现网指标数据源，或采集数据不可用。</p>';
  const rows = doc.models.map((m) => `<tr><td>${esc(m.model || '未知')}</td><td>${fmtCount(m.calls)}</td><td>${fmtDuration(m.ttft_avg_ms)}（${fmtCount(m.ttft_sample_count)}）</td><td>${fmtTpot(m.tpot_avg_ms)}（${fmtCount(m.tpot_sample_count)}）</td><td>${fmtDuration(m.gateway_duration_p95_ms)}（${fmtCount(m.duration_sample_count)}）</td><td>${fmtCount(m.prompt_tokens)}</td><td>${fmtCount(m.completion_tokens)}</td><td>${fmtCount(m.total_tokens)}</td></tr>`).join('');
  const calls = Array.isArray(doc.calls) ? doc.calls : [];
  const details = calls.slice(0, 200).map((c) => `<tr><td>${esc(c.model || '未知')}</td><td>${esc(c.status || '未知')}</td><td>${fmtDuration(c.duration_ms)}</td><td>${fmtDuration(c.ttft_ms)}</td><td>${fmtTpot(c.tpot_ms)}</td><td>${fmtCount(c.prompt_tokens)}</td><td>${fmtCount(c.completion_tokens)}</td><td>${fmtCount(c.total_tokens)}</td></tr>`).join('');
  const excluded = Number.isFinite(doc.excluded_unknown) ? doc.excluded_unknown : 0;
  const duplicates = Number.isFinite(doc.excluded_duplicates) ? doc.excluded_duplicates : 0;
  const excludedNote = `未纳入统计 ${fmtCount(excluded)} 条（非 production、未知或缺少可信标识）${duplicates ? `，重复请求排除 ${fmtCount(duplicates)} 条` : ''}`;
  const callDetails = calls.length
    ? `<details><summary>单次调用（最多 200 条${doc.calls_truncated ? '，已截断' : ''}）</summary><div class="table-wrap"><table class="history-table"><thead><tr><th>模型</th><th>状态</th><th>网关耗时</th><th>TTFT</th><th>TPOT</th><th>输入</th><th>输出</th><th>总 Token</th></tr></thead><tbody>${details}</tbody></table></div></details>`
    : '';
  return `<p class="chart-note">${esc(doc.environment || '未知环境')} · ${esc(doc.start || '—')} 至 ${esc(doc.end || '—')} UTC · 更新 ${esc(doc.generated_at || '—')} · ${excludedNote}。P95 为网关总耗时，至少 20 个成功样本，不代表纯模型耗时。</p>${rows ? `<div class="table-wrap"><table class="history-table"><thead><tr><th>物理模型</th><th>调用数</th><th>TTFT 均值（样本）</th><th>TPOT 均值（样本）</th><th>网关 P95（样本）</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">无已分类现网调用。</p>'}${callDetails}`;
}

function fmtToken(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  fmtToken.formatter ??= new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  return fmtToken.formatter.format(value);
}

// A signed delta against the previous period. Direction is colored only when
// "up" has a known meaning (latency up is bad) or the caller asks for explicit
// direction colors (up red / down green), with an arrow and a named period so
// color is never the only signal.
function deltaChip(current, previous, { lowerIsBetter = false, colorDirection = false, label = '较前一日' } = {}) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return '';
  const change = (current - previous) / previous;
  const up = change > 0;
  const arrow = up ? '▲' : '▼';
  const percent = Math.abs(change * 100);
  if (percent < 0.05) return `<span class="delta neutral">持平</span>`;
  const tone = lowerIsBetter || colorDirection ? (up ? 'bad' : 'good') : 'neutral';
  const text = percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
  const labelHtml = label ? ` <span class="delta-label">${esc(label)}</span>` : '';
  return `<span class="delta ${tone}" title="${esc(label)}${up ? '上升' : '下降'} ${text}">${arrow} ${text}</span>${labelHtml}`;
}

function previousRow(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const previous = rows[rows.length - 2];
  return addDays(previous.date, 1) === rows[rows.length - 1].date ? previous : null;
}

function benchmarkModelName(row) {
  const name = typeof row?.model === 'string' ? row.model.trim() : '';
  return name || '未知';
}

function benchmarkModelNames(history) {
  const totals = new Map();
  for (const entry of Object.values(history?.cases || {})) {
    for (const point of entry?.points || []) {
      for (const row of point?.benchmark_models || []) {
        const name = benchmarkModelName(row);
        const calls = Number.isFinite(row?.call_count) && row.call_count > 0 ? row.call_count : 0;
        totals.set(name, (totals.get(name) || 0) + calls);
      }
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

function median(values) {
  const sorted = (values || [])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// A question can trigger several model calls; question-level metrics count
// questions, not calls. A point without a query count still counts as one
// question when it produced a latency sample.
function questionCount(point) {
  const count = Number(point?.query_count);
  if (Number.isFinite(count) && count > 0) return count;
  return Number.isFinite(point?.query_ms) ? 1 : 0;
}

// Suite-wide question stats per day: median question latency plus failed and
// blocked question counts. Blocked questions are reported separately because
// the case dashboard treats a blocked run as not failed. Points may carry
// explicit failed_queries/blocked_queries counts (production gateways know
// per-request outcomes); benchmark points without them fall back to status.
function dailyQuestionStats(history) {
  const byDate = new Map();
  for (const entry of Object.values(history?.cases || {})) {
    for (const point of entry?.points || []) {
      const date = String(point?.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!byDate.has(date)) byDate.set(date, { date, queries: 0, failed: 0, blocked: 0, values: [] });
      const day = byDate.get(date);
      const count = questionCount(point);
      day.queries += count;
      const failedCount = Number.isFinite(point?.failed_queries)
        ? Math.max(0, Math.min(Number(point.failed_queries), count))
        : point?.status === 'FAILED'
          ? count
          : 0;
      const blockedCount = Number.isFinite(point?.blocked_queries)
        ? Math.max(0, Math.min(Number(point.blocked_queries), count - failedCount))
        : point?.status === 'BLOCKED'
          ? count
          : 0;
      day.failed += failedCount;
      day.blocked += blockedCount;
      if (Number.isFinite(point?.query_ms)) day.values.push(point.query_ms);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ values, ...day }) => ({
      ...day,
      median_ms: median(values),
      failure_rate: day.queries > 0 ? (day.failed / day.queries) * 100 : null,
    }));
}

// The baseline is the median of the previous days' daily medians; the upper
// limit keeps the reference dashboard's 1.5x rule.
function baselineStats(history, ratio = 1.5) {
  const days = dailyQuestionStats(history);
  const withMedian = days.filter((day) => Number.isFinite(day.median_ms));
  if (!withMedian.length) return null;
  const current = withMedian[withMedian.length - 1];
  const prior = withMedian.slice(0, -1);
  const baseline = median(prior.map((day) => day.median_ms));
  const limit = Number.isFinite(baseline) ? Math.round(baseline * ratio) : null;
  const change = Number.isFinite(baseline) && baseline > 0 ? ((current.median_ms - baseline) / baseline) * 100 : null;
  const failure = [...days].reverse().find((day) => day.queries > 0) || null;
  return {
    current,
    baseline_ms: baseline,
    limit_ms: limit,
    change_percent: change,
    baseline_days: prior.length,
    failure,
  };
}

// Attribute failures only when the source point describes exactly one model.
function failureSeries(history, dates, model) {
  const wanted = new Set((dates || []).map((day) => day?.date).filter(Boolean));
  const byDate = new Map();
  for (const entry of Object.values(history?.cases || {})) {
    for (const point of entry?.points || []) {
      if (!wanted.has(point?.date)) continue;
      const models = new Set((point.benchmark_models || []).map(benchmarkModelName));
      if (!models.has(model)) continue;
      if (!byDate.has(point.date)) byDate.set(point.date, { queries: 0, failed: 0, complete: true });
      const day = byDate.get(point.date);
      const queries = point.query_count;
      const failed = point.failed_queries;
      const unknown = point.unknown_status_count;
      if (unknown !== 0 || models.size !== 1 || !Number.isFinite(queries) || queries <= 0 || !Number.isFinite(failed) || failed < 0 || failed > queries) {
        day.complete = false;
        continue;
      }
      day.queries += queries;
      day.failed += failed;
    }
  }
  return [...wanted].sort().map((date) => {
    const day = byDate.get(date);
    return day?.complete && day.queries > 0
      ? { date, queries: day.queries, failed: day.failed, failure_rate: day.failed / day.queries * 100 }
      : { date, queries: 0, failed: 0, failure_rate: null };
  });
}

function fmtPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

// Aggregate counts first so weekly rates are weighted by request volume.
function weeklyFailureRates(failures) {
  const weeks = new Map();
  for (const row of failures || []) {
    const start = weekStart(row.date);
    if (!start) continue;
    if (!weeks.has(start)) weeks.set(start, { queries: 0, failed: 0, complete: true });
    const total = weeks.get(start);
    if (!Number.isFinite(row.failure_rate)) total.complete = false;
    total.queries += row.queries;
    total.failed += row.failed;
  }
  return new Map([...weeks].map(([start, row]) => [start, row.complete && row.queries > 0 ? row.failed / row.queries * 100 : null]));
}

function perfStrip(history) {
  const stats = baselineStats(history);
  if (!stats) return '';
  const { current, baseline_ms, limit_ms, change_percent, baseline_days } = stats;
  const changeTone = !Number.isFinite(change_percent) || Math.abs(change_percent) < 0.05
    ? ''
    : change_percent < 0 ? 'ok' : 'failed';
  const changeText = Number.isFinite(change_percent)
    ? `${change_percent > 0 ? '+' : ''}${change_percent.toFixed(1)}%`
    : '—';
  const changeHint = Number.isFinite(change_percent)
    ? `${change_percent < 0 ? '低于' : '高于'}基线 ${fmtDuration(Math.abs(current.median_ms - baseline_ms))}`
    : '暂无可比基线';
  const failure = stats.failure;
  return `
    <div class="stat-card">
      <div class="stat-label">当前请求中位数</div>
      <div class="stat-value">${fmtDuration(current.median_ms)}</div>
      <div class="stat-hint">${esc(current.date)} · 全部用例 · ${fmtCount(current.queries)} 个请求</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">基线中位数</div>
      <div class="stat-value">${fmtDuration(baseline_ms)}</div>
      <div class="stat-hint">${baseline_days ? `此前 ${baseline_days} 天每日中位数` : '暂无历史基线'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">上限</div>
      <div class="stat-value">${fmtDuration(limit_ms)}</div>
      <div class="stat-hint">基线中位数 × 1.5</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">较基线</div>
      <div class="stat-value ${changeTone}">${esc(changeText)}</div>
      <div class="stat-hint">${esc(changeHint)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">请求失败率</div>
      <div class="stat-value ${failure?.failed ? 'failed' : 'ok'}">${failure ? fmtPercent(failure.failure_rate) : '—'}</div>
      <div class="stat-hint">${failure ? `失败 ${fmtCount(failure.failed)} / 请求 ${fmtCount(failure.queries)}${failure.blocked ? ` · 阻塞 ${fmtCount(failure.blocked)}` : ''}` : '暂无请求数据'}</div>
    </div>
  `;
}

function newMetricAccumulator() {
  return {
    calls: 0,
    queries: 0,
    ttft_sum: 0,
    ttft_samples: 0,
    tpot_sum: 0,
    tpot_samples: 0,
    p95_min: null,
    p95_max: null,
    p95_complete: true,
    duration_samples: 0,
    input_sum: 0,
    input_complete: true,
    output_sum: 0,
    output_complete: true,
    total_sum: 0,
    total_complete: true,
  };
}

// Raw benchmark rows (and already-finalized day rows) share the same metric
// fields, so both can be folded with one accumulator.
function mergeMetricRow(acc, row) {
  acc.calls += Number.isFinite(row?.calls) && row.calls > 0 ? row.calls : 0;
  acc.queries += Number.isFinite(row?.queries) && row.queries > 0 ? row.queries : 0;
  for (const key of ['ttft', 'tpot']) {
    const value = row?.[`${key}_ms`];
    const samples = row?.[`${key}_samples`];
    if (Number.isFinite(value) && value >= 0 && Number.isFinite(samples) && samples > 0) {
      acc[`${key}_sum`] += value * samples;
      acc[`${key}_samples`] += samples;
    }
  }
  if (Number.isFinite(row?.p95_ms) && row.p95_ms >= 0) {
    const upper = row.p95_ms;
    const lower = Number.isFinite(row.p95_lower_ms) && row.p95_lower_ms >= 0 ? row.p95_lower_ms : upper;
    acc.p95_min = acc.p95_min === null ? lower : Math.min(acc.p95_min, lower);
    acc.p95_max = acc.p95_max === null ? upper : Math.max(acc.p95_max, upper);
  }
  if (Number.isFinite(row?.duration_samples) && row.duration_samples > 0) {
    acc.duration_samples += row.duration_samples;
    if (!Number.isFinite(row.p95_ms)) acc.p95_complete = false;
  }
  for (const key of ['input', 'output', 'total']) {
    const value = row?.[`${key}_tokens`];
    if (Number.isFinite(value) && value >= 0) acc[`${key}_sum`] += value;
    else acc[`${key}_complete`] = false;
  }
}

function finalizeMetricAccumulator(acc) {
  const result = {
    calls: acc.calls,
    queries: acc.queries,
    ttft_ms: acc.ttft_samples > 0 ? acc.ttft_sum / acc.ttft_samples : null,
    ttft_samples: acc.ttft_samples,
    tpot_ms: acc.tpot_samples > 0 ? acc.tpot_sum / acc.tpot_samples : null,
    tpot_samples: acc.tpot_samples,
    p95_lower_ms: acc.p95_complete ? acc.p95_min : null,
    p95_ms: acc.p95_complete ? acc.p95_max : null,
    duration_samples: acc.duration_samples,
  };
  for (const key of ['input', 'output', 'total']) {
    const total = acc[`${key}_complete`] ? acc[`${key}_sum`] : null;
    result[`${key}_tokens`] = total;
    result[`${key}_per_request`] = total !== null && acc.calls > 0 ? total / acc.calls : null;
    result[`${key}_per_query`] = total !== null && acc.queries > 0 ? total / acc.queries : null;
  }
  return result;
}

function benchmarkRowToMetric(row) {
  const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const metric = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  return {
    calls: positive(row?.call_count),
    ttft_ms: metric(row?.ttft_avg_ms),
    ttft_samples: positive(row?.ttft_sample_count),
    tpot_ms: metric(row?.tpot_avg_ms),
    tpot_samples: positive(row?.tpot_sample_count),
    p95_ms: metric(row?.duration_p95_ms),
    duration_samples: positive(row?.duration_sample_count),
    input_tokens: metric(row?.input_tokens),
    output_tokens: metric(row?.output_tokens),
    total_tokens: metric(row?.total_tokens),
  };
}

function modelSeries(history, model) {
  const name = String(model || '').trim();
  if (!name) return [];
  const byDate = new Map();
  for (const entry of Object.values(history?.cases || {})) {
    for (const point of entry?.points || []) {
      const date = String(point?.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const matched = (point?.benchmark_models || []).filter((row) => benchmarkModelName(row) === name);
      if (!matched.length) continue;
      if (!byDate.has(date)) byDate.set(date, { acc: newMetricAccumulator(), version: null });
      const slot = byDate.get(date);
      for (const row of matched) mergeMetricRow(slot.acc, benchmarkRowToMetric(row));
      // Count the day's questions once per model, not once per model row.
      slot.acc.queries += questionCount(point);
      // Keep the freshest contributing point's provenance so the daily table
      // can attribute a day to the run / commit that produced it.
      const candidate = {
        finished_at: String(point?.finished_at || ''),
        run_id: String(point?.run_id || ''),
        commit: String(point?.commit || ''),
      };
      if (!slot.version || candidate.finished_at >= slot.version.finished_at) slot.version = candidate;
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, slot]) => ({
      date,
      run_id: slot.version?.run_id || '',
      commit: slot.version?.commit || '',
      ...finalizeMetricAccumulator(slot.acc),
    }));
}

function weekStart(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return new Date(ms - ((new Date(ms).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms + days * 86400000).toISOString().slice(0, 10) : date;
}

function weekSeries(days) {
  const groups = new Map();
  for (const day of days || []) {
    const start = weekStart(day?.date);
    if (!start) continue;
    if (!groups.has(start)) groups.set(start, newMetricAccumulator());
    mergeMetricRow(groups.get(start), day);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, acc]) => {
      const end = addDays(start, 6);
      return {
        week_start: start,
        week_end: end,
        week_label: `${start} ~ ${end}`,
        ...finalizeMetricAccumulator(acc),
      };
    });
}

// The range control scopes every card below it: keep only rows inside the
// trailing calendar window ending at the latest data date.
function inRange(days, rangeDays, endDate = null) {
  const rows = Array.isArray(days) ? days : [];
  const span = Number(rangeDays);
  if (!Number.isFinite(span) || span <= 0 || !rows.length) return rows;
  const end = endDate || rows[rows.length - 1].date;
  const start = addDays(end, -(span - 1));
  return rows.filter((row) => row.date >= start && row.date <= end);
}

function latestModelDate(history) {
  let latest = '';
  for (const name of benchmarkModelNames(history)) {
    const date = modelSeries(history, name).at(-1)?.date || '';
    if (date > latest) latest = date;
  }
  return latest;
}

// SVG charts scale their whole viewBox, labels included. On a phone a fixed
// 1000-unit chart squeezes axis text into a few pixels, so size the viewBox to
// the width the card will really have and keep a 1:1 user-unit/px scale.
function chartSize(baseWidth, baseHeight, { columns = 1, hostId = 'model-trends' } = {}) {
  const host = typeof document !== 'undefined' ? document.getElementById(hostId) : null;
  const available = host && host.clientWidth > 0 ? host.clientWidth : 0;
  if (!available) return { width: baseWidth, height: baseHeight };
  const stacked = typeof window !== 'undefined' && window.innerWidth <= 860;
  const count = stacked ? 1 : columns;
  const perCard = count > 1 ? (available - 12) / 2 : available;
  const width = Math.max(260, Math.round(perCard - 26));
  const height = Math.max(baseHeight, Math.round((width * baseHeight) / baseWidth));
  return { width, height };
}

// Call volume and question failures are one "how much ran, how much broke"
// view: calls use the left count axis while the failure rate (all benchmark
// requests for the selected model) uses the right percentage axis.
function volumeTrendChart(days, failures, visibility = {}) {
  const rows = Array.isArray(days) ? days : [];
  const failureByDate = new Map(
    (Array.isArray(failures) ? failures : [])
      .map((row) => [row?.date, row])
      .filter(([date]) => Boolean(date)),
  );
  const isVisible = (key) => visibility?.[key] !== false;
  const series = [
    {
      key: 'calls',
      label: '调用数',
      layer: 'calls',
      values: rows.map((row) => (Number.isFinite(row?.calls) ? row.calls : null)),
      format: fmtCount,
      axis: 'left',
    },
    {
      key: 'failure',
      label: '请求失败率',
      layer: 'failure',
      values: rows.map((row) => {
        const rate = failureByDate.get(row?.date)?.failure_rate;
        return Number.isFinite(rate) ? rate : null;
      }),
      format: fmtPercent,
      axis: 'right',
    },
  ];
  const legend = series
    .map((item) => {
      const active = isVisible(item.key);
      return `<button class="legend-toggle volume-toggle${active ? '' : ' off'}" type="button" data-volume-layer="${item.key}" aria-pressed="${active}">
        <i class="legend-line ${item.layer}"></i><span>${esc(item.label)}</span>
      </button>`;
    })
    .join('');
  const head = `<div class="trend-head"><h3>调用数与请求失败率</h3><div class="trend-legend">${legend}</div></div>`;
  if (!rows.length || series.every((item) => item.values.every((value) => value === null))) {
    return `<div class="trend-card wide">${head}<p class="empty">暂无数据</p></div>`;
  }

  const { width, height } = chartSize(1000, 220);
  const leftValues = series[0].values.filter((value) => value !== null);
  const rightValues = series[1].values.filter((value) => value !== null);
  const hasLeft = leftValues.length > 0;
  const hasRight = rightValues.length > 0;
  const pad = { left: 52, right: hasRight ? 46 : 18, top: 14, bottom: 30 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const leftMax = niceMax(hasLeft ? Math.max(...leftValues) : 1);
  const rightMax = Math.min(100, niceMax(hasRight ? Math.max(...rightValues, 10) : 10));
  const x = (index) =>
    rows.length === 1 ? pad.left + innerWidth / 2 : pad.left + (index * innerWidth) / (rows.length - 1);
  const yLeft = (value) => pad.top + innerHeight - (Math.max(0, value) / leftMax) * innerHeight;
  const yRight = (value) => pad.top + innerHeight - (Math.max(0, value) / rightMax) * innerHeight;
  const ticks = 4;

  const grid = Array.from({ length: ticks + 1 }, (_, index) => {
    const fraction = index / ticks;
    const yy = pad.top + innerHeight - fraction * innerHeight;
    const leftLabel = hasLeft
      ? `<text class="axis-text" x="${pad.left - 8}" y="${yy + 3}" text-anchor="end">${esc(fmtCount(Math.round(leftMax * fraction)))}</text>`
      : '';
    const rightLabel = hasRight
      ? `<text class="axis-text axis-right" x="${width - pad.right + 8}" y="${yy + 3}">${esc(`${Math.round(rightMax * fraction)}%`)}</text>`
      : '';
    return `<line class="grid-line" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />${leftLabel}${rightLabel}`;
  }).join('');

  const layers = series
    .map((item) => {
      const active = isVisible(item.key);
      const scale = item.axis === 'right' ? yRight : yLeft;
      let path = '';
      let open = false;
      item.values.forEach((value, index) => {
        if (value === null) {
          open = false;
          return;
        }
        path += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${scale(value).toFixed(1)}`;
        open = true;
      });
      const dots = item.values
        .map((value, index) => {
          if (value === null) return '';
          return `<circle class="trend-dot" cx="${x(index).toFixed(1)}" cy="${scale(value).toFixed(1)}" r="2.5">
            <title>${esc(`${rows[index]?.date || ''} · ${item.label} ${item.format(value)}`)}</title>
          </circle>`;
        })
        .join('');
      return `<g class="volume-layer ${item.layer}${active ? '' : ' is-hidden'}" data-layer="${item.key}">
        ${path ? `<path class="trend-series" d="${path}" />` : ''}${dots}
      </g>`;
    })
    .join('');

  const labelIndexes = new Set([0, rows.length - 1, Math.floor((rows.length - 1) / 2)]);
  const xLabels = [...labelIndexes]
    .filter((index) => index >= 0 && index < rows.length)
    .sort((a, b) => a - b)
    .map((index) => {
      const date = String(rows[index]?.date || '');
      return `<text class="axis-text" x="${x(index)}" y="${height - 8}" text-anchor="middle">${esc(date.slice(5))}</text>`;
    })
    .join('');

  const anyVisible = series.some((item) => isVisible(item.key));
  const visible = series.filter((item) => isVisible(item.key));
  const zoneWidth = rows.length > 1 ? innerWidth / (rows.length - 1) : innerWidth;
  const zones = visible.length
    ? rows
        .map((row, index) => {
          if (!visible.some((item) => item.values[index] !== null)) return '';
          const cx = x(index);
          const left = Math.max(pad.left, cx - zoneWidth / 2);
          const right = Math.min(width - pad.right, cx + zoneWidth / 2);
          const tip = [String(row?.date || '')];
          for (const item of visible) {
            const value = item.values[index];
            if (value === null) {
              tip.push(`— · ${item.label}`);
              continue;
            }
            if (item.key === 'failure') {
              const detail = failureByDate.get(row?.date);
              const counts =
                detail && Number.isFinite(detail.failed)
                  ? `（失败 ${fmtCount(detail.failed)} / 请求 ${fmtCount(detail.queries)}${
                      detail.blocked ? ` · 阻塞 ${fmtCount(detail.blocked)}` : ''
                    }）`
                  : '';
              tip.push(`${item.format(value)} · ${item.label}${counts}`);
            } else {
              tip.push(`${item.format(value)} · ${item.label}`);
            }
          }
          return `<rect class="hover-zone" x="${left.toFixed(1)}" y="${pad.top}" width="${(right - left).toFixed(1)}" height="${innerHeight}" data-tip="${esc(tip.join('\n'))}" data-x="${cx.toFixed(1)}" />`;
        })
        .join('')
    : '';

  return `<div class="trend-card wide">${head}<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="调用数与请求失败率趋势">
    ${grid}
    <line class="axis-line" x1="${pad.left}" y1="${pad.top + innerHeight}" x2="${width - pad.right}" y2="${pad.top + innerHeight}" />
    ${layers}
    <text class="trend-all-hidden${anyVisible ? ' is-hidden' : ''}" x="${width / 2}" y="${height / 2}" text-anchor="middle">已隐藏全部曲线</text>
    ${xLabels}
    <line class="hover-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerHeight}" hidden />
    ${zones}
  </svg><p class="chart-note">调用数使用左侧计数轴，请求失败率使用右侧百分比轴（所选模型的请求）。</p></div>`;
}

function p95RangeText(row) {
  const upper = row?.p95_ms;
  if (!Number.isFinite(upper)) return '—';
  const lower = Number.isFinite(row?.p95_lower_ms) ? row.p95_lower_ms : upper;
  return lower === upper ? fmtDuration(upper) : `${fmtDuration(lower)} – ${fmtDuration(upper)}`;
}

// TTFT and P95 are both milliseconds on the left axis. TPOT joins the same
// card on a secondary right axis (ms/token) so every latency curve lives in
// one place and each can be toggled from the legend.
function latencyTrendChart(points, visibility = {}) {
  const rows = Array.isArray(points) ? points : [];
  const isVisible = (key) => visibility?.[key] !== false;
  const series = (key) => rows.map((row) => (Number.isFinite(row?.[key]) ? row[key] : null));
  const ttft = series('ttft_ms');
  const tpot = series('tpot_ms');
  const upper = series('p95_ms');
  const lower = rows.map((row) => {
    if (!Number.isFinite(row?.p95_ms)) return null;
    return Number.isFinite(row?.p95_lower_ms) ? row.p95_lower_ms : row.p95_ms;
  });
  const leftUsable = [...ttft, ...upper].filter((value) => value !== null);
  const tpotUsable = tpot.filter((value) => value !== null);
  const hasTpot = tpotUsable.length > 0;
  const usable = [...leftUsable, ...tpotUsable];

  const legend = [
    { key: 'ttft', label: '平均 TTFT', style: 'ttft' },
    { key: 'tpot', label: '平均 TPOT', style: 'tpot' },
    { key: 'p95_upper', label: 'P95 上界', style: 'p95' },
    { key: 'p95_lower', label: 'P95 下界', style: 'p95 lower' },
  ]
    .map((item) => {
      const active = isVisible(item.key);
      return `<button class="legend-toggle latency-toggle${active ? '' : ' off'}" type="button" data-latency-layer="${item.key}" aria-pressed="${active}">
        <i class="legend-line ${item.style}"></i><span>${item.label}</span>
      </button>`;
    })
    .join('');
  const head = `<div class="trend-head"><h3>延迟（TTFT · TPOT · P95）</h3><div class="trend-legend">${legend}</div></div>`;
  if (!usable.length) return `<div class="trend-card wide">${head}<p class="empty">暂无数据</p></div>`;

  const { width, height } = chartSize(1000, 220);
  const pad = { left: 58, right: hasTpot ? 66 : 18, top: 14, bottom: 30 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = niceMax(leftUsable.length ? Math.max(...leftUsable) : 1);
  const rightMax = niceMax(hasTpot ? Math.max(...tpotUsable) : 1);
  const x = (index) =>
    rows.length === 1 ? pad.left + innerWidth / 2 : pad.left + (index * innerWidth) / (rows.length - 1);
  const y = (value) => pad.top + innerHeight - (Math.max(0, value) / max) * innerHeight;
  const yRight = (value) => pad.top + innerHeight - (Math.max(0, value) / rightMax) * innerHeight;
  const ticks = 4;

  const grid = Array.from({ length: ticks + 1 }, (_, index) => {
    const fraction = index / ticks;
    const yy = pad.top + innerHeight - fraction * innerHeight;
    const leftLabel = leftUsable.length
      ? `<text class="axis-text" x="${pad.left - 8}" y="${yy + 3}" text-anchor="end">${esc(fmtAxis(max * fraction))}</text>`
      : '';
    const rightLabel = hasTpot
      ? `<text class="axis-text axis-right" x="${width - pad.right + 8}" y="${yy + 3}">${esc(
          `${Math.round(rightMax * fraction * 10) / 10}`,
        )}</text>`
      : '';
    return `<line class="grid-line" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />${leftLabel}${rightLabel}`;
  }).join('');

  const runs = [];
  let run = [];
  rows.forEach((_, index) => {
    if (upper[index] === null || lower[index] === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push(index);
  });
  if (run.length) runs.push(run);

  const linePath = (values, scale = y) => {
    let path = '';
    let open = false;
    values.forEach((value, index) => {
      if (value === null) {
        open = false;
        return;
      }
      path += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${scale(value).toFixed(1)}`;
      open = true;
    });
    return path;
  };

  const bands =
    isVisible('p95_upper') && isVisible('p95_lower')
      ? runs
          .filter((segment) => segment.length > 1)
          .map((segment) => {
            const top = segment.map((index) => `${x(index).toFixed(1)},${y(upper[index]).toFixed(1)}`).join('L');
            const bottom = [...segment]
              .reverse()
              .map((index) => `${x(index).toFixed(1)},${y(lower[index]).toFixed(1)}`)
              .join('L');
            return `M${top}L${bottom}Z`;
          })
          .join(' ')
      : '';

  const layer = (key, values, extraClass, dots = true, scale = y) => {
    const paths = linePath(values, scale);
    const marks = dots
      ? values
          .map((value, index) => {
            if (value === null) return '';
            return `<circle class="trend-dot" cx="${x(index).toFixed(1)}" cy="${scale(value).toFixed(1)}" r="3" />`;
          })
          .join('')
      : '';
    return `<g class="latency-layer ${extraClass}${isVisible(key) ? '' : ' is-hidden'}">
      ${paths ? `<path class="trend-series" d="${paths}" />` : ''}${marks}
    </g>`;
  };

  const labelIndexes = new Set([0, rows.length - 1, Math.floor((rows.length - 1) / 2)]);
  const xLabels = [...labelIndexes]
    .filter((index) => index >= 0 && index < rows.length)
    .sort((a, b) => a - b)
    .map((index) => {
      const date = String(rows[index]?.date || '');
      return `<text class="axis-text" x="${x(index)}" y="${height - 8}" text-anchor="middle">${esc(date.slice(5))}</text>`;
    })
    .join('');

  const zoneWidth = rows.length > 1 ? innerWidth / (rows.length - 1) : innerWidth;
  const zones = rows
    .map((row, index) => {
      const lines = [String(row?.date || '')];
      if (isVisible('ttft') && ttft[index] !== null) lines.push(`${fmtDuration(ttft[index])} · 平均 TTFT`);
      if (isVisible('tpot') && tpot[index] !== null) lines.push(`${fmtTpot(tpot[index])} · 平均 TPOT`);
      if (isVisible('p95_upper') && upper[index] !== null) lines.push(`${fmtDuration(upper[index])} · P95 上界`);
      if (isVisible('p95_lower') && lower[index] !== null) lines.push(`${fmtDuration(lower[index])} · P95 下界`);
      if (lines.length === 1) return '';
      const cx = x(index);
      const left = Math.max(pad.left, cx - zoneWidth / 2);
      const right = Math.min(width - pad.right, cx + zoneWidth / 2);
      return `<rect class="hover-zone" x="${left.toFixed(1)}" y="${pad.top}" width="${(right - left).toFixed(1)}" height="${innerHeight}" data-tip="${esc(lines.join('\n'))}" data-x="${cx.toFixed(1)}" />`;
    })
    .join('');

  return `<div class="trend-card wide">${head}<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="平均 TTFT、TPOT 与耗时 P95 区间趋势">
    ${grid}
    <line class="axis-line" x1="${pad.left}" y1="${pad.top + innerHeight}" x2="${width - pad.right}" y2="${pad.top + innerHeight}" />
    ${bands ? `<path class="p95-band" d="${bands}" />` : ''}
    ${layer('ttft', ttft, 'ttft')}
    ${hasTpot ? layer('tpot', tpot, 'tpot', true, yRight) : ''}
    ${layer('p95_upper', upper, 'p95-upper')}
    ${layer('p95_lower', lower, 'p95-lower', false)}
    ${xLabels}
    <line class="hover-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerHeight}" hidden />
    ${zones}
  </svg><p class="chart-note">TTFT 与 P95 共用左侧毫秒轴，TPOT 使用右侧 ms/token 轴；P95 实线为上界、虚线为下界，阴影为区间。</p></div>`;
}

function tokenTrendChart(points, visibility = {}, unit = 'query') {
  const rows = Array.isArray(points) ? points : [];
  const suffix = unit === 'request' ? 'per_request' : 'per_query';
  const unitLabel = unit === 'request' ? '请求' : '提问';
  const definitions = [
    { key: 'input_per_request', field: 'input', label: `输入 / ${unitLabel}`, layer: 'input' },
    { key: 'output_per_request', field: 'output', label: `输出 / ${unitLabel}`, layer: 'output' },
    { key: 'total_per_request', field: 'total', label: `总 Token / ${unitLabel}`, layer: 'total' },
  ];
  const isVisible = (key) => visibility?.[key] !== false;
  const valuesFor = (field) =>
    rows.map((row) => (Number.isFinite(row?.[`${field}_${suffix}`]) ? row[`${field}_${suffix}`] : null));
  const series = definitions.map((definition) => ({
    ...definition,
    values: valuesFor(definition.field),
  }));
  const allValues = series.flatMap((item) => item.values).filter((value) => value !== null);

  const legend = series
    .map((item) => {
      const active = isVisible(item.key);
      return `<button class="legend-toggle${active ? '' : ' off'}" type="button" data-trend-layer="${item.key}" aria-pressed="${active}">
        <i class="legend-swatch ${item.layer}"></i><span>${esc(item.label)}</span>
      </button>`;
    })
    .join('');
  const head = `<div class="trend-head"><h3>Token / ${unitLabel}</h3>
    <div class="trend-tools">
      <div class="trend-legend">${legend}</div>
    </div></div>`;
  if (!allValues.length) return `<div class="trend-card wide">${head}<p class="empty">暂无数据</p></div>`;

  const { width, height } = chartSize(1000, 220);
  const pad = { left: 58, right: 18, top: 14, bottom: 30 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...allValues, 1));
  const x = (index) =>
    rows.length === 1 ? pad.left + innerWidth / 2 : pad.left + (index * innerWidth) / (rows.length - 1);
  const y = (value) => pad.top + innerHeight - (Math.max(0, value) / max) * innerHeight;
  const ticks = 4;

  const grid = Array.from({ length: ticks + 1 }, (_, index) => {
    const value = (max / ticks) * index;
    const yy = y(value);
    return `<line class="grid-line" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />
      <text class="axis-text" x="${pad.left - 8}" y="${yy + 3}" text-anchor="end">${esc(fmtCount(Math.round(value)))}</text>`;
  }).join('');

  const layers = series
    .map((item) => {
      const active = isVisible(item.key);
      let path = '';
      let open = false;
      item.values.forEach((value, index) => {
        if (value === null) {
          open = false;
          return;
        }
        path += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
        open = true;
      });
      const dots = item.values
        .map((value, index) => {
          if (value === null) return '';
          return `<circle class="trend-dot" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2.5">
            <title>${esc(`${rows[index]?.date || ''} · ${item.label} ${fmtToken(value)}`)}</title>
          </circle>`;
        })
        .join('');
      return `<g class="trend-layer ${item.layer}${active ? '' : ' is-hidden'}" data-layer="${item.key}">
        ${path ? `<path class="trend-series" d="${path}" />` : ''}${dots}
      </g>`;
    })
    .join('');

  const labelIndexes = new Set([0, rows.length - 1, Math.floor((rows.length - 1) / 2)]);
  const xLabels = [...labelIndexes]
    .filter((index) => index >= 0 && index < rows.length)
    .sort((a, b) => a - b)
    .map((index) => {
      const date = String(rows[index]?.date || '');
      return `<text class="axis-text" x="${x(index)}" y="${height - 8}" text-anchor="middle">${esc(date.slice(5))}</text>`;
    })
    .join('');

  const anyVisible = series.some((item) => isVisible(item.key));
  const visible = series.filter((item) => isVisible(item.key));
  const zoneWidth = rows.length > 1 ? innerWidth / (rows.length - 1) : innerWidth;
  const zones = visible.length
    ? rows
        .map((row, index) => {
          if (!visible.some((item) => item.values[index] !== null)) return '';
          const cx = x(index);
          const left = Math.max(pad.left, cx - zoneWidth / 2);
          const right = Math.min(width - pad.right, cx + zoneWidth / 2);
          const tip = [
            String(row?.date || ''),
            ...visible.map(
              (item) => `${item.values[index] === null ? '—' : fmtToken(item.values[index])} · ${item.label}`,
            ),
          ].join('\n');
          return `<rect class="hover-zone" x="${left.toFixed(1)}" y="${pad.top}" width="${(right - left).toFixed(1)}" height="${innerHeight}" data-tip="${esc(tip)}" data-x="${cx.toFixed(1)}" />`;
        })
        .join('')
    : '';

  return `<div class="trend-card wide">${head}<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="每次请求 Token 趋势">
    ${grid}
    <line class="axis-line" x1="${pad.left}" y1="${pad.top + innerHeight}" x2="${width - pad.right}" y2="${pad.top + innerHeight}" />
    ${layers}
    <text class="trend-all-hidden${anyVisible ? ' is-hidden' : ''}" id="token-all-hidden" x="${width / 2}" y="${height / 2}" text-anchor="middle">已隐藏全部曲线</text>
    ${xLabels}
    <line class="hover-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerHeight}" hidden />
    ${zones}
  </svg></div>`;
}

function modelTrends(days, tokenVisibility = {}, latencyVisibility = {}, { tokenUnit = 'query', failures = [], volumeVisibility = {} } = {}) {
  return volumeTrendChart(days, failures, volumeVisibility)
    + latencyTrendChart(days, latencyVisibility)
    + tokenTrendChart(days, tokenVisibility, tokenUnit);
}

function modelSummary(days, model, { unit = 'query', failure = null } = {}) {
  if (!days.length) return '<p class="empty">暂无该模型的按日数据。</p>';
  const latest = days[days.length - 1];
  const previous = previousRow(days);
  const hint = (base, delta) => `${base}${delta ? ` · ${delta}` : ''}`;
  const suffix = unit === 'request' ? 'per_request' : 'per_query';
  const unitLabel = unit === 'request' ? '请求' : '提问';
  return `
    <div class="stat-card">
      <div class="stat-label">最新数据</div>
      <div class="stat-value">${esc(latest.date)}</div>
      <div class="stat-hint">${days.length} 天 · ${esc(model)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">当日调用数</div>
      <div class="stat-value">${fmtCount(latest.calls)}</div>
      <div class="stat-hint">${hint('现网调用', deltaChip(latest.calls, previous?.calls))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">平均 TTFT</div>
      <div class="stat-value">${fmtDuration(latest.ttft_ms)}</div>
      <div class="stat-hint">${hint(`${fmtCount(latest.ttft_samples)} 个样本`, deltaChip(latest.ttft_ms, previous?.ttft_ms, { lowerIsBetter: true }))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">平均 TPOT</div>
      <div class="stat-value">${fmtTpot(latest.tpot_ms)}</div>
      <div class="stat-hint">${hint(`${fmtCount(latest.tpot_samples)} 个样本`, deltaChip(latest.tpot_ms, previous?.tpot_ms, { lowerIsBetter: true }))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">耗时 P95 区间</div>
      <div class="stat-value">${esc(p95RangeText(latest))}</div>
      <div class="stat-hint">${hint(`${fmtCount(latest.duration_samples)} 个样本`, deltaChip(latest.p95_ms, previous?.p95_ms, { lowerIsBetter: true }))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">输入 Token / ${unitLabel}</div>
      <div class="stat-value">${fmtToken(latest[`input_${suffix}`])}</div>
      <div class="stat-hint">${hint(`当日合计 ${fmtToken(latest.input_tokens)}`, deltaChip(latest[`input_${suffix}`], previous?.[`input_${suffix}`], { colorDirection: true }))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">输出 Token / ${unitLabel}</div>
      <div class="stat-value">${fmtToken(latest[`output_${suffix}`])}</div>
      <div class="stat-hint">${hint(`当日合计 ${fmtToken(latest.output_tokens)}`, deltaChip(latest[`output_${suffix}`], previous?.[`output_${suffix}`], { colorDirection: true }))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">总 Token / ${unitLabel}</div>
      <div class="stat-value">${fmtToken(latest[`total_${suffix}`])}</div>
      <div class="stat-hint">${hint(`当日合计 ${fmtToken(latest.total_tokens)}`, deltaChip(latest[`total_${suffix}`], previous?.[`total_${suffix}`], { colorDirection: true }))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">请求失败率</div>
      <div class="stat-value ${failure ? (failure.failed ? 'failed' : 'ok') : ''}">${failure ? fmtPercent(failure.failure_rate) : '—'}</div>
      <div class="stat-hint">${failure ? `所选模型 · 失败 ${fmtCount(failure.failed)} / 请求 ${fmtCount(failure.queries)}${failure.blocked ? ` · 阻塞 ${fmtCount(failure.blocked)}` : ''}` : '暂无请求数据'}</div>
    </div>
  `;
}

// Day-over-day increases at or above this percentage are treated as
// regressions worth flagging to whoever is triaging the dashboard.
const REGRESSION_THRESHOLD = 20;

function modelMetricTable(rows, { label = '日期', dateKey = 'date', unit = 'query', showVersion = false } = {}) {
  if (!Array.isArray(rows) || !rows.length) return '<p class="empty">暂无统计数据。</p>';
  const suffix = unit === 'request' ? 'per_request' : 'per_query';
  const unitLabel = unit === 'request' ? '请求' : '提问';
  const versionHead = showVersion ? '<th>版本</th>' : '';
  const body = [...rows]
    .map((row, index) => {
      const prior = index > 0 ? rows[index - 1] : null;
      const previous = prior && (!row.date || addDays(prior.date, 1) === row.date) ? prior : null;
      const ttftChip = deltaChip(row?.ttft_ms, previous?.ttft_ms, { lowerIsBetter: true, label: '' });
      const tpotChip = deltaChip(row?.tpot_ms, previous?.tpot_ms, { lowerIsBetter: true, label: '' });
      const p95Chip = deltaChip(row?.p95_ms, previous?.p95_ms, { lowerIsBetter: true, label: '' });
      const versionCell = showVersion
        ? `<td class="run-id" title="${esc([row?.run_id, row?.commit].filter(Boolean).join(' · '))}">${esc(shortVersion(row) || '—')}</td>`
        : '';
      return `<tr>
        <td>${esc(row?.[dateKey] ?? '—')}</td>${versionCell}
        <td class="num">${fmtCount(row?.calls)}</td>
        <td class="num">${fmtCount(row?.queries)}</td>
        <td class="num">${fmtPercent(row?.failure_rate)}</td>
        <td class="num metric-column"><span class="metric-cell"><span>${fmtDuration(row?.ttft_ms)}</span><span class="metric-samples">（${fmtCount(row?.ttft_samples)}）</span><span class="metric-change">${ttftChip}</span></span></td>
        <td class="num metric-column"><span class="metric-cell"><span>${fmtTpot(row?.tpot_ms)}</span><span class="metric-samples">（${fmtCount(row?.tpot_samples)}）</span><span class="metric-change">${tpotChip}</span></span></td>
        <td class="num metric-column"><span class="metric-cell"><span>${esc(p95RangeText(row))}</span><span class="metric-samples">（${fmtCount(row?.duration_samples)}）</span><span class="metric-change">${p95Chip}</span></span></td>
        <td class="num">${fmtToken(row?.[`input_${suffix}`])}</td>
        <td class="num">${fmtToken(row?.[`output_${suffix}`])}</td>
        <td class="num">${fmtToken(row?.[`total_${suffix}`])}</td>
      </tr>`;
    })
    .reverse()
    .join('');
  return `<div class="table-wrap"><table class="history-table">
    <thead><tr><th>${esc(label)}</th>${versionHead}<th>调用数</th><th>请求数</th><th title="所选模型的失败请求占全部请求的比例；未知状态时不显示">请求失败率</th><th class="metric-column">平均 TTFT（样本）</th><th class="metric-column">平均 TPOT（样本）</th><th class="metric-column">耗时 P95 区间（样本）</th><th>输入 / ${unitLabel}</th><th>输出 / ${unitLabel}</th><th>总 Token / ${unitLabel}</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// The shortest stable identifier for the run that produced a row: prefer the
// git commit, fall back to the run id, and keep nightly uuids compact.
function shortVersion(row) {
  const commit = typeof row?.commit === 'string' ? row.commit.trim() : '';
  if (commit) return commit.slice(0, 10);
  const run = typeof row?.run_id === 'string' ? row.run_id.trim() : '';
  if (!run) return '';
  return run.length <= 18 ? run : `${run.slice(0, 8)}…`;
}

// Regressions worth surfacing: day-over-day increases at or above the
// threshold for the latency-oriented metrics.
function regressionFindings(latest, previous) {
  const findings = [];
  if (!latest || !previous) return findings;
  const checks = [
    ['平均 TTFT', latest.ttft_ms, previous.ttft_ms],
    ['平均 TPOT', latest.tpot_ms, previous.tpot_ms],
    ['P95 上界', latest.p95_ms, previous.p95_ms],
  ];
  for (const [label, current, prior] of checks) {
    if (!Number.isFinite(current) || !Number.isFinite(prior) || prior <= 0) continue;
    const change = ((current - prior) / prior) * 100;
    if (change >= REGRESSION_THRESHOLD) findings.push({ label, change });
  }
  return findings;
}

// A slim banner above the model cards when the latest day regresses; an empty
// string keeps the page clean on quiet days.
function regressionBanner(days, failures = []) {
  if (!Array.isArray(days) || days.length < 2) return '';
  const latest = days[days.length - 1];
  const previous = previousRow(days);
  if (!previous) return '';
  const notes = regressionFindings(latest, previous).map(
    (finding) => `${finding.label} ▲${Math.round(finding.change)}%`,
  );
  const failureByDate = new Map((Array.isArray(failures) ? failures : []).map((row) => [row?.date, row]));
  const latestFailure = failureByDate.get(latest.date);
  if (latestFailure && Number.isFinite(latestFailure.failure_rate) && latestFailure.failure_rate > 0) {
    const previousRate = Number.isFinite(failureByDate.get(previous.date)?.failure_rate)
      ? failureByDate.get(previous.date).failure_rate
      : 0;
    // A jump from zero (or a doubling) is the signal; small absolute rates stay quiet.
    if (latestFailure.failure_rate >= Math.max(previousRate * 2, previousRate + 5)) {
      notes.push(
        `请求失败率升至 ${fmtPercent(latestFailure.failure_rate)}（失败 ${fmtCount(latestFailure.failed)} / 请求 ${fmtCount(latestFailure.queries)}）`,
      );
    }
  }
  if (!notes.length) return '';
  return `<div class="insight-banner" role="status">⚠ ${esc(latest.date)} 较前一日：${esc(notes.join(' · '))}（回退阈值 ≥${REGRESSION_THRESHOLD}%）</div>`;
}

// Range-wide totals per model so the comparison card can sit above the
// per-model drill-down; rows reuse the same weighted merging as weekly stats.
// Unlike the per-model range control, the window is anchored at the newest
// data date across ALL models, so every row covers the same calendar days.
function modelComparison(history, rangeDays = 0) {
  const perModel = new Map();
  let end = '';
  for (const name of benchmarkModelNames(history)) {
    const days = modelSeries(history, name);
    if (days.length) end = end > days[days.length - 1].date ? end : days[days.length - 1].date;
    perModel.set(name, days);
  }
  const span = Number(rangeDays);
  const start = Number.isFinite(span) && span > 0 && end ? addDays(end, -(Math.floor(span) - 1)) : '';
  const rows = [];
  for (const [name, days] of perModel) {
    const scoped = start ? days.filter((day) => day.date >= start && day.date <= end) : days;
    const acc = newMetricAccumulator();
    for (const day of scoped) mergeMetricRow(acc, day);
    rows.push({
      name,
      hasData: scoped.length > 0,
      totals: finalizeMetricAccumulator(acc),
      latest: scoped[scoped.length - 1],
      previous: previousRow(scoped),
    });
  }
  return rows;
}

function modelCompareCard(rows, { selected = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return '<p class="empty">暂无模型数据。</p>';
  const body = rows
    .map((row) => {
      const regressing = regressionFindings(row.latest, row.previous).length > 0;
      const chip = deltaChip(row.latest?.ttft_ms, row.previous?.ttft_ms, { lowerIsBetter: true, label: '' });
      return `<tr data-compare-model="${esc(row.name)}"${row.name === selected ? ' class="is-selected"' : ''}>
        <td class="mono-cell"><button type="button" class="compare-model-button" data-select-model="${esc(row.name)}" aria-pressed="${row.name === selected}">${esc(row.name)}</button>${row.name === selected ? ' <span class="selected-model-badge">当前查看</span>' : ''}${regressing ? ' <span class="badge failed">回退</span>' : ''}</td>
        <td class="num">${row.hasData ? fmtCount(row.totals.calls) : '无数据'}</td>
        <td class="num">${fmtDuration(row.totals.ttft_ms)}</td>
        <td class="num">${fmtTpot(row.totals.tpot_ms)}</td>
        <td class="num">${esc(p95RangeText(row.totals))}</td>
        <td class="num">${fmtToken(row.totals.output_per_query)}</td>
        <td class="num">${fmtDuration(row.latest?.ttft_ms)}${chip ? ` ${chip}` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="history-table compare-table">
    <thead><tr><th>模型</th><th>调用数</th><th>平均 TTFT</th><th>平均 TPOT</th><th>耗时 P95 区间</th><th>输出 / 请求</th><th>最新 TTFT 较前日</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// The freshest point across all cases identifies the current data drop.
function latestDataPoint(history) {
  let latest = null;
  for (const entry of Object.values(history?.cases || {})) {
    for (const point of entry?.points || []) {
      if (!latest || String(point?.finished_at || '') >= String(latest.finished_at || '')) latest = point;
    }
  }
  return latest;
}

function versionLine(history) {
  const point = latestDataPoint(history);
  if (!point) return '暂无采集信息';
  const parts = [];
  if (point.run_id) parts.push(`run ${point.run_id}`);
  const commit = typeof point.commit === 'string' ? point.commit.trim() : '';
  if (commit) parts.push(`commit ${commit.slice(0, 10)}`);
  if (point.finished_at) parts.push(`完成于 ${fmtDateTime(point.finished_at)}`);
  return parts.join(' · ') || '暂无采集信息';
}

function historyTable(points) {
  const rows = [...(points || [])].reverse();
  if (!rows.length) return '<p class="empty">暂无执行历史。</p>';
  return `<div class="table-wrap"><table class="history-table">
    <thead><tr><th>日期</th><th>状态</th><th>平均查询</th><th>查询数</th><th>运行</th><th>commit</th></tr></thead>
    <tbody>${rows
      .map(
        (point) => `<tr>
          <td>${esc(point.date)}</td>
          <td><span class="badge ${statusClass(point.status)}">${esc(statusLabel(point.status))}</span></td>
          <td class="num">${fmtDuration(point.query_ms)}</td>
          <td class="num">${point.query_count ?? 0}</td>
          <td class="run-id" title="${esc(point.run_id)}">${esc(point.run_id || '—')}</td>
          <td class="run-id">${esc((point.commit || '').slice(0, 10) || '—')}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

function renderDetail() {
  const entry = state.history?.cases?.[state.selected];
  if (!entry) {
    $('detail').innerHTML = '<div class="detail-placeholder">选择左侧用例查看性能。</div>';
    return;
  }

  const latest = entry.latest;
  const points = [...(entry.points || [])].sort((a, b) => a.date.localeCompare(b.date));
  const point = latestPoint(entry);
  const status = latest?.status || point?.status || 'UNKNOWN';
  const queries = Array.isArray(latest?.queries) ? latest.queries : [];
  const durations = points.map((item) => item.query_ms).filter(Number.isFinite);
  const device = latest?.device;
  const queryCount = latest?.query_count ?? queries.length;
  const latestMeta = [
    latest?.finished_at ? `完成于 ${fmtDateTime(latest.finished_at)}` : null,
    latest?.run_id ? `run ${latest.run_id}` : null,
    latest?.commit ? `commit ${latest.commit}` : null,
    device?.model ? `设备 ${device.model}` : null,
    latest?.duration_ms != null ? `E2E 总耗时 ${fmtDuration(latest.duration_ms)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const chartNote =
    points.length === 1
      ? `当前只有 1 个按日数据点（${esc(points[0].date)}）；后续 nightly 每天追加一个点，形成查询耗时曲线。`
      : '按 Asia/Shanghai 日历日聚合；每点为当轮 query 平均耗时，仅 profiling，不含 E2E 步骤等待；同一天重跑只保留最新完成的一次。';

  $('detail').innerHTML = `
    <div class="detail-head">
      <div>
        <h2 class="detail-id">${esc(entry.id)}</h2>
        <p class="detail-title">${esc(entry.title || '')}</p>
        <p class="detail-meta">${esc(latestMeta || '暂无最近一次运行信息')}</p>
      </div>
      <span class="badge ${statusClass(status)}">${esc(statusLabel(status))}</span>
    </div>

    <div class="stat-grid">
      <div class="small-stat"><div class="k">本轮平均查询</div><div class="v">${fmtDuration(point?.query_ms)}</div></div>
      <div class="small-stat"><div class="k">历史中位数</div><div class="v">${fmtDuration(median(durations))}</div></div>
      <div class="small-stat"><div class="k">查询次数</div><div class="v">${queryCount}</div></div>
      <div class="small-stat"><div class="k">记录天数</div><div class="v">${points.length}</div></div>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>最近一次 Profiling · 查询耗时</h2>
        <span class="muted">${latest ? `${queryCount} 次查询 · ${esc(latest.screenshots ?? 0)} 截图 · ${esc(latest.profiling_files ?? 0)} profiling` : '—'}</span>
      </div>
      ${queryWaterfall(latest)}
    </section>

    <section class="card">
      <div class="card-head"><h2>基准用例模型性能</h2><span class="muted">仅统计已关联调用</span></div>
      ${benchmarkMetrics(latest)}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>每日平均查询耗时</h2>
        <span class="muted">一天一个点 · Asia/Shanghai</span>
      </div>
      ${dailyChart(points)}
      <p class="chart-note">${chartNote}</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>执行历史</h2>
        <span class="muted">${points.length} 天</span>
      </div>
      ${historyTable(points)}
    </section>
  `;
}

function syncRangeButtons(disabled = false) {
  document.querySelectorAll('.range-btn').forEach((button) => {
    const active = Number(button.dataset.range || 0) === state.rangeDays;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = disabled;
  });
}

function currentModelDays() {
  if (!state.history || !state.model) return [];
  return inRange(modelSeries(state.history, state.model), state.rangeDays, latestModelDate(state.history));
}

function renderTrends() {
  hideChartHover();
  const target = $('model-trends');
  if (!target) return;
  if (!state.history || !state.model) {
    target.innerHTML = '<p class="empty">暂无模型数据。</p>';
    return;
  }
  const days = currentModelDays();
  target.innerHTML = modelTrends(days, state.tokenVisibility, state.latencyVisibility, {
    tokenUnit: state.tokenUnit,
    failures: failureSeries(state.history, days, state.model),
    volumeVisibility: state.volumeVisibility,
  });
}

function renderModels() {
  hideChartHover();
  const history = state.history;
  if (!history) return;
  const names = benchmarkModelNames(history);
  // A model named in the URL hash wins once, then falls back to the busiest.
  if (state.hashModel) {
    if (names.includes(state.hashModel)) state.model = state.hashModel;
    state.hashModel = null;
  } else if (!names.includes(state.model)) {
    state.model = names[0] || null;
  }

  const granularitySelect = $('granularity-select');
  if (granularitySelect && granularitySelect.value !== state.granularity) {
    granularitySelect.value = state.granularity;
  }

  const currentModel = $('current-model');
  const summary = $('model-summary');
  const trends = $('model-trends');
  const stats = $('model-stats');
  const range = $('daily-range');
  const scope = $('model-range');
  const insights = $('model-insights');
  const compare = $('model-compare');
  const compareVersion = $('compare-version');
  if (!names.length) {
    if (currentModel) currentModel.textContent = '';
    const empty =
      '<p class="empty">历史中没有可确认关联的基准模型调用。nightly 产生 <code>points[].benchmark_models</code> 后，这里会按天展示 TTFT、TPOT、耗时 P95 与 Token 曲线。</p>';
    if (summary) summary.innerHTML = '';
    if (trends) trends.innerHTML = empty;
    if (stats) stats.innerHTML = '<p class="empty">暂无统计数据。</p>';
    if (insights) insights.innerHTML = '';
    if (compare) compare.innerHTML = '<p class="empty">暂无模型数据。</p>';
    if (compareVersion) compareVersion.textContent = '暂无可选模型';
    if (range) range.textContent = 'Asia/Shanghai';
    if (scope) scope.textContent = '暂无可选模型';
    syncRangeButtons(true);
    return;
  }

  if (currentModel) currentModel.textContent = `当前模型：${state.model}`;
  const days = currentModelDays();
  const weeks = weekSeries(days);
  const failures = failureSeries(history, days, state.model);
  const dailyRates = new Map(failures.map((row) => [row.date, row.failure_rate]));
  const weeklyRates = weeklyFailureRates(failures);
  const latestFailure = failures.find((row) => row.date === days.at(-1)?.date && Number.isFinite(row.failure_rate)) || null;
  const span = days.length
    ? `${days[0].date} 至 ${days[days.length - 1].date} · ${days.length} 天`
    : '暂无数据';
  if (insights) insights.innerHTML = regressionBanner(days, failures);
  if (compare) {
    compare.innerHTML = modelCompareCard(modelComparison(history, state.rangeDays), { selected: state.model });
  }
  if (compareVersion) compareVersion.textContent = versionLine(history);
  if (summary) summary.innerHTML = modelSummary(days, state.model, { unit: state.tokenUnit, failure: latestFailure });
  if (trends) {
    trends.innerHTML = modelTrends(days, state.tokenVisibility, state.latencyVisibility, {
      tokenUnit: state.tokenUnit,
      failures,
      volumeVisibility: state.volumeVisibility,
    });
  }
  if (stats) {
    stats.innerHTML =
      state.granularity === 'weekly'
        ? modelMetricTable(weeks.map((row) => ({ ...row, failure_rate: weeklyRates.get(row.week_start) ?? null })), { label: '周（周一至周日）', dateKey: 'week_label', unit: state.tokenUnit })
        : modelMetricTable(days.map((row) => ({ ...row, failure_rate: dailyRates.get(row.date) ?? null })), { label: '日期', unit: state.tokenUnit, showVersion: true });
  }
  if (range) {
    range.textContent = state.granularity === 'weekly' ? `周一至周日 · ${span}` : span;
  }
  if (scope) scope.textContent = span;
  syncRangeButtons(false);
  // Keep the URL shareable: model, range and granularity round-trip through
  // the hash so a version manager can paste a link straight into an issue.
  if (state.view === 'models') {
    try {
      window.history.replaceState(null, '', modelsHash());
    } catch {
      // file:// and sandboxed frames may refuse history updates; tabs still work.
    }
  }
}

// The models view round-trips model / range / granularity through the hash
// (#models?model=…&range=…&granularity=…) so a link pasted into an issue or
// release note reopens the exact same view.
function modelsHash() {
  const params = new URLSearchParams();
  if (state.model) params.set('model', state.model);
  params.set('range', String(state.rangeDays));
  params.set('granularity', state.granularity);
  return `#models?${params.toString()}`;
}

function applyModelsHash() {
  const queryIndex = location.hash.indexOf('?');
  if (queryIndex < 0) return;
  const params = new URLSearchParams(location.hash.slice(queryIndex + 1));
  const model = params.get('model');
  if (model) state.hashModel = model;
  const range = Number(params.get('range'));
  if (Number.isFinite(range) && range > 0) state.rangeDays = Math.min(Math.floor(range), 365);
  const granularity = params.get('granularity');
  if (granularity === 'daily' || granularity === 'weekly') state.granularity = granularity;
}

function showView(view, { updateHash = true } = {}) {
  hideChartHover();
  const next = view === 'models' ? 'models' : 'cases';
  state.view = next;
  const models = next === 'models';
  const casesView = $('view-cases');
  const modelsView = $('view-models');
  if (casesView) casesView.hidden = models;
  if (modelsView) modelsView.hidden = !models;
  document.querySelectorAll('.tab[data-view]').forEach((tab) => {
    const active = tab.dataset.view === next;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  if (models) applyModelsHash();
  if (updateHash) {
    const hash = models ? modelsHash() : '#cases';
    if (location.hash !== hash) {
      try {
        history.replaceState(null, '', hash);
      } catch {
        // file:// and sandboxed frames may refuse history updates; tabs still work.
      }
    }
  }
  if (models && state.history) renderModels();
}

function viewFromHash() {
  return location.hash.startsWith('#models') ? 'models' : 'cases';
}

function render() {
  if (!state.history) return;
  renderHeader();
  renderSummary();
  renderPerfStrip();
  renderCaseList();
  renderDetail();
}

function showError(message) {
  const banner = $('error');
  banner.hidden = false;
  banner.textContent = message;
  $('summary').innerHTML = '';
  $('case-list').innerHTML = '';
  $('detail').innerHTML = '<div class="detail-placeholder">无法加载数据。</div>';
  $('model-summary').innerHTML = '';
  $('model-trends').innerHTML = '<p class="empty">无法加载数据。</p>';
  $('model-stats').innerHTML = '';
  const insights = $('model-insights');
  if (insights) insights.innerHTML = '';
  const compare = $('model-compare');
  if (compare) compare.innerHTML = '';
}

// The dashboard ships in two layouts: standalone (a data/ directory next to
// this file) and embedded in the CI dashboard, where board data is assembled
// one level up under data/e2e-performance/. Try the standalone layout first
// and fall back to the assembled board layout.
const DATA_BASES = ['data/', '../data/e2e-performance/']

async function fetchDataJson(name, options) {
  let lastError = null
  for (const base of DATA_BASES) {
    try {
      const response = await fetch(base + name, options)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error(`无法加载 ${name}`)
}

// The production snapshot is optional and may live behind a slow private data
// path. Load it independently so it can never delay or fail the history view.
async function loadProductionMetrics() {
  const target = $('production-metrics');
  if (!target) return;
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(10000)
    : undefined;
  try {
    const response = await fetchDataJson('model-request-metrics.json', { cache: 'no-store', signal });
    target.innerHTML = productionMetrics(await response.json());
  } catch {
    target.innerHTML = productionMetrics(null);
  }
}

async function load() {
  try {
    const response = await fetch('../data/production-model-history.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = await response.json();
    if (!history || typeof history !== 'object' || !history.cases) {
      throw new Error('history.json 缺少 cases');
    }
    state.history = history;
    state.model = benchmarkModelNames(history)[0] || null;
    void loadProductionMetrics();
    const cases = sortedCases();
    state.selected = cases.find((entry) => entry.id === 'DM-WF-BACK-01')?.id || cases[0]?.id || null;
    render();
    showView(viewFromHash(), { updateHash: false });
  } catch (error) {
    const hint =
      location.protocol === 'file:'
        ? '请从 dashboard/e2e-performance 目录启动本地 HTTP 服务，例如：python3 -m http.server 8787'
        : '请配置现网每日聚合数据（production-model-history.json）。';
    showError(`现网性能指标暂不可用：${error.message}。${hint}`);
  }
}

$('case-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-case-id]');
  if (!button) return;
  state.selected = button.dataset.caseId;
  render();
});

$('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  showView(button.dataset.view);
});

// The comparison card doubles as a switcher: clicking a row drills into that
// model's summary, trends and table below.
$('model-compare').addEventListener('click', (event) => {
  const row = event.target.closest('[data-compare-model]');
  if (!row) return;
  const restoreFocus = event.target.closest('[data-select-model]') !== null;
  state.model = row.dataset.compareModel;
  renderModels();
  if (restoreFocus) {
    const button = [...document.querySelectorAll('[data-select-model]')].find((item) => item.dataset.selectModel === state.model);
    button?.focus();
  }
});

$('granularity-select').addEventListener('change', (event) => {
  state.granularity = event.target.value === 'weekly' ? 'weekly' : 'daily';
  renderModels();
});

$('model-controls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-range]');
  if (!button || button.disabled) return;
  const value = Number(button.dataset.range);
  state.rangeDays = Number.isFinite(value) && value > 0 ? value : 0;
  renderModels();
});

$('model-trends').addEventListener('click', (event) => {
  const latency = event.target.closest('[data-latency-layer]');
  if (latency) {
    const key = latency.dataset.latencyLayer;
    state.latencyVisibility[key] = latency.getAttribute('aria-pressed') !== 'true';
    renderTrends();
    const next = document.querySelector(`#model-trends [data-latency-layer="${key}"]`);
    if (next) next.focus();
    return;
  }
  const volume = event.target.closest('[data-volume-layer]');
  if (volume) {
    const key = volume.dataset.volumeLayer;
    state.volumeVisibility[key] = volume.getAttribute('aria-pressed') !== 'true';
    renderTrends();
    const next = document.querySelector(`#model-trends [data-volume-layer="${key}"]`);
    if (next) next.focus();
    return;
  }
  const button = event.target.closest('[data-trend-layer]');
  if (!button) return;
  const key = button.dataset.trendLayer;
  state.tokenVisibility[key] = button.getAttribute('aria-pressed') !== 'true';
  renderTrends();
  const next = document.querySelector(`#model-trends [data-trend-layer="${key}"]`);
  if (next) next.focus();
});

// One hover readout for every chart: a crosshair snaps to the nearest date and
// a single tooltip reports that point. Values also live in the tables below.
const chartTooltip = $('chart-tooltip');
let activeChart = null;

function hideChartHover() {
  if (activeChart) {
    activeChart.querySelectorAll('.hover-line, .hover-dot').forEach((mark) => {
      mark.hidden = true;
    });
    activeChart = null;
  }
  if (chartTooltip) chartTooltip.hidden = true;
}

function showChartHover(zone, clientX, clientY) {
  const tip = zone.dataset.tip;
  if (!tip || !chartTooltip) return;
  const svg = zone.closest('svg');
  if (!svg) return;
  if (svg !== activeChart) {
    hideChartHover();
    activeChart = svg;
  }
  const line = svg.querySelector('.hover-line');
  if (line) {
    line.setAttribute('x1', zone.dataset.x);
    line.setAttribute('x2', zone.dataset.x);
    line.hidden = false;
  }
  const dot = svg.querySelector('.hover-dot');
  if (dot && zone.dataset.y) {
    dot.setAttribute('cx', zone.dataset.x);
    dot.setAttribute('cy', zone.dataset.y);
    dot.hidden = false;
  }
  chartTooltip.textContent = tip;
  chartTooltip.hidden = false;
  const box = chartTooltip.getBoundingClientRect();
  let left = clientX + 14;
  let top = clientY + 14;
  if (left + box.width > window.innerWidth - 10) left = clientX - box.width - 14;
  if (top + box.height > window.innerHeight - 10) top = clientY - box.height - 14;
  chartTooltip.style.left = `${Math.max(10, left)}px`;
  chartTooltip.style.top = `${Math.max(10, top)}px`;
}

document.addEventListener('pointermove', (event) => {
  const zone = event.target.closest?.('.hover-zone');
  if (!zone) {
    hideChartHover();
    return;
  }
  showChartHover(zone, event.clientX, event.clientY);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideChartHover();
});

window.addEventListener('scroll', hideChartHover, { passive: true });

$('tabs').addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('.tab[data-view]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  showView(tabs[next].dataset.view);
});

window.addEventListener('hashchange', () => showView(viewFromHash(), { updateHash: false }));

// Chart viewBoxes are sized at render time, so redraw after the layout settles
// on a different width (rotation, window resize).
let chartResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (!state.history) return;
    if (state.view === 'models') renderTrends();
    else if (state.selected) renderDetail();
  }, 160);
});

showView(viewFromHash(), { updateHash: false });
load();

// Keep the embedded view as tall as its content.
if (window.parent !== window) {
  const reportHeight = () => window.parent.postMessage({ type: 'production-metrics-height', height: document.documentElement.scrollHeight }, location.origin);
  new ResizeObserver(reportHeight).observe(document.body);
  window.addEventListener('load', reportHeight);
}
