/**
 * Minimal GitHub REST API client with pagination, rate-limit awareness and
 * retry with backoff. Uses the global `fetch` available in Node 18+.
 */

const DEFAULT_API = 'https://api.github.com'
const MAX_RETRIES = 4

export class RateLimitError extends Error {}

export class GitHubClient {
  /**
   * @param {{ token?: string, apiBase?: string, userAgent?: string,
   *           maxWaitMs?: number, log?: (msg: string) => void }} options
   */
  constructor(options = {}) {
    this.token = options.token ?? ''
    this.apiBase = options.apiBase ?? DEFAULT_API
    this.userAgent = options.userAgent ?? 'oss-community-monitor'
    this.maxWaitMs = options.maxWaitMs ?? 15 * 60 * 1000
    this.log = options.log ?? (() => {})
    this.rateLimit = null
  }

  get authenticated() {
    return Boolean(this.token)
  }

  headers(accept) {
    const headers = {
      Accept: accept ?? 'application/vnd.github+json',
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  /** Perform a single request with retry/backoff and rate-limit handling. */
  async request(path, { accept, allow404 = false, allow403 = false } = {}) {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`
    let attempt = 0

    for (;;) {
      attempt += 1
      let res
      try {
        res = await fetch(url, { headers: this.headers(accept) })
      } catch (error) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Network error for ${url}: ${error.message}`)
        }
        const delay = 2 ** attempt * 500
        this.log(`  network error, retrying in ${delay}ms (${attempt})`)
        await sleep(delay)
        continue
      }

      this.#recordRateLimit(res.headers)

      if (res.status === 404 && allow404) return null

      if (res.status === 403 || res.status === 429) {
        if (allow403) return null
        const remaining = res.headers.get('x-ratelimit-remaining')
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0)
        if (remaining === '0' && reset > 0) {
          const waitMs = reset * 1000 - Date.now()
          if (waitMs > 0 && waitMs <= this.maxWaitMs) {
            this.log(`  rate limit hit, waiting ${Math.ceil(waitMs / 1000)}s`)
            await sleep(waitMs + 1000)
            continue
          }
          throw new RateLimitError(
            `Rate limit exhausted; reset in ${Math.ceil(waitMs / 1000)}s (too long to wait)`
          )
        }
        if (attempt >= MAX_RETRIES) {
          throw new Error(`HTTP ${res.status} for ${url}`)
        }
        await sleep(2 ** attempt * 500)
        continue
      }

      if (res.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`HTTP ${res.status} for ${url}`)
        }
        await sleep(2 ** attempt * 500)
        continue
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`)
      }

      return res
    }
  }

  async getJson(path, options) {
    const res = await this.request(path, options)
    if (res === null) return null
    return res.json()
  }

  /**
   * Iterate paginated results following the `Link` header.
   * Returns `{ items, truncated }`.
   */
  async paginate(path, { maxPages = 20, perPage = 100, allow403 = false } = {}) {
    const items = []
    let url = `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}`
    let page = 0
    let truncated = false

    while (url) {
      page += 1
      if (page > maxPages) {
        truncated = true
        break
      }
      const res = await this.request(url, { allow403 })
      if (res === null) break
      const batch = await res.json()
      if (!Array.isArray(batch)) break
      items.push(...batch)
      url = links(res.headers.get('link')).next
    }

    return { items, truncated }
  }

  #recordRateLimit(headers) {
    const remaining = headers.get('x-ratelimit-remaining')
    if (remaining === null) return
    this.rateLimit = {
      limit: Number(headers.get('x-ratelimit-limit') ?? 0),
      remaining: Number(remaining),
      reset: Number(headers.get('x-ratelimit-reset') ?? 0),
    }
  }

  get remaining() {
    return this.rateLimit?.remaining ?? null
  }
}

/** Parse a `Link` response header into `{ first, prev, next, last }` URLs. */
function links(linkHeader) {
  const out = {}
  if (!linkHeader) return out
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/)
    if (match) out[match[2]] = match[1]
  }
  return out
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}