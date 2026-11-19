// Start requests (#933, #934): an administrator of a repository whose organization is not trusted confirmed its onboarding
// plan, and a super administrator decides here, at the top of 待处理. Approving starts the project with the model and level
// chosen (optionally trusting the organization, #848); the rest of the plan is then applied as the requester. Rejecting
// needs a reason, which the requester is told. Only super administrators can read or decide (src/management/api.ts).
async function renderStartRequests(holder, isCurrent = () => holder.isConnected) {
  if (me?.role !== 'super_admin') { holder.replaceChildren(); return; }
  let listed, models = [];
  try {
    [listed, models] = await Promise.all([api('/api/management/onboarding-requests'),
      api('/api/models').then(value => value.models.filter(model => model.repository_id === null && model.key_configured)).catch(() => [])]);
  } catch (err) {
    if (isCurrent()) holder.replaceChildren(consoleState('启动申请未能读取', readErrorText(err) + '。', { tone: 'error', retry: () => renderStartRequests(holder, isCurrent) }));
    return;
  }
  if (!isCurrent()) return;
  const requests = listed.requests;
  if (!requests.length) { holder.replaceChildren(); return; }
  const section = element('section', '', 'start-requests'); section.dataset.testid = 'start-requests';
  section.append(element('h2', `启动申请（${requests.length}）`), element('p', '这些仓库所属组织尚未受信任，仓库管理员在管理助手提交了启动申请，需要你同意才能启动。', 'muted'));
  for (const request of requests) section.append(startRequestCard(request, models, () => renderStartRequests(holder, isCurrent)));
  holder.replaceChildren(section);
}

function startRequestCeilingCaption(value) {
  return projectCeilingOptions.find(([level]) => level === value)?.[1] || value;
}

function startRequestCard(request, models, reload) {
  const card = element('article', '', 'start-request'); card.dataset.requestId = request.id;
  const summary = request.summary, name = request.repository.full_name || request.repository.id;
  const head = element('div', '', 'start-request-head');
  head.append(element('h3', name), element('span', '待处理', 'status status-warning'));
  card.append(head, element('p', `${(request.requested_by.github_login ? '@' + request.requested_by.github_login : request.requested_by.name || '管理员')} 于 ${timestamp(request.requested_at)} 申请${request.plan_version != null ? ` · 第 ${request.plan_version} 版方案` : ''}`, 'muted'));
  const facts = element('dl', '', 'start-request-facts');
  const fact = (term, value) => facts.append(element('dt', term), element('dd', value));
  fact('能力上限', summary.capability_ceiling ? startRequestCeilingCaption(summary.capability_ceiling) : '未指定（默认评论与标签）');
  if (request.plan_version != null) {
    fact('新建标签', summary.labels.length ? summary.labels.join('、') : '无');
    fact('定时检查', summary.schedules.length ? summary.schedules.join('、') : '无');
    fact('CI 建议', summary.ci ? '有，确认后转成开发任务（bot 开 PR，人合并）' : '无');
  }
  card.append(facts);
  if (summary.profile) {
    const profile = element('details', '', 'start-request-profile'), body = element('div', '', 'management-markdown');
    renderManagementMarkdown(body, summary.profile); profile.append(element('summary', '仓库画像'), body); card.append(profile);
  }
  const problem = element('p', '', 'view-error'); problem.setAttribute('role', 'alert');
  const slot = element('div', '', 'start-request-form');
  const decide = async (path, body, buttonNode, done) => {
    buttonNode.disabled = true; problem.textContent = '';
    try { await api(`/api/management/onboarding-requests/${request.id}/${path}`, 'POST', body); notice('message', done); await reload(); }
    catch (err) { buttonNode.disabled = false; problem.textContent = err.code === 'onboarding_request_closed' ? '这份申请已经被处理或已失效。' : err.code === 'rejection_reason_required' ? '请写明拒绝的原因。' : readErrorText(err); }
  };
  const approveForm = () => {
    const form = document.createElement('form'); form.className = 'start-request-decision';
    const model = document.createElement('select'); model.name = 'model';
    model.append(new Option('部署默认的接入模型', ''));
    for (const m of models) model.append(new Option(m.model_name + (m.onboarding_default ? '（接入默认）' : ''), m.id));
    const level = document.createElement('select'); level.name = 'level';
    for (const [value, caption] of projectCeilingOptions) level.append(new Option(caption, value, false, value === (summary.capability_ceiling || 'comment')));
    const trust = document.createElement('input'); trust.type = 'checkbox'; trust.name = 'trust';
    const trustLabel = element('label', '', 'start-request-trust'); trustLabel.append(trust, element('span', '同时信任这个组织：之后它的仓库由管理员自己启动，默认用这次选的模型和能力上限'));
    const submit = element('button', '确认同意并启动', 'btn-primary'); submit.type = 'submit';
    const cancel = button('取消', () => slot.replaceChildren(), 'quiet');
    const actions = element('div', '', 'actions'); actions.append(submit, cancel);
    form.append(field('模型', model), field('能力上限', level), trustLabel, actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void decide('approve', { ...(model.value ? { model_id: model.value } : {}), capability_ceiling: level.value, ...(trust.checked ? { trust_organization: true } : {}) }, submit, request.plan_version != null ? `已同意 ${name} 启动，方案其余各项正在应用。` : `已同意 ${name} 启动。`);
    });
    slot.replaceChildren(form); model.focus();
  };
  const rejectForm = () => {
    const form = document.createElement('form'); form.className = 'start-request-decision';
    const reason = textarea('reason', '', { rows: 3, maxLength: 2000, required: true, placeholder: '申请人会收到这段原因，例如需要先补 CI 或换一个组织' });
    const submit = element('button', '确认拒绝', 'btn-secondary'); submit.type = 'submit';
    const cancel = button('取消', () => slot.replaceChildren(), 'quiet');
    const actions = element('div', '', 'actions'); actions.append(submit, cancel);
    form.append(field('拒绝原因（必填）', reason), actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!reason.value.trim()) { problem.textContent = '请写明拒绝的原因。'; reason.focus(); return; }
      void decide('reject', { reason: reason.value.trim() }, submit, `已拒绝 ${name} 的启动申请，申请人会收到原因。`);
    });
    slot.replaceChildren(form); reason.focus();
  };
  const actions = element('div', '', 'actions start-request-actions');
  actions.append(button('同意…', approveForm, 'btn-primary'), button('拒绝…', rejectForm, 'btn-secondary'));
  card.append(actions, slot, problem);
  return card;
}
