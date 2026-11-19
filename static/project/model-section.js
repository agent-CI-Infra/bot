function modelsSection() {
  // Models are configured in two layers (#1122): Project Default Model + Per-Role Model overrides on #/projects/:id/roles.
  const draft = { defaultId: current.policy.model_id || '', initialDefault: current.policy.model_id || '' };
  const isDirty = () => draft.defaultId !== draft.initialDefault;
  const page = element('div', '', 'models-settings');
  const bar = consoleSaveBar({
    status: '已保存',
    dirty: false,
    onSave: async () => {
      try {
        if (!isDirty()) return;
        await patchPolicy({ model_id: draft.defaultId || null });
        current.focusAnchor = 'project-default-model';
        await reloadWith('已保存模型设置');
      } catch (err) { bar.messageEl.textContent = readErrorText(err); }
    },
    onDiscard: async () => {
      if (!isDirty()) return;
      if (!await askConfirm({ title: '放弃未保存的更改？', body: ['将丢弃本页未保存的模型选择，并重新读取已保存的设置。'], action: '放弃更改' })) return;
      await reloadProject();
    },
  });
  const sync = () => bar.refresh({ dirty: isDirty(), status: isDirty() ? '有未保存的更改' : '已保存' });
  const catalogWasOpen = document.querySelector('[data-testid="model-catalog"]')?.open;
  const catalog = element('details', '', 'fold model-catalog');
  catalog.dataset.testid = 'model-catalog';
  catalog.open = Boolean(catalogWasOpen);
  catalog.append(element('summary', '模型目录'), modelCatalogPanel(), ...modelManagementSections());
  page.append(bar, projectDefaultModelCard(current.policy, current.models, draft, sync), catalog);
  return [page];
}
