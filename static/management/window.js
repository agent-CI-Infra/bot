let managementChat = null;
function managementChatState() {
  const chat = managementChat;
  return chat ? { active: !!chat.active, unread: !!chat.unread, open: !chat.window.hidden } : null;
}
function syncManagementChat() {
  if (managementChat?.user === me?.id && me) return;
  managementChat?.client?.dispose();
  managementChat?.cleanup();
  managementChat?.window.remove(); managementChat = null;
  document.body.classList.remove('management-page-mode');
  if (!me) return;
  const box = element('section', '', 'management-window management-page'); box.id = 'management-chat'; box.hidden = true;
  box.setAttribute('role', 'region'); box.setAttribute('aria-label', '管理助手');
  const panel = element('div', '', 'management-panel'); box.append(panel);
  document.body.append(box);
  const chat = managementChat = { user: me.id, window: box, panel, client: null, loading: null, openVersion: 0, active: false, unread: false };
  const header = document.querySelector('body > header');
  const updateViewport = () => {
    box.style.setProperty('--management-header-height', (header?.getBoundingClientRect().height || 0) + 'px');
    box.toggleAttribute('data-compact', !box.hidden && box.getBoundingClientRect().height < 520);
  };
  chat.updateViewport = updateViewport;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateViewport) : null;
  if (header) observer?.observe(header);
  const scopeBar = document.getElementById('console-mobile-scope');
  if (scopeBar) observer?.observe(scopeBar);
  window.addEventListener('resize', updateViewport);
  chat.cleanup = () => { observer?.disconnect(); window.removeEventListener('resize', updateViewport); };
}
async function openManagementPage(projectId = null) {
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  const address = consolePageAddress('management', projectId || consoleScope());
  if (location.hash !== address) history.pushState(null, '', address);
  await route();
}
