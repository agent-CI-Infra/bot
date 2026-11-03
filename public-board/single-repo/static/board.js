/* Issue / PR 页的看板视图：GitHub Projects 风格的本地项目板。
 * 数据 = 快照里的 Issue/PR + 本地字段（状态/优先级/迭代/备注），由静态快照和浏览器字段装配；
 * 每个页面只显示自己的类型，筛选偏好按类型分别保存。
 * 拖拽、字段编辑、列设置都只写当前浏览器存储，不写回 GitHub。 */
(() => {
  'use strict';
  const H = window.GSB;
  const { esc, ago, days, date, n, badge, labelChips, link, codeify, conclusionBadge, tip, empty } = H;
  const $ = (sel, root = document) => root.querySelector(sel);
  const MARKER = 'github-status-board';
  const LS_KEY = 'gsb.board.prefs';
  const NONE = '__none__';
  const GROUPS = { status: '状态', priority: '优先级', iteration: '迭代', assignee: '负责人', label: '标签', milestone: '里程碑', author: '作者' };
  const SCOPES = { issue: { tab: 'issues', name: 'Issue' }, pr: { tab: 'prs', name: 'PR' } };
  const DRAGGABLE = new Set(['status', 'priority', 'iteration']);
  const PRIORITY_TONE = { P0: 'bad', P1: 'serious', P2: 'warn', P3: '' };
  const REVIEW = { APPROVED: ['已批准', 'good'], CHANGES_REQUESTED: ['需修改', 'bad'], REVIEW_REQUIRED: ['待评审', 'warn'], NONE: ['无评审', ''] };
  const COLOR_VAR = (c) => (c && /^s[1-8]$/.test(c) ? `var(--${c})` : c === 'critical' ? 'var(--critical)' : c === 'serious' ? 'var(--serious)' : c === 'warning' ? 'var(--warning)' : 'var(--muted)');

  const B = { data: null, error: null, loading: false, snapshotAt: null, scope: 'issue', prefsBy: { issue: loadPrefs('issue'), pr: loadPrefs('pr') }, drag: null, drawer: null, details: {}, historyOpen: false, scroll: new Map() };
  // The page that mounted the board owns the filters and grouping in use.
  Object.defineProperty(B, 'prefs', { get: () => B.prefsBy[B.scope] });

  function loadPrefs(scope) {
    const base = { group: 'status', equal: true, filters: { q: '', state: '', label: '', assignee: '', author: '', priority: '', iteration: '', milestone: '' } };
    try {
      const saved = JSON.parse(localStorage.getItem(`${LS_KEY}.${scope}`) || '{}');
      return { ...base, ...saved, group: GROUPS[saved.group] ? saved.group : base.group, filters: { ...base.filters, ...(saved.filters || {}) } };
    } catch (e) { return base; }
  }
  const savePrefs = () => { try { localStorage.setItem(`${LS_KEY}.${B.scope}`, JSON.stringify(B.prefs)); } catch (e) { /* private mode */ } };

  // ------------------------------------------------------------ data access
  async function fetchJson(url, opts={}) { return window.GSBLocalBoard.request(url, opts); }
  async function post(url, body) {
    const doc = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': MARKER }, body: JSON.stringify(body) });
    if (doc.board) { B.data = doc.board; B.error = null; render(); if (B.drawer) renderDrawer(); }
    return doc;
  }
  async function load() {
    B.loading = true; render();
    try { B.data = await fetchJson('/api/board'); B.error = null; } catch (err) { B.error = err.name === 'AbortError' ? '读取 /api/board 超时' : err.message; }
    B.loading = false; render(); if (B.drawer) renderDrawer();
  }
  function onSnapshot(snap) {
    if (!snap) return;
    if (snap.generated_at !== B.snapshotAt) { B.snapshotAt = snap.generated_at; B.details = {}; load(); } else render();
  }
  async function mutate(fn) {
    try { await fn(); flash(''); } catch (err) { flash(`操作失败：${err.message}`); }
  }
  function flash(msg) {
    const el = $('#board-flash');
    if (!el) return;
    el.textContent = msg; el.classList.toggle('hidden', !msg);
  }

  // ------------------------------------------------------------ filtering / grouping
  function byId() { const m = {}; (B.data?.items || []).forEach((i) => { m[i.id] = i; }); return m; }
  function filtered() {
    const f = B.prefs.filters, q = (f.q || '').trim().toLowerCase();
    // The open-age pie on the owning page filters these cards too (Issue and PR stay apart).
    const ageSel = H.ageFilter ? H.ageFilter()[B.scope === 'issue' ? 'issues' : 'prs'] : null;
    return (B.data?.items || []).filter((i) => {
      if (i.kind !== B.scope) return false;
      if (ageSel != null && H.ageBucketOf(i.age_days) !== ageSel) return false;
      if (f.state === 'open' && i.state !== 'open') return false;
      if (f.state === 'closed' && i.state !== 'closed') return false;
      if (f.label && !i.labels.some((l) => l.name === f.label)) return false;
      if (f.assignee === NONE ? i.assignees.length : f.assignee && !i.assignees.includes(f.assignee)) return false;
      if (f.author && i.author !== f.author) return false;
      if (f.priority === NONE ? i.priority : f.priority && i.priority !== f.priority) return false;
      if (f.iteration === NONE ? i.iteration : f.iteration && i.iteration !== f.iteration) return false;
      if (f.milestone === NONE ? i.milestone : f.milestone && i.milestone !== f.milestone) return false;
      if (q && !`#${i.number} ${i.title} ${i.author} ${(i.note || '')}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function groupKeys(item, group) {
    switch (group) {
      case 'status': return [item.status || NONE];
      case 'priority': return [item.priority || NONE];
      case 'iteration': return [item.iteration || NONE];
      case 'assignee': return item.assignees.length ? item.assignees : [NONE];
      case 'label': return item.labels.length ? item.labels.map((l) => l.name) : [NONE];
      case 'milestone': return [item.milestone || NONE];
      case 'author': return [item.author || NONE];
      default: return [NONE];
    }
  }
  function columns(items) {
    const d = B.data, group = B.prefs.group;
    const buckets = new Map();
    const put = (key, item) => { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(item); };
    items.forEach((i) => groupKeys(i, group).forEach((k) => put(k, i)));
    let keys = [];
    const noneLabel = { status: '未分类', priority: '未设置', iteration: '未设置', assignee: '未指派', label: '无标签', milestone: '无里程碑', author: '未知' }[group];
    if (group === 'status') keys = d.fields.status.options.map((o) => o.name);
    else if (group === 'priority') keys = d.fields.priority.options.map((o) => o.name);
    else if (group === 'iteration') keys = d.facets.iterations;
    else keys = [...buckets.keys()].filter((k) => k !== NONE).sort((a, b) => (buckets.get(b).length - buckets.get(a).length) || a.localeCompare(b));
    if (!keys.includes(NONE) && buckets.has(NONE)) keys = group === 'status' ? [NONE, ...keys] : [...keys, NONE];
    const optByName = Object.fromEntries((d.fields.status.options || []).map((o) => [o.name, o]));
    const prByName = Object.fromEntries((d.fields.priority.options || []).map((o) => [o.name, o]));
    return keys.map((k) => {
      const cards = buckets.get(k) || [];
      const opt = group === 'status' ? optByName[k] : group === 'priority' ? prByName[k] : null;
      const openCount = cards.filter((c) => c.state === 'open').length;
      return {
        key: k, label: k === NONE ? noneLabel : (group === 'priority' ? (opt?.label || k) : k),
        color: opt?.color || null, limit: opt?.limit || null, description: opt?.description || '',
        over: !!(opt?.limit && openCount > opt.limit), open: openCount, items: cards,
        readonly: !DRAGGABLE.has(group),
      };
    });
  }

  // ------------------------------------------------------------ rendering: pieces
  const priorityBadge = (p) => (p ? badge(p, PRIORITY_TONE[p] ?? '') : '');
  const kindTag = (i) => `<span class="ktag ${i.kind}">${i.kind === 'pr' ? 'PR' : 'Issue'} #${i.number}</span>`;
  function cardHtml(i, draggable) {
    const linked = i.kind === 'issue'
      ? i.linked.map((l) => `<a class="lnk ${esc(l.state)}" href="${esc(l.url)}" target="_blank" rel="noopener"${tip(`${l.title || ''}\n${l.state}`)}>PR #${l.number}</a>`).join('')
      : i.linked.map((l) => `<span class="lnk issue"${tip('该 PR 引用的 Issue')}>#${l.number}</span>`).join('');
    const prBits = i.kind === 'pr' ? [i.draft ? badge('草稿', 'none') : '', i.merged ? badge('已合并', 'info') : '', i.review_decision ? badge(...(REVIEW[i.review_decision] || [i.review_decision, ''])) : '', i.ci_state ? conclusionBadge(i.ci_state) : ''].filter(Boolean).join(' ') : '';
    const people = i.assignee_names.length ? i.assignee_names.map((nm, k) => `<span class="person"${tip(`负责人 ${i.assignees[k]}`)}>${esc(nm)}</span>`).join('') : '<span class="person none">未指派</span>';
    return `<div class="bcard ${i.state} ${i.kind}" data-id="${esc(i.id)}" draggable="${draggable ? 'true' : 'false'}">
      <div class="bcard-head">${kindTag(i)}${i.state === 'closed' ? '<span class="closed-mark"' + tip(i.merged ? '已合并' : '已关闭') + '>✓</span>' : ''}<span class="grow"></span>${priorityBadge(i.priority)}${i.iteration ? `<span class="iter"${tip('迭代')}>${esc(i.iteration)}</span>` : ''}<button class="icon-btn" data-open="${esc(i.id)}"${tip('查看详情 / 编辑字段')}>⤢</button></div>
      <div class="bcard-title"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
      ${i.labels.length ? `<div class="bcard-labels">${labelChips(i.labels)}</div>` : ''}
      <div class="bcard-foot"><span class="people">${people}</span><span class="grow"></span>${prBits}${i.comments ? `<span class="muted"${tip('评论数')}>💬 ${i.comments}</span>` : ''}<span class="muted"${tip(`更新 ${date(i.updated_at)}`)}>${ago(i.updated_at)}</span></div>
      ${linked ? `<div class="bcard-links">${linked}</div>` : ''}
      ${i.note ? `<div class="bcard-note"${tip('本地备注')}>${esc(i.note)}</div>` : ''}
    </div>`;
  }
  function columnHtml(col, group) {
    const head = `<div class="bcol-head" style="--col:${col.color ? COLOR_VAR(col.color) : 'var(--axis)'}"><span class="swatch"></span><span class="bcol-name" title="${esc(col.description || col.label)}">${esc(col.label)}</span><span class="bcol-count ${col.over ? 'over' : ''}"${tip(col.limit ? `开放 ${col.open} / 上限 ${col.limit}` : `${col.items.length} 张卡`)}>${col.items.length}${col.limit ? ` / ${col.limit}` : ''}</span>${col.readonly ? `<span class="muted small"${tip('该分组由 GitHub 字段决定，看板不写回 GitHub，因此不可拖拽')}>只读</span>` : ''}</div>`;
    const body = col.items.length ? col.items.map((i) => cardHtml(i, !col.readonly)).join('') : '<div class="bcol-empty">拖卡片到这里</div>';
    return `<div class="bcol ${col.over ? 'over' : ''} ${col.readonly ? 'readonly' : ''}" data-key="${esc(col.key)}" data-group="${group}">${head}<div class="bcol-body">${body}</div></div>`;
  }
  function toolbarHtml(items) {
    const d = B.data, f = B.prefs.filters, p = B.prefs;
    const sel = (name, list, cur, allLabel, noneLabel) => `<select data-bfilter="${name}"><option value="">${allLabel}</option>${noneLabel ? `<option value="${NONE}"${cur === NONE ? ' selected' : ''}>${noneLabel}</option>` : ''}${list.map((x) => { const [v, l] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
    const chips = Object.entries(f).filter(([k, v]) => v).map(([k, v]) => `<span class="chip">${esc({ q: '搜索', state: '状态', label: '标签', assignee: '负责人', author: '作者', priority: '优先级', iteration: '迭代', milestone: '里程碑' }[k])}: ${esc(v === NONE ? '无' : v)} <button data-bclear="${k}">×</button></span>`).join('');
    const summary = p.group === 'status' ? columns(items).map((c) => `<span class="sum ${c.over ? 'over' : ''}" style="--col:${c.color ? COLOR_VAR(c.color) : 'var(--axis)'}"><i></i>${esc(c.label)} <b>${c.items.length}</b>${c.limit ? `<span class="muted">/${c.limit}</span>` : ''}</span>`).join('') : '';
    return `<div class="board-toolbar">
      <div class="seg" data-bpref="group"><span class="seg-label">分组</span>${Object.entries(GROUPS).map(([k, l]) => `<button class="${p.group === k ? 'on' : ''}" data-val="${k}">${l}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-bpref="equal" ${p.equal ? 'checked' : ''}> 等高列</label>
      <span class="grow"></span>
      <button class="btn small" data-baction="history">最近变更 (${d.history.length})</button>
      <button class="btn small" data-baction="settings">列与规则</button>
      <button class="btn small" data-baction="reload">重新装配</button><button class="btn small" data-local-export>导出字段</button><label class="btn small">导入字段<input type="file" accept="application/json,.json" data-local-import hidden></label>
    </div>
    <div class="board-filters">
      <input type="search" data-bfilter="q" placeholder="搜索编号 / 标题 / 备注" value="${esc(f.q)}">
      ${sel('state', [['open', '只看开放'], ['closed', '只看已关闭']], f.state, '开放 + 最近关闭')}
      ${sel('label', d.facets.labels, f.label, '全部标签', '无标签')}${sel('assignee', d.facets.assignees, f.assignee, '全部负责人', '未指派')}
      ${sel('author', d.facets.authors, f.author, '全部作者')}${sel('priority', d.facets.priorities, f.priority, '全部优先级', '未设置')}
      ${sel('iteration', d.facets.iterations, f.iteration, '全部迭代', '未设置')}${sel('milestone', d.facets.milestones, f.milestone, '全部里程碑', '无里程碑')}
      <span class="muted small">${items.length} / ${d.items.filter((i) => i.kind === B.scope).length} 张卡</span>
    </div>
    ${chips ? `<div class="chips">${chips}<button class="btn small" data-baction="clear-filters">清除全部</button></div>` : ''}
    ${summary ? `<div class="board-summary">${summary}<span class="muted small">规则：加入→${esc(d.rules.default_status)} · 指派→${esc(d.rules.doing_status)} · 关联 PR→${esc(d.rules.review_status)} · 关闭/合并→${esc(d.rules.done_status)}</span></div>` : ''}
    <div id="board-flash" class="banner error hidden"></div>`;
  }
  function historyHtml() {
    const h = B.data.history || [];
    const line = (e) => {
      const what = e.kind === 'status' ? `状态 ${esc(e.from || '未分类')} → ${esc(e.to || '未分类')}${e.reason && e.reason !== 'manual' ? ` <span class="muted">(${esc(e.reason)})</span>` : ''}`
        : e.kind === 'priority' ? `优先级 ${esc(e.from || '无')} → ${esc(e.to || '无')}` : e.kind === 'iteration' ? `迭代 ${esc(e.from || '无')} → ${esc(e.to || '无')}`
        : e.kind === 'fields' ? `列设置：${esc((e.status_options || []).join(' / '))}` : e.kind === 'rules' ? '规则已更新' : esc(e.kind);
      return `<li><span class="muted">${ago(e.at)}</span> ${e.item ? `<code>${esc(e.item)}</code>` : ''} ${what} <span class="muted">${e.actor === 'rule' ? '自动' : '手动'}</span></li>`;
    };
    return `<div class="card board-history"><h3>最近变更<span class="sub">本地字段的手动与自动变更，最多保留 300 条</span></h3>${h.length ? `<ul class="checks">${h.map(line).join('')}</ul>` : empty('还没有变更')}</div>`;
  }

  // ------------------------------------------------------------ rendering: page
  function render() {
    const root = $(`#tab-${SCOPES[B.scope].tab} .work-board`);
    if (!root) return;
    if (B.error && !B.data) { root.innerHTML = `<div class="banner error"><span class="icon">⛔</span><div><div class="title">看板数据不可用</div><div>${esc(B.error)}</div></div><div class="banner-actions"><button class="btn small" data-baction="reload">重试</button></div></div>`; return; }
    if (!B.data) { root.innerHTML = `<div class="skeleton"><span class="spinner"></span>装配看板…</div>`; return; }
    if(B.data.storage_warning) B.error=B.data.storage_warning;
    const items = filtered();
    let html = '<div class="board-controls"><p class="board-local-note">GitHub 工作项由快照更新；优先级、迭代、备注和列设置仅保存在本浏览器，不会同步给其他成员。</p>'+toolbarHtml(items);
    if (B.error) html += `<div class="banner warn"><span class="icon">▲</span><div>${esc(B.error)}</div></div>`;
    if (B.historyOpen) html += historyHtml();
    html += '</div>';
    // The page owns the shared chart/list header; keep the board itself full width.
    const controls = $(`#tab-${SCOPES[B.scope].tab} .open-board-controls`);
    if (controls) { controls.innerHTML = html; html = ''; }
    const cols = columns(items);
    html += `<div class="board ${B.prefs.equal ? 'equal' : ''}">${cols.map((c) => columnHtml(c, B.prefs.group)).join('')}</div>`;
    html += `<div class="muted small board-foot">数据：快照 ${ago(B.data.snapshot_generated_at)} 的 ${SCOPES[B.scope].name} + 本地字段（${B.scope === 'pr' ? B.data.counts.prs : B.data.counts.issues} 个，含最近 ${esc(String(B.data.rules.closed_window_days))} 天关闭的）。拖拽只改本地字段，不写回 GitHub。</div>`;
    // The page re-renders its mount point on every refresh, so scroll positions are
    // recorded as the reader scrolls and restored whenever the board is drawn again.
    root.innerHTML = html;
    root.querySelectorAll(SCROLLABLE).forEach(el => {
      const pos = B.scroll.get(`${B.scope}:${scrollKey(el)}`);
      if (pos) [el.scrollLeft, el.scrollTop] = pos;
    });
  }
  const SCROLLABLE = '.board, .board-controls, .bcol-body';
  const scrollKey = el => el.classList.contains('bcol-body')
    ? 'column:' + el.parentElement.dataset.group + ':' + el.parentElement.dataset.key : el.classList.contains('board') ? 'board' : el.className;
  document.addEventListener('scroll', (ev) => {
    const el = ev.target;
    if (el.matches?.(SCROLLABLE) && el.closest('.work-board')) B.scroll.set(`${B.scope}:${scrollKey(el)}`, [el.scrollLeft, el.scrollTop]);
  }, true);

  // ------------------------------------------------------------ drawer
  function openDrawer(id) { B.drawer = id; renderDrawer(); if (!B.details[id]) loadDetail(id); }
  function closeDrawer() { B.drawer = null; $('#drawer').classList.add('hidden'); }
  async function loadDetail(id) {
    const [kind, num] = id.split(':');
    try { B.details[id] = await fetchJson(`/api/board/item/${kind}/${num}`); } catch (err) { B.details[id] = { error: { message: err.message } }; }
    if (B.drawer === id) renderDrawer();
  }
  function renderDrawer() {
    const el = $('#drawer'), i = byId()[B.drawer];
    if (!i) { closeDrawer(); return; }
    const d = B.data, det = B.details[i.id];
    const opts = (list, cur, none) => `<option value=""${cur ? '' : ' selected'}>${none}</option>${list.map((o) => `<option value="${esc(o.name)}"${o.name === cur ? ' selected' : ''}>${esc(o.label || o.name)}</option>`).join('')}`;
    const refs = det && !det.error ? (det.cross_references || []) : [];
    const body = det ? (det.error ? `<div class="banner warn"><span class="icon">▲</span><div>正文不可用：${esc(det.error.message)}</div></div>` : `<div class="md">${markdown(det.body, d.repo)}</div>`) : '<div class="muted"><span class="spinner"></span>读取正文…</div>';
    const hist = (d.history || []).filter((e) => e.item === i.id).slice(0, 8);
    el.classList.remove('hidden');
    el.innerHTML = `<div class="drawer-head">${kindTag(i)} ${i.state === 'open' ? badge('open', 'good') : badge(i.merged ? 'merged' : 'closed', 'none')}<span class="grow"></span>${link(i.url, '在 GitHub 打开 ↗')}<button class="icon-btn" data-baction="close-drawer"${tip('关闭')}>✕</button></div>
      <h2 class="drawer-title">${esc(i.title)}</h2>
      <div class="drawer-meta">${esc(i.author_name || i.author || '')} 创建于 ${date(i.created_at)} · 更新 ${ago(i.updated_at)}${i.milestone ? ` · 里程碑 ${esc(i.milestone)}` : ''}${i.kind === 'pr' ? ` · <code>${esc(i.head || '')}</code> → <code>${esc(i.base || '')}</code>` : ''}</div>
      <div class="drawer-meta">${labelChips(i.labels)} ${i.assignee_names.length ? `负责人：${i.assignee_names.map(esc).join('、')}` : '<span class="muted">未指派</span>'}</div>
      <div class="field-grid">
        <label>状态<select data-dfield="status">${opts(d.fields.status.options, i.status, '未分类')}</select></label>
        <label>优先级<select data-dfield="priority">${opts(d.fields.priority.options, i.priority, '无')}</select></label>
        <label>迭代<input data-dfield="iteration" list="iteration-list-d" value="${esc(i.iteration || '')}" placeholder="如 2026-W39"><datalist id="iteration-list-d">${(d.facets.iterations || []).map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
        <label class="wide">备注<textarea data-dfield="note" rows="2" placeholder="只保存在本浏览器">${esc(i.note || '')}</textarea></label>
      </div>
      ${i.status_by && i.status_by !== 'manual' ? `<div class="muted small">状态由规则设置（${esc(i.status_by)}）；手动改动后规则不再降级它。</div>` : ''}
      <h4>关联</h4>
      ${refs.length || i.linked.length ? `<ul class="checks">${refs.map((r) => `<li>${badge(r.kind === 'pr' ? 'PR' : 'Issue', 'info')} ${link(r.url, `#${r.number} ${esc(r.title || '')}`)} ${badge(r.state || '', r.state === 'merged' ? 'info' : r.state === 'open' ? 'good' : 'none')} <span class="muted">${ago(r.at)}</span></li>`).join('')}${!refs.length ? i.linked.map((l) => `<li>${badge(l.kind === 'issue' ? 'Issue' : 'PR', 'info')} ${l.url ? link(l.url, `#${l.number} ${esc(l.title || '')}`) : `#${l.number}`}</li>`).join('') : ''}</ul>` : '<div class="muted">没有交叉引用</div>'}
      <h4>正文</h4>${body}
      ${hist.length ? `<h4>本卡变更</h4><ul class="checks">${hist.map((e) => `<li><span class="muted">${ago(e.at)}</span> ${esc(e.kind)} ${esc(e.from || '—')} → ${esc(e.to || '—')} <span class="muted">${e.actor === 'rule' ? '自动' : '手动'}</span></li>`).join('')}</ul>` : ''}`;
  }
  /** Minimal markdown: headings, lists, fenced/inline code, links, bold, #123 references. Input is escaped first. */
  function markdown(text, repo) {
    const lines = esc((text || '').replace(/<!--[\s\S]*?-->/g, '')).split('\n');
    const out = []; let code = false, list = false;
    const inline = (s) => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[^"'>=\]])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/(^|[\s(（])#(\d+)\b/g, `$1<a href="https://github.com/${repo}/issues/$2" target="_blank" rel="noopener">#$2</a>`);
    for (const raw of lines) {
      if (raw.startsWith('```')) { if (list) { out.push('</ul>'); list = false; } out.push(code ? '</pre>' : '<pre>'); code = !code; continue; }
      if (code) { out.push(raw); continue; }
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { if (list) { out.push('</ul>'); list = false; } const lv = Math.min(h[1].length + 2, 6); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }
      const li = raw.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push('</ul>'); list = false; }
      if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
    }
    if (list) out.push('</ul>');
    if (code) out.push('</pre>');
    return out.join('\n') || '<p class="muted">（无正文）</p>';
  }

  // ------------------------------------------------------------ settings dialog
  function openSettings() {
    const d = B.data, dlg = $('#board-settings');
    const colors = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const row = (o, idx) => `<tr data-orig="${esc(o.name)}"><td><input name="name" value="${esc(o.name)}" required maxlength="40"></td>
      <td><select name="color">${colors.map((c) => `<option value="${c}"${o.color === c ? ' selected' : ''} style="color:var(--${c})">${c}</option>`).join('')}</select></td>
      <td><input name="limit" type="number" min="0" value="${o.limit ?? ''}" placeholder="无" size="4"></td>
      <td><input name="description" value="${esc(o.description || '')}" maxlength="120" placeholder="说明"></td>
      <td class="row-actions"><button type="button" data-srow="up">↑</button><button type="button" data-srow="down">↓</button><button type="button" data-srow="del" class="danger">删除</button></td></tr>`;
    const statusSel = (key) => `<select name="${key}">${['', ...d.fields.status.options.map((o) => o.name)].map((nm) => `<option value="${esc(nm)}"${d.rules[key] === nm ? ' selected' : ''}>${nm || '（不启用）'}</option>`).join('')}</select>`;
    dlg.innerHTML = `<form method="dialog" id="settings-form">
      <div class="dlg-head"><h3>看板列与规则</h3><span class="muted">只保存在本浏览器，不共享给其他成员</span></div>
      <section><h4>状态列 <span class="muted small">顺序即看板顺序；WIP 上限按开放卡计</span></h4>
        <table class="settings-table"><thead><tr><th>名称</th><th>颜色</th><th>WIP 上限</th><th>说明</th><th></th></tr></thead><tbody id="status-rows">${d.fields.status.options.map(row).join('')}</tbody></table>
        <button type="button" class="btn small" data-baction="add-status">添加列</button></section>
      <section><h4>自动化规则 <span class="muted small">根据快照更新本浏览器中的状态</span></h4>
        <div class="rules-grid">
          <label>加入看板时 → ${statusSel('default_status')}</label>
          <label><input type="checkbox" name="assigned_to_doing" ${d.rules.assigned_to_doing ? 'checked' : ''}> Issue 被指派 → ${statusSel('doing_status')}</label>
          <label><input type="checkbox" name="linked_pr_to_review" ${d.rules.linked_pr_to_review ? 'checked' : ''}> 出现开放的关联 PR → ${statusSel('review_status')}</label>
          <label><input type="checkbox" name="closed_to_done" ${d.rules.closed_to_done ? 'checked' : ''}> 关闭 / 合并 → ${statusSel('done_status')}</label>
          <label><input type="checkbox" name="reopened_to_default" ${d.rules.reopened_to_default ? 'checked' : ''}> 重新打开 → 回到「加入」列</label>
          <label><input type="checkbox" name="include_prs" ${d.rules.include_prs ? 'checked' : ''}> PR 也作为卡片</label>
          <label>保留最近 <input type="number" name="closed_window_days" min="1" max="365" value="${d.rules.closed_window_days}" size="4"> 天内关闭的卡</label>
        </div></section>
      <section><h4>迭代 <span class="muted small">每行一个，作为迭代字段的候选</span></h4><textarea name="iterations" rows="3">${esc((d.fields.iterations || []).join('\n'))}</textarea></section>
      <section><h4>成员别名 <span class="muted small">GitHub 登录名 → 显示名，只影响本地显示</span></h4>
        <table class="settings-table"><thead><tr><th>登录名</th><th>显示名</th><th></th></tr></thead><tbody id="alias-rows">${Object.entries(d.aliases || {}).map(([l, a]) => `<tr><td><input name="alias-login" value="${esc(l)}"></td><td><input name="alias-name" value="${esc(a)}"></td><td class="row-actions"><button type="button" data-srow="del" class="danger">删除</button></td></tr>`).join('')}</tbody></table>
        <button type="button" class="btn small" data-baction="add-alias">添加别名</button></section>
      <div id="settings-error" class="banner error hidden"></div>
      <footer><button type="button" class="btn" data-baction="cancel-settings">取消</button><button type="submit" class="btn primary">保存</button></footer>
    </form>`;
    dlg.showModal();
  }
  async function saveSettings(form) {
    const d = B.data;
    const status_options = [...form.querySelectorAll('#status-rows tr')].map((tr) => ({
      name: tr.querySelector('[name=name]').value, color: tr.querySelector('[name=color]').value,
      limit: tr.querySelector('[name=limit]').value === '' ? null : Number(tr.querySelector('[name=limit]').value),
      description: tr.querySelector('[name=description]').value, rename_from: tr.dataset.orig || null,
    }));
    const rules = {};
    ['default_status', 'doing_status', 'review_status', 'done_status'].forEach((k) => { rules[k] = form.querySelector(`[name=${k}]`).value; });
    ['assigned_to_doing', 'linked_pr_to_review', 'closed_to_done', 'reopened_to_default', 'include_prs'].forEach((k) => { rules[k] = form.querySelector(`[name=${k}]`).checked; });
    rules.closed_window_days = Number(form.querySelector('[name=closed_window_days]').value) || 30;
    // A renamed column keeps its rule bindings: map old → new names before sending.
    const renames = Object.fromEntries(status_options.filter((o) => o.rename_from && o.rename_from !== o.name).map((o) => [o.rename_from, o.name]));
    ['default_status', 'doing_status', 'review_status', 'done_status'].forEach((k) => { if (renames[rules[k]]) rules[k] = renames[rules[k]]; });
    const iterations = form.querySelector('[name=iterations]').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const errBox = form.querySelector('#settings-error');
    try {
      await post('/api/board/fields', { status_options, rules, iterations });
      const wanted = {};
      form.querySelectorAll('#alias-rows tr').forEach((tr) => { const l = tr.querySelector('[name=alias-login]').value.trim(), a = tr.querySelector('[name=alias-name]').value.trim(); if (l) wanted[l] = a; });
      for (const [l, a] of Object.entries(wanted)) if ((d.aliases || {})[l] !== a) await post('/api/board/aliases', { login: l, alias: a || null });
      for (const l of Object.keys(d.aliases || {})) if (!(l in wanted)) await post('/api/board/aliases', { login: l, alias: null });
      $('#board-settings').close();
    } catch (err) {
      errBox.textContent = err.message; errBox.classList.remove('hidden');
    }
  }

  // ------------------------------------------------------------ drag & drop
  function clearDropMarks() { document.querySelectorAll('.bcol.drop-target').forEach((c) => c.classList.remove('drop-target')); document.querySelectorAll('.drop-line').forEach((l) => l.remove()); }
  document.addEventListener('dragstart', (ev) => {
    const card = ev.target.closest?.('.bcard[draggable="true"]');
    if (!card) return;
    B.drag = { id: card.dataset.id, before: null, after: null, col: null };
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', card.dataset.id); } catch (e) { /* older engines */ }
    card.classList.add('dragging');
  });
  document.addEventListener('dragend', (ev) => { ev.target.closest?.('.bcard')?.classList.remove('dragging'); clearDropMarks(); B.drag = null; });
  document.addEventListener('dragover', (ev) => {
    if (!B.drag) return;
    const col = ev.target.closest?.('.bcol');
    if (!col || col.classList.contains('readonly')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    col.classList.add('drop-target');
    const over = ev.target.closest('.bcard');
    const line = document.createElement('div'); line.className = 'drop-line';
    B.drag.col = col.dataset.key; B.drag.before = null; B.drag.after = null;
    if (over && over.dataset.id !== B.drag.id) {
      const r = over.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { over.before(line); B.drag.before = over.dataset.id; }
      else { over.after(line); B.drag.after = over.dataset.id; }
    } else if (!over) {
      const body = col.querySelector('.bcol-body');
      const cards = [...body.querySelectorAll('.bcard')].filter((c) => c.dataset.id !== B.drag.id);
      const last = cards[cards.length - 1];
      if (last) { last.after(line); B.drag.after = last.dataset.id; } else body.prepend(line);
    }
  });
  document.addEventListener('drop', (ev) => {
    if (!B.drag) return;
    const col = ev.target.closest?.('.bcol');
    if (!col || col.classList.contains('readonly')) return;
    ev.preventDefault();
    const { id, before, after } = B.drag, key = col.dataset.key, group = col.dataset.group;
    clearDropMarks();
    B.drag = null;
    const value = key === NONE ? null : key;
    if (group === 'status') mutate(() => post('/api/board/move', { id, status: value, before, after }));
    else if (group === 'priority') mutate(() => post(`/api/board/items/${id}`, { priority: value }));
    else if (group === 'iteration') mutate(() => post(`/api/board/items/${id}`, { iteration: value }));
  });

  // ------------------------------------------------------------ events
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const open = t.closest?.('[data-open]');
    if (open) { ev.preventDefault(); openDrawer(open.dataset.open); return; }
    const seg = t.closest?.('[data-bpref] button');
    if (seg) { const pref = seg.closest('[data-bpref]').dataset.bpref; B.prefs[pref] = seg.dataset.val; savePrefs(); render(); return; }
    const clear = t.closest?.('[data-bclear]');
    if (clear) { B.prefs.filters[clear.dataset.bclear] = ''; savePrefs(); render(); return; }
    const rowBtn = t.closest?.('[data-srow]');
    if (rowBtn) {
      const tr = rowBtn.closest('tr'), op = rowBtn.dataset.srow;
      if (op === 'del') tr.remove(); else if (op === 'up' && tr.previousElementSibling) tr.previousElementSibling.before(tr); else if (op === 'down' && tr.nextElementSibling) tr.nextElementSibling.after(tr);
    }
    const act = t.closest?.('[data-baction]');
    if (!act) return;
    const a = act.dataset.baction;
    if (a === 'reload') load();
    else if (a === 'history') { B.historyOpen = !B.historyOpen; render(); }
    else if (a === 'settings') openSettings();
    else if (a === 'clear-filters') {
      Object.keys(B.prefs.filters).forEach((k) => { B.prefs.filters[k] = ''; });
      savePrefs();
      const tab = B.scope === 'issue' ? 'issues' : 'prs';
      if (H.ageFilter && H.ageFilter()[tab] != null) H.setAgeFilter(tab, null); else render();
    }
    else if (a === 'close-drawer') closeDrawer();
    else if (a === 'cancel-settings') $('#board-settings').close();
    else if (a === 'add-status') $('#status-rows').insertAdjacentHTML('beforeend', `<tr data-orig=""><td><input name="name" placeholder="新列" required maxlength="40"></td><td><select name="color">${['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((c) => `<option value="${c}">${c}</option>`).join('')}</select></td><td><input name="limit" type="number" min="0" placeholder="无" size="4"></td><td><input name="description" placeholder="说明"></td><td class="row-actions"><button type="button" data-srow="up">↑</button><button type="button" data-srow="down">↓</button><button type="button" data-srow="del" class="danger">删除</button></td></tr>`);
    else if (a === 'add-alias') $('#alias-rows').insertAdjacentHTML('beforeend', '<tr><td><input name="alias-login" placeholder="login"></td><td><input name="alias-name" placeholder="显示名"></td><td class="row-actions"><button type="button" data-srow="del" class="danger">删除</button></td></tr>');

  });
  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.matches?.('[data-bfilter]')) {
      B.prefs.filters[el.dataset.bfilter] = el.value; savePrefs();
      const pos = el.selectionStart; render();
      const again = document.querySelector(`[data-bfilter="${el.dataset.bfilter}"]`);
      if (again && again.tagName === 'INPUT') { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* n/a */ } }
    } else if (el.matches?.('[data-bpref="equal"]')) { B.prefs.equal = el.checked; savePrefs(); render(); }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches?.('[data-dfield]') && B.drawer) {
      const field = el.dataset.dfield, value = el.value === '' ? null : el.value;
      mutate(() => post(`/api/board/items/${B.drawer}`, { [field]: value }));
    }
  });
  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'settings-form') { ev.preventDefault(); saveSettings(ev.target); }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && B.drawer) closeDrawer(); });
  // Wheel over column headings / gutters scrolls the board horizontally (columns scroll vertically themselves).
  document.addEventListener('wheel', (ev) => {
    const board = ev.target.closest?.('.board');
    if (!board) return;
    const body = ev.target.closest('.bcol-body');
    if (body && body.scrollHeight > body.clientHeight) return;
    if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) { board.scrollLeft += ev.deltaY; ev.preventDefault(); }
  }, { passive: false });

  document.addEventListener('click',ev=>{
    if(!ev.target.closest('[data-local-export]'))return;
    const blob=new Blob([window.GSBLocalBoard.export()],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='board-fields.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  document.addEventListener('change',async ev=>{
    if(!ev.target.matches('[data-local-import]'))return;
    try {const file=ev.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw Error('导入文件超过 5 MiB');window.GSBLocalBoard.import(await file.text());await load();}
    catch(err){flash('导入失败：'+err.message);}
  });
  // Issue and PR pages call this when their list switches to the board.
  function mount(scope) { if (!SCOPES[scope]) return; B.scope = scope; if (B.data) render(); else if (H.snapshot()) onSnapshot(H.snapshot()); }
  window.GSBBoard = { onSnapshot, load, render, mount };
  if(H.snapshot())onSnapshot(H.snapshot());
})();
