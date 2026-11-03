/**
 * Shared data contract between the collection script (`scripts/collect.mjs`)
 * and the frontend. Every file lives under `public/data/`.
 *
 * Conventions:
 * - All timestamps are ISO-8601 strings in UTC.
 * - A `null` numeric value means "not available yet" (e.g. no sample),
 *   which is different from a real `0`.
 */

export type DataStatus = 'ok' | 'partial' | 'failed' | 'empty'

export type ContributionType = 'internal' | 'external' | 'unknown'

export type RepoRef = {
  owner: string
  name: string
  fullName: string
  htmlUrl: string
  description: string | null
  homepage: string | null
  defaultBranch: string
  createdAt: string
  license: string | null
  topics: string[]
}

export type CollectionError = {
  at: string
  scope: string
  message: string
}

/** `meta.json` — collection status and provenance. */
export type MonitorMeta = {
  schemaVersion: number
  repo: RepoRef
  /** When this monitor started persisting history (UTC ISO). */
  monitoringStart: string | null
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  status: DataStatus
  errors: CollectionError[]
  tokenConfigured: boolean
  /** False when early history could not be reconstructed reliably. */
  historyComplete: boolean
  notes: string[]
}

export type PendingItem = {
  number: number
  title: string
  author: string
  createdAt: string
  waitingHours: number
  url: string
}

export type Composition = {
  internal: number
  external: number
  unknown: number
}

export type PullMetrics = {
  total: number
  open: number
  merged: number
  closedUnmerged: number
  composition: Composition
}

export type IssueMetrics = {
  total: number
  open: number
  closed: number
  composition: Composition
  longOpen: {
    thresholdDays: number
    count: number
    items: PendingItem[]
  }
}

export type ContributorMetrics = {
  total: number
  activeLast30d: number
  newLast30d: number
  composition: Composition
}

export type RepoCounters = {
  stars: number
  forks: number
  watchers: number
  openIssuesAndPrs: number
}

/** `latest.json` — cumulative / current snapshot. */
export type MetricSnapshot = {
  generatedAt: string
  repo: RepoCounters
  contributors: ContributorMetrics
  pulls: PullMetrics
  issues: IssueMetrics
}

/** `history.json` — one entry per collected day (UTC). */
export type HistoryPoint = {
  date: string
  /** Cumulative counters observed at `date`. */
  stars: number
  forks: number
  watchers: number
  openPulls: number
  openIssues: number
  totalPulls: number
  totalIssues: number
  /** Activity observed during that UTC day. */
  newPulls: number
  mergedPulls: number
  closedUnmergedPulls: number
  newIssues: number
  closedIssues: number
  activeContributors: number
  collectedAt: string
}

export type PullRecord = {
  number: number
  title: string
  author: string
  contributionType: ContributionType
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  createdAt: string
  mergedAt: string | null
  closedAt: string | null
  /** Hours an open PR has been waiting. */
  waitingHours: number | null
  comments: number
  labels: string[]
  url: string
}

export type IssueRecord = {
  number: number
  title: string
  author: string
  contributionType: ContributionType
  state: 'open' | 'closed'
  isPullRequest: false
  createdAt: string
  closedAt: string | null
  /** Hours an open Issue has been waiting. */
  waitingHours: number | null
  comments: number
  labels: string[]
  url: string
}

export type ContributorRecord = {
  login: string
  contributionType: ContributionType
  isBot: boolean
  firstContributionAt: string | null
  lastContributionAt: string | null
  pulls: number
  issues: number
  reviews: number
}

/** `contributors.json` */
export type ContributorDataset = {
  generatedAt: string | null
  items: ContributorRecord[]
}

export type ChannelMetrics = {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
}

export type EcosystemItem = {
  id: string
  platform: string
  title: string
  url: string
  publishedAt: string | null
  metrics: ChannelMetrics
  collectedAt: string
  source: string
}

/** `ecosystem.json` — GitHub-external propagation. */
export type EcosystemDataset = {
  generatedAt: string | null
  available: boolean
  note: string
  items: EcosystemItem[]
}

/** `config.json` — public classification rules (never contains secrets). */
export type MonitorConfig = {
  /**
   * Internal contributor logins per repository, keyed by `owner/name`.
   * Every other (non-bot) login in that repository is external.
   */
  internalContributors: Record<string, string[]>
  bots: string[]
  /** Days an Issue may stay open before being flagged as long-unresolved. */
  longOpenIssueDays: number
}

/** One monitored repository as listed in `index.json`. */
export type RepoSummary = {
  owner: string
  name: string
  fullName: string
  htmlUrl: string
  description: string | null
  defaultBranch: string
}

/**
 * `index.json` — the set of repositories collected in one run. Per-repo files
 * live under `data/<owner>/<name>/`.
 */
export type ReposIndex = {
  generatedAt: string | null
  repos: RepoSummary[]
}

/** One published release (version) of a repository. */
export type ReleaseRecord = {
  /** Git tag backing this release (e.g. `v1.0.0`). */
  tag: string
  /** Human-readable release title. */
  name: string | null
  publishedAt: string | null
  prerelease: boolean
  /** Link to the README as of this release's tag. */
  readmeUrl: string
  /** Link to the release note / changelog entry. */
  releaseNoteUrl: string
  /** Manually curated promotional video URL, if any. */
  videoUrl: string | null
  /** Project homepage, taken from the repository metadata. */
  homepage: string | null
  /** Default branch of the repository. */
  branch: string
}

/** `releases.json` */
export type ReleaseDataset = {
  generatedAt: string | null
  items: ReleaseRecord[]
}
