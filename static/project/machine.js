function machineSection(globalSettings = false) {
  const { environment } = current, pc = environment?.environment.computer, editable = me.role === 'super_admin' && !!pc;
  const status = element('div', '', 'status-grid computer-status-grid'); status.id = 'machine-status'; status.append(...machineStatus());
  if (!pc) return [status, ...(globalSettings ? [] : [concurrencyForm()]), note('暂时读不到虚拟电脑规格。连接恢复后可重新读取本页配置；未保存改动请先保存。'),button('重新读取电脑配置',()=>reloadProject().catch(error))];
  const unread = !current.rules || current.rules.needs_refresh === true || !current.rules.sha;
  const effective=current.rules?.computer||pc, source=current.rules?.files.find(f=>f.path==='.bot/computer.yaml');
  const shown={...pc,...effective,network_policy:effective.egress===undefined?pc.network_policy:effective.egress?'internet egress':'internal, no egress'};
  // A resource left empty follows the global default; own() is the value the project sets (console or repository file).
  const own = name => current.rules?.computer ? current.rules.computer[name] : pc.inherited?.includes(name) ? undefined : pc[name];
  const number = (name, step) => input(name, own(name) ?? '', { type: 'number', step, min: pc.bounds?.[name]?.[0] ?? '', max: pc.bounds?.[name]?.[1] ?? '',
    placeholder: `留空使用全局默认（${pc.defaults?.[name] ?? pc[name]}）` });
  const configField = (label, control, name) => {
    const wrap = element('div', '', 'machine-config-field'), source = current.rules?.computer_sources?.[name];
    const inherited = specFields.includes(name) && own(name) == null;
    const origin = source ? layerNames[source] : specFields.includes(name) ? '全局默认' : '内置默认';
    const hint = element('span', unread ? '来源暂未读取' : `已保存来源：${origin}${inherited && source ? '，跟随全局默认' : ''}`, 'machine-config-origin');
    if (specFields.includes(name)) {
      const target = own(name) ?? pc.defaults?.[name];
      hint.append(` · ${unread ? '临时值' : '配置目标'} ${target ?? '未知'} · 电脑报告 ${pc[name] ?? '未知'}`);
    }
    wrap.append(control.tagName === 'LABEL' ? control : field(label, control), hint); return wrap;
  };
  const group = (title, text, ...fields) => {
    const section = element('section', '', 'machine-config-group');
    section.append(element('h4', title), note(text), ...fields); return section;
  };
  const sourceLink=element('a','查看规则文件来源');sourceLink.href=`#/projects/${current.id}/roles/manager`;
  const sourceActions=element('div','','actions');sourceActions.append(sourceLink);
  // Tasks apply the repository file when they prepare; a super administrator can apply it right away.
  if(source?.source==='repository'&&editable&&!unread){const apply=button('立即应用仓库文件',async()=>{apply.disabled=true;apply.textContent='正在按仓库文件重建虚拟电脑…';
    try{await api(`/api/repositories/${current.id}/rules/apply-computer`,'POST',{});current.flash='已按仓库 .bot/computer.yaml 重建虚拟电脑';await reloadProject();}catch(err){apply.disabled=false;apply.textContent='立即应用仓库文件';error(err);}});sourceActions.append(apply);}
  const resourceGrid = element('div', '', 'field-grid');
  resourceGrid.append(configField('CPU（核）', number('cpus', '0.25'), 'cpus'), configField('内存（MB）', number('memory_mb', '128'), 'memory_mb'),
    configField('进程数上限', number('pids', '1'), 'pids'), configField('/tmp 大小（MB）', number('tmp_mb', '16'), 'tmp_mb'));
  const fields = element('div', '', 'machine-config-fields');
  fields.append(group('资源上限', '留空跟随全局默认（全局设置 → 工作电脑）。配置目标与电脑报告分开展示，修改草稿不会改变已保存值。', resourceGrid),
    group('软件与初始化', pc.build?.toolchain ? '镜像已包含：' + pc.build.toolchain : '额外软件包会先构建镜像；初始化脚本以项目用户在工作卷中运行。',
      configField('额外系统软件包', textarea('packages', packagesText(shown.packages), { rows: 2, spellcheck: false, placeholder: 'Debian 包名，空格或换行分隔，例如 ffmpeg libpq-dev' }), 'packages'),
      configField('初始化脚本', textarea('setup_script', shown.setup_script || '', { rows: 5, spellcheck: false, className: 'code', placeholder: '以项目用户在 /workspace 运行，HOME=/workspace/home 持久保存；脚本或代次变化时重新运行' }), 'setup_script'),
      checkbox('rerun_setup', false, '保存后重新运行初始化脚本')),
    group('网络与环境变量', '环境变量对仓库代码可见，不要填写密钥。网络设置和变量随本组配置保存。',
      configField('网络访问', checkbox('egress', shown.network_policy === 'internet egress', '允许访问外网（安装依赖、访问测试地址）'), 'egress'),
      configField('环境变量', textarea('env', envText(shown.env), { rows: 3, spellcheck: false, placeholder: '每行 名称=值。对仓库代码可见，不要填写密钥' }), 'env')));
  const impact = element('aside', '', 'machine-config-impact'), draft = element('p', '', 'machine-config-draft'); draft.setAttribute('role', 'status');
  impact.append(element('h4', '保存影响'), draft,
    note(editable ? '保存会按本组改动重建虚拟电脑；正在执行的命令先执行完，任务保留的后台进程会结束。新增软件包需要先构建镜像，首次可能需要几分钟。' : '机器配置由超级管理员设置。'),
    note('工作卷、笔记和代次保留。项目任务并发在另一组单独保存，不会重建电脑。'));
  if (pc.resources_pending) impact.append(note('全局默认已变化，电脑等待空闲后重建。电脑报告的资源是配置目标，不能据此确认运行中容器已使用新上限。'));
  if (source?.source === 'repository') impact.append(note('仓库仅覆盖写明的字段；表单改动写入项目控制台，下次任务准备时同名字段仍以仓库文件为准。'));
  const layout = element('div', '', 'machine-config-layout'); layout.append(fields, impact);
  const nodes = [
    note(unread?'尚未读取默认分支配置，目前仅显示内置与控制台临时值，无法确认仓库覆盖关系。':source?.source==='repository'?'表单显示默认分支 .bot/computer.yaml 合并后的配置目标，电脑是否已应用需结合上方状态核对。':'表单显示已保存的配置目标；仓库 .bot/computer.yaml 可以按字段覆盖控制台值。'),sourceActions,
    layout];
  const readSpec = form => {
    const spec = {};
    // null clears the project's value, so the resource follows the global default again.
    for (const name of specFields) { const text = form.elements[name].value.trim(), value = text === '' ? null : Number(text); if (value !== (own(name) ?? null)) spec[name] = value; }
    if (form.elements.egress.checked !== (shown.network_policy === 'internet egress')) spec.egress = form.elements.egress.checked;
    const packages = [...new Set(form.elements.packages.value.split(/[\s,]+/).filter(Boolean))];
    if (packages.slice().sort().join(' ') !== [...(shown.packages || [])].sort().join(' ')) spec.packages = packages;
    const env = parseEnv(form.elements.env.value); if (envText(env) !== envText(shown.env)) spec.env = env;
    if (form.elements.setup_script.value !== (shown.setup_script || '')) spec.setup_script = form.elements.setup_script.value;
    if (form.elements.rerun_setup.checked) spec.rerun_setup = true;
    return spec;
  };
  const form = settingsForm('配置', nodes, async (form, progress) => {
    const spec = readSpec(form);
    if (!Object.keys(spec).length) return '没有改动';
    progress(spec.packages ? '正在安装软件包并重建虚拟电脑，首次可能需要几分钟…' : spec.setup_script !== undefined || spec.rerun_setup ? '正在重建虚拟电脑并运行初始化脚本…' : '正在按新配置重建虚拟电脑…');
    await api(`/api/environments/${current.id}/configure`, 'POST', { operation_id: operationId(), generation: environment.environment.generation, spec });
    return '已保存，虚拟电脑已按新配置重建';
  }, { editable: editable && !unread });
  form.classList.add('machine-config-card');
  const names = { cpus: 'CPU', memory_mb: '内存', pids: '进程数', tmp_mb: '/tmp', packages: '软件包', setup_script: '初始化脚本', rerun_setup: '重新初始化', egress: '网络', env: '环境变量' };
  const update = () => {
    try { const changes = Object.keys(readSpec(form.querySelector('form'))); draft.textContent = changes.length ? '待保存草稿：' + changes.map(key => names[key]).join('、') + '。已保存配置尚未改变。' : '本组没有待保存改动。'; }
    catch (err) { draft.textContent = '草稿尚未保存：' + err.message; }
  };
  form.addEventListener('input', update); update();
  const sourceReadError = element('p', '', 'view-error'); sourceReadError.hidden = true;
  const reread = button('重新读取电脑配置', async () => {
    const target = current, actor = me, address = location.hash, live = () => current === target && me === actor && location.hash === address;
    let dirty = true; try { dirty = !!Object.keys(readSpec(form.querySelector('form'))).length; } catch {}
    if (dirty && !await askConfirm({ title: '重新读取已保存配置？', body: ['本组未保存的输入将被替换。取消可继续保留草稿。'], action: '重新读取' })) return;
    if (!live()) return;
    reread.disabled = true; sourceReadError.hidden = true;
    try {
      // Re-reading an uncached local projection cannot discover repository overrides; fetch the branch first.
      if (unread && target.rules) await api(`/api/repositories/${target.id}/rules/refresh`, 'POST', {});
      if (live()) await reloadProject();
    } catch (err) { if (live()) { sourceReadError.textContent = '重新读取失败：' + err.message; sourceReadError.setAttribute('role', 'alert'); sourceReadError.hidden = false; } }
    finally { reread.disabled = false; }
  }, 'quiet');
  // Keep recovery outside the disabled fieldset when source data was unavailable.
  const heading=form.querySelector('h3'),toolbar=element('div','','heading');heading.replaceWith(toolbar);toolbar.append(heading,reread);
  toolbar.after(sourceReadError);
  if(unread)toolbar.after(note(!current.rules?'规则来源读取失败，不能确认仓库覆盖关系。请重新读取配置后保存。':'尚未读取默认分支文件，不能确认仓库覆盖关系。请重新读取配置后保存。'));
  return [status, ...(globalSettings ? [] : [concurrencyForm()]), form];
}
// How many tasks this computer runs at once: the project's own value, or empty for the global default. Project
// administrators change it too; it never rebuilds the computer.
function concurrencyForm() {
  const own = current.policy.task_concurrency, fallback = current.concurrencyDefault;
  const value = input('task_concurrency', own ?? '', { type: 'number', min: 1, max: 32, step: 1, placeholder: `留空使用全局默认（${fallback}）` });
  return settingsForm('同时运行的任务', [field('这台虚拟电脑同时运行的任务数', value),
    note(`当前生效 ${own ?? fallback} 个（${own == null ? '全局默认' : '项目覆写'}）。这是项目任务并发，与角色并发限额分开。取 1–32，留空跟随全局默认；超出的任务继续排队。每个任务用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限；保存不会重建虚拟电脑。`)],
  form => { const text = form.elements.task_concurrency.value.trim(); return patchPolicy(changed({ task_concurrency: text === '' ? null : Number(text) }, { task_concurrency: own ?? null })); });
}
// Status cards of the machine section, re-rendered by the refresh loop without touching the form.
function machineStatus() {
  const environment = current.environment;
  const reload = button('刷新电脑状态', async event => { const control=event.currentTarget;control.disabled=true;try{await refreshProjectStatus(renderToken);}finally{control.disabled=false;} });reload.id='computer-refresh';
  if (!environment) return [consoleState('电脑状态未知', '目前无法读取项目电脑记录，不能判断是否就绪。', { tone: 'error' }), reload];
  const env = environment.environment, pc = env.computer || {}, machine = card('机器'), lifecycle = element('div', '', 'actions');
  const limit=(key,unit)=>typeof pc[key]==='number'&&Number.isFinite(pc[key])&&pc[key]>=0?pc[key]+' '+unit:'未知';
  const observed=environment.observation, available=observed?.status==='available'&&Object.hasOwn(states,observed.state)&&!current.environmentReadError;
  machine.append(facts([['实时核验',available&&observed.state?state(observed.state):'未知'],['核验完成于',timestamp(observed?.checked_at)||'未提供'],['资源上限',`${limit('cpus','CPU')} · 内存 ${limit('memory_mb','MB')} · 进程 ${limit('pids','个')} · /tmp ${limit('tmp_mb','MB')}`],
    ['读取说明',current.environmentReadError?'读取失败，保留上次记录，可能已过期。':observed?.status==='unavailable'?'manager 暂不可达（manager_unavailable），可重试连接核验。':observed?.status==='absent'?'manager 未找到电脑记录；这不能解释为电脑已停止。':observed?.status==='recovering'?'管理服务恢复中，尚未返回电脑状态（manager_not_ready）。':observed?.status==='error'?'管理服务返回异常，未能核验电脑状态（manager_read_failed）。':observed?.status==='available'&&!available?'管理服务报告了未识别的电脑状态。':!observed?'尚未获得实时核验结果。':null]]));
  machine.append(note('实时核验时间是本次读取完成时间，不是电脑心跳；就绪也不代表任务、QA 或远程检查成功。'),reload);
  const record=element('details','','fold');record.append(element('summary','查看电脑记录与技术信息'),facts([['状态记录',state(env.state)],['容器', pc.container], ['代次', env.generation ? 'g' + env.generation : '待创建'], ['启动于', timestamp(env.started_at)],
    ['工作卷', pc.volume ? `${pc.volume} → ${pc.workdir}` : null], ['网络', pc.network ? `${pc.network}（${networkText(pc)}）` : null], ['镜像', pc.image ? pc.image.slice(0, 19) : null],
    ['资源', pc.resources_pending ? '全局默认资源已改，等没有任务运行时按新值重建' : null],
    ['运行用户', pc.user], ['根文件系统', pc.root_filesystem === 'read-only' ? '只读；HOME 和工作区在工作卷中持久保存' : pc.root_filesystem], ['故障', environmentFault(env.error)]]));machine.append(record);
  if(pc.image)machine.append(collapsible('完整运行镜像',pc.image));
  environmentButtons(env, environment.running_tasks?.length > 0, reloadProject, error).forEach((control,index)=>{control.id='computer-action-'+index;if(!available)control.disabled=true;lifecycle.append(control);}); machine.append(lifecycle);
  const work=card('运行与排队记录'), count=value=>Array.isArray(value)?value.length:'未知';
  work.append(facts([['运行任务记录',count(environment.running_tasks)],['排队任务记录',count(environment.queued_tasks)]]),
    consoleLink(`#/projects/${current.id}/activity`,'查看运行与排队任务','与本页使用同一项目电脑记录'),note('任务记录与电脑连接分别读取；配置页的项目任务并发与角色容量是不同限制。'));
  return [machine, usageCard(), work, preparationCard(pc, available && !!env.computer)];
}
let usage = null;
function usageCard() {
  const section = card('实时资源'), stats = usage?.id === current.id ? usage.stats : undefined;
  if(usage?.id===current.id&&usage.error)section.append(element('p','资源读取失败，'+(stats?'保留上次成功采样，可能已过期。':'当前数值未知。'),'view-error'));
  const amount=value=>Number.isFinite(value)&&value>=0?bytes(value):'未知', number=value=>Number.isFinite(value)&&value>=0?String(value):'未知';
  const sampled=Date.parse(stats?.sampled_at),age=Date.now()-sampled;
  if(stats?.running&&(!Number.isFinite(sampled)||age>30000||age< -5000))section.append(badge(!Number.isFinite(sampled)?'采样时间未知':age< -5000?'采样时间异常':'采样已过期','warning'));
  section.append(stats === undefined ? note('读取中…') : !stats ? note('暂时读不到资源数据。') : stats.running===false ? note('虚拟电脑未运行。') : stats.running!==true ? note('资源运行状态未知。')
    : facts([['CPU', Number.isFinite(stats.cpu_percent)&&stats.cpu_percent>=0?`${stats.cpu_percent}%`:'未知'], ['内存', `${amount(stats.memory_bytes)} / ${amount(stats.memory_limit_bytes)}`], ['进程', number(stats.pids)], ['网络', `↓ ${amount(stats.net_rx_bytes)} · ↑ ${amount(stats.net_tx_bytes)}`],
      ['磁盘读写', `${amount(stats.block_read_bytes)} / ${amount(stats.block_write_bytes)}`], ['工作区占用', amount(stats.workspace_bytes)], ['采样', timestamp(stats.sampled_at)||'未知']]));
  return section;
}
// Package image build and setup script results: what was installed into this computer and whether it worked.
function preparationCard(pc, known = true) {
  const section = card('软件安装与初始化'), build = pc.build, setup = pc.setup;
  const buildState = { none: ['仅用镜像自带软件', ''], building: ['正在构建软件包镜像', 'info'], ready: ['软件包镜像已就绪', 'success'], failed: ['软件包镜像构建失败', 'danger'] }[build?.state] || ['未知', ''];
  const setupState = !known ? ['初始化状态未知', ''] : !setup ? ['没有初始化脚本', ''] : { running: ['初始化脚本运行中', 'info'], succeeded: ['初始化脚本成功', 'success'], failed: ['初始化脚本失败', 'danger'] }[setup.state] || [setup.state, ''];
  const head = element('div', '', 'actions'); head.append(badge(...buildState), badge(...setupState)); section.append(head);
  section.append(facts([['镜像标签', build?.tag], ['构建完成', timestamp(build?.finished_at)], ['脚本退出码', setup?.exit_code ?? (setup?.error || null)], ['运行于', setup ? `g${setup.generation} · ${timestamp(setup.finished_at || setup.started_at)}` : null]]));
  if (build?.output) section.append(collapsible('构建输出', build.output, build.state === 'failed'));
  if (setup?.output) section.append(collapsible('初始化输出', setup.output, setup.state === 'failed'));
  return section;
}
// Keeps machine and activity status current while the section is open: environment every 5 s, live stats with it.
let projectStatusRead = 0;
async function refreshProjectStatus(token) {
  clearTimeout(projectTimer); if (token !== renderToken || !['machine', 'activity'].includes(current?.section)) return;
  const target=current,id=target.id,section=target.section,address=location.hash,read=++projectStatusRead;
  const settled=promise=>promise.then(value=>({value}),error=>({error}));
  const [environment, stats] = await Promise.all([settled(api('/api/environments/' + id)),
    section === 'machine' ? settled(api(`/api/environments/${id}/stats`).then(r => r.stats)) : {value:null}]);
  if (token !== renderToken || read!==projectStatusRead || current!==target || location.hash!==address) return;
  // These manager answers describe the computer/service, not the signed-in actor's project access.
  const managerStatsError=stats.error&&['project_not_registered','unauthorized','resource_ownership_mismatch'].includes(stats.error.code);
  const errors=[environment.error,managerStatsError?null:stats.error],revoked=errors.find(err=>err&&[401,403].includes(err.status))||(target.environment&&errors.find(err=>err?.status===404));
  if(revoked){target.environment=null;usage=null;$(target.globalSettings ? 'settings-panel' : 'project-page').replaceChildren(consoleState('项目电脑暂不可访问','原记录和配置已清除。'+revoked.message,{tone:'error',retry:()=>target.globalSettings?route():renderProject({id,section})}));return;}
  if (environment.value) target.environment = environment.value;
  target.environmentReadError=environment.error?.message||'';
  $(target.globalSettings ? 'settings-panel' : 'project-page').querySelectorAll('[data-project-environment-state]').forEach(node=>node.replaceWith(projectEnvironmentState()));
  if (section === 'machine') {
    usage = { id, stats:stats.error?(usage?.id===id?usage.stats:null):stats.value, error:stats.error?.message||'' };
    const status = $('machine-status');if(status){const focused=status.contains(document.activeElement)?document.activeElement.id:null;keepOpen(status, () => status.replaceChildren(...machineStatus()));if(focused)document.getElementById(focused)?.focus({preventScroll:true});}
  }
  else { const box = $('activity-status'); if (box) keepOpen(box, () => box.replaceChildren(...activityCards())); }
  projectTimer = setTimeout(() => refreshProjectStatus(token), 5000);
}

