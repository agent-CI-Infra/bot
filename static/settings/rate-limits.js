// GitHub's hourly request windows per credential, grouped by account: the App's own (JWT), each installation (an
// organization or user, shared by every repository and task agent there) and a bot account's user.
const windowNames = { core: 'REST', graphql: 'GraphQL', search: '搜索' };
function rateLimitBody(view, redraw) {
  const nodes = [note('GitHub 按发出请求的身份分别计算每小时的请求额度。GitHub App 按安装计算：装在几个组织（或个人账号）上就有几份，每份由那个组织下所有仓库的检视、开发和任务 agent 的请求共用，一个组织用完不影响其他组织。Token 账号按 Token 所属的 GitHub 用户计算，只有一份，它处理的所有仓库和这个用户的其他 Token 共用。'),
    note('额度用完时，任务等到窗口重置再继续，不在窗口内重试。数据来自 GitHub 每次响应和每 10 分钟的同步；「探测」立即读取一次；读窗口不计入额度，App 签发临时令牌、Token 账号首次读取登录名会各用少量请求。App 自身（JWT）的请求只在 GitHub 报告额度时列出。')];
  if (!view.limits) { nodes.push(element('p', '暂时读不到请求额度。', 'view-error')); return nodes; }
  for (const account of view.accounts) {
    const recorded = view.limits.accounts.find(row => row.account_id === account.id), head = element('div', '', 'actions settings-list-head');
    const probe = button('探测', async () => {
      probe.disabled = true;
      try { view.limits = await api(`/api/accounts/${account.id}/rate-limits/probe`, 'POST', {}); redraw(`已读取 ${account.name} 的请求额度`); }
      catch (err) { probe.disabled = false; message.textContent = err.message; }
    }, ''), message = element('p', '', 'view-error');
    message.setAttribute('role', 'alert');
    head.append(element('h4', `${account.name}（${account.type === 'github_app' ? 'GitHub App' : 'Token 账号'}）`), probe); nodes.push(head, message);
    if (!recorded?.buckets.length) { nodes.push(note('还没有记录，点「探测」读取。')); continue; }
    const table = element('table', '', 'rule-table rate-table'), headRow = element('tr', '');
    for (const caption of ['对象', '额度', '已用', '剩余', '窗口重置', '状态']) headRow.append(element('th', caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(headRow); table.append(thead, body);
    for (const bucket of recorded.buckets) for (const window of bucket.windows) {
      const row = element('tr', ''), cell = (label, value) => { const td = element('td', ''); td.dataset.label = label; td.append(value); row.append(td); };
      const who = bucket.kind === 'app' ? 'App 自身（JWT）' : bucket.kind === 'user' ? `Token 用户 ${bucket.owner || '（登录名未读到）'}`
        : `${bucket.owner ? bucket.owner + ' 上的 ' : ''}App 安装（${bucket.installation_id}）`;
      const share = window.quota ? window.remaining / window.quota : 1, meter = element('span', '', 'rate-meter'), fill = element('span', '');
      fill.style.width = `${Math.round(Math.min(1, window.used / (window.quota || 1)) * 100)}%`; if (share < 0.1) fill.className = 'low'; meter.append(fill);
      const status = window.resource === 'core' && bucket.blocked_until ? badge(`流控中，${timestamp(new Date(bucket.blocked_until).toISOString()).slice(11, 19)} 后继续`, 'danger')
        : window.expired ? badge('窗口已重置', '') : share < 0.1 ? badge('将用完', 'warning') : badge('正常', 'success');
      const state = element('span', ''); state.append(status);
      if (window.resource === 'core' && bucket.waiting_tasks) state.append(' ', element('span', `${bucket.waiting_tasks} 个任务在等`, 'muted'));
      cell('对象', `${who} · ${windowNames[window.resource] || window.resource}`);
      cell('额度', String(window.quota)); const used = element('span', String(window.used)); used.append(' ', meter); cell('已用', used);
      cell('剩余', String(window.remaining)); cell('窗口重置', window.reset_at ? timestamp(new Date(window.reset_at).toISOString()) : '—'); cell('状态', state);
      body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); nodes.push(wrap);
    const observed = recorded.buckets.flatMap(b => b.windows.map(w => w.observed_at)).sort().at(-1);
    if (observed) nodes.push(note('最近一次读取：' + timestamp(observed)));
  }
  if (!view.accounts.length) nodes.push(note('还没有登记账号。'));
  return nodes;
}
