async function renderSettings(request) {
  // Named apart from the page's own route(): the error card's 重新加载 asks the page to redraw this address.
  const address = settingsRoute(), section = address.section, nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content'), body = element('div', '', 'project-body settings-body');
  // A project administrator reaches only 存储, so their category bar must not claim to be global settings (#799).
  nav.setAttribute('aria-label', typeof me === 'object' && me && me.role === 'super_admin' ? '全局设置类别' : '设置类别');
  // #615: a group heading only earns its line when it separates groups; one category stays a plain link.
  const groups = visibleSettingsGroups();
  for (const [groupTitle, items] of groups) {
    if (groups.length > 1) nav.append(element('p', groupTitle, 'console-nav-label'));
    for (const [key, caption] of items) { const item = element('a', caption); item.href = '#/settings/' + key; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item); }
  }
  // The categories are drawn at once; the chosen category's cards follow when their data arrives.
  $('count').textContent = ''; content.append(element('p', '正在加载…', 'muted')); body.append(nav, content); $('settings-panel').replaceChildren(body);
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  // The hash may only choose among the declared sections: never let a user-written name reach the prototype chain, and
  // never call anything that is not a declared loader. Anything else falls back to 工作电脑.
  const handler = Object.hasOwn(settingsCards, section) ? settingsCards[section] : settingsCards['work-computers'];
  if (typeof handler !== 'function') return;
  let cards;
  try { cards = await handler(request, address.id); }
  catch (err) {
    // #976: a refused read rejected renderSettings with the placeholder still on the page, so the tab waited forever.
    // It now stops on the same error card and retry every other console page uses; the retry redraws the address, so
    // a later good read replaces the card with the real one instead of leaving both.
    if (request !== renderVersion) return;
    const caption = visibleSettingsSections().find(([key]) => key === section)?.[1] ?? '设置';
    $('count').textContent = '读取失败';
    content.replaceChildren(consoleState(caption + '读取失败', readErrorText(err) + '。这不是空结果，当前无法判断这里是否有数据。', { tone: 'error', retry: () => route() }));
    return;
  }
  if (request !== renderVersion) return;
  content.replaceChildren(...cards);
}
// #879: a save result is assertive only when it failed. The role and the sentence move together in one synchronous
// update: writing the text first leaves the new sentence under the old role for a rendering step (a reader can miss it),
// and setting the role in a later task has the same gap. No extra aria-live is set — role=alert and role=status already
// carry it, and a second declaration could contradict the role that was just written.
function announceSave(target, text, failed) {
  target.setAttribute('role', failed ? 'alert' : 'status');
  target.textContent = text;
}
