// Unsaved forms and uncertain command keys belong to this login and project only.
let scheduleOwner = null;
const scheduleViews = new Map();
function resetScheduleViews() { scheduleOwner = null; scheduleViews.clear(); }
async function renderSchedules(panel, project) {
  const owner = JSON.stringify([me?.id, me?.actor?.tenant_id, me?.actor?.principal_id]);
  if (scheduleOwner !== owner) { resetScheduleViews(); scheduleOwner = owner; }
  const state = scheduleViews.get(project) || { selected: '', fields: null, envelope: null, receipt: null, sending: false };
  scheduleViews.set(project, state);
  const container = panel; panel = element('section', '', 'schedule-panel'); container.replaceChildren(panel);
  let accessLost = false;
  const live = () => !accessLost && panel.isConnected && scheduleOwner === owner && owner === JSON.stringify([me?.id, me?.actor?.tenant_id, me?.actor?.principal_id]);
  panel.append(element('h3', '定时计划与通知'));
  if (location.hash !== '#/projects/'+project+'/schedules') panel.append(consoleLink('#/projects/'+project+'/schedules','在项目页管理计划与通知'));
  const status = element('p', '', 'muted'); status.setAttribute('role', 'status'); panel.append(status);
  function revoked(error) {
    // Channel audience failures invalidate the destination, while project read authority may still be valid.
    if (error.code?.startsWith('channel_') || ![401,403].includes(error.status) || !live()) return false;
    accessLost = true; scheduleViews.delete(project); panel.replaceChildren(note('计划访问权限已失效，请按当前授权重新进入。')); return true;
  }
  const target = { project_id: project }, endpoint = '/api/management';
  const read = (operation, args = {}) => api(endpoint + '/query', 'POST', { operation, target, arguments: args });
  let plans, destinations, subscriptions;
  try { [plans, destinations, subscriptions] = await Promise.all([read('list_schedules'), read('list_schedule_destinations'), read('list_subscriptions')]); }
  catch (error) {
    if (!live()) return;
    if (revoked(error)) return;
    status.textContent = '计划上下文未能读取，数量及状态未知：' + error.message;
    panel.append(button('重新读取计划上下文', () => renderSchedules(container, project), 'quiet')); return;
  }
  if (!live()) return;
  let revision = plans.revision, activePreview = 0;
  const receiptBox = element('section', '', 'schedule-receipt'); receiptBox.setAttribute('aria-label', '计划操作回执'); receiptBox.setAttribute('aria-live', 'polite');
  const lock = () => {
    const blocked=state.sending || !!state.envelope;
    for (const control of panel.querySelectorAll('input,textarea,select,button')) if (!receiptBox.contains(control) && !control.closest('.schedule-records')) control.disabled=blocked || !!state.conflict && control.dataset.scheduleWrite==='1';
    for (const control of panel.querySelectorAll('[data-schedule-action]')) {
      const action=control.dataset.scheduleAction;
      control.disabled=blocked || !!state.conflict || !original || original.state==='deleted' || action==='pause' && original.state!=='active' || action==='resume' && original.state!=='paused' || action==='run-now' && (original.state!=='active' || !original.supported);
    }
    if(original){kind.disabled=true;actor.disabled=true;}
  };
  function showReceipt() {
    if (!live()) return; receiptBox.replaceChildren(); lock();
    if (!state.envelope) return;
    const receipt = state.receipt;
    receiptBox.append(element('h4', receipt ? '管理回执：' + receipt.state : '操作结果待核对'), note('操作绑定项目 ' + project + (state.envelope.arguments.id ? '、对象 ' + state.envelope.arguments.id : '') + '，核对仍使用同一次操作的幂等键。'));
    if (receipt) receiptBox.append(note('回执编号：' + receipt.id));
    if (receipt && ['failed','rejected'].includes(receipt.state)) {
      receiptBox.append(note(receipt.result?.error || receipt.state), button('返回计划草稿', async () => {
        state.conflict = /revision.*conflict|revision_changed/.test(state.receipt.result?.error || ''); state.envelope = null; state.receipt = null; await renderSchedules(container,project);
      }, 'quiet'));
    } else {
      receiptBox.append(note('尚未确认操作完成，先核对回执。'));
      const check = button(receipt ? '刷新计划操作回执' : '核对同一次计划操作', async () => {
        if (state.sending) return;
        if (!receipt) { await send(); return; }
        state.sending = true; showReceipt();
        try { state.receipt = await api(endpoint + '/commands/' + receipt.id); await finish(); }
        catch (error) { if (live() && !revoked(error)) status.textContent = error.message; }
        finally { state.sending = false; state.update?.(); }
      }, 'quiet'); check.disabled = state.sending; receiptBox.append(check);
    }
  }
  async function finish() {
    if (!live()) return;
    if (state.receipt?.state === 'succeeded') {
      // Running, pausing or changing a subscription does not save the plan form. Keep unrelated/newer edits.
      if (['schedule.register','schedule.update','schedule.delete'].includes(state.envelope?.operation) && state.fields === state.submittedFields) state.fields = null;
      state.envelope = null; state.receipt = null; state.sending = false; state.submittedFields = null;
      await renderSchedules(container, project);
    }
  }
  async function send() {
    if (!live() || state.sending || !state.envelope) return;
    const replay = !!state.uncertain; state.sending = true; showReceipt();
    try { state.receipt = await api(endpoint + '/commands', 'POST', state.envelope); state.uncertain = false; await finish(); }
    catch (error) {
      if (!live()) return;
      if (revoked(error)) return;
      if (!replay && error.status >= 400 && error.status < 500 && !error.message.includes('idempotency_conflict')) { state.envelope = null; state.receipt = null; state.conflict = /revision.*conflict|revision_changed/.test(error.message); }
      else state.uncertain = true;
      status.textContent = error.message + '。草稿已保留；先核对当前版本或原回执。';
    } finally { state.sending = false; state.update?.(); }
  }
  state.update = () => { if (!live()) return; if (state.receipt?.state === 'succeeded') void finish(); else showReceipt(); };
  const command = async (operation, args) => {
    if (!live() || state.envelope || state.sending) return;
    if (state.conflict) { status.textContent='请先重新读取计划，比较当前版本后明确保留草稿。'; return; }
    const key = 'console-schedule:' + crypto.randomUUID();
    state.envelope = { operation, target, arguments: args, expected_revision: revision,
      idempotency_key: key, source_conversation: 'console:schedules', source_message: key };
    state.receipt = null; state.uncertain = false; state.submittedFields = state.fields; await send();
  };
  const select = (label, options) => {
    const input = document.createElement('select'); input.setAttribute('aria-label', label); input.dataset.scheduleField = label;
    for (const [value, caption] of options) { const o = element('option', caption); o.value = value; input.append(o); }
    return input;
  };
  const input = (label, value, type = 'text') => { const node = document.createElement('input'); node.type = type; node.value = value; node.setAttribute('aria-label', label); node.dataset.scheduleField = label; return node; };
  const destinationOptions = destinations.destinations.map(d => [d.id, (d.type === 'group' ? '群聊 ' : '私聊 ') + d.chat_id]);
  for (const s of plans.schedules) if (!destinationOptions.some(d => d[0] === s.spec.destination_id)) destinationOptions.push([s.spec.destination_id, '目的地已失效 · ' + s.spec.destination_id.slice(0, 8)]);
  panel.append(note('目的地可直接选择你本人已绑定的飞书私聊，或你能管理、且范围包含本项目的群；保存时自动登记，无需先到其他页面操作。每次发送仍检查当前权限和范围。'));
  const form = document.createElement('form'), chosen = select('编辑计划', [['', '新建计划'], ...plans.schedules.filter(s => s.state !== 'deleted').map(s => [s.id, s.spec.name + ' · ' + s.state])]);
  const name = input('计划名称', '项目日报'), kind = select('执行身份类型', [['personal', '个人计划'], ['project', '项目服务计划']]);
  const actor = select('项目服务身份', (destinations.services ?? []).map(s => [s.id, s.maintenance + ' · ' + s.id.slice(0, 8)]));
  const maintainer = select('项目维护人', (destinations.maintainers ?? [{ id: me.id, name: me.username }]).map(s => [s.id, s.name]));
  const zone = input('计划时区', 'Asia/Shanghai'), recurrence = select('重复方式', [['cron', 'Cron（本地时间）'], ['interval', '固定周期']]);
  const cron = input('Cron 表达式', '0 9 * * *'), interval = input('固定周期分钟', '1440', 'number');
  const presets=[['0 9 * * *','每天 09:00'],['0 18 * * *','每天 18:00'],['0 9 * * 1','每周一 09:00'],['custom','自定义 Cron / 固定周期']];
  const preset=select('常用触发时间',presets),timeRules=element('details','','schedule-time-rules');
  timeRules.append(element('summary','高级时间规则（Cron / 固定周期）'),field('重复方式',recurrence),field('Cron（分 时 日 月 周）',cron),field('固定周期分钟',interval));
  const syncPreset=()=>{preset.value=recurrence.value==='cron'&&presets.some(([value])=>value===cron.value)?cron.value:'custom';timeRules.open=preset.value==='custom';};

  const start = input('有效期开始', new Date().toISOString(), 'text'), end = input('有效期结束（可留空）', '', 'text');
  const destination = select('计划目的地', destinationOptions), workflow = select('执行内容', [['report.daily', '项目日报'], ['manager.check', 'Manager 定时检查'], ['release.scheduled', '定时发布（处理器未就绪时不支持）']]);
  const instruction=document.createElement('textarea');instruction.rows=3;instruction.setAttribute('aria-label','定时检查内容');instruction.dataset.scheduleField='定时检查内容';
  const instructionField=field('定时检查内容',instruction);
  const misfire = select('遗漏策略', [['skip', '跳过遗漏'], ['once', '宽限期内只补一次']]), grace = input('宽限期分钟', '1', 'number');
  const limits = {};
  const budgetBox = element('details', ''); budgetBox.append(element('summary', '运行限制'));
  for (const [key, label, value] of [['concurrency', '计划并发', 1], ['runtime_ms', '最长运行毫秒', 60000], ['runs', '每天运行次数', 100], ['model_calls', '每天模型调用次数', 0], ['cost_micros', '每天费用上限（微单位）', 0], ['retries', '最大自动重试', 3], ['manual_retries', '人工补发次数上限', 1], ['notifications_per_minute', '每分钟通知数', 10]]) {
    limits[key] = input(label, String(value), 'number'); budgetBox.append(field(label, limits[key]));
  }
  const summary = element('section', '', 'schedule-list'); summary.setAttribute('aria-label','项目计划列表');
  summary.append(element('h4','计划列表'), note('时区和触发时间来自服务端记录；尚未成功或没有下次触发不会显示为零。'));
  const states = { active:'启用中',paused:'已暂停',deleted:'已删除',unsupported:'处理器未支持' };
  const time = (value,zone) => value == null ? '无记录' : new Date(value).toLocaleString(undefined,{timeZone:zone}) + ' · ' + zone;
  for (const item of plans.schedules) {
    const row = element('article', '', 'schedule-row'); row.append(element('strong',item.spec.name),note((states[item.state] || item.state) + (item.reason ? ' · '+item.reason : '')),
      facts([['身份',item.spec.kind === 'personal' ? '个人计划' : '项目服务计划'],['时区',item.spec.timezone],['下次触发',item.next_at == null ? '无下次触发' : time(item.next_at,item.spec.timezone)],['最近成功',item.last_success == null ? '尚无成功记录' : time(item.last_success,item.spec.timezone)],['维护人',(destinations.maintainers || []).find(person=>person.id===item.spec.maintainer_id)?.name || item.spec.maintainer_id],['处理器',item.supported ? '已注册' : '未支持，不表示可执行']]));
    if (item.state !== 'deleted') row.append(button('编辑计划：'+item.spec.name,()=>{chosen.value=item.id;chosen.dispatchEvent(new Event('change'));},'quiet'));
    summary.append(row);
  }
  if (!plans.schedules.length) summary.append(note('当前项目没有计划。')); panel.append(summary);
  let original = null, dirty = false;

  const syncFields = () => {
    instructionField.hidden=workflow.value!=='manager.check';
    if (actor.parentElement) actor.parentElement.hidden = kind.value === 'personal';
    if (maintainer.parentElement) maintainer.parentElement.hidden = kind.value === 'personal';
    if (cron.parentElement) cron.parentElement.hidden = recurrence.value !== 'cron';
    if (interval.parentElement) interval.parentElement.hidden = recurrence.value !== 'interval';
  };
  kind.onchange = syncFields; recurrence.onchange = syncFields; workflow.onchange=syncFields;
  preset.onchange=()=>{if(preset.value!=='custom'){recurrence.value='cron';cron.value=preset.value;}timeRules.open=preset.value==='custom';syncFields();};
  const spec = () => ({ ...(original?.spec ?? {}), name: name.value, kind: kind.value, actor_id: kind.value === 'personal' ? me.id : actor.value,
    owner_id: original?.spec.owner_id ?? me.id, maintainer_id: kind.value === 'personal' ? me.id : maintainer.value,
    workflow: workflow.value, parameters: {...(original?.spec.parameters ?? {}),...(workflow.value==='manager.check'?{instruction:instruction.value}:{})}, timezone: zone.value,
    cron: recurrence.value === 'cron' ? cron.value : undefined, interval_ms: recurrence.value === 'interval' ? Number(interval.value) * 60000 : undefined,
    start_at: Date.parse(start.value), end_at: end.value ? Date.parse(end.value) : undefined, enabled: original ? original.state === 'active' : true,
    misfire: misfire.value, grace_ms: Number(grace.value) * 60000, destination_id: destination.value,
    limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Number(value.value)])) });
  const parsed = element('pre', ''); parsed.setAttribute('aria-label', '计划预览');
  const contextMeta=element('p','','schedule-context');
  const updateMeta=()=>{contextMeta.textContent='执行时区：'+zone.value+' · 目的地：'+(destination.selectedOptions[0]?.textContent || '尚未选择');};
  const fill = () => {
    original = plans.schedules.find(s => s.id === chosen.value) ?? null; if (!original) return;
    const p = original.spec; name.value = p.name; kind.value = p.kind; actor.value = p.actor_id; maintainer.value = p.maintainer_id;
    zone.value = p.timezone; recurrence.value = p.cron ? 'cron' : 'interval'; cron.value = p.cron ?? ''; interval.value = String((p.interval_ms ?? 86400000) / 60000);
    start.value = new Date(p.start_at).toISOString(); end.value = p.end_at ? new Date(p.end_at).toISOString() : ''; destination.value = p.destination_id; workflow.value = p.workflow;
    misfire.value = p.misfire; grace.value = String(p.grace_ms / 60000); for (const [k, v] of Object.entries(p.limits)) limits[k].value = String(v);
    parsed.textContent = original.state + (original.reason ? ' · ' + original.reason : '') + '\n时区：' + p.timezone + '\n下次触发：' + (original.next_at ? new Date(original.next_at).toISOString() : '无') + '\n最近成功：' + (original.last_success ? new Date(original.last_success).toISOString() : '尚无') + '\n处理器：' + (original.supported ? '可用' : '不支持') + '\n维护人：' + p.maintainer_id;
    instruction.value=p.parameters?.instruction || ''; syncPreset(); syncFields(); updateMeta();
  };
  chosen.onchange = async () => {
    const id = chosen.value;
    if (dirty && !await askConfirm({title:'切换计划并丢弃未保存修改？',body:['当前计划的未保存修改将被清除。'],action:'切换计划'})) { chosen.value=state.selected; return; }
    if (!live()) return; state.selected=id; state.fields=null; dirty=false;
    if (!id) { await renderSchedules(container,project); return; }
    fill(); ++activePreview; showReceipt();
  };
  const sections = [
    ['content','执行内容',[field('计划名称',name),field('执行内容',workflow),instructionField]],
    ['identity','身份与维护人',[field('执行身份类型',kind),field('项目服务身份',actor),field('项目维护人',maintainer)]],
    ['time','触发时间',[field('计划时区（IANA）',zone),field('常用触发时间',preset),timeRules,field('有效期开始（ISO 时间）',start),field('有效期结束（可留空）',end),field('遗漏策略',misfire),field('宽限期分钟',grace)]],
    ['destination','通知目的地',[field('计划目的地',destination),note('保存和发送仍会重新检查身份、目的地与接收范围；登记不表示已送达。')]],
    ['limits','运行限制',[budgetBox]],
  ];
  const steps=element('nav','','schedule-editor-steps');steps.setAttribute('aria-label','计划编辑步骤');
  const step=value=>{form.dataset.scheduleStep=value;for(const item of steps.children)item.setAttribute('aria-current',item.dataset.step===value?'step':'false');};
  form.append(field('编辑计划',chosen),contextMeta,steps);
  for(const [id,title,children] of sections){
    const section=element('section','','schedule-editor-section');section.dataset.step=id;section.setAttribute('aria-label',title);section.append(element('h4',title),...children);form.append(section);
    const tab=button(title,()=>step(id),'quiet');tab.dataset.step=id;steps.append(tab);
  }
  step('content');
  form.append(
    button('预览日报计划', async () => {
      const plan=spec(), signature=JSON.stringify(plan), index=++activePreview, id=original?.id;
      parsed.textContent='正在按服务端算法读取未来触发时间…';
      try {
        const p = await read('preview_schedule',{plan,...(id ? {schedule_id:id} : {})});
        if (!live() || index!==activePreview || signature!==JSON.stringify(spec()) || id!==original?.id) return;
        revision=p.revision; parsed.textContent='时区：'+p.timezone+'\n未来触发：\n'+(p.future.length ? p.future.map(t=>time(t,p.timezone)).join('\n') : '无下一次触发')+'\n'+(p.report ? '以下为当前时间的样例日报；正式窗口截至逻辑触发时刻。\n'+p.report.text : p.supported ? '处理器已注册' : '处理器尚不支持，不能视为可执行');
      } catch(error) { if (live() && index===activePreview && !revoked(error)) { parsed.textContent='未来触发状态未知；请重新预览。'; status.textContent=error.message; } }
    },'quiet'),parsed);
  const save = element('button', '保存计划'); save.type = 'submit'; save.dataset.scheduleWrite='1'; form.append(save);
  form.onsubmit = e => { e.preventDefault(); void command(original ? 'schedule.update' : 'schedule.register', original ? { id: original.id, revision: original.revision, plan: spec() } : { plan: spec() }); };
  for (const [action, label] of [['pause', '暂停计划'], ['resume', '恢复计划'], ['run-now', '立即运行一次'], ['delete', '删除计划']]) {
    const control=button(label,()=>original ? command('schedule.'+action,{id:original.id,revision:original.revision}) : Promise.resolve(),'quiet');
    control.dataset.scheduleAction=action;form.append(control);
  }
  const controls = () => [...form.querySelectorAll('[data-schedule-field]')];
  const capture = () => Object.fromEntries(controls().map(node=>[node.dataset.scheduleField,{value:node.value,checked:node.checked}]));
  if (state.selected) { chosen.value=state.selected; fill(); }
  if (state.fields) for (const node of controls()) { const value=state.fields[node.dataset.scheduleField]; if (value) { node.value=value.value; if(node.type==='checkbox')node.checked=value.checked; } }
  dirty=!!state.fields;
  form.addEventListener('input',event=>{if(event.target===chosen)return;dirty=true;state.fields=capture();updateMeta();++activePreview;parsed.textContent='表单已修改，请重新预览当前时间和计划。';});
  form.addEventListener('change',event=>{if(event.target!==chosen){dirty=true;state.fields=capture();updateMeta();++activePreview;}});
  const previewBox=element('aside','','schedule-time-preview');previewBox.setAttribute('aria-label','触发时间预览');
  const previewAction=[...form.querySelectorAll('button')].find(node=>node.textContent==='预览日报计划');
  previewBox.append(element('h4','何时触发、发给谁'),previewAction,parsed,note('未来时间来自服务端解析；日报是当前样例，不代表未来执行结果。'));
  const editor=element('div','','schedule-editor-layout');editor.append(form,previewBox);panel.append(editor,receiptBox);
  if(state.conflict){
    const comparison=element('section','','schedule-conflict');comparison.setAttribute('role','alert');
    comparison.append(element('h4','计划版本已变化，草稿已保留'),note('以下是重新读取的当前计划；比较后再明确采用当前版本保存草稿。'),element('pre',JSON.stringify(original?.spec || {},null,2)),button('比较后保留草稿并采用当前版本',async()=>{
      if(!await askConfirm({title:'使用当前版本保存草稿？',body:['当前服务端计划已展示在比较区；后续保存将使用重新读取的版本和你的草稿。'],action:'保留草稿'}))return;
      if(!live())return;state.conflict=false;comparison.remove();showReceipt();
    },'quiet'));editor.prepend(comparison);
  }
  syncPreset(); syncFields(); updateMeta(); showReceipt();
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
  renderScheduleRecords(panel, { project, read, invalidate: revoked });
  panel.append(button('刷新定时与通知', () => renderSchedules(container, project), 'quiet'));
  showReceipt();
}
