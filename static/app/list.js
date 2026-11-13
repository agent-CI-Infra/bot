// `quiet` is the periodic refresh: the list stays on screen while loading, and only rows whose data changed are replaced
// (a running task's runtime changes every refresh; the rows around it, and whatever the user is pointing at, stay put).
let listSignature = ''; const rowSignatures = new WeakMap();
function listParams() {
  const params = new URLSearchParams({ offset: String(offset), limit: '50' });
  if ($('repository-filter').value) params.set('repository_id', $('repository-filter').value);
  if ($('account-filter').value && me.role === 'super_admin') params.set('account_id', $('account-filter').value);
  if ($('owner-filter').value) params.set('owner_id', $('owner-filter').value);
  return params;
}
function projectListAddress(hidden = false, params = listParams()) {
  return (me.role !== 'super_admin' ? '/api/repositories' : hidden ? '/api/installations/hidden' : '/api/installations') + '?' + params;
}

// #523: an empty delivery list is a guided empty state, not the generic "暂无记录" CSS placeholder.
function eventsEmptyState(params) {
  const filtered = !!(params.get('repository_id') || params.get('account_id') || params.get('owner_id'));
  const paged = Number(params.get('offset') || 0) > 0;
  const title = paged ? '本页没有投递' : filtered ? '当前筛选下没有投递' : '还没有 Webhook 投递';
  const text = paged
    ? '已经翻过第一页，这一页没有记录。可以回到上一页，或调整筛选后再看。'
    : filtered
      ? '这个仓库、账号或组织范围内还没有投递记录。投递可能在其他筛选条件下，或 Webhook 尚未把事件送到本部署。'
      : '下面是常见原因。有投递之后，这里会列出接收、验签和处理结果。';
  const empty = consoleState(title, text);
  if (!filtered && !paged) {
    const reasons = document.createElement('ul');
    // Super administrators still see rejected-signature and unregistered-repository
    // rows here (repository_id is null; /api/events does not filter them). Those
    // conditions therefore cannot explain an empty list for that role.
    if (me.role === 'super_admin') {
      reasons.append(
        element('li', 'GitHub App 的 Webhook 还没指向本部署，事件没有到达这里。'),
        element('li', '当前确实还没有事件。验签失败或尚未启动的仓库仍会作为投递出现在本页。')
      );
    } else {
      reasons.append(
        element('li', 'GitHub App 的 Webhook 还没指向本部署，或验签失败。'),
        element('li', '仓库还没被管理员启动，事件不会在这里形成任务。'),
        element('li', '当前账号范围内确实还没有事件。')
      );
    }
    empty.append(reasons);
  }
  if (filtered) {
    empty.append(button('清除筛选', () => {
      $('repository-filter').value = '';
      $('account-filter').value = '';
      $('owner-filter').value = '';
      offset = 0;
      render().catch(error);
    }));
  } else if (paged) {
    empty.append(button('返回第一页', () => { offset = 0; render().catch(error); }));
  }
  if (me.role === 'super_admin') {
    empty.append(consoleLink('#/settings/onboarding', '打开接入向导', '检查并更新 GitHub App 的 Webhook 地址'));
    empty.append(consoleLink('#/settings/accounts', '查看机器人账号', '核对 Webhook 入口和签名凭据'));
  } else {
    empty.append(consoleLink('#/identity', '查看身份与权限', '确认当前授权范围'));
    empty.append(element('p', '若授权无误，请联系管理员检查 Webhook 是否指向本部署，以及相关仓库是否已启动。', 'muted'));
  }
  return empty;
}
