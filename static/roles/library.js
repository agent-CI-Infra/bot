// Independent project Skill Library workspace (#1359): inspect built-in/repository/console skills,
// browse immutable version history & files, create/edit console skills, and import whole directories from trusted base branch.
const skillOriginLabels = { builtin: '内置', repository: '仓库', console: '控制台' };
const skillOriginTones = { builtin: 'info', repository: 'success', console: '' };

function skillLibraryErrorText(err) {
  const map = {
    skill_in_use: '该 Skill 仍被当前角色配置的技能包引用，请先在「技能包目录」解除引用并保存后再删除。',
    skill_already_exists: '当前项目已存在同名控制台 Skill（slug 重复），请更换 slug 或直接编辑现有 Skill。',
    skill_read_only: '内置或仓库导入的 Skill 不能直接在线编辑，请重新从仓库导入或新建控制台 Skill。',
    skill_revision_conflict: '该 Skill 已被其他操作更新，请刷新技能库核对最新版本后重试。',
    invalid_skill_slug: 'Skill slug 仅支持小写字母、数字、点号、下划线和连字符（1-64 个字符，以字母或数字开头）。',
    invalid_skill_frontmatter: 'SKILL.md 必须包含合法的 YAML frontmatter，并声明 name 与 description。',
    skill_md_required: 'Skill 必须包含根目录下的 SKILL.md 文件。',
    skill_source_not_found: '在可信基准分支中未找到目标 .agents/skills/ 目录或 SKILL.md。',
    skill_source_commit_unavailable: '请求的仓库提交不再与当前可信基准分支或缓存一致，请刷新后重试。',
    invalid_skill_file: '包含不合法的文件路径或非普通文件（如符号链接、路径越界或受限二进制文件）。',
    skill_file_too_large: '文件大小超过上限（单文件 512 KiB，单 Skill 总计 8 MiB）。',
    too_many_skill_files: '文件数量超过上限（单 Skill 最多 256 个文件）。',
  };
  const base = (err && map[err.code]) || readErrorText(err);
  return err?.detail && typeof err.detail === 'string' && !base.includes(err.detail) ? `${base}（${err.detail}）` : base;
}

function defaultSkillTemplate(slug) {
  const name = slug || 'my-skill';
  return `---\nname: ${name}\ndescription: Describe when and how the agent should apply this skill.\n---\n\n# ${name}\n\n1. State the exact conditions where this skill applies.\n2. Provide step-by-step instructions and verification checks.\n`;
}

function formatSkillBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function roleSkillLibraryWorkspace(state, redraw, access) {
  const repoId = access.repositoryId || current.id;
  const section = card('技能库');
  section.classList.add('skill-library-workspace');
  section.setAttribute('aria-label', '技能库');
  section.dataset.testid = 'skill-library-workspace';

  const ui = state.libraryUi ??= {
    origin: 'all',
    query: '',
    mode: 'detail', // 'detail' | 'create' | 'import'
    selectedId: null,
    selectedVersion: null,
    detail: null,
    detailKey: '',
    detailLoading: false,
    detailError: '',
    selectedFile: 'SKILL.md',
    editing: false,
    editFiles: [],
    createSlug: '',
    createFiles: [{ path: 'SKILL.md', content: defaultSkillTemplate('') }],
    importPath: '',
    busy: false,
    status: '',
    error: '',
  };

  const lib = state.skillLibrary;
  const canEdit = lib ? lib.can_edit !== false : state.data.can_edit !== false;
  const allSkills = Array.isArray(lib?.skills) ? lib.skills : [];

  const reloadLibrary = async (selectId = null, statusText = '') => {
    ui.busy = true; ui.error = ''; ui.status = ''; redraw();
    try {
      const fresh = await state.refreshSkillLibrary?.();
      if (!access.live()) return;
      if (fresh) {
        if (selectId) {
          ui.selectedId = selectId;
          ui.selectedVersion = null;
          ui.mode = 'detail';
          ui.editing = false;
        }
        ui.detail = null;
        ui.detailKey = '';
        ui.status = statusText;
      } else {
        ui.error = state.skillLibraryError || '无法读取技能库，请稍后重试。';
      }
    } finally {
      ui.busy = false;
      if (access.live()) redraw();
    }
  };

  const loadDetail = async (skillId, version = null) => {
    const key = `${skillId}@${version ?? 'latest'}`;
    if (ui.detailLoading && ui.detailKey === key) return;
    ui.detailKey = key;
    ui.detailLoading = true;
    ui.detailError = '';
    const qs = version ? `?version=${encodeURIComponent(version)}` : '';
    try {
      const res = await api(`/api/repositories/${repoId}/skills/${encodeURIComponent(skillId)}${qs}`);
      if (!access.live() || ui.detailKey !== key) return;
      ui.detail = res;
      ui.selectedVersion = res.version.version;
      const paths = (res.version.files || []).map(f => f.path);
      if (!paths.includes(ui.selectedFile)) ui.selectedFile = paths.includes('SKILL.md') ? 'SKILL.md' : (paths[0] || '');
      ui.detailLoading = false;
      redraw();
    } catch (err) {
      if (!access.live() || ui.detailKey !== key) return;
      ui.detailLoading = false;
      ui.detailError = skillLibraryErrorText(err);
      redraw();
    }
  };

  // Header & top actions
  const head = element('div', '', 'skill-library-head');
  const intro = note('独立版本化的 Skill 资产库：内置 Skill 随平台镜像同步，仓库 Skill 从可信基准分支整目录导入，控制台 Skill 在此在线新建与迭代。每个版本不可变，可在「技能包目录」中按版本引用。');
  const topActions = element('div', '', 'actions skill-library-actions');
  if (canEdit) {
    const createBtn = button('新建控制台 Skill', () => {
      ui.mode = 'create'; ui.editing = false; ui.error = ''; ui.status = '';
      if (!ui.createFiles.length) ui.createFiles = [{ path: 'SKILL.md', content: defaultSkillTemplate(ui.createSlug) }];
      redraw();
    }, ui.mode === 'create' ? '' : 'quiet');
    createBtn.dataset.testid = 'create-console-skill-btn';
    const importBtn = button('从仓库导入 Skill', () => {
      ui.mode = 'import'; ui.editing = false; ui.error = ''; ui.status = '';
      redraw();
    }, ui.mode === 'import' ? '' : 'quiet');
    importBtn.dataset.testid = 'import-repo-skill-btn';
    topActions.append(createBtn, importBtn);
  }
  const refreshBtn = button('刷新技能库', () => reloadLibrary(ui.selectedId), 'quiet');
  refreshBtn.disabled = !!ui.busy;
  topActions.append(refreshBtn);
  head.append(intro, topActions);
  section.append(head);

  if (ui.status) {
    const st = element('p', ui.status, 'view-success'); st.setAttribute('role', 'status');
    section.append(st);
  }
  if (ui.error) {
    const errEl = element('p', ui.error, 'view-error'); errEl.setAttribute('role', 'alert');
    section.append(errEl);
  }

  if (!lib) {
    section.append(note(state.skillLibraryError || '正在读取技能库…'), button('重试读取', () => reloadLibrary(null), 'quiet'));
    if (!ui.busy && !state.skillLibraryError) void reloadLibrary(null);
    return section;
  }

  // Filter bar
  const filterRow = element('div', '', 'skill-library-filters');
  const originGroup = element('div', '', 'actions skill-origin-tabs');
  originGroup.setAttribute('role', 'group');
  originGroup.setAttribute('aria-label', '按来源筛选');
  const counts = {
    all: allSkills.length,
    builtin: allSkills.filter(s => s.origin === 'builtin').length,
    repository: allSkills.filter(s => s.origin === 'repository').length,
    console: allSkills.filter(s => s.origin === 'console').length,
  };
  for (const [key, label] of [['all', '全部'], ['builtin', '内置'], ['repository', '仓库'], ['console', '控制台']]) {
    const btn = button(`${label} (${counts[key]})`, () => { ui.origin = key; redraw(); }, 'quiet');
    btn.setAttribute('aria-pressed', String(ui.origin === key));
    btn.dataset.originFilter = key;
    originGroup.append(btn);
  }
  filterRow.append(originGroup);
  section.append(filterRow);

  const layout = element('div', '', 'skill-catalog-layout skill-library-layout');
  const sidebar = element('div', '', 'skill-catalog-sidebar');
  const search = input('skill_library_search', ui.query, { placeholder: '按名称、slug 或描述搜索' });
  search.setAttribute('aria-label', '搜索技能库');
  const navList = element('nav', '', 'skill-catalog-nav');
  navList.setAttribute('aria-label', '技能库列表');

  const filterSkills = () => {
    const q = ui.query.trim().toLowerCase();
    return allSkills.filter(skill => {
      if (ui.origin !== 'all' && skill.origin !== ui.origin) return false;
      if (!q) return true;
      return `${skill.slug} ${skill.name} ${skill.description || ''} ${skill.id}`.toLowerCase().includes(q);
    });
  };

  let matching = filterSkills();
  if (ui.mode === 'detail') {
    const exists = allSkills.some(s => s.id === ui.selectedId);
    if (!exists && matching.length) {
      ui.selectedId = matching[0].id;
      ui.selectedVersion = null;
      ui.detail = null;
      ui.detailKey = '';
    }
  }

  const drawNav = () => {
    matching = filterSkills();
    navList.replaceChildren();
    for (const skill of matching) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiet skill-library-item';
      btn.dataset.skillId = skill.id;
      btn.setAttribute('aria-pressed', String(ui.mode === 'detail' && ui.selectedId === skill.id));
      const top = element('span', '', 'skill-library-item-top');
      top.append(element('strong', skill.name || skill.slug), badge(skillOriginLabels[skill.origin] || skill.origin, skillOriginTones[skill.origin] || ''));
      const sub = element('span', `${skill.slug} · v${skill.latest_version} · ${skill.file_count} 文件`, 'muted skill-library-item-meta');
      btn.append(top, sub);
      btn.addEventListener('click', () => {
        ui.mode = 'detail';
        ui.editing = false;
        ui.error = '';
        ui.status = '';
        if (ui.selectedId !== skill.id) {
          ui.selectedId = skill.id;
          ui.selectedVersion = null;
          ui.detail = null;
          ui.detailKey = '';
        }
        redraw();
      });
      navList.append(btn);
    }
    if (!matching.length) navList.append(note(allSkills.length ? '没有匹配的 Skill。' : '当前项目技能库为空。'));
  };
  search.addEventListener('input', () => { ui.query = search.value; drawNav(); });
  drawNav();
  sidebar.append(field('搜索技能库', search), navList);

  const panel = element('div', '', 'card skill-catalog-editor skill-library-detail');

  if (ui.mode === 'create' && canEdit) {
    panel.append(element('h4', '新建控制台 Skill'));
    panel.append(note('填写唯一 slug 与标准 SKILL.md（含 name、description 的 YAML frontmatter），可附带 companion 参考文件或脚本文本。创建后立即生成 v1，可在技能包目录中引用。'));
    const slugInput = input('create_skill_slug', ui.createSlug, { placeholder: '如 release-checklist', maxLength: 64 });
    slugInput.setAttribute('aria-label', 'Skill slug');
    slugInput.addEventListener('input', () => { ui.createSlug = slugInput.value; });
    panel.append(field('Skill slug', slugInput));

    const filesWrap = element('div', '', 'skill-files-editor');
    ui.createFiles.forEach((file, idx) => {
      const fset = element('fieldset', '', 'role-skill skill-file-row');
      fset.append(element('legend', file.path || `文件 ${idx + 1}`));
      const pathInput = input(`create_file_path_${idx}`, file.path, { placeholder: idx === 0 ? 'SKILL.md' : 'references/guide.md' });
      pathInput.setAttribute('aria-label', `文件路径 ${idx + 1}`);
      if (idx === 0) pathInput.readOnly = true;
      pathInput.addEventListener('input', () => { file.path = pathInput.value; });
      const contentInput = textarea(`create_file_content_${idx}`, file.content, { rows: idx === 0 ? 10 : 6 });
      contentInput.setAttribute('aria-label', `文件内容 ${idx + 1}`);
      contentInput.addEventListener('input', () => { file.content = contentInput.value; });
      fset.append(field('文件路径', pathInput), field('文件内容', contentInput));
      if (idx > 0) {
        fset.append(button('移除此文件', () => { ui.createFiles.splice(idx, 1); redraw(); }, 'quiet'));
      }
      filesWrap.append(fset);
    });
    panel.append(filesWrap);

    const formActions = element('div', '', 'actions');
    const addFileBtn = button('添加附带文件', () => {
      ui.createFiles.push({ path: `references/note-${ui.createFiles.length}.md`, content: '' });
      redraw();
    }, 'quiet');
    const fillTemplateBtn = button('按 slug 重置模板', () => {
      if (ui.createFiles[0]) ui.createFiles[0].content = defaultSkillTemplate(ui.createSlug.trim());
      redraw();
    }, 'quiet');
    const submitBtn = button(ui.busy ? '正在创建…' : '创建 Skill (v1)', async () => {
      if (ui.busy) return;
      ui.busy = true; ui.error = ''; ui.status = ''; redraw();
      try {
        const res = await api(`/api/repositories/${repoId}/skills`, 'POST', {
          slug: ui.createSlug.trim(),
          files: ui.createFiles.map(f => ({ path: f.path.trim(), content: f.content })),
        });
        if (!access.live()) return;
        ui.createSlug = '';
        ui.createFiles = [{ path: 'SKILL.md', content: defaultSkillTemplate('') }];
        await reloadLibrary(res.skill.id, `已创建控制台 Skill「${res.skill.slug}」（v${res.version.version}）。`);
      } catch (err) {
        if (!access.live()) return;
        ui.busy = false;
        ui.error = skillLibraryErrorText(err);
        redraw();
      }
    });
    submitBtn.dataset.testid = 'submit-create-skill';
    submitBtn.disabled = !!ui.busy;
    const cancelBtn = button('取消', () => { ui.mode = 'detail'; ui.error = ''; redraw(); }, 'quiet');
    formActions.append(submitBtn, addFileBtn, fillTemplateBtn, cancelBtn);
    panel.append(formActions);
  } else if (ui.mode === 'import' && canEdit) {
    panel.append(element('h4', '从仓库导入 Skill（整目录）'));
    panel.append(note('只从当前仓库的可信基准分支读取 .agents/skills/<name>/** 整目录（含 SKILL.md、references、scripts 及受控静态资源），绝不读取未合入 PR 分支；重复导入内容无变化时不产生新版本。'));
    const repoSources = lib.repository_sources;
    if (repoSources && Array.isArray(repoSources.skills) && repoSources.skills.length) {
      panel.append(note(`可信缓存提交：${repoSources.commit.slice(0, 12)}（发现 ${repoSources.skills.length} 个 Skill 目录）`));
      const tbl = projectTable(['目录', 'Slug', '文件数', '状态', '操作'], '可从缓存导入的仓库 Skill');
      for (const item of repoSources.skills) {
        const tr = document.createElement('tr');
        tableCell(tr, '目录', element('code', item.path));
        tableCell(tr, 'Slug', element('code', item.slug));
        tableCell(tr, '文件数', note(`${item.file_count} 文件 · ${formatSkillBytes(item.total_bytes)}`));
        tableCell(tr, '状态', item.imported_version ? badge(`已导入 v${item.imported_version}`, 'success') : badge('未导入', ''));
        const impBtn = button(item.imported_version ? '重新导入' : '导入', async () => {
          if (ui.busy) return;
          ui.busy = true; ui.error = ''; ui.status = ''; redraw();
          try {
            const res = await api(`/api/repositories/${repoId}/skills/import`, 'POST', {
              path: item.path, commit: repoSources.commit, source: 'cache',
            });
            if (!access.live()) return;
            const first = res.imported?.[0];
            await reloadLibrary(first?.skill?.id || null, first?.created ? `已导入 ${item.slug}（v${first.version.version}）。` : `${item.slug} 内容与当前最新版本一致，未生成重复版本。`);
          } catch (err) {
            if (!access.live()) return;
            ui.busy = false; ui.error = skillLibraryErrorText(err); redraw();
          }
        }, 'quiet');
        impBtn.disabled = !!ui.busy;
        impBtn.dataset.importPath = item.path;
        tableCell(tr, '操作', impBtn);
        tbl.body.append(tr);
      }
      const importAllBtn = button('全部导入缓存中的 Skill', async () => {
        if (ui.busy) return;
        ui.busy = true; ui.error = ''; ui.status = ''; redraw();
        try {
          const res = await api(`/api/repositories/${repoId}/skills/import`, 'POST', {
            all: true, commit: repoSources.commit, source: 'cache',
          });
          if (!access.live()) return;
          const created = (res.imported || []).filter(i => i.created).length;
          await reloadLibrary(res.imported?.[0]?.skill?.id || null, `已扫描 ${res.imported?.length || 0} 个仓库 Skill，新增或升级 ${created} 个版本。`);
        } catch (err) {
          if (!access.live()) return;
          ui.busy = false; ui.error = skillLibraryErrorText(err); redraw();
        }
      });
      importAllBtn.dataset.testid = 'import-all-cached-skills';
      importAllBtn.disabled = !!ui.busy;
      panel.append(tbl.table, element('div', '', 'actions'));
      panel.lastChild.append(importAllBtn);
    } else {
      panel.append(note('当前尚未缓存到 .agents/skills/ 目录。可先在「角色 → Manager」刷新仓库缓存，或直接从基准分支实时导入。'));
    }

    const liveBox = element('fieldset', '', 'role-skill');
    liveBox.append(element('legend', '从基准分支实时导入'));
    const pathIn = input('live_import_path', ui.importPath, { placeholder: '如 .agents/skills/release-guide（留空可点全部实时导入）' });
    pathIn.setAttribute('aria-label', '仓库 Skill 路径');
    pathIn.addEventListener('input', () => { ui.importPath = pathIn.value; });
    const liveActions = element('div', '', 'actions');
    const liveOne = button('按路径实时导入', async () => {
      if (ui.busy) return;
      const targetPath = ui.importPath.trim();
      if (!targetPath) { ui.error = '请填写要导入的 .agents/skills/<name> 路径。'; redraw(); return; }
      ui.busy = true; ui.error = ''; ui.status = ''; redraw();
      try {
        const res = await api(`/api/repositories/${repoId}/skills/import`, 'POST', { path: targetPath, source: 'live' });
        if (!access.live()) return;
        const first = res.imported?.[0];
        ui.importPath = '';
        await reloadLibrary(first?.skill?.id || null, `已从提交 ${String(res.commit || '').slice(0, 12)} 导入 ${first?.skill?.slug || targetPath}。`);
      } catch (err) {
        if (!access.live()) return;
        ui.busy = false; ui.error = skillLibraryErrorText(err); redraw();
      }
    }, 'quiet');
    liveOne.disabled = !!ui.busy;
    const liveAll = button('实时导入全部 .agents/skills/', async () => {
      if (ui.busy) return;
      ui.busy = true; ui.error = ''; ui.status = ''; redraw();
      try {
        const res = await api(`/api/repositories/${repoId}/skills/import`, 'POST', { all: true, source: 'live' });
        if (!access.live()) return;
        await reloadLibrary(res.imported?.[0]?.skill?.id || null, `已从提交 ${String(res.commit || '').slice(0, 12)} 导入 ${res.imported?.length || 0} 个仓库 Skill。`);
      } catch (err) {
        if (!access.live()) return;
        ui.busy = false; ui.error = skillLibraryErrorText(err); redraw();
      }
    }, 'quiet');
    liveAll.disabled = !!ui.busy;
    liveActions.append(liveOne, liveAll, button('返回详情', () => { ui.mode = 'detail'; ui.error = ''; redraw(); }, 'quiet'));
    liveBox.append(field('目录路径', pathIn), liveActions);
    panel.append(liveBox);
  } else {
    // Detail mode
    const summary = allSkills.find(s => s.id === ui.selectedId) || matching[0] || null;
    if (!summary) {
      panel.append(note('选择左侧任意 Skill 查看其版本与文件，或点击上方按钮新建／导入 Skill。'));
    } else {
      const targetKey = `${summary.id}@${ui.selectedVersion ?? 'latest'}`;
      if ((!ui.detail || ui.detail.skill.id !== summary.id || (ui.selectedVersion && ui.detail.version.version !== ui.selectedVersion)) && !ui.detailLoading && !ui.detailError) {
        void loadDetail(summary.id, ui.selectedVersion);
      }

      const dHead = element('div', '', 'skill-detail-head');
      dHead.append(
        element('h4', summary.name || summary.slug),
        badge(skillOriginLabels[summary.origin] || summary.origin, skillOriginTones[summary.origin] || ''),
        badge(`v${ui.detail?.skill?.id === summary.id ? ui.detail.version.version : summary.latest_version}`, ''),
      );
      panel.append(dHead);
      if (summary.description) panel.append(note(summary.description));

      const detail = ui.detail?.skill?.id === summary.id ? ui.detail : null;
      const versionObj = detail?.version || null;
      const versions = Array.isArray(detail?.versions) ? detail.versions : [];
      const factRows = [
        ['Skill 标识', summary.id],
        ['Slug', summary.slug],
        ['来源', skillOriginLabels[summary.origin] || summary.origin],
        ['最新版本', `v${summary.latest_version}`],
        ['文件与大小', `${versionObj ? versionObj.file_count : summary.file_count} 文件 · ${formatSkillBytes(versionObj ? versionObj.total_bytes : summary.total_bytes)}`],
      ];
      if (summary.source_path) factRows.push(['源路径', summary.source_path]);
      if (versionObj?.source_meta?.commit) factRows.push(['来源提交', String(versionObj.source_meta.commit)]);
      if (versionObj?.content_hash) factRows.push(['内容哈希', versionObj.content_hash]);
      panel.append(facts(factRows));

      if (summary.origin === 'builtin') {
        panel.append(note('内置 Skill 随平台镜像同步，只读且不可删除；镜像更新后会自动追加新版本号，旧版本保持不可变。'));
      }

      if (ui.detailError) {
        panel.append(element('p', ui.detailError, 'view-error'), button('重试加载详情', () => { ui.detailError = ''; void loadDetail(summary.id, ui.selectedVersion); }, 'quiet'));
      } else if (ui.detailLoading || !detail) {
        panel.append(note('正在读取 Skill 版本与文件内容…'));
      } else {
        // Version switcher + actions
        const bar = element('div', '', 'skill-version-bar');
        const verSelect = document.createElement('select');
        verSelect.setAttribute('aria-label', '查看技能版本');
        for (const v of versions) {
          const opt = new Option(`v${v.version}${v.version === summary.latest_version ? '（最新）' : ''} · ${v.file_count} 文件 · ${v.created_at ? timestamp(v.created_at) : ''}`, String(v.version));
          verSelect.add(opt);
        }
        verSelect.value = String(versionObj.version);
        verSelect.addEventListener('change', () => {
          ui.selectedVersion = Number(verSelect.value);
          ui.editing = false;
          ui.detail = null;
          ui.detailKey = '';
          void loadDetail(summary.id, ui.selectedVersion);
        });
        bar.append(field('历史版本', verSelect));

        const itemActions = element('div', '', 'actions');
        if (canEdit && summary.origin === 'console' && !ui.editing) {
          const editBtn = button('编辑并发布新版本', () => {
            ui.editing = true;
            ui.error = '';
            ui.status = '';
            ui.editFiles = (versionObj.files || []).filter(f => f.encoding !== 'base64').map(f => ({ path: f.path, content: f.content || '' }));
            if (!ui.editFiles.length) ui.editFiles = [{ path: 'SKILL.md', content: defaultSkillTemplate(summary.slug) }];
            redraw();
          });
          editBtn.dataset.testid = 'edit-console-skill-btn';
          itemActions.append(editBtn);
        }
        if (canEdit && summary.scope_kind === 'project') {
          const delBtn = button('删除 Skill', async () => {
            if (ui.busy) return;
            const ok = await askConfirm({
              title: `删除 Skill「${summary.slug}」？`,
              body: ['删除后将清除该 Skill 的所有版本。若当前激活的角色配置技能包仍在引用它，服务端将拒绝删除。'],
              action: '确认删除',
              danger: true,
            });
            if (!ok || !access.live()) return;
            ui.busy = true; ui.error = ''; ui.status = ''; redraw();
            try {
              await api(`/api/repositories/${repoId}/skills/${encodeURIComponent(summary.id)}`, 'DELETE', { expected_version: summary.latest_version });
              if (!access.live()) return;
              ui.selectedId = null;
              ui.selectedVersion = null;
              ui.editing = false;
              await reloadLibrary(null, `已删除 Skill「${summary.slug}」。`);
            } catch (err) {
              if (!access.live()) return;
              ui.busy = false;
              ui.error = skillLibraryErrorText(err);
              redraw();
            }
          }, 'quiet destructive');
          delBtn.dataset.testid = 'delete-project-skill-btn';
          delBtn.disabled = !!ui.busy;
          itemActions.append(delBtn);
        }
        bar.append(itemActions);
        panel.append(bar);

        if (ui.editing && canEdit && summary.origin === 'console') {
          const editBox = element('div', '', 'skill-files-editor');
          editBox.append(note(`基于当前最新版本 v${summary.latest_version} 编辑；保存后将生成新版本 v${summary.latest_version + 1}（内容未变则不生成新版本）。`));
          ui.editFiles.forEach((file, idx) => {
            const fset = element('fieldset', '', 'role-skill skill-file-row');
            fset.append(element('legend', file.path || `文件 ${idx + 1}`));
            const pIn = input(`edit_file_path_${idx}`, file.path, { placeholder: 'references/guide.md' });
            pIn.setAttribute('aria-label', `编辑文件路径 ${idx + 1}`);
            if (file.path === 'SKILL.md') pIn.readOnly = true;
            pIn.addEventListener('input', () => { file.path = pIn.value; });
            const cIn = textarea(`edit_file_content_${idx}`, file.content, { rows: file.path === 'SKILL.md' ? 12 : 6 });
            cIn.setAttribute('aria-label', `编辑文件内容 ${idx + 1}`);
            cIn.addEventListener('input', () => { file.content = cIn.value; });
            fset.append(field('文件路径', pIn), field('文件内容', cIn));
            if (file.path !== 'SKILL.md') {
              fset.append(button('移除此文件', () => { ui.editFiles.splice(idx, 1); redraw(); }, 'quiet'));
            }
            editBox.append(fset);
          });
          const editActions = element('div', '', 'actions');
          const saveEditBtn = button(ui.busy ? '正在保存…' : '保存新版本', async () => {
            if (ui.busy) return;
            ui.busy = true; ui.error = ''; ui.status = ''; redraw();
            try {
              const res = await api(`/api/repositories/${repoId}/skills/${encodeURIComponent(summary.id)}`, 'PUT', {
                expected_version: summary.latest_version,
                files: ui.editFiles.map(f => ({ path: f.path.trim(), content: f.content })),
              });
              if (!access.live()) return;
              ui.editing = false;
              await reloadLibrary(summary.id, res.created ? `已发布 ${summary.slug} v${res.version.version}。` : '内容无变化，保持当前版本。');
            } catch (err) {
              if (!access.live()) return;
              ui.busy = false; ui.error = skillLibraryErrorText(err); redraw();
            }
          });
          saveEditBtn.dataset.testid = 'save-console-skill-edit';
          saveEditBtn.disabled = !!ui.busy;
          editActions.append(
            saveEditBtn,
            button('添加附带文件', () => { ui.editFiles.push({ path: `references/extra-${ui.editFiles.length}.md`, content: '' }); redraw(); }, 'quiet'),
            button('取消编辑', () => { ui.editing = false; ui.error = ''; redraw(); }, 'quiet'),
          );
          panel.append(editBox, editActions);
        } else {
          // File list & viewer
          const files = Array.isArray(versionObj.files) ? versionObj.files : [];
          const fileTabs = element('div', '', 'actions skill-file-tabs');
          fileTabs.setAttribute('role', 'group');
          fileTabs.setAttribute('aria-label', 'Skill 文件列表');
          for (const f of files) {
            const tab = button(`${f.path} (${formatSkillBytes(f.bytes)})`, () => { ui.selectedFile = f.path; redraw(); }, 'quiet');
            tab.setAttribute('aria-pressed', String(f.path === ui.selectedFile));
            fileTabs.append(tab);
          }
          panel.append(element('h5', `版本 v${versionObj.version} 文件内容`), fileTabs);
          const activeFile = files.find(f => f.path === ui.selectedFile) || files[0];
          if (activeFile) {
            if (activeFile.encoding === 'base64') {
              panel.append(note(`受控静态资源文件（${activeFile.path} · ${formatSkillBytes(activeFile.bytes)} · SHA-256 ${String(activeFile.sha256 || '').slice(0, 16)}…），在容器技能目录中以只读文件提供，控制台不展开二进制原文。`));
            } else {
              const pre = element('pre', '', 'skill-file-preview');
              pre.append(element('code', activeFile.content || ''));
              panel.append(pre);
            }
          }
        }
      }
    }
  }

  layout.append(sidebar, panel);
  section.append(layout);
  return section;
}
