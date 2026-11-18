// Unsaved forms and uncertain command keys belong to this login and project only.
let scheduleOwner = null;
const scheduleViews = new Map();
function resetScheduleViews() { scheduleOwner = null; scheduleViews.clear(); }
async function renderSchedules(panel, project) {
  const owner = JSON.stringify([me?.id, me?.actor?.tenant_id, me?.actor?.principal_id]);
  if (scheduleOwner !== owner) { resetScheduleViews(); scheduleOwner = owner; }
  const state = scheduleViews.get(project) || { selected: '', fields: null, envelope: null, receipt: null, sending: false };
  scheduleViews.set(project, state);
  state.subscription ||= { selected: '', fields: null };
  const isSubscription = operation => operation === 'notification.register' || operation?.startsWith('subscription.');
  const markConflict = (operation, message) => { const target = isSubscription(operation) ? state.subscription : state; target.conflict = /revision.*conflict|revision_changed/.test(message || ''); if(isSubscription(operation)){target.error=message;target.candidate=null;} };
  const container = panel; panel = element('section', '', 'schedule-panel'); container.replaceChildren(panel);
  let accessLost = false;
  const live = () => !accessLost && panel.isConnected && scheduleOwner === owner && owner === JSON.stringify([me?.id, me?.actor?.tenant_id, me?.actor?.principal_id]);
  panel.append(element('h3', '定时任务与通知'));
  if (location.hash !== '#/projects/'+project+'/schedules') panel.append(consoleLink('#/projects/'+project+'/schedules','在项目页管理定时任务与通知'));
  const status = element('p', '', 'muted'); status.setAttribute('role', 'status'); panel.append(status);
  function revoked(error) {
    // Channel audience failures invalidate the destination, while project read authority may still be valid.
    if (error.code?.startsWith('channel_') || error.code?.startsWith('schedule_destination_') || ![401,403].includes(error.status) || !live()) return false;
    accessLost = true; scheduleViews.delete(project);
    panel.replaceChildren(note(error.code === 'capability_forbidden' ? '当前账号没有计划管理权限，请联系项目管理员核对授权。' : '计划访问权限已失效，请按当前授权重新进入。')); return true;
  }
  const target = { project_id: project }, endpoint = '/api/management';
  const read = (operation, args = {}) => api(endpoint + '/query', 'POST', { operation, target, arguments: args });
  let plans, destinations, migrations;
  try { [plans, destinations, migrations] = await Promise.all([read('list_schedules'), read('list_schedule_destinations'), read('list_schedule_migrations', { limit: 100 })]); }
  catch (error) {
    if (!live()) return;
    if (revoked(error)) return;
    status.textContent = '计划上下文未能读取，数量及状态未知：' + readErrorText(error);
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
    state.subscription.update?.();
  };
  function showReceipt() {
    if (!live()) return; receiptBox.replaceChildren(); lock();
    receiptBox.setAttribute('aria-label', isSubscription(state.envelope?.operation) ? '订阅操作回执' : '计划操作回执');
    if (!state.envelope) return;
    const subscriptionOperation=isSubscription(state.envelope.operation);
    const receipt = state.receipt;
    receiptBox.append(element('h4', receipt ? '管理回执：' + receipt.state : '操作结果待核对'), note('操作绑定项目 ' + project + (state.envelope.arguments.id ? '、对象 ' + state.envelope.arguments.id : '') + '，核对仍使用同一次操作的幂等键。'));
    if (receipt) receiptBox.append(note('回执编号：' + receipt.id));
    if (receipt && ['failed','rejected'].includes(receipt.state)) {
      receiptBox.append(note(receipt.result?.error || receipt.state), button(subscriptionOperation?'返回订阅草稿':'返回计划草稿', async () => {
        markConflict(state.envelope.operation,state.receipt.result?.error || ''); state.envelope = null; state.receipt = null; await renderSchedules(container,project);
      }, 'quiet'));
    } else {
      receiptBox.append(note('尚未确认操作完成，先核对回执。'));
      const check = button(receipt ? (subscriptionOperation?'刷新订阅操作回执':'刷新计划操作回执') : (subscriptionOperation?'核对同一次订阅操作':'核对同一次计划操作'), async () => {
        if (state.sending) return;
        if (!receipt) { await send(); return; }
        state.sending = true; showReceipt();
        try { state.receipt = await api(endpoint + '/commands/' + receipt.id); await finish(); }
        catch (error) { if (live() && !revoked(error)) status.textContent = readErrorText(error); }
        finally { state.sending = false; state.update?.(); }
      }, 'quiet'); check.disabled = state.sending; receiptBox.append(check);
    }
  }
  async function finish() {
    if (!live()) return;
    if (state.receipt?.state === 'succeeded') {
      // Running, pausing or changing a subscription does not save the plan form. Keep unrelated/newer edits.
      if (['schedule.register','schedule.update','schedule.delete'].includes(state.envelope?.operation) && state.fields === state.submittedFields) state.fields = null;
      if (['notification.register','subscription.update'].includes(state.envelope?.operation) && state.subscription.fields === state.submittedSubscriptionFields) { state.subscription.fields=null; state.subscription.selected=state.receipt.result?.subscription?.id || state.subscription.selected; state.subscription.conflict=false; state.subscription.error=''; }
      if (state.envelope?.operation==='subscription.delete' && state.subscription.selected===state.envelope.arguments.id && state.subscription.fields===state.submittedSubscriptionFields) { state.subscription.selected='';state.subscription.fields=null;state.subscription.conflict=false; }
      if(isSubscription(state.envelope?.operation))state.subscription.flash=({'notification.register':'事件订阅已保存','subscription.update':'事件订阅已保存','subscription.pause':'事件订阅已暂停','subscription.resume':'事件订阅已恢复','subscription.delete':'事件订阅已解除'})[state.envelope.operation]||'订阅操作已完成';
      state.envelope = null; state.receipt = null; state.sending = false; state.submittedFields = null; state.submittedSubscriptionFields=null;
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
      if (!replay && error.status >= 400 && error.status < 500 && !error.message.includes('idempotency_conflict')) { markConflict(state.envelope.operation,error.message); state.envelope = null; state.receipt = null; }
      else state.uncertain = true;
      status.textContent = (error.code === 'schedule_occurrence_in_progress' ? '上次检查还在进行，完成后才能再运行' : readErrorText(error)) + '。草稿已保留；先核对当前版本或原回执。';
    } finally { state.sending = false; state.update?.(); }
  }
  state.update = () => { if (!live()) return; if (state.receipt?.state === 'succeeded') void finish(); else showReceipt(); };
  const command = async (operation, args, expectedRevision = revision) => {
    if (!live() || state.envelope || state.sending) return;
    if ((isSubscription(operation)?state.subscription:state).conflict) { status.textContent='请先重新读取并比较当前版本，再明确保留草稿。'; return; }
    const key = 'console-schedule:' + crypto.randomUUID();
    state.envelope = { operation, target, arguments: args, expected_revision: expectedRevision,
      idempotency_key: key, source_conversation: 'console:schedules', source_message: key };
    state.receipt = null; state.uncertain = false; state.submittedFields = state.fields; state.submittedSubscriptionFields=state.subscription.fields; await send();
  };
  const select = (label, options) => {
    const input = document.createElement('select'); input.setAttribute('aria-label', label); input.dataset.scheduleField = label;
    for (const [value, caption] of options) { const o = element('option', caption); o.value = value; input.append(o); }
    return input;
  };
  const input = (label, value, type = 'text') => { const node = document.createElement('input'); node.type = type; node.value = value; node.setAttribute('aria-label', label); node.dataset.scheduleField = label; return node; };
  // #1027: the one kind of project plan is the project scheduled task (manager.check). Its results stay in the project; a
  // scheduled summary in Feishu is a timer on that chat, run by the chat's own assistant.
  const editable = item => item.state !== 'deleted' && item.spec.workflow === 'manager.check';
  const intro = element('div', '', 'schedule-intro');
  intro.append(note('项目定时任务到点由项目的角色（Manager 安排）处理，结果留在项目的任务记录和 GitHub 上，不发到飞书。需要在飞书里定时收到汇报，请在对应私聊或群的「定时任务」里添加，由那个会话的助手执行。'),
    consoleLink('#/identity/feishu', '管理飞书会话的定时任务'));
  panel.append(intro);
  const form = document.createElement('form'), chosen = select('编辑计划', [['', '新建定时任务'], ...plans.schedules.filter(editable).map(s => [s.id, s.spec.name + ' · ' + s.state])]);
  const name = input('计划名称', '项目定时任务'), kind = select('执行身份类型', [['personal', '个人计划'], ['project', '项目服务计划']]);
  const actor = select('项目服务身份', (destinations.services ?? []).map(s => [s.id, s.maintenance + ' · ' + s.id.slice(0, 8)]));
  const maintainer = select('项目维护人', (destinations.maintainers ?? [{ id: me.id, name: userDisplayName(me) }]).map(s => [s.id, s.name]));
  const zone = input('计划时区', 'Asia/Shanghai'), recurrence = select('重复方式', [['cron', 'Cron（本地时间）'], ['interval', '固定周期']]);
  const cron = input('Cron 表达式', '0 9 * * *'), interval = input('固定周期分钟', '1440', 'number');
  const presets=[['0 9 * * *','每天 09:00'],['0 18 * * *','每天 18:00'],['0 9 * * 1','每周一 09:00'],['custom','自定义 Cron / 固定周期']];
  const preset=select('常用触发时间',presets),timeRules=element('details','','fold schedule-time-rules');
  timeRules.dataset.testid='schedule-time-rules';
  timeRules.append(element('summary','高级时间规则（Cron / 固定周期）'),field('重复方式',recurrence),field('Cron（分 时 日 月 周）',cron),field('固定周期分钟',interval));
  // #744: the summary and the advanced fold follow every edit of the time fields, not only the load,
  // the first screen and the template. A hand-typed Cron that matches a preset shows that preset; one
  // that does not shows 自定义 and keeps the advanced rules open. `collapsePreset` is only passed by
  // the internal syncs, so typing never shuts a fold the operator opened themselves.
  const syncPreset = (collapsePreset = false) => {
    const matched = recurrence.value === 'cron' && presets.some(([value]) => value === cron.value);
    preset.value = matched ? cron.value : 'custom';
    if (!matched) timeRules.open = true; else if (collapsePreset) timeRules.open = false;
  };

  const start = input('有效期开始', new Date().toISOString(), 'text'), end = input('有效期结束（可留空）', '', 'text');
  const instruction=document.createElement('textarea');instruction.rows=3;instruction.setAttribute('aria-label','要做什么');instruction.dataset.scheduleField='要做什么';
  instruction.placeholder='例如：检查 Nightly 的结果，指标变差就分析原因并提 Issue。';
  const instructionField=field('要做什么',instruction);
  const fileIssues=select('创建 Issue 的权限',[['inherit','跟随角色（未设置）'],['allow','允许创建或回复 Issue'],['deny','拒绝创建或回复 Issue']]);
  const fileIssuesField=field('创建 Issue 的权限',fileIssues);
  fileIssuesField.append(note('这项计划开关会覆盖执行角色的 GitHub 写权限：允许时即使角色没有写权限也可以在本项目仓库创建或回复 Issue；拒绝时即使角色有写权限也不允许；跟随角色（未设置）时不写入该标志，沿用角色策略。无论哪种选择，写入仍受项目能力上限约束，也不会改代码或发布。新建计划默认跟随角色。'));
  const misfire = select('遗漏策略', [['skip', '跳过遗漏'], ['once', '宽限期内只补一次']]), grace = input('宽限期分钟', '1', 'number');
  timeRules.append(field('计划时区（IANA）',zone),field('有效期开始（ISO 时间）',start),field('有效期结束（可留空）',end),field('遗漏策略',misfire),field('宽限期分钟',grace));
  const limits = {};
  const budgetBox = element('details', ''); budgetBox.append(element('summary', '运行限制'));
  for (const [key, label, value] of [['concurrency', '计划并发', 1], ['runtime_ms', '最长运行毫秒', 60000], ['runs', '每天运行次数', 100], ['model_calls', '每天模型调用次数', 0], ['cost_micros', '每天费用上限（微单位）', 0], ['retries', '最大自动重试', 3], ['manual_retries', '人工补发次数上限', 1], ['notifications_per_minute', '每分钟通知数', 10]]) {
    limits[key] = input(label, String(value), 'number'); budgetBox.append(field(label, limits[key]));
  }
  const summary = element('section', '', 'schedule-list'); summary.setAttribute('aria-label','项目定时任务列表');
  summary.append(element('h4','项目定时任务'), note('时区和触发时间来自服务端记录；尚未成功或没有下次触发不会显示为零。'));
  const states = { active:'启用中',paused:'已暂停',deleted:'已删除',unsupported:'处理器未支持' };
  const reasons = { migrated_to_chat_schedule:'已迁移到飞书会话的定时任务', daily_report_retired:'项目日报已停用', schedule_workflow_unsupported:'执行内容已不支持' };
  const time = (value,zone) => value == null ? '无记录' : stamped(value,zone);
  for (const item of plans.schedules) {
    const legacy = item.spec.workflow !== 'manager.check';
    const row = element('article', '', 'schedule-row'); row.append(element('strong',item.spec.name),note((states[item.state] || item.state) + (item.reason ? ' · '+(reasons[item.reason] || item.reason) : '')),
      facts([['执行内容',legacy ? (item.spec.workflow==='report.daily' ? '项目日报（已停用）' : item.spec.workflow + '（不支持）') : '项目定时任务'],['身份',item.spec.kind === 'personal' ? '个人计划' : '项目服务计划'],['时区',item.spec.timezone],['下次触发',item.next_at == null ? '无下次触发' : time(item.next_at,item.spec.timezone)],['最近成功',item.last_success == null ? '尚无成功记录' : time(item.last_success,item.spec.timezone)],['维护人',(destinations.maintainers || []).find(person=>person.id===item.spec.maintainer_id)?.name || item.spec.maintainer_id],...(legacy?[]:[['创建 Issue',item.spec.parameters?.file_issues===true?'允许（覆盖角色）':item.spec.parameters?.file_issues===false?'拒绝（覆盖角色）':'跟随角色']]),...(item.migration?[['迁移',item.migration.outcome==='migrated'?'已迁成'+(item.migration.chat_type==='group'?'群聊':'私聊')+'的会话定时任务':'未迁移（见下方迁移记录）']]:[])]));
    if (editable(item)) row.append(button('编辑计划：'+item.spec.name,()=>{chosen.value=item.id;chosen.dispatchEvent(new Event('change'));},'quiet'));
    summary.append(row);
  }
  if (!plans.schedules.length) summary.append(note('当前项目没有定时任务。')); panel.append(summary);
  // #1027: the report of the daily report plans moved to chat timers at the upgrade, one entry per plan.
  if (migrations.migrations.length) {
    const outcomes = { migrated:'已迁移', failed:'未迁移', skipped:'已跳过' };
    const why = { schedule_destination_unavailable:'原来的通知目的地已不存在', channel_chat_not_found:'找不到原来的飞书会话', channel_schedule_owner_unavailable:'私聊的主人已不在这个会话', channel_service_binding_missing:'这个群没有群聊助手绑定', plan_deleted:'原计划已删除', plan_expired:'原计划已过期' };
    const notes = { interval_rounded:'固定周期取整为至少 5 分钟，从迁移时开始计算', end_at_not_carried:'会话定时任务没有结束时间，需要时请手动暂停或删除' };
    const record = element('section', '', 'schedule-migrations'); record.setAttribute('aria-label', '项目日报迁移记录');
    record.append(element('h4', '项目日报迁移记录'), note('升级时，原来定时发到飞书的项目日报已迁成同一会话上的会话定时任务，由该会话的助手执行；原计划已停用并保留在上方列表。'));
    for (const m of migrations.migrations) {
      const entry = element('article', '', 'schedule-row');
      entry.append(element('strong', m.plan_name), note(outcomes[m.outcome] || m.outcome), facts([
        ['会话', m.chat_type ? (m.chat_type === 'group' ? '群聊' : '私聊') : '无'],
        ['会话定时任务', m.channel_schedule_id ? (m.detail?.timer?.name || m.channel_schedule_id) + (m.detail?.timer?.enabled === false ? '（已暂停，与原计划一致）' : '') : '未创建'],
        ['原因', m.reason ? (why[m.reason] || m.reason) : '无'],
        ...(m.detail?.notes?.length ? [['说明', m.detail.notes.map(n => notes[n] || n).join('；')]] : []),
        ['迁移时间', timestamp(m.created_at)]]));
      record.append(entry);
    }
    panel.append(record);
  }
  let original = null, dirty = false, serviceMissing = null;

  const syncFields = () => {
    if (actor.parentElement) actor.parentElement.hidden = kind.value === 'personal';
    if (serviceMissing) serviceMissing.hidden = kind.value === 'personal';
    if (maintainer.parentElement) maintainer.parentElement.hidden = kind.value === 'personal';
    if (cron.parentElement) cron.parentElement.hidden = recurrence.value !== 'cron';
    if (interval.parentElement) interval.parentElement.hidden = recurrence.value !== 'interval';
  };
  kind.onchange = syncFields; recurrence.onchange = () => { syncFields(); syncPreset(); };
  for (const node of [cron, interval]) { node.addEventListener('input', () => syncPreset()); node.addEventListener('change', () => syncPreset()); }
  preset.onchange=()=>{if(preset.value!=='custom'){recurrence.value='cron';cron.value=preset.value;}timeRules.open=preset.value==='custom';syncFields();};
  const spec = () => ({ ...(original?.spec ?? {}), destination_id: undefined, name: name.value, kind: kind.value, actor_id: kind.value === 'personal' ? me.id : actor.value,
    owner_id: original?.spec.owner_id ?? me.id, maintainer_id: kind.value === 'personal' ? me.id : maintainer.value,
    workflow: 'manager.check', parameters: (()=>{const parameters={...(original?.spec.parameters ?? {})};parameters.instruction=instruction.value;if(fileIssues.value==='allow')parameters.file_issues=true;else if(fileIssues.value==='deny')parameters.file_issues=false;else delete parameters.file_issues;return parameters;})(), timezone: zone.value,
    cron: recurrence.value === 'cron' ? cron.value : undefined, interval_ms: recurrence.value === 'interval' ? Number(interval.value) * 60000 : undefined,
    start_at: Date.parse(start.value), end_at: end.value ? Date.parse(end.value) : undefined, enabled: original ? original.state === 'active' : true,
    misfire: misfire.value, grace_ms: Number(grace.value) * 60000,
    limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Number(value.value)])) });
  // #886: a `pre` maps to generic, where an author name is prohibited; the name needs a role that accepts it.
  const parsed = element('pre', ''); parsed.setAttribute('role', 'group'); parsed.setAttribute('aria-label', '计划预览');
  const contextMeta=element('p','','schedule-context');
  const updateMeta=()=>{contextMeta.textContent='执行时区：'+zone.value+' · 结果留在项目的任务记录和 GitHub 上';};
  const fill = () => {
    original = plans.schedules.find(s => s.id === chosen.value) ?? null; if (!original) return;
    const p = original.spec; name.value = p.name; kind.value = p.kind; actor.value = p.actor_id; maintainer.value = p.maintainer_id;
    zone.value = p.timezone; recurrence.value = p.cron ? 'cron' : 'interval'; cron.value = p.cron ?? ''; interval.value = String((p.interval_ms ?? 86400000) / 60000);
    start.value = new Date(p.start_at).toISOString(); end.value = p.end_at ? new Date(p.end_at).toISOString() : '';
    misfire.value = p.misfire; grace.value = String(p.grace_ms / 60000); for (const [k, v] of Object.entries(p.limits)) limits[k].value = String(v);
    parsed.textContent = original.state + (original.reason ? ' · ' + original.reason : '') + '\n时区：' + p.timezone + '\n下次触发：' + (original.next_at ? new Date(original.next_at).toISOString() : '无') + '\n最近成功：' + (original.last_success ? new Date(original.last_success).toISOString() : '尚无') + '\n处理器：' + (original.supported ? '可用' : '不支持') + '\n维护人：' + p.maintainer_id;
    instruction.value=p.parameters?.instruction || ''; fileIssues.value=p.parameters?.file_issues===true?'allow':p.parameters?.file_issues===false?'deny':'inherit'; syncPreset(true); syncFields(); updateMeta();
  };
  chosen.onchange = async () => {
    const id = chosen.value;
    if (dirty && !await askConfirm({title:'切换计划并丢弃未保存修改？',body:['当前计划的未保存修改将被清除。'],action:'切换计划'})) { chosen.value=state.selected; return; }
    if (!live()) return; state.selected=id; state.fields=null; dirty=false;
    if (!id) { await renderSchedules(container,project); return; }
    fill(); ++activePreview; showReceipt();
  };
  const identityFold = element('details','','fold schedule-identity-fold');
  identityFold.dataset.testid='schedule-identity-fold';
  identityFold.append(element('summary','高级身份选项'),field('执行身份类型',kind),field('项目服务身份',actor));
  // #851: the project's administrators create its service identity here; project plans (Manager checks) run as it.
  if (destinations.can_manage_project && !(destinations.services ?? []).length) {
    const create = button('创建项目服务身份', async () => {
      create.disabled = true;
      try { await api('/api/identity/service-principals', 'POST', { project_id: project, maintenance: '项目定时检查' }); if (live()) await renderSchedules(panel, project); }
      catch (err) { create.disabled = false; if (live()) status.textContent = readErrorText(err); }
    }, 'quiet');
    serviceMissing = element('div', '', 'schedule-service-missing');
    serviceMissing.append(note('本项目还没有服务身份。项目服务计划以它的身份运行，它只拿到你本人在本项目拥有的权限，你失去这些权限时计划随之暂停。'), create);
    identityFold.append(serviceMissing);
  }
  identityFold.append(field('项目维护人',maintainer));
  const syncFoldsForViewport=()=>{ if (window.innerWidth<=760) identityFold.open=true; };
  const onFoldResize=()=>{ if (!panel.isConnected) { window.removeEventListener('resize',onFoldResize); return; } syncFoldsForViewport(); };
  window.addEventListener('resize',onFoldResize);
  syncFoldsForViewport();
  const sections = [
    ['content','要做什么',[field('计划名称',name),instructionField,fileIssuesField]],
    ['identity','身份与维护人',[identityFold]],
    ['time','触发时间',[field('常用触发时间',preset),note('先选每天或每周的常用时间；Cron、时区和有效期在「高级时间规则」里。'),timeRules]],
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
    button('预览触发时间', async () => {
      const plan=spec(), signature=JSON.stringify(plan), index=++activePreview, id=original?.id;
      parsed.textContent='正在按服务端算法读取未来触发时间…';
      try {
        const p = await read('preview_schedule',{plan,...(id ? {schedule_id:id} : {})});
        if (!live() || index!==activePreview || signature!==JSON.stringify(spec()) || id!==original?.id) return;
        revision=p.revision; parsed.textContent='时区：'+p.timezone+'\n未来触发：\n'+(p.future.length ? p.future.map(t=>time(t,p.timezone)).join('\n') : '无下一次触发');
      } catch(error) { if (live() && index===activePreview && !revoked(error)) { parsed.textContent=error.code === 'schedule_has_no_future_occurrence' ? '无下一次触发：按当前时间规则与有效期，服务端找不到未来触发。' : '未来触发状态未知；请重新预览。'; status.textContent = readErrorText(error); } }
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
  const previewAction=[...form.querySelectorAll('button')].find(node=>node.textContent==='预览触发时间');
  previewBox.append(element('h4','何时触发'),previewAction,parsed,note('未来时间来自服务端解析；到点生成一个项目任务，结果留在任务记录和 GitHub 上。'));
  const editor=element('div','','schedule-editor-layout');editor.append(form,previewBox);panel.append(editor,receiptBox);
  if(state.conflict){
    const comparison=element('section','','schedule-conflict');comparison.setAttribute('role','alert');
    comparison.append(element('h4','计划版本已变化，草稿已保留'),note('以下是重新读取的当前计划；比较后再明确采用当前版本保存草稿。'),element('pre',JSON.stringify(original?.spec || {},null,2)),button('比较后保留草稿并采用当前版本',async()=>{
      if(!await askConfirm({title:'使用当前版本保存草稿？',body:['当前服务端计划已展示在比较区；后续保存将使用重新读取的版本和你的草稿。'],action:'保留草稿'}))return;
      if(!live())return;state.conflict=false;comparison.remove();showReceipt();
    },'quiet'));editor.prepend(comparison);
  }
  syncPreset(true); syncFields(); updateMeta(); showReceipt();
  renderSubscriptionEditor(panel, {project,destinations,read,command,model:state.subscription,busy:()=>state.sending || !!state.envelope,invalidate:revoked,active:live});
  const applyFailureNotice=()=>{ void state.subscription.applyFailureTemplate?.(); };
  const applyCustomCheck=()=>{
    name.value='项目定时任务'; kind.value='personal';
    zone.value=zone.value||'Asia/Shanghai'; recurrence.value='cron'; cron.value='0 9 * * *';
    instruction.value=instruction.value||''; fileIssues.value='inherit';
    dirty=true; state.selected=''; state.fields=capture(); state.templateNotice='已套用项目定时任务模板：每天 09:00 生成一个项目任务。请写明要做什么。创建 Issue 的权限默认跟随执行角色；如需明确允许或拒绝，请在保存前选择。';
    if (chosen.value) { dirty=false; chosen.value=''; void renderSchedules(container,project); return; }
    syncPreset(true); syncFields(); updateMeta(); status.textContent=state.templateNotice; state.templateNotice=null;
  };
  const templates=element('section','','schedule-templates');
  templates.dataset.testid='schedule-templates';
  templates.append(
    element('h4','常用模板'),
    note('先选用一个模板，再按需要修改。不必先填完整高级表单。'),
    button('使用项目定时任务模板',applyCustomCheck),
    button('使用失败时通知模板',applyFailureNotice)
  );
  const list=panel.querySelector('.schedule-list');
  if (list) list.before(templates); else panel.prepend(templates);
  if (state.templateNotice) { status.textContent=state.templateNotice; state.templateNotice=null; }
  renderScheduleRecords(panel, { project, read, invalidate: revoked });
  panel.append(button('刷新定时与通知', () => renderSchedules(container, project), 'quiet'));
  showReceipt();
}
