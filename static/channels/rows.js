// Clicking a binding row's body opens its chat history, without hijacking inner buttons, links, form controls, drawers or text selection.
function makeFeishuRowClickable(row, getHref, onUnavailable) {
  row.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.target.closest('a, button, input, select, textarea, label, summary, details, form, .feishu-row-drawer')) return;
    const selection = window.getSelection?.();
    if (selection && String(selection).trim()) return;
    const href = getHref();
    if (href) location.hash = href;
    else if (onUnavailable) onUnavailable();
  });
}

