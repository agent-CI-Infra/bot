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
| `issue.labeled` | 有人（不是 App）加上项目登记的标签，或开发标签（同时提供开发和回应标签的检视） | 标签列表；开发标签另有开关 |
| `pull_request.opened` | PR 打开或 Ready for review | `review_pull_requests` |
| `pull_request.synchronize` | PR 推送新提交 | `review_pr_updates` |

`pull_request.opened` 和 `pull_request.synchronize`（以及检视发现的新 head）不会立刻交给 Manager。控制面先记下该 head，等目标分支的必需检查（规则集或分支保护）全部完成且通过后再分派 `review.pr`。检查失败或等待超时（默认 60 分钟）时不开始检视，并在 PR 上留言说明；推送新的 head 且新 head 检查通过后才会再检视。同一 SHA 只检视一次。没有配置必需检查时，等该 SHA 上已出现的检查结束；宽限期（2 分钟）内没有任何检查，按「仓库没有 CI」开始检视。有人评论、提到 bot 或提交检视等更新仍立刻分派，不等待 CI。完成检查的 webhook（`check_run`、`check_suite`、`workflow_run`、`status`）会尽快唤醒等待；未订阅这些事件时，控制面会轮询检查状态（需要 `checks:read` 与 `statuses:read`，不必把这些事件加进基线 App 订阅）。

| `pull_request.updated` | PR 修改、可信讨论、提交检视、回复检视意见 | `review_pr_discussion`，默认还要 `review_pull_requests` 开着 |
| `pull_request.mention` | PR 上的评论提到 bot | 默认跟随 `review_pull_requests` |
| `pull_request.labeled` | 有人给 PR 加上项目登记的标签 | 标签列表 |
| `review.published` | 检视发布：Issue 上有人加的开发标签时的 Issue 检视，或 bot PR 的检视采纳了修改要求、发现可执行问题 | `review.published.issue`、`review.published.pr` |
| `release.manual` | 「发版本」页请求 CI 观察或起草发行说明 | 对应工作类型的开关 |
| `actions.run_failed` | 默认分支的 Actions 运行失败 | Actions 失败处理的开关 |
| `gate.manual` | 「接入门禁」对话里开始或回复 | 接入门禁的开关 |
| `schedule.due` | `manager.check` 定时计划到期 | 定时检查的开关 |

五个策略字段沿用原来的名字和 `PATCH /api/repositories/:id/policy`，含义从「检视这类事件」变为「把这类事件交给 Manager」。其余开关和标签列表保存在策略的 `event_filters` 里；在 Manager 页单独保存过的开关不再跟随打开开关。

## 分派

每个事件写成 `dispatch_events` 里的一条记录，`event_key` 唯一，同一事件只记录一次（重复投递、同一 PR head 的 webhook 和检视发现的新 head 都是同一个事件）。记录里有控制面算好的选项：

- **新建选项**：完整的任务规格（类型、对象、head、输入、唯一键），只在开发开关、人加的开发标签、修订预算、一次一个修订等控制面条件满足时才出现。检视结论是否支持开发、有没有指派人，是 Manager 的判断，写在事件的 `facts` 里；
- **续接选项**：同一项目同一对象上还没开始发布的检视（PR 还要求同一 head），在分派时重新查询。

后台的分派器逐条认领事件（带租约），交给 Manager 跑一轮普通的 agent 循环（#381）：系统提示是固定的分派规则，后面是完整 Manager 分派提示词；用户消息是事件摘要、同一对象上最近的任务、选项（每个新建选项附带它的写入）和本事件已经做过的 GitHub 写入。循环里 Manager 可以按角色权限用 `github_read`、`github_search`、`read_job_log` 读取事件所在仓库，用 `github_write` 写这个仓库（例如请作者补充信息的评论、分类标签），每一步之前续租。工具说明见[共享 Agent 后端](agent-runtime.md#github-写入github_write)。最多 16 步，最后一步只能分派。模型最后用 `dispatch` 工具回答一种结果：

- `create`：一到三个新建选项，可附简要说明（目标和验收标准），可收窄写入；
- `continue`：一个续接选项，事件作为更新交给那个检视，它在发布前回应；
- `ignore`：不创建或续接任务；此前已授权工具操作的结果保留在各自的写入账本中。

三种结果都必须写理由。选「开发 Issue」而检视没有给出实现目标时必须附简要说明。选了没提供的选项、缺少必需的简要说明、多要写入或格式不对时，在同一轮里把错误交回模型改一次，仍不合格就按失败处理。模型优先读 `task_models.manager`，没有时用项目默认模型。分派不保留会话，每次只读取事件和任务事实。

Manager 的写入只能落在本事件所在的仓库：`github_write` 没有仓库参数，路径相对这个仓库，不设次数上限，每次写入都记审计。每次写入带 key，按事件去重：重新分派时用户消息列出已经做过的写入，同一个 key 直接返回上次的结果，不会再写一遍。默认只有 Manager 有 GitHub 写权限（Issue、Pull Request、Contents）；在「角色 → Manager」把这些资源改成只读后，分派时不再提供 `github_write`。

决定在一个事务里落地：新建任务、写续接、记录理由，并通知拥有这个事件的模块。新建任务的输入里有 `manager`（事件 id、理由、简要说明、收窄后的写入），执行时作为说明交给 agent，不能扩大范围、写入或控制面条件；任务日志有一条 `dispatch` 记录，`task_events` 把任务和事件关联起来。

人工重试仍使用原事件编号，事务中先把失败原因和原轮尝试次数保存到 `dispatch_retries`，再把同一事件改回等待；重复重试已非失败状态的事件返回 409，不新增重试记录。详情保留最近 50 条人工重试，当前轮的结果、尝试次数与原失败分开展示，重启后仍可读取。

失败的分派按 5 秒、15 秒、45 秒……最长 10 分钟重试，第 8 次仍失败时标为 `failed`，等人在事件记录里点「重试」；等待结果的模块会收到「没有决定」并停止等待。进程重启时认领中的事件回到待分派；再决定一次也不会重复建任务，因为任务规格带唯一键、续接按事件去重。

## Manager 提示词

Manager 分派提示词在「角色 → Manager」里作为一份完整文本编辑。新项目显示完整的内置默认提示词，保存后整份替换；普通 Markdown 标题没有章节 id 语义。控制面仍固定校验可选任务、对象和写入范围。`PUT /api/repositories/:id/manager` 的 `prompt` 字段保存这份文本，并用 `expected_revision` 防止覆盖别人的修改。

升级前的章节配置继续作为任务规则保留，原有项目指令会合入首次显示的完整 Manager 文本。新分派提示词单独版本化保存在 `manager_dispatch_prompts`；编辑任务规则或事件开关不会覆盖它，旧任务的规则快照和权限保持原有约束。旧 `content` 字段供兼容客户端编辑已有任务规则，界面不再暴露章节编辑器。

项目界面不再展示「工作类型：开关、写入与设置」表格。工作类型标识仍用于内部任务分类、模型覆盖和既有权限校验。

## 工作类型

| 工作类型 | 任务类型 | 可选写入（默认／固定） |
| --- | --- | --- |
| 检视 Issue `review.issue` | `review.issue` | 回复评论（默认，固定）、加分类标签（默认）、修改代码、开 PR |
| 检视 PR `review.pr` | `review.pr` | 同上 |
| 开发 Issue `development.issue` | `development.issue` | 修改代码、开 PR（默认，固定） |
| 跟进 bot PR `development.pr` | `development.pr` | 同上 |
| 通用回复 `reply` | `workflow.issue`、`workflow.pr` | 回复评论（默认）、加分类标签、修改代码、开 PR；默认关闭 |
| CI 观察 `release.observe` | `release.observe` | 无 |
| 发行说明 `release.notes` | `release.notes` | 写发行说明（默认） |
| Actions 失败处理 `actions.failures` | `actions.failures` | 重跑失败的运行、提报 Issue（默认）；默认关闭 |
| 接入门禁 `gate.onboarding` | `gate.onboarding` | 提交门禁方案（固定） |
| 定时检查 `task.request` | `task.request` | 修改代码、开 PR（默认都不选） |

每个工作类型在项目配置里有开关和写入（策略的 `work_settings`，Actions 失败处理沿用 `actions_failures_enabled`），模型在 `task_models` 里按工作类型 id 保存。检视和开发类型还受项目的检视、开发总开关约束。写入只能在可选范围内选，固定的写入不能去掉，开 PR 必须同时允许修改代码；不合规时返回 400 `invalid_work_writes`。

一个任务实际可用的写入是三者的交集：项目当前的写入、任务创建时的快照、Manager 为它收窄后的写入。之后收窄项目写入会立刻收窄运行中的任务；放宽项目写入不会让已有任务超过它创建时的范围。事件内容和 Manager 都不能扩大写入。所有 GitHub 写入仍由控制面完成，agent 只拿得到只读令牌。

工作类型的写入是框架交付：检视结论（`finish_review`）、从测试通过的候选发布 PR、Actions 重跑与失败提报、发行说明和门禁方案。它们沿用各自的流程，只看工作类型的写入，不再要求执行角色有 GitHub 写权限（#381），所以只读的内置角色照常交付。除此之外的直接写入（例如提报一个后续 Issue）统一用 `github_write`，由执行角色的 GitHub 资源权限决定是否提供；「提报 Issue」写入只留给 Actions 失败处理的 `report_failure`，升级时其他工作类型保存过的这项写入会被忽略。

## 控制面模块

下面这些仍是控制面模块，Manager 只能选择是否让它们产生任务，不能改它们的校验规则：

- **CI 观察**：请求写成事件，发布记录在 `observation_event` 里等待决定；建了任务才有 `observation_task`，不处理时 `observation_error` 写明 Manager 的理由。
- **发行说明**：控制面核验每个来源恰好出现一次，标题和链接由控制面写出；Manager 不处理时按内置规则直接列出来源。
- **Actions 失败处理**：日志引用核验、单次重跑预算和同一失败只报一次不变；Manager 不处理时这次失败记为 `ignored`，不重跑也不提报。
- **接入门禁**：方案只回到对话里，人确认后才开门禁 PR；Manager 不处理时对话里写明原因，可以再发一次。
- **定时检查**：计划的 `workflow` 写 `manager.check`，`parameters.instruction` 写要检查什么；到期时成为 `schedule.due` 事件，Manager 可以新建一项只读的通用任务（任务的执行身份是计划的服务主体）。
- 合并队列、发布 outbox、对账、PR head 校验、bot 分支归属、开发标签必须由人加上并在发布前仍在、发布前测试都不变。

## 升级迁移

升级后第一次启动时，控制面对每个项目做一次迁移，在一个事务里完成后删除 `workflows` 表：

- 规则文件的控制台覆盖成为检视、开发、标签、行为指南章节；CI 观察、发行说明、Actions 失败处理、接入门禁的控制台提示词成为对应章节；
- 自定义工作流成为「通用回复」章节下的小节，写明原来的说明、触发源和写入；它们的写入取并集作为「通用回复」的写入，模型成为 `task_models.reply`，有任一开着的自定义工作流时「通用回复」打开；
- 内置工作流保存过的开关和写入成为工作类型的设置；
- 开着的工作流的触发源取并集成为事件开关和标签列表；触发源和默认流程不一致时（保存过触发源、关掉过内置工作流或有自定义工作流），「分派」章节附一张「升级前的触发配置」表，按事件列出原来启动的工作，Manager 按表分派；
- 原来的工作流行、相关策略字段和迁移报告（含需要人留意的差异，例如写入取并集、多个模型）保存在 `manager_migrations`，迁移产生的提示词是第 1 版，来源 `migration`，审计记录 `manager.migrated`。

迁移前已经开始的阶段计划继续使用原来工作流行的指纹，不会因为升级暂停；之后改动某个工作类型的设置或章节，才会像以前修改工作流一样使旧的阶段结果失效。

## 控制台分派记录

在「角色 → Manager → 最近的分派」按收到时间、状态、决定和事件类型筛选。输入时间按浏览器时区解释，开始时间包含边界，结束时间不包含边界；更早记录使用稳定游标，期间新收到的事件不会把已读记录重复挤到下一页。详情按触发事件、Manager 判断、关联任务和人工重试展示；“不分派任务”只描述任务分派，不表示没有进行过工具操作，地址中的 `dispatch` 参数可恢复同一事件；模型字段仅是当时记录的名称，没有模型配置版本时不推断。读取失败保留上次记录并提示范围可能过期，首次失败明确未知；权限失效清空列表和详情，离开项目后的迟到响应不写回当前页。

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/repositories/:id/manager` | GET | 提示词（`revision`、`content`）、各章节（内置文本、是否写过、实际来源和生效文本）、工作类型（开关、写入、可选写入、模型）、分派模型、事件开关、规则来源和迁移记录 |
| `/api/repositories/:id/manager` | PUT | `expected_revision` 必填，`prompt`（完整分派提示词）、旧 `content`（任务规则）、`work`（`{<工作类型>: {enabled, writes}}`）、`events`（事件开关和标签列表）可选；经管理服务的 `manager.update` 命令执行，审计相同；版本不一致返回 409 `manager_revision_conflict` |
| `/api/repositories/:id/dispatch` | GET | 事件记录，最新在前：类型、摘要、状态、结果、理由、简要说明、新建或续接的任务、模型、失败原因；`state`、`decision`（create/continue/ignore）、`type`、`from`（含）/`until`（不含，UTC ISO 时间）、`limit`（1–100）可选；`next_cursor` 用于更早分页，原 `offset` 仍兼容但不能和 cursor 同用。游标绑定项目与筛选，改变筛选后重新读取首页 |
| `/api/repositories/:id/dispatch/:event` | GET | 本项目的事件摘要、来源、原投递编号、已记录的模型名称、当前状态、实际关联任务和最近 50 条人工重试。排除原始 facts、候选任务输入、租约及凭据；不以当前模型配置补写历史 |
| `/api/repositories/:id/dispatch/:event/retry` | POST | 重试失败的分派 |
| `/api/tasks/:id/dispatch` | GET | 任务因哪些事件新建或续接，以及 Manager 的理由 |
| `/api/repositories/:id/workflows[/...]` | 任意 | 410 `workflows_removed`，说明里给出替代路径 |

管理服务的 `manager.update` 命令和上面的 PUT 相同；`get_effective_config` 返回 `manager`，另外的 `workflows` 按旧格式列出各工作类型的生效提示词，供旧客户端读取。旧命令 `workflow.update` 仍可用，`target.workflow_id` 是工作类型 id，只接受 `prompt`（改写该工作类型的章节）、`enabled` 和 `writes`；`triggers`、`model_id`、`settings`、`name` 等返回 410，说明里写明去处。

## 看板与统计

看板按工作类型分卡：检视 Issue、检视 PR、开发 Issue、跟进 bot PR、通用回复，以及「发版本」。原自定义工作流的任务都归入「通用回复」卡片；以前保存的视图里的 `custom.<id>` 筛选按「通用回复」处理，`review`、`development` 仍表示全部检视和全部开发。`GET /api/board` 的 `workflows` 字段保留原名，列出这些工作类型。用量统计同样按工作类型汇总，字段 `workflow` 是工作类型 id。
