/* A public, per-case Real E2E view. The snapshot contains only bounded score fields. */
(() => {
  'use strict';
  const root = document.getElementById('real-case-detail');
  const params = new URLSearchParams(location.search);
  const wantedCase = params.get('case') || '';
  const wantedLine = params.get('line') || '';
  const boardUrl = `./?returnLine=${encodeURIComponent(wantedLine)}&returnCase=${encodeURIComponent(wantedCase)}#tests`;
  document.querySelector('.report-actions a').href = boardUrl;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const safeRunUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : '';
    } catch (_) { return ''; }
  };
  const link = (url, label) => {
    const safe = safeRunUrl(url);
    return safe ? `<a href="${escape(safe)}" target="_blank" rel="noopener">${escape(label)}</a>` : escape(label);
  };
  const beijingDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  };
  const duration = (value) => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const seconds = Math.round(Number(value) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  };
  const metricValue = (metric) => {
    const value = metric?.value;
    if (value == null || !Number.isFinite(Number(value))) return '不可用';
    if (metric.unit === 'percent') return `${Number(value).toFixed(1)}%`;
    if (metric.unit === 'score100') return `${Number(value).toFixed(2)} / 100`;
    if (metric.unit === 'ratio') return Number(value).toFixed(4);
    return String(value);
  };
  const sourceLabel = (metric) => metric.source === 'carried' ? '沿用上次实测'
    : metric.source === 'baseline' ? '无历史，按 0 展示'
      : metric.value == null ? (metric.status || '未评分') : '';
  const familyName = {
    deepresearchbench: 'DeepResearchBench', biomnibench: 'BiomniBench',
    'research-team': 'Research Team', 'evolve-compression': 'PUCT Compression',
  };
  const deliveryName = (value) => value === 'passed' ? '通过' : value === 'failed' ? '失败' : '未知';
  const qualityName = (value) => value === 'error' || value === 'failed' ? '评分异常'
    : value === 'scored' || value === 'completed' || value === 'passed' ? '已评分' : value || '未知';
  const reportRow = (name, value) => `<tr><th>${escape(name)}</th><td>${value}</td></tr>`;
  const scoreTable = (history) => {
    const metrics = new Map();
    for (const point of [...history].reverse()) for (const metric of point.metrics || []) {
      const key = `${metric.label}\u0000${metric.unit}`;
      if (!metrics.has(key)) metrics.set(key, { label: metric.label, unit: metric.unit, latest: null, values: [] });
      const row = metrics.get(key);
      if (point === history.at(-1)) row.latest = metric;
      if ((metric.source === 'measured' || (!metric.source && point.delivery === 'passed')) && Number.isFinite(metric.value)) row.values.push(metric.value);
    }
    if (!metrics.size) return '<p class="empty">没有可读取的评分指标。</p>';
    return `<table class="metric-table"><thead><tr><th>指标</th><th>最新</th><th>平均（实测）</th></tr></thead><tbody>${[...metrics.values()].map((row) => {
      const latest = row.latest;
      const latestText = latest ? `<strong>${escape(metricValue(latest))}</strong>${sourceLabel(latest) ? ` <span class="muted">${escape(sourceLabel(latest))}</span>` : ''}` : '—';
      const average = row.values.length ? escape(metricValue({ value: row.values.reduce((sum, value) => sum + value, 0) / row.values.length, unit: row.unit })) : '—';
      return `<tr><th>${escape(row.label)}</th><td>${latestText}</td><td>${average}</td></tr>`;
    }).join('')}</tbody></table>`;
  };
  const outcomeClass = (delivery) => delivery === 'passed' ? 'PASS' : delivery === 'failed' ? 'FAIL' : 'UNKNOWN';
  const statusBadge = (delivery) => `<span class="badge ${delivery === 'passed' || delivery === 'failed' ? delivery : 'unknown'}">${escape(deliveryName(delivery))}</span>`;

  function render(snapshot) {
    const line = (snapshot.lines || []).find((item) => item.key === wantedLine);
    if (!line || !wantedCase || wantedCase.length > 100) {
      root.innerHTML = '<p>未找到对应的分支线或用例。<a href="./#tests">返回 E2E 看板</a></p>';
      return;
    }
    const data = (line.default ? snapshot.sections?.tests : snapshot.line_sections?.[line.key]?.tests)?.data || {};
    const report = data.score_report || data.executed?.find((item) => item.artifact?.startsWith('real-e2e-results') && item.scores?.length);
    const scoredCase = report?.scores?.find((item) => item.case === wantedCase);
    const history = (data.score_history?.[wantedCase] || (scoredCase ? [{ ...scoredCase,
      run_id: report.run_id, attempt: report.attempt, created_at: report.created_at, url: report.url }] : []))
      .slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.run_id) - Number(b.run_id));
    if (!history.length) {
      root.innerHTML = `<p>当前 <code>${escape(line.ref)}</code> 分支线没有 ${escape(wantedCase)} 的可读取记录。<a href="./#tests">返回 E2E 看板</a></p>`;
      return;
    }
    const latest = history.at(-1);
    const family = scoredCase?.family || latest.family || '';
    const newerUnreadable = (data.score_runs || []).filter((run) =>
      run.artifact_status !== 'available' && Date.parse(run.created_at) > Date.parse(latest.created_at));
    document.title = `旅程报告 · ${wantedCase}`;
    const ordered = [...history].reverse();
    const journeyPoint = ordered.find((point) => point.journey?.goal || point.journey?.preconditions?.length || point.journey?.step_summary || point.journey?.steps?.length);
    const journey = journeyPoint?.journey || scoredCase?.journey || {};
    const reported = (value) => value ? escape(value) : '<span class="muted">当前已读取记录未提供</span>';
    const preconditions = journey.preconditions?.length
      ? `<ul>${journey.preconditions.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`
      : '<p class="muted">当前已读取记录未提供前置条件。</p>';
    const steps = journey.steps?.length
      ? `<table class="history-table"><thead><tr><th>用户步骤</th><th>用户应看到</th><th>结果</th><th>耗时</th></tr></thead><tbody>${journey.steps.map((step) => `<tr><td>${escape(step.title)}</td><td>${escape(step.expected)}</td><td>${escape(step.result)}</td><td>${escape(step.duration)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="muted">${escape(journey.step_summary || '当前已读取记录未提供逐步骤记录。')}</p>`;
    const meta = journey.metadata || {};
    const model = latest.model || scoredCase?.model || meta.model;
    const historyRows = ordered.map((point) => `<tr class="real-history-row">
      <td>${escape(beijingDate(point.created_at))}</td>
      <td>${statusBadge(point.delivery)}</td><td>${escape(qualityName(point.quality_status))}</td>
      <td>${escape(duration(point.duration_ms))}</td><td>${link(point.url, `run ${point.run_id}`)}</td>
    </tr>`).join('');
    root.innerHTML = `<h1>旅程报告 · ${escape(wantedCase)}</h1>
      <p><span class="outcome ${outcomeClass(latest.delivery)}">${outcomeClass(latest.delivery)}</span></p>
      <table class="report-meta"><tbody>
        ${reportRow('结果', escape(deliveryName(latest.delivery)))}
        ${reportRow('分支', `<code>${escape(line.ref)}</code>`)}
        ${reportRow('用例', escape(wantedCase))}
        ${reportRow('分组', escape(familyName[family] || family || 'Real E2E'))}
        ${reportRow('记录时间', escape(beijingDate(latest.created_at)) + '（北京时间）')}
        ${reportRow('耗时', escape(duration(latest.duration_ms)))}
        ${reportRow('评分状态', escape(qualityName(latest.quality_status)))}
        ${reportRow('已读取记录', escape(history.length))}
      </tbody></table>
      <h2>场景目标</h2><p>${reported(journey.goal)}</p>
      <h2>前置条件</h2>${preconditions}
      <h2>步骤总览</h2>${steps}
      <h2>运行元数据</h2><table class="report-meta"><tbody>
        ${reportRow('类型', reported(meta.type || 'real'))}
        ${reportRow('模型', reported(model))}
        ${reportRow('凭据', reported(meta.credentials))}
        ${reportRow('成本与副作用', reported(meta.cost_side_effects))}
      </tbody></table>
      ${journey.source === 'source-definition' ? '<p class="muted">场景与元数据来自测试用例定义；看板当前没有读取到这次运行的旅程报告。</p>' : journey.source === 'run-report+source-definition' ? '<p class="muted">场景与步骤来自运行报告；报告缺少的元数据按测试用例定义补齐。</p>' : journeyPoint && journeyPoint !== latest ? `<p class="muted">场景说明来自最近一次带有旅程报告的记录：${escape(beijingDate(journeyPoint.created_at))}。</p>` : ''}
      <h2>质量评分</h2>${scoreTable(history)}<p class="muted">平均仅统计下方执行历史中的实测分数；沿用值和基线值不参与计算。分数不改变 CI 结论。</p>
      <h2>执行历史（${history.length} 次）</h2><div class="table-wrap"><table class="history-table"><thead><tr><th>记录时间（北京时间）</th><th>结果</th><th>评分状态</th><th>耗时</th><th>来源</th></tr></thead><tbody>${historyRows}</tbody></table></div>
      <p class="muted">与看板分数趋势使用同一批已读取记录；失败记录的沿用分数只在评分表中标明。</p>
      ${newerUnreadable.length ? `<p class="muted">最近还有 ${newerUnreadable.length} 次 Nightly 的评分产物未读到，无法判断此用例在那些运行中的结果。</p>` : ''}`;
  }

  if (!wantedCase || !wantedLine) {
    root.innerHTML = '<p>缺少用例或分支线参数。<a href="./#tests">返回 E2E 看板</a></p>';
    return;
  }
  fetch('./data/snapshot.json', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('snapshot unavailable');
    return response.json();
  }).then(render).catch(() => {
    root.innerHTML = '<p>暂时无法读取用例详情。请稍后重试，或<a href="./#tests">返回 E2E 看板</a>。</p>';
  });
})();
