// One installation: its archive snapshot, the repositories it grants and its recent deliveries. Evidence is shown as
// recorded: a missing history never becomes "no request", and an unverified signature is marked instead of trusted.
const installationStatusNames = { active: '有效', pending_sync: '等待同步', suspended: '已暂停', deleted: '已卸载' };
const installationCompletenessNames = { complete: '完整', pending: '等待同步', stale: '待核实', error: '同步失败，保留最近成功快照' };
async function installationDetail(request, ref) {
  const section = card('安装档案详情'), content = element('div', ''), back = settingsLink('#/settings/installations', '返回安装档案');
  section.append(back, content);
  const match = /^([^/]+)\/([1-9]\d*)\/([1-9]\d*)$/.exec(ref || '');
  if (!match) { content.append(note('安装地址不完整，请从安装档案列表打开。')); return [section]; }
  const base = `/api/installations/archive/${match[1]}/${match[2]}/${match[3]}`;
  // A notice carries the tone of its own outcome: a failed re-sync must not look like a success.
  const draw = async (notice, tone = 'view-success') => {
    content.replaceChildren(element('p', '正在加载…', 'muted'));
    try {
      const [record, repositories, deliveries] = await Promise.all([api(base), api(base + '/repositories'), api(base + '/events')]);
      content.replaceChildren(...(notice ? [element('p', notice, tone)] : []),
        ...installationDetailBody(base, record.installation, repositories.repositories || [], deliveries.events || [], draw));
    } catch (err) { content.replaceChildren(note('读不到这条安装：' + err.message)); }
  };
  await draw('');
  return [section];
}
function installationDetailBody(base, snapshot, repositories, deliveries, redraw) {
  const nodes = [], installation = snapshot.installation, evidence = snapshot.evidence || {};
  nodes.push(element('h4', `${snapshot.target.login || '目标待同步'} · 安装 ${installation.installation_id}`),
    facts([['状态', installationStatusNames[snapshot.status] || snapshot.status],
      ['范围', snapshot.repository_selection === 'all' ? '全部仓库' : snapshot.repository_selection === 'selected' ? '指定仓库' : '待同步'],
      ['完整性', installationCompletenessNames[snapshot.completeness] || snapshot.completeness],
      ['最近成功同步', snapshot.last_success_at ? timestamp(snapshot.last_success_at) : '尚未成功同步'],
      ['执行', snapshot.execution_blocked ? '已阻止：安装未生效或范围变更待确认' : '可以执行'],
      ['投影／范围／权限版本', `${snapshot.projection_version} / ${snapshot.scope_version} / ${snapshot.permissions_version}`]]));
  const permissions = Object.entries(snapshot.permissions || {}).map(([name, level]) => `${permissionNames[name] || name}（${accessNames[level] || level}）`);
  nodes.push(facts([['安装授权（GitHub 返回）', permissions.join('、') || '未同步到权限，不能据此判断缺什么']]));
  // #237: an App's definition, an installation's scope and the actual user grants are three separate checks, each with its
  // own evidence. The list page already runs the App check against GitHub; this page offers the same check so that the
  // profile answers "what does the App declare" on its own and names the features a gap would block.
  const app = accounts.find(account => account.type === 'github_app' && String(account.app_id) === String(installation.app_id));
  const appSection = element('section', ''); appSection.append(element('h4', 'App 定义检查'));
  appSection.append(facts([['App', app ? `${app.name}（GitHub App · App ID ${app.app_id}）` : '未匹配到已登记账号（App 已删除或凭据已撤销）'],
    ['安装范围', snapshot.repository_selection === 'all' ? '全部仓库' : snapshot.repository_selection === 'selected' ? '指定仓库' : '待同步']]));
  if (app?.credentials_configured) appSection.append(note('这一项只检查 App 自己声明的权限与事件订阅；安装范围看上面的「范围」，实际用户授权在账号页与身份页分别核对。缺项会写明影响哪些已开启的功能。'), appPermissionCheck(app));
  else appSection.append(note(app ? '这个 App 的凭据已撤销，无法检查 App 定义与安装缺少哪些权限。' : '未匹配到已登记账号，无法检查 App 定义；先登记这个 App 的凭据。'));
  nodes.push(appSection);
  // A missing history is stated as missing; it is not evidence that nobody ever applied, nor an approver to show.
  if (evidence.history_missing) nodes.push(note('历史证据缺失：不能判断申请者与批准者，也不能据此认为没有申请。'));
  else {
    const person = value => value ? `${value.login || '名称未知'}（${value.id}）` : '未提供';
    nodes.push(facts([['安装事件触发者', person(evidence.sender)], ['申请者', person(evidence.requester)], ['批准者', evidence.approval?.label || '批准者未知']]));
  }
  const repoSection = element('section', ''); repoSection.append(element('h4', `仓库（${repositories.length}）`));
  if (!repositories.length) repoSection.append(element('p', '无仓库（零仓库安装也会保留；同步后新仓库会出现）', 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', '');
    const captions = ['仓库', '私有', '最近成功同步'];
    for (const caption of captions) head.append(element('th', caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head); table.append(thead, body);
    for (const repository of repositories) {
      const row = element('tr', ''),
        cell = (index, value) => { const td = element('td'); td.dataset.label = captions[index]; td.append(value); return td; };
      // The narrow layout prints the column name from data-label instead of leaving a bare value under no heading.
      row.append(cell(0, repository.full_name), cell(1, repository.private ? '私有' : '公开'),
        cell(2, repository.last_success_at ? timestamp(repository.last_success_at) : '尚未同步'));
      body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); repoSection.append(wrap);
  }
  nodes.push(repoSection);
  const eventSection = element('section', ''); eventSection.append(element('h4', `最近安装事件（${deliveries.length}）`));
  if (!deliveries.length) eventSection.append(element('p', '还没有记录到安装事件。', 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', '');
    const captions = ['时间', '事件', '动作', '发送者', '申请者', '证据类型', '签名'];
    for (const caption of captions) head.append(element('th', caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head); table.append(thead, body);
    const person = value => value ? `${value.login || '名称未知'}（${value.id}）` : '未提供';
    for (const event of deliveries) {
      const row = element('tr', ''), cell = (index, value) => { const td = element('td'); td.dataset.label = captions[index]; td.append(value); return td; };
      row.append(cell(0, event.received_at ? timestamp(event.received_at) : '—'), cell(1, event.event || '—'),
        cell(2, event.action || '—'), cell(3, person(event.sender)), cell(4, person(event.requester)),
        cell(5, event.evidence_type || '—'));
      const signature = element('td'); signature.dataset.label = captions[6];
      signature.append(event.signature_verified ? badge('签名已验证', 'success') : badge('签名未验证', 'danger'));
      row.append(signature); body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); eventSection.append(wrap);
  }
  nodes.push(eventSection);
  // Only this card redraws after the sync request; the other archive cards keep what they already showed.
  const sync = button('重新同步', async () => {
    sync.disabled = true;
    try { await api(base + '/sync', 'POST', {}); await redraw('已排队重新同步：完成后刷新这一页查看新状态。'); }
    catch (err) { await redraw('重新同步失败：' + err.message, 'view-error'); }
    finally { sync.disabled = false; }
  });
  const actions = element('div', '', 'actions'); actions.append(sync); nodes.push(actions);
  return nodes;
}
