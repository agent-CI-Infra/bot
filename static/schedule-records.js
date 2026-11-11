// Keep an uncertain retry's identity across reopening this page, but never across logins.
let notificationTraceOwner = null;
const notificationTraceCommands = new Map();
function renderScheduleRecords(host, { project, read, invalidate }) {
  const owner = JSON.stringify([me?.id, me?.csrf_token]);
  if (notificationTraceOwner !== owner) { notificationTraceCommands.clear(); notificationTraceOwner = owner; }
  const pending = notificationTraceCommands.get(project) || {};
  notificationTraceCommands.set(project, pending);
  const address = location.hash, root = element('section', '', 'schedule-records');
  root.setAttribute('aria-label', '计划与通知记录'); host.append(root);
  const live = () => root.isConnected && address === location.hash && owner === JSON.stringify([me?.id, me?.csrf_token]);
  const title = element('h4', '运行与通知记录'), tabs = element('div', '', 'schedule-record-tabs');
  const status = element('p', '选择记录类型，读取服务端保存的事实。', 'muted'); status.setAttribute('role', 'status');
  const receipt = element('section', '', 'schedule-record-receipt'), list = element('div'), paging = element('div', '', 'schedule-record-paging');
  receipt.setAttribute('aria-label', '通知补发回执'); receipt.setAttribute('aria-live', 'polite');
  root.append(title, tabs, status, receipt, list, paging);
  const labels = { list_occurrences: '查看运行与跳过原因', list_notification_deliveries: '查看通知及失败队列', list_schedule_audit: '查看触发审计' };
  const captions = { pending:'待发送', sending:'发送中', sent:'已送达', retry:'等待重试', unknown:'结果未知', dead:'死信', blocked:'已阻止', skipped:'已跳过', succeeded:'执行成功', failed:'执行失败', dispatched:'已交给业务执行', running:'执行中', queued:'待执行', cancelled:'已取消' };
  const caption = value => captions[value] || value || '未知';
  const at = (value, zone = 'UTC') => {
    if (value == null) return '未记录';
    try { return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle:'medium', timeStyle:'medium', hour12:false }).format(new Date(value)) + ' · ' + zone; }
    catch { return '时间或时区无法识别'; }
  };
  const facts = entries => {
    const dl = element('dl');
    for (const [label, value] of entries) { dl.append(element('dt', label), element('dd', value == null ? '未记录' : String(value))); }
    return dl;
  };
  let operation = 'list_notification_deliveries', generation = 0, revision, loading = false, next = null, records = [], observedAt = null;
  function refused(error) {
    if (!live()) return true;
    if ([401,403].includes(error.status) && !error.code?.startsWith('channel_')) {
      notificationTraceCommands.delete(project); ++generation; root.replaceChildren(); invalidate(error); return true;
    }
    return false;
  }
  function showReceipt() {
    if (!live()) return;
    receipt.replaceChildren();
    if (!pending.envelope) return;
    const current = pending.receipt;
    if (current?.state === 'succeeded') {
      delete pending.envelope; delete pending.receipt;
      status.textContent = '上一笔补发已排队，实际送达状态请读取通知记录。';
      void load(false); return;
    }
    receipt.append(element('h5', current ? '补发操作：' + current.state : '补发结果待核对'), note('项目 ' + project + ' · 通知 ' + pending.envelope.arguments.id + '。核对沿用原操作编号，不另建补发请求。'));
    if (current) receipt.append(note('回执编号：' + current.id));
    if (current && ['failed','rejected'].includes(current.state)) receipt.append(note(current.result?.error || current.state), button('关闭失败回执并刷新记录', () => {
      if (!live()) return; delete pending.envelope; delete pending.receipt; showReceipt(); void load(false);
    }, 'quiet'));
    else receipt.append(note(current?.state === 'awaiting_approval' ? '等待现有组织策略审批，尚未补发。' : '尚未确认执行结果；请核对原回执。'), button(current ? '刷新通知补发回执' : '核对同一次通知补发', () => send(true), 'quiet'));
    for (const control of receipt.querySelectorAll('button')) control.disabled = !!pending.sending;
  }
  async function send(check = false) {
    if (!live() || pending.sending || !pending.envelope) return;
    pending.sending = true; showReceipt(); draw();
    try {
      const result = check && pending.receipt ? await api('/api/management/commands/' + encodeURIComponent(pending.receipt.id)) : await api('/api/management/commands', 'POST', pending.envelope);
      // Preserve a late receipt for this login/project; it cannot repaint another view.
      pending.receipt = result;
      if (!live()) return;
      if (result.state === 'succeeded') {
        delete pending.envelope; delete pending.receipt;
        status.textContent = '补发已排队；当前回执不代表通知已经送达。';
        await load(false);
      }
    } catch (error) {
      if (!live() || refused(error)) return;
      // Only a definitive refusal permits a new operation. Network failures retain the same key.
      if (error.status >= 400 && error.status < 500 && error.code !== 'idempotency_conflict' && !check) { delete pending.envelope; delete pending.receipt; }
      status.textContent = error.message + '。先刷新记录或核对原操作；不会自动重复补发。';
    } finally { pending.sending = false; pending.update?.(); }
  }
  async function retry(row, acknowledged) {
    if (!live() || pending.envelope || pending.sending) return;
    if (row.state === 'unknown' && !acknowledged) { status.textContent = '结果未知可能已经送达；请先接受可能重复送达的风险。'; return; }
    if (!await askConfirm({ title: row.state === 'unknown' ? '接受重复风险并人工补发？' : '人工补发这条通知？', body: ['通知 ' + row.id, row.state === 'unknown' ? '上一次结果未知，接收方可能已经收到。再次发送可能重复送达。' : '补发仍检查当前身份、目的地受众、计划状态和次数限制。'], action:'确认人工补发' })) return;
    if (!live() || pending.envelope) return;
    const key = 'console-notification:' + crypto.randomUUID();
    pending.envelope = { operation:'notification.retry', target:{ project_id:project }, arguments:{ id:row.id, acknowledge_unknown:row.state === 'unknown' && acknowledged }, expected_revision:revision, idempotency_key:key, source_conversation:'console:notifications', source_message:key };
    delete pending.receipt; await send();
  }
  function delivery(row) {
    const card = element('details', '', 'schedule-record'); card.dataset.recordId = row.id;
    card.append(element('summary', caption(row.state) + ' · ' + (row.origin?.name || (row.schedule_id ? '定时计划' : '事件订阅')) + ' · ' + at(row.created_at)));
    const steps = element('ol', '', 'schedule-record-timeline'), origin = row.origin || {}, zone = origin.timezone || row.payload?.report?.window?.timezone || 'UTC';
    const step = (label, content) => { const li = element('li'); li.append(element('h5',label), content); steps.append(li); };
    step('触发来源', facts([['类型',row.schedule_id ? '定时计划' : '事件订阅'],['名称',origin.name || '未读取到来源名称'],['来源编号',row.schedule_id || row.subscription_id],['保存版本',origin.revision ?? row.subscription_revision],['逻辑触发标识',row.logical_key],['关联事件',row.incident]]));
    const window = row.payload?.report?.window;
    step('逻辑窗口与执行', facts([['逻辑触发时间',at(origin.logical_at,zone)],['日报窗口',window ? '[' + at(window.start,window.timezone) + ', ' + at(window.end,window.timezone) + ')' : '此记录未保存日报窗口'],['运行编号',origin.run_id],['执行结果',origin.state ? caption(origin.state) : row.subscription_id ? '事件直接形成通知，不代表一次定时运行' : '未读取到执行结果'],['执行原因',origin.reason || '未记录异常原因']]));
    if (row.payload?.events?.length) {
      const events = element('ul');
      for (const event of row.payload.events) events.append(element('li', event.type + ' · ' + at(event.at,zone) + ' · 事件序号 ' + event.sequence));
      step('聚合观测事件',events);
    }
    const destination = row.destination || {};
    step('接收范围',facts([['会话类型',destination.type === 'group' ? '群聊' : ['private','p2p'].includes(destination.type) ? '私聊' : '未核验'],['会话',destination.chat_id || row.destination_id],['当前目的地核验',destination.valid ? '当前有效；实际发送前仍重新核验' : '未通过：' + (destination.reason || '未记录')],['发送记录中的执行身份',row.actor_id]]));
    if (!destination.valid) {
      const help = element('li'); help.append(note('目的地或受众失效时不会绕过校验补发。请在身份与权限页重新验证私聊或群聊助手的项目范围。'),consoleLink('#/identity','前往身份与权限')); steps.append(help);
    }
    const attempts = element('ul');
    for (const attempt of row.attempts_detail || []) attempts.append(element('li', '第 ' + attempt.attempt + ' 次 · ' + caption(attempt.state) + ' · ' + at(attempt.started_at) + ' → ' + at(attempt.finished_at) + (attempt.error ? ' · ' + attempt.error : '')));
    if (!attempts.childElementCount) attempts.append(element('li','尚无保存的发送尝试；不代表已送达。'));
    step('发送尝试',attempts);
    step('当前结果',facts([['状态',caption(row.state)],['原因',row.last_error || '未记录异常原因'],['下次尝试', ['pending','retry'].includes(row.state) ? at(row.next_attempt) : '未安排'],['送达时间',at(row.sent_at)],['远端消息编号',row.remote_message_id],['人工补发次数',row.manual_retries]]));
    card.append(steps);
    if (row.payload?.text) { const content=element('details'); content.append(element('summary','查看实际通知正文'),element('pre',row.payload.text)); card.append(content); }
    if (['dead','unknown'].includes(row.state)) {
      const acknowledge=document.createElement('input'); acknowledge.type='checkbox'; acknowledge.setAttribute('aria-label','接受未知结果可能重复送达');
      if (row.state === 'unknown') card.append(field('接受未知结果可能重复送达',acknowledge));
      const action=button('人工补发 ' + row.id.slice(0,12),()=>retry(row,acknowledge.checked),'quiet'); action.disabled=!!pending.envelope || !!pending.sending; card.append(action);
    }
    return card;
  }
  function draw() {
    if (!live()) return;
    const expanded = new Set([...list.querySelectorAll('details.schedule-record[open]')].map(node=>node.dataset.recordId));
    list.replaceChildren();
    for (const row of records) {
      let card;
      if (operation === 'list_notification_deliveries') card=delivery(row);
      else {
        card=element('details','','schedule-record'); card.dataset.recordId=String(row.id);
        const plan=row.snapshot?.plan;
        card.append(element('summary',operation === 'list_occurrences' ? caption(row.state)+' · '+(plan?.name || row.schedule_id)+' · '+at(row.logical_at,plan?.timezone || 'UTC') : row.action+' · '+at(row.created_at)),facts(operation === 'list_occurrences' ? [['来源',row.source],['计划编号',row.schedule_id],['保存版本',row.revision],['运行编号',row.run_id],['状态',caption(row.state)],['原因',row.reason],['开始',at(row.started_at)],['结束',at(row.finished_at)]] : [['对象',row.resource_id],['动作',row.action],['发起人',row.initiator],['执行身份',row.actor_id],['授权版本',row.authorization_revision],['配置版本',row.revision],['操作来源',row.source]]));
        if (row.result?.report?.text) card.append(element('pre',row.result.report.text));
        if (row.detail && Object.keys(row.detail).length) { const detail=element('details'); detail.append(element('summary','审计详情'),element('pre',JSON.stringify(row.detail,null,2))); card.append(detail); }
      }
      card.open=expanded.has(String(row.id)); list.append(card);
    }
    paging.replaceChildren();
    if (next != null) { const more=button('加载更多记录',()=>load(true),'quiet'); more.disabled=loading; paging.append(more); }
  }
  async function load(append) {
    if (!live() || loading) return;
    const request=++generation, selected=operation, offset=append ? next : 0;
    loading=true; status.textContent=append ? '正在读取更多记录…' : '正在读取，当前状态待核验…'; draw();
    try {
      const value=await read(selected,{limit:20,offset:offset || 0});
      if (!live() || request!==generation || selected!==operation) return;
      revision=value.revision; observedAt=Date.now();
      const merged=append ? [...records,...value.records] : value.records;
      records=[...new Map(merged.map(row=>[String(row.id),row])).values()]; next=value.next_offset;
      status.textContent=records.length ? '已读取 '+records.length+' 条记录 · '+at(observedAt)+'。这是保存记录，实际发送仍会重新核验。' : '该范围没有保存的记录；不能据此判定全部发送成功。';
    } catch (error) {
      if (!live() || request!==generation || refused(error)) return;
      status.textContent='本次读取失败，最新状态未知'+(records.length ? '；保留上次读取的 '+records.length+' 条。读取于 '+at(observedAt)+'。' : '。')+' '+error.message;
    } finally { if (live() && request===generation) { loading=false; draw(); } }
  }
  for (const [key,label] of Object.entries(labels)) tabs.append(button(label,()=>{
    if (!live()) return; ++generation; loading=false; operation=key; records=[]; next=null; void load(false);
  },'quiet'));
  tabs.append(button('重新读取当前记录',()=>load(false),'quiet'));
  pending.update = () => { if (live()) { showReceipt(); draw(); } };
  showReceipt();
}
