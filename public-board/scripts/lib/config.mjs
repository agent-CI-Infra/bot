import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_BOTS = [
  'dependabot[bot]',
  'github-actions[bot]',
  'renovate[bot]',
  'codecov[bot]',
  'copilot[bot]',
  'openjiuwen-sync-bot[bot]',
  'openjiuwen-release-bot[bot]',
  'openjiuwen-collaboration-bot[bot]',
]

/** Internal contributors are configured once, for every monitored repo. */
const INTERNAL_CONTRIBUTORS_FILE = path.join(
  import.meta.dirname,
  '../../config',
  'internal-contributors.json'
)

/** Manual release metadata (homepage + promo videos), keyed by `owner/name`. */
const RELEASE_OVERRIDES_FILE = path.join(
  import.meta.dirname,
  '../../config',
  'release-overrides.json'
)

function splitList(value) {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Per-repository internal contributors read from
 * `config/internal-contributors.json`, keyed by `owner/name`. Everyone else
 * (non-bot) in that repository counts as external.
 *
 * @returns {Record<string, string[]>}
 */
function loadInternalContributors() {
  if (!existsSync(INTERNAL_CONTRIBUTORS_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(INTERNAL_CONTRIBUTORS_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    /** @type {Record<string, string[]>} */
    const out = {}
    for (const [repo, logins] of Object.entries(parsed)) {
      if (Array.isArray(logins)) {
        out[repo] = logins.filter((v) => typeof v === 'string')
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Internal contributor logins for one repository (empty when unconfigured).
 *
 * @param {{ internalContributors: Record<string, string[]> }} config
 * @param {string} fullName `owner/name`
 */
export function internalContributorsFor(config, fullName) {
  return config.internalContributors[fullName] ?? []
}

/**
 * Manual release metadata read from `config/release-overrides.json`:
 * `{ "owner/name": { "homepage": "https://...", "videos": { "v1.0.0": "https://..." } } }`.
 * The homepage overrides the GitHub repository value; videos are keyed by tag.
 *
 * @returns {Record<string, { homepage?: string, videos?: Record<string, string> }>}
 */
export function loadReleaseOverrides() {
  if (!existsSync(RELEASE_OVERRIDES_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(RELEASE_OVERRIDES_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    /** @type {Record<string, { homepage?: string, videos?: Record<string, string> }>} */
    const out = {}
    for (const [repo, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      /** @type {{ homepage?: string, videos?: Record<string, string> }} */
      const override = {}
      if (typeof entry.homepage === 'string' && entry.homepage) {
        override.homepage = entry.homepage
      }
      if (entry.videos && typeof entry.videos === 'object' && !Array.isArray(entry.videos)) {
        override.videos = {}
        for (const [tag, url] of Object.entries(entry.videos)) {
          if (typeof url === 'string' && url) override.videos[tag] = url
        }
      }
      out[repo] = override
    }
    return out
  } catch {
    return {}
  }
}

/** @returns {{ owner: string, name: string, fullName: string }} */
export function parseRepo(slug) {
  const [owner, name] = slug.split('/')
  if (!owner || !name) throw new Error(`Invalid repo slug: ${slug}`)
  return { owner, name, fullName: `${owner}/${name}` }
}

function loadExistingConfig(outDir) {
  const file = path.join(outDir, 'config.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve runtime configuration.
 *
 * Multiple repositories are collected in one run. The monitored list defaults
 * to the keys of `config/internal-contributors.json`, so adding a community is
 * a single-file change; `MONITOR_REPOS` (comma-separated) or `MONITOR_REPO`
 * (single) override it when needed. Secrets (GITHUB_TOKEN) are only ever read
 * from the environment and are never written to any output file.
 */
export function loadConfig(outDir) {
  const existing = loadExistingConfig(outDir)

  // The whitelist keys define the monitored repositories: GITHUB_REPOSITORY is
  // intentionally ignored, since in CI it points at the site repo, not the
  // monitored project.
  const internalContributors = loadInternalContributors()
  const repoList = splitList(process.env.MONITOR_REPOS)
  const slugs = repoList.length
    ? repoList
    : process.env.MONITOR_REPO
      ? [process.env.MONITOR_REPO]
      : Object.keys(internalContributors)
  if (slugs.length === 0) {
    throw new Error(
      'No monitored repositories configured: add "owner/name" keys to config/internal-contributors.json'
    )
  }
  const repos = slugs.map(parseRepo)

  const bots = splitList(process.env.MONITOR_BOTS)

  /** @type {import('../src/lib/monitor/types.ts').MonitorConfig} */
  const config = {
    internalContributors,
    bots: bots.length ? bots : (existing?.bots ?? DEFAULT_BOTS),
    longOpenIssueDays: Number(
      process.env.MONITOR_LONG_OPEN_DAYS ?? existing?.longOpenIssueDays ?? 30
    ),
  }

  return {
    repos,
    config,
    token: process.env.GITHUB_TOKEN ?? process.env.MONITOR_TOKEN ?? '',
    outDir: outDir,
    maxListPages: Number(process.env.MONITOR_MAX_LIST_PAGES ?? 20),
    schemaVersion: 1,
    releaseOverrides: loadReleaseOverrides(),
  }
}