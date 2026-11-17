// One authenticated chat surface survives page navigation. Minimizing it never cancels a submitted command.
let managementChat = null;
// #623: a picker change can arrive while a panel is still connecting, before it has a client to forward the change to.
// Remember it on that one chat, so the connection that finishes afterwards replays it instead of keeping the scope the
// render began with.
const pendingScopeChange = new WeakMap();
// #481: the phone's bottom bar is the assistant's only entry point, so it reads the same state the floating
// launcher shows on wide screens instead of keeping a second copy of it.
function managementChatState() {
  const chat = managementChat;
  return chat ? { active: !!chat.active, unread: !!chat.unread, open: !chat.window.hidden } : null;
}
function syncManagementChat() {
  if (managementChat?.user === me?.id && me) return;
  managementChat?.client?.dispose();
  managementChat?.cleanup();
  managementChat?.window.remove(); managementChat?.launcher.remove(); managementChat = null;
  document.body.classList.remove('management-page-mode', 'management-fullscreen-mode');
  if (!me) return;
  const box = element('section', '', 'management-window'); box.id = 'management-chat'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'management-chat-title');
  const head = element('div', '', 'management-window-head'), title = element('div', '', 'management-window-title');
  const heading = element('h2', '管理助手'); heading.id = 'management-chat-title';
  title.append(heading, element('p', '从了解情况，到推进下一步'));
  const minimize = button('收起', () => Promise.resolve(minimizeManagementChat()).catch(error), 'quiet');
  const maximize = button('全屏', () => toggleManagementFullscreen(), 'quiet');
  const controls = element('div', '', 'actions'); controls.append(maximize, minimize); head.append(title, controls);
  const resize = button('↖', () => {}, 'management-size-handle');
  resize.setAttribute('aria-label', '调整管理助手窗口大小'); resize.title = '拖动左上角调整大小；方向键微调';
  const panel = element('div', '', 'management-panel'); box.append(resize, head, panel);
  const launcher = button('', () => openManagementChat(), 'management-launcher'); launcher.id = 'management-launcher';
  // #914: no aria-label — the launcher's name is the text it already shows (管理助手 + its state), so voice control and
  // screen readers say the same words the reader sees, in all three states.
  launcher.setAttribute('aria-controls', box.id); launcher.setAttribute('aria-expanded', 'false');
  const icon = element('span', '✦', 'management-launcher-icon'); icon.setAttribute('aria-hidden', 'true');
  const label = element('span', '', 'management-launcher-label'), state = element('small', '随时唤起');
  label.append(element('strong', '管理助手'), state); launcher.append(icon, label);
  document.body.append(box, launcher);
  const chat = managementChat = { user: me.id, window: box, launcher, panel, state, minimize, maximize, resize, client: null, loading: null, openVersion: 0, active: false, unread: false,
    mode: 'floating', fullscreenFrom: 'floating', returnAddress: '#/projects', requestedProject: null, size: { width: 480, height: 740 } };
  try { const saved = JSON.parse(localStorage.getItem('management-window-size:' + chat.user)); if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) chat.size = saved; } catch { /* Use the default size when storage is unavailable. */ }
  const header = document.querySelector('body > header');
  const updateViewport = () => {
    box.style.setProperty('--management-header-height', (header?.getBoundingClientRect().height || 0) + 'px');
    if (chat.mode === 'floating') fitManagementWindow(chat);
    // The tag follows the box's own height in every mode: a page/fullscreen view that is itself short (768x432 at 250%
    // zoom) needs the compact rules just as the floating panel does, and a tall page view must not inherit the tag from a
    // shrunk floating box. Measured here, after setManagementPresentation removed the inline size.
    else box.toggleAttribute('data-compact', box.getBoundingClientRect().height < 520);
  };
  chat.updateViewport = updateViewport;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateViewport) : null;
  if (header) observer?.observe(header);
  window.addEventListener('resize', updateViewport);
  chat.cleanup = () => { observer?.disconnect(); window.removeEventListener('resize', updateViewport); };
  resize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || chat.mode !== 'floating') return;
    event.preventDefault(); resize.setPointerCapture(event.pointerId);
    const start = box.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    const move = next => resizeManagementWindow(chat, start.width + x - next.clientX, start.height + y - next.clientY);
    const end = () => { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', end); resize.removeEventListener('pointercancel', end); };
    resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', end); resize.addEventListener('pointercancel', end);
  });
  resize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const rect = box.getBoundingClientRect(), step = event.shiftKey ? 64 : 24;
    resizeManagementWindow(chat, rect.width + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0), rect.height + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
  });
  setManagementPresentation(chat, 'floating');
  box.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && chat.mode !== 'page') {
      event.preventDefault(); event.stopPropagation();
      if (chat.mode === 'fullscreen') { toggleManagementFullscreen(); maximize.focus(); } else minimizeManagementChat();
    }
    if (event.key === 'Tab' && chat.mode === 'fullscreen') {
      const items = [...box.querySelectorAll('button, input, textarea, select, summary, a[href]')].filter(node => !node.disabled && node.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
}
// The same DOM and client serve all three presentations; changing size or mode never reopens a conversation.
function fitManagementWindow(chat) {
  // #641: a remembered or dragged size could push the top edge over the page header (and off screen on a phone), which
  // covered the bar's 退出登录 / account entry. The box is clamped between the header and the bottom bar instead.
  const margin = innerWidth <= 600 ? 10 : 24;
  const header = document.querySelector('body > header')?.getBoundingClientRect().height || 0;
  const bar = document.querySelector('.console-mobile-nav');
  // The bar is measured as it is right now: shell.css hides it only on a short phone (≤767x560) while the floating panel
  // is up, and that is why the fit below runs again once the window is visible (#641 F5).
  const barHeight = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0;
  // A short viewport keeps the panel under the header and above the bar even when that leaves little height: at
  // 250% zoom (768×432 CSS) the panel used to reach 24px and sit 40px under the 64px top bar. The max-height media query
  // already compresses the composer there, so a short box stays usable, while a box over the top bar is not.
  const room = innerHeight - header - barHeight - margin * 2;
  const maxWidth = Math.max(1, innerWidth - margin * 2), maxHeight = Math.max(1, room);
  const width = Math.max(Math.min(360, maxWidth), Math.min(chat.size.width, maxWidth)), height = Math.max(Math.min(460, maxHeight), Math.min(chat.size.height, maxHeight));
  chat.window.style.width = Math.round(width) + 'px'; chat.window.style.height = Math.round(height) + 'px';
  // #641 review: the compact layout follows the box's own height, not the viewport's. Between 561 and ~660px of viewport
  // the clamp below leaves a box under 520px while no max-height media query matches, so the composer overflowed the box
  // and the send button landed outside both the panel and the screen.
  // This path writes the tag for the floating panel only, from the height the clamp just produced. The page and
  // fullscreen views get theirs from updateViewport(), which measures their own box after setManagementPresentation
  // removed the inline size — a short page view (768×432 at 250% zoom) needs the compact rules too, so the tag is not
  // simply cleared when the panel leaves the floating mode. toggleAttribute, not dataset = '': an empty attribute still
  // matches [data-compact]. A hidden window measures 0px, which is why openManagementChat calls updateViewport() again
  // once chat.window.hidden is false.
  const floating = !chat.window.classList.contains('management-page') && !chat.window.classList.contains('management-fullscreen');
  chat.window.toggleAttribute('data-compact', floating && height < 520);
}
function resizeManagementWindow(chat, width, height) {
  chat.size = { width, height }; fitManagementWindow(chat);
  const rect = chat.window.getBoundingClientRect(); chat.size = { width: rect.width, height: rect.height };
  try { localStorage.setItem('management-window-size:' + chat.user, JSON.stringify(chat.size)); } catch { /* Keep the size for this visit. */ }
}
function setManagementPresentation(chat, mode) {
  chat.mode = mode;
  const page = mode === 'page' || mode === 'fullscreen' && chat.fullscreenFrom === 'page';
  chat.window.classList.toggle('management-page', mode === 'page'); chat.window.classList.toggle('management-fullscreen', mode === 'fullscreen');
  chat.window.setAttribute('role', mode === 'page' ? 'region' : 'dialog');
  if (mode === 'fullscreen') chat.window.setAttribute('aria-modal', 'true'); else chat.window.removeAttribute('aria-modal');
  document.body.classList.toggle('management-page-mode', page); document.body.classList.toggle('management-fullscreen-mode', mode === 'fullscreen');
  chat.maximize.textContent = mode === 'fullscreen' ? '退出全屏' : '全屏'; chat.maximize.setAttribute('aria-label', mode === 'fullscreen' ? '退出管理助手全屏' : '全屏显示管理助手');
  chat.minimize.textContent = page ? '悬浮窗口' : '收起'; chat.minimize.setAttribute('aria-label', page ? '切换为悬浮窗口' : '收起管理助手');
  chat.resize.hidden = mode !== 'floating';
  if (mode !== 'floating') { chat.window.style.removeProperty('width'); chat.window.style.removeProperty('height'); }
  chat.updateViewport();
}
function toggleManagementFullscreen() {
  const chat = managementChat; if (!chat) return;
  if (chat.mode === 'fullscreen') setManagementPresentation(chat, chat.fullscreenFrom);
  else { chat.fullscreenFrom = chat.mode; setManagementPresentation(chat, 'fullscreen'); }
}
async function openManagementPage(projectId = null) {
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  syncManagementChat(); const chat = managementChat; if (!chat) return;
  if (location.hash !== '#/management') { chat.returnAddress = location.hash || '#/projects'; history.pushState(null, '', '#/management'); }
  chat.requestedProject = projectId; await route();
}
