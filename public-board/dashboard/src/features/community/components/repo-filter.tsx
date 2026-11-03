import { repoKey } from '@/lib/monitor/data'
import type { RepoSummary } from '@/lib/monitor/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type RepoFilterProps = {
  repos: RepoSummary[]
  /** Currently selected repository key (`owner/name`). */
  value: string
  onChange: (key: string) => void
  className?: string
}

/** Switch the repository a monitor page is scoped to, as a row of buttons. */
export function RepoFilter({
  repos,
  value,
  onChange,
  className,
}: RepoFilterProps) {
  if (repos.length <= 1) return null

  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded-lg border p-1',
        className
      )}
    >
      {repos.map((repo) => {
        const key = repoKey(repo)
        return (
          <Button
            key={key}
            type='button'
            size='sm'
            variant={key === value ? 'secondary' : 'ghost'}
            className='h-7 px-2.5 text-xs'
            onClick={() => onChange(key)}
          >
            {repo.fullName}
          </Button>
        )
      })}
    </div>
  )
}
