// #224-A: the console's component and state sample page.
//
// It is a real console page — served by the same control plane, drawing with the same stylesheets and the same shared
// renderers — reachable at #/design and deliberately absent from #tabs and from every product page's links. It is the
// reviewed evidence surface for the shared console tokens (declared only in static/shell.css, see docs/console-ui.md) and for the states the console must cover, not
// a feature users navigate to; static/app.js registers the address and keeps it to super administrators.
//
// The samples use the components that already exist: buttons and form controls from static/style.css, status badges from
// static/app.js states(), the notification strip from app.js notice(), cards from views.js. Nothing here invents a second
// version of a component, and nothing here is presented as an unbuilt capability: the states are the real states.
const designTokenGroups = [
  ['表面', [['--color-bg', '页面底色'], ['--color-surface', '卡片'], ['--color-surface-alt', '侧栏/下沉'], ['--color-hover', '悬停底']]],
  ['文字', [['--color-text', '正文（强）'], ['--color-text-muted', '次要'], ['--color-text-inverse', '反白'], ['--color-nav', '导航']]],
  ['品牌与状态', [['--color-brand', '品牌/当前'], ['--color-brand-weak', '当前底色'], ['--color-danger', '失败'], ['--color-danger-bg', '失败底'], ['--color-warning', '关注'], ['--color-warning-bg', '关注底'], ['--color-success', '成功'], ['--color-success-bg', '成功底'], ['--color-info', '信息'], ['--color-info-bg', '信息底']]],
  ['边框与形状', [['--color-border', '卡片边框'], ['--radius-2', '控件圆角'], ['--radius-card', '卡片圆角']]],
  ['密度与动效', [['--control-min', '触控下限'], ['--motion-fast', '状态变化'], ['--motion-base', '较大位移'], ['--focus-ring', '焦点环']]],
];
const designScale = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8', '--space-9', '--space-10'];
const designFonts = ['--font-size-micro', '--font-size-1', '--font-size-label', '--font-size-2', '--font-size-row', '--font-size-touch', '--font-size-3', '--font-size-4', '--font-size-brand', '--font-size-display', '--font-size-5'];
// The scale rows read the token itself, so the table shows the value the page actually uses (#223 shell.css owns
// several of these names) instead of a copy that drifts the moment a token changes.
const tokenValue = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function designSection(id, title, hint, ...children) {
  const section = element('section', '', 'side-card design-section');
  section.id = id;
  const heading = element('h3', title);
  section.append(heading);
  if (hint) section.append(element('p', hint, 'muted'));
  section.append(...children);
  return section;
}

// A swatch reads its colour from the token itself, so the sample cannot drift from the contract it documents.
function designSwatch(name, caption) {
  const row = element('div', '', 'design-swatch');
  // Only a colour token can be shown as a chip; a radius or a duration shown as a background would paint nothing.
  if (/^--color-/.test(name) || name === '--focus-ring') {
    const chip = element('i'); chip.style.background = `var(${name})`; chip.setAttribute('aria-hidden', 'true');
    row.append(chip);
  }
  row.append(element('code', name), element('span', caption));
  if (!/^--color-/.test(name) && name !== '--focus-ring') row.append(element('span', tokenValue(name), 'design-value'));
  return row;
}

function designStatus(tone, caption, icon) {
  const badge = element('span', caption, 'status' + (tone ? ' status-' + tone : ''));
  if (icon && typeof warningIcon === 'function') badge.append(warningIcon());
  return badge;
}

function designRows() {
  const rows = element('div', '', 'rows');
  for (const [title, note, tone, caption, action] of [
    ['检视 issue #12', 'fixture/project-101 · 模型执行中', 'info', '执行中', '查看'],
    ['开发 issue #9', 'fixture/project-101 · 已创建 PR', 'success', '已完成', '详情'],
    ['开发 issue #10', 'fixture/project-101 · 等待权限', 'warning', '需人工', '处理'],
    ['发布 v1.4.0', 'fixture/project-101 · 签名无效', 'danger', '失败', '日志'],
  ]) {
    const row = element('div', '', 'row has-actions'); row.setAttribute('role', 'listitem');
    const content = element('div', '', 'row-content');
    content.append(element('strong', title), element('p', note));
    const state = element('div', '', 'row-state'); state.append(designStatus(tone, caption));
    const actions = element('div', '', 'actions');
    actions.append(button(action, () => notice('message', `${action}：这是样例行，不会执行任何操作。`), 'quiet'));
    row.append(content, state, actions); rows.append(row);
  }
  return rows;
}

function designDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = 'design-confirm'; dialog.setAttribute('aria-labelledby', 'design-confirm-title');
  const heading = element('h2', '确认删除这个安装？'); heading.id = 'design-confirm-title';
  const body = element('p', '删除后该项目在本部署的安装记录会消失，需要用 GitHub App 重新安装才能恢复；已经创建的任务和 PR 不受影响。');
  const actions = element('div', '', 'actions');
  actions.append(
    button('取消', () => dialog.close(), 'quiet'),
    button('删除安装', () => { dialog.close(); notice('message', '样例：真实页面会在这里报告结果。'); }, 'quiet destructive'));
  dialog.append(heading, body, actions);
  return dialog;
}

// Built once; repeated visits reuse the same nodes so the page keeps a stable identity and no listener is added twice.
function renderDesignPage() {
  const host = $('design-page');
  if (host.dataset.rendered) return;

  const tokenLists = designTokenGroups.map(([group, tokens]) => {
    const card = element('div', '', 'design-group');
    card.append(element('h4', group));
    for (const [name, caption] of tokens) card.append(designSwatch(name, caption));
    return card;
  });
  const scaleCard = element('div', '', 'design-group');
  scaleCard.append(element('h4', '间距与字号'));
  for (const name of [...designScale, ...designFonts]) {
    const row = element('div', '', 'design-swatch');
    row.append(element('code', name), element('span', tokenValue(name)));
    scaleCard.append(row);
  }
  const tokensGrid = element('div', '', 'design-grid');
  tokensGrid.append(...tokenLists, scaleCard);

  const buttons = element('div', '', 'design-row');
  buttons.append(
    button('保存', () => notice('message', '样例：保存反馈沿用页面顶部的提示条。')),
    button('取消', () => notice('message', ''), 'quiet'),
    button('删除', () => notice('message', '样例：危险操作必须先说明影响对象。'), 'quiet destructive'),
    button('查看详情', () => notice('message', '样例：链接式按钮。'), 'linkish'));
  const disabled = button('保存中…', () => {}); disabled.disabled = true; buttons.append(disabled);

  const field = (label, control) => { const wrap = element('label', label); wrap.append(control); return wrap; };
  const input = document.createElement('input'); input.value = '巡检计划'; input.id = 'design-input';
  const select = document.createElement('select'); select.id = 'design-select';
  for (const option of ['全部项目', 'fixture/project-101']) select.add(new Option(option, option));
  const area = document.createElement('textarea'); area.value = '说明这次变更的范围。'; area.id = 'design-textarea';
  const check = document.createElement('label', '', 'check');
  const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true;
  check.append(box, element('span', '同时通知项目管理员'));
  const form = element('form', '');
  // The sample does not submit anywhere; Enter in a field must not navigate the console away from the page.
  form.addEventListener('submit', event => event.preventDefault());
  form.append(field('计划名称', input), field('项目', select), field('说明', area), check);

  const card = element('div', '', 'side-card');
  card.append(element('h3', '卡片标题'), element('p', '卡片用来承载一组同源信息；表格行在窄屏会转成这种排布。'));

  const states = element('div', '', 'design-states');
  states.append(
    element('p', '空：没有任何记录，说明为什么是空的、下一步做什么。', 'muted'),
    Object.assign(element('div', '', 'rows'), { id: 'design-empty' }),
    element('p', '加载：占位文案沿用列表的 aria-busy 状态，不提前显示成功。', 'muted'),
    Object.assign(element('div', '', 'rows'), { id: 'design-loading' }),
    element('p', '错误：说明发生了什么、还能做什么。', 'muted'),
    element('p', '保存失败：文件已被其他操作更新，请刷新后再保存。', 'view-error'),
    element('p', '已保存：服务端确认之后才出现。', 'view-success'),
    element('p', '公开地址已生效，现在可以从外部访问。', 'flash'));
  states.querySelector('#design-loading').setAttribute('aria-busy', 'true');

  const permission = element('div', '', 'side-card');
  permission.append(element('h3', '无权限'), designStatus('warning', '权限待处理', true),
    element('p', '当前账号没有这个项目的管理权限。页面保留标题和返回路径，只去掉不能执行的操作；不会用一个空白页代替。'));

  const dialogButton = button('打开确认框', () => $('design-confirm').showModal(), 'quiet');
  const dialogCard = element('div', '', 'side-card');
  dialogCard.append(element('h3', '确认框'), element('p', '危险确认说明影响对象与不可逆性；Esc 关闭并把焦点还给触发按钮。'), dialogButton);

  host.append(
    designSection('design-tokens', '设计 token', '值只在 static/shell.css 声明（见 docs/console-ui.md）；本页不声明任何 token，样例只用它们着色。', tokensGrid),
    designSection('design-buttons', '按钮与操作', '', buttons),
    designSection('design-form', '表单控件', '', form),
    designSection('design-rows', '表格、卡片与状态', '', designRows(), card),
    designSection('design-states', '状态：空 / 加载 / 错误 / 无权限 / 成功', '', states, permission),
    designSection('design-dialog', '对话框', '', dialogCard));
  document.body.append(designDialog());
  host.dataset.rendered = '1';
}
