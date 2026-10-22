// Project pages: one settings page per repository with categories on the left (#/projects/<id>/<section>).
// Loaded after app.js and views.js and reuses their helpers.
const projectSections = [['basic', '基本设置'], ['machine', '机器配置'], ['model', '使用的模型'], ['review', '检视规则'], ['development', '开发设置'], ['rules','生效规则'], ['members', '成员', true], ['activity', '运行记录']];
const specFields = ['cpus', 'memory_mb', 'pids', 'tmp_mb', 'max_command_minutes'];
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
    try { const done = await save(form, text => { message.className = 'view-progress'; message.textContent = text; }); current.flash = done || '已保存'; await reloadProject(); }
    catch (err) { message.className = 'view-error'; message.textContent = err.message; } finally { submit.disabled = false; }
  });
  section.append(form); return section;
}

let current = null, projectTimer = null, renderToken = 0;
// Loads the project once per visit and re-renders the active section; status cards refresh on their own.
async function renderProject(route) {
  const token = ++renderToken, page = $('project-page'); clearTimeout(projectTimer);
  if (current?.id !== route.id) { current = { id: route.id }; page.replaceChildren(element('p', '正在加载…', 'muted')); }
  try { await loadProject(route.id); } catch (err) { if (token === renderToken) page.replaceChildren(element('p', err.message, 'view-error')); return; }
  if (token !== renderToken) return;
  const section = projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin')) ? route.section : 'basic';
  current.section = section; page.replaceChildren(projectHeader(), projectBody(section));
  if(section==='rules')page.querySelector('.project-nav [aria-current=page]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  if (['machine', 'activity'].includes(section)) refreshProjectStatus(token);
}
async function loadProject(id) {
  const superUser = me.role === 'super_admin';
  const [repo, environment, installed] = await Promise.all([api('/api/repositories/' + id), api('/api/environments/' + id).catch(() => null), superUser ? api('/api/installations').catch(() => null) : null]);
  Object.assign(current, { repository: repo.repository, policy: repo.policy, environment, installed: installed?.repositories.find(r => r.id === id) || null });
}
async function reloadProject() { await loadProject(current.id); renderProject({ id: current.id, section: current.section }); }
function projectStatus() {
  const { policy, installed } = current;
  const status = !policy.enabled ? badge('已禁用', 'warning') : policy.review_enabled ? badge('工作中', 'success') : badge('未开检视', 'warning');
  return [status, ...(installed?.installed === false ? [badge('已移出安装', 'danger')] : []), ...(current.environment ? [state(current.environment.environment.state)] : [])];
}
function projectHeader() {
  const { repository, policy } = current, head = element('div', '', 'project-head'), title = element('div', '', 'title-group'), actions = element('div', '', 'actions');
  const back = element('a', '← 全部项目', 'back-link'); back.href = '#/projects';
  title.append(element('h1', repository.full_name), ...projectStatus());
  actions.append(link(`https://github.com/${repository.full_name}`, '在 GitHub 打开', 'button-link'));
  if (me.role === 'super_admin') actions.append(policy.enabled
    ? button('禁用项目', async () => { if (confirm(`禁用 ${repository.full_name}？新的 Issue／PR 不再处理，正在执行的任务会中止，虚拟电脑停止但数据保留。`)) { await api(`/api/installations/${current.id}/disable`, 'POST', {}).catch(error); await reloadProject(); } })
    : button('启用项目', async () => { await api(`/api/installations/${current.id}/activate`, 'POST', {}).catch(error); await reloadProject(); }, ''));
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
  content.append(...({ basic: basicSection, machine: machineSection, model: modelSection, review: reviewSection, development: developmentSection, rules: rulesSection, members: membersSection, activity: activitySection }[section])());
  body.append(nav, content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

function basicSection() {
  const { repository, policy, installed, environment } = current, info = card('仓库');
  info.append(facts([['仓库', link(`https://github.com/${repository.full_name}`, repository.full_name)], ['仓库 ID', repository.id], ['所有者', installed?.owner_login ? `${installed.owner_login}（${repository.owner_id}）` : repository.owner_id],
    ['处理账号', installed?.account_name || repository.account_id], ['安装', installed ? installed.installation_id ? `安装 ${installed.installation_id}${installed.installed === false ? '（已移出）' : ''}` : '手动登记' : null],
    ['可见性', installed ? installed.private ? '私有' : '公开' : null], ['项目状态', policy.enabled ? '已启用' : '已禁用'], ['虚拟电脑', environment ? (states[environment.environment.state] || [environment.environment.state])[0] : '读取失败']]));
  const summary = card('当前配置一览');
  summary.append(facts([['检视', policy.review_enabled ? '开启' : '关闭'], ['自动开发', policy.development_enabled ? '开启' : '关闭'], ['模型', policy.model_id ? '已选择' : '未选择，任务会等待配置'],
    ['机器', environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null]]));
  const branch = settingsForm('分支', [field('基准分支', input('base_branch', policy.base_branch, { maxLength: 256, placeholder: '留空使用仓库默认分支' })),
    note('开发任务从这个分支拉取代码并向它开 PR；检视 Issue 时也读取这个分支的代码。')],
  form => patchPolicy(changed({ base_branch: form.elements.base_branch.value.trim() }, { base_branch: policy.base_branch || '' })));
  return [info, summary, branch];
}

function machineSection() {
  const { environment } = current, pc = environment?.environment.computer, editable = me.role === 'super_admin' && !!pc;
  const status = element('div', '', 'status-grid'); status.id = 'machine-status'; status.append(...machineStatus());
  if (!pc) return [status, note('暂时读不到虚拟电脑规格，稍后再试。')];
  const number = (name, step) => input(name, pc[name], { type: 'number', step, min: pc.bounds?.[name]?.[0] ?? '', max: pc.bounds?.[name]?.[1] ?? '' });
  const nodes = [
    note(editable ? '保存后虚拟电脑按新配置重建：工作卷和代次保留，正在执行的命令先执行完，任务保留的后台进程会结束。新增软件包时会先构建镜像，首次可能需要几分钟。' : '机器配置由超级管理员设置。'),
    element('h4', '资源'),
    (() => { const grid = element('div', '', 'field-grid'); grid.append(field('CPU（核）', number('cpus', '0.25')), field('内存（MB）', number('memory_mb', '128')), field('进程数上限', number('pids', '1')),
      field('/tmp 大小（MB）', number('tmp_mb', '16')), field('单条命令最长时间（分钟）', number('max_command_minutes', '1'))); return grid; })(),
    checkbox('egress', pc.network_policy === 'internet egress', '允许访问外网（安装依赖、访问测试地址）'),
    element('h4', '软件'),
    note(pc.build?.toolchain ? '镜像已包含：' + pc.build.toolchain : ''),
    field('额外系统软件包', textarea('packages', packagesText(pc.packages), { rows: 2, spellcheck: false, placeholder: 'Debian 包名，空格或换行分隔，例如 ffmpeg libpq-dev' })),
    field('环境变量', textarea('env', envText(pc.env), { rows: 3, spellcheck: false, placeholder: '每行 名称=值。对仓库代码可见，不要填写密钥' })),
    field('初始化脚本', textarea('setup_script', pc.setup_script || '', { rows: 5, spellcheck: false, className: 'code', placeholder: '以项目用户在 /workspace 运行，HOME=/workspace/home 持久保存，可联网；脚本或代次变化时重新运行' })),
    checkbox('rerun_setup', false, '保存后重新运行初始化脚本')];
  const form = settingsForm('配置', nodes, async (form, progress) => {
    const spec = {};
    for (const name of specFields) if (Number(form.elements[name].value) !== pc[name]) spec[name] = Number(form.elements[name].value);
    if (form.elements.egress.checked !== (pc.network_policy === 'internet egress')) spec.egress = form.elements.egress.checked;
    const packages = [...new Set(form.elements.packages.value.split(/[\s,]+/).filter(Boolean))];
    if (packages.slice().sort().join(' ') !== [...(pc.packages || [])].sort().join(' ')) spec.packages = packages;
    const env = parseEnv(form.elements.env.value); if (envText(env) !== envText(pc.env)) spec.env = env;
    if (form.elements.setup_script.value !== (pc.setup_script || '')) spec.setup_script = form.elements.setup_script.value;
    if (form.elements.rerun_setup.checked) spec.rerun_setup = true;
    if (!Object.keys(spec).length) return '没有改动';
    progress(spec.packages ? '正在安装软件包并重建虚拟电脑，首次可能需要几分钟…' : spec.setup_script !== undefined || spec.rerun_setup ? '正在重建虚拟电脑并运行初始化脚本…' : '正在按新配置重建虚拟电脑…');
    await api(`/api/environments/${current.id}/configure`, 'POST', { operation_id: operationId(), generation: environment.environment.generation, spec });
    return '已保存，虚拟电脑已按新配置重建';
  }, { editable });
  return [status, form];
}
// Status cards of the machine section, re-rendered by the refresh loop without touching the form.
function machineStatus() {
  const environment = current.environment; if (!environment) return [note('暂时读不到虚拟电脑状态。')];
  const env = environment.environment, pc = env.computer || {}, machine = card('机器'), lifecycle = element('div', '', 'actions');
  machine.append(facts([['状态', state(env.state)], ['容器', pc.container], ['代次', env.generation ? 'g' + env.generation : '待创建'], ['启动于', timestamp(env.started_at)],
    ['工作卷', pc.volume ? `${pc.volume} → ${pc.workdir}` : null], ['网络', pc.network ? `${pc.network}（${networkText(pc)}）` : null], ['镜像', pc.image ? pc.image.slice(0, 19) : null],
    ['运行用户', pc.user], ['根文件系统', pc.root_filesystem === 'read-only' ? '只读；HOME 和工作区在工作卷中持久保存' : pc.root_filesystem], ['故障', env.error]]));
  lifecycle.append(...environmentButtons(env, environment.current_task, reloadProject, error)); machine.append(lifecycle);
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
    for (const m of models) choices.append(option(m.id, m.model_name, `${m.repository_id ? '本项目专属' : '部署共享'} · ${hostOf(m.api_url)}${m.key_configured ? '' : ' · Key 已撤销'}`, policy.model_id === m.id));
    save.type = 'button'; save.addEventListener('click', async () => {
      const value = choices.querySelector('input:checked')?.value || null; save.disabled = true;
      try { await patchPolicy(changed({ model_id: value }, { model_id: policy.model_id || null })); await reloadProject(); } catch (err) { message.textContent = err.message; save.disabled = false; }
    });
    const actions = element('div', '', 'actions form-actions'); actions.append(save); list.replaceChildren(choices, message, actions);
    const row = (m, target) => { const li = element('li', ''); li.append(element('span', `${m.model_name} · ${hostOf(m.api_url)}`), modelActions(m)); target.append(li); };
    models.filter(m => m.repository_id === current.id).forEach(m => row(m, ownList)); if (!ownList.childElementCount) ownList.append(element('li', '还没有专属模型。', 'muted'));
    models.filter(m => m.repository_id === null).forEach(m => row(m, sharedList)); if (!sharedList.childElementCount) sharedList.append(element('li', '还没有共享模型。', 'muted'));
  })().catch(err => list.replaceChildren(element('p', err.message, 'view-error')));
  own.append(modelForm('添加专属模型', current.id));
  const sections = [chooser, own];
  if (superUser) { shared.append(modelForm('添加部署共享模型', null)); sections.push(shared); }
  return sections;
}
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
// Rotating or revoking a key never shows it; an empty key field keeps the current one.
function modelActions(model) {
  const actions = element('div', '', 'actions'), editable = me.role === 'super_admin' || model.repository_id === current.id;
  if (!editable) return actions;
  actions.append(button('更换 Key', async () => {
    const key = prompt(`为 ${model.model_name} 输入新的 API Key（不会回显）`); if (!key?.trim()) return;
    await api('/api/models/' + model.id, 'PATCH', { version: model.version, api_key: key.trim() }).catch(error); await reloadProject();
  }));
  if (model.key_configured) actions.append(button('撤销 Key', async () => {
    if (!confirm(`撤销 ${model.model_name} 的 API Key？使用它的项目会停在“配置待补”。`)) return;
    await api(`/api/models/${model.id}/credentials/revoke`, 'POST', {}).catch(error); await reloadProject();
  }));
  return actions;
}
function modelForm(title, repositoryId) {
  const details = element('details', '', 'fold add-model'); details.append(element('summary', title));
  const form = settingsForm(title, [field('接口 URL', input('api_url', '', { type: 'url', required: true, placeholder: 'https://example.com/v1' })),
    field('模型名', input('model_name', '', { required: true, maxLength: 200 })), field('API Key', input('api_key', '', { type: 'password', required: true, autocomplete: 'new-password' })),
    note('兼容 Chat Completions 的接口；Key 加密保存，不会再显示。保存即视为可信接口，可接收本项目的代码和日志。')],
  async form => { const created = (await api('/api/models', 'POST', { repository_id: repositoryId, api_url: form.elements.api_url.value.trim(), model_name: form.elements.model_name.value.trim(), api_key: form.elements.api_key.value }));
    return `已添加 ${created.model.model_name}，可在“使用的模型”里选择`; }, { caption: '添加' });
  form.querySelector('h3').remove(); details.append(form); return details;
}

function reviewSection() {
  const { policy } = current, language = document.createElement('select'); language.name = 'review_language';
  for (const [value, caption] of [['auto', '跟随 Issue／PR 的语言'], ['zh', '简体中文'], ['en', 'English']]) language.add(new Option(caption, value));
  language.value = policy.review_language || 'auto';
  const nodes = [checkbox('review_enabled', policy.review_enabled, '检视这个项目的 Issue 和 PR'),
    element('h4', '何时检视'), checkbox('review_issues', policy.review_issues, '新打开的 Issue'), checkbox('review_pull_requests', policy.review_pull_requests, '新打开或从草稿转为可检视的 PR'),
    checkbox('review_pr_updates', policy.review_pr_updates, 'PR 推送新提交后（bot PR 的自动跟进也依赖它）'), note('草稿 PR 不检视；编辑、评论和重新打开不额外触发。'),
    element('h4', '怎么写'), field('评论语言', language),
    field('项目检视指引', textarea('review_instructions', policy.review_instructions, { rows: 7, maxLength: 8000, placeholder: '写给检视 Agent 的项目规则，例如：\n- 重点关注 API 兼容性和数据迁移\n- 新增功能必须有测试，否则作为发现提出\n- 不评论代码格式，由 CI 检查' })),
    note('指引作为管理员配置传给模型；仓库里的内容仍按不可信数据处理。行内评论固定为 COMMENT，不会批准、请求修改或合并。'),
    field('检视后打的标签', input('review_label', policy.review_label, { maxLength: 50, placeholder: '未设置时使用生效规则，默认 bot-reviewed' })),note('最终标签以「生效规则」为准，仓库文件优先。已有控制台标签可清空保存以关闭；未设置时使用内置默认。')];
  return [settingsForm('检视规则', nodes, form => patchPolicy(changed({
    review_enabled: form.elements.review_enabled.checked, review_issues: form.elements.review_issues.checked, review_pull_requests: form.elements.review_pull_requests.checked,
    review_pr_updates: form.elements.review_pr_updates.checked, review_language: form.elements.review_language.value, review_instructions: form.elements.review_instructions.value,
    review_label: form.elements.review_label.value.trim() }, { review_enabled: !!policy.review_enabled, review_issues: !!policy.review_issues, review_pull_requests: !!policy.review_pull_requests,
    review_pr_updates: !!policy.review_pr_updates, review_language: policy.review_language || 'auto', review_instructions: policy.review_instructions || '', review_label: policy.review_label || '' })))];
}

function developmentSection() {
  const { policy } = current;
  const nodes = [checkbox('development_enabled', policy.development_enabled, '自动开发：Issue 明确要求改代码时，在虚拟电脑里实现、测试并开 bot PR'),
    field('测试命令', input('test_command', policy.test_command, { maxLength: 2048, placeholder: '如 npm test；留空时使用模型给出的命令' })),
    field('bot PR 自动修订轮数', input('max_revisions', policy.max_revisions, { type: 'number', min: 0, max: 10, step: 1 })),
    note('开发只在检视开启时衔接：Issue 检视认定需要改代码、给出原文依据且不缺信息时才创建开发任务。测试不通过不推分支、不开 PR；别人的 PR 只评论，不会推送到作者分支。')];
  return [settingsForm('开发设置', nodes, form => patchPolicy(changed({ development_enabled: form.elements.development_enabled.checked, test_command: form.elements.test_command.value,
    max_revisions: Number(form.elements.max_revisions.value) }, { development_enabled: !!policy.development_enabled, test_command: policy.test_command || '', max_revisions: policy.max_revisions })))];
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
  const { current_task: running, tasks, commands } = environment, work = card('正在执行');
  work.append(running ? button(`${kindLabels[running.kind] || running.kind} #${running.object_number} · ${(states[running.status] || [running.status])[0]}`, () => openTask(running.id), 'quiet linkish') : note('空闲。每个项目同一时间只执行一个任务。'));
  const recent = card('最近任务'), taskList = element('ul', '', 'history');
  for (const task of tasks) {
    const row = element('li', ''); row.append(button(`${kindLabels[task.kind] || task.kind} #${task.object_number}`, () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `${task.generation ? 'g' + task.generation + ' · ' : ''}${timestamp(task.updated_at)}`, 'muted wide-cell')); taskList.append(row);
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

function rulesSection(){
  const id=current.id,section=card('生效规则与来源');section.append(note('内置默认 → 项目控制台 → 默认分支仓库文件；PR 中的新行为文件不会直接启用。机器资源沿用「机器配置」。'));
  async function load(refresh=false){
    const {rules}=await api(`/api/repositories/${id}/rules${refresh?'/refresh':''}`,refresh?'POST':'GET',refresh?{}:undefined);
    if(current.id!==id||current.section!=='rules')return;
    const select=document.createElement('select');select.setAttribute('aria-label','规则文件');rules.files.forEach(row=>select.add(new Option(row.path,row.path)));
    const head=element('div','','actions');head.append(button('刷新默认分支文件',()=>load(true).catch(error)),button('打开机器配置',()=>openProject(id,'machine')));
    section.replaceChildren(element('h3','生效规则与来源'),note(rules.sha?`来源提交 ${rules.sha} · ${timestamp(rules.updated_at)}`:'尚未读取默认分支。当前展示内置与控制台配置，请点击刷新。'),head,field('规则文件',select));
    const detail=element('div','','rule-layers');section.append(detail);
    function show(){
      const row=rules.files.find(item=>item.path===select.value),names={builtin:'内置默认',console:'项目控制台',repository:'仓库文件'};
      detail.replaceChildren(element('p','最终来源：'+names[row.source],'rule-source'),collapsible('最终生效内容',row.effective,true));
      for(const layer of row.layers)detail.append(collapsible(names[layer.source]+' · '+row.path,layer.content));
      if(row.path==='.bot/computer.yaml'){
        detail.append(note('这些值合并到现有 manager 的项目电脑规格。任务准备时应用默认分支的配置；手动应用仅限超级管理员。'));
        if(me.role==='super_admin')detail.append(button('应用到此项目电脑',async()=>{try{await api(`/api/repositories/${id}/rules/apply-computer`,'POST',{});await load();}catch(e){error(e);}}));
      }else if(row.path.startsWith('.bot/')){
        const consoleLayer=row.layers.find(layer=>layer.source==='console'),editor=textarea('rule_content',consoleLayer?.content??'',{rows:6,spellcheck:false}),actions=element('div','','actions');
        detail.append(field('项目控制台覆盖内容',editor),note(row.source==='repository'?'该文件已被仓库覆盖。控制台保存仍会保留，但最终以仓库文件为准。':'留空也是明确的空内容；恢复默认请使用清除按钮。'));
        actions.append(button('保存控制台覆盖',async()=>{try{await api(`/api/repositories/${id}/rules`,'PUT',{path:row.path,content:editor.value});await load();}catch(e){error(e);}}),button('清除控制台覆盖',async()=>{try{await api(`/api/repositories/${id}/rules`,'PUT',{path:row.path,content:null});await load();}catch(e){error(e);}}));detail.append(actions);
      }
    }
    select.onchange=show;show();
  }
  void load().catch(error);return [section];
}
