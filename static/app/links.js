// Navigation links are also used by ordinary lists, so keep their DOM helper in the shared base layer.
function consoleLink(href, caption, hint = '') {
  const a = element('a', '', 'console-link'); a.href = href;
  a.append(element('span', caption));
  if (hint) { const note = element('small', hint); note.title = hint; a.append(note); }
  return a;
}
// Shared with the identity page and the onboarding wizard. The general entry is select_target; a wizard URL with suggested_target_id stays on /installations/new/permissions.
function githubAppInstallUrl(slug) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(slug)) return '';
  return 'https://github.com/apps/' + encodeURIComponent(slug) + '/installations/select_target';
}
function rewriteGithubAppInstallUrl(url, slug) {
  const fallback = githubAppInstallUrl(slug || '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) return fallback || url;
    // Already-installed configure pages (/settings/installations/...) stay as they are.
    const match = /^\/apps\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/installations\/(new|select_target)(\/permissions)?$/.exec(parsed.pathname);
    if (!match) return url;
    const rewritten = githubAppInstallUrl(match[1]);
    if (!rewritten) return fallback || url;
    const out = new URL(rewritten);
    const target = parsed.searchParams.get('suggested_target_id');
    const state = parsed.searchParams.get('state');
    if (target && /^[0-9]+$/.test(target)) {
      out.pathname = out.pathname.replace(/\/installations\/select_target$/, '/installations/new/permissions');
      out.searchParams.set('suggested_target_id', target);
    }
    if (state && /^[a-f0-9]{48}$/.test(state)) out.searchParams.set('state', state);
    return out.href;
  } catch { return fallback || url; }
}
