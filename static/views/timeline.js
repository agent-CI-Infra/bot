function renderTimeline(task, logs) {
  let modelStep = 0;
  const list = $('timeline'), box = scroller(list.parentElement), first = !list.childElementCount, atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (let log of logs) {
    let value;try{value=JSON.parse(log.content);}catch{}
    // A legacy ordinal is only knowable when the beginning of the log has actually been read.
    if (value?.type === 'model') {
      modelStep++;
      if (!Number.isSafeInteger(value.step) && !taskLogState?.page?.has_older) log = { ...log, content: JSON.stringify({ ...value, step: modelStep }) };
    }
    if(renderedLogs.has(log.id))continue;
    renderedLogs.add(log.id);
    if(value?.type==='phase'&&value.phase==='prepare'||['snapshot_progress','snapshot_skipped','snapshot_git','snapshot'].includes(value?.type)){
      appendSnapshotProgress(list,log,value);continue;
    }
    if(snapshotProgress){
      if(value?.type==='prepared'||value?.type==='phase'&&value.phase!=='prepare'){
        snapshotProgress.prepared=true;setSnapshotStatus(snapshotProgress,'succeeded');
      }else if(value?.type==='fault'&&!snapshotProgress.prepared)setSnapshotStatus(snapshotProgress,value.state);
    }
    list.append(step(log));
  }
  if(snapshotProgress)setSnapshotStatus(snapshotProgress,snapshotProgress.prepared?'succeeded':task.status);
  const live = liveText(task); $('timeline-live').hidden = !live; $('timeline-live').textContent = live || '';
  // A finished task opens at its first step; a running one follows the newest step unless the reader scrolled up.
  if (first ? !!live : atBottom) box.scrollTop = box.scrollHeight;
}
function setSnapshotStatus(progress,status) {
  const waiting=status?.startsWith('waiting_')||status==='retry_wait'||['needs_replan','needs_help'].includes(status)||status==='paused';
  progress.status.replaceChildren(waiting?badge('已暂停','warning'):state(status));
}
function snapshotMessage(value) {
  if(value.type!=='snapshot')return value.detail||({snapshot_progress:`已写入 ${value.files} 个文件，${value.bytes} 字节；刚写完 ${value.path}`,
    snapshot_skipped:`已跳过路径 ${value.path}：${value.reason}`,snapshot_git:`正在构建本地 Git 树：${value.tree_sha}`}[value.type]||'正在准备仓库快照…');
  const lines=[`提交 ${value.sha} · 已接收 ${value.files} 个文件，${value.bytes} 字节 · 跳过 ${value.skipped} 项`];
  if(value.source)lines.push(value.source==='git_cache'?(value.cache==='hit'?'文件来自仓库 Git 缓存，这个提交已缓存，没有访问 GitHub。':'文件来自仓库 Git 缓存，本次从 GitHub 拉取了这个提交。')
    :value.cache==='unavailable'?'Git 缓存不可用，文件经 GitHub API 逐个读取。':'文件经 GitHub API 逐个读取。');
  if(value.directory_fallback)lines.push('递归树被截断，已改为逐目录列举。');
  if(value.detail)lines.push(value.detail);
  return lines.join('\n');
}
function appendSnapshotProgress(list,log,value) {
  // One DOM node per preparation keeps the reader's fold and scroll position across polling updates.
  if(!snapshotProgress||value.type==='phase'||value.sha&&snapshotProgress.sha&&value.sha!==snapshotProgress.sha){
    const item=element('li','','step step-snapshot'),details=element('details','','snapshot-progress'),summary=element('summary','');
    const head=element('span','','snapshot-heading'),status=element('span','','step-meta'),time=element('time',''),latest=element('span','','snapshot-latest');
    const output=element('pre','','output snapshot-output');output.tabIndex=0;output.setAttribute('aria-label','仓库快照实时日志');
    details.open=false;head.append(element('strong','仓库快照进度'),status,time);summary.append(head,latest);details.append(summary,output);item.append(details);list.append(item);
    details.addEventListener('toggle',()=>{if(details.open)output.scrollTop=output.scrollHeight;});
    snapshotProgress={details,status,time,latest,output,prepared:false};setSnapshotStatus(snapshotProgress,'running');
  }
  if(value.sha)snapshotProgress.sha=value.sha;
  const {output,latest,time}=snapshotProgress,follow=output.scrollHeight-output.scrollTop-output.clientHeight<60,message=snapshotMessage(value);
  if(log.created_at){time.textContent=timestamp(log.created_at).slice(11,19);time.dateTime=log.created_at;time.title=timestamp(log.created_at);}
  latest.textContent=value.type==='snapshot'?`已接收 ${value.files} 个文件 · ${value.bytes} 字节 · 跳过 ${value.skipped} 项`
    :value.type==='snapshot_progress'&&value.files!==undefined?`已写入 ${value.files} 个文件 · ${value.bytes} 字节`
    :value.type==='snapshot_git'?'正在构建本地 Git 树…':message.split('\n')[0];
  output.append((log.created_at?'['+time.textContent+'] ':'')+message+'\n');
  if(follow)output.scrollTop=output.scrollHeight;
}
function toolCaption(call) {
  let args = {}; try { args = JSON.parse(call.arguments); } catch { /* Long arguments are clipped in the log. */ }
  return { run_command: '执行命令：' + clipText(args.command, 80), read_file: '读取 ' + (args.path || '文件'), write_file: '写入 ' + (args.path || '文件'),
    finish_review: '提交检视结论', create_pull_request: '创建 PR' }[call.name] || call.name;
}
function step(log) {
  let value; try { value = JSON.parse(log.content); } catch { value = { type: 'raw' }; }
  const item = element('li', '', 'step step-' + value.type), head = element('div', '', 'step-head'), title = element('strong', ''), meta = element('span', '', 'step-meta');
  head.append(title, meta); item.append(head);
  if (log.created_at) { const time = element('time', timestamp(log.created_at).slice(11, 19)); time.dateTime = log.created_at; time.title = timestamp(log.created_at); meta.append(time); }
  const add = (...nodes) => item.append(...nodes), args = value.arguments || {}, result = value.result || {};
  if (value.type === 'queued') {
    title.textContent = '任务排队日志'; add(element('p', value.detail));
  } else if (value.type === 'phase') {
    title.textContent = {prepare:'工作区准备日志',model:'Agent 执行日志',validate:'仓库测试日志',publish:'GitHub 发布日志'}[value.phase] || '运行阶段日志';
    add(element('p', value.detail));
  } else if (value.type === 'tool_start') {
    title.textContent = '工具开始日志';
    const action={read_file:'读取文件',write_file:'写入文件',run_command:'执行命令',finish_review:'提交检视结论',create_pull_request:'创建 PR',github_read_token:'申请 GitHub 只读令牌'}[value.name] || value.name;
    add(element('p', `正在${action}：${value.path || value.command || value.name}`));
  } else if (value.type === 'prepared') {
    title.textContent = '准备项目工作区'; add(element('p', `固定提交 ${String(value.sha || '').slice(0, 12)}`));
    for (const line of value.coverage || []) add(element('p', line, 'muted'));
  } else if (value.type === 'model') {
    title.textContent = Number.isSafeInteger(value.step) ? `第 ${value.step} 步 · 模型公开输出` : '模型公开输出';
    if (value.content) add(element('p', value.content, 'say'));
    const calls = element('div', '', 'calls'); for (const call of value.tool_calls || []) calls.append(element('span', toolCaption(call), 'call'));
    if (calls.childElementCount) add(calls);
  } else if (value.type === 'tool' && value.name === 'run_command' || value.type === 'command') {
    const command = value.type === 'command' ? value : { command: args.command, ...result };
    title.textContent = '执行命令'; meta.prepend(exitBadge(command)); add(element('pre', '$ ' + command.command, 'command'));
    if (command.output) add(output(command.output));
  } else if (value.type === 'tool' && value.name === 'read_file') {
    title.textContent = '读取文件'; add(element('p', `${args.path} · ${result.error || (result.bytes??new TextEncoder().encode(result.content||'').length) + ' 字节'}`));
    if (result.content) add(collapsible('文件内容', result.content));
  } else if (value.type === 'tool' && value.name === 'write_file') {
    title.textContent = '写入文件'; add(element('p', `${args.path} · ${args.bytes??new TextEncoder().encode(args.content||'').length} 字节`));
  } else if (value.type==='tool' && ['finish_review','create_pull_request'].includes(value.name)) {
    title.textContent=value.name==='finish_review'?'提交检视结论':'创建 PR';
    if(args.summary)add(element('p',clipText(args.summary,240)));
    if(args.test_command)add(element('p','测试：'+args.test_command,'muted'));
    add(collapsible('原始 JSON',JSON.stringify({arguments:args,result},null,2)));
  } else if (value.type === 'published') {
    title.textContent = '发布到 GitHub'; const links = element('div', '', 'calls');
    for (const out of value.outputs || []) {
      if (out.labels) out.labels.forEach(name => links.append(element('span', '标签 ' + name, 'call')));
      else if (out.html_url) links.append(link(out.html_url, out.branch ? 'PR · ' + out.branch : out.inline_comments ? `行内检视 · ${out.inline_comments} 条` : /pull\/\d+$/.test(out.html_url) ? 'PR' : '总结评论', 'call call-link'));
    }
    add(links);
  } else if(value.type==='pr_head_wait'){
    title.textContent='等待 GitHub 更新 PR head';add(element('p','已推送 '+value.expected_sha),element('p','当前 PR '+value.observed_sha+'；自动重读，确认后继续。','muted'));
  } else if (value.type === 'completed') { title.textContent = '任务结束'; meta.prepend(state(value.status)); }
  else if (value.type === 'fault') {
    const empty = value.code === 'repository_has_no_commit' && value.state === 'waiting_configuration';
    if (empty) item.classList.replace('step-fault', 'step-waiting');
    const cause = empty ? null : log.cause;
    title.textContent = empty ? '仓库还没有提交' : cause ? '暂停或失败 · ' + cause.label : '任务暂停或失败'; meta.prepend(empty ? badge('等待首次提交', 'warning') : state(value.state));
    if (!cause) add(element('p', taskErrorText(value.code), 'muted'));
    if (value.detail) add(element('p', value.detail, 'say'));
    if (cause) add(element('p', '处理：' + cause.action, 'fault-action'), element('p', '错误码 ' + value.code, 'muted'));
  }
  else if (value.type === 'development_waiting') {
    title.textContent = '开发等待';
    add(element('p', value.reason === 'assigned' ? `Issue 已指派给 ${(value.assignees || []).join('、')}，bot 不接手；取消指派后重新加开发标签才会开发。`
      : value.reason === 'app' ? '开发标签是 App 加的，要由人加上才会开发。' : '等有人加上开发标签。', 'muted'));
  }
  else if (value.type === 'revision_requests') {
    title.textContent = '修订请求';
    const list = element('ul');
    for (const r of value.requests || []) { const li = element('li'); li.append(`${r.author_type === 'Bot' ? '其他机器人' : '成员'} ${r.author} 的`, link(r.url || '', r.type === 'review' ? '检视' : r.type === 'review_comment' ? '行内评论' : '评论')); list.append(li); }
    add(element('p', '检视采纳了这些修改请求，核对作者后据此修订 PR。', 'muted'), list);
  }
  else if (value.type === 'revision_deferred') { title.textContent = '修订顺延'; add(element('p', value.detail || '', 'muted')); }
  else if (value.type === 'restart_attempt') { title.textContent = '重新开始一次尝试'; add(element('p', '中断的工作目录保留，新的尝试使用新目录。', 'muted')); }
  else if (value.type === 'runtime_fault') { title.textContent = '运行故障'; add(element('p', value.message || '', 'muted')); if (value.where) add(collapsible('出错位置', value.where)); }
  else if (value.type === 'agent_failure') { title.textContent = '执行进程失败'; add(element('p', value.detail || '执行进程没有给出原因。', 'say')); if (value.error) add(element('p', '错误码 ' + value.error, 'muted')); }
  else { title.textContent = value.type === 'tool' ? '工具 ' + value.name : '记录'; add(element('pre', log.content, 'output')); }
  return item;
}
