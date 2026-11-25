function roleBundleIds(role) {
  if (Array.isArray(role.skill_bundle_refs) && role.skill_bundle_refs.length) {
    return role.skill_bundle_refs.map(ref => ref.id).filter(Boolean);
  }
  return role.skill_bundle_ref?.id ? [role.skill_bundle_ref.id] : [];
}
function setRoleBundleIds(role, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  role.skill_bundle_refs = unique.map(id => ({ id }));
  role.skill_bundle_ref = unique.length ? { id: unique[0] } : null;
}
function skillLibraryMap(state) {
  return new Map((state.skillLibrary?.skills || []).map(skill => [skill.id, skill]));
}
function skillIdToSlug(skillId, byId) {
  const found = byId.get(skillId);
  if (found?.slug) return found.slug;
  const parts = String(skillId || '').split(':');
  return parts[parts.length - 1] || String(skillId || '');
}
function bundleDisplayName(bundle, state) {
  if (bundle.name) return `${bundle.name}（${bundle.id}）`;
  const bi = (state.data.builtin_bundles || []).find(entry => entry.id === bundle.id);
  return bi ? `${bi.name}（${bundle.id}）` : bundle.id;
}
const bundleOriginBadges = {
  builtin: ['内置', 'info'],
  builtin_modified: ['内置·已修改', 'warning'],
  project: ['项目', ''],
};
function roleEffectiveSkillsPreview(role, state) {
  const box = element('section', '', 'role-effective-skills');
  box.dataset.testid = 'role-effective-skills';
  box.setAttribute('aria-label', '角色生效技能预览');
  box.append(element('h5', '当前草稿生效技能预览'));
  const byId = skillLibraryMap(state);
  const boundIds = roleBundleIds(role);
  const bySlug = new Map();
  const entries = [];
  const conflicts = [];

  for (const bid of boundIds) {
    const bundle = state.draft.skills.find(entry => entry.id === bid);
    if (!bundle) continue;
    if (bundle.source?.type === 'library') {
      for (const item of bundle.source.items || []) {
        const meta = byId.get(item.skill_id);
        const slug = skillIdToSlug(item.skill_id, byId);
        const prior = bySlug.get(slug);
        if (prior && (prior.skill_id !== item.skill_id || prior.version !== item.version)) {
          conflicts.push({ slug, a: prior, b: { bundleId: bid, skill_id: item.skill_id, version: item.version } });
        } else if (!prior) {
          bySlug.set(slug, { bundleId: bid, skill_id: item.skill_id, version: item.version });
        }
        entries.push({
          title: meta?.name || slug,
          slug,
          origin: meta?.origin || (String(item.skill_id).startsWith('builtin:') ? 'builtin' : 'console'),
          detail: `v${item.version} · 来自技能包 ${bid}`,
        });
      }
    } else if (bundle.source?.type === 'repository') {
      const count = (bundle.source.paths || []).length;
      entries.push({ title: bid, slug: bid, origin: 'repository', detail: `固定仓库提交 ${String(bundle.source.commit || '').slice(0, 8)}（${count} 文件）` });
    } else {
      const count = (bundle.source?.files || []).length;
      entries.push({ title: bid, slug: bid, origin: 'console', detail: `控制台自定义文件（${count} 文件）` });
    }
  }

  if (conflicts.length) {
    for (const c of conflicts) {
      const alert = element('p', `检测到同名 Skill 版本冲突：${c.slug} 同时被技能包「${c.a.bundleId}」（${c.a.skill_id}@v${c.a.version}）和「${c.b.bundleId}」（${c.b.skill_id}@v${c.b.version}）引用。保存时服务端将拒绝，请统一版本或取消其中一个技能包。`, 'view-error');
      alert.setAttribute('role', 'alert');
      box.append(alert);
    }
  }

  if (entries.length) {
    const ul = element('ul', '', 'role-effective-skill-list');
    for (const item of entries) {
      const li = element('li', '');
      const label = skillOriginLabels[item.origin] || item.origin;
      const tone = skillOriginTones[item.origin] || '';
      li.append(element('strong', item.title), ' ', badge(label, tone), ' ', element('span', item.detail, 'muted'));
      ul.append(li);
    }
    box.append(ul);
  } else {
    box.append(note('当前未绑定任何显式技能包。'));
  }

  if (role.role_id === 'qa') {
    box.append(note('独立 QA 保持干净上下文，不自动叠加仓库 .agents/skills/，仅加载上方显式绑定的技能包。'));
  } else {
    const repoPaths = (state.data.skill_sources?.repository?.paths || []).filter(p => p.endsWith('/SKILL.md'));
    if (repoPaths.length) {
      const dirs = repoPaths.map(p => p.replace(/\/SKILL\.md$/, '')).join('、');
      box.append(note(`运行时还将自动叠加可信基准分支的仓库 Skill（${dirs}）；同名 Skill 以显式绑定的项目技能包优先。`));
    } else {
      box.append(note('运行时会自动叠加可信基准分支的 .agents/skills/（如有）；未合入外部 PR 检出不会自动加载仓库 Skill。'));
    }
  }
  return box;
}
function roleSkillBundlePicker(role, state, redraw) {
  const wrap = element('div', '', 'role-skill-picker-wrap');
  const group = element('fieldset', '', 'role-choices role-skill-bundles');
  group.dataset.testid = 'role-skill-bundles';
  group.append(element('legend', role.role_id + ' 技能包'));
  const selected = new Set(roleBundleIds(role));
  if (!state.draft.skills.length) {
    group.append(note('当前项目还没有技能包，请前往「技能包目录」创建或恢复内置默认。'));
  }
  for (const bundle of state.draft.skills) {
    const labelText = bundleDisplayName(bundle, state);
    const check = checkbox('role_skill_bundle:' + role.role_id + ':' + bundle.id, selected.has(bundle.id), labelText);
    const ctrl = check.querySelector('input');
    ctrl.dataset.bundleId = bundle.id;
    roleBound(ctrl, checked => {
      const next = new Set(roleBundleIds(role));
      if (checked) next.add(bundle.id);
      else next.delete(bundle.id);
      setRoleBundleIds(role, [...next]);
      redraw();
    }, state);
    group.append(check);
  }
  const links = element('div', '', 'actions');
  links.append(
    consoleLink(`#/projects/${current.id}/roles?view=skills`, '管理技能包目录', '查看或编辑技能包及内置版本升级'),
    consoleLink(`#/projects/${current.id}/roles?view=library`, '打开技能库', '浏览内置 Skill、导入仓库 Skill 或新建控制台 Skill'),
  );
  wrap.append(group, roleEffectiveSkillsPreview(role, state), links);
  return wrap;
}
function roleModelResolution(role, state, access) {
  const region = element('section', '', 'role-model-resolution'); region.setAttribute('aria-label', '检查已保存模型');
  const repositoryId = current.id, saved = state.data.configuration.roles.find(entry => entry.role_id === role.role_id);
  region.append(element('h5', '检查已保存模型'), note('只读取已保存角色定义与项目默认模型，未保存的选择不参与解析；不会启动任务或修改运行历史。具体任务使用的配置仍以任务详情中的运行快照为准。'));
  if (role.role_id === 'dev' && state.data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') region.append(note('尚未显式变更开发角色的后端时，检视与 Actions 开发入口仍使用 Pi；这里读取的是角色定义本身。'));
  const result = element('div'), status = note('尚未读取已保存的模型解析，当前结果未知。'); status.setAttribute('role', 'status');
  let request = 0;
  const version = state.data.configuration.revision, live = () => access.live() && region.isConnected && state.data.configuration.revision === version;
  const read = button('读取已保存模型解析', async () => {
    const sequence = ++request; read.disabled = true; result.replaceChildren(); status.textContent = '正在读取已保存配置的解析…';
    try {
      const value = await api(`/api/repositories/${repositoryId}/roles/resolve`, 'POST', { role: role.role_id, expected_revision: version });
      if (!live() || sequence !== request) return;
      const snapshot = value.snapshot, model = snapshot.model, external = model.source === 'external_harness', localConfig = model.source === 'local_config';
      const factsList = element('dl');
      for (const [caption, text] of [['配置版本', snapshot.config_revision], ['角色版本', snapshot.role_revision],
        ['Agent 后端', `${harnessName(snapshot.harness.id)} · ${snapshot.harness.version}`],
        ['模型来源', external ? '执行器自带模型' : localConfig ? '项目电脑内自行配置（不注入模型配置）' : own(modelSources, model.source) || model.source],
        ['模型名称', external ? '由执行器管理，不使用项目模型' : localConfig ? '由项目电脑内的配置决定' : model.name],
        ['模型标识', external || localConfig ? '不适用' : model.id],
        ['模型记录版本', external || localConfig ? '不适用' : model.version]]) {
        factsList.append(element('dt', caption), element('dd', String(text)));
      }
      result.append(factsList, note('解析标识：' + value.snapshot_id)); status.textContent = '已读取已保存配置；没有保存草稿或启动任务。';
    } catch (err) {
      if (!live() || sequence !== request) return;
      if ([401, 403].includes(err.status)) { access.failed(err); return; }
      const reasons = { role_configuration_changed: '配置版本已变化，请读取最新角色配置并比较草稿后再检查。', role_disabled: '此角色已停用。',
        role_model_not_available: '显式选择的角色模型已删除、撤销或不可访问，不会换用其他模型。', role_model_profile_changed: '角色模型的地址或名称已变化，需要重新保存角色配置。',
        model_unavailable: '继承的模型当前不可用，不会换用其他模型。', model_not_configured: '项目尚未配置可用的默认模型，且此角色未单独指定模型。',
        subscription_mode_not_implemented: '仅 Claude Code 与 Codex 支持项目电脑内自行配置模式。',
        claude_local_config_missing: '项目电脑 /workspace/home 下未找到 Claude Code 配置文件，请先在机器配置中写入。',
        codex_local_config_missing: '项目电脑 /workspace/home 下未找到 Codex 配置文件，请先在机器配置中写入。',
        harness_model_api_unsupported: '当前执行后端不支持该模型的接口协议（统一透传网关不做跨协议转换），请更换兼容协议的模型或切换执行后端。',
        harness_model_profile_unsupported: '此执行器使用自带模型，不能指定项目模型。', harness_role_unsupported: '执行器不支持此角色类型。' };
      status.textContent = `解析失败，当前结果未知：${reasons[err.code] || readErrorText(err)}${err.field ? '（配置项：' + err.field + '）' : ''}`;
    } finally { if (live() && sequence === request) read.disabled = false; }
  });
  region.append(read, status, result); return region;
}
function roleSettingsCard(role, state, redraw, access) {
  const section = card(roleConfigName(role) + rolePageText('formSuffix'));
  section.dataset.testid = 'role-form';
  const enable = roleCheck(rolePageText('enable'), role, 'enabled', state, requiredRoleLocked(role), { reason: requiredEnableReason(role) });
  const title = section.querySelector('h3');
  const head = element('div', '', 'role-form-head');
  title.replaceWith(head);
  head.append(title, enable);
  const group = (key, title, parent = section) => {
    const box = element('section', '', 'role-editor-group'), heading = element('h4', title); box.id = `role-${role.role_id}-${key}`; heading.tabIndex = -1;
    box.append(heading); parent.append(box); return box;
  };
  const basic = group('basic', rolePageText('basic'));
  basic.append(roleText(rolePageText('displayName'), role, 'name', state, { maxLength: 80 }),
    roleText(rolePageText('duty'), role, 'responsibility', state, { multiline: true, rows: 3, maxLength: 2000 }));
  const agent = group('agent', rolePageText('agent'));
  const backendInfo = (state.data.backends || []).find(entry => entry.id === role.harness_ref.id);
  const runtimeBox = roleBackendRuntimeBox(role, state), fixedBackend = roleFixedBackend(role, state);
  agent.append(
    // What runs now: the saved configuration, or the defaults a project without one follows (#1068).
    note((state.data.configured === false ? rolePageText('statusDefault') : '已保存') + ' · 模型：' + roleModelText(state.data.preview.find(row => row.role === role.role_id))),
    note('下面是待保存的选择；修改不会重写运行中任务的模型快照。'),
    fixedBackend ? note(`Agent 后端：${fixedBackend.name}（这个角色固定使用 ${fixedBackend.name}，不能切换）`) : field('Agent 后端', roleBackendPicker(role, state, redraw)),
    ...(runtimeBox ? [runtimeBox] : []),
  );
  if (backendInfo?.supported_model_sources?.some(isRoleLocalConfigSource)) {
    agent.append(field('模型来源', roleModelSourcePicker(role, state, redraw)));
    if (isRoleLocalConfigSource(role.harness_ref?.model_source)) {
      const localCfg = backendInfo.runtime_status?.subscription;
      const filesText = (localCfg?.config_files || []).join('、');
      const cfgNotice = element('div', '', 'role-local-config-notice');
      cfgNotice.dataset.testid = 'local-config-notice';
      cfgNotice.append(
        note(`模型由项目电脑内的配置决定：平台不会注入模型地址、API Key、--model 或 config.toml。每次运行前仅把 ${filesText || '/workspace/home 下的配置文件'} 复制到当前会话隔离目录，运行结束后清除副本。`),
        note(localCfg?.notice || '这些凭据存放在项目电脑的 /workspace/home 中，同一项目内任意 Agent 的原生 Shell 都可以读取。控制面不读取、不保存文件内容。'),
      );
      if (typeof current === 'object' && current?.id) {
        cfgNotice.append(consoleLink(`#/projects/${current.id}/machine`, '前往机器配置写入 CLI 配置文件', '在项目电脑 /workspace/home 中写入或删除配置文件'));
      }
      agent.append(cfgNotice);
    }
  }
  agent.append(field('模型', roleModelPicker(role, state, redraw)));
  const saved = state.data.configuration.roles.find(entry => entry.role_id === role.role_id);
  if (role.role_id === 'dev' && state.data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') {
    agent.append(note('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更'));
  }
  const profile = role.model_profile_ref, backend = state.data.harnesses.find(entry => entry.id === role.harness_ref.id);
  const advanced = element('details', '', 'fold role-form-advanced');
  advanced.dataset.testid = 'role-form-advanced';
  advanced.open = !!state.roleFormAdvancedOpen;
  advanced.addEventListener('toggle', () => { state.roleFormAdvancedOpen = advanced.open; });
  advanced.append(element('summary', rolePageText('advanced')));
  const idLine = note(rolePageText('roleId') + '：' + role.role_id); idLine.dataset.testid = 'role-id'; advanced.append(idLine);
  if (profile) {
    const modelExtra = group('model-extra', '模型细节', advanced);
    modelExtra.append(field('模型 API', roleSelect('模型 API', profile.api, (backend?.model_api || []).map(id => [id, id]), value => { profile.api = value; markRoleDirty(state); })),
      roleCheck('模型支持工具调用', profile, 'tool_calls', state),
      // Every backend answers through tool calls since text_json went with the Process driver (#1338): a choice is shown
      // only when the backend offers more than one way.
      ...((backend?.structured_output || []).length > 1 ? [field('结构化输出方式', roleSelect('结构化输出方式', profile.structured_output, backend.structured_output.map(id => [id, id]), value => { profile.structured_output = value; markRoleDirty(state); }))] : []),
      roleModelResolution(role, state, access));
  } else {
    group('model-extra', '模型细节', advanced).append(roleModelResolution(role, state, access));
  }
  const prompts = group('prompts', rolePageText('prompts'));
  const system = textarea('system_prompt', state.data.system_prompt, { rows: 6, readOnly: true }); system.setAttribute('aria-label', '系统提示词'); system.readOnly = true;
  prompts.append(field('系统提示词', system), note(rolePageText('systemNote')));
  // #1123: the role prompt opens in its reading view; the view a person picked stays while they are on this project,
  // through redraws, a discarded draft and a re-read configuration.
  const personaField = roleText('角色提示词', role, 'persona_prompt', state, { multiline: true, rows: 18, maxLength: 32000 }), promptModes = current.rolePromptModes ??= {};
  const persona = promptReader(personaField, personaField.querySelector('textarea'), { label: '角色提示词', mode: promptModes[role.role_id] || 'read',
    onMode: mode => { promptModes[role.role_id] = mode; },
    assistant: typeof openManagementRequest === 'function' ? async () => {
      if (state.dirty && !await askConfirm({ title: '先离开未保存的角色配置？', body: ['管理助手读取的是已保存的角色配置，这里未保存的修改不会带过去。'], action: '打开管理助手' })) return;
      await openManagementRequest(current.id, `我想调整角色「${roleConfigName(role)}」（${role.role_id}）提示词里的工作流程。请先读取这个角色当前的提示词，用 Mermaid 流程图画出现在的流程；我说明要改的地方后，再画出修改后的流程图并列出变更要点，等我确认后再保存。要调整的是：`);
    } : null });
  prompts.append(persona, note(rolePageText('promptNote')), button('恢复角色模板', async () => {
    if (!await askConfirm({ title: '恢复角色模板？', body: ['当前角色提示词将替换为默认模板，保存后生效。'], action: '恢复模板' })) return;
    role.persona_prompt = (Object.hasOwn(state.data.role_templates, role.role_id) ? state.data.role_templates[role.role_id] : state.data.role_templates.observer); markRoleDirty(state); redraw();
  }));
  group('skills', '技能包', advanced).append(roleSkillBundlePicker(role, state, redraw));
  group('permissions', '权限', advanced).append(rolePermissionEditor(role, state));
  const runtime = group('runtime', '环境与输出', advanced);
  const environment = state.data.environment_profiles.filter(entry => entry.kinds.includes(role.kind));
  runtime.append(field('运行环境', roleSelect('运行环境', role.environment_profile_ref.id, environment.map(entry => [entry.id, environmentLabels[entry.id] || entry.id, entry.isolation === 'run_container' && backend?.capabilities?.isolation !== 'run_environment']), id => { role.environment_profile_ref = { id }; markRoleDirty(state); })));
  runtime.append(field('输出结果', roleSelect('输出结果', role.output_schema_ref.id, state.data.output_schemas.filter(entry => entry.kinds.includes(role.kind)).map(entry => [entry.id, outputLabels[entry.id] || entry.id]), id => { role.output_schema_ref = { id }; markRoleDirty(state); })));
  const budget = group('budget', '预算', advanced);
  budget.append(field('预算方式', roleSelect('预算方式', role.budget_policy_ref.id, [['entry-default', '沿用任务限制'], ['bounded', '限制单次运行'], ['metered', '限制任务累计用量']], id => {
    const old = role.budget_policy_ref; role.budget_policy_ref = id === 'entry-default' ? { id } : { id, max_turns: old.max_turns || 32, max_output_tokens: old.max_output_tokens || 4096 }; markRoleDirty(state); redraw();
  })));
  budget.append(note('未配置的轮次沿用运行入口缺省值：通用任务 16 轮、角色对话 24 轮（摘要 4 轮）、任务管理 32 轮、开发 64 轮、独立 QA 32 轮、协调 12 轮；恢复与收尾入口另有 8／12／24 轮缺省值。单次输出通常为 8192 token，开发和部分 DeepSeek 入口为 16384 token。显式配置的轮次和输出上限优先于这些缺省值；累计模型请求数单独计算。'));
  if (role.budget_policy_ref.id !== 'entry-default') {
    for (const [key, title, min, max] of budgetFields.slice(0, role.budget_policy_ref.id === 'bounded' ? 2 : undefined)) {
      const control = input(key, role.budget_policy_ref[key] ?? '', { type: 'number', min, max, step: 1 });
      budget.append(field(title, roleBound(control, value => { if (value === '') delete role.budget_policy_ref[key]; else role.budget_policy_ref[key] = Number(value); }, state)));
    }
  }
  if (!(state.data.required_roles || ['manager', 'qa']).includes(role.role_id)) group('danger', '删除角色', advanced).append(button('删除这个角色', async () => {
    if (!await askConfirm({ title: '删除角色 ' + roleConfigName(role) + '？', body: ['保存后该角色不再参与新任务，正在运行的角色也会停止使用工具。'], action: '删除角色' })) return;
    state.draft.roles = state.draft.roles.filter(entry => entry !== role);
    if (state.data.configuration.roles.some(entry => entry.role_id === role.role_id)) state.draft.deleted_roles = [...new Set([...(state.draft.deleted_roles || []), role.role_id])]; markRoleDirty(state); current.item = null; history.replaceState(null, '', `#/projects/${current.id}/roles`); redraw(); }, 'quiet destructive'));
  section.append(advanced);
  return section;
}
const skillSourceNames = { repository: '固定仓库提交', inline: '控制台文件', library: '技能库' };
function roleSkillFacts(bundle, state) {
  const saved = state.data.configuration.skills.find(entry => entry.id === bundle.id), box = element('section', '', 'skill-saved-facts'); box.setAttribute('aria-label', '已保存技能版本');
  const savedBindings = state.data.configuration.roles.filter(role => roleBundleIds(role).includes(bundle.id)).map(roleConfigName);
  const originKind = state.data.bundle_origins?.[bundle.id] || (bundle.origin === 'builtin' ? 'builtin' : 'project');
  const [originLabel] = bundleOriginBadges[originKind] || ['项目', ''];
  box.append(facts([
    ['来源类型', originLabel],
    ['已保存版本', saved ? String(saved.revision) : '此标识尚未保存'],
    ['已保存来源', saved ? skillSourceNames[saved.source.type] || saved.source.type : '尚未保存'],
    ['已保存绑定角色', savedBindings.join('、') || '无'],
    ['内容哈希', saved?.content_hash || '保存后由服务端计算'],
  ]));
  if (saved?.source.origin && typeof saved.source.origin === 'object') box.append(note('已迁移为控制台文件；保留原绑定内容和文件哈希。原指南：' + saved.source.origin.playbooks.join('、') + '；原版本：' + saved.source.origin.revision + '；原内容哈希：' + saved.source.origin.content_hash));
  if (saved?.source.type === 'repository') box.append(note('已固定提交：' + saved.source.commit));
  if (saved?.source.type === 'library' && Array.isArray(saved.source.items)) {
    box.append(note('已固定技能库条目：' + (saved.source.items.map(item => `${item.skill_id}@v${item.version}`).join('、') || '无')));
  }
  const table = projectTable(['文件', '大小', 'SHA-256'], '已保存技能文件');
  for (const file of saved?.files || []) { const row = document.createElement('tr'); tableCell(row, '文件', element('code', file.path)); tableCell(row, '大小', note(String(file.bytes) + ' B')); tableCell(row, 'SHA-256', element('code', file.sha256)); table.body.append(row); }
  if (saved?.files?.length) box.append(table.table); else box.append(note('尚无已保存的文件清单；下面编辑的是草稿。'));
  if (bundle.source.type === 'repository') {
    const cached = state.data.skill_sources?.repository;
    box.append(note(cached ? '当前可选仓库文件来自提交：' + cached.commit : '尚未读取仓库技能缓存；新的仓库来源需要先在「角色 → Manager」刷新默认分支的仓库 skill。'));
    if (cached?.commit !== bundle.source.commit) box.append(note('草稿指定的提交与当前仓库缓存不同。未更改的已固定包可原样保存；更换标识、路径或提交需要先取得对应版本，不会自动更新到分支最新内容。'));
  }
  return box;
}
function bundlePendingUpgrades(bundle, state) {
  const entry = (state.data.bundle_upgrades || []).find(u => u.bundle_id === bundle.id);
  if (!entry || bundle.source?.type !== 'library' || !Array.isArray(bundle.source.items)) return [];
  return (entry.upgrades || []).filter(up => {
    const cur = bundle.source.items.find(item => item.skill_id === up.skill_id);
    return cur && cur.version < up.latest_version;
  });
}
function roleSkillsWorkspace(state, redraw) {
  const section = card('技能包目录'); section.classList.add('skill-workspace'); section.setAttribute('aria-label', '技能包目录');
  const introRow = element('div', '', 'skill-library-head');
  introRow.append(
    note('技能包用于将技能库中的一个或多个固定版本 Skill 组合并绑定给角色（一个角色可同时绑定多个技能包）。技能只是工作材料，不会扩大工具、权限或能力上限。'),
    consoleLink(`#/projects/${current.id}/roles?view=library`, '前往技能库管理 Skill', '浏览、创建或导入 Skill 版本'),
  );
  section.append(introRow);
  const layout = element('div', '', 'skill-catalog-layout'), sidebar = element('div', '', 'skill-catalog-sidebar'), search = input('skill_search', state.skillSearch || '', { placeholder: '按标识或来源搜索' });
  const list = element('nav', '', 'skill-catalog-nav'); list.setAttribute('aria-label', '技能包列表'); search.setAttribute('aria-label', '搜索技能包'); sidebar.append(field('搜索技能包', search), list);
  const active = state.draft.skills.includes(state.activeSkill) ? state.activeSkill : state.draft.skills.find(bundle => bundle.id === state.activeSkill?.id) || state.draft.skills[0]; state.activeSkill = active;
  const drawList = () => {
    const query = search.value.trim().toLowerCase();
    const matching = state.draft.skills.filter(bundle => (bundle.id + ' ' + (bundle.name || '') + ' ' + bundle.source.type + ' ' + (skillSourceNames[bundle.source.type] || bundle.source.type)).toLowerCase().includes(query));
    list.replaceChildren();
    for (const bundle of matching) {
      const originKind = state.data.bundle_origins?.[bundle.id] || (bundle.origin === 'builtin' ? 'builtin' : 'project');
      const [originText, originTone] = bundleOriginBadges[originKind] || ['项目', ''];
      const upgrades = bundlePendingUpgrades(bundle, state);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'quiet skill-bundle-nav-item';
      item.dataset.bundleId = bundle.id;
      item.setAttribute('aria-pressed', String(bundle === active));
      item.append(element('span', `${bundle.id} · ${skillSourceNames[bundle.source.type] || bundle.source.type}`, 'skill-bundle-nav-title'));
      const meta = element('span', '', 'skill-bundle-nav-badges');
      meta.append(badge(originText, originTone));
      if (upgrades.length) meta.append(badge('有新版本', 'warning'));
      item.append(meta);
      item.addEventListener('click', () => { state.activeSkill = bundle; redraw(); });
      list.append(item);
    }
    if (!matching.length) list.append(note(state.draft.skills.length ? '没有匹配的技能包；当前编辑草稿仍保留。' : '尚无技能包，请在右侧或下方创建。'));
  };
  search.addEventListener('input', () => { state.skillSearch = search.value; drawList(); }); drawList();
  const editor = roleSkillsCard(state, redraw, active || null); editor.classList.add('skill-catalog-editor');
  layout.append(sidebar, editor); section.append(layout); return section;
}
function roleSkillsCard(state, redraw, selected = null) {
  const section = card('技能包'), { draft, data } = state;
  const byId = skillLibraryMap(state);
  const allLibrarySkills = Array.isArray(state.skillLibrary?.skills) ? state.skillLibrary.skills : [];
  section.append(note('创建或编辑技能包后，可在此页或单个角色的「高级设置 → 技能包」中多选绑定；点击顶部「保存」生效。'));
  for (const bundle of selected ? [selected] : draft.skills) {
    const group = element('fieldset', '', 'role-skill');
    const name = roleBound(input('bundle_id', bundle.id), value => {
      const old = bundle.id;
      bundle.id = value;
      for (const role of draft.roles) {
        const ids = roleBundleIds(role);
        if (ids.includes(old)) setRoleBundleIds(role, ids.map(id => (id === old ? value : id)));
      }
    }, state);
    name.addEventListener('change', redraw);
    const originKind = data.bundle_origins?.[bundle.id] || (bundle.origin === 'builtin' ? 'builtin' : 'project');
    const [originText, originTone] = bundleOriginBadges[originKind] || ['项目', ''];
    const legend = element('legend', bundle.name ? `${bundle.name}（${bundle.id}）` : bundle.id);
    group.append(legend);
    const badgeLine = element('p', '', 'skill-bundle-origin-line');
    badgeLine.append(badge(originText, originTone));
    if (bundle.origin === 'builtin' && data.configured === false) {
      badgeLine.append(' ', element('span', '默认配置状态：自动跟随最新内置 Skill 版本。', 'muted'));
    } else if (originKind === 'builtin') {
      badgeLine.append(' ', element('span', '已锁定当前内置 Skill 版本；内置更新时不会静默覆盖，可按需一键升级。', 'muted'));
    } else if (originKind === 'builtin_modified') {
      badgeLine.append(' ', element('span', '基于内置技能包做了项目自定义修改。', 'muted'));
    }
    group.append(badgeLine);

    // Upgrade banner for pinned built-in skills with newer available versions
    const pendingUpgrades = bundlePendingUpgrades(bundle, state);
    if (pendingUpgrades.length) {
      const upBox = element('div', '', 'skill-upgrade-banner');
      upBox.dataset.testid = 'bundle-upgrade-banner';
      const summary = pendingUpgrades.map(u => `${u.slug}: v${u.pinned_version} → v${u.latest_version}`).join('、');
      const upBtn = button('升级到最新内置版本', () => {
        const latestMap = new Map(pendingUpgrades.map(u => [u.skill_id, u.latest_version]));
        bundle.source.items = (bundle.source.items || []).map(item => (
          latestMap.has(item.skill_id) ? { ...item, version: latestMap.get(item.skill_id) } : item
        ));
        markRoleDirty(state);
        redraw();
      });
      upBtn.dataset.testid = 'upgrade-bundle-skills';
      upBox.append(badge('有新版本可用', 'warning'), ' ', element('span', `可升级内置 Skill：${summary}。`), ' ', upBtn);
      group.append(upBox);
    }

    if (bundle.source?.migrated_needs_review) {
      const reviewNote = element('p', '此技能包由旧内联文本自动迁移并补充了默认 SKILL.md 元数据，建议前往「技能库」复核与润色内容。', 'endpoint-warning');
      group.append(reviewNote);
    }

    group.append(field('技能包名称', name));
    if (selected) group.append(roleSkillFacts(bundle, state));
    const sourceOptions = [['library', '技能库'], ['repository', '仓库技能文件'], ['inline', '自定义文件']];
    group.append(field('来源', roleSelect('技能来源', bundle.source.type, sourceOptions, type => {
      if (type === 'library') {
        const first = allLibrarySkills[0];
        bundle.source = { type: 'library', items: first ? [{ skill_id: first.id, version: first.latest_version }] : [] };
      } else if (type === 'repository') {
        bundle.source = { type, commit: data.skill_sources?.repository?.commit || '', paths: [] };
      } else {
        bundle.source = { type, files: [{ path: 'guide.md', content: '' }] };
      }
      markRoleDirty(state); redraw();
    })));

    if (bundle.source.type === 'repository') {
      group.append(roleText('固定仓库提交', bundle.source, 'commit', state, { maxLength: 40 }), roleChoices('仓库技能文件', bundle.source, 'paths', [...new Set([...(bundle.source.paths || []), ...(data.skill_sources?.repository?.paths || [])])].map(path => [path, path]), state));
    } else if (bundle.source.type === 'library') {
      const items = Array.isArray(bundle.source.items) ? bundle.source.items : (bundle.source.items = []);
      const list = element('ul', '', 'skill-library-items');
      list.setAttribute('aria-label', '技能库条目');
      for (const item of items) {
        const meta = byId.get(item.skill_id);
        const entry = element('li', '', 'skill-library-bundle-item');
        const info = element('span', '', 'skill-library-bundle-item-info');
        const origin = meta?.origin || (String(item.skill_id).startsWith('builtin:') ? 'builtin' : 'console');
        info.append(
          element('strong', meta?.name || skillIdToSlug(item.skill_id, byId)),
          ' ',
          badge(skillOriginLabels[origin] || origin, skillOriginTones[origin] || ''),
          ' ',
          element('code', `${item.skill_id}@v${item.version}`),
        );
        const controls = element('span', '', 'skill-library-bundle-item-controls');
        const maxVer = Math.max(Number(meta?.latest_version || item.version || 1), Number(item.version || 1));
        const verChoices = [];
        for (let v = maxVer; v >= 1; v--) verChoices.push([String(v), `v${v}${meta && v === meta.latest_version ? '（最新）' : ''}`]);
        const verSelect = roleSelect(`选择 ${item.skill_id} 版本`, String(item.version), verChoices, val => {
          item.version = Number(val);
          markRoleDirty(state);
          redraw();
        });
        verSelect.dataset.skillVersionSelect = item.skill_id;
        const removeItemBtn = button('移除', () => {
          bundle.source.items = items.filter(x => x !== item);
          markRoleDirty(state);
          redraw();
        }, 'quiet');
        controls.append(verSelect, removeItemBtn);
        entry.append(info, controls);
        list.append(entry);
      }
      group.append(items.length ? list : note('尚未添加技能库条目（至少需要 1 个 Skill 才能保存）。'));

      // Picker to add another skill from the project skill library
      const existingIds = new Set(items.map(i => i.skill_id));
      const existingSlugs = new Set(items.map(i => skillIdToSlug(i.skill_id, byId)));
      const candidates = allLibrarySkills.filter(s => !existingIds.has(s.id));
      if (candidates.length) {
        const addRow = element('div', '', 'skill-add-item-row');
        const picker = document.createElement('select');
        picker.setAttribute('aria-label', '选择要加入技能包的 Skill');
        picker.dataset.testid = 'bundle-add-skill-select';
        for (const s of candidates) {
          const conflictHint = existingSlugs.has(s.slug) ? '（与包内已有 slug 同名）' : '';
          picker.add(new Option(`${s.name || s.slug} [${skillOriginLabels[s.origin] || s.origin}] · ${s.slug} (v${s.latest_version})${conflictHint}`, s.id));
        }
        const addBtn = button('加入技能包', () => {
          const chosen = candidates.find(s => s.id === picker.value);
          if (!chosen) return;
          bundle.source.items.push({ skill_id: chosen.id, version: chosen.latest_version });
          markRoleDirty(state);
          redraw();
        }, 'quiet');
        addBtn.dataset.testid = 'bundle-add-skill-btn';
        addRow.append(picker, addBtn);
        group.append(field('添加技能库 Skill', addRow));
      } else if (!allLibrarySkills.length) {
        group.append(note('技能库尚未加载或暂无可选 Skill，请先前往「技能库」查看或创建。'));
      }
    } else {
      for (const file of bundle.source.files || []) group.append(roleText('文件路径', file, 'path', state), roleText('文件内容', file, 'content', state, { multiline: true, rows: 5 }), button('移除文件', () => { bundle.source.files = bundle.source.files.filter(entry => entry !== file); markRoleDirty(state); redraw(); }));
      group.append(button('添加文件', () => { (bundle.source.files ??= []).push({ path: '', content: '' }); markRoleDirty(state); redraw(); }));
    }
    if (selected) {
      const bindings = element('fieldset', '', 'role-choices'); bindings.append(element('legend', '草稿绑定角色'));
      for (const role of draft.roles) {
        const bound = roleBundleIds(role).includes(bundle.id);
        const wrap = checkbox('bind:' + role.role_id, bound, roleConfigName(role));
        roleBound(wrap.querySelector('input'), checked => {
          const next = new Set(roleBundleIds(role));
          if (checked) next.add(bundle.id);
          else next.delete(bundle.id);
          setRoleBundleIds(role, [...next]);
        }, state);
        bindings.append(wrap);
      }
      group.append(bindings, note('支持同一角色同时绑定多个技能包。移除技能包会同时解除草稿中的角色绑定；保存后影响新任务，运行中的快照保持。'));
    }
    group.append(button('移除技能包', () => {
      draft.skills = draft.skills.filter(entry => entry !== bundle);
      for (const role of draft.roles) {
        const ids = roleBundleIds(role).filter(id => id !== bundle.id);
        setRoleBundleIds(role, ids);
      }
      markRoleDirty(state); redraw();
    }, 'quiet destructive'));
    section.append(group);
  }
  section.append(button('添加技能包', () => {
    let n = 1; while (draft.skills.some(bundle => bundle.id === 'skills_' + n)) n++;
    const first = allLibrarySkills[0];
    const bundle = first
      ? { id: 'skills_' + n, source: { type: 'library', items: [{ skill_id: first.id, version: first.latest_version }] } }
      : { id: 'skills_' + n, source: { type: 'inline', files: [{ path: 'guide.md', content: '' }] } };
    draft.skills.push(bundle); state.activeSkill = bundle; state.skillSearch = ''; markRoleDirty(state); redraw();
  }));
  return section;
}
