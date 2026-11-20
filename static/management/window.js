let managementChat = null, pendingRepositoryOnboarding = null;
function repositoryOnboardingPrompt(repo) {
  const label = repo.full_name || ('仓库编号 ' + repo.id);
  if (repo.started) {
    return `请帮我核对并优化仓库 ${label} 的接入配置：先读取当前已生效配置与仓库现状（文档、构建与测试命令、CI 工作流、现有标签和近期 Issue/PR），给出简要仓库画像和能力档说明，只针对与当前配置有差异的关键选择向我提问并给出推荐项；等我确认后再应用配置（若需要修改 .github/workflows/，请生成待我在控制台确认的开发任务）。`;
  }
  return `请帮我接入已安装仓库 ${label}：先只读分析仓库（README、目录结构、构建与测试命令、CI 工作流、现有标签与近期 Issue/PR），给出仓库画像、各能力上限（read / comment / develop）说明以及最多 5 个关键配置问题和推荐项；等我确认后再启动仓库（或提交启动申请）并按确认项完成配置。`;
}
function managementRecommendations({ scope = 'platform', project = null, projects = [], pendingRepositories = [] } = {}) {
  const scopedProject = scope !== 'platform' ? project : null;
  const onlyOneRepo = scopedProject || (projects.length + pendingRepositories.length === 1 ? (projects[0] || pendingRepositories[0]) : null);
  const targetName = onlyOneRepo?.full_name || null;
  const onboarding = scopedProject
    ? { description: '对照当前配置只读分析仓库，确认后再调整设置',
      prompt: repositoryOnboardingPrompt({ id: scopedProject.id, full_name: scopedProject.full_name, started: true }) }
    : !projects.length && pendingRepositories.length === 1
    ? { description: `只读分析待接入仓库 ${pendingRepositories[0].full_name}，确认后启动并配置`,
      prompt: repositoryOnboardingPrompt({ id: pendingRepositories[0].id, full_name: pendingRepositories[0].full_name, started: false }) }
    : !pendingRepositories.length && projects.length === 1
    ? { description: `对照当前配置只读分析 ${projects[0].full_name}，确认后再调整设置`,
      prompt: repositoryOnboardingPrompt({ id: projects[0].id, full_name: projects[0].full_name, started: true }) }
    : pendingRepositories.length > 0
    ? { description: '选择待接入或已启动仓库做只读分析，确认后启动并配置',
      prompt: `请先列出我当前待接入的已安装仓库（${pendingRepositories.slice(0, 3).map(repo => repo.full_name).join('、')}${pendingRepositories.length > 3 ? ' 等' : ''}）与已启动项目，帮我选择要接入或核对接入配置的仓库：先只读分析仓库（README、目录结构、构建与测试命令、CI 工作流、现有标签与近期 Issue/PR），给出仓库画像、各能力上限（read / comment / develop）说明以及最多 5 个关键配置问题和推荐项；等我确认后再启动仓库（或提交启动申请）并按确认项完成配置。` }
    : { description: '只读分析仓库现状与当前配置，确认后再启动或调整设置',
      prompt: '请先列出我当前可管理的仓库与待接入仓库，帮我选择要接入或核对接入配置的仓库：选定后先读取当前配置并只读分析仓库（文档、构建与测试命令、CI 工作流、现有标签和近期 Issue/PR），给出仓库画像、能力档说明与关键配置推荐项；等我确认后再启动或应用配置。' };
  return [
    { id: 'onboarding', title: '运行仓库接入助手', description: onboarding.description, prompt: onboarding.prompt },
    { id: 'gates', title: '优化门禁', description: '按分层门禁梳理测试与工作流缺口，确认后生成 CI 改动任务',
      prompt: targetName
        ? `请帮我评估并优化仓库 ${targetName} 的 CI 门禁：先读取 layered-ci-gates 技能以及仓库现有的脚本、测试目录、.github/workflows/、近期 Actions 运行耗时与失败情况和分支规则，按分层门禁给出当前缺口、各层检查建议、需人工调整的仓库设置与拆分 PR 计划；等我确认方案后，再生成待我在控制台确认的 .github/workflows/ 开发任务。`
        : '请帮我评估并优化仓库的 CI 门禁（仓库：，留空则先列出我可管理的仓库供选择）：先读取 layered-ci-gates 技能以及仓库现有的脚本、测试目录、.github/workflows/、近期 Actions 运行耗时与失败情况和分支规则，按分层门禁给出当前缺口、各层检查建议、需人工调整的仓库设置与拆分 PR 计划；等我确认方案后，再生成待我在控制台确认的 .github/workflows/ 开发任务。' },
    { id: 'actions', title: '分析 Actions 运行', description: '读取指定运行或近期失败作业日志，定位根因与修复建议',
      prompt: targetName
        ? `请帮我分析仓库 ${targetName} 的 GitHub Actions 运行（运行编号或链接：，留空则先查看近期失败的运行）：读取对应 workflow 配置、作业状态与失败日志，区分代码缺陷、环境配置或偶发波动，定位根因并给出修复建议。`
        : '请帮我分析某次 GitHub Actions 运行（仓库与运行编号或链接：，留空则先查看我可管理仓库近期失败的运行）：读取对应 workflow 配置、作业状态与失败日志，区分代码缺陷、环境配置或偶发波动，定位根因并给出修复建议。' },
    { id: 'issue', title: '分析 Issue', description: '结合仓库代码调查指定 Issue 的成因、影响范围与处理方案',
      prompt: targetName
        ? `请帮我分析仓库 ${targetName} 的 Issue #（也可填链接，或留空先列出近期值得关注的未关闭 Issue）：读取 Issue 描述与评论、关联代码和已有任务记录，梳理成因、影响范围与处理方案，等我确认后再决定是否创建任务或调整标签。`
        : '请帮我分析某个 Issue（仓库与 Issue 编号或链接：，留空则先列出我可管理仓库近期值得关注的未关闭 Issue）：读取 Issue 描述与评论、关联代码和已有任务记录，梳理成因、影响范围与处理方案，等我确认后再决定是否创建任务或调整标签。' },
  ];
}
function queueRepositoryOnboarding(repo) {
  if (!me || !repo?.id) return;
  pendingRepositoryOnboarding = { user: me.id, id: String(repo.id), full_name: repo.full_name || null, started: !!repo.started, prompt: typeof repo.prompt === 'string' ? repo.prompt : null };
}
// #1123: a project page opens the project's assistant with its own request in the composer; nothing is sent until the
// person finishes the sentence and sends it.
function openManagementRequest(projectId, prompt) { return openRepositoryOnboarding({ id: projectId, started: true, prompt }); }
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
