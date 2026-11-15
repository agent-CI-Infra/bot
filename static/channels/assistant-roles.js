// Project administrators keep group assistant roles for their own projects (#849): a prompt and a model, which may be the
// project's own model. Such a role fits only groups scoped to that project; what a group may do stays its binding's level.
// The cards are the service roles page's cards, with each role's models read from its project.
async function buildProjectRolesSection(data, changed) {
  const section = card('项目群助手角色'); section.setAttribute('aria-label', '项目群助手角色');
  section.append(note('项目管理员可以为自己的项目建群助手角色：一份提示词和一个模型，可以用本项目的专属模型。项目角色只能用在范围只有这个项目的群里；群能做什么仍由群绑定的权限档位决定。'));
  const roles = (await api('/api/service-roles')).service_roles.filter(role => role.project), models = new Map();
  // The models a project's role may use: the project's own and the shared models authorized to it.
  const modelsOf = async project => {
    if (!models.has(project)) models.set(project, (await api('/api/models?repository_id=' + encodeURIComponent(project))).models);
    return models.get(project);
  };
  for (const project of new Set(roles.map(role => role.project.id))) await modelsOf(project);
  const view = { roles, items: [], models: [], modelsFor: role => models.get(role.project.id) || [] };
  const list = element('div', '', 'feishu-project-roles');
  if (!roles.length) list.append(note('你的项目还没有自己的群助手角色。'));
  for (const role of roles) list.append(serviceRoleCard(view, role));
  const project = document.createElement('select'); project.name = 'project_id'; project.setAttribute('aria-label', '所属项目');
  for (const p of data.projects) project.add(new Option(p.full_name, p.id));
  const name = input('name', '', { maxLength: 80, required: true }), responsibility = textarea('responsibility', '', { maxLength: 2000, rows: 2 });
  const create = actionForm([field('所属项目', project), field('名称', name), field('职责说明', responsibility)], '新建项目角色', async () => {
    if (!name.value.trim()) throw new Error('先填写名称');
    await serviceRoleRequest('/api/service-roles', 'POST', { project_id: project.value, name: name.value, responsibility: responsibility.value });
    // The new role is offered in the group binding editor too, so both are drawn again.
    changed();
  });
  section.append(list, element('h4', '新建项目角色'), note('新角色保存后在它的卡片里选择模型和填写提示词。'), create);
  return section;
}
