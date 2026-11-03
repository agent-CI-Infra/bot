/* GitHub 状态看板 — 单页渲染逻辑（无构建、无依赖）。
 * 数据来自同站点静态 snapshot.json；每个区块独立渲染，区块级错误只影响自己的卡片。 */
(() => {
  'use strict';

  // ------------------------------------------------------------ utilities
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'));
  const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
  const dur = (s) => {
    if (s == null) return '—';
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const hours = (h) => (h == null ? '—' : h * 60 < 1 ? '<1 分钟' : h < 1 ? `${Math.round(h * 60)} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`);
  const codeify = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  // Memory-only parts of the snapshot come back from the disk cache as {redacted:true} after a restart.
  const live = (v) => (v && typeof v === 'object' && v.redacted ? null : v);
  const pending = (v) => !!(v && typeof v === 'object' && v.redacted);
  const memoryOnlyNote = (what) => `<div class="muted">${badge('内存态', 'info')} ${esc(what)}只保留在进程内存、不写入磁盘缓存；服务刚重启，等待本轮采集（约 15 秒）后显示。</div>`;
  const ago = (iso) => {
    if (!iso) return '—';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 60) return `${Math.floor(diff / 86400)} 天前`;
    return `${Math.floor(diff / 86400 / 30)} 个月前`;
  };
  const date = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
  const shortDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const shortDateTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${shortDate(iso)} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':')}`;
  };
  const days = (d) => (d == null ? '—' : d < 1 ? '<1 天' : `${Math.round(d)} 天`);
  const tip = (text) => ` data-tip="${esc(text)}"`;
  const link = (href, text, extra = '') => `<a href="${esc(/^https:\/\//.test(href || "") ? href : "#")}" target="_blank" rel="noopener"${extra}>${text}</a>`;
  const LAYER_COLOR = { unit: 'var(--s1)', e2e: 'var(--s2)', st: 'var(--s3)', 'ci-self': 'var(--s4)', tooling: 'var(--s5)', other: 'var(--muted)' };
  const LAYER_NAME = { unit: '单元 (unit)', e2e: '端到端 (e2e)', st: '系统/冒烟 (st)', 'ci-self': 'CI 自检', tooling: '脚本工具', other: '其他' };
  const CONCLUSION_TONE = { success: 'good', failure: 'bad', timed_out: 'bad', cancelled: '', skipped: '', in_progress: 'warn', queued: 'warn', pending: 'warn', neutral: '', action_required: 'warn', startup_failure: 'bad', error: 'bad', expected: 'warn' };
  const CONCLUSION_NAME = { success: '成功', failure: '失败', timed_out: '超时', cancelled: '取消', skipped: '跳过', in_progress: '运行中', queued: '排队', pending: '等待', neutral: '中性', action_required: '需处理', startup_failure: '启动失败', error: '错误', expected: '等待' };

  const VIEW_KEY = 'gsb.list.view', LINE_KEY = 'gsb.line', COV_SORT_KEY = 'gsb.coverage.sort';
  const loadViews = () => { try { return { issues: 'table', prs: 'table', ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch (e) { return { issues: 'table', prs: 'table' }; } };
  const loadLine = () => { try { return localStorage.getItem(LINE_KEY); } catch (e) { return null; } };
  const loadCovSort = () => { try { return localStorage.getItem(COV_SORT_KEY) === 'lines' ? 'lines' : 'name'; } catch (e) { return 'name'; } };
  const STATE = { snap: null, status: null, tab: 'overview', views: loadViews(), line: loadLine(), covOpen: new Set(), covSort: loadCovSort(), sort: {}, filters: { issueQ: '', issueLabel: '', issueAssignee: '', runBranch: '' }, ageFilter: { issues: null, prs: null }, coverageWeekOffset: 0, e2e: null, e2eSteps: {}, e2eFilter: { status: '', q: '' }, e2eLoading: new Set(), e2eErrors: new Set(), e2eCollapsed: new Set(), performance: null, perfCase: null, pollTimer: null };
  const returnParams = new URLSearchParams(location.search);
  const returnFocus = { line: returnParams.get('returnLine'), caseName: returnParams.get('returnCase'), pending: !!returnParams.get('returnCase'),
    e2eKey: returnParams.get('returnE2E'), e2ePending: !!returnParams.get('returnE2E') };

  // ------------------------------------------------------------ components
  const badge = (text, tone = '', extra = '') => `<span class="badge ${tone}"${extra}>${esc(text)}</span>`;
  const conclusionBadge = (c) => badge(CONCLUSION_NAME[c] || c || '未知', CONCLUSION_TONE[c] ?? '');
  const tiles = (items) => `<div class="tiles">${items.map((t) => {
    const inner = `<div class="label"><span>${esc(t.label)}</span>${t.tag ? `<span>${t.tag}</span>` : ''}</div>
      <div class="value">${t.value}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div>${t.sub ? `<div class="foot">${t.sub}</div>` : ''}`;
    return `<div class="tile ${t.tone || ''}">${t.href ? `<a href="${esc(t.href)}">${inner}</a>` : inner}</div>`;
  }).join('')}</div>`;
  const card = (title, body, opts = {}) => `<div class="card ${opts.span2 ? 'span2' : ''}"><h3>${esc(title)}${opts.sub ? `<span class="sub">${opts.sub}</span>` : ''}</h3>${body}</div>`;
  const empty = (text) => `<div class="empty">${esc(text)}</div>`;
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const sectionHead = (title, sub = '') => `<div class="section-head"><h2>${esc(title)}</h2><span class="sub">${sub}</span></div>`;

  /** Horizontal magnitude bars: one hue (sequential job), value text in ink. */
  const bars = (items, opts = {}) => {
    if (!items.length) return empty(opts.emptyText || '暂无数据');
    const max = opts.max ?? Math.max(...items.map((i) => i.value || 0), 1);
    return `<div class="bars">${items.map((i) => {
      const segs = i.segments
        ? i.segments.map((s) => `<span class="fill" style="width:${(s.value / max) * 100}%;background:${s.color}"${tip(`${s.name}: ${s.value}`)}></span>`).join('')
        : `<span class="fill" style="width:${((i.value || 0) / max) * 100}%;${i.color ? `background:${i.color}` : ''}"></span>`;
      return `<span class="lbl" title="${esc(i.label)}">${i.labelHtml || esc(i.label)}</span><span class="track">${segs}</span><span class="val">${i.valueText ?? n(i.value)}</span>`;
    }).join('')}</div>`;
  };
  const legend = (items) => `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.name)}${i.value != null ? ` ${n(i.value)}` : ''}</span>`).join('')}</div>`;
  const stack = (segments) => {
    const total = segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
    return `<div class="stack">${segments.filter((s) => s.value).map((s) => `<span style="width:${(s.value / total) * 100}%;background:${s.color}"${tip(`${s.name}: ${s.value} (${((s.value / total) * 100).toFixed(1)}%)`)}></span>`).join('')}</div>`;
  };
  const ratioBar = (v, tone = '') => `<span class="ratio ${tone}"><span style="width:${Math.max(0, Math.min(100, v || 0))}%"></span></span>`;
  const dayDate = (day) => new Date(`${day}T00:00:00Z`);
  const dayString = (value) => {
    const d = value instanceof Date ? value : dayDate(value);
    return d.toISOString().slice(0, 10);
  };
  const addDays = (day, count) => {
    const d = dayDate(day);
    d.setUTCDate(d.getUTCDate() + count);
    return dayString(d);
  };
  const weekStart = (day) => {
    const d = dayDate(day);
    const offset = (d.getUTCDay() + 6) % 7;
    return addDays(day, -offset);
  };
  const dayLabel = (day) => {
    const d = dayDate(day);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const historyRange = (historyDays, offset) => {
    const days = historyDays.filter(Boolean).sort();
    if (!days.length) return null;
    const latestDay = days[days.length - 1];
    const earliest = weekStart(days[0]);
    const firstHistoryWeek = addDays(weekStart(latestDay), -7);
    const maxOffset = dayDate(firstHistoryWeek) < dayDate(earliest)
      ? 0
      : Math.floor((dayDate(firstHistoryWeek) - dayDate(earliest)) / 604800000) + 1;
    const selectedOffset = Math.max(0, Math.min(offset, maxOffset));
    if (selectedOffset === 0) {
      return { start: addDays(latestDay, -6), end: latestDay, maxOffset, offset: selectedOffset, recent: true };
    }
    const start = addDays(firstHistoryWeek, -7 * (selectedOffset - 1));
    return { start, end: addDays(start, 6), maxOffset, offset: selectedOffset, recent: false };
  };
  const coverageRange = (languages) => {
    const days = Object.values(languages).flatMap((dataset) => (dataset.history || []).map((row) => row.day));
    const range = historyRange(days, STATE.coverageWeekOffset);
    if (range) STATE.coverageWeekOffset = range.offset;
    return range;
  };
  const coverageTrend = (history, selectedWeek) => {
    if (!selectedWeek) return '';
    const w = 800, h = 210, left = 58, right = 18, top = 12, bottom = 34;
    const plotW = w - left - right, plotH = h - top - bottom;
    const byDay = new Map(history.filter((row) => row.day).map((row) => [row.day, row]));
    const slots = Array.from({ length: 7 }, (_, index) => {
      const day = addDays(selectedWeek, index);
      return { day, row: byDay.get(day) || null };
    });
    const values = slots.filter((slot) => slot.row?.totals?.lines?.percentage != null)
      .map((slot) => Number(slot.row.totals.lines.percentage));
    if (!values.length) {
      return `<div class="coverage-week-empty">${slots.map((slot) => `<span>${dayLabel(slot.day)}</span>`).join('')}<strong>该周没有完整覆盖率结果</strong></div>`;
    }
    const rawMin = Math.min(...values), rawMax = Math.max(...values);
    const margin = Math.max((rawMax - rawMin) * 0.18, 0.5);
    const paddedMin = Math.max(0, rawMin - margin), paddedMax = Math.min(100, rawMax + margin);
    const roughStep = Math.max((paddedMax - paddedMin) / 4, 0.1);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const fraction = roughStep / magnitude;
    const tickStep = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
    const yMin = Math.max(0, Math.floor(paddedMin / tickStep) * tickStep);
    const yMax = Math.min(100, Math.ceil(paddedMax / tickStep) * tickStep);
    const yRange = yMax - yMin || 1;
    const pts = slots.map((slot, index) => {
      if (!slot.row) return null;
      const value = Number(slot.row.totals.lines.percentage);
      return {
        x: left + (index * plotW) / 6,
        y: top + ((yMax - value) / yRange) * plotH,
        value,
        row: slot.row,
        day: slot.day,
      };
    });
    const segments = [];
    for (const point of pts) {
      if (!point) {
        if (segments.length && segments[segments.length - 1].length) segments.push([]);
        continue;
      }
      if (!segments.length) segments.push([]);
      segments[segments.length - 1].push(point);
    }
    const populated = segments.filter((segment) => segment.length);
    const paths = populated.map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
    const baseY = top + plotH;
    const areas = populated.filter((segment) => segment.length > 1).map((segment) => {
      const path = segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      return `${path} L${segment[segment.length - 1].x.toFixed(1)},${baseY} L${segment[0].x.toFixed(1)},${baseY} Z`;
    });
    const ticks = Array.from({ length: Math.round((yMax - yMin) / tickStep) + 1 }, (_, index) => yMin + tickStep * index);
    const yAxis = ticks.map((value) => {
      const y = top + ((yMax - value) / yRange) * plotH;
      const label = tickStep < 1 ? value.toFixed(1) : value.toFixed(0);
      return `<line class="coverage-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${w - right}" y2="${y.toFixed(1)}"></line><text class="coverage-y-label" x="${left - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end">${label}%</text>`;
    }).join('');
    const xAxis = slots.map((slot, index) => {
      const x = left + (index * plotW) / 6;
      const anchor = index === 0 ? 'start' : index === 6 ? 'end' : 'middle';
      return `<text class="coverage-x-label" x="${x.toFixed(1)}" y="${h - 8}" text-anchor="${anchor}">${dayLabel(slot.day)}</text>`;
    }).join('');
    const dots = pts.filter(Boolean).map((point) => {
      const label = `${date(point.row.created_at)} · ${pct(point.value)}\n${point.row.kind === 'nightly' ? 'nightly' : '完整门禁'} · ${(point.row.sha || '').slice(0, 12)}\n${point.row.artifact || ''}`;
      return `<circle class="coverage-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"></circle><circle class="coverage-hit" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="11"${tip(label)}></circle>`;
    }).join('');
    return `<svg class="coverage-trend" viewBox="0 0 ${w} ${h}" role="img" aria-label="完整行覆盖率历史趋势">${yAxis}<line class="coverage-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseY}"></line><line class="coverage-axis" x1="${left}" y1="${baseY}" x2="${w - right}" y2="${baseY}"></line>${areas.map((area) => `<path class="coverage-area" d="${area}"></path>`).join('')}${paths.map((path) => `<path class="coverage-line" d="${path}"></path>`).join('')}${dots}${xAxis}</svg>`;
  };
  // CI history lanes: one row per trigger lane, one column per day on a shared axis.
  // The collector buckets days and orders runs, so a column simply stacks them top-down.
  const LANE_SOURCE = { pr: 'CI · pull_request', main: 'CI · 默认分支 push / 手动', merge_queue: 'merge_group · 合并队列', daily: 'Nightly · 定时 / 手动', release: 'Release · 版本运行' };
  const laneSource = (L, key) => (key === 'main' && L.branch ? `CI · ${L.branch} push / 手动` : LANE_SOURCE[key] || '');
  const LANE_OUTCOMES = [['success', '成功'], ['failure', '失败/超时'], ['cancelled', '取消'], ['running', '运行中'], ['other', '其他（待批准等）']];
  const LANE_EVENT = { schedule: 'schedule · 定时', workflow_dispatch: 'workflow_dispatch · 手动' };
  const LANE_STACK = 10; // runs visible per day before that column scrolls
  const laneDay = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}`; };
  // Run time short enough to print inside a day cell: 45s, 18m, 1h05.
  const laneTime = (s) => (s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`);
  const laneRun = (lane, day, r, zone) => {
    const pr = r.pr ? ` · PR #${r.pr}${r.pr_linked ? '' : '（按分支推断）'}` : '';
    const text = [
      `${r.workflow} · ${LANE_EVENT[r.event] || r.event || '未知事件'}${pr}`,
      `${CONCLUSION_NAME[r.conclusion] || CONCLUSION_NAME[r.status] || r.conclusion || r.status || '未知'}${r.duration_s != null ? ` · 耗时 ${dur(r.duration_s)}` : ''}${r.attempt > 1 ? ` · 第 ${r.attempt} 次尝试` : ''}`,
      `${laneDay(day)} ${r.time}（${zone}）`,
      `${lane === 'release' ? '标签' : '分支'} ${r.branch || '—'}${r.sha ? ` · ${r.sha}` : ''}`,
      r.title,
    ].filter(Boolean).join('\n');
    const href = /^https:\/\//.test(r.url || '') ? r.url : '#';
    return `<a class="ci-run ${esc(r.outcome)}" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(text)}"${tip(text)}>${esc(laneTime(r.duration_s))}</a>`;
  };
  const ciLanes = (L, { notes: withNotes = true } = {}) => {
    if (!L) return empty('分层历史会在下一次采集后出现');
    const zone = L.zone || 'UTC+8';
    const uncollected = (day) => L.collected_since && day < L.collected_since;
    const outcomes = (runs) => LANE_OUTCOMES.map(([key, name]) => [name, runs.filter((r) => r.outcome === key).length]).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join(' · ');
    const rows = Object.keys(LANE_SOURCE).map((key) => L.lanes.find((lane) => lane.key === key)).filter(Boolean).map((lane) => {
      const s = lane.summary;
      const counts = [['成功', s.success], ['失败', s.failure], ['取消', s.cancelled], ['运行中', s.running], ...(s.other ? [['其他', s.other]] : [])];
      const head = `<div class="ci-lane-head" role="rowheader"><b>${esc(lane.label).replace(/\//g, '/<wbr>')}</b><span class="ci-lane-src">${esc(laneSource(L, lane.key))}</span>`
        + `<span class="ci-lane-rate">成功率 ${pct(s.success_rate)}</span>`
        + (s.median_duration_s != null ? `<span class="ci-lane-time">中位耗时 ${dur(s.median_duration_s)}</span>` : '')
        + `<span class="ci-lane-sum">${s.total ? counts.map(([name, count]) => `<span>${name} ${count}</span>`).join(' · ') : '窗口内没有 run'}</span></div>`;
      const days = lane.days.map((runs, i) => {
        const day = L.days[i];
        if (uncollected(day)) return `<div class="ci-lane-day uncollected" role="cell"${tip(`${laneDay(day)} 未采集`)}></div>`;
        const more = runs.length > LANE_STACK ? `<span class="ci-day-more">${runs.length}</span>` : '';
        const note = runs.length ? tip(`${laneDay(day)} · ${lane.label} ${runs.length} 次\n${outcomes(runs)}`) : '';
        return `<div class="ci-lane-day${more ? ' dense' : ''}" role="cell"${note}><div class="ci-day-stack">${runs.map((r) => laneRun(lane.key, day, r, zone)).join('')}</div>${more}</div>`;
      }).join('');
      return `<div class="ci-lane-row" role="row" data-lane="${esc(lane.key)}">${head}${days}</div>`;
    }).join('');
    const axis = L.days.map((day, i) => `<div class="ci-axis-day" role="columnheader">${i === 0 || day.endsWith('-01') ? laneDay(day) : Number(day.slice(8))}</div>`).join('');
    const notes = [
      '成功率 = 成功 ÷（成功 + 失败/超时），取消、运行中与其他不计入；重跑按最后一次尝试着色，仍放在 run 创建的那天。',
      '耗时为最后一次尝试从开始到结束的时间；中位耗时只统计成功与失败的运行，运行中的没有耗时。',
      '按 run ID 展示 PR、分支门禁、合并队列、Daily、版本五层；merge_group 优先归入合并队列。',
      L.collected_since ? `${laneDay(L.collected_since)} 之前的日期尚未采集（斜纹），不代表没有运行。` : '',
    ].filter(Boolean);
    const legendItems = LANE_OUTCOMES.map(([key, name]) => `<span><i class="ci-run ${key}"></i>${esc(name)}</span>`).join('') + (L.collected_since ? '<span><i class="ci-lane-day uncollected"></i>未采集</span>' : '');
    return `<div class="ci-lanes-scroll"><div class="ci-lanes" role="table" aria-label="CI 分层历史" style="--days:${L.days.length}">${rows}<div class="ci-lane-row ci-axis" role="row"><div class="ci-lane-head" role="rowheader"></div>${axis}</div></div></div>`
      + `<div class="legend ci-legend">${legendItems}</div>${withNotes ? `<ul class="notes ci-lane-notes">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
  };
  // Narrow screens scroll the day axis. Stay on the newest day unless the reader scrolled away.
  const pinLanes = (keep = {}) => document.querySelectorAll('.ci-lanes-scroll').forEach((el) => {
    if (!el.clientWidth) return;
    const saved = keep[el.closest('.tab')?.id];
    if (saved != null) { el.scrollLeft = saved; el.dataset.away = '1'; } else if (!el.dataset.away) el.scrollLeft = el.scrollWidth;
  });
  // Charts the reader scrolled away from the newest day, by tab, so a refresh keeps their place.
  const lanePositions = () => Object.fromEntries([...document.querySelectorAll('.ci-lanes-scroll')].filter((el) => el.dataset.away).map((el) => [el.closest('.tab')?.id, el.scrollLeft]));
  // The Issue / PR list in board form renders through board.js into the page's mount point.
  const mountBoard = () => {
    const scope = { issues: 'issue', prs: 'pr' }[STATE.tab];
    if (scope && STATE.views[STATE.tab] === 'board') { try { window.GSBBoard?.mount(scope); } catch (err) { console.error(err); } }
  };
  // Branch lines: CI, E2E and Coverage show one long-lived branch at a time. PR runs
  // belong to the branch they target; sections hold the default line.
  const currentLine = (snap) => { const lines = snap?.lines || []; return lines.find((l) => l.key === STATE.line) || lines[0] || { key: '', ref: snap?.repository?.default_branch, default: true }; };
  const lineSection = (snap, name) => { const line = currentLine(snap); return line.default ? snap.sections[name] : snap.line_sections?.[line.key]?.[name]; };
  const lineBar = (snap) => {
    const lines = snap.lines || [], line = currentLine(snap);
    if (lines.length < 2) return '';
    return `<div class="line-bar"><div class="seg line-switch" role="group" aria-label="分支线"><span class="seg-label">分支线</span>${lines.map((l) => `<button type="button" class="${l.key === line.key ? 'on' : ''}" data-line="${esc(l.key)}" aria-pressed="${l.key === line.key}">${esc(l.ref)}</button>`).join('')}</div>`
      + `<span class="muted">当前 <code>${esc(line.ref)}</code>：按运行分支及 PR 目标分支归类，按 PR、分支门禁、合并队列、Daily 与版本展示；各分支线的数据互不混合。</span></div>`;
  };
  // The word for a line's own branch runs: 主干 on the default branch, the full branch name elsewhere.
  const trunkName = (line) => (line.default ? '主干' : ` ${line.ref} 分支`);
  const labelChips = (labels) => labels.map((l) => `<span class="label-chip"><span class="sw" style="background:#${esc(l.color || '999')}"></span>${esc(l.name)}</span>`).join('');

  /** Sortable table. cols: [{key,label,num,render,sort}] ; rows: objects. Sorting is client-side by id. */
  const table = (id, cols, rows, opts = {}) => {
    const sort = STATE.sort[id] || opts.defaultSort || null;
    let data = rows.slice();
    if (sort) {
      const col = cols.find((c) => c.key === sort.key);
      const getter = col?.sort || ((r) => r[sort.key]);
      data.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va > vb ? 1 : va < vb ? -1 : 0) * (sort.dir === 'desc' ? -1 : 1);
      });
    }
    if (opts.limit) data = data.slice(0, opts.limit);
    if (!data.length) return empty(opts.emptyText || '暂无数据');
    const head = cols.map((c) => `<th class="${c.num ? 'num' : ''} ${c.sortable === false ? '' : 'sortable'}" data-table="${id}" data-key="${c.key}">${esc(c.label)}${sort && sort.key === c.key ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('');
    const body = data.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${opts.limit && rows.length > opts.limit ? `<div class="muted" style="margin-top:6px">仅显示前 ${opts.limit} / ${rows.length} 条</div>` : ''}`;
  };

  const KIND_TEXT = { unauthorized: '未授权', forbidden: '权限不足', rate_limited: 'API 限流', not_found: '不存在或无权限', network: '网络错误', server: 'GitHub 服务端错误', internal: '看板内部错误', error: '错误' };
  const errorBanner = (err, what = '') => {
    if (!err) return '';
    const reset = err.reset_at ? `（重置于 ${date(new Date(err.reset_at * 1000).toISOString())}）` : '';
    const hint = err.hint ? `<div class="hint">${esc(err.hint).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>` : '';
    return `<div class="banner error"><span class="icon">⛔</span><div><div class="title">${esc(what)}${KIND_TEXT[err.kind] || err.kind}${err.status ? ` · HTTP ${err.status}` : ''}${reset}</div><div>${esc(err.message)}</div>${hint}${err.trace ? `<details><summary>堆栈</summary><pre class="mono">${esc(err.trace)}</pre></details>` : ''}</div><div class="banner-actions"><button class="btn small" data-action="refresh">重试</button></div></div>`;
  };
  const notesList = (notes) => (notes && notes.length ? `<ul class="notes">${notes.map((x) => `<li><b>${esc(x.what || x.key)}</b>：${esc(x.message)}${x.hint ? ` <span class="muted">${esc(x.hint)}</span>` : ''}</li>`).join('')}</ul>` : '');
  const sectionState = (sec, name) => {
    if (!sec) return `<div class="banner warn"><span class="icon">⏳</span><div><div class="title">${esc(name)} 尚未采集</div><div>当前已发布快照没有这部分数据。</div></div></div>`;
    if (sec.status === 'error') return errorBanner(sec.error, `${name}：`);
    return notesList(sec.notes);
  };

  // ------------------------------------------------------------ renderers
  // Issue and PR lists switch between the table and the local board; the choice stays in this browser.
  const viewSwitch = (tab) => `<div class="seg view-switch" data-work-view="${tab}" role="group" aria-label="列表形式">${[['table', '表格'], ['board', '看板']].map(([v, l]) => `<button type="button" class="${STATE.views[tab] === v ? 'on' : ''}" data-val="${v}" aria-pressed="${STATE.views[tab] === v}">${l}</button>`).join('')}</div>`;
  const listHead = (tab, title, sub) => `<div class="section-head list-head"><h2>${esc(title)}</h2><span class="sub">${sub}</span><span class="grow"></span>${viewSwitch(tab)}</div>`;
  const boardMount = (scope) => `<div class="work-board" data-scope="${scope}"><div class="skeleton"><span class="spinner"></span>装配看板…</div></div>`;

  // Open-age pie above each open list: same bucket boundaries as the collector's aging
  // summary ([0,7), [7,30), [30,90), [90,∞)), computed from the items the list shows.
  const AGE_BUCKETS = [['<7d', 0, 7], ['7-30d', 7, 30], ['30-90d', 30, 90], ['>90d', 90, null]];
  const AGE_BUCKET_COLOR = ['s2', 's4', 's7', 's3'];
  const ageBucketOf = (age) => {
    if (age == null || Number.isNaN(Number(age))) return -1;
    return AGE_BUCKETS.findIndex(([, lo, hi]) => age >= lo && (hi == null || age < hi));
  };
  const ageBucketCounts = (items) => {
    const counts = AGE_BUCKETS.map(() => 0);
    items.forEach((i) => { const k = ageBucketOf(i.age_days); if (k >= 0) counts[k] += 1; });
    return counts;
  };
  // Donut chart: every drawn sector is a focusable button; zero-count buckets only appear
  // in the legend as plain text. Clicking a sector or legend entry filters the list below.
  const agePie = (tab, items, unit) => {
    const counts = ageBucketCounts(items), total = counts.reduce((a, b) => a + b, 0);
    if (!total) return empty(`开放${unit}都没有年龄数据`);
    const sel = STATE.ageFilter[tab];
    const cx = 90, cy = 90, rO = 82, rI = 46;
    const point = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const sectors = [];
    let angle = -Math.PI / 2;
    counts.forEach((count, k) => {
      if (!count) return;
      const span = (count / total) * Math.PI * 2, a0 = angle, a1 = angle + span;
      angle = a1;
      const on = sel === k, share = (count / total) * 100;
      const [x0, y0] = point(rO, a0), [u0, v0] = point(rI, a0);
      let d;
      if (span >= Math.PI * 2 - 1e-9) {
        // A lone sector is a full ring: two half arcs each way, since a 360° arc collapses.
        const [x1, y1] = point(rO, a0 + Math.PI), [u1, v1] = point(rI, a0 + Math.PI);
        d = `M${x0.toFixed(2)},${y0.toFixed(2)} A${rO},${rO} 0 1 1 ${x1.toFixed(2)},${y1.toFixed(2)} A${rO},${rO} 0 1 1 ${x0.toFixed(2)},${y0.toFixed(2)} L${u0.toFixed(2)},${v0.toFixed(2)} A${rI},${rI} 0 1 0 ${u1.toFixed(2)},${v1.toFixed(2)} A${rI},${rI} 0 1 0 ${u0.toFixed(2)},${v0.toFixed(2)} Z`;
      } else {
        const [x1, y1] = point(rO, a1), [u1, v1] = point(rI, a1), large = span > Math.PI ? 1 : 0;
        d = `M${x0.toFixed(2)},${y0.toFixed(2)} A${rO},${rO} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${u1.toFixed(2)},${v1.toFixed(2)} A${rI},${rI} 0 ${large} 0 ${u0.toFixed(2)},${v0.toFixed(2)} Z`;
      }
      sectors.push(`<path class="age-sector${on ? ' on' : ''}" d="${d}" fill="var(--${AGE_BUCKET_COLOR[k]})" role="button" tabindex="0" data-age-tab="${tab}" data-age-filter="${k}" aria-pressed="${on}" aria-label="筛选开启时长 ${esc(AGE_BUCKETS[k][0])} 的${unit}：${n(count)} 个，占 ${share.toFixed(1)}%"${tip(`${AGE_BUCKETS[k][0]}：${n(count)} 个（${share.toFixed(1)}%）`)}></path>`);
    });
    const center = `<text class="age-total" x="${cx}" y="${cy + 1}" text-anchor="middle">${n(total)}</text><text class="age-total-sub" x="${cx}" y="${cy + 18}" text-anchor="middle">开放${unit}</text>`;
    const legend = AGE_BUCKETS.map(([label], k) => {
      const share = ((counts[k] / total) * 100).toFixed(1), sw = `<i style="background:var(--${AGE_BUCKET_COLOR[k]})"></i>`, text = `<span class="age-name">${esc(label)}</span><b>${n(counts[k])}</b><span class="muted">${share}%</span>`;
      if (!counts[k]) return `<li><span class="age-key zero">${sw}${text}</span></li>`;
      const on = sel === k;
      return `<li><button type="button" class="age-key${on ? ' on' : ''}" data-age-tab="${tab}" data-age-filter="${k}" aria-pressed="${on}"${tip(on ? '取消这个时长筛选' : `筛选开启时长 ${label} 的${unit}`)}>${sw}${text}</button></li>`;
    }).join('');
    return `<div class="age-pie" data-age-pie="${tab}"><svg class="age-pie-svg" viewBox="0 0 180 180" role="img" aria-label="开放${unit}开启时长分布">${sectors.join('')}${center}</svg><ul class="age-legend">${legend}</ul></div>`;
  };
  const ageChip = (tab) => {
    const sel = STATE.ageFilter[tab];
    return sel == null ? '' : `<span class="chip">开启时长：${esc(AGE_BUCKETS[sel][0])} <button type="button" data-age-tab="${tab}" data-age-clear aria-label="清除开启时长筛选">×</button></span>`;
  };
  const openListHeader = (tab, items, unit, sub, filters = '') => `<div class="card open-list-header">
    <div class="age-overview"><h3>开启时长</h3><p class="sub">点击扇区或图例筛选，再次点击取消</p>${agePie(tab, items, unit)}</div>
    <div class="open-list-controls">${listHead(tab, `开放 ${unit}`, sub)}
      ${STATE.views[tab] === 'board' ? '<div class="open-board-controls"></div>' : filters}
      <div class="age-filter-slot">${ageChip(tab)}</div>
    </div>
  </div>`;
  function setAgeFilter(tab, value, focusBucket) {
    const { scrollX, scrollY } = window, panel = $(`#tab-${tab}`);
    // Shorter results must still leave enough document height to restore this viewport.
    const top = panel.getBoundingClientRect().top + scrollY;
    panel.style.minHeight = `${Math.max(0, scrollY + window.innerHeight - top)}px`;
    STATE.ageFilter[tab] = value;
    renderTabs();
    if (focusBucket != null) document.querySelector(`.age-key[data-age-tab="${tab}"][data-age-filter="${focusBucket}"]`)?.focus({ preventScroll: true });
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
  }
  // Totals across test reports, or null when any report has no readable counts.
  const sumCounts = (reports) => (!reports.length || reports.some((r) => !r.counts) ? null
    : Object.fromEntries(['tests', 'passed', 'failed', 'skipped', 'flaky'].map((k) => [k, reports.reduce((sum, r) => sum + (r.counts[k] || 0), 0)])));
  // Latest run of one CI lane, from the lane chart the collector already built.
  const latestInLane = (lane) => {
    for (let i = (lane?.days || []).length - 1; i >= 0; i--) if (lane.days[i].length) return lane.days[i][lane.days[i].length - 1];
    return null;
  };
  const OUTCOME_TEXT = { success: ['成功', 'good'], failure: ['失败', 'bad'], cancelled: ['已取消', ''], running: ['运行中', 'warn'], other: ['待处理', 'warn'] };
  // The newest `count` days of the lane chart, with each lane's summary recomputed for that window.
  const recentLanes = (L, count) => L && ({ ...L, days: L.days.slice(-count), collected_since: L.collected_since && L.collected_since > L.days[L.days.length - count] ? L.collected_since : null,
    lanes: L.lanes.map((lane) => {
      const days = lane.days.slice(-count), runs = days.flat(), by = (o) => runs.filter((r) => r.outcome === o).length;
      const success = by('success'), failure = by('failure');
      const times = runs.filter((r) => (r.outcome === 'success' || r.outcome === 'failure') && r.duration_s != null).map((r) => r.duration_s).sort((a, b) => a - b);
      const median = times.length ? Math.floor(times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2) : null;
      return { ...lane, days, summary: { total: runs.length, success, failure, cancelled: by('cancelled'), running: by('running'), other: by('other'), success_rate: success + failure ? Math.round((success * 1000) / (success + failure)) / 10 : null, median_duration_s: median } };
    }) });

  function renderOverview(snap) {
    const S = snap.sections;
    const iss = S.issues?.data, prs = S.prs?.data, ci = S.ci?.data, tests = S.tests?.data, ops = S.ops?.data;
    const L = ci?.lanes, lanes = Object.fromEntries((L?.lanes || []).map((lane) => [lane.key, lane]));
    const tagged = tests?.tagged, gate = tagged?.profiles?.find((p) => p.name === 'pr');
    const cov = tests?.coverage, lines = cov?.current?.totals?.lines?.percentage ?? cov?.value?.lines_pct;
    const releases = snap.releases || [], runsById = new Map((snap.quality?.runs || []).map((r) => [r.id, r]));
    const validation = (release) => (release.validation_run_ids || []).map((id) => runsById.get(id)).filter(Boolean)[0] || null;
    const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity);

    // Problems first, most severe first: what a maintainer has to act on today.
    const items = [];
    const main = latestInLane(lanes.main), daily = latestInLane(lanes.daily), prGate = latestInLane(lanes.pr);
    const runLink = (r) => (r ? ` ${link(r.url, '查看运行')}` : '');
    // Unreadable data is unknown, never healthy.
    [[ci, 'CI', '#ci'], [prs, 'PR', '#prs'], [iss, 'Issue', '#issues']].forEach(([value, name, href]) => { if (!value) items.push(['warn', `${name} 数据暂不可读取，状态未知`, href]); });
    if (ci?.red_streak_main) items.push(['critical', `主干 CI 连续失败 ${ci.red_streak_main} 次；失败 job：${esc((ci.latest_main?.jobs || []).filter((j) => j.conclusion === 'failure').map((j) => j.name).join('、') || '—')}`, '#ci']);
    else if (main?.outcome === 'failure') items.push(['critical', `主干最近一次 CI 失败（${esc(main.time)}，<code>${esc(main.sha)}</code>）${runLink(main)}`, '#ci']);
    if (daily?.outcome === 'failure') items.push(['critical', `每日构建最近一次失败（${shortDate(daily.created_at)} ${esc(daily.time)}）${runLink(daily)}`, '#ci']);
    else if (lanes.daily && hoursSince(daily?.created_at) > 36) items.push(['warn', daily ? `每日构建已 ${Math.floor(hoursSince(daily.created_at))} 小时没有运行` : '近 30 天没有每日构建运行', '#ci']);
    const releaseURL = `${snap.repo_url}/releases`, latestRelease = releases[0], releaseRun = latestRelease && validation(latestRelease);
    if (latestRelease && !releaseRun) items.push(['warn', `版本 ${esc(latestRelease.tag)} 没有找到提交一致的版本验证运行`, latestRelease.url || releaseURL]);
    else if (releaseRun && releaseRun.status === 'completed' && releaseRun.conclusion !== 'success') items.push(['critical', `版本 ${esc(latestRelease.tag)} 的验证运行${esc(CONCLUSION_NAME[releaseRun.conclusion] || releaseRun.conclusion)}${runLink(releaseRun)}`, releaseRun.url || latestRelease.url || releaseURL]);
    if (prs?.ci_states?.failure) items.push(['warn', `${prs.ci_states.failure} 个开放 PR 的检查失败：${prs.items.filter((p) => p.ci?.state === 'failure').map((p) => link(p.url, `#${p.number}`)).join(' ')}`, '#prs']);
    if (prs?.waiting_review_count) items.push(['warn', `${prs.waiting_review_count} 个 PR 超过 ${prs.review_sla_days} 天无人评审：${prs.items.filter((p) => p.waiting_review).map((p) => link(p.url, `#${p.number}`)).join(' ')}`, '#prs']);
    if (prs?.items?.some((p) => p.mergeable === 'CONFLICTING')) items.push(['warn', `存在冲突的 PR：${prs.items.filter((p) => p.mergeable === 'CONFLICTING').map((p) => link(p.url, `#${p.number}`)).join(' ')}`, '#prs']);
    (snap.lines || []).slice(1).forEach((l) => {
      const other = snap.line_sections?.[l.key]?.ci?.data?.lanes?.lanes?.find((lane) => lane.key === 'main'), last = latestInLane(other);
      if (last?.outcome === 'failure') items.push(['warn', `<code>${esc(l.ref)}</code> 分支最近一次运行失败（${shortDate(last.created_at)} ${esc(last.time)}）${runLink(last)}`, '#ci']);
    });
    const hints = [];
    if (tagged?.uncovered?.cases) hints.push(['info', `${n(tagged.uncovered.cases)} 个标签化用例不会被任何流水线组合选中`, '#tests']);
    if (iss?.no_response_count) hints.push(['info', `${iss.no_response_count} 个开放 Issue 还没有评论，${iss.unassigned_count} 个无人认领`, '#issues']);
    if (iss?.stale_count) hints.push(['info', `${iss.stale_count} 个 Issue 超过 ${iss.stale_days_threshold} 天没有更新`, '#issues']);
    if (ops?.releases?.unreleased?.commits > 50) hints.push(['info', `自 ${esc(ops.releases.latest?.tag)} 以来已有 ${n(ops.releases.unreleased.commits)} 个提交未发布`, releaseURL]);
    if (ops?.branches?.protection && !ops.branches.protection.enabled) hints.push(['info', `默认分支 ${esc(ops.branches.default)} 未启用分支保护`, `${snap.repo_url}/branches`]);
    const line = ([sev, text, href]) => `<li><span class="sev ${sev}"></span><span>${text} ${href.startsWith("https://") ? link(href, "详情") : `<a href="${esc(href)}">详情</a>`}</span></li>`;
    const serious = items.filter(([sev]) => sev === 'critical').length;
    let html = `<div class="card health ${serious ? 'health-bad' : items.length ? 'health-warn' : 'health-good'}"><h3>${serious ? `${serious} 个流水线问题需要处理` : items.length ? `${items.length} 项需要关注` : '流水线与交付状态正常'}<span class="sub">数据截至 ${date(snap.generated_at)}（${ago(snap.generated_at)}）</span></h3>
      ${items.length ? `<ul class="attention">${items.map(line).join('')}</ul>` : '<div class="muted">主干、每日构建和最新版本都没有失败；开放 PR 没有失败检查或超期评审。</div>'}
      ${hints.length ? `<details class="hints"><summary>其他提示（${hints.length}）</summary><ul class="attention">${hints.map(line).join('')}</ul></details>` : ''}</div>`;

    // Pipelines: the latest run of each lane and its recent completion rate.
    const laneTile = (key, label, href) => {
      const lane = lanes[key], run = latestInLane(lane), [text, tone] = run ? OUTCOME_TEXT[run.outcome] || ['未知', ''] : ['暂无运行', ''];
      const rate = lane?.summary?.success_rate;
      return { label, value: text, tone, href, sub: run ? `${shortDate(run.created_at)} ${esc(run.time)} · ${esc(run.workflow)}${run.pr ? ` · PR #${run.pr}` : ''}${run.duration_s != null ? ` · 耗时 ${dur(run.duration_s)}` : ''}<br>近 ${L.window_days} 天成功率 ${pct(rate)}（${n(lane.summary.total)} 次）` : lane ? `近 ${L.window_days} 天没有运行` : '分层历史尚未生成' };
    };
    html += sectionHead('流水线', L ? `最近一次运行的结论；成功率 = 成功 ÷（成功 + 失败）${(snap.lines || []).length > 1 ? `；此处为 ${esc(snap.lines[0].ref)} 分支线，其他分支线在 CI 页切换` : ''}` : '');
    html += tiles([laneTile('pr', 'PR 门禁', '#ci'), laneTile('main', '主干', '#ci'), laneTile('daily', '每日构建', '#ci'), laneTile('release', '版本构建', '#ci')]);
    if (L) html += `<div class="grid one" style="margin-top:12px">${card('近 14 天', ciLanes(recentLanes(L, Math.min(14, L.days.length)), { notes: false }), { sub: `每格一次运行，颜色为结论；<a href="#ci">完整 ${L.window_days} 天与 job 明细</a>` })}</div>`;

    // Delivery and quality at a glance.
    const layers = gate?.results ? Object.entries(gate.results).filter(([, r]) => r) : [];
    const planned = layers.reduce((sum, [, r]) => sum + (r.planned || 0), 0), passed = layers.reduce((sum, [, r]) => sum + (r.passed || 0), 0);
    // The published release list is canonical; the ops block adds the unreleased commit count.
    const rel = releases[0] ? { tag: releases[0].tag, age_days: (Date.now() - new Date(releases[0].published_at).getTime()) / 86400000 } : ops?.releases?.latest;
    html += sectionHead('交付与质量', '');
    html += tiles([
      { label: '开放 PR', value: n(prs?.open_count), href: '#prs', tone: prs?.ci_states?.failure || prs?.waiting_review_count ? 'warn' : '', sub: prs ? `待评审超期 ${n(prs.waiting_review_count)} · 检查失败 ${n(prs.ci_states.failure || 0)} · 30 天合并 ${n(prs.merged_30d)}` : '—' },
      { label: '开放 Issue', value: n(iss?.open_count), href: '#issues', sub: iss ? `7 天 +${n(iss.counts.opened_7d)} / −${n(iss.counts.closed_7d)} · 陈旧 ${n(iss.stale_count)}` : '—' },
      { label: '主干门禁用例', value: layers.length ? `${n(passed)}<small>/ ${n(planned)}</small>` : '—', href: '#tests', tone: layers.length ? (passed === planned ? 'good' : 'bad') : '', sub: layers.length ? layers.map(([s, r]) => `${s.toUpperCase()} ${n(r.passed)}/${n(r.planned)}`).join(' · ') : '尚未读取到门禁计划' },
      { label: '整仓行覆盖率', value: lines != null ? pct(lines) : '—', href: '#coverage', sub: cov?.current?.kind === 'authoritative' ? '主干完整结果' : cov?.current?.kind === 'incremental' ? '基线 + 主干增量' : cov?.source ? '部分结果' : '暂无覆盖率' },
      { label: '最新版本', value: rel ? esc(rel.tag) : '—', href: latestRelease?.url || releaseURL, sub: rel ? `${days(rel.age_days)}前${ops?.releases?.unreleased ? ` · 之后 ${n(ops.releases.unreleased.commits)} 个提交未发布` : ''}` : '尚无 release' },
    ]);

    const releaseRows = releases.slice(0, 3).map((release) => {
      const run = validation(release), e2eCounts = run && sumCounts((run.tests || []).filter((t) => t.layer === 'e2e'));
      return `<li>${link(release.url, esc(release.tag))} <span class="muted">${ago(release.published_at)}</span> ${run ? `${conclusionBadge(run.status === 'completed' ? run.conclusion : run.status)} ${link(run.url, '验证运行')}${e2eCounts ? ` <span class="muted">E2E ${n(e2eCounts.passed)}/${n(e2eCounts.tests)}</span>` : ''}` : badge('无验证运行', 'warn')}</li>`;
    }).join('');
    const merged = (prs?.recent_merged || []).slice(0, 5).map((p) => `<li>${badge('合并', 'good')} ${link(p.url, `#${p.number} ${esc(p.title)}`)} <span class="muted">${ago(p.merged_at)}</span></li>`);
    const opened = (iss?.items || []).slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 5).map((i) => `<li>${badge('新建', 'info')} ${link(i.url, `#${i.number} ${esc(i.title)}`)} <span class="muted">${ago(i.created_at)}</span></li>`);
    html += `<div class="grid wide" style="margin-top:12px">
      ${card('版本质量', releaseRows ? `<ul class="checks">${releaseRows}</ul>` : empty('仓库尚无 release'), { sub: `版本提交的验证运行结论；${link(releaseURL, '在 GitHub 查看全部版本 ↗')}` })}
      ${card('最近动态', merged.length || opened.length ? `<ul class="checks">${[...merged, ...opened].join('')}</ul>` : empty('最近没有合并或新建'), { sub: '最近合并的 PR 与新建的 Issue' })}
    </div>`;
    const status = Object.entries(S).filter(([, s]) => s.status !== 'ok').map(([k, s]) => badge(`${k} ${s.status}`, s.status === 'partial' ? 'warn' : 'bad'));
    html += `<p class="muted small" style="margin-top:12px">数据来源 ${link(snap.repo_url, esc(snap.repo))} · 视图每 60 秒读取已发布快照${status.length ? ` · 部分区块不完整：${status.join(' ')}` : ''}</p>`;
    return html;
  }

  // Issue / PR daily flow. Daily counts and the number still open differ in scale, so they get
  // two charts on one shared time axis rather than two y-axes. The series come precomputed in the
  // snapshot; the charts are drawn after the tab is in the page so they can use its real width.
  const TREND_SERIES = {
    issues: [{ key: 'opened', label: '新增', color: 's1' }, { key: 'closed', label: '关闭', color: 's2' }, { key: 'open', label: '存量', color: 's4' }],
    prs: [{ key: 'opened', label: '新增', color: 's1' }, { key: 'merged', label: '合入', color: 's3' }, { key: 'closed', label: '关闭未合入', color: 's2' }, { key: 'open', label: '存量', color: 's4' }],
  };
  const TREND_RANGES = [[7, '近 7 天'], [30, '近 30 天'], [90, '近 90 天'], ['all', '全部']];
  // Range and hidden series live in memory per tab: a reload starts again at the last 30 days.
  STATE.trend = { issues: { range: 30, from: '', to: '', hidden: new Set() }, prs: { range: 30, from: '', to: '', hidden: new Set() } };
  const trendData = (kind) => STATE.snap?.sections?.[kind]?.data?.trend || null;
  const trendSection = (kind) => `<section class="card trend-card" data-trend-card="${kind}"><div class="trend-head"><h3>${kind === 'prs' ? 'PR' : 'Issue'} 每日趋势</h3></div><div class="trend-body" data-trend-body="${kind}"></div></section>`;
  // Inclusive index window [lo, hi] into the trend's days for the current range.
  function trendWindow(trend, view) {
    const last = trend.open.length - 1;
    const at = (day) => Math.max(0, Math.min(last, Math.round((dayDate(day) - dayDate(trend.start)) / 86400000)));
    if (view.range === 'custom' && view.from && view.to) {
      const [lo, hi] = [at(view.from), at(view.to)].sort((a, b) => a - b);
      return [lo, hi];
    }
    return view.range === 'all' ? [0, last] : [Math.max(0, last - view.range + 1), last];
  }
  // Whole-number axis for counts: a 1/2/5 × 10ⁿ tick step with at most four steps above zero.
  const countScale = (value) => {
    if (value <= 4) return { max: Math.max(1, Math.ceil(value)), step: 1 };
    const power = 10 ** Math.floor(Math.log10(value / 4)), step = [1, 2, 5, 10].map((unit) => unit * power).find((size) => value / size <= 4);
    return { max: Math.ceil(value / step) * step, step };
  };
  // One chart: lines for `series` over days lo..hi, sharing `geom` so both charts line up.
  function trendSvg(trend, series, lo, hi, geom, height, title) {
    const { width, left, right } = geom, top = 10, bottom = 24, count = hi - lo + 1;
    const { max, step: tick } = countScale(Math.max(0, ...series.flatMap((item) => trend[item.key].slice(lo, hi + 1))));
    const step = count > 1 ? (width - left - right) / (count - 1) : 0;
    const xAt = (index) => count > 1 ? left + (index - lo) * step : (left + width - right) / 2;
    const yAt = (value) => top + (1 - value / max) * (height - top - bottom);
    const grid = Array.from({ length: max / tick + 1 }, (_, index) => index * tick).map((value) => `<line class="trend-grid" x1="${left}" x2="${width - right}" y1="${yAt(value).toFixed(1)}" y2="${yAt(value).toFixed(1)}"></line><text class="trend-tick" x="${left - 6}" y="${(yAt(value) + 4).toFixed(1)}" text-anchor="end">${n(value)}</text>`).join('');
    // About one date label per 56 px, always ending on the last day of the range.
    const every = Math.max(1, Math.ceil(count * 56 / Math.max(1, width - left - right)));
    const ticks = [];
    for (let index = hi; index >= lo; index -= every) ticks.push(index);
    const axis = ticks.map((index) => `<text class="trend-tick" x="${xAt(index).toFixed(1)}" y="${height - 6}" text-anchor="middle">${dayLabel(addDays(trend.start, index))}</text>`).join('');
    const lines = series.map((item) => {
      const points = trend[item.key].slice(lo, hi + 1).map((value, offset) => `${xAt(lo + offset).toFixed(1)},${yAt(value).toFixed(1)}`);
      const dots = step >= 12 || count === 1 ? points.map((point) => { const [x, y] = point.split(','); return `<circle class="trend-dot" cx="${x}" cy="${y}" r="3" style="--c: var(--${item.color})"></circle>`; }).join('') : '';
      return `<polyline class="trend-line" points="${points.join(' ')}" style="--c: var(--${item.color})"></polyline>${dots}`;
    }).join('');
    const marks = series.map((item) => `<circle class="trend-focus" r="4.5" style="--c: var(--${item.color})" data-trend-mark="${item.key}"></circle>`).join('');
    return `<svg class="trend-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${grid}${axis}${lines}<line class="trend-cross" y1="${top}" y2="${height - bottom}"></line>${marks}<rect class="trend-hit" x="${left}" y="0" width="${Math.max(1, width - left - right)}" height="${height}" tabindex="0" data-trend-hit aria-label="${esc(title)}：用左右方向键逐日查看"></rect></svg>`;
  }
  function drawTrend(kind) {
    const body = document.querySelector(`[data-trend-body="${kind}"]`);
    if (!body) return;
    const trend = trendData(kind), view = STATE.trend[kind];
    if (!trend || !trend.open?.length) { body.innerHTML = empty('还没有可用的历史数据：需要看板仓的增量采集先记录 Issue／PR。'); return; }
    const [lo, hi] = trendWindow(trend, view), day = (index) => addDays(trend.start, index);
    const all = TREND_SERIES[kind], shown = all.filter((item) => !view.hidden.has(item.key));
    const flow = shown.filter((item) => item.key !== 'open'), stock = shown.filter((item) => item.key === 'open');
    const controls = `<div class="trend-controls" data-trend-kind="${kind}"><div class="seg" role="group" aria-label="时间范围">${TREND_RANGES.map(([range, label]) => `<button type="button" class="${view.range === range ? 'on' : ''}" data-trend-range="${range}" aria-pressed="${view.range === range}">${label}</button>`).join('')}</div>
      <label class="trend-dates">从 <input type="date" data-trend-from value="${day(lo)}" min="${trend.start}" max="${trend.end}" aria-label="开始日期"></label><label class="trend-dates">到 <input type="date" data-trend-to value="${day(hi)}" min="${trend.start}" max="${trend.end}" aria-label="结束日期"></label></div>
      <div class="trend-legend" data-trend-kind="${kind}" role="group" aria-label="显示的数据">${all.map((item) => `<button type="button" class="trend-toggle" data-trend-series="${item.key}" aria-pressed="${!view.hidden.has(item.key)}"><span class="trend-key" style="--c: var(--${item.color})"></span>${item.label}</button>`).join('')}</div>`;
    const width = Math.max(280, Math.floor(body.clientWidth || 760));
    // Shared left margin for the longest tick label of either chart, so the days line up.
    const labelWidth = (series) => series.length ? String(n(countScale(Math.max(0, ...series.flatMap((item) => trend[item.key].slice(lo, hi + 1)))).max)).length : 1;
    const geom = { width, left: Math.max(labelWidth(flow), labelWidth(stock)) * 7 + 14, right: 14 };
    const chart = (series, height, title) => `<figure class="trend-chart"><figcaption>${title}</figcaption>${trendSvg(trend, series, lo, hi, geom, height, title)}</figure>`;
    const charts = (flow.length ? chart(flow, 180, '每日数量') : '') + (stock.length ? chart(stock, 140, '存量（当天结束时仍开放）') : '')
      || `<div class="muted trend-none">所有数据都已关闭显示，点上方的按钮重新打开。</div>`;
    const rows = Array.from({ length: hi - lo + 1 }, (_, offset) => hi - offset).map((index) => `<tr><td>${day(index)}</td>${all.map((item) => `<td class="num">${n(trend[item.key][index])}</td>`).join('')}</tr>`).join('');
    const note = `按 UTC 日期统计。存量按每个 ${kind === 'prs' ? 'PR' : 'Issue'} 当前的创建和关闭时间回推，关闭后又重开的从创建起都算开放${kind === 'prs' ? '；合入的 PR 不计入“关闭未合入”' : ''}。${trend.complete ? '' : ' 历史仍在回填，较早日期的数量可能偏少。'}`;
    body.innerHTML = `${controls}${charts}<p class="muted trend-note">${note}</p><details class="trend-table"><summary>按日数据（${n(hi - lo + 1)} 天）</summary><div class="table-wrap"><table><thead><tr><th>日期（UTC）</th>${all.map((item) => `<th class="num">${item.label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
    // Hover or arrow keys pick a day; every chart shows the crosshair and the tooltip lists the shown series.
    const pick = (index, hit) => {
      index = Math.max(lo, Math.min(hi, index));
      body.dataset.trendIndex = index;
      const count = hi - lo + 1, x = count > 1 ? geom.left + (index - lo) * (width - geom.left - geom.right) / (count - 1) : (geom.left + width - geom.right) / 2;
      body.querySelectorAll('.trend-svg').forEach((svg) => {
        const cross = svg.querySelector('.trend-cross');
        cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.classList.add('on');
        svg.querySelectorAll('[data-trend-mark]').forEach((mark) => {
          const line = [...svg.querySelectorAll('.trend-line')][[...svg.querySelectorAll('[data-trend-mark]')].indexOf(mark)];
          const point = line.getAttribute('points').split(' ')[index - lo].split(',');
          mark.setAttribute('cx', point[0]); mark.setAttribute('cy', point[1]); mark.classList.add('on');
        });
      });
      hit.dataset.tip = [`${day(index)}（UTC）`, ...shown.map((item) => `${n(trend[item.key][index])}  ${item.label}`)].join('\n');
    };
    // SVG ignores the hidden attribute, so visibility is a class.
    const clear = () => body.querySelectorAll('.trend-cross, [data-trend-mark]').forEach((el) => el.classList.remove('on'));
    body.querySelectorAll('[data-trend-hit]').forEach((hit) => {
      hit.addEventListener('mousemove', (ev) => {
        const box = hit.getBoundingClientRect(), count = hi - lo + 1;
        pick(lo + Math.round((ev.clientX - box.left) / Math.max(1, box.width) * Math.max(0, count - 1)), hit);
      });
      hit.addEventListener('mouseleave', clear);
      hit.addEventListener('focus', () => { pick(Number(body.dataset.trendIndex ?? hi), hit); showTip(hit); });
      hit.addEventListener('blur', clear);
      hit.addEventListener('keydown', (ev) => {
        const move = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[ev.key];
        if (move == null) return;
        ev.preventDefault();
        const current = Number(body.dataset.trendIndex ?? hi);
        pick(Number.isFinite(move) ? current + move : move < 0 ? lo : hi, hit);
        showTip(hit);
      });
    });
  }
  const drawTrends = () => ['issues', 'prs'].forEach(drawTrend);

  function renderIssues(sec) {
    const d = sec?.data;
    let html = sectionState(sec, 'Issue');
    if (!d) return html;
    html += tiles([
      { label: '开放', value: n(d.open_count), sub: d.truncated ? '列表已截断（只取前 500）' : '' },
      { label: '已关闭（累计）', value: n(d.counts.closed_total) },
      { label: '30 天新增', value: n(d.counts.opened_30d), sub: `7 天 ${n(d.counts.opened_7d)}` },
      { label: '30 天关闭', value: n(d.counts.closed_30d), sub: `7 天 ${n(d.counts.closed_7d)}` },
      { label: `陈旧（≥${d.stale_days_threshold} 天无更新）`, value: n(d.stale_count), tone: d.stale_count ? 'warn' : '' },
      { label: '无人认领', value: n(d.unassigned_count), tone: d.unassigned_count ? 'warn' : '' },
      { label: '无标签', value: n(d.unlabeled_count) },
      { label: '零回复', value: n(d.no_response_count) },
      { label: '中位年龄', value: days(d.median_age_days), sub: `最老 ${days(d.oldest_age_days)}` },
    ]);
    html += trendSection('issues');
    html += `<div class="grid">
      ${card('标签分布', bars(d.labels.map((l) => ({ label: l.name, labelHtml: `<span class="label-chip"><span class="sw" style="background:#${esc(l.color || '999')}"></span>${esc(l.name)}</span>`, value: l.count })), { emptyText: '开放 Issue 都没有标签' }) + (d.unused_labels.length ? `<div class="muted" style="margin-top:8px">仓库另有 ${d.unused_labels.length} 个标签未用于任何开放 Issue：${esc(d.unused_labels.join('、'))}</div>` : ''), { sub: '按开放 Issue 计数' })}
      ${card('认领负载', bars(d.assignee_load.map((a) => ({ label: a.login, value: a.count })), { emptyText: '所有开放 Issue 均无人认领' }), { sub: '按 assignee' })}
      ${card('里程碑', bars(d.milestones.map((m) => ({ label: m.name, value: m.count }))))}
    </div>`;
    // Drill-down list with filters.
    const f = STATE.filters;
    const labels = [...new Set(d.items.flatMap((i) => i.labels.map((l) => l.name)))].sort();
    const assignees = [...new Set(d.items.flatMap((i) => i.assignees))].sort();
    let rows = d.items;
    if (f.issueQ) rows = rows.filter((i) => `${i.number} ${i.title} ${i.author}`.toLowerCase().includes(f.issueQ.toLowerCase()));
    if (f.issueLabel === '__none__') rows = rows.filter((i) => !i.labels.length);
    else if (f.issueLabel) rows = rows.filter((i) => i.labels.some((l) => l.name === f.issueLabel));
    if (f.issueAssignee === '__none__') rows = rows.filter((i) => !i.assignees.length);
    else if (f.issueAssignee) rows = rows.filter((i) => i.assignees.includes(f.issueAssignee));
    if (STATE.ageFilter.issues != null) rows = rows.filter((i) => ageBucketOf(i.age_days) === STATE.ageFilter.issues);
    const preview = d.preview_total > d.items.length ? ` · 列表显示最近更新的 ${d.items.length} / ${d.preview_total} 个` : '';
    const filters = `<div class="filters">
      <input type="text" data-filter="issueQ" placeholder="搜索编号 / 标题 / 作者" value="${esc(f.issueQ)}">
      <select data-filter="issueLabel"><option value="">全部标签</option><option value="__none__" ${f.issueLabel === '__none__' ? 'selected' : ''}>无标签</option>${labels.map((l) => `<option ${f.issueLabel === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select data-filter="issueAssignee"><option value="">全部认领人</option><option value="__none__" ${f.issueAssignee === '__none__' ? 'selected' : ''}>无人认领</option>${assignees.map((a) => `<option ${f.issueAssignee === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
    </div>`;
    html += openListHeader('issues', d.items, 'Issue', STATE.views.issues === 'board' ? `看板含最近关闭的 Issue${preview}` : `${rows.length} / ${d.items.length}${preview}`, filters);
    if (STATE.views.issues === 'board') return html + boardMount('issue');
    html += `<div class="card work-table">${table('iss-all', [
      { key: 'number', label: '#', num: true, render: (i) => link(i.url, `#${i.number}`) },
      { key: 'title', label: '标题', render: (i) => `${link(i.url, esc(i.title))}<div class="sub">${labelChips(i.labels)}${i.milestone ? ` · ${esc(i.milestone)}` : ''}</div>` },
      { key: 'author', label: '作者' },
      { key: 'assignees', label: '认领', render: (i) => (i.assignees.length ? esc(i.assignees.join(', ')) : '<span class="muted">—</span>'), sort: (i) => i.assignees.join(',') },
      { key: 'comments', label: '评论', num: true },
      { key: 'created_at', label: '创建', render: (i) => ago(i.created_at) },
      { key: 'updated_at', label: '更新', render: (i) => ago(i.updated_at) },
    ], rows, { defaultSort: { key: 'updated_at', dir: 'desc' }, emptyText: '没有符合筛选条件的开放 Issue' })}</div>`;
    return html;
  }

  function renderPRs(sec) {
    const d = sec?.data;
    let html = sectionState(sec, 'PR');
    if (!d) return html;
    html += tiles([
      { label: '开放 PR', value: n(d.open_count) },
      { label: '草稿', value: n(d.draft_count) },
      { label: `等待评审 > ${d.review_sla_days} 天`, value: n(d.waiting_review_count), tone: d.waiting_review_count ? 'warn' : 'good' },
      { label: 'CI 失败', value: n(d.ci_states.failure || 0), tone: d.ci_states.failure ? 'bad' : 'good', sub: `成功 ${d.ci_states.success || 0} · 进行中 ${d.ci_states.pending || 0}` },
      { label: '30 天合并', value: n(d.merged_30d), sub: `关闭未合并 ${n(d.closed_unmerged_30d)}` },
      { label: '合并时长中位（全部）', value: hours(d.median_time_to_merge_h), sub: `P90 ${hours(d.p90_time_to_merge_h)} · 含 bot 同步 PR` },
      { label: '合并时长中位（人工 PR）', value: hours(d.median_time_to_merge_h_human), sub: d.merged_human_count ? `样本 ${d.merged_human_count} 个非 bot PR` : '暂无非 bot PR 样本' },
    ]);
    html += trendSection('prs');
    const DECISION = { APPROVED: ['已批准', 'good'], CHANGES_REQUESTED: ['需修改', 'bad'], REVIEW_REQUIRED: ['待评审', 'warn'], NONE: ['无评审', ''] };
    const MERGEABLE = { MERGEABLE: ['可合并', 'good'], CONFLICTING: ['有冲突', 'bad'], UNKNOWN: ['计算中', ''] };
    const ciCell = (p) => {
      const checks = p.ci.checks || [];
      const ok = checks.filter((c) => c.conclusion === 'success').length;
      const bad = checks.filter((c) => ['failure', 'timed_out', 'error', 'cancelled', 'startup_failure'].includes(c.conclusion)).length;
      const state = p.ci.state ? conclusionBadge(p.ci.state) : badge('无检查', 'none');
      const list = checks.length ? `<details><summary>${ok}/${checks.length} 通过${bad ? `，${bad} 失败` : ''}</summary><ul class="checks">${checks.map((c) => `<li>${conclusionBadge(c.conclusion)} ${c.url ? link(c.url, esc(c.name)) : esc(c.name)}</li>`).join('')}</ul></details>` : '';
      return `${state}${list}`;
    };
    html += `<div class="grid">
      ${card('评审负载', bars(d.reviewer_load.map((r) => ({ label: r.login, value: r.count })), { emptyText: '开放 PR 没有被指定或提交过评审' }), { sub: '被请求评审 + 已提交评审（开放 PR）' })}
      ${card('PR 作者', bars(d.authors.map((a) => ({ label: a.login, value: a.count }))), { sub: '开放 + 最近关闭' })}
      ${card('评审决定', bars(Object.entries(d.review_decisions).map(([k, v]) => ({ label: (DECISION[k] || [k])[0], value: v }))))}
      ${card('CI 状态', bars(Object.entries(d.ci_states).map(([k, v]) => ({ label: CONCLUSION_NAME[k] || k, value: v }))))}
    </div>`;
    let rows = d.items;
    if (STATE.ageFilter.prs != null) rows = rows.filter((p) => ageBucketOf(p.age_days) === STATE.ageFilter.prs);
    html += openListHeader('prs', d.items, 'PR', STATE.views.prs === 'board' ? '看板含最近关闭与合并的 PR' : `${rows.length} / ${d.items.length} 个`);
    if (STATE.views.prs === 'board') html += boardMount('pr');
    else html += `<div class="card work-table">${table('pr-open', [
      { key: 'number', label: '#', num: true, render: (p) => link(p.url, `#${p.number}`) },
      { key: 'title', label: '标题', render: (p) => `${link(p.url, esc(p.title))}<div class="sub">${esc(p.author)} · <code>${esc(p.head)}</code> → <code>${esc(p.base)}</code>${p.labels.length ? ' · ' + labelChips(p.labels) : ''}</div>` },
      { key: 'age_days', label: '年龄', num: true, render: (p) => days(p.age_days) },
      { key: 'review_decision', label: '状态', render: (p) => [p.draft ? badge('草稿', 'none') : '', badge(...(DECISION[p.review_decision] || [p.review_decision, ''])), p.mergeable ? badge(...(MERGEABLE[p.mergeable] || [p.mergeable, ''])) : '', p.waiting_review ? badge(`等待评审 ${days(p.age_days)}`, 'warn') : ''].filter(Boolean).join(' ') },
      { key: 'ci', label: 'CI', render: ciCell, sort: (p) => p.ci.state },
      { key: 'requested_reviewers', label: '评审人', render: (p) => (p.requested_reviewers.length ? esc(p.requested_reviewers.join(', ')) : p.reviews.length ? esc([...new Set(p.reviews.map((r) => r.author))].join(', ')) : '<span class="muted">未指定</span>'), sort: (p) => p.requested_reviewers.length },
      { key: 'updated_at', label: '更新', render: (p) => ago(p.updated_at) },
    ], rows, { emptyText: STATE.ageFilter.prs != null ? '没有符合筛选条件的开放 PR' : '当前没有开放 PR' })}</div>`;
    html += sectionHead('最近合并', '按合并时间');
    html += `<div class="card">${table('pr-merged', [
      { key: 'number', label: '#', num: true, render: (p) => link(p.url, `#${p.number}`) },
      { key: 'title', label: '标题', render: (p) => `${link(p.url, esc(p.title))}<div class="sub">${esc(p.author)}</div>` },
      { key: 'merged_at', label: '合并', render: (p) => ago(p.merged_at) },
      { key: 'time_to_merge_h', label: '开到合并', num: true, render: (p) => hours(p.time_to_merge_h) },
    ], d.recent_merged, { limit: 15 })}</div>`;
    return html;
  }

  function renderCI(sec, line) {
    const d = sec?.data, trunk = trunkName(line);
    let html = sectionState(sec, 'CI');
    if (!d) return html;
    const rateTone = (r) => (r == null ? '' : r >= 80 ? 'good' : r >= 50 ? 'warn' : 'bad');
    html += tiles([
      { label: line.default ? `主干 (${d.default_branch}) 成功率` : `${trunk}成功率`, value: pct(d.main.success_rate), tone: rateTone(d.main.success_rate), sub: `${d.main.success} 成功 / ${d.main.failure} 失败 / ${d.main.cancelled} 取消` },
      { label: 'PR 触发成功率', value: pct(d.pull_request.success_rate), tone: rateTone(d.pull_request.success_rate), sub: `${d.pull_request.success} 成功 / ${d.pull_request.failure} 失败` },
      { label: `${trunk}连续失败`, value: n(d.red_streak_main), tone: d.red_streak_main ? 'bad' : 'good', unit: '次' },
      { label: '7 天失败', value: n(d.failures_7d), tone: d.failures_7d ? 'warn' : '' },
      { label: `${trunk}中位耗时`, value: dur(d.main.median_duration_s) },
      { label: '采样 run', value: n(d.runs_sampled), sub: `job 明细取最近 ${d.job_history_runs} 次${trunk} run` },
    ]);
    const L = d.lanes;
    const range = L ? `近 ${L.window_days} 天（${laneDay(L.days[0])}–${laneDay(L.days[L.days.length - 1])}，${esc(L.zone)}）` : '';
    html += `<div class="grid one" style="margin-top:12px">
      ${card('CI 分层历史', ciLanes(L), { sub: `${range} · 各层共用日期轴，每格一次 run，同一天自上而下按时间排列（上早下晚）· 点击打开 run` })}
    </div>`;
    const gates = d.gates;
    if (gates) {
      const GATE_STATE = { pass: ['通过', 'good'], fail: ['失败', 'bad'], observe_fail: ['观察失败', 'warn'], waived: ['豁免', ''], not_applicable: ['不适用', ''], error: ['错误', 'bad'] };
      const STAGE = { discovered: '已发现', 'gates-running': '门禁运行中', 'cases-pending': '用例待补', observing: '观察中', enforced: '已强制', failing: '失败' };
      const c = gates.cases || {};
      const gateRows = (gates.lanes || []).map((lane) => {
        const [name, tone] = GATE_STATE[lane.verdict] || [lane.verdict, ''];
        const passed = (lane.results || []).filter((r) => r.status === 'pass').length;
        const total = (lane.results || []).length;
        return `<tr><td><code>${esc(lane.lane)}</code>${lane.level ? ` <span class="muted">${esc(lane.level)}</span>` : ''}</td><td>${badge(name, tone)}</td><td>${passed}/${total}</td><td>${esc(lane.event || '—')}</td></tr>`;
      }).join('');
      const run = gates.run || {};
      const head = `<div class="muted">最新门禁 run ${run.url ? link(run.url, `#${run.id}`) : '—'} · ${esc(run.event || '—')}${run.sha ? ` · <code>${esc(run.sha.slice(0, 7))}</code>` : ''} · 用例总数 ${n(c.total)}（ready ${n(c.ready)} / todo ${n(c.todo)} / skipped ${n(c.skipped)}）${gates.stage ? ` · ${esc(STAGE[gates.stage] || gates.stage)}` : ''}</div>`;
      html += `<div class="grid one" style="margin-top:12px">${card('质量门禁', `${head}<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Lane</th><th>结论</th><th>命令通过</th><th>事件</th></tr></thead><tbody>${gateRows}</tbody></table></div>`, { sub: '来自 ci-gates-reports；命令输出不进入公开快照' })}</div>`;
    }
    html += `<div class="grid wide" style="margin-top:12px">
      ${card(`最近一次${trunk} run`, d.latest_main ? `${kv([
        ['Run', `${link(d.latest_main.run.url, esc(d.latest_main.run.title))} ${conclusionBadge(d.latest_main.run.conclusion)}`],
        ['时间', `${date(d.latest_main.run.created_at)} · ${dur(d.latest_main.run.duration_s)} · ${esc(d.latest_main.run.actor)}`],
      ])}<ul class="checks" style="margin-top:8px">${d.latest_main.jobs.map((j) => `<li>${conclusionBadge(j.conclusion)} ${link(j.url, esc(j.name))} <span class="muted">${dur(j.duration_s)}</span>${j.failed_steps.length ? ` <span class="bad">失败步骤：${esc(j.failed_steps.join('、'))}</span>` : ''}</li>`).join('')}</ul>` : empty(line.default ? '没有主干 run' : `近期没有 ${d.default_branch} 上的 push / 手动运行`))}
    </div>`;
    html += sectionHead('Workflow 健康');
    html += `<div class="card">${table('ci-wf', [
      { key: 'name', label: 'Workflow', render: (w) => `${link(w.url, esc(w.name))}<div class="sub"><code>${esc(w.path)}</code> · ${esc(w.state)}</div>` },
      { key: 'all', label: '总体成功率', num: true, render: (w) => `${ratioBar(w.all.success_rate, rateTone(w.all.success_rate))}${pct(w.all.success_rate)} <span class="muted">(${w.all.total})</span>`, sort: (w) => w.all.success_rate },
      { key: 'main', label: trunk.trim(), num: true, render: (w) => `${pct(w.main.success_rate)} <span class="muted">(${w.main.total})</span>`, sort: (w) => w.main.success_rate },
      { key: 'pull_request', label: 'PR', num: true, render: (w) => `${pct(w.pull_request.success_rate)} <span class="muted">(${w.pull_request.total})</span>`, sort: (w) => w.pull_request.success_rate },
      { key: 'failures_7d', label: '7 天失败', num: true },
      { key: 'median', label: '中位耗时', num: true, render: (w) => dur(w.all.median_duration_s), sort: (w) => w.all.median_duration_s },
      { key: 'last', label: '最近 run', render: (w) => (w.last_run ? `${conclusionBadge(w.last_run.conclusion || w.last_run.status)} ${link(w.last_run.url, esc(w.last_run.branch))} <span class="muted">${ago(w.last_run.created_at)}</span>` : '—'), sortable: false },
    ], d.workflows)}</div>`;
    html += sectionHead('Job 健康', `最近 ${d.job_history_runs} 次${trunk} run 的 job 级统计`);
    html += `<div class="card">${table('ci-jobs', [
      { key: 'name', label: 'Job' },
      { key: 'success_rate', label: '成功率', num: true, render: (j) => `${ratioBar(j.success_rate, rateTone(j.success_rate))}${pct(j.success_rate)}` },
      { key: 'runs', label: '次数', num: true, render: (j) => `${j.runs} <span class="muted">(${j.success}✓ ${j.failure}✗ ${j.cancelled}取消)</span>` },
      { key: 'median_duration_s', label: '中位耗时', num: true, render: (j) => dur(j.median_duration_s) },
      { key: 'last', label: '最近', render: (j) => (j.last ? `${conclusionBadge(j.last.conclusion)} ${link(j.last.url, ago(j.last.created_at))}` : '—'), sortable: false },
      { key: 'steps', label: '常失败步骤', render: (j) => (j.top_failed_steps.length ? j.top_failed_steps.map((s) => `${esc(s.step)} ×${s.count}`).join('，') : '<span class="muted">—</span>'), sortable: false },
    ], d.job_health, { emptyText: '没有可统计的 job' })}</div>`;
    // Keep the run table within the displayed lanes, without a fallback list for hidden categories.
    const visibleIds = new Set((L?.lanes || []).filter((lane) => Object.hasOwn(LANE_SOURCE, lane.key)).flatMap((lane) => lane.days.flatMap((runs) => runs.map((r) => r.id))));
    const recent = d.recent_runs.filter((r) => visibleIds.has(r.id));
    const branches = [...new Set(recent.map((r) => r.branch))];
    const f = STATE.filters;
    const runs = f.runBranch ? recent.filter((r) => r.branch === f.runBranch) : recent;
    html += sectionHead('最近 run', `${runs.length} 条`);
    html += `<div class="card"><div class="filters"><select data-filter="runBranch"><option value="">全部分支</option>${branches.map((b) => `<option ${f.runBranch === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>${table('ci-runs', [
      { key: 'conclusion', label: '结论', render: (r) => conclusionBadge(r.conclusion || r.status) },
      { key: 'title', label: '标题', render: (r) => `${link(r.url, esc(r.title))}<div class="sub">${esc(r.name)} · <code>${esc(r.sha)}</code> · ${esc(r.actor)}</div>` },
      { key: 'branch', label: '分支', render: (r) => `<code>${esc(r.branch)}</code>` },
      { key: 'event', label: '事件' },
      { key: 'duration_s', label: '耗时', num: true, render: (r) => dur(r.duration_s) },
      { key: 'created_at', label: '时间', render: (r) => ago(r.created_at) },
    ], runs, { limit: 30 })}</div>`;
    return html;
  }

  // Source-tagged tests: the collector evaluates every CI profile on the latest
  // default-branch catalog; this only lays the answer out.
  const PROFILE_NAME = { pr: 'PR', daily: 'Daily', release: 'Release' };
  const SLICE_NAME = { ut: 'UT', st: 'ST', e2e: 'E2E' };
  const TAKE = { yes: ['✓', '选取'], any: ['不限', '不限制该维度'], no: ['✗', '不选'] };
  const tagChip = (tag, muted) => `<span class="tag-chip${muted ? ' muted' : ''}">${esc(tag)}</span>`;
  function taggedSection(t, line) {
    const where = line.default ? '默认分支' : ` ${line.ref} `;
    if (t && !line.default) t = { ...t, profiles: t.profiles.filter((p) => p.run) };
    let html = sectionHead('标签化测试', t ? `${where}最新 CI 冻结的用例目录 · ${n(t.cases)} 个用例 · ${t.dimensions.length} 个标签维度 · ${n(t.signatures)} 种标签组合` : '');
    if (!t) return html + `<div class="banner warn"><span class="icon">▲</span><div><div class="title">尚未读取到标签化测试目录</div><div>需要源仓 CI 在 ut / st / e2e-results 产物中上传各层的 <code>tagged/catalog.json</code> 与 <code>plan.json</code>；读取到${esc(where)}的一次运行后，这里显示各维度标签、组合与覆盖情况。${line.default ? '' : `请在 <code>${esc(line.ref)}</code> 上通过 push 或手动运行一次上传上述产物的 CI；目标为它的 PR 可能修改规则，不作为依据。`}</div></div></div>`;
    const share = (x) => (t.cases ? `${((x / t.cases) * 100).toFixed(1)}%` : '—');
    const runText = (p) => {
      if (!p.run) return '暂无该组合的运行';
      const parts = Object.entries(p.results || {}).filter(([, r]) => r).map(([s, r]) => `${SLICE_NAME[s] || s} ${n(r.passed)}/${n(r.planned)}`);
      return `最近运行 ${shortDate(p.run.created_at)}${parts.length ? ` · 通过 ${parts.join(' · ')}` : ''}`;
    };
    const catalogRun = t.catalog.run;
    const notes = [];
    if (t.catalog.missing.length) notes.push(`目录缺少 ${t.catalog.missing.map((s) => SLICE_NAME[s] || s).join('、')} 层（该层产物未读取到），这些用例不在统计内。`);
    if (!t.schema.known) notes.push('未读取到标签词表：未声明的维度没有补默认值，词表外的标签值也无法列出。');
    const drift = t.checks.filter((c) => c.computed !== c.planned);
    if (drift.length) notes.push(`看板按规则计算的选中数与 CI 冻结计划不一致（${drift.map((c) => `${SLICE_NAME[c.slice] || c.slice}：计划 ${n(c.planned)}，计算 ${c.computed == null ? '无法解析' : n(c.computed)}`).join('；')}），覆盖数字仅供参考。`);
    t.profiles.filter((p) => p.run && p.revisions?.length && t.catalog.revision.length && p.revisions.join() !== t.catalog.revision.join()).forEach((p) => notes.push(`${PROFILE_NAME[p.name]} 的规则取自修订 ${p.revisions.map((r) => r.slice(0, 7)).join('/')}，目录为 ${t.catalog.revision.map((r) => r.slice(0, 7)).join('/')}；覆盖按同一目录计算。`));
    html += `<div class="muted" style="margin:-4px 0 8px">目录来自 ${link(catalogRun.url, `run ${esc(catalogRun.id)}`)}（${esc(catalogRun.branch)} · ${esc(catalogRun.event)} · ${ago(catalogRun.created_at)} · 修订 <code>${esc(t.catalog.revision.map((r) => r.slice(0, 7)).join('/'))}</code>）；各组合的规则取自其最近一次${line.default ? '默认分支 / 版本' : esc(where)}运行的冻结计划。</div>`;
    html += tiles([
      { label: '目录用例', value: n(t.cases), sub: `${t.catalog.slices.map((s) => SLICE_NAME[s] || s).join(' + ')} 三层合并去重` },
      ...t.profiles.map((p) => ({ label: `${PROFILE_NAME[p.name]} 选中`, value: p.covered == null ? '—' : n(p.covered), sub: p.covered == null ? (p.error ? '规则无法解析' : '暂无运行，无法读取组合') : `${share(p.covered)} · ${esc(runText(p))}` })),
      { label: '任一组合覆盖', value: share(t.covered), sub: `${n(t.covered)} / ${n(t.cases)} 个用例`, tone: 'good' },
      { label: '从未覆盖', value: n(t.uncovered.cases), sub: '当前任何组合都不会选中', tone: t.uncovered.cases ? 'warn' : 'good' },
    ]);
    if (notes.length) html += `<ul class="notes">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

    // Dimension × profile matrix: reading down a profile column gives its combination.
    const profiles = t.profiles;
    const head = profiles.map((p) => `<th class="take-col"><div>${esc(PROFILE_NAME[p.name])}</div><div class="sub">${p.same_as ? `与 ${esc(PROFILE_NAME[p.same_as])} 相同` : p.run ? (p.rules ? `${p.rules.length} 条规则` : '含 not，见选择器') : '暂无运行'}</div></th>`).join('');
    const body = t.dimensions.map((dim) => {
      const meta = [dim.multiple ? '可多选' : '单选', dim.vocabulary != null ? `词表 ${dim.vocabulary} 个` : '', `使用 ${dim.used} 个`, dim.default ? `默认 ${dim.default}` : ''].filter(Boolean).join(' · ');
      const group = `<tr class="dim-row"><th colspan="${2 + profiles.length}"><b>${esc(dim.group)}</b> <span class="sub">${esc(meta)}</span></th></tr>`;
      return group + dim.values.map((v) => {
        const miss = v.cases - v.covered;
        const bar = `<span class="tag-bar"${tip(`${dim.group}:${v.value}\n${n(v.cases)} 个用例 · 被任一组合选中 ${n(v.covered)} · 从未覆盖 ${n(miss)}`)}>${v.covered ? `<span class="hit" style="width:${(v.covered / t.cases) * 100}%"></span>` : ''}${miss ? `<span class="miss" style="width:${(miss / t.cases) * 100}%"></span>` : ''}</span>`;
        const takes = profiles.map((p) => {
          const state = v.profiles[p.name];
          if (!p.run) return '<td class="take-col"></td>';
          const [mark, text] = TAKE[state] || ['?', '规则无法展开'];
          return `<td class="take-col"><span class="take ${esc(state || 'unknown')}"${tip(`${PROFILE_NAME[p.name]} ${text} ${dim.group}:${v.value}`)} aria-label="${esc(`${PROFILE_NAME[p.name]} ${text} ${dim.group}:${v.value}`)}">${mark}</span></td>`;
        }).join('');
        return `<tr class="${v.cases ? '' : 'unused'}" data-tag="${esc(`${dim.group}:${v.value}`)}"><td>${tagChip(v.value, !v.cases)}</td><td class="tag-count">${bar}<span class="num">${n(v.cases)}</span>${miss ? ` <span class="miss-text">未覆盖 ${n(miss)}</span>` : ''}</td>${takes}</tr>`;
      }).join('');
    }).join('');
    const ruleText = (p) => {
      if (!p.run) return `${PROFILE_NAME[p.name]}：暂无运行，无法读取组合`;
      if (p.same_as) return `${PROFILE_NAME[p.name]}：与 ${PROFILE_NAME[p.same_as]} 规则相同`;
      if (!p.rules) return `${PROFILE_NAME[p.name]}：${Object.values(p.selectors).join(' ｜ ')}`;
      return `${PROFILE_NAME[p.name]}：${p.rules.map((row) => row.map(([g, vs]) => vs.length > 1 ? `${g} ∈ {${vs.join(', ')}}` : `${g} = ${vs[0]}`).join(' 且 ')).join('；或 ')}（目标 ${p.targets.join('、')}）`;
    };
    html += `<div class="grid one" style="margin-top:12px">${card('每个维度的标签与组合', `<ul class="rule-list">${profiles.map((p) => `<li>${esc(ruleText(p))}</li>`).join('')}</ul>
      <div class="table-wrap"><table class="tag-matrix"><thead><tr><th>标签</th><th>用例数</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="legend"><span><i style="background:var(--s1)"></i>被任一组合选中</span><span><i style="background:var(--warning)"></i>从未覆盖</span><span>✓ 组合选取该标签 · 不限 = 组合不约束该维度 · ✗ 不选</span></div>
      <div class="muted" style="margin-top:6px">读法：同一维度内多个 ✓ 是“或”，不同维度之间是“且”。可多选维度（os、arch）上一个用例可带多个值，各值计数之和会大于用例总数；多平台用例只要有一个平台实例被选中即算覆盖。</div>`, { sub: `标签值计数按${esc(where)}目录；组合列来自冻结计划` })}</div>`;

    // Never covered: why, then which cases.
    const reasons = t.uncovered.reasons;
    const items = t.uncovered.items;
    html += `<div class="grid wide" style="margin-top:12px">${card('从未覆盖的用例', reasons.length ? `${bars(reasons.map((r) => ({ label: r.reason, value: r.cases, color: 'var(--warning)' })))}
      <details style="margin-top:8px"><summary>查看用例（${n(t.uncovered.cases)}${items.length < t.uncovered.cases ? `，列出前 ${items.length} 个` : ''}）</summary>${table('tag-uncovered', [
        { key: 'reason', label: '被排除的标签', render: (r) => `<span class="nowrap">${esc(r.reason)}</span>` },
        { key: 'id', label: '用例', render: (r) => `<span class="mono case-id" title="${esc(r.id)}">${esc(r.id)}</span>` },
      ], items)}</details>` : empty('所有用例都至少被一个组合选中'), { sub: '按挡住它的标签归类：该标签值不在任何组合里' })}
      ${card('标签组合', table('tag-combos', [
        { key: 'cases', label: '用例', num: true },
        { key: 'tags', label: '标签（灰色为默认值）', sortable: false, render: (c) => c.tags.map((tag) => { const [g, v] = tag.split(':'); const dim = t.dimensions.find((x) => x.group === g); return tagChip(tag, dim?.default === v); }).join(' ') },
        ...profiles.map((p) => ({ key: p.name, label: PROFILE_NAME[p.name], sortable: false, render: (c) => c.profiles[p.name] == null ? '<span class="muted">—</span>' : c.profiles[p.name] ? '<span class="take yes">✓</span>' : '<span class="take no">✗</span>' })),
      ], t.combinations, { limit: 40 }), { sub: '标签完全相同的用例被组合选中的方式也相同' })}</div>`;
    return html;
  }

  const REAL_FAMILY_NAME = {
    deepresearchbench: 'DeepResearchBench', biomnibench: 'BiomniBench',
    'research-team': 'Research Team', 'evolve-compression': 'PUCT Compression',
  };
  const scoreText = (metric) => {
    if (metric.value == null) return `不可用${metric.status ? `（${metric.status}）` : ''}`;
    const value = Number(metric.value);
    if (metric.unit === 'percent') return `${value.toFixed(1)}%`;
    if (metric.unit === 'score100') return `${value.toFixed(2)} / 100`;
    if (metric.unit === 'ratio') return value.toFixed(4);
    return n(value);
  };
  const scoreSource = (metric) => metric.source === 'carried' ? '（沿用上次实测）'
    : metric.source === 'baseline' ? '（无历史，按 0 展示）' : '';
  const realCaseHref = (caseName) => `./real-e2e.html?line=${encodeURIComponent(currentLine(STATE.snap).key)}&case=${encodeURIComponent(caseName)}`;
  const scoreTick = (value, unit) => unit === 'percent' ? `${value.toFixed(1)}%`
    : unit === 'score100' ? value.toFixed(1) : unit === 'ratio' ? value.toFixed(3)
      : unit === 'duration_ms' ? dur(value / 1000) : n(value);
  const scoreDay = (iso) => {
    const timestamp = Date.parse(iso);
    return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) : null;
  };
  const metricKey = (metric) => `${metric.label}\u0000${metric.unit}`;
  const deliveryBadge = (value) => badge(value === 'passed' ? '通过' : value === 'failed' ? '失败' : value || '未知', value === 'passed' ? 'good' : value === 'failed' ? 'bad' : 'warn');
  const qualityName = (value) => ['error', 'failed'].includes(value) ? '评分异常'
    : ['scored', 'completed', 'passed'].includes(value) ? '已评分' : ['not_run', 'not_scored'].includes(value) ? '未评分' : value || '未知';

  // Real E2E uses the E2E run-record layout: category → case → one mark per recorded run, with the
  // delivery result as the status. Every metric and the run time are drawn inline under the case.
  const REAL_STATUS = { passed: '交付通过', failed: '交付失败', unknown: '交付未知' };
  const REAL_MARK = { passed: '✓', failed: '×', unknown: '?' };
  const realStatus = (delivery) => delivery === 'passed' || delivery === 'failed' ? delivery : 'unknown';
  // One small chart per metric, points evenly spaced in run order like the marks above it.
  // Show missing results only after the first measured score. Keep their marks at the previous
  // recorded score, including across date boundaries; the mark is not a new measurement.
  function realTrendChart(points, metric) {
    const w = 320, h = 116, right = 10, top = 10, bottom = 22;
    const duration = metric.unit === 'duration_ms', key = metricKey(metric);
    const entry = (point) => duration ? null : (point.metrics || []).find((item) => metricKey(item) === key);
    const values = points.map((point) => {
      const raw = duration ? point.duration_ms : entry(point)?.value;
      return raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
    });
    const valid = values.filter((value) => value != null);
    if (!valid.length) return '';
    const low = Math.min(...valid), high = Math.max(...valid);
    const pad = Math.max((high - low) * .18, metric.unit === 'ratio' ? .005 : duration ? 60000 : 1);
    const floor = ['ratio', 'percent', 'score100', 'duration_ms'].includes(metric.unit) ? 0 : -Infinity;
    const ceiling = metric.unit === 'ratio' ? 1 : ['percent', 'score100'].includes(metric.unit) ? 100 : Infinity;
    const yMin = Math.min(low, Math.max(floor, low - pad));
    const yMax = low === 0 && high === 0 && Number.isFinite(ceiling) ? ceiling : Math.max(high, Math.min(ceiling, high + pad));
    const ticks = [yMax, (yMin + yMax) / 2, yMin];
    // Room for the longest tick label (about 6.5 px per character at 11 px), so "53m 12s" is not clipped.
    const left = Math.max(40, Math.ceil(Math.max(...ticks.map((value) => scoreTick(value, metric.unit).length)) * 6.5) + 10);
    const range = yMax - yMin || 1, step = (w - left - right) / points.length;
    const xAt = (index) => left + (index + .5) * step;
    const yAt = (value) => top + (yMax - value) / range * (h - top - bottom);
    const grid = ticks.map((value) => {
      const y = yAt(value).toFixed(1);
      return `<line class="score-grid" x1="${left}" x2="${w - right}" y1="${y}" y2="${y}"></line><text x="${left - 6}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end">${esc(scoreTick(value, metric.unit))}</text>`;
    }).join('');
    const reused = (index) => ['carried', 'baseline'].includes(entry(points[index])?.source);
    const firstSuccess = values.findIndex((value, index) => value != null && (duration || (!reused(index) && points[index].delivery === 'passed')));
    const measured = values.map((value, index) => value == null || firstSuccess < 0 || index < firstSuccess ? null : index).filter((index) => index != null);
    const previousAt = (index) => measured.findLast((at) => at < index);
    const lines = measured.slice(1).map((index, position) => {
      const previous = measured[position], gap = index > previous + 1;
      const start = `M${xAt(previous).toFixed(1)},${yAt(values[previous]).toFixed(1)}`;
      const missing = gap ? Array.from({ length: index - previous - 1 }, (_, offset) => ` L${xAt(previous + offset + 1).toFixed(1)},${yAt(values[previous]).toFixed(1)}`).join('') : '';
      return `<path class="score-line${gap ? ' gap' : reused(previous) || reused(index) ? ' carried' : ''}" d="${start}${missing} L${xAt(index).toFixed(1)},${yAt(values[index]).toFixed(1)}"></path>`;
    }).join('') + (measured.length && measured.at(-1) < points.length - 1
      ? `<path class="score-line gap" d="M${xAt(measured.at(-1)).toFixed(1)},${yAt(values[measured.at(-1)]).toFixed(1)}${Array.from({ length: points.length - measured.at(-1) - 1 }, (_, offset) => ` L${xAt(measured.at(-1) + offset + 1).toFixed(1)},${yAt(values[measured.at(-1)]).toFixed(1)}`).join('')}"></path>`
      : '');
    const cross = (index, y, label) => `<g class="score-x" transform="translate(${xAt(index).toFixed(1)},${y.toFixed(1)})"${tip(label)}><path d="M-4,-4 L4,4 M4,-4 L-4,4"></path><title>${esc(label)}</title></g>`;
    const dots = values.map((value, index) => {
      const point = points[index], source = entry(point)?.source;
      if (index < firstSuccess || firstSuccess < 0) return '';
      if (value == null) {
        const status = entry(point)?.status;
        const reason = duration ? '耗时未记录' : `评分缺失${status ? `（${status}）` : ''}`;
        const previous = previousAt(index);
        return cross(index, yAt(values[previous]), `${date(point.created_at)} · ${metric.label} ${reason} · run ${point.run_id}；× 与上次有分数的运行平齐，不是本次测量值`);
      }
      const label = `${date(point.created_at)} · ${metric.label} ${scoreTick(value, metric.unit)}${source === 'carried' ? '（交付失败，沿用上次实测）' : source === 'baseline' ? '（交付失败，无历史按 0）' : ''} · run ${point.run_id}`;
      if (!duration && point.delivery === 'failed') return cross(index, yAt(value), label);
      return `<circle class="score-dot${reused(index) ? ' carried' : ''}" cx="${xAt(index).toFixed(1)}" cy="${yAt(value).toFixed(1)}" r="3.5"${tip(label)}><title>${esc(label)}</title></circle>`;
    }).join('');
    const day = (index) => { const value = scoreDay(points[index].created_at); return value ? dayLabel(value) : ''; };
    const axis = points.length > 1
      ? `<text x="${xAt(0).toFixed(1)}" y="${h - 6}" text-anchor="start">${esc(day(0))}</text><text x="${xAt(points.length - 1).toFixed(1)}" y="${h - 6}" text-anchor="end">${esc(day(points.length - 1))}</text>`
      : `<text x="${xAt(0).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(day(0))}</text>`;
    return `<svg class="score-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(metric.label)}历史曲线">${grid}${lines}${dots}${axis}</svg>`;
  }
  function realCaseGroups(report, history) {
    const latestRows = new Map((report?.scores || []).map((row) => [row.case, row]));
    const cases = new Map(Object.entries(history || {}).filter(([, points]) => Array.isArray(points) && points.length).map(([name, points]) => [name, [...points]]));
    // A case seen only in the latest report, with no history yet, still shows that one run.
    for (const [name, row] of latestRows) if (!cases.has(name)) cases.set(name, [{ ...row, run_id: report.run_id, attempt: report.attempt, created_at: report.created_at, url: report.url }]);
    const groups = new Map();
    for (const [name, points] of cases) {
      points.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || Number(a.run_id) - Number(b.run_id));
      const family = latestRows.get(name)?.family || points.findLast((point) => point.family)?.family || 'other';
      const spec = points.findLast((point) => point.journey?.spec)?.journey.spec || latestRows.get(name)?.journey?.spec || '';
      if (!groups.has(family)) groups.set(family, []);
      groups.get(family).push({ name, points, spec });
    }
    const order = Object.keys(REAL_FAMILY_NAME), rank = (family) => order.includes(family) ? order.indexOf(family) : order.length;
    return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([family, items]) => ({ family, items: items.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })) }));
  }
  function realCaseItem(item) {
    const latest = item.points.at(-1);
    const marks = item.points.map((point) => {
      const state = realStatus(point.delivery);
      const scores = (point.metrics || []).map((metric) => `${metric.label} ${scoreText(metric)}${scoreSource(metric)}`).join(' · ');
      const description = `${date(point.created_at)} · ${REAL_STATUS[state]} · ${qualityName(point.quality_status)}${scores ? ` · ${scores}` : ''} · 耗时 ${msText(point.duration_ms)} · run ${point.run_id}${point.attempt > 1 ? ` 第 ${point.attempt} 次` : ''}`;
      const content = `<span class="e2e-status-mark ${state}" aria-hidden="true">${REAL_MARK[state]}</span>`;
      return `<li class="e2e-history-point ${state}" data-real-run="${esc(point.run_id)}">${/^https:\/\//.test(point.url || '')
        ? `<a class="e2e-point" href="${esc(point.url)}" target="_blank" rel="noopener"${tip(description)} aria-label="${esc(description)}">${content}</a>`
        : `<span class="e2e-point" tabindex="0" role="img"${tip(description)} aria-label="${esc(description)}">${content}</span>`}</li>`;
    }).join('');
    const metrics = new Map();
    for (const point of item.points) for (const metric of point.metrics || []) if (!metrics.has(metricKey(metric))) metrics.set(metricKey(metric), { label: metric.label, unit: metric.unit });
    const trends = [...metrics.values(), { label: '运行耗时', unit: 'duration_ms' }].map((metric) => {
      const duration = metric.unit === 'duration_ms';
      const current = duration ? null : (latest.metrics || []).find((item) => metricKey(item) === metricKey(metric));
      const now = duration ? msText(latest.duration_ms) : current ? `${scoreText(current)}${scoreSource(current)}` : '本次无此指标';
      const chart = realTrendChart(item.points, metric);
      return `<figure class="real-trend${duration ? ' duration' : ''}"><figcaption><span>${esc(metric.label)}</span> <span class="num">${esc(now)}</span> <span class="muted">最新</span></figcaption>${chart || '<div class="muted real-trend-empty">还没有可画的数值</div>'}</figure>`;
    }).join('');
    const anomaly = ['error', 'failed'].includes(latest.quality_status) ? ` ${badge('评分异常', 'warn')}` : '';
    return `<article class="e2e-case real-case" data-real-item="${esc(item.name)}"><header class="e2e-case-head"><h4 class="e2e-case-title"><a class="real-case-link" data-real-case="${esc(item.name)}" href="${esc(realCaseHref(item.name))}" aria-label="查看 ${esc(item.name)} 的 Real E2E 详情"><code>${esc(item.name)}</code></a></h4><span class="sub">${n(item.points.length)} 次执行 · 最新 ${deliveryBadge(latest.delivery)}${anomaly}</span></header>
      ${item.spec ? `<div class="sub e2e-case-file"><code>${esc(item.spec)}</code></div>` : ''}
      <ol class="e2e-timeline" aria-label="${esc(item.name)}的执行历史">${marks}</ol>
      <div class="real-trends">${trends}</div></article>`;
  }
  function realScoresSection(executed, history = {}, scoreRuns = [], mockPreview = false, localArtifactPreview = false, scoreReport = null) {
    const report = scoreReport || executed.find((entry) => entry.artifact.startsWith('real-e2e-results') && entry.scores?.length);
    const groups = realCaseGroups(report, history);
    let html = sectionHead('Real E2E 质量评分', localArtifactPreview ? '本地导入的真实历史产物；逐用例结果请以来源运行和日期为准' : mockPreview ? '本地模拟评分与耗时，仅用于预览；不代表 CI 实测结果' : '质量分数仅作观察，不设置通过门槛；交付结果单独显示');
    if (scoreRuns.length) html += `<div class="card score-run-summary"><b>${localArtifactPreview ? '最近两次主仓 Nightly（下方展示本地导入的历史报告）' : '最近两天的 Nightly'}</b><div class="muted">按北京时间，同一天优先使用手动或触发式运行。</div>${scoreRuns.slice(0, 2).map((run) => `<div class="score-run-row"><span class="${run.conclusion === 'success' ? 'good' : run.conclusion === 'cancelled' ? 'muted' : 'bad'}">${run.conclusion === 'success' ? '✓' : run.conclusion === 'cancelled' ? '−' : '×'}</span> ${esc(scoreDay(run.created_at))} · ${run.event === 'workflow_dispatch' ? (run.branch === 'main' ? '手动' : '触发式') : '定时'} · ${link(run.url, `run ${esc(run.run_id)}`)} · 整次运行${run.conclusion === 'success' ? '成功' : run.conclusion === 'cancelled' ? '取消' : '失败'} · 耗时 ${dur(run.duration_s)} · 产物${run.artifact_status === 'available' ? '已读取' : run.artifact_status === 'unreadable' ? '解析失败' : '缺失'}</div>`).join('')}<div class="muted">产物未读到时，逐用例分数和耗时未知；整次失败不代表每个用例失败。</div></div>`;
    if (!report) {
      html += `<div class="banner warn"><span class="icon">▲</span><div><div class="title">尚未读取到最新 Real E2E 评分</div><div>${groups.length ? '以下仍显示已保存的逐用例历史；最新运行的分数和耗时暂不可用。' : '需要可解析的 <code>real-e2e-results</code> 产物，才能显示逐用例分数、失败标记和耗时。'}</div></div></div>`;
      if (!groups.length) return html;
    } else {
      const scores = report.scores;
      const passed = scores.filter((row) => row.delivery === 'passed').length;
      const scored = scores.filter((row) => row.metrics.some((metric) => metric.value != null)).length;
      html += `<div class="muted" style="margin:-4px 0 8px">${mockPreview ? `本地模拟运行 · ${date(report.created_at)}` : `最近一次可读取的逐用例报告：${link(report.url, `run ${esc(report.run_id)}`)} · <code>${esc(report.branch)}</code> · ${date(report.created_at)}`} · 此处保留各评分器的原始量纲。</div>`;
      html += tiles([
        { label: 'Real E2E 用例', value: n(scores.length), sub: `${new Set(scores.map((row) => row.family)).size} 类评分` },
        { label: '交付通过', value: `${n(passed)}<small>/ ${n(scores.length)}</small>`, sub: '仅表示测试流程与最终交付成功', tone: passed === scores.length ? 'good' : 'warn' },
        { label: '有质量分数', value: `${n(scored)}<small>/ ${n(scores.length)}</small>`, sub: '未评分或 Judge 错误会明确显示', tone: scored === scores.length ? 'good' : 'warn' },
        { label: '质量门槛', value: '无', sub: '不根据分数改变 CI 结论' },
      ]);
    }
    html += `<div class="e2e-legend" aria-label="Real E2E 状态图例">${['passed', 'failed', 'unknown'].map((state) => `<span><span class="e2e-status-mark ${state}" aria-hidden="true">${REAL_MARK[state]}</span>${REAL_STATUS[state]}</span>`).join('')}<span class="muted">曲线：圆点为实测；首次实测后的红色 × 表示该项数据缺失或用例交付失败，悬停可看原因。缺失数据的 × 与上次有分数的运行平齐，虚线经过缺失运行连接到下次实测；交付失败时沿用上次实测分数（没有历史时按 0）。每个用例最多保留最近 30 个运行日，每天取一次运行。</span></div>`;
    html += groups.map((group) => {
      // Collapse state shares the run-record set; the prefix keeps family names apart from shard names.
      const key = `real:${group.family}`, open = !STATE.e2eCollapsed.has(key), id = `real-e2e-category-${encodeURIComponent(group.family)}`;
      return `<section class="card e2e-category" data-real-family="${esc(group.family)}"><h3><button type="button" class="e2e-category-toggle" data-e2e-category="${esc(key)}" aria-expanded="${open}" aria-controls="${esc(id)}"><span class="e2e-category-chevron" aria-hidden="true"></span><span>${esc(REAL_FAMILY_NAME[group.family] || (group.family === 'other' ? '其他' : group.family))}</span> <span class="sub">${n(group.items.length)} 个用例</span></button></h3><div id="${esc(id)}"${open ? '' : ' hidden'}>${group.items.map(realCaseItem).join('')}</div></section>`;
    }).join('');
    return html;
  }

  // E2E run records: each unexpired e2e-results on the board lists its Playwright
  // cases and execution history; HTML stays only as long as the Actions artifact.
  const E2E_NAME = { failed: '失败', flaky: '重试通过', skipped: '跳过', passed: '通过' };
  const E2E_TONE = { failed: 'bad', flaky: 'warn', skipped: '', passed: 'good' };
  const E2E_ORDER = ['failed', 'flaky', 'skipped', 'passed'];
  const E2E_MARK = { failed: '×', flaky: '↻', skipped: '−', passed: '✓' };
  const msText = (v) => (v == null ? '—' : v < 1000 ? `${Math.round(v)}ms` : v < 60000 ? `${(v / 1000).toFixed(1)}s` : dur(v / 1000));
  const hostedSlice = (r, slice) => r.reports?.some((rep) => rep.slice === slice && rep.html === `e2e/${r.artifact_id}/${slice}/index.html`);
  function caseHTMLPath(c, r, slice) {
    const path = typeof c.html === 'string' ? c.html : '';
    // The index is authoritative after Pages attaches bundles. A cached steps file
    // must not link to a report which this deployment could not host.
    if (!hostedSlice(r, slice) || !/^\d+$/.test(String(r.artifact_id)) || !/^[A-Za-z0-9_@+=-][A-Za-z0-9._@+=-]{0,127}$/.test(slice)
        || !path.startsWith('data/') || !path.endsWith('.html')
        || !path.split('/').every(p => p && [...p].length <= 128 && p !== '.' && p !== '..' && !/[\\\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(p))) return '';
    const href = `./e2e/${r.artifact_id}/${encodeURIComponent(slice)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    return href;
  }
  const e2eDataKey = (r) => `${r.artifact_id}:${r.version}:${r.bundle || ''}`;
  function lineRunIds() {
    const d = lineSection(STATE.snap, 'ci')?.data, ids = new Set();
    for (const lane of d?.lanes?.lanes || []) for (const day of lane.days || []) for (const cell of day || []) ids.add(cell.id);
    for (const run of d?.recent_runs || []) ids.add(run.id);
    return ids;
  }
  function e2eRecords() {
    const ids = lineRunIds();
    return (STATE.e2e?.records || []).filter(r => ids.has(r.run_id) && /^data\/e2e\/\d+\.json$/.test(r.steps || ''));
  }
  function e2eCaseGroups() {
    const groups = new Map();
    for (const record of e2eRecords()) {
      const doc = STATE.e2eSteps[e2eDataKey(record)];
      for (const slice of doc?.slices || []) {
        if (typeof slice?.slice !== 'string' || !Array.isArray(slice.cases)) continue;
        for (const [position, c] of slice.cases.entries()) {
          if (!c || typeof c.title !== 'string' || !E2E_ORDER.includes(c.status)) continue;
          const file = typeof c.file === 'string' ? c.file : '';
          // Lines move as specs are edited. Only slice + file + title identify a case.
          const key = JSON.stringify([slice.slice, file, c.title]);
          if (!groups.has(slice.slice)) groups.set(slice.slice, new Map());
          const cases = groups.get(slice.slice);
          if (!cases.has(key)) cases.set(key, { key, slice: slice.slice, file, title: c.title, history: [] });
          cases.get(key).history.push({ record, c, position });
        }
      }
    }
    const time = r => Date.parse(r.created_at) || 0;
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([slice, cases]) => ({
      slice, cases: [...cases.values()].map(c => {
        c.history.sort((a, b) => time(a.record) - time(b.record) || Number(a.record.artifact_id) - Number(b.record.artifact_id) || a.position - b.position);
        return c;
      }).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.file.localeCompare(b.file)),
    }));
  }
  function e2eHistoryCase(item) {
    const latest = item.history.at(-1).c;
    const points = item.history.map(({record, c}) => {
      const href = caseHTMLPath(c, record, item.slice);
      const viewer = href ? `./e2e-report.html?${new URLSearchParams({ src: href.slice(2), line: currentLine(STATE.snap).key, case: item.key })}` : '';
      const description = `${date(record.created_at)} · ${E2E_NAME[c.status]} · 耗时 ${msText(c.duration_ms)} · ${record.title || 'run'} ${record.run_id}${c.project ? ` · ${c.project}` : ''}${href ? ' · 打开执行记录 HTML' : ''}`;
      const content = `<span class="e2e-status-mark ${esc(c.status)}" aria-hidden="true">${E2E_MARK[c.status]}</span>`;
      return `<li class="e2e-history-point ${esc(c.status)}" data-e2e-artifact="${esc(record.artifact_id)}">${href
        ? `<a class="e2e-point e2e-case-html" href="${esc(viewer)}" target="_blank" rel="noopener"${tip(description)} aria-label="${esc(description)}">${content}</a>`
        : `<span class="e2e-point" tabindex="0" role="img"${tip(description)} aria-label="${esc(description)}">${content}</span>`}</li>`;
    }).join('');
    return `<article class="e2e-case" data-e2e-case="${esc(item.key)}"><header class="e2e-case-head"><h4 class="e2e-case-title">${esc(item.title)}</h4><span class="sub">${n(item.history.length)} 次执行 · 最新 ${badge(E2E_NAME[latest.status], E2E_TONE[latest.status])}</span></header>
      <div class="sub e2e-case-file"><code>${esc(item.file)}</code></div>
      <ol class="e2e-timeline" aria-label="${esc(item.title)}的执行历史">${points}</ol></article>`;
  }
  function e2eHistoryContent() {
    const groups = e2eCaseGroups(), filter = STATE.e2eFilter, records = e2eRecords();
    const count = groups.reduce((sum, g) => sum + g.cases.length, 0);
    let html = sectionHead('E2E 执行记录', `${n(groups.length)} 个类别 · ${n(count)} 个用例 · 保留期内的执行历史`);
    if (!STATE.e2e) return html + `<div class="card">${empty('尚未读取到 E2E 执行记录')}</div>`;
    const options = ['', ...E2E_ORDER].map(k => `<option value="${k}"${filter.status === k ? ' selected' : ''}>${k ? `最新${E2E_NAME[k]}` : '全部结果'}</option>`).join('');
    html += `<div class="filters e2e-filters"><select data-e2e-filter="status" aria-label="按最新结果筛选">${options}</select><input type="search" data-e2e-filter="q" value="${esc(filter.q)}" placeholder="搜索类别、用例、文件" aria-label="搜索用例"></div>`;
    const loading = records.filter(r => STATE.e2eLoading.has(e2eDataKey(r))).length;
    const errors = records.filter(r => STATE.e2eErrors.has(e2eDataKey(r))).length;
    if (loading) html += `<div class="muted" role="status">正在读取 ${n(loading)} 份执行记录…</div>`;
    if (errors) html += `<div class="muted" role="status">${n(errors)} 份执行记录暂不可读取，已展示其余可用用例。</div>`;
    const q = filter.q.trim().toLowerCase();
    const visible = groups.map(g => ({...g, cases: g.cases.filter(c => (!filter.status || c.history.at(-1).c.status === filter.status)
      && (!q || `${g.slice} ${c.title} ${c.file}`.toLowerCase().includes(q)))})).filter(g => g.cases.length);
    html += `<div class="e2e-legend" aria-label="执行状态图例">${E2E_ORDER.map(status => `<span><span class="e2e-status-mark ${status}" aria-hidden="true">${E2E_MARK[status]}</span>${E2E_NAME[status]}</span>`).join('')}</div>`;
    html += visible.map(g => {
      // Search/filter opens matches without overwriting the user's collapse choice.
      const open = Boolean(q || filter.status) || !STATE.e2eCollapsed.has(g.slice);
      const id = `e2e-category-${encodeURIComponent(g.slice)}`;
      return `<section class="card e2e-category" data-e2e-slice="${esc(g.slice)}"><h3><button type="button" class="e2e-category-toggle" data-e2e-category="${esc(g.slice)}" aria-expanded="${open}" aria-controls="${esc(id)}"><span class="e2e-category-chevron" aria-hidden="true"></span><span>${esc(g.slice)}</span> <span class="sub">${n(g.cases.length)} 个用例</span></button></h3><div id="${esc(id)}"${open ? '' : ' hidden'}>${g.cases.map(e2eHistoryCase).join('')}</div></section>`;
    }).join('');
    if (!visible.length && !loading) html += empty(count ? '没有符合条件的用例' : '该分支线暂时没有可展示的用例执行历史');
    return html;
  }
  const e2eRecordsSection = () => `<div id="e2e-records">${e2eHistoryContent()}</div>`;
  function renderE2EHistory() {
    const box = $('#e2e-records');
    if (!box) return;
    const focus = document.activeElement, key = focus?.dataset?.e2eFilter, pos = focus?.selectionStart;
    box.innerHTML = e2eHistoryContent();
    if (returnFocus.e2ePending && STATE.tab === 'tests') {
      const target = [...box.querySelectorAll('[data-e2e-case]')]
        .find((item) => item.dataset.e2eCase === returnFocus.e2eKey);
      if (target) {
        returnFocus.e2ePending = false;
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'center' });
          const url = new URL(location.href);
          url.searchParams.delete('returnLine');
          url.searchParams.delete('returnE2E');
          history.replaceState(history.state, '', url);
        });
      }
    }
    if (key) {
      const el = $(`[data-e2e-filter="${key}"]`, box);
      el?.focus({preventScroll: true});
      if (el?.type === 'search' && pos != null) el.setSelectionRange(pos, pos);
    }
  }
  async function loadE2EHistory() {
    if (STATE.tab !== 'tests' || !STATE.snap) return;
    const queue = e2eRecords().filter(r => {
      const key = e2eDataKey(r);
      return !STATE.e2eSteps[key] && !STATE.e2eLoading.has(key) && !STATE.e2eErrors.has(key);
    });
    if (!queue.length) return;
    queue.forEach(r => STATE.e2eLoading.add(e2eDataKey(r)));
    renderE2EHistory();
    // Read only published JSON, with four concurrent requests. One unavailable
    // file must not block the other cases, and line changes never merge histories.
    await Promise.all(Array.from({length: Math.min(4, queue.length)}, async () => {
      while (queue.length) {
        const record = queue.shift(), key = e2eDataKey(record);
        try {
          const doc = await fetchJson(`./${record.steps}`);
          if (!Array.isArray(doc?.slices)) throw new Error('invalid steps');
          STATE.e2eSteps[key] = doc;
        } catch (err) {
          STATE.e2eErrors.add(key);
        } finally {
          STATE.e2eLoading.delete(key);
          renderE2EHistory();
        }
      }
    }));
  }

  // Nightly performance: one duration point per case per Beijing calendar day.
  // The file is optional, so boards that do not publish it simply omit this section.
  const PERF_STATUS = {
    COMPLETED: ['通过', 'good'],
    BLOCKED: ['阻塞', 'warn'],
    FAILED: ['失败', 'bad'],
    ERROR: ['错误', 'bad'],
    CANCELLED: ['取消', ''],
  };
  const perfStatus = (status) => PERF_STATUS[String(status || '').toUpperCase()] || [status || '未知', ''];
  const perfMs = (ms) => (ms == null ? '—' : msText(ms));
  const perfDot = (status) => `<span class="perf-dot ${perfStatus(status)[1] || 'unknown'}" aria-hidden="true"></span>`;
  const perfDevice = (device) => {
    if (!device) return '—';
    const screen = device.screen ? `${device.screen.width}×${device.screen.height}` : '';
    return [device.model, screen].filter(Boolean).join(' · ') || '—';
  };
  const perfAxis = (ms) => (ms == null || ms === 0 ? '0' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`);

  function perfSparkline(points) {
    const vals = (points || []).map((p) => p.query_ms).filter((v) => v != null);
    if (!vals.length) return '<span class="perf-spark-empty">—</span>';
    if (vals.length === 1) return '<svg class="perf-spark" viewBox="0 0 112 24" width="112" height="24" aria-hidden="true"><circle cx="56" cy="12" r="2.8"/></svg>';
    const w = 112, h = 24, pad = 3;
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const step = (w - pad * 2) / (vals.length - 1);
    const pts = vals.map((v, i) => [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="perf-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4"/></svg>`;
  }

  function perfChart(points) {
    const rows = (points || []).filter((p) => p && p.date);
    const vals = rows.map((p) => p.query_ms).filter((v) => v != null);
    if (!rows.length || !vals.length) return empty('还没有可绘制的查询耗时数据');
    const W = 760, H = 230, L = 52, R = 16, T = 16, B = 30;
    const max = Math.max(...vals);
    const mag = Math.pow(10, Math.floor(Math.log10(max || 1)));
    const step = Math.max(mag / 2, 1);
    const yMax = Math.max(1, Math.ceil((max * 1.08) / step) * step);
    const x = (i) => (rows.length === 1 ? L + (W - L - R) / 2 : L + (i / (rows.length - 1)) * (W - L - R));
    const y = (v) => H - B - (v / yMax) * (H - T - B);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const yy = T + f * (H - T - B);
      return `<line class="perf-grid-line" x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}"/><text class="perf-axis-text" x="${L - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${perfAxis(yMax * (1 - f))}</text>`;
    }).join('');
    let d = '', begun = false;
    rows.forEach((p, i) => {
      if (p.query_ms == null) { begun = false; return; }
      d += `${begun ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.query_ms).toFixed(1)} `;
      begun = true;
    });
    const dots = rows.map((p, i) => {
      if (p.query_ms == null) return '';
      const [label, tone] = perfStatus(p.status);
      return `<circle class="perf-point ${tone}" cx="${x(i).toFixed(1)}" cy="${y(p.query_ms).toFixed(1)}" r="4"><title>${esc(`${p.date} · ${label} · 查询 ${perfMs(p.query_ms)} · ${p.run_id || ''}`)}</title></circle>`;
    }).join('');
    const labels = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])].filter((i) => i >= 0 && i < rows.length);
    const xText = labels.map((i) => `<text class="perf-axis-text" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(rows[i].date.slice(5))}</text>`).join('');
    const note = rows.length === 1 ? `<text class="perf-chart-note" x="${x(0).toFixed(1)}" y="${(y(rows[0].query_ms) - 12).toFixed(1)}" text-anchor="middle">首个数据点</text>` : '';
    return `<div class="perf-chart-wrap"><svg class="perf-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="每日查询耗时曲线，${rows.length} 个数据点">${grid}<line class="perf-axis-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>${d ? `<path class="perf-line" d="${d}"/>` : ''}${dots}${xText}${note}</svg></div>`;
  }

  const PERF_STAGE_NAME = { tap: '点击', queued: '排队', dequeued: '出队', wire_send: '发送', ack: 'ACK', first_text: '首条消息', last_text: '消息接收', task_done: '任务完成', display_done: '展示完成' };
  const perfOutcome = (outcome) => {
    const value = String(outcome || '').toLowerCase();
    if (value === 'completed' || value === 'ok') return ['完成', 'good'];
    if (value === 'cancelled') return ['取消', 'warn'];
    return [outcome || '未知', 'bad'];
  };

  function perfQueryStages(query) {
    const stages = (Array.isArray(query?.stages) ? query.stages : [])
      .filter((s) => s && Number.isFinite(Number(s.at_ms)) && (!s.name || s.name !== 'display_done'))
      .sort((a, b) => Number(a.at_ms) - Number(b.at_ms));
    if (!stages.length) return empty('这次查询没有阶段明细');
    const base = Number(stages[0].at_ms);
    const lastIndex = stages.map((s) => s.name).lastIndexOf('last_text');
    const visible = lastIndex >= 0 ? stages.slice(0, lastIndex + 1) : stages;
    const rows = visible.map((stage, index) => {
      const start = Math.max(0, Number(stage.at_ms) - base);
      const next = index + 1 < visible.length ? Math.max(0, Number(visible[index + 1].at_ms) - base) : start;
      const width = Math.max(0, next - start);
      return { name: PERF_STAGE_NAME[stage.name] || stage.name, start, width, offset: start, detail: stage.detail || '' };
    });
    const max = Math.max(...rows.map((row) => row.start + row.width), 1);
    return `<div class="perf-waterfall">${rows.map((row) => `<div class="perf-step" title="${esc(row.detail)}"><span class="perf-step-id">${esc(row.name)}</span><span class="perf-step-action">+${perfMs(row.offset)}</span><span class="perf-step-track"><span class="perf-step-fill ok" style="width:${Math.max(2, (row.width / max) * 100).toFixed(1)}%"></span></span><span class="perf-step-ms">${perfMs(row.width)}</span></div>`).join('')}</div>`;
  }

  function perfQueries(latest) {
    const queries = Array.isArray(latest?.queries) ? latest.queries : [];
    if (!queries.length) return empty('这次运行没有 Orbit profiling 查询记录；不使用 E2E 总耗时替代');
    const max = Math.max(...queries.map((q) => q.duration_ms || 0), 1);
    const latestQuery = queries[queries.length - 1];
    return `<div class="perf-query-list">${queries.map((q, i) => {
      const [label, tone] = perfOutcome(q.outcome);
      return `<div class="perf-query"><div class="perf-query-head"><code>Q${i + 1}</code><span class="muted">${esc(shortDateTime(q.started_at))}</span>${badge(label, tone)}<span class="perf-query-ms">${perfMs(q.duration_ms)}</span></div><div class="perf-query-track"><span class="perf-query-fill ${tone}" style="width:${Math.max(2, ((q.duration_ms || 0) / max) * 100).toFixed(1)}%"></span></div><div class="perf-query-sub">首条消息 ${perfMs(q.first_text_ms)} · 展示完成 ${perfMs(q.display_ms)} · ${n(q.text_chars)} 字 · 上下行 ${perfBytes(q.request_bytes)} / ${perfBytes(q.response_bytes)}</div></div>`;
    }).join('')}</div><div class="perf-stage-title">最近一次查询阶段</div>${perfQueryStages(latestQuery)}`;
  }

  const perfInt = (value) => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('zh-CN').format(Number(value));
  };
  const perfBytes = (value) => {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return '—';
    const bytes = Number(value);
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  const PERF_PHASE_NAME = {
    'route.apps': '路由应用',
    route: '路由',
    'task.saved': '保存任务',
    'run.start': '启动',
    classify: '分类',
    'brief.memory': '记忆检索',
    execute: '执行',
    'post.reviews': '结果审阅',
    'post.next_steps': '后续步骤',
    'post.citations': '引用整理',
    posted: '完成',
  };

  function perfCloudPhases(phases) {
    const rows = (Array.isArray(phases) ? phases : [])
      .filter((phase) => phase && phase.name)
      .sort((a, b) => (Number(a.start_ms) || 0) - (Number(b.start_ms) || 0));
    if (!rows.length) return empty('这条 trace 没有 Orbit 阶段事件');
    const max = Math.max(...rows.map((phase) => (Number(phase.start_ms) || 0) + (Number(phase.duration_ms) || 0)), 1);
    return `<div class="perf-waterfall">${rows.map((phase) => {
      const start = Number(phase.start_ms) || 0;
      const duration = Number(phase.duration_ms) || 0;
      const label = PERF_PHASE_NAME[phase.name] || phase.name;
      return `<div class="perf-step" title="${esc(phase.name)}${phase.note ? ` · ${esc(phase.note)}` : ''}"><span class="perf-step-id">${esc(label)}</span><span class="perf-step-action">+${perfMs(start)}</span><span class="perf-step-track"><span class="perf-step-fill ok" style="width:${Math.max(2, (duration / max) * 100).toFixed(1)}%"></span></span><span class="perf-step-ms">${perfMs(duration)}</span></div>`;
    }).join('')}</div>`;
  }

  function perfCloud(latest) {
    const cloud = latest?.cloud;
    if (!cloud?.available || (!cloud.calls?.length && !cloud.phases?.length)) {
      return empty('这次运行没有 Orbit 云端 trace；model / TTFT / TPOT 要在 profiling 落盘后才有');
    }
    const matched = Number(cloud.matched_queries) || 0;
    const traceCount = Number(cloud.trace_count) || 0;
    const calls = Array.isArray(cloud.calls) ? cloud.calls.slice().reverse().slice(0, 12) : [];
    const totals = cloud.totals || {};
    const note = matched > 0
      ? `已按 task id 关联 ${matched} 个 query；以下是本 case 可见的 ${traceCount} 条云端 trace`
      : `当前 query 的云端 trace 尚未落盘 / 未按 task id 匹配；以下为本 case 目录中可见的 ${traceCount} 条 trace，仅作模型侧参考`;
    const captured = cloud.captured_at ? `采集 ${shortDateTime(cloud.captured_at)}` : '采集时间未知';
    return `<div class="perf-cloud-note ${matched ? 'matched' : 'unmatched'}">${esc(note)}<span class="muted"> · ${esc(captured)}</span></div>
      <div class="perf-cloud-stats">
        <div><span>模型调用</span><strong>${n(totals.calls ?? cloud.call_count)}</strong><em>${n(traceCount)} 条 trace</em></div>
        <div><span>平均 TTFT</span><strong>${perfMs(totals.ttft_avg_ms)}</strong><em>首 token</em></div>
        <div><span>平均 TPOT</span><strong>${totals.tpot_avg_ms == null ? '—' : `${Number(totals.tpot_avg_ms).toFixed(2)}ms`}</strong><em>每 token</em></div>
        <div><span>上下文 tokens</span><strong>${perfInt(totals.input_tokens)}</strong><em>单次最大 ${perfInt(totals.input_tokens_max)}</em></div>
        <div><span>输出 tokens</span><strong>${perfInt(totals.output_tokens)}</strong><em>模型均耗时 ${perfMs(totals.model_ms_avg)}</em></div>
      </div>
      ${calls.length ? `<div class="perf-model-scroll-hint">表格可左右滑动查看 TTFT / TPOT / 上下文</div><div class="perf-model-wrap"><table class="perf-model-table"><thead><tr><th>模型</th><th class="num">耗时</th><th class="num">TTFT</th><th class="num">TPOT</th><th class="num">上下文</th><th class="num">输出</th><th>流式</th></tr></thead><tbody>${calls.map((call) => {
        const title = [call.provider, call.stream_ms != null ? `stream ${perfMs(call.stream_ms)}` : null, call.finish_reason, call.status, call.tokens_per_s != null ? `${call.tokens_per_s} tok/s` : null].filter(Boolean).join(' · ');
        return `<tr title="${esc(title)}"><td class="model" title="${esc(call.model)}">${esc(call.model)}</td><td class="num">${perfMs(call.duration_ms)}</td><td class="num">${perfMs(call.ttft_ms)}</td><td class="num">${call.tpot_ms == null ? '—' : `${Number(call.tpot_ms).toFixed(2)}ms`}</td><td class="num">${perfInt(call.input_tokens)}</td><td class="num">${perfInt(call.output_tokens)}</td><td>${call.stream ? badge('流式', 'good') : badge('非流式', '')}</td></tr>`;
      }).join('')}</tbody></table></div>${cloud.call_count > calls.length ? `<p class="perf-note">共 ${n(cloud.call_count)} 条调用，显示最近 ${n(calls.length)} 条。</p>` : ''}` : ''}
      <div class="perf-stage-title">Orbit 阶段（最新一次云端 trace）</div>
      ${perfCloudPhases(cloud.phases)}
      <p class="perf-note">上下文 = model call 的 input tokens；缓存读取 ${perfInt(cloud.usage?.cache_read_tokens)} tokens，reasoning ${perfInt(cloud.usage?.reasoning_tokens)} tokens。trace 由 Orbit 异步写入，未匹配时不代表当前 query。</p>`;
  }

  function perfHistoryTable(points) {
    if (!points.length) return empty('还没有历史点');
    return `<div class="table-wrap perf-table-wrap"><table class="perf-table"><thead><tr><th>日期</th><th>状态</th><th class="num">平均查询</th><th class="num">查询数</th><th>运行</th><th>commit</th></tr></thead><tbody>${points.slice().reverse().map((p) => {
      const [label, tone] = perfStatus(p.status);
      return `<tr><td class="nowrap">${esc(p.date)}</td><td>${badge(label, tone)}</td><td class="num nowrap">${perfMs(p.query_ms)}</td><td class="num">${n(p.query_count ?? 0)}</td><td><code>${esc(p.run_id || '—')}</code></td><td class="mono">${esc((p.commit || '').slice(0, 7) || '—')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function performanceSection() {
    const history = STATE.performance;
    const cases = history?.cases && typeof history.cases === 'object' ? Object.values(history.cases) : [];
    if (!cases.length) return '';
    cases.sort((a, b) => String(b.latest?.finished_at || '').localeCompare(String(a.latest?.finished_at || '')) || String(a.id).localeCompare(String(b.id)));
    if (!STATE.perfCase || !history.cases[STATE.perfCase]) {
      STATE.perfCase = history.cases['DM-WF-BACK-01'] ? 'DM-WF-BACK-01' : cases[0].id;
    }
    const selected = history.cases[STATE.perfCase] || cases[0];
    const latest = selected.latest || {};
    const points = (Array.isArray(selected.points) ? selected.points : []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const statuses = cases.map((c) => c.latest?.status);
    const completed = statuses.filter((s) => String(s).toUpperCase() === 'COMPLETED').length;
    const blocked = statuses.filter((s) => String(s).toUpperCase() === 'BLOCKED').length;
    const failed = statuses.filter((s) => ['FAILED', 'ERROR'].includes(String(s).toUpperCase())).length;
    const latestQueries = cases.map((c) => c.latest?.query_ms).filter((v) => v != null);
    const avgQuery = latestQueries.length ? Math.round(latestQueries.reduce((sum, value) => sum + value, 0) / latestQueries.length) : null;
    const values = points.map((p) => p.query_ms).filter((v) => v != null).sort((a, b) => a - b);
    const median = values.length ? (values.length % 2 ? values[(values.length - 1) / 2] : Math.round((values[values.length / 2 - 1] + values[values.length / 2]) / 2)) : null;
    const [selectedLabel, selectedTone] = perfStatus(latest.status);
    const activeDays = new Set(points.map((p) => p.date)).size;
    const queryCount = latest.query_count ?? (Array.isArray(latest.queries) ? latest.queries.length : 0);
    const title = selected.title || latest.title || selected.id;
    const caseButtons = cases.map((c) => {
      const active = c.id === selected.id;
      return `<button type="button" class="perf-case${active ? ' active' : ''}" data-perf-case="${esc(c.id)}" aria-pressed="${active}"><span class="perf-case-top">${perfDot(c.latest?.status)}<code>${esc(c.id)}</code><span class="perf-case-dur" title="本轮 query 平均耗时">${perfMs(c.latest?.query_ms)}</span></span><span class="perf-case-title">${esc(c.title || '')}</span>${perfSparkline(c.points)}</button>`;
    }).join('');
    const updated = history.updated_at ? shortDateTime(history.updated_at) : '—';
    return `<div class="perf-section" data-perf-section>
      ${sectionHead('Nightly 用例性能', `真机 / 模拟器 nightly · 每用例每天一个查询耗时点 · 从发出 query 到收到最后一条消息 · 同日重跑取最新 · 数据 ${esc(updated)}`)}
      ${tiles([
        { label: '用例', value: n(cases.length), sub: `最新一轮 ${n(completed)} 通过` },
        { label: '最新通过', value: `${n(completed)}<small>/ ${n(cases.length)}</small>`, sub: `${Math.round((completed / cases.length) * 100)}%`, tone: completed === cases.length ? 'good' : '' },
        { label: '阻塞 / 失败', value: `${n(blocked)} / ${n(failed)}`, sub: '阻塞不等于失败', tone: blocked || failed ? 'warn' : 'good' },
        { label: '最新平均查询耗时', value: perfMs(avgQuery), sub: '各用例最近一次 · 不含 E2E 等待' },
      ])}
      <div class="perf-layout">
        <div class="card perf-list-card"><h3>用例 <span class="sub">${n(cases.length)} 个 · 点击切换</span></h3><div class="perf-list">${caseButtons}</div></div>
        <div class="perf-detail">
          <div class="card perf-detail-head"><div class="perf-detail-title"><div class="perf-title-row"><h3><code>${esc(selected.id)}</code></h3>${badge(selectedLabel, selectedTone)}</div><p class="perf-case-name">${esc(title)}</p><p class="muted">完成于 ${esc(shortDateTime(latest.finished_at))} · run <code>${esc(latest.run_id || '—')}</code> · commit <span class="mono">${esc((latest.commit || '').slice(0, 7) || '—')}</span> · ${esc(perfDevice(latest.device))} · E2E 总耗时 ${perfMs(latest.duration_ms)}</p></div></div>
          <div class="perf-kpis">
            <div><span>本轮平均查询</span><strong>${perfMs(latest.query_ms)}</strong></div>
            <div><span>历史中位数</span><strong>${perfMs(median)}</strong></div>
            <div><span>查询次数</span><strong>${n(queryCount)}</strong></div>
            <div><span>记录天数</span><strong>${n(activeDays)}</strong></div>
          </div>
          <div class="card perf-card"><h3>最近一次 Profiling · 查询耗时 <span class="sub">${n(queryCount)} 次查询 · 以最后一条消息到达计 · E2E ${perfMs(latest.duration_ms)}</span></h3>${perfQueries(latest)}</div>
          <div class="card perf-card"><h3>Orbit 云端 trace <span class="sub">model 耗时 · TTFT · TPOT · 上下文 tokens · 阶段</span></h3>${perfCloud(latest)}</div>
          <div class="card perf-card"><h3>每日平均查询耗时 <span class="sub">一天一个点 · 从 query 到消息接收 · Asia/Shanghai</span></h3>${perfChart(points)}<p class="perf-note">当前 ${n(activeDays)} 个执行日；每点为当轮 query 平均耗时，仅 profiling，不含 E2E 步骤等待；缺失日期不补 0。</p></div>
          <details class="card perf-card perf-history"><summary>执行历史 <span class="sub">${n(points.length)} 天</span></summary>${perfHistoryTable(points)}</details>
        </div>
      </div>
    </div>`;
  }

  function renderTests(sec, line) {
    const d = sec?.data;
    let html = sectionState(sec, 'E2E');
    if (!d) return html;
    const tree = d.tree;
    const ut = d.executed.find((e) => e.artifact.startsWith('ut'));
    const e2e = d.executed.find((e) => e.layer === 'e2e' && !e.artifact.startsWith('real-e2e-results'));
    html += tiles([
      { label: '测试文件（仓库树）', value: n(tree?.total), sub: tree ? `来源 ${esc(d.tree_source)}` : '文件树不可用' },
      { label: '有测试的包', value: tree ? `${d.inventory.filter((p) => p.tested).length}<small>/ ${d.inventory.length}</small>` : '—', tone: d.inventory.some((p) => !p.tested) ? 'warn' : 'good' },
      { label: 'CI 最近 UT 用例', value: n(ut?.totals?.tests), sub: ut?.totals ? `${ut.totals.passed} 通过 · ${ut.totals.failed} 失败 · ${ut.totals.skipped} 跳过` : ut ? '产物存在但没有解析出用例数' : '无产物', tone: ut?.totals?.failed ? 'bad' : ut?.totals ? 'good' : '' },
      { label: 'CI 最近 E2E 用例', value: n(e2e?.totals?.tests), sub: e2e?.totals ? `${e2e.totals.passed} 通过 · ${e2e.totals.failed} 失败/超时 · ${e2e.totals.skipped} 跳过 · ${e2e.totals.flaky} 重试通过` : e2e ? '产物存在但没有解析出用例数' : '无产物', tone: e2e?.totals?.failed ? 'bad' : e2e?.totals ? 'good' : '' },
    ]);
    html += performanceSection();
    html += e2eRecordsSection();
    html += realScoresSection(d.executed, d.score_history, d.score_runs, d.mock_real_e2e, d.local_artifact_preview, d.score_report);
    html += taggedSection(d.tagged, line);

    // Distribution ----------------------------------------------------------
    if (tree) {
      const layerSegs = Object.entries(tree.by_layer).map(([k, v]) => ({ name: LAYER_NAME[k] || k, value: v, color: LAYER_COLOR[k] || 'var(--muted)' }));
      const pkgs = tree.by_package.slice(0, 20).map((p) => ({ label: p.package, value: p.files, segments: Object.entries(p.layers).map(([k, v]) => ({ name: LAYER_NAME[k] || k, value: v, color: LAYER_COLOR[k] })) }));
      html += `<div class="grid wide" style="margin-top:12px">
        ${card('按层分布', stack(layerSegs) + legend(layerSegs) + `<div class="muted" style="margin-top:12px">按语言 / 文件类型分布（同一批 ${n(tree.total)} 个文件，包含所有测试层）</div><div style="margin-top:6px">${bars(Object.entries(tree.by_language).map(([k, v]) => ({ label: k, value: v })))}</div>`, { sub: `测试相关文件共 ${n(tree.total)} 个；上方按层统计` })}
        ${card('按包 / 目录分布', bars(pkgs) + legend(layerSegs.map((s) => ({ name: s.name, color: s.color }))), { sub: '每行数字是该包 / 目录中的测试相关文件数' })}
      </div>`;
    }

    html += sectionHead('按包的测试结构', '源文件数不含测试与 .d.ts；CI 用例只显示可映射到包的报告数量；覆盖率见 Coverage 页');
    html += `<div class="card">${table('t-inv', [
      { key: 'package', label: '包', render: (p) => `<code>${esc(p.package)}</code>` },
      { key: 'tested', label: '状态', render: (p) => (p.tested ? badge('有测试', 'good') : badge('无测试', 'bad')), sort: (p) => (p.tested ? 1 : 0) },
      { key: 'source_files', label: '源文件', num: true },
      { key: 'test_files', label: '测试文件', num: true },
      { key: 'ratio', label: '测试/源 比', num: true, render: (p) => (p.ratio == null ? '—' : `${ratioBar(Math.min(p.ratio, 1) * 100, p.ratio >= 0.5 ? 'good' : p.ratio > 0 ? 'warn' : 'bad')}${p.ratio.toFixed(2)}`) },
      { key: 'ci_cases', label: 'CI 用例', num: true, render: (p) => (p.ci_cases == null ? '<span class="muted">—</span>' : `${n(p.ci_cases)}${p.ci_failed ? ` <span class="bad">(${p.ci_failed} 失败)</span>` : ''}`) },
      { key: 'layers', label: '层', render: (p) => Object.entries(p.layers).map(([k, v]) => `${k} ${v}`).join(' · '), sortable: false },
    ], d.inventory, { defaultSort: { key: 'ratio', dir: 'asc' } })}</div>`;
    if (Object.keys(d.test_scripts || {}).length) html += `<div class="card" style="margin-top:12px"><h3>根 package.json 测试脚本</h3>${kv(Object.entries(d.test_scripts).map(([k, v]) => [k, `<code>${esc(v)}</code>`]))}</div>`;
    return html;
  }

  // Directory tree over per-file totals. Directories add up their files; a chain of
  // single directories collapses into one row, like compact folders in an editor.
  // Summaries without per-file totals pass their groups instead: each group is a
  // directory leaf carrying its own file count, so the tree stops at that level.
  const coverageTone = (v) => (v == null ? '' : v >= 80 ? 'good' : v >= 50 ? 'warn' : 'bad');
  function coverageTree(language, entries, query, { groups = false } = {}) {
    const metrics = language === 'node' ? ['lines', 'branches', 'functions'] : ['lines', 'branches'];
    const make = (name, path) => ({ name, path, dirs: new Map(), files: [], totals: {}, count: 0 });
    const add = (node, totals, files) => {
      node.count += files;
      for (const m of metrics) { const t = node.totals[m] ||= { covered: 0, total: 0 }; t.covered += totals?.[m]?.covered || 0; t.total += totals?.[m]?.total || 0; }
    };
    const root = make('', '');
    for (const entry of entries) {
      if (query && !entry.path.toLowerCase().includes(query)) continue;
      const parts = entry.path.split('/'), files = groups ? entry.files || 0 : 1;
      let node = root; add(root, entry.totals, files);
      parts.slice(0, -1).forEach((part, i) => {
        if (!node.dirs.has(part)) node.dirs.set(part, make(part, parts.slice(0, i + 1).join('/')));
        node = node.dirs.get(part); add(node, entry.totals, files);
      });
      node.files.push({ name: parts[parts.length - 1], path: entry.path, totals: entry.totals, files: groups ? files : null });
    }
    if (!root.count && !root.files.length) return empty(query ? '没有匹配的路径' : '没有路径');
    const compact = (node) => { while (node.dirs.size === 1 && !node.files.length) { const [only] = node.dirs.values(); node = { ...only, name: `${node.name}/${only.name}` }; } return node; };
    const percent = (t) => (t && t.total ? (t.covered * 100) / t.total : null);
    const describe = (path, totals) => [path, ...metrics.map((m) => `${COVERAGE_METRIC[m]} ${n(totals?.[m]?.covered)} / ${n(totals?.[m]?.total)}（${pct(percent(totals?.[m]))}）`)].join('\n');
    const cells = (totals, files) => metrics.map((m, i) => {
      const v = percent(totals?.[m]);
      return `<span class="cov-cell${i ? '' : ' main'}">${i ? '' : ratioBar(v ?? 0, coverageTone(v))}<span class="${coverageTone(v)}-text">${pct(v)}</span></span>`;
    }).join('') + `<span class="cov-count">${n(totals?.lines?.covered)} / ${n(totals?.lines?.total)}${files == null ? '' : ` · ${n(files)} 个文件`}</span>`;
    const row = (label, totals, files, path) => `<span class="cov-name"${tip(describe(path, totals))}>${label}</span>${cells(totals, files)}`;
    // Lowest line coverage first when asked; paths without lines go last, then by name.
    const lineRate = (item) => percent(item.totals?.lines) ?? Infinity;
    const order = STATE.covSort === 'lines' ? (a, b) => lineRate(a) - lineRate(b) || a.name.localeCompare(b.name) : (a, b) => a.name.localeCompare(b.name);
    const branch = (node, depth) => [...node.dirs.values()].map(compact).sort(order).map((dir) => {
      const key = `${language}:${dir.path}`, open = query || STATE.covOpen.has(key);
      return `<details class="cov-dir" data-cov-path="${esc(key)}"${open ? ' open' : ''} style="--depth:${depth}"><summary class="cov-row">${row(`<span class="cov-toggle" aria-hidden="true"></span>${esc(dir.name)}/`, dir.totals, dir.count, dir.path)}</summary>${branch(dir, depth + 1)}</details>`;
    }).join('') + node.files.slice().sort(order).map((file) => `<div class="cov-row cov-file${groups ? ' cov-group' : ''}" style="--depth:${depth}">${row(groups ? `${esc(file.name)}/` : esc(file.name), file.totals, file.files, file.path)}</div>`).join('');
    const head = `<div class="cov-row cov-head"><span class="cov-name">路径</span>${metrics.map((m) => `<span class="cov-cell">${COVERAGE_METRIC[m]}</span>`).join('')}<span class="cov-count">已覆盖 / 总行数</span></div>`;
    return `<div class="cov-tree" data-language="${language}" style="--metrics:${metrics.length}">${head}${branch(root, 0)}</div>`;
  }
  const COVERAGE_METRIC = { lines: '行', branches: '分支', functions: '函数' };

  function renderCoverage(sec, line) {
    const d = sec?.data;
    let html = sectionState(sec, 'Coverage');
    if (!d) return html;
    const cov = d.coverage || {};
    if (!cov.source) {
      const steps = `<ul class="steps">${(cov.attempts || []).map((a) => `<li><span class="mark ${a.ok ? 'ok' : 'no'}">${a.ok ? '✓' : '✗'}</span><span><b>${esc(a.step)}</b> <span class="muted">${esc(a.detail)}</span></span></li>`).join('')}</ul>`;
      const repoName = STATE.snap?.repository?.name || '本仓';
      return html + sectionHead('Coverage', '尚无可解析的覆盖率产物')
        + (line.default ? `<div class="banner warn"><span class="icon">▲</span><div><div class="title">等待 ${esc(repoName)} 覆盖率工作流首次发布摘要</div><div>每日完整基线成功后，这里会显示整仓趋势和路径明细；PR 与 main 增量随后自动叠加。</div></div></div>`
          : `<div class="banner warn"><span class="icon">▲</span><div><div class="title"><code>${esc(line.ref)}</code> 还没有覆盖率摘要</div><div>该分支的 CI 由目标为它的 PR 和手动运行触发；PR 或手动运行上传覆盖率摘要后，这里显示该分支自己的结果，不借用主干数据。</div></div></div>`)
        + `<div class="card" style="margin-top:12px">${steps}</div>`;
    }
    const languages = cov.languages || {};
    const prs = STATE.snap.sections?.prs?.data || {};
    const prTargetByNumber = new Map(
      ['items', 'recent_merged', 'recent_closed_unmerged']
        .flatMap((key) => prs[key] || [])
        .map((row) => [Number(row.number), row.base]),
    );
    if (!Object.keys(languages).length) {
      const labels = { lines_pct: '行覆盖率', branches_pct: '分支覆盖率', functions_pct: '函数覆盖率', statements_pct: '语句覆盖率' };
      const rows = Object.entries(cov.value || {}).filter(([key, value]) => key !== 'format' && value != null)
        .map(([key, value]) => [labels[key] || key, typeof value === 'number' && key.endsWith('_pct') ? pct(value) : esc(String(value))]);
      return html + sectionHead('Coverage', `来源 ${esc(cov.source)}`) + `<div class="card">${kv(rows)}</div>`;
    }

    const overall = cov.current?.totals || {};
    const overallKind = cov.current?.kind === 'authoritative' ? '权威完整结果' : cov.current?.kind === 'incremental' ? '增量估算' : '部分结果';
    html += sectionHead('Coverage', `${overallKind} · Node.js 与 Python 分开采集，整仓行/分支按计数合并`);
    html += tiles([
      { label: '整仓行覆盖率', value: pct(overall.lines?.percentage), tone: 'good', sub: `${n(overall.lines?.covered)} / ${n(overall.lines?.total)}` },
      { label: '整仓分支覆盖率', value: pct(overall.branches?.percentage), sub: `${n(overall.branches?.covered)} / ${n(overall.branches?.total)}` },
      { label: '数据集', value: Object.keys(languages).length, tone: Object.keys(languages).length === 2 ? 'good' : 'warn', sub: Object.keys(languages).map((key) => key === 'node' ? 'Node.js' : 'Python').join(' + ') },
    ]);

    const selectedRange = coverageRange(languages);
    if (selectedRange) {
      html += `<div class="coverage-week-toolbar" aria-label="覆盖率趋势时间范围">
        <button class="btn small" data-coverage-week="older"${STATE.coverageWeekOffset >= selectedRange.maxOffset ? ' disabled' : ''}>‹ 上一周</button>
        <strong>${selectedRange.recent ? '最新 · ' : ''}${dayLabel(selectedRange.start)}–${dayLabel(selectedRange.end)}</strong>
        <button class="btn small" data-coverage-week="newer"${STATE.coverageWeekOffset === 0 ? ' disabled' : ''}>下一周 ›</button>
        <button class="btn small" data-coverage-week="latest"${STATE.coverageWeekOffset === 0 ? ' disabled' : ''}>最新</button>
      </div>`;
    }

    const query = (STATE.filters.coverageQ || '').trim().toLowerCase();
    const renderLanguage = (key, label) => {
      const dataset = languages[key];
      if (!dataset) return sectionHead(label, '没有可用摘要') + `<div class="card">${empty('尚未读取到该语言的覆盖率 artifact')}</div>`;
      const current = dataset.current || {};
      const baseline = dataset.baseline;
      const totals = current.totals || baseline?.totals || {};
      const kind = current.kind === 'authoritative' ? '权威完整结果' : current.kind === 'incremental' ? '增量估算' : '部分结果';
      const tone = current.kind === 'authoritative' ? 'good' : 'warn';
      const metricTiles = [
        { label: `${label} 行覆盖率`, value: pct(totals.lines?.percentage), tone: 'good', sub: `${n(totals.lines?.covered)} / ${n(totals.lines?.total)}` },
        { label: `${label} 分支覆盖率`, value: pct(totals.branches?.percentage), sub: `${n(totals.branches?.covered)} / ${n(totals.branches?.total)}` },
      ];
      if (key === 'node') metricTiles.push({ label: `${label} 函数覆盖率`, value: pct(totals.functions?.percentage), sub: `${n(totals.functions?.covered)} / ${n(totals.functions?.total)}` });
      let body = sectionHead(label, dataset.scope || dataset.source);
      if (current.kind !== 'authoritative') {
        body += `<div class="banner warn"><span class="icon">≈</span><div><div class="title">${esc(label)} 当前不是独立完整基线</div><div>${baseline ? `以 ${date(baseline.created_at)} 的完整结果为基线，叠加 ${(current.increments || []).length} 次 main 增量。` : '当前只拿到部分模块摘要；整仓结果会在完整运行后校准。'}</div></div></div>`;
      }
      body += tiles(metricTiles);
      const history = (dataset.history || []).filter((row) => row.totals?.lines?.percentage != null);
      body += `<div class="grid wide" style="margin-top:12px">
        ${card(`${label} 每日完整行覆盖率`, history.length ? coverageTrend(history, selectedRange?.start) : empty('下一次完整运行后会形成趋势'), { sub: `默认展示最新数据窗口；历史按自然周查看。每天取北京时间最后一个完整覆盖率结果：Nightly 须 UT、ST、Coverage 成功（不受 real E2E 影响），${line.default ? 'main push' : `${esc(line.ref)} push / 手动`} 须 CI 成功；不混入 PR 结果` })}
        ${card(`${label} 数据身份`, kv([
          ['当前', `${badge(kind, tone)} ${esc(dataset.source)}`],
          ['完整基线', baseline ? `${date(baseline.created_at)} · <code>${esc((baseline.sha || '').slice(0, 12))}</code>` : '尚无'],
          ['main 增量', `${n(current.increments?.length || 0)} 次`],
          ['路径数', n(current.groups?.length || baseline?.groups?.length)],
        ]))}
      </div>`;
      // Without per-file totals the tree stops at the summary's groups (directories).
      const sources = current.sources || [], groups = (current.groups || baseline?.groups || []).map((group) => ({ path: group.name, totals: group.totals, files: group.files }));
      const byFile = sources.length > 0, entries = byFile ? sources : groups;
      // One source for the whole tree: the newest result any path took its numbers from.
      const latest = (current.groups || []).reduce((a, g) => ((g.updated_at || '') > (a?.updated_at || '') ? g : a), null);
      const source = latest ? `最新数据：${date(latest.updated_at)}（${ago(latest.updated_at)}）· 提交 <code>${esc((latest.source_sha || '').slice(0, 10))}</code>` : '';
      const reach = byFile ? `${n(sources.length)} 个文件，逐层展开到文件` : `${n(groups.length)} 个覆盖率分组；源仓摘要暂无逐文件数据，只能展开到分组目录`;
      body += sectionHead(`${label} 目录覆盖率`, [reach, source].filter(Boolean).join(' · '));
      const sortSwitch = `<div class="seg cov-sort" role="group" aria-label="排序"><span class="seg-label">排序</span>${[['name', '按名称'], ['lines', '行覆盖率从低到高']].map(([v, l]) => `<button type="button" class="${STATE.covSort === v ? 'on' : ''}" data-cov-sort="${v}" aria-pressed="${STATE.covSort === v}">${l}</button>`).join('')}</div>`;
      body += `<div class="card"><div class="cov-tools"><label class="filter"><span>过滤路径</span><input type="search" data-filter="coverageQ" value="${esc(STATE.filters.coverageQ || '')}" placeholder="packages/schema 或 services/evolve"></label>${entries.length ? `${sortSwitch}<span class="grow"></span><button class="btn small" data-cov-expand="${key}">全部展开</button><button class="btn small" data-cov-collapse="${key}">全部收起</button>` : ''}</div>
        ${entries.length ? coverageTree(key, entries, query, { groups: !byFile }) : empty('当前覆盖率摘要没有路径数据。')}</div>`;
      const prs = (dataset.pull_requests || []).map((row) => ({
        ...row,
        base_branch: row.base_branch || prTargetByNumber.get(Number(row.number)),
        lines_pct: row.totals?.lines?.percentage,
        group_names: (row.groups || []).map((group) => group.name).join(', '),
      }));
      body += sectionHead(`${label} 最近 PR 覆盖率`, `目标为 ${esc(line.ref)} 的 PR 的 UT/ST 门禁实测范围；不会更新该分支当前覆盖率`);
      body += `<div class="card">${table(`cov-prs-${key}`, [
        { key: 'number', label: 'PR', render: (row) => link(`${STATE.snap.repo_url}/pull/${row.number}`, `#${row.number}`) },
        { key: 'branch', label: '来源分支', render: (row) => `<code>${esc(row.branch || '—')}</code>` },
        { key: 'base_branch', label: '目标分支', render: (row) => `<code>${esc(row.base_branch || '—')}</code>` },
        { key: 'lines_pct', label: '门禁实测行覆盖率', num: true, render: (row) => pct(row.lines_pct) },
        { key: 'group_names', label: '覆盖路径', render: (row) => `<span class="mono">${esc(row.group_names)}</span>` },
        { key: 'created_at', label: '时间', render: (row) => ago(row.created_at) },
      ], prs, { limit: 10, emptyText: '还没有 PR 覆盖率摘要' })}</div>`;
      return body;
    };
    html += renderLanguage('node', 'Node.js');
    html += renderLanguage('python', 'Python');
    return html;
  }

  // ------------------------------------------------------------ shell
  const activeTab = () => {
    const requested = location.hash.slice(1);
    const known = [...document.querySelectorAll('#tabs [data-tab]')].some(tab => (!tab.hidden || (!STATE.snap && requested === 'production-metrics')) && tab.dataset.tab === requested);
    if (known) return requested;
    if (requested) history.replaceState(history.state, '', location.pathname + location.search + '#overview');
    return 'overview';
  };

  function renderShell() {
    const snap=STATE.snap, btn=$('#refresh-btn'), banner=$('#global-banner');
    const productionTab = document.querySelector('[data-tab="production-metrics"]');
    productionTab.hidden = !snap || String(snap.repo || '').toLowerCase() !== 'openjiuwen-ai/digitalmate';
    if (snap && productionTab.hidden && STATE.tab === 'production-metrics') { STATE.tab = 'overview'; history.replaceState(history.state, '', location.pathname + location.search + '#overview'); }
    const frame = document.querySelector('#tab-production-metrics iframe');
    if (!productionTab.hidden && STATE.tab === 'production-metrics' && frame.getAttribute('src') === 'about:blank') frame.src = './production-metrics/index.html#models';
    btn.disabled=!!STATE.status?.refreshing;
    btn.textContent=btn.disabled?'读取中…':'刷新视图';
    if(snap){
      $('#repo-link').textContent=snap.repo;$('#repo-link').href=snap.repo_url;
      const label=snap.deployment?.label;
      $('.brand-title').textContent=label ? label+' · GitHub 状态看板' : 'GitHub 状态看板';
      document.title=snap.repo+' · '+$('.brand-title').textContent;
      $('#meta').textContent=date(snap.generated_at);
      $('#meta').dateTime=snap.generated_at;
      $('#meta').title='按浏览器时区显示';
      $('#repo-link').title=snap.repo;
    }
    // A quiet collection keeps the snapshot's time, a new UTC day rebuilds it, and the bot collects at
    // least every eight hours: an older snapshot means collection has stopped.
    const stale=snap && Date.now()-new Date(snap.generated_at)>36*3600000;
    const message=STATE.clientError || [...(snap?.notices||[]).map(n=>n.message).filter(message=>message !== '部分补充信息不可读取，请以 GitHub 原页面为准。'), ...(stale?['快照超过 36 小时未更新，采集可能已停止；当前显示最后一次发布的数据。']:[])].join(' ');
    banner.className='banner '+(message?'warn':'hidden');banner.textContent=message;
    document.querySelectorAll('#tabs a').forEach(a=>{
      const active=a.dataset.tab===STATE.tab;a.classList.toggle('active',active);
      if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    });
  }

  function renderTabs() {
    const snap = STATE.snap;
    const render = (id, fn) => { const el = $(`#tab-${id}`); if (el) el.innerHTML = fn(); };
    if (!snap) {
      ['overview', 'issues', 'prs', 'ci', 'tests', 'coverage'].forEach((id) => render(id, () => `<div class="skeleton">${STATE.status?.refreshing ? '<span class="spinner"></span>采集中…' : '暂无数据'}</div>`));
      return;
    }
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${STATE.tab}`));
    // One tab's render bug must not blank the others: each tab is isolated and shows its own error.
    const safe = (id, fn) => { try { render(id, fn); } catch (err) { console.error(err); render(id, () => `<div class="banner error"><span class="icon">⛔</span><div><div class="title">该标签页渲染出错</div><div class="mono">${esc(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : String(err))}</div><div class="hint">其他标签页不受影响；请把这行反馈给维护者。</div></div></div>`); } };
    const keep = lanePositions();
    safe('overview', () => renderOverview(snap));
    safe('issues', () => renderIssues(snap.sections.issues));
    safe('prs', () => renderPRs(snap.sections.prs));
    const line = currentLine(snap);
    safe('ci', () => lineBar(snap) + renderCI(lineSection(snap, 'ci'), line));
    safe('tests', () => lineBar(snap) + renderTests(lineSection(snap, 'tests'), line));
    safe('coverage', () => lineBar(snap) + renderCoverage(lineSection(snap, 'tests'), line));
    pinLanes(keep);
    try { if (window.GSBBoard) window.GSBBoard.onSnapshot(snap); } catch (err) { console.error(err); }
    mountBoard();
    drawTrends();
    if (returnFocus.pending && STATE.tab === 'tests') {
      const target = [...document.querySelectorAll('#tab-tests [data-real-case]')]
        .find((item) => item.dataset.realCase === returnFocus.caseName);
      if (target) {
        returnFocus.pending = false;
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'center' });
          const url = new URL(location.href);
          url.searchParams.delete('returnLine');
          url.searchParams.delete('returnCase');
          history.replaceState(history.state, '', url);
        });
      }
    }
  }

  function renderAll() { renderShell(); renderTabs(); }

  // ------------------------------------------------------------ data flow
  // Every request has a hard timeout and every code path ends in schedulePoll(), so a hung
  // request, a proxy that drops a response, or a render exception can never freeze the page
  // in the "采集中" state: the worst case is a visible error banner plus a retry a few seconds later.
  const FETCH_TIMEOUT_MS = 20000;
  async function fetchJson(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function load() {
    try {
      const doc = await fetchJson('./data/snapshot.json?ts='+Date.now());
      if(!doc.sections || !doc.board)throw new Error('快照格式尚未更新，请稍后刷新');
      STATE.snap=doc;STATE.status={refreshing:false};
      if ((returnFocus.pending || returnFocus.e2ePending) && (doc.lines || []).some((line) => line.key === returnFocus.line)) STATE.line = returnFocus.line;
      window.GSBLocalBoard?.setSnapshot(doc);
      STATE.clientError = null;
      // Run records are optional: a missing index only hides that section.
      STATE.e2e = await fetchJson('./data/e2e/index.json?ts='+Date.now()).catch(() => null);
      // Optional nightly performance history; a missing file hides the section on other boards.
      STATE.performance = await fetchJson('./data/e2e-performance/history.json?ts='+Date.now()).catch(() => null);
      STATE.e2eErrors.clear();
    } catch (err) {
      STATE.clientError = err.name === 'AbortError'
        ? `读取静态快照超时（${FETCH_TIMEOUT_MS / 1000} 秒），已保留当前数据`
        : `无法读取快照：${err.message}，已保留当前数据`;
      STATE.status = { ...(STATE.status || {}), refreshing: false };
    }
    try {
      renderAll();
      await loadE2EHistory();
    } catch (err) {
      showRenderError(err);
    }
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(STATE.pollTimer);
    const st = STATE.status || {};
    // Quick retry after a client-side failure; 3s while a refresh runs; otherwise 60s to pick up auto refreshes.
    const delay = STATE.clientError ? 5000 : st.refreshing ? 3000 : 60000;
    STATE.pollTimer = setTimeout(load, delay);
  }
  async function refresh() {
    if(STATE.status?.refreshing)return;
    STATE.status={refreshing:true};renderShell();
    await load();
  }
  function showRenderError(err) {
    const banner = $('#global-banner');
    const where = err && err.stack ? esc(err.stack.split('\n').slice(0, 3).join(' | ')) : esc(String(err));
    banner.className = 'banner error';
    banner.innerHTML = `<span class="icon">⛔</span><div><div class="title">页面渲染出错：数据已经拿到，但前端脚本在渲染时抛出异常</div><div class="mono">${where}</div><div class="hint">请把上面这行反馈给维护者；轮询仍在继续，点击「刷新」可重试。</div></div>`;
    console.error(err);
  }
  // ------------------------------------------------------------ events
  $('#tab-tests').addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-e2e-filter]');
    if (!el) return;
    STATE.e2eFilter[el.dataset.e2eFilter] = el.value;
    renderE2EHistory();
  });
  document.addEventListener('click', (ev) => {
    const perfCase = ev.target.closest('[data-perf-case]');
    if (perfCase) {
      STATE.perfCase = perfCase.dataset.perfCase;
      const section = document.querySelector('[data-perf-section]');
      if (section) section.outerHTML = performanceSection();
      return;
    }
    const category = ev.target.closest('[data-e2e-category]');
    if (category) {
      const open = category.getAttribute('aria-expanded') !== 'true';
      const slice = category.dataset.e2eCategory;
      if (open) STATE.e2eCollapsed.delete(slice); else STATE.e2eCollapsed.add(slice);
      category.setAttribute('aria-expanded', String(open));
      document.getElementById(category.getAttribute('aria-controls')).hidden = !open;
      return;
    }
    const coverageWeekButton = ev.target.closest('[data-coverage-week]');
    if (coverageWeekButton && !coverageWeekButton.disabled) {
      const direction = coverageWeekButton.dataset.coverageWeek;
      if (direction === 'older') STATE.coverageWeekOffset += 1;
      if (direction === 'newer') STATE.coverageWeekOffset = Math.max(0, STATE.coverageWeekOffset - 1);
      if (direction === 'latest') STATE.coverageWeekOffset = 0;
      renderTabs();
      return;
    }
    const th = ev.target.closest('th.sortable[data-table]');
    if (th) {
      const id = th.dataset.table, key = th.dataset.key;
      const cur = STATE.sort[id];
      STATE.sort[id] = cur && cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' };
      renderTabs();
      return;
    }
    const view = ev.target.closest('[data-work-view] button');
    if (view) {
      const tab = view.closest('[data-work-view]').dataset.workView;
      STATE.views[tab] = view.dataset.val;
      try { localStorage.setItem(VIEW_KEY, JSON.stringify(STATE.views)); } catch (e) { /* private mode */ }
      renderTabs();
      return;
    }
    const age = ev.target.closest('[data-age-tab]');
    if (age) {
      const tab = age.dataset.ageTab, prev = STATE.ageFilter[tab];
      const next = 'ageClear' in age.dataset ? null : Number(age.dataset.ageFilter);
      const value = prev === next ? null : next;
      setAgeFilter(tab, value, value ?? prev);
      return;
    }
    const lineButton = ev.target.closest('[data-line]');
    if (lineButton) {
      STATE.line = lineButton.dataset.line;
      // Branch filters and coverage weeks belong to the line that was shown.
      STATE.filters.runBranch = '';
      STATE.coverageWeekOffset = 0;
      try { localStorage.setItem(LINE_KEY, STATE.line); } catch (e) { /* private mode */ }
      renderTabs();
      loadE2EHistory();
      return;
    }
    const covSort = ev.target.closest('[data-cov-sort]');
    if (covSort) {
      STATE.covSort = covSort.dataset.covSort;
      try { localStorage.setItem(COV_SORT_KEY, STATE.covSort); } catch (e) { /* private mode */ }
      renderTabs();
      return;
    }
    const tree = ev.target.closest('[data-cov-expand], [data-cov-collapse]');
    if (tree) {
      const language = tree.dataset.covExpand || tree.dataset.covCollapse, open = !!tree.dataset.covExpand;
      document.querySelectorAll(`.cov-tree[data-language="${language}"] .cov-dir`).forEach((dir) => { dir.open = open; });
      return;
    }
    const act = ev.target.closest('[data-action="refresh"]');
    if (act) { ev.preventDefault(); refresh(); }
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-filter]');
    if (!el) return;
    STATE.filters[el.dataset.filter] = el.value;
    const focusSel = `[data-filter="${el.dataset.filter}"]`;
    const pos = el.selectionStart;
    renderTabs();
    const again = document.querySelector(focusSel);
    if (again && again.tagName === 'INPUT') { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* select elements */ } }
  });
  $('#refresh-btn').addEventListener('click', refresh);
  // Browsers throttle timers in background tabs; re-sync as soon as the tab is visible again.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { clearTimeout(STATE.pollTimer); load(); } });
  window.addEventListener('message', (event) => {
    const frame = document.querySelector('#tab-production-metrics iframe');
    if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'production-metrics-height') return;
    const height = Number(event.data.height);
    if (Number.isFinite(height) && height >= 100 && height <= 20000) frame.style.height = `${Math.ceil(height)}px`;
  });

  window.addEventListener('hashchange', () => { STATE.tab = activeTab(); renderShell(); mountBoard(); document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${STATE.tab}`)); pinLanes(); drawTrends(); loadE2EHistory(); });
  // Tooltip layer: any element with data-tip.
  const tipEl = $('#tooltip');
  // Beside an element (for keyboard focus); a trend chart anchors it to its crosshair instead.
  function showTip(el) {
    if (!el.dataset.tip) return;
    tipEl.textContent = el.dataset.tip;
    tipEl.classList.remove('hidden');
    const cross = el.closest('svg')?.querySelector('.trend-cross.on'), box = (cross || el).getBoundingClientRect();
    tipEl.style.left = `${Math.max(8, Math.min(box.right + 8, window.innerWidth - tipEl.offsetWidth - 8))}px`;
    tipEl.style.top = `${Math.max(8, Math.min((cross ? box.top : box.bottom) + 6, window.innerHeight - tipEl.offsetHeight - 8))}px`;
  }
  document.addEventListener('mousemove', (ev) => {
    const el = ev.target.closest('[data-tip]');
    if (!el) { tipEl.classList.add('hidden'); return; }
    tipEl.textContent = el.dataset.tip;
    tipEl.classList.remove('hidden');
    const x = Math.min(ev.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8);
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
  });
  // Keyboard focus shows the same details beside the focused mark.
  document.addEventListener('focusin', (ev) => {
    const el = ev.target.closest?.('[data-tip]');
    if (el) showTip(el);
  });
  document.addEventListener('focusout', () => tipEl.classList.add('hidden'));
  document.addEventListener('scroll', (ev) => {
    const el = ev.target;
    if (el.classList?.contains('ci-lanes-scroll')) el.dataset.away = el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? '1' : '';
  }, true);
  let trendResize = null;
  window.addEventListener('resize', () => { pinLanes(); clearTimeout(trendResize); trendResize = setTimeout(drawTrends, 150); });
  // Trend controls: range presets, custom dates and series toggles redraw only that chart.
  document.addEventListener('click', (ev) => {
    const control = ev.target.closest('[data-trend-kind] button');
    if (!control) return;
    const kind = control.closest('[data-trend-kind]').dataset.trendKind, view = STATE.trend[kind];
    if (control.dataset.trendRange) { const range = control.dataset.trendRange; view.range = range === 'all' ? 'all' : Number(range); }
    if (control.dataset.trendSeries) { const key = control.dataset.trendSeries; if (view.hidden.has(key)) view.hidden.delete(key); else view.hidden.add(key); }
    drawTrend(kind);
    document.querySelector(`[data-trend-kind="${kind}"] [data-trend-${control.dataset.trendRange ? 'range' : 'series'}="${control.dataset.trendRange || control.dataset.trendSeries}"]`)?.focus();
  });
  document.addEventListener('change', (ev) => {
    const input = ev.target.closest('[data-trend-from], [data-trend-to]');
    if (!input || !input.value) return;
    const kind = input.closest('[data-trend-kind]').dataset.trendKind, box = input.closest('[data-trend-kind]');
    Object.assign(STATE.trend[kind], { range: 'custom', from: box.querySelector('[data-trend-from]').value, to: box.querySelector('[data-trend-to]').value });
    drawTrend(kind);
  });
  // SVG sectors are not native buttons: activate them with Enter / Space like the legend buttons.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const sector = ev.target.closest?.('.age-sector[data-age-tab]');
    if (!sector) return;
    ev.preventDefault();
    sector.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // Remember expanded coverage directories across the periodic refresh.
  document.addEventListener('toggle', (ev) => {
    const dir = ev.target;
    if (!dir.matches?.('.cov-dir')) return;
    if (dir.open) STATE.covOpen.add(dir.dataset.covPath); else STATE.covOpen.delete(dir.dataset.covPath);
  }, true);

  // Shared helpers for the board module (static/board.js).
  window.GSB = { esc, ago, days, date, n, badge, labelChips, link, codeify, conclusionBadge, tip, empty, kv, CONCLUSION_NAME, refresh, snapshot:()=>STATE.snap, ageBucketOf, AGE_BUCKETS, ageFilter:()=>STATE.ageFilter, setAgeFilter };
  STATE.tab = activeTab();
  load();
})();
