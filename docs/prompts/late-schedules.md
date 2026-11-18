# Late scheduled workflow runs

GitHub starts `schedule` runs late, and sometimes drops them, when it is busy; the top of the hour is the peak. When you
read a workflow's runs and its scheduled runs start much later than their cron says, recommend that the bot start the
workflow on time instead. How late is serious is your judgment; as a reference, scheduled runs that are often more than
an hour late.

1. **Check the evidence.** The workflow file gives the cron (`on.schedule`, in UTC). List its recent scheduled runs
   (`/actions/workflows/<file>/runs?event=schedule`) and compare each run's `created_at` with the cron time just before
   it. One late run is not enough: say how many recent runs were late and by how much, with their links.
2. **Recommend once per repository.** Search the repository's Issues, open and closed, for an earlier recommendation
   (the workflow file name, `workflow_dispatch`, "schedule"). If one exists, comment on it with the new observations
   instead of opening another; if people closed it as not wanted, leave it.
3. **Write the recommendation** as an Issue with `github_write` when it is offered, in the language the repository's
   Issues use; without `github_write`, put it in your result or reply. Recommend one plan with two parts that go
   together, not alternatives: the bot starts the workflow on time, and the workflow keeps `schedule` only as a fallback
   that skips itself once the bot's run has succeeded. Without the bot's run the skip never applies; without the skip
   the late scheduled run repeats the bot's work. The recommendation contains:
   - the evidence: the workflow, its cron and the late runs;
   - part 1, turning on bot scheduling: in the bot's console, ask the management assistant, or add a project scheduled
     task on the project's 定时任务与通知 page with an instruction such as "start nightly.yml on main; first check that no
     run of it is queued or in progress, and if one is, start nothing";
   - part 2, changing the workflow: add `workflow_dispatch` and keep `schedule` as a fallback, set `concurrency` with
     `cancel-in-progress: false` so a scheduled run waits for a running manual one instead of cancelling it, and let the
     first job skip all the others when the run was started by `schedule` and a manual run succeeded since the previous
     scheduled time. For example, adapting the cron, the file name and the time window:

```yaml
on:
  schedule:
    - cron: '0 16 * * *'
  workflow_dispatch:

concurrency:
  group: nightly
  cancel-in-progress: false

jobs:
  guard:
    runs-on: ubuntu-latest
    permissions:
      actions: read
    outputs:
      skip: ${{ steps.check.outputs.skip }}
    steps:
      - id: check
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          skip=false
          if [ "${{ github.event_name }}" = schedule ]; then
            since=$(date -u -d '20 hours ago' +%Y-%m-%dT%H:%M:%SZ)
            done=$(gh run list -R "$GITHUB_REPOSITORY" -w nightly.yml -e workflow_dispatch -s success --created ">=$since" --json databaseId -q length)
            [ "$done" -gt 0 ] && skip=true
          fi
          echo "skip=$skip" >> "$GITHUB_OUTPUT"
  build:
    needs: guard
    if: needs.guard.outputs.skip != 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # the existing steps
```

The workflow change is the repository's own decision: recommend it, never push it.
