/**
 * Live, on-demand repository statistics fetched directly from the public
 * GitHub REST API in the browser. Used by the overview page's "更新数据"
 * button to show the newest counts without waiting for the scheduled
 * collection job.
 *
 * Unauthenticated requests are limited to 60 requests/hour per IP, and the
 * network to `api.github.com` can be unreachable/blocked in some regions, so
 * this is a best-effort manual refresh — callers should fall back to the
 * published snapshot when it fails.
 */

export type LiveRepoStats = {
  stars: number
  forks: number
  openPulls: number
  openIssues: number
  /** When the live values were fetched (UTC ISO). */
  fetchedAt: string
}

export type LiveFetchErrorKind = 'network' | 'rate-limit' | 'not-found' | 'http'

/** Distinguishable failure so the UI can react (e.g. fall back on `network`). */
export class LiveFetchError extends Error {
  readonly kind: LiveFetchErrorKind

  constructor(message: string, kind: LiveFetchErrorKind) {
    super(message)
    this.name = 'LiveFetchError'
    this.kind = kind
  }
}

/** True when the request never reached GitHub (offline, DNS, TLS, blocked). */
export function isNetworkError(error: unknown): boolean {
  return error instanceof LiveFetchError && error.kind === 'network'
}

const API = 'https://api.github.com'
const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}
const TIMEOUT_MS = 12_000

async function rawFetch(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { headers: HEADERS, signal: controller.signal })
  } catch {
    // fetch rejects with a TypeError on network/TLS failure or timeout.
    throw new LiveFetchError(
      '无法连接 GitHub API（当前网络不可达或被拦截）',
      'network'
    )
  } finally {
    clearTimeout(timer)
  }
}

function rateLimitMessage(res: Response): string {
  const base = 'GitHub API 访问受限（匿名限额 60 次/小时'
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const minutes = Math.max(0, Math.ceil((reset * 1000 - Date.now()) / 60000))
    return `${base}，约 ${minutes} 分钟后重置）`
  }
  return `${base}）`
}

async function githubFetch(url: string): Promise<Response> {
  const res = await rawFetch(url)
  if (res.ok) return res
  if (res.status === 403 || res.status === 429) {
    throw new LiveFetchError(rateLimitMessage(res), 'rate-limit')
  }
  if (res.status === 404) {
    throw new LiveFetchError('仓库不存在或不可公开访问', 'not-found')
  }
  throw new LiveFetchError(`GitHub API 请求失败（HTTP ${res.status}）`, 'http')
}

/** Read the last page number from a GitHub `Link` header (`rel="last"`). */
function lastPage(link: string | null): number | null {
  if (!link) return null
  const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/)
  return match ? Number(match[1]) : null
}

/** Count open items using `per_page=1` + the pagination `Link` header. */
async function countOpen(
  owner: string,
  name: string,
  resource: 'pulls' | 'issues'
): Promise<number> {
  const res = await githubFetch(
    `${API}/repos/${owner}/${name}/${resource}?state=open&per_page=1`
  )
  const total = lastPage(res.headers.get('link'))
  if (total !== null) return total
  const items = (await res.json()) as unknown[]
  return items.length
}

/**
 * Fetch the current repository-level counts (stars, forks, open PRs and open
 * issues) straight from GitHub. Throws a `LiveFetchError` on failure.
 */
export async function fetchLiveRepoStats(repo: {
  owner: string
  name: string
}): Promise<LiveRepoStats> {
  const { owner, name } = repo
  const [repoRes, openPulls] = await Promise.all([
    githubFetch(`${API}/repos/${owner}/${name}`),
    countOpen(owner, name, 'pulls'),
  ])

  const data = (await repoRes.json()) as {
    stargazers_count: number
    forks_count: number
    open_issues_count: number
  }

  return {
    stars: data.stargazers_count,
    forks: data.forks_count,
    openPulls,
    // `open_issues_count` counts both open issues and open PRs.
    openIssues: Math.max(0, data.open_issues_count - openPulls),
    fetchedAt: new Date().toISOString(),
  }
}
