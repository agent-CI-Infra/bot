// Details stay in the project page instead of covering the table with a modal.
function showProjectDetails(title, render) {
  const redraw = notice => {
    const detail = $('project-detail'); if (!detail) return;
    const head = element('div', '', 'heading'), heading = element('h3', title);
    heading.id = 'project-detail-title'; head.append(heading, button('收起', () => { detail.hidden = true; detail.replaceChildren(); }, 'quiet'));
    detail.hidden = false; detail.redraw = redraw; detail.setAttribute('aria-labelledby', heading.id);
    detail.replaceChildren(head, ...(notice ? [element('p', notice, 'view-success flash')] : []), ...render());
  };
  redraw(); $('project-detail')?.scrollIntoView({ block: 'nearest' }); return redraw;
}
function openProjectRule(path) { showProjectDetails(ruleInfo(path)[1], () => [ruleCard(path)]); }
function projectTable(captions, name) {
  const table = document.createElement('table'), head = document.createElement('tr'), body = document.createElement('tbody');
  table.className = 'project-table'; table.setAttribute('aria-label', name);
  for (const caption of captions) { const th = element('th', caption); th.scope = 'col'; head.append(th); }
  table.createTHead().append(head); table.append(body); return { table, body };
}
function tableCell(row, caption, ...nodes) {
  const td = document.createElement('td'); td.dataset.label = caption; td.append(...nodes); row.append(td); return td;
}
