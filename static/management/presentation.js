// Model text is untrusted. Parse Markdown, then allow only document markup before attaching it to the live page.
// ```mermaid blocks become flow diagrams (diagrams.js); `class` survives only as that block's language marker.
function renderManagementMarkdown(node, text) {
  const fragment = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled', 'class'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
  });
  for (const el of fragment.querySelectorAll('[class]')) {
    if (!(el.localName === 'code' && el.className === 'language-mermaid' && el.parentElement?.localName === 'pre')) el.removeAttribute('class');
  }
  mountDiagrams(fragment);
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove(); else input.disabled = true;
  }
  for (const anchor of fragment.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    try {
      const url = new URL(href, location.href);
      if (!href || !['https:', 'http:', 'mailto:'].includes(url.protocol)) anchor.removeAttribute('href');
      else if (url.origin !== location.origin) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    } catch { anchor.removeAttribute('href'); }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrap = element('div', '', 'management-table'); table.replaceWith(wrap); wrap.append(table);
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '回答中的表格');
  }
  retireDiagrams(node); node.replaceChildren(fragment);
}
const managementOperationLabels = {
  list_projects: '查询项目', list_tasks: '查询任务', get_task: '读取任务状态', get_effective_config: '读取项目配置',
  get_usage: '查询成本与预算', list_audit: '查询操作记录', 'task.create': '创建任务', 'task.pause': '暂停任务',
  'task.cancel': '取消任务', 'task.retry': '重试任务', 'task.instructions': '追加任务指令', 'task.contract': '修订任务目标',
  'task.adopt-config': '采用新执行配置', 'workflow.update': '更新工作配置', 'manager.update': '更新 Manager 配置',
  'project.update': '更新项目配置', 'roles.update': '更新角色', 'rules.update': '更新规则', 'configuration.pr': '创建配置 PR'
};
// A console write is shown before it is sent (#355): the preview is drawn only from the command this page builds — the
// operation label above, its target, its arguments and the expected revision — so it never claims an effect the server
// does not have. Nothing reaches POST /api/management/commands until 确认执行; the receipt afterwards is still the
// execution result, because there is no approval step (#312).
function managementPreview(command, context = {}) {
  const box = element('section', '', 'management-command-preview');
  box.dataset.commandPreview = ''; box.dataset.operation = command.operation;
  box.setAttribute('role', 'region'); box.setAttribute('aria-label', '执行前确认');
  const place = [context.project && '项目 ' + context.project, context.task && '任务 ' + context.task, context.workflow && '工作类型 ' + context.workflow].filter(Boolean).join(' · ');
  const rows = [['操作', managementOperationLabels[command.operation] ?? command.operation], ['目标', place || command.target.project_id],
    ['预计版本', String(command.expected_revision)]];
  for (const [key, value] of Object.entries(command.arguments ?? {})) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    rows.push(['参数 ' + key, text.length > 120 ? text.slice(0, 120) + '…' : text]);
  }
  const actions = element('div', '', 'actions'), confirm = button('确认执行', () => {}, ''), cancel = button('取消', () => {});
  actions.append(confirm, cancel);
  const workflowNote = command.operation === 'task.create' && command.arguments?.workflow_changes === true
    ? note('这项开发任务允许在 bot 分支与 PR 中修改 .github/workflows/（推送分支时申请 Workflows 权限），仍须人工检视合并，不会直接写入默认分支。')
    : null;
  box.append(element('h3', '执行前确认'), facts(rows), ...(workflowNote ? [workflowNote] : []),
    note('确认后立即提交并执行：控制台没有审批步骤，执行结果写在回执里。版本不一致或权限已变更时，服务端会拒绝这次操作。'), actions);
  return { box, confirm, cancel };
}
// Commands execute directly (#312): a receipt is the execution result, never a pending decision. "rejected" only appears on
// receipts recorded before the approval flow was retired.
const managementCommandStates = {
  pending: ['等待执行', '已提交，等待执行。结果出来后会更新这条回执。'],
  executing: ['执行中', '执行中，结果出来后会更新这条回执。'],
  succeeded: ['已执行', '已执行。下方是这次操作的执行回执。'],
  rejected: ['已拒绝', '这条命令在审批流程取消前被拒绝，没有执行。'],
  failed: ['执行失败', '执行失败，命令未完成。原因见下方回执。'],
  unknown: ['结果待确认', '结果待确认。对账回读之前不会再次执行。'],
  not_operator: ['未执行：只有发起人可以执行', '只有这条命令的发起人可以执行它；命令保持原状态，没有执行。']
};
const managementCommandState = state => managementCommandStates[state] ?? [state, '当前状态：' + state];
