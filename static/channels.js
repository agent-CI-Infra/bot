// Personal identity proof belongs with account permissions; app credentials live in global settings.
async function feishuIdentityCard() {
  const data = await api('/api/channels/bindings'), section = card('飞书身份绑定'), request = renderVersion, nameLookups = [];
  section.id = 'feishu-identity';
  section.append(note('将本人的飞书账号关联到当前平台账户。本地账户和 GitHub 登录均可使用，无需先绑定 GitHub。之后仅能访问该账户实际获准的项目，绑定本身不会增加仓库权限。'));
  // Organization and repository admins add and manage their organization's apps from here; super administrators in settings (#424).
  if (me.role === 'super_admin') section.append(channelLink('#/settings/feishu', '管理员：连接或管理飞书应用', 'button-link'));
  else if (data.can_manage_applications) section.append(channelLink('#/identity/feishu-apps', '连接或管理本组织的飞书应用', 'button-link'));
  const steps = element('ol', '', 'feishu-binding-steps');
  for (const caption of ['在下方选择机器人并点“生成绑定串”，本页会显示一条只能使用一次的消息。',
    '在飞书中打开与这个机器人的私聊，把那条消息原样发送一次。',
    '本页只在服务端确认后显示“已绑定”；复制、跳转或等待失败都不算绑定成功。']) steps.append(element('li', caption));
  if (data.applications.length) {
    section.append(steps, note('认证字符串五分钟内有效，仅可使用一次，请勿转发。'));
    const apps = element('div'); apps.setAttribute('aria-label', '可绑定的飞书应用');
    const label = a => `${a.tenant_name || '企业名称暂未获取'} · ${a.app_name || '机器人名称暂未获取'}${a.organization ? ' · 组织 ' + a.organization + ' 的应用' : ''}`;
    // The console issues the code for the chosen bot (#236): the private-chat message that carries it completes the
    // binding in one step, and this page only shows 已绑定 after it reads the binding back from the server.
    const consoleBind = async (a, slot) => {
      const box = element('div', '', 'channel-binding-console'); box.setAttribute('aria-label', '控制台发起的绑定');
      // One bot shows one string at a time: asking again replaces the previous box, and the server retires the older code.
      slot.replaceChildren(box);
      // Success means a binding this page did not have before: an existing binding is not proof that this code was used.
      const known = data.bindings.length;
      const status = element('p', '', 'muted'); status.setAttribute('role', 'status');
      box.append(status); status.textContent = '正在向服务端申请一次性绑定串…';
      try {
        const issued = await api('/api/channels/bindings/issue', 'POST', { connector_id: a.id }), command = '绑定 ' + issued.code;
        const copy = button('复制绑定串', async () => {
          try { await navigator.clipboard.writeText(command); status.textContent = '已复制。复制只影响剪贴板，绑定仍以服务端确认为准。'; }
          catch { status.textContent = '复制失败，请选中上面的文字手动复制。'; }
        }, 'quiet');
        box.replaceChildren(element('strong', '在飞书中发送这一条'), element('code', command), copy, status);
        status.textContent = '等待飞书中发送这条消息…（五分钟内有效，仅可使用一次，请勿转发）';
        const deadline = issued.expires_at;
        const poll = async () => {
          if (!box.isConnected) return;
          if (Date.now() > deadline) { status.textContent = '绑定串已过期，请重新生成。'; return; }
          try {
            const now = await api('/api/channels/bindings');
            if (now.bindings.length > known) { status.textContent = '已绑定。'; await start(); return; }
          } catch { status.textContent = '暂时无法读取服务端绑定状态，仍在等待确认。'; }
          setTimeout(poll, 2000);
        };
        void poll();
      } catch (err) { status.textContent = err.message; }
    };
    for (const a of data.applications) {
      const row = element('div', '', 'channel-binding'), link = channelLink(a.chat_url, '打开机器人私聊', 'button-link');
      const slot = element('div', '', 'channel-binding-slot'); slot.setAttribute('aria-live', 'polite');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      row.append(element('strong', label(a)), link, button('生成绑定串', () => consoleBind(a, slot), 'quiet'), slot,
        note('若飞书未打开，请在飞书客户端搜索上方机器人名称；找不到时，请联系应用管理员检查应用可用范围。'),
        ...(a.organization ? [note(`这是组织 ${a.organization} 的应用：经它绑定的飞书身份只能使用你在该组织内的权限。`)] : []));
      apps.append(row);
    }
    const form = element('form', '', 'project-form'), app = channelSelect(form, '要绑定的飞书机器人', 'binding_connector', data.applications.map(a => [a.id, label(a)]));
    const code = channelField(form, '飞书认证字符串', 'binding_code'); code.required = true; code.autocomplete = 'off'; code.spellcheck = false;
    code.placeholder = '粘贴机器人私聊返回的 FSB- 开头字符串'; code.maxLength = 100;
    const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
    const submit = element('button', '确认绑定到当前账户'); submit.type = 'submit';
    form.append(note(`将绑定到当前平台账户：${me.username}。请仅使用本人私聊收到的认证字符串。`), status, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return;
      submit.disabled = true; status.textContent = '';
      try {
        await api('/api/channels/bindings/confirm', 'POST', { code: code.value.trim(), connector_id: app.value });
        history.replaceState(null, '', '#/identity/feishu'); await start();
      } catch (err) {
        const reasons = { binding_code_invalid: '认证字符串无效，或不属于所选机器人。请核对后重试。', binding_expired: '认证字符串已过期，请在机器人私聊重新发送 /bind。',
          binding_replayed: '认证字符串已使用，请刷新状态；需要重新认证时发送 /reauth。', binding_login_already_started: '此请求已进入链接绑定流程，请回原私聊确认，或重新发送 /bind 获取认证字符串。',
          external_identity_conflict: '这个飞书身份已属于其他平台账户，请登录原账户处理。',
          channel_application_forbidden: '你在这个机器人所属的组织没有授权，不能通过它绑定。' };
        status.textContent = Object.entries(reasons).find(([key]) => err.message.includes(key))?.[1] || err.message;
        submit.disabled = false;
      }
    });
    section.append(apps, form);
  } else section.append(note('暂无你可以使用的飞书应用。请联系超级管理员或本组织的管理员配置。'));
  const challenge = /^#\/identity\/feishu\?challenge=([a-f0-9]{48})$/.exec(location.hash)?.[1];
  if (challenge) {
    const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
    const claim = button('绑定到当前平台账户', async () => {
      claim.disabled = true; status.textContent = '';
      try {
        await api('/api/channels/bindings/claim', 'POST', { challenge });
        history.replaceState(null, '', '#/identity/feishu'); await start();
      } catch (err) {
        const reason = { binding_expired: '绑定链接已过期，请在原飞书私聊重新发送 /bind。',
          binding_replayed: '此绑定请求已处理，请刷新状态或在原私聊重新发送 /bind。',
          binding_login_already_started: '此请求已关联平台账户，请完成原私聊确认；需要更换账户时重新发送 /bind。',
          channel_application_forbidden: '你在这个机器人所属的组织没有授权，不能通过它绑定。' };
        status.textContent = Object.entries(reason).find(([code]) => err.message.includes(code))?.[1] || err.message;
        claim.disabled = false;
      }
    }, '');
    section.append(note(`将绑定到当前平台账户：${me.username}。如需使用其他账户，请先退出登录并重新打开绑定链接。`), claim, status);
  }
  for (const p of data.pending) {
    const pending = element('div', '', 'channel-binding'); pending.setAttribute('aria-label', '待确认的飞书身份');
    pending.append(element('strong', '等待原飞书操作者确认'), facts([['平台账户', p.account.username],
      ['飞书账号', '发起本次绑定的飞书账号'], ['机器人', p.app_name || '机器人名称暂未获取'],
      ['机器人所属企业', p.tenant_name || '企业名称暂未获取'], ['有效期', new Date(p.expires_at).toLocaleString()]]),
      channelCopy('在原私聊发送的确认指令', '确认绑定 ' + p.confirmation));
    section.append(pending);
  }
  if (!data.bindings.length && !data.pending.length) section.append(element('p', '尚未绑定飞书身份', 'muted'));
  for (const b of data.bindings) {
    const row = element('div', '', 'channel-binding'), active = b.status === 'active';
    const name = () => { const value = typeof b.display_name === 'string' ? b.display_name.trim() : ''; return value && value !== b.external_actor ? value : ''; };
    const state = active ? '已绑定' : b.status === 'revoked' ? '已解绑' : '需要重新认证';
    const title = element('strong'), renderName = () => { title.textContent = `${name() || me.username + ' 的飞书账号'} · ${state}`; };
    renderName();
    row.setAttribute('aria-label', '我的飞书账号');
    row.append(title, note(`机器人：${b.app_name || '机器人名称暂未获取'}；所属企业：${b.tenant_name || '企业名称暂未获取'}`),
      note(`关联平台账户：${me.username}`));
    const nameStatus = note(name() ? '' : '飞书姓名暂不可读取，当前显示关联的平台账户。'); nameStatus.setAttribute('role', 'status');
    row.append(nameStatus);
    if (b.connection_enabled === 0) row.append(note('此机器人连接已停用。'));
    else if (b.connection_enabled === null) row.append(note('原机器人连接已不可用。'));
    if (b.can_read_name) {
      const refreshName = async () => {
        if (refresh.disabled) return;
        refresh.disabled = true; nameStatus.textContent = '正在读取飞书姓名…';
        try {
          const result = await api('/api/channels/bindings/' + encodeURIComponent(b.id) + '/name', 'POST', {});
          if (request !== renderVersion) return;
          b.display_name = result.display_name; renderName(); nameStatus.textContent = '飞书姓名已更新。';
        } catch (err) {
          if (request !== renderVersion) return;
          const changed = ['authorization_changed', 'external_binding_required', 'identity_not_found', 'channel_connector_inactive', 'channel_configuration_changed', 'login_required'].some(code => err.message.includes(code));
          nameStatus.textContent = changed ? '绑定或机器人连接状态已变化，请刷新飞书绑定状态。' : name() ? '暂时无法更新飞书姓名，保留上次读取的姓名。' : '飞书暂未提供姓名，当前显示关联的平台账户。';
        } finally { refresh.disabled = false; }
      };
      const refresh = button('刷新飞书姓名', refreshName, 'quiet'); row.append(refresh);
      if (!name()) nameLookups.push(refreshName);
    }
    if (active) row.append(button('解除飞书绑定', async () => {
      if (!confirm('解除绑定后，这个飞书身份不能继续管理项目。继续？')) return;
      try { await api('/api/identity/bindings/' + b.id, 'DELETE', {}); await start(); } catch (err) { error(err); }
    }, 'quiet'));
    else row.append(note('需要恢复时，在原飞书私聊发送 /reauth，重新完成双端验证。'));
    section.append(row);
  }
  section.append(button('刷新飞书绑定状态', () => start().catch(error), 'quiet'), note('绑定后可直接说“你好”“我能管理哪些项目”或“看看 bot 项目的任务”；需要明确目标时，助手会按名称追问。群聊由维护人在下方「飞书群聊助手」绑定后，群成员无需逐人绑定。'));
  // Names are presentation metadata: render immediately, then fill missing names without blocking the identity page.
  void (async () => { for (const lookup of nameLookups) { if (request !== renderVersion) break; await lookup(); } })();
  section.append(await channelServiceBindingSettings(), await channelPersonalChats());
  return section;
}
const employeeErrors = { channel_employee_revalidation_required: '群成员正在重新核验，受保护动作暂时暂停。', channel_employee_member_required: '你或来源成员当前不在这个群中。',
  external_binding_required: '需要先完成本人的飞书身份绑定。', capability_forbidden: '你在所选仓库或组织没有配置权限（config.write）。', channel_employee_source_inactive: '应用已停用、机器人已移出或群已归档。',
  channel_employee_project_inactive: '项目已停用。', channel_employee_disabled: '旧群员工授权已停用。',
  channel_employee_sync_paused: '群授权或受众待核验，历史同步已暂停。', channel_bot_not_in_chat: '机器人当前不在这个群中。',
  channel_audience_unverified: '平台未提供完整成员范围，暂时无法核验。', channel_history_forbidden: '需要该群助手的负责人，或在其全部项目范围内有配置权限。',
  channel_audience_permission_required: '飞书应用还没有读取群成员的权限，无法核验你是否在群中。请超级管理员在「全局设置 → 飞书连接」查看缺少的权限，为应用开通 im:chat.members:read 并发布新版本后再保存。',
  channel_revision_conflict: '这个群的配置已被其他人修改，请刷新本页后重新保存。', service_role_unavailable: '所选服务角色已停用。', service_role_not_bindable: '管理助手不能绑定到群聊。',
  channel_service_scope_paused: '配置人在全部所选仓库的权限都已变化，助手暂停。', channel_service_binding_disabled: '群聊助手已停用。',
  schedule_destination_binding_required: '这个群没有启用的群聊助手绑定。',
  channel_service_binding_forbidden: '只有这个群聊助手的负责人、其项目范围所属组织的管理员或超级管理员可以修改、停用或转交。', channel_service_scope_invalid: '请至少选择一个仓库，或选择一个组织。',
  channel_service_scope_outside_organization: '这个群使用的是组织的飞书应用，只能选择该组织的仓库或整个组织。',
  channel_service_owner_ineligible: '新负责人需要对当前全部项目范围有配置权限，且账户处于启用状态。',
  service_role_model_not_configured: '服务角色尚未配置模型，请超级管理员在「全局设置 → 服务角色」中选择。' };
const employeeError = value => Object.entries(employeeErrors).find(([key]) => String(value).includes(key))?.[1] || String(value);
// Prompt-driven timers of one chat (#330): the chat's own assistant runs the prompt with the chat's permissions and posts the
// result here. A private chat uses its owner's management assistant; a group uses its bound service role.
const scheduleStates = { active: '生效中', paused: '已暂停' };
const scheduleRunStates = { running: '运行中', completed: '已发送结果', silent: '无需通知，未发送', failed: '未完成', skipped: '已跳过' };
const scheduleErrors = { channel_schedule_forbidden: '只有私聊的本人，或能管理该群聊助手的人可以管理这里的定时任务。',
  channel_schedule_recurrence_required: '请填写 Cron 表达式或间隔分钟数，二选一。', channel_schedule_interval_invalid: '间隔须为 5 分钟到 31 天之间的整数分钟。',
  invalid_schedule_cron: 'Cron 表达式应为五段：分 时 日 月 周，例如 0 9 * * 1-5。', invalid_schedule_timezone: '时区无效，请使用 IANA 时区名，例如 Asia/Shanghai。',
  channel_schedule_revision_conflict: '定时任务已被其他操作修改，请刷新本页后重试。', channel_schedule_running: '这个定时任务正在运行，请稍后再试。',
  channel_schedule_missed: '服务未运行时错过了触发时间', channel_schedule_previous_run_active: '上一次运行尚未结束', channel_schedule_interrupted: '服务重启时中断',
  channel_schedule_changed: '定时任务在运行中被修改或删除', external_binding_required: '本人的飞书身份绑定已失效', principal_inactive: '账户已停用',
  user_paused: '已手动暂停', invalid_field: '名称、提示词和时区都需要填写。' };
const scheduleError = value => scheduleErrors[String(value)] || employeeError(value);
const scheduleTime = (at, zone) => new Date(at).toLocaleString('zh-CN', { timeZone: zone });
async function channelSchedules(chatId) {
  const box = element('div', '', 'channel-schedules'); box.setAttribute('aria-label', '定时任务');
  box.append(element('strong', '定时任务'), note('到点后用这里的提示词唤醒本会话的助手，在本会话的权限内查询、汇总或处理，再把结果发回本会话；超出权限的项目和操作会被拒绝。私聊用管理助手和你本人的当前权限，群聊用本群绑定的服务角色和项目范围。模型用量记在对应的服务角色上。'));
  let data;
  try { data = await api('/api/channels/chats/' + chatId + '/schedules'); } catch (err) { box.append(note(scheduleError(err.message))); return box; }
  const list = element('div');
  let fill = () => {};
  for (const s of data.schedules) {
    const row = element('article', '', 'channel-binding'); row.setAttribute('aria-label', '定时任务 ' + s.name);
    const rhythm = s.cron ? 'Cron ' + s.cron : '每 ' + s.interval_minutes + ' 分钟';
    row.append(element('strong', `${scheduleStates[s.state] || s.state} · ${s.name}`), note(`${rhythm}（${s.timezone}）${s.reason ? '；暂停原因：' + scheduleError(s.reason) : ''}`),
      element('p', '提示词：' + s.prompt), note(s.future.length ? '接下来：' + s.future.map(at => scheduleTime(at, s.timezone)).join('、') : '暂停中，不会自动触发。'));
    const latest = s.runs[0];
    if (latest) row.append(note(`最近一次（${latest.trigger === 'manual' ? '手动' : '定时'}，${scheduleTime(latest.created_at, s.timezone)}）：${scheduleRunStates[latest.state] || latest.state}${latest.error ? '，原因：' + scheduleError(latest.error) : ''}`));
    const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
    // A step returning false (a cancelled confirmation) leaves the page as it is.
    const act = (caption, work) => button(caption, async () => { status.textContent = ''; try { if (await work() !== false) await start(); } catch (err) { status.textContent = scheduleError(err.message); } }, 'quiet');
    const actions = element('div', '', 'actions'); row.append(actions);
    if (s.can_manage) actions.append(act('立即运行一次', () => api('/api/channels/schedules/' + s.id + '/run', 'POST', {})),
      act(s.state === 'active' ? '暂停' : '恢复', () => api('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: s.revision, enabled: s.state !== 'active' })),
      button('编辑', () => fill(s), 'quiet'), act('删除', async () => { if (!confirm('删除定时任务「' + s.name + '」？')) return false; await api('/api/channels/schedules/' + s.id, 'DELETE', { expected_revision: s.revision }); }));
    else if (s.state === 'active') actions.append(act('停用（管理员）', () => api('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: s.revision, enabled: false })));
    row.append(status); list.append(row);
  }
  if (!data.schedules.length) list.append(note('还没有定时任务。'));
  box.append(list);
  if (data.can_manage) {
    const form = element('form', '', 'project-form'), title = element('strong', '新建定时任务');
    const name = channelField(form, '定时任务名称', 'schedule_name_' + chatId);
    const prompt = document.createElement('textarea'); prompt.name = 'schedule_prompt_' + chatId; prompt.rows = 4; prompt.maxLength = 8000;
    prompt.placeholder = '例如：汇总我可读的所有项目中过去 24 小时失败的任务和 CI，按项目分条列出；如果都没有异常，简短告知一切正常。';
    form.append(field('任务提示词', prompt));
    const zone = channelField(form, '时区', 'schedule_zone_' + chatId, 'Asia/Shanghai');
    const kind = channelSelect(form, '触发方式', 'schedule_kind_' + chatId, [['cron', 'Cron 表达式'], ['interval', '固定间隔']]);
    const cron = channelField(form, 'Cron 表达式（分 时 日 月 周）', 'schedule_cron_' + chatId, '0 9 * * *');
    const minutes = channelField(form, '间隔分钟数', 'schedule_minutes_' + chatId, '60', 'number'); minutes.min = '5';
    const enabled = checkbox('schedule_enabled_' + chatId, true, '保存后立即生效'); form.append(enabled);
    const preview = note(''), status = element('p', '', 'view-error'); status.setAttribute('role', 'alert'); preview.setAttribute('role', 'status');
    const save = element('button', '保存定时任务'); save.type = 'submit';
    let editing = null;
    const spec = () => ({ name: name.value.trim(), prompt: prompt.value.trim(), timezone: zone.value.trim(), ...(kind.value === 'cron' ? { cron: cron.value.trim() } : { interval_minutes: Number(minutes.value) }) });
    const showKind = () => { cron.closest('label').hidden = kind.value !== 'cron'; minutes.closest('label').hidden = kind.value === 'cron'; };
    kind.addEventListener('change', showKind); showKind();
    fill = s => { editing = s; title.textContent = '编辑定时任务「' + s.name + '」'; name.value = s.name; prompt.value = s.prompt; zone.value = s.timezone;
      kind.value = s.cron ? 'cron' : 'interval'; cron.value = s.cron || '0 9 * * *'; minutes.value = String(s.interval_minutes || 60); enabled.querySelector('input').checked = s.state === 'active'; showKind(); name.focus(); };
    form.append(button('预览触发时间', async () => {
      preview.textContent = '';
      try { const result = await api('/api/channels/schedules/preview', 'POST', { timezone: spec().timezone, ...(kind.value === 'cron' ? { cron: spec().cron } : { interval_minutes: spec().interval_minutes }) });
        preview.textContent = '接下来：' + result.future.map(at => scheduleTime(at, spec().timezone)).join('、'); }
      catch (err) { preview.textContent = scheduleError(err.message); }
    }, 'quiet'), preview, status, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; status.textContent = '';
      try {
        const body = { ...spec(), enabled: enabled.querySelector('input').checked };
        if (editing) await api('/api/channels/schedules/' + editing.id, 'PATCH', { ...body, expected_revision: editing.revision });
        else await api('/api/channels/chats/' + chatId + '/schedules', 'POST', body);
        await start();
      } catch (err) { status.textContent = scheduleError(err.message); save.disabled = false; }
    });
    box.append(title, form);
  }
  return box;
}
const participationOptions = [['mentions', '仅回应 @'], ['questions', '回应 @ 及以问号结尾的文字'], ['all', '读取每条新文字后判断是否发言']];
const bindingStates = { active: '生效中', paused: '已暂停', disabled: '已停用' };
// A group binds one service role and one project scope; members use it without binding themselves.
async function channelServiceBindingSettings() {
  const data = await api('/api/channels/service-bindings'), box = card('飞书群聊助手'), form = element('form', '', 'project-form');
  box.append(note('为机器人所在的群选择一个服务角色和项目范围（整个组织或多个仓库）。群成员无需绑定或授权，按这里的配置使用助手，也不需要先选项目。第一个配置的人成为负责人，需要已绑定飞书、在该群中，并对所选仓库（或整个组织）有配置权限；配置人失去某个仓库的权限时，只暂停该仓库。'),
    note('之后只有负责人、项目范围所属组织的管理员和超级管理员可以修改或停用，组织管理员和超级管理员不在群里也可以修改，并可以把负责人转交给对全部范围有配置权限的人。使用组织飞书应用的群只能选择该组织的仓库。'));
  // Each chat's app decides which organization its scope may use (null: any).
  const chatOrganization = new Map([...data.chats.map(c => [c.id, c.organization || null]), ...data.bindings.map(b => [b.chat_id, b.chat.organization || null])]);
  const chats = new Map([...data.chats.map(c => [c.id, `${c.app_name || c.app_id || '已配置群'} · ${c.chat_id}`]), ...data.bindings.filter(b => !data.chats.some(c => c.id === b.chat_id)).map(b => [b.chat_id, `${b.chat.app_name || '已配置群'} · ${b.chat.chat_id}`])]);
  const chat = channelSelect(form, '助手所在群', 'binding_chat', [...chats]);
  const role = channelSelect(form, '服务角色', 'binding_role', data.service_roles.map(r => [r.id, r.name + (r.recommended ? '（推荐）' : '')]));
  const roleNote = note(''); form.append(roleNote);
  const scope = element('fieldset', '', 'role-choices'); scope.append(element('legend', '项目范围'));
  const kind = name => { const control = document.createElement('input'); control.type = 'radio'; control.name = 'binding_scope'; control.value = name; return control; };
  const repositoriesKind = kind('repositories'), organizationKind = kind('organization');
  const repositoriesLabel = element('label', '', 'check'), organizationLabel = element('label', '', 'check');
  repositoriesLabel.append(repositoriesKind, ' 选择仓库'); organizationLabel.append(organizationKind, ' 整个组织');
  const repositories = element('div', '', 'role-choices'); repositories.setAttribute('aria-label', '可选择的仓库');
  const boxes = new Map(data.projects.map(p => { const wrap = checkbox('binding_repository:' + p.id, false, p.full_name); repositories.append(wrap); return [p.id, wrap.querySelector('input')]; }));
  const projectOrganization = new Map(data.projects.map(p => [p.id, p.organization]));
  const organization = document.createElement('select'); organization.setAttribute('aria-label', '组织');
  for (const o of data.organizations) organization.add(new Option(o.name, o.id));
  organizationKind.disabled = !data.organizations.length;
  scope.append(repositoriesLabel, repositories, organizationLabel, field('组织', organization), ...(data.organizations.length ? [] : [note('你没有组织级配置权限，只能选择仓库。')]));
  form.append(scope);
  const participation = channelSelect(form, '助手发言范围', 'binding_participation', participationOptions);
  form.append(note('注意：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。所有获准消息都会存入本地；扩大发言范围会增加模型用量，用量记在服务角色上，不计入项目。'));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const ownership = note(''); ownership.setAttribute('role', 'status');
  const save = element('button', '保存群聊助手'); save.type = 'submit';
  form.append(ownership, status, save);
  let expected = 0;
  const unavailable = !chats.size || !data.service_roles.length || !data.projects.length && !data.organizations.length;
  const describeRole = () => {
    const r = data.service_roles.find(item => item.id === role.value);
    const labels = { none: '禁止', read: '只读', write: '读写', allow: '允许', deny: '拒绝' };
    roleNote.textContent = r ? `${r.responsibility || '自定义服务角色'} 权限：${data.permission_items.map(item => item.name + ' ' + (labels[r.permissions[item.id]] || '禁止')).join('；')}。` : '';
  };
  const showScope = () => { repositories.hidden = !repositoriesKind.checked; organization.closest('label').hidden = !organizationKind.checked; };
  const fill = () => {
    const current = data.bindings.find(b => b.chat_id === chat.value), organizationOnly = chatOrganization.get(chat.value) || null;
    expected = current?.revision || 0;
    // An organization app's group offers only that organization's repositories and the organization itself.
    for (const [id, input] of boxes) { const hidden = !!organizationOnly && projectOrganization.get(id) !== organizationOnly; input.closest('label').hidden = hidden; if (hidden) input.checked = false; }
    for (const option of organization.options) option.disabled = !!organizationOnly && option.value !== organizationOnly;
    if (organizationOnly && [...organization.options].some(o => o.value === organizationOnly)) organization.value = organizationOnly;
    organizationKind.disabled = !data.organizations.some(o => !organizationOnly || o.id === organizationOnly);
    const locked = !!current && !current.can_manage;
    ownership.textContent = locked ? `这个群的助手由 ${current.owner || '原负责人'} 负责；只有负责人、所属组织的管理员和超级管理员可以修改。` : current?.owner ? '负责人：' + current.owner : '';
    save.disabled = unavailable || locked;
    role.value = current?.enabled && data.service_roles.some(r => r.id === current.service_role.id) ? current.service_role.id : (data.service_roles.find(r => r.recommended) || data.service_roles[0])?.id || '';
    participation.value = current?.participation || 'mentions';
    const org = current?.enabled && current.scope.organization;
    organizationKind.checked = !!org && !organizationKind.disabled; repositoriesKind.checked = !organizationKind.checked;
    if (org) organization.value = org.id;
    for (const [id, input] of boxes) input.checked = !!current?.enabled && current.scope.repositories.some(r => r.id === id);
    describeRole(); showScope();
  };
  for (const control of [repositoriesKind, organizationKind]) control.addEventListener('change', showScope);
  role.addEventListener('change', describeRole); chat.addEventListener('change', fill);
  save.disabled = unavailable;
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '正在核验你的飞书绑定、群成员身份和所选范围的配置权限…';
    const selected = organizationKind.checked ? { kind: 'organization', organization: organization.value } : { kind: 'repositories', repositories: [...boxes].filter(([, input]) => input.checked).map(([id]) => id) };
    try {
      await api('/api/channels/chats/' + chat.value + '/service-binding', 'PUT', { service_role_id: role.value, scope: selected, participation: participation.value, enabled: true, expected_revision: expected });
      await start();
    } catch (err) { status.textContent = employeeError(err.message); save.disabled = false; }
  });
  if (!chats.size) box.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length && !data.organizations.length) box.append(note('当前没有可配置的仓库。个人绑定不会增加项目权限。'));
  if (!data.service_roles.length) box.append(note('当前没有可用于群聊的服务角色，请联系超级管理员。'));
  box.append(form); if (chats.size) fill();
  for (const b of data.bindings) {
    const row = element('article', '', 'channel-binding'), scopeText = b.scope.organization ? '整个组织 ' + b.scope.organization.name : b.scope.repositories.map(r => r.full_name).join('、');
    row.setAttribute('aria-label', '群聊助手绑定');
    row.append(element('strong', `${bindingStates[b.state] || b.state} · ${b.service_role.name || '服务角色已删除'}`), note(`群：${b.chat.app_name ? b.chat.app_name + ' · ' : ''}${b.chat.chat_id}`),
      note('项目范围：' + scopeText), note('发言范围：' + (participationOptions.find(([id]) => id === b.participation)?.[1] || b.participation)),
      note(`负责人：${b.owner || '账户已删除'}${b.configured_by && b.configured_by !== b.owner ? '；最近修改：' + b.configured_by : ''}`),
      ...(b.paused.length ? [note('暂停的仓库（配置人权限已变化）：' + b.paused.join('、'))] : []), ...(b.migrated ? [note('由旧群员工自动迁移为仓库问答助手。')] : []),
      ...(b.error ? [note(employeeError(b.error))] : []));
    const history = element('div');
    row.append(button('查看连续会话', () => channelConversation(b.chat_id, history).catch(err => error(err)), 'quiet'), button('查询该群本地记录', () => channelEmployeeHistory(b, history).catch(err => error(err)), 'quiet'));
    if (b.enabled && b.can_manage) row.append(button('停用群聊助手', async () => {
      try { await api('/api/channels/chats/' + b.chat_id + '/service-binding', 'PUT', { enabled: false, expected_revision: b.revision }); await start(); }
      catch (err) { error(err); }
    }, 'quiet'));
    if (b.can_transfer) row.append(channelOwnerTransfer(b));
    if (b.enabled && b.can_manage) row.append(await channelSchedules(b.chat_id));
    row.append(history); box.append(row);
  }
  const legacy = data.legacy_employees.filter(g => g.enabled);
  if (legacy.length) {
    const old = element('div'); old.append(element('h4', '旧群员工'), note('旧群员工已不再接收群消息，只用于继续核验升级前已创建的任务。确认这些任务不再需要后可以停用。'));
    for (const g of legacy) {
      const row = element('article', '', 'channel-binding');
      row.append(element('strong', `仍有效 · ${g.full_name} · ${g.role_id}`), note(`未结束的任务：${g.open_tasks} 个`), button('停用旧群员工授权', async () => {
        try { await api('/api/channels/chats/' + g.chat_id + '/employee', 'PUT', { project_id: g.project_id, enabled: false, expected_revision: g.revision }); await start(); }
        catch (err) { error(err); }
      }, 'quiet'));
      old.append(row);
    }
    box.append(old);
  }
  return box;
}
// Organization and platform administrators hand a group binding to someone who can configure its whole scope (#424).
function channelOwnerTransfer(binding) {
  const box = element('form', '', 'project-form'), status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  if (!binding.owner_candidates.length) { box.append(note('转交负责人：暂无其他对全部项目范围有配置权限的账户。')); return box; }
  const owner = channelSelect(box, '转交负责人给', 'binding_owner_' + binding.chat_id, binding.owner_candidates.map(c => [c.id, c.username]));
  const submit = element('button', '转交负责人', 'quiet'); submit.type = 'submit'; box.append(status, submit);
  box.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; status.textContent = '';
    const name = owner.selectedOptions[0]?.textContent || '';
    if (!confirm(`把这个群聊助手的负责人转交给 ${name}？转交后原负责人不能再修改它。`)) { submit.disabled = false; return; }
    try { await api('/api/channels/chats/' + binding.chat_id + '/service-binding/owner', 'PUT', { owner_id: owner.value, expected_revision: binding.revision }); await start(); }
    catch (err) { status.textContent = employeeError(err.message); submit.disabled = false; }
  });
  return box;
}
async function channelPersonalChats() {
  const data = await api('/api/channels/employees'), personal = card('我的飞书私信会话');
  personal.append(note('私信与控制台管理对话共用管理助手、当前授权与执行回执。可按项目或任务名称提问并继续选择，无需先选项目。同一私信跨项目和话题延续上下文，个人记录不进入群聊。'));
  if (!data.personal_chats.length) personal.append(note('绑定后先在飞书私聊发一条普通消息，再刷新此页。'));
  for (const chat of data.personal_chats) {
    const row = element('article', '', 'channel-binding'), target = element('div');
    row.append(element('strong', '私信 ' + chat.chat_id), button('查看私信连续会话', () => channelConversation(chat.id, target).catch(error), 'quiet'),
      button('查询私信本地记录', () => channelEmployeeHistory({ chat_id: chat.id }, target).catch(error), 'quiet'));
    row.append(await channelSchedules(chat.id), target); personal.append(row);
  }
  return personal;
}
async function channelConversation(id, target) {
  target.replaceChildren(); const summary = element('div'), turns = element('div'), status = note(''), controls = element('div', '', 'actions');
  turns.setAttribute('aria-label', '连续会话记录'); status.setAttribute('role', 'status'); let offset = 0;
  const next = button('下一页会话记录', () => read(true), 'quiet'); next.hidden = true;
  const read = async more => {
    try {
      if (!more) { offset = 0; turns.replaceChildren(); }
      const result = await api('/api/channels/chats/' + id + '/conversation?offset=' + offset); offset = result.next_offset;
      const scopeText = result.binding ? (result.binding.scope.organization ? '整个组织 ' + result.binding.scope.organization.name : result.binding.scope.repositories.map(r => r.full_name).join('、')) : '';
      summary.replaceChildren(facts([['会话', result.mode === 'management' ? '个人飞书管理会话' : result.mode === 'service' ? '群聊助手会话（' + (result.binding.service_role.name || '服务角色已删除') + '）' : result.conversation_id],
        ['管理范围', result.mode === 'management' ? '全部有权项目（按请求确定目标）' : result.mode === 'service' ? scopeText : result.current_project || '尚未选择'], ['模型请求记录', String(result.usage.requests || 0)], ['用量未完整核验', String(result.usage.usage_missing_requests || 0)],
        ['后端未报告实际请求次数的回合', String(result.usage.provider_request_count_unknown || 0)],
        ['已记录费用', result.usage.costs.map(c => c.currency + ' ' + c.amount).join('、') || '尚无已定价费用'], ['未知费用请求', String(result.usage.unpriced_requests || 0)]]));
      status.textContent = '本地同步：' + channelSyncText(result.sync_state) + '。未核验／缺口：' + result.gaps.map(g => channelGapText(g.reason)).join('、') + '。费用只汇总同一模型请求账本，未知金额不按零处理。';
      for (const turn of result.turns) {
        const row = element('article', '', 'channel-binding');
        if (result.mode === 'management') row.append(element('strong', '管理助手 · ' + turn.state), note(new Date(turn.created_at).toLocaleString()),
          ...(turn.request ? [element('p', '我：' + turn.request)] : []), element('p', turn.reply || '等待处理'), channelLink('#/management', '打开管理对话与执行记录'));
        else if (result.mode === 'service') row.append(element('strong', turn.role_id + ' · ' + turn.state), note(new Date(turn.created_at).toLocaleString()),
          element('p', turn.reply || (turn.stale_source ? '来源或授权范围已变化，旧回答不再展示。' : turn.state === 'completed' ? '本轮保持安静。' : '本轮未完成：' + employeeError(turn.error || turn.state))));
        else row.append(element('strong', turn.role_id + ' · 项目 ' + turn.project_id), note(new Date(turn.created_at).toLocaleString() + ' · 来源 ' + turn.source_message),
          element('p', turn.reply || (turn.stale_source ? '来源或授权范围已变化，旧派生回答不再展示。' : turn.state === 'completed' ? '本轮保持安静。' : '本轮未完成：' + (turn.error || turn.state))),
          channelLink('#/projects/' + turn.project_id + '/overview/all', '查看同一项目任务看板')); turns.append(row);
      }
      if (!result.turns.length && !more) turns.append(note('当前授权范围暂无会话回合。原始本地消息可通过记录搜索查询。'));
      next.hidden = !result.has_more;
    } catch (err) { status.textContent = employeeError(err.message); }
  };
  controls.append(button('刷新连续会话', () => read(false), 'quiet'), next); target.append(summary, status, turns, controls); await read(false);
}
async function channelEmployeeHistory(grant, target) {
  target.replaceChildren(); const form = element('form', '', 'project-form'), keyword = channelField(form, '查询关键词', 'employee_keyword'),
    sender = channelField(form, '查询发送者 ID', 'employee_sender'), status = element('p', '', 'muted'), messages = element('div');
  status.setAttribute('role', 'status'); let cursor;
  const next = button('下一页本地记录', () => read(true), 'quiet'); next.hidden = true;
  const read = async more => {
    if (!more) { cursor = undefined; messages.replaceChildren(); }
    const query = new URLSearchParams({ limit: '50' });
    if (keyword.value) query.set('keyword', keyword.value); if (sender.value) query.set('sender_id', sender.value); if (cursor) query.set('cursor', cursor);
    try {
      const result = await api(`/api/channels/chats/${grant.chat_id}/messages?${query}`); cursor = result.next_cursor;
      status.textContent = `本地同步状态：${channelSyncText(result.sync_state)}。未核验／缺口：${result.gaps.map(g => channelGapText(g.reason)).join('、')}。`;
      if (!result.messages.length && !more) messages.append(note('本地已同步范围没有匹配记录；这不代表飞书历史中从未存在。'));
      for (const m of result.messages) messages.append(facts([['发送者', m.sender_id || '未知'], ['时间', new Date(m.created_at).toLocaleString()], ['消息', m.message_id], ['内容', m.content]]));
      next.hidden = !result.has_more;
    } catch (err) { status.textContent = employeeError(err.message); }
  };
  const submit = element('button', '搜索本地记录'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', event => { event.preventDefault(); void read(false); }); target.append(form, status, messages, next); await read(false);
}
const channelSyncText = state => ({ active: '运行中', syncing: '正在同步', visible_range_complete: '可见范围已完成本次同步', blocked: '同步受阻', paused: '暂停', removed: '机器人已移出', archived: '群已归档' })[state] || state;
const channelGapText = reason => ({ platform_visibility_not_verified: '平台可见范围仍受权限约束', message_edit_event_unavailable: '编辑变更须在后续同步中核验', thread_time_boundary_unsupported: '话题分页不支持时间边界', retention: '部分内容已按保留策略清理', sync_pending: '尚有分页未完成', channel_history_inaccessible: '平台暂不可访问', channel_history_cursor_stalled: '分页游标未推进' })[reason] || employeeError(reason);
function channelCopy(caption, value) {
  const box = element('div', '', 'channel-copy'), text = document.createElement('textarea'), label = element('label', caption), status = element('p', '', 'muted');
  text.value = value; text.readOnly = true; text.rows = Math.min(8, value.split('\n').length); text.setAttribute('aria-label', caption); label.append(text); status.setAttribute('role', 'status');
  box.append(label, button('复制' + caption, async () => {
    try { await navigator.clipboard.writeText(value); status.textContent = '已复制'; }
    catch { text.focus(); text.select(); status.textContent = '已选中文本，请手动复制。'; }
  }, 'quiet'), status); return box;
}
function channelField(form, caption, name, value = '', type = 'text') {
  const control = document.createElement('input'); control.name = name; control.type = type; control.value = value; control.autocomplete = 'off';
  form.append(field(caption, control)); return control;
}
function channelSelect(form, caption, name, values, value) {
  const control = document.createElement('select'); control.name = name; control.setAttribute('aria-label', caption);
  for (const [id, title] of values) control.add(new Option(title, id));
  if (value !== undefined) control.value = value;
  form.append(field(caption, control)); return control;
}
async function channelDiagnostics(c, panel, history = true) {
  const [{ operations }, { deliveries }] = await Promise.all([api('/api/channels/connectors/' + c.id + '/events'), api('/api/channels/connectors/' + c.id + '/outbox')]);
  const view = card('连接健康与收发记录');
  view.append(facts([['连接状态', c.enabled ? '启用' : '停用'], ['传输状态', c.transport === 'http' ? 'HTTP 事件回调' : c.health.connection_state],
    ['最后收到事件', c.health.last_received_at ? new Date(c.health.last_received_at).toLocaleString() : '尚未收到'], ['诊断', c.health.last_error || '无'], ['待处理', c.health.queued], ['发送失败', c.health.failed]]),
    note('应用鉴权成功或长连接已连接，都不能证明消息已经送达。请完成发布并在飞书中实测。群聊的项目范围在「身份与权限 → 飞书群聊助手」为每个群单独设置。'));
  for (const op of operations.slice(0, 10)) view.append(note(`渠道操作 ${op.operation_id} · ${op.state}${op.error ? ' · ' + op.error : ''}${op.conversation_id ? ' · 会话 ' + op.conversation_id : ''}`));
  if (operations.some(op => op.reaction_error === 'channel_reaction_permission_required'))
    view.append(note('处理中表情暂不可用：请在飞书开通应用身份权限 im:message.reactions:write_only，并发布新版本。普通消息回复不受影响。'));
  else if (operations.some(op => op.reaction_error)) view.append(note('部分处理中表情添加或清理未成功，可在收件诊断中查看；普通消息回复继续处理。'));
  for (const d of deliveries.slice(0, 10)) view.append(note(`发送 ${d.id} · ${d.state} · 尝试 ${d.attempts}${d.parts?.length ? ' · 已送达 ' + d.parts.filter(p => p.state === 'sent').length + '/' + d.parts.length + ' 项' : ''}${d.last_error === 'channel_delivery_unknown' ? ' · 部分送达结果待核对，已停止自动重发' : d.last_error ? ' · ' + d.last_error : ''}`));
  panel.append(view);
  // Reading a whole app's local chats stays with super administrators; group histories are read from their bindings.
  if (history) await channelHistory(c, panel);
}

async function channelHistory(connector, panel) {
  const section = card('本地消息与历史同步'), { chats } = await api('/api/channels/chats?connector_id=' + connector.id);
  section.append(note('搜索只读取本地密封消息库，不向飞书回源。同步完成仅代表已遍历平台返回的可见范围，不能证明入群前历史或所有编辑均可见。图片和文件按消息保存来源；获授权助手读取时才下载，撤回和清理后不可再访问。'));
  if (!chats.length) section.append(note('尚未收到此应用的会话事件。机器人进群或首次收到消息后会建立本地记录。'));
  const form = element('form', '', 'project-form');
  const select = channelSelect(form, '本地会话', 'chat', chats.map(c => [c.id, `${c.chat_type === 'group' ? '群' : '私信'} ${c.chat_id}`]));
  const keyword = channelField(form, '消息关键词', 'keyword'), sender = channelField(form, '发送者 ID', 'sender_id');
  const messageId = channelField(form, '消息 ID', 'message_id'), reply = channelField(form, '回复的消息 ID', 'reply_to');
  const from = channelField(form, '开始时间', 'from', '', 'datetime-local'), to = channelField(form, '结束时间', 'to', '', 'datetime-local');
  const queryButton = element('button', '搜索本地记录'); queryButton.type = 'submit'; queryButton.disabled = !chats.length;
  const status = element('p', '', 'muted'), results = element('div'), controls = element('div', '', 'actions');
  status.setAttribute('role', 'status'); results.setAttribute('aria-label', '本地消息搜索结果');
  let cursor = null;
  const search = async (more = false) => {
    queryButton.disabled = true;
    try {
      if (!more) { cursor = null; results.replaceChildren(); }
      const query = new URLSearchParams({ limit: '50' });
      for (const input of [keyword, sender, messageId, reply]) if (input.value) query.set(input.name, input.value);
      for (const input of [from, to]) if (input.value) query.set(input.name, String(new Date(input.value).getTime()));
      if (cursor) query.set('cursor', cursor);
      const result = await api(`/api/channels/chats/${select.value}/messages?${query}`);
      cursor = result.next_cursor;
      status.textContent = `同步：${channelSyncText(result.sync_state)}。缺口／未核验：${result.gaps.map(g => channelGapText(g.reason)).join('、')}。保留策略：${result.retention.days === null ? '保留至管理员显式清理' : result.retention.days + ' 天'}。`;
      if (!result.messages.length && !more) results.append(note('本地已同步范围没有匹配消息；这不代表飞书历史中从未存在。'));
      for (const m of result.messages) {
        const item = element('article', '', 'channel-binding');
        item.append(element('strong', `${m.sender_id || '未知发送者'} · ${m.message_type}`), note(new Date(m.created_at).toLocaleString() + ' · ' + m.message_id),
          element('p', m.content || '此消息没有可显示的文本'), ...(m.resources || []).map(r => note(`附件：${r.name} · ${{pending:'待下载',ready:'可用',failed:'读取失败'}[r.state] || r.state}${r.size === null ? '' : ' · ' + r.size + ' 字节'}${r.mime ? ' · ' + r.mime : ''}${r.error ? ' · ' + r.error : ''}`)), ...(m.thread_id ? [note('话题 ' + m.thread_id)] : [])); results.append(item);
      }
      next.hidden = !result.has_more;
    } catch (err) { status.textContent = err.message; } finally { queryButton.disabled = !chats.length; }
  };
  const next = button('读取下一页本地消息', () => search(true), 'quiet'); next.hidden = true;
  controls.append(next, button('显式重新同步可见历史', async () => {
    if (!select.value) return;
    try { await api(`/api/channels/chats/${select.value}/sync`, 'POST', { full: true }); await search(); }
    catch (err) { status.textContent = err.message; }
  }, 'quiet'));
  form.append(queryButton); form.addEventListener('submit', e => { e.preventDefault(); void search(); });
  select.addEventListener('change', () => { void search(); });
  const retention = element('form', '', 'project-form'), days = channelField(retention, '保留天数（留空保留至显式清理）', 'days', '', 'number');
  days.min = '1'; days.max = '3650';
  const before = channelField(retention, '显式清理此时间之前的记录', 'before', '', 'datetime-local');
  const fresh = async () => (await api('/api/channels/chats?connector_id=' + connector.id)).chats.find(c => c.id === select.value);
  retention.append(button('保存本地保留策略', async () => {
    try { const chat = await fresh(); if (!chat) return; await api(`/api/channels/chats/${chat.id}/retention`, 'PUT', { days: days.value ? Number(days.value) : null, expected_revision: chat.revision }); await search(); }
    catch (err) { status.textContent = err.message; }
  }, 'quiet'), button('清理指定时间之前的本地记录', async () => {
    if (!before.value || !confirm('清理会删除原文及派生摘要，并保留覆盖边界。继续？')) return;
    try { const chat = await fresh(); if (!chat) return; await api(`/api/channels/chats/${chat.id}/retention`, 'DELETE', { before: new Date(before.value).getTime(), expected_revision: chat.revision }); await search(); }
    catch (err) { status.textContent = err.message; }
  }, 'quiet'));
  section.append(form, status, results, controls, retention); panel.append(section);
  if (chats.length) await search();
}

function channelLink(url, caption, className) {
  if (!url.startsWith('#/')) return link(url, caption, className);
  const anchor = element('a', caption, className); anchor.href = url; return anchor;
}
