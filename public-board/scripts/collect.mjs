#!/usr/bin/env node
/**
 * GitHub open-source community data collector (multi-repository).
 *
 * Produces the static JSON contract consumed by the frontend:
 *   public/data/index.json                        list of monitored repositories
 *   public/data/config.json                       shared classification rules
 *   public/data/<owner>/<name>/meta.json          per-repo status & provenance
 *   public/data/<owner>/<name>/latest.json        per-repo cumulative snapshot
 *   public/data/<owner>/<name>/history.json       per-repo daily snapshots
 *   public/data/<owner>/<name>/{pulls,issues,contributors,releases}.json
 *
 * Design rules (see the task spec):
 * - Secrets come only from the environment and are never written to output.
 * - A failed step must NOT overwrite the last valid data with zeros.
 * - History only ever appends forward, one point per UTC day.
 * - Distinguish "real zero" from "no sample" by using `null`.
 * - A failure in one repository never aborts the others.
 *
 * Usage:
 *   node scripts/collect.mjs            # local / CI collection
 *   npm run collect
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { GitHubClient } from './lib/github.mjs'
import { loadConfig, internalContributorsFor } from './lib/config.mjs'
import { classify, isBot, toComposition, hoursBetween } from './lib/metrics.mjs'

const OUT_DIR = path.join(process.cwd(), 'public', 'data')
const DAY_MS = 24 * 60 * 60 * 1000

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function dayKey(date) {
  return date.toISOString().slice(0, 10)
}

function refOf(repo) {
  return { owner: repo.owner, name: repo.name, fullName: repo.fullName }
}

async function main() {
  const log = (msg) => console.log(msg)
  const cfg = loadConfig(OUT_DIR)
  const client = new GitHubClient({ token: cfg.token, log })
  const now = new Date()

  const summaries = []
  for (const repo of cfg.repos) {
    try {
      const summary = await collectRepo(repo, cfg, client, now, log)
      if (summary) summaries.push(summary)
    } catch (error) {
      log(`! ${repo.fullName}: ${error?.message ?? error}`)
    }
  }

  // Shared across repos. Public classification rules only — never secrets.
  writeJson(path.join(OUT_DIR, 'config.json'), cfg.config)
  writeJson(path.join(OUT_DIR, 'index.json'), {
    generatedAt: new Date().toISOString(),
    repos: summaries,
  })
  log(`Wrote ${OUT_DIR}`)
}

export async function collectRepo(repo, cfg, client, now, log) {
  const repoRef = refOf(repo)
  const full = repoRef.fullName
  const nowIso = now.toISOString()
  const repoDir = path.join(cfg.outDir, repo.owner, repo.name)
  mkdirSync(repoDir, { recursive: true })

  const internal = internalContributorsFor(cfg.config, full)

  log(`Collecting ${full} (token: ${client.authenticated ? 'yes' : 'no'})`)

  const prevMeta = readJson(path.join(repoDir, 'meta.json'))
  const prevLatest = readJson(path.join(repoDir, 'latest.json'))
  const prevHistory = readJson(path.join(repoDir, 'history.json'), []) ?? []
  const prevPulls = readJson(path.join(repoDir, 'pulls.json'), { items: [] })
  const prevIssues = readJson(path.join(repoDir, 'issues.json'), { items: [] })
  const prevReleases = readJson(path.join(repoDir, 'releases.json'), { items: [] })

  /** @type {{ at: string, scope: string, message: string }[]} */
  const errors = []
  const notes = []
  const fail = (scope, error) => {
    const message = String(error?.message ?? error)
    errors.push({ at: nowIso, scope, message })
    log(`  ! ${scope}: ${message}`)
  }

  // --- repository -----------------------------------------------------------
  let repoInfo = null
  try {
    repoInfo = await client.getJson(`/repos/${full}`)
  } catch (error) {
    fail('repo', error)
  }

  // --- contributors ---------------------------------------------------------
  let contributorRaw = null
  try {
    const { items, truncated } = await client.paginate(
      `/repos/${full}/contributors?anon=0`,
      { maxPages: cfg.maxListPages }
    )
    contributorRaw = items
    if (truncated) notes.push('Contributor list truncated by MONITOR_MAX_LIST_PAGES.')
  } catch (error) {
    fail('contributors', error)
  }

  // --- pull requests --------------------------------------------------------
  let pullsRaw = null
  try {
    const { items, truncated } = await client.paginate(
      `/repos/${full}/pulls?state=all&sort=created&direction=desc`,
      { maxPages: cfg.maxListPages }
    )
    pullsRaw = items
    if (truncated) notes.push('Pull request list truncated by MONITOR_MAX_LIST_PAGES.')
  } catch (error) {
    fail('pulls', error)
  }

  // --- issues (PRs are filtered out; GitHub numbers PRs as issues) ----------
  let issuesRaw = null
  /**
   * Conversation-comment counts for pull requests, keyed by number. The
   * `/pulls` feed omits `comments` entirely, but the `/issues` feed returns
   * PRs too and exposes it — so we harvest it here before filtering.
   */
  let prComments = null
  try {
    const { items, truncated } = await client.paginate(
      `/repos/${full}/issues?state=all&sort=created&direction=desc`,
      { maxPages: cfg.maxListPages }
    )
    prComments = new Map(
      items.filter((i) => i.pull_request).map((i) => [i.number, i.comments ?? 0])
    )
    issuesRaw = items.filter((i) => !i.pull_request)
    if (truncated) notes.push('Issue list truncated by MONITOR_MAX_LIST_PAGES.')
  } catch (error) {
    fail('issues', error)
  }

  // --- releases (versions) ---------------------------------------------------
  let releasesRaw = null
  try {
    const { items, truncated } = await client.paginate(
      `/repos/${full}/releases`,
      { maxPages: cfg.maxListPages }
    )
    releasesRaw = items
    if (truncated) notes.push('Release list truncated by MONITOR_MAX_LIST_PAGES.')
  } catch (error) {
    fail('releases', error)
  }

  // --- build records --------------------------------------------------------
  let pullRecords = null
  if (pullsRaw) {
    pullRecords = pullsRaw.map((p) => {
      const author = p.user?.login ?? 'unknown'
      const mergedAt = p.merged_at ?? null
      const state = mergedAt ? 'merged' : p.state === 'open' ? 'open' : 'closed'
      return {
        number: p.number,
        title: p.title ?? '',
        author,
        contributionType: classify(author, internal, cfg.config, p.user?.type),
        state,
        isDraft: Boolean(p.draft),
        createdAt: p.created_at,
        mergedAt,
        closedAt: p.closed_at ?? null,
        waitingHours: state === 'open' ? hoursBetween(p.created_at, nowIso) : null,
        comments: prComments?.get(p.number) ?? 0,
        labels: (p.labels ?? []).map((l) => l.name),
        url: p.html_url,
      }
    })
    if (prComments) {
      const missing = pullsRaw.filter((p) => !prComments.has(p.number)).length
      if (missing > 0) {
        notes.push(
          `${missing} pull request comment counts unavailable (issues feed truncated).`
        )
      }
    }
  }

  let issueRecords = null
  if (issuesRaw) {
    issueRecords = issuesRaw.map((i) => {
      const author = i.user?.login ?? 'unknown'
      return {
        number: i.number,
        title: i.title ?? '',
        author,
        contributionType: classify(author, internal, cfg.config, i.user?.type),
        state: i.state === 'open' ? 'open' : 'closed',
        isPullRequest: false,
        createdAt: i.created_at,
        closedAt: i.closed_at ?? null,
        waitingHours: i.state === 'open' ? hoursBetween(i.created_at, nowIso) : null,
        comments: i.comments ?? 0,
        labels: (i.labels ?? []).map((l) => l.name),
        url: i.html_url,
      }
    })
  }

  // --- metrics --------------------------------------------------------------
  const pullsSection = pullRecords
    ? computePullMetrics(pullRecords)
    : (prevLatest?.pulls ?? null)
  const issuesSection = issueRecords
    ? computeIssueMetrics(issueRecords, cfg.config)
    : (prevLatest?.issues ?? null)
  const contributorsSection =
    pullRecords || issueRecords
      ? computeContributors(pullRecords ?? [], issueRecords ?? [], contributorRaw, internal, cfg, now)
      : (prevLatest?.contributors ?? null)

  const counters = {
    stars: repoInfo?.stargazers_count ?? prevLatest?.repo?.stars ?? 0,
    forks: repoInfo?.forks_count ?? prevLatest?.repo?.forks ?? 0,
    watchers: repoInfo?.subscribers_count ?? prevLatest?.repo?.watchers ?? 0,
    openIssuesAndPrs: repoInfo?.open_issues_count ?? prevLatest?.repo?.openIssuesAndPrs ?? 0,
  }

  const generatedAt = nowIso
  const latest = {
    generatedAt,
    repo: counters,
    contributors: contributorsSection ?? emptyContributors(),
    pulls: pullsSection ?? emptyPulls(),
    issues: issuesSection ?? emptyIssues(cfg.config),
  }

  // --- history (append/replace today's point) -------------------------------
  const history = appendHistory(prevHistory, {
    date: dayKey(now),
    counters,
    pullRecords,
    issueRecords,
    collectedAt: generatedAt,
  })

  // --- status ---------------------------------------------------------------
  const anyData = Boolean(pullRecords || issueRecords)
  const anyError = errors.length > 0
  const status = !anyData
    ? anyError
      ? 'failed'
      : 'empty'
    : anyError
      ? 'partial'
      : 'ok'
  const lastSuccessAt = anyData ? nowIso : (prevMeta?.lastSuccessAt ?? null)

  const monitoringStart = prevMeta?.monitoringStart ?? nowIso
  const meta = {
    schemaVersion: cfg.schemaVersion,
    repo: {
      ...repoRef,
      htmlUrl: repoInfo?.html_url ?? `https://github.com/${full}`,
      description: repoInfo?.description ?? prevMeta?.repo?.description ?? null,
      homepage: repoInfo?.homepage ?? prevMeta?.repo?.homepage ?? null,
      defaultBranch: repoInfo?.default_branch ?? prevMeta?.repo?.defaultBranch ?? 'main',
      createdAt: repoInfo?.created_at ?? prevMeta?.repo?.createdAt ?? '',
      license: repoInfo?.license?.spdx_id ?? prevMeta?.repo?.license ?? null,
      topics: repoInfo?.topics ?? prevMeta?.repo?.topics ?? [],
    },
    monitoringStart,
    lastSuccessAt,
    lastAttemptAt: nowIso,
    status,
    errors,
    tokenConfigured: client.authenticated,
    historyComplete: false,
    notes,
  }

  // Build the version list once the repository metadata (homepage / branch) is
  // known. Curated promotional videos are attached by matching release tag.
  const releaseRecords = buildReleaseRecords(
    releasesRaw,
    full,
    meta.repo.homepage,
    meta.repo.defaultBranch,
    cfg.releaseOverrides?.[full] ?? {}
  )

  // --- persist --------------------------------------------------------------
  writeJson(path.join(repoDir, 'meta.json'), meta)
  writeJson(path.join(repoDir, 'latest.json'), latest)
  writeJson(path.join(repoDir, 'history.json'), history)
  writeJson(
    path.join(repoDir, 'pulls.json'),
    pullRecords ? { generatedAt, items: pullRecords } : prevPulls
  )
  writeJson(
    path.join(repoDir, 'issues.json'),
    issueRecords ? { generatedAt, items: issueRecords } : prevIssues
  )
  writeJson(path.join(repoDir, 'contributors.json'), {
    generatedAt: contributorsSection ? generatedAt : (readJson(path.join(repoDir, 'contributors.json'))?.generatedAt ?? null),
    items: contributorsSection ? buildContributorRecords(pullRecords ?? [], issueRecords ?? [], contributorRaw, internal, cfg) : (readJson(path.join(repoDir, 'contributors.json'))?.items ?? []),
  })
  writeJson(path.join(repoDir, 'releases.json'), {
    generatedAt: releaseRecords ? generatedAt : (prevReleases?.generatedAt ?? null),
    items: releaseRecords ? releaseRecords : (prevReleases?.items ?? []),
  })

  log(`Status: ${status} | PRs: ${pullsSection?.total ?? '-'} | Issues: ${issuesSection?.total ?? '-'} | Releases: ${releaseRecords?.length ?? '-'}`)

  // Summary used to build the multi-repo `index.json`.
  return {
    owner: repoRef.owner,
    name: repoRef.name,
    fullName: repoRef.fullName,
    htmlUrl: meta.repo.htmlUrl,
    description: meta.repo.description,
    defaultBranch: meta.repo.defaultBranch,
  }
}

function computePullMetrics(records) {
  const open = records.filter((r) => r.state === 'open')
  const merged = records.filter((r) => r.state === 'merged')
  const closedUnmerged = records.filter((r) => r.state === 'closed')

  return {
    total: records.length,
    open: open.length,
    merged: merged.length,
    closedUnmerged: closedUnmerged.length,
    composition: toComposition(records),
  }
}

function computeIssueMetrics(records, config) {
  const open = records.filter((r) => r.state === 'open')
  const closed = records.filter((r) => r.state === 'closed')

  // Long-unresolved is age based: how long an open Issue has been around.
  const longOpenItems = open
    .filter(
      (r) =>
        r.waitingHours !== null &&
        r.waitingHours >= config.longOpenIssueDays * 24 &&
        !isBot(r.author, undefined, config)
    )
    .sort((a, b) => b.waitingHours - a.waitingHours)

  return {
    total: records.length,
    open: open.length,
    closed: closed.length,
    composition: toComposition(records),
    longOpen: {
      thresholdDays: config.longOpenIssueDays,
      count: longOpenItems.length,
      items: longOpenItems.slice(0, 50).map(toPending),
    },
  }
}

function toPending(r) {
  return {
    number: r.number,
    title: r.title,
    author: r.author,
    createdAt: r.createdAt,
    waitingHours: r.waitingHours,
    url: r.url,
  }
}

function computeContributors(pullRecords, issueRecords, contributorRaw, internal, cfg, now) {
  const logins = new Set()
  for (const r of pullRecords) if (!isBot(r.author, undefined, cfg.config)) logins.add(r.author)
  for (const r of issueRecords) if (!isBot(r.author, undefined, cfg.config)) logins.add(r.author)
  for (const c of contributorRaw ?? []) {
    if (!isBot(c.login, c.type, cfg.config)) logins.add(c.login)
  }

  const firstSeen = new Map()
  const lastSeen = new Map()
  for (const r of [...pullRecords, ...issueRecords]) {
    const t = new Date(r.createdAt).getTime()
    if (!firstSeen.has(r.author) || t < firstSeen.get(r.author)) firstSeen.set(r.author, t)
    if (!lastSeen.has(r.author) || t > lastSeen.get(r.author)) lastSeen.set(r.author, t)
  }

  const cutoff = now.getTime() - 30 * DAY_MS
  let activeLast30d = 0
  let newLast30d = 0
  const composition = { internal: 0, external: 0, unknown: 0 }

  for (const login of logins) {
    const last = lastSeen.get(login)
    const first = firstSeen.get(login)
    if (last !== undefined && last >= cutoff) activeLast30d += 1
    if (first !== undefined && first >= cutoff) newLast30d += 1
    const type = classify(login, internal, cfg.config)
    composition[type] += 1
  }

  return {
    total: logins.size,
    activeLast30d,
    newLast30d,
    composition,
  }
}

function buildContributorRecords(pullRecords, issueRecords, contributorRaw, internal, cfg) {
  const map = new Map()
  const ensure = (login) => {
    if (!map.has(login)) {
      map.set(login, {
        login,
        contributionType: classify(login, internal, cfg.config),
        isBot: isBot(login, undefined, cfg.config),
        firstContributionAt: null,
        lastContributionAt: null,
        pulls: 0,
        issues: 0,
        reviews: 0,
      })
    }
    return map.get(login)
  }

  for (const r of pullRecords) {
    const c = ensure(r.author)
    c.pulls += 1
    trackSeen(c, r.createdAt)
  }
  for (const r of issueRecords) {
    const c = ensure(r.author)
    c.issues += 1
    trackSeen(c, r.createdAt)
  }
  for (const raw of contributorRaw ?? []) {
    const c = ensure(raw.login)
    c.isBot = isBot(raw.login, raw.type, cfg.config)
  }

  return [...map.values()].sort((a, b) => b.pulls + b.issues - (a.pulls + a.issues))
}

function trackSeen(record, iso) {
  if (!record.firstContributionAt || iso < record.firstContributionAt) {
    record.firstContributionAt = iso
  }
  if (!record.lastContributionAt || iso > record.lastContributionAt) {
    record.lastContributionAt = iso
  }
}

function appendHistory(prevHistory, { date, counters, pullRecords, issueRecords, collectedAt }) {
  const points = (prevHistory ?? []).filter((p) => p.date !== date)
  const dayStart = new Date(`${date}T00:00:00.000Z`).getTime()
  const dayEnd = dayStart + DAY_MS
  const inDay = (iso) => {
    if (!iso) return false
    const t = new Date(iso).getTime()
    return t >= dayStart && t < dayEnd
  }

  const pulls = pullRecords ?? []
  const issues = issueRecords ?? []
  const active = new Set()
  let newPulls = 0
  let mergedPulls = 0
  let closedUnmergedPulls = 0
  let newIssues = 0
  let closedIssues = 0

  for (const p of pulls) {
    if (inDay(p.createdAt)) {
      newPulls += 1
      active.add(p.author)
    }
    if (inDay(p.mergedAt)) mergedPulls += 1
    if (!p.mergedAt && inDay(p.closedAt)) closedUnmergedPulls += 1
  }
  for (const i of issues) {
    if (inDay(i.createdAt)) {
      newIssues += 1
      active.add(i.author)
    }
    if (inDay(i.closedAt)) closedIssues += 1
  }

  points.push({
    date,
    stars: counters.stars,
    forks: counters.forks,
    watchers: counters.watchers,
    openPulls: pullRecords ? pulls.filter((p) => p.state === 'open').length : 0,
    openIssues: issueRecords ? issues.filter((i) => i.state === 'open').length : 0,
    totalPulls: pullRecords ? pulls.length : 0,
    totalIssues: issueRecords ? issues.length : 0,
    newPulls,
    mergedPulls,
    closedUnmergedPulls,
    newIssues,
    closedIssues,
    activeContributors: active.size,
    collectedAt,
  })

  return points.sort((a, b) => a.date.localeCompare(b.date))
}

function emptyContributors() {
  return {
    total: 0,
    activeLast30d: 0,
    newLast30d: 0,
    composition: { internal: 0, external: 0, unknown: 0 },
  }
}

function emptyPulls() {
  return {
    total: 0,
    open: 0,
    merged: 0,
    closedUnmerged: 0,
    composition: { internal: 0, external: 0, unknown: 0 },
  }
}

function emptyIssues(config) {
  return {
    total: 0,
    open: 0,
    closed: 0,
    composition: { internal: 0, external: 0, unknown: 0 },
    longOpen: { thresholdDays: config.longOpenIssueDays, count: 0, items: [] },
  }
}

/**
 * Map raw GitHub Releases into the frontend `ReleaseRecord` contract. Draft
 * releases are skipped; README / release-note links are derived per tag. The
 * homepage falls back to the manually curated override, then the GitHub value;
 * promotional videos come from the override's `{ tag: url }` map.
 */
function buildReleaseRecords(releasesRaw, full, githubHomepage, defaultBranch, override) {
  if (!releasesRaw) return null
  const homepage = override?.homepage || githubHomepage || null
  const videos = override?.videos ?? {}
  return releasesRaw
    .filter((r) => !r.draft && r.tag_name)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name ?? null,
      publishedAt: r.published_at ?? null,
      prerelease: Boolean(r.prerelease),
      readmeUrl: `https://github.com/${full}/blob/${r.tag_name}/README.md`,
      releaseNoteUrl:
        r.html_url ?? `https://github.com/${full}/releases/tag/${r.tag_name}`,
      videoUrl: videos[r.tag_name] ?? null,
      homepage,
      branch: defaultBranch,
    }))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
}
