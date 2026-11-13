// A card holding a list of records with one add button that opens the shared editor.
function settingsList(title, intro, lines, empty, caption, kind) {
  const section = card(title), list = element('div', '', 'rows settings-rows'), head = element('div', '', 'actions settings-list-head');
  list.setAttribute('role', 'list'); list.setAttribute('aria-label', title); list.append(...(lines.length ? lines : [element('p', empty, 'muted')]));
  head.append(note(intro), button(caption, () => openEditor(kind), ''));
  section.append(head, list); return section;
}
// In-console addresses are hash links, not external URLs: link() only builds absolute http(s) anchors.
function settingsLink(hash, text) { const a = element('a', text); a.href = hash; return a; }
