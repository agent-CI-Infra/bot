// Global settings (super administrators only): deployment-wide defaults, the version this control plane runs, the
// deployment settings the onboarding wizard saves, and the shared models. Loaded after app.js, views.js and project.js and
// reuses their helpers; tunnelCredential comes from onboarding.js, which loads later but before any page is drawn.
// The wizard settings and models are saved through the wizard's and the model APIs; a card redraws only itself.
titles.settings = '全局设置';
// waiting_token with a saved token means this deployment has no tunnel status endpoint to read.
const tunnelStates = { waiting_token: '读不到状态', not_running: 'tunnel 服务未运行', connecting: '正在连接', connected: '已连接' };
// What the cards draw from; the model cards are redrawn together because deleting the default model clears it.
let settingsView = null;
async function renderSettings(request) {
  const [{ settings, version }, onboarding, { accounts: registered }, { models }] = await Promise.all([
    api('/api/settings'), api('/api/onboarding'), api('/api/accounts'), api('/api/models')]);
  if (request !== renderVersion) return;
  $('count').textContent = '';
  const about = card('当前运行版本');
  about.append(version.image_tag ? facts([['镜像标签', version.image_tag]]) : note('源码运行：没有设置镜像标签（BOT_IMAGE_TAG），版本以部署所用的源码提交为准。'));
  const [min, max] = settings.task_concurrency_bounds, concurrency = card('同时运行的任务');
  const form = document.createElement('form'), value = input('task_concurrency', settings.task_concurrency, { type: 'number', min, max, step: 1, required: true });
  const message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', '保存');
  form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert'); actions.append(submit);
  form.append(field('每台虚拟电脑默认同时运行的任务数', value),
    note(`取 ${min}–${max}。每个仓库一台虚拟电脑；项目在「机器配置」里没有单独设置时使用这个值，超出的任务继续排队。同时运行的任务各用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限。`),
    message, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.className = 'view-error'; message.textContent = '';
    if (!value.checkValidity()) { message.textContent = `需要 ${min}–${max} 之间的整数`; value.focus(); return; }
    submit.disabled = true;
    try {
      const saved = await api('/api/settings', 'PATCH', { task_concurrency: Number(value.value) });
      value.value = saved.settings.task_concurrency; message.className = 'view-success'; message.textContent = '已保存，新任务按这个并发数排队';
    } catch (err) { message.textContent = err.message; } finally { submit.disabled = false; }
  });
  concurrency.append(form);
  const view = settingsView = { request, onboarding, accounts: registered, models };
  view.address = liveCard('公网 HTTPS 地址', redraw => addressBody(view, redraw));
  view.tunnel = liveCard('Cloudflare Tunnel', redraw => tunnelBody(view, redraw));
  view.app = liveCard('GitHub App', redraw => appBody(view, redraw));
  view.defaultModel = liveCard('默认共享模型', redraw => defaultModelBody(view, redraw));
  view.sharedModels = liveCard('部署共享模型', () => sharedModelsBody(view));
  view.sharedModels.section.classList.add('settings-wide');
  $('settings-panel').replaceChildren(about, concurrency, ...['address', 'tunnel', 'app', 'defaultModel', 'sharedModels'].map(name => view[name].section));
}
// A card whose body `draw(redraw)` builds; `redraw(notice)` draws it again with the outcome of the last action on top.
function liveCard(title, draw) {
  const section = card(title), heading = section.children[0];
  const redraw = notice => {
    const nodes = draw(redraw);
    if (notice) { const flash = element('p', notice, 'view-success flash'); flash.setAttribute('role', 'status'); nodes.unshift(flash); }
    section.replaceChildren(heading, ...nodes);
  };
  redraw(); return { section, redraw };
}
// Fields, an error line and a submit button with optional extra buttons; an error thrown by `save` goes to the line.
function actionForm(nodes, caption, save, extra = []) {
  const form = element('form', '', 'project-form'), message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', caption);
  form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert'); actions.append(submit, ...extra); form.append(...nodes, message, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.textContent = ''; submit.disabled = true;
    try { await save(); } catch (err) { message.textContent = err.message; } finally { submit.disabled = false; }
  });
  return form;
}
function addressBody(view, redraw) {
  const saved = view.onboarding.public_address, origin = input('origin', saved?.origin || '', { type: 'url', placeholder: 'https://你的域名，不带路径' });
  return [saved ? facts([['已验证地址', saved.origin], ['检查时间', timestamp(saved.checked_at)]]) : note('还没有验证过的公网地址。'),
    note('GitHub 把 webhook 送到这个地址。它只能连到 webhook 8791，检查会拒绝管理页面和其他实例。改了地址后，在「GitHub App」里点当前 App 的「重新检查」，把 App 的 webhook 改到新地址。'),
    actionForm([field('公网 HTTPS 地址', origin)], '检查并保存', async () => {
      if (!origin.value.trim()) throw new Error('先填写公网 HTTPS 地址');
      view.onboarding.public_address = (await api('/api/onboarding/address', 'POST', { origin: origin.value.trim() })).public_address;
      redraw('已检查并保存 ' + view.onboarding.public_address.origin); view.app.redraw();
    })];
}
// The token is write-only: the page shows whether one is saved, never the token or the pasted command.
function tunnelBody(view, redraw) {
  const tunnel = view.onboarding.tunnel, configured = tunnel.token_configured;
  const credential = tunnelCredential(configured ? '已保存；粘贴新的 token 或命令来替换' : '粘贴 tunnel token 或 Cloudflare 完整命令');
  const revoke = button('撤销 token', async () => {
    if (!await askConfirm({ title: '撤销 Cloudflare Tunnel token？', body: ['删除保存的 token，tunnel 服务随之断开；经 tunnel 转发的 webhook 不再到达，直到重新保存 token。', '已验证的公网地址和 GitHub App 的 webhook 地址都不变。'], action: '撤销', danger: true })) return;
    revoke.disabled = true;
    try { view.onboarding.tunnel = (await api('/api/onboarding/tunnel', 'POST', { revoke: true })).tunnel; redraw('已撤销 tunnel token'); }
    catch (err) { revoke.disabled = false; error(err); }
  }, 'quiet destructive');
  const nodes = [facts([['Token', configured ? '已保存' : '未配置'], ['连接状态', configured ? tunnelStates[tunnel.state] || tunnel.state : null], ['Service URL', tunnel.origin]]),
    note('只用自建 HTTPS 中转时不需要 tunnel。可以粘贴原始 token，或包含它的完整 cloudflared 安装、运行命令；只保存其中的 token，页面和接口都不再显示它。Published application 的 Service URL 必须是 http://webhook:8791。')];
  if (!tunnel.available) nodes.push(note('这台部署没有配置 tunnel 服务，保存和撤销都会失败。'));
  nodes.push(actionForm([field('Tunnel token 或完整命令', credential)], '保存 token', async () => {
    if (!credential.value.trim()) throw new Error('先粘贴 tunnel token 或完整命令');
    view.onboarding.tunnel = (await api('/api/onboarding/tunnel', 'POST', { token: credential.value })).tunnel; redraw('已保存 tunnel token');
  }, configured ? [revoke] : []));
  return nodes;
}
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
// The model the wizard's last step starts repositories with; projects keep their own choice.
function defaultModelBody(view, redraw) {
  const shared = view.models.filter(model => model.repository_id === null), chosen = shared.find(model => model.id === view.onboarding.model_id), usable = shared.filter(model => model.key_configured);
  const nodes = [facts([['当前默认', chosen ? `${chosen.model_name} · ${chosen.api_url}` : view.onboarding.model_id ? '已不可用，请重新选择' : '未设置']])];
  if (chosen && !chosen.key_configured) nodes.push(element('p', 'Key 已撤销：在下面给它更换 Key，或改选另一条模型。', 'endpoint-warning'));
  nodes.push(note('接入向导最后一步启用仓库时使用这个模型；已启用的项目在各自的「使用的模型」里选择，不受影响。只能选 Key 仍在的部署共享模型。'));
  if (!usable.length) { nodes.push(note('还没有 Key 可用的部署共享模型，先在「部署共享模型」里添加。')); return nodes; }
  const select = document.createElement('select'), empty = element('option', '选择部署共享模型'); select.name = 'model_id'; empty.value = ''; select.append(empty);
  for (const model of usable) { const option = element('option', `${model.model_name} · ${hostOf(model.api_url)}`); option.value = model.id; select.append(option); }
  select.value = chosen?.key_configured ? chosen.id : '';
  nodes.push(actionForm([field('默认模型', select)], '设为默认', async () => {
    if (!select.value) throw new Error('先选择一条部署共享模型');
    view.onboarding.model_id = (await api('/api/onboarding/model', 'POST', { model_id: select.value })).model_id; redraw('已设为默认模型');
  }));
  return nodes;
}
// The same row actions and add form as the project page, refreshing only these two cards instead of a project.
function sharedModelsBody(view) {
  const list = element('ul', '', 'history');
  for (const model of view.models.filter(row => row.repository_id === null)) {
    const row = element('li', '', 'model-entry'), result = probeResult('wide-cell'), address = modelAddress(model);
    if (model.id === view.onboarding.model_id) address.append(' ', badge('默认', 'info'));
    if (!model.key_configured) address.append(' ', badge('Key 已撤销', 'warning'));
    row.append(address, modelActions(model, result, refreshSettingsModels), result); list.append(row);
  }
  if (!list.childElementCount) list.append(element('li', '还没有部署共享模型。', 'muted'));
  return [note('不属于任何仓库、所有项目都能选用的模型。项目在「使用的模型」里选用；删除后，选用它的项目改回「不使用模型」，已有成本记录保留。'), list,
    modelForm('添加部署共享模型', null, refreshSettingsModels)];
}
async function refreshSettingsModels(notice) {
  const view = settingsView; if (!view) return;
  const [{ models }, { model_id }] = await Promise.all([api('/api/models'), api('/api/onboarding')]);
  if (view !== settingsView || view.request !== renderVersion) return;
  Object.assign(view, { models }); view.onboarding.model_id = model_id;
  view.defaultModel.redraw(); view.sharedModels.redraw(notice);
}
