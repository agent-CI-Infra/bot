// Project pages: one settings page per repository with categories on the left (#/projects/<id>/<section>).
// Loaded after app.js and views.js and reuses their helpers.
const projectSections = [['basic', '基本设置'], ['machine', '机器配置'], ['model', '使用的模型'], ['review', '检视'], ['development', '开发'], ['rules', '规则总览'], ['external', '外部执行'], ['members', '成员', true], ['activity', '运行记录']];
// The bot's rule files: what each one does, which tasks read it, and the section where it is edited.
// Every file has the same three layers: built-in default, project console override, default-branch repository file.
const ruleFiles = [
  ['.bot/guide.md', '行为指南', '全部任务', 'rules'],
  ['.bot/rules/issue-review.md', 'Issue 检视规则', 'Issue 检视', 'review'],
  ['.bot/rules/pr-review.md', 'PR 检视规则', 'PR 检视', 'review'],
  ['.bot/rules/labels.md', '检视标签', 'Issue 与 PR 检视', 'review'],
  ['.bot/rules/issue-development.md', '开发规则', '开发', 'development'],
  ['.bot/computer.yaml', '虚拟电脑', '全部任务', 'machine']];
const layerNames = { builtin: '内置默认', console: '项目控制台', repository: '仓库文件' };
const ruleInfo = path => ruleFiles.find(([p]) => p === path) || [path, '仓库 skill', '全部任务', 'rules'];
const specFields = ['cpus', 'memory_mb', 'pids', 'tmp_mb'];
const packagesText = list => (list || []).join(' '), envText = env => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
const bytes = value => value == null ? '—' : value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.round(value / 1024) + ' KB';
function parseEnv(text) {
  const env = {};
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return; const at = line.indexOf('=');
    if (at < 1) throw new Error(`环境变量第 ${index + 1} 行需要写成 名称=值`); env[line.slice(0, at).trim()] = line.slice(at + 1);
  });
  return env;
}
function projectRoute() { const m = /^#\/projects\/([1-9]\d*)(?:\/([a-z]+))?$/.exec(location.hash); return m ? { id: m[1], section: m[2] || 'basic' } : null; }
function openProject(id, section = 'basic') { location.hash = `#/projects/${id}/${section}`; }
function field(label, control) { const wrap = element('label', label); wrap.append(control); return wrap; }
function input(name, value, attributes = {}) { const el = document.createElement('input'); el.name = name; el.value = value ?? ''; Object.assign(el, attributes); return el; }
function textarea(name, value, attributes = {}) { const el = document.createElement('textarea'); el.name = name; el.value = value ?? ''; Object.assign(el, attributes); return el; }
function checkbox(name, checked, caption) { const box = input(name, '', { type: 'checkbox', checked: !!checked }), wrap = element('label', '', 'check'); wrap.append(box, ' ' + caption); return wrap; }
function note(text) { return element('p', text, 'muted'); }
// A settings form: fields, an error line and a save button; `save` receives the form and reports through the error line.
function settingsForm(title, nodes, save, { editable = true, caption = '保存' } = {}) {
  const section = card(title), form = document.createElement('form'), message = element('p', '', 'view-error'), submit = element('button', caption);
  form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert');
  const set = element('fieldset', ''); set.disabled = !editable; set.append(...nodes); form.append(set, message);
  if (editable) { const actions = element('div', '', 'actions form-actions'); actions.append(submit); form.append(actions); }
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.className = 'view-error'; message.textContent = '';
    const invalid = [...form.querySelectorAll('input')].find(el => !el.checkValidity());
    if (invalid) {
      const label = invalid.closest('label')?.firstChild?.textContent?.trim() || invalid.name, range = invalid.validity.rangeOverflow || invalid.validity.rangeUnderflow;
      message.textContent = range ? `${label}需在 ${invalid.min}–${invalid.max} 之间` : invalid.validity.stepMismatch ? `${label}的取值步长是 ${invalid.step}` : `${label}：${invalid.validationMessage}`; invalid.focus(); return;
    }
    submit.disabled = true;
    // The page re-renders after saving, so the result is shown at the top of the refreshed section.
    try { const done = await save(form, text => { message.className = 'view-progress'; message.textContent = text; }); current.flash = typeof done === 'string' && done ? done : '已保存'; await reloadProject(); }
    catch (err) { message.className = 'view-error'; message.textContent = err.message; } finally { submit.disabled = false; }
  });
  section.append(form); return section;
}

let current = null, projectTimer = null, renderToken = 0;
// Loads the project once per visit and re-renders the active section; status cards refresh on their own.
async function renderProject(route) {
  const token = ++renderToken, page = $('project-page'); clearTimeout(projectTimer);
  if (current?.id !== route.id) { current = { id: route.id }; page.replaceChildren(element('p', '正在加载…', 'muted')); }
  try { await loadProject(route.id,route.section); } catch (err) { if (token === renderToken) page.replaceChildren(element('p', err.message, 'view-error')); return; }
  if (token !== renderToken) return;
  const section = projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin')) ? route.section : 'basic';
  current.section = section; page.replaceChildren(projectHeader(), projectBody(section));
  if(section==='rules')page.querySelector('.project-nav [aria-current=page]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  // Opening a rule file from the overview, or saving one, brings its card into view.
  if (current.focusRule) { page.querySelector(`[data-rule-path="${CSS.escape(current.focusRule)}"]`)?.scrollIntoView({ block: 'start' }); current.focusRule = null; }
  if (['machine', 'activity'].includes(section)) refreshProjectStatus(token);
}
async function loadProject(id,section=current.section) {
  const superUser = me.role === 'super_admin';
  const [repo, environment, installed, rules, models] = await Promise.all([api('/api/repositories/' + id), api('/api/environments/' + id).catch(() => null), superUser ? api('/api/installations').catch(() => null) : null, api('/api/repositories/'+id+'/rules').catch(()=>null), api('/api/models?repository_id='+id).catch(()=>null)]);
  const external=section==='external'?await loadExternalProject(id):null;
  Object.assign(current, { external, repository: repo.repository, policy: repo.policy, concurrencyDefault: repo.task_concurrency_default, environment, installed: installed?.repositories.find(r => r.id === id) || null, rules:rules?.rules, models:models?.models||[] });
}
async function reloadProject() { await loadProject(current.id); renderProject({ id: current.id, section: current.section }); }
function projectStatus() {
  const { policy, installed } = current;
  const status = !policy.enabled ? badge('已禁用', 'warning') : policy.review_enabled ? badge('工作中', 'success') : badge('未开检视', 'warning');
  const permission = installed?.permission_missing?.length ? [permissionBadge(installed)] : [];
  return [status, ...(installed?.installed === false ? [badge('已移出安装', 'danger')] : []), ...permission, ...(current.environment ? [state(current.environment.environment.state)] : [])];
}
function projectHeader() {
  const { repository, policy } = current, head = element('div', '', 'project-head'), title = element('div', '', 'title-group'), actions = element('div', '', 'actions');
  const back = element('a', '← 全部项目', 'back-link'); back.href = '#/projects';
  title.append(element('h1', repository.full_name), ...projectStatus());
  actions.append(link(`https://github.com/${repository.full_name}`, '在 GitHub 打开', 'button-link'));
  if (me.role === 'super_admin') actions.append(policy.enabled
    ? button('禁用项目', async () => {
      if (!await askConfirm({ title: `禁用 ${repository.full_name}？`, body: ['新的 Issue／PR 不再处理，正在执行的任务会中止，虚拟电脑停止但数据保留，之后可以再启用。'], action: '禁用', danger: true })) return;
      await api(`/api/installations/${current.id}/disable`, 'POST', {}).catch(error); await reloadProject();
    })
    : button('启用项目', async () => { await api(`/api/installations/${current.id}/activate`, 'POST', {}).catch(error); await reloadProject(); }, ''));
  // Always offered here; the server deletes only when GitHub, asked right now, says the account lost the repository.
  if (me.role === 'super_admin') actions.append(button('删除项目',
    () => deleteProject({ id: current.id, full_name: repository.full_name, registered: true }, async () => { current = null; location.hash = '#/projects'; }), 'quiet destructive'));
  head.append(back, title, actions); return head;
}
function projectBody(section) {
  const body = element('div', '', 'project-body'), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content');
  nav.setAttribute('aria-label', '项目设置类别');
  for (const [key, caption, superOnly] of projectSections) {
    if (superOnly && me.role !== 'super_admin') continue;
    const item = element('a', caption); item.href = `#/projects/${current.id}/${key}`; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item);
  }
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  content.append(...({ basic: basicSection, machine: machineSection, model: modelSection, review: reviewSection, development: developmentSection, rules: rulesSection, external: externalSection, members: membersSection, activity: activitySection }[section])());
  body.append(nav, content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

function basicSection() {
  const { repository, policy, installed, environment } = current, info = card('仓库');
  info.append(facts([['仓库', link(`https://github.com/${repository.full_name}`, repository.full_name)], ['仓库 ID', repository.id], ['所有者', installed?.owner_login ? `${installed.owner_login}（${repository.owner_id}）` : repository.owner_id],
    ['处理账号', installed?.account_name || repository.account_id], ['安装', !installed ? null : installed.installed === null ? '不在安装列表' : `${installed.installation_id ? '安装 ' + installed.installation_id : '机器人账号可见'}${installed.installed === false ? '（已移出）' : ''}`],
    ['可见性', installed ? installed.private ? '私有' : '公开' : null], ['项目状态', policy.enabled ? '已启用' : '已禁用'], ['虚拟电脑', environment ? (states[environment.environment.state] || [environment.environment.state])[0] : '读取失败']]));
  const summary = card('当前配置一览');
  summary.append(facts([['检视', policy.review_enabled ? '开启' : '关闭'], ['自动开发', policy.development_enabled ? '开启' : '关闭'], ['模型', current.models.find(m=>m.id===policy.model_id)?.model_name || (policy.model_id?'模型不可用':'未选择，任务会等待配置')],
    ['机器', current.rules?.computer?.cpus ? `${current.rules.computer.cpus} CPU · ${current.rules.computer.memory_mb} MB（${current.rules.files.find(f=>f.path==='.bot/computer.yaml').source==='repository'?'仓库 .bot/computer.yaml':'控制台'}）` : environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null]]));
  const branch = settingsForm('分支', [field('基准分支', input('base_branch', policy.base_branch, { maxLength: 256, placeholder: '留空使用仓库默认分支' })),
    note('开发任务从这个分支拉取代码并向它开 PR；检视 Issue 时也读取这个分支的代码。')],
  form => patchPolicy(changed({ base_branch: form.elements.base_branch.value.trim() }, { base_branch: policy.base_branch || '' })));
  return [info, summary, branch];
}

function machineSection() {
  const { environment } = current, pc = environment?.environment.computer, editable = me.role === 'super_admin' && !!pc;
  const status = element('div', '', 'status-grid'); status.id = 'machine-status'; status.append(...machineStatus());
  if (!pc) return [status, concurrencyForm(), note('暂时读不到虚拟电脑规格，稍后再试。')];
  const effective=current.rules?.computer||pc, source=current.rules?.files.find(f=>f.path==='.bot/computer.yaml');
  const shown={...pc,...effective,network_policy:effective.egress===undefined?pc.network_policy:effective.egress?'internet egress':'internal, no egress'};
  const number = (name, step) => input(name, shown[name], { type: 'number', step, min: pc.bounds?.[name]?.[0] ?? '', max: pc.bounds?.[name]?.[1] ?? '' });
  const sourceLink=element('a','查看规则总览');sourceLink.href=`#/projects/${current.id}/rules`;
  const sourceActions=element('div','','actions');sourceActions.append(sourceLink);
  // Tasks apply the repository file when they prepare; a super administrator can apply it right away.
  if(source?.source==='repository'&&editable){const apply=button('立即应用仓库文件',async()=>{apply.disabled=true;apply.textContent='正在按仓库文件重建虚拟电脑…';
    try{await api(`/api/repositories/${current.id}/rules/apply-computer`,'POST',{});current.flash='已按仓库 .bot/computer.yaml 重建虚拟电脑';await reloadProject();}catch(err){apply.disabled=false;apply.textContent='立即应用仓库文件';error(err);}});sourceActions.append(apply);}
  const nodes = [
    note(source?.source==='repository'?'表单显示默认分支 .bot/computer.yaml 合并后的生效值。这里保存的是控制台配置，下次任务准备时会再次被仓库文件覆盖。':'表单显示当前生效电脑规格；仓库 .bot/computer.yaml 可以覆盖控制台值。'),sourceActions,
    note(editable ? '保存后虚拟电脑按新配置重建：工作卷和代次保留，正在执行的命令先执行完，任务保留的后台进程会结束。新增软件包时会先构建镜像，首次可能需要几分钟。' : '机器配置由超级管理员设置。'),
    element('h4', '资源'),
    (() => { const grid = element('div', '', 'field-grid'); grid.append(field('CPU（核）', number('cpus', '0.25')), field('内存（MB）', number('memory_mb', '128')), field('进程数上限', number('pids', '1')),
      field('/tmp 大小（MB）', number('tmp_mb', '16'))); return grid; })(),
    checkbox('egress', shown.network_policy === 'internet egress', '允许访问外网（安装依赖、访问测试地址）'),
    element('h4', '软件'),
    note(pc.build?.toolchain ? '镜像已包含：' + pc.build.toolchain : ''),
    field('额外系统软件包', textarea('packages', packagesText(shown.packages), { rows: 2, spellcheck: false, placeholder: 'Debian 包名，空格或换行分隔，例如 ffmpeg libpq-dev' })),
    field('环境变量', textarea('env', envText(shown.env), { rows: 3, spellcheck: false, placeholder: '每行 名称=值。对仓库代码可见，不要填写密钥' })),
    field('初始化脚本', textarea('setup_script', shown.setup_script || '', { rows: 5, spellcheck: false, className: 'code', placeholder: '以项目用户在 /workspace 运行，HOME=/workspace/home 持久保存，可联网；脚本或代次变化时重新运行' })),
    checkbox('rerun_setup', false, '保存后重新运行初始化脚本')];
  const form = settingsForm('配置', nodes, async (form, progress) => {
    const spec = {};
    for (const name of specFields) if (Number(form.elements[name].value) !== shown[name]) spec[name] = Number(form.elements[name].value);
    if (form.elements.egress.checked !== (shown.network_policy === 'internet egress')) spec.egress = form.elements.egress.checked;
    const packages = [...new Set(form.elements.packages.value.split(/[\s,]+/).filter(Boolean))];
    if (packages.slice().sort().join(' ') !== [...(shown.packages || [])].sort().join(' ')) spec.packages = packages;
    const env = parseEnv(form.elements.env.value); if (envText(env) !== envText(shown.env)) spec.env = env;
    if (form.elements.setup_script.value !== (shown.setup_script || '')) spec.setup_script = form.elements.setup_script.value;
    if (form.elements.rerun_setup.checked) spec.rerun_setup = true;
    if (!Object.keys(spec).length) return '没有改动';
    progress(spec.packages ? '正在安装软件包并重建虚拟电脑，首次可能需要几分钟…' : spec.setup_script !== undefined || spec.rerun_setup ? '正在重建虚拟电脑并运行初始化脚本…' : '正在按新配置重建虚拟电脑…');
    await api(`/api/environments/${current.id}/configure`, 'POST', { operation_id: operationId(), generation: environment.environment.generation, spec });
    return '已保存，虚拟电脑已按新配置重建';
  }, { editable });
  return [status, concurrencyForm(), form];
}
// How many tasks this computer runs at once: the project's own value, or empty for the global default. Project
// administrators change it too; it never rebuilds the computer.
function concurrencyForm() {
  const own = current.policy.task_concurrency, fallback = current.concurrencyDefault;
  const value = input('task_concurrency', own ?? '', { type: 'number', min: 1, max: 32, step: 1, placeholder: `留空使用全局默认（${fallback}）` });
  return settingsForm('同时运行的任务', [field('这台虚拟电脑同时运行的任务数', value),
    note(`当前生效 ${own ?? fallback} 个${own == null ? '（全局默认）' : ''}。取 1–32，留空跟随全局默认；超出的任务继续排队。每个任务用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限；保存不会重建虚拟电脑。`)],
  form => { const text = form.elements.task_concurrency.value.trim(); return patchPolicy(changed({ task_concurrency: text === '' ? null : Number(text) }, { task_concurrency: own ?? null })); });
}
// Status cards of the machine section, re-rendered by the refresh loop without touching the form.
function machineStatus() {
  const environment = current.environment; if (!environment) return [note('暂时读不到虚拟电脑状态。')];
  const env = environment.environment, pc = env.computer || {}, machine = card('机器'), lifecycle = element('div', '', 'actions');
  machine.append(facts([['状态', state(env.state)], ['容器', pc.container], ['代次', env.generation ? 'g' + env.generation : '待创建'], ['启动于', timestamp(env.started_at)],
    ['工作卷', pc.volume ? `${pc.volume} → ${pc.workdir}` : null], ['网络', pc.network ? `${pc.network}（${networkText(pc)}）` : null], ['镜像', pc.image ? pc.image.slice(0, 19) : null],
    ['运行用户', pc.user], ['根文件系统', pc.root_filesystem === 'read-only' ? '只读；HOME 和工作区在工作卷中持久保存' : pc.root_filesystem], ['故障', env.error]]));
  lifecycle.append(...environmentButtons(env, environment.running_tasks?.length > 0, reloadProject, error)); machine.append(lifecycle);
  return [machine, usageCard(), preparationCard(pc)];
}
let usage = null;
function usageCard() {
  const section = card('实时资源'), stats = usage?.id === current.id ? usage.stats : undefined;
  section.append(stats === undefined ? note('读取中…') : !stats ? note('暂时读不到资源数据。') : !stats.running ? note('虚拟电脑未运行。')
    : facts([['CPU', `${stats.cpu_percent}%`], ['内存', `${bytes(stats.memory_bytes)} / ${bytes(stats.memory_limit_bytes)}`], ['进程', stats.pids], ['网络', `↓ ${bytes(stats.net_rx_bytes)} · ↑ ${bytes(stats.net_tx_bytes)}`],
      ['磁盘读写', `${bytes(stats.block_read_bytes)} / ${bytes(stats.block_write_bytes)}`], ['工作区占用', bytes(stats.workspace_bytes)], ['采样', timestamp(stats.sampled_at).slice(11, 19)]]));
  return section;
}
// Package image build and setup script results: what was installed into this computer and whether it worked.
function preparationCard(pc) {
  const section = card('软件安装与初始化'), build = pc.build, setup = pc.setup;
  const buildState = { none: ['仅用镜像自带软件', ''], building: ['正在构建软件包镜像', 'info'], ready: ['软件包镜像已就绪', 'success'], failed: ['软件包镜像构建失败', 'danger'] }[build?.state] || ['未知', ''];
  const setupState = !setup ? ['没有初始化脚本', ''] : { running: ['初始化脚本运行中', 'info'], succeeded: ['初始化脚本成功', 'success'], failed: ['初始化脚本失败', 'danger'] }[setup.state] || [setup.state, ''];
  const head = element('div', '', 'actions'); head.append(badge(...buildState), badge(...setupState)); section.append(head);
  section.append(facts([['镜像标签', build?.tag], ['构建完成', timestamp(build?.finished_at)], ['脚本退出码', setup?.exit_code ?? (setup?.error || null)], ['运行于', setup ? `g${setup.generation} · ${timestamp(setup.finished_at || setup.started_at)}` : null]]));
  if (build?.output) section.append(collapsible('构建输出', build.output, build.state === 'failed'));
  if (setup?.output) section.append(collapsible('初始化输出', setup.output, setup.state === 'failed'));
  return section;
}
// Keeps machine and activity status current while the section is open: environment every 5 s, live stats with it.
async function refreshProjectStatus(token) {
  clearTimeout(projectTimer); if (token !== renderToken || !['machine', 'activity'].includes(current?.section)) return;
  const [environment, stats] = await Promise.all([api('/api/environments/' + current.id).catch(() => null),
    current.section === 'machine' ? api(`/api/environments/${current.id}/stats`).then(r => r.stats).catch(() => null) : null]);
  if (token !== renderToken) return;
  if (environment) current.environment = environment;
  if (current.section === 'machine') { usage = { id: current.id, stats }; const status = $('machine-status'); if (status) keepOpen(status, () => status.replaceChildren(...machineStatus())); }
  else { const box = $('activity-status'); if (box) keepOpen(box, () => box.replaceChildren(...activityCards())); }
  projectTimer = setTimeout(() => refreshProjectStatus(token), 5000);
}

function modelSection() {
  const { policy } = current, superUser = me.role === 'super_admin', chooser = card('使用的模型'), list = element('div', '', 'model-list');
  chooser.append(note('检视和开发都用这里选择的模型。部署共享模型由超级管理员提供，本项目专属模型只对这个项目可见。'), list);
  const own = card('本项目专属模型'), ownList = element('ul', '', 'history'), shared = card('部署共享模型'), sharedList = element('ul', '', 'history');
  own.append(ownList); shared.append(sharedList);
  (async () => {
    const models = (await api(superUser ? '/api/models' : '/api/models?repository_id=' + current.id)).models.filter(m => m.repository_id === null || m.repository_id === current.id);
    const choices = element('div', '', 'choices'), save = element('button', '保存选择'), message = element('p', '', 'view-error');
    const option = (value, title, detail, checked) => { const label = element('label', '', 'choice'), radio = input('model', value, { type: 'radio', checked }); label.append(radio, element('strong', title), element('span', detail, 'muted')); return label; };
    choices.append(option('', '不使用模型', '检视和开发任务会停在“配置待补”', !policy.model_id));
    for (const m of models) choices.append(option(m.id, m.model_name, `${m.repository_id ? '本项目专属' : '部署共享'} · ${m.api_url}${m.key_configured ? '' : ' · Key 已撤销'}`, policy.model_id === m.id));
    save.type = 'button'; save.addEventListener('click', async () => {
      const value = choices.querySelector('input:checked')?.value || null; save.disabled = true;
      try { await patchPolicy(changed({ model_id: value }, { model_id: policy.model_id || null })); await reloadProject(); } catch (err) { message.textContent = err.message; save.disabled = false; }
    });
    const actions = element('div', '', 'actions form-actions'); actions.append(save); list.replaceChildren(choices, message, actions);
    const row = (m, target) => { const li = element('li', '', 'model-entry'), result = probeResult('wide-cell'); li.append(modelAddress(m), modelActions(m, result), result); target.append(li); };
    models.filter(m => m.repository_id === current.id).forEach(m => row(m, ownList)); if (!ownList.childElementCount) ownList.append(element('li', '还没有专属模型。', 'muted'));
    models.filter(m => m.repository_id === null).forEach(m => row(m, sharedList)); if (!sharedList.childElementCount) sharedList.append(element('li', '还没有共享模型。', 'muted'));
  })().catch(err => list.replaceChildren(element('p', err.message, 'view-error')));
  own.append(modelForm('添加专属模型', current.id));
  const sections = [chooser, own];
  if (superUser) { shared.append(modelForm('添加部署共享模型', null)); sections.push(shared); }
  return sections;
}
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
// Rotating or revoking a key never shows it; an empty key field keeps the current one. Listing and testing use the
// saved URL, key and name and need the same right as editing; their outcome goes to the row's result line.
function modelActions(model, result) {
  const actions = element('div', '', 'actions'), editable = me.role === 'super_admin' || model.repository_id === current.id;
  if (!editable) return actions;
  if (model.key_configured) actions.append(
    probeButton('获取模型列表', result, () => api(`/api/models/${model.id}/upstream`, 'POST', {}), value => listOutcome(value, model.model_name)),
    probeButton('测试模型', result, () => api(`/api/models/${model.id}/test`, 'POST', {}), testOutcome));
  actions.append(button('计费单价',()=>modelPricing(model)));
  actions.append(button('更换 Key', async () => {
    const saved = await confirmDialog({ title: `更换 ${model.model_name} 的 API Key`, body: ['保存后立即生效；页面和接口都不会再显示这个 Key。'], action: '保存',
      input: { label: '新的 API Key', type: 'password' }, run: key => api('/api/models/' + model.id, 'PATCH', { version: model.version, api_key: key }) });
    if (saved) await reloadProject();
  }));
  if (model.key_configured) actions.append(button('撤销 Key', async () => {
    if (!await askConfirm({ title: `撤销 ${model.model_name} 的 API Key？`, body: ['使用它的项目会停在“配置待补”，直到换上新的 Key。'], action: '撤销', danger: true })) return;
    await api(`/api/models/${model.id}/credentials/revoke`, 'POST', {}).catch(error); await reloadProject();
  }));
  return actions;
}
function modelForm(title, repositoryId) {
  const details = element('details', '', 'fold add-model'); details.append(element('summary', title));
  const form = settingsForm(title, [...modelFields(repositoryId),
    note('兼容 Chat Completions 的接口；Key 加密保存，不会再显示。保存即视为可信接口，可接收本项目的代码和日志。')],
  async form => { const created = (await api('/api/models', 'POST', { repository_id: repositoryId, api_url: form.elements.api_url.value.trim(), model_name: form.elements.model_name.value.trim(), api_key: form.elements.api_key.value }));
    return `已添加 ${created.model.model_name}，可在“使用的模型”里选择`; }, { caption: '添加' });
  form.querySelector('h3').remove(); details.append(form); return details;
}

// Model address, upstream list and test, shared by the project page and the onboarding wizard (onboarding.js loads
// after this file). The server resolves addresses, so the page shows exactly where tasks will send their requests.
const modelUrlRule = '地址按填写的路径使用：去掉末尾的 / 和 /chat/completions 后，接上 /chat/completions 发送对话，接上 /models 获取模型列表；不会自动添加或删除 /v1。';
const modelV1Warning = '当前地址不含末尾的 /v1；多数兼容接口需要它，只有上游确认不用时才这样填写。';
function endpointFacts(endpoints) {
  const nodes = [facts([['对话地址', endpoints.chat_url], ['模型列表地址', endpoints.models_url]])];
  if (!endpoints.has_v1) nodes.push(element('p', modelV1Warning, 'endpoint-warning'));
  return nodes;
}
function modelAddress(model) {
  const address = element('span', `${model.model_name} · ${model.api_url}`, 'model-address');
  if (model.endpoints && !model.endpoints.has_v1) { const flag = badge('地址不含 /v1', 'warning'); flag.title = modelV1Warning; address.append(' ', flag); }
  return address;
}
function probeResult(className = '') { const box = element('div', '', ('probe-result ' + className).trim()); box.setAttribute('role', 'status'); return box; }
const probeErrors = { upstream_timeout: '上游 15 秒内没有响应', upstream_unreachable: '无法连接上游', upstream_redirect: '上游要求重定向，请改填最终地址',
  upstream_http_error: '上游返回错误', upstream_response_invalid: '上游返回的内容无法识别', upstream_response_too_large: '上游返回的内容过大' };
function probeFailure(value) {
  const reason = (probeErrors[value.error] || value.error) + (value.status ? `（HTTP ${value.status}）` : '') + (value.message ? '：' + value.message : '');
  return [element('p', reason, 'view-error'), facts([['请求地址', value.chat_url || value.models_url]])];
}
// `current` is the saved model's name; an unsaved form passes nothing and offers the ids in its own picker.
function listOutcome(value, current) {
  if (!value.ok) return probeFailure(value);
  const nodes = [element('p', `上游返回 ${value.total} 个模型${value.truncated ? `，只列出按名称排序的前 ${value.models.length} 个` : ''}。`, 'view-success')];
  if (current !== undefined) nodes.push(note(value.models.includes(current) ? `当前模型名 ${current} 在列表中。`
    : `当前模型名 ${current} 不在${value.truncated ? '列出的部分' : '列表'}中；上游没有列出的名字也可能可用，可以用「测试模型」确认。`));
  if (value.models.length) nodes.push(collapsible(`模型 id（${value.models.length}）`, value.models.join('\n')));
  return nodes;
}
function testOutcome(value) {
  if (!value.ok) return probeFailure(value);
  const reply = value.reply || (value.finish_reason === 'length' ? '（空，已达到测试的输出上限）' : '（空）');
  return [element('p', `测试通过 · HTTP ${value.status} · ${value.elapsed_ms} ms`, 'view-success'), facts([['上游返回的模型', value.model || '（未返回）'], ['回复摘录', reply]])];
}
// A button that runs one upstream call and writes its outcome to `result`; a newer call or `stale()` discards older answers.
function probeButton(caption, result, call, render, check = () => '') {
  const run = button(caption, async () => {
    const problem = check(); if (problem) { result.replaceChildren(element('p', problem, 'view-error')); return; }
    const request = result.dataset.request = String(Number(result.dataset.request || 0) + 1);
    run.disabled = true; result.replaceChildren(element('p', `正在${caption}…`, 'view-progress'));
    try { const value = await call(); if (result.dataset.request === request) result.replaceChildren(...render(value)); }
    catch (err) { if (result.dataset.request === request) result.replaceChildren(element('p', err.message, 'view-error')); }
    finally { run.disabled = false; }
  });
  return run;
}
// Fields of an unsaved model: URL with its resolved addresses, key, name with an optional pick from the upstream list.
function modelFields(repositoryId) {
  const url = input('api_url', '', { type: 'url', required: true, placeholder: 'https://example.com/v1' }), key = input('api_key', '', { type: 'password', required: true, autocomplete: 'new-password' });
  const name = input('model_name', '', { required: true, maxLength: 200 }), picker = document.createElement('select'), pick = field('从上游列表选用', picker);
  const preview = element('div', '', 'endpoint-preview'), result = probeResult(), actions = element('div', '', 'actions probe-actions');
  preview.setAttribute('aria-live', 'polite'); pick.hidden = true;
  picker.addEventListener('change', () => { if (picker.value) name.value = picker.value; });
  // A changed address or key makes earlier upstream answers stale; the address preview follows the typing.
  let previewRequest = 0, timer = null;
  const stale = () => { result.dataset.request = String(Number(result.dataset.request || 0) + 1); result.replaceChildren(); pick.hidden = true; picker.replaceChildren(); };
  url.addEventListener('input', () => {
    stale(); clearTimeout(timer); const value = url.value.trim(), request = ++previewRequest;
    if (!value) { preview.replaceChildren(); return; }
    timer = setTimeout(async () => {
      try { const endpoints = await api('/api/models/endpoints?api_url=' + encodeURIComponent(value)); if (request === previewRequest) preview.replaceChildren(...endpointFacts(endpoints)); }
      catch { if (request === previewRequest) preview.replaceChildren(element('p', '地址无效：需要 http:// 或 https://，不能包含用户名、密码、? 或 #。', 'endpoint-warning')); }
    }, 250);
  });
  key.addEventListener('input', stale);
  const missing = labels => () => { const empty = labels.filter(([el]) => !el.value.trim()).map(([, label]) => label); return empty.length ? `先填写${empty.join('、')}` : ''; };
  const target = () => ({ repository_id: repositoryId, api_url: url.value.trim(), api_key: key.value });
  actions.append(
    probeButton('获取模型列表', result, () => api('/api/models/upstream', 'POST', target()), value => {
      if (!value.ok) return listOutcome(value);
      picker.replaceChildren(new Option(value.models.length ? '选择一个模型 id' : '上游没有列出模型', ''), ...value.models.map(id => new Option(id, id)));
      pick.hidden = !value.models.length;
      return [...listOutcome(value).slice(0, 1), note('可以在「从上游列表选用」中选择，也可以在「模型名」里直接填写列表外的名字。')];
    }, missing([[url, '接口 URL'], [key, 'API Key']])),
    probeButton('测试模型', result, () => api('/api/models/test', 'POST', { ...target(), model_name: name.value.trim() }), testOutcome, missing([[url, '接口 URL'], [key, 'API Key'], [name, '模型名']])));
  return [field('接口 URL', url), note(modelUrlRule), preview, field('API Key', key), field('模型名', name), pick, actions, result];
}

function reviewSection() {
  const { policy } = current, language = document.createElement('select'); language.name = 'review_language';
  for (const [value, caption] of [['auto', '跟随 Issue／PR 的语言'], ['zh', '简体中文'], ['en', 'English']]) language.add(new Option(caption, value));
  language.value = policy.review_language || 'auto';
  const nodes = [checkbox('review_enabled', policy.review_enabled, '检视这个项目的 Issue 和 PR'),
    element('h4', '何时检视'), checkbox('review_issues', policy.review_issues, '新打开的 Issue'), checkbox('review_pull_requests', policy.review_pull_requests, '新打开或从草稿转为可检视的 PR'),
    checkbox('review_pr_updates', policy.review_pr_updates, 'PR 推送新提交后（bot PR 的自动跟进也依赖它）'), note('草稿 PR 不检视；编辑、评论和重新打开不额外触发。行内评论固定 COMMENT，不会批准、请求修改或合并。'),
    field('评论语言', language)];
  return [settingsForm('检视开关', nodes, form => patchPolicy(changed({
    review_enabled: form.elements.review_enabled.checked, review_issues: form.elements.review_issues.checked, review_pull_requests: form.elements.review_pull_requests.checked,
    review_pr_updates: form.elements.review_pr_updates.checked, review_language: form.elements.review_language.value }, { review_enabled: !!policy.review_enabled,
    review_issues: !!policy.review_issues, review_pull_requests: !!policy.review_pull_requests, review_pr_updates: !!policy.review_pr_updates, review_language: policy.review_language || 'auto' }))),
    ...['.bot/rules/issue-review.md', '.bot/rules/pr-review.md', '.bot/rules/labels.md'].map(ruleCard)];
}

function developmentSection() {
  const { policy } = current;
  const nodes = [checkbox('development_enabled', policy.development_enabled, '自动开发：Issue 明确要求改代码时，在虚拟电脑里实现、测试并开 bot PR'),
    field('测试命令', input('test_command', policy.test_command, { maxLength: 2048, placeholder: '如 npm test；留空时使用模型给出的命令' })),
    field('bot PR 自动修订轮数', input('max_revisions', policy.max_revisions, { type: 'number', min: 0, max: 10, step: 1 })),
    note('开发只在检视开启时衔接：Issue 检视认定需要改代码、给出原文依据且不缺信息时才创建开发任务。测试不通过不推分支、不开 PR；别人的 PR 只评论，不会推送到作者分支。')];
  return [settingsForm('开发开关', nodes, form => patchPolicy(changed({ development_enabled: form.elements.development_enabled.checked, test_command: form.elements.test_command.value,
    max_revisions: Number(form.elements.max_revisions.value) }, { development_enabled: !!policy.development_enabled, test_command: policy.test_command || '', max_revisions: policy.max_revisions }))),
    ruleCard('.bot/rules/issue-development.md')];
}

function membersSection() {
  const section = card('项目管理员'), list = element('ul', '', 'history'), add = element('div', '', 'actions member-add');
  section.append(note('项目管理员可以管理这个项目的检视、开发、模型和虚拟电脑启停，看到它的任务、日志和投递；不能修改机器配置或其他项目。'), list, add);
  (async () => {
    const [{ users }, { assignments }] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    const assigned = user => assignments.filter(a => a.user_id === user.id).map(a => a.repository_id);
    const update = async (user, ids) => { await api('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: ids }).catch(error); await reloadProject(); };
    for (const user of users.filter(u => u.role === 'project_admin' && assigned(u).includes(current.id))) {
      const li = element('li', ''); li.append(element('span', user.username + (user.active ? '' : '（已停用）')), button('移除', () => update(user, assigned(user).filter(id => id !== current.id)))); list.append(li);
    }
    if (!list.childElementCount) list.append(element('li', '还没有项目管理员，超级管理员可以管理全部项目。', 'muted'));
    const candidates = users.filter(u => u.role === 'project_admin' && u.active && !assigned(u).includes(current.id)), select = document.createElement('select');
    select.add(new Option(candidates.length ? '选择项目管理员' : '没有可添加的项目管理员（在“用户”页创建）', '')); candidates.forEach(u => select.add(new Option(u.username, u.id)));
    add.append(select, button('添加', () => { const user = candidates.find(u => u.id === select.value); if (user) update(user, [...assigned(user), current.id]); }));
  })().catch(err => list.replaceChildren(element('li', err.message, 'view-error')));
  return [section];
}

function activitySection() { const box = element('div', '', 'status-grid'); box.id = 'activity-status'; box.append(...activityCards()); return [box]; }
function activityCards() {
  const environment = current.environment; if (!environment) return [note('暂时读不到运行记录。')];
  const { running_tasks: running = [], task_concurrency: limit, tasks, commands } = environment, work = card(`正在执行 ${running.length}／${limit ?? 1}`);
  const list = element('ul', '', 'history');
  for (const task of running) { const row = element('li', ''); row.append(button(`${kindLabels[task.kind] || task.kind} #${task.object_number}`, () => openTask(task.id), 'quiet linkish'), state(task.status)); list.append(row); }
  work.append(running.length ? list : note('空闲。'), note(`这台虚拟电脑最多同时执行 ${limit ?? 1} 个任务，其余任务排队。`));
  const recent = card('最近任务'), taskList = element('ul', '', 'history');
  for (const task of tasks) {
    const row = element('li', ''); row.append(button(`${kindLabels[task.kind] || task.kind} #${task.object_number}`, () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `${task.generation ? 'g' + task.generation + ' · ' : ''}${timestamp(task.updated_at)}`, 'muted wide-cell'),taskMetricsLine(task)); taskList.append(row);
  }
  recent.append(tasks.length ? taskList : note('还没有任务。'));
  const history = card('最近在虚拟电脑上执行的命令'), commandList = element('ul', '', 'history commands');
  for (const command of commands) {
    const row = element('li', ''); row.append(element('code', '$ ' + clipText(command.command, 160)), exitBadge(command));
    row.append(element('span', `${command.created_at ? command.created_at.slice(11, 19) + ' · ' : ''}${kindLabels[command.kind] || command.kind} #${command.object_number}`, 'muted wide-cell')); commandList.append(row);
  }
  history.append(commands.length ? commandList : note('还没有命令记录。'));
  return [work, recent, history];
}

// One rule file: what it does, where the effective text comes from, and the project console override (edited on demand).
function ruleCard(path) {
  const [, purpose, task] = ruleInfo(path), row = current.rules?.files.find(file => file.path === path), section = card(purpose);
  section.classList.add('rule-card'); section.dataset.rulePath = path;
  if (!row) { section.append(note(current.rules ? '仓库没有这个文件。' : '暂时读不到规则文件，稍后再试。')); return section; }
  const meta = element('div', '', 'rule-meta'); meta.append(element('code', path), badge('生效：' + layerNames[row.source], row.source === 'builtin' ? '' : 'info'), element('span', '用于' + (/^[A-Za-z]/.test(task) ? ' ' : '') + task, 'muted'));
  section.append(meta);
  if (current.ruleNotice?.path === path) { const done = element('p', current.ruleNotice.text, 'view-success flash'); done.setAttribute('role', 'status'); section.append(done); current.ruleNotice = null; }
  // Short files are shown open; long ones stay folded with their size so the page remains scannable.
  const lines = row.effective.split('\n').length;
  section.append(collapsible(lines > 15 ? `当前生效内容（${lines} 行）` : '当前生效内容', row.effective, lines <= 15));
  for (const layer of row.layers) if (layer.source !== row.source) section.append(collapsible(`${layerNames[layer.source]}（被覆盖）`, layer.content));
  if (!path.startsWith('.bot/rules/') && path !== '.bot/guide.md') return section;
  const consoleLayer = row.layers.find(layer => layer.source === 'console'), actions = element('div', '', 'actions'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  section.append(note(row.source === 'repository' ? (consoleLayer ? '默认分支的仓库文件整份覆盖控制台内容；控制台覆盖只在仓库删除该文件后生效。' : '默认分支的仓库文件整份覆盖内置默认；在这里添加的控制台覆盖只在仓库删除该文件后生效。')
    : consoleLayer ? '项目控制台覆盖了内置默认；默认分支加入同名仓库文件后以仓库为准。' : '使用内置默认。保存控制台覆盖后整份替换内置内容；默认分支加入同名仓库文件后以仓库为准。'), actions, message);
  const save = async content => {
    try { const { rules } = await api(`/api/repositories/${current.id}/rules`, 'PUT', { path, content }); current.rules = rules;
      current.ruleNotice = { path, text: content === null ? '已清除控制台覆盖' : '已保存控制台覆盖' }; current.focusRule = path; renderProject({ id: current.id, section: current.section }); }
    catch (err) { message.textContent = err.message; }
  };
  // Browse first, edit on demand: the editor starts from the console text, or from the built-in default when there is none.
  actions.append(button(consoleLayer ? '编辑控制台覆盖' : '添加控制台覆盖', () => {
    const form = document.createElement('form'), editor = textarea('rule_content', consoleLayer?.content ?? row.layers[0].content, { rows: 8, spellcheck: false, className: 'code' }), buttons = element('div', '', 'actions');
    form.className = 'project-form rule-editor'; editor.setAttribute('aria-label', path + ' 控制台覆盖');
    const submit = element('button', '保存'); submit.type = 'submit'; buttons.append(submit, button('取消', () => { form.remove(); actions.hidden = false; }));
    form.append(editor, buttons); form.addEventListener('submit', event => { event.preventDefault(); submit.disabled = true; save(editor.value).finally(() => { submit.disabled = false; }); });
    actions.hidden = true; actions.after(form); editor.focus();
  }));
  if (consoleLayer) actions.append(button('清除控制台覆盖', async () => {
    if (await askConfirm({ title: `清除 ${path} 的控制台覆盖？`, body: ['清除后回到仓库文件或内置默认的内容。'], action: '清除', danger: true })) save(null);
  }));
  return section;
}

// One place to see every rule file: purpose, path, tasks, and which layer wins.
function rulesSection() {
  const id = current.id, rules = current.rules, overview = card('规则总览'), message = element('p', '', 'view-error'), head = element('div', '', 'actions');
  overview.classList.add('rule-overview'); message.setAttribute('role', 'alert');
  overview.append(note('每个任务读取自己的规则文件，行为指南和虚拟电脑对全部任务生效。优先级：内置默认 → 项目控制台 → 默认分支仓库文件，后一层存在时整份覆盖前一层；PR 里改动的规则文件合入默认分支后才生效。'));
  if (!rules) { overview.append(note('暂时读不到规则文件，稍后再试。')); return [overview]; }
  const source = note(rules.sha ? `仓库文件来自默认分支提交 ${rules.sha.slice(0, 12)} · ${timestamp(rules.updated_at)}` : '尚未读取默认分支，下表只含内置与控制台配置。'); if (rules.sha) source.title = rules.sha;
  overview.append(source, head, message);
  const refresh = button('刷新默认分支文件', async () => {
    refresh.disabled = true; refresh.textContent = '正在读取默认分支…'; message.textContent = '';
    try { const result = await api(`/api/repositories/${id}/rules/refresh`, 'POST', {}); current.rules = result.rules; current.flash = `已读取默认分支提交 ${result.rules.sha.slice(0, 12)}`; renderProject({ id, section: 'rules' }); }
    catch (err) { message.textContent = err.message; refresh.disabled = false; refresh.textContent = '刷新默认分支文件'; }
  });
  head.append(refresh);
  const table = document.createElement('table'), body = document.createElement('tbody'); table.className = 'rule-table';
  const headRow = document.createElement('tr'); for (const caption of ['作用', '文件', '用于', ...Object.values(layerNames), '']) headRow.append(element('th', caption));
  table.createTHead().append(headRow); table.append(body);
  const known = ruleFiles.map(([path]) => path), skills = rules.files.filter(file => !known.includes(file.path));
  for (const path of [...known, ...skills.map(file => file.path)]) {
    const [, purpose, task, target] = ruleInfo(path), row = rules.files.find(file => file.path === path), tr = document.createElement('tr');
    const cell = (label, ...nodes) => { const td = document.createElement('td'); td.dataset.label = label; td.append(...nodes); tr.append(td); };
    cell('作用', element('strong', purpose)); cell('文件', element('code', path)); cell('用于', task);
    // Each layer is the winner, present but overridden, or absent.
    for (const [source, caption] of Object.entries(layerNames)) cell(caption, !row?.layers.some(layer => layer.source === source) ? element('span', '—', 'muted') : row.source === source ? badge('生效', 'success') : badge('被覆盖'));
    const open = () => { current.focusRule = path; if (current.section === target) renderProject({ id, section: target }); else openProject(id, target); };
    cell('', button(path.startsWith('.agents/') ? '查看' : '编辑', open));
    body.append(tr);
  }
  const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); overview.append(wrap);
  // The behavior guide applies to every task, so it is edited here; repository skills are read-only text.
  return [overview, ruleCard('.bot/guide.md'), ...skills.map(file => ruleCard(file.path))];
}
