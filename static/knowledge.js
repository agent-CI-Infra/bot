// File navigation lives in this login's memory. It never persists private content in browser storage.
const knowledgeViews = new Map();
let knowledgeOwner = null, knowledgeEditor = null, knowledgeNavigationAllowed = false;
const knowledgeIdentity = () => me && JSON.stringify([me.id, me.actor?.tenant_id, me.actor?.principal_id]);
function resetKnowledgeFiles() { knowledgeViews.clear(); knowledgeOwner = null; knowledgeEditor = null; }
function knowledgeUnsaved() { return knowledgeEditor?.root.isConnected && (knowledgeEditor.draft.content !== knowledgeEditor.draft.initial || !!knowledgeEditor.draft.name); }
async function confirmKnowledgeLeave(signingOut = false) {
  if (!knowledgeUnsaved()) return true;
  const leave = await askConfirm({ title: signingOut ? '退出并清除未保存草稿？' : '离开未保存的文件？', body: [signingOut ? '退出登录会清除本次登录期间保留的草稿。' : '草稿仅在本次登录期间保留。'], action: signingOut ? '退出登录' : '离开文件' });
  if (leave) knowledgeEditor = null; return leave;
}
window.addEventListener('beforeunload', event => { if (knowledgeUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', event => {
  if (knowledgeNavigationAllowed) { knowledgeNavigationAllowed = false; return; }
  if (!knowledgeUnsaved()) return;
  event.stopImmediatePropagation(); const destination = event.newURL; history.replaceState(null, '', event.oldURL);
  void askConfirm({ title: '离开未保存的文件？', body: ['草稿仅在本次登录期间保留；退出登录后会清除。'], action: '离开文件' }).then(leave => {
    if (leave) { knowledgeNavigationAllowed = true; location.href = destination; }
  });
}, true);

function knowledgeSection() {
  const owner = knowledgeIdentity();
  if (knowledgeOwner !== owner) resetKnowledgeFiles(); knowledgeOwner = owner;
  const repo = current.id, endpoint = `/api/repositories/${repo}/knowledge-files`, root = element('section', '', 'knowledge-workspace');
  root.setAttribute('aria-label', '项目文件');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const saved = knowledgeViews.get(repo), state = saved || { directory: '', file: null, revision: null, screen: 'directory', expanded: new Set(['']), drafts: new Map(), query: '', trash: false, historyScroll: 0 };
  if (params.size || history.state?.knowledge === repo) Object.assign(state, { directory: params.get('directory') || '', file: params.get('file'), revision: params.has('revision') ? Number(params.get('revision')) : null, screen: params.get('history') === '1' ? 'history' : params.has('file') ? 'preview' : 'directory', query: params.get('query') || '', trash: params.get('deleted') === '1' });
  knowledgeViews.set(repo, state);
  if (!saved) history.replaceState({ ...history.state, knowledge: repo }, '', location.href);
  for (let path = state.directory; path; path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') state.expanded.add(path);
  const status = element('div', '', 'knowledge-status'), workspace = element('div', '', 'knowledge-layout');
  status.setAttribute('role', 'alert'); root.append(status, workspace);
  let epoch = 0, listing = null, selected = null, versions = null, busy = false, editing = false, conflict = null;
  const live = token => root.isConnected && knowledgeIdentity() === owner && current?.id === repo && current.section === 'knowledge' && token === epoch;
  const url = id => endpoint + '/' + encodeURIComponent(id);
  const locationText = path => path || '全部文件';
  const fileBytes = value => value == null ? '大小未知' : value < 1024 ? value + ' B' : bytes(value);
  const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未提供';
  const actor = value => value ? value === 'filesystem' ? '文件系统变更' : value === 'user:'+me.actor?.principal_id ? (me.username || '当前用户') : value : '修改人未提供';
  const write = () => listing?.can_write === true;
  const routeState = () => {
    const next = new URLSearchParams(); if (state.directory) next.set('directory', state.directory); if (state.query) next.set('query', state.query);
    if (state.trash) next.set('deleted', '1'); if (state.file) next.set('file', state.file); if (state.revision) next.set('revision', String(state.revision));
    if (state.screen === 'history') next.set('history', '1');
    const address = `#/projects/${repo}/knowledge${next.size ? '?' + next : ''}`;
    if (location.hash !== address) history.pushState({ knowledge: repo }, '', address);
  };
  const capture = () => { const panel = root.querySelector('.knowledge-history'); if (panel) state.historyScroll = panel.scrollTop; };
  const leave = async () => !knowledgeUnsaved() || await askConfirm({ title: '离开未保存的文件？', body: ['草稿仅在本次登录期间保留。'], action: '离开文件' });
  const failure = (error, retry, token) => {
    if (!live(token)) return;
    if ([401, 403].includes(error.status) || error.code === 'repository_not_found') {
      ++epoch; knowledgeViews.delete(repo); knowledgeEditor = null; selected = null; versions = null; listing = null;
      workspace.replaceChildren(); status.replaceChildren(note('文件访问权限已失效。请重新登录或联系管理员。')); return;
    }
    const message = error.code === 'note_move_uncertain' ? '文件移动的归属无法确认，本项目知识区已暂停读写。请联系部署维护者按「知识文件恢复」说明停写、备份并恢复一致的完整知识卷；重试不会解除此状态。' : error.message || '读取失败';
    status.replaceChildren(element('p', message, 'view-error'), button('重试读取', () => void retry(), 'quiet'));
  };
  const act = action => async () => { if (busy) return; try { await action(); } catch (error) { failure(error, refresh, epoch); } };
  const actionButton = (label, action, className = 'quiet') => { const b = button(label, act(action), className); b.disabled = busy; return b; };
  async function loadDirectory(repaint = true) {
    const token = ++epoch; status.replaceChildren(note('正在读取文件…'));
    try {
      const data = await api(endpoint + '?' + new URLSearchParams({ directory: state.directory, query: state.query, deleted_only: state.trash ? '1' : '0' }));
      if (!live(token)) return false; listing = data; status.replaceChildren(); if (repaint) draw(); return true;
    } catch (error) { failure(error, loadDirectory, token); return false; }
  }
  async function loadFile(id, revision = null) {
    const token = ++epoch; status.replaceChildren(note('正在读取文件…'));
    try {
      const data = await api(url(id) + (revision ? '?revision=' + revision : ''));
      if (!live(token)) return; selected = data.file; conflict = null;
      if (!revision && state.drafts.has(id) && !selected.readonly && selected.can_edit !== false) editing = true;
      status.replaceChildren(); draw();
    } catch (error) { failure(error, () => loadFile(id, revision), token); }
  }
  async function loadVersions() {
    const token = ++epoch; status.replaceChildren(note('正在读取历史…'));
    try {
      const data = await api(url(state.file) + '/versions'); if (!live(token)) return;
      versions = data.versions; status.replaceChildren(); draw();
    } catch (error) { failure(error, loadVersions, token); }
  }
  async function refresh() {
    if (editing && knowledgeUnsaved()) { status.replaceChildren(note('当前有未保存草稿；请先保存或取消编辑。')); return; }
    if (!await loadDirectory(!state.file)) return; if (state.file && listing) await loadFile(state.file, state.revision); if (state.screen === 'history' && selected) await loadVersions();
  }
  async function directory(path, trash = false) {
    if (!await leave()) return; capture(); editing = false; knowledgeEditor = null; state.directory = path; state.query = ''; state.trash = trash; state.file = null; state.revision = null; state.screen = 'directory'; selected = null; versions = null;
    for (let path = state.directory; path; path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') state.expanded.add(path);
    routeState(); await loadDirectory();
  }
  async function openFile(id, revision = null) {
    if (!await leave()) return; capture(); editing = false; knowledgeEditor = null; selected = null;
    state.moreOpen = false; state.file = id; state.revision = revision; state.screen = 'preview'; routeState(); draw(); await loadFile(id, revision);
    if (live(epoch) && !revision && state.drafts.has(id)) { editing = true; draw(); }
  }
  async function historyView() {
    if (!await leave()) return; editing = false; knowledgeEditor = null; state.screen = 'history'; routeState(); await loadVersions();
  }
  async function mutation(method, path, body, after) {
    if (busy) return false; const token = epoch; busy = true; status.replaceChildren(note('正在保存…')); draw();
    try {
      const result = await api(path, method, body); if (!live(token)) return;
      busy = false; status.replaceChildren(); await after(result); return true;
    } catch (error) {
      busy = false;
      if (!live(token)) return;
      if (error.status === 409 && editing && state.file) {
        const draft = state.drafts.get(state.file);
        try {
          const latest = (await api(url(state.file))).file; if (!live(token)) return; conflict = latest;
          status.replaceChildren(note(`文件已更新到 v${latest.current_revision}。草稿已保留，请先比较最新内容。`));
        } catch (readError) { failure(readError, () => loadFile(state.file), token); }
        if (draft) draw();
      } else { failure(error, refresh, token); draw(); }
          return false;
    } finally { busy = false; }
  }
  function crumbs() {
    const nav = element('nav', '', 'knowledge-breadcrumb'); nav.setAttribute('aria-label', '文件位置');
    nav.append(actionButton('全部文件', () => directory('')));
    if (state.trash) nav.append(element('span', '已删除文件'));
    else { let path = ''; for (const part of state.directory.split('/').filter(Boolean)) { path += (path ? '/' : '') + part; const target = path; nav.append(element('span', '/'), actionButton(part, () => directory(target))); } }
    return nav;
  }
  function tree() {
    const aside = element('aside', '', 'knowledge-tree'); aside.setAttribute('aria-label', '文件目录');
    aside.append(element('h3', '目录'), actionButton('全部文件', () => directory('')));
    const rows = element('div', '', 'knowledge-tree-rows');
    const visit = parent => {
      for (const path of (listing?.directories || []).filter(path => path && (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') === parent)) {
        const row = element('div', '', 'knowledge-tree-row'), expanded = state.expanded.has(path);
        const toggle = actionButton(expanded ? '▾' : '▸', () => { capture(); if (expanded) state.expanded.delete(path); else state.expanded.add(path); draw(); });
        toggle.setAttribute('aria-label', (expanded ? '收起目录 ' : '展开目录 ') + path); toggle.setAttribute('aria-expanded', String(expanded));
        const open = actionButton('▱ ' + path.split('/').at(-1), () => directory(path)); open.setAttribute('aria-label', '目录 ' + path); open.title = path;
        if (path === state.directory && !state.trash) open.setAttribute('aria-current', 'location');
        row.style.paddingInlineStart = (path.split('/').length - 1) * 14 + 'px'; row.append(toggle, open); rows.append(row); if (expanded) visit(path);
      }
    }; visit('');
    for (const file of (listing?.files || []).filter(file => !state.trash && file.directory === state.directory)) {
      const open = actionButton('▤ ' + file.name, () => openFile(file.id)); open.setAttribute('aria-label', '文件 ' + file.path); open.title = file.path;
      if (file.id === (selected?.id || state.file)) open.setAttribute('aria-current', 'page');
      const row = element('div', '', 'knowledge-tree-row'); row.append(open); rows.append(row);
    }
    aside.append(rows, actionButton('已删除文件', () => directory('', true))); return aside;
  }
  function metadata(file) { return note(`v${file.revision ?? '未知'} · ${timestamp(file.created_at)} · ${actor(file.actor)} · ${fileBytes(file.bytes)}`); }
  function directoriesPage(main) {
    main.append(element('h2', state.trash ? '已删除文件' : locationText(state.directory)));
    const search = input('knowledge_query', state.query, { placeholder: '搜索文件名或路径' }), form = element('form', '', 'knowledge-search');
    search.setAttribute('aria-label', '搜索文件名或路径'); const submit = element('button', '搜索', 'quiet'); submit.type = 'submit'; form.append(search, submit);
    form.addEventListener('submit', event => { event.preventDefault(); state.query = search.value; routeState(); void loadDirectory(); }); main.append(form);
    if (state.query) main.append(note('搜索范围：全部目录的文件名和路径。'));
    const tools = element('div', '', 'actions');
    if (!state.trash && write()) {
      tools.append(actionButton('新建文件', () => createFile()), actionButton('新建文件夹', () => directoryDialog(false)));
      if (state.directory) tools.append(actionButton('删除空文件夹', () => directoryDialog(true), 'quiet destructive'));
    }
    tools.append(actionButton('刷新文件', refresh)); main.append(tools);
    if (!listing) { main.append(note('文件列表尚未读取成功。')); return; }
    // A file saved under a name the current contract cannot address still sits on the volume. Nothing here renames or
    // deletes it: the page names what it left out, so a short list never reads as a complete one.
    const quarantined = state.trash ? [] : listing.quarantined || [];
    if (quarantined.length) {
      const readable = path => String(path).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
      const panel = element('details', '', 'knowledge-quarantined'); panel.append(element('summary', `另有 ${quarantined.length} 个无法打开的旧文件（名字含控制字符）`));
      const items = element('ul'); for (const row of quarantined) items.append(element('li', `${readable(row.path)} · 名字含控制字符，无法打开`));
      panel.append(items); main.append(panel);
    }
    const rows = element('ul', '', 'knowledge-file-list');
    if (!state.query && !state.trash) for (const path of listing.directories.filter(path => path && (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') === state.directory)) {
      const row = element('li'); row.append(actionButton('▱ ' + path.split('/').at(-1), () => directory(path)), note('文件夹')); rows.append(row);
    }
    for (const file of listing.files) {
      const row = element('li'), open = actionButton(file.name, () => openFile(file.id)); open.title = file.path;
      row.append(open, note(`${state.query || state.trash ? file.path + ' · ' : ''}${file.binary ? '无法预览的文件' : /\.md$/i.test(file.name) ? 'Markdown' : '文本'}${file.readonly ? ' · 只读' : ''}`), metadata(file)); rows.append(row);
    }
    main.append(rows.children.length ? rows : note(state.trash ? '没有已删除文件。' : '这个目录是空的。'));
    if (!write()) main.append(note('当前权限只能读取文件。'));
  }
  function preview(main) {
    main.append(actionButton('← 返回目录', () => directory(state.directory, state.trash)));
    const file = selected; if (!file) { main.append(note('正在读取文件内容…')); return; }
    const heading = element('div', '', 'knowledge-file-heading'); heading.append(element('h2', file.name), element('p', file.path, 'knowledge-path'), metadata(file)); main.append(heading);
    if (file.historical) main.append(element('p', `正在查看 v${file.revision} · 只读，当前仍为 v${file.current_revision}`, 'knowledge-version-notice'), actionButton('返回当前版本', () => openFile(state.file)));
    if (file.readonly) main.append(note(file.source === 'repository' ? '此文件来自仓库，正文修改通过仓库 PR 完成。' : '当前权限只能读取此文件。'));
    const tools = element('div', '', 'actions');
    if (!editing && !file.historical && !file.current_deleted && !file.readonly && file.can_edit !== false) tools.append(actionButton('编辑文件', () => {
      editing = true; const body = textarea('', file.content ?? '');
      if (!state.drafts.has(file.id)) state.drafts.set(file.id, { content: body.value, initial: body.value, raw: file.content, revision: file.current_revision }); draw();
    }));
    if (!file.deleted && (file.content !== null || file.download_base64)) tools.append(actionButton('下载文件', () => {
      const data = file.download_base64 ? Uint8Array.from(atob(file.download_base64), c => c.charCodeAt(0)) : file.content;
      const address = URL.createObjectURL(new Blob([data], { type: file.download_base64 ? 'application/octet-stream' : 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = address; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(address), 1000);
    }));
    tools.append(actionButton('历史版本', historyView));
    if (file.historical && !file.deleted && !file.readonly) tools.append(actionButton('恢复此版本', async () => {
      if (!await askConfirm({ title: `恢复 v${file.revision}？`, body: [`当前版本为 v${file.current_revision}；恢复会创建新版本，已有历史保留。`], action: '恢复版本' })) return;
      await mutation('POST', url(state.file) + '/restore', { revision: file.revision, expected_revision: file.current_revision }, async () => { state.revision = null; state.screen = 'preview'; routeState(); await refresh(); });
    }));
    if (!editing && !file.historical && !file.readonly) {
      const more = element('details', '', 'knowledge-more'), summary = element('summary', '更多操作'), menu = element('div', '', 'actions');
      more.open = !!state.moreOpen; more.addEventListener('toggle', () => { if (more.isConnected) state.moreOpen = more.open; });
      if (file.can_move) menu.append(actionButton('重命名或移动', moveDialog));
      if (!file.deleted) menu.append(actionButton('删除文件', async () => {
        if (!await askConfirm({ title: `删除 ${file.name}？`, body: ['删除后可在已删除文件中查阅和恢复历史。'], action: '删除', danger: true })) return;
        await mutation('DELETE', url(state.file), { expected_revision: file.current_revision }, async () => { state.drafts.delete(state.file); await refresh(); });
      }, 'quiet destructive')); more.append(summary, menu); tools.append(more);
    }
    main.append(tools);
    if (editing && !file.historical && !file.readonly && file.can_edit !== false) { editor(main, file); return; }
    const content = element('div', '', 'knowledge-content'); content.tabIndex = 0; content.setAttribute('aria-label', '文件内容');
    if (file.deleted) content.append(note('文件已删除。打开历史版本，选择删除前的版本即可恢复。'));
    else if (file.availability === 'unsupported_format') content.append(note('这种格式无法在此预览或编辑。可以下载原文件，字节保持不变。'));
    else if (file.content === null) content.append(note('原文暂时不可用，请重试读取。'));
    else if (file.content === '') content.append(note('这是一个空文件。'));
    else if (/\.md$/i.test(file.name)) renderManagementMarkdown(content, file.content);
    else content.append(element('pre', file.content)); main.append(content);
  }
  function editor(main, file) {
    const draft = state.drafts.get(file.id); if (!draft) return;
    const form = element('form', '', 'knowledge-editor'), content = textarea('knowledge_content', draft.content, { rows: 16, spellcheck: false, className: 'code' });
    content.setAttribute('aria-label', '内容'); content.disabled = busy;
    const notice = note('草稿未保存；保存时核对当前权限与版本。'); notice.setAttribute('role', 'status');
    content.addEventListener('input', () => { draft.content = content.value; notice.textContent = draft.content === draft.initial ? '内容没有修改。' : '草稿未保存；离开前会提醒。'; });
    const actions = element('div', '', 'knowledge-editor-actions'), save = element('button', busy ? '正在保存…' : '保存文件'); save.type = 'submit'; save.disabled = busy;
    actions.append(save, actionButton('取消编辑', async () => { if (!await leave()) return; editing = false; knowledgeEditor = null; state.drafts.delete(file.id); conflict = null; draw(); }));
    form.append(notice, field('内容', content));
    if (conflict) {
      const compare = element('details', '', 'knowledge-conflict'); compare.open = true; compare.append(element('summary', `最新已保存 v${conflict.current_revision}（只读比较）`), element('pre', conflict.content ?? '此版本没有可预览的正文'));
      if (!conflict.readonly && !conflict.current_deleted && conflict.can_edit !== false) compare.append(actionButton(`基于 v${conflict.current_revision} 保存草稿`, async () => {
        if (!await askConfirm({ title: '用草稿创建新版本？', body: [`已比较 v${conflict.current_revision}。这会用当前草稿创建下一个版本，已有历史保留。`], action: '保存草稿' })) return;
        draft.revision = conflict.current_revision; await saveDraft(file, draft);
      })); form.append(compare);
    }
    form.append(actions); form.addEventListener('submit', event => { event.preventDefault(); void saveDraft(file, draft); }); main.append(form); knowledgeEditor = { root, draft };
  }
  async function saveDraft(file, draft) {
    await mutation('PUT', url(file.id), { content: draft.content === draft.initial ? draft.raw : draft.content, expected_revision: draft.revision }, async () => {
      state.drafts.delete(file.id); editing = false; knowledgeEditor = null; conflict = null; await refresh();
    });
  }
  function historyPanel() {
    const panel = element('aside', '', 'knowledge-history'); panel.setAttribute('aria-label', '文件历史');
    panel.append(element('h3', '历史版本'), actionButton('← 返回文件', async () => { capture(); state.screen = 'preview'; routeState(); draw(); }));
    if (!versions) panel.append(note('历史尚未读取成功。'));
    for (const version of versions || []) {
      const row = element('div', '', 'knowledge-history-row'); row.append(actionButton(`v${version.revision}${version.deleted ? ' · 删除' : version.operation === 'move' ? ' · 移动' : ''}`, () => openFile(state.file, version.revision)), note(`${timestamp(version.created_at)} · ${actor(version.actor)}`)); panel.append(row);
    }
    requestAnimationFrame(() => { if (panel.isConnected) panel.scrollTop = state.historyScroll; }); return panel;
  }
  function draw() {
    capture(); knowledgeEditor = null; root.dataset.scene = state.screen; workspace.replaceChildren(tree());
    const main = element('div', '', 'knowledge-main'); main.append(crumbs());
    if (state.file) preview(main); else directoriesPage(main);
    workspace.append(main); if (state.screen === 'history') workspace.append(historyPanel());
  }
  async function directoryDialog(remove) {
    if (remove) {
      if (!await askConfirm({ title: `删除空目录 ${state.directory}？`, body: ['只删除空目录；文件的历史记录继续保留。'], action: '删除目录', danger: true })) return;
      const parent = state.directory.includes('/') ? state.directory.slice(0, state.directory.lastIndexOf('/')) : '';
      await mutation('DELETE', `/api/repositories/${repo}/knowledge-directories`, { path: state.directory }, () => directory(parent)); return;
    }
    pathDialog('新建文件夹', '', async path => mutation('POST', `/api/repositories/${repo}/knowledge-directories`, { path: (state.directory ? state.directory + '/' : '') + path }, () => loadDirectory()));
  }
  function pathDialog(title, value, save) {
    const dialog = element('dialog', '', 'knowledge-dialog'), form = element('form'), control = input('knowledge_path', value, { required: true }), feedback = element('p', '', 'view-error');
    feedback.setAttribute('role', 'alert'); const submit = element('button', '确认'); submit.type = 'submit'; form.append(element('h2', title), field(title === '新建文件夹' ? '文件夹名称' : '目标路径', control), feedback, submit, button('取消', () => dialog.close(), 'quiet'));
    form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true;
      // Path operations use the page's mutation guard and always leave the error in the live workspace.
      try { const done = await save(control.value); if (done !== false) dialog.close(); else feedback.textContent = status.textContent || '操作未完成，请重试。'; } catch (error) { feedback.textContent = error.message; } finally { submit.disabled = false; }
    }); dialog.append(form); root.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); control.focus();
  }
  function moveDialog() {
    const file = selected;
    pathDialog('重命名或移动', file.path, path => mutation('POST', url(file.id) + '/move', { path, expected_revision: file.current_revision }, async result => {
      state.directory = result.file.directory; state.query = ''; state.trash = false; routeState(); await refresh();
    }));
  }
  async function createFile() {
    if (!await leave()) return; knowledgeEditor = null; state.file = null; editing = false;
    const key = 'new:' + state.directory, draft = state.drafts.get(key) || { content: '', initial: '', name: '' }; state.drafts.set(key, draft);
    const main = element('div', '', 'knowledge-main'), form = element('form', '', 'knowledge-editor'), name = input('knowledge_filename', draft.name, { required: true, placeholder: '例如 readme.md' }), body = textarea('knowledge_content', draft.content, { rows: 16, spellcheck: false, className: 'code' });
    name.addEventListener('input', () => { draft.name = name.value; }); body.addEventListener('input', () => { draft.content = body.value; });
    const submit = element('button', '保存文件'); submit.type = 'submit'; form.append(element('h2', '新建文件'), field('文件名', name), field('内容', body), submit, actionButton('取消新建', async () => { if (!await leave()) return; state.drafts.delete(key); knowledgeEditor = null; draw(); }));
    form.addEventListener('submit', async event => { event.preventDefault(); if (busy || !form.reportValidity()) return;
      const path = (state.directory ? state.directory + '/' : '') + name.value, token = epoch; busy = true; submit.disabled = true;
      try { const result = await api(endpoint, 'POST', { path, content: body.value }); if (!live(token)) return; state.drafts.delete(key); knowledgeEditor = null; busy = false; if (!await loadDirectory()) return; await openFile(result.file.id); }
      catch (error) { failure(error, refresh, token); } finally { busy = false; submit.disabled = false; }
    }); main.append(crumbs(), form); workspace.replaceChildren(tree(), main); root.dataset.scene = 'preview'; knowledgeEditor = { root, draft }; body.focus();
  }
  draw(); void refresh(); return [root];
}
