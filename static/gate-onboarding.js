// Gate onboarding (repository list → 接入门禁). The dialog first explains the five lanes; only then does the person start a
// conversation in which the project's agent proposes each lane's commands from repository facts. Nothing is written to the
// repository until the person confirms a plan revision. Globals are prefixed gateOnboarding: console scripts share one scope.
const gateOnboardingLanes = [
  ['build', 'PR 每次更新时、进入 merge queue 后、合入默认分支后都会跑，确认代码能构建。'],
  ['pr-ready', 'PR 每次更新时跑，检查 PR 的 head 提交（不是 GitHub 生成的合并提交），放 lint、单元测试等合入前必须通过的检查。'],
  ['pr-merge', 'PR 进入 merge queue 后，对排队中的合并结果跑；仓库没有 merge queue 时不会触发。'],
  ['daily', '每天北京时间 0 点在默认分支定时跑，放耗时较长的全量测试或端到端测试。'],
  ['release', '推送版本标签（如 v1.2.3）或发布 Release 时跑，是发布前的最后一道检查。'],
];
const gateOnboardingTools = [['node', 'Node 版本', '运行 gate.mjs，默认 22'], ['python', 'Python 版本', '留空表示不安装'], ['go', 'Go 版本', '填 go.mod 表示按 go.mod'], ['java', 'Java 版本', '留空表示不安装']];
const gateOnboardingStates = { collecting: '正在读取仓库', thinking: 'agent 正在思考', ready: '等待你的回复或确认', creating: '正在创建门禁 PR',
  done: '已创建门禁 PR', connected: '仓库已接入门禁', blocked: '需要人工处理', failed: '失败' };
const gateOnboardingErrors = {
  gate_plan_changed: '方案已经更新，请查看最新方案后再确认。', merge_queue_required: '请先回答默认分支是否启用了 merge queue。',
  gate_pr_open: '仓库已有未合入的门禁 PR，请先合入或关闭它。', gate_workflow_exists: '仓库已有 ci.yml 和 ci-gates.yml，门禁 workflow 没有可以新增的位置。',
  gate_agent_unavailable: '这个仓库没有可用的模型，agent 不能回复；可以直接修改方案后确认。', gate_onboarding_busy: '上一步还在进行，请稍候。',
  gate_onboarding_superseded: '已经开始了新的接入对话，请关闭后重新打开。', gate_onboarding_closed: '这个对话已经结束，可以重新开始。',
  merge_queue_known: '这个仓库的 merge queue 状态已经读到，不需要回答。',
  gate_plan_invalid: '方案格式无效：安装命令不能包含 ${{ }} 表达式或控制字符。', gate_plan_secret: '方案里像是包含了令牌或密钥，不能写进仓库。', message_required: '请输入要发给 agent 的内容。',
};
const gateOnboardingBusy = ['collecting', 'thinking', 'creating'];
const gateOnboardingView = document.createElement('dialog'); gateOnboardingView.id = 'quickstart-view'; gateOnboardingView.className = 'gate-dialog';
gateOnboardingView.setAttribute('aria-labelledby', 'gate-onboarding-title');
gateOnboardingView.innerHTML = `<div class="view-head"><h2 id="gate-onboarding-title">接入门禁</h2><div class="actions">
<button type="button" class="quiet" id="gate-onboarding-restart" hidden>重新开始</button><button type="button" class="quiet" id="gate-onboarding-close">关闭</button></div></div>
<p id="gate-onboarding-error" class="view-error" role="alert"></p>
<section id="gate-onboarding-intro" class="gate-intro" aria-labelledby="gate-onboarding-intro-title">
<h3 id="gate-onboarding-intro-title">五层门禁</h3>
<p>门禁按五层（lane）组织。每一层在不同的时机运行这个仓库自己的检查命令，结果写进门禁报告和看板。</p>
<dl id="gate-onboarding-lanes" class="gate-lanes"></dl>
<p>仓库启用了 merge queue 时，这次只提交进入队列之前的门禁，也就是 PR 上的 build 和 pr-ready；merge_group 上的 pr-merge 和合入默认分支后才运行的门禁不会提交。daily 和 release 有仓库事实支持时可以保留。</p>
<p>点「开始适配」后，agent 只读地查看仓库：语言、已有 workflow、构建和测试命令、默认分支、是否已有 ci.yml 或 ci-gates.json、是否启用 merge queue，再按仓库实际情况提出每层的命令，不确定的会在对话里问你。你确认之前，不会创建分支或 PR，不会写仓库，也不会运行仓库里的脚本；确认后由控制面创建门禁 PR。</p>
<p id="gate-onboarding-last" class="muted"></p>
<div class="actions"><button type="button" class="quiet" id="gate-onboarding-resume" hidden>继续上次的对话</button><button type="button" id="gate-onboarding-start">开始适配</button></div>
</section>
<div id="gate-onboarding-chat" class="gate-chat" hidden>
<section class="gate-conversation" aria-label="对话">
<ol id="gate-onboarding-messages" class="gate-messages" aria-live="polite"></ol>
<form id="gate-onboarding-compose" class="gate-compose"><label>发给 agent<textarea name="content" rows="3" placeholder="例如：测试命令用 python -m pytest -q；daily 跑 make e2e"></textarea></label>
<div class="actions"><span id="gate-onboarding-agent" class="muted"></span><button type="submit">发送</button></div></form>
</section>
<form id="gate-onboarding-plan" class="gate-plan" aria-labelledby="gate-onboarding-plan-title">
<h3 id="gate-onboarding-plan-title">门禁方案</h3>
<p id="gate-onboarding-queue" class="muted"></p>
<fieldset id="gate-onboarding-queue-question" hidden><legend>默认分支是否启用了 merge queue？</legend>
<label class="check"><input type="radio" name="merge_queue" value="enabled"> 已启用：只提交进入队列之前的门禁</label>
<label class="check"><input type="radio" name="merge_queue" value="disabled"> 没有启用：保留完整的五层事件</label></fieldset>
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
  const label = element('label', ''), hint = element('span', when, 'muted'), area = document.createElement('textarea');
  area.name = 'lane_' + lane; area.rows = 2; area.placeholder = '留空表示还没有配置，不表示检查通过';
  label.append(element('strong', lane), hint, area); $('gate-onboarding-plan-lanes').append(label);
}
// row: the repository list row; session: the latest conversation; rendered: the plan revision the form shows, so polling
// never overwrites what the person is typing; timer: polling while a step runs.
let gateOnboardingContext = { row: null, after: null, session: null, rendered: -1, timer: null, wasBusy: false };

function gateOnboardingError(err) {
  const code = String(err.message || '').split(' · ')[1];
  $('gate-onboarding-error').textContent = gateOnboardingErrors[code] || err.message;
}
function gateOnboardingLines(value) { return String(value || '').split('\n').map(line => line.trim()).filter(Boolean); }
function gateOnboardingForm() {
  const form = $('gate-onboarding-plan').elements;
  return { toolchains: Object.fromEntries(gateOnboardingTools.map(([name]) => [name, form['tool_' + name].value.trim()])), install: gateOnboardingLines(form.install.value),
    lanes: Object.fromEntries(gateOnboardingLanes.map(([lane]) => [lane, gateOnboardingLines(form['lane_' + lane].value)])) };
}
function gateOnboardingFill(plan) {
  const form = $('gate-onboarding-plan').elements;
  for (const [name] of gateOnboardingTools) form['tool_' + name].value = plan.toolchains[name] || '';
  form.install.value = plan.install.join('\n');
  for (const [lane] of gateOnboardingLanes) form['lane_' + lane].value = plan.lanes[lane].join('\n');
}
function gateOnboardingShowChat(show) {
  $('gate-onboarding-intro').hidden = show; $('gate-onboarding-chat').hidden = !show; $('gate-onboarding-restart').hidden = !show;
  gateOnboardingView.classList.toggle('wide', show);
}
function gateOnboardingIntro() {
  const session = gateOnboardingContext.session, last = $('gate-onboarding-last'); last.replaceChildren();
  $('gate-onboarding-resume').hidden = !session;
  if (!session) return;
  last.append(`上次对话：${gateOnboardingStates[session.state] || session.state}（${timestamp(session.updated_at)}）`);
  if (session.pr_url) { const link = element('a', ' 查看门禁 PR', 'result-link'); link.href = session.pr_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; last.append(link); }
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
  if (busy) list.append(element('li', gateOnboardingStates[session.state] + '…', 'gate-message gate-message-pending'));
  if (session.pr_url) { const item = element('li', '', 'gate-message gate-message-system'), link = element('a', '打开门禁 PR', 'result-link');
    link.href = session.pr_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); list.append(item); }
  list.lastElementChild?.scrollIntoView({ block: 'end' });
  const agent = session.agent || {};
  $('gate-onboarding-compose').hidden = !agent.available || !open;
  $('gate-onboarding-agent').textContent = agent.available ? `agent 使用项目模型 ${agent.model}` : '';
  const plan = $('gate-onboarding-plan'); plan.hidden = !session.plan || session.state === 'connected';
  if (!session.plan) return;
  // Only a new revision from the server replaces the form; the person's unsent edits otherwise stay.
  if (gateOnboardingContext.rendered !== session.revision) { gateOnboardingFill(session.plan); gateOnboardingContext.rendered = session.revision; }
  $('gate-onboarding-plan-title').textContent = `门禁方案 · 第 ${session.revision} 版`;
  const queue = session.merge_queue || { state: 'unknown' }, question = $('gate-onboarding-queue-question');
  question.hidden = !queue.asked || session.state === 'done';
  $('gate-onboarding-queue').textContent = { enabled: `merge queue：已启用（${queue.evidence}）。只提交进入队列之前的门禁，pr-merge 留空，不包含 merge_group 和合入默认分支后的门禁。`,
    disabled: `merge queue：未启用（${queue.evidence}），保留完整的五层事件。`, unknown: `merge queue：无法判断（${queue.evidence}），请在下面回答。` }[queue.state];
  if (queue.asked && queue.state !== 'unknown') $('gate-onboarding-queue').textContent += ' 可以在下面改。';
  // The saved answer (merge_queue.state) checks its radio; the person changes it there.
  for (const radio of plan.querySelectorAll('input[name=merge_queue]')) { radio.checked = radio.value === queue.state; radio.disabled = !open; }
  const queueState = queue.state;
  const mergeLane = plan.elements['lane_pr-merge']; mergeLane.disabled = queueState === 'enabled';
  if (queueState === 'enabled') mergeLane.placeholder = '仓库启用了 merge queue，本次不提交 pr-merge';
  for (const field of plan.querySelectorAll('input:not([type=radio]), textarea')) field.readOnly = !open;
  const files = $('gate-onboarding-files'); files.replaceChildren();
  if (session.target) {
    files.append(element('p', `门禁 workflow：${session.target.workflow_path}，触发事件 ${session.target.events.join('、')}。第 ${session.revision} 版方案将提交：`, 'muted'));
    for (const file of session.target.files) files.append(element('h4', file.path), element('pre', file.content));
    files.append(element('p', session.target.gate_script === 'copy' ? 'scripts/gate/gate.mjs：创建 PR 时从 CI-workflow 复制。' : 'scripts/gate/gate.mjs：沿用仓库已有的文件。', 'muted'));
  } else files.append(element('p', session.target_problem || '回答 merge queue 问题后显示将提交的文件。', 'muted'));
  const blockers = [session.facts?.open_gate_prs?.length ? `仓库已有未合入的门禁 PR（${session.facts.open_gate_prs.map(item => '#' + item.number).join('、')}），请先合入或关闭。` : '',
    session.target_problem || '', queueState === 'unknown' && open ? '回答 merge queue 问题后才能确认。' : ''].filter(Boolean);
  $('gate-onboarding-note').textContent = blockers.join(' ') || (open ? '确认后控制面按右侧方案创建门禁 PR；空 lane 只表示还没有配置。' : '');
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
async function gateOnboardingStart() {
  const context = gateOnboardingContext; context.rendered = -1;
  if (await gateOnboardingSend(`/api/projects/${context.row.id}/gate-onboarding`, {})) gateOnboardingShowChat(true);
}

async function openGateOnboarding(row, after) {
  clearTimeout(gateOnboardingContext.timer);
  gateOnboardingContext = { row, after, session: null, rendered: -1, timer: null, wasBusy: false };
  $('gate-onboarding-title').textContent = '接入门禁 · ' + row.full_name; $('gate-onboarding-error').textContent = '';
  // A previous repository's answer or unsent message must not carry over.
  for (const radio of $('gate-onboarding-plan').querySelectorAll('input[name=merge_queue]')) radio.checked = false;
  for (const field of $('gate-onboarding-compose').querySelectorAll('textarea')) field.value = '';
  gateOnboardingShowChat(false); gateOnboardingIntro();
  gateOnboardingView.showModal();
  try { const value = await api(`/api/projects/${row.id}/gate-onboarding`); if (gateOnboardingContext.row === row) { gateOnboardingContext.session = value.session; gateOnboardingIntro(); } }
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
// A merge queue answer is saved at once, so the file preview and the agent's next turn follow it.
$('gate-onboarding-plan').addEventListener('change', event => {
  const session = gateOnboardingContext.session;
  if (event.target.name === 'merge_queue' && session) gateOnboardingSend(`/api/gate-onboarding/${session.id}/merge-queue`, { answer: event.target.value });
});
$('gate-onboarding-plan').addEventListener('submit', async event => {
  event.preventDefault(); const session = gateOnboardingContext.session; if (!session) return;
  await gateOnboardingSend(`/api/gate-onboarding/${session.id}/confirm`, { revision: gateOnboardingContext.rendered, plan: gateOnboardingForm() });
});
