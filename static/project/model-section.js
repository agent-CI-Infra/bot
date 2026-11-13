function modelsSection() {
  const section = card('工作类型模型'), { table, body } = projectTable(['工作类型', '模型选择'], '工作类型模型');
  section.append(note('未指定模型时继承项目默认。失效的模型不会自动替换。「Manager 分派」是每个事件调用一次的分派模型。'));
  let overrides = {}; try { overrides = taskModelMap(current.policy); } catch {}
  // Saved identifiers that are no work type (such as models of former custom workflows) stay visible so they can be removed.
  const other = Object.keys(overrides).filter(kind => !builtInTasks.some(task => task.kind === kind));
  for (const definition of [...builtInTasks, ...other.map(kind => ({ kind, title: kind, custom: true }))]) {
    const row = document.createElement('tr'); row.dataset.taskKind = definition.kind; row.dataset.overviewAnchor = definition.kind;
    tableCell(row, '工作类型', element('strong', definition.title), element('code', definition.kind));
    tableCell(row, '模型选择', taskModelEditor(definition.kind, definition.title, current.policy, current.models, definition)); body.append(row);
  }
  section.append(table); return [projectDefaultModelCard(current.policy, current.models), section, ...modelManagementSections()];
}
