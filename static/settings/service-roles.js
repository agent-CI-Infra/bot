// One service role: its facts and usage, then the editor. Saving sends the revision it was drawn from, so an edit made
// elsewhere in the meantime is reported as a conflict instead of being overwritten.
const serviceRoleErrors = { service_role_permissions_fixed: '管理助手固定允许全部能力，实际操作仍受当前用户授权约束。', service_role_revision_conflict: '这个角色已被其他操作修改，请刷新本页、核对当前配置后重新保存。',
  shared_model_required: '只能选择部署共享模型。', builtin_service_role_required: '内置角色不能停用或删除。',
  service_role_permissions_moved: '群能做什么已改在每个群绑定的权限档位里设置（个人设置 → 飞书绑定），服务角色只保留提示词和模型。',
  project_model_required: '项目角色只能选择本项目的专属模型，或已授权给本项目的共享模型。' };
// The API's stable error codes, in words for the person who saved.
async function serviceRoleRequest(path, method, body) {
  try { return await api(path, method, body); }
  catch (err) {
    // #849: a group bound to this role reads projects the new model does not serve; say which.
    if (err.code === 'channel_service_model_unavailable') throw new Error(`这个模型没有授权给 ${(err.detail?.projects || []).join('、') || '用这个角色的群范围内的部分项目'}；用这个角色的群会因此停下，所以没有保存。请选择对这些项目都可用的模型，或先调整这些群。`);
    const code = /· (\w+)$/.exec(err.message)?.[1]; throw serviceRoleErrors[code] ? new Error(serviceRoleErrors[code]) : err;
  }
}

function serviceUsageText(usage) {
  if (!usage.requests) return '还没有模型请求';
  const parts = [`${metricNumber(usage.requests)} 次请求`, `输入 ${metricNumber(usage.input_tokens)} / 输出 ${metricNumber(usage.output_tokens)} tokens`];
  parts.push(usage.costs.length ? '费用 ' + usage.costs.map(cost => money(cost.amount, cost.currency)).join('，') : '费用未知');
  if (usage.unpriced_requests) parts.push(`${usage.unpriced_requests} 次未计价`);
  return parts.join(' · ');
}
// #1039: the role card is an h2 on the settings page (its page h1 is 全局设置) and an h3 on the Feishu bindings page,
// where buildProjectRolesSection draws it inside its own h3 card (static/channels/assistant-roles.js), so the caller
// names the level instead of inheriting the settings default.
function serviceRoleCard(view, initial, level = 'h3') {
  let role = initial;
  const live = liveCard(role.name, redraw => {
    const kind = [role.builtin ? badge('内置', 'info') : badge(role.project ? '项目角色' : '自定义', ''), role.enabled ? badge('已启用', 'success') : badge('已停用', 'warning')], head = element('p', '');
    head.append(...kind.flatMap(node => [node, ' ']));
    const model = role.model ? `${role.model.model_name} · ${hostOf(role.model.api_url)}${role.model.key_configured ? '' : '（Key 已撤销）'}` : '未配置';
    // Only the management assistant has items (all of them, within the user's own authority); a group's are on its binding (#849).
    const permissions = role.permissions_fixed ? '全部能力已允许' : '由每个群绑定的权限档位决定';
    const nodes = [head, facts([...(role.project ? [['所属项目', role.project.full_name]] : []), ['职责', role.responsibility || '—'], ['模型', model], ['权限', permissions],
      ['累计用量', serviceUsageText(role.usage)], ['最近请求', role.usage.last_requested_at ? timestamp(role.usage.last_requested_at) : null], ['配置版本', String(role.revision)]])];
    if (!role.model) nodes.push(element('p', '没有配置模型时，这个角色的对话会直接提示到这里配置，不会改用其他模型。', 'endpoint-warning'));
    const name = input('name', role.name, { maxLength: 80, required: true }), responsibility = textarea('responsibility', role.responsibility, { maxLength: 2000, rows: 2 });
    const prompt = textarea('prompt', role.prompt, { maxLength: 32000, rows: 4, placeholder: '附加在内置安全提示之后的说明；不能扩大工具或权限' });
    const modelSelect = document.createElement('select'), none = element('option', '不使用模型'); modelSelect.name = 'model_id'; none.value = ''; modelSelect.append(none);
    // A global template chooses among shared models; a project's role also among that project's own models (#849).
    for (const choice of view.modelsFor?.(role) ?? view.models) {
      const option = element('option', `${choice.model_name} · ${hostOf(choice.api_url)}${choice.repository_id ? '（项目专属）' : ''}${choice.key_configured ? '' : '（Key 已撤销）'}`); option.value = choice.id; modelSelect.append(option);
    }
    modelSelect.value = role.model_id ?? '';

    const harnessSelect=document.createElement('select');harnessSelect.name='harness';for(const [id,label] of [['native','Native（兼容）'],['pi','Pi'],['codex','Codex'],['claude_code','Claude Code']]){const option=element('option',label);option.value=id;harnessSelect.append(option);}harnessSelect.value=role.harness??'native';
    const grid = role.permissions_fixed ? permissionEditor(structuredClone(role.permissions), view.items, () => {}, '', true)
      : note('这个角色只提供提示词和模型。每个群能读还是能写，由群绑定的权限档位决定，在「个人设置 → 飞书绑定」的群绑定里设置。');
    const enabled = role.builtin ? null : checkbox('enabled', role.enabled, '启用');
    const remove = role.builtin ? null : button('删除角色', async () => {
      if (!await askConfirm({ title: `删除服务角色 ${role.name}？`, body: ['已记录的用量保留，仍按这个角色归属。'], action: '删除', danger: true })) return;
      remove.disabled = true;
      try { await serviceRoleRequest('/api/service-roles/' + role.id, 'DELETE', { expected_revision: role.revision }); live.section.replaceChildren(element(level, role.name), element('p', '已删除', 'view-success')); }
      catch (err) { remove.disabled = false; error(err); }
    }, 'quiet destructive');
    nodes.push(actionForm([field('名称', name), field('职责说明', responsibility), field('提示词', prompt), field('Agent 后端',harnessSelect), field(role.project ? '模型（本项目可用的模型）' : '模型（部署共享模型）', modelSelect),
      grid,
      ...(enabled ? [enabled] : [])], '保存', async () => {
      const change = { expected_revision: role.revision, harness:harnessSelect.value, name: name.value, responsibility: responsibility.value, prompt: prompt.value, model_id: modelSelect.value || null };
      if (enabled) change.enabled = enabled.querySelector('input').checked;
      role = (await serviceRoleRequest('/api/service-roles/' + role.id, 'PATCH', change)).service_role;
      live.section.querySelector(level).textContent = role.name; redraw('已保存');
    }, remove ? [remove] : []));
    return nodes;
  }, level);
  return live.section;
}
// #1039: the card the form inserts in place is a card of the calling page, so the page names its level too; the default
// stays h3 for the Feishu page, where the form is not rendered.
function serviceRoleCreate(view, level = 'h3') {
  const section = settingsCard('新建服务角色'), name = input('name', '', { maxLength: 80, required: true }), responsibility = textarea('responsibility', '', { maxLength: 2000, rows: 2 });
  section.append(note('新角色是一份提示词和模型，可以用在多个群里；每个群能做什么由它的群绑定的权限档位决定。保存后可以在它的卡片里选择模型和填写提示词。'),
    actionForm([field('名称', name), field('职责说明', responsibility)], '新建', async () => {
      if (!name.value.trim()) throw new Error('先填写名称');
      const created = (await serviceRoleRequest('/api/service-roles', 'POST', { name: name.value, responsibility: responsibility.value })).service_role;
      view.roles.push(created); section.before(serviceRoleCard(view, created, level)); name.value = ''; responsibility.value = '';
    }));
  return section;
}
