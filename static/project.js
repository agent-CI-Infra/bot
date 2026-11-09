// Project pages: one settings page per repository with categories on the left (#/projects/<id>/<section>).
// Loaded after app.js and views.js and reuses their helpers.
const projectSections = [['basic', '基本设置'], ['management', '管理对话'], ['machine', '机器配置'], ['model', '模型'], ['release', '发版本'], ['knowledge', '项目知识'], ['notes', '项目笔记'], ['roles', 'Manager 与角色'], ['external', '外部执行'], ['members', '成员', true], ['activity', '运行状态']];
// Older addresses open the Manager page: the workflows page it replaced, the task overview and the review, development and rule pages.
const legacyProjectSections = { workflows: 'manager-prompt', tasks: '', review: 'work-types', development: 'work-types', rules: 'rule-sources' };
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
function projectRoute() { const m = /^#\/projects\/([1-9]\d*)(?:\/([a-z]+)(?:\/([\w.-]+))?)?$/.exec(location.hash); return m ? { id: m[1], section: m[2] || 'basic', item: m[3] || null } : null; }
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
function settingsForm(title, nodes, save, { editable = true, caption = '保存', after = null } = {}) {
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
    try {
      const done = await save(form, text => { message.className = 'view-progress'; message.textContent = text; }), text = typeof done === 'string' && done ? done : '已保存';
      if (after) await after(text); else { current.flash = text; await reloadProject(); }
    }
    catch (err) { message.className = 'view-error'; message.textContent = err.message; } finally { submit.disabled = false; }
  });
  section.append(form); return section;
}

let current = null, projectTimer = null, renderToken = 0;
// Loads the project once per visit and re-renders the active section; status cards refresh on their own.
async function renderProject(route) {
  const legacyFocus = legacyProjectSections[route.section];
  if (legacyFocus !== undefined) {
    route = { ...route, section: 'roles' };
    history.replaceState(null, '', `#/projects/${route.id}/roles`);
  }
  const token = ++renderToken, page = $('project-page'); clearTimeout(projectTimer);
  if (current?.id !== route.id) { current = { id: route.id }; page.replaceChildren(element('p', '正在加载…', 'muted')); }
  if (legacyFocus) current.focusAnchor = legacyFocus;
  try { await loadProject(route.id,route.section); } catch (err) { if (token === renderToken) page.replaceChildren(element('p', err.message, 'view-error')); return; }
  if (token !== renderToken) return;
  const section = projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin')) ? route.section : 'basic';
  current.section = section; page.replaceChildren(projectHeader(), projectBody(section));
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
  const [repo, environment, installed, rules, models] = await Promise.all([api('/api/repositories/' + id), api('/api/environments/' + id).catch(() => null), superUser ? api('/api/installations').catch(() => null) : null, api('/api/repositories/'+id+'/rules').catch(()=>null), api(superUser ? '/api/models' : '/api/models?repository_id='+id).catch(()=>null)]);
  const external=section==='external'?await loadExternalProject(id):null;
  Object.assign(current, { external, repository: repo.repository, policy: repo.policy, actionsFailures: repo.actions_failures, concurrencyDefault: repo.task_concurrency_default, environment, installed: installed?.repositories.find(r => r.id === id) || null, rules:rules?.rules,
    models:(models?.models||[]).filter(model=>model.repository_id===null||model.repository_id===id) });
}
async function reloadProject() { await loadProject(current.id); renderProject({ id: current.id, section: current.section }); }
// Reloads the project with the outcome of an action shown at the top of the section.
async function reloadWith(notice) { if (notice) current.flash = notice; await reloadProject(); }
function projectStatus() {
  const { policy, installed } = current;
  const status = !policy.enabled ? badge('已禁用', 'warning') : policy.review_enabled ? badge('工作中', 'success') : badge('未开检视', 'warning');
  const permission = installed?.access_gaps?.length ? [permissionBadge(installed)] : [];
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
    if (key === 'management') { const project = current.id; item.addEventListener('click', event => { event.preventDefault(); void openManagementChat(project).catch(error); }); }
  }
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  content.append(...({ basic: basicSection, machine: machineSection, model: modelsSection, release: releaseSection, knowledge: knowledgeSection, notes: notesSection, roles: rolesSection, external: externalSection, members: membersSection, activity: activitySection }[section])());
  body.append(nav, content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

function releaseSection() {
  const section = card('发版本'), endpoint = `/api/repositories/${current.id}/releases`, id = current.id;
  section.classList.add('release-panel');
  const version = input('release_version', '', { placeholder: 'v1.2.3 或 v1.2.3-beta.1', maxLength: 256 }), preview = element('div'), status = element('div'), message = element('p', '', 'view-error');
  const confirm = button('确认打标签', async () => {
    const p = current.releasePreview;
    if (!p?.available || p.version !== version.value) return;
    if (!await askConfirm({ title: `确认打标签 ${p.version}？`, body: [p.target_sha, p.target_title, '工作流成功后生成草稿，正式发布仍需单独确认。'], action: '确认打标签' })) return;
    try { confirm.disabled = true; await api(endpoint, 'POST', { version: p.version, target_sha: p.target_sha, credential: p.credential }); await refresh(); }
    catch (err) { message.textContent = err.message; await check(); }
  }); confirm.disabled = true;
  const check = async () => {
    const value = version.value; confirm.disabled = true; message.textContent = '';
    try {
      const p = await api(endpoint + '/preflight?version=' + encodeURIComponent(value));
      if (current.id !== id || value !== version.value) return;
      current.releasePreview = p;
      version.pattern = p.version_pattern || '';
      // Failed checks stand out once a well-formed version is entered; before that they only describe what is needed.
      preview.replaceChildren(...(p.checks || []).map(c => {
        const item = note(c.message + (c.reason ? ' ' + c.reason : '')); if (!c.ok && p.version_valid) item.classList.add('release-check-failed'); return item;
      }));
      if (p.detail) preview.append(note(p.detail));
      if (p.target_sha) preview.append(facts([['默认分支', p.default_branch], ['目标提交', link(p.target_url, p.target_sha)], ['提交标题', p.target_title], ['版本', !p.version_valid ? '请填写合法版本号' : p.prerelease ? '预发布' : '稳定版'],
        ['上一枚版本', p.previous_tag ? `${p.previous_tag.name} · ${p.previous_tag.sha}` : '从仓库历史起算'], ['发行说明规则', `${p.skill.source} · ${p.skill.path || p.skill.version}`],
        ['已有标签', p.existing_tag ? p.existing_tag.commit : '无'], ['已有 Release', p.existing_release ? link(p.existing_release.url, p.existing_release.draft ? '已有草稿' : '已由仓库工作流／外部操作发布') : '无']]));
      confirm.disabled = !p.available;
    } catch (err) { message.textContent = err.message; }
  };
  version.addEventListener('input', () => { confirm.disabled = true; });
  version.addEventListener('change', check);
  const refresh = async () => {
    try {
      const data = await api(endpoint); if (current.id !== id || current.section !== 'release') return;
      if (document.activeElement?.name === 'release_body') return;
      status.replaceChildren(...data.releases.map(r => releaseRecord(r, endpoint, refresh, message)));
    } catch (err) { message.textContent = err.message; }
  };
  const checks = element('div', '', 'actions'), actions = element('div', '', 'actions'), history = element('h4', '发布记录');
  checks.append(button('检查候选提交', check)); actions.append(confirm); status.className = 'release-history';
  section.append(note('填写版本并确认目标提交。控制面创建标签，复用仓库 Release 工作流，成功后准备发行说明草稿。'), field('版本号', version), checks, preview, actions, message, history, status);
  void check(); void refresh();
  const poll = async () => { if (current?.id !== id || current.section !== 'release') return; await refresh(); projectTimer = setTimeout(poll, 5000); };
  projectTimer = setTimeout(poll, 5000); return [section];
}
const releaseStages = { tagging: '正在打标签', waiting_run: '等待 Release 工作流', running: '工作流运行中', preparing_notes: '准备发行说明', creating_draft: '创建草稿', draft: '草稿待发布', publishing: '正式发布中', published: '已人工发布', externally_published: '已由仓库工作流／外部操作发布', failed: '失败', waiting_permission: '等待权限处理', write_unknown: '写入结果待查证' };
function releaseRecord(r, endpoint, refresh, message) {
  const section = card(r.version), run = r.run;
  section.classList.add('release-record');
  section.append(facts([['阶段', releaseStages[r.stage] || r.stage], ['目标提交', r.target_sha], ['失败步骤', r.failure_step], ['错误码', r.error], ['说明', r.detail],
    ['工作流', run?.name], ['Run／attempt', r.run_id ? `${r.run_id} / ${r.run_attempt}` : null], ['状态／结论', run ? `${run.status} / ${run.conclusion || '等待结果'}` : null],
    ['开始时间', run?.started_at], ['结束时间', run?.ended_at], ['Actions', r.actions_url ? link(r.actions_url, '查看本次运行') : null]]));
  const jobs = element('div', '', 'release-jobs');
  for (const job of run?.jobs || []) {
    const item = element('div', '', 'release-job'); item.append(note(`${job.name} · ${job.status} · ${job.conclusion || '等待结果'}`), link(job.url, '查看 job'));
    const failed = (job.steps || []).filter(s => s.conclusion && s.conclusion !== 'success');
    for (const step of failed) item.append(note(`Step ${step.number}: ${step.name} · ${step.conclusion}`)); jobs.append(item);
  }
  section.append(jobs);
  for (const candidate of r.candidates || []) section.append(link(candidate.url, `候选 run ${candidate.id}`));
  const action = (caption, suffix) => {
    const pending = current.releaseActions ||= new Set(), key = r.id + ':' + suffix;
    const control = button(pending.has(key) ? caption + '…' : caption, async () => {
      if (pending.has(key)) return;
      pending.add(key); control.disabled = true; control.textContent = caption + '…';
      try { await api(endpoint + '/' + r.id + '/' + suffix, 'POST', { revision: r.revision }); }
      catch (err) { message.textContent = err.message; }
      finally { pending.delete(key); await refresh(); }
    });
    control.disabled = pending.has(key); return control;
  };
  const actions = element('div', '', 'actions'); section.append(actions);
  if (r.stage === 'failed' && ['release_ci_unsuccessful', 'release_rerun_not_started'].includes(r.error) && r.run_id) actions.append(action('重跑', 'rerun'));
  if (['failed', 'write_unknown', 'waiting_permission'].includes(r.stage) && r.error !== 'release_ci_unsuccessful') actions.append(action('继续／查证此步骤', 'resume'));
  if (r.run_id) actions.append(action('让智能体看这次运行（只读）', 'observe'));
  // The request goes to the Manager first; its task runs in the project computer, and this page refreshes until it is done.
  if (r.observation_event && !r.observation_task) section.append(note('运行分析的请求在等 Manager 分派，安排后在项目电脑里执行。'));
  if (r.observation_task) {
    const pending = element('p', '运行分析在项目电脑里排队或执行中，完成后显示在这里。', 'muted');
    pending.append(' ', button('查看分析过程', () => openTask(r.observation_task), 'quiet')); section.append(pending);
  }
  if (r.observation_error) section.append(note(r.observation_error));
  if (r.observation) {
    section.append(note(`运行分析 · run ${r.observation.run_id} / attempt ${r.observation.attempt} · 仅供排查的建议`), releaseAdvice(r.observation.advice));
    for (const job of r.observation.jobs) section.append(link(job.url, `${job.name} · ${job.conclusion}`));
    for (const log of r.observation.logs || []) {
      const related = log.run_id !== r.observation.run_id || log.attempt != null && log.attempt !== r.observation.attempt;
      const origin = related ? ` · run ${log.run_id} / attempt ${log.attempt ?? '未知'}` : '';
      const details = element('details'); details.append(element('summary', `${log.name} 日志${origin} · 第 ${log.first_line}–${log.last_line || log.first_line} 行${log.truncated ? '（已截取）' : ''}`), link(log.url, '查看 job 完整日志'), element('pre', log.content)); section.append(details);
    }
  }
  if (r.release_url) actions.append(link(r.release_url, '查看 GitHub Release'));
  if (r.skill) {
    const provenance = element('details'); provenance.append(element('summary', '发行说明规则与范围'), facts([['规则来源', r.skill.source], ['规则路径／版本', r.skill.path || r.skill.version], ['规则所在提交', r.skill.sha], ['规则内容哈希', r.skill.hash], ['上一枚版本', r.previous_tag ? `${r.previous_tag.name} · ${r.previous_tag.sha}` : '从仓库历史起算']])); section.append(provenance);
  }
  if (r.sources) {
    const details = element('details'), summary = element('summary', `发行说明来源（${r.sources.length}）`); details.append(summary);
    for (const source of r.sources) details.append(note(`${source.kind} · ${source.title}`), link(source.url, source.id));
    if (!r.sources.length) details.append(note('本次范围无新增提交')); section.append(details);
  }
  if (r.stage === 'draft') {
    current.releaseEdits ||= new Map();
    let edit = current.releaseEdits.get(r.id);
    if (!edit?.dirty) { edit = { body: r.body || '', revision: r.revision, body_revision: r.body_revision, dirty: false }; current.releaseEdits.set(r.id, edit); }
    const editor = textarea('release_body', edit.body, { rows: 16, spellcheck: false });
    editor.addEventListener('input', () => { edit.body = editor.value; edit.dirty = true; });
    const save = button('保存草稿正文', async () => {
      try {
        save.disabled = true;
        const saved = await api(endpoint + '/' + r.id + '/draft', 'PATCH', { body: editor.value, revision: edit.revision, body_revision: edit.body_revision });
        current.releaseEdits.delete(r.id); await refresh(); message.textContent = saved.release.stage === 'draft' ? '草稿已保存' : '已由仓库工作流／外部操作发布';
      } catch (err) { message.textContent = err.message; await refresh(); } finally { save.disabled = false; }
    });
    const edits = element('div', '', 'actions');
    edits.append(save, button('丢弃本地编辑并刷新正文', async () => { current.releaseEdits.delete(r.id); message.textContent = ''; await refresh(); }));
    section.append(field('发行说明草稿', editor), note('保存正文不会正式发布。外部或其他人的修改会返回冲突，请刷新后对照。'), edits);
    const publish = button('正式发布', async () => {
      if (edit.dirty) { message.textContent = '请先保存草稿正文，再正式发布。'; return; }
      if (!await askConfirm({ title: `正式发布 ${r.version}？`, body: [r.target_sha, r.prerelease ? '发布后仍为预发布版本。' : '发布后为稳定版本。', '将此 GitHub Release 草稿改为正式发布。'], action: '正式发布' })) return;
      try {
        publish.disabled = true;
        await api(endpoint + '/' + r.id + '/publish', 'POST', { revision: r.revision, body_revision: r.body_revision }); await refresh();
      } catch (err) { message.textContent = err.message; await refresh(); } finally { publish.disabled = false; }
    }); edits.append(publish);
  } else if (r.body) { const body = element('pre', r.body); section.append(body); }
  return section;
}

// The 「Manager 与角色」 page: the Manager configuration (manager.js) above the roles: which entries run under the project
// controller, how the controller delegates Dev, Test, Reviewer and UX, and which Agent backend (harness) each role runs on;
// every role picks its backend, Pi is recommended. It explains a division of work and grants nothing: tools come from
// capability policies, writes from the work type configuration, completion from independent QA.

const roleRefText = ref => ref ? `${ref.id}@${ref.version}` : '—';
// The entries a project may put under the controller (controller.entries); every other work type keeps its executor.
const roleEntries = [['development', '开发', '开发 Issue、跟进 bot PR'], ['request', '普通任务', '管理对话或接口创建的任务'], ['review', '检视', '检视 Issue、检视 PR'], ['actions', 'Actions 失败分析', 'Actions 失败处理']];
const roleDuties = {
  manager: '读任务契约和记录，按需委派，再把候选提名给独立 QA。不能改代码、跑命令、发布、验收或合入。',
  dev: '唯一可写的角色：在任务检出里实现或排查，交出候选。',
  test: '在固定候选的独立检出里测试，只报告结果。',
  reviewer: '在固定候选的独立检出里检视，报告可执行的问题。',
  ux: '检查交互、可见状态和无障碍，只报告结果。',
  qa: '每次正式验收都新开上下文，判断候选是否满足任务契约。主控不能委派或代替它。',
  coordinator: '只在出现明确的跨任务请求时运行，给相关任务的主控提建议；不执行、不验收。' };
const harnessDetails = { pi: '项目电脑里的 Pi 会话', native: '控制面的工具循环', process: '控制面启动的独立 Node 进程', acp: '外部智能体，用它自带的模型', claude_code: 'Claude Code CLI，用它自带的模型' };
const modelSources = { role: '角色', workflow: '工作类型', project: '项目默认' };

/** Which entries run under the controller now: only when coordination is on and the entry is switched on. */
function coordinationEntries(config) {
  return roleEntries.map(([id, title, covers]) => ({ id, title, covers, coordinated: !!config.enabled && config.controller.entries[id] === true }));
}
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
 * How a role runs. A project that never saved its roles runs none of them; every role shows the recommended backend
 * (Pi) a save gives it (pending). A saved choice is shown as saved and never switched by the page: Native, Process, ACP
 * and Claude Code are peer backends. Only a configuration saved before V2 with coordination on, whose controller still
 * runs on its old backend, is marked as the old configuration in use (legacy); a save upgrades it to V2 with the
 * backends chosen in the table.
 */
function roleExecutor(role, config, { configured = true, recommended = 'pi', harnesses = [] } = {}) {
  if (!configured) { const backend = harnesses.find(h => h.id === recommended); return { id: recommended, name: harnessName(recommended), ref: backend ? `${recommended}@${backend.version}` : recommended, legacy: false, pending: true }; }
  const old = !!config.legacy && !!config.enabled && role.role_id === config.controller.role && role.harness_ref.id !== recommended;
  return { id: role.harness_ref.id, name: harnessName(role.harness_ref.id), ref: `${role.harness_ref.id}@${role.harness_ref.version}`, legacy: old, pending: false };
}
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
// The JSON the editor starts from: every saved backend as saved (stored choices are not migrated by the page).
const editableRole = r => ({ role_id: r.role_id, enabled: r.enabled, name: r.name, responsibility: r.responsibility, persona_prompt: r.persona_prompt,
  model_profile_ref: r.model_profile_ref ? { model_id: r.model_profile_ref.model_id, api: r.model_profile_ref.api, tool_calls: r.model_profile_ref.tool_calls, structured_output: r.model_profile_ref.structured_output } : null,
  skill_bundle_ref: r.skill_bundle_ref ? { id: r.skill_bundle_ref.id } : null, harness_ref: { id: r.harness_ref.id }, capability_policy_ref: { id: r.capability_policy_ref.id },
  environment_profile_ref: { id: r.environment_profile_ref.id }, budget_policy_ref: Object.fromEntries(Object.entries(r.budget_policy_ref).filter(([key]) => key !== 'version')),
  output_schema_ref: { id: r.output_schema_ref.id } });

function rolesSection() {
  const id = current.id, endpoint = `/api/repositories/${id}/roles`, holder = element('div', '', 'roles-page'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert'); holder.append(note('正在读取角色配置…'));
  const managerHolder = element('div', '', 'manager-holder');
  const refresh = async () => {
    // The Manager cards say who executes each work type, so they are drawn with the role configuration when it can be read.
    let data = null, failure = null;
    try { data = await api(endpoint); } catch (err) { failure = err; }
    if (current?.id !== id || current.section !== 'roles') return;
    managerHolder.replaceChildren(...managerSection(data));
    if (data) holder.replaceChildren(...roleCards(data, message)); else { holder.replaceChildren(); message.textContent = failure.message; }
  };
  void refresh(); return [managerHolder, holder, message];
}
function roleCards(data, message) {
  const config = data.configuration, byId = new Map(config.roles.map(role => [role.role_id, role]));
  const recommended = data.recommended_backend || 'pi', configured = data.configured !== false;
  const preview = roleId => data.preview.find(p => p.role === roleId), executorOf = role => roleExecutor(role, config, { configured, recommended, harnesses: data.harnesses });
  // Every role picks an Agent backend; a project that never saved its roles starts from the recommended one.
  const backends = data.backends || data.harnesses.map(h => ({ ...h, name: h.id, available: true }));
  const draft = { enabled: config.enabled, controller: config.controller, roles: config.roles.map(r => ({ ...editableRole(r), ...(!configured ? { harness_ref: { id: recommended } } : {}) })), skills: data.skill_inputs };
  const editor = textarea('role_configuration', JSON.stringify(draft, null, 2), { rows: 18, spellcheck: false, className: 'code' });
  return [coordinationCard(config, configured), delegationCard(config, byId, preview, executorOf), roleTableCard(data, config, preview, executorOf, { backends, draft, editor, message, configured }), roleEditorCard(data, config, message, { backends, editor, configured })];
}
// Whether role coordination is on, and for which entries; without it every entry keeps its own executor.
function coordinationCard(config, configured = true) {
  const section = card('角色协调'), head = element('div', '', 'roles-state'), entries = coordinationEntries(config);
  section.classList.add('roles-coordination');
  head.append(config.enabled ? badge('已开启', 'success') : badge('未开启'), element('span', `配置 revision ${config.revision}`, 'muted'));
  section.append(head);
  if (!config.enabled) section.append(element('p', '没有开启：开发、普通任务、检视和 Actions 失败分析都走原来的执行器，也就是每类工作在项目电脑里的 Pi 进程。交付前仍由独立 QA 在新的上下文里验收。'));
  else {
    const list = element('ul', '', 'role-entries');
    for (const entry of entries) {
      const item = element('li', ''); item.dataset.entry = entry.id;
      item.append(element('strong', entry.title), element('span', entry.covers, 'muted'), entry.coordinated ? badge('主控委派', 'info') : badge('原执行器'));
      if (entry.coordinated) item.append(element('span', ['review', 'actions'].includes(entry.id) ? entryDevText(config) : '可委派：' + workerNames(entryWorkers(config, entry.id)), 'role-entry-workers'));
      list.append(item);
    }
    section.append(list, note('上面关着的入口和其他工作类型（通用回复、CI 观察、发行说明、接入门禁）走原来的执行器。无论哪种方式，交付前都由独立 QA 验收。'));
  }
  const controller = config.roles.find(role => role.role_id === config.controller.role);
  if (!configured) section.append(note('还没有保存过角色配置。下面显示的是保存后各角色的默认后端（推荐 Pi）；开启协调并保存后才会运行。'));
  else if (config.legacy && config.enabled && controller?.harness_ref.id !== 'pi') section.append(element('p', `这份配置保存于 V2 之前，仍按旧配置运行：主控还是 ${harnessName(controller?.harness_ref.id)}。在「每个角色的解析结果」里为主控选好后端（推荐 Pi）后保存一次，就升级为 V2；保存时不改选，主控继续用 ${harnessName(controller?.harness_ref.id)}。正在运行的任务保留启动时的快照。`, 'endpoint-warning'));
  else if (config.legacy) section.append(note('这份配置保存于 V2 之前。保存一次就升级为 V2，各角色按「每个角色的解析结果」里选择的后端运行，页面不会替你改成 Pi。'));
  return section;
}
// One tile per role: what it does, the executor it runs on and the model it resolves to.
function roleTile(role, preview, executorOf) {
  const tile = element('article', '', 'role-tile' + (role.enabled ? '' : ' role-disabled')), executor = executorOf(role), head = element('div', '', 'role-tile-head');
  tile.dataset.role = role.role_id;
  head.append(element('strong', roleLabel(role.role_id, role.name)), ...(role.enabled ? [] : [badge('已停用')]));
  const runs = element('p', '', 'role-executor');
  runs.append(badge(executor.name, executor.legacy ? 'warning' : executor.id === 'pi' ? 'info' : ''), element('span', own(harnessDetails, executor.id) || executor.ref, 'muted'));
  if (executor.legacy) runs.append(badge('旧配置沿用', 'warning')); else if (executor.pending) runs.append(badge('保存后生效'));
  tile.append(head, element('p', own(roleDuties, role.role_id) || role.responsibility || '项目自定义的角色。'), runs, element('p', '模型：' + roleModelText(preview(role.role_id)), 'muted'));
  return tile;
}
function delegationCard(config, byId, preview, executorOf) {
  const section = card('主控怎样委派'), lanes = element('div', '', 'role-lanes'), lane = (title, ...tiles) => { const box = element('section', '', 'role-lane'); box.append(element('h4', title), ...tiles); return box; };
  const arrow = () => { const mark = element('span', '→', 'role-lane-arrow'); mark.setAttribute('aria-hidden', 'true'); return mark; };
  section.classList.add('roles-delegation');
  const controller = byId.get(config.controller.role), workers = config.roles.filter(role => !['controller', 'evaluator'].includes(role.kind)), qa = config.roles.find(role => role.kind === 'evaluator');
  const publish = element('article', '', 'role-tile role-framework'); publish.append(element('strong', '控制面发布'), element('p', '按工作类型配置允许的写入发布到 GitHub。合入另需人授权，任何角色都没有发布或合入工具。'));
  const tile = role => roleTile(role, preview, executorOf);
  lanes.append(lane('主控', ...(controller ? [tile(controller)] : [])), arrow(), lane('按需委派', ...workers.map(tile)), arrow(), lane('验收与发布', ...(qa ? [tile(qa)] : []), publish));
  section.append(note('主控按任务决定要谁：可能只委派 Dev，也可能再请 Test、Reviewer、UX 看同一份固定候选；检视意见回到同一个 Dev。'), lanes,
    note('这是分工说明，不是每个任务都要走一遍的流程，也不授予权限：工具只来自能力策略，写入只来自工作类型配置，换后端也不改变它们。开发和普通任务里，主控可以委派这里已启用的工作角色；检视和 Actions 失败分析接入主控后只委派 Dev，Dev 用这个入口自己的工具和工作区，后端按 Dev 的选择（旧 V2 配置在改选前仍用 Pi）。独立 QA 不是被委派的角色，它在主控提名候选之后验收。'));
  const coordinator = byId.get('coordinator');
  if (coordinator) { const line = element('div', '', 'role-coordinator'); line.append(tile(coordinator)); section.append(element('h4', '不在单个任务里的角色'), line); }
  return section;
}
// The exact resolution of every role, as a run would start now.
function roleTableCard(data, config, preview, executorOf, { backends, draft, editor, message, configured }) {
  const section = card('每个角色的解析结果'), { table, body } = projectTable(['角色', '执行后端', '模型（来源）', '技能包', '能力策略', 'revision'], '角色解析结果');
  for (const role of config.roles) {
    const row = document.createElement('tr'), executor = executorOf(role), model = preview(role.role_id);
    tableCell(row, '角色', element('strong', role.name), note(`${role.role_id} · ${role.kind}${role.enabled ? '' : ' · 已停用'}`));
    // The backend picker edits the configuration below; nothing changes until it is saved.
    const picker = document.createElement('select'); picker.setAttribute('aria-label', `${role.role_id} Agent 后端`);
    for (const backend of backends) {
      const option = new Option(`${backend.name}${backend.recommended ? '（推荐）' : ''}${backend.available ? '' : '（驱动待接入）'}`, backend.id);
      option.disabled = !backend.available || !backend.kinds.includes(role.kind); picker.add(option);
    }
    picker.value = draft.roles.find(r => r.role_id === role.role_id).harness_ref.id;
    picker.addEventListener('change', () => {
      try {
        const value = JSON.parse(editor.value), entry = value.roles.find(r => r.role_id === role.role_id);
        if (!entry) throw new Error('配置中缺少该角色');
        entry.harness_ref = { id: picker.value };
        editor.value = JSON.stringify(value, null, 2); message.textContent = '';
      } catch { message.textContent = '请先修正配置 JSON，再选择后端。'; }
    });
    tableCell(row, '执行后端', picker, note(configured ? `已保存：${roleRefText(role.harness_ref)}` : `还没保存，保存后为 ${executor.ref}`), ...(executor.legacy ? [badge('旧配置沿用', 'warning')] : executor.pending ? [badge('保存后生效')] : []));
    if (data.configured && role.role_id === 'dev' && role.entry_harness_source !== 'role' && role.harness_ref.id !== 'pi')
      row.lastElementChild.append(note('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更'));
    tableCell(row, '模型（来源）', element('span', roleModelText(model), model?.error ? 'view-error' : ''));
    tableCell(row, '技能包', element('span', role.skill_bundle_ref ? `${role.skill_bundle_ref.id}@${role.skill_bundle_ref.revision} · ${role.skill_bundle_ref.content_hash.slice(0, 12)}` : '—'));
    tableCell(row, '能力策略', element('span', `${role.capability_policy_ref.id}@${role.capability_policy_ref.version}`));
    tableCell(row, 'revision', element('span', String(role.revision)));
    body.append(row);
  }
  section.append(note('每个角色都可以选择 Agent 后端，默认推荐 Pi；换后端不改变它的工具和权限。在这里改选会同步到下方的配置，保存后才生效。'),
    note(`模型按工作类型 ${data.workflow} 预览：角色自己的模型优先，其次是工作类型的模型，最后是项目默认；ACP 和 Claude Code 用后端自带的模型。`), table);
  return section;
}
function roleEditorCard(data, config, message, { backends, editor, configured }) {
  const section = card('修改配置'), endpoint = `/api/repositories/${current.id}/roles`;
  const save = button('保存为新 revision', async () => {
    message.textContent = '';
    let value; try { value = JSON.parse(editor.value); } catch { message.textContent = '配置不是合法 JSON。'; return; }
    try { const saved = await api(endpoint, 'PUT', { ...value, expected_revision: config.revision }); current.flash = `角色配置已保存为 revision ${saved.configuration.revision}。`; await reloadProject(); }
    catch (err) { message.textContent = err.field ? `${err.message}（字段 ${err.field}）` : err.message; }
  });
  const actions = element('div', '', 'actions'); actions.append(save);
  section.append(note('人设提示词只是资料，改它不会改变工具、权限或任务契约。保存要带当前 revision；正在运行的角色保留启动时的快照。'),
    ...(configured && config.legacy ? [note('这是 V2 以前格式的配置：保存一次就升级为 V2，各角色按上面表格里选择的后端运行，不会自动改成 Pi。')] : []),
    field('配置（JSON）', editor), actions, message,
    note('可引用的模型：' + (data.models.map(m => `${m.id}（${m.name}${m.shared ? '，共享' : ''}）`).join('、') || '无')),
    note('Agent 后端：' + backends.map(h => `${h.name}（${h.available ? h.id + '@' + h.version : '驱动待接入，#' + h.integration_issue}）`).join('；')),
    note('最近的 revision：' + (data.revisions.map(r => `${r.revision}（${r.created_at}）`).join('、') || '无')));
  return section;
}
function notesSection() {
  const id = current.id, endpoint = `/api/repositories/${id}/notes`, section = card('项目笔记'), list = element('div', '', 'project-notes-list'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  section.append(note('旧版文件笔记独立保留，不自动导入项目知识。新的共享知识与角色经验请在「项目知识」管理；正式规则仍通过仓库文档 PR 更新。'),
    list, message);
  const edit = async (name, content) => {
    const filename = input('note_name', name, { required: true, readOnly: !!name, placeholder: 'repository.md' });
    const editor = textarea('note_content', content, { rows: 18, spellcheck: false, className: 'code' });
    const form = settingsForm(name ? `编辑 ${name}` : '新建笔记', [field('文件名', filename), field('笔记内容', editor)], async () => {
      await api(endpoint + '/' + encodeURIComponent(filename.value), 'PUT', { content: editor.value });
    }, { after: async () => { form.remove(); await refresh(); } });
    list.replaceChildren(form); editor.focus();
    form.append(button('取消', () => refresh()));
  };
  const refresh = async () => {
    try {
      message.textContent = ''; const { files } = await api(endpoint);
      const rows = element('ul', '', 'history'), actions = element('div', '', 'actions');
      for (const file of files) {
        const row = element('li', '');
        row.append(element('code', file.name), element('span', bytes(file.bytes), 'muted'), button('查看／编辑', async () => {
          try { await edit(file.name, (await api(endpoint + '/' + encodeURIComponent(file.name))).content); } catch (err) { message.textContent = err.message; }
        }), button('删除', async () => {
          if (!await askConfirm({ title: `删除 ${file.name}？`, body: ['这份长期经验将从项目笔记中删除。'], action: '删除', danger: true })) return;
          try { await api(endpoint + '/' + encodeURIComponent(file.name), 'DELETE', {}); await refresh(); } catch (err) { message.textContent = err.message; }
        }, 'quiet destructive')); rows.append(row);
      }
      actions.append(button('新建笔记', () => edit('', '')));
      list.replaceChildren(files.length ? rows : note('还没有项目笔记。有可复用的经验时再记录，无需创建占位文件。'), actions);
    } catch (err) { message.textContent = err.message; }
  };
  void refresh(); return [section];
}

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
  // A resource left empty follows the global default; own() is the value the project sets (console or repository file).
  const own = name => current.rules?.computer ? current.rules.computer[name] : pc.inherited?.includes(name) ? undefined : pc[name];
  const number = (name, step) => input(name, own(name) ?? '', { type: 'number', step, min: pc.bounds?.[name]?.[0] ?? '', max: pc.bounds?.[name]?.[1] ?? '',
    placeholder: `留空使用全局默认（${pc.defaults?.[name] ?? pc[name]}）` });
  const sourceLink=element('a','查看规则文件来源');sourceLink.href=`#/projects/${current.id}/roles`;
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
  const environment = current.environment; if (!environment) return [note('暂时读不到虚拟电脑状态。')];
  const env = environment.environment, pc = env.computer || {}, machine = card('机器'), lifecycle = element('div', '', 'actions');
  machine.append(facts([['状态', state(env.state)], ['容器', pc.container], ['代次', env.generation ? 'g' + env.generation : '待创建'], ['启动于', timestamp(env.started_at)],
    ['工作卷', pc.volume ? `${pc.volume} → ${pc.workdir}` : null], ['网络', pc.network ? `${pc.network}（${networkText(pc)}）` : null], ['镜像', pc.image ? pc.image.slice(0, 19) : null],
    ['资源', pc.resources_pending ? '全局默认资源已改，等没有任务运行时按新值重建' : null],
    ['运行用户', pc.user], ['根文件系统', pc.root_filesystem === 'read-only' ? '只读；HOME 和工作区在工作卷中持久保存' : pc.root_filesystem], ['故障', environmentFault(env.error)]]));
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
function providerList(models, row, after = reloadWith, { editable = true } = {}) {
  const list = element('div', '', 'provider-list');
  for (const group of byProvider(models)) {
    const section = element('section', '', 'provider-group'), head = element('div', '', 'provider-head'), rows = element('ul', '', 'history');
    head.append(providerTitle(group[0]), element('span', `${group.length} 个模型`, 'muted provider-count'));
    const canEdit = editable && (me.role === 'super_admin' || group[0].repository_id === current?.id);
    if (canEdit) head.append(button('编辑供应商',()=>providerEditor(group,group[0].repository_id,after)));
    for (const model of group) rows.append(row(model));
    section.append(head, rows); list.append(section);
  }
  return list;
}
// Adding and editing use one provider form. URL/key changes and newly selected models commit together.
function providerEditor(group, repositoryId, after) {
  const editing=!!group.length, source=group.find(model=>model.key_configured)||group[0], existing=new Set(group.map(model=>model.model_name)), selected=new Set();
  const modal=document.createElement('dialog'),form=document.createElement('form'),head=element('div','','heading'),title=element('h2',editing?'编辑供应商':'新增供应商');
  modal.id='provider-edit';title.id='provider-edit-title';modal.setAttribute('aria-labelledby',title.id);head.append(title);
  const fields=document.createElement('fieldset');fields.className='provider-fields';
  const url=input('api_url',source?.api_url||'',{type:'url',required:true,placeholder:'填写供应商接口地址'}),key=input('api_key','',{type:'password',autocomplete:'new-password',required:!editing,placeholder:editing?'留空保持已保存的 Key':'填写 API Key'});
  const preview=element('div','','endpoint-preview'),endpointDetail=element('details','','fold'),result=probeResult(),choices=element('div','','model-chips'),picked=element('div','','model-chips provider-selected'),filter=input('filter','',{type:'search',placeholder:'筛选上游模型'}),manual=input('model_name','',{maxLength:200,placeholder:'例如模型列表中没有列出的名称'});
  filter.setAttribute('aria-label','筛选上游模型');filter.hidden=true;manual.setAttribute('aria-label','手动模型名');
  endpointDetail.append(element('summary','查看实际请求地址'),preview);if(source?.endpoints)preview.append(...endpointFacts(source.endpoints));
  const message=element('p','','view-error'),selectedLabel=element('p','待添加','muted');message.setAttribute('role','alert');selectedLabel.hidden=true;let request=0,available=[];
  const draw=()=>{
    selectedLabel.hidden=!selected.size;
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
  const actions=element('div','','actions provider-editor-actions'),save=element('button','保存'),cancel=button('取消',()=>modal.close());save.type='submit';
  const snapshot=()=>group.map(model=>({id:model.id,version:model.version}));
  if(editing&&group.some(model=>model.key_configured))actions.append(button('撤销供应商 Key',async()=>{
    const revoked=await confirmDialog({title:'撤销此供应商的 API Key？',body:[`撤销这 ${group.length} 个模型的 Key，使用它们的任务将等待配置。`,'未保存的 URL 和待添加模型不会保存。'],action:'撤销',danger:true,
      run:()=>api(`/api/models/${source.id}/provider`,'PATCH',{versions:snapshot(),revoke_key:true})});
    if(revoked){modal.close();await after('已撤销供应商下全部模型的 Key');}
  },'quiet destructive'));
  actions.append(cancel,save);form.append(head,fields,message,actions);modal.append(form);document.body.append(modal);
  form.addEventListener('submit',async event=>{
    event.preventDefault();message.textContent='';const address=url.value.trim(),name=manual.value.trim();if(name&&!existing.has(name))selected.add(name);
    if(!address||!editing&&!key.value.trim()){message.textContent='请填写接口 URL 和 API Key';return;}
    if(!editing&&!selected.size){message.textContent='请先选择或手动添加至少一个模型';return;}
    const changes={};if(editing){if(address!==source.api_url)changes.api_url=address;if(key.value.trim())changes.api_key=key.value;if(selected.size)changes.model_names=[...selected];}
    if(editing&&!Object.keys(changes).length){modal.close();return;}
    fields.disabled=true;for(const control of actions.querySelectorAll('button'))control.disabled=true;
    try{
      await api(editing?`/api/models/${source.id}/provider`:'/api/models/provider',editing?'PATCH':'POST',editing?{versions:snapshot(),...changes}:{repository_id:repositoryId,api_url:address,api_key:key.value,model_names:[...selected]});
      modal.close();await after(editing?'已保存供应商配置'+(selected.size?'，已添加 '+[...selected].join('、'):''):'已新增供应商，已添加 '+[...selected].join('、'));
    }catch(err){const code=err.message.replace(/^\d+\s*·\s*/,'');message.textContent=({version_conflict:'供应商已被其他页面修改，请关闭后重新打开再保存。',provider_already_exists:'该地址已有供应商，请在对应供应商中编辑。',model_key_missing:'请填写 API Key 后添加模型。',model_already_exists:'要添加的模型已经存在，请重新打开供应商。'})[code]||err.message;}
    finally{fields.disabled=false;for(const control of actions.querySelectorAll('button'))control.disabled=false;}
  });
  modal.addEventListener('close',()=>{request++;key.value='';modal.remove();},{once:true});modal.showModal();
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
    ? '配置错误：此仓库使用的 App 安装未订阅 workflow_run。本功能已停止写入，请 App 管理员添加事件订阅。'
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
  const section = card('项目管理员'), list = element('ul', '', 'history'), add = element('div', '', 'actions member-add');
  section.append(note('项目管理员可以管理这个项目的检视、开发、模型和虚拟电脑启停，看到它的任务、日志和投递；不能修改机器配置或其他项目。'), list, add);
  (async () => {
    const [{ users }, { assignments, organization_assignments: organizations, organizations: installed }] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    const assigned = user => assignments.filter(a => a.user_id === user.id).map(a => a.repository_id);
    // Only the single-repository grant is changed here; a whole-organization grant is edited on the users page.
    const wholeOrganization = user => organizations.some(o => o.user_id === user.id && o.owner_id === current.repository.owner_id);
    // A grant whose repository is neither installed nor a project any more would be refused, so saving here drops it.
    const grantable = new Set([...installed.flatMap(o => o.repositories.map(r => r.id)), ...repositories.map(r => r.id)]);
    const update = async (user, ids) => { await api('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: ids.filter(id => grantable.has(id)) }).catch(error); await reloadProject(); };
    for (const user of users.filter(u => u.role === 'project_admin' && (assigned(u).includes(current.id) || wholeOrganization(u)))) {
      const li = element('li', ''); li.append(element('span', user.username + (user.active ? '' : '（已停用）')));
      if (wholeOrganization(user)) li.append(element('span', '整个组织授权，在「用户」页修改', 'muted'));
      if (assigned(user).includes(current.id)) li.append(button('移除', () => update(user, assigned(user).filter(id => id !== current.id))));
      list.append(li);
    }
    if (!list.childElementCount) list.append(element('li', '还没有项目管理员，超级管理员可以管理全部项目。', 'muted'));
    const candidates = users.filter(u => u.role === 'project_admin' && u.active && !assigned(u).includes(current.id) && !wholeOrganization(u)), select = document.createElement('select');
    select.add(new Option(candidates.length ? '选择项目管理员' : '没有可添加的项目管理员（在“用户”页创建）', '')); candidates.forEach(u => select.add(new Option(u.username, u.id)));
    add.append(select, button('添加', () => { const user = candidates.find(u => u.id === select.value); if (user) update(user, [...assigned(user), current.id]); }));
  })().catch(err => list.replaceChildren(element('li', err.message, 'view-error')));
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
      else { current.focusRule = path; renderProject({ id: current.id, section: current.section }); } }
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

function knowledgeSection() {
  const id = current.id, endpoint = `/api/repositories/${id}/memories`, section = card('项目知识'), list = element('div', ''), detail = element('div', ''), message = element('p', '', 'view-error');
  const query = input('knowledge_query', '', { placeholder: '标题、错误信息或别名' }), path = input('knowledge_path', '', { placeholder: '目录或文件路径' }), module = input('knowledge_module', '', { placeholder: '适用模块' });
  const choose = (name, rows, value = rows[0]?.[0] ?? '') => { const el = document.createElement('select'); el.name = name; for (const [v, label] of rows) el.add(new Option(label, v)); el.value = value; return el; };
  const status = choose('knowledge_status', [['', '当前条目'], ...['active', 'needs_review', 'conflict', 'archived', 'revoked'].map(v => [v, v])]);
  const categories = [['', '全部类别'], ['goal', '目标'], ['decision', '架构决策'], ['convention', '开发约定'], ['operations', '测试运维'], ['experience', '故障经验'], ['hypothesis', '待验证假设']];
  const category = choose('knowledge_category', categories), filters = element('div', '', 'actions'); let cursor = null;
  message.setAttribute('role', 'alert');
  const run = fn => async () => { try { message.textContent = ''; await fn(); } catch (err) { message.textContent = err.message; } };
  const show = async (memoryId, revision) => {
    const { memory: m } = await api(endpoint + '/' + encodeURIComponent(memoryId) + (revision ? '?revision=' + revision : ''));
    const { versions } = await api(endpoint + '/' + encodeURIComponent(memoryId) + '/versions');
    const box = card(m.catalog.title), version = choose('knowledge_revision', versions.map(v => [String(v.revision), `版本 ${v.revision} · ${v.actor} · ${v.reason}`]), String(m.revision));
    version.setAttribute('aria-label', '查看历史版本');
    version.addEventListener('change', run(() => show(memoryId, version.value)));
    box.append(field('查看历史版本', version), note(`状态 ${m.status}（当前 ${m.current_status}） · ${m.verification} · ${m.authority}${m.review_overdue ? ' · 已到复核时间' : ''}`),
      note(`范围 ${m.catalog.audience} · 路径 ${m.catalog.path || '—'} · 模块 ${m.catalog.module || '—'} · 负责人 ${m.catalog.owner || '—'}`),
      note(`上次复核 ${m.catalog.reviewed_at || '—'} · 下次复核 ${m.catalog.review_due_at || '—'}`),
      element('pre', m.body ?? (m.availability ? `来源状态：${m.availability}。请核对仓库原文。` : '正文位于已合入的仓库文档。')),
      element('pre', JSON.stringify({ sources: m.sources, scope: m.scope, document: m.document, candidate: m.candidate, review: m.review, supersedes: m.supersedes, superseded_by: m.superseded_by }, null, 2)));
    if (!m.historical) {
      const actions = element('div', '', 'actions');
      actions.append(button('编辑条目', run(() => edit(m))), button('复核／改变状态', run(() => review(m))), button('关联文档 PR', run(() => documentPR(m)))); box.append(actions);
    }
    detail.replaceChildren(box);
  };
  const refresh = async (after = '') => {
    const params = new URLSearchParams({ query: query.value, path: path.value, module: module.value, status: status.value, category: category.value, after, limit: '20', include_superseded: '1' });
    const data = await api(endpoint + '?' + params); cursor = data.next_after;
    const rows = element('ul', '', 'history knowledge-list');
    for (const m of data.items) {
      const row = element('li', ''); row.append(button(m.catalog.title, run(() => show(m.id, m.revision))),
        note(`${m.kind} · ${m.status} · ${m.verification} · 版本 ${m.revision}${m.review_overdue ? ' · 待复核' : ''}`), note(m.catalog.path || m.catalog.module || m.catalog.audience), note(m.preview || '查看原文并检查来源'));
      rows.append(row);
    }
    list.replaceChildren(data.items.length ? rows : note('没有匹配的知识条目。搜索预览不代表已读正文。'));
    if (cursor) list.append(button('下一页', run(() => refresh(cursor))));
  };
  const changed = async memoryId => { await refresh(); await show(memoryId); };
  const edit = m => {
    const c = m?.catalog || {}, key = input('knowledge_key', m?.key, { readOnly: !!m, required: true }), title = input('knowledge_title', c.title || ''), body = textarea('knowledge_body', m?.body || '', { rows: 8, readOnly: m?.authority === 'repository' });
    const kind = choose('knowledge_kind', ['goal', 'decision', 'implementation', 'experience', 'hypothesis'].map(v => [v, v]), m?.kind || 'experience');
    const controls = Object.fromEntries(['path', 'module', 'owner', 'audience', 'category', 'review_due_at'].map(k => [k, input('knowledge_' + k, c[k] || (k === 'audience' ? 'project' : ''))]));
    const tags = input('knowledge_tags', (c.tags || []).join(', ')), aliases = input('knowledge_aliases', (c.aliases || []).join(', ')), sources = textarea('knowledge_sources', JSON.stringify(m?.sources || [{ reference: '' }], null, 2), { rows: 5 }), reason = input('knowledge_reason', '', { required: true });
    const labels = { path: '目录／文件路径', module: '适用模块', owner: '负责人', audience: '可见范围（project 或 role:dev 等）', category: '类别（goal／decision／convention／operations／experience）', review_due_at: '下次复核时间（ISO 日期，可留空）' };
    const form = settingsForm(m ? `编辑：${c.title}` : '新建知识', [note(m ? `当前版本 ${m.revision}；保存后保留原文及修改历史。` : '来源必须具体；私人聊天和凭据不得自动导入。'), field('条目标识', key), field('标题', title), field('知识类型', kind), field('正文', body), ...Object.entries(controls).map(([k, el]) => field(labels[k], el)), field('标签（逗号分隔）', tags), field('别名（逗号分隔）', aliases), field('来源与环境（JSON 列表）', sources), field('修改原因', reason)], async () => {
      const catalog = { title: title.value || key.value, tags: tags.value.split(',').map(v => v.trim()).filter(Boolean), aliases: aliases.value.split(',').map(v => v.trim()).filter(Boolean), ...Object.fromEntries(Object.entries(controls).map(([k, el]) => [k, el.value || null])) };
      const result = await api(endpoint + (m ? '/' + encodeURIComponent(m.id) : ''), m ? 'PATCH' : 'POST', { key: key.value, expected_revision: m?.revision || 0, ...(m?.authority === 'repository' ? {} : { body: body.value }), kind: kind.value, catalog, sources: JSON.parse(sources.value), reason: reason.value });
      await changed(result.memory.id);
    }, { after: () => {} }); detail.replaceChildren(form);
  };
  const review = m => {
    const action = choose('knowledge_review_action', [['accept', '接受并记录已观察证据'], ['conflict', '标记冲突'], ['archive', '归档'], ['reject', '拒绝候选'], ['revoke', '撤销'], ['restore', '恢复为待复核'], ['merge', '合并重复条目']]);
    const evidence = textarea('knowledge_review_evidence', '', { rows: 4 }), reason = input('knowledge_review_reason', '', { required: true }), replacements = input('knowledge_supersedes', '');
    const form = settingsForm(`复核：${m.catalog.title}`, [note(`当前版本 ${m.revision}，状态 ${m.status}，验证级别 ${m.verification}。复核不会晋升为仓库规则；证据和历史会保留。`), field('复核操作', action), field('证据引用（每行一条检查结果、运行产物或来源）', evidence), field('原因', reason), field('被合并条目 ID（逗号分隔，仅合并时填写）', replacements)], async () => {
      const result = await api(endpoint + '/' + encodeURIComponent(m.id) + '/review', 'POST', { expected_revision: m.revision, action: action.value, evidence: evidence.value.split('\n').map(v => v.trim()).filter(Boolean), reason: reason.value, ...(action.value === 'merge' ? { supersedes: replacements.value.split(',').map(v => v.trim()).filter(Boolean) } : {}) }); await changed(result.memory.id);
    }, { after: () => {} }); detail.replaceChildren(form);
  };
  const documentPR = m => {
    const pr = input('knowledge_document_pr', m.candidate?.pr_number || m.document?.pr_number || '', { type: 'number', min: 1, required: true }), file = input('knowledge_document_path', m.catalog.path || '', { required: true });
    const form = settingsForm('核验文档 PR', [note(`当前版本 ${m.revision}。只有同仓库真实默认分支合入、提交和文件内容校验通过，正文权威才迁到仓库文件；其他 PR 继续作为候选。`), field('PR 编号', pr), field('文件路径', file)], async () => {
      const result = await api(endpoint + '/' + encodeURIComponent(m.id) + '/document', 'POST', { expected_revision: m.revision, pr_number: Number(pr.value), path: file.value }); await changed(result.memory.id);
    }, { after: () => {} }); detail.replaceChildren(form);
  };
  filters.append(field('搜索', query), field('路径', path), field('模块', module), field('状态', status), field('类别', category), button('搜索知识', run(() => refresh())), button('新建知识', run(() => edit(null))), button('导出当前视图', run(async () => {
    const data = await api(endpoint + '?export=1&' + new URLSearchParams({query:query.value,path:path.value,module:module.value,status:status.value,category:category.value})), a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.href = url; a.download = 'project-knowledge.json'; a.click(); URL.revokeObjectURL(url);
  })));
  section.append(note('共享已复核知识与角色私人经验按权限展示。预览不是已读证明；使用前打开精确版本，检查验证级别、来源和代码基线。知识保存在项目数据库，清理执行工作区不会删除知识。'), filters, message, list, detail);
  void run(() => refresh())(); return [section];
}
