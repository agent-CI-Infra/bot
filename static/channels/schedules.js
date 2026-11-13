// Prompt-driven timers of one chat (#330): reload in-place so saving/pausing/resuming keeps the open drawer right where the user is working.
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
  const load = async () => {
    box.replaceChildren(element('strong', '定时任务'), note('到点后用这里的提示词唤醒本会话的助手，在本会话的权限内查询、汇总或处理，再把结果发回本会话；超出权限的项目和操作会被拒绝。私聊用管理助手和你本人的当前权限，群聊用本群绑定的服务角色和项目范围。模型用量记在对应的服务角色上。'));
    let data;
    try { data = await api('/api/channels/chats/' + chatId + '/schedules'); } catch (err) { box.append(note(scheduleError(err.message))); return; }
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
      // A step returning false (a cancelled confirmation) leaves the panel as it is.
      const act = (caption, work) => button(caption, async () => { status.textContent = ''; try { if (await work() !== false) await load(); } catch (err) { status.textContent = scheduleError(err.message); } }, 'quiet');
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
          await load();
        } catch (err) { status.textContent = scheduleError(err.message); save.disabled = false; }
      });
      box.append(title, form);
    }
  };
  await load();
  return box;
}

