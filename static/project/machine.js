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
  // An entry the field cannot accept must be reported, never read as「empty → follow the global default」: letters typed
  // into a number input leave .value empty without badInput, and a value the browser discards loses badInput too. The
  // invalid state is captured while typing, so a later submit cannot mistake it for an explicit clear.
  const number = (name, step) => {
    const control = input(name, own(name) ?? '', { type: 'number', step, min: pc.bounds?.[name]?.[0] ?? '', max: pc.bounds?.[name]?.[1] ?? '',
      placeholder: `留空使用全局默认（${pc.defaults?.[name] ?? pc[name]}）` });
    const emptyNote = () => '留空即跟随全局默认';
    const invalidNote = () => '这个字段只能填数字';
    const error = element('span', '', 'machine-config-error'), follow = element('span', '', 'machine-config-follow');
    error.id = `machine-${name}-error`; error.hidden = true; follow.textContent = emptyNote(); follow.hidden = control.value.trim() !== '';
    control.setAttribute('aria-describedby', error.id);
    // A refused entry stays refused until the user clears the field, deletes content it actually held, or enters a value
    // it now accepts. An empty value alone cannot be told apart from an explicit clear, and reading it as one is the
    // #865 defect: a paste fires `insertFromPaste` and then `input` with an empty value, and Backspace in an already
    // empty field fires only a delete, so neither may reset the rejection.
    let rejected = false;
    const render = () => {
      const accepted = control.value.trim() !== '' && Number.isFinite(Number(control.value.trim()));
      control.dataset.invalidNumber = rejected ? '1' : '';
      // A refused entry the field can still accept is released by the submit (#944); until then the message stays, but it
      // must not let the browser reject that submit before readSpec has had the chance to release it.
      control.setCustomValidity(rejected && !accepted ? invalidNote() : '');
      control.setAttribute('aria-invalid', rejected ? 'true' : 'false');
      error.textContent = rejected ? invalidNote() : '';
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
      if (rejected && text !== '' && Number.isFinite(Number(text))) release();
    };
    const clear = button('清空并跟随全局默认', () => { release(); control.value = ''; control.dispatchEvent(new Event('input', { bubbles: true })); control.focus(); }, 'quiet');
    clear.hidden = true;
    // Characters a number input cannot accept never reach .value and fire no input event; beforeinput still reports them.
    control.addEventListener('beforeinput', event => {
      const data = event.data ?? '';
      if ((event.inputType === 'insertText' || event.inputType === 'insertFromPaste') && data && !/^[0-9.eE+\-]+$/.test(data)) reject();
      // Deleting content the field actually held is an explicit clear; Backspace in an already empty field is not.
      else if ((event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') && control.value.trim() !== '') release();
    });
    control.addEventListener('input', () => {
      const text = control.value.trim();
      // badInput is the browser's own "cannot parse" flag; an entry it discards leaves the value empty but valid.
      if (control.validity.badInput || (text !== '' && !Number.isFinite(Number(text)))) reject();
      // Only text the field actually holds releases the refusal. An empty value is not a replacement: a paste over the
      // saved value drops the selection with the discarded text, so releasing on "changed from the refused value"
      // would let that empty field pass for an explicit clear (#903 review B1).
      else if (rejected && text !== '') release();
      else render();
    });
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
  fields.append(group('资源上限', isSuper ? '留空跟随全局默认（全局设置 → 工作电脑）。构建预编译镜像时也按此项目的 CPU 与内存上限执行。' : '资源上限由超级管理员统一管控，留空跟随全局默认；构建预编译镜像时按此处生效上限执行。', resourceGrid),
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
        if (control.dataset.invalidNumber === '1' || (text !== '' && !Number.isFinite(Number(text))))
          throw new Error(`${names[name]}：这个字段只能填数字`);
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
  const cliConfig = globalSettings ? null : cliConfigCard(canConfigure);
  const page = element('div', '', 'machine-settings');
  if (concurrency) page.append(concurrency);
  page.append(form);
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

