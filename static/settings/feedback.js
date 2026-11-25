// Global Settings -> Platform Feedback Box (#/settings/feedback & #/settings/feedback/<id>)
// Super administrators only. Renders index-backed list & filters, on-demand decompressed detail,
// safe Markdown (marked + DOMPurify), collapsible environment/role snapshot, Markdown export, triage & delete.

const feedbackStatusLabels = {
  all: '全部',
  open: '待处理',
  triaged: '已分诊',
  resolved: '已解决',
  dismissed: '已忽略',
};

const feedbackCategoryLabels = {
  skill: '技能（Skill）',
  tool: '工具',
  prompt: '提示词',
  workflow: '平台流程',
  environment: '运行环境',
  other: '其他',
};

const feedbackSeverityLabels = {
  high: '高',
  medium: '中',
  low: '低',
};

const feedbackSourceLabels = {
  project_role: '项目工作角色',
  dispatch_manager: '事件分派 Manager',
  role_conversation: '角色对话',
  management_assistant: '个人管理助手',
  group_assistant: '飞书群聊助手',
  memory_consolidation: '夜间记忆整理',
};

const feedbackErrorMessages = {
  feedback_not_found: '找不到这条意见记录，可能已被删除。',
  feedback_payload_corrupt: '意见正文文件缺失、损坏或校验失败，已拒绝展示（可删除损坏索引行）。',
  feedback_settings_invalid: '意见箱设置参数无效，请检查单次运行上限范围。',
  feedback_invalid_filter: '筛选条件无效，请重置筛选后重试。',
  feedback_invalid_field: '分诊状态或备注格式无效。',
};

function feedbackErrorText(err) {
  if (err && err.code && Object.hasOwn(feedbackErrorMessages, err.code)) {
    return feedbackErrorMessages[err.code];
  }
  return readErrorText(err);
}

function updateFeedbackNavBadge(openCount) {
  const n = Number(openCount) || 0;
  for (const link of document.querySelectorAll('.project-nav a[href="#/settings/feedback"]')) {
    const existing = link.querySelector('[data-testid="feedback-open-badge"]');
    if (n <= 0) {
      if (existing) {
        if (existing.previousSibling?.nodeType === 3 && existing.previousSibling.textContent === ' ') {
          existing.previousSibling.remove();
        }
        existing.remove();
      }
      continue;
    }
    const badge = existing || element('span', '', 'fb-nav-badge');
    badge.dataset.testid = 'feedback-open-badge';
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.setAttribute('aria-label', `未处理意见 ${n} 条`);
    if (!existing) link.append(' ', badge);
  }
}

async function refreshFeedbackNavBadge(request) {
  if (typeof me !== 'object' || !me || me.role !== 'super_admin') return;
  try {
    const data = await api('/api/feedback?limit=1');
    if (request !== renderVersion) return;
    updateFeedbackNavBadge(data?.counts?.open ?? 0);
  } catch { /* badge refresh is advisory; errors surface on the feedback page itself */ }
}

/** Untrusted model Markdown -> parsed via marked and strictly sanitized via DOMPurify. */
function renderFeedbackMarkdown(node, text) {
  const raw = String(text ?? '');
  if (typeof marked === 'undefined' || typeof marked.parse !== 'function' || typeof DOMPurify === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    node.textContent = raw;
    return;
  }
  const parsed = marked.parse(raw, { gfm: true, breaks: true });
  const fragment = DOMPurify.sanitize(parsed, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const el of fragment.querySelectorAll('h1,h2,h3,h5,h6')) {
    const demoted = document.createElement('h4');
    demoted.append(...el.childNodes);
    el.replaceWith(demoted);
  }
  for (const el of fragment.querySelectorAll('input')) {
    if (el.type !== 'checkbox') el.remove();
    else el.disabled = true;
  }
  for (const anchor of fragment.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    try {
      const url = new URL(href, location.href);
      if (!href || !['https:', 'http:', 'mailto:'].includes(url.protocol)) {
        anchor.removeAttribute('href');
      } else {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }
    } catch {
      anchor.removeAttribute('href');
    }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrap = element('div', '', 'fb-table-wrap');
    table.replaceWith(wrap);
    wrap.append(table);
  }
  node.replaceChildren(fragment);
}

function feedbackBadge(text, variant) {
  return element('span', text, `fb-badge fb-badge-${variant}`);
}

function buildFeedbackIssueMarkdown(entry, payload) {
  const fb = payload?.feedback || {};
  const env = payload?.environment_snapshot || {};
  const plat = env.platform || {};
  const role = env.role_config || {};
  const model = env.model || {};
  const harness = env.harness || {};
  const exec = env.execution || {};
  const lines = [
    `## [Feedback] ${fb.title || entry.title}`,
    '',
    `- **ID**: \`${entry.id}\``,
    `- **Status**: ${feedbackStatusLabels[entry.status] || entry.status} (\`${entry.status}\`)`,
    `- **Category**: ${feedbackCategoryLabels[entry.category] || entry.category} (\`${entry.category}\`)`,
    `- **Severity**: ${feedbackSeverityLabels[entry.severity] || entry.severity} (\`${entry.severity}\`)`,
    `- **Source**: ${feedbackSourceLabels[entry.source_kind] || entry.source_kind} (\`${entry.source_kind}\`)`,
    `- **Untrusted Context**: ${entry.untrusted_context ? 'YES (untrusted external PR / branch checkout)' : 'No'}`,
    `- **Project**: ${entry.repository_full_name ? `${entry.repository_full_name} (\`${entry.repository_id}\`${entry.repository_deleted ? ', deleted' : ''})` : 'None / Global'}`,
    `- **Role / Harness / Model**: \`${role.role_id || entry.role_id || '—'}\` / \`${harness.id || entry.harness_id || '—'}\` (CLI: \`${harness.cli_version || '—'}\`) / \`${model.name || entry.model_name || '—'}\``,
    `- **Target Ref**: ${fb.target_ref ? `\`${fb.target_ref}\`` : '—'}`,
    `- **Created At**: ${entry.created_at}`,
    '',
    '### Context',
    '',
    String(fb.context || ''),
    '',
    '### Problem',
    '',
    String(fb.problem || ''),
    '',
    '### Suggestion',
    '',
    String(fb.suggestion || ''),
  ];
  if (Array.isArray(fb.evidence_refs) && fb.evidence_refs.length) {
    lines.push('', '### Evidence References', '');
    for (const ref of fb.evidence_refs) lines.push(`- \`${ref}\``);
  }
  lines.push(
    '',
    '### Environment & Role Snapshot',
    '',
    `- **Launchpad**: ${plat.launchpad_version || 'unknown'}${plat.image_tag ? ` (${plat.image_tag})` : ''} · Node ${plat.node_version || '—'} · ${plat.os_platform || '—'}/${plat.os_arch || '—'}`,
    `- **Revisions**: config=${role.config_revision ?? '—'}, role=${role.role_revision ?? '—'}, snapshot=${role.snapshot_id || '—'}`,
    `- **System Prompt SHA-256**: \`${role.system_prompt_sha256 || '—'}\``,
    `- **Task / Run / Conversation**: task=\`${exec.task_id || '—'}\`, run=\`${exec.run_id || '—'}\`, conversation=\`${exec.conversation_id || '—'}\``,
  );
  if (Array.isArray(env.skills?.skills_read) && env.skills.skills_read.length) {
    lines.push(`- **Skills Read**: ${env.skills.skills_read.map(p => `\`${p}\``).join(', ')}`);
  }
  return lines.join('\n');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fallback below */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

const feedbackListState = {
  ownerId: null,
  status: 'all',
  category: '',
  severity: '',
  source_kind: '',
  repository_id: '',
  untrusted: '',
  q: '',
  offset: 0,
  limit: 20,
};

function syncFeedbackStateOwner() {
  const currentId = typeof me === 'object' && me ? String(me.id || '') : '';
  if (feedbackListState.ownerId !== currentId) {
    feedbackListState.ownerId = currentId;
    feedbackListState.status = 'all';
    feedbackListState.category = '';
    feedbackListState.severity = '';
    feedbackListState.source_kind = '';
    feedbackListState.repository_id = '';
    feedbackListState.untrusted = '';
    feedbackListState.q = '';
    feedbackListState.offset = 0;
  }
}

function feedbackListQuery(state) {
  const params = new URLSearchParams();
  if (state.status && state.status !== 'all') params.set('status', state.status);
  if (state.category) params.set('category', state.category);
  if (state.severity) params.set('severity', state.severity);
  if (state.source_kind) params.set('source_kind', state.source_kind);
  if (state.repository_id) params.set('repository_id', state.repository_id);
  if (state.untrusted) params.set('untrusted', state.untrusted);
  if (state.q) params.set('q', state.q);
  params.set('offset', String(state.offset));
  params.set('limit', String(state.limit));
  return '/api/feedback?' + params.toString();
}

async function feedbackSettingsPage(request, id) {
  if (id) return renderFeedbackDetail(request, id);
  return renderFeedbackList(request);
}

async function renderFeedbackList(request) {
  syncFeedbackStateOwner();
  const [settingsView, initialList] = await Promise.all([
    api('/api/feedback/settings'),
    api(feedbackListQuery(feedbackListState)),
  ]);
  if (request !== renderVersion) return [];
  updateFeedbackNavBadge(initialList.counts?.open ?? 0);

  const section = settingsCard('角色意见箱', 'h2');
  section.classList.add('fb-card');
  section.dataset.testid = 'feedback-list-card';
  section.append(note('全平台 6 类执行入口（项目工作角色、事件分派 Manager、角色对话、个人管理助手、飞书群聊助手与夜间记忆整理）均可通过只增工具 submit_feedback 反馈平台 Skill、工具、提示词、流程与环境问题。意见正文以明文 gzip 压缩保存在控制面数据卷中，仅超级管理员可读与管理，删除项目默认保留历史意见。'));

  // Global feedback box settings (enabled + max_per_run)
  const settingsFold = element('details', '', 'fb-settings-fold');
  settingsFold.dataset.testid = 'feedback-settings-fold';
  const currentSettings = settingsView.settings || { enabled: true, max_per_run: 3 };
  const [minRun, maxRun] = settingsView.bounds?.max_per_run || [1, 20];
  const settingsSummary = element('summary', `意见箱全局设置（当前：${currentSettings.enabled ? '已开启' : '已关闭'} · 单次运行上限 ${currentSettings.max_per_run} 条）`);
  const settingsForm = element('form', '', 'fb-settings-form');

  const enabledCheck = document.createElement('input');
  enabledCheck.type = 'checkbox';
  enabledCheck.name = 'enabled';
  enabledCheck.checked = Boolean(currentSettings.enabled);
  const enabledLabel = element('label', '', 'check');
  enabledLabel.append(enabledCheck, ' 启用全平台意见箱（向各角色下发只增工具 submit_feedback）');

  const maxRunInput = input('max_per_run', currentSettings.max_per_run, {
    type: 'number', min: minRun, max: maxRun, step: 1, required: true,
  });
  const settingsRow = element('div', '', 'fb-settings-row');
  const saveSettingsBtn = element('button', '保存意见箱设置', 'btn-primary');
  saveSettingsBtn.type = 'submit';
  const settingsStatus = note('');
  settingsStatus.setAttribute('role', 'status');
  settingsRow.append(field(`单次运行/回合提交上限（${minRun}–${maxRun}）`, maxRunInput), saveSettingsBtn);
  settingsForm.append(enabledLabel, settingsRow, settingsStatus);
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    announceSave(settingsStatus, '', false);
    const val = Number(maxRunInput.value);
    if (!Number.isSafeInteger(val) || val < minRun || val > maxRun) {
      announceSave(settingsStatus, `单次运行上限需为 ${minRun}–${maxRun} 之间的整数。`, true);
      maxRunInput.focus();
      return;
    }
    saveSettingsBtn.disabled = true;
    try {
      const saved = await api('/api/feedback/settings', 'PUT', {
        enabled: enabledCheck.checked,
        max_per_run: val,
      });
      if (request !== renderVersion) return;
      const next = saved.settings;
      settingsSummary.textContent = `意见箱全局设置（当前：${next.enabled ? '已开启' : '已关闭'} · 单次运行上限 ${next.max_per_run} 条）`;
      announceSave(settingsStatus, '意见箱设置已保存。', false);
    } catch (err) {
      if (request === renderVersion) announceSave(settingsStatus, feedbackErrorText(err), true);
    } finally {
      saveSettingsBtn.disabled = false;
    }
  });
  settingsFold.append(settingsSummary, settingsForm);
  section.append(settingsFold);

  // Status tabs
  const tabsWrap = element('div', '', 'fb-tabs');
  tabsWrap.setAttribute('role', 'group');
  tabsWrap.setAttribute('aria-label', '按状态筛选意见');
  const tabButtons = {};
  for (const statusKey of ['all', 'open', 'triaged', 'resolved', 'dismissed']) {
    const btn = element('button', '', 'quiet fb-tab');
    btn.type = 'button';
    btn.dataset.statusTab = statusKey;
    btn.setAttribute('aria-pressed', feedbackListState.status === statusKey ? 'true' : 'false');
    const labelSpan = element('span', feedbackStatusLabels[statusKey]);
    const countSpan = element('span', '0', 'fb-tab-count');
    btn.append(labelSpan, countSpan);
    btn.addEventListener('click', () => {
      if (feedbackListState.status === statusKey) return;
      feedbackListState.status = statusKey;
      feedbackListState.offset = 0;
      void reloadList();
    });
    tabButtons[statusKey] = { btn, countSpan };
    tabsWrap.append(btn);
  }
  section.append(tabsWrap);

  // Multi-dimensional filters
  const filterForm = element('form', '', 'fb-filters');
  filterForm.dataset.testid = 'feedback-filters';

  const makeSelect = (name, options, selected) => {
    const sel = document.createElement('select');
    sel.name = name;
    for (const [val, label] of options) sel.add(new Option(label, val));
    sel.value = selected || '';
    return sel;
  };

  const catSelect = makeSelect('category', [['', '全部类别'], ...Object.entries(feedbackCategoryLabels)], feedbackListState.category);
  const sevSelect = makeSelect('severity', [['', '全部严重度'], ...Object.entries(feedbackSeverityLabels)], feedbackListState.severity);
  const srcSelect = makeSelect('source_kind', [['', '全部来源入口'], ...Object.entries(feedbackSourceLabels)], feedbackListState.source_kind);
  const repoSelect = makeSelect('repository_id', [['', '全部项目'], ['__none__', '无归属项目（全局/助手）']], feedbackListState.repository_id);
  const untrustedSelect = makeSelect('untrusted', [['', '全部上下文'], ['1', '仅不可信检出'], ['0', '仅可信环境']], feedbackListState.untrusted);
  const qInput = input('q', feedbackListState.q, { type: 'search', placeholder: '标题、角色、目标引用或任务 ID', maxLength: 120 });

  const filterActions = element('div', '', 'fb-filter-actions');
  const applyBtn = element('button', '筛选', 'btn-secondary');
  applyBtn.type = 'submit';
  const resetBtn = button('重置', () => {
    feedbackListState.category = '';
    feedbackListState.severity = '';
    feedbackListState.source_kind = '';
    feedbackListState.repository_id = '';
    feedbackListState.untrusted = '';
    feedbackListState.q = '';
    feedbackListState.offset = 0;
    catSelect.value = '';
    sevSelect.value = '';
    srcSelect.value = '';
    repoSelect.value = '';
    untrustedSelect.value = '';
    qInput.value = '';
    void reloadList();
  }, 'quiet');
  filterActions.append(applyBtn, resetBtn);

  filterForm.append(
    field('类别', catSelect),
    field('严重度', sevSelect),
    field('来源入口', srcSelect),
    field('项目', repoSelect),
    field('上下文信任', untrustedSelect),
    field('关键词', qInput),
    filterActions,
  );
  filterForm.addEventListener('submit', event => {
    event.preventDefault();
    feedbackListState.category = catSelect.value;
    feedbackListState.severity = sevSelect.value;
    feedbackListState.source_kind = srcSelect.value;
    feedbackListState.repository_id = repoSelect.value;
    feedbackListState.untrusted = untrustedSelect.value;
    feedbackListState.q = qInput.value.trim();
    feedbackListState.offset = 0;
    void reloadList();
  });
  section.append(filterForm);

  const listWrap = element('div', '', 'fb-list');
  listWrap.dataset.testid = 'feedback-entries-list';
  const pagingWrap = element('div', '', 'fb-paging');
  section.append(listWrap, pagingWrap);

  let loadSeq = 0;

  function syncRepoOptions(repos) {
    const current = feedbackListState.repository_id;
    const base = [['', '全部项目'], ['__none__', '无归属项目（全局/助手）']];
    const items = (Array.isArray(repos) ? repos : []).map(r => [
      r.repository_id,
      r.repository_full_name + (r.deleted ? '（项目已删除）' : ''),
    ]);
    repoSelect.replaceChildren();
    for (const [val, label] of [...base, ...items]) repoSelect.add(new Option(label, val));
    if (current && ![...repoSelect.options].some(o => o.value === current)) {
      repoSelect.add(new Option(current, current));
    }
    repoSelect.value = current || '';
  }

  function paintList(data) {
    const counts = data.counts || { all: 0, open: 0, triaged: 0, resolved: 0, dismissed: 0 };
    updateFeedbackNavBadge(counts.open ?? 0);
    for (const [key, { btn, countSpan }] of Object.entries(tabButtons)) {
      btn.setAttribute('aria-pressed', feedbackListState.status === key ? 'true' : 'false');
      countSpan.textContent = String(counts[key] ?? 0);
    }
    syncRepoOptions(data.repositories || []);

    listWrap.replaceChildren();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) {
      const hasFilter = feedbackListState.status !== 'all' || feedbackListState.category || feedbackListState.severity
        || feedbackListState.source_kind || feedbackListState.repository_id || feedbackListState.untrusted || feedbackListState.q;
      listWrap.append(consoleState(
        hasFilter ? '没有符合条件的意见' : '意见箱暂无记录',
        hasFilter ? '请调整状态标签页或筛选条件后重试。' : '各角色运行过程中遇到平台 Skill、工具、提示词或流程问题时，会通过 submit_feedback 上报到这里。',
      ));
    } else {
      for (const entry of entries) {
        const card = element('article', '', 'fb-item' + (entry.untrusted_context ? ' fb-item-untrusted' : ''));
        card.dataset.feedbackId = entry.id;

        const head = element('div', '', 'fb-item-head');
        const link = element('a', entry.title, 'fb-item-title');
        link.href = '#/settings/feedback/' + encodeURIComponent(entry.id);

        const badges = element('div', '', 'fb-badges');
        badges.append(
          feedbackBadge(feedbackStatusLabels[entry.status] || entry.status, entry.status),
          feedbackBadge(`严重度：${feedbackSeverityLabels[entry.severity] || entry.severity}`, entry.severity),
          feedbackBadge(feedbackCategoryLabels[entry.category] || entry.category, 'info'),
        );
        if (entry.untrusted_context) {
          const warn = feedbackBadge('不可信检出', 'untrusted');
          warn.title = '该意见来自外部 PR、未合入分支检出或外部 PR 事件上下文，请独立核实';
          badges.append(warn);
        }
        head.append(link, badges);

        const meta = element('div', '', 'fb-meta');
        meta.append(
          element('span', feedbackSourceLabels[entry.source_kind] || entry.source_kind, 'fb-meta-strong'),
          element('span', entry.repository_full_name
            ? (entry.repository_deleted ? `${entry.repository_full_name}（已删除）` : entry.repository_full_name)
            : '全局 / 非单项目'),
        );
        if (entry.role_id) meta.append(element('span', `角色：${entry.role_id}`));
        if (entry.harness_id) meta.append(element('span', `后端：${entry.harness_id}`));
        if (entry.model_name) meta.append(element('span', `模型：${entry.model_name}`));
        if (entry.target_ref) meta.append(element('span', `目标：${entry.target_ref}`));
        meta.append(element('span', timeText(entry.created_at)));

        card.append(head, meta);
        listWrap.append(card);
      }
    }

    pagingWrap.replaceChildren();
    const total = Number(data.total ?? 0);
    const limit = Number(data.limit ?? feedbackListState.limit);
    const offset = Number(data.offset ?? 0);
    if (total > 0) {
      const pageNum = Math.floor(offset / limit) + 1;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const prevBtn = button('上一页', () => {
        feedbackListState.offset = Math.max(0, offset - limit);
        void reloadList();
      }, 'quiet');
      prevBtn.disabled = offset <= 0;
      const nextBtn = button('下一页', () => {
        feedbackListState.offset = offset + limit;
        void reloadList();
      }, 'quiet');
      nextBtn.disabled = !data.has_more;
      pagingWrap.append(
        element('span', `共 ${total} 条 · 第 ${pageNum} / ${totalPages} 页`, 'muted'),
        prevBtn,
        nextBtn,
      );
    }
  }

  async function reloadList() {
    const seq = ++loadSeq;
    listWrap.setAttribute('aria-busy', 'true');
    try {
      const data = await api(feedbackListQuery(feedbackListState));
      if (request !== renderVersion || seq !== loadSeq || !section.isConnected) return;
      paintList(data);
    } catch (err) {
      if (request !== renderVersion || seq !== loadSeq || !section.isConnected) return;
      listWrap.replaceChildren(consoleState('意见箱列表加载失败', feedbackErrorText(err), { tone: 'error', retry: () => void reloadList() }));
    } finally {
      listWrap.removeAttribute('aria-busy');
    }
  }

  paintList(initialList);
  return [section];
}

function renderSnapshotPanel(entry, env) {
  const details = element('details', '', 'fb-snapshot-fold');
  details.dataset.testid = 'feedback-snapshot-fold';
  const role = env?.role_config || {};
  const model = env?.model || {};
  const harness = env?.harness || {};
  const plat = env?.platform || {};
  const project = env?.project || null;
  const skills = env?.skills || {};
  const exec = env?.execution || {};

  details.append(element('summary', `查看完整环境与角色配置快照（${role.role_id || entry.role_id || '未知角色'} · ${harness.id || entry.harness_id || '—'} · ${model.name || entry.model_name || '—'}）`));
  const body = element('div', '', 'fb-snapshot-body');

  // 1. Platform & Runtime
  const platRows = [
    ['Launchpad 版本', `${plat.launchpad_version || '未知'}${plat.image_tag ? `（镜像 ${plat.image_tag}）` : ''}`],
    ['Node / OS', `${plat.node_version || '—'} · ${plat.os_platform || '—'} / ${plat.os_arch || '—'} (${plat.os_release || '—'})`],
    ['来源入口', `${feedbackSourceLabels[env?.source_kind] || env?.source_kind || entry.source_kind} (${env?.source_kind || entry.source_kind})`],
    ['不可信检出上下文', env?.untrusted_context ? '是（外部 PR / 未合入分支或外部 PR 事件）' : '否'],
    ['采集时间', env?.collected_at ? timeText(env.collected_at) : '—'],
  ];
  body.append(element('h3', '运行平台与来源'), facts(platRows));

  // 2. Project / Scope Summary
  if (project) {
    const projRows = [
      ['仓库', `${project.full_name || entry.repository_full_name || '—'}（ID: ${project.repository_id || entry.repository_id || '—'}${entry.repository_deleted ? '，项目已删除' : ''}）`],
      ['项目启用', project.enabled == null ? '—' : project.enabled ? '已启用' : '已停用'],
      ['能力上限', project.capability_ceiling || '—'],
      ['基准分支', project.base_branch || '默认分支'],
      ['自动合并策略', project.auto_merge_policy || '—'],
      ['测试命令', project.test_command_configured ? '已配置' : '未配置'],
    ];
    body.append(element('h3', '项目与策略摘要'), facts(projRows));
  }
  if (env?.scope_summary) {
    const scopeFold = element('details', '', 'fb-subfold');
    scopeFold.append(element('summary', '查看范围摘要（scope_summary）'), element('pre', JSON.stringify(env.scope_summary, null, 2), 'fb-pre'));
    body.append(scopeFold);
  }

  // 3. Model & Harness
  body.append(element('h3', '模型与 Harness'), facts([
    ['模型', `${model.name || entry.model_name || '—'}${model.id ? ` (id: ${model.id}, v${model.version ?? '?'})` : ''}`],
    ['模型来源 / 接口', `${model.source || '—'} / ${model.interface_type || '—'}${model.transport ? ` · ${model.transport}` : ''}`],
    ['脱敏 API 地址', model.api_url || '—'],
    ['Harness / 版本', `${harness.id || entry.harness_id || '—'} @ ${harness.version || '—'}${harness.model_source ? ` (${harness.model_source})` : ''}`],
    ['CLI 版本', harness.cli_version || '—'],
    ['运行环境类型', harness.environment || '—'],
  ]));

  // 4. Role Config Snapshot
  body.append(element('h3', '角色配置快照'), facts([
    ['角色 ID / 名称 / 类型', `${role.role_id || '—'} / ${role.role_name || '—'} / ${role.kind || '—'}`],
    ['配置 / 角色 Revision', `config=${role.config_revision ?? '—'} · role=${role.role_revision ?? '—'}${role.binding_revision != null ? ` · binding=${role.binding_revision}` : ''}`],
    ['Snapshot ID', role.snapshot_id || '—'],
    ['生效系统提示词 SHA-256', role.system_prompt_sha256 || '—'],
  ]));

  if (role.permissions && typeof role.permissions === 'object') {
    const permTable = costTable(['权限项', '模式']);
    for (const [k, v] of Object.entries(role.permissions)) {
      const tr = document.createElement('tr');
      tr.append(element('td', k), element('td', typeof v === 'string' ? v : JSON.stringify(v)));
      permTable.body.append(tr);
    }
    const permFold = element('details', '', 'fb-subfold');
    permFold.append(element('summary', `权限矩阵（${Object.keys(role.permissions).length} 项）`), permTable.wrap);
    body.append(permFold);
  }

  if (role.budget && typeof role.budget === 'object') {
    const budgetFold = element('details', '', 'fb-subfold');
    budgetFold.append(element('summary', '角色预算配置'), element('pre', JSON.stringify(role.budget, null, 2), 'fb-pre'));
    body.append(budgetFold);
  }

  if (Array.isArray(role.offered_tools) && role.offered_tools.length) {
    const toolsWrap = element('div', '', 'fb-pill-list');
    for (const toolName of role.offered_tools) toolsWrap.append(element('span', toolName, 'fb-pill'));
    const toolsFold = element('details', '', 'fb-subfold');
    toolsFold.append(element('summary', `下发工具清单（${role.offered_tools.length} 个）`), toolsWrap);
    body.append(toolsFold);
  }

  if (role.system_prompt) {
    const promptFold = element('details', '', 'fb-subfold');
    promptFold.dataset.testid = 'feedback-system-prompt-fold';
    promptFold.append(element('summary', `生效系统提示词正文（${role.system_prompt.length} 字符）`), element('pre', role.system_prompt, 'fb-pre'));
    body.append(promptFold);
  }
  if (role.persona_prompt) {
    const personaFold = element('details', '', 'fb-subfold');
    personaFold.append(element('summary', `角色 Persona 提示词（${role.persona_prompt.length} 字符）`), element('pre', role.persona_prompt, 'fb-pre'));
    body.append(personaFold);
  }
  if (role.administrator_prompt) {
    const adminFold = element('details', '', 'fb-subfold');
    adminFold.append(element('summary', `管理员附加提示词（${role.administrator_prompt.length} 字符）`), element('pre', role.administrator_prompt, 'fb-pre'));
    body.append(adminFold);
  }

  // 5. Skills
  const skillBundle = skills.bundle || null;
  const skillsRead = Array.isArray(skills.skills_read) ? skills.skills_read : [];
  body.append(element('h3', 'Skill Bundle 与已读路径'), facts([
    ['Skill Bundle', skillBundle ? `${skillBundle.id || '—'} @ rev ${skillBundle.revision ?? '—'} (hash: ${skillBundle.content_hash || '—'})` : '未绑定'],
    ['本次已读 Skill 路径', skillsRead.length ? skillsRead.join('、') : '无'],
  ]));
  if (Array.isArray(skillBundle?.files) && skillBundle.files.length) {
    const fileTable = costTable(['文件路径', '大小', 'SHA-256']);
    for (const f of skillBundle.files) {
      const tr = document.createElement('tr');
      tr.append(element('td', f.path), element('td', f.bytes != null ? storageSize(f.bytes) : '—'), element('td', f.sha256 ? f.sha256.slice(0, 16) : '—'));
      fileTable.body.append(tr);
    }
    const sfFold = element('details', '', 'fb-subfold');
    sfFold.append(element('summary', `Skill Bundle 文件清单（${skillBundle.files.length} 个）`), fileTable.wrap);
    body.append(sfFold);
  }

  // 6. Execution traces & recent tools
  const execRows = [
    ['任务 ID / 类型 / 状态', `${exec.task_id || '—'} / ${exec.task_kind || '—'} / ${exec.task_status || '—'}${exec.task_phase ? ` (${exec.task_phase})` : ''}`],
    ['Run / Instance / Attempt', `${exec.run_id || '—'} / ${exec.instance_id || '—'} / #${exec.attempt ?? '—'}`],
    ['分派事件 / 线程', `${exec.dispatch_event_id || '—'} (${exec.dispatch_event_type || '—'}) / ${exec.dispatch_thread_key || '—'}`],
    ['会话 / 回合 / 独立子任务', `${exec.conversation_id || '—'} / ${exec.turn_id || '—'} / ${exec.own_task_id || '—'}`],
    ['记忆整理 Run / 范围', `${exec.consolidation_run_id || '—'} / ${exec.consolidation_scope_kind || '—'}${exec.consolidation_scope_id ? `:${exec.consolidation_scope_id}` : ''}`],
    ['运行时长', exec.elapsed_ms != null ? `${Math.round(exec.elapsed_ms / 1000)} 秒` : '—'],
  ];
  body.append(element('h3', '执行线索与近期工具摘要'), facts(execRows));

  const recentTools = Array.isArray(exec.recent_tools) ? exec.recent_tools : [];
  if (recentTools.length) {
    const rtTable = costTable(['工具名', '结果', '错误码', '时间']);
    for (const item of recentTools) {
      const tr = document.createElement('tr');
      tr.append(element('td', item.name || '—'), element('td', item.outcome || '—'), element('td', item.error || '—'), element('td', item.at ? timeText(item.at) : '—'));
      rtTable.body.append(tr);
    }
    body.append(rtTable.wrap);
  }

  // 7. Full raw JSON snapshot
  const rawFold = element('details', '', 'fb-subfold');
  rawFold.append(element('summary', '查看完整原始环境快照 JSON'), element('pre', JSON.stringify(env, null, 2), 'fb-pre'));
  body.append(rawFold);

  details.append(body);
  return details;
}

async function renderFeedbackDetail(request, id) {
  void refreshFeedbackNavBadge(request);
  let detail;
  try {
    detail = await api('/api/feedback/' + encodeURIComponent(id));
  } catch (err) {
    if (request !== renderVersion) return [];
    const back = settingsLink('#/settings/feedback', '← 返回意见箱列表');
    if (err && err.code === 'feedback_payload_corrupt') {
      const card = settingsCard('意见正文损坏或丢失', 'h2');
      card.classList.add('fb-card');
      card.append(
        consoleState('意见正文文件损坏或缺失', feedbackErrorText(err), { tone: 'error' }),
        back,
      );
      const danger = element('div', '', 'fb-danger-zone');
      const status = note('');
      status.setAttribute('role', 'status');
      const delBtn = button('删除损坏索引记录', async () => {
        delBtn.disabled = true;
        try {
          await api('/api/feedback/' + encodeURIComponent(id), 'DELETE', {});
          await refreshFeedbackNavBadge(request);
          location.hash = '#/settings/feedback';
        } catch (delErr) {
          delBtn.disabled = false;
          announceSave(status, feedbackErrorText(delErr), true);
        }
      }, 'btn-danger');
      danger.append(delBtn, status);
      card.append(danger);
      return [card];
    }
    const card = settingsCard('意见详情', 'h2');
    card.classList.add('fb-card');
    card.append(consoleState('无法读取意见详情', feedbackErrorText(err), { tone: 'error', retry: () => route() }), back);
    return [card];
  }
  if (request !== renderVersion) return [];

  const { entry, payload } = detail;
  const fb = payload?.feedback || {};
  const env = payload?.environment_snapshot || {};

  // Header & Actions Card
  const headCard = settingsCard(fb.title || entry.title, 'h2');
  headCard.classList.add('fb-card');
  headCard.dataset.testid = 'feedback-detail-card';

  const backBar = element('div', '', 'fb-back-bar');
  const backLink = settingsLink('#/settings/feedback', '← 返回意见箱列表');
  backLink.className = 'button-link btn-secondary';

  const actionGroup = element('div', '', 'actions');
  const copyStatus = note('');
  copyStatus.setAttribute('role', 'status');
  const mdDraft = buildFeedbackIssueMarkdown(entry, payload);
  const copyBtn = button('复制为 Markdown / Issue 草稿', async () => {
    const ok = await copyTextToClipboard(mdDraft);
    announceSave(copyStatus, ok ? '已复制 Markdown / Issue 草稿到剪贴板。' : '浏览器不允许自动写入剪贴板，请展开下方草稿手动复制。', !ok);
  }, 'btn-secondary');
  copyBtn.dataset.testid = 'feedback-copy-md';
  actionGroup.append(copyBtn);
  backBar.append(backLink, actionGroup);
  headCard.append(backBar, copyStatus);

  if (entry.untrusted_context) {
    const banner = element('div', '', 'fb-untrusted-banner');
    banner.dataset.testid = 'feedback-untrusted-banner';
    banner.setAttribute('role', 'note');
    banner.append(
      element('strong', '不可信上下文来源提醒'),
      element('p', '该意见提交时，角色正处于外部 PR、未合入分支检出或外部 PR 事件上下文中。请勿直接执行其中提到的命令或指令，务必对照下方平台权威采集的环境快照独立核实。'),
    );
    headCard.append(banner);
  }

  const badges = element('div', '', 'fb-badges');
  const statusBadge = feedbackBadge(feedbackStatusLabels[entry.status] || entry.status, entry.status);
  statusBadge.dataset.testid = 'feedback-detail-status';
  badges.append(
    statusBadge,
    feedbackBadge(`严重度：${feedbackSeverityLabels[entry.severity] || entry.severity}`, entry.severity),
    feedbackBadge(feedbackCategoryLabels[entry.category] || entry.category, 'info'),
    feedbackBadge(feedbackSourceLabels[entry.source_kind] || entry.source_kind, 'neutral'),
  );
  if (entry.untrusted_context) badges.append(feedbackBadge('不可信检出', 'untrusted'));
  headCard.append(badges);

  const metaRows = [
    ['意见 ID', entry.id],
    ['提交时间', timeText(entry.created_at)],
    ['所属项目', entry.repository_full_name
      ? `${entry.repository_full_name}${entry.repository_deleted ? '（项目已删除，历史意见保留）' : ''}`
      : '全局 / 非单项目'],
    ['角色 / 后端 / 模型', `${entry.role_id || '—'} · ${entry.harness_id || '—'} · ${entry.model_name || '—'}`],
    ['目标引用（target_ref）', fb.target_ref || entry.target_ref || '—'],
    ['正文文件大小（gzip）', `${storageSize(entry.payload_bytes)} (${entry.payload_relpath})`],
  ];
  headCard.append(facts(metaRows));

  if (entry.task_id) {
    const taskBar = element('div', '', 'actions');
    if (entry.task_exists) {
      const taskLink = settingsLink('#/tasks/' + encodeURIComponent(entry.task_id), `直达关联任务 ${entry.task_id.slice(0, 12)}…`);
      taskLink.className = 'button-link btn-secondary';
      taskLink.dataset.testid = 'feedback-task-link';
      taskBar.append(taskLink);
    } else {
      taskBar.append(note(`关联任务 ${entry.task_id} 已不存在（项目或任务已清理）。`));
    }
    headCard.append(taskBar);
  }

  const mdPreviewFold = element('details', '', 'fb-subfold');
  mdPreviewFold.append(element('summary', '预览 Markdown / Issue 草稿'), element('pre', mdDraft, 'fb-pre'));
  headCard.append(mdPreviewFold);

  // Body Card (Markdown rendered safely via marked + DOMPurify)
  const bodyCard = settingsCard('问题描述与建议', 'h2');
  bodyCard.classList.add('fb-card');
  bodyCard.dataset.testid = 'feedback-body-card';

  for (const [heading, content, testId] of [
    ['前因后果与触发背景（Context）', fb.context, 'feedback-section-context'],
    ['遇到的具体问题与现象（Problem）', fb.problem, 'feedback-section-problem'],
    ['具体可落地改进建议（Suggestion）', fb.suggestion, 'feedback-section-suggestion'],
  ]) {
    const block = element('div', '', 'fb-section-block');
    block.dataset.testid = testId;
    block.append(element('h3', heading));
    const mdNode = element('div', '', 'fb-markdown');
    renderFeedbackMarkdown(mdNode, content || '');
    block.append(mdNode);
    bodyCard.append(block);
  }

  const evidenceRefs = Array.isArray(fb.evidence_refs) ? fb.evidence_refs : [];
  if (evidenceRefs.length) {
    const evBlock = element('div', '', 'fb-section-block');
    evBlock.append(element('h3', `证据与关联引用（${evidenceRefs.length} 项）`));
    const ul = element('ul', '', 'fb-evidence-list');
    for (const ref of evidenceRefs) {
      const li = document.createElement('li');
      li.append(element('code', String(ref)));
      ul.append(li);
    }
    evBlock.append(ul);
    bodyCard.append(evBlock);
  }

  // Snapshot Card
  const snapshotCard = settingsCard('平台采集的环境与角色配置快照', 'h2');
  snapshotCard.classList.add('fb-card');
  snapshotCard.append(
    note('以下信息由平台控制面在工具调用瞬间权威采集，不依赖模型自报，且已自动脱敏凭据与敏感参数。'),
    renderSnapshotPanel(entry, env),
  );

  // Triage & Delete Card
  const triageCard = settingsCard('分诊与管理', 'h2');
  triageCard.classList.add('fb-card');
  triageCard.dataset.testid = 'feedback-triage-card';

  const triageForm = element('form', '', 'fb-triage-form');
  const statusSelect = document.createElement('select');
  statusSelect.name = 'status';
  for (const key of ['open', 'triaged', 'resolved', 'dismissed']) {
    statusSelect.add(new Option(feedbackStatusLabels[key], key));
  }
  statusSelect.value = entry.status;

  const noteArea = document.createElement('textarea');
  noteArea.name = 'triage_note';
  noteArea.maxLength = 2000;
  noteArea.placeholder = '记录分诊结论、关联 Issue/PR 链接或忽略原因（最多 2000 字）';
  noteArea.value = entry.triage_note || '';

  const triageMeta = note(entry.triaged_at
    ? `上次分诊：${entry.triaged_by || '管理员'} 于 ${timeText(entry.triaged_at)}`
    : '尚未分诊。');
  const triageStatus = note('');
  triageStatus.setAttribute('role', 'status');
  const saveTriageBtn = element('button', '保存分诊结果', 'btn-primary');
  saveTriageBtn.type = 'submit';
  saveTriageBtn.dataset.testid = 'feedback-triage-save';

  triageForm.append(
    field('处理状态', statusSelect),
    field('分诊备注', noteArea),
    triageMeta,
    triageStatus,
    saveTriageBtn,
  );
  triageForm.addEventListener('submit', async event => {
    event.preventDefault();
    announceSave(triageStatus, '', false);
    saveTriageBtn.disabled = true;
    try {
      const saved = await api('/api/feedback/' + encodeURIComponent(entry.id), 'PATCH', {
        status: statusSelect.value,
        triage_note: noteArea.value.trim() || null,
      });
      if (request !== renderVersion) return;
      const next = saved.entry;
      statusBadge.textContent = feedbackStatusLabels[next.status] || next.status;
      statusBadge.className = `fb-badge fb-badge-${next.status}`;
      triageMeta.textContent = `上次分诊：${next.triaged_by || '管理员'} 于 ${timeText(next.triaged_at)}`;
      announceSave(triageStatus, '分诊结果已保存。', false);
      void refreshFeedbackNavBadge(request);
    } catch (err) {
      if (request === renderVersion) announceSave(triageStatus, feedbackErrorText(err), true);
    } finally {
      saveTriageBtn.disabled = false;
    }
  });
  triageCard.append(triageForm);

  // Two-step inline delete (accessible, no window.confirm)
  const dangerZone = element('div', '', 'fb-danger-zone');
  const deleteStatus = note('');
  deleteStatus.setAttribute('role', 'status');
  const deleteStartBtn = button('删除该意见', () => {
    deleteStartBtn.hidden = true;
    deleteConfirmBtn.hidden = false;
    deleteCancelBtn.hidden = false;
    deleteConfirmBtn.focus();
  }, 'btn-danger');
  deleteStartBtn.dataset.testid = 'feedback-delete-start';
  const deleteConfirmBtn = button('确认永久删除', async () => {
    deleteConfirmBtn.disabled = true;
    deleteCancelBtn.disabled = true;
    try {
      await api('/api/feedback/' + encodeURIComponent(entry.id), 'DELETE', {});
      if (request !== renderVersion) return;
      void refreshFeedbackNavBadge(request);
      location.hash = '#/settings/feedback';
    } catch (err) {
      deleteConfirmBtn.disabled = false;
      deleteCancelBtn.disabled = false;
      if (request === renderVersion) announceSave(deleteStatus, feedbackErrorText(err), true);
    }
  }, 'btn-danger');
  deleteConfirmBtn.dataset.testid = 'feedback-delete-confirm';
  deleteConfirmBtn.hidden = true;
  const deleteCancelBtn = button('取消', () => {
    deleteConfirmBtn.hidden = true;
    deleteCancelBtn.hidden = true;
    deleteStartBtn.hidden = false;
    deleteStartBtn.focus();
  }, 'quiet');
  deleteCancelBtn.hidden = true;

  dangerZone.append(deleteStartBtn, deleteConfirmBtn, deleteCancelBtn, deleteStatus);
  triageCard.append(dangerZone);

  return [headCard, bodyCard, snapshotCard, triageCard];
}
