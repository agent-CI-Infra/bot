// Only Apps registered in this system are offered. Creating an App and installing it stay one-time steps of the wizard.
function appBody(view, redraw) {
  const saved = view.onboarding.app, apps = view.accounts.filter(account => account.type === 'github_app'), origin = view.onboarding.public_address?.origin;
  const message = element('p', '', 'view-error'), list = element('ul', '', 'history'); message.setAttribute('role', 'alert');
  const nodes = [saved ? facts([['名称', apps.find(app => app.id === saved.account_id)?.name], ['Slug', saved.slug], ['App ID', saved.app_id], ['已确认安装数', saved.installations], ['Webhook 地址', saved.webhook_url]]) : note('还没有选择 GitHub App。')];
  if (saved?.webhook_url && origin && !saved.webhook_url.startsWith(origin + '/')) nodes.push(element('p', 'App 的 webhook 不在当前公网地址下。点当前 App 的「重新检查」，把它改到新地址。', 'endpoint-warning'));
  for (const app of apps) {
    const row = element('li', ''), selected = app.id === saved?.account_id, name = element('div', app.name);
    if (selected) name.append(' ', badge('当前', 'success'));
    name.append(element('p', 'App ID ' + app.app_id, 'muted'));
    const use = button(selected ? '重新检查' : '改用此 App', async () => {
      if (!selected && !await askConfirm({ title: `改用 ${app.name}？`, body: ['接入向导的安装和启用步骤改用这个 App；已启用的项目继续使用各自的账号。', `GitHub 上这个 App 的 webhook 会改为 ${origin} 下的地址。`], action: '改用' })) return;
      use.disabled = true; message.textContent = '';
      try { view.onboarding.app = (await api('/api/onboarding/use-app', 'POST', { account_id: app.id, update_webhook: true })).app; redraw(selected ? '已重新检查，webhook 指向当前公网地址' : `已改用 ${app.name}`); }
      catch (err) { use.disabled = false; message.textContent = err.message; }
    });
    use.disabled = !origin; row.append(name, use); list.append(row);
  }
  if (!apps.length) list.append(element('li', '本系统还没有登记 GitHub App。', 'muted'));
  nodes.push(list, message, note(origin ? '改用或重新检查时向 GitHub 核对 App 凭据和安装数，并把 App 的 webhook 设为上面已验证的公网地址。新建 App 和安装到账号在「接入向导」里完成。' : '先验证公网 HTTPS 地址，才能改用或重新检查 App。'));
  return nodes;
}
