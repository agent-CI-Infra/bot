// Project-wide event intake, independent of the Manager role editor. The existing API preserves saved choices/revisions.
const projectEventCaptions = [['actions.run_failed', '接收默认分支和版本标签的 Actions 失败事件'], ['issue.opened', 'Issue 打开'], ['issue.updated', 'Issue 修改或可信评论'], ['issue.mention', 'Issue 评论提到 bot'], ['issue.development_label', '有人加上开发标签'],
  ['pull_request.opened', 'PR 打开或 Ready for review'], ['pull_request.synchronize', 'PR 推送新提交'], ['pull_request.updated', 'PR 修改、讨论或检视'], ['pull_request.mention', 'PR 评论提到 bot'],
  ['review.published.issue', 'Issue 检视发布（可能开始开发）'], ['review.published.pr', 'bot PR 检视发布（可能修订 PR）']];

function projectTriggersSection() {
  const target = current, id = target.id, token = renderToken, holder = element('div', '', 'project-triggers-page');
  const message = element('p', '', 'view-error'); message.setAttribute('role', 'alert');
  const live = () => current === target && renderToken === token && current.section === 'triggers' && holder.isConnected;
  const refresh = async () => {
    try {
      const { manager } = await api(`/api/repositories/${id}/manager`);
      if (!live()) return;
      const intro = card('监听与触发');
      intro.append(note('这些设置决定项目整体接收哪些事件、允许启动哪些自动任务。接收后由 Manager 安排处理；关闭的来源保持关闭，项目启停、权限、预算及独立 QA 和发布检查继续生效。'));
      holder.replaceChildren(intro, projectWorkPolicyCard(), projectEventFiltersCard(manager, target, live), message);
      message.textContent = '';
    } catch (err) {
      if (!live()) return;
      holder.replaceChildren(consoleState('监听与触发配置读取失败', '当前状态未知，请重新读取。', { retry: refresh, retryLabel: '重新读取监听配置' }), message);
      message.textContent = projectTriggerError(err);
    }
  };
  holder.append(note('正在读取项目监听与触发配置…')); void refresh(); return [holder];
}
const projectTriggerError = err => {
  const code = err.code || /· (\w+)$/.exec(err.message)?.[1];
  return code === 'manager_revision_conflict' ? '项目配置已被修改，请刷新后再保存监听与触发设置。'
    : code === 'invalid_event_filters' ? '事件开关或标签无效：标签最多 50 个字符，最多 30 个。' : readErrorText(err);
};

function projectWorkPolicyCard() {
  const target = current, policy = target.policy, id = target.id, saved = projectCeilingOf(policy);
  const choices = element('fieldset', '', 'project-ceiling-choices'); choices.append(element('legend', 'bot 在这个项目里最多能写到哪一步'));
  for (const [level, title, detail] of projectCeilingOptions) {
    const label = element('label', '', 'check'); label.append(input('capability_ceiling', level, { type: 'radio', checked: level === saved }), ' ' + title);
    choices.append(label, note(detail));
  }
  // Independent QA before a PR is project policy (#814), on by default.
  const qa = policy.delivery_gates?.pull_request_qa !== false;
  const gate = checkbox('pull_request_qa', qa, '普通任务开 PR 前需要独立 QA 通过');
  return settingsForm('能力上限', [choices, gate,
    note('关闭后，普通任务的候选只要通过项目测试命令就可以开或更新 PR，不再等独立 QA；项目没有配置测试命令时仍要独立 QA。Issue 开发、bot PR 修订和已经创建的任务仍按原来的流程验收。'),
    note('工作类型的写入、角色的 GitHub 写、飞书群档位和私聊个人权限都以这一档为上限，只能更窄。调低后，受影响的任务在下一个工具调用前停下并写明原因，不会被取消；调回后可以重试。事件来源只决定哪些 GitHub 事件交给 Manager，不增加写权限。')],
    async form => { const level = form.elements.capability_ceiling.value, gated = form.elements.pull_request_qa.checked;
      if (level !== saved || gated !== qa) await api(`/api/repositories/${id}/policy`, 'PATCH', { ...(level !== saved ? { capability_ceiling: level } : {}), ...(gated !== qa ? { delivery_gates: { pull_request_qa: gated } } : {}) }); },
    { editable: target.canConfigure !== false, draftKey: 'automation', caption: '保存能力上限' });
}

function projectEventFiltersCard(manager, target, live) {
  const id = target.id, editable = target.canConfigure !== false;
  const section = card('监听的事件来源'), form = document.createElement('form'), message = element('p', '', 'view-error'), events = manager.events;
  section.dataset.overviewAnchor = 'project-events'; form.className = 'project-form'; message.setAttribute('role', 'alert');
  section.append(note(`草稿、已关闭的对象、bot 自己写的内容和仓库外人员的评论始终不会触发自动处理。关闭的来源不会被接收，也不会产生分派调用。提到 bot 指评论里写了 ${manager.mention_names.map(name => '@' + name).join('、') || '（部署关闭了提及）'}。`));
  section.append(note('开启 Actions 失败事件后，系统会扫描默认分支的失败运行，以及推送版本标签触发、提交在默认分支历史上的失败运行，并安排分析；关闭后停止接收和扫描。开启来源不会增加 GitHub 写权限。'));
  const fields = document.createElement('fieldset'); fields.disabled = !editable;
  const boxes = element('div', '', 'manager-events');
  for (const [key, caption] of projectEventCaptions) boxes.append(checkbox('event:' + key, events[key], caption));
  const labels = (key, caption) => field(caption, input(key, events[key].join(', '), { placeholder: '逗号分隔；留空表示不监听加标签事件' }));
  const submit = element('button', '保存事件开关'), buttons = element('div', '', 'actions form-actions'); submit.type = 'submit';
  if (editable) buttons.append(submit);
  const status = element('p', '', 'muted'); status.dataset.actionsStatus = '';
  if (target.policy.actions_failures_enabled) showActionsFailureStatus(status, target.actionsFailures, target.actionsFailuresRead); else status.textContent = '未开启。';
  fields.append(boxes, labels('issue.labels', '有人给 Issue 加上这些标签时'), labels('pull_request.labels', '有人给 PR 加上这些标签时'));
  form.append(fields, status, message, buttons);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!editable || !live()) return; submit.disabled = true; message.textContent = '';
    const list = key => form.elements[key].value.split(',').map(label => label.trim()).filter(Boolean);
    const value = Object.fromEntries(projectEventCaptions.map(([key]) => [key, form.elements['event:' + key].checked]));
    try {
      await api(`/api/repositories/${id}/manager`, 'PUT', { expected_revision: manager.prompt.revision, events: { ...value, 'issue.labels': list('issue.labels'), 'pull_request.labels': list('pull_request.labels') } });
      if (live()) await reloadWith('已保存事件开关');
    } catch (err) { if (live()) message.textContent = projectTriggerError(err); }
    finally { if (live()) submit.disabled = false; }
  });
  section.append(form); return section;
}
