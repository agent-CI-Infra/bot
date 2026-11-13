// The next step is the first thing under the title, above the timeline and the side panel on every screen width.
function renderTaskNext(task, roles, purposes) {
  const text = taskNextStep(task, task.structured, roles, purposes), line = $('task-next-text');
  if (line.textContent !== text) line.textContent = text;
  $('task-next').hidden = false;
}
const evidenceSource = source => source === 'policy_validation' ? '项目测试命令' : /^task_history:\d+$/.test(source) ? '任务记录 #' + source.slice(13) : source;
// Goal, candidate, evidence, acceptance and publication, each read from the task's own record. A part that has not
// happened yet says what produces it, so the card never looks like a plan the page made up.
function taskFactsCard(task, record, publications) {
  const section = card('任务事实'); section.classList.add('task-facts');
  const part = (title, status, ...nodes) => {
    const box = element('section', '', 'task-fact'), head = element('div', '', 'task-fact-head'); box.dataset.fact = title;
    head.append(element('h4', title), ...(status ? [status] : [])); box.append(head, ...nodes); section.append(box);
  };
  const list = items => { const ul = element('ul', '', 'task-fact-list'); for (const item of items) ul.append(item instanceof Node ? item : element('li', item)); return ul; };
  const contract = record.contract, candidate = record.candidate;
  part('目标', badge('需求版本 ' + record.revision), element('p', contract.goal, 'say'),
    facts([['验收条件', contract.criteria?.length ? list(contract.criteria) : '没有写明，按目标判断'], ['约束', contract.constraints?.length ? list(contract.constraints) : null],
      ['交付终点', contract.endpoint || '尚未明确'], ['选用的指南', record.selections?.length ? list(record.selections.map(p => `${p.id} · ${shortId(p.version)} · ${p.purpose}`)) : null]]));
  if (!candidate) part('候选', badge('还没有'), mutedLine('执行方提交成果后，候选固定在这里，之后的验收只认这一版。'));
  else part('候选', candidate.revision === record.revision ? badge('当前', 'info') : badge('基于旧需求版本', 'warning'),
    facts([['编号', shortId(candidate.id)], ['需求版本', candidate.revision], ['成果', candidate.artifacts.map(a => `${a.kind === 'code' ? '代码' : a.kind === 'report' ? '报告' : a.kind} ${shortId(a.version)}`).join('、')], ['提交时间', timestamp(candidate.created_at)]]));
  const evidence = candidate?.evidence || [];
  if (!evidence.length) part('证据', badge(candidate ? '没有附带' : '还没有'), mutedLine(candidate ? '这个候选没有附带证据；独立 QA 会自己检查，证据不足时退回。' : '随候选一起提交，例如测试命令的结果和任务记录。'));
  else part('证据', badge(`${evidence.filter(e => e.verified).length}/${evidence.length} 已核验`, evidence.every(e => e.verified) ? 'success' : 'warning'),
    list(evidence.map(e => { const li = element('li', ''); li.append(element('span', evidenceSource(e.source)), badge(e.verified ? '已核验' : '未核验', e.verified ? 'success' : 'warning'), element('code', shortId(e.version))); return li; })));
  const verdict = record.pending || record.acceptance;
  if (!verdict) part('验收', badge(candidate ? '等待验收' : '还没有'), mutedLine(candidate ? '独立 QA 会在新的上下文里验收这个候选，执行方和主控都不能代替它。' : '有候选后，由独立 QA 在新的上下文里验收。'));
  else {
    const outcome = own(acceptanceLabels, verdict.outcome) || verdict.outcome, passing = ['pass', 'pass_with_issues'].includes(verdict.outcome);
    part('验收', badge(record.pending ? outcome + '（待发布确认）' : outcome, passing ? 'success' : 'warning'),
      facts([['验收的候选', shortId(verdict.candidate_id) + (candidate && verdict.candidate_id !== candidate.id ? '（不是当前候选）' : '')], ['结论', verdict.reason],
        ['还缺', verdict.gaps?.length ? list(verdict.gaps) : null], ['遗留项', verdict.residuals?.length ? list(verdict.residuals.map(r => `${r.key} · ${r.description}`)) : null]]));
    for (const f of record.followups || []) section.lastElementChild.append(button('查看遗留任务 ' + f.issue_key, () => openTask(f.task_id)));
  }
  if (publications?.length) {
    const rows = element('ul', '', 'history');
    for (const p of publications) {
      const row = element('li', ''), [caption, tone] = publicationStates[p.state] || [p.state, ''], name = publicationLabels[p.kind] || p.kind;
      row.append(p.response?.html_url ? link(p.response.html_url, name) : element('span', p.kind === 'label' && Array.isArray(p.response) ? `${name} ${p.response.map(l => l.name).join('、')}` : name), badge(caption, tone));
      rows.append(row);
    }
    part('发布', null, rows);
  } else part('发布', badge(terminalStates.includes(task.status) ? '没有写到 GitHub' : '还没有'), mutedLine(terminalStates.includes(task.status) ? '这个任务没有写到 GitHub 的内容，结果只留在控制台。' : '验收通过后，由控制面按工作类型允许的写入发布到 GitHub。'));
  return section;
}
// How the task ran: under the project controller or on its work type's own executor, and the delegations actually recorded.
function taskExecutionCard(task, record, roles, purposes) {
  const section = card('谁在执行'), controller = controllerOf(roles), qaRuns = roles?.runs.filter(run => run.role === 'qa').length || 0;
  section.classList.add('task-execution');
  if (!roles) section.append(mutedLine('读不到这个任务的角色记录。'));
  else if (task.origin?.source_kind === 'role' && task.origin.executor_role) section.append(element('p', `任务执行角色：${task.origin.executor_role}。实际运行与独立 QA 记录将在下方显示。`));
  else if (controller) {
    const legacy = roles.snapshot(controller.snapshot_id)?.legacy;
    section.append(element('p', `角色协调：主控 Manager（${harnessName(controller.harness)}${legacy ? '，旧配置沿用' : ''}）按需委派工作，候选由它提名后交给独立 QA。`));
  } else section.append(element('p', '没有读取到主控记录；实际 Agent 和模型以运行记录为准。'));
  if (roles) section.append(facts([['独立 QA', qaRuns ? `运行过 ${qaRuns} 次，每次都是新的上下文` : record?.candidate ? '等待验收' : '有候选后验收']]));
  // The delegations in the order they were recorded, each with the harness of every run that executed it. A stage
  // timeline, once the server keeps one per task, belongs in this list too; until then nothing here is inferred from the
  // Manager prompt or the role configuration.
  const work = (roles?.assignments || []).filter(a => !['manager', 'qa'].includes(a.role));
  if (roles && !roles.complete) section.append(element('p', `委派记录没有读完：服务端的分页游标没有前进，下面只列出已读到的 ${roles.assignments.length} 条，看不出现在是谁在处理。`, 'endpoint-warning'));
  if (work.length) {
    const list = element('ol', '', 'role-work');
    for (const a of work) {
      const item = element('li', ''), head = element('div', '', 'role-work-head'), [caption, tone] = own({ running: ['进行中', 'info'], completed: ['已交回', 'success'], failed: ['失败', 'danger'] }, a.status) || [a.status, ''];
      head.append(element('strong', roleLabel(a.role, a.name)), element('span', a.harnesses.map(harnessName).join(' → ') || '—', 'muted'), badge(caption, tone));
      item.append(head);
      // A project's own role says what it is for; the built-in roles are explained on the 角色 page. Their names on this
      // page never come from a snapshot, so only a project's own role can lose its historical definition.
      if (!own(builtinRoleNames, a.role) && a.definitionMissing) item.append(element('p', '历史定义不可用：这次运行没有留下可读的角色快照，名称和职责不按现在的定义补写。', 'muted role-work-duty'));
      else if (!own(builtinRoleNames, a.role) && a.responsibility) item.append(element('p', '职责：' + a.responsibility, 'muted role-work-duty'));
      if (purposes[a.id]) item.append(element('p', purposes[a.id]));
      if (a.candidate_version) item.append(element('p', '看的是候选版本 ' + shortId(a.candidate_version), 'muted'));
      // A delegation that ran more than once (recovery, a new revision) shows each run, oldest first.
      if (a.runs.length > 1) item.append(mutedLine(`执行了 ${a.runs.length} 次：` + a.runs.map((run, at) => `第 ${at + 1} 次 ${harnessName(run.harness)}`
        + (at && own(recoveryModes, run.recovery_mode) ? '，' + own(recoveryModes, run.recovery_mode) : '') + '，' + (own(runCaptions, run.status) || run.status)
        + (run.stop_reason ? `（${own(stopReasons, run.stop_reason) || run.stop_reason}）` : '')).join('；') + '。'));
      list.append(item);
    }
    section.append(element('h4', '委派记录'), list, mutedLine('按实际记录的先后列出。这不是预设流程，也不授予权限：委派谁由主控按任务决定，写入只来自工作类型配置。'));
  } else if (controller && roles.complete) section.append(mutedLine('主控还没有委派工作。'));
  return section;
}
// Which events the Manager created or continued this task for, and why. Its brief explains the work; it grants nothing.
function taskDispatchCard(entries) {
  const section = card('Manager 分派'), list = element('ul', '', 'history');
  for (const entry of entries) {
    const item = element('li', '');
    item.append(element('strong', entry.relation === 'created' ? '因事件新建' : '续接事件'), ' ', element('span', entry.summary), element('p', '理由：' + (entry.reason || '—'), 'muted'));
    if (entry.brief?.goal) item.append(element('p', '简要说明：' + entry.brief.goal + (entry.brief.criteria?.length ? '（' + entry.brief.criteria.join('；') + '）' : ''), 'muted'));
    item.append(element('span', timestamp(entry.decided_at || entry.created_at), 'muted')); list.append(item);
  }
  section.append(list); return section;
}
function taskRunHistoryCard(roles) {
  const section = card('实际运行记录');
  section.append(mutedLine('每次重试和恢复保留独立运行；下方 Agent、模型和配置取自该次运行快照。'));
  if (!roles) { section.append(mutedLine('角色运行记录读取失败，实际执行配置未知。')); return section; }
  if (!roles.runs.length) { section.append(mutedLine('没有角色运行记录；历史任务不补造运行。')); return section; }
  const list = element('div', '', 'task-run-history');
  for (const run of roles.runs.slice().reverse()) {
    const snapshot = roles.snapshot(run.role_snapshot), row = element('details', '', 'fold');
    const summary = element('summary', `${roleLabel(run.role, snapshot?.name)} · ${own(runCaptions, run.status) || run.status} · ${shortId(run.id)}`);
    row.append(summary, facts([['运行 ID', run.id], ['委派 ID', run.assignment_id || '未关联委派'],
      ['Agent', run.harness ? `${harnessName(run.harness)}${run.harness_version ? ' · ' + run.harness_version : ''}` : '未记录'],
      ['模型', snapshot?.model?.name || '快照未提供'], ['模型来源', ({ role: '角色覆写', workflow: '工作类型', project: '项目默认', external_harness: '外部 Agent 自带' })[snapshot?.model?.source] || '未知'],
      ['配置版本', snapshot?.config_revision == null ? '未记录' : String(snapshot.config_revision)],
      ['开始', timestamp(run.started_at) || '未记录'], ['结束', timestamp(run.ended_at) || (run.status === 'running' ? '尚未结束' : '未记录')],
      ['续接来源', run.resume_from_run_id || null], ['停止原因', stopReasons[run.stop_reason] || run.stop_reason || null]]));
    list.append(row);
  }
  section.append(list); return section;
}
function taskDetails(title, ...content) {
  const section = element('details', '', 'fold task-details');
  section.append(element('summary', title), ...content); return section;
}
function taskOverviewCard(task) {
  const section = card('任务目标'); section.classList.add('task-overview');
  section.append(element('p', task.structured?.contract?.goal || task.summary || '尚未记录任务目标。', 'say'));
  const runtime = metricRuntime(task.metrics);
  section.append(facts([['执行耗时', runtime === '—' ? '未记录' : runtime], ['优先级', task.priority || 'P2']]),
    mutedLine('执行耗时不含排队和等待；未记录表示没有可靠的耗时数据。'));
  return section;
}
function taskAttentionCard(task, roles) {
  const section = card('需处理事项'); section.classList.add('task-attention');
  const fault = task.error_detail || (task.error_code === 'pr_head_pending' ? 'PR 尚未指向刚推送的提交' : ownershipErrors[task.error_code] || taskErrorText(task.error_code));
  section.append(facts([[task.error_code === 'repository_has_no_commit' ? '等待原因' : '故障', fault],
    ['原因', task.error_code && task.error_code !== 'repository_has_no_commit' && task.error_cause ? faultSummary(task.error_code, task.error_cause) : null],
    ['处理', task.error_code !== 'repository_has_no_commit' ? task.error_cause?.action : null]]));
  const record = task.structured, verdict = record?.pending || record?.acceptance;
  if (verdict?.gaps?.length || verdict?.residuals?.length) {
    section.append(mutedLine(verdict.candidate_id === record.candidate?.id && verdict.revision === record.revision ? '当前候选的验收记录：' : '先前候选或需求版本的验收记录：'));
    const list = element('ul', '', 'task-fact-list');
    for (const gap of verdict.gaps || []) list.append(element('li', gap));
    for (const residual of verdict.residuals || []) list.append(element('li', residual.description));
    section.append(list);
    for (const followup of record.followups || []) section.append(button('查看遗留任务 ' + followup.issue_key, () => openTask(followup.task_id)));
  }
  if (!roles) section.append(mutedLine('角色运行记录读取失败，实际执行配置未知。'));
  else if (!roles.complete) section.append(mutedLine('委派记录未完整读取，当前执行者以已读取的记录为限。'));
  return section.querySelector('dd, li, p') ? section : null;
}
function renderTaskSide(detail, environment, roles = null, purposes = {}) {
  const { task, publications } = detail, side = $('task-side'); side.replaceChildren();
  const record = task.structured;
  side.append(taskOverviewCard(task));
  const attention = taskAttentionCard(task, roles); if (attention) side.append(attention);
  const result = resultCard(task) || card('任务结果');
  if (!result.querySelector('p, dd, li')) result.append(mutedLine(terminalStates.includes(task.status) ? '没有记录任务结果，请结合实际状态和验收记录查看。' : '尚未产生任务结果。'));
  const verdict = record?.pending || record?.acceptance;
  if (verdict) result.append(facts([['验收', (own(acceptanceLabels, verdict.outcome) || verdict.outcome) + (record.pending ? '（待发布确认）' : '')
    + (verdict.candidate_id !== record.candidate?.id ? '（不是当前候选）' : '') + (verdict.revision !== record.revision ? '（先前需求版本）' : '')], ['验收结论', verdict.reason]]));
  result.classList.add('task-outcome'); side.append(result);
  // The task keeps the webhook delivery that created it; name it here so the chain can be walked back (#238).
  const sourceDelivery = record?.contract?.source?.delivery_id;
  if (task.origin || sourceDelivery) {
    const origin = card('任务来源与执行者'), served = task.origin ? [['来源消息', task.origin.source_message], ['父任务', task.origin.source_task_id]] : [];
    origin.append(note(task.origin ? taskOriginCaption(task.origin) : '来源：Webhook 投递'), facts(served));
    if (sourceDelivery) { origin.dataset.sourceDelivery = sourceDelivery; origin.append(facts([['来源投递', button('查看投递', () => openTaskDelivery(sourceDelivery).catch(error), 'quiet linkish')]])); }
    side.append(taskDetails('执行来源', origin));
  }
  if (record) side.append(taskDetails('完整目标、候选与验收证据', taskFactsCard(task, record, publications)), taskDetails('执行者与完整委派', taskExecutionCard(task, record, roles, purposes)));
  side.append(taskDetails('实际运行记录', taskRunHistoryCard(roles)));
  if (detail.dispatch?.length) side.append(taskDetails('Manager 分派记录', taskDispatchCard(detail.dispatch)));
  const info = card('任务技术信息');
  info.append(facts([['优先级', task.priority || 'P2'], ['入队序号', String(task.queue_seq ?? '—')], ['阶段', phaseLabels[task.phase] || task.phase], ['尝试', `第 ${task.attempt} 次`], ['提交', task.head_sha?.slice(0, 12)],
    [task.error_code==='repository_has_no_commit'?'等待原因':'故障', task.error_detail||(task.error_code==='pr_head_pending'?'PR 尚未指向刚推送的提交':ownershipErrors[task.error_code]||taskErrorText(task.error_code))],
    ['原因', task.error_code&&task.error_code!=='repository_has_no_commit'&&task.error_cause?faultSummary(task.error_code,task.error_cause):null], ['处理', task.error_code!=='repository_has_no_commit'?task.error_cause?.action:null], ['已推送提交',task.pushed_sha], ['创建', timestamp(task.created_at)], ['更新', timestamp(task.updated_at)]]));
  if (task.source_task_id) info.append(button('查看来源检视', () => openTask(task.source_task_id)));
  if (!terminalStates.includes(task.status)) {
    const controls = card('任务操作'); controls.classList.add('task-controls');
    const priority=element('select'),reason=element('input');priority.setAttribute('aria-label','任务优先级');reason.placeholder='影响证据与调整理由';reason.style.width='100%';reason.style.boxSizing='border-box';reason.setAttribute('aria-label','优先级调整理由');
    for(const level of ['P0','P1','P2','P3']){const option=element('option',level);option.value=level;priority.append(option);}priority.value=task.priority||'P2';priority.dataset.savedValue=priority.value;
    controls.append(mutedLine('P0 紧急止损 · P1 核心阻塞 · P2 正常开发 · P3 非核心完善；改级排到新级队尾，不抢占运行。'),priority,reason,button('调整优先级',async()=>{try{await api('/api/tasks/'+task.id+'/priority','POST',{priority:priority.value,reason:reason.value});priority.dataset.savedValue=priority.value;reason.value='';await refreshTask();}catch(e){notice('task-error',e.message);}}));
    side.append(controls);
  }
  if(record?.relations?.length){const relations=card('关联任务');for(const r of record.relations){const target=r.source_task_id===task.id?r.target_task_id:r.source_task_id;relations.append(button(shortId(target)+' · '+r.relationship,()=>openTask(target)),element('p',r.reason,'muted'));}side.append(relations);}
  side.append(taskDetails('用量明细', taskMetricsCard(task)), taskDetails('项目环境与操作', computerCard(task, environment)), taskDetails('任务技术信息', info));
  // A task without a structured record still lists what was written to GitHub.
  if (!record && publications?.length) {
    const section = card('GitHub 发布记录'), list = element('ul', '', 'history');
    for (const p of publications) {
      const row = element('li', ''), [caption, tone] = publicationStates[p.state] || [p.state, ''], name = publicationLabels[p.kind] || p.kind;
      row.append(p.response?.html_url ? link(p.response.html_url, name) : element('span', p.kind === 'label' && Array.isArray(p.response) ? `${name} ${p.response.map(l => l.name).join('、')}` : name), badge(caption, tone));
      list.append(row);
    }
    section.append(list); side.append(taskDetails('GitHub 发布记录', section));
  }
  if(detail.history_page){const section=card('结构化过程记录'),index=element('a','按需查看分页索引');index.href='/api/tasks/'+encodeURIComponent(task.id)+'/events?limit=50';index.target='_blank';index.rel='noopener noreferrer';section.append(index,element('p','详情只保留最近 50 条索引；记录正文通过索引中的 source 引用读取。','muted'));side.append(taskDetails('结构化过程记录',section));}
  const raw = element('details', '', 'fold raw'); raw.append(element('summary', '原始数据'), element('pre', JSON.stringify(detail, null, 2), 'output')); side.append(raw);
}
function computerCard(task, environment) {
  const section = card('虚拟电脑（项目环境）');
  if (!environment) { section.append(element('p', '无法读取环境状态。', 'muted')); return section; }
  const env = environment.environment, pc = env.computer || {}, running = environment.running_tasks || [];
  const others = running.filter(other => other.id !== task.id).length, mine = running.length > others;
  const usage = mine ? (others ? `本任务正在使用，另有 ${others} 个任务同时执行` : '本任务正在使用') : running.length ? `正在执行 ${running.length} 个任务` : '空闲';
  const head = element('div', '', 'actions'); head.append(state(env.state), element('span', usage, 'muted')); section.append(head);
  section.append(facts([['容器', pc.container], ['代次', task.generation && env.generation && task.generation !== env.generation ? `当前 g${env.generation}，本任务用 g${task.generation}` : env.generation ? 'g' + env.generation : '待创建'],
    ['资源', pc.cpus ? `${pc.cpus} CPU · ${pc.memory_mb} MB 内存 · ${pc.pids} 进程` : null], ['网络', networkText(pc)]]));
  const actions = element('div', '', 'actions');
  actions.append(button('打开项目机器配置', () => { taskView.close(); openProject(task.repository_id, 'machine'); }), ...environmentButtons(env, running.length > 0, refreshTask, err => notice('task-error',err.message)));
  section.append(actions); return section;
}
function resultCard(task) {
  const result = task.result; if (!result) return null;
  const review = task.kind.startsWith('review.'), section = card(review ? '检视结论' : task.kind === 'task.request' ? '任务结果' : '开发结果');
  if (result.summary) section.append(element('p', result.summary, 'say'));
  if (review && Array.isArray(result.findings)) {
    section.append(element('p', `${result.findings.length} 条发现`, 'muted'));
    const list = element('ol', '', 'findings');
    for (const finding of result.findings) {
      const item = element('li', '');
      item.append(element('span', finding.format === 'inline' && finding.path ? `行内 · ${finding.path}:${finding.line}` : '讨论评论', 'call'), element('p', clipText(finding.body, 500)));
      if (finding.selection_reason) item.append(element('p', '选择理由：' + finding.selection_reason, 'muted'));
      list.append(item);
    }
    section.append(list);
  } else if (!review) {
    section.append(facts([['分支', result.branch], ['PR', result.pr_url ? link(result.pr_url, 'PR #' + result.pr_number) : null],
      ['测试', result.validation ? `${result.validation.command} · 退出码 ${result.validation.exit_code}` : result.test_command], ['提交', result.sha?.slice(0, 12)]]));
  }
  return section;
}

taskView.addEventListener('close', () => {
  const origin = taskInboxOrigin; taskInboxOrigin = null;
  clearTimeout(taskTimer); openTaskId = null; taskReadVersion++; taskLogState = null;
  if (origin && typeof refreshInboxAfterTask === 'function') void refreshInboxAfterTask(origin);
});
$('logout').addEventListener('click', () => { if (taskView.open) taskView.close(); });

