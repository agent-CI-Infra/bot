// Project pages: one settings page per repository with categories on the left (#/projects/<id>/<section>).
// Loaded after app.js and views.js and reuses their helpers.
const projectSections = [['overview', '项目总览'], ['basic', '基本设置'], ['management', '管理对话'], ['machine', '机器配置'], ['roles', '角色'], ['model', '模型'], ['release', '发版本'], ['knowledge', '项目知识'], ['external', '外部执行'], ['members', '成员'], ['activity', '运行状态']];
// Older addresses open the Manager page: the workflows page it replaced, the task overview and the review, development and rule pages.
const legacyProjectSections = { workflows: 'manager-prompt', tasks: '', review: '', development: '', rules: 'rule-sources' };
// Every file has the same three layers: built-in default, project console override, default-branch repository file.
const ruleFiles = [
  ['.bot/guide.md', '行为指南', '全部任务', 'tasks'],
  ['.bot/rules/issue-review.md', 'Issue 检视规则', 'Issue 检视', 'tasks'],
  ['.bot/rules/pr-review.md', 'PR 检视规则', 'PR 检视', 'tasks'],
  ['.bot/rules/labels.md', '检视标签', 'Issue 与 PR 检视', 'tasks'],
  ['.bot/rules/issue-development.md', '开发规则', '开发与跟进 bot PR', 'tasks'],
  ['.bot/computer.yaml', '虚拟电脑', '全部任务', 'machine']];
const layerNames = { builtin: '内置默认', console: '项目控制台', repository: '仓库文件' };
const ruleInfo = path => ruleFiles.find(([p]) => p === path) || [path, '仓库 skill', '全部任务', 'tasks'];
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
// A section may name one item inside it (older workflow addresses did, e.g. #/projects/<id>/workflows/review.pr).
function projectRoute() { const m = /^#\/projects\/([1-9]\d*)(?:\/([a-z]+)(?:\/([\w.-]+))?)?$/.exec(location.hash.split('?')[0]); return m ? { id: m[1], section: m[2] || 'basic', item: m[3] || null } : null; }
function openProject(id, section = 'basic') { location.hash = `#/projects/${id}/${section}`; }
function field(label, control) { const wrap = element('label', label); wrap.append(control); return wrap; }
function input(name, value, attributes = {}) { const el = document.createElement('input'); el.name = name; el.value = value ?? ''; Object.assign(el, attributes); return el; }
function textarea(name, value, attributes = {}) { const el = document.createElement('textarea'); el.name = name; el.value = value ?? ''; Object.assign(el, attributes); return el; }
function checkbox(name, checked, caption) { const box = input(name, '', { type: 'checkbox', checked: !!checked }), wrap = element('label', '', 'check'); wrap.append(box, ' ' + caption); return wrap; }
function note(text) { return element('p', text, 'muted'); }
// The CI observation's advice is the model's Markdown. It is drawn with text nodes only, never parsed as HTML: headings,
// list items and paragraphs keep their lines, and `code`, **bold** and http(s) links become elements.
function releaseAdviceInline(target, text) {
  let at = 0;
  for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    target.append(text.slice(at, match.index));
    target.append(match[1] ? element('code', match[1]) : match[2] ? element('strong', match[2]) : link(match[4], match[3]));
    at = match.index + match[0].length;
  }
  target.append(text.slice(at)); return target;
}
function releaseAdvice(markdown) {
  const box = element('div', '', 'release-advice'); let list = null;
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trimEnd(), heading = /^#{1,6}\s+(.*)$/.exec(line), item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) { list = null; continue; }
    if (heading) { list = null; box.append(releaseAdviceInline(element('h4', ''), heading[1])); continue; }
    if (item) {
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = element(tag, ''); box.append(list); }
      list.append(releaseAdviceInline(element('li', ''), item[2])); continue;
    }
    list = null; box.append(releaseAdviceInline(element('p', ''), line.trim()));
  }
  return box;
}
// A settings form: fields, an error line and a save button; `save` receives the form and reports through the error line.
// `after` receives the result text; without it the project page shows the text and reloads.
const projectSettingDrafts = new Map();
function settingsForm(title, nodes, save, { editable = true, caption = '保存', after = null, draftKey = null } = {}) {
  const target = current, address = location.hash;
  const live = () => current === target && location.hash === address && form.isConnected;
  const section = card(title), form = document.createElement('form'), message = element('p', '', 'view-error'), submit = element('button', caption);
  form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert');
  const set = element('fieldset', ''); set.disabled = !editable; set.append(...nodes); form.append(set, message);
  if (editable) { const actions = element('div', '', 'actions form-actions'); actions.append(submit); form.append(actions); }
  const key = draftKey && `${me.id}:${me.actor?.tenant_id || ''}:${target.id}:${draftKey}`;
  const draftNotice = element('p', '', 'muted'); draftNotice.setAttribute('role', 'status');
  if (key && editable) {
    const valueOf = control => control.type === 'checkbox' ? control.checked : control.value;
    const baseline = Object.fromEntries([...form.elements].filter(c => c.name).map(c => [c.name, valueOf(c)]));
    const draft = { ...projectSettingDrafts.get(key) };
    for (const [name, value] of Object.entries(draft)) {
      const control = form.elements[name]; if (!control) continue;
      if (control.type === 'checkbox') control.checked = value; else control.value = value;
    }
    const update = () => { draftNotice.textContent = Object.keys(draft).length ? '草稿未保存；刷新会保留输入，保存时重新核对当前权限。' : ''; };
    form.addEventListener('input', event => {
      const control = event.target; if (!control.name) return;
      if (valueOf(control) === baseline[control.name]) delete draft[control.name]; else draft[control.name] = valueOf(control);
      projectSettingDrafts.set(key, draft); update();
    });
    update(); form.prepend(draftNotice);
    const discard = button('放弃本组草稿', async () => {
      if (!await askConfirm({ title: '放弃未保存的设置？', body: ['仅清除此组草稿，并读取最新已保存设置。'], action: '放弃草稿' })) return;
      projectSettingDrafts.delete(key); if (live()) await reloadProject();
    }, 'quiet');
    form.querySelector('.form-actions').append(discard);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || !editable || !live()) return; message.className = 'view-error'; message.textContent = '';
    const invalid = [...form.querySelectorAll('input')].find(el => !el.checkValidity());
    if (invalid) {
      const label = invalid.closest('label')?.firstChild?.textContent?.trim() || invalid.name, range = invalid.validity.rangeOverflow || invalid.validity.rangeUnderflow;
      message.textContent = range ? `${label}需在 ${invalid.min}–${invalid.max} 之间` : invalid.validity.stepMismatch ? `${label}的取值步长是 ${invalid.step}` : `${label}：${invalid.validationMessage}`; invalid.focus(); return;
    }
    const submittedDraft = key && projectSettingDrafts.get(key);
    submit.disabled = true; if (key) set.disabled = true;
    // The page re-renders after saving, so the result is shown at the top of the refreshed section.
    try {
      const done = await save(form, text => { message.className = 'view-progress'; message.textContent = text; }), text = typeof done === 'string' && done ? done : '已保存';
      if (key && projectSettingDrafts.get(key) === submittedDraft) projectSettingDrafts.delete(key);
      if (!live()) return;
      if (after) await after(text); else { current.flash = text; await reloadProject(); }
    }
    catch (err) { message.className = 'view-error'; message.textContent = err.message; } finally { submit.disabled = false; set.disabled = !editable; }
  });
  section.append(form); return section;
}

let current = null, projectTimer = null, renderToken = 0;
// Loads the project once per visit and re-renders the active section; status cards refresh on their own.
async function renderProject(route) {
  if (route.section === 'notes') { route = { ...route, section: 'knowledge' }; history.replaceState(null, '', `#/projects/${route.id}/knowledge`); }
  const legacyFocus = legacyProjectSections[route.section];
  if (legacyFocus !== undefined) {
    route = { ...route, section: 'roles', item: null };
    history.replaceState(null, '', `#/projects/${route.id}/roles`);
  }
  const token = ++renderToken, page = $('project-page'); clearTimeout(projectTimer);
  if (current?.id !== route.id) { current = { id: route.id }; page.replaceChildren(element('p', '正在加载…', 'muted')); }
  if (legacyFocus) current.focusAnchor = legacyFocus;
  try { await loadProject(route.id,route.section); } catch (err) { if (token === renderToken) { if ([401,403].includes(err.status) && typeof resetKnowledgeFiles === 'function') resetKnowledgeFiles(); page.replaceChildren(element('p', err.message, 'view-error')); } return; }
  if (token !== renderToken) return;
  const section = projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin')) ? route.section : 'basic';
  // A newly granted or externally created project may not be in the list loaded at login.
  if (!repositories.some(repo => String(repo.id) === String(current.id))) repositories.push(current.repository);
  current.section = section; current.item = route.item || null; page.replaceChildren(projectHeader(), projectBody(section));
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  // The Manager page draws its cards after reading them; the anchor of an older address is scrolled to once they are there.
  if (current.focusAnchor) { const anchor = current.focusAnchor; current.focusAnchor = null;
    const scroll = () => page.querySelector(`[data-overview-anchor="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' });
    if (section === 'roles') current.managerAnchor = scroll; else scroll(); }
  // Opening a rule file from the overview, or saving one, brings its card into view.
  if (current.focusRule) { page.querySelector(`[data-rule-path="${CSS.escape(current.focusRule)}"]`)?.scrollIntoView({ block: 'start' }); current.focusRule = null; }
  if (['machine', 'activity'].includes(section)) refreshProjectStatus(token);
  if (section === 'roles' && current.policy.actions_failures_enabled) projectTimer = setTimeout(() => refreshActionsFailureStatus(token), 5000);
}
async function loadProject(id,section=current.section) {
  const superUser = me.role === 'super_admin';
  // Capture the visited object before awaiting: a different project replaces current while this request is in flight.
  const overview = section === 'overview', target = current;
  const [repo, environment, installed, rules, models] = await Promise.all([api('/api/repositories/' + id), overview ? null : api('/api/environments/' + id).catch(() => null), superUser ? api('/api/installations').catch(() => null) : null, overview ? null : api('/api/repositories/'+id+'/rules').catch(()=>null), overview ? null : api(superUser ? '/api/models' : '/api/models?repository_id='+id).catch(()=>null)]);
  const external=section==='external'?await loadExternalProject(id):null;
  Object.assign(target, { external, repository: repo.repository, canConfigure: repo.can_configure, policy: repo.policy, actionsFailures: repo.actions_failures, concurrencyDefault: repo.task_concurrency_default, environment, environmentReadError:'', installed: installed?.repositories.find(r => r.id === id) || null, rules:rules?.rules,
    models:(models?.models||[]).filter(model=>model.repository_id===null||model.repository_id===id) });
}
async function reloadProject() {
  const target = current, route = { id: target.id, section: target.section, item: target.item };
  await loadProject(target.id, target.section);
  if (current === target && projectRoute()?.id === route.id && projectRoute()?.section === route.section) return renderProject(route);
}
// Reloads the project with the outcome of an action shown at the top of the section.
async function reloadWith(notice) { if (notice) current.flash = notice; await reloadProject(); }
function projectStatus() {
  const { policy, installed } = current;
  const status = !policy.enabled ? badge('已禁用', 'warning') : badge('已启用', 'info');
  const permission = installed?.access_gaps?.length ? [permissionBadge(installed)] : [];
  return [status, ...(installed?.installed === false ? [badge('已移出安装', 'danger')] : []), ...permission, ...(current.environment ? [projectEnvironmentState()] : [])];
}
// A background permission check answers with the whole snapshot row for every repository. This header drew its own read
// earlier, so it has to take that answer too; otherwise one screen shows the old grant next to the bar's new one. Only the
// header is redrawn: re-reading the page would discard what the reader has already typed into the settings forms.
function applyInstalledRow(row) {
  if (!row || !current || String(row.id) !== String(current.id) || projectRoute()?.id !== String(current.id)) return false;
  current.installed = { ...(current.installed || {}), ...row };
  const title = document.querySelector('#project-page .project-head .title-group'), name = title?.querySelector('h1');
  if (!name) return false;
  title.replaceChildren(name, ...projectStatus());
  return true;
}
function projectEnvironmentState() {
  const observed=current.environment?.observation;
  const known=observed?.status==='available'&&Object.hasOwn(states,observed.state)&&!current.environmentReadError;
  const unknown=current.environmentReadError?'电脑待核验':observed?.status==='recovering'?'管理服务恢复中':observed?.status==='absent'?'电脑记录缺失':observed?.status==='error'||observed?.status==='available'?'电脑状态未知':'电脑待核验';
  const node=known?state(observed.state):badge(unknown,'warning');
  node.dataset.projectEnvironmentState='';return node;
}
function projectHeader() {
  const { repository, policy } = current, head = element('div', '', 'project-head'), title = element('div', '', 'title-group'), actions = element('div', '', 'actions');
  const back = element('a', '← 全部项目', 'back-link'); back.href = '#/projects';
  title.append(element('h1', repository.full_name), ...projectStatus());
  actions.append(link(`https://github.com/${repository.full_name}`, '在 GitHub 打开', 'button-link'));
  if (current.section === 'basic') actions.append(button('刷新项目设置', () => reloadProject().catch(error)));
  head.append(back, title, actions); return head;
}
function projectBody(section) {
  const body = element('div', '', 'project-body'), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content');
  nav.setAttribute('aria-label', '项目设置类别');
  for (const [key, caption, superOnly] of projectSections) {
    if (superOnly && me.role !== 'super_admin') continue;
    const item = element('a', caption); item.href = `#/projects/${current.id}/${key}`; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item);
    if (key === 'management') { const project = current.id; item.addEventListener('click', event => { event.preventDefault(); void openManagementChat(project).catch(error); }); }
  }
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  content.append(...({ overview: workspaceOverview, basic: basicSection, machine: machineSection, model: modelsSection, release: releaseSection, knowledge: knowledgeSection, roles: rolesSection, external: externalSection, members: membersSection, activity: activitySection }[section])());
  body.append(nav, content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

// Shared role labels and editable definitions; roles.js renders the overview and role forms.
const roleEntries = [['development', '开发', '开发 Issue、跟进 bot PR'], ['request', '普通任务', '管理对话或接口创建的任务'], ['review', '检视', '检视 Issue、检视 PR'], ['actions', 'Actions 失败分析', 'Actions 失败处理']];
const modelSources = { role: '角色', workflow: '工作类型', project: '项目默认' };

/**
 * The roles the controller may delegate in one entry (src/roles/team.ts, src/agent/loop.ts). Development and ordinary
 * requests offer every enabled writer and observer role; review and Actions analysis offer only Dev, whose work stays
 * on the entry's own Pi executor. QA is never delegated: it accepts the candidate the controller nominates.
 */
const entryWorkers = (config, entry) => ['review', 'actions'].includes(entry) ? config.roles.filter(role => role.role_id === 'dev')
  : config.roles.filter(role => role.enabled && ['writer', 'observer'].includes(role.kind));
const workerNames = roles => roles.map(role => roleLabel(role.role_id, role.name)).join('、') || '无';
const entryDevText = config => { const dev = entryDevBackend(config); return `只委派 Dev，Dev 用这个入口的工具和工作区，后端 ${harnessName(dev.id)}${dev.kept ? '（旧 V2 配置沿用 Pi，Dev 的后端选择改变后才换）' : ''}`; };
/**
 * The backend Dev uses when the controller delegates it in review or Actions analysis (src/roles/definition.ts): Dev's
 * own backend once its choice applies to these entries (entry_harness_source "role"); an older V2 configuration keeps
 * Pi there until Dev's backend selection changes.
 */
function entryDevBackend(config) {
  const dev = config.roles.find(role => role.role_id === 'dev');
  const own = dev?.entry_harness_source === 'role';
  return { id: own ? dev.harness_ref.id : 'pi', kept: !own && !!dev && dev.harness_ref.id !== 'pi' };
}
function roleModelText(preview) {
  if (!preview) return '—';
  if (preview.error) return `${preview.error}${preview.detail ? '：' + preview.detail : ''}`;
  return preview.model.source === 'external_harness' ? '后端自带模型' : `${preview.model.name}（${own(modelSources, preview.model.source) || preview.model.source}）`;
}
// Only editable fields cross the API; saved versions are pinned again by the server.
const editableRole = r => ({ role_id: r.role_id, enabled: r.enabled, name: r.name, responsibility: r.responsibility, persona_prompt: r.persona_prompt,
  model_profile_ref: r.model_profile_ref ? { model_id: r.model_profile_ref.model_id, api: r.model_profile_ref.api, tool_calls: r.model_profile_ref.tool_calls, structured_output: r.model_profile_ref.structured_output } : null,
  skill_bundle_ref: r.skill_bundle_ref ? { id: r.skill_bundle_ref.id } : null, harness_ref: { id: r.harness_ref.id }, permissions: structuredClone(r.permissions),
  environment_profile_ref: { id: r.environment_profile_ref.id }, budget_policy_ref: Object.fromEntries(Object.entries(r.budget_policy_ref).filter(([key]) => key !== 'version')),
  output_schema_ref: { id: r.output_schema_ref.id } });

function rolesSection() { return rolesConsole(); }
function basicSection() {
  const target = current, { repository, policy, installed, environment } = target, info = card('项目概况');
  const id = target.id, save = values => api(`/api/repositories/${id}/policy`, 'PATCH', values);
  const editable = target.canConfigure !== false;
  info.append(facts([['仓库', link(`https://github.com/${repository.full_name}`, repository.full_name)], ['仓库 ID', repository.id], ['所有者', installed?.owner_login ? `${installed.owner_login}（${repository.owner_id}）` : repository.owner_id],
    ['处理账号', installed?.account_name || repository.account_id], ['安装', !installed ? null : installed.installed === null ? '不在安装列表' : `${installed.installation_id ? '安装 ' + installed.installation_id : '机器人账号可见'}${installed.installed === false ? '（已移出）' : ''}`],
    ['可见性', installed ? installed.private ? '私有' : '公开' : null], ['项目状态', policy.enabled ? '已启用' : '已禁用'], ['虚拟电脑', projectEnvironmentState()]]));
  const summary = card('当前配置一览');
  summary.append(facts([['检视', policy.review_enabled ? '开启' : '关闭'], ['自动开发', policy.development_enabled ? '开启' : '关闭'], ['模型', current.models.find(m=>m.id===policy.model_id)?.model_name || (policy.model_id?'模型不可用':'未选择，任务会等待配置')],
    ['机器', current.rules?.computer?.cpus ? `${current.rules.computer.cpus} CPU · ${current.rules.computer.memory_mb} MB（${current.rules.files.find(f=>f.path==='.bot/computer.yaml').source==='repository'?'仓库 .bot/computer.yaml':'控制台'}）` : environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null]]));
  const branch = settingsForm('分支', [field('基准分支', input('base_branch', policy.base_branch, { maxLength: 256, placeholder: '留空使用仓库默认分支' })),
    note('开发任务从这个分支拉取代码并向它开 PR；检视 Issue 时也读取这个分支的代码。')],
    form => save(changed({ base_branch: form.elements.base_branch.value.trim() }, { base_branch: policy.base_branch || '' })), { editable, draftKey: 'branch' });
  const automation = settingsForm('检视与开发策略', [
    checkbox('review_enabled', policy.review_enabled, '开启 Issue 与 PR 检视'), checkbox('development_enabled', policy.development_enabled, '开启自动开发'),
    note('此处保存功能开关，不代表任务正在执行。项目禁用时仍可保存，重新启用后生效。')],
    form => save(changed({ review_enabled: form.elements.review_enabled.checked, development_enabled: form.elements.development_enabled.checked },
      { review_enabled: !!policy.review_enabled, development_enabled: !!policy.development_enabled })), { editable, draftKey: 'automation' });
  const sources = card('规则来源');
  sources.append(note('内置默认、项目控制台和默认分支仓库文件依次覆盖。这里仅展示来源，编辑入口沿用角色与机器页面。'));
  if (!target.rules) sources.append(consoleState('规则来源暂不可读取', '请重新读取；当前不能判断哪一层生效。', { retry: () => reloadProject().catch(error) }));
  else for (const file of target.rules.files.filter(f => f.path === '.bot/guide.md' || f.path === '.bot/computer.yaml')) {
    sources.append(facts([['规则', file.path], ['当前来源', layerNames[file.source] || file.source]]));
  }
  sources.append(consoleLink(`#/projects/${id}/roles/manager`, '查看与修改规则', '保留现有的来源比较和版本检查'));
  const publication = card('公开可见性');
  if (me.role !== 'super_admin') publication.append(note('公开看板由平台超级管理员管理；项目配置权限不会增加公开授权。'));
  else if (!installed) publication.append(consoleState('公开设置暂不可读取', '安装信息读取失败，公开状态未知。', { retry: () => reloadProject().catch(error) }));
  else {
    const status = element('p', '', 'muted'), feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'status');
    const toggle = button('', async () => {
      const enabled = !installed.board_enabled;
      if (!await askConfirm({ title: enabled ? '开启公开看板？' : '关闭公开看板？',
        body: [enabled ? '允许无需登录访问单仓看板及 Dashboard 汇总，包括私有仓显式公开的看板数据。' : '保存后停止对外提供本项目看板。',
          '公开内容由看板采集服务生成，不开放管理端任务日志、身份、提示词或成本。'], action: enabled ? '开启公开看板' : '关闭公开看板', danger: enabled })) return;
      toggle.disabled = true; feedback.textContent = '正在保存公开设置…';
      try {
        const { board } = await api(`/api/installations/${id}/board`, 'PATCH', { enabled });
        Object.assign(installed, { board_enabled: board.enabled, board_state: board.state, board_url: board.url });
        show(); feedback.textContent = board.enabled ? '公开设置已保存；看板数据允许公开访问。' : '已关闭公开访问。';
      } catch (err) { feedback.textContent = '公开设置保存失败：' + err.message; }
      finally { toggle.disabled = installed.installed !== true; }
    });
    const show = () => { status.textContent = !installed.board_enabled ? '看板未公开' : installed.board_state === 'published' ? '看板已公开' : '已允许公开，等待采集'; toggle.textContent = installed.board_enabled ? '关闭公开看板' : '开启公开看板'; };
    show(); toggle.disabled = installed.installed !== true;
    publication.append(status, note('公开与项目启用分别保存。私有仓也可显式选择公开，请确认数据范围后操作。'), toggle, feedback);
    if (installed.board_enabled && installed.board_url) publication.append(link(installed.board_url, '查看公开看板'));
  }
  const danger = card('危险区'); danger.classList.add('project-danger');
  danger.append(note('禁用会停止新任务、中止正在执行的任务并停止虚拟电脑，保留现有数据；删除会清除本系统项目数据，且仍须通过服务端的实时检查。'));
  if (me.role === 'super_admin') {
    const feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'alert');
    const change = button(policy.enabled ? '禁用项目' : '启用项目', async () => {
      if (!await askConfirm({ title: `${policy.enabled ? '禁用' : '启用'} ${repository.full_name}？`,
        body: [policy.enabled ? '新 Issue／PR 不再处理；正在执行的任务会中止，虚拟电脑停止，已有数据保留。' : '恢复按当前检视、开发与模型配置处理任务。', '公开看板的可见性由上方独立设置控制。'], action: policy.enabled ? '禁用' : '启用', danger: !!policy.enabled })) return;
      change.disabled = true; feedback.textContent = '';
      try { await api(`/api/installations/${id}/${policy.enabled ? 'disable' : 'activate'}`, 'POST', {}); if (current === target && projectRoute()?.id === id) await reloadProject(); }
      catch (err) { feedback.textContent = `项目${policy.enabled ? '禁用' : '启用'}失败：${err.message}`; }
      finally { change.disabled = false; }
    }, policy.enabled ? 'destructive' : '');
    danger.append(change, button('删除项目', () => deleteProject({ id, full_name: repository.full_name, registered: true }, async () => {
      if (current === target && projectRoute()?.id === id) { current = null; location.hash = '#/projects'; }
    }), 'quiet destructive'), feedback);
  } else danger.append(note('启用、禁用与删除项目由平台超级管理员处理。请联系该管理员；项目管理员不因页面入口获得这些能力。'));
  const layout = element('div', '', 'project-settings-layout'); layout.append(info, summary, branch, automation, sources, publication, danger);
  return [layout];
}

function machineSection() {
  const { environment } = current, pc = environment?.environment.computer, editable = me.role === 'super_admin' && !!pc;
  const status = element('div', '', 'status-grid computer-status-grid'); status.id = 'machine-status'; status.append(...machineStatus());
  if (!pc) return [status, concurrencyForm(), note('暂时读不到虚拟电脑规格。连接恢复后可重新读取本页配置；未保存改动请先保存。'),button('重新读取电脑配置',()=>reloadProject().catch(error))];
  const effective=current.rules?.computer||pc, source=current.rules?.files.find(f=>f.path==='.bot/computer.yaml');
  const shown={...pc,...effective,network_policy:effective.egress===undefined?pc.network_policy:effective.egress?'internet egress':'internal, no egress'};
  // A resource left empty follows the global default; own() is the value the project sets (console or repository file).
  const own = name => current.rules?.computer ? current.rules.computer[name] : pc.inherited?.includes(name) ? undefined : pc[name];
  const number = (name, step) => input(name, own(name) ?? '', { type: 'number', step, min: pc.bounds?.[name]?.[0] ?? '', max: pc.bounds?.[name]?.[1] ?? '',
    placeholder: `留空使用全局默认（${pc.defaults?.[name] ?? pc[name]}）` });
  const sourceLink=element('a','查看规则文件来源');sourceLink.href=`#/projects/${current.id}/roles/manager`;
  const sourceActions=element('div','','actions');sourceActions.append(sourceLink);
  // Tasks apply the repository file when they prepare; a super administrator can apply it right away.
  if(source?.source==='repository'&&editable){const apply=button('立即应用仓库文件',async()=>{apply.disabled=true;apply.textContent='正在按仓库文件重建虚拟电脑…';
    try{await api(`/api/repositories/${current.id}/rules/apply-computer`,'POST',{});current.flash='已按仓库 .bot/computer.yaml 重建虚拟电脑';await reloadProject();}catch(err){apply.disabled=false;apply.textContent='立即应用仓库文件';error(err);}});sourceActions.append(apply);}
  const nodes = [
    note(source?.source==='repository'?'表单显示默认分支 .bot/computer.yaml 合并后的生效值。这里保存的是控制台配置，下次任务准备时会再次被仓库文件覆盖。':'表单显示当前生效电脑规格；仓库 .bot/computer.yaml 可以覆盖控制台值。'),sourceActions,
    note(editable ? '保存后虚拟电脑按新配置重建：工作卷和代次保留，正在执行的命令先执行完，任务保留的后台进程会结束。新增软件包时会先构建镜像，首次可能需要几分钟。' : '机器配置由超级管理员设置。'),
    element('h4', '资源'),
    note('留空的资源跟随全局默认（全局设置 → 常规），全局默认改了以后这台电脑在空闲时按新值重建。'),
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
    // null clears the project's value, so the resource follows the global default again.
    for (const name of specFields) { const text = form.elements[name].value.trim(), value = text === '' ? null : Number(text); if (value !== (own(name) ?? null)) spec[name] = value; }
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
  if(revoked){target.environment=null;usage=null;$('project-page').replaceChildren(consoleState('项目电脑暂不可访问','原记录和配置已清除。'+revoked.message,{tone:'error',retry:()=>renderProject({id,section})}));return;}
  if (environment.value) target.environment = environment.value;
  target.environmentReadError=environment.error?.message||'';
  $('project-page').querySelectorAll('[data-project-environment-state]').forEach(node=>node.replaceWith(projectEnvironmentState()));
  if (section === 'machine') {
    usage = { id, stats:stats.error?(usage?.id===id?usage.stats:null):stats.value, error:stats.error?.message||'' };
    const status = $('machine-status');if(status){const focused=status.contains(document.activeElement)?document.activeElement.id:null;keepOpen(status, () => status.replaceChildren(...machineStatus()));if(focused)document.getElementById(focused)?.focus({preventScroll:true});}
  }
  else { const box = $('activity-status'); if (box) keepOpen(box, () => box.replaceChildren(...activityCards())); }
  projectTimer = setTimeout(() => refreshProjectStatus(token), 5000);
}

// Event tasks (CI observation, Actions failures, gate onboarding turns) have no Issue or PR number.
function projectTaskLabel(task) { return `${kindLabels[task.kind] || task.kind}${task.object_number == null ? '' : ' #' + task.object_number}`; }
const builtInTasks = [
  { kind: 'manager', group: 'Manager', title: 'Manager 分派', description: '每个交给 Manager 的事件调用一次：决定新建任务、续接已有任务还是不处理。' },
  { kind: 'review.issue', group: '检视', title: '检视 Issue', description: '检视 Issue，判断意图、核对代码证据，回复评论并加分类标签。', rule: '.bot/rules/issue-review.md' },
  { kind: 'review.pr', group: '检视', title: '检视 PR', description: '检视 PR 的变更、测试与证据，发布 COMMENT 检视结论。', rule: '.bot/rules/pr-review.md' },
  { kind: 'development.issue', group: '开发', title: '开发 Issue', description: 'Issue 明确要求改代码时，在虚拟电脑里实现、测试并创建 bot PR。', rule: '.bot/rules/issue-development.md' },
  { kind: 'development.pr', group: '开发', title: '跟进 bot PR', description: '检视采纳了 bot PR 上的修改要求，或发现可执行问题后，修订 bot 自己的 PR。' },
  { kind: 'reply', group: '通用', title: '通用回复', description: '按 Manager 提示词「通用回复」章节在 Issue 或 PR 上完成一项工作并回复。' },
  { kind: 'release.observe', group: '发版本', title: 'CI 观察', description: '只读分析一次 Release 工作流运行并汇总失败线索；观察操作仍留在「发版本」。' },
  { kind: 'release.notes', group: '发版本', title: '发行说明', description: '把已核验的提交和合并 PR 整理成发行说明；起草与正式发布仍留在「发版本」。' },
  { kind: 'actions.failures', group: 'Actions', title: 'Actions 失败处理', description: '分析默认分支 Actions 运行失败的原因，外部原因重跑一次，其他提报 Issue。' },
  { kind: 'gate.onboarding', group: '门禁', title: '接入门禁', description: '「接入门禁」对话的每一轮。' },
  { kind: 'task.request', group: '通用', title: '普通任务与定时检查', description: '管理对话、接口或定时检查发起的通用任务。' }
];
const releaseNotesSkill = '.agents/skills/release-notes/SKILL.md';
function taskModelMap(policy) {
  const values = JSON.parse(policy.task_models || '{}');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('当前任务模型配置无效，请先在仓库配置中修正。');
  return { ...values };
}
function modelOption(select, value, caption) { const option = element('option', caption); option.value = value; select.append(option); }
function modelOptions(select, models, selected, empty = null) {
  if (empty) modelOption(select, '', empty);
  for (const model of models) modelOption(select, model.id, `${model.model_name} · ${model.repository_id ? '本项目专属' : '部署共享'} · ${hostOf(model.api_url)}${model.key_configured ? '' : ' · Key 已撤销'}`);
  if (selected && !models.some(model => model.id === selected)) modelOption(select, selected, `模型不可用（${selected}）`);
  select.value = selected || '';
}
function projectDefaultModelCard(policy, models) {
  const section = card('项目默认模型'), select = document.createElement('select'), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'project-default-model'; message.setAttribute('role', 'alert');
  const selected = models.find(model => model.id === policy.model_id);
  modelOptions(select, models, policy.model_id, '不使用默认模型（继承它的任务会等待配置）');
  const save = button('保存默认模型', async () => {
    save.disabled = true; message.textContent = '';
    try { await patchPolicy({ model_id: select.value || null }); current.focusAnchor = 'project-default-model'; await reloadWith('已保存项目默认模型'); }
    catch (err) { message.textContent = err.message; save.disabled = false; }
  }, '');
  const actions = element('div', '', 'actions form-actions'); actions.append(save);
  section.append(note('未单独指定模型的任务继承这里的选择。部署共享模型由超级管理员提供，本项目专属模型只对这个项目可见。'),
    note(policy.model_id && !selected ? `当前默认模型不可用（${policy.model_id}），不会自动换成其他模型。` : selected?.key_configured === false ? `当前默认模型 ${selected.model_name} 的 Key 已撤销，任务会等待配置。` : '在下方任务模型表中可以单独覆盖项目默认。'),
    field('默认模型', select), message, actions);
  return section;
}
function modelManagementSections() {
  const models = current.models, own = card('本项目专属模型'), shared = card('部署共享模型');
  own.dataset.overviewAnchor = 'project-own-models'; shared.dataset.overviewAnchor = 'deployment-shared-models';
  const row = model => { const li = element('li', '', 'model-entry'), result = probeResult('wide-cell'); li.append(modelLabel(model), modelActions(model, result), result); return li; };
  const ownModels = models.filter(model => model.repository_id === current.id), sharedModels = models.filter(model => model.repository_id === null);
  own.append(...(ownModels.length ? [providerList(ownModels, row)] : [note('还没有专属模型。点击「新增供应商」添加。')]), providerCreate(current.id));
  const sharedRow = model => { const li = element('li', '', 'model-entry'); li.append(modelLabel(model)); return li; };
  shared.append(note('这里只读展示，可在上方选作项目默认或任务模型。供应商、Key、模型名和计费单价统一在「全局设置 → 模型」中管理。'),
    ...(sharedModels.length ? [providerList(sharedModels, sharedRow, reloadWith, { editable: false })] : [note('还没有可供本项目使用的共享模型，请联系超级管理员配置。')]));
  return [own, shared];
}
function taskModelEditor(kind, title, policy, models, { custom = false } = {}) {
  const section = element('section', '', 'task-model-editor'), select = document.createElement('select'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  let initial = {}; try { initial = taskModelMap(policy); } catch (err) { message.textContent = err.message; }
  const configured = Object.hasOwn(initial, kind), selected = configured ? initial[kind] : policy.model_id;
  const defaultModel = models.find(model => model.id === policy.model_id);
  modelOptions(select, models, configured ? selected : '', custom ? null : `继承项目默认${defaultModel ? `（${defaultModel.model_name}）` : policy.model_id ? `（模型不可用 ${policy.model_id}）` : '（未选择）'}`);
  const selectedModel = models.find(model => model.id === selected);
  const currentText = configured
    ? selectedModel ? `${selectedModel.model_name} · 此任务指定${selectedModel.key_configured ? '' : ' · Key 已撤销，不会自动切换'}` : `模型不可用（${selected}） · 此任务指定，不会自动切换`
    : selectedModel ? `${selectedModel.model_name} · 继承项目默认${selectedModel.key_configured ? '' : ' · Key 已撤销'}` : policy.model_id ? `模型不可用（${policy.model_id}） · 继承项目默认，不会自动切换` : '未选择项目默认模型，任务会等待配置';
  const actions = element('div', '', 'actions form-actions');
  const persist = async (value, notice) => {
    message.textContent = ''; for (const control of actions.querySelectorAll('button')) control.disabled = true;
    try {
      const values = taskModelMap(current.policy);
      if (value) values[kind] = value; else delete values[kind];
      await patchPolicy({ task_models: values }); current.focusAnchor = kind; await reloadWith(notice);
    } catch (err) { message.textContent = err.message; }
    finally { for (const control of actions.querySelectorAll('button')) control.disabled = false; }
  };
  actions.append(button('保存模型', () => persist(select.value, `已保存${title}的模型`)));
  if (!custom && configured) actions.append(button('恢复继承', () => persist('', `已恢复${title}继承项目默认模型`)));
  if (custom) actions.append(button('移除这项设置', () => persist('', `已移除 ${kind} 的模型设置`), 'quiet destructive'));
  section.append(note(`当前使用：${currentText}`), field('任务模型', select), message, actions);
  return section;
}
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
// Connections belong to the provider editor; testing, naming, pricing and deletion stay with each model.
function modelActions(model, result, after = reloadWith) {
  const actions = element('div', '', 'actions'), editable = me.role === 'super_admin' || model.repository_id === current?.id;
  if (!editable) return actions;
  if (model.key_configured) actions.append(probeButton('测试模型', result, () => api(`/api/models/${model.id}/test`, 'POST', {}), testOutcome));
  actions.append(button('修改模型名', () => modelEdit(model, after)), button('计费单价', () => modelPricing(model, after)));
  actions.append(button('删除', async () => {
    let detail;
    try { detail = (await api(`/api/models/${model.id}`)).model; }
    catch (err) { result.hidden = false; result.replaceChildren(element('p', err.message, 'view-error')); return; }
    const used = detail.used_by || [], body = [
      '只从本系统删除这条模型配置，并销毁封存的 API Key；页面和日志都不会显示它。',
      '不会删除 GitHub 上的任何东西。已有成本记录保留，仍使用当时记下的模型名和单价。'];
    if (used.length) body.push('以下项目正在使用它。默认选择会改回“不使用模型”；任务专属选择保留为不可用，相关任务进入“配置待补”：', used.map(repo => repo.full_name));
    else body.push('当前没有项目选用它。');
    if (detail.repository_id === null) body.push('这是部署共享模型，删除后所有项目都不能再选它。');
    const deleted = await confirmDialog({ title: `删除模型 ${detail.model_name}？`, body, action: '删除', danger: true,
      progress: '正在删除模型…', run: () => api(`/api/models/${model.id}`, 'DELETE', {}) });
    if (deleted) await after(`已删除模型 ${detail.model_name}`);
  }, 'quiet destructive'));
  return actions;
}
// Model-specific edits do not change its provider's connection settings.
function modelEdit(model, after) {
  const modal = document.createElement('dialog'), form = document.createElement('form'), heading = element('h2', `修改 ${model.model_name} 的模型名`);
  modal.id = 'model-edit'; heading.id = 'model-edit-title'; modal.setAttribute('aria-labelledby', heading.id);
  const name = input('model_name', model.model_name, {required:true,maxLength:200}), message = element('p','','view-error'), actions = element('div','','actions'), save = element('button','保存');
  message.setAttribute('role','alert'); save.type = 'submit'; actions.append(button('取消',()=>modal.close()),save);
  form.append(heading,field('模型名',name),message,actions);
  form.addEventListener('submit',async event=>{
    event.preventDefault();const value=name.value.trim();if(!value){message.textContent='请填写模型名';return;}
    if(value===model.model_name){modal.close();return;}save.disabled=true;
    try{await api('/api/models/'+model.id,'PATCH',{version:model.version,model_name:value});modal.close();await after(`已保存模型名 ${value}`);}
    catch(err){message.textContent=err.message;}finally{save.disabled=false;}
  });
  modal.append(form);document.body.append(modal);modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
}
function providerCreate(repositoryId, after = reloadWith) {
  const actions=element('div','','actions provider-create');
  actions.append(button('新增供应商',()=>providerEditor([],repositoryId,after)));return actions;
}

// Model address, upstream list and test, shared by the project page, global settings and the onboarding wizard
// (settings.js and onboarding.js load after this file). The server resolves addresses, so the page shows exactly where
// tasks will send their requests.
const modelUrlRule = '地址按填写的路径使用：去掉末尾的 / 和 /chat/completions 后，接上 /chat/completions 发送对话，接上 /models 获取模型列表；不会自动添加或删除 /v1。';
const modelV1Warning = '当前地址不含末尾的 /v1；多数兼容接口需要它，只有上游确认不用时才这样填写。';
function endpointFacts(endpoints) {
  const nodes = [facts([['对话地址', endpoints.chat_url], ['模型列表地址', endpoints.models_url]])];
  if (!endpoints.has_v1) nodes.push(element('p', modelV1Warning, 'endpoint-warning'));
  return nodes;
}
// Saved models are shown by provider: one group per request address. The key is the server's chat_url, so URLs that
// differ only in what the server ignores (a trailing / or /chat/completions) are one provider, as they are for tasks.
function byProvider(models) {
  const groups = new Map();
  for (const model of models) { const key = model.endpoints?.chat_url || model.api_url; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(model); }
  return [...groups.values()];
}
function providerTitle(model, className = 'provider-title') {
  const title = element('div', '', className); title.append(element('strong', hostOf(model.api_url)), ' ', element('span', model.api_url, 'muted'));
  if (model.endpoints && !model.endpoints.has_v1) { const flag = badge('地址不含 /v1', 'warning'); flag.title = modelV1Warning; title.append(' ', flag); }
  return title;
}
// A model with its address on one line, where it is not shown inside a provider group (the onboarding wizard).
function modelAddress(model) {
  const address = element('span', `${model.model_name} · ${model.api_url}`, 'model-address');
  if (model.endpoints && !model.endpoints.has_v1) { const flag = badge('地址不含 /v1', 'warning'); flag.title = modelV1Warning; address.append(' ', flag); }
  return address;
}
// A model inside its provider group: the name, and `extra` badges such as the wizard's default.
function modelLabel(model, extra = []) {
  const label = element('span', model.model_name, 'model-address');
  for (const flag of [...extra, ...(model.key_configured ? [] : [badge('Key 已撤销', 'warning')])]) label.append(' ', flag);
  return label;
}
// The provider groups of one list (models of one project, or the shared ones); `row` draws each model. Whoever may edit
// the models can add more of a provider's models with its saved key.
function modelConnectionFacts(model) {
  const box = element('div', '', 'model-connection-facts'), price = model.pricing, policy = current && projectRoute()?.id === current.id ? current.policy : null;
  box.append(badge(model.repository_id === null ? '部署共享' : '项目专属', 'info'));
  if (price) box.append(element('span', `${price.currency} / 百万 token · 输入 ${price.input_per_million} · 输出 ${price.output_per_million} · 缓存 ${price.cache_per_million}`, 'model-price'));
  else box.append(element('span', '未定价 · 不按 0 估算', 'model-price'));
  if (policy?.model_id === model.id) box.append(badge('项目默认', 'success'));
  try {
    const uses = Object.entries(policy ? taskModelMap(policy) : {}).filter(([, id]) => id === model.id).length;
    if (uses) box.append(element('span', `${uses} 个工作类型显式使用`, 'muted'));
  } catch { box.append(element('span', '工作类型模型配置未能解析', 'muted')); }
  // Which projects reference this model, from the list route's `used_by`. The absence is stated: a model nobody uses
  // can be deleted without a migration, so "nobody" is information, not an empty cell.
  const used = model.used_by || [];
  box.append(element('span', used.length ? `使用位置：${used.map(repo => repo.full_name).join('、')}` : '未被任何项目选用', 'model-usage'));
  return box;
}
function providerList(models, row, after = reloadWith, { editable = true } = {}) {
  const list = element('div', '', 'provider-list'), tools = element('div', '', 'provider-list-tools'), search = input('provider_search', '', { type: 'search', placeholder: '搜索供应商地址或模型名称' }), count = element('span', '', 'muted');
  search.setAttribute('aria-label', '搜索供应商或模型'); count.setAttribute('role', 'status'); tools.append(search, count); list.append(tools);
  const entries = [];
  for (const group of byProvider(models)) {
    const section = element('section', '', 'provider-group'), head = element('div', '', 'provider-head'), rows = element('ul', '', 'history');
    head.append(providerTitle(group[0]), element('span', `${group.length} 个模型`, 'muted provider-count'));
    head.append(badge(group.every(model => model.key_configured) ? 'Key 已配置' : group.some(model => model.key_configured) ? '部分 Key 已撤销' : 'Key 已撤销', group.every(model => model.key_configured) ? '' : 'warning'));
    const canEdit = editable && (me.role === 'super_admin' || group[0].repository_id === current?.id);
    if (canEdit) head.append(button('编辑供应商',()=>providerEditor(group,group[0].repository_id,after)));
    else head.append(badge('只读'));
    const modelsInGroup = [];
    for (const model of group) { const item = row(model); item.append(modelConnectionFacts(model)); rows.append(item); modelsInGroup.push({ item, name: model.model_name.toLowerCase() }); }
    section.append(head, rows); list.append(section); entries.push({ section, host: group[0].api_url.toLowerCase(), models: modelsInGroup });
  }
  const filter = () => {
    const value = search.value.trim().toLowerCase(); let visible = 0;
    for (const entry of entries) {
      for (const model of entry.models) { model.item.hidden = !!value && !entry.host.includes(value) && !model.name.includes(value); if (!model.item.hidden) visible++; }
      entry.section.hidden = entry.models.every(model => model.item.hidden);
    }
    count.textContent = `${visible} / ${models.length} 个模型`; empty.hidden = !!visible;
  };
  const empty = element('p', '没有匹配的供应商或模型，清空搜索可恢复全部。', 'provider-search-empty'); empty.hidden = true; list.append(empty); search.addEventListener('input', filter); filter();
  return list;
}
// Adding and editing use one provider form. URL/key changes and newly selected models commit together.
function providerEditor(group, repositoryId, after) {
  const editing=!!group.length, existing=new Set(group.map(model=>model.model_name)), selected=new Set();
  let source=group.find(model=>model.key_configured)||group[0];
  const modal=document.createElement('dialog'),form=document.createElement('form'),head=element('div','','heading'),title=element('h2',editing?'编辑供应商':'新增供应商');
  modal.id='provider-edit';title.id='provider-edit-title';modal.setAttribute('aria-labelledby',title.id);head.append(title);
  const fields=document.createElement('fieldset');fields.className='provider-fields';
  const url=input('api_url',source?.api_url||'',{type:'url',required:true,placeholder:'填写供应商接口地址'}),key=input('api_key','',{type:'password',autocomplete:'new-password',required:!editing,placeholder:editing?'留空保持已保存的 Key':'填写 API Key'});
  const preview=element('div','','endpoint-preview'),endpointDetail=element('details','','fold'),result=probeResult(),choices=element('div','','model-chips'),picked=element('div','','model-chips provider-selected'),filter=input('filter','',{type:'search',placeholder:'筛选上游模型'}),manual=input('model_name','',{maxLength:200,placeholder:'例如模型列表中没有列出的名称'});
  filter.setAttribute('aria-label','筛选上游模型');filter.hidden=true;manual.setAttribute('aria-label','手动模型名');
  endpointDetail.append(element('summary','查看实际请求地址'),preview);if(source?.endpoints)preview.append(...endpointFacts(source.endpoints));
  const message=element('p','','view-error'),selectedLabel=element('p','待添加','provider-selection-summary');message.setAttribute('role','alert');selectedLabel.hidden=true;let request=0,available=[];
  const impact=element('section','','provider-impact'), impactTitle=element('h3','保存影响'), impactText=element('p'); impact.append(impactTitle,impactText);
  const drawImpact=()=>{impactText.textContent=editing?`将更新 ${group.length} 个现有模型${selected.size?'，新增 '+selected.size+' 个模型':''}；${key.value.trim()?'替换连接 Key':'保留已保存的 Key'}。现有任务的历史配置和费用快照不会重写。`:`新增 ${selected.size} 个${repositoryId===null?'部署共享':'项目专属'}模型；保存后仍需显式选择默认或覆写。`;};
  const draw=()=>{
    selectedLabel.hidden=false;selectedLabel.textContent=`已选 ${selected.size} 个待添加模型 · 获取列表不等于模型可用`;drawImpact();
    picked.replaceChildren(...[...selected].map(name=>button(name+' ×',()=>{selected.delete(name);draw();},'quiet model-chip')));
    choices.replaceChildren(...available.filter(name=>name.toLowerCase().includes(filter.value.trim().toLowerCase())).map(name=>{
      const have=existing.has(name),chosen=selected.has(name),item=button(name+(have?' · 已添加':chosen?' ✓':''),()=>{selected.has(name)?selected.delete(name):selected.add(name);draw();},'quiet model-chip');
      item.disabled=have;item.setAttribute('aria-pressed',String(chosen));return item;
    }));
  };
  const stale=()=>{request++;available=[];selected.clear();filter.hidden=true;result.replaceChildren();draw();};
  watchEndpoint(url,preview,stale);key.addEventListener('input',stale);filter.addEventListener('input',draw);
  const fetchModels=button('获取模型列表',async()=>{
    const address=url.value.trim();if(!address||!editing&&!key.value.trim()){message.textContent='先填写接口 URL 和 API Key';return;}
    message.textContent='';const version=++request;fetchModels.disabled=true;result.replaceChildren(element('p','正在获取模型列表…','view-progress'));
    try{
      const value=await api(editing?`/api/models/${source.id}/upstream`:'/api/models/upstream','POST',editing?{version:source.version,api_url:address,api_key:key.value}:{repository_id:repositoryId,api_url:address,api_key:key.value});
      if(version!==request||!modal.isConnected)return;
      if(!value.ok){result.replaceChildren(...probeFailure(value));return;}available=value.models;filter.hidden=!available.length;draw();
      result.replaceChildren(element('p',`返回 ${value.total} 个模型${value.truncated?'（仅显示前 '+value.models.length+' 个）':''}，选择要添加的模型后保存。`,'view-success'));
    }catch(err){if(version===request)result.replaceChildren(element('p',err.message,'view-error'));}finally{fetchModels.disabled=false;}
  });
  const addManual=button('加入待添加',()=>{const name=manual.value.trim();if(!name)return;if(existing.has(name)){message.textContent='这个模型已经在该供应商下';return;}selected.add(name);manual.value='';message.textContent='';draw();});
  // Enter in a text box submits its form, which here saves the provider: in the filter it only filters, in the manual
  // name box it adds the name to the list. An Enter that ends an input method composition is left alone.
  filter.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();draw();}});
  manual.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();addManual.click();}});
  const manualRow=element('div','','actions provider-manual');manualRow.append(field('手动模型名',manual),addManual);
  fields.append(field('接口 URL',url),field(editing?'API Key（留空保持不变）':'API Key',key),
    note(editing?`修改 URL 或填写新 Key 将应用于本供应商的 ${group.length} 个模型。留空则保留各模型现有 Key，页面不会回显。`:'填写连接信息，获取模型列表或手动添加至少一个模型后保存。Key 加密保存，不会回显。'),endpointDetail);
  if(editing)fields.append(element('h3','已配置模型'),note([...existing].join('、')),note(group.some(model=>model.key_configured)?'Key 已保存；如需更换，在上方填写新 Key。':'Key 已撤销；填写新 Key 后才能调用模型。'));
  fields.append(element('h3',editing?'添加模型':'选择模型'),fetchModels,result,filter,choices,manualRow,selectedLabel,picked);
  const testDraft=button('测试当前连接',async()=>{
    const name=manual.value.trim()||[...selected][0]||source?.model_name,address=url.value.trim();
    if(!name||!address||!editing&&!key.value.trim()){message.textContent='填写连接信息，并选择或手动填写一个待测试模型。';return;}
    const version=++request;testDraft.disabled=true;result.replaceChildren(element('p','正在测试当前连接…','view-progress'));
    try{
      const value=await api(editing?`/api/models/${source.id}/test`:'/api/models/test','POST',editing?{version:source.version,api_url:address,api_key:key.value,model_name:name}:{repository_id:repositoryId,api_url:address,api_key:key.value,model_name:name});
      if(version===request&&modal.isConnected)result.replaceChildren(...testOutcome(value),note(`本次测试模型：${name}；测试不会保存连接或添加模型。`));
    }catch(err){if(version===request&&modal.isConnected)result.replaceChildren(element('p',err.message,'view-error'));}
    finally{testDraft.disabled=false;}
  });
  fields.append(testDraft,note('测试使用当前填写的 URL 与 Key；编辑时 Key 留空则复用已保存的 Key。测试通过不代表所有待添加模型都可用。'),impact);
  const actions=element('div','','actions provider-editor-actions'),save=element('button','保存'),cancel=button('取消',()=>modal.close());save.type='submit';
  const latest=button('读取最新版本并比较',async()=>{
    latest.disabled=true;
    try{
      const value=await api('/api/models'),next=byProvider(value.models.filter(model=>model.repository_id===source.repository_id)).find(models=>models.some(model=>model.id===source.id));
      if(!next)throw new Error('该供应商已删除，草稿仍保留，请取消后确认最新列表。');
      const comparison=element('p',`服务器当前地址：${next[0].api_url}；模型：${next.map(model=>model.model_name).join('、')}。当前表单仍为你的草稿，核对后再保存。`,'provider-comparison');
      group=next;source=next.find(model=>model.key_configured)||next[0];existing.clear();next.forEach(model=>existing.add(model.model_name));
      for(const name of selected)if(existing.has(name))selected.delete(name);
      message.replaceChildren(comparison);draw();latest.hidden=true;
    }catch(err){message.textContent=err.message;}finally{latest.disabled=false;}
  });latest.hidden=true;actions.append(latest);
  const snapshot=()=>group.map(model=>({id:model.id,version:model.version}));
  if(editing&&group.some(model=>model.key_configured))actions.append(button('撤销供应商 Key',async()=>{
    const revoked=await confirmDialog({title:'撤销此供应商的 API Key？',body:[`撤销这 ${group.length} 个模型的 Key，使用它们的任务将等待配置。`,'未保存的 URL 和待添加模型不会保存。'],action:'撤销',danger:true,
      run:()=>api(`/api/models/${source.id}/provider`,'PATCH',{versions:snapshot(),revoke_key:true})});
    if(revoked){modal.close();await after('已撤销供应商下全部模型的 Key');}
  },'quiet destructive'));
  actions.append(cancel,save);const scroll=element('div','','provider-editor-scroll');scroll.append(fields);form.append(head,scroll,message,actions);modal.append(form);document.body.append(modal);
  form.addEventListener('submit',async event=>{
    event.preventDefault();message.textContent='';const address=url.value.trim(),name=manual.value.trim();if(name&&!existing.has(name))selected.add(name);
    if(!address||!editing&&!key.value.trim()){message.textContent='请填写接口 URL 和 API Key';return;}
    if(!editing&&!selected.size){message.textContent='请先选择或手动添加至少一个模型';return;}
    const changes={};if(editing){if(address!==source.api_url)changes.api_url=address;if(key.value.trim())changes.api_key=key.value;if(selected.size)changes.model_names=[...selected];}
    if(editing&&!Object.keys(changes).length){modal.close();return;}drawImpact();
    fields.disabled=true;for(const control of actions.querySelectorAll('button'))control.disabled=true;
    try{
      await api(editing?`/api/models/${source.id}/provider`:'/api/models/provider',editing?'PATCH':'POST',editing?{versions:snapshot(),...changes}:{repository_id:repositoryId,api_url:address,api_key:key.value,model_names:[...selected]});
      modal.close();await after(editing?'已保存供应商配置'+(selected.size?'，已添加 '+[...selected].join('、'):''):'已新增供应商，已添加 '+[...selected].join('、'));
    }catch(err){const code=err.message.replace(/^\d+\s*·\s*/,'');message.textContent=({version_conflict:'供应商已被其他页面修改。草稿已保留，请读取最新版本并核对差异后再保存。',provider_already_exists:'该地址已有供应商，请在对应供应商中编辑。',model_key_missing:'请填写 API Key 后添加模型。',model_already_exists:'要添加的模型已经存在，请重新打开供应商。'})[code]||err.message;latest.hidden=code!=='version_conflict';}
    finally{fields.disabled=false;for(const control of actions.querySelectorAll('button'))control.disabled=false;}
  });
  modal.addEventListener('close',()=>{request++;key.value='';modal.remove();},{once:true});draw();modal.showModal();
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
// The address preview follows the typing; `changed` runs on every edit of the URL.
function watchEndpoint(url, preview, changed = () => {}) {
  let previewRequest = 0, timer = null;
  url.addEventListener('input', () => {
    changed(); clearTimeout(timer); const value = url.value.trim(), request = ++previewRequest;
    if (!value) { preview.replaceChildren(); return; }
    timer = setTimeout(async () => {
      try { const endpoints = await api('/api/models/endpoints?api_url=' + encodeURIComponent(value)); if (request === previewRequest) preview.replaceChildren(...endpointFacts(endpoints)); }
      catch { if (request === previewRequest) preview.replaceChildren(element('p', '地址无效：需要 http:// 或 https://，不能包含用户名、密码、? 或 #。', 'endpoint-warning')); }
    }, 250);
  });
}
// Fields of an unsaved model: URL with its resolved addresses, key, name with an optional pick from the upstream list.
function modelFields(repositoryId) {
  const url = input('api_url', '', { type: 'url', required: true, placeholder: 'https://example.com/v1' }), key = input('api_key', '', { type: 'password', required: true, autocomplete: 'new-password' });
  const name = input('model_name', '', { required: true, maxLength: 200 }), picker = document.createElement('select'), pick = field('从上游列表选用', picker);
  const preview = element('div', '', 'endpoint-preview'), result = probeResult(), actions = element('div', '', 'actions probe-actions');
  preview.setAttribute('aria-live', 'polite'); pick.hidden = true;
  picker.addEventListener('change', () => { if (picker.value) name.value = picker.value; });
  // A changed address or key makes earlier upstream answers stale.
  const stale = () => { result.dataset.request = String(Number(result.dataset.request || 0) + 1); result.replaceChildren(); pick.hidden = true; picker.replaceChildren(); };
  watchEndpoint(url, preview, stale);
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

function showActionsFailureStatus(message, status) {
  message.className = status?.error ? 'endpoint-warning' : 'muted';
  message.textContent = status?.error ? status.error === 'actions_workflow_run_subscription_missing'
    ? '配置错误：此仓库使用的 App 安装未订阅 Webhook 事件「Workflow run」，Actions 失败分析已停止，不读取运行、不重跑、不提报。'
      + `请 App 管理员在 App 设置的 Permissions & events → Subscribe to events 勾选「Workflow run」并保存。${eventPermissionNotes.workflow_run}`
    : status.error === 'actions_permission_missing'
    ? '配置错误：此仓库使用的 App 安装没有 Actions 权限，GitHub 也不会向它投递「Workflow run」事件，Actions 失败分析已停止。'
      + '请 App 管理员在 Permissions & events 把 Actions 设为「Read and write」（读取运行只需只读，重跑失败的作业需要写），再由安装所有者接受新权限。不需要 Workflows 权限。'
    : /^model_/.test(status.error) ? `Actions 失败分析在等模型：${status.error}。请在「模型」页为 Actions 失败处理选择可用的模型，或检查项目默认模型。`
    : `Actions 失败处理已暂停：${status.error}。请检查账号授权或日志读取状态。`
    : status ? '配置检查通过后每分钟扫描；重复事件和人工重跑共用原运行的一次自动重试预算。' : '等待检查 App 事件订阅。';
}
async function refreshActionsFailureStatus(token) {
  if (token !== renderToken || current?.section !== 'roles' || !current.policy.actions_failures_enabled) return;
  try {
    const value = await api('/api/repositories/' + current.id);
    if (token !== renderToken) return;
    current.actionsFailures = value.actions_failures;
    const message = document.querySelector('[data-actions-status]'); if (message) showActionsFailureStatus(message, value.actions_failures);
  } catch { /* Keep the last visible status; the next poll can recover. */ }
  if (token === renderToken) projectTimer = setTimeout(() => refreshActionsFailureStatus(token), 5000);
}

function membersSection() {
  const target = current, id = target.id, address = location.hash, section = card('项目成员与授权来源');
  const live = () => current === target && location.hash === address && section.isConnected;
  let readVersion = 0;
  const load = async () => {
    const request = ++readVersion, isCurrent = () => live() && request === readVersion;
    let data;
    try { data = await api(`/api/repositories/${id}/members`); }
    catch (err) {
      if (isCurrent()) section.replaceChildren(element('h3', '项目成员与授权来源'), consoleState('成员权限读取失败',
        err.status === 403 ? '需要本项目配置权限。请联系组织或平台管理员；身份绑定不会自动增加成员管理能力。' : err.message,
        { tone: 'error', retry: load }));
      return;
    }
    if (!isCurrent()) return;
    section.replaceChildren(element('h3', '项目成员与授权来源'), note(`本次读取：${timestamp(data.read_at)}。每次操作仍由服务端重新核验。平台超级管理员可管理全部项目，不计入下方项目授权。`));
    const list = element('div', '', 'project-member-list');
    for (const grant of data.grants) {
      const row = element('article', '', 'project-member'), inherited = grant.scope === 'tenant', github = grant.source === 'github_derived';
      row.append(element('h4', grant.principal_name), badge(({ active: '有效', revoked: '已撤销', inactive: '账号已停用', pending_verification: '待验证', quarantined: '归属待处理' })[grant.state] || grant.state, grant.state === 'active' ? 'success' : 'warning'),
        facts([['角色', ({ project_admin: '项目管理员', org_admin: '组织管理员', delegated: '受委派成员', service: '项目服务身份' })[grant.role] || grant.role],
          ['生效范围', inherited ? '整个组织，包含本项目' : '仅本项目'], ['授权来源', github ? 'GitHub 当前权限（继承）' : inherited ? '组织显式委派（继承）' : '项目显式委派'],
          ['最近核验', grant.verified_at ? timestamp(grant.verified_at) : '未提供核验时间'], ['到期时间', grant.expires_at == null ? '未设置到期时间' : timestamp(grant.expires_at)]]));
      const capabilities = element('details', '', 'fold'); capabilities.append(element('summary', '查看授权能力'), note(grant.capabilities.join('、') || '当前无有效能力')); row.append(capabilities);
      row.append(note(github ? '由当前 GitHub 身份和安装范围核验；请在 GitHub 修改后重新验证，不能在这里直接编辑。' : inherited ? '继承自组织授权，请在原授权来源调整；移除项目单独授权不会移除继承权限。' : grant.policy === 'legacy' ? '由平台管理员在下方管理项目分配。' : '独立显式委派沿用授权服务管理；撤销其他来源不会移除这条委派。'));
      list.append(row);
    }
    if (!data.grants.length) list.append(consoleState('没有本项目授权记录', '平台超级管理员仍可管理本项目。需要其他成员访问时，请由有转授权能力的管理员处理。'));
    section.append(button('刷新成员权限', load, 'quiet'), list);
    if (data.can_manage_legacy) {
      const legacy = card('项目管理员分配'); section.append(legacy); await loadLegacy(legacy, isCurrent);
    } else section.append(note('当前页面只展示授权。项目管理员不自动拥有 grants.manage，不能再转授权。'));
  };
  const loadLegacy = async (container, isCurrent) => {
    try {
    const [{ users }, { assignments, organization_assignments: organizations, organizations: installed }] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    if (!isCurrent()) return;
    const list = element('ul', '', 'history'), add = element('div', '', 'actions member-add'), message = element('p', '', 'view-error'); message.setAttribute('role', 'alert');
    container.append(note('只修改本项目的旧式显式分配；GitHub 派生、独立委派和整个组织授权保持各自来源。'), list, add, message);
    const assigned = user => assignments.filter(a => a.user_id === user.id).map(a => a.repository_id);
    // Only the single-repository grant is changed here; a whole-organization grant is edited on the users page.
    const wholeOrganization = user => organizations.some(o => o.user_id === user.id && o.owner_id === target.repository.owner_id);
    // A grant whose repository is neither installed nor a project any more would be refused, so saving here drops it.
    const grantable = new Set([...installed.flatMap(o => o.repositories.map(r => r.id)), ...repositories.map(r => r.id)]);
    let pending = false;
    const update = async (user, ids) => {
      if (pending || !live()) return; pending = true;
      container.querySelectorAll('button,select').forEach(control => control.disabled = true); message.textContent = '';
      try { await api('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: ids.filter(id => grantable.has(id)) }); if (live()) await load(); }
      catch (err) { if (live()) message.textContent = '项目分配保存失败：' + err.message; }
      finally { pending = false; container.querySelectorAll('button,select').forEach(control => control.disabled = false); }
    };
    for (const user of users.filter(u => u.role === 'project_admin' && (assigned(u).includes(id) || wholeOrganization(u)))) {
      const li = element('li', ''); li.append(element('span', user.username + (user.active ? '' : '（已停用）')));
      if (wholeOrganization(user)) li.append(element('span', '整个组织授权，在「用户」页修改', 'muted'));
      if (assigned(user).includes(id)) li.append(button('移除', async () => {
        if (await askConfirm({ title: `移除 ${user.username} 的项目分配？`, body: ['只移除此项目的显式分配；组织继承、GitHub 派生和其他显式委派仍按各自条件生效。'], action: '移除分配', danger: true })) await update(user, assigned(user).filter(value => value !== id));
      }));
      list.append(li);
    }
    if (!list.childElementCount) list.append(element('li', '还没有项目管理员，超级管理员可以管理全部项目。', 'muted'));
    const candidates = users.filter(u => u.role === 'project_admin' && u.active && !assigned(u).includes(id) && !wholeOrganization(u)), select = document.createElement('select');
    select.setAttribute('aria-label', '添加项目管理员');
    select.add(new Option(candidates.length ? '选择项目管理员' : '没有可添加的项目管理员（在“用户”页创建）', '')); candidates.forEach(u => select.add(new Option(u.username, u.id)));
    add.append(select, button('添加', () => { const user = candidates.find(u => u.id === select.value); if (user) return update(user, [...assigned(user), id]); }));
    } catch (err) { if (isCurrent()) container.append(consoleState('项目分配读取失败', err.message, { tone: 'error', retry: () => { container.replaceChildren(element('h3', '项目管理员分配')); return loadLegacy(container, isCurrent); } })); }
  };
  section.append(consoleState('正在读取项目授权', '按本项目范围核对有效授权和历史来源。'));
  void load();
  return [section];
}

function activitySection() { const box = element('div', '', 'status-grid'); box.id = 'activity-status'; box.append(...activityCards()); return [box]; }
function activityCards() {
  const environment = current.environment; if (!environment) return [note('暂时读不到运行状态。')];
  const { running_tasks: running = [], queued_tasks: queued = [], task_concurrency: limit, tasks } = environment, work = card(`正在执行 ${running.length}／${limit ?? 1}`);
  const list = element('ul', '', 'history');
  for (const task of running) { const row = element('li', ''); row.append(button(projectTaskLabel(task), () => openTask(task.id), 'quiet linkish'), state(task.status)); list.append(row); }
  work.append(running.length ? list : note('暂无正在执行的任务。'), note(`这台虚拟电脑最多同时执行 ${limit ?? 1} 个任务，其余任务排队。`));
  const queue = card(`排队任务 ${queued.length}`), queueList = element('ul', '', 'history');
  for (const task of queued) {
    const row = element('li', ''); row.append(button(projectTaskLabel(task), () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `入队 ${timestamp(task.created_at)}`, 'muted wide-cell')); queueList.append(row);
  }
  queue.append(queued.length ? queueList : note('暂无排队任务。'));
  const recent = card('最近任务'), taskList = element('ul', '', 'history');
  recent.classList.add('activity-history');
  for (const task of tasks) {
    const row = element('li', ''); row.append(button(projectTaskLabel(task), () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `${task.generation ? 'g' + task.generation + ' · ' : ''}${timestamp(task.updated_at)}`, 'muted wide-cell'),taskMetricsLine(task)); taskList.append(row);
  }
  recent.append(tasks.length ? taskList : note('还没有任务。'));
  return [work, queue, recent];
}

// One rule file: what it does, where the effective text comes from, and the project console override (edited on demand).
function ruleCard(path) {
  const id = current.id, [, purpose, task] = ruleInfo(path), row = current.rules?.files.find(file => file.path === path), section = card(purpose);
  section.classList.add('rule-card'); section.dataset.rulePath = path;
  if (!row) { section.append(note(current.rules ? '仓库没有这个文件。' : '暂时读不到规则文件，稍后再试。')); return section; }
  const meta = element('div', '', 'rule-meta'); meta.append(element('code', path), badge('生效：' + layerNames[row.source], row.source === 'builtin' ? '' : 'info'), element('span', '用于' + (/^[A-Za-z]/.test(task) ? ' ' : '') + task, 'muted'));
  section.append(meta);
  if (current.ruleNotice?.path === path) { const done = element('p', current.ruleNotice.text, 'view-success flash'); done.setAttribute('role', 'status'); section.append(done); current.ruleNotice = null; }
  const lines = row.effective.split('\n').length;
  section.append(collapsible(`当前生效内容（${lines} 行）`, row.effective));
  for (const layer of row.layers) if (layer.source !== row.source) section.append(collapsible(`${layerNames[layer.source]}（被覆盖）`, layer.content));
  if (!path.startsWith('.bot/rules/') && path !== '.bot/guide.md') return section;
  const consoleLayer = row.layers.find(layer => layer.source === 'console'), actions = element('div', '', 'actions'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  section.append(note(row.source === 'repository' ? (consoleLayer ? '默认分支的仓库文件整份覆盖控制台内容；控制台覆盖只在仓库删除该文件后生效。' : '默认分支的仓库文件整份覆盖内置默认；在这里添加的控制台覆盖只在仓库删除该文件后生效。')
    : consoleLayer ? '项目控制台覆盖了内置默认；默认分支加入同名仓库文件后以仓库为准。' : '使用内置默认。保存控制台覆盖后整份替换内置内容；默认分支加入同名仓库文件后以仓库为准。'), actions, message);
  const save = async content => {
    try { const { rules } = await api(`/api/repositories/${id}/rules`, 'PUT', { path, content }); if (current?.id !== id) return; current.rules = rules;
      current.ruleNotice = { path, text: content === null ? '已清除控制台覆盖' : '已保存控制台覆盖' };
      updateRuleSources(); if (typeof managerChanged === 'function') void managerChanged();
      const common = section.closest('details.common-rule');
      if (common) common.querySelector('.common-rule-body').replaceChildren(ruleCard(path));
      else if ($('project-detail')?.redraw) $('project-detail').redraw();
      else { current.focusRule = path; renderProject({ id: current.id, section: current.section, item: current.item }); } }
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

function ruleSource(path) {
  const row = current.rules?.files.find(file => file.path === path), source = element('span', '', 'task-rule-source');
  if (path) source.dataset.ruleSource = path;
  const name = row ? layerNames[row.source] : !current.rules ? '暂未读取' : !path ? '内置默认' : '未配置';
  source.append(badge(name, row?.source === 'repository' ? 'info' : row?.source === 'console' ? 'success' : ''));
  source.title = !current.rules ? '暂时无法读取规则，无法确定生效来源。' : !path ? '内置默认：生效（release-notes-v1）' : Object.entries(layerNames).map(([key, label]) => `${label}：${row?.source === key ? '生效' : row?.layers.some(layer => layer.source === key) ? '被覆盖' : '未配置'}`).join('；');
  return source;
}
function updateRuleSources() {
  $('project-page')?.querySelectorAll('[data-rule-source]').forEach(node => node.replaceWith(ruleSource(node.dataset.ruleSource)));
}
function commonRule(path, title) {
  const details = element('details', '', 'common-rule'), summary = element('summary'), body = element('div', '', 'common-rule-body');
  details.dataset.commonRule = path;
  summary.append(element('strong', title), ruleSource(path), element('span', '展开内容与编辑', 'muted'));
  details.append(summary, body);
  details.addEventListener('toggle', () => { if (details.open && !body.querySelector('form')) body.replaceChildren(ruleCard(path)); });
  return details;
}
function ruleSync() {
  const id = current.id, section = element('div', '', 'rule-sync'), source = note(''), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'rule-sources'; message.setAttribute('role', 'status');
  const describe = () => { source.textContent = current.rules?.sha ? `默认分支提交 ${current.rules.sha.slice(0, 12)} · ${timestamp(current.rules.updated_at)}` : current.rules ? '尚未读取默认分支，当前显示内置与控制台配置。' : '暂时无法读取规则，点击刷新重试。'; };
  const refresh = button('刷新默认分支文件', async () => {
    refresh.disabled = true; refresh.textContent = '正在读取默认分支…'; message.className = 'view-error'; message.textContent = '';
    try {
      const { rules } = await api(`/api/repositories/${id}/rules/refresh`, 'POST', {});
      if (current?.id !== id) return;
      current.rules = rules; updateRuleSources(); describe();
      // Refresh saved content without discarding an editor's unsaved draft.
      $('project-page').querySelectorAll('.common-rule').forEach(details => {
        const body = details.querySelector('.common-rule-body');
        if (!body.querySelector('form')) body.replaceChildren(...(details.open ? [ruleCard(details.dataset.commonRule)] : []));
      });
      const detail = $('project-detail'); if (detail?.redraw && !detail.hidden && !detail.querySelector('form')) detail.redraw();
      message.className = 'view-success flash'; message.textContent = `已读取默认分支提交 ${rules.sha.slice(0, 12)}`;
    } catch (err) { message.textContent = err.message; }
    finally { refresh.disabled = false; refresh.textContent = '刷新默认分支文件'; }
  });
  describe(); section.append(source, refresh, message); return section;
}
// Details stay in the project page instead of covering the table with a modal.
function showProjectDetails(title, render) {
  const redraw = notice => {
    const detail = $('project-detail'); if (!detail) return;
    const head = element('div', '', 'heading'), heading = element('h3', title);
    heading.id = 'project-detail-title'; head.append(heading, button('收起', () => { detail.hidden = true; detail.replaceChildren(); }, 'quiet'));
    detail.hidden = false; detail.redraw = redraw; detail.setAttribute('aria-labelledby', heading.id);
    detail.replaceChildren(head, ...(notice ? [element('p', notice, 'view-success flash')] : []), ...render());
  };
  redraw(); $('project-detail')?.scrollIntoView({ block: 'nearest' }); return redraw;
}
function openProjectRule(path) { showProjectDetails(ruleInfo(path)[1], () => [ruleCard(path)]); }
function projectTable(captions, name) {
  const table = document.createElement('table'), head = document.createElement('tr'), body = document.createElement('tbody');
  table.className = 'project-table'; table.setAttribute('aria-label', name);
  for (const caption of captions) { const th = element('th', caption); th.scope = 'col'; head.append(th); }
  table.createTHead().append(head); table.append(body); return { table, body };
}
function tableCell(row, caption, ...nodes) {
  const td = document.createElement('td'); td.dataset.label = caption; td.append(...nodes); row.append(td); return td;
}
function modelsSection() {
  const section = card('工作类型模型'), { table, body } = projectTable(['工作类型', '模型选择'], '工作类型模型');
  section.append(note('未指定模型时继承项目默认。失效的模型不会自动替换。「Manager 分派」是每个事件调用一次的分派模型。'));
  let overrides = {}; try { overrides = taskModelMap(current.policy); } catch {}
  // Saved identifiers that are no work type (such as models of former custom workflows) stay visible so they can be removed.
  const other = Object.keys(overrides).filter(kind => !builtInTasks.some(task => task.kind === kind));
  for (const definition of [...builtInTasks, ...other.map(kind => ({ kind, title: kind, custom: true }))]) {
    const row = document.createElement('tr'); row.dataset.taskKind = definition.kind; row.dataset.overviewAnchor = definition.kind;
    tableCell(row, '工作类型', element('strong', definition.title), element('code', definition.kind));
    tableCell(row, '模型选择', taskModelEditor(definition.kind, definition.title, current.policy, current.models, definition)); body.append(row);
  }
  section.append(table); return [projectDefaultModelCard(current.policy, current.models), section, ...modelManagementSections()];
}
