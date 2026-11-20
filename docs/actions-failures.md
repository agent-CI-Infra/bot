# Actions 失败排查与提报

默认分支或版本标签上的失败运行会产生 `actions.run_failed` 事件。Manager 可把调查分派为通用 `task.request`，在项目电脑检出失败运行对应的提交。Manager 忽略事件时，扫描将该 attempt 记为 `ignored`。

每个仓库可在「项目设置 → 监听与触发」保存「接收默认分支和版本标签的 Actions 失败事件」，也可通过 `PATCH /api/repositories/:id/policy` 保存 `actions_failures_enabled`。经 GitHub App 首次启动且项目能力上限至少为 `comment` 的新项目默认启用。机器人账号和以 `read` 启动的项目默认关闭。接收需要开关启用、项目启用和至少 `comment` 的能力上限。

## 配置前提

App 管理员需要在已有 App 的事件订阅中添加 `workflow_run`，即 GitHub App 设置 Permissions & events → Subscribe to events 里的「Workflow run」。它是 Webhook 事件订阅，不是 Workflows 权限：GitHub 只要求 App 至少有 Actions read 才能订阅；Workflows 权限只用于修改 `.github/workflows` 下的文件，确认为 CI 改动的 bot PR 需要它，本功能不需要。新建 App 的 manifest 不能替代这个操作。此事件不属于全局 `appEvents`，因此未启用本功能的安装继续使用现有接入要求。

处理器读取该仓库实际使用的安装的 `permissions` 和 `events`，在项目设置和仓库读取 API 的 `actions_failures.error` 中报告最先缺少的一项：安装没有 Actions 权限时为 `actions_permission_missing`（这时 GitHub 不会提供 Workflow run 订阅，先补权限）；有 Actions 权限但没有订阅时为 `actions_workflow_run_subscription_missing`。两者都让本功能停在读取运行之前，不写 GitHub。超级管理员的项目列表按安装记录的事件，在缺少 `workflow_run` 的每个仓库行显示「事件未订阅」，开启本功能的仓库为琥珀色，未开启的为蓝色；「同步安装列表」的结论和「机器人账号」的 App 检查也会列出它，但它不计入检视和开发的基线。GitHub 文档只要求新增权限时由安装所有者批准；安装设置出现待批准的变更时接受即可。

扫描器只申请 Contents 和 Actions 的读取权限。任务写入另由对应通用工具申请所需的安装权限，仍受项目 `capability_ceiling`、任务授予的写权限和来源角色的 GitHub 权限约束。

## 运行范围与扫描

签名验证通过的 `workflow_run.completed` 事件只记入持久收件记录。每 5 秒检查待处理事件；后台扫描间隔为 60 秒，每页 50 个 run。只处理 `conclusion=failure`，忽略 PR 事件、带有 PR 关联的 run，以及成功、取消和跳过。普通 run 必须属于默认分支。推送标签触发的 run（版本标签运行，#1028）不限 workflow 名字：GitHub 给这类 run 的 `event` 是 `push`，`head_branch` 是标签名，控制面用 `GET /git/ref/tags/<标签名>` 确认这个标签存在、并且（附注标签解到它指向的对象后）指向 run 的提交，再通过 compare 确认该提交是默认分支的祖先。GitHub 不给这类 run 标出引用类型，所以判断只看同名标签：已删除或已改指别的提交的标签、不在默认分支历史上的提交都不进入；分支推送的 run 只有在恰好有同名标签指向同一个提交时，才会被当作版本标签运行（这个提交同样在默认分支历史上）。不会修改任何目标仓库工作流。

版本标签运行和默认分支的失败走同一套处理：同样作为 `actions.run_failed` 事件交给 Manager，同一 `repository + run id + attempt` 重复投递只处理一次。为了让 Manager 和分析任务区分，事件摘要和分析任务的标题写明「版本标签运行」和标签名，事件和 `run.json` 里的 `run` 用 `tag_run: true` 和 `tag` 代替 `branch`，分析可以按需要在正文说明标签。它和「发版本」是两件事：本功能不读写发版本记录，不影响发版本页面的流程；发版本页面请求的 CI 观察和发行说明（`release.observe`、`release.notes`）照旧是独立任务，不依赖本功能，两者互不取消。

首次开启保存精确的 `enabled_at`。已经在该时刻前完成的运行不补报，之前开始且仍在运行的任务会跟踪到完成。为发现这种较早开始的运行，首次扫描读取历史 run 的元数据，但不读取已完成历史运行的日志、不处理其失败。之后只扫描新增创建时间窗口；已发现的未完成 run 单独轮询。

重跑不改变 run 的创建时间，创建时间窗口不会再返回已结束且不在跟踪中的 run。这类重跑首先由 `workflow_run.completed` 事件送达；为防投递丢失，每 10 分钟再列一次最近 72 小时创建的 run，取最新一次 attempt 已结束、结论为 failure、在开启之后完成且尚未记录的 attempt，按同一个 `repository + run id + attempt` 记录处理。GitHub 单次查询最多返回 1,000 条，更早的部分仍依赖事件。

GitHub 的 run 列表支持 `created` 范围，不支持完成时间范围。扫描使用固定创建时间上下界，且不按可变的 status 过滤，避免运行完成或重跑时改变分页成员。窗口结束时间落后当前时间 2 秒；相邻周期重叠一个创建时间秒，由 run/attempt 去重。超过 API 1,000 条查询上限时，先按创建时间对半拆分窗口；单秒也超过上限则显示错误并保留位置，不跳过。

窗口、页号、当前页内容及页内位置保存在 SQLite。每项成功处理或安全忽略后推进页内位置，当前页全部处理后才推进页号；失败页在重启后继续。未完成运行写入独立跟踪表就算已接收，它的最终结果仍需处理。已跟踪 run 逐条隔离处理错误，失败项保留扫描位置。扫描不依赖收到 webhook，两个入口共用 `repository + run id + attempt` 记录。

## 调查、重跑与提报

`../context/run.json` 提供 run、attempt、提交和失败 job 的日志摘录。任务可用 `read_job_log` 查看更多日志，结合源代码、产物和相关运行判断原因。任务用 `submit_report` 记录调查结果。扫描记录可在 Manager 完成分派后结算，调查进度和交付结果在任务详情中查看。

当证据支持所有失败 job 都因临时外部问题失败时，有权限的任务可用 `rerun_failed_run` 重跑原运行的失败作业。工具核对该 attempt 仍是最新的已完成失败，并按仓库和 run 保留一次预算。旧处理器已发送或发送结果不明的重跑也占用预算。

有必要提报时，任务先搜索现有开放 Issue。若已有单据记录同一问题，可用 `github_write` 补充新证据。新建 Issue 优先遵循目标仓库的 `.github/ISSUE_TEMPLATE/`、`CONTRIBUTING.md`、`AGENTS.md` 和相关 `.agents/skills/`，包括仓库规定的语言、模板字段、标签和责任人。没有约定时，可简述失败运行链接和触发提交、失败现象和关键日志，以及初步原因。标题、语言和正文结构由仓库约定和调查需要决定。新建后的检视和开发走普通 Issue 事件与项目规则。

任务也会收到[定时运行延迟指引](prompts/late-schedules.md)。发现持续延迟时，可查重并通过 `github_write` 提出建议，或者把建议写入任务报告。

## 升级与验证

升级保留历史扫描、运行、attempt、Issue 和发布回执。未分派的旧事件由 Manager 创建通用任务，已有专用调查仍可结束并保留内部报告，旧发布回执留作查询。历史任务和 Issue 可以继续通过原有记录查阅。

`test/st/src/actions/actions-failures.test.mjs` 使用签名 webhook、SQLite、GitHub 和模型夹具覆盖分派、扫描分页恢复、历史数据保留、通用 Issue 写入和重跑权限。`test/e2e/projects/actions-failures.spec.mjs` 覆盖管理页面的开关与配置错误。
