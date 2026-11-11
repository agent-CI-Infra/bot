// Preflight and records use separate reads: a failure never turns an existing release into an empty history.
function releaseSection() {
  const target = current, id = target.id, owner = me.id, section = card('发版本'), endpoint = `/api/repositories/${id}/releases`;
  section.classList.add('release-panel');
  const layout = element('div', '', 'release-preparation'), preparation = element('div', '', 'release-input'), preview = element('div', '', 'release-preview');
  const version = input('release_version', target.releaseVersion || '', { placeholder: 'v1.2.3 或 v1.2.3-beta.1', maxLength: 256 });
  const status = element('div', '', 'release-history'), message = element('p', '', 'view-error'), readStatus = element('p', '', 'muted');
  message.setAttribute('role', 'alert'); readStatus.setAttribute('role', 'status');
  let checking = 0, reading = 0, writing = false;
  const live = () => section.isConnected && current === target && current.section === 'release' && me?.id === owner;
  const denied = error => {
    if (![401,403].includes(error.status)) return false;
    checking++; reading++; target.releasePreview = null; target.releaseEdits?.clear(); confirm.disabled = true;
    preview.replaceChildren(); status.replaceChildren(); message.textContent = '发布权限已失效，请刷新项目或联系管理员。'; return true;
  };
  const confirm = button('确认打标签', async () => {
    const p = target.releasePreview;
    if (!live() || writing || !p?.available || p.version !== version.value) return;
    if (!await askConfirm({ title: `确认打标签 ${p.version}？`, body: [p.target_sha, p.target_title, `范围：${p.previous_tag?.name || '仓库起点'} → ${p.version}`, '标签触发 Release 检查；通过后生成草稿，正式发布仍需独立确认。'], action: '确认打标签' })) return;
    if (!live()) return; writing = true; confirm.disabled = true;
    try { if (!live()) return; await api(endpoint, 'POST', { version: p.version, target_sha: p.target_sha, credential: p.credential }); if (live()) await refresh(); }
    catch (error) { if (!live()) return; if (!denied(error)) { const detail = error.message;
      if (!error.status || error.status >= 500) { target.releasePreview = null; confirm.disabled = true; await refresh(); if (live()) message.textContent = detail + '；提交结果未确认，请先核对发布记录，再重新检查候选。'; }
      else { await check(); if (live()) message.textContent = detail; } } }
    finally { writing = false; if (live()) confirm.disabled = !target.releasePreview?.available || target.releasePreview.version !== version.value; }
  }); confirm.disabled = true;
  const check = async () => {
    const token = ++checking, value = version.value; target.releaseVersion = value; target.releasePreview = null; confirm.disabled = true;
    preview.replaceChildren(note('正在读取仓库与候选提交…')); message.textContent = '';
    try {
      const p = await api(endpoint + '/preflight?version=' + encodeURIComponent(value));
      if (!live() || token !== checking || value !== version.value) return;
      target.releasePreview = p; version.pattern = p.version_pattern || '';
      const title = element('h3', p.available ? '候选已就绪，等待确认' : p.error ? '候选状态未知' : '发布前检查'), list = element('ul', '', 'release-preflight-checks');
      for (const c of p.checks || []) {
        const item = element('li', '', c.ok ? 'release-check-ready' : p.version_valid ? 'release-check-failed' : '');
        item.append(element('span', c.ok ? '✓' : '·'), element('span', c.message + (c.reason ? ' ' + c.reason : ''), !c.ok && p.version_valid ? 'release-check-failed' : '')); list.append(item);
      }
      preview.replaceChildren(title, list); if (p.detail) preview.append(note(p.detail));
      if (p.target_sha) preview.append(facts([['默认分支', p.default_branch], ['目标提交', link(p.target_url, p.target_sha)], ['提交标题', p.target_title],
        ['版本', !p.version_valid ? '请填写合法版本号' : p.prerelease ? '预发布' : '稳定版'], ['上一枚版本', p.previous_tag ? `${p.previous_tag.name} · ${p.previous_tag.sha}` : '从仓库历史起算'],
        ['新增提交', Number.isSafeInteger(p.commit_count) ? String(p.commit_count) : '数量未提供'], ['发行说明规则', `${({repository:'仓库文件',console:'项目设置',builtin:'内置规则'})[p.skill.source] || p.skill.source} · ${p.skill.path || p.skill.version}`],
        ['已有标签', p.existing_tag ? p.existing_tag.commit : '无'], ['已有 Release', p.existing_release ? link(p.existing_release.url, p.existing_release.draft ? '已有草稿' : '已由仓库工作流／外部操作发布') : '无']]));
      confirm.disabled = writing || !p.available;
    } catch (error) { if (!live() || token !== checking) return; target.releasePreview = null; confirm.disabled = true; if (!denied(error)) { preview.replaceChildren(note('候选读取失败，当前无法确认目标提交。')); message.textContent = error.message; } }
  };
  const refresh = async () => {
    const token = ++reading;
    try {
      const data = await api(endpoint); if (!live() || token !== reading) return;
      readStatus.textContent = `记录读取于 ${new Date().toLocaleTimeString()}；这是读取时间。`;
      if (document.activeElement?.name === 'release_body') return;
      status.replaceChildren(...data.releases.map(record => releaseRecord(record, endpoint, refresh, message, { live, target })));
      if (!data.releases.length) status.append(note('还没有发布记录。'));
    } catch (error) { if (!live() || token !== reading) return; if (!denied(error)) { readStatus.textContent = '发布记录读取失败；保留上次内容，当前状态未确认。'; message.textContent = error.message; } }
  };
  version.addEventListener('input', () => { checking++; target.releasePreview = null; target.releaseVersion = version.value; confirm.disabled = true; });
  version.addEventListener('change', check);
  const controls = element('div', '', 'actions'); controls.append(button('检查候选提交', check), confirm);
  preparation.append(element('h3', '准备新版本'), note('确认版本与精确提交后创建标签。检查通过只生成草稿；正式发布需要再次确认。'), field('版本号', version), controls);
  layout.append(preparation, preview); const historyHead = element('div', '', 'heading'); historyHead.append(element('h3', '发布记录'), button('刷新发布记录', refresh, 'quiet'));
  section.append(layout, message, historyHead, readStatus, status); void check(); void refresh();
  const poll = async () => { if (!live()) return; await refresh(); if (live()) projectTimer = setTimeout(poll, 5000); };
  projectTimer = setTimeout(poll, 5000); return [section];
}
function releaseProcess(record) {
  const proof = record.ci_success, matches = proof?.run_id != null && record.run_id != null && Number.isSafeInteger(proof.attempt) && proof.attempt > 0 && String(proof.run_id) === String(record.run_id) && proof.attempt === record.run_attempt && record.run?.status === 'completed' && record.run?.conclusion === 'success';
  const points = [['目标提交', record.target_sha ? '已冻结' : '未提供'], ['版本标签', record.stage === 'tagging' || record.failure_step === 'tagging' ? '待创建或查证' : record.tag_object_sha ? '已记录' : '未确认'],
    ['Release 检查', matches ? `run ${proof.run_id} / attempt ${proof.attempt} 已通过` : record.expected_attempt > (record.run_attempt || 0) ? `等待 attempt ${record.expected_attempt}` : record.run ? `${record.run.status} · ${record.run.conclusion || '等待结果'}` : '等待运行'],
    ['说明与草稿', record.stage === 'draft' ? '草稿待确认' : record.stage === 'preparing_notes' ? '准备发行说明' : record.body ? '已有正文' : '尚未生成'],
    ['正式发布', record.stage === 'published' ? record.prerelease ? '已人工发布预发布版' : '已人工发布稳定版' : record.stage === 'externally_published' ? '外部已发布' : '尚未正式发布']];
  const steps = element('ol', '', 'release-process'); steps.setAttribute('aria-label', '发布过程');
  for (const [label, value] of points) { const item = element('li'); item.append(element('strong', label), element('span', value)); steps.append(item); } return steps;
}
const releaseStages = { tagging: '正在打标签', waiting_run: '等待 Release 工作流', running: '工作流运行中', preparing_notes: '准备发行说明', creating_draft: '创建草稿', draft: '草稿待发布', publishing: '正式发布中', published: '已人工发布', externally_published: '已由仓库工作流／外部操作发布', failed: '失败', waiting_permission: '等待权限处理', write_unknown: '写入结果待查证' };
function releaseRecord(r, endpoint, refresh, message, context) {
  const { live, target } = context;
  const section = card(r.version), run = r.run;
  section.classList.add('release-record');
  section.append(note(`${r.prerelease ? '预发布' : '稳定版本'} · 发起者 ${r.initiator?.name || '未提供'} · 更新于 ${r.updated_at || '时间未提供'}`), releaseProcess(r));
  section.append(facts([['阶段', releaseStages[r.stage] || r.stage], ['目标提交', r.target_sha], ['失败步骤', r.failure_step], ['错误码', r.error], ['说明', r.detail],
    ['工作流', run?.name], ['Run／attempt', r.run_id ? `${r.run_id} / ${r.run_attempt}` : null], ['状态／结论', run ? `${run.status} / ${run.conclusion || '等待结果'}` : null],
    ['开始时间', run?.started_at], ['结束时间', run?.ended_at], ['Actions', r.actions_url ? link(r.actions_url, '查看本次运行') : null]]));
  const jobs = element('div', '', 'release-jobs');
  for (const job of run?.jobs || []) {
    const item = element('div', '', 'release-job'); item.append(note(`${job.name} · ${job.status} · ${job.conclusion || '等待结果'}`), link(job.url, '查看 job'));
    const failed = (job.steps || []).filter(s => s.conclusion && s.conclusion !== 'success');
    for (const step of failed) item.append(note(`Step ${step.number}: ${step.name} · ${step.conclusion}`)); jobs.append(item);
  }
  section.append(jobs);
  for (const candidate of r.candidates || []) section.append(link(candidate.url, `候选 run ${candidate.id}`));
  const action = (caption, suffix) => {
    const pending = target.releaseActions ||= new Set(), key = r.id + ':' + suffix;
    const control = button(pending.has(key) ? caption + '…' : caption, async () => {
      if (!live() || pending.has(key)) return;
      if (['rerun','resume'].includes(suffix) && !await askConfirm({ title: suffix === 'rerun' ? '重跑这次 Release 检查？' : '查证或恢复这个步骤？', body: [r.target_sha, suffix === 'rerun' ? '会创建新的运行 attempt，不会自动正式发布。' : '将依据已记录的步骤核验或继续；已有同名标签不会移动或删除。'], action: caption })) return;
      if (!live()) return;
      pending.add(key); control.disabled = true; control.textContent = caption + '…';
      try { if (!live()) return; await api(endpoint + '/' + r.id + '/' + suffix, 'POST', { revision: r.revision }); }
      catch (err) { message.textContent = err.message; }
      finally { pending.delete(key); await refresh(); }
    });
    control.disabled = pending.has(key); return control;
  };
  const actions = element('div', '', 'actions'); section.append(actions);
  if (r.stage === 'failed' && ['release_ci_unsuccessful', 'release_rerun_not_started'].includes(r.error) && r.run_id) actions.append(action('重跑', 'rerun'));
  if (['failed', 'write_unknown', 'waiting_permission'].includes(r.stage) && r.error !== 'release_ci_unsuccessful') actions.append(action('继续／查证此步骤', 'resume'));
  if (r.run_id) actions.append(action('让智能体看这次运行（只读）', 'observe'));
  // The request goes to the Manager first; its task runs in the project computer, and this page refreshes until it is done.
  if (r.observation_event && !r.observation_task) section.append(note('运行分析的请求在等 Manager 分派，安排后在项目电脑里执行。'));
  if (r.observation_task) {
    const pending = element('p', '运行分析在项目电脑里排队或执行中，完成后显示在这里。', 'muted');
    pending.append(' ', button('查看分析过程', () => openTask(r.observation_task), 'quiet')); section.append(pending);
  }
  if (r.observation_error) section.append(note(r.observation_error));
  if (r.observation) {
    const historical = r.observation.run_id !== r.run_id || r.observation.attempt !== r.run_attempt;
    section.append(note(`${historical ? '历史运行分析（与当前运行不同）' : '运行分析'} · run ${r.observation.run_id} / attempt ${r.observation.attempt} · 仅供排查的建议`), releaseAdvice(r.observation.advice));
    for (const job of r.observation.jobs) section.append(link(job.url, `${job.name} · ${job.conclusion}`));
    for (const log of r.observation.logs || []) {
      const related = log.run_id !== r.observation.run_id || log.attempt != null && log.attempt !== r.observation.attempt;
      const origin = related ? ` · run ${log.run_id} / attempt ${log.attempt ?? '未知'}` : '';
      const details = element('details'); details.append(element('summary', `${log.name} 日志${origin} · 第 ${log.first_line}–${log.last_line || log.first_line} 行${log.truncated ? '（已截取）' : ''}`), link(log.url, '查看 job 完整日志'), element('pre', log.content)); section.append(details);
    }
  }
  if (r.release_url) actions.append(link(r.release_url, '查看 GitHub Release'));
  if (r.skill) {
    const provenance = element('details'); provenance.append(element('summary', '发行说明规则与范围'), facts([['规则来源', r.skill.source], ['规则路径／版本', r.skill.path || r.skill.version], ['规则所在提交', r.skill.sha], ['规则内容哈希', r.skill.hash], ['上一枚版本', r.previous_tag ? `${r.previous_tag.name} · ${r.previous_tag.sha}` : '从仓库历史起算']])); section.append(provenance);
  }
  if (r.sources) {
    const details = element('details'), summary = element('summary', `发行说明来源（${r.sources.length}）`); details.append(summary);
    for (const source of r.sources) details.append(note(`${source.kind} · ${source.title}`), link(source.url, source.id));
    if (!r.sources.length) details.append(note('本次范围无新增提交')); section.append(details);
  }
  if (r.stage === 'draft') {
    target.releaseEdits ||= new Map();
    let edit = target.releaseEdits.get(r.id);
    if (!edit?.dirty) { edit = { body: r.body || '', revision: r.revision, body_revision: r.body_revision, dirty: false }; target.releaseEdits.set(r.id, edit); }
    const editor = textarea('release_body', edit.body, { rows: 16, spellcheck: false });
    editor.addEventListener('input', () => { edit.body = editor.value; edit.dirty = true; });
    const save = button('保存草稿正文', async () => {
      try {
        if (!live()) return; save.disabled = true;
        const saved = await api(endpoint + '/' + r.id + '/draft', 'PATCH', { body: editor.value, revision: edit.revision, body_revision: edit.body_revision });
        target.releaseEdits.delete(r.id); await refresh(); message.textContent = saved.release.stage === 'draft' ? '草稿已保存' : '已由仓库工作流／外部操作发布';
      } catch (err) { message.textContent = err.message; await refresh(); } finally { save.disabled = false; }
    });
    const edits = element('div', '', 'actions');
    edits.append(save, button('丢弃本地编辑并刷新正文', async () => { target.releaseEdits.delete(r.id); message.textContent = ''; await refresh(); }));
    section.append(field('发行说明草稿', editor), note('保存正文不会正式发布。外部或其他人的修改会返回冲突，请刷新后对照。'), edits);
    const publish = button('正式发布', async () => {
      if (edit.dirty) { message.textContent = '请先保存草稿正文，再正式发布。'; return; }
      if (!await askConfirm({ title: `正式发布 ${r.version}？`, body: [r.target_sha, r.prerelease ? '发布后仍为预发布版本。' : '发布后为稳定版本。', '将此 GitHub Release 草稿改为正式发布。'], action: '正式发布' })) return;
      try {
        if (!live()) return; publish.disabled = true;
        await api(endpoint + '/' + r.id + '/publish', 'POST', { revision: r.revision, body_revision: r.body_revision }); await refresh();
      } catch (err) { message.textContent = err.message; await refresh(); } finally { publish.disabled = false; }
    }); edits.append(publish);
  } else if (r.body) { const body = element('pre', r.body); section.append(body); }
  return section;
}

