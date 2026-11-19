// Repository onboarding (#934): #/onboarding/<repository id>, the one page a repository's administrator goes through, from
// 开始接入 to the completion page. The conversation with the management assistant runs on the left; the repository profile
// and the plan it produced are on the right (one tab each on a phone). The questions it asks are a card in the conversation,
// under the turns that asked them. After the confirmation the plan side shows the start request (#933) and the receipts of
// each item (#932), and the completion page says what the bot does now.
// Everything drawn is read back from the control plane (src/management/onboarding*.ts): a reload, or another device, opens
// the same state. The page keeps only which tab a phone shows.

let repoOnboardingPage = null;
/** Leaves the page when the address moves elsewhere: its stream, its poll and its timers stop with it. */
function leaveRepositoryOnboarding(hash) {
  if (repoOnboardingPage && repoOnboardingPage.address !== hash) { repoOnboardingPage.dispose(); repoOnboardingPage = null; }
}
const repoOnboardingItemNames = { start: '启动项目', capability_ceiling: '能力上限', events: '监听与触发', test_command: '测试命令', review_language: '检视语言',
  conventions: '本仓库约定', labels: 'GitHub 标签', schedules: '项目定时任务', ci: 'CI 建议' };
const repoOnboardingLanguages = { auto: '自动（跟随 Issue／PR 的语言）', zh: '中文', en: '英文' };
const repoOnboardingFeishuLevels = { read: '只读', comment: '可评论', dispatch: '可派任务' };
const repoOnboardingReceiptStates = { succeeded: ['已生效', 'success'], exists: ['已是方案值', 'success'], skipped: ['未应用', ''], pending: ['等待中', 'info'], running: ['应用中', 'info'], failed: ['未生效', 'danger'] };
const repoOnboardingErrors = {
  repository_admin_required: '只有这个仓库的管理员（仓库 admin 或组织 owner）可以运行接入向导。',
  repository_not_installed: '这个仓库没有安装 GitHub App，或已经移出安装范围。',
  scope_forbidden: '当前登录限定在别的组织或项目，切换组织后再打开。',
  onboarding_turn_running: '上一轮还在进行，等它结束或先停止。',
  onboarding_session_closed: '这个接入会话已经结束，请重新开始分析。',
  onboarding_session_not_found: '这个仓库没有进行中的接入会话。',
  onboarding_plan_outdated: '方案刚刚更新了，已重新读取，请核对后再确认。',
  onboarding_changes_outdated: '项目现状或方案刚刚变化，已重新读取，请核对后再确认。',
  onboarding_apply_running: '这个仓库正在应用另一份确认，稍后再试。',
  onboarding_nothing_to_apply: '项目现状已经和方案一致，没有要改的。',
  onboarding_start_required: '还没启动的仓库必须保留「启动项目」这一项。',
  invalid_onboarding_items: '至少保留一项再确认。',
  onboarding_item_not_failed: '这一项不是失败状态，不需要重试。',
  onboarding_request_not_found: '这个仓库没有待处理的启动申请。',
  onboarding_request_closed: '这份申请已经处理或失效。',
};
const repoOnboardingErrorText = err => repoOnboardingErrors[err?.code] || readErrorText(err);
const repoOnboardingCeiling = level => (typeof projectCeilingOptions !== 'undefined' && projectCeilingOptions.find(([value]) => value === level)) || [level, level, ''];
function repoOnboardingEvent(key) {
  const caption = typeof projectEventCaptions !== 'undefined' ? projectEventCaptions.find(([value]) => value === key)?.[1] : null;
  return caption || { 'issue.labels': '只处理带这些标签的 Issue', 'pull_request.labels': '只处理带这些标签的 PR' }[key] || key;
}
const repoOnboardingEventValue = value => Array.isArray(value) ? (value.length ? value.join('、') : '不限标签') : value === true ? '开' : value === false ? '关' : '—';

/**
 * Which step the onboarding is at, from what the control plane returned and whether a turn is running. The confirmed
 * application is the current one when the page's plan is the one confirmed, or when no session is open any more.
 */
function repoOnboardingPhase(view, active, lastTurn) {
  const application = view.application, plan = view.plan;
  if (application && (plan ? plan.confirmed : !view.session)) {
    const receipts = application.receipts;
    if (view.request?.state === 'pending' && receipts.some(r => r.item === 'start' && r.state === 'pending' && r.error === 'start_approval_pending')) return 'requested';
    if (application.applying || receipts.some(r => r.state === 'running' || r.state === 'pending' && r.error !== 'start_approval_pending')) return 'applying';
    return 'done';
  }
  if (active) return 'analyzing';
  if (!view.session) return 'start';
  const questions = view.questions, asked = questions ? Date.parse(questions.asked_at) : 0;
  // Questions are open until a later message answers them or a later plan replaces them.
  if (questions && !(lastTurn && Date.parse(lastTurn.created_at) > asked) && !(plan && Date.parse(plan.created_at) > asked)) return 'answering';
  if (plan) return 'confirming';
  if (!lastTurn) return 'start';
  return ['failed', 'stopped', 'interrupted'].includes(lastTurn.state) ? 'stalled' : 'conversation';
}
const repoOnboardingPhaseNames = { start: ['未开始', ''], analyzing: ['分析中', 'info'], stalled: ['分析未完成', 'warning'], conversation: ['待补充', 'info'],
  answering: ['待回答', 'warning'], confirming: ['待确认', 'warning'], requested: ['已申请（等待超管）', 'info'], applying: ['应用中', 'info'], done: ['完成', 'success'] };
const repoOnboardingStepOf = { start: 0, analyzing: 0, stalled: 0, conversation: 0, answering: 1, confirming: 2, requested: 3, applying: 3, done: 4 };

async function renderRepositoryOnboarding(request) {
  repoOnboardingPage?.dispose(); repoOnboardingPage = null;
  const id = repositoryOnboardingAddress.exec(location.hash)?.[1], page = $('console-page');
  page.replaceChildren(consoleState('正在读取接入向导', '读取这个仓库的接入会话、问题和方案。', { tone: 'loading' }));
  let view;
  try { view = await api('/api/management/onboarding/' + id); }
  catch (err) {
    if (request !== renderVersion || tab !== 'repository-onboarding') return;
    const box = consoleState('无法打开接入向导', repoOnboardingErrorText(err), { tone: 'error', retry: () => renderRepositoryOnboarding(++renderVersion), retryLabel: '重试' });
    const links = element('div', '', 'actions'); links.append(consoleLink('#/projects', '回到项目列表'), consoleLink('#/identity', '查看身份与权限')); box.append(links);
    page.replaceChildren(box); return;
  }
  if (request !== renderVersion || tab !== 'repository-onboarding') return;
  repoOnboardingPage = mountRepositoryOnboarding(page, id, view);
  if (typeof applyDocumentTitle === 'function') applyDocumentTitle();
}

function mountRepositoryOnboarding(page, id, initial) {
  const address = location.hash, user = me;
  let view = initial, disposed = false, conversation = view.session?.conversation_id ?? null, cursor = 0, active = null, reading = null, streamController = null;
  let busy = '', pollTimer = 0, phase = '', project = null, showHistory = false;
  // What the reader chose but has not sent yet survives a repaint: items left out of the plan, answers being chosen.
  const excluded = new Set(), answers = new Map(); let excludedPlan = null, answersFor = null;
  const messages = new Map(), turns = new Map(), questionCards = new Map(), questionCalls = new Map(), signatures = {};
  const tabKey = 'repository-onboarding-tab:' + id;
  let shownTab = (() => { try { const saved = sessionStorage.getItem(tabKey); return ['chat', 'profile', 'plan'].includes(saved) ? saved : 'chat'; } catch { return 'chat'; } })();
  const alive = () => !disposed && me === user && root.isConnected;

  // ---- Skeleton ----
  const root = element('div', '', 'ro-page'); root.dataset.testid = 'repository-onboarding';
  const head = element('div', '', 'console-page-head ro-head'), heading = element('div', '', 'ro-heading');
  const chip = element('span', '', 'status ro-phase'); chip.dataset.testid = 'onboarding-phase';
  const titleRow = element('div', '', 'ro-title'); titleRow.append(element('h1', view.repository.full_name), chip);
  const scopeLine = element('p', '', 'muted ro-scope');
  heading.append(element('p', '仓库接入', 'eyebrow'), titleRow, scopeLine);
  const steps = element('ol', '', 'ro-steps'); steps.setAttribute('aria-label', '接入进度');
  const next = element('section', '', 'ro-next'); next.setAttribute('aria-label', '下一步'); next.dataset.testid = 'onboarding-next';
  const nextText = element('p', '', 'ro-next-text'), nextActions = element('div', '', 'actions ro-next-actions');
  next.append(nextText, nextActions);
  const problem = element('p', '', 'view-error ro-problem'); problem.setAttribute('role', 'alert'); problem.hidden = true;
  head.append(heading, steps, next, problem);

  const done = element('section', '', 'ro-done'); done.dataset.testid = 'onboarding-done'; done.hidden = true;
  const work = element('div', '', 'ro-work');
  const tabs = element('div', '', 'ro-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '接入向导内容');
  const layout = element('div', '', 'ro-layout'), side = element('div', '', 'ro-side');
  const panel = (key, title, className) => {
    const box = element('section', '', 'ro-panel ' + className); box.dataset.panel = key; box.id = 'ro-panel-' + key;
    box.setAttribute('role', 'tabpanel'); box.setAttribute('aria-labelledby', 'ro-tab-' + key);
    const body = element('div', '', 'ro-panel-body'); if (title) box.append(element('h2', title)); box.append(body); return { box, body };
  };
  const chat = panel('chat', '', 'ro-chat'), profilePanel = panel('profile', '仓库画像', 'ro-profile'), planPanel = panel('plan', '方案', 'ro-plan');
  const tabButtons = {};
  for (const [key, caption] of [['chat', '对话'], ['profile', '画像'], ['plan', '方案']]) {
    const b = button(caption, () => showTab(key), 'quiet ro-tab'); b.id = 'ro-tab-' + key; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'ro-panel-' + key);
    b.append(element('span', '', 'ro-tab-badge')); tabButtons[key] = b; tabs.append(b);
  }
  side.append(profilePanel.box, planPanel.box); layout.append(chat.box, side); work.append(tabs, layout);
  const historyToggle = button('查看接入对话和方案', () => { showHistory = !showHistory; paint(); }, 'quiet ro-history-toggle'); historyToggle.hidden = true;
  root.append(head, done, historyToggle, work); page.replaceChildren(root);

  // The conversation: its feed, a status line and the composer with 停止.
  const feed = element('div', '', 'ro-feed'); feed.setAttribute('role', 'log'); feed.setAttribute('aria-label', '接入对话'); feed.setAttribute('aria-live', 'polite');
  const welcome = element('div', '', 'ro-welcome');
  welcome.append(element('h2', '先让助手读懂这个仓库'), element('p', '助手只读分析：读 README、目录、CI、标签和最近的 Issue／PR，不写 GitHub，也不启动项目。几分钟内给出仓库画像、几个问题和推荐方案；方案在你确认后才生效。', 'muted'));
  feed.append(welcome);
  const status = element('p', '', 'ro-status muted'); status.setAttribute('role', 'status');
  const reconnect = button('重新连接', () => { problem.hidden = true; void readConversation(); }, 'quiet'); reconnect.hidden = true;
  const statusBar = element('div', '', 'ro-status-bar'); statusBar.append(status, reconnect);
  const composer = document.createElement('form'); composer.className = 'ro-composer';
  const message = textarea('onboarding-message', '', { rows: 3, placeholder: '回答问题、补充情况，或告诉助手想怎么调整方案…', maxLength: 16000 }); message.setAttribute('aria-label', '给接入助手的消息');
  const stop = button('停止', () => void stopTurn(), 'quiet ro-stop'), send = element('button', '发送', 'btn-primary'); send.type = 'submit';
  const composerActions = element('div', '', 'actions'); composerActions.append(stop, send);
  const composerFoot = element('div', '', 'ro-composer-foot'); composerFoot.append(element('span', 'Ctrl / ⌘ + Enter 发送', 'muted'), composerActions);
  composer.append(message, composerFoot);
  chat.body.append(feed, statusBar, composer);
  composer.addEventListener('submit', event => { event.preventDefault(); const text = message.value.trim(); if (text) void say(text).then(sent => { if (sent && message.value.trim() === text) message.value = ''; }); });
  message.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } });

  const showProblem = text => { problem.textContent = text; problem.hidden = !text; };
  const showStatus = text => { status.textContent = text; };
  function showTab(key) {
    shownTab = key; try { sessionStorage.setItem(tabKey, key); } catch { /* The tab only lasts this view without storage. */ }
    root.dataset.tab = key;
    for (const [name, b] of Object.entries(tabButtons)) { b.setAttribute('aria-selected', String(name === key)); b.tabIndex = name === key ? 0 : -1; }
  }
  tabs.addEventListener('keydown', event => {
    const keys = Object.keys(tabButtons), at = keys.indexOf(shownTab);
    const to = event.key === 'ArrowRight' ? keys[(at + 1) % keys.length] : event.key === 'ArrowLeft' ? keys[(at + keys.length - 1) % keys.length] : null;
    if (to) { event.preventDefault(); showTab(to); tabButtons[to].focus(); }
  });

  // ---- Server calls ----
  const base = '/api/management/onboarding/' + id;
  async function refresh() {
    try {
      const next = await api(base); if (!alive()) return;
      // Another administrator may have started a new session meanwhile: follow it.
      const before = conversation; view = next; conversation = view.session?.conversation_id ?? null;
      if (conversation !== before) { resetFeed(); if (conversation) void readConversation(); }
    }
    catch (err) { if (alive()) showProblem('读取接入状态失败：' + repoOnboardingErrorText(err)); }
  }
  async function act(name, work) {
    if (busy) return false; busy = name; showProblem(''); paint();
    try { await work(); return true; }
    catch (err) {
      if (!alive()) return false;
      // A plan or a project that changed under the page is read again, so the next confirmation names what is true now.
      if (['onboarding_changes_outdated', 'onboarding_plan_outdated'].includes(err.code)) await refresh();
      showProblem(repoOnboardingErrorText(err)); return false;
    } finally { if (alive()) { busy = ''; paint(); schedulePoll(); } }
  }
  // Opens the repository's session (or the one already open) and sends a first message, which starts the analysis.
  const begin = (text = '请开始分析这个仓库，给出仓库画像、需要我回答的问题和推荐方案。') => act('open', async () => {
    if (!view.session) { view = await api(base, 'POST', {}); conversation = view.session.conversation_id; resetFeed(); }
    await post(text);
  });
  // A new session: the previous one is closed (its conversation and drafts stay readable to the control plane).
  const restart = () => act('restart', async () => {
    if (view.session) await api(base + '/close', 'POST', {});
    view = await api(base, 'POST', {}); conversation = view.session.conversation_id; resetFeed();
    await post('请重新分析这个仓库，对照它现在的设置，只列出建议改变的项。');
  });
  async function post(text) {
    const sent = await api(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: crypto.randomUUID(), content: text });
    messages.set(sent.id, { id: sent.id, state: sent.state ?? 'pending', input: { content: text }, principal_id: me.id, created_at: new Date().toISOString() });
    turn(sent.id); active = sent.id; showTab('chat'); feed.scrollTop = feed.scrollHeight;
    void readConversation();
  }
  const say = text => act('send', () => post(text));
  async function stopTurn() {
    if (!active || !conversation) return;
    try { await api(`/api/management/conversations/${conversation}/messages/${active}/stop`, 'POST', {}); showStatus('已请求停止，当前一步结束后停下。'); status.dataset.held = '1'; }
    catch (err) { showProblem(repoOnboardingErrorText(err)); }
  }
  const confirm = items => act('confirm', async () => {
    // Applying can take a while (labels are written to GitHub one by one): read the receipts while it runs.
    const watch = setInterval(() => { void api(base).then(next => { if (alive() && busy === 'confirm') { view = next; paint(); } }).catch(() => {}); }, 1500);
    try { view = await api(base + '/confirm', 'POST', { version: view.plan.version, changes_revision: view.plan.changes_revision, items }); }
    finally { clearInterval(watch); }
  });
  const retry = item => act('retry:' + item, async () => { view = await api(`${base}/items/${item}/retry`, 'POST', {}); });
  const withdraw = () => act('withdraw', async () => { view = await api(base + '/request/withdraw', 'POST', {}); });

  // Waiting for someone else (the super administrator's decision) or for items to finish: read the state again now and then.
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (disposed || busy) return;
    const delay = phase === 'applying' ? 2000 : phase === 'requested' ? 10000 : 0;
    if (delay) pollTimer = setTimeout(async () => { await refresh(); if (alive()) { paint(); schedulePoll(); } }, delay);
  }

  // ---- Conversation ----
  function resetFeed() { streamController?.abort(); cursor = 0; active = null; messages.clear(); turns.clear(); questionCards.clear(); questionCalls.clear(); answers.clear(); answersFor = null; welcome.hidden = false; feed.replaceChildren(welcome); }
  function turn(messageId) {
    if (turns.has(messageId)) return turns.get(messageId);
    const record = messages.get(messageId), item = element('article', '', 'ro-turn'); item.dataset.messageId = messageId;
    if (record?.input?.content) {
      const own = record.principal_id === me.id, mine = element('div', '', 'ro-user');
      mine.append(element('strong', own ? '你' : '其他管理员'), element('p', record.input.content)); item.append(mine);
    }
    const assistant = element('div', '', 'ro-assistant'), meta = element('div', '', 'ro-assistant-meta'), badge = element('span', '', 'ro-turn-state');
    meta.append(element('strong', '接入助手'), badge);
    const reads = element('details', '', 'ro-reads'), readsSummary = element('summary', ''), readsList = element('ul', ''); reads.append(readsSummary, readsList); reads.hidden = true;
    const replies = element('div', '', 'ro-replies'), cards = element('div', '', 'ro-question-cards');
    assistant.append(meta, reads, replies, cards); item.append(assistant); feed.append(item); welcome.hidden = true;
    const value = { item, badge, reads, readsSummary, readsList, replies, cards, count: 0, provisional: null, state: record?.state ?? 'pending', stage: '正在连接助手' };
    turns.set(messageId, value); paintTurn(value); return value;
  }
  function paintTurn(value) {
    const running = ['pending', 'running'].includes(value.state);
    value.badge.textContent = running ? value.stage : { completed: '本轮完成', failed: '未完成', stopped: '已停止', interrupted: '运行中断' }[value.state] ?? value.state;
    value.badge.dataset.state = running ? 'running' : value.state;
    value.item.setAttribute('aria-busy', String(running));
    value.readsSummary.textContent = `读取与操作 ${value.count} 步`; value.reads.hidden = !value.count;
  }
  function answer(value) {
    if (value.provisional) return value.provisional;
    const node = element('div', '', 'ro-answer management-markdown'), entry = { node, text: '' };
    value.replies.append(node); value.provisional = entry; return entry;
  }
  const settle = value => { if (value.provisional) { renderManagementMarkdown(value.provisional.node, value.provisional.text); value.provisional = null; } };
  // A successful ask_onboarding_questions call is drawn under the assistant replies of the turn that asked it, so a reload
  // rebuilds every card from the conversation events. Only the session's latest questions stay editable; older cards read only.
  function renderQuestionCard(callId, messageId, questions) {
    if (questionCards.has(callId)) return questionCards.get(callId);
    const askedNow = view.questions?.message_id === messageId && JSON.stringify(view.questions.questions) === JSON.stringify(questions);
    if (askedNow && answersFor !== view.questions.asked_at) { answers.clear(); answersFor = view.questions.asked_at; }
    const node = element('section', '', 'ro-question-card'); node.dataset.messageId = messageId;
    const form = document.createElement('form'); form.className = 'ro-question-form';
    const noteNode = element('p', '这一组问题已结束。要改主意，直接在对话里告诉助手。', 'muted ro-question-note');
    form.append(noteNode);
    const fieldsets = [];
    questions.forEach((q, index) => {
      const radioName = `q-${callId}-${q.id}`, ownName = `own-${callId}-${q.id}`, key = callId + ':' + q.id;
      const set = element('fieldset', '', 'ro-question');
      set.append(element('legend', `${index + 1}. ${q.question}`));
      const options = element('div', '', 'ro-options');
      for (const option of q.options) {
        const label = element('label', '', 'ro-option'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = radioName; radio.value = option.label;
        radio.checked = option.label === (answers.get(key)?.choice ?? q.recommended);
        const text = element('span', '', 'ro-option-text'); text.append(element('strong', option.label));
        if (option.label === q.recommended) text.append(element('span', '推荐', 'status status-info ro-recommended'));
        if (option.description) text.append(element('small', option.description));
        label.append(radio, text); options.append(label);
      }
      const own = input(ownName, answers.get(key)?.extra ?? '', { placeholder: '其他想法（可选），例如只对某些目录这样做', maxLength: 1000 }); own.setAttribute('aria-label', `第 ${index + 1} 题的补充`);
      set.append(options, element('p', '推荐理由：' + q.reason, 'muted ro-reason'), own); fieldsets.push(set); form.append(set);
    });
    const submit = element('button', '提交回答', 'btn-primary'); submit.type = 'submit'; form.append(submit);
    node.append(form);
    form.addEventListener('input', () => {
      for (const q of questions) answers.set(callId + ':' + q.id, { choice: form.elements[`q-${callId}-${q.id}`]?.value, extra: form.elements[`own-${callId}-${q.id}`]?.value ?? '' });
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!questionCards.get(callId)?.open) return;
      const lines = questions.map((q, index) => {
        const chosen = form.elements[`q-${callId}-${q.id}`]?.value, extra = form.elements[`own-${callId}-${q.id}`]?.value.trim();
        return `${index + 1}. ${q.question}\n   → ${chosen || '（没有选）'}${extra ? `；补充：${extra}` : ''}`;
      });
      void say('我的回答：\n' + lines.join('\n'));
    });
    const card = { node, form, fieldsets, note: noteNode, submit, questions, messageId, open: false };
    questionCards.set(callId, card); turn(messageId).cards.append(node); paintQuestionCards(); return card;
  }
  function latestQuestionCard() {
    if (!view.questions) return null;
    let latest = null;
    for (const card of questionCards.values()) if (card.messageId === view.questions.message_id && JSON.stringify(card.questions) === JSON.stringify(view.questions.questions)) latest = card;
    return latest;
  }
  function paintQuestionCards() {
    const latest = latestQuestionCard();
    for (const card of questionCards.values()) {
      card.open = phase === 'answering' && card === latest;
      card.note.hidden = card.open; card.submit.hidden = !card.open; card.submit.disabled = !card.open || !!busy;
      card.submit.textContent = busy === 'send' ? '正在提交…' : '提交回答';
      for (const set of card.fieldsets) set.disabled = !card.open || !!busy;
    }
  }
  // What one tool call did, in words: which file or list was read, a question asked, a draft saved.
  function stepText(data) {
    const args = data.arguments || {};
    if (data.name === 'ask_onboarding_questions') return '提出问题';
    if (data.name === 'propose_onboarding_plan') return '保存方案草稿';
    if (data.name === 'github_read') return '读取 ' + (args.path || '仓库');
    if (data.name === 'github_search') return '搜索 ' + (args.query || '仓库');
    if (data.name === 'read_job_log') return '读取 Actions 日志';
    if (data.name === 'read_tool_result') return '展开先前的读取结果';
    return data.name || '操作';
  }
  function onEvent(row) {
    if (row.sequence <= cursor) return; cursor = row.sequence;
    const data = row.data || {}, value = turn(row.message_id);
    if (row.type === 'running' || row.type === 'model_start') { value.state = 'running'; value.stage = data.turn > 0 ? '正在整理结果' : '正在分析'; settle(value); }
    else if (row.type === 'tool_call') {
      settle(value);
      if (data.name === 'send_message') return paintTurn(value);
      if (data.name === 'ask_onboarding_questions' && data.arguments?.questions) questionCalls.set(data.call_id, data.arguments);
      value.count++; value.stage = stepText(data); value.readsList.append(element('li', stepText(data)));
    } else if (row.type === 'tool_result') {
      const asked = questionCalls.get(data.call_id);
      if (asked && data.name === 'ask_onboarding_questions') {
        questionCalls.delete(data.call_id);
        if (data.result?.recorded === true) renderQuestionCard(data.call_id, row.message_id, asked.questions);
      }
    } else if (row.type === 'tool_error') {
      questionCalls.delete(data.call_id);
      value.readsList.append(element('li', '未成功：' + (data.error || data.name), 'view-error'));
    }
    else if (row.type === 'message') {
      // A stage message the assistant sent while working (#435).
      settle(value); const note = element('div', '', 'ro-stage management-markdown'); renderManagementMarkdown(note, data.text || ''); value.replies.append(note); value.stage = '已发送进展';
    } else if (row.type === 'text') { const entry = answer(value); entry.text += data.delta ?? ''; entry.node.textContent = entry.text; value.stage = '正在回复'; }
    else if (row.type === 'reply') { const entry = answer(value); entry.text = data.text ?? ''; settle(value); }
    else if (row.type === 'model_retry') { if (value.provisional) { value.provisional.node.remove(); value.provisional = null; } value.stage = `模型暂时没有响应，正在重试（第 ${data.retry}/${data.retries} 次）`; }
    else if (row.type === 'done') { settle(value); value.state = data.state ?? 'completed'; }
    else if (row.type === 'error' || row.type === 'stopped') {
      settle(value); value.state = row.type === 'error' ? 'failed' : 'stopped';
      value.replies.append(element('p', row.type === 'stopped' ? '已停止。已经读到的内容和保存的草稿都保留。' : '这一轮没有完成：' + (data.notice || data.detail || data.error || '未知原因'), 'ro-turn-notice'));
    }
    paintTurn(value);
    const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 96; if (near) feed.scrollTop = feed.scrollHeight;
  }
  async function readConversation() {
    if (reading || !conversation || disposed) return reading;
    const id = conversation;
    const job = (async () => {
      try {
        for (;;) {
          if (!alive() || conversation !== id) return;
          streamController = new AbortController();
          const pageOf = await api(`/api/management/conversations/${id}/events?after=${cursor}`, 'GET', undefined, { signal: streamController.signal });
          if (!alive() || conversation !== id) return;
          for (const m of pageOf.messages) { messages.set(m.id, m); turn(m.id); }
          for (const row of pageOf.events) onEvent(row);
          if (pageOf.has_more) continue;
          const pending = pageOf.messages.find(m => ['pending', 'running'].includes(m.state));
          for (const m of pageOf.messages) if (!['pending', 'running'].includes(m.state)) { const value = turn(m.id); settle(value); value.state = m.state; paintTurn(value); }
          const was = active; active = pending?.id ?? null;
          // A turn that just ended may have asked questions or saved a plan: read the page state again.
          if (!pending) { if (was) await refresh(); if (alive()) { reconnect.hidden = true; paint(); } return; }
          paint();
          streamController = new AbortController();
          const response = await fetch(`/api/management/conversations/${id}/events?stream=1&after=${cursor}`, { signal: streamController.signal });
          if (!response.ok) throw new Error('读取分析进展失败');
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
          for (;;) {
            const part = await reader.read(); if (!alive() || conversation !== id) { await reader.cancel(); return; }
            if (part.done) { if (text.trim()) onEvent(JSON.parse(text)); break; }
            text += decoder.decode(part.value, { stream: true });
            let at; while ((at = text.indexOf('\n')) >= 0) { const line = text.slice(0, at); text = text.slice(at + 1); if (line) onEvent(JSON.parse(line)); }
          }
        }
      } catch (err) {
        if (alive() && err?.name !== 'AbortError') { reconnect.hidden = false; showProblem('连接中断：' + readErrorText(err) + '。分析在服务端继续，点「重新连接」读取进展。'); }
      }
    })();
    reading = job;
    try { await job; } finally { if (reading === job) reading = null; }
  }

  // ---- Panels ----
  const planOf = () => view.plan?.plan ?? null;
  // The plan's bot-scheduling recommendation (#1072): never applied with the plan and never in the way of the start. Once the
  // project is started it can go to the management assistant, as a request to send, or to the schedules page.
  function dispatchRecommendation() {
    const recommended = planOf()?.scheduled_dispatch; if (!recommended?.workflows?.length) return null;
    const box = element('section', '', 'ro-recommendation'); box.dataset.item = 'scheduled_dispatch';
    const head = element('div', '', 'ro-receipt-head');
    head.append(element('strong', '用 Bot 定时触发 workflow'), element('span', '推荐 · 可选', 'status status-info'));
    const list = element('ul', '', 'ro-recommendation-list');
    for (const w of recommended.workflows) list.append(element('li', `${w.path}：${w.cron}${w.delay ? '，' + w.delay : ''}`));
    box.append(head, element('p', recommended.reason), list,
      note('GitHub 的定时触发在高峰时会推迟甚至丢掉。做法：项目定时任务到点用 workflow_dispatch 触发；workflow 保留 schedule 兜底，concurrency 设 cancel-in-progress: false，第一个 job 在 schedule 触发且已有成功的手动运行时跳过后面的 job。这一项不随方案应用，也不影响启动项目。'));
    const actions = element('div', '', 'actions');
    if (view.repository.started) {
      const workflows = recommended.workflows.map(w => `${w.path}（${w.cron}）`).join('、');
      const ask = `请为 ${view.repository.full_name} 开启 Bot 定时触发：${workflows}。先核对这些 workflow 有没有声明 workflow_dispatch，再建项目定时任务按时触发（触发前先查看有没有排队或正在运行的运行，有就不触发）；没有声明的，提一个 Issue 推荐：加 workflow_dispatch、保留 schedule 兜底、concurrency 设 cancel-in-progress: false、第一个 job 在 schedule 触发且已有成功的手动运行时跳过。`;
      actions.append(button('交给管理助手', () => void openManagementChat().then(() => managementChat?.client?.draft?.(ask)).catch(error), 'btn-secondary'),
        consoleLink(`#/projects/${id}/schedules`, '去定时任务页', '使用「定时触发 workflow」模板'));
    } else actions.append(note('项目启动后可以交给管理助手处理，或在项目的「定时任务与通知」页添加。'));
    box.append(actions);
    return box;
  }
  function paintProfile() {
    const plan = planOf(), signature = JSON.stringify(plan?.profile ?? null) + (phase === 'analyzing');
    if (signatures.profile === signature) return; signatures.profile = signature;
    const body = profilePanel.body;
    if (!plan?.profile) { body.replaceChildren(note(phase === 'analyzing' ? '助手正在读取仓库，画像会和方案一起出现在这里。' : '助手给出方案后，这里显示仓库是做什么的、技术栈、协作方式、CI 和标签现状。')); return; }
    const p = plan.profile, list = element('dl', '', 'ro-facts');
    const fact = (term, value) => { if (!value || Array.isArray(value) && !value.length) return; list.append(element('dt', term), element('dd', Array.isArray(value) ? value.join('、') : value)); };
    fact('技术栈', p.stack); fact('协作方式', p.collaboration); fact('CI', p.ci); fact('标签', p.labels); fact('近期活动', p.activity);
    const summary = element('div', '', 'management-markdown ro-profile-summary'); renderManagementMarkdown(summary, p.summary);
    const sources = element('details', '', 'ro-sources'); sources.append(element('summary', `依据（读取了 ${p.sources.length} 处）`), ...p.sources.map(s => element('p', s, 'muted')));
    body.replaceChildren(summary, list, sources);
  }
  // One change of the plan in words: what it is now and what it becomes.
  function changeBody(change) {
    const box = element('div', '', 'ro-change-body'), proposed = change.proposed, current = change.current;
    const line = (text, className = '') => box.append(element('p', text, className));
    switch (change.item) {
      case 'start': {
        const trusted = proposed.organization_trusted;
        line(me.role === 'super_admin' ? '确认后由你直接启动项目，使用部署默认的共享模型。'
          : trusted ? '所属组织已受信任：确认后你直接启动项目，模型和能力上限先用组织的默认值。'
            : '所属组织未受信任：确认后向超级管理员申请启动，同意后其余各项自动生效。');
        if (proposed.capability_ceiling) line('方案的能力上限：' + repoOnboardingCeiling(proposed.capability_ceiling)[1], 'muted');
        break;
      }
      case 'capability_ceiling': line(`${current ? repoOnboardingCeiling(current)[1] : '启动时的默认值'} → ${repoOnboardingCeiling(proposed)[1]}`); line(repoOnboardingCeiling(proposed)[2], 'muted'); break;
      case 'events': for (const [key, value] of Object.entries(proposed)) line(`${repoOnboardingEvent(key)}：${current && key in current ? repoOnboardingEventValue(current[key]) + ' → ' : ''}${repoOnboardingEventValue(value)}`); break;
      case 'test_command': { const code = element('code', proposed); const p = element('p', current ? `原来：${current}；改为 ` : ''); p.append(code); box.append(p); line('确认时不运行；首个任务或 CI 任务运行它时验证。', 'muted'); break; }
      case 'review_language': line(`${current ? repoOnboardingLanguages[current] ?? current : '默认'} → ${repoOnboardingLanguages[proposed] ?? proposed}`); break;
      case 'conventions': {
        for (const [key, caption] of [['label_usage', '标签用法'], ['review_focus', '检视重点'], ['simple_issues', '哪些问题算简单问题']]) if (proposed[key]) { const p = element('p', ''); p.append(element('strong', caption + '：'), proposed[key]); box.append(p); }
        line('作为独立段落追加到 Manager 提示词和各角色提示词，不覆盖已有内容。', 'muted'); break;
      }
      case 'labels': {
        const chips = element('div', '', 'ro-labels');
        for (const label of proposed) { const chipNode = element('span', label.name, 'ro-label'); chipNode.style.setProperty('--ro-label', '#' + label.color); if (label.description) chipNode.title = label.description; chips.append(chipNode); }
        box.append(chips); line('在 GitHub 上新建；已经存在的同名标签保持原样。', 'muted'); break;
      }
      case 'schedules': {
        for (const s of proposed) line(`${s.name}：${s.cron}（${s.timezone}）`);
        if (change.service_principal === 'delegated') line('定时检查以项目的服务身份运行；项目还没有这个身份，会以你的委托创建。', 'muted');
        break;
      }
      case 'ci': { const summary = element('div', '', 'management-markdown'); renderManagementMarkdown(summary, proposed.summary); box.append(summary); line('确认后建一个开发任务：bot 开 PR 改 CI，由人检视并合并，不直接改默认分支。', 'muted'); break; }
      default: line(JSON.stringify(proposed));
    }
    return box;
  }
  const confirmCaption = () => {
    const starting = view.plan?.changes?.some(c => c.item === 'start');
    if (!starting) return '确认并应用';
    return me.role === 'super_admin' || view.repository.organization_trusted ? '确认并启动' : '确认并申请启动';
  };
  function paintPlan() {
    const signature = JSON.stringify([view.plan, view.application, view.request, phase, busy]);
    if (signatures.plan === signature) return; signatures.plan = signature;
    const body = planPanel.body, plan = view.plan;
    planPanel.box.querySelector('h2').textContent = ['requested', 'applying', 'done'].includes(phase) ? '进度与回执' : '方案';
    tabButtons.plan.firstChild.textContent = ['requested', 'applying', 'done'].includes(phase) ? '进度' : '方案';
    if (['requested', 'applying', 'done'].includes(phase)) { body.replaceChildren(...requestNotice(), receiptList()); return; }
    if (!plan) { body.replaceChildren(note('助手给出方案后，这里逐项列出会改什么、在哪里生效。你可以去掉不想要的项，整份方案确认一次。')); return; }
    const intro = element('p', `第 ${plan.version} 版方案 · ${timestamp(plan.created_at)}`, 'muted ro-plan-version');
    const recommendation = dispatchRecommendation();
    if (!plan.changes.length) { body.replaceChildren(intro, note('项目现状已经和这份方案一致，没有要改的。想调整什么，直接在对话里告诉助手。'), ...(recommendation ? [recommendation] : [])); return; }
    if (excludedPlan !== plan.id) { excluded.clear(); excludedPlan = plan.id; }
    const form = document.createElement('form'); form.className = 'ro-plan-form';
    const list = element('ul', '', 'ro-changes');
    for (const change of plan.changes) {
      const item = element('li', '', 'ro-change'); item.dataset.item = change.item;
      const toggle = element('label', '', 'ro-change-toggle'), box = document.createElement('input'); box.type = 'checkbox'; box.name = 'item'; box.value = change.item; box.checked = !excluded.has(change.item);
      // A repository that is not started gets nothing else without its start.
      box.disabled = change.item === 'start' || phase !== 'confirming' || !!busy;
      toggle.append(box, element('strong', repoOnboardingItemNames[change.item] ?? change.item));
      item.append(toggle, element('p', '在哪里生效：' + change.where, 'muted ro-where'), changeBody(change)); list.append(item);
    }
    const count = element('p', '', 'ro-plan-count'); count.setAttribute('aria-live', 'polite');
    const submit = element('button', busy === 'confirm' ? '正在应用…' : confirmCaption(), 'btn-primary'); submit.type = 'submit';
    const recount = () => { const n = form.querySelectorAll('input[name=item]:checked').length; count.textContent = `将应用 ${n} 项，共 ${plan.changes.length} 项`; submit.disabled = !n || !!busy || phase !== 'confirming'; };
    form.addEventListener('change', event => { if (event.target.name === 'item') { if (event.target.checked) excluded.delete(event.target.value); else excluded.add(event.target.value); } recount(); });
    form.addEventListener('submit', event => { event.preventDefault(); void confirm([...form.querySelectorAll('input[name=item]:checked')].map(b => b.value)); });
    form.append(list, count, submit); recount();
    body.replaceChildren(intro, form, ...(recommendation ? [recommendation] : []));
  }
  function requestNotice() {
    const request = view.request; if (!request) return [];
    const box = element('div', '', 'ro-request'); box.dataset.state = request.state;
    const who = request.requested_by?.github_login ? '@' + request.requested_by.github_login : request.requested_by?.name || '管理员';
    if (request.state === 'pending') box.append(element('strong', '已申请启动，等待超级管理员处理'), element('p', `${who} 于 ${timestamp(request.requested_at)} 申请（第 ${request.plan_version} 版方案）。超级管理员会在控制台和飞书私聊收到申请，同意后项目启动、方案其余各项自动生效。`, 'muted'));
    else if (request.state === 'approved') box.append(element('strong', '启动申请已同意'), element('p', `${timestamp(request.decided_at)} 同意，能力上限 ${repoOnboardingCeiling(request.decision?.capability_ceiling)[1]}${request.decision?.trust_organization ? '，并信任了这个组织' : ''}。`, 'muted'));
    else if (request.state === 'rejected') box.append(element('strong', '启动申请被拒绝'), element('p', '原因：' + (request.reason || '—'), 'ro-reject-reason'));
    else if (request.state === 'withdrawn') box.append(element('strong', '启动申请已撤回'));
    else box.append(element('strong', '启动申请已失效'));
    return [box];
  }
  function receiptList() {
    const list = element('ul', '', 'ro-receipts');
    for (const receipt of view.application?.receipts ?? []) list.append(receiptItem(receipt));
    return list;
  }
  function receiptDetail(receipt) {
    const d = receipt.detail || {};
    if (receipt.state === 'skipped') return receipt.error === 'decided_by_approval' ? `超级管理员同意时定了能力上限「${repoOnboardingCeiling(d.approved)[1]}」，这一项不再改动。` : '确认时去掉了这一项。';
    switch (receipt.error) {
      case 'start_approval_pending': return '已向超级管理员申请启动，等待同意。';
      case 'project_not_started': return '项目启动后接着应用。';
      case 'start_rejected': return '超级管理员拒绝了启动申请：' + (d.reason || '未写原因') + '。调整后点「重试」会再次申请。';
      case 'start_request_withdrawn': return '启动申请已撤回。点「重试」会再次申请。';
      case 'start_request_lapsed': return d.reason === 'organization_trusted' ? '所属组织已受信任，申请自动失效：点「重试」直接启动。' : d.reason === 'repository_not_installed' ? '仓库已不在 GitHub App 的安装范围内，申请失效。' : '申请已失效。';
      // Left by an older version: project scheduled tasks no longer report to Feishu (#1027), so a retry needs nothing more.
      case 'schedule_destination_required': return '旧版本要求选择结果发到哪个飞书会话；项目定时任务现在不发飞书，直接重试即可。';
      case 'labels_unreadable': return '读不到仓库现有的标签，稍后重试。';
      case 'labels_failed': return '有标签没建成：' + (d.labels || []).filter(l => l.state === 'failed').map(l => `${l.name}（${l.error}）`).join('、');
      case 'onboarding_item_interrupted': return '控制面重启中断了这一项，可以重试。';
      case 'start_approval_required': case 'super_admin_required': return '你不能直接启动这个仓库。';
    }
    if (receipt.error) return '未成功：' + receipt.error;
    if (receipt.item === 'start' && receipt.state === 'succeeded') return { approval: '超级管理员同意后启动', super_admin: '由超级管理员启动', trusted_organization: '按受信任组织的默认值启动' }[d.by] + (d.capability_ceiling ? `，能力上限「${repoOnboardingCeiling(d.capability_ceiling)[1]}」` : '') + '。';
    if (receipt.item === 'test_command' && receipt.state === 'succeeded') return '已保存，尚未验证：首个任务或 CI 任务运行时验证。';
    if (receipt.item === 'labels' && d.labels) return d.labels.map(l => `${l.name}${l.state === 'created' ? ' 已新建' : ' 已存在'}`).join('、');
    if (receipt.item === 'schedules' && d.schedules) return '已建项目定时任务：' + d.schedules.join('、') + (d.service_principal_created ? '（以你的委托新建了项目服务身份）' : '');
    if (receipt.item === 'conventions' && receipt.state === 'succeeded') return '已追加到 Manager 提示词' + (d.roles?.length ? '和 ' + d.roles.length + ' 个角色的提示词' : '') + '。';
    return '';
  }
  function receiptItem(receipt) {
    const [caption, tone] = repoOnboardingReceiptStates[receipt.state] ?? [receipt.state, ''];
    const waiting = receipt.state === 'pending' && receipt.error === 'start_approval_pending';
    const item = element('li', '', 'ro-receipt'); item.dataset.item = receipt.item; item.dataset.state = receipt.state;
    const top = element('div', '', 'ro-receipt-head');
    top.append(element('strong', repoOnboardingItemNames[receipt.item] ?? receipt.item), element('span', waiting ? '等待审批' : caption, 'status' + (tone ? ' status-' + tone : '')));
    item.append(top, element('p', receipt.where, 'muted ro-where'));
    const detail = receiptDetail(receipt); if (detail) item.append(element('p', detail, receipt.state === 'failed' ? 'ro-receipt-error' : 'ro-receipt-detail'));
    if (receipt.item === 'ci' && receipt.detail?.task_id) item.append(consoleLink('#/tasks/' + encodeURIComponent(receipt.detail.task_id), '查看 CI 开发任务'));
    if (receipt.state === 'failed' && !['repository_not_installed'].includes(receipt.detail?.reason)) {
      const actions = element('div', '', 'actions');
      const again = button(busy === 'retry:' + receipt.item ? '正在重试…' : '重试', () => void retry(receipt.item), 'btn-secondary');
      again.disabled = !!busy; again.setAttribute('aria-label', `重试「${repoOnboardingItemNames[receipt.item] ?? receipt.item}」`); actions.append(again); item.append(actions);
    }
    return item;
  }

  // ---- Completion page ----
  async function loadProject() {
    if (project?.id === id || !view.repository.started) return;
    try { const read = await api('/api/repositories/' + encodeURIComponent(id)); if (alive()) { project = { id, ...read }; paint(); } } catch { /* The guidance falls back to the plan. */ }
  }
  function paintDone() {
    const signature = JSON.stringify([view.application, view.request, view.repository, project?.policy ?? null, busy]);
    if (signatures.done === signature) return; signatures.done = signature;
    const receipts = view.application.receipts, failed = receipts.filter(r => r.state === 'failed'), start = receipts.find(r => r.item === 'start');
    const started = view.repository.started, plan = planOf();
    const head = element('div', '', 'ro-done-head');
    head.append(element('h2', !started ? '项目还没有启动' : failed.length ? `接入完成，有 ${failed.length} 项没有生效` : '接入完成'),
      element('p', !started ? receiptDetail(start ?? {}) || '启动没有成功，见下面的回执。' : failed.length ? '已生效的项已经在工作；没生效的项按说明处理后点「重试」。' : '方案已经生效，bot 按下面的设置开始工作。', 'muted'));
    const receiptsBox = element('section', '', 'ro-done-receipts'); receiptsBox.append(element('h3', '已应用的项和回执'), ...requestNotice(), receiptList());
    const parts = [head, receiptsBox];
    if (started) {
      const policy = project?.policy, level = policy ? projectCeilingOf(policy) : plan?.capability_ceiling?.value;
      const guide = element('section', '', 'ro-guide');
      const block = (title, ...lines) => { const box = element('div', '', 'ro-guide-item'); box.append(element('h3', title)); for (const lineNode of lines) box.append(typeof lineNode === 'string' ? element('p', lineNode) : lineNode); guide.append(box); };
      const ceiling = repoOnboardingCeiling(level);
      block('bot 现在会做什么', level ? `能力上限「${ceiling[1]}」：${ceiling[2]}` : '按项目设置处理新的 Issue 和 PR。',
        'Manager 按「监听与触发」的设置接收 Issue、PR 和 Actions 事件，决定检视、回复或开发。' + (policy?.actions_failures_enabled ? '默认分支的 Actions 失败会被分析，必要时提 Issue。' : ''));
      const dev = policy?.development_label, developing = policy?.developing_label;
      block('在 GitHub 上怎么用', '在 Issue 或 PR 的评论里 @ 这个 GitHub App 的机器人账号提问、请它检视或修改。',
        level === 'develop' ? `要 bot 开发一个 Issue：给它加开发标签${dev ? `「${dev}」` : ''}，或由维护者（triage 以上权限）在评论里提出；Manager 提示词里允许开发的规则（例如这次确认的「简单问题」约定）也算，已被别人认领的 Issue 不会自行开发。开发期间 Issue 上有${developing ? `「${developing}」标签和` : ''}一条持续更新的进展评论；bot 在自己的分支上开发并开 PR，由人合并。` : '现在的能力上限不含开发；要让 bot 开发 Issue，先在「基本设置」把能力上限调到「可开发并开 PR」。');
      const feishu = element('p', '');
      feishu.append('私聊：在「个人设置 · 飞书绑定」绑定后，私聊 bot 等同你在控制台的权限。群里：项目管理员在群里绑定这个仓库并选择权限档' + (plan?.feishu ? `，方案推荐「${repoOnboardingFeishuLevels[plan.feishu.level] ?? plan.feishu.level}」` : '') + '。 ', consoleLink('#/identity/feishu', '飞书绑定'));
      block('在飞书里怎么用', feishu);
      const where = element('div', '', 'ro-guide-links');
      for (const [section, caption, hint] of [['basic', '基本设置', '能力上限、测试命令、标签'], ['triggers', '监听与触发', '接收哪些事件'], ['roles', '角色', '提示词和本仓库约定'], ['schedules', '定时任务与通知', '项目定时任务']])
        where.append(consoleLink(`#/projects/${id}/${section}`, caption, hint));
      block('以后在哪里改', where);
      parts.push(guide);
      const recommendation = dispatchRecommendation(); if (recommendation) parts.push(recommendation);
    }
    done.replaceChildren(...parts);
  }

  // ---- Header and actions ----
  function paintSteps() {
    const labels = ['分析仓库', '回答问题', '确认方案', view.repository.started ? '应用方案' : '启动与应用', '完成'], at = repoOnboardingStepOf[phase] ?? 0;
    steps.replaceChildren(...labels.map((label, index) => {
      const item = element('li', label); item.dataset.state = index < at ? 'done' : index === at ? 'current' : 'todo';
      if (index === at) item.setAttribute('aria-current', 'step'); return item;
    }));
  }
  function actionsFor() {
    const primary = (caption, run, disabled = false) => { const b = button(caption, run, 'btn-primary'); b.disabled = disabled || !!busy; return b; };
    const secondary = (caption, run) => { const b = button(caption, run, 'btn-secondary'); b.disabled = !!busy; return b; };
    const model = view.model;
    switch (phase) {
      case 'start': return [primary(busy ? '正在开始…' : view.repository.started ? '开始重新分析' : '开始分析', () => void begin(), !model.available)];
      case 'analyzing': return [primary('分析中…', () => {}, true), button('停止', () => void stopTurn(), 'btn-secondary')];
      case 'stalled': return [primary('重试分析', () => void say('请继续分析这个仓库，给出问题和推荐方案。')), secondary('重新开始', () => void restart()), consoleLink('#/projects', '返回项目列表')];
      case 'conversation': return [primary('请助手给出方案', () => void say('请根据目前的分析给出推荐方案。'))];
      case 'answering': return [primary('去回答问题', () => {
        showTab('chat');
        const card = latestQuestionCard();
        if (!card) {
          reconnect.hidden = false;
          showProblem('问题卡片还没有读取到。先点「重新连接」读取这次提问，再点「去回答问题」。');
          return;
        }
        showProblem('');
        card.node.scrollIntoView({ block: 'center' });
        card.form.querySelector('input[type=radio]')?.focus();
      })];
      case 'confirming': return [primary(view.plan.changes.length ? '去确认方案' : '没有要改的', () => { showTab('plan'); planPanel.box.scrollIntoView({ block: 'start' }); planPanel.box.querySelector('button[type=submit]')?.focus(); }, !view.plan.changes.length)];
      case 'requested': return [secondary(busy === 'withdraw' ? '正在撤回…' : '撤回申请', () => void withdraw())];
      case 'applying': return [primary('应用中…', () => {}, true)];
      case 'done': return [
        ...(view.repository.started ? [consoleLink(`#/projects/${id}/overview`, '前往项目总览')] : []),
        secondary('重新运行接入向导', () => void restart())];
    }
    return [];
  }
  function nextStepText() {
    const failed = view.application?.receipts.filter(r => r.state === 'failed').length ?? 0;
    switch (phase) {
      case 'start': return view.model.available ? (view.repository.started ? '项目已经在运行。点「开始重新分析」，助手对照现在的设置，只列出建议改变的项；你不确认就不改。' : '点「开始分析」，助手只读分析仓库，不写 GitHub、不启动项目。')
        : '接入助手还没有可用的模型' + (view.model.notice ? '：' + view.model.notice : '') + '。请超级管理员在「全局设置 · 服务角色」给管理助手选择共享模型。';
      case 'analyzing': return '助手正在读取仓库，几分钟内给出仓库画像、问题和方案；可以随时停止。';
      case 'stalled': return '这次分析没有完成。可以重试分析，或重新开始一个新的会话。';
      case 'conversation': return '助手还没有给出问题或方案：在对话里继续补充，或请它给出方案。';
      case 'answering': return '回答助手的问题：选推荐答案或别的选项，也可以直接在对话里打字回答。助手会据此给出方案。';
      case 'confirming': return view.plan.changes.length ? `核对方案：每项写明会改什么、在哪里生效。去掉不想要的项，再点「${confirmCaption()}」。` : '项目现状已经和方案一致，没有要改的；想调整就在对话里告诉助手。';
      case 'requested': return '已向超级管理员申请启动；同意后项目启动、方案自动生效，结果会通知你。可以撤回申请。';
      case 'applying': return '正在逐项应用方案，每项完成后都有回执。';
      case 'done': return !view.repository.started ? '项目没有启动：按回执里的说明处理后重试。' : failed ? `有 ${failed} 项没有生效：按说明处理后点「重试」。` : '方案已经生效。下面说明 bot 现在会做什么、怎么用、以后在哪里改。';
    }
    return '';
  }
  function paint() {
    if (!alive()) return;
    const lastTurn = [...messages.values()].at(-1);
    phase = repoOnboardingPhase(view, active, lastTurn);
    const [caption, tone] = repoOnboardingPhaseNames[phase]; chip.textContent = phase === 'done' && view.application?.receipts.some(r => r.state === 'failed') ? '部分未生效' : caption;
    chip.className = 'status ro-phase' + (tone ? ' status-' + tone : ''); root.dataset.phase = phase;
    const usage = view.usage?.requests ? ` · 分析用了 ${view.usage.requests} 次模型请求，记在这个仓库的用量里` : '';
    scopeLine.textContent = (view.repository.started ? '已启动的项目' + (phase === 'done' ? '' : ' · 只列出建议改变的项，不确认就不改') : view.repository.organization_trusted ? '还没启动 · 所属组织已受信任，确认后可以直接启动' : '还没启动 · 确认后需要超级管理员同意启动') + usage;
    paintSteps(); nextText.textContent = nextStepText(); nextActions.replaceChildren(...actionsFor());
    const finished = phase === 'done';
    done.hidden = !finished; historyToggle.hidden = !finished; work.hidden = finished && !showHistory;
    historyToggle.textContent = showHistory ? '收起接入对话和方案' : '查看接入对话和方案'; historyToggle.setAttribute('aria-expanded', String(showHistory));
    if (finished) { paintDone(); void loadProject(); }
    paintProfile(); paintQuestionCards(); paintPlan();
    const running = !!active, open = !!view.session;
    message.disabled = !open || phase === 'applying'; send.disabled = !open || running || !!busy || phase === 'applying'; stop.hidden = !running;
    composer.classList.toggle('is-running', running);
    // A stop that was asked for keeps its line until the turn ends; otherwise the line follows the turn.
    if (!running || !status.dataset.held) { delete status.dataset.held; showStatus(!open ? '还没有开始分析。' : running ? '助手正在处理，可以先写下一条消息。' : phase === 'applying' ? '方案应用中，暂时不能发消息。' : '就绪 · 可以继续补充情况或请助手调整方案'); }
    tabButtons.plan.querySelector('.ro-tab-badge').textContent = phase === 'confirming' && view.plan.changes.length ? String(view.plan.changes.length) : '';
    schedulePoll();
  }

  showTab(shownTab); paint();
  if (conversation) void readConversation();
  return { address, dispose() { disposed = true; clearTimeout(pollTimer); streamController?.abort(); } };
}
