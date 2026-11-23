// A section may name one item inside it (older workflow addresses did, e.g. #/projects/<id>/workflows/review.pr).
function projectRoute(hash = location.hash) { const m = /^#\/projects\/([1-9]\d*)(?:\/(new-task|[a-z]+)(?:\/([\w.-]+))?)?$/.exec(hash.split('?')[0]); return m ? { id: m[1], section: m[2] || 'basic', item: m[3] || null } : null; }
function openProject(id, section = 'basic') { location.hash = `#/projects/${id}/${section}`; }
function field(label, control) { const wrap = element('label', label); wrap.append(control); return wrap; }
function input(name, value, attributes = {}) { const el = document.createElement('input'); el.name = name; el.value = value ?? ''; Object.assign(el, attributes); return el; }
function textarea(name, value, attributes = {}) { const el = document.createElement('textarea'); el.name = name; el.value = value ?? ''; Object.assign(el, attributes); return el; }
function checkbox(name, checked, caption) { const box = input(name, '', { type: 'checkbox', checked: !!checked }), wrap = element('label', '', 'check'); wrap.append(box, ' ' + caption); return wrap; }
function note(text) { return element('p', text, 'muted'); }
// Pi, Codex and Claude Code run every turn of a service assistant on an assistant computer (#1254). Next to the backend
// choice: when this deployment cannot provide one, say so and why, instead of leaving every turn to fail. Read once, and
// only when a backend other than Native is shown; an editor that sets the choice itself calls refresh().
const assistantComputerReasons = { manager_not_configured: '控制面没有配置 manager', assistant_homes_missing: '控制面没有挂载 assistant-homes 卷',
  manager_unavailable: '连不上 manager', assistant_homes_unavailable: 'manager 没有挂载 assistant-homes 卷' };
function harnessComputerWarning(select) {
  const warning = element('p', '', 'endpoint-warning'); warning.hidden = true; warning.setAttribute('role', 'status');
  let status;
  const show = () => {
    if (select.value === 'native') { warning.hidden = true; return; }
    if (status === undefined) { status = null; api('/api/assistant-computers/status').then(value => { status = value; show(); }, () => {}); return; }
    warning.hidden = !status || status.available;
    if (!warning.hidden) warning.textContent = `这个部署的助手电脑现在不可用（${assistantComputerReasons[status.reason] || status.reason}）。Pi、Codex 和 Claude Code 的每一轮都要在助手电脑上运行，修好之前这些轮次都会失败。`;
  };
  select.addEventListener('change', show); warning.refresh = show; show();
  return warning;
}
