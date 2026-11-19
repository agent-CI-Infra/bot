let managementChat = null, pendingRepositoryOnboarding = null;
function repositoryOnboardingPrompt(repo) {
  const label = repo.full_name || ('仓库编号 ' + repo.id);
  if (repo.started) {
    return `请帮我核对并优化仓库 ${label} 的接入配置：先读取当前已生效配置与仓库现状（文档、构建与测试命令、CI 工作流、现有标签和近期 Issue/PR），给出简要仓库画像和能力档说明，只针对与当前配置有差异的关键选择向我提问并给出推荐项；等我确认后再应用配置（若需要修改 .github/workflows/，请生成待我在控制台确认的开发任务）。`;
  }
  return `请帮我接入已安装仓库 ${label}：先只读分析仓库（README、目录结构、构建与测试命令、CI 工作流、现有标签与近期 Issue/PR），给出仓库画像、各能力上限（read / comment / develop）说明以及最多 5 个关键配置问题和推荐项；等我确认后再启动仓库（或提交启动申请）并按确认项完成配置。`;
}
function queueRepositoryOnboarding(repo) {
  if (!me || !repo?.id) return;
  pendingRepositoryOnboarding = { user: me.id, id: String(repo.id), full_name: repo.full_name || null, started: !!repo.started };
}
function peekRepositoryOnboarding() {
  if (!pendingRepositoryOnboarding || pendingRepositoryOnboarding.user !== me?.id) { pendingRepositoryOnboarding = null; return null; }
  return pendingRepositoryOnboarding;
}
function clearRepositoryOnboarding() { pendingRepositoryOnboarding = null; }
async function openRepositoryOnboarding(repo) {
  if (!repo?.id) return;
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  const started = !!repo.started || repositories.some(row => String(row.id) === String(repo.id));
  queueRepositoryOnboarding({ ...repo, started });
  const address = started ? `#/projects/${encodeURIComponent(repo.id)}/management` : '#/management';
  if (location.hash !== address) { history.pushState(null, '', address); await route(); }
  else await openManagementChat(started ? String(repo.id) : null);
}
function managementChatState() {
  const chat = managementChat;
  return chat ? { active: !!chat.active, unread: !!chat.unread, open: !chat.window.hidden } : null;
}
function syncManagementChat() {
  if (managementChat?.user === me?.id && me) return;
  managementChat?.client?.dispose();
  managementChat?.cleanup();
  managementChat?.window.remove(); managementChat = null;
  document.body.classList.remove('management-page-mode');
  if (!me) { pendingRepositoryOnboarding = null; return; }
  const box = element('section', '', 'management-window management-page'); box.id = 'management-chat'; box.hidden = true;
  box.setAttribute('role', 'region'); box.setAttribute('aria-label', '管理助手');
  const panel = element('div', '', 'management-panel'); box.append(panel);
  document.body.append(box);
  const chat = managementChat = { user: me.id, window: box, panel, client: null, loading: null, openVersion: 0, active: false, unread: false };
  const header = document.querySelector('body > header');
  const updateViewport = () => {
    box.style.setProperty('--management-header-height', (header?.getBoundingClientRect().height || 0) + 'px');
    box.toggleAttribute('data-compact', !box.hidden && box.getBoundingClientRect().height < 520);
  };
  chat.updateViewport = updateViewport;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateViewport) : null;
  if (header) observer?.observe(header);
  const scopeBar = document.getElementById('console-mobile-scope');
  if (scopeBar) observer?.observe(scopeBar);
  window.addEventListener('resize', updateViewport);
  chat.cleanup = () => { observer?.disconnect(); window.removeEventListener('resize', updateViewport); };
}
async function openManagementPage(projectId = null) {
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  const address = consolePageAddress('management', projectId || consoleScope());
  if (location.hash !== address) history.pushState(null, '', address);
  await route();
}
