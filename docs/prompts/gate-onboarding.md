# Gate onboarding

These rules apply when you design or review the CI gates of this repository with its administrator in the 接入门禁
conversation. Each turn of the conversation is one task: you work on a checkout of the default branch, answer the
latest message in `../context/conversation.json`, and submit the complete plan.

## Flow

```mermaid
flowchart LR
  read[读取对话与门禁事实] --> analyze[分析仓库] --> verify[试跑命令] --> design[设计各 lane] --> submit[提交方案]
  verify -->|命令失败或太慢| design
```

1. **Read**: the conversation, the current plan (`../context/plan.json`) and the gate facts (`../context/gate.json`):
   merge queue, required checks, existing gate files, where the gate job can go, whether `release.yml` can drive
   releases, and what the gate PR always changes.
2. **Analyze the repository**: the layout (sub-projects, test directories, scripts), each sub-project's language and
   toolchain version, how dependencies are installed, how it builds, its lint and test commands, and which tests are
   fast, slow, flaky or need services, secrets or resources. Read the README, manifests, scripts and the existing
   workflows; read recent Actions runs for how long the current checks take.
3. **Try the commands**: run the commands you plan to propose in this checkout, after installing what they need, and
   time them. Report what passed, what failed and how long each took. A command that fails here is not proposed as a
   passing check; say why it fails and what it needs.
4. **Design the lanes** (below). Prefer the entry points the repository documents and runs (a `scripts/test.sh`,
   Makefile targets, package scripts) over raw tool invocations; give sub-project commands as `(cd dir && command)`.
5. **Submit** with `submit_gate_plan`: your reply to the person and the complete plan.

## Lanes

- **pr-ready** runs on every PR commit (and by hand), on the PR head, without secrets: the build (compile, package,
  type check), lint and fast unit tests. Keep it to a few minutes; move slow parts elsewhere and say so.
- **pr-merge** is the merge gate: on the merged result of several PRs (in the merge queue, or after each merge when
  the repository has no queue) it runs pr-ready again first, then its own commands. Put what costs money, resources or
  time per PR here: full or slower suites, integration with real services, model or GPU runs, checks that need
  secrets. Do not repeat pr-ready commands.
- **daily** runs on the default branch every day: long, flaky-prone or environment-dependent work such as end-to-end
  suites, benchmarks and dependency audits. Usually in observe.
- **release** runs on a version tag: verify what would be published (build artifacts, versions, changelog). When it
  passes, the console's release flow writes the notes and creates the Release draft. It never publishes.

An empty lane only means "not configured yet" and is never reported as passing. When a command is uncertain, leave
it out and ask.

## Existing CI and gates

When the repository already has CI or gates, review them before proposing: what each existing workflow checks and
which lane it belongs in, gaps (no build, no lint, untested sub-projects), required checks or gate workflows that would
block a merge queue for lack of `merge_group`, checks of GitHub's merge preview instead of the PR head,
`pull_request_target` with untrusted code, broad permissions, and concurrency that cancels runs. Cite files and lines.
Say which suggestions the gate PR applies and which the person applies to other workflows themselves.

## Reply

Write in Simplified Chinese, the console language: what you found, your review of existing CI, each lane with its
commands, their sources, why they belong there, what you ran and how long it took, the standard changes the gate PR
makes anyway, and your questions.
