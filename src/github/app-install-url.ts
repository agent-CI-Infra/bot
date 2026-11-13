/** The public page that lets a person pick an account, then the repositories to install on. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

export function githubAppInstallUrl(slug: string): string | null {
  if (!SLUG.test(slug)) return null;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/select_target`;
}

function withSafeInstallParams(base: string, from: URL): string {
  const url = new URL(base);
  const target = from.searchParams.get('suggested_target_id');
  const state = from.searchParams.get('state');
  // GitHub only documents suggested_target_id on /installations/new/permissions, so keep that
  // path when a target id is present. The general install entry stays select_target.
  if (target && /^[0-9]+$/.test(target)) {
    url.pathname = url.pathname.replace(/\/installations\/select_target$/, '/installations/new/permissions');
    url.searchParams.set('suggested_target_id', target);
  }
  if (state && /^[a-f0-9]{48}$/.test(state)) url.searchParams.set('state', state);
  return url.href;
}

/** Turn a stored `/installations/new` address into `select_target`, except a wizard URL that carries `suggested_target_id`, which stays on the documented `/new/permissions` path. Other GitHub paths are rejected. Safe install query (`suggested_target_id`, `state`) is kept; anything else is dropped. */
export function rewriteGithubAppInstallUrl(value: string, slug?: string): string | null {
  const fromSlug = typeof slug === 'string' ? githubAppInstallUrl(slug) : null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return fromSlug;
    const match = /^\/apps\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/installations\/(new|select_target)(\/permissions)?$/.exec(url.pathname);
    const rewritten = match ? githubAppInstallUrl(match[1]!) : null;
    return rewritten ? withSafeInstallParams(rewritten, url) : fromSlug;
  } catch { return fromSlug; }
}

/** Normalize the install_url on a saved onboarding App record when it is read or written. */
export function withGithubAppInstallUrl<T extends { slug?: unknown; install_url?: unknown }>(app: T): T {
  const url = rewriteGithubAppInstallUrl(typeof app.install_url === 'string' ? app.install_url : '', typeof app.slug === 'string' ? app.slug : undefined);
  return url ? { ...app, install_url: url } : app;
}
