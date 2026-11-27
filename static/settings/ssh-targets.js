// Global SSH remote host pool (#1412): super-administrator settings page (#/settings/ssh-targets).
// Reuses shared SSH form, address summary and connectivity test helpers from static/project/ssh-targets.js.

async function sshTargetsSettingsPage(request) {
  const poolPath = '/api/ssh-targets';
  let rows = (await api(poolPath))?.targets || [];

  const section = settingsCard('全局 SSH 远程主机池', 'h2');
  section.dataset.testid = 'global-ssh-targets';

  const guidance = element('p', '整台虚拟电脑跑在远端 Linux Docker 主机上，请前往 ', 'ssh-targets-guidance');
  const computeNodesLink = settingsLink('#/settings/compute-nodes', '计算节点');
  computeNodesLink.dataset.testid = 'ssh-to-compute-nodes-link';
  guidance.append(computeNodesLink, '；任务内通过 ssh / scp / rsync 访问异构主机、测试机或嵌入式设备，请在此登记全局 SSH 主机。');

  const intro = note('全局主机由超级管理员在此统一登记、编辑、测试连通性与删除，所有变更即时生效。各项目在「项目设置 → 机器配置」按需绑定所需全局主机，也可单独维护仅归本项目使用的专属主机。每台主机使用一把专用私钥；连通性测试从控制面连接登记地址，核验主机指纹与凭据。');

  const toolbar = element('div', '', 'actions ssh-targets-toolbar');
  const status = element('p', '', 'ssh-target-status muted');
  status.setAttribute('role', 'status');
  const editorHost = element('div', '', 'ssh-target-editor-host');
  const listHost = element('div', '', 'ssh-targets-pool-list');

  const live = () => request === renderVersion && section.isConnected !== false;
  let listRevision = 0;

  const refresh = async (successText = '') => {
    const version = ++listRevision;
    const fresh = await api(poolPath);
    if (version !== listRevision || !live()) return;
    rows = Array.isArray(fresh?.targets) ? fresh.targets : [];
    editorHost.replaceChildren();
    renderList();
    if (successText) sshTargetAnnounce(status, successText, false);
  };

  const openEditor = target => {
    sshTargetAnnounce(status, '', false);
    const { form, focusField } = sshTargetEditorForm({
      target,
      available: rows,
      scopeLabel: '全局主机',
      headingLevel: 'h3',
      isLive: live,
      onCancel: () => editorHost.replaceChildren(),
      onSave: async body => {
        await api(poolPath + (target ? '/' + target.id : ''), target ? 'PUT' : 'POST', body);
        if (!live()) return;
        await refresh(target ? `已更新全局主机「${body.alias}」。` : `已新增全局主机「${body.alias}」。`);
      },
    });
    editorHost.replaceChildren(form);
    focusField.focus();
  };

  const addButton = button('新增全局主机', () => openEditor(null), 'btn-primary');
  const refreshButton = button('刷新列表', async () => {
    refreshButton.disabled = true;
    sshTargetAnnounce(status, '', false);
    try {
      await refresh();
    } catch (err) {
      if (live()) sshTargetAnnounce(status, '刷新失败：' + sshTargetErrorText(err), true);
    } finally {
      if (live()) refreshButton.disabled = false;
    }
  }, 'quiet');
  toolbar.append(addButton, refreshButton);

  const renderList = () => {
    if (!rows.length) {
      listHost.replaceChildren(note('尚未登记全局 SSH 主机。点击「新增全局主机」添加供各项目按需绑定的共享主机。'));
      return;
    }
    const aliasById = new Map(rows.map(row => [row.id, row.alias]));
    const { table, body } = projectTable(['别名', '地址', '连接方式', '已绑定项目', '操作'], '全局 SSH 远程主机池');
    table.classList.add('ssh-target-table', 'ssh-target-table-global');
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.dataset.sshId = row.id;
      tr.dataset.sshAlias = row.alias;
      tableCell(tr, '别名', element('strong', row.alias));
      tableCell(tr, '地址', sshTargetAddressCell(row, aliasById));
      tableCell(tr, '连接方式', element('span', sshRouteLabels[row.route] || row.route));

      const boundProjects = Array.isArray(row.bound_projects) ? row.bound_projects : [];
      const boundCell = element('div', '', 'ssh-bound-projects');
      if (!boundProjects.length) {
        boundCell.append(element('span', '未绑定项目', 'muted'));
      } else {
        for (const project of boundProjects) {
          const linkEl = settingsLink(`#/projects/${encodeURIComponent(project.id)}/machine`, project.full_name || project.id);
          linkEl.className = 'ssh-bound-project-link';
          boundCell.append(linkEl);
        }
      }
      tableCell(tr, '已绑定项目', boundCell);

      const actions = element('div', '', 'ssh-target-actions');
      actions.append(
        sshTargetTestButton(poolPath, row, actions, live),
        button('编辑', () => openEditor(row), 'quiet'),
      );
      const remove = button('删除', async () => {
        const confirmBody = [`地址：${row.username}@${row.host}:${row.port}`];
        if (boundProjects.length) {
          confirmBody.push(`当前有 ${boundProjects.length} 个项目绑定了此全局主机，删除后这些项目将立即解除绑定并失去访问权限：`);
          confirmBody.push(boundProjects.map(project => project.full_name || project.id));
        } else {
          confirmBody.push('删除后无法恢复。');
        }
        if (!await askConfirm({
          title: `删除全局 SSH 主机「${row.alias}」？`,
          body: confirmBody,
          action: '删除',
          danger: true,
        })) return;
        if (!live()) return;
        remove.disabled = true;
        sshTargetAnnounce(status, '', false);
        try {
          await api(`${poolPath}/${row.id}`, 'DELETE', {});
          if (!live()) return;
          await refresh(`已删除全局主机「${row.alias}」。`);
        } catch (err) {
          if (live()) sshTargetAnnounce(status, sshTargetErrorText(err), true);
        } finally {
          if (live()) remove.disabled = false;
        }
      }, 'quiet destructive');
      actions.append(remove);
      tableCell(tr, '操作', actions);
      body.append(tr);
    }
    listHost.replaceChildren(table);
  };

  renderList();
  section.append(guidance, intro, toolbar, status, editorHost, listHost);
  return [section];
}
