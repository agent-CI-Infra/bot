// Prompt cards open in a reading view (#1123): the prompt's Markdown with its Mermaid flow diagrams drawn. 编辑源码
// shows the card's own textarea next to a live preview. That textarea stays the only input the card saves, so drafts,
// revision checks and the save buttons are unchanged; the reading view always shows what saving would write.
// `assistant` adds 在管理助手中用对话改流程, which opens the project's assistant with a request prefilled.
function promptReader(editorField, editor, { label, mode = 'read', onMode, assistant } = {}) {
  const box = element('div', '', 'prompt-reader'), bar = element('div', '', 'prompt-reader-bar');
  const reading = element('div', '', 'prompt-reading management-markdown'), source = element('div', '', 'prompt-source');
  const preview = element('section', '', 'prompt-preview'), previewBody = element('div', '', 'management-markdown');
  for (const [node, name] of [[reading, label + '阅读视图'], [preview, label + '实时预览']]) { node.tabIndex = 0; node.setAttribute('role', 'region'); node.setAttribute('aria-label', name); }
  preview.append(element('p', '实时预览', 'prompt-preview-title'), previewBody); source.append(editorField, preview);
  const readButton = button('阅读视图', () => show('read')), editButton = button('编辑源码', () => show('edit', true));
  bar.append(readButton, editButton);
  if (assistant) bar.append(button('在管理助手中用对话改流程', assistant));
  // A page can hold two prompt cards (the Manager page has its dispatch prompt and its role prompt): name each control.
  for (const control of bar.children) control.setAttribute('aria-label', `${label}：${control.textContent}`);
  // The Markdown renderer ships in management.js; a page without it shows the prompt as its source text.
  const draw = target => {
    const markdown = typeof renderManagementMarkdown === 'function';
    if (markdown) retireDiagrams(target);
    if (!editor.value.trim()) target.replaceChildren(note('提示词为空。'));
    else if (markdown) renderManagementMarkdown(target, editor.value);
    else target.replaceChildren(element('pre', editor.value));
  };
  let timer = 0;
  editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { if (mode === 'edit') draw(previewBody); }, 300); });
  function show(next, focus = false) {
    mode = next; box.dataset.mode = next; reading.hidden = next !== 'read'; source.hidden = next !== 'edit';
    readButton.setAttribute('aria-pressed', String(next === 'read')); editButton.setAttribute('aria-pressed', String(next === 'edit'));
    draw(next === 'read' ? reading : previewBody); onMode?.(next);
    if (focus) editor.focus();
  }
  // A caller that sets editor.value itself (no input event) redraws the view that is showing.
  box.refresh = () => draw(mode === 'read' ? reading : previewBody);
  box.append(bar, reading, source); show(mode); return box;
}
