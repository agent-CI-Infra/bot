// Global management assistant editor (#1249). Saving sends expected_revision so concurrent edits report a conflict.
const serviceRoleErrors = { service_role_permissions_fixed: '管理助手固定允许全部能力，实际操作仍受当前用户授权约束。', service_role_revision_conflict: '配置已被其他操作修改，请刷新本页、核对当前配置后重新保存。',
  shared_model_required: '只能选择部署共享模型。', builtin_service_role_required: '管理助手不能停用或删除。',
  service_role_group_moved: '飞书群聊助手的模型与提示词已统一在「个人设置 → 飞书绑定」的各群绑定中直接配置。' };
async function serviceRoleRequest(path, method, body) {
  try { return await api(path, method, body); }
  catch (err) {
    const code = /· (\w+)$/.exec(err.message)?.[1]; throw serviceRoleErrors[code] ? new Error(serviceRoleErrors[code]) : err;
  }
}

function serviceUsageText(usage) {
  if (!usage?.requests) return '还没有模型请求';
  const parts = [`${metricNumber(usage.requests)} 次请求`, `输入 ${metricNumber(usage.input_tokens)} / 输出 ${metricNumber(usage.output_tokens)} tokens`];
  parts.push(usage.costs?.length ? '费用 ' + usage.costs.map(cost => money(cost.amount, cost.currency)).join('，') : '费用未知');
  if (usage.unpriced_requests) parts.push(`${usage.unpriced_requests} 次未计价`);
  return parts.join(' · ');
}
function serviceRoleCard(view, initial, level = 'h2') {
  let role = initial;
  const live = liveCard(role.name, redraw => {
    const head = element('p', '');
    head.append(badge('内置', 'info'), ' ', role.enabled ? badge('已启用', 'success') : badge('已停用', 'warning'));
    const model = role.model ? `${role.model.model_name} · ${hostOf(role.model.api_url)}${role.model.key_configured ? '' : '（Key 已撤销）'}` : '未配置';
    const nodes = [head, facts([['职责', role.responsibility || '—'], ['模型', model], ['权限', '全部能力已允许'],
      ['累计用量', serviceUsageText(role.usage)], ['最近请求', role.usage.last_requested_at ? timestamp(role.usage.last_requested_at) : null], ['配置版本', String(role.revision)]])];
    if (!role.model) nodes.push(element('p', '没有配置模型时，管理助手的对话会直接提示到这里配置，不会改用其他模型。', 'endpoint-warning'));
    const name = input('name', role.name, { maxLength: 80, required: true }), responsibility = textarea('responsibility', role.responsibility, { maxLength: 2000, rows: 2 });
    const prompt = textarea('prompt', role.prompt, { maxLength: 32000, rows: 4, placeholder: '附加在内置安全提示之后的说明；不能扩大工具或权限' });
    const modelSelect = document.createElement('select'), none = element('option', '不使用模型'); modelSelect.name = 'model_id'; none.value = ''; modelSelect.append(none);
    for (const choice of view.models) {
      const option = element('option', `${choice.model_name} · ${hostOf(choice.api_url)}${choice.key_configured ? '' : '（Key 已撤销）'}`); option.value = choice.id; modelSelect.append(option);
    }
    modelSelect.value = role.model_id ?? '';

    const harnessSelect = document.createElement('select'); harnessSelect.name = 'harness';
    for (const [id, label] of [['native', 'Native（兼容）'], ['pi', 'Pi'], ['codex', 'Codex'], ['claude_code', 'Claude Code']]) {
      const option = element('option', label); option.value = id; harnessSelect.append(option);
    }
    harnessSelect.value = role.harness ?? 'native';
    const computerWarning = harnessComputerWarning(harnessSelect);
    const grid = permissionEditor(structuredClone(role.permissions), view.items, () => {}, '', true);
    nodes.push(actionForm([field('名称', name), field('职责说明', responsibility), field('提示词', prompt), field('Agent 后端', harnessSelect), computerWarning, field('模型（部署共享模型）', modelSelect), grid], '保存', async () => {
      const change = { expected_revision: role.revision, harness: harnessSelect.value, name: name.value, responsibility: responsibility.value, prompt: prompt.value, model_id: modelSelect.value || null };
      role = (await serviceRoleRequest('/api/service-roles/' + role.id, 'PATCH', change)).service_role;
      live.section.querySelector(level).textContent = role.name; redraw('已保存');
    }));
    return nodes;
  }, level);
  return live.section;
}
