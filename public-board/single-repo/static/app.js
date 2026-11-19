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
  const CONCLUSION_TONE = { success: 'good', failure: 'bad', timed_out: 'bad', cancelled: '', skipped: '', in_progress: 'warn', queued: 'warn', pending: 'warn', neutral: '', action_required: 'warn', startup_failure: 'bad', error: 'bad', expected: 'warn' };
  const CONCLUSION_NAME = { success: '成功', failure: '失败', timed_out: '超时', cancelled: '取消', skipped: '跳过', in_progress: '运行中', queued: '排队', pending: '等待', neutral: '中性', action_required: '需处理', startup_failure: '启动失败', error: '错误', expected: '等待' };

  const VIEW_KEY = 'gsb.list.view', LINE_KEY = 'gsb.line';
  const loadViews = () => { try { return { issues: 'table', prs: 'table', ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch (e) { return { issues: 'table', prs: 'table' }; } };
  const loadLine = () => { try { return localStorage.getItem(LINE_KEY); } catch (e) { return null; } };
  const STATE = { snap: null, status: null, tab: 'overview', views: loadViews(), line: loadLine(), sort: {}, filters: { issueQ: '', issueLabel: '', issueAssignee: '', runBranch: '' }, ageFilter: { issues: null, prs: null }, pollTimer: null };

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
  const dayLabel = (day) => {
    const d = dayDate(day);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  // The Issue / PR list in board form renders through board.js into the page's mount point.
  const mountBoard = () => {
    const scope = { issues: 'issue', prs: 'pr' }[STATE.tab];
    if (scope && STATE.views[STATE.tab] === 'board') { try { window.GSBBoard?.mount(scope); } catch (err) { console.error(err); } }
  };
  // Branch lines: CI shows one long-lived branch at a time. PR runs
  // belong to the branch they target; sections hold the default line.
  const currentLine = (snap) => { const lines = snap?.lines || []; return lines.find((l) => l.key === STATE.line) || lines[0] || { key: '', ref: snap?.repository?.default_branch, default: true }; };
  const lineSection = (snap, name) => { const line = currentLine(snap); return line.default ? snap.sections[name] : snap.line_sections?.[line.key]?.[name]; };
  const lineBar = (snap) => {
    const lines = snap.lines || [], line = currentLine(snap);
    if (lines.length < 2) return '';
    return `<div class="line-bar"><div class="seg line-switch" role="group" aria-label="分支线"><span class="seg-label">分支线</span>${lines.map((l) => `<button type="button" class="${l.key === line.key ? 'on' : ''}" data-line="${esc(l.key)}" aria-pressed="${l.key === line.key}">${esc(l.ref)}</button>`).join('')}</div>`
      + `<span class="muted">当前 <code>${esc(line.ref)}</code>：按运行分支及 PR 目标分支归类；各分支线的数据互不混合。</span></div>`;
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
  function renderOverview(snap) {
    const S = snap.sections;
    const iss = S.issues?.data, prs = S.prs?.data, ci = S.ci?.data, ops = S.ops?.data;
    const releases = snap.releases || [], runs = snap.quality?.runs || [], runsById = new Map(runs.map((r) => [r.id, r]));
    const validation = (release) => (release.validation_run_ids || []).map((id) => runsById.get(id)).filter(Boolean)[0] || null;
    const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity);

    // Problems first, most severe first: what a maintainer has to act on today.
    const items = [];
    const main = ci?.latest_main?.run, scheduled = runs.find((r) => r.event === 'schedule');
    const runLink = (r) => (r ? ` ${link(r.url, '查看运行')}` : '');
    // Unreadable data is unknown, never healthy.
    [[ci, 'CI', '#ci'], [prs, 'PR', '#prs'], [iss, 'Issue', '#issues']].forEach(([value, name, href]) => { if (!value) items.push(['warn', `${name} 数据暂不可读取，状态未知`, href]); });
    if (ci?.red_streak_main) items.push(['critical', `默认分支 CI 连续失败 ${ci.red_streak_main} 次；失败 job：${esc((ci.latest_main?.jobs || []).filter((j) => j.conclusion === 'failure').map((j) => j.name).join('、') || '—')}`, '#ci']);
    else if (main?.conclusion === 'failure') items.push(['critical', `默认分支最近一次 CI 失败（${date(main.created_at)}）${runLink(main)}`, '#ci']);
    if (scheduled?.conclusion === 'failure') items.push(['critical', `定时运行 ${esc(scheduled.name)} 最近一次失败（${date(scheduled.created_at)}）${runLink(scheduled)}`, '#ci']);
    else if (scheduled && hoursSince(scheduled.created_at) > 36) items.push(['warn', `定时运行 ${esc(scheduled.name)} 已 ${Math.floor(hoursSince(scheduled.created_at))} 小时没有运行`, '#ci']);
    const releaseURL = `${snap.repo_url}/releases`, latestRelease = releases[0], releaseRun = latestRelease && validation(latestRelease);
    if (latestRelease && !releaseRun) items.push(['warn', `版本 ${esc(latestRelease.tag)} 没有找到提交一致的版本验证运行`, latestRelease.url || releaseURL]);
    else if (releaseRun && releaseRun.status === 'completed' && releaseRun.conclusion !== 'success') items.push(['critical', `版本 ${esc(latestRelease.tag)} 的验证运行${esc(CONCLUSION_NAME[releaseRun.conclusion] || releaseRun.conclusion)}${runLink(releaseRun)}`, releaseRun.url || latestRelease.url || releaseURL]);
    if (prs?.ci_states?.failure) items.push(['warn', `${prs.ci_states.failure} 个开放 PR 的检查失败：${prs.items.filter((p) => p.ci?.state === 'failure').map((p) => link(p.url, `#${p.number}`)).join(' ')}`, '#prs']);
    if (prs?.waiting_review_count) items.push(['warn', `${prs.waiting_review_count} 个 PR 超过 ${prs.review_sla_days} 天无人评审：${prs.items.filter((p) => p.waiting_review).map((p) => link(p.url, `#${p.number}`)).join(' ')}`, '#prs']);
    if (prs?.items?.some((p) => p.mergeable === 'CONFLICTING')) items.push(['warn', `存在冲突的 PR：${prs.items.filter((p) => p.mergeable === 'CONFLICTING').map((p) => link(p.url, `#${p.number}`)).join(' ')}`, '#prs']);
    (snap.lines || []).slice(1).forEach((l) => {
      const last = snap.line_sections?.[l.key]?.ci?.data?.latest_main?.run;
      if (last?.conclusion === 'failure') items.push(['warn', `<code>${esc(l.ref)}</code> 分支最近一次运行失败（${date(last.created_at)}）${runLink(last)}`, '#ci']);
    });
    const hints = [];
    if (iss?.no_response_count) hints.push(['info', `${iss.no_response_count} 个开放 Issue 还没有评论，${iss.unassigned_count} 个无人认领`, '#issues']);
    if (iss?.stale_count) hints.push(['info', `${iss.stale_count} 个 Issue 超过 ${iss.stale_days_threshold} 天没有更新`, '#issues']);
    if (ops?.releases?.unreleased?.commits > 50) hints.push(['info', `自 ${esc(ops.releases.latest?.tag)} 以来已有 ${n(ops.releases.unreleased.commits)} 个提交未发布`, releaseURL]);
    if (ops?.branches?.protection && !ops.branches.protection.enabled) hints.push(['info', `默认分支 ${esc(ops.branches.default)} 未启用分支保护`, `${snap.repo_url}/branches`]);
    const line = ([sev, text, href]) => `<li><span class="sev ${sev}"></span><span>${text} ${href.startsWith("https://") ? link(href, "详情") : `<a href="${esc(href)}">详情</a>`}</span></li>`;
    const serious = items.filter(([sev]) => sev === 'critical').length;
    let html = `<div class="card health ${serious ? 'health-bad' : items.length ? 'health-warn' : 'health-good'}"><h3>${serious ? `${serious} 个流水线问题需要处理` : items.length ? `${items.length} 项需要关注` : '流水线与交付状态正常'}<span class="sub">数据截至 ${date(snap.generated_at)}（${ago(snap.generated_at)}）</span></h3>
      ${items.length ? `<ul class="attention">${items.map(line).join('')}</ul>` : '<div class="muted">默认分支、定时运行和最新版本都没有失败；开放 PR 没有失败检查或超期评审。</div>'}
      ${hints.length ? `<details class="hints"><summary>其他提示（${hints.length}）</summary><ul class="attention">${hints.map(line).join('')}</ul></details>` : ''}</div>`;

    // Workflows: the latest run of the busiest ones and their recent success rate.
    const workflows = (ci?.workflows || []).filter((w) => w.all?.total).slice().sort((a, b) => b.all.total - a.all.total).slice(0, 4);
    const rateTone = (r) => (r == null ? '' : r >= 80 ? 'good' : r >= 50 ? 'warn' : 'bad');
    html += sectionHead('流水线', workflows.length ? `运行最多的 workflow：最近一次运行的结论，以及最近 ${n(ci.runs_sampled)} 次运行中的成功率 = 成功 ÷（成功 + 失败）${(snap.lines || []).length > 1 ? `；此处为 ${esc(snap.lines[0].ref)} 分支线，其他分支线在 CI 页切换` : ''}` : '');
    html += workflows.length ? tiles(workflows.map((w) => {
      const last = w.last_run, state = last ? last.conclusion || last.status : null;
      return { label: w.name, value: last ? esc(CONCLUSION_NAME[state] || state) : '暂无运行', tone: CONCLUSION_TONE[state] ?? '', href: '#ci',
        sub: `${last ? `${ago(last.created_at)} · <code>${esc(last.branch)}</code><br>` : ''}成功率 ${pct(w.all.success_rate)}（${n(w.all.total)} 次）${w.all.median_duration_s != null ? ` · 中位耗时 ${dur(w.all.median_duration_s)}` : ''}` };
    })) : `<div class="card">${empty('近期没有 workflow 运行')}</div>`;

    // Delivery at a glance.
    // The published release list is canonical; the ops block adds the unreleased commit count.
    const rel = releases[0] ? { tag: releases[0].tag, age_days: (Date.now() - new Date(releases[0].published_at).getTime()) / 86400000 } : ops?.releases?.latest;
    html += sectionHead('交付', '');
    html += tiles([
      { label: '开放 PR', value: n(prs?.open_count), href: '#prs', tone: prs?.ci_states?.failure || prs?.waiting_review_count ? 'warn' : '', sub: prs ? `待评审超期 ${n(prs.waiting_review_count)} · 检查失败 ${n(prs.ci_states.failure || 0)} · 30 天合并 ${n(prs.merged_30d)}` : '—' },
      { label: '开放 Issue', value: n(iss?.open_count), href: '#issues', sub: iss ? `7 天 +${n(iss.counts.opened_7d)} / −${n(iss.counts.closed_7d)} · 陈旧 ${n(iss.stale_count)}` : '—' },
      { label: '最新版本', value: rel ? esc(rel.tag) : '—', href: latestRelease?.url || releaseURL, sub: rel ? `${days(rel.age_days)}前${ops?.releases?.unreleased ? ` · 之后 ${n(ops.releases.unreleased.commits)} 个提交未发布` : ''}` : '尚无 release' },
    ]);

    const releaseRows = releases.slice(0, 3).map((release) => {
      const run = validation(release);
      return `<li>${link(release.url, esc(release.tag))} <span class="muted">${ago(release.published_at)}</span> ${run ? `${conclusionBadge(run.status === 'completed' ? run.conclusion : run.status)} ${link(run.url, '验证运行')}` : badge('无验证运行', 'warn')}</li>`;
    }).join('');
    const merged = (prs?.recent_merged || []).slice(0, 5).map((p) => `<li>${badge('合并', 'good')} ${link(p.url, `#${p.number} ${esc(p.title)}`)} <span class="muted">${ago(p.merged_at)}</span></li>`);
    const opened = (iss?.items || []).slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 5).map((i) => `<li>${badge('新建', 'info')} ${link(i.url, `#${i.number} ${esc(i.title)}`)} <span class="muted">${ago(i.created_at)}</span></li>`);
    html += `<div class="grid wide" style="margin-top:12px">
      ${card('版本', releaseRows ? `<ul class="checks">${releaseRows}</ul>` : empty('仓库尚无 release'), { sub: `版本提交的验证运行结论；${link(releaseURL, '在 GitHub 查看全部版本 ↗')}` })}
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

  const LANE_OUTCOMES = { success: '成功', failure: '失败 / 超时', cancelled: '取消 / 跳过', running: '运行中', other: '其他' };
  function compactDuration(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
  }

  function laneMark(run, day, zone) {
    const state = run.conclusion || run.status;
    let outcome = 'other';
    if (run.status && run.status !== 'completed') outcome = 'running';
    else if (state === 'success') outcome = 'success';
    else if (['cancelled', 'skipped'].includes(state)) outcome = 'cancelled';
    else if (['failure', 'timed_out', 'startup_failure'].includes(state)) outcome = 'failure';
    const seconds = run.duration_s;
    const detail = [`${run.name || '未知 workflow'} · ${run.event || '未知事件'}`,
      `${CONCLUSION_NAME[state] || state || '未知'} · 耗时 ${dur(seconds)} · 第 ${run.attempt} 次尝试`,
      `分支 ${run.branch || '—'} · ${run.sha || '—'}`, `${day} ${run.time}（${zone}）`].join('\n');
    return link(run.url, esc(compactDuration(seconds)), ` class="ci-run ${outcome}" aria-label="${esc(detail)}"${tip(detail)}`);
  }

  function runCalendar(lanes) {
    const { rows, days, zone } = lanes;
    const axis = days.map(day => `<th scope="col"><time datetime="${esc(day.date)}">${dayLabel(day.date)}</time></th>`).join('');
    const body = rows.map(row => {
      const cells = row.days.map((runs, i) => {
        const day = days[i];
        if (!day.collected) return `<td class="uncollected" aria-label="未采集"${tip(day.date + ' 未采集')}></td>`;
        return `<td><div class="ci-stack">${runs.map(run => laneMark(run, day.date, zone)).join('')}</div></td>`;
      }).join('');
      return `<tr><th scope="row">${esc(row.label)}</th>${cells}</tr>`;
    }).join('');
    const legend = Object.entries(LANE_OUTCOMES).map(([key, name]) => `<span><i class="ci-run ${key}"></i>${name}</span>`).join('')
      + (days.some(day => !day.collected) ? '<span><i class="uncollected"></i>未采集</span>' : '');
    return sectionHead('近 30 天运行记录') + `<div class="card ci-calendar"><p>按 ${esc(zone)} 创建日期排列，同一天从上到下由早到晚。每块显示最后一次尝试的耗时与状态。</p>
      <div class="ci-lanes-scroll"><table dir="ltr" aria-label="近 30 天运行记录"><thead><tr><th scope="col">触发通道</th>${axis}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="legend">${legend}</div></div>`;
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
    if (d.lanes) html += runCalendar(d.lanes);
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
      { key: 'p90', label: 'P90 耗时', num: true, render: (w) => dur(w.all.p90_duration_s), sort: (w) => w.all.p90_duration_s },
      { key: 'jobs', label: '失败最多的 job', render: (w) => (w.top_failed_jobs?.length ? w.top_failed_jobs.map((j) => `${esc(j.name)} ×${n(j.count)}`).join('，') : '<span class="muted">—</span>'), sortable: false },
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
    const recent = d.recent_runs;
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

  // ------------------------------------------------------------ scheduled runs (#938)
  // Each scheduled workflow's runs (on schedule or by hand) and what each one reported about itself (see
  // gsb/results.py): one picked metric as a single series over the runs, with the runs below as the table view.
  // Only raw values are shown; nothing is scored.
  const SCHED_SOURCE = { check_run: '检查输出中的表格', artifact: 'JUnit / JSON 产物', jobs: '仅 job 结论与耗时' };
  STATE.schedMetric = {};
  const schedOptions = (w) => [
    ...w.metrics.map((m) => ({ key: `m:${m.name}`, label: m.name, unit: m.unit, value: (run) => run.metrics[m.name] })),
    { key: 'duration', label: '运行耗时', unit: 's', value: (run) => run.duration_s },
    ...[...new Set(w.runs.flatMap((run) => run.jobs.map((job) => job.name)))].map((name) => ({ key: `job:${name}`, label: `${name} 耗时`, unit: 's',
      value: (run) => run.jobs.find((job) => job.name === name)?.duration_s })),
  ];
  const schedOption = (w) => { const options = schedOptions(w); return options.find((o) => o.key === STATE.schedMetric[w.workflow_id]) || options[0]; };
  const schedValue = (value, unit) => (value == null ? '—' : unit === 's' ? dur(value) : unit === '%' ? `${n(value)}%` : `${n(value)}${unit && unit !== 'count' ? ` ${unit}` : ''}`);
  const schedWorkflows = () => lineSection(STATE.snap, 'scheduled')?.data?.workflows || [];

  function renderScheduled(sec) {
    const workflows = sec?.data?.workflows || [];
    if (!workflows.length) return '';
    let html = sectionHead('定时运行', '定时触发和手动触发的运行各自报告的结果：原始指标及其变化，不打分');
    html += workflows.map((w) => {
      const option = schedOption(w), latest = w.runs[w.runs.length - 1];
      const sources = [...new Set(w.runs.map((run) => run.source).filter(Boolean))].map((source) => SCHED_SOURCE[source] || source);
      const select = `<label class="sched-pick">指标 <select data-sched-metric="${esc(w.workflow_id)}">${schedOptions(w).map((o) => `<option value="${esc(o.key)}"${o.key === option.key ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      const rows = w.runs.slice(-10).reverse().map((run) => `<tr><td>${link(run.url, esc(date(run.created_at)))}${run.event === 'workflow_dispatch' ? ' <span class="muted">手动</span>' : ''}</td><td>${conclusionBadge(run.conclusion)}</td>`
        + `<td class="num">${esc(schedValue(option.value(run), option.unit))}</td><td class="num">${dur(run.duration_s)}</td><td>${esc(SCHED_SOURCE[run.source] || '尚未读取')}</td></tr>`).join('');
      const body = `<div class="sched-head">${select}<span class="muted small">结果来源：${esc(sources.join('、') || '尚未读取')}</span></div>`
        + `<figure class="sched-chart" data-sched-chart="${esc(w.workflow_id)}"></figure>`
        + `<div class="table-wrap"><table><thead><tr><th>运行</th><th>结论</th><th class="num">${esc(option.label)}</th><th class="num">运行耗时</th><th>结果来源</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      return `<div class="grid one" style="margin-top:12px">${card(w.name, body, { sub: `最近 ${n(w.runs.length)} 次运行 · 最新一次 ${latest ? ago(latest.created_at) : '—'}` })}</div>`;
    }).join('');
    return html;
  }

  // Drawn after the tab is in the page, at its real width. The x axis is the run sequence (dates label it); the
  // marker shape carries the outcome: filled for a successful run, a ring for any other conclusion.
  function drawScheduled() {
    const workflows = schedWorkflows();
    document.querySelectorAll('[data-sched-chart]').forEach((box) => {
      const w = workflows.find((item) => String(item.workflow_id) === box.dataset.schedChart);
      if (!w || !box.clientWidth) return;
      const option = schedOption(w), points = w.runs.map((run) => ({ run, value: option.value(run) })).filter((p) => typeof p.value === 'number');
      if (!points.length) { box.innerHTML = empty('这些运行里还没有所选指标的数值'); return; }
      const width = box.clientWidth, height = 200, left = 56, right = 16, top = 12, bottom = 26, count = points.length;
      // A change over time: the axis fits the values (about four steps), so small moves stay visible; the caption
      // says when it does not start at zero.
      const values = points.map((p) => p.value), vmin = Math.min(...values), vmax = Math.max(...values);
      const raw = (vmax - vmin || Math.abs(vmax) * 0.1 || 1) / 4, power = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((unit) => unit * power).find((size) => raw <= size);
      let lo = Math.floor(vmin / step) * step, hi = Math.ceil(vmax / step) * step;
      if (lo === hi) { lo -= step; hi += step; }
      if (vmin >= 0 && lo < 0) lo = 0;
      const xAt = (index) => (count > 1 ? left + index * (width - left - right) / (count - 1) : (left + width - right) / 2);
      const yAt = (value) => top + (1 - (value - lo) / (hi - lo)) * (height - top - bottom);
      const tick = (value) => (option.unit === 's' ? dur(value) : n(value));
      const grid = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step).map((value) => `<line class="trend-grid" x1="${left}" x2="${width - right}" y1="${yAt(value).toFixed(1)}" y2="${yAt(value).toFixed(1)}"></line><text class="trend-tick" x="${left - 6}" y="${(yAt(value) + 4).toFixed(1)}" text-anchor="end">${esc(tick(value))}</text>`).join('');
      const every = Math.max(1, Math.ceil(count * 64 / Math.max(1, width - left - right))), labels = [];
      for (let i = count - 1; i >= 0; i -= every) labels.push(`<text class="trend-tick" x="${xAt(i).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(shortDate(points[i].run.created_at))}</text>`);
      const line = count > 1 ? `<polyline class="trend-line" style="--c: var(--s1)" points="${points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ')}"></polyline>` : '';
      const marks = points.map((p, i) => {
        const ok = p.run.conclusion === 'success', x = xAt(i).toFixed(1), y = yAt(p.value).toFixed(1);
        const text = `${date(p.run.created_at)} · ${CONCLUSION_NAME[p.run.conclusion] || p.run.conclusion || '未知'}${p.run.sha ? ` · ${p.run.sha}` : ''}\n${option.label}：${schedValue(p.value, option.unit)}`;
        return `<circle class="${ok ? 'trend-dot' : 'sched-miss'}" style="--c: var(--s1)" cx="${x}" cy="${y}" r="4"></circle><circle class="sched-hit" cx="${x}" cy="${y}" r="12" tabindex="0"${tip(text)}></circle>`;
      }).join('');
      box.innerHTML = `<svg class="trend-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`${w.name}：${option.label}，最近 ${count} 次运行`)}">${grid}${labels.join('')}${line}${marks}</svg>`
        + `<figcaption class="muted small">每个点是一次运行，按运行先后排列；实心点为成功，空心圈为失败、取消或其他结论。${lo > 0 ? `纵轴从 ${esc(tick(lo))} 开始。` : ''}悬停或聚焦查看数值。</figcaption>`;
    });
  }

  // ------------------------------------------------------------ shell
  const activeTab = () => {
    const requested = location.hash.slice(1);
    const known = [...document.querySelectorAll('#tabs [data-tab]')].some(tab => tab.dataset.tab === requested);
    if (known) return requested;
    if (requested) history.replaceState(history.state, '', location.pathname + location.search + '#overview');
    return 'overview';
  };

  function renderShell() {
    const snap=STATE.snap, btn=$('#refresh-btn'), banner=$('#global-banner');
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

  // The scrollport starts at its right edge (the newest day). A redraw replaces
  // the table, so retain the reader's offset even while the CI tab is hidden.
  let calendarOffset = 0;
  function restoreCalendarOffset() {
    const calendar = $('.ci-lanes-scroll');
    if (calendar?.clientWidth) calendar.scrollLeft = calendarOffset;
  }
  document.addEventListener('scroll', ({ target }) => {
    if (target.classList?.contains('ci-lanes-scroll') && target.clientWidth) calendarOffset = target.scrollLeft;
  }, true);

  function renderTabs() {
    const snap = STATE.snap;
    const render = (id, fn) => { const el = $(`#tab-${id}`); if (el) el.innerHTML = fn(); };
    if (!snap) {
      ['overview', 'issues', 'prs', 'ci'].forEach((id) => render(id, () => `<div class="skeleton">${STATE.status?.refreshing ? '<span class="spinner"></span>采集中…' : '暂无数据'}</div>`));
      return;
    }
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${STATE.tab}`));
    // One tab's render bug must not blank the others: each tab is isolated and shows its own error.
    const safe = (id, fn) => { try { render(id, fn); } catch (err) { console.error(err); render(id, () => `<div class="banner error"><span class="icon">⛔</span><div><div class="title">该标签页渲染出错</div><div class="mono">${esc(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : String(err))}</div><div class="hint">其他标签页不受影响；请把这行反馈给维护者。</div></div></div>`); } };
    safe('overview', () => renderOverview(snap));
    safe('issues', () => renderIssues(snap.sections.issues));
    safe('prs', () => renderPRs(snap.sections.prs));
    const line = currentLine(snap);
    safe('ci', () => lineBar(snap) + renderCI(lineSection(snap, 'ci'), line) + renderScheduled(lineSection(snap, 'scheduled')));
    restoreCalendarOffset();
    try { if (window.GSBBoard) window.GSBBoard.onSnapshot(snap); } catch (err) { console.error(err); }
    mountBoard();
    drawTrends();
    drawScheduled();
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
      window.GSBLocalBoard?.setSnapshot(doc);
      STATE.clientError = null;
    } catch (err) {
      STATE.clientError = err.name === 'AbortError'
        ? `读取静态快照超时（${FETCH_TIMEOUT_MS / 1000} 秒），已保留当前数据`
        : `无法读取快照：${err.message}，已保留当前数据`;
      STATE.status = { ...(STATE.status || {}), refreshing: false };
    }
    try {
      renderAll();
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
  document.addEventListener('click', (ev) => {
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
      // Branch filters belong to the line that was shown.
      STATE.filters.runBranch = '';
      try { localStorage.setItem(LINE_KEY, STATE.line); } catch (e) { /* private mode */ }
      renderTabs();
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

  window.addEventListener('hashchange', () => { STATE.tab = activeTab(); renderShell(); mountBoard(); document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${STATE.tab}`)); restoreCalendarOffset(); drawTrends(); drawScheduled(); });
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
  let trendResize = null;
  window.addEventListener('resize', () => { clearTimeout(trendResize); trendResize = setTimeout(() => { drawTrends(); drawScheduled(); }, 150); });
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
  // The scheduled-run metric: the table column follows, so the whole CI tab is drawn again.
  document.addEventListener('change', (ev) => {
    const pick = ev.target.closest('[data-sched-metric]');
    if (!pick) return;
    STATE.schedMetric[pick.dataset.schedMetric] = pick.value;
    renderTabs();
    document.querySelector(`[data-sched-metric="${pick.dataset.schedMetric}"]`)?.focus();
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
  // Shared helpers for the board module (static/board.js).
  window.GSB = { esc, ago, days, date, n, badge, labelChips, link, codeify, conclusionBadge, tip, empty, kv, CONCLUSION_NAME, refresh, snapshot:()=>STATE.snap, ageBucketOf, AGE_BUCKETS, ageFilter:()=>STATE.ageFilter, setAgeFilter };
  STATE.tab = activeTab();
  load();
})();
