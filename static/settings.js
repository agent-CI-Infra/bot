// Global settings (super administrators only): deployment-wide defaults and the version this control plane runs.
// Loaded after app.js, views.js and project.js and reuses their helpers.
titles.settings = '全局设置';
async function renderSettings(request) {
  const { settings, version } = await api('/api/settings');
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
  $('settings-panel').replaceChildren(about, concurrency);
}
