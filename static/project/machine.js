function machineSection(globalSettings = false) {
  const { environment } = current, pc = environment?.environment.computer, isSuper = me.role === 'super_admin';
  const canConfigure = isSuper || environment?.can_configure === true, editable = canConfigure && !!pc;
  const status = element('div', '', 'status-grid computer-status-grid'); status.id = 'machine-status'; status.append(...machineStatus());
  if (!pc) return [status, ...(globalSettings ? [] : [concurrencyPage()]), note('暂时读不到虚拟电脑规格。连接恢复后可重新读取本页配置；未保存改动请先保存。'),button('重新读取电脑配置',()=>reloadProject().catch(error))];
  // The saved spec is the project's own layer (#935: no repository file adds to it); without it the form cannot tell
  // the project's values from the defaults.
  const unread = !current.rules;
  const effective=current.rules?.computer||pc;
  const ownOverlay = pc.own || {};
  const globalDefaults = pc.global_defaults || { packages: [], setup_script: '', env: {} };
  const shown={...pc,...effective,
    packages: current.rules?.computer ? (effective.packages || []) : (pc.own ? (ownOverlay.packages || []) : (effective.packages || [])),
    setup_script: current.rules?.computer ? (effective.setup_script || '') : (pc.own ? (ownOverlay.setup_script || '') : (effective.setup_script || '')),
    env: current.rules?.computer ? (effective.env || {}) : (pc.own ? (ownOverlay.env || {}) : (effective.env || {})),
    network_policy:effective.egress===undefined?pc.network_policy:effective.egress?'internet egress':'internal, no egress'};
  // A resource left empty follows the global default; own() is the value the project sets.
  const own = name => current.rules?.computer ? current.rules.computer[name] : pc.inherited?.includes(name) ? undefined : pc[name];
  const names = { cpus: 'CPU', memory_mb: '内存', pids: '进程数', tmp_mb: '/tmp', packages: '软件包', setup_script: '初始化脚本', rebuild: '重新预编译镜像', rerun_setup: '重新预编译镜像', egress: '网络', env: '环境变量' };
  // An entry the field cannot accept must be reported, never read as「empty → follow the global default」. The four
  // resource fields are decimal-input text (#865): a number input silently drops text it cannot parse, so a typo left
  // .value empty and the save wrote null, clearing the project override. Text keeps what was typed, and the value is
  // checked here — the same bounds and step the number input enforced natively. The invalid state is still captured
  // while typing, so a later submit cannot mistake it for an explicit clear.
  const number = (name, step) => {
    const rawMax = pc.bounds?.[name]?.[1];
    const effectiveMax = name === 'memory_mb' && pc.host_memory_cap_mb != null
      ? Math.min(rawMax ?? Infinity, pc.host_memory_cap_mb)
      : name === 'cpus' && pc.host_cpus != null
        ? Math.min(rawMax ?? Infinity, pc.host_cpus)
        : name === 'tmp_mb' && (own('memory_mb') ?? pc.memory_mb) != null
          ? Math.min(rawMax ?? Infinity, own('memory_mb') ?? pc.memory_mb)
          : rawMax;
    const control = input(name, own(name) ?? '', { type: 'text', inputMode: 'decimal', autocomplete: 'off', spellcheck: false,
      placeholder: `留空使用全局默认（${pc.defaults?.[name] ?? pc[name]}）` });
    const emptyNote = () => '留空即跟随全局默认';
    const invalidNote = () => '这个字段只能填数字';
    // '' (an empty field) is not an error: it follows the global default unless it was refused while holding text.
    const valueError = text => {
      if (text === '') return '';
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) return invalidNote();
      const value = Number(text), [min] = pc.bounds?.[name] ?? [];
      if (min != null && value < min) return `需不小于 ${min}`;
      if (effectiveMax != null && value > effectiveMax) return `需不大于 ${effectiveMax}`;
      const size = Number(step);
      if (size > 0) { const steps = (value - (min ?? 0)) / size; if (Math.abs(steps - Math.round(steps)) > 1e-9) return `取值步长是 ${step}`; }
      return '';
    };
    const error = element('span', '', 'machine-config-error'), follow = element('span', '', 'machine-config-follow');
    error.id = `machine-${name}-error`; error.hidden = true; follow.textContent = emptyNote(); follow.hidden = control.value.trim() !== '';
    control.setAttribute('aria-describedby', error.id);
    // A refused entry stays refused until the user clears the field, deletes content it actually held, or enters a value
    // it now accepts. An empty value alone cannot be told apart from an explicit clear, and reading it as one is the
    // #865 defect: a paste fires `insertFromPaste` and then `input` with an empty value, and Backspace in an already
    // empty field fires only a delete, so neither may reset the rejection.
    let rejected = false;
    const render = () => {
      const text = control.value.trim(), reason = valueError(text), accepted = text !== '' && reason === '';
      control.dataset.invalidNumber = rejected ? '1' : '';
      // A refused entry the field can still accept is released by the submit (#944); until then the message stays, but it
      // must not let the browser reject that submit before readSpec has had the chance to release it.
      control.setCustomValidity(rejected && !accepted ? reason || invalidNote() : '');
      control.setAttribute('aria-invalid', rejected ? 'true' : 'false');
      error.textContent = rejected ? reason || invalidNote() : '';
      error.hidden = !rejected; clear.hidden = !rejected;
      follow.textContent = emptyNote();
      follow.hidden = rejected || control.value.trim() !== '';
    };
    // A refusal is unsaved state: announce it through the form's change so the dirty bar appears even when the browser
    // discarded the entry without firing an input event (a letter typed into a number input that already holds a value).
    const reject = () => { rejected = true; render(); control.dispatchEvent(new Event('change', { bubbles: true })); };
    const release = () => { rejected = false; render(); };
    // Saving asks every refused field to step aside when its current text is one it accepts (#944); a refused field that
    // still holds the saved value therefore saves without clearing, and one that holds a new number saves that number.
    control.machineReleaseIfAccepted = () => {
      const text = control.value.trim();
      if (rejected && text !== '' && !valueError(text)) release();
    };
    const clear = button('清空并跟随全局默认', () => { release(); control.value = ''; control.dispatchEvent(new Event('input', { bubbles: true })); control.focus(); }, 'quiet');
    clear.hidden = true;
    // Letters reach a text field, unlike the number input this replaced; beforeinput still reports a paste of characters
    // the field cannot mean, so the refusal is raised before the value is read.
    control.addEventListener('beforeinput', event => {
      const data = event.data ?? '';
      if ((event.inputType === 'insertText' || event.inputType === 'insertFromPaste') && data && !/^[0-9.eE+\-]+$/.test(data)) reject();
      // Deleting content the field actually held is an explicit clear; Backspace in an already empty field is not.
      else if ((event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') && control.value.trim() !== '') release();
    });
    control.addEventListener('input', () => {
      const text = control.value.trim();
      // Out of range and off-step text is refused like text that is not a number: the browser no longer does it for us.
      if (valueError(text)) reject();
      // Only text the field actually holds releases the refusal. An empty value is not a replacement: emptying the field
      // with Backspace deletes content it held, while an empty value alone is not an explicit clear (#903 review B1).
      else if (rejected && text !== '') release();
      else render();
    });
    control.machineValueError = valueError;
    control.machineExtras = [error, clear, follow];
    return control;
  };
  const configField = (label, control, name) => {
    const wrap = element('div', '', 'machine-config-field'), source = current.rules?.computer_sources?.[name];
    const inherited = specFields.includes(name) && own(name) == null;
    const origin = source ? layerNames[source] : specFields.includes(name) ? '全局默认' : '内置默认';
    const hint = element('span', unread ? '来源暂未读取' : `已保存来源：${origin}${inherited && source ? '，跟随全局默认' : ''}`, 'machine-config-origin');
    if (specFields.includes(name)) {
      const target = own(name) ?? pc.defaults?.[name];
      hint.append(` · ${unread ? '临时值' : '配置目标'} ${target ?? '未知'} · 电脑报告 ${pc[name] ?? '未知'}`);
    }
    wrap.append(control.tagName === 'LABEL' ? control : field(label, control), ...(control.machineExtras ?? []), hint); return wrap;
  };
  const group = (title, text, ...fields) => {
    const section = element('section', '', 'machine-config-group');
    section.append(element('h4', title), note(text), ...fields); return section;
  };
  const resourceGrid = element('div', '', 'field-grid');
  const cpusControl = number('cpus', '0.25'), memoryControl = number('memory_mb', '128'), pidsControl = number('pids', '1'), tmpControl = number('tmp_mb', '16');
  if (!isSuper) for (const ctrl of [cpusControl, memoryControl, pidsControl, tmpControl]) ctrl.disabled = true;
  resourceGrid.append(configField('CPU（核）', cpusControl, 'cpus'), configField('内存（MB）', memoryControl, 'memory_mb'),
    configField('进程数上限', pidsControl, 'pids'), configField('/tmp 大小（MB）', tmpControl, 'tmp_mb'));
  const globalPkgList = globalDefaults.packages?.length ? globalDefaults.packages.join(' ') : '无';
  const globalEnvKeys = Array.isArray(globalDefaults.env_keys) ? globalDefaults.env_keys : Object.keys(globalDefaults.env || {});
  const hasGlobalSetup = globalDefaults.has_setup_script ?? !!globalDefaults.setup_script?.trim();
  const globalBaseline = facts([
    ['全局预装软件包（自动继承）', globalPkgList],
    ['全局初始化脚本（自动继承）', hasGlobalSetup ? '已配置（本项目脚本将叠加在其之后执行）' : '无'],
    ['全局环境变量（自动继承）', globalEnvKeys.length ? globalEnvKeys.join('、') : '无'],
  ]);
  const egressControl = checkbox('egress', shown.network_policy === 'internet egress', '允许访问外网（安装依赖、访问测试地址）');
  if (!isSuper) egressControl.querySelector('input').disabled = true;
  const fields = element('div', '', 'machine-config-fields');
  const resourceNote = isSuper
    ? '留空跟随全局默认（全局设置 → 工作电脑）。构建预编译镜像时也按此项目的 CPU 与内存上限执行。'
      + (pc.host_memory_cap_mb != null ? ` 当前宿主机单容器内存安全上限为 ${pc.host_memory_cap_mb} MB（预留 25% 给宿主机与控制面）` : '')
      + (pc.host_clamped ? `，已将原目标 ${pc.configured_memory_mb} MB 自动收紧至 ${pc.memory_mb} MB 生效。` : pc.host_memory_cap_mb != null ? '。' : '')
    : '资源上限由超级管理员统一管控，留空跟随全局默认；构建预编译镜像时按此处生效上限执行。';
  fields.append(group('资源上限', resourceNote, resourceGrid),
    group('软件与初始化', pc.build?.toolchain ? '基础镜像已包含：' + pc.build.toolchain + '。本项目填写的软件包与初始化脚本会叠加在全局默认之上自动预编译并缓存；初始化脚本始终以非特权用户（UID 10001）安装到 /opt/preinstalled，不可修改系统目录。' : '本项目软件包与初始化脚本叠加在全局默认之上自动预编译并缓存；初始化脚本始终以非特权用户（UID 10001）运行。',
      globalBaseline,
      configField('额外系统软件包', textarea('packages', packagesText(shown.packages), { rows: 2, spellcheck: false, placeholder: 'Debian 包名，空格或换行分隔，例如 ffmpeg libpq-dev（自动叠加在全局包之上）' }), 'packages'),
      configField('初始化脚本', textarea('setup_script', shown.setup_script || '', { rows: 5, spellcheck: false, className: 'code', placeholder: '以 UID 10001 在构建期运行，工具安装到 /opt/preinstalled（uv/pip/npm -g/cargo/go/$HOME/.local/bin 已自动指向并加入 PATH）' }), 'setup_script'),
      checkbox('rebuild', false, '强制重新预编译镜像（忽略已有缓存层）')),
    group('网络与环境变量', '环境变量对仓库代码可见，不要填写密钥；同名变量会覆盖全局默认值。' + (isSuper ? '' : '网络开关由超级管理员管控。'),
      configField('网络访问', egressControl, 'egress'),
      configField('环境变量', textarea('env', envText(shown.env), { rows: 3, spellcheck: false, placeholder: '每行 名称=值。对仓库代码可见，不要填写密钥' }), 'env')));
  const impact = element('aside', '', 'machine-config-impact'), draft = element('p', '', 'machine-config-draft'); draft.setAttribute('role', 'status');
  impact.append(element('h4', '保存影响'), draft,
    note(!canConfigure ? '只有项目管理员或超级管理员可修改机器配置。' : isSuper ? '保存后若需要预编译镜像，构建将在后台串行队列（并发=1，无超时）自动执行，上方卡片实时显示构建日志且可随时手动停止；构建完成前当前运行中的虚拟电脑不受影响。' : '项目管理员可配置本项目增量软件包、初始化脚本与环境变量，并实时查看构建进展或手动停止构建；资源上限与网络开关由超级管理员维护。'),
    note('工作卷、笔记和代次保留。项目任务并发在另一组单独保存，不会重建电脑。'));
  if (pc.resources_pending) impact.append(note('全局默认已变化，电脑等待空闲后重建。电脑报告的资源是配置目标，不能据此确认运行中容器已使用新上限。'));
  if (pc.image_pending) impact.append(note('新的预编译镜像已就绪，电脑将在当前运行任务全部空闲后自动平滑切换，不会中断正在执行的任务。'));
  if (pc.tools_pending) impact.append(note('项目工具卷已发布新版本，电脑将在当前运行任务全部空闲后自动整卷轮换，不会中断正在执行的任务。'));
  if (pc.toolchain_pending) impact.append(note('预编译工具链正在构建或等待切换，新任务将暂缓认领直到新镜像切换到位。'));
  if (pc.toolchain_missing) impact.append(note('预编译构建失败或已停止，当前电脑缺少项目预装软件包/初始化脚本（降级运行中），任务可继续认领；请修复配置后保存或重新预编译。'));
  const layout = element('div', '', 'machine-config-layout'); layout.append(fields, impact);
  const nodes = [
    note(unread?'暂时读不到已保存的机器配置，目前显示电脑报告的值。':'表单显示本项目叠加配置，电脑是否已应用需结合上方状态核对。机器配置只在这里修改，仓库里的 .bot/computer.yaml 不再读取。'),
    layout];
  const readSpec = (form, releasing = false) => {
    const spec = {};
    if (isSuper) {
      // null clears the project's value, so the resource follows the global default again — only an explicit clear may do that.
      for (const name of specFields) {
        const control = form.elements[name], text = control.value.trim();
        if (releasing) control.machineReleaseIfAccepted?.();
        // A refused entry is checked first, so it is reported instead of being read as「no change」(review of #903).
        // The value is validated here too: as text the field no longer has min/max/step for the browser to enforce.
        const reason = control.machineValueError?.(text) ?? '';
        if (control.dataset.invalidNumber === '1' || reason)
          throw new Error(`${names[name]}：${reason || '这个字段只能填数字'}`);
        const value = text === '' ? null : Number(text);
        if (value !== (own(name) ?? null)) spec[name] = value;
      }
      if (form.elements.egress.checked !== (shown.network_policy === 'internet egress')) spec.egress = form.elements.egress.checked;
    }
    const packages = [...new Set(form.elements.packages.value.split(/[\s,]+/).filter(Boolean))];
    if (packages.slice().sort().join(' ') !== [...(shown.packages || [])].sort().join(' ')) spec.packages = packages;
    const env = parseEnv(form.elements.env.value); if (envText(env) !== envText(shown.env)) spec.env = env;
    if (form.elements.setup_script.value !== (shown.setup_script || '')) spec.setup_script = form.elements.setup_script.value;
    if (form.elements.rebuild?.checked) spec.rebuild = true;
    return spec;
  };
  const form = settingsForm('配置', nodes, async (form, progress) => {
    const spec = readSpec(form, true);
    if (!Object.keys(spec).length) return '没有改动';
    progress(spec.packages !== undefined || spec.setup_script !== undefined || spec.rebuild ? '正在提交配置并触发预编译镜像构建…' : '正在按新配置更新虚拟电脑…');
    const saved = await api(`/api/environments/${current.id}/configure`, 'POST', { operation_id: operationId(), generation: environment.environment.generation, spec });
    const buildState = saved?.environment?.computer?.build?.state;
    if (buildState === 'queued' || buildState === 'building') {
      void refreshProjectStatus(renderToken);
      return buildState === 'queued' ? '已提交：镜像构建已进入排队，可在上方卡片查看实时进展或手动停止' : '已提交：正在后台预编译镜像，可在上方卡片查看实时日志或手动停止';
    }
    return '已保存，虚拟电脑已按新配置重建';
  }, { editable: editable && !unread, hideActions: editable && !unread });
  form.classList.add('machine-config-card');
  const update = () => {
    try { const changes = Object.keys(readSpec(form.querySelector('form'))); draft.textContent = changes.length ? '有未保存的更改：' + changes.map(key => names[key]).join('、') : '已保存'; }
    catch (err) { draft.textContent = '有未保存的更改：' + readErrorText(err); }
  };
  form.addEventListener('input', update); form.addEventListener('change', update); update();
  form.settingDirty = () => { try { return !!Object.keys(readSpec(form.querySelector('form'))).length; } catch { return true; } };
  form.settingClearDraft = () => {};
  const sourceReadError = element('p', '', 'view-error'); sourceReadError.hidden = true;
  const reread = button('重新读取电脑配置', async () => {
    const target = current, actor = me, address = location.hash, live = () => current === target && me === actor && location.hash === address;
    let dirty = true; try { dirty = !!Object.keys(readSpec(form.querySelector('form'))).length; } catch {}
    if (dirty && !await askConfirm({ title: '重新读取已保存配置？', body: ['本组未保存的输入将被替换。取消可继续保留草稿。'], action: '重新读取' })) return;
    if (!live()) return;
    reread.disabled = true; sourceReadError.hidden = true;
    try {
      if (live()) await reloadProject();
    } catch (err) { if (live()) { sourceReadError.textContent = '重新读取失败：' + readErrorText(err); sourceReadError.setAttribute('role', 'alert'); sourceReadError.hidden = false; } }
    finally { reread.disabled = false; }
  }, 'quiet');
  const canEdit = editable && !unread;
  const heading=form.querySelector('h3'),toolbar=element('div','','heading');heading.replaceWith(toolbar);
  // When the unified bar is present,「重新读取」lives directly in the save bar. Otherwise keep it next to the heading for recovery.
  if (!canEdit) toolbar.append(heading, reread);
  else toolbar.append(heading);
  toolbar.after(sourceReadError);
  if(unread)toolbar.after(note('已保存的机器配置读取失败，不能区分项目自己的值和默认值。请重新读取配置后保存。'));
  const concurrency = globalSettings ? null : concurrencyForm();
  const nodeBinding = globalSettings ? null : nodeBindingCard(isSuper);
  const projectTools = globalSettings ? null : projectToolsCard(canConfigure);
  const cliConfig = globalSettings ? null : cliConfigCard(canConfigure);
  const page = element('div', '', 'machine-settings');
  if (concurrency) page.append(concurrency);
  if (nodeBinding) page.append(nodeBinding);
  page.append(form);
  if (projectTools) page.append(projectTools);
  if (cliConfig) page.append(cliConfig);
  if (canEdit) {
    attachUnifiedSettingsBar(page, [form, concurrency].filter(Boolean), {
      dirty: () => form.settingDirty() || !!(concurrency && concurrency.settingDirty?.()),
      advanced: [reread],
    });
  } else if (concurrency) {
    // Project administrators (and super administrators while the computer spec is unread) cannot change the computer
    // spec, but they may still change「同时运行的任务」: give that form the same bar on its own.
    attachUnifiedSettingsBar(page, [concurrency]);
  }
  return [status, page];
}

// #1380: Per-project compute node binding card inside「机器配置」.
// Super administrators can rebind a repository to another online Linux Docker node; project members see read-only binding state.
function nodeBindingCard(isSuper) {
  const target = current, id = target.id, token = typeof renderToken === 'number' ? renderToken : 0;
  const section = card('计算节点绑定');
  section.dataset.testid = 'machine-node-binding';
  const body = element('div', '', 'machine-node-binding-body');
  body.append(note('正在读取计算节点绑定状态…'));
  const feedback = element('p', '', 'view-error');
  feedback.setAttribute('role', 'status');
  section.append(body, feedback);

  const live = () => current === target && (typeof renderToken !== 'number' || renderToken === token) && section.isConnected;
  const nodeStateMap = { online: ['在线', 'success'], draining: ['排水中', 'warning'], offline: ['离线', 'danger'], pending: ['待配对', ''], pending_pair: ['待配对', ''], revoked: ['已撤销', 'danger'] };
  const bindStateMap = { bound: '已绑定', active: '运行中', draining: '排水中', offline: '节点离线', rebinding: '改绑迁移中' };

  const renderBinding = data => {
    const b = data?.binding || { node_id: 'local', node_name: '本机节点 (local)', node_status: 'online', node_arch: 'amd64', node_os: 'linux', node_labels: {}, state: 'bound', binding_epoch: 1 };
    const [nLabel, nTone] = nodeStateMap[b.node_status] || [String(b.node_status || '未知'), ''];
    const labelsText = b.node_labels && typeof b.node_labels === 'object' && Object.keys(b.node_labels).length
      ? Object.entries(b.node_labels).sort(([a], [c]) => a.localeCompare(c)).map(([k, v]) => `${k}=${v}`).join(', ')
      : '无';

    const badges = element('div', '', 'actions project-tools-badges');
    badges.append(
      badge(`当前节点：${b.node_name || b.node_id}`, 'info'),
      badge(nLabel, nTone),
      badge(`绑定状态：${bindStateMap[b.state] || b.state}（epoch #${b.binding_epoch ?? 1}）`, b.state === 'draining' || b.state === 'rebinding' ? 'warning' : ''),
    );

    const rows = facts([
      ['绑定节点 ID', b.node_id],
      ['平台与架构', `${b.node_os || 'linux'}/${b.node_arch || 'amd64'}`],
      ['节点调度标签', labelsText],
    ]);

    const controls = [];
    if (isSuper && data?.can_rebind && Array.isArray(data?.nodes)) {
      const form = element('form', '', 'project-form machine-node-rebind-form');
      const select = document.createElement('select');
      select.name = 'target_node_id';
      select.setAttribute('aria-label', '目标计算节点');
      for (const n of data.nodes) {
        const opt = document.createElement('option');
        opt.value = n.id;
        const [st] = nodeStateMap[n.status] || [n.status];
        opt.textContent = `${n.name} (${n.id} · ${n.arch || 'amd64'} · ${st})`;
        if (n.id === b.node_id) opt.selected = true;
        select.append(opt);
      }
      const submit = element('button', '切换绑定节点');
      submit.type = 'submit';
      submit.disabled = data.nodes.length <= 1;
      const formActions = element('div', '', 'actions form-actions');
      formActions.append(submit);
      form.append(
        field('切换目标节点', select),
        note('切换前会先将项目笔记经同步引擎写回控制面，停止并回收旧节点工作区与容器，再在目标节点重建项目电脑（不跨节点拷贝工作卷）。如需接入新节点，请前往「全局设置 → 计算节点」。'),
        formActions,
      );
      form.addEventListener('submit', async event => {
        event.preventDefault();
        feedback.className = 'view-error';
        announceSave(feedback, '', false);
        const targetId = select.value;
        if (!targetId || targetId === b.node_id) {
          announceSave(feedback, '目标节点与当前绑定一致，无需切换。', false);
          return;
        }
        const targetMeta = data.nodes.find(n => n.id === targetId);
        const confirmed = await askConfirm({
          title: `将本项目改绑到节点「${targetMeta?.name || targetId}」？`,
          body: [
            '改绑期间将暂停新任务认领，并停止回收旧节点上的项目容器与本地工作卷（项目笔记保留在控制面）。',
            '目标节点在线后会自动拉起新的项目电脑。',
          ],
          action: '确认切换节点',
        });
        if (!confirmed || !live()) return;
        submit.disabled = true;
        try {
          const res = await api(`/api/repositories/${id}/node`, 'PUT', { node_id: targetId });
          if (!live()) return;
          feedback.className = 'view-success';
          announceSave(feedback, `已切换绑定到「${res.binding?.node_name || targetId}」（epoch #${res.binding?.binding_epoch ?? ''}）。`, false);
          await loadBinding();
        } catch (err) {
          if (!live()) return;
          feedback.className = 'view-error';
          const code = String(err?.message || '');
          const reason = ({
            target_node_not_online: '目标节点当前不在线，请先确认目标节点已连接上线。',
            node_not_found: '目标节点不存在，请刷新页面后重试。',
            repository_already_bound_to_node: '该项目已绑定到所选节点，无需重复切换。',
            repository_rebind_in_progress: '该项目正在执行改绑操作，请稍候刷新。',
            repository_rebinding: '该项目正在执行改绑操作，请稍候刷新。',
            project_tasks_running: '当前项目仍有正在执行的任务，请等待任务结束或停止后再切换节点。',
            environment_operation_pending: '当前项目有尚未完成的电脑操作，请稍候完成后再切换节点。',
            previous_node_unreachable: '旧节点当前不可达，暂无法自动清理旧节点工作区。',
            binding_epoch_mismatch: '节点绑定状态已变化，请刷新页面后重试。',
            invalid_node_labels: '节点调度标签格式无效。',
          })[code] || readErrorText(err);
          announceSave(feedback, reason, true);
        } finally {
          if (live()) submit.disabled = data.nodes.length <= 1;
        }
      });
      controls.push(form);
    } else {
      controls.push(note('当前项目绑定节点由超级管理员统一维护；如需迁移节点请联系超级管理员。'));
    }

    body.replaceChildren(badges, rows, ...controls);
  };

  const loadBinding = async () => {
    try {
      const data = await api(`/api/repositories/${id}/node`);
      if (!live()) return;
      renderBinding(data);
    } catch (err) {
      if (!live()) return;
      body.replaceChildren(note('读取计算节点绑定失败：' + readErrorText(err)));
    }
  };
  void loadBinding();
  return section;
}

// #1322: Per-project isolated read-only binary tools volume (/opt/project-tools).
// Streaming upload directly to the control plane, immutable revisions, idle rotation, and 3-revision rollback.
function projectToolsCard(canConfigure) {
  const target = current, id = target.id, token = typeof renderToken === 'number' ? renderToken : 0;
  const section = card('项目工具卷（/opt/project-tools）');
  section.dataset.testid = 'machine-project-tools';
  const guidance = element('div', '', 'project-tools-guidance');
  const guidanceTitle = element('strong', '工具配置优先级（先系统、再预编译镜像、最后才用项目工具卷）');
  const guidanceList = element('ol', '', 'project-tools-priority-list');
  for (const line of [
    '优先使用基础镜像已预装的通用工具链（Node.js、Python/uv、git、gh、gcc/make、ripgrep、jq、Chromium 等）。',
    '凡可通过 Debian apt 或在线/内网软件源声明式安装的软件与 SDK，优先在上方「软件与初始化」配置 packages 与 setup_script 预编译缓存。',
    '仅当需要私有、离线或闭源预编译二进制工具时，才上传到本项目工具卷。工具卷按项目严格隔离、只读挂载在 /opt/project-tools（/opt/project-tools/bin 追加在 PATH 末尾，绝不覆盖系统工具）；群聊助手仅只读挂载已授权项目到 /opt/project-tools/<owner>__<repo>；更新后等待空闲整卷轮换，不中断正在执行的任务。',
  ]) guidanceList.append(element('li', line));
  guidance.append(guidanceTitle, guidanceList);
  section.append(guidance);

  const summaryHost = element('div', '', 'project-tools-summary');
  summaryHost.append(note('正在读取项目工具卷状态…'));
  const feedback = element('p', '', 'muted');
  feedback.setAttribute('role', 'status');
  const uploadHost = element('div', '', 'project-tools-upload');
  const filesHost = element('div', '', 'project-tools-files');
  const historyHost = element('div', '', 'project-tools-history');
  section.append(summaryHost, feedback, uploadHost, filesHost, historyHost);

  const live = () => current === target && (typeof renderToken !== 'number' || renderToken === token) && section.isConnected;
  const fmtBytes = value => {
    if (!Number.isFinite(value) || value < 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toLocaleString('zh-CN', { maximumFractionDigits: i ? 2 : 0 }) + ' ' + units[i];
  };
  const modeLabel = mode => mode === 'replace' ? '整卷替换' : mode === 'merge' ? '增量合并' : String(mode || '—');
  const sourceLabel = src => ({ console: '控制台上传', assistant: '管理助手', api: 'API' }[src] || String(src || '—'));
  const isArchiveName = name => /\.(?:tar\.gz|tgz|zip)$/i.test(String(name || ''));

  const renderState = data => {
    const writable = canConfigure && data?.can_manage !== false && data?.available !== false;
    summaryHost.replaceChildren();
    const badges = element('div', '', 'actions project-tools-badges');
    badges.append(
      data?.active_revision ? badge(`当前版本 rev-${data.active_revision}`, 'success') : badge('未配置工具卷', ''),
      ...(data?.tools_pending === true
        ? [badge(`等待空闲切换（运行中 ${data.applied_revision ? 'rev-' + data.applied_revision : '未挂载'} → 目标 ${data.active_revision ? 'rev-' + data.active_revision : '清空'}）`, 'warning')]
        : data?.tools_pending === null || data?.rotation_status === 'unknown'
          ? [badge('轮换状态未知（manager 暂不可达）', '')]
          : data?.applied_revision
            ? [badge(`容器已挂载 rev-${data.applied_revision}`, 'info')]
            : []),
      ...(data?.available === false ? [badge('控制面未挂载 project-tools 卷', 'danger')] : []),
    );
    const used = Number(data?.used_bytes) || 0;
    const quota = Number(data?.quota_bytes) || 0;
    const pct = quota > 0 ? Math.min(100, Math.round(used / quota * 1000) / 10) : 0;
    summaryHost.append(
      badges,
      facts([
        ['挂载路径（只读）', `${data?.mount_path || '/opt/project-tools'}（bin/ 位于 PATH 末尾）`],
        ['当前容量 / 配额', `${fmtBytes(used)} / ${data?.quota_gb ?? 20} GiB（${pct}%） · ${data?.files_count ?? 0} 个文件`],
        ['历史保留策略', `保留当前生效版本与最近 ${data?.retain_previous ?? 3} 个历史版本供回滚；更早未挂载版本自动回收`],
        ['最近更新', data?.updated_at ? `${timestamp(data.updated_at)}${(data.updated_by_label || data.updated_by) ? ' · ' + (data.updated_by_label || data.updated_by) : ''}` : '尚未发布'],
      ]),
    );
    if (!canConfigure || data?.can_manage === false) {
      summaryHost.append(note('当前账号为只读权限：仅本项目管理员或超级管理员可上传、删除或回滚项目工具卷。'));
    }

    uploadHost.replaceChildren();
    if (writable) {
      const formEl = element('form', '', 'project-tools-form');
      formEl.dataset.testid = 'project-tools-upload-form';
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.name = 'tool_file';
      fileInput.dataset.testid = 'project-tools-file';

      const modeSelect = document.createElement('select');
      modeSelect.name = 'tool_mode';
      modeSelect.dataset.testid = 'project-tools-mode';
      modeSelect.add(new Option('增量合并（保留未改动文件，覆盖同名文件）', 'merge'));
      modeSelect.add(new Option('整卷替换（清空旧文件并发布新快照）', 'replace'));

      const kindSelect = document.createElement('select');
      kindSelect.name = 'tool_kind';
      kindSelect.dataset.testid = 'project-tools-kind';
      kindSelect.add(new Option('单文件上传', 'file'));
      kindSelect.add(new Option('压缩包安全解压（.tar.gz / .tgz / .zip）', 'archive'));

      const targetPathInput = input('tool_target_path', '', {
        placeholder: '例如 bin/my-cli（留空默认使用原文件名）',
        spellcheck: false,
      });
      targetPathInput.dataset.testid = 'project-tools-target-path';
      const targetPathWrap = field('目标相对路径（仅单文件）', targetPathInput);

      const execWrap = checkbox('tool_executable', true, '赋予可执行权限（chmod +x，推荐用于 bin/ 下的工具）');
      const execInput = execWrap.querySelector('input');
      execInput.dataset.testid = 'project-tools-executable';

      const noteInput = input('tool_note', '', { placeholder: '可选：说明工具名称、版本或用途', maxLength: 500 });
      noteInput.dataset.testid = 'project-tools-note';

      const syncKindControls = () => {
        const isFile = kindSelect.value === 'file';
        targetPathWrap.hidden = !isFile;
        execWrap.hidden = !isFile;
      };
      fileInput.addEventListener('change', () => {
        const picked = fileInput.files?.[0];
        if (!picked) return;
        kindSelect.value = isArchiveName(picked.name) ? 'archive' : 'file';
        if (kindSelect.value === 'file' && !targetPathInput.value.trim()) {
          targetPathInput.value = 'bin/' + picked.name;
        }
        syncKindControls();
      });
      kindSelect.addEventListener('change', syncKindControls);
      syncKindControls();

      const submitBtn = element('button', '流式上传并发布新版本', 'btn-primary');
      submitBtn.type = 'submit';
      submitBtn.dataset.testid = 'project-tools-upload-submit';

      const actionsRow = element('div', '', 'actions');
      actionsRow.append(submitBtn);
      if (data?.active_revision) {
        const clearBtn = button('清空工具卷', async () => {
          if (typeof askConfirm === 'function' && !await askConfirm({
            title: '清空本项目工具卷？',
            body: ['清空后项目电脑与群聊助手将在空闲轮换时卸载 /opt/project-tools；历史版本仍按保留策略留存以便回滚。'],
            action: '确认清空',
            danger: true,
          })) return;
          clearBtn.disabled = true;
          try {
            const res = await api(`/api/repositories/${id}/tools/clear`, 'POST', { confirm: true });
            if (!live()) return;
            feedback.className = 'view-success';
            feedback.textContent = '已清空当前生效工具卷，容器将在空闲后自动卸载。';
            renderState(res?.state || await api(`/api/repositories/${id}/tools`));
            void refreshProjectStatus(renderToken);
          } catch (err) {
            if (!live()) return;
            feedback.className = 'view-error';
            feedback.textContent = '清空失败：' + readErrorText(err);
            clearBtn.disabled = false;
          }
        }, 'btn-danger');
        clearBtn.dataset.testid = 'project-tools-clear';
        actionsRow.append(clearBtn);
      }

      const grid = element('div', '', 'field-grid');
      grid.append(field('选择文件或压缩包（流式直传，支持大包）', fileInput), field('发布模式', modeSelect), field('处理方式', kindSelect), targetPathWrap);
      formEl.append(element('h4', '上传与发布'), grid, execWrap, field('变更说明（可选）', noteInput), note('上传过程自动阻止路径穿越、符号链接逃逸、敏感凭据文件（如 .env / *.pem / *.key / id_rsa）与已登记密钥明文。'), actionsRow);

      formEl.addEventListener('submit', async event => {
        event.preventDefault();
        const file = fileInput.files?.[0];
        if (!file) {
          feedback.className = 'view-error';
          feedback.textContent = '请先选择要上传的文件或压缩包（.tar.gz / .tgz / .zip）。';
          return;
        }
        submitBtn.disabled = true;
        feedback.className = 'muted';
        feedback.textContent = `正在流式上传 ${file.name}（${fmtBytes(file.size)}）并执行安全校验…`;
        try {
          const qs = new URLSearchParams({
            mode: modeSelect.value,
            kind: kindSelect.value,
            filename: file.name,
          });
          if (kindSelect.value === 'file') {
            const rel = targetPathInput.value.trim();
            if (rel) qs.set('target_path', rel);
            if (execInput.checked) qs.set('executable', '1');
          }
          if (noteInput.value.trim()) qs.set('note', noteInput.value.trim());
          const response = await fetch(`/api/repositories/${id}/tools/upload?${qs.toString()}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              ...(me ? { 'X-CSRF-Token': me.csrf_token } : {}),
            },
            body: file,
          });
          let payload;
          try { payload = await response.json(); } catch { payload = null; }
          if (!live()) return;
          if (!response.ok) {
            if (typeof isSessionExpiry === 'function' && isSessionExpiry(response.status, payload?.error)) markSessionExpired();
            const code = payload?.error || `HTTP ${response.status}`;
            const detail = payload?.detail ? `（${payload.detail}）` : '';
            throw new Error(`${response.status} · ${code}${detail}`);
          }
          feedback.className = 'view-success';
          feedback.textContent = `已发布 rev-${payload.revision}（共 ${payload.files_count} 个文件，${fmtBytes(payload.total_bytes)}）。项目电脑将在空闲后自动切换，不中断在途任务。`;
          renderState(payload.state || await api(`/api/repositories/${id}/tools`));
          void refreshProjectStatus(renderToken);
        } catch (err) {
          if (!live()) return;
          feedback.className = 'view-error';
          feedback.textContent = '上传发布失败：' + readErrorText(err);
          submitBtn.disabled = false;
        }
      });
      uploadHost.append(formEl);
    }

    filesHost.replaceChildren();
    filesHost.append(element('h4', '当前文件清单'));
    const files = Array.isArray(data?.files) ? data.files : [];
    if (!files.length) {
      filesHost.append(note('当前工具卷为空。'));
    } else {
      const { table, body } = projectTable(writable ? ['路径', '类型与权限', '大小', '操作'] : ['路径', '类型与权限', '大小'], '项目工具卷文件清单');
      table.dataset.testid = 'project-tools-files-table';
      for (const file of files.slice(0, 200)) {
        const tr = document.createElement('tr');
        tableCell(tr, '路径', element('code', file.path));
        const permText = file.type === 'symlink'
          ? `相对软链 → ${file.target || ''}`
          : file.executable ? '可执行文件 (+x)' : '普通文件';
        tableCell(tr, '类型与权限', note(permText));
        tableCell(tr, '大小', note(file.type === 'symlink' ? '—' : fmtBytes(file.size)));
        if (writable) {
          const ops = element('div', '', 'actions');
          const delBtn = button('移除', async () => {
            if (typeof askConfirm === 'function' && !await askConfirm({
              title: `从工具卷移除 ${file.path}？`,
              body: ['移除将以增量合并方式生成新的不可变版本；原有历史版本仍可回滚。'],
              action: '确认移除',
              danger: true,
            })) return;
            delBtn.disabled = true;
            try {
              const res = await api(`/api/repositories/${id}/tools/delete-files`, 'POST', { paths: [file.path] });
              if (!live()) return;
              feedback.className = 'view-success';
              feedback.textContent = `已移除 ${file.path} 并发布 rev-${res.revision}。`;
              renderState(res.state || await api(`/api/repositories/${id}/tools`));
              void refreshProjectStatus(renderToken);
            } catch (err) {
              if (!live()) return;
              feedback.className = 'view-error';
              feedback.textContent = '移除失败：' + readErrorText(err);
              delBtn.disabled = false;
            }
          }, 'quiet destructive');
          ops.append(delBtn);
          tableCell(tr, '操作', ops);
        }
        body.append(tr);
      }
      filesHost.append(table);
      if (files.length > 200) filesHost.append(note(`当前共 ${files.length} 个文件，界面展示前 200 项。`));
    }

    historyHost.replaceChildren();
    historyHost.append(element('h4', '版本历史与一键回滚'));
    const revisions = Array.isArray(data?.revisions) ? data.revisions : [];
    if (!revisions.length) {
      historyHost.append(note('尚无已发布的工具卷版本。'));
    } else {
      const { table, body } = projectTable(writable ? ['版本', '方式', '内容', '来源', '发布时间', '说明', '操作'] : ['版本', '方式', '内容', '来源', '发布时间', '说明'], '项目工具卷版本历史');
      table.dataset.testid = 'project-tools-revisions-table';
      for (const rev of revisions) {
        const tr = document.createElement('tr');
        tr.dataset.revision = String(rev.revision);
        const revCell = element('div', '', 'actions');
        revCell.append(element('strong', `rev-${rev.revision}`));
        if (rev.revision === data?.active_revision) revCell.append(badge('当前生效', 'success'));
        tableCell(tr, '版本', revCell);
        tableCell(tr, '方式', note(modeLabel(rev.mode)));
        tableCell(tr, '内容', note(`${rev.files_count} 个文件 · ${fmtBytes(rev.total_bytes)}`));
        tableCell(tr, '来源', note(`${sourceLabel(rev.source)} · ${rev.actor_label || rev.actor}`));
        tableCell(tr, '发布时间', note(timestamp(rev.created_at) || '—'));
        tableCell(tr, '说明', note(rev.note || '—'));
        if (writable) {
          const ops = element('div', '', 'actions');
          if (rev.revision !== data?.active_revision) {
            const rbBtn = button('回滚到此版本', async () => {
              if (typeof askConfirm === 'function' && !await askConfirm({
                title: `回滚项目工具卷至 rev-${rev.revision}？`,
                body: ['回滚将立即切换目标版本，运行中的任务不受影响，项目电脑与群聊助手将在空闲后整卷轮换。'],
                action: '确认回滚',
              })) return;
              rbBtn.disabled = true;
              try {
                const res = await api(`/api/repositories/${id}/tools/rollback`, 'POST', { revision: rev.revision });
                if (!live()) return;
                feedback.className = 'view-success';
                feedback.textContent = `已将目标版本回滚至 rev-${rev.revision}，容器将在空闲后自动切换。`;
                renderState(res.state || await api(`/api/repositories/${id}/tools`));
                void refreshProjectStatus(renderToken);
              } catch (err) {
                if (!live()) return;
                feedback.className = 'view-error';
                feedback.textContent = '回滚失败：' + readErrorText(err);
                rbBtn.disabled = false;
              }
            }, 'btn-secondary');
            rbBtn.dataset.testid = `project-tools-rollback-${rev.revision}`;
            ops.append(rbBtn);
          } else {
            ops.append(note('—'));
          }
          tableCell(tr, '操作', ops);
        }
        body.append(tr);
      }
      historyHost.append(table);
    }
  };

  const load = async () => {
    try {
      const data = await api(`/api/repositories/${id}/tools`);
      if (!live()) return;
      renderState(data);
    } catch (err) {
      if (!live()) return;
      summaryHost.replaceChildren(element('p', '暂时无法读取项目工具卷状态：' + readErrorText(err), 'view-error'));
    }
  };
  void load();
  return section;
}

// #1260: Write-only editor for Claude Code / Codex local model configs in /workspace/home.
// Control plane never stores, reads back, or logs file contents; only existence/size/mtime are shown.
function cliConfigCard(canConfigure) {
  const target = current, id = target.id, token = typeof renderToken === 'number' ? renderToken : 0;
  const section = card('CLI 本地模型配置（项目电脑内自行配置）');
  section.dataset.testid = 'machine-cli-config';
  section.append(
    note('当 Claude Code 或 Codex 角色选择「项目电脑内自行配置（不注入模型配置）」时，运行前会从项目电脑的 /workspace/home 读取这里写入的配置文件并复制到当前会话隔离目录，运行结束后清除副本。'),
    note('安全说明：这些凭据存放在项目电脑的 /workspace/home 中，同一项目内任意 Agent 的原生 Shell 都可以读取。控制面不读取、不保存、不回显文件内容。'),
  );
  const statusHost = element('div', '', 'cli-config-status');
  statusHost.append(note('正在检查项目电脑内的 CLI 配置文件…'));
  const feedback = element('p', '', 'muted'); feedback.setAttribute('role', 'status');
  section.append(statusHost, feedback);

  const fileDefs = {
    claude_code: [
      ['settings.json', '.claude/settings.json（模型与基础配置）'],
      ['.credentials.json', '.claude/.credentials.json（认证凭据）'],
    ],
    codex: [
      ['config.toml', '.codex/config.toml（模型与提供方配置）'],
      ['auth.json', '.codex/auth.json（认证凭据）'],
    ],
  };

  let setEditorAvailability = () => {};
  const live = () => current === target && (typeof renderToken !== 'number' || renderToken === token) && section.isConnected;
  const loadStatus = async () => {
    try {
      const data = await api(`/api/environments/${id}/cli-config`);
      if (!live()) return;
      statusHost.replaceChildren();
      setEditorAvailability(Boolean(data?.available));
      if (!data?.available) {
        statusHost.append(note(`项目电脑当前未运行或暂不可访问（${data?.reason || 'unavailable'}），启动项目电脑后可检查与写入配置文件。`));
        return;
      }
      const { table, body } = projectTable(['CLI', '配置文件', '状态', '操作'], 'CLI 本地配置文件状态');
      for (const [cliId, cliTitle] of [['claude_code', 'Claude Code'], ['codex', 'Codex']]) {
        const files = data.clis?.[cliId]?.files || {};
        for (const [fileName] of fileDefs[cliId]) {
          const info = files[fileName] || { path: '', exists: false, bytes: null, updated_at: null };
          const row = document.createElement('tr');
          row.dataset.cli = cliId; row.dataset.file = fileName;
          tableCell(row, 'CLI', element('strong', cliTitle));
          tableCell(row, '配置文件', element('code', info.path || fileName));
          tableCell(row, '状态', info.exists
            ? note(`已存在（${info.bytes ?? 0} 字节${info.updated_at ? ' · 更新于 ' + timestamp(info.updated_at) : ''}）`)
            : note('未配置'));
          const opCell = element('div', '', 'actions');
          if (canConfigure && info.exists) {
            const delBtn = button('删除', async () => {
              if (typeof askConfirm === 'function' && !await askConfirm({
                title: `删除 ${info.path || fileName}？`,
                body: ['删除后使用「项目电脑内自行配置」的该 CLI 任务将无法读取此文件。'],
                action: '删除',
                danger: true,
              })) return;
              delBtn.disabled = true;
              try {
                await api(`/api/environments/${id}/cli-config`, 'DELETE', { cli: cliId, file: fileName });
                feedback.className = 'view-success';
                feedback.textContent = `已删除 ${info.path || fileName}`;
                await loadStatus();
              } catch (err) {
                feedback.className = 'view-error';
                feedback.textContent = '删除失败：' + readErrorText(err);
                delBtn.disabled = false;
              }
            }, 'quiet destructive');
            opCell.append(delBtn);
          } else {
            opCell.append(note('—'));
          }
          tableCell(row, '操作', opCell);
          body.append(row);
        }
      }
      statusHost.append(table);
    } catch (err) {
      if (!live()) return;
      setEditorAvailability(false);
      statusHost.replaceChildren(note('暂时无法检查 CLI 配置文件状态：' + readErrorText(err)));
    }
  };

  if (canConfigure) {
    const cliSelect = document.createElement('select'); cliSelect.name = 'cli_config_cli';
    for (const [val, label] of [['claude_code', 'Claude Code'], ['codex', 'Codex']]) cliSelect.add(new Option(label, val));
    const fileSelect = document.createElement('select'); fileSelect.name = 'cli_config_file';
    const syncFiles = () => {
      fileSelect.replaceChildren();
      for (const [val, label] of fileDefs[cliSelect.value] || []) fileSelect.add(new Option(label, val));
    };
    cliSelect.addEventListener('change', syncFiles); syncFiles();
    const contentBox = textarea('cli_config_content', '', {
      rows: 6,
      spellcheck: false,
      className: 'code',
      placeholder: '粘贴配置文件内容（仅写入项目电脑 /workspace/home，写入后自动清空输入框，控制面不保存、不回显）',
    });
    const writeBtn = button('写入配置文件', async () => {
      const content = contentBox.value;
      if (!content.trim()) { feedback.className = 'view-error'; feedback.textContent = '请先输入配置文件内容。'; return; }
      writeBtn.disabled = true;
      feedback.className = 'muted'; feedback.textContent = '正在写入项目电脑…';
      try {
        const res = await api(`/api/environments/${id}/cli-config`, 'PUT', {
          cli: cliSelect.value,
          file: fileSelect.value,
          content,
        });
        contentBox.value = '';
        feedback.className = 'view-success';
        feedback.textContent = `已写入 ${res?.path || fileSelect.value}（${res?.bytes ?? 0} 字节），输入框已清空。`;
        await loadStatus();
      } catch (err) {
        feedback.className = 'view-error';
        feedback.textContent = '写入失败：' + readErrorText(err);
      } finally {
        writeBtn.disabled = false;
      }
    });
    const editor = element('div', '', 'cli-config-editor');
    editor.append(field('CLI', cliSelect), field('目标文件', fileSelect), field('文件内容（只写不回显）', contentBox), writeBtn);
    setEditorAvailability = available => { writeBtn.disabled = !available; contentBox.disabled = !available; };
    setEditorAvailability(false);
    section.append(editor);
  }
  void loadStatus();
  return section;
}
// The concurrency form with its own save bar, for the page that cannot read the computer spec at all.
function concurrencyPage() {
  const concurrency = concurrencyForm(), page = element('div', '', 'machine-settings');
  page.append(concurrency); attachUnifiedSettingsBar(page, [concurrency]);
  return page;
}
// How many tasks this computer runs at once: the project's own value, or empty for the global default. Project
// administrators change it too; it never rebuilds the computer.
function concurrencyForm() {
  const own = current.policy.task_concurrency, fallback = current.concurrencyDefault;
  const value = input('task_concurrency', own ?? '', { type: 'number', min: 1, max: 32, step: 1, placeholder: `留空使用全局默认（${fallback}）` });
  return settingsForm('同时运行的任务', [field('这台虚拟电脑同时运行的任务数', value),
    note(`当前生效 ${own ?? fallback} 个（${own == null ? '全局默认' : '项目覆写'}）。这是项目任务并发，与角色并发限额分开。取 1–32，留空跟随全局默认；超出的任务继续排队。每个任务用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限；保存不会重建虚拟电脑。`)],
  form => { const text = form.elements.task_concurrency.value.trim(); return patchPolicy(changed({ task_concurrency: text === '' ? null : Number(text) }, { task_concurrency: own ?? null })); },
  { draftKey: 'concurrency', hideActions: true });
}
// Status cards of the machine section, re-rendered by the refresh loop without touching the form.
function machineStatus() {
  const environment = current.environment;
  const refresh = async event => { const control=event.currentTarget;control.disabled=true;try{await refreshProjectStatus(renderToken);}finally{control.disabled=false;} };
  const reload = button('刷新电脑状态', refresh);reload.id='computer-refresh';
  if (!environment) return [consoleState('电脑状态未知', '目前无法读取项目电脑记录，不能判断是否就绪。', { tone: 'error', retry: refresh, retryLabel: '刷新电脑状态', retryId: 'computer-refresh' })];
  const env = environment.environment, pc = env.computer || {}, machine = card('机器'), lifecycle = element('div', '', 'actions');
  const limit=(key,unit)=>typeof pc[key]==='number'&&Number.isFinite(pc[key])&&pc[key]>=0?pc[key]+' '+unit:'未知';
  const observed=environment.observation, available=observed?.status==='available'&&Object.hasOwn(states,observed.state)&&!current.environmentReadError;
  machine.append(facts([['实时核验',available&&observed.state?state(observed.state):'未知'],['核验完成于',timestamp(observed?.checked_at)||'未提供'],['资源上限',`${limit('cpus','CPU')} · 内存 ${limit('memory_mb','MB')} · 进程 ${limit('pids','个')} · /tmp ${limit('tmp_mb','MB')}`],
    ['读取说明',current.environmentReadError?'读取失败，保留上次记录，可能已过期。':observed?.status==='unavailable'?'manager 暂不可达（manager_unavailable），可重试连接核验。':observed?.status==='absent'?'manager 未找到电脑记录；这不能解释为电脑已停止。':observed?.status==='recovering'?'管理服务恢复中，尚未返回电脑状态（manager_not_ready）。':observed?.status==='error'?'管理服务返回异常，未能核验电脑状态（manager_read_failed）。':observed?.status==='available'&&!available?'管理服务报告了未识别的电脑状态。':!observed?'尚未获得实时核验结果。':null]]));
  machine.append(note('实时核验时间是本次读取完成时间，不是电脑心跳；就绪也不代表任务、QA 或远程检查成功。'),reload);
  const record=element('details','','fold');record.append(element('summary','查看电脑记录与技术信息'),facts([['状态记录',state(env.state)],['容器', pc.container], ['代次', env.generation ? 'g' + env.generation : '待创建'], ['启动于', timestamp(env.started_at)],
    ['工作卷', pc.volume ? `${pc.volume} → ${pc.workdir}` : null], ['网络', pc.network ? `${pc.network}（${networkText(pc)}）` : null], ['镜像', pc.image ? pc.image.slice(0, 19) : null],
    ['资源', pc.resources_pending ? '全局默认资源已改，等没有任务运行时按新值重建' : null],
    ['预编译镜像切换', pc.image_pending ? '新预编译镜像已就绪，等没有任务运行时自动切换（新任务暂缓认领）' : pc.toolchain_pending ? '预编译工具链构建/恢复中，暂缓认领新任务' : pc.toolchain_missing ? '预编译构建失败或已停止，当前缺少项目增量工具链（降级可认领任务）' : null],
    ['项目工具卷', pc.tools_pending ? `等待空闲整卷轮换（当前 ${pc.applied_tools_revision ? 'rev-' + pc.applied_tools_revision : '未挂载'} → 目标 ${pc.tools_revision ? 'rev-' + pc.tools_revision : '清空'}）` : pc.applied_tools_revision ? `rev-${pc.applied_tools_revision}（只读挂载于 /opt/project-tools）` : null],
    ['运行用户', pc.user], ['根文件系统', pc.root_filesystem === 'read-only' ? '只读；HOME 和工作区在工作卷中持久保存' : pc.root_filesystem], ['故障', environmentFault(env.error)]]));machine.append(record);
  if(pc.image)machine.append(collapsible('完整运行镜像',pc.image));
  environmentButtons(env, environment.running_tasks?.length > 0, reloadProject, error).forEach((control,index)=>{control.id='computer-action-'+index;if(!available)control.disabled=true;lifecycle.append(control);}); machine.append(lifecycle);
  const work=card('运行与排队记录'), count=value=>Array.isArray(value)?value.length:'未知';
  work.append(facts([['运行任务记录',count(environment.running_tasks)],['排队任务记录',count(environment.queued_tasks)]]),
    consoleLink(`#/projects/${current.id}/activity`,'查看运行与排队任务','与本页使用同一项目电脑记录'),note('任务记录与电脑连接分别读取；配置页的项目任务并发与角色容量是不同限制。'));
  const canConfigure = me.role === 'super_admin' || environment?.can_configure === true;
  return [machine, usageCard(), work, preparationCard(pc, available && !!env.computer, canConfigure)];
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
// Package image build and precompiled setup script progress: live status, streaming output, and manual cancel.
function preparationCard(pc, known = true, canConfigure = false) {
  const section = card('软件安装与初始化'), build = pc.build, setup = pc.setup;
  const phaseName = build?.phase === 'global' ? '全局基座层' : build?.phase === 'project' ? '项目增量层' : null;
  const buildState = {
    none: ['仅用基础镜像', ''],
    queued: [`排队等待构建${build?.queue_position ? `（第 ${build.queue_position} 位）` : ''}`, 'warning'],
    building: [`正在预编译镜像${phaseName ? `（${phaseName}）` : ''}`, 'info'],
    cancelling: ['正在停止构建', 'warning'],
    ready: ['预编译镜像已就绪', 'success'],
    failed: ['预编译构建失败', 'danger'],
    cancelled: ['构建已手动停止', 'warning'],
  }[build?.state] || ['未知', ''];
  const setupState = !known ? ['初始化状态未知', ''] : !setup ? ['没有初始化脚本', ''] : {
    running: ['初始化脚本运行中', 'info'],
    succeeded: [setup.mode === 'precompiled' ? '初始化脚本已预编译固化' : '初始化脚本成功', 'success'],
    failed: ['初始化脚本失败', 'danger'],
    cancelled: ['初始化构建已取消', 'warning'],
  }[setup.state] || [setup.state, ''];
  const head = element('div', '', 'actions'); head.append(badge(...buildState), badge(...setupState));
  if (canConfigure && (build?.can_cancel || ['queued', 'building'].includes(build?.state))) {
    const cancelBtn = button('停止构建', async event => {
      if (!await askConfirm({ title: '停止当前镜像构建？', body: ['正在排队或构建中的镜像任务会立即中止；当前正在运行的虚拟电脑和已有工作卷不受影响。'], action: '停止构建', danger: true })) return;
      const btn = event.currentTarget; btn.disabled = true;
      try {
        await api(`/api/environments/${current.id}/build/cancel`, 'POST', {});
        await refreshProjectStatus(renderToken);
      } catch (err) { btn.disabled = false; error(err); }
    }, 'danger');
    cancelBtn.id = 'computer-build-cancel';
    head.append(cancelBtn);
  }
  section.append(head);
  section.append(facts([
    ['镜像标签', build?.tag],
    ['构建阶段', phaseName],
    ['排队位置', build?.state === 'queued' && build?.queue_position ? `第 ${build.queue_position} 位（全局串行并发 1）` : null],
    ['开始时间', timestamp(build?.started_at)],
    ['最近更新', ['queued', 'building', 'cancelling'].includes(build?.state) ? timestamp(build?.updated_at) : null],
    ['构建完成', timestamp(build?.finished_at)],
    ['初始化方式', setup?.mode === 'precompiled' ? '构建期非特权预编译至 /opt/preinstalled（重置复用缓存）' : null],
  ]));
  const openOutput = ['building', 'cancelling', 'failed', 'cancelled'].includes(build?.state);
  if (build?.output) section.append(collapsible('构建输出', build.output, openOutput));
  if (setup?.output && setup?.mode !== 'precompiled') section.append(collapsible('初始化输出', setup.output, setup.state === 'failed'));
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
  const activeBuild = ['queued', 'building', 'cancelling'].includes(target.environment?.environment?.computer?.build?.state);
  projectTimer = setTimeout(() => refreshProjectStatus(token), activeBuild ? 2500 : 5000);
}

