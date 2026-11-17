async function renderManagementPage() {
  const receipt = /^#\/management\/commands\/([a-f0-9]+)$/.exec(location.hash)?.[1];
  if (receipt) { leaveManagementPage(receiptShownId === receipt); await renderManagementReceiptPage(receipt); return; }
  hideManagementReceiptPage();
  syncManagementChat(); const project = consoleScope();
  if (paintedAddress && !/^#\/management(?:\/|$)/.test(paintedAddress) && projectRoute(paintedAddress)?.section !== 'management') {
    managementChat.returnAddress = paintedAddress;
  }
  window.scrollTo(0, 0); await openManagementChat(project, { mode: 'page' });
}
function leaveManagementPage(keepReceipt = false) {
  hideManagementReceiptPage(keepReceipt);
  const chat = managementChat; if (!chat || !(chat.mode === 'page' || chat.mode === 'fullscreen' && chat.fullscreenFrom === 'page')) return;
  chat.openVersion++; setManagementPresentation(chat, 'floating'); minimizeManagementChat(false);
}
async function floatManagementPage() {
  const chat = managementChat; if (!chat) return;
  // The chat is already open: keep it and focus synchronously. Loading the underlying page must not take focus back
  // from a resize handle or another control the person has started using in the meantime.
  chat.openVersion++; setManagementPresentation(chat, 'floating'); chat.client?.focus();
  const scope = consoleScope(), previous = projectRoute(chat.returnAddress), page = addressTab(chat.returnAddress);
  // Changing presentation keeps the current conversation. Restore the underlying page type in the current scope.
  const section = projectConsolePages.includes(page) ? page : previous?.section || 'projects';
  const destination = consoleAddressScope(chat.returnAddress) === undefined ? chat.returnAddress
    : scope ? consolePageAddress(section, scope) : consolePageAddress(projectConsolePages.includes(section) ? section : 'projects', null);
  history.replaceState(null, '', destination); await route();
}
function minimizeManagementChat(focus = true) {
  const chat = managementChat; if (!chat || chat.window.hidden) return;
  if (chat.mode === 'page' || chat.mode === 'fullscreen' && chat.fullscreenFrom === 'page') return floatManagementPage();
  if (chat.mode === 'fullscreen') setManagementPresentation(chat, 'floating');
  chat.window.hidden = true; chat.launcher.hidden = false; chat.launcher.setAttribute('aria-expanded', 'false');
  // #481: a phone has no floating launcher to take focus back, so the bar's 助手 destination does, and the bar also
  // learns that the chat is closed again.
  if (focus) { const bar = document.querySelector('#console-mobile-nav a[data-page="assistant"]'); if (bar && consoleMedia.matches) bar.focus({ preventScroll: true }); else chat.launcher.focus(); }
  if (typeof updateConsoleAssistant === 'function') updateConsoleAssistant();
}
const MANAGEMENT_SLOW_NOTICE = 3000, MANAGEMENT_CONNECT_TIMEOUT = 10000;
async function openManagementChat(projectId = null, { mode = 'floating' } = {}) {
  syncManagementChat(); const chat = managementChat; if (!chat) return;
  const version = ++chat.openVersion;
  setManagementPresentation(chat, mode);
  chat.window.hidden = false; chat.launcher.hidden = true; chat.launcher.setAttribute('aria-expanded', 'true'); chat.unread = false;
  // The presentation was set while the window was still hidden, so a hidden box measured 0: the bar it takes off screen
  // was still in the layout, and a page view's own height was not readable yet. Measure again now that it is visible —
  // the floating panel re-fits (#641 F5), and a page/fullscreen view settles its own compact tag.
  chat.updateViewport();
  const focusAtOpen = document.activeElement;
  const activity = (active, received = false) => {
    if (managementChat !== chat) return;
    chat.active = active; if (received && chat.window.hidden) chat.unread = true;
    chat.state.textContent = active ? '正在处理…' : chat.unread ? '有新回复' : '随时唤起';
    chat.launcher.classList.toggle('has-update', active || chat.unread);
    if (typeof updateConsoleAssistant === 'function') updateConsoleAssistant();
  };
  if (!chat.loading && !chat.client) {
    // #641: a first query that never returns used to leave the panel saying 「正在连接」 forever. Three seconds in it says
    // the wait is slow and offers 取消; at ten seconds it stops waiting and states the failure with 重试 and 查看项目列表.
    // The request is aborted, so a late answer cannot repaint over the failure or the reader's next choice.
    const controller = new AbortController();
    let timedOut = false, cancelled = false;
    const connecting = element('div', '', 'management-connecting');
    const slow = note('仍在连接，网络较慢时可能需要多等一会儿'); slow.hidden = true;
    const cancel = button('取消', () => { cancelled = true; controller.abort(); minimizeManagementChat(); });
    cancel.hidden = true;
    connecting.append(note('正在连接管理助手…'), slow, cancel);
    chat.panel.replaceChildren(connecting);
    const slowTimer = setTimeout(() => {
      if (managementChat !== chat || chat.panel.firstElementChild !== connecting) return;
      slow.hidden = false; cancel.hidden = false;
    }, MANAGEMENT_SLOW_NOTICE);
    // Retrying after a timeout starts a fresh connect even though the abandoned request may still be settling.
    const reconnect = () => { chat.loading = null; chat.client = null; openManagementChat(projectId, { mode: chat.mode }); };
    const timeoutTimer = setTimeout(() => {
      timedOut = true; controller.abort();
      if (managementChat !== chat) return;
      const box = consoleState('管理助手暂时连不上', '可以稍后重试，或先去项目列表查看进展。', { tone: 'error', retry: reconnect, retryLabel: '重试' });
      box.append(consoleLink('#/projects', '查看项目列表'));
      chat.panel.replaceChildren(box);
    }, MANAGEMENT_CONNECT_TIMEOUT);
    chat.loading = renderManagement(chat.panel, projectId, activity, { signal: controller.signal }).then(client => {
      if (managementChat !== chat) { client?.dispose(); return; }
      chat.client = client;
      // #623: the picker may have moved while this panel was connecting, and the render chose its scope before that
      // change. Now that a client exists, replay the change so the control, the sentence and the conversation follow.
      if (client) syncManagementScope();
    }).catch(err => {
      if (managementChat !== chat || timedOut || cancelled) return;
      const box = consoleState('无法连接管理助手', managementAccessMessage(err), { tone: 'error', retry: reconnect });
      box.querySelector('button').textContent = '重试';
      box.append(consoleLink('#/projects', '查看项目列表'));
      chat.panel.replaceChildren(box);
    }).finally(() => { clearTimeout(slowTimer); clearTimeout(timeoutTimer); chat.loading = null; });
  }
  await chat.loading;
  if (managementChat !== chat || version !== chat.openVersion || !chat.client) return;
  await syncManagementScope();
  if (!chat.window.hidden && document.activeElement === focusAtOpen) chat.client.focus();
  activity(chat.active);
}

// Both the page and floating assistant use the resolved address. A connection completing late re-reads this value.
function syncManagementScope() {
  const chat = managementChat;
  if (!chat?.client) return;
  const project = consoleScope();
  return chat.client.setScope(project ? 'project:' + project : 'platform').catch(() => { /* The chat renders its own access error. */ });
}
