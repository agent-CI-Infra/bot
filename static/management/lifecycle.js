async function renderManagementPage() {
  const receipt = /^#\/management\/commands\/([a-f0-9]+)$/.exec(location.hash)?.[1];
  if (receipt) { leaveManagementPage(receiptShownId === receipt); await renderManagementReceiptPage(receipt); return; }
  hideManagementReceiptPage();
  syncManagementChat();
  window.scrollTo(0, 0); await openManagementChat(consoleScope());
}
function leaveManagementPage(keepReceipt = false) {
  hideManagementReceiptPage(keepReceipt);
  const chat = managementChat; if (!chat) return;
  chat.openVersion++; chat.window.hidden = true;
  document.body.classList.remove('management-page-mode'); chat.updateViewport();
  if (typeof updateConsoleAssistant === 'function') updateConsoleAssistant();
}
const MANAGEMENT_SLOW_NOTICE = 3000, MANAGEMENT_CONNECT_TIMEOUT = 10000;
async function openManagementChat(projectId = null) {
  syncManagementChat(); const chat = managementChat; if (!chat) return;
  const version = ++chat.openVersion;
  chat.window.hidden = false; chat.unread = false;
  document.body.classList.add('management-page-mode'); chat.updateViewport();
  if (typeof updateConsoleAssistant === 'function') updateConsoleAssistant();
  const focusAtOpen = document.activeElement;
  const activity = (active, received = false) => {
    if (managementChat !== chat) return;
    chat.active = active; if (received && chat.window.hidden) chat.unread = true;
    if (typeof updateConsoleAssistant === 'function') updateConsoleAssistant();
  };
  if (!chat.loading && !chat.client) {
    const controller = new AbortController();
    let timedOut = false, cancelled = false;
    const connecting = element('div', '', 'management-connecting');
    const slow = note('仍在连接，网络较慢时可能需要多等一会儿'); slow.hidden = true;
    const reconnect = () => { chat.loading = null; chat.client = null; openManagementChat(projectId); };
    const cancel = button('取消', () => {
      cancelled = true; controller.abort();
      const box = consoleState('已取消连接', '可以重试，或先从侧栏打开其他页面。', { retry: reconnect, retryLabel: '重试' });
      box.append(consoleLink('#/projects', '查看项目列表')); chat.panel.replaceChildren(box);
    });
    cancel.hidden = true;
    connecting.append(note('正在连接管理助手…'), slow, cancel);
    chat.panel.replaceChildren(connecting);
    const slowTimer = setTimeout(() => {
      if (managementChat !== chat || chat.panel.firstElementChild !== connecting) return;
      slow.hidden = false; cancel.hidden = false;
    }, MANAGEMENT_SLOW_NOTICE);
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
function syncManagementScope() {
  const chat = managementChat;
  if (!chat?.client) return;
  const project = consoleScope();
  return chat.client.setScope(project ? 'project:' + project : 'platform').catch(() => { /* The chat renders its own access error. */ });
}
