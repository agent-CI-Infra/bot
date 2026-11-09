# 项目 Manager 与工作类型

从 #207 起，项目不再配置「工作流」。每个项目只配置 **Manager 提示词**（项目唯一的流程定义）和角色；控制面把通过过滤的每个事件交给 Manager 分派一次，由它决定新建任务、续接已有任务，还是不处理，并写下理由。任务创建之后照旧由 Task 引擎执行：队列、claim、合同、候选、独立 QA、阶段调度和 Publisher 都不变，见[持久化角色调度](role-scheduling.md)。

升级时，原来的工作流配置会一次性迁入 Manager 提示词和项目配置，并留下迁移记录，见下文「升级迁移」。工作流页、工作流助手和 `/api/repositories/:id/workflows` 已删除。

## 事件怎样到达 Manager

控制面先按确定的条件过滤，被过滤的事件不会到达 Manager，也不写事件记录：

- 安装范围、项目未启用、仓库外人员的评论（只认对象作者和 `OWNER`、`MEMBER`、`COLLABORATOR`）、bot 自己写的内容（例外：bot 自己开的 PR 上，其他检视机器人的评论和检视）、草稿和已关闭的对象、PR head 校验；
- 项目关掉的事件（见下表）；
- 没有任何可选处理方式的事件：它能导致的工作类型都关着，也没有可以续接的任务。

| 事件 | 含义 | 开关 |
| --- | --- | --- |
| `issue.opened` | Issue 打开 | 策略字段 `review_issues` |
| `issue.updated` | Issue 标题或正文修改、可信评论 | `review_issue_updates`，默认还要 `review_issues` 开着 |
| `issue.mention` | 评论提到 `BOT_MENTION_NAMES` 里的名字 | 默认跟随 `review_issues` |
| `issue.labeled` | 有人（不是 App）加上项目登记的标签，或开发标签 | 标签列表；开发标签另有开关 |
| `pull_request.opened` | PR 打开或 Ready for review | `review_pull_requests` |
| `pull_request.synchronize` | PR 推送新提交 | `review_pr_updates` |
| `pull_request.updated` | PR 修改、可信讨论、提交检视、回复检视意见 | `review_pr_discussion`，默认还要 `review_pull_requests` 开着 |
| `pull_request.mention` | PR 上的评论提到 bot | 默认跟随 `review_pull_requests` |
| `pull_request.labeled` | 有人给 PR 加上项目登记的标签 | 标签列表 |
| `review.published` | 检视发布：Issue 检视找到 Issue 要求的代码修改且开发条件满足，或 bot PR 的检视采纳了修改要求、发现可执行问题 | `review.published.issue`、`review.published.pr` |
| `release.manual` | 「发版本」页请求 CI 观察或起草发行说明 | 对应工作类型的开关 |
| `actions.run_failed` | 默认分支的 Actions 运行失败 | Actions 失败处理的开关 |
| `gate.manual` | 「接入门禁」对话里开始或回复 | 接入门禁的开关 |
| `schedule.due` | `manager.check` 定时计划到期 | 定时检查的开关 |

五个策略字段沿用原来的名字和 `PATCH /api/repositories/:id/policy`，含义从「检视这类事件」变为「把这类事件交给 Manager」。其余开关和标签列表保存在策略的 `event_filters` 里；在 Manager 页单独保存过的开关不再跟随打开开关。

## 分派

每个事件写成 `dispatch_events` 里的一条记录，`event_key` 唯一，同一事件只记录一次（重复投递、同一 PR head 的 webhook 和检视发现的新 head 都是同一个事件）。记录里有控制面算好的选项：

- **新建选项**：完整的任务规格（类型、对象、head、输入、唯一键），只在开发条件、修订预算、一次一个修订等控制面条件满足时才出现；
- **续接选项**：同一项目同一对象上还没开始发布的检视（PR 还要求同一 head），在分派时重新查询。

后台的分派器逐条认领事件（带租约），调用一次 Manager：系统提示是固定的分派规则，后面是 Manager 提示词的前言、「分派」章节和项目写过的其他章节；用户消息是事件摘要、同一对象上最近的任务和选项（每个新建选项附带它的写入）。模型用 `dispatch` 工具回答一种结果：

- `create`：一到三个新建选项，可附简要说明（目标和验收标准），可收窄写入；
- `continue`：一个续接选项，事件作为更新交给那个检视，它在发布前回应；
- `ignore`：不处理。

三种结果都必须写理由。选了没提供的选项、多要写入或格式不对时，同一次调用里把错误交回模型改一次，仍不合格就按失败处理。模型优先读 `task_models.manager`，没有时用项目默认模型。分派调用不保留会话，每次只读取事件和任务事实。

决定在一个事务里落地：新建任务、写续接、记录理由，并通知拥有这个事件的模块。新建任务的输入里有 `manager`（事件 id、理由、简要说明、收窄后的写入），执行时作为说明交给 agent，不能扩大范围、写入或控制面条件；任务日志有一条 `dispatch` 记录，`task_events` 把任务和事件关联起来。

失败的分派按 5 秒、15 秒、45 秒……最长 10 分钟重试，第 8 次仍失败时标为 `failed`，等人在事件记录里点「重试」；等待结果的模块会收到「没有决定」并停止等待。进程重启时认领中的事件回到待分派；再决定一次也不会重复建任务，因为任务规格带唯一键、续接按事件去重。

## Manager 提示词

提示词是 Markdown，在项目「Manager 与角色」页编辑，每次保存是一版（`manager_revisions`）。二级标题以反引号里的章节 id 结尾时开始一个章节，例如 `## 检视 Issue \`review.issue\``；第一个章节之前的文字是前言，和「分派」章节一起交给 Manager。没写的章节使用内置文本。

| 章节 id | 用途 | 内置文本 |
| --- | --- | --- |
| `dispatch` | 哪类事件需要哪种工作、何时续接或不处理 | `docs/prompts/manager-dispatch.md` |
| `review.issue` | 检视 Issue | `.bot/rules/issue-review.md` 的内置层 |
| `review.pr` | 检视 PR | `.bot/rules/pr-review.md` 的内置层 |
| `development` | 开发 Issue 和跟进 bot PR，第一行 `development_label:` 是开发标签 | `.bot/rules/issue-development.md` 的内置层 |
| `labels` | 检视标签和分类标签 | `.bot/rules/labels.md` 的内置层 |
| `guide` | 所有任务的行为指南 | `.bot/guide.md` 的内置层 |
| `reply` | 通用回复任务做什么（原自定义工作流迁到这里） | 空 |
| `release.observe` | CI 观察 | `docs/prompts/release-observe.md` |
| `release.notes` | 发行说明 | 默认分支的 `.agents/skills/release-notes/SKILL.md` 优先；都没有时用内置规则直接列出来源 |
| `actions.failures` | Actions 失败处理 | `docs/prompts/actions-failures.md` |
| `gate.onboarding` | 接入门禁 | `docs/prompts/gate-onboarding.md` |
| `schedule` | 定时检查做什么 | 空 |

检视、开发、标签和行为指南这几个章节就是对应 `.bot` 规则文件的控制台层：默认分支上的仓库文件仍然整份替换它，`PUT /api/repositories/:id/rules` 也改写同一个章节。开发标签那一行的校验不变，删掉仍按 `bot-develop` 要求。

提示词只描述流程，不能授予任何权限：写在提示词里的「允许提报 Issue」之类的话不会改变写入，写入只来自下一节的项目配置。

## 工作类型

| 工作类型 | 任务类型 | 可选写入（默认／固定） |
| --- | --- | --- |
| 检视 Issue `review.issue` | `review.issue` | 回复评论（默认，固定）、加分类标签（默认）、修改代码、开 PR、提报 Issue |
| 检视 PR `review.pr` | `review.pr` | 同上 |
| 开发 Issue `development.issue` | `development.issue` | 修改代码、开 PR（默认，固定）、提报 Issue |
| 跟进 bot PR `development.pr` | `development.pr` | 同上 |
| 通用回复 `reply` | `workflow.issue`、`workflow.pr` | 回复评论（默认）、加分类标签、修改代码、开 PR、提报 Issue；默认关闭 |
| CI 观察 `release.observe` | `release.observe` | 提报 Issue |
| 发行说明 `release.notes` | `release.notes` | 写发行说明（默认）、提报 Issue |
| Actions 失败处理 `actions.failures` | `actions.failures` | 重跑失败的运行、提报 Issue（默认）；默认关闭 |
| 接入门禁 `gate.onboarding` | `gate.onboarding` | 提交门禁方案（固定） |
| 定时检查 `task.request` | `task.request` | 无 |

每个工作类型在项目配置里有开关和写入（策略的 `work_settings`，Actions 失败处理沿用 `actions_failures_enabled`），模型在 `task_models` 里按工作类型 id 保存。检视和开发类型还受项目的检视、开发总开关约束。写入只能在可选范围内选，固定的写入不能去掉，开 PR 必须同时允许修改代码；不合规时返回 400 `invalid_work_writes`。

一个任务实际可用的写入是三者的交集：项目当前的写入、任务创建时的快照、Manager 为它收窄后的写入。之后收窄项目写入会立刻收窄运行中的任务；放宽项目写入不会让已有任务超过它创建时的范围。事件内容和 Manager 都不能扩大写入。所有 GitHub 写入仍由控制面完成，agent 只拿得到只读令牌。

## 控制面模块

下面这些仍是控制面模块，Manager 只能选择是否让它们产生任务，不能改它们的校验规则：

- **CI 观察**：请求写成事件，发布记录在 `observation_event` 里等待决定；建了任务才有 `observation_task`，不处理时 `observation_error` 写明 Manager 的理由。
- **发行说明**：控制面核验每个来源恰好出现一次，标题和链接由控制面写出；Manager 不处理时按内置规则直接列出来源。
- **Actions 失败处理**：日志引用核验、单次重跑预算和同一失败只报一次不变；Manager 不处理时这次失败记为 `ignored`，不重跑也不提报。
- **接入门禁**：方案只回到对话里，人确认后才开门禁 PR；Manager 不处理时对话里写明原因，可以再发一次。
- **定时检查**：计划的 `workflow` 写 `manager.check`，`parameters.instruction` 写要检查什么；到期时成为 `schedule.due` 事件，Manager 可以新建一项只读的通用任务（任务的执行身份是计划的服务主体）。
- 合并队列、发布 outbox、对账、PR head 校验、bot 分支归属、开发标签和指派人条件、发布前测试都不变。

## 升级迁移

升级后第一次启动时，控制面对每个项目做一次迁移，在一个事务里完成后删除 `workflows` 表：

- 规则文件的控制台覆盖成为检视、开发、标签、行为指南章节；CI 观察、发行说明、Actions 失败处理、接入门禁的控制台提示词成为对应章节；
- 自定义工作流成为「通用回复」章节下的小节，写明原来的说明、触发源和写入；它们的写入取并集作为「通用回复」的写入，模型成为 `task_models.reply`，有任一开着的自定义工作流时「通用回复」打开；
- 内置工作流保存过的开关和写入成为工作类型的设置；
- 开着的工作流的触发源取并集成为事件开关和标签列表；触发源和默认流程不一致时（保存过触发源、关掉过内置工作流或有自定义工作流），「分派」章节附一张「升级前的触发配置」表，按事件列出原来启动的工作，Manager 按表分派；
- 原来的工作流行、相关策略字段和迁移报告（含需要人留意的差异，例如写入取并集、多个模型）保存在 `manager_migrations`，迁移产生的提示词是第 1 版，来源 `migration`，审计记录 `manager.migrated`。

迁移前已经开始的阶段计划继续使用原来工作流行的指纹，不会因为升级暂停；之后改动某个工作类型的设置或章节，才会像以前修改工作流一样使旧的阶段结果失效。

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/repositories/:id/manager` | GET | 提示词（`revision`、`content`）、各章节（内置文本、是否写过、实际来源和生效文本）、工作类型（开关、写入、可选写入、模型）、分派模型、事件开关、规则来源和迁移记录 |
| `/api/repositories/:id/manager` | PUT | `expected_revision` 必填，`content`、`work`（`{<工作类型>: {enabled, writes}}`）、`events`（事件开关和标签列表）可选；经管理服务的 `manager.update` 命令执行，审批和审计相同；版本不一致返回 409 `manager_revision_conflict` |
| `/api/repositories/:id/dispatch` | GET | 事件记录，最新在前：类型、摘要、状态、结果、理由、简要说明、新建或续接的任务、模型、失败原因；`state`、`limit`、`offset` 可选 |
| `/api/repositories/:id/dispatch/:event/retry` | POST | 重试失败的分派 |
| `/api/tasks/:id/dispatch` | GET | 任务因哪些事件新建或续接，以及 Manager 的理由 |
| `/api/repositories/:id/workflows[/...]` | 任意 | 410 `workflows_removed`，说明里给出替代路径 |

管理服务的 `manager.update` 命令和上面的 PUT 相同；`get_effective_config` 返回 `manager`，另外的 `workflows` 按旧格式列出各工作类型的生效提示词，供旧客户端读取。旧命令 `workflow.update` 仍可用，`target.workflow_id` 是工作类型 id，只接受 `prompt`（改写该工作类型的章节）、`enabled` 和 `writes`；`triggers`、`model_id`、`settings`、`name` 等返回 410，说明里写明去处。

## 看板与统计

看板按工作类型分卡：检视 Issue、检视 PR、开发 Issue、跟进 bot PR、通用回复，以及「发版本」。原自定义工作流的任务都归入「通用回复」卡片；以前保存的视图里的 `custom.<id>` 筛选按「通用回复」处理，`review`、`development` 仍表示全部检视和全部开发。`GET /api/board` 的 `workflows` 字段保留原名，列出这些工作类型。用量统计同样按工作类型汇总，字段 `workflow` 是工作类型 id。
