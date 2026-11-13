function modelsSection() {
  const { table, body } = projectTable(['工作类型', '模型选择'], '工作类型模型');
  let overrides = {}, parseError = null;
  try { overrides = taskModelMap(current.policy); } catch (err) { parseError = err; }
  // #567: the default model and every per-type override are one draft saved by the shared sticky save bar.
  const draft = { defaultId: current.policy.model_id || '', initialDefault: current.policy.model_id || '', tasks: { ...overrides }, initialTasks: { ...overrides } };
  const isDirty = () => draft.defaultId !== draft.initialDefault || JSON.stringify(draft.tasks) !== JSON.stringify(draft.initialTasks);
  const page = element('div', '', 'models-settings');
  const bar = consoleSaveBar({
    status: '已保存',
    dirty: false,
    onSave: async () => {
      try {
        const payload = {};
        if (draft.defaultId !== draft.initialDefault) payload.model_id = draft.defaultId || null;
        if (JSON.stringify(draft.tasks) !== JSON.stringify(draft.initialTasks)) payload.task_models = draft.tasks;
        if (!Object.keys(payload).length) return;
        await patchPolicy(payload);
        current.focusAnchor = 'project-default-model';
        await reloadWith('已保存模型设置');
      } catch (err) { bar.messageEl.textContent = err.message; }
    },
    onDiscard: async () => {
      if (!isDirty()) return;
      if (!await askConfirm({ title: '放弃未保存的更改？', body: ['将丢弃本页未保存的模型选择，并重新读取已保存的设置。'], action: '放弃更改' })) return;
      await reloadProject();
    },
  });
  const sync = () => bar.refresh({ dirty: isDirty(), status: isDirty() ? '有未保存的更改' : '已保存' });
  // Saved identifiers that are no work type (such as models of former custom workflows) stay visible so they can be removed.
  const other = Object.keys(overrides).filter(kind => !builtInTasks.some(task => task.kind === kind));
  for (const definition of [...builtInTasks, ...other.map(kind => ({ kind, title: '其他工作类型', custom: true }))]) {
    const row = document.createElement('tr'); row.dataset.taskKind = definition.kind; row.dataset.overviewAnchor = definition.kind;
    const name = element('strong', definition.title);
    name.title = definition.custom ? definition.kind : definition.title;
    tableCell(row, '工作类型', name);
    tableCell(row, '模型选择', taskModelEditor(definition.kind, definition.title, current.policy, current.models, { ...definition, draft, sync })); body.append(row);
  }
  const overrideIds = Object.values(overrides).filter(id => id);
  const unavailable = overrideIds.filter(id => !(current.models || []).some(model => model.id === id)).length;
  let summaryText = '按任务类型覆写';
  if (overrideIds.length) {
    summaryText = '按任务类型覆写（已设 ' + overrideIds.length + ' 项';
    if (unavailable) summaryText += '，' + unavailable + ' 项不可用';
    summaryText += '）';
  }
  // Keep an already-open fold open across the project-page repaint that follows a save.
  const overridesWasOpen = document.querySelector('[data-testid="model-overrides"]')?.open;
  const catalogWasOpen = document.querySelector('[data-testid="model-catalog"]')?.open;
  const overridesFold = element('details', '', 'fold model-overrides');
  overridesFold.dataset.testid = 'model-overrides';
  overridesFold.open = Boolean(overridesWasOpen) || Boolean(parseError) || unavailable > 0;
  overridesFold.append(
    element('summary', summaryText),
    note('大多数项目只用上面的默认模型。需要时可为个别工作类型单独指定。未指定时继承项目默认。失效的模型不会自动替换。'),
    table
  );
  const parseAlert = parseError ? element('p', parseError.message || '当前任务模型配置无效，请先在仓库配置中修正。', 'view-error') : null;
  if (parseAlert) { parseAlert.setAttribute('role', 'alert'); parseAlert.dataset.testid = 'task-models-error'; }
  const catalog = element('details', '', 'fold model-catalog');
  catalog.dataset.testid = 'model-catalog';
  catalog.open = Boolean(catalogWasOpen);
  catalog.append(element('summary', '模型目录'), ...modelManagementSections());
  page.append(...[bar, projectDefaultModelCard(current.policy, current.models, draft, sync), parseAlert, overridesFold, catalog].filter(Boolean));
  return [page];
}
