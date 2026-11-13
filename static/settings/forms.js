// A card whose body `draw(redraw)` builds; `redraw(notice)` draws it again with the outcome of the last action on top.
function liveCard(title, draw) {
  const section = card(title), heading = section.children[0];
  const redraw = notice => {
    const nodes = draw(redraw);
    if (notice) { const flash = element('p', notice, 'view-success flash'); flash.setAttribute('role', 'status'); nodes.unshift(flash); }
    section.replaceChildren(heading, ...nodes);
  };
  redraw(); return { section, redraw };
}
// Fields, an error line and a submit button with optional extra buttons; an error thrown by `save` goes to the line.
function actionForm(nodes, caption, save, extra = []) {
  const form = element('form', '', 'project-form'), message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', caption);
  form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert'); actions.append(submit, ...extra); form.append(...nodes, message, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.textContent = ''; submit.disabled = true;
    try { await save(); } catch (err) { message.textContent = err.message; } finally { submit.disabled = false; }
  });
  return form;
}
