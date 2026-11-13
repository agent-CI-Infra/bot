function modelsSection() {
  const { table, body } = projectTable(['工作类型', '模型选择'], '工作类型模型');
  let overrides = {}; try { overrides = taskModelMap(current.policy); } catch {}
  // Saved identifiers that are no work type (such as models of former custom workflows) stay visible so they can be removed.
  const other = Object.keys(overrides).filter(kind => !builtInTasks.some(task => task.kind === kind));
  for (const definition of [...builtInTasks, ...other.map(kind => ({ kind, title: '其他工作类型', custom: true }))]) {
    const row = document.createElement('tr'); row.dataset.taskKind = definition.kind; row.dataset.overviewAnchor = definition.kind;
    const name = element('strong', definition.title);
    name.title = definition.custom ? definition.kind : definition.title;
    tableCell(row, '工作类型', name);
    tableCell(row, '模型选择', taskModelEditor(definition.kind, definition.title, current.policy, current.models, definition)); body.append(row);
  }
  // Keep an already-open fold open across the project-page repaint that follows a save.
  const overridesWasOpen = document.querySelector('[data-testid="model-overrides"]')?.open;
  const catalogWasOpen = document.querySelector('[data-testid="model-catalog"]')?.open;
  const overridesFold = element('details', '', 'fold model-overrides');
  overridesFold.dataset.testid = 'model-overrides';
  overridesFold.open = Boolean(overridesWasOpen);
  overridesFold.append(
    element('summary', '按任务类型覆写'),
    note('大多数项目只用上面的默认模型。需要时可为个别工作类型单独指定。未指定时继承项目默认。失效的模型不会自动替换。'),
    table
  );
  const catalog = element('details', '', 'fold model-catalog');
  catalog.dataset.testid = 'model-catalog';
  catalog.open = Boolean(catalogWasOpen);
  catalog.append(element('summary', '模型目录'), ...modelManagementSections());
  return [projectDefaultModelCard(current.policy, current.models), overridesFold, catalog];
}
