// Project administrators keep group assistant roles for their own project inside Project Settings -> Roles (#849, #1232):
// a prompt and a model (including the project's own models). Such a role fits only groups scoped to that project;
// what a group may do stays in its group binding configuration on #/identity/feishu.
async function buildProjectRolesSection(project, changed) {
  const section = card('项目群助手角色', 'h2');
  section.setAttribute('aria-label', '项目群助手角色');
  const headActions = element('div', '', 'feishu-page-actions');
  headActions.append(channelLink('#/identity/feishu', '前往飞书绑定', 'button-link quiet'));
  if (me?.role === 'super_admin') headActions.append(channelLink('#/settings/service-roles', '全局服务角色', 'button-link quiet'));
  section.append(
    note(`为 ${project.full_name} 创建专属的飞书群聊助手角色（一份提示词和一个模型，可使用本项目专属模型或已授权的共享模型）。项目角色只能用于范围仅包含本项目的飞书群；群能做什么由「个人设置 → 飞书绑定」中的群权限配置决定。`),
    headActions,
  );
  const [{ service_roles: allRoles }, { models }] = await Promise.all([
    api('/api/service-roles'),
    api('/api/models?repository_id=' + encodeURIComponent(project.id)),
  ]);
  const roles = allRoles.filter(role => role.project?.id === project.id);
  const view = { roles, items: [], models, modelsFor: () => models };
  const list = element('div', '', 'feishu-project-roles');
  if (!roles.length) list.append(note('本项目还没有专属群助手角色。'));
  for (const role of roles) list.append(serviceRoleCard(view, role));
  const name = input('name', '', { maxLength: 80, required: true }), responsibility = textarea('responsibility', '', { maxLength: 2000, rows: 2 });
  const create = actionForm([field('名称', name), field('职责说明', responsibility)], '新建项目角色', async () => {
    if (!name.value.trim()) throw new Error('先填写名称');
    await serviceRoleRequest('/api/service-roles', 'POST', { project_id: project.id, name: name.value, responsibility: responsibility.value });
    changed();
  });
  section.append(list, element('h3', '新建项目角色'), note('新角色保存后在它的卡片里选择模型和填写提示词。'), create);
  return section;
}
