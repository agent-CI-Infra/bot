// Shared SSH remote host helpers (#1379, #1412), reused by the project「机器配置」card and
// global settings「SSH 远程主机」(#/settings/ssh-targets, loaded afterwards via static/settings.js).

const sshRouteLabels = { direct: '直连', proxy_jump: '跳板', tunnel: '控制面隧道' };
const sshAuthLabels = { key: '专用私钥', password: '密码' };
const sshErrorHints = {
  ssh_alias_in_use: '别名已被占用（ssh_alias_in_use），请更换其他别名。',
  ssh_target_in_use: '该主机正被其他主机用作跳板（ssh_target_in_use），请先修改或删除依赖它的主机。',
  ssh_key_reused: '每台主机须使用专用私钥，该私钥已登记到其他主机（ssh_key_reused）。',
  ssh_credential_required: '变更主机地址、端口、用户、主机指纹或认证方式时须重新填写凭据（ssh_credential_required）。',
  invalid_ssh_credential: '凭据格式无效：私钥须为未加密的 OpenSSH / PEM 格式，密码至少 4 个字符（invalid_ssh_credential）。',
  invalid_ssh_jump: '跳板主机无效或形成环路（invalid_ssh_jump）。',
  ssh_auth_mismatch: '认证方式与所填凭据字段不匹配（ssh_auth_mismatch）。',
  ssh_target_not_found: '目标 SSH 主机不存在或已删除（ssh_target_not_found）。',
};

function sshTargetErrorText(err) {
  const code = String(err?.code || err?.message || '');
  return sshErrorHints[code] || readErrorText(err);
}

function sshTargetAnnounce(target, text, failed = false) {
  target.className = 'ssh-target-status ' + (failed ? 'view-error' : text ? 'view-success' : 'muted');
  target.setAttribute('role', failed ? 'alert' : 'status');
  target.textContent = text;
}

function sshTargetSelect(choices, initial) {
  const control = document.createElement('select');
  for (const [value, label] of choices) control.add(new Option(label, value));
  control.value = initial;
  return control;
}

function sshTargetAddressCell(row, aliasById) {
  const wrap = element('div', '', 'ssh-address-cell');
  wrap.append(element('code', `${row.username}@${row.host}:${row.port}`));
  const parts = [sshAuthLabels[row.auth] || row.auth];
  const roles = Array.isArray(row.allowed_roles) ? row.allowed_roles : [];
  parts.push(roles.length ? '角色：' + roles.join(', ') : '未配置允许角色');
  if (row.route === 'proxy_jump' && row.jump_id) {
    parts.push('跳板：' + (aliasById?.get(row.jump_id) || row.jump_id.slice(0, 8)));
  }
  if (row.allow_untrusted_pr) parts.push('允许不可信 PR');
  wrap.append(element('p', parts.join(' · '), 'muted ssh-target-meta'));
  return wrap;
}

function sshTargetTestButton(basePath, row, actions, isLive = () => true) {
  const rowLive = () => isLive() && actions.isConnected !== false;
  const test = button('测试连通性', async () => {
    test.disabled = true;
    actions.querySelector('[data-ssh-test-status]')?.remove();
    const result = element('p', '正在测试…', 'muted');
    result.dataset.sshTestStatus = '1';
    result.setAttribute('role', 'status');
    actions.append(result);
    try {
      const reply = await api(`${basePath}/${row.id}/test`, 'POST', {});
      if (!rowLive()) return;
      if (reply.ok) sshTargetAnnounce(result, '认证成功', false);
      else sshTargetAnnounce(result, '测试失败：' + reply.error, true);
    } catch (err) {
      if (!rowLive()) return;
      sshTargetAnnounce(result, sshTargetErrorText(err), true);
    } finally {
      if (rowLive()) test.disabled = false;
    }
  });
  return test;
}

function sshTargetEditorForm({ target = null, available = [], scopeLabel, headingLevel = 'h4', onSave, onCancel, isLive = () => true }) {
  const form = element('form', '', 'project-form ssh-target-editor');
  form.dataset.testid = 'ssh-target-editor-form';
  const alias = input('alias', target?.alias ?? '', { required: true, placeholder: '如 board-01' });
  const host = input('host', target?.host ?? '', { required: true, placeholder: '如 10.0.1.25 或 lab.internal' });
  const port = input('port', target?.port ?? 22, { type: 'number', min: 1, max: 65535, required: true });
  const username = input('username', target?.username ?? '', { required: true, placeholder: '如 tester' });
  const pin = input('fingerprint', target?.host_key_sha256 ?? '', { required: true, placeholder: 'SHA256:…' });
  const roles = input('roles', (target?.allowed_roles || []).join(', '), { placeholder: '如 dev, qa' });
  const untrusted = checkbox('untrusted', target?.allow_untrusted_pr, '允许不可信 PR 使用此主机');
  const auth = sshTargetSelect([['key', '专用私钥'], ['password', '密码']], target?.auth ?? 'key');
  const route = sshTargetSelect([['direct', '直连'], ['proxy_jump', '登记的跳板主机'], ['tunnel', '经控制面隧道']], target?.route ?? 'direct');
  const jumpCandidates = available.filter(row => row.id !== target?.id);
  const jump = sshTargetSelect(
    [['', '请选择'], ...jumpCandidates.map(row => [row.id, row.owner_project ? row.alias : `${row.alias}${scopeLabel === '项目专属主机' ? '（全局主机）' : ''}`])],
    target?.jump_id ?? '',
  );
  const jumpField = field('跳板主机', jump);
  const jumpHint = note('当前尚无可选跳板主机，请先登记或绑定一台直连/隧道主机。');
  jumpHint.hidden = true;
  const credential = element('div', '');
  const formStatus = element('p', '', 'view-error');
  formStatus.setAttribute('role', 'status');
  let secret;

  function changeAuth() {
    secret = auth.value === 'key'
      ? textarea('private_key', '', { rows: 4, spellcheck: false, autocomplete: 'off', className: 'code', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' })
      : input('password', '', { type: 'password', autocomplete: 'new-password', minLength: 4 });
    secret.required = !target || target.auth !== auth.value;
    credential.replaceChildren(field(auth.value === 'key' ? 'SSH 私钥' : 'SSH 密码', secret));
    if (target) credential.append(note('保留原凭据请留空。更换主机、端口、用户、主机指纹或认证方式时需重新填写。'));
  }

  const changeRoute = () => {
    const isJump = route.value === 'proxy_jump';
    jumpField.hidden = !isJump;
    jump.required = isJump;
    jumpHint.hidden = !isJump || jumpCandidates.length > 0;
  };
  auth.addEventListener('change', changeAuth);
  route.addEventListener('change', changeRoute);
  changeAuth();
  changeRoute();

  const basicGrid = element('div', '', 'field-grid');
  basicGrid.append(
    field('别名', alias),
    field('主机地址', host),
    field('端口', port),
    field('用户名', username),
    field('主机公钥指纹', pin),
    field('允许角色（逗号分隔）', roles),
  );
  const policyGrid = element('div', '', 'field-grid');
  policyGrid.append(field('连接方式', route), jumpField, field('认证方式', auth));

  const save = element('button', '保存', 'btn-primary');
  save.type = 'submit';
  const cancel = button('取消', () => onCancel(), 'quiet');
  const formActions = element('div', '', 'actions form-actions');
  formActions.append(save, cancel);

  form.append(
    element(headingLevel, (target ? '编辑' : '新增') + scopeLabel, headingLevel === 'h3' ? 'card-sub' : ''),
    basicGrid,
    policyGrid,
    jumpHint,
    untrusted,
    credential,
    formStatus,
    formActions,
  );

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    sshTargetAnnounce(formStatus, '', false);
    if (route.value === 'proxy_jump' && !jump.value) {
      sshTargetAnnounce(formStatus, '请选择一台跳板主机。', true);
      jump.focus();
      return;
    }
    const body = {
      alias: alias.value.trim(),
      host: host.value.trim(),
      port: Number(port.value),
      username: username.value.trim(),
      host_key_sha256: pin.value.trim(),
      route: route.value,
      jump_id: route.value === 'proxy_jump' ? jump.value : null,
      auth: auth.value,
      allowed_roles: roles.value.split(/[\s,，]+/).filter(Boolean),
      allow_untrusted_pr: untrusted.querySelector('input').checked,
    };
    if (secret.value) body[secret.name] = secret.value;
    save.disabled = true;
    try {
      await onSave(body);
    } catch (err) {
      if (isLive()) sshTargetAnnounce(formStatus, sshTargetErrorText(err), true);
    } finally {
      if (isLive()) save.disabled = false;
    }
  });

  return { form, focusField: alias };
}

function sshTargetsCard(project, canManage) {
  const targetProject = typeof current !== 'undefined' ? current : null;
  const token = typeof renderToken === 'number' ? renderToken : 0;
  const root = card('SSH 远程主机');
  root.dataset.testid = 'machine-ssh-targets';
  const listing = element('div', '', 'ssh-targets-listing');
  const status = element('p', '', 'ssh-target-status muted');
  status.setAttribute('role', 'status');
  listing.append(note('正在读取 SSH 主机…'));
  root.append(
    note('项目电脑里的任务（含项目测试命令与独立 QA 门禁）可直接对已生效别名使用 ssh、scp、sftp、rsync：只有允许角色可用，不可信 PR 默认关闭。此处绑定与增删改操作即时生效，无需点击页面保存栏。'),
    status,
    listing,
  );

  const projectPath = '/api/repositories/' + project + '/ssh-targets';
  const poolPath = '/api/ssh-targets';
  let revision = 0;

  const live = () => (typeof current === 'undefined' || current === targetProject)
    && (typeof renderToken !== 'number' || renderToken === token)
    && root.isConnected !== false;

  async function act(control, action, successText = '') {
    if (control) control.disabled = true;
    sshTargetAnnounce(status, '', false);
    try {
      await action();
      if (!live()) return;
      await load();
      if (live() && successText) sshTargetAnnounce(status, successText, false);
    } catch (err) {
      if (live()) sshTargetAnnounce(status, sshTargetErrorText(err), true);
    } finally {
      if (control && live()) control.disabled = false;
    }
  }

  async function load() {
    const version = ++revision;
    const [projectList, pool] = await Promise.all([
      api(projectPath),
      canManage ? api(poolPath) : Promise.resolve({ targets: [] }),
    ]);
    if (version !== revision || !live()) return;

    const projectTargets = Array.isArray(projectList?.targets) ? projectList.targets : [];
    const poolTargets = Array.isArray(pool?.targets) ? pool.targets : [];
    const boundIds = new Set(projectTargets.filter(row => !row.owner_project).map(row => row.id));
    const ownTargets = projectTargets.filter(row => !!row.owner_project);
    const poolAliasMap = new Map(poolTargets.map(row => [row.id, row.alias]));
    const projectAliasMap = new Map(projectTargets.map(row => [row.id, row.alias]));

    // Section 1: Bindings to the platform global SSH host pool (bind/unbind only; no global CRUD here)
    const globalSection = element('section', '', 'ssh-targets-section');
    globalSection.dataset.testid = 'project-ssh-global-bindings';
    const globalHead = element('div', '', 'heading ssh-targets-subhead');
    globalHead.append(element('h4', '绑定全局主机'));
    if (canManage) {
      const manageLink = element('a', '管理全局 SSH 主机 →', 'button-link quiet');
      manageLink.href = '#/settings/ssh-targets';
      manageLink.dataset.testid = 'machine-ssh-global-link';
      globalHead.append(manageLink);
    }
    globalSection.append(
      globalHead,
      note(canManage
        ? '从平台全局 SSH 主机池按需绑定到本项目；全局主机的新增、编辑、连通性测试与删除请前往「全局设置 → SSH 远程主机」。'
        : '以下为本项目已绑定的全局 SSH 主机（只读）。全局主机的维护与绑定由超级管理员统一管理。'),
    );

    if (canManage) {
      if (!poolTargets.length) {
        globalSection.append(note('全局主机池尚未登记主机，可点击右上方链接前往全局设置登记。'));
      } else {
        const { table, body } = projectTable(['别名', '地址', '连接方式', '操作'], '绑定全局主机');
        table.classList.add('ssh-target-table', 'ssh-target-table-bind');
        for (const row of poolTargets) {
          const linked = boundIds.has(row.id);
          const tr = document.createElement('tr');
          tr.dataset.sshId = row.id;
          tr.dataset.sshAlias = row.alias;
          const aliasCell = element('div', '', 'ssh-alias-cell');
          aliasCell.append(element('strong', row.alias), badge(linked ? '已绑定' : '未绑定', linked ? 'success' : ''));
          tableCell(tr, '别名', aliasCell);
          tableCell(tr, '地址', sshTargetAddressCell(row, poolAliasMap));
          tableCell(tr, '连接方式', element('span', sshRouteLabels[row.route] || row.route));
          const actions = element('div', '', 'ssh-target-actions');
          const bind = button(linked ? '解除绑定' : '绑定', () =>
            act(
              bind,
              () => api(`${projectPath}/${row.id}/binding`, linked ? 'DELETE' : 'PUT', {}),
              linked ? `已解除绑定全局主机「${row.alias}」。` : `已绑定全局主机「${row.alias}」。`,
            ),
          linked ? 'quiet' : 'btn-secondary');
          actions.append(bind);
          tableCell(tr, '操作', actions);
          body.append(tr);
        }
        globalSection.append(table);
      }
    } else {
      const boundGlobals = projectTargets.filter(row => !row.owner_project);
      if (!boundGlobals.length) {
        globalSection.append(note('本项目尚未绑定全局主机。'));
      } else {
        const { table, body } = projectTable(['别名', '地址', '连接方式'], '已绑定的全局主机');
        table.classList.add('ssh-target-table', 'ssh-target-table-readonly');
        for (const row of boundGlobals) {
          const tr = document.createElement('tr');
          tr.dataset.sshId = row.id;
          tr.dataset.sshAlias = row.alias;
          const aliasCell = element('div', '', 'ssh-alias-cell');
          aliasCell.append(element('strong', row.alias), badge('已绑定', 'success'));
          tableCell(tr, '别名', aliasCell);
          tableCell(tr, '地址', sshTargetAddressCell(row, projectAliasMap));
          tableCell(tr, '连接方式', element('span', sshRouteLabels[row.route] || row.route));
          body.append(tr);
        }
        globalSection.append(table);
      }
    }

    // Section 2: Project-exclusive SSH hosts
    const ownSection = element('section', '', 'ssh-targets-section');
    ownSection.dataset.testid = 'project-ssh-own-targets';
    const ownEditor = element('div', '', 'ssh-target-editor-host');
    const openOwnEditor = target => {
      const { form, focusField } = sshTargetEditorForm({
        target,
        available: projectTargets,
        scopeLabel: '项目专属主机',
        headingLevel: 'h4',
        isLive: live,
        onCancel: () => ownEditor.replaceChildren(),
        onSave: async body => {
          await api(projectPath + (target ? '/' + target.id : ''), target ? 'PUT' : 'POST', body);
          if (!live()) return;
          await load();
          if (live()) sshTargetAnnounce(status, target ? `已更新项目专属主机「${body.alias}」。` : `已新增项目专属主机「${body.alias}」。`, false);
        },
      });
      ownEditor.replaceChildren(form);
      focusField.focus();
    };

    const ownHead = element('div', '', 'heading ssh-targets-subhead');
    ownHead.append(element('h4', '项目专属主机'));
    if (canManage) ownHead.append(button('新增项目专属主机', () => openOwnEditor(null), 'btn-secondary'));
    ownSection.append(
      ownHead,
      note('仅归本项目使用的专属 SSH 主机，不会对其他项目可见。' + (canManage ? '支持将已绑定的全局主机或本项目专属主机设为跳板机。' : '仅超级管理员可增删改或测试连通性。')),
      ownEditor,
    );

    if (!ownTargets.length) {
      ownSection.append(note('尚未登记项目专属主机。'));
    } else {
      const { table, body } = projectTable(canManage ? ['别名', '地址', '连接方式', '操作'] : ['别名', '地址', '连接方式'], '项目专属主机');
      table.classList.add('ssh-target-table', canManage ? 'ssh-target-table-project' : 'ssh-target-table-readonly');
      for (const row of ownTargets) {
        const tr = document.createElement('tr');
        tr.dataset.sshId = row.id;
        tr.dataset.sshAlias = row.alias;
        tableCell(tr, '别名', element('strong', row.alias));
        tableCell(tr, '地址', sshTargetAddressCell(row, projectAliasMap));
        tableCell(tr, '连接方式', element('span', sshRouteLabels[row.route] || row.route));
        if (canManage) {
          const actions = element('div', '', 'ssh-target-actions');
          actions.append(
            sshTargetTestButton(projectPath, row, actions, live),
            button('编辑', () => openOwnEditor(row), 'quiet'),
          );
          const remove = button('删除', async () => {
            if (!await askConfirm({
              title: `删除项目专属 SSH 主机「${row.alias}」？`,
              body: [`地址：${row.username}@${row.host}:${row.port}`, '删除后该项目任务将立即无法使用此主机，且无法恢复。'],
              action: '删除',
              danger: true,
            })) return;
            if (!live()) return;
            await act(remove, () => api(`${projectPath}/${row.id}`, 'DELETE', {}), `已删除项目专属主机「${row.alias}」。`);
          }, 'quiet destructive');
          actions.append(remove);
          tableCell(tr, '操作', actions);
        }
        body.append(tr);
      }
      ownSection.append(table);
    }

    listing.replaceChildren(globalSection, ownSection);
  }

  const startLoad = () => load().catch(err => {
    if (!live()) return;
    sshTargetAnnounce(status, '读取 SSH 主机失败：' + sshTargetErrorText(err), true);
    listing.replaceChildren(button('重新读取 SSH 主机', () => {
      sshTargetAnnounce(status, '', false);
      listing.replaceChildren(note('正在读取 SSH 主机…'));
      startLoad();
    }, 'quiet'));
  });
  startLoad();
  return root;
}
