// Why a command did not run, in words instead of only the code the server returned. A code the console cannot explain
// keeps its bare value below the sentence rather than being guessed at.
// Why the assistant page or the floating chat could not open, in words a project administrator can act on.
const managementAccessHints = {
  scope_forbidden: '当前范围里没有已启动、且你有权管理的项目，所以还不能使用管理助手。请改选上面的项目，或先到项目列表、身份与权限查看项目是否已启动。',
  capability_forbidden: '当前账号没有使用管理助手所需的权限。请联系管理员，或到「身份与权限」查看授权。',
  tenant_forbidden: '当前身份不能在这个范围管理项目。请在「身份与权限」核对有效授权后再试。',
  project_scope_mismatch: '这个项目不在当前选定的范围内。请改选范围后再试。',
  authorization_changed: '权限已变化，请刷新页面后按当前权限重试。',
  login_required: '登录已失效，请重新登录。',
  repository_not_found: '这个项目还没有启动，或当前账号看不到它。请到项目列表或身份与权限查看。'
};
function managementAccessMessage(err) {
  if (err && err.code && managementAccessHints[err.code]) return managementAccessHints[err.code];
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return '读取管理会话超时，请重试。这不代表你的权限被撤销。';
  return (err && err.message) ? '无法打开管理会话：' + readErrorText(err) : '暂时无法连接管理助手，请重试。';
}

const managementFailureHints = {
  task_already_delivered: '任务已经交付，这个操作不能再执行。',
  management_revision_conflict: '提交之后项目配置的版本变了，命令没有执行；先读回当前配置再提交。',
  authorization_changed: '发起人的权限在命令提交之后变了，命令没有执行。',
  execution_context_changed: '执行上下文（权限或环境）在提交之后变了，命令没有执行。',
  command_operator_required: '只有这条命令的发起人可以执行它。',
  approval_retired: '这条命令来自审批流程取消之前，已经作废，不会执行。',
  role_setting_forbidden: '这个项目不允许通过这些字段修改角色。',
  external_result_unknown: '外部调用可能已经生效，对账回读之前不知道结果；不要重复提交。',
  management_tool_failed: '服务端在处理这条命令时出错，命令没有完成。'
};
const managementChannels = { api: '接口调用', console: '控制台', im: '即时消息' };
const managementStateTone = { succeeded: 'success', failed: 'danger', rejected: 'warning', unknown: 'warning', pending: 'warning', executing: 'warning', not_operator: 'warning' };
// The target keys this page can name; a key it does not know keeps its own name.
const managementTargetNames = { project_id: '项目', task_id: '任务', workflow_id: '工作类型', repository_id: '仓库' };
// A command receipt has an address of its own (#235). It renders the one GET /api/management/commands/<id> the console
// already exposes and nothing else, and it is read-only: no approval, retry or reconcile, so a bookmarked receipt can
// never turn into a second execution.
// #382: the same receipt address can be routed twice while the shell is still booting (a hashchange while the login
// form's start() is finishing its own reads, then start()'s trailing route). The page keeps the id it has already read
// so the second render does not issue a second GET; leaving for any other page clears it, so a later visit reads again.
let receiptShownId = null, receiptLoading = null;
function hideManagementReceiptPage(keepShown = false) {
  const page = document.getElementById('management-receipt-page'); if (page) page.hidden = true;
  if (!keepShown) receiptShownId = null;
}
// The console's link() only builds absolute http(s) anchors, so a hash address or an API path needs a plain anchor:
// a receipt page that looks like a link but is not one would be worse than no link at all.
function managementReceiptLink(href, caption) {
  const anchor = element('a', caption); anchor.href = href;
  if (/^https?:/.test(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
  return anchor;
}
function managementReceiptPage() {
  let page = document.getElementById('management-receipt-page'); if (page) return page;
  page = element('section', '', 'project-page'); page.id = 'management-receipt-page'; page.hidden = true;
  page.setAttribute('aria-label', '命令回执详情');
  const body = element('div', '', 'project-body settings-body'), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content');
  nav.setAttribute('aria-label', '命令回执导航');
  body.append(nav, content); page.append(body); document.getElementById('workspace').append(page);
  return page;
}
function receiptSourceLine(receipt) {
  if (!receipt.source_conversation) return element('span', '这条回执没有记录来源会话（更早的命令不写这一列）。', 'muted');
  const line = element('span', ''); line.dataset.receiptSource = '';
  line.append(element('code', receipt.source_conversation), document.createTextNode(' · 消息 '),
    element('code', receipt.source_message || '未记录'), document.createTextNode(' '),
    managementReceiptLink(consolePageAddress('management', receipt.project_id || null), '回到管理会话'));
  return line;
}
async function renderManagementReceiptPage(id) {
  const page = managementReceiptPage(), nav = page.querySelector('.project-nav'), content = page.querySelector('.project-content');
  // A completed render of this id is already on screen: show it instead of reading the same receipt again.
  if (receiptShownId === id) { page.hidden = false; return; }
  page.hidden = false;
  const back = element('a', '返回管理助手'); back.href = consolePageAddress('management'); nav.replaceChildren(back);
  content.replaceChildren(element('p', '正在加载命令回执…', 'muted'));
  let receipt;
  try {
    // A read for this id that is still in flight is shared instead of started again.
    const pending = receiptLoading?.id === id ? receiptLoading.promise : null;
    if (pending) receipt = await pending;
    else {
      const load = { id }; load.promise = api('/api/management/commands/' + encodeURIComponent(id)); receiptLoading = load;
      try { receipt = await load.promise; } finally { if (receiptLoading === load) receiptLoading = null; }
    }
  }
  // #540: remember the id whose read failed, exactly as a completed render does. The console routes this address again
  // by itself while the shell is still booting (#382); without the id that second route reads the receipt again and a
  // success it did not have when the reader asked silently replaces the failure. Leaving the page clears the id and a
  // reload is a new document, so a person who asks again still reads.
  catch (err) {
    if (page.hidden) return;
    receiptShownId = id;
    content.replaceChildren(element('p', '读不到这条回执：' + readErrorText(err), 'view-error'));
    return;
  }
  if (page.hidden) return;
  back.href = consolePageAddress('management', receipt.project_id || null);
  if (receipt.project_id) {
    const roles = element('a', '项目配置'); roles.href = '#/projects/' + receipt.project_id + '/roles';
    const activity = element('a', '任务'); activity.href = '#/projects/' + receipt.project_id + '/activity';
    nav.append(roles, activity);
  }
  content.replaceChildren(...managementReceiptBody(receipt));
  receiptShownId = id;
  window.scrollTo(0, 0);
}
function managementReceiptBody(receipt) {
  const operation = managementOperationLabels[receipt.operation] ?? receipt.operation, nodes = [];
  // The same state machine the transcript card uses: the page never restates a state the console can already name.
  const shown = receipt.state === 'failed' && receipt.result?.error === 'command_operator_required' ? 'not_operator' : receipt.state;
  const [caption, explanation] = managementCommandState(shown);
  const head = element('div', '', 'management-receipt-head'), state = badge(caption, managementStateTone[shown] ?? 'warning');
  state.dataset.receiptState = '';
  head.append(element('h1', '命令回执'), state); nodes.push(head);
  nodes.push(element('p', explanation, 'management-receipt-page-note'));
  // The project is named from the list the console already loaded; the initiator is only called "you" when it is you.
  const project = (typeof repositories === 'undefined' ? [] : repositories).find(row => String(row.id) === String(receipt.project_id));
  const projectLine = element('span', project ? project.full_name : `项目 ${receipt.project_id}`);
  if (project) projectLine.append(' · ', managementReceiptLink('#/projects/' + receipt.project_id + '/basic', '打开项目'));
  const initiator = element('span', ''); initiator.dataset.receiptInitiator = '';
  initiator.textContent = me && String(receipt.principal_id) === String(me.id)
    ? '你（当前登录用户） · ' + receipt.principal_id
    : receipt.principal_id + '（不是当前登录用户；只有发起人可以执行或对账这条命令）';
  const version = receipt.before_revision ? receipt.before_revision.slice(0, 12) + ' → ' + (receipt.after_revision ?? receipt.before_revision).slice(0, 12) : null;
  const overview = card('这次操作');
  overview.append(facts([['操作', `${operation}（${receipt.operation}）`], ['项目', projectLine], ['发起人', initiator],
    ['渠道', managementChannels[receipt.channel] ?? receipt.channel], ['版本', version],
    ['提交时间', timestamp(receipt.created_at)], ['更新时间', timestamp(receipt.updated_at)],
    ['参数指纹', receipt.parameter_hash ? receipt.parameter_hash.slice(0, 12) : null],
    // #355: a receipt names the conversation and the message it came from, so a reader can walk back to the request
    // that produced it instead of matching timestamps by eye. Older receipts without those columns say so.
    ['来源', receiptSourceLine(receipt)]]));
  // The key alone only means something with the rule it drives (#355): the same principal submitting the same key and
  // the same arguments gets this receipt back instead of a second execution. A receipt without one says so, because an
  // empty cell would read as "a repeat always runs again".
  const idempotency = element('div', ''); idempotency.dataset.receiptIdempotency = '';
  idempotency.append(facts([['幂等键', receipt.idempotency_key]]));
  idempotency.append(element('p', receipt.idempotency_key
    ? '同一个幂等键重放不会重复执行：同一发起人用同一个键和同一份参数再提交，服务端直接返回这份回执，不再执行一次。'
    : '这条回执没有幂等键：服务端无法用它识别重放，重复提交会再执行一次。', 'muted'));
  overview.append(idempotency);
  // What the command is expected to affect. The server records it as the notice it writes together with an effect
  // (workflow.update, manager.update); a notice without an effect is the outcome or a caveat, so it stays in the record
  // section and this row keeps its honest fallback. A dedicated impact field wins, and a row-level copy is still honored.
  const effectNotice = receipt.result?.effect ? receipt.result?.notice : null;
  const impactValue = [receipt.result?.impact, effectNotice, receipt.impact].find(value => typeof value === 'string' && value.trim());
  const impact = element('div', ''); impact.dataset.receiptImpact = '';
  impact.append(facts([['影响', impactValue]]));
  impact.append(element('p', impactValue ? '上面是服务端为这次操作记录的影响描述。' : '服务端未提供影响描述：这次操作会影响什么，只能从「具体变更」和「配置差异」里读。', 'muted'));
  overview.append(impact);
  nodes.push(overview);
  // What the command named and what it wrote, as fields instead of one JSON blob.
  const change = card('具体变更'), target = element('div', ''); target.dataset.receiptTarget = '';
  target.append(facts(Object.entries(receipt.target || {}).map(([key, value]) => [managementTargetNames[key] ?? key, typeof value === 'object' ? JSON.stringify(value) : String(value)])));
  if (!target.querySelector('dd')) target.append(element('p', '这次操作没有指定目标字段。', 'muted'));
  const args = element('div', ''); args.dataset.receiptArguments = '';
  args.append(facts(Object.entries(receipt.arguments || {}).map(([key, value]) => [key, value === null || value === undefined ? '未设置' : typeof value === 'object' ? JSON.stringify(value) : String(value)])));
  if (!args.querySelector('dd')) args.append(element('p', '这次操作没有提交参数。', 'muted'));
  change.append(target, args); nodes.push(change);
  // The recorded diff, one row per field: before, after. A command that records no diff says so rather than showing an
  // empty table that could be read as "nothing changed".
  const difference = card('配置差异'), differenceBox = element('div', ''); differenceBox.dataset.receiptDiff = '';
  const before = receipt.result?.diff?.before, after = receipt.result?.diff?.after;
  const text = value => value === null || value === undefined || value === '' ? '未设置' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (before || after) {
    const table = element('table', '', 'rule-table'), thead = element('thead', ''), tbody = element('tbody', ''), headRow = element('tr', '');
    for (const column of ['字段', '之前', '之后']) headRow.append(element('th', column));
    thead.append(headRow);
    for (const key of [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]) {
      const row = element('tr', ''); row.append(element('td', key), element('td', text(before?.[key])), element('td', text(after?.[key]))); tbody.append(row);
    }
    table.append(thead, tbody); const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); differenceBox.append(wrap);
  } else differenceBox.append(element('p', '这个操作不回执字段级差异；执行结果写在下面的回执里。', 'muted'));
  difference.append(differenceBox); nodes.push(difference);
  // The outcome gets the section its state deserves (#355): a success, a refusal and an unconfirmed result read
  // differently, so they never share one block. What is not the outcome — links, notices, the receipt id — stays in its
  // own record section, so a refusal cannot be mistaken for a result.
  const resultTitles = { succeeded: '执行结果', failed: '执行失败', not_operator: '未执行', rejected: '未执行', unknown: '结果待确认', pending: '执行进度', executing: '执行进度' };
  const result = card(resultTitles[shown] ?? '执行结果'), resultBox = element('div', ''); resultBox.dataset.receiptResult = shown;
  const outcome = receipt.result || {};
  if (receipt.state === 'failed' || shown === 'not_operator') {
    resultBox.append(element('p', '命令未执行：' + (managementFailureHints[outcome.error] ?? '服务端拒绝了这个操作，原因见下方代码。')));
    resultBox.append(facts([['错误代码', String(outcome.error ?? '未提供')], ['HTTP 状态', outcome.http_status ? String(outcome.http_status) : null]]));
  } else if (receipt.state === 'unknown') {
    resultBox.append(element('p', '结果待确认：外部调用可能已经生效，对账回读之前不要重复提交这条命令。'));
    resultBox.append(facts([['错误代码', String(outcome.error ?? '未提供')]]));
  } else if (receipt.state === 'pending' || receipt.state === 'executing') {
    resultBox.append(element('p', '结果还没出来：执行结束后回执会更新，刷新这一页即可看到最新状态。'));
  } else if (shown === 'rejected') {
    resultBox.append(element('p', '这条命令在审批流程取消前被拒绝，没有执行，也没有修改任何东西。'));
  } else if (shown === 'succeeded') {
    // A successful command says so in its own words instead of leaving an empty section beside the state badge.
    resultBox.append(element('p', '已执行，服务端没有记录错误。'));
    if (receipt.after_revision) resultBox.append(facts([['执行后版本', receipt.after_revision.slice(0, 12)]]));
  }
  result.append(resultBox); nodes.push(result);
  // Everything that is a record of the command rather than its outcome: server notes, the links it produced and the
  // receipt id with the raw JSON behind it.
  const recordCard = card('回执记录'), recordBox = element('div', ''); recordBox.dataset.receiptRecord = '';
  if (outcome.notice) recordBox.append(element('p', String(outcome.notice)));
  if (outcome.pr_url) recordBox.append(managementReceiptLink(String(outcome.pr_url), '查看配置 PR（待合入）'));
  if (outcome.configuration_url) recordBox.append(managementReceiptLink(String(outcome.configuration_url), '查看当前配置'));
  const taskId = receipt.target?.task_id ?? (receipt.operation === 'task.create' ? outcome.id : null);
  if (taskId) recordBox.append(managementReceiptLink('#/projects/' + receipt.project_id + '/activity', '查看任务 ' + taskId));
  if (outcome.rollback) recordBox.append(element('p', '这条回执带有原值回滚；需要回滚时在管理助手里发起，会重新校验权限与版本。', 'muted'));
  const record = element('p', ''); record.append('回执 ID ' + receipt.id + ' · ', managementReceiptLink('/api/management/commands/' + receipt.id, '原始回执（JSON）'));
  recordBox.append(record);
  recordCard.append(recordBox); nodes.push(recordCard);
  // Read-only by design: retry and reconcile are executions, and they belong to the conversation that can show them.
  nodes.push(element('p', '这一页只读：不提供批准、重试或对账。需要重试或对账时回管理助手，那里的操作会重新校验权限与版本。', 'management-receipt-page-note'));
  return nodes;
}
