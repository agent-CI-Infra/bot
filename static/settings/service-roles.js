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
function serviceRoleSkillBundlesText(role, catalog) {
  const effective = Array.isArray(role.effective_skill_bundle_ids) ? role.effective_skill_bundle_ids : (role.default_skill_bundle_ids || []);
  const byId = new Map((catalog || []).map(b => [b.id, b]));
  const names = effective.map(id => byId.get(id)?.name ? `${byId.get(id).name}（${id}）` : id);
  const mode = role.skill_bundle_ids == null ? '默认配置' : '自定义';
  return `${names.length ? names.join('、') : '未绑定'}（${mode}）`;
}
function serviceRoleCard(view, initial, level = 'h2') {
  let role = initial;
  const live = liveCard(role.name, redraw => {
    const catalog = Array.isArray(view.skillBundles) ? view.skillBundles : [];
    const head = element('p', '');
    head.append(badge('内置', 'info'), ' ', role.enabled ? badge('已启用', 'success') : badge('已停用', 'warning'));
    const model = role.model ? `${modelChoiceName(role.model)}${role.model.key_configured ? '' : '（Key 已撤销）'}` : '未配置';
    const nodes = [head, facts([['职责', role.responsibility || '—'], ['Agent 后端', 'Pi'], ['模型', model], ['技能包', serviceRoleSkillBundlesText(role, catalog)], ['权限', '全部能力已允许'],
      ['累计用量', serviceUsageText(role.usage)], ['最近请求', role.usage.last_requested_at ? timestamp(role.usage.last_requested_at) : null], ['配置版本', String(role.revision)]])];
    if (!role.model) nodes.push(element('p', '没有配置模型时，管理助手的对话会直接提示到这里配置，不会改用其他模型。', 'endpoint-warning'));
    const name = input('name', role.name, { maxLength: 80, required: true }), responsibility = textarea('responsibility', role.responsibility, { maxLength: 2000, rows: 2 });
    const prompt = textarea('prompt', role.prompt, { maxLength: 32000, rows: 4, placeholder: '附加在内置安全提示之后的说明；不能扩大工具或权限' });
    const modelSelect = document.createElement('select'), none = element('option', '不使用模型'); modelSelect.name = 'model_id'; none.value = ''; modelSelect.append(none);
    for (const choice of view.models) {
      const option = element('option', `${modelChoiceName(choice)}${choice.key_configured ? '' : '（Key 已撤销）'}`); option.value = choice.id; modelSelect.append(option);
    }
    modelSelect.value = role.model_id ?? '';

    const defaultIds = Array.isArray(role.default_skill_bundle_ids) ? role.default_skill_bundle_ids : [];
    const initialIds = Array.isArray(role.effective_skill_bundle_ids) ? role.effective_skill_bundle_ids : defaultIds;
    let followDefaultSkills = role.skill_bundle_ids == null;
    const skillBundleChecks = new Map();
    const skillFieldset = element('fieldset', '', 'role-choices service-skill-bundles');
    skillFieldset.dataset.testid = 'service-role-skill-bundles';
    skillFieldset.append(element('legend', '技能包'));
    const skillModeNote = note(followDefaultSkills ? '当前跟随内置默认技能包配置；勾选变更后保存为自定义，也可点击「恢复默认技能包」。' : '当前使用自定义技能包配置。');
    for (const bundle of catalog) {
      const feishuOnly = Array.isArray(bundle.channels) && bundle.channels.includes('feishu') && !bundle.channels.includes('web');
      const labelText = `${bundle.name}（${bundle.id}）${feishuOnly ? ' · 仅飞书渠道生效' : ''}`;
      const wrap = checkbox('service_skill_bundle:' + bundle.id, initialIds.includes(bundle.id), labelText);
      const ctrl = wrap.querySelector('input');
      ctrl.dataset.bundleId = bundle.id;
      ctrl.addEventListener('change', () => {
        followDefaultSkills = false;
        skillModeNote.textContent = '已调整技能包，保存后按当前勾选生效。';
      });
      skillBundleChecks.set(bundle.id, ctrl);
      skillFieldset.append(wrap);
      if (bundle.description) skillFieldset.append(note(`${bundle.description}（包含：${(bundle.skills || []).join('、')}）`));
    }
    if (catalog.length) {
      const resetSkills = button('恢复默认技能包', () => {
        followDefaultSkills = true;
        for (const [bid, ctrl] of skillBundleChecks) ctrl.checked = defaultIds.includes(bid);
        skillModeNote.textContent = '已恢复内置默认技能包，保存后自动跟随内置默认。';
      }, 'quiet');
      resetSkills.dataset.testid = 'reset-service-role-skills';
      skillFieldset.append(skillModeNote, resetSkills);
    }

    // The management assistant runs only on Pi (#1337): there is no backend to choose.
    const computerWarning = harnessComputerWarning();
    const grid = permissionEditor(structuredClone(role.permissions), view.items, () => {}, '', true);
    nodes.push(actionForm([field('名称', name), field('职责说明', responsibility), field('提示词', prompt), computerWarning, field('模型（部署共享模型）', modelSelect), ...(catalog.length ? [skillFieldset] : []), grid], '保存', async () => {
      const selectedBundles = followDefaultSkills
        ? null
        : [...skillBundleChecks].filter(([, ctrl]) => ctrl.checked).map(([bid]) => bid);
      const change = {
        expected_revision: role.revision,
        name: name.value,
        responsibility: responsibility.value,
        prompt: prompt.value,
        model_id: modelSelect.value || null,
        ...(catalog.length ? { skill_bundle_ids: selectedBundles } : {}),
      };
      role = (await serviceRoleRequest('/api/service-roles/' + role.id, 'PATCH', change)).service_role;
      live.section.querySelector(level).textContent = role.name; redraw('已保存');
    }));
    return nodes;
  }, level);
  return live.section;
}
