import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { activityScore } from './derive'
import type { TimeRangeSearch } from './ranges'
import type {
  ContributorDataset,
  EcosystemDataset,
  HistoryPoint,
  IssueRecord,
  MetricSnapshot,
  MonitorConfig,
  MonitorMeta,
  PullRecord,
  ReleaseDataset,
  ReleaseRecord,
  ReposIndex,
  RepoSummary,
} from './types'

/**
 * Static JSON files produced by `scripts/collect.mjs` and shipped with the
 * site. Resolved against Vite's `BASE_URL` so the same build works under a
 * project subpath (`/<repo>/`) or a root domain.
 *
 * Layout: `index.json` lists the monitored repositories; each repository's
 * files live under `data/<owner>/<name>/`.
 */
const DATA_DIR = `${import.meta.env.BASE_URL}data`

async function fetchJson<T>(file: string): Promise<T> {
  const res = await fetch(`${DATA_DIR}/${file}`, { cache: 'no-cache' })
  if (!res.ok) {
    throw new Error(`Failed to load ${file} (HTTP ${res.status})`)
  }
  return (await res.json()) as T
}

/**
 * Shared options for a repository detail file. Kept separate from the hooks so
 * multi-repository views (e.g. the activity ranking) can reuse the exact same
 * query keys and therefore share the cache instead of re-fetching.
 */
function datasetOptions<T, R = T>(
  file: string,
  key: string,
  select?: (data: T) => R
) {
  return {
    queryKey: ['monitor', key, file],
    queryFn: () => fetchJson<T>(file),
    select,
    retry: 1,
    staleTime: 5 * 60 * 1000,
  }
}

function useDataQuery<T, R = T>(
  file: string,
  key: string,
  select?: (data: T) => R,
  enabled = true
) {
  return useQuery({ ...datasetOptions(file, key, select), enabled })
}

/** Composite key for a repository (`owner/name`). */
export function repoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`
}

/** Detail files wrap their records in an envelope with a generation timestamp. */
type RecordDataset<T> = { generatedAt: string; items: T[] }

export const useRepos = () => useDataQuery<ReposIndex>('index.json', 'index')

export const useMonitorMeta = (repo: string) =>
  useDataQuery<MonitorMeta>(
    `${repo}/meta.json`,
    `${repo}:meta`,
    undefined,
    Boolean(repo)
  )

export const useLatestSnapshot = (repo: string) =>
  useDataQuery<MetricSnapshot>(
    `${repo}/latest.json`,
    `${repo}:latest`,
    undefined,
    Boolean(repo)
  )

export const useHistory = (repo: string) =>
  useDataQuery<HistoryPoint[]>(
    `${repo}/history.json`,
    `${repo}:history`,
    undefined,
    Boolean(repo)
  )

export const pullsQuery = (repo: string) =>
  datasetOptions<RecordDataset<PullRecord>, PullRecord[]>(
    `${repo}/pulls.json`,
    `${repo}:pulls`,
    (data) => data.items
  )

export const issuesQuery = (repo: string) =>
  datasetOptions<RecordDataset<IssueRecord>, IssueRecord[]>(
    `${repo}/issues.json`,
    `${repo}:issues`,
    (data) => data.items
  )

export const contributorsQuery = (repo: string) =>
  datasetOptions<ContributorDataset>(
    `${repo}/contributors.json`,
    `${repo}:contributors`
  )

export const releasesQuery = (repo: string) =>
  datasetOptions<ReleaseDataset, ReleaseRecord[]>(
    `${repo}/releases.json`,
    `${repo}:releases`,
    (data) => data.items
  )

export const usePulls = (repo: string) =>
  useQuery({ ...pullsQuery(repo), enabled: Boolean(repo) })

export const useIssues = (repo: string) =>
  useQuery({ ...issuesQuery(repo), enabled: Boolean(repo) })

export const useContributors = (repo: string) =>
  useQuery({ ...contributorsQuery(repo), enabled: Boolean(repo) })

export const useReleases = (repo: string) =>
  useQuery({ ...releasesQuery(repo), enabled: Boolean(repo) })

/** Classification rules are shared across all monitored repositories. */
export const useMonitorConfig = () =>
  useDataQuery<MonitorConfig>('config.json', 'config')

/** Ecosystem influence is currently a single global dataset. */
export const useEcosystem = () =>
  useDataQuery<EcosystemDataset>('ecosystem.json', 'ecosystem')

/**
 * Loads the files every monitor page needs (status banner + trend charts).
 */
export function useMonitorCore(repo: string) {
  const meta = useMonitorMeta(repo)
  const latest = useLatestSnapshot(repo)
  const history = useHistory(repo)

  return {
    meta,
    latest,
    history,
    isLoading: !repo || meta.isLoading || latest.isLoading || history.isLoading,
    isError:
      Boolean(repo) && (meta.isError || latest.isError || history.isError),
  }
}

/**
 * Resolve the repository selected via the URL (`search.repo`), falling back to
 * the first monitored repository. Returns the full list for selectors.
 */
export function useSelectedRepo(search: TimeRangeSearch) {
  const reposQuery = useRepos()
  const repos = reposQuery.data?.repos
  const selected = useMemo<RepoSummary | null>(() => {
    if (!repos || repos.length === 0) return null
    const match = search.repo
      ? repos.find((r) => repoKey(r) === search.repo)
      : undefined
    return match ?? repos[0]
  }, [repos, search.repo])

  return {
    repos: repos ?? [],
    list: repos,
    selected,
    key: selected ? repoKey(selected) : '',
    isLoading: reposQuery.isLoading,
    isError: reposQuery.isError,
    refetch: reposQuery.refetch,
  }
}

/**
 * Community activity score for every repository, keyed by `owner/name`. Loaded
 * with `useQueries` so a page can rank repositories before rendering them. The
 * query options are shared with the single-repo hooks, so nothing is fetched
 * twice — the same cache entry is reused.
 */
export function useActivityScores(
  repos: RepoSummary[]
): Map<string, number | null> {
  const keys = repos.map(repoKey)
  const pulls = useQueries({
    queries: keys.map((key) => ({ ...pullsQuery(key), enabled: Boolean(key) })),
  })
  const issues = useQueries({
    queries: keys.map((key) => ({
      ...issuesQuery(key),
      enabled: Boolean(key),
    })),
  })
  const contributors = useQueries({
    queries: keys.map((key) => ({
      ...contributorsQuery(key),
      enabled: Boolean(key),
    })),
  })

  const scores = new Map<string, number | null>()
  keys.forEach((key, index) => {
    const pullRecords = pulls[index].data
    const issueRecords = issues[index].data
    const contributorData = contributors[index].data
    scores.set(
      key,
      pullRecords && issueRecords && contributorData
        ? activityScore(pullRecords, issueRecords, contributorData.items)
        : null
    )
  })
  return scores
}

export { DATA_DIR, fetchJson }
