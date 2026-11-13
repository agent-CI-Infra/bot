// One service role: its facts and usage, then the editor. Saving sends the revision it was drawn from, so an edit made
// elsewhere in the meantime is reported as a conflict instead of being overwritten.
const serviceRoleErrors = { service_role_permissions_fixed: '管理助手固定允许全部能力，实际操作仍受当前用户授权约束。', service_role_revision_conflict: '这个角色已被其他操作修改，请刷新本页、核对当前配置后重新保存。',
  shared_model_required: '只能选择部署共享模型。', builtin_service_role_required: '内置角色不能停用或删除。', invalid_service_role_budget: '预算金额需要大于 0。' };
// The API's stable error codes, in words for the person who saved.
async function serviceRoleRequest(path, method, body) {
  try { return await api(path, method, body); }
  catch (err) { const code = /· (\w+)$/.exec(err.message)?.[1]; throw serviceRoleErrors[code] ? new Error(serviceRoleErrors[code]) : err; }
}
const serviceBudgetText = budget => budget ? money(budget.limit_amount, budget.currency) + '（累计）' : '不限额';
function serviceUsageText(usage) {
  if (!usage.requests) return '还没有模型请求';
  const parts = [`${metricNumber(usage.requests)} 次请求`, `输入 ${metricNumber(usage.input_tokens)} / 输出 ${metricNumber(usage.output_tokens)} tokens`];
  parts.push(usage.costs.length ? '费用 ' + usage.costs.map(cost => money(cost.amount, cost.currency)).join('，') : '费用未知');
  if (usage.unpriced_requests) parts.push(`${usage.unpriced_requests} 次未计价`);
  return parts.join(' · ');
}
function serviceRoleCard(view, initial) {
  let role = initial;
  const live = liveCard(role.name, redraw => {
    const kind = [role.builtin ? badge('内置', 'info') : badge('自定义', ''), role.enabled ? badge('已启用', 'success') : badge('已停用', 'warning')], head = element('p', '');
    head.append(...kind.flatMap(node => [node, ' ']));
    const model = role.model ? `${role.model.model_name} · ${hostOf(role.model.api_url)}${role.model.key_configured ? '' : '（Key 已撤销）'}` : '未配置';
    const permissions = role.permissions_fixed ? '全部能力已允许' : view.items.map(item => `${item.name}：${permissionModeLabels[role.permissions[item.id]] ?? role.permissions[item.id]}`).join('；');
    const nodes = [head, facts([['职责', role.responsibility || '—'], ['模型', model], ['权限', permissions], ['预算', serviceBudgetText(role.budget)],
      ['累计用量', serviceUsageText(role.usage)], ['最近请求', role.usage.last_requested_at ? timestamp(role.usage.last_requested_at) : null], ['配置版本', String(role.revision)]])];
    if (!role.model) nodes.push(element('p', '没有配置模型时，这个角色的对话会直接提示到这里配置，不会改用其他模型。', 'endpoint-warning'));
    const name = input('name', role.name, { maxLength: 80, required: true }), responsibility = textarea('responsibility', role.responsibility, { maxLength: 2000, rows: 2 });
    const prompt = textarea('prompt', role.prompt, { maxLength: 32000, rows: 4, placeholder: '附加在内置安全提示之后的说明；不能扩大工具或权限' });
    const modelSelect = document.createElement('select'), none = element('option', '不使用模型'); modelSelect.name = 'model_id'; none.value = ''; modelSelect.append(none);
    for (const shared of view.models) { const option = element('option', `${shared.model_name} · ${hostOf(shared.api_url)}${shared.key_configured ? '' : '（Key 已撤销）'}`); option.value = shared.id; modelSelect.append(option); }
    modelSelect.value = role.model_id ?? '';
    const currency = document.createElement('select'); currency.name = 'budget_currency';
    for (const value of ['USD', 'CNY']) { const option = element('option', value); option.value = value; currency.append(option); }
    currency.value = role.budget?.currency ?? 'USD';
    const amount = input('budget_limit', role.budget?.limit_amount ?? '', { type: 'number', min: 0, step: 'any', placeholder: '留空表示不限额' });
    const budget = element('div', '', 'field-grid'); budget.append(field('预算币种', currency), field('预算上限', amount));
    const editedPermissions = structuredClone(role.permissions);
    const grid = permissionEditor(editedPermissions, view.items, () => {}, '', role.permissions_fixed);
    const enabled = role.builtin ? null : checkbox('enabled', role.enabled, '启用');
    const remove = role.builtin ? null : button('删除角色', async () => {
      if (!await askConfirm({ title: `删除服务角色 ${role.name}？`, body: ['已记录的用量保留，仍按这个角色归属。'], action: '删除', danger: true })) return;
      remove.disabled = true;
      try { await serviceRoleRequest('/api/service-roles/' + role.id, 'DELETE', { expected_revision: role.revision }); live.section.replaceChildren(element('h3', role.name), element('p', '已删除', 'view-success')); }
      catch (err) { remove.disabled = false; error(err); }
    }, 'quiet destructive');
    nodes.push(actionForm([field('名称', name), field('职责说明', responsibility), field('提示词', prompt), field('模型（部署共享模型）', modelSelect),
      grid,
      budget, ...(enabled ? [enabled] : [])], '保存', async () => {
      const limit = amount.value.trim();
      if (limit && !(Number(limit) > 0)) throw new Error('预算金额需要大于 0，留空表示不限额');
      const change = { expected_revision: role.revision, name: name.value, responsibility: responsibility.value, prompt: prompt.value, model_id: modelSelect.value || null,
        budget: limit ? { currency: currency.value, limit_amount: Number(limit) } : null };
      if (!role.permissions_fixed) change.permissions = editedPermissions;
      if (enabled) change.enabled = enabled.querySelector('input').checked;
      role = (await serviceRoleRequest('/api/service-roles/' + role.id, 'PATCH', change)).service_role;
      live.section.querySelector('h3').textContent = role.name; redraw('已保存');
    }, remove ? [remove] : []));
    nodes.push(note('预算与项目管理预算的语义相同：累计用量达到上限即停止；存在无法计价的用量（模型没有价格、币种不同或请求结果未知）时也停止，不把未知费用当作零。'));
    return nodes;
  });
  return live.section;
}
function serviceRoleCreate(view) {
  const section = card('新建服务角色'), name = input('name', '', { maxLength: 80, required: true }), responsibility = textarea('responsibility', '', { maxLength: 2000, rows: 2 });
  section.append(note('新角色从仓库问答助手的权限开始：读当前会话记录和 GitHub，不访问其他角色的任务，不派活；保存后可以在它的卡片里修改。'),
    actionForm([field('名称', name), field('职责说明', responsibility)], '新建', async () => {
      if (!name.value.trim()) throw new Error('先填写名称');
      const created = (await serviceRoleRequest('/api/service-roles', 'POST', { name: name.value, responsibility: responsibility.value })).service_role;
      view.roles.push(created); section.before(serviceRoleCard(view, created)); name.value = ''; responsibility.value = '';
    }));
  return section;
}
