async function renderSchedules(panel, project) {
  panel.replaceChildren(); panel.className = 'schedule-panel'; panel.append(element('h3', '定时计划与通知'));
  const status = element('p', '', 'muted'); status.setAttribute('role', 'status'); panel.append(status);
  const target = { project_id: project }, endpoint = '/api/management';
  const read = (operation, args = {}) => api(endpoint + '/query', 'POST', { operation, target, arguments: args });
  const [plans, destinations, subscriptions] = await Promise.all([read('list_schedules'), read('list_schedule_destinations'), read('list_subscriptions')]);
  let revision = plans.revision;
  const command = async (operation, args) => {
    try {
      const key = crypto.randomUUID();
      const receipt = await api(endpoint + '/commands', 'POST', { operation, target, arguments: args, expected_revision: revision,
        idempotency_key: key, source_conversation: 'console:schedules', source_message: key });
      if (receipt.state !== 'succeeded') { status.textContent = '操作未成功：' + (receipt.result?.error ?? receipt.state); return; }
      await renderSchedules(panel, project);
    } catch (e) { status.textContent = e.message; }
  };
  const select = (label, options) => {
    const input = document.createElement('select'); input.setAttribute('aria-label', label);
    for (const [value, caption] of options) { const o = element('option', caption); o.value = value; input.append(o); }
    return input;
  };
  const input = (label, value, type = 'text') => { const node = document.createElement('input'); node.type = type; node.value = value; node.setAttribute('aria-label', label); return node; };
  const destinationOptions = destinations.destinations.map(d => [d.id, (d.type === 'group' ? '群聊 ' : '私聊 ') + d.chat_id]);
  for (const s of plans.schedules) if (!destinationOptions.some(d => d[0] === s.spec.destination_id)) destinationOptions.push([s.spec.destination_id, '目的地已失效 · ' + s.spec.destination_id.slice(0, 8)]);
  panel.append(note('通知目的地在「身份与权限」页登记：私聊在「我的飞书私信会话」，群聊在对应的群聊助手处（项目须在该群的范围内）。每次发送仍检查当前权限和范围。'));
  const form = document.createElement('form'), chosen = select('编辑计划', [['', '新建计划'], ...plans.schedules.filter(s => s.state !== 'deleted').map(s => [s.id, s.spec.name + ' · ' + s.state])]);
  const name = input('计划名称', '项目日报'), kind = select('执行身份类型', [['personal', '个人计划'], ['project', '项目服务计划']]);
  const actor = select('项目服务身份', (destinations.services ?? []).map(s => [s.id, s.maintenance + ' · ' + s.id.slice(0, 8)]));
  const maintainer = select('项目维护人', (destinations.maintainers ?? [{ id: me.id, name: me.username }]).map(s => [s.id, s.name]));
  const zone = input('计划时区', 'Asia/Shanghai'), recurrence = select('重复方式', [['cron', 'Cron（本地时间）'], ['interval', '固定周期']]);
  const cron = input('Cron 表达式', '0 9 * * *'), interval = input('固定周期分钟', '1440', 'number');
  const start = input('有效期开始', new Date().toISOString(), 'text'), end = input('有效期结束（可留空）', '', 'text');
  const destination = select('计划目的地', destinationOptions), workflow = select('执行内容', [['report.daily', '项目日报'], ['manager.check', 'Manager 定时检查'], ['release.scheduled', '定时发布（处理器未就绪时不支持）']]);
  const misfire = select('遗漏策略', [['skip', '跳过遗漏'], ['once', '宽限期内只补一次']]), grace = input('宽限期分钟', '1', 'number');
  const limits = {};
  const budgetBox = element('details', ''); budgetBox.append(element('summary', '运行限制'));
  for (const [key, label, value] of [['concurrency', '计划并发', 1], ['runtime_ms', '最长运行毫秒', 60000], ['runs', '每天运行次数', 100], ['model_calls', '每天模型调用次数', 0], ['cost_micros', '每天费用上限（微单位）', 0], ['retries', '最大自动重试', 3], ['manual_retries', '人工补发次数上限', 1], ['notifications_per_minute', '每分钟通知数', 10]]) {
    limits[key] = input(label, String(value), 'number'); budgetBox.append(field(label, limits[key]));
  }
  let original = null;
  const syncFields = () => {
    if (actor.parentElement) actor.parentElement.hidden = kind.value === 'personal';
    if (maintainer.parentElement) maintainer.parentElement.hidden = kind.value === 'personal';
    if (cron.parentElement) cron.parentElement.hidden = recurrence.value !== 'cron';
    if (interval.parentElement) interval.parentElement.hidden = recurrence.value !== 'interval';
  };
  kind.onchange = syncFields; recurrence.onchange = syncFields;
  const spec = () => ({ ...(original?.spec ?? {}), name: name.value, kind: kind.value, actor_id: kind.value === 'personal' ? me.id : actor.value,
    owner_id: original?.spec.owner_id ?? me.id, maintainer_id: kind.value === 'personal' ? me.id : maintainer.value,
    workflow: workflow.value, parameters: original?.spec.parameters ?? {}, timezone: zone.value,
    cron: recurrence.value === 'cron' ? cron.value : undefined, interval_ms: recurrence.value === 'interval' ? Number(interval.value) * 60000 : undefined,
    start_at: Date.parse(start.value), end_at: end.value ? Date.parse(end.value) : undefined, enabled: original ? original.state === 'active' : true,
    misfire: misfire.value, grace_ms: Number(grace.value) * 60000, destination_id: destination.value,
    limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Number(value.value)])) });
  const parsed = element('pre', ''); parsed.setAttribute('aria-label', '计划预览');
  const fill = () => {
    original = plans.schedules.find(s => s.id === chosen.value) ?? null; if (!original) return;
    const p = original.spec; name.value = p.name; kind.value = p.kind; actor.value = p.actor_id; maintainer.value = p.maintainer_id;
    zone.value = p.timezone; recurrence.value = p.cron ? 'cron' : 'interval'; cron.value = p.cron ?? ''; interval.value = String((p.interval_ms ?? 86400000) / 60000);
    start.value = new Date(p.start_at).toISOString(); end.value = p.end_at ? new Date(p.end_at).toISOString() : ''; destination.value = p.destination_id; workflow.value = p.workflow;
    misfire.value = p.misfire; grace.value = String(p.grace_ms / 60000); for (const [k, v] of Object.entries(p.limits)) limits[k].value = String(v);
    parsed.textContent = original.state + (original.reason ? ' · ' + original.reason : '') + '\n时区：' + p.timezone + '\n下次触发：' + (original.next_at ? new Date(original.next_at).toISOString() : '无') + '\n最近成功：' + (original.last_success ? new Date(original.last_success).toISOString() : '尚无') + '\n处理器：' + (original.supported ? '可用' : '不支持') + '\n维护人：' + p.maintainer_id;
    syncFields();
  };
  chosen.onchange = fill;
  form.append(field('编辑计划', chosen), field('计划名称', name), field('执行身份类型', kind), field('项目服务身份', actor), field('项目维护人', maintainer), field('执行内容', workflow),
    field('计划时区（IANA）', zone), field('重复方式', recurrence), field('Cron（分 时 日 月 周）', cron), field('固定周期分钟', interval), field('有效期开始（ISO 时间）', start), field('有效期结束（可留空）', end),
    field('遗漏策略', misfire), field('宽限期分钟', grace), field('计划目的地', destination), budgetBox,
    button('预览日报计划', async () => { try { const p = await read('preview_schedule', { plan: spec(), ...(original ? { schedule_id: original.id } : {}) }); revision = p.revision; parsed.textContent = '时区：' + p.timezone + '\n未来触发：\n' + p.future.map(t => new Date(t).toISOString()).join('\n') + '\n' + (p.report ? '以下为当前时间的样例日报；正式窗口截至逻辑触发时刻。\n' + p.report.text : p.supported ? '处理器已注册' : '处理器尚不支持'); } catch (e) { status.textContent = e.message; } }, 'quiet'), parsed);
  const save = element('button', '保存计划'); save.type = 'submit'; form.append(save);
  form.onsubmit = e => { e.preventDefault(); void command(original ? 'schedule.update' : 'schedule.register', original ? { id: original.id, revision: original.revision, plan: spec() } : { plan: spec() }); };
  for (const [action, label] of [['pause', '暂停计划'], ['resume', '恢复计划'], ['run-now', '立即运行一次'], ['delete', '删除计划']]) form.append(button(label, () => original ? command('schedule.' + action, { id: original.id, revision: original.revision }) : Promise.resolve(), 'quiet'));
  panel.append(form);
  syncFields();
  const subscriptionBox = element('section', ''); subscriptionBox.append(element('h4', '事件订阅'));
  let editingSubscription = null;
  const subName = input('订阅名称', '项目事件'), subDestination = select('订阅目的地', destinationOptions), subZone = input('订阅时区', 'Asia/Shanghai');
  const aggregate = input('聚合窗口分钟', '5', 'number'), quietStart = input('静默开始', '', 'time'), quietEnd = input('静默结束', '', 'time');
  const events = select('事件筛选', [['task.failed', '任务失败'], ['ci.failed,ci.recovered', 'CI 失败与恢复'], ['project.daily', '项目日报']]);
  const saveSubscription = button('创建事件订阅', () => {
    const subscription = { name: subName.value, destination_id: subDestination.value, events: events.value.split(','), projects: [project], aggregate_ms: Number(aggregate.value) * 60000, timezone: subZone.value,
      quiet_start: quietStart.value || undefined, quiet_end: quietEnd.value || undefined, enabled: editingSubscription ? editingSubscription.state === 'active' : true };
    return command(editingSubscription ? 'subscription.update' : 'notification.register', editingSubscription ? { id: editingSubscription.id, revision: editingSubscription.revision, subscription } : { subscription });
  }, 'quiet');
  subscriptionBox.append(field('订阅名称', subName), field('事件筛选', events), field('订阅目的地', subDestination), field('聚合窗口分钟', aggregate), field('订阅时区', subZone), field('静默开始', quietStart), field('静默结束', quietEnd), saveSubscription);
  for (const sub of subscriptions.subscriptions) {
    const row = element('article', ''); row.append(element('p', sub.spec.name + ' · ' + sub.state + (sub.reason ? ' · ' + sub.reason : '') + ' · ' + sub.spec.events.join('、')));
    if (sub.state !== 'deleted') row.append(button('编辑订阅', () => {
      editingSubscription = sub; const s = sub.spec; subName.value = s.name; subDestination.value = s.destination_id; subZone.value = s.timezone; aggregate.value = String(s.aggregate_ms / 60000); quietStart.value = s.quiet_start ?? ''; quietEnd.value = s.quiet_end ?? '';
      const value = s.events.join(','); if (![...events.options].some(o => o.value === value)) { const o = element('option', s.events.join('、')); o.value = value; events.append(o); }
      events.value = value; saveSubscription.textContent = '保存订阅修改';
    }, 'quiet'));
    if (sub.state !== 'deleted') for (const [action, label] of [['pause', '暂停订阅'], ['resume', '恢复订阅'], ['delete', '解除订阅']]) row.append(button(label, () => command('subscription.' + action, { id: sub.id, revision: sub.revision }), 'quiet'));
    subscriptionBox.append(row);
  }
  panel.append(subscriptionBox);
  const diagnostic = element('pre', ''), retryActions = element('div', '', 'actions'); diagnostic.setAttribute('aria-label', '计划与通知记录');
  for (const [operation, label] of [['list_occurrences', '查看运行与跳过原因'], ['list_notification_deliveries', '查看通知及失败队列'], ['list_schedule_audit', '查看触发审计']]) panel.append(button(label, async () => {
    try {
      const result = await read(operation); diagnostic.textContent = JSON.stringify(result, null, 2); retryActions.replaceChildren();
      if (operation === 'list_notification_deliveries') for (const delivery of result.records.filter(d => ['dead', 'unknown'].includes(d.state))) {
        const acknowledge = input('接受未知结果可能重复送达', '', 'checkbox');
        if (delivery.state === 'unknown') retryActions.append(field('接受未知结果可能重复送达', acknowledge));
        retryActions.append(button('人工补发 ' + delivery.id.slice(0, 12), () => command('notification.retry', { id: delivery.id, acknowledge_unknown: delivery.state === 'unknown' && acknowledge.checked }), 'quiet'));
      }
    } catch (e) { status.textContent = e.message; }
  }, 'quiet'));
  panel.append(diagnostic, retryActions, button('刷新定时与通知', () => renderSchedules(panel, project), 'quiet'));
}
