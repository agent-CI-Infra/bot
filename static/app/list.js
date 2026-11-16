// `quiet` is the periodic refresh: the list stays on screen while loading, and only rows whose data changed are replaced
// (a running task's runtime changes every refresh; the rows around it, and whatever the user is pointing at, stay put).
let listSignature = ''; const rowSignatures = new WeakMap();
function listParams() {
  // #747: ask for one row past the page. The list APIs only slice, so the extra row is how the pager learns there is a
  // next page; a page of exactly 50 must not offer one.
  const params = new URLSearchParams({ offset: String(offset), limit: '51' });
  if ($('repository-filter').value) params.set('repository_id', $('repository-filter').value);
  if ($('account-filter').value && me.role === 'super_admin') params.set('account_id', $('account-filter').value);
  if ($('owner-filter').value) params.set('owner_id', $('owner-filter').value);
  return params;
}
function projectListAddress(hidden = false, params = listParams()) {
  return (me.role !== 'super_admin' ? '/api/repositories' : hidden ? '/api/installations/hidden' : '/api/installations') + '?' + params;
}
