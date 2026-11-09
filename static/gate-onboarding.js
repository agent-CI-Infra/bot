// Gate onboarding (repository list → 接入门禁). The dialog first explains the five lanes; only then does the person start a
// conversation in which the project's agent proposes each lane's commands from repository facts, or reviews the CI and gates
// the repository already has. Nothing is written to the repository until the person confirms a plan revision after seeing
// the files it changes. Globals are prefixed gateOnboarding: console scripts share one scope.
const gateOnboardingLanes = [
  ['pr-ready', 'PR 每次提交或更新时跑（也可以手动运行），检查 PR 的 head 提交。放构建和基础检查：编译、lint、类型检查、快速的单元测试，要在几分钟内跑完。'],
  ['pr-merge', '合入门禁，确保多个 PR 合在一起不会互相影响：有 merge queue 时在队列里对合并结果先跑 pr-ready 再跑这一层；没有 merge queue 时在合入默认分支后对合入结果这样运行。放需要费用、资源或较长时间的检查，比如全量测试、真实服务或模型的集成测试。'],
  ['daily', '每天北京时间 0 点在默认分支定时跑，放耗时较长或依赖外部环境的全量测试、端到端测试，通常只记录失败。'],
  ['release', '推送版本标签（如 v1.2.3）时跑，是发版本前的最后一道检查；通过后「发版本」才生成 Release 草稿，不负责发包。'],
];
const gateOnboardingTools = [['node', 'Node 版本', '运行 gate.mjs，默认 22'], ['python', 'Python 版本', '留空表示不安装'], ['go', 'Go 版本', '填 go.mod 表示按 go.mod'], ['java', 'Java 版本', '留空表示不安装']];
const gateOnboardingStates = { collecting: '正在读取仓库', thinking: 'agent 正在思考', ready: '等待你的回复或确认', creating: '正在创建门禁 PR',
  done: '已创建门禁 PR', connected: '仓库已接入门禁', blocked: '需要人工处理', failed: '失败' };
const gateOnboardingErrors = {
  gate_plan_changed: '方案已经更新，请查看最新方案后再确认。', merge_queue_required: '请先回答默认分支是否启用了 merge queue。',
  gate_pr_open: '仓库已有未合入的门禁 PR，请先合入或关闭它。', gate_workflow_invalid: '选的 workflow 不能放门禁 job，请换一个位置。',
  gate_no_changes: '方案和仓库现有的门禁一致，没有需要提交的改动。', gate_file_changed: '默认分支上的门禁文件在对话开始后有变化，请重新开始。',
  gate_project_not_started: '项目还没有启动：先在仓库列表点「启动」，等虚拟电脑就绪后再接入门禁。', gate_project_disabled: '项目已禁用，启用后再接入门禁。',
  gate_environment_not_ready: '项目的虚拟电脑还没有就绪，就绪后再接入门禁。', work_disabled: '项目配置里关闭了「接入门禁」，请在项目的「Manager 与角色」页打开它。', workflow_disabled: '「接入门禁」已关闭，请在项目的「Manager 与角色」页打开它。',
  model_not_configured: '项目没有可用的模型，请先在项目设置里选择模型。', github_app_required: '门禁接入只使用 GitHub App；这个仓库挂在机器人账号上。',
  gate_onboarding_busy: '上一步还在进行，请稍候。',
  gate_onboarding_superseded: '已经开始了新的接入对话，请关闭后重新打开。', gate_onboarding_closed: '这个对话已经结束，可以重新开始。',
  merge_queue_known: '这个仓库的 merge queue 状态已经读到，不需要回答。',
  gate_plan_invalid: '方案格式无效：安装命令不能包含 ${{ }} 表达式或控制字符。', gate_plan_secret: '方案里像是包含了令牌或密钥，不能写进仓库。', message_required: '请输入要发给 agent 的内容。',
};
const gateOnboardingBusy = ['collecting', 'thinking', 'creating'];
// Where a turn's task is: the Manager starts it, then it waits in the project's queue like every other task.
const gateOnboardingTaskStates = { queued: '排队等待项目电脑', preparing: '在项目电脑里准备检出', running: '在项目电脑里分析', retry_wait: '等待重试',
  waiting_environment: '等待项目电脑就绪', waiting_configuration: '等待模型或配置', waiting_permission: '等待 GitHub 权限' };
const gateOnboardingView = document.createElement('dialog'); gateOnboardingView.id = 'quickstart-view'; gateOnboardingView.className = 'gate-dialog';
gateOnboardingView.setAttribute('aria-labelledby', 'gate-onboarding-title');
gateOnboardingView.innerHTML = `<div class="view-head"><h2 id="gate-onboarding-title">接入门禁</h2><div class="actions">
<button type="button" class="quiet" id="gate-onboarding-restart" hidden>重新开始</button><button type="button" class="quiet" id="gate-onboarding-close">关闭</button></div></div>
<p id="gate-onboarding-error" class="view-error" role="alert"></p>
<section id="gate-onboarding-intro" class="gate-intro" aria-labelledby="gate-onboarding-intro-title">
<h3 id="gate-onboarding-intro-title">门禁的几个 lane</h3>
<p>门禁按 lane 组织。每个 lane 在不同的时机运行这个仓库自己的检查命令，结果写进门禁报告和看板；命令为空的 lane 只表示还没有配置，不表示检查通过。门禁检出并报告同一个提交：PR 上检查的就是 PR 的 head 提交。</p>
<dl id="gate-onboarding-lanes" class="gate-lanes"></dl>
<p>pr-merge 是合入门禁：仓库启用了 merge queue 时，它就是队列的门禁，所以门禁可以设为必需检查，合入后不再重复运行；没有 merge queue 时，它在每次合入默认分支后运行。发版本时，bot 打版本标签，标签触发 release lane，通过后生成 Release 草稿。</p>
<p>点「开始适配」后，接入门禁和其他工作一样在项目的虚拟电脑里工作：每次开始或回复是一轮任务，agent 检出默认分支，分析目录结构和子项目、语言和工具链、README 和脚本、构建和测试方式、已有 workflow 和它们的耗时，必要时安装依赖、试跑命令并计时，再按仓库实际情况设计每个 lane 的命令，说明理由，不确定的会在对话里问你。仓库已经有 CI 或门禁时，agent 会先审视现有配置，说明哪里不合理并给出建议。所以项目要先启动、虚拟电脑就绪、选好模型，才能接入门禁。</p>
<p>你确认之前，不会创建分支或 PR，也不会写仓库；确认前可以预览 PR 会新增或修改的每个文件。</p>
<p id="gate-onboarding-ready" class="view-error" role="status"></p>
<p id="gate-onboarding-last" class="muted"></p>
<div class="actions"><button type="button" class="quiet" id="gate-onboarding-resume" hidden>继续上次的对话</button><button type="button" id="gate-onboarding-start">开始适配</button></div>
</section>
<div id="gate-onboarding-chat" class="gate-chat" hidden>
<section class="gate-conversation" aria-label="对话">
<ol id="gate-onboarding-messages" class="gate-messages" aria-live="polite"></ol>
<form id="gate-onboarding-compose" class="gate-compose"><label>发给 agent<textarea name="content" rows="3" placeholder="例如：测试命令用 python -m pytest -q；daily 跑 make e2e"></textarea></label>
<div class="actions"><span id="gate-onboarding-agent" class="muted"></span><button type="submit">发送</button></div></form>
<p id="gate-onboarding-turn" class="gate-turn muted" hidden></p>
</section>
<form id="gate-onboarding-plan" class="gate-plan" aria-labelledby="gate-onboarding-plan-title">
<h3 id="gate-onboarding-plan-title">门禁方案</h3>
<p id="gate-onboarding-queue" class="muted"></p>
<fieldset id="gate-onboarding-queue-question" hidden><legend>默认分支是否启用了 merge queue？</legend>
<label class="check"><input type="radio" name="merge_queue" value="enabled"> 已启用：合入门禁在队列里运行</label>
<label class="check"><input type="radio" name="merge_queue" value="disabled"> 没有启用：合入门禁在合入默认分支后运行</label></fieldset>
<label>门禁 job 放在<select name="workflow"></select></label>
<div id="gate-onboarding-tools" class="gate-tools"></div>
<label>安装依赖（每行一条命令）<textarea name="install" rows="2"></textarea></label>
<div id="gate-onboarding-plan-lanes" class="gate-plan-lanes"></div>
<details id="gate-onboarding-preview"><summary>预览将提交的文件</summary><div id="gate-onboarding-files"></div></details>
<p id="gate-onboarding-note" class="muted"></p>
<div class="actions"><button type="submit" id="gate-onboarding-confirm">确认并创建门禁 PR</button></div>
</form>
</div>`;
document.body.append(gateOnboardingView);
for (const [lane, when] of gateOnboardingLanes) $('gate-onboarding-lanes').append(element('dt', lane), element('dd', when));
for (const [name, caption, hint] of gateOnboardingTools) {
  const label = element('label', caption), input = document.createElement('input'); input.name = 'tool_' + name; input.placeholder = hint; label.append(input);
  $('gate-onboarding-tools').append(label);
}
for (const [lane, when] of gateOnboardingLanes) {
  const row = element('div', '', 'gate-lane'), label = element('label', ''), area = document.createElement('textarea');
  area.name = 'lane_' + lane; area.rows = 2; area.placeholder = '留空表示还没有配置，不表示检查通过';
  label.append(element('strong', lane), element('span', when, 'muted'), area);
  const observe = element('label', '', 'check'), box = document.createElement('input'); box.type = 'checkbox'; box.name = 'observe_' + lane;
  observe.append(box, ` ${lane} 失败只记录，不让门禁失败（observe）`);
  row.append(label, observe); $('gate-onboarding-plan-lanes').append(row);
}
// row: the repository list row; session: the latest conversation; rendered: the plan revision the form shows, so polling
// never overwrites what the person is typing; preview: files for the form's unsent edits; timer: polling while a step runs.
let gateOnboardingContext = { row: null, after: null, session: null, ready: null, rendered: -1, preview: null, timer: null, wasBusy: false };

function gateOnboardingError(err) {
  const code = String(err.message || '').split(' · ')[1];
  $('gate-onboarding-error').textContent = gateOnboardingErrors[code] || err.message;
}
function gateOnboardingLines(value) { return String(value || '').split('\n').map(line => line.trim()).filter(Boolean); }
function gateOnboardingForm() {
  const form = $('gate-onboarding-plan').elements, session = gateOnboardingContext.session;
  // The default place is sent as "" so that leaving it alone does not count as an edit.
  const workflow = form.workflow.value === session?.default_workflow && !session?.plan?.workflow ? '' : form.workflow.value;
  return { toolchains: Object.fromEntries(gateOnboardingTools.map(([name]) => [name, form['tool_' + name].value.trim()])), install: gateOnboardingLines(form.install.value),
    lanes: Object.fromEntries(gateOnboardingLanes.map(([lane]) => [lane, gateOnboardingLines(form['lane_' + lane].value)])),
    observe: gateOnboardingLanes.map(([lane]) => lane).filter(lane => form['observe_' + lane].checked), workflow };
}
function gateOnboardingFill(session) {
  const form = $('gate-onboarding-plan').elements, plan = session.plan, select = form.workflow, gate = session.facts?.existing?.gate_workflow;
  select.replaceChildren();
  for (const option of session.workflow_options || [])
    select.add(new Option(`${option.mode === 'create' ? '新建' : option.path === gate ? '更新现有门禁' : '并入已有'} ${option.path}`, option.path));
  select.value = plan.workflow || session.default_workflow || '';
  for (const [name] of gateOnboardingTools) form['tool_' + name].value = plan.toolchains[name] || '';
  form.install.value = plan.install.join('\n');
  for (const [lane] of gateOnboardingLanes) { form['lane_' + lane].value = plan.lanes[lane].join('\n'); form['observe_' + lane].checked = (plan.observe || []).includes(lane); }
}
function gateOnboardingShowChat(show) {
  $('gate-onboarding-intro').hidden = show; $('gate-onboarding-chat').hidden = !show; $('gate-onboarding-restart').hidden = !show;
  gateOnboardingView.classList.toggle('wide', show);
}
function gateOnboardingIntro() {
  const session = gateOnboardingContext.session, last = $('gate-onboarding-last'), ready = gateOnboardingContext.ready; last.replaceChildren();
  // Like every task, gate onboarding runs in the project computer: a project that is not ready cannot start it.
  $('gate-onboarding-ready').textContent = ready && !ready.ok ? ready.reason : '';
  $('gate-onboarding-start').disabled = !ready?.ok;
  $('gate-onboarding-resume').hidden = !session;
  if (!session) return;
  last.append(`上次对话：${gateOnboardingStates[session.state] || session.state}（${timestamp(session.updated_at)}）`);
  if (session.pr_url) { const link = element('a', ' 查看门禁 PR', 'result-link'); link.href = session.pr_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; last.append(link); }
}
// A changed file is shown as a diff, a new one whole.
function gateOnboardingFiles(view, revision) {
  const files = $('gate-onboarding-files'); files.replaceChildren();
  if (!view.target) { files.append(element('p', view.target_problem || '回答 merge queue 问题后显示将提交的文件。', 'muted')); return; }
  const target = view.target, edited = gateOnboardingContext.preview === view;
  files.append(element('p', `门禁 job：${target.mode === 'create' ? '新建' : '更新'} ${target.workflow_path}，在 ${target.events.join('、')} 上运行。${edited ? '按表单里当前的内容（含未发送的修改）' : `第 ${revision} 版方案`}将提交：`, 'muted'));
  if (!target.files.length) files.append(element('p', '没有改动：方案和仓库现有的门禁一致。', 'muted'));
  for (const file of target.files) {
    files.append(element('h4', `${file.path}（${file.mode === 'create' ? '新增' : '修改'}）`));
    const pre = element('pre', file.mode === 'create' ? file.content : '', file.mode === 'create' ? '' : 'gate-diff');
    if (file.mode !== 'create') for (const line of file.diff.split('\n'))
      pre.append(element('span', line, 'diff-line ' + (line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-same')));
    files.append(pre);
  }
  files.append(element('p', target.gate_script === 'copy' ? 'scripts/gate/gate.mjs：创建 PR 时从 CI-workflow 复制。' : 'scripts/gate/gate.mjs：沿用仓库已有的文件。', 'muted'));
}

function gateOnboardingRender() {
  const session = gateOnboardingContext.session; if (!session) return;
  const busy = gateOnboardingBusy.includes(session.state), open = session.state === 'ready' && session.latest && !busy;
  const list = $('gate-onboarding-messages'); list.replaceChildren();
  for (const message of session.messages) {
    const item = element('li', '', 'gate-message gate-message-' + message.role);
    item.append(element('span', { agent: 'agent', user: '你', system: '控制面' }[message.role] || message.role, 'gate-message-role'), element('p', message.content));
    list.append(item);
  }
  const task = session.task, waiting = task && gateOnboardingTaskStates[task.status];
  // A turn the Manager has not started yet has no task: the conversation says so instead of an agent at work.
  if (busy) list.append(element('li', (session.state === 'thinking' && waiting ? `agent ${waiting}` : session.state === 'thinking' && !task ? '等 Manager 安排这一轮' : gateOnboardingStates[session.state]) + '…', 'gate-message gate-message-pending'));
  // A turn is a task in the project computer; its process (commands, files read, model output) opens like any task's.
  const turn = $('gate-onboarding-turn'); turn.replaceChildren(); turn.hidden = !task;
  if (task) turn.append(`本轮任务：${waiting || task.status}${task.error ? `（${task.error}）` : ''} `, button('查看执行过程', () => openTask(task.id), 'quiet'));
  if (session.pr_url) { const item = element('li', '', 'gate-message gate-message-system'), link = element('a', '打开门禁 PR', 'result-link');
    link.href = session.pr_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); list.append(item); }
  list.lastElementChild?.scrollIntoView({ block: 'end' });
  const ready = session.ready || {};
  $('gate-onboarding-compose').hidden = !ready.ok || !open;
  $('gate-onboarding-agent').textContent = ready.ok ? `agent 在项目电脑里工作，使用模型 ${ready.model}` : ready.reason || '';
  const plan = $('gate-onboarding-plan'); plan.hidden = !session.plan || session.state === 'connected';
  if (!session.plan) return;
  // Only a new revision from the server replaces the form; the person's unsent edits otherwise stay.
  if (gateOnboardingContext.rendered !== session.revision) { gateOnboardingFill(session); gateOnboardingContext.rendered = session.revision; gateOnboardingContext.preview = null; }
  $('gate-onboarding-plan-title').textContent = `门禁方案 · 第 ${session.revision} 版`;
  const queue = session.merge_queue || { state: 'unknown' }, question = $('gate-onboarding-queue-question');
  question.hidden = !queue.asked || session.state === 'done';
  $('gate-onboarding-queue').textContent = { enabled: `merge queue：已启用（${queue.evidence}）。PR 上跑 pr-ready；队列里先跑 pr-ready 再跑 pr-merge，合入后不再重复运行。`,
    disabled: `merge queue：未启用（${queue.evidence}）。PR 上跑 pr-ready；每次合入默认分支后先跑 pr-ready 再跑 pr-merge。`, unknown: `merge queue：无法判断（${queue.evidence}），请在下面回答。` }[queue.state];
  if (queue.asked && queue.state !== 'unknown') $('gate-onboarding-queue').textContent += ' 可以在下面改。';
  // The saved answer (merge_queue.state) checks its radio; the person changes it there.
  for (const radio of plan.querySelectorAll('input[name=merge_queue]')) { radio.checked = radio.value === queue.state; radio.disabled = !open; }
  for (const field of plan.querySelectorAll('input:not([type=radio]):not([type=checkbox]), textarea')) field.readOnly = !open;
  for (const field of plan.querySelectorAll('input[type=checkbox], select')) field.disabled = !open;
  const view = gateOnboardingContext.preview || session;
  gateOnboardingFiles(view, session.revision);
  const unchanged = !!view.target && !view.target.files.length;
  const blockers = [session.facts?.open_gate_prs?.length ? `仓库已有未合入的门禁 PR（${session.facts.open_gate_prs.map(item => '#' + item.number).join('、')}），请先合入或关闭。` : '',
    view.target_problem || '', queue.state === 'unknown' && open ? '回答 merge queue 问题后才能确认。' : ''].filter(Boolean);
  // No changes is only a note: an edit typed just before clicking confirm reaches the server with the click.
  $('gate-onboarding-note').textContent = blockers.join(' ') || (!open ? '' : unchanged ? '方案和仓库现有的门禁一致，没有需要提交的改动；按建议修改后再确认。'
    : '确认后控制面按右侧方案创建门禁 PR；空 lane 只表示还没有配置。');
  const confirm = $('gate-onboarding-confirm');
  confirm.hidden = ['done', 'connected', 'blocked', 'failed'].includes(session.state);
  confirm.disabled = !open || blockers.length > 0;
}

async function gateOnboardingRefresh() {
  const context = gateOnboardingContext; if (!context.session) return;
  clearTimeout(context.timer);
  const value = await api(`/api/gate-onboarding/${context.session.id}`);
  if (gateOnboardingContext !== context || !context.row) return;
  context.session = value.session; gateOnboardingRender();
  gateOnboardingWatch();
}
function gateOnboardingWatch() {
  const context = gateOnboardingContext, busy = gateOnboardingBusy.includes(context.session?.state);
  if (busy) { context.wasBusy = true; context.timer = setTimeout(() => gateOnboardingRefresh().catch(gateOnboardingError), 1500); }
  else if (context.wasBusy) { context.wasBusy = false; if (['done', 'connected'].includes(context.session.state) && context.after) context.after(); }
}
async function gateOnboardingSend(path, body) {
  const context = gateOnboardingContext; $('gate-onboarding-error').textContent = '';
  try { const value = await api(path, 'POST', body); context.session = value.session; gateOnboardingRender(); gateOnboardingWatch(); return true; }
  catch (err) { gateOnboardingError(err); if (/gate_plan_changed/.test(err.message)) await gateOnboardingRefresh().catch(() => {}); return false; }
}
// Renders the files for the form as it is now, so the person sees what confirming would commit before sending anything.
async function gateOnboardingPreview() {
  const context = gateOnboardingContext, session = context.session; if (!session?.plan) return;
  try {
    const view = await api(`/api/gate-onboarding/${session.id}/preview`, 'POST', { plan: gateOnboardingForm() });
    if (gateOnboardingContext !== context || context.session?.id !== session.id) return;
    context.preview = view; $('gate-onboarding-error').textContent = ''; gateOnboardingRender();
  } catch (err) { gateOnboardingError(err); }
}
async function gateOnboardingStart() {
  const context = gateOnboardingContext; context.rendered = -1; context.preview = null;
  if (await gateOnboardingSend(`/api/projects/${context.row.id}/gate-onboarding`, {})) gateOnboardingShowChat(true);
}

async function openGateOnboarding(row, after) {
  clearTimeout(gateOnboardingContext.timer);
  gateOnboardingContext = { row, after, session: null, ready: null, rendered: -1, preview: null, timer: null, wasBusy: false };
  $('gate-onboarding-title').textContent = '接入门禁 · ' + row.full_name; $('gate-onboarding-error').textContent = '';
  // A previous repository's answer or unsent message must not carry over.
  for (const radio of $('gate-onboarding-plan').querySelectorAll('input[name=merge_queue]')) radio.checked = false;
  for (const field of $('gate-onboarding-compose').querySelectorAll('textarea')) field.value = '';
  gateOnboardingShowChat(false); gateOnboardingIntro();
  gateOnboardingView.showModal();
  try { const value = await api(`/api/projects/${row.id}/gate-onboarding`); if (gateOnboardingContext.row === row) { Object.assign(gateOnboardingContext, { session: value.session, ready: value.ready }); gateOnboardingIntro(); } }
  catch (err) { gateOnboardingError(err); }
}
$('gate-onboarding-start').addEventListener('click', () => gateOnboardingStart());
$('gate-onboarding-restart').addEventListener('click', async () => {
  if (await askConfirm({ title: '重新开始接入？', body: ['重新只读地查看仓库，开始一段新的对话。当前对话里还没确认的方案不会保留。'], action: '重新开始' })) gateOnboardingStart();
});
$('gate-onboarding-resume').addEventListener('click', () => { gateOnboardingShowChat(true); gateOnboardingRender(); gateOnboardingWatch(); });
$('gate-onboarding-close').addEventListener('click', () => { clearTimeout(gateOnboardingContext.timer); gateOnboardingContext.row = null; gateOnboardingView.close(); });
$('gate-onboarding-compose').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, session = gateOnboardingContext.session, submit = form.querySelector('[type=submit]');
  if (!session) return;
  submit.disabled = true;
  // The person's unsent plan edits travel with the message, so the agent answers about what they see.
  if (await gateOnboardingSend(`/api/gate-onboarding/${session.id}/messages`, { content: form.elements.content.value, revision: gateOnboardingContext.rendered, plan: gateOnboardingForm() })) form.reset();
  submit.disabled = false;
});
// A merge queue answer is saved at once; any other change re-renders the preview from the form.
$('gate-onboarding-plan').addEventListener('change', event => {
  const session = gateOnboardingContext.session;
  if (!session) return;
  if (event.target.name === 'merge_queue') gateOnboardingSend(`/api/gate-onboarding/${session.id}/merge-queue`, { answer: event.target.value }).then(() => { if (gateOnboardingContext.preview) gateOnboardingPreview(); });
  else gateOnboardingPreview();
});
$('gate-onboarding-plan').addEventListener('submit', async event => {
  event.preventDefault(); const session = gateOnboardingContext.session; if (!session) return;
  await gateOnboardingSend(`/api/gate-onboarding/${session.id}/confirm`, { revision: gateOnboardingContext.rendered, plan: gateOnboardingForm() });
});
