// GitCode sync page: renders data/gitcode-sync.json, which the collect workflow
// publishes from the bot's sanitized records. Read-only; fetches only that file.
(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Only plain https links reach the DOM; anything else renders as text.
  const href = (url) => (/^https:\/\/[^\s"'<>@]+$/.test(String(url || '')) ? url : '');
  const link = (url, text) => (href(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false }); };
  const sha = (value) => (value ? `<code>${esc(String(value).slice(0, 7))}</code>` : '—');
  const ACTION = { opened: '创建', synchronize: '推送新提交', reopened: '重新打开', closed: '关闭（未合并）', merged: 'GitHub 已合并', codecheck: 'CodeCheck 回读' };
  const STATUS = { success: ['good', '成功'], error: ['bad', '失败'], skipped: ['none', '跳过'] };
  const SYNC = { pending: ['info', '排队中'], retrying: ['warn', '重试中'], synced: ['good', '已同步'], diverged: ['bad', '已推送，历史分叉'],
    failed: ['bad', '同步失败'], closed: ['none', '已关闭'], merged: ['none', 'GitHub 已合并'], skipped: ['none', '跳过'] };
  const CHECK = { pending: ['info', '等待结论'], success: ['good', '通过'], failure: ['bad', '未通过'], timed_out: ['bad', '超时无结论'], cancelled: ['none', '已取消'] };
  const badge = ([cls, text]) => `<span class="badge ${cls}">${esc(text)}</span>`;
  // Why the bot is not syncing. Missing credentials are faults; no token and `off` are deliberate.
  const REASON = {
    no_github_app: [true, '缺少 GitHub App 凭据', 'Bot 没有配置 SDBOT_GITHUB_APP_ID 与 SDBOT_GITHUB_APP_PRIVATE_KEY，无法从 GitHub 拉取 PR 提交，也无法写 CodeCheck Check。'],
    no_webhook_secret: [true, '缺少 GitHub Webhook secret', 'Bot 没有配置 SDBOT_GITHUB_WEBHOOK_SECRET，收不到经过验签的 PR 事件。'],
    no_token: [false, '未设置 GITCODE_TOKEN', 'Bot 没有 GitCode 令牌，PR 不会同步到 GitCode，也不会写 CodeCheck Check。'],
    off: [false, '同步已关闭（SDBOT_GITCODE_SYNC_TARGET=off）', '运维人员显式关闭了 GitCode 同步。'],
  };
  const reasons = (doc) => (Array.isArray(doc?.reasons) ? doc.reasons : []).filter((r) => REASON[r]);
  const missingCredentials = (doc) => doc?.enabled === false && reasons(doc).some((r) => REASON[r][0]);
  const state = { doc: null, error: '', onlyFailures: false };
  // Problems are sync failures, not CodeCheck verdicts: a failed check is the gate working.
  const problems = (doc) => (doc?.pulls || []).filter((p) => ['failed', 'diverged', 'retrying'].includes(p.sync_status));

  function nav() {
    const tab = document.querySelector('#tabs a[data-tab="sync"]');
    if (!tab) return;
    const count = state.doc ? problems(state.doc).length + (state.doc.available === false ? 1 : 0) + (missingCredentials(state.doc) ? 1 : 0) : 0;
    tab.innerHTML = 'GitCode 同步' + (count ? `<span class="tab-count" title="需要处理的同步问题">${count}</span>` : '');
  }
  function render() {
    const root = document.getElementById('tab-sync');
    if (!root) return;
    nav();
    const doc = state.doc;
    const head = `<div class="section-head"><h2>GitCode 同步</h2><span class="sub">GitHub PR 同步为 GitCode MR，CodeCheck 结论以 GitHub Check${doc?.check_name ? `「${esc(doc.check_name)}」` : ''}写回${doc?.generated_at ? ` · 数据更新于 ${esc(when(doc.generated_at))}` : ''}</span></div>`;
    if (!doc) {
      root.innerHTML = head + (state.error === 'missing'
        ? '<div class="banner info"><div><div class="title">尚未发布同步记录</div><div class="hint">Bot 启用 GitCode 同步、看板采集运行后，这里会出现记录。</div></div></div>'
        : `<div class="banner error"><div><div class="title">同步数据读取失败</div><div class="hint">${esc(state.error || '载入中…')}</div></div></div>`);
      return;
    }
    const banners = [];
    if (doc.available === false) banners.push(`<div class="banner error" data-sync="stale"><div><div class="title">最近一次采集没能读取 Bot 的同步记录</div><div class="hint">原因：${esc(doc.error || '未知')}。下面是 ${esc(when(doc.stale_since))} 的数据，可能已过期。</div></div></div>`);
    if (doc.enabled === false) {
      const known = reasons(doc);
      const items = known.length ? known.map((r) => `<li data-reason="${esc(r)}"><strong>${esc(REASON[r][1])}</strong>：${esc(REASON[r][2])}</li>`).join('')
        : '<li>Bot 没有说明停用原因。</li>';
      banners.push(`<div class="banner ${missingCredentials(doc) ? 'error' : 'info'}" data-sync="disabled"><div><div class="title">GitCode 同步已停用</div><ul class="sync-reasons">${items}</ul></div></div>`);
    }
    const broken = problems(doc);
    if (broken.length) banners.push(`<div class="banner error" data-sync="problems"><div><div class="title">${broken.length} 个 PR 同步失败、重试中或历史分叉</div><div class="hint">见下方「当前状态」的错误摘要和同步记录。</div></div></div>`);
    const records = doc.records || [], pulls = doc.pulls || [];
    const failures = records.filter((r) => r.status === 'error');
    const waiting = pulls.filter((p) => p.check === 'pending').length;
    const tiles = `<div class="tiles">
      <div class="tile"><div class="label">跟踪中的 PR</div><div class="value">${pulls.length}</div></div>
      <div class="tile ${broken.length ? 'bad' : 'good'}"><div class="label">同步有问题的 PR</div><div class="value">${broken.length}</div></div>
      <div class="tile"><div class="label">等待 CodeCheck 结论</div><div class="value">${waiting}</div></div>
      <div class="tile ${failures.length ? 'bad' : 'good'}"><div class="label">记录中的失败</div><div class="value">${failures.length}<small>/ ${records.length}</small></div></div></div>`;
    const pullRows = pulls.map((p) => `<tr class="${['failed', 'diverged', 'retrying'].includes(p.sync_status) ? 'sync-error' : ''}">
      <td data-label="GitHub PR">${link(p.pr_url, '#' + p.pr)}<div class="sub">${esc(p.title)}</div></td><td data-label="GitCode MR">${p.mr ? link(p.mr_url, '!' + p.mr) : '—'}</td>
      <td data-label="Head">${sha(p.head_sha)}</td><td data-label="同步">${badge(SYNC[p.sync_status] || ['none', p.sync_status])}</td><td data-label="CodeCheck">${p.check ? badge(CHECK[p.check] || ['none', p.check]) : '—'}</td>
      <td data-label="错误摘要" class="sync-detail">${p.error ? `<span class="sync-error-text">${esc(p.error_code || '')}</span> ${esc(p.error)}` : '—'}</td></tr>`).join('');
    const shown = state.onlyFailures ? failures : records;
    const recordRows = shown.map((r) => `<tr class="${r.status === 'error' ? 'sync-error' : ''}" data-record="${esc(r.id)}">
      <td data-label="时间" class="nowrap">${esc(when(r.time))}</td><td data-label="GitHub PR">${link(r.pr_url, '#' + r.pr)}<div class="sub">${esc(r.title)}</div></td>
      <td data-label="GitCode MR">${r.mr ? link(r.mr_url, '!' + r.mr) : '—'}</td><td data-label="动作">${esc(ACTION[r.action] || r.action)}<div class="sub">${sha(r.head_sha)}</div></td>
      <td data-label="状态">${badge(STATUS[r.status] || ['none', r.status])}</td>
      <td data-label="说明" class="sync-detail">${esc(r.summary)}${r.error ? `<div class="sync-error-text">${esc(r.error_code ? r.error_code + '：' : '')}${esc(r.error)}</div>` : ''}</td></tr>`).join('');
    root.innerHTML = head + banners.join('') + tiles +
      `<div class="card"><h3>当前状态<span class="sub">每个 PR 最新一次同步与 CodeCheck 结论</span></h3>${pulls.length ? `<div class="table-wrap"><table><thead><tr><th>GitHub PR</th><th>GitCode MR</th><th>Head</th><th>同步</th><th>CodeCheck</th><th>错误摘要</th></tr></thead><tbody>${pullRows}</tbody></table></div>` : '<div class="empty">暂无同步中的 PR</div>'}</div>` +
      `<div class="card"><h3>同步记录<span class="sub">最新在前</span></h3><label class="sync-toolbar"><input type="checkbox" id="sync-only-failures"${state.onlyFailures ? ' checked' : ''}> 只看失败（${failures.length}）</label>` +
      (shown.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>GitHub PR</th><th>GitCode MR</th><th>动作</th><th>状态</th><th>说明 / 错误摘要</th></tr></thead><tbody>${recordRows}</tbody></table></div>` : '<div class="empty">没有记录</div>') + '</div>';
  }
  async function load() {
    try {
      const response = await fetch('./data/gitcode-sync.json', { cache: 'no-store' });
      if (response.status === 404) { state.doc = null; state.error = 'missing'; }
      else if (!response.ok) { state.doc = null; state.error = `HTTP ${response.status}`; }
      else { state.doc = await response.json(); state.error = ''; }
    } catch (err) { state.doc = null; state.error = err && err.message ? err.message : String(err); }
    render();
  }
  document.addEventListener('change', (ev) => {
    if (ev.target && ev.target.id === 'sync-only-failures') { state.onlyFailures = ev.target.checked; render(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  load();
})();
