# 项目 Manager 与工作类型

从 #207 起，项目不再配置「工作流」。每个项目只配置 **Manager 提示词**（项目唯一的流程定义）和角色；控制面把通过过滤的每个事件交给 Manager 分派一次，由它决定新建任务、续接已有任务，还是不处理，并写下理由。任务创建之后照旧由 Task 引擎执行：队列、claim、合同、候选、独立 QA、阶段调度和 Publisher 都不变，见[持久化角色调度](role-scheduling.md)。

升级时，原来的工作流配置会一次性迁入 Manager 提示词和项目配置，并留下迁移记录，见下文「升级迁移」。工作流页、工作流助手和 `/api/repositories/:id/workflows` 已删除。

## 项目监听与触发

项目设置中的「监听与触发」（`#/projects/<id>/triggers`）集中管理项目的能力上限、事件来源和标签触发。它是项目设置的一级入口，不属于 Manager 角色；基本设置、角色概览和 Manager 页只提供链接。Manager 提示词、模型、角色权限与预算仍在「角色 → Manager」编辑，分派记录也保留在那里。

新启动的开发、普通任务、检视和 Actions 分析默认由 Manager 安排，无需协调总开关或按任务类型交给主控。项目启停、任务暂停、事件信任与防循环、已授予的权限、预算、独立 QA 及发布检查继续生效。

## 项目能力上限

每个项目有一个能力上限（策略字段 `capability_ceiling`，#850），决定 bot 在这个项目里最多能写到哪一步：

| 档位 | 含义 | GitHub 写入 |
| --- | --- | --- |
| `read` 只读问答 | 在飞书和控制台里回答、检视讨论 | 无 |
| `comment` 可评论和打标签 | 评论、加标签、提 Issue、发检视，Actions 失败可以重跑一次 | Issues、Pull requests |
| `develop` 可开发并开 PR | 还可以改代码、交付 bot PR | 再加 Contents（文件、分支和引用、合并 PR） |

合并 PR 是 Contents 写，包含在 `develop` 里，Manager 默认就有，不单设一档。上限在启动项目时选择（默认 `comment`；受信任组织可以预设它下面的项目启动时的档位，见[管理员手册](admin.md)），之后由项目管理员在「监听与触发」修改。bot 的每一次写入都在上限之内：

- 工作类型：检视、通用回复和 Actions 失败处理要 `comment`，开发和开发任务要 `develop`；普通事项、CI 观察和发行说明在任何档位都能运行。工作类型的写入（默认值或项目保存的值）超过上限的部分不生效，降回上限后自动恢复。普通事项的写入默认继承上限：`develop` 时可以修改代码并交付 PR。
- `github_write`：Issues 和 Pull requests 路由要 `comment`，Contents 路由要 `develop`。项目角色、飞书群、管理助手都经同一个入口，超过上限时返回 `capability_ceiling`，带 `needed`（需要的档位）和 `ceiling`（项目当前档位），不发出任何请求。角色的 GitHub 写权限、群档位和私聊里本人的权限都只能在上限之下再收窄。
- 交付代码：上限低于 `develop` 时，给任务授予 `pull_request`（建任务时的 `writes`、`intent=development`、PR 终点，或之后的 `grant_writes`）返回 403 `capability_ceiling`（`detail.needed` 为 `develop`），Manager 的 `create_task`／`grant_writes` 得到同样的拒绝并可以改做报告。普通任务开 PR 前默认还要独立 QA 通过，项目可以在「能力上限」里关掉这道门槛，关掉后仍要通过项目测试命令；没有配置测试命令的项目仍要独立 QA。
- 事件开关只决定哪些 GitHub 事件交给 Manager，不增加写权限。

调低上限不会取消任务：需要更高档位的任务在下一个工具调用前停下，状态为 `waiting_permission`、原因 `capability_ceiling_lowered`，已有改动保留；调回足够的档位后点「重试」继续。项目禁用（`enabled=false`）仍会结束任务。

策略接口直接设 `capability_ceiling`。原来的 `review_enabled`、`development_enabled` 仍然可以写，并换算成上限：检视开是至少 `comment`、关是 `read`，开发开是 `develop`、关是至多 `comment`；同一请求里不能和 `capability_ceiling` 同时出现，也不能"开开发、关检视"。读到的这两个字段总是与上限一致。

升级时每个项目按原来的开关和写入取最窄的一档：开发开是 `develop`；否则检视开、Actions 失败处理开或通用回复开是 `comment`；否则 `read`。原来开着开发却关着检视的项目，上限为 `develop`，同时把两个检视工作类型关掉，保持升级前的写入不变；普通事项原来默认不写，没有保存过写入的项目升级时把它保存为不写，不会因为继承上限多出交付 PR。角色的 GitHub 写权限不参与推导：Manager 默认带的 Contents 写（合并、写分支）在 `develop` 以下的项目里不再生效，`read` 的项目里角色不能经 `github_write` 写。受信任组织原来保存的「启动时开启开发」换算为 `develop`，没开的为 `comment`（启动一直会打开检视）。审计里记录每个项目的 `policy.capability_ceiling_migrated`，之后每次修改记 `policy.capability_ceiling`。

升级或移动页面不会开启以前关闭的事件来源，也不会增加写授权；旧任务的配置快照和执行路线保留。开启 Actions 失败来源后即可进入自动分析流程，仍须满足项目启用、模型与实际授权等既有条件。项目监听、任务许可、Manager 提示词及角色设置分别保存，互不覆盖。现有 `GET/PUT /api/repositories/:id/manager` 保留为兼容接口；事件数据仍是项目策略，不因此归属于 Manager 角色。

## 事件怎样到达 Manager

控制面先按确定的条件过滤，被过滤的事件不会到达 Manager。由人引起的事件（打开、编辑、评论、检视、加标签、推送、提到 bot）被过滤时留一条状态为 `filtered` 的分派记录，`reason` 写明原因、`result.filtered` 是原因代码（`project_disabled`、`object_closed`、`object_draft`、`bot_own_content`、`event_filter_off`、`label_by_app`、`label_not_dispatched`、`outsider_comment`、`work_inactive` 等），在「角色 → Manager」的分派记录里按「被过滤」筛选可以看到；这类记录保留 30 天。过滤条件：

- 安装范围、项目未启用、仓库外人员的更新类评论和检视（`issue.updated`、`pull_request.updated` 只认对象作者和 `OWNER`、`MEMBER`、`COLLABORATOR`；提到 bot 的评论不按评论人过滤，见下文）、bot 自己写的内容（例外：bot 自己开的 PR 上，其他检视机器人的评论和检视）、草稿和已关闭的对象、PR head 校验；
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
| `pull_request.updated` | PR 修改、可信讨论、提交检视、回复检视意见 | `review_pr_discussion`，默认还要 `review_pull_requests` 开着 |
| `pull_request.mention` | PR 上的评论提到 bot | 默认跟随 `review_pull_requests` |
| `pull_request.labeled` | 有人给 PR 加上项目登记的标签 | 标签列表 |
| `review.published` | 检视发布：Issue 上有人加的开发标签时的 Issue 检视，或 bot PR 的检视采纳了修改要求、发现可执行问题 | `review.published.issue`、`review.published.pr` |
| `release.manual` | 「发版本」页请求 CI 观察或起草发行说明 | 对应工作类型的开关 |
| `actions.run_failed` | 默认分支的 Actions 运行失败 | Actions 失败处理的开关 |
| `schedule.due` | `manager.check` 定时计划到期 | 定时检查的开关 |

提到 bot 的评论（`issue.mention`、`pull_request.mention`）不按评论人过滤：任何人在打开的 Issue 或 PR 上 `@bot`，包括公开仓库里的仓库外人员，都会交给 Manager 分派一次，由它按提示词决定回答、检视还是不处理。这类事件只提供检视、通用回复和续接选项，不提供开发；开发仍要有人加开发标签，外人的评论不作为开发依据。Manager 自己的 `github_write` 不受事件来源限制，回应外人时由 Manager 提示词把握。

五个策略字段沿用原来的名字和 `PATCH /api/repositories/:id/policy`，含义从「检视这类事件」变为「把这类事件交给 Manager」。其余开关和标签列表保存在策略的 `event_filters` 里；在「监听与触发」页单独保存过的开关不再跟随打开开关。

## 分派

每个事件写成 `dispatch_events` 里的一条记录，`event_key` 唯一，同一事件只记录一次（重复投递、同一 PR head 的 webhook 都是同一个事件）。记录里有这个事件可以新建的工作和续接的方式：

- **可以新建的工作**：事件对象上的每种工作（检视、通用回复、开发等）和它的完整任务规格（类型、对象、head、输入、唯一键）。项目现在不允许的工作（项目停用、工作类型关闭、能力上限不够、工作类型不处理这类事件）也列给 Manager，附上原因（#815），Manager 选了它会被拒绝。人加的开发标签、修订预算等其余条件仍在提供开发时检查。检视结论是否支持开发、有没有指派人，是 Manager 的判断，写在事件的 `facts` 里；
- **续接选项**：同一项目同一对象上排队、执行中或发布中的检视；没有这些时，是这个对象最近一次已发布的检视，续接后它作为同一任务的下一轮继续（#770）。选项在分派时重新查询。PR 推送新提交也是更新：续接的检视把工作区移到新 head 继续，发布中的检视发完后在下一轮看新 head（见[架构](architecture.md#检视与开发数据流)）。还有检视可续接时，推送事件不提供「检视 PR」新建选项，同一次推送不会有两条检视。

后台的分派器逐条认领事件（带租约），交给 Manager 跑一轮普通的 agent 循环（#381）：系统提示是固定的分派规则，后面是完整 Manager 分派提示词；用户消息是事件摘要、同一对象上最近的任务、选项（每个新建选项附带它的写入）和本事件已经做过的 GitHub 写入。循环里 Manager 可以按角色权限用 `github_read`、`github_search`、`read_job_log` 读取事件所在仓库，用 `github_write` 写这个仓库（例如请作者补充信息的评论、分类标签），每一步之前续租。工具说明见[共享 Agent 后端](agent-runtime.md#github-写入github_write)。最多 16 步，最后一步只能分派。模型最后用 `dispatch` 工具回答一种结果：

- `create_task`：新建一到三项工作，可附简要说明（目标和验收标准），可收窄写入；
- `continue_task`：续接一个运行中的任务，事件作为更新交给那个检视，它在发布前回应（新提交时先转到新 head）；
- `ignore_event`：不创建或续接任务；此前已授权工具操作的结果保留在各自的写入账本中。

三种决定都必须写理由（#815 之前是一个 `dispatch` 工具在预先算好的选项里选）。`create_task` 在调用时由控制面检查：项目现在是否允许这项工作、对象上是否已有未结束的同类开发或修订、这个事件的任务是否已经建过。被拒绝时什么都不建，拒绝的代码和原因返回给 Manager 并记在事件的 `refusals` 里（分派详情里的「控制面拒绝」）；Manager 可以先用 `github_write` 回复提出请求的人，再 `ignore_event`，或者改选别的工作。一轮里被拒绝 3 次时按 `ignore` 结束，拒绝记录保留。选「开发 Issue」而检视没有给出实现目标时必须附简要说明。缺少必需的简要说明、多要写入或格式不对时，在同一轮里把错误交回模型改一次，仍不合格就按失败处理。模型优先读 `task_models.manager`，没有时用项目默认模型。分派不保留会话，每次只读取事件和任务事实。

Manager 的写入只能落在本事件所在的仓库：`github_write` 没有仓库参数，路径相对这个仓库，不设次数上限，每次写入都记审计。每次写入带 key，按事件去重：重新分派时用户消息列出已经做过的写入，同一个 key 直接返回上次的结果，不会再写一遍。默认只有 Manager 有 GitHub 写权限（Issue、Pull Request、Contents）。Contents 写包括合并 PR 和写分支（包括默认分支），所以 Manager 默认可以经 `github_write` 合并 PR；这不经过 `POST /api/tasks/:id/merge` 的校验，能否合入由仓库的分支保护和必需检查决定，见[角色池](role-pool.md#authorized-merge)。在「角色 → Manager」把这些资源改成只读后，分派时不再提供相应的写入；全部改成只读时不再提供 `github_write`。

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
| 定时检查 `task.request` | `task.request` | 修改代码、开 PR（默认都选，随能力上限生效） |

每个工作类型在项目配置里有开关和写入（策略的 `work_settings`，Actions 失败处理沿用 `actions_failures_enabled`），模型在 `task_models` 里按工作类型 id 保存。工作类型和它的写入都在项目能力上限之内生效（见上文「项目能力上限」）。写入只能在可选范围内选，固定的写入不能去掉，开 PR 必须同时允许修改代码；不合规时返回 400 `invalid_work_writes`。

一个任务实际可用的写入是三者的交集：项目当前的写入（已按能力上限收窄）、任务创建时的快照、Manager 为它收窄后的写入。之后收窄项目写入会立刻收窄运行中的任务；放宽项目写入不会让已有任务超过它创建时的范围。事件内容和 Manager 都不能扩大写入。所有 GitHub 写入仍由控制面完成，agent 只拿得到只读令牌。

工作类型的写入是框架交付：检视结论（`finish_review`）、从测试通过的候选发布 PR、Actions 重跑与失败提报和发行说明。它们沿用各自的流程，只看工作类型的写入，不再要求执行角色有 GitHub 写权限（#381），所以只读的内置角色照常交付。除此之外的直接写入（例如提报一个后续 Issue）统一用 `github_write`，由执行角色的 GitHub 资源权限和项目能力上限决定是否可用；「提报 Issue」写入只留给 Actions 失败处理的 `report_failure`，升级时其他工作类型保存过的这项写入会被忽略。

## 控制面模块

下面这些仍是控制面模块，Manager 只能选择是否让它们产生任务，不能改它们的校验规则：

- **CI 观察**：请求写成事件，发布记录在 `observation_event` 里等待决定；建了任务才有 `observation_task`，不处理时 `observation_error` 写明 Manager 的理由。
- **发行说明**：控制面核验每个来源恰好出现一次，标题和链接由控制面写出；Manager 不处理时按内置规则直接列出来源。
- **Actions 失败处理**：日志引用核验、单次重跑预算和同一失败只报一次不变；Manager 不处理时这次失败记为 `ignored`，不重跑也不提报。
- **定时检查**：计划的 `workflow` 写 `manager.check`，`parameters.instruction` 写要检查什么；到期时成为 `schedule.due` 事件，Manager 可以新建一项不交付代码的通用任务（授权身份是计划的服务主体，由 Manager 角色执行）；能力上限至少为 `comment` 时它可以经 `github_write` 提报 Issue 和评论，见[定时任务](schedules.md)。
- 合并队列、发布 outbox、对账、PR head 校验、bot 分支归属、开发标签必须由人加上并在发布前仍在、发布前测试都不变。

## 升级迁移

升级后第一次启动时，控制面对每个项目做一次迁移，在一个事务里完成后删除 `workflows` 表：

- 规则文件的控制台覆盖成为检视、开发、标签、行为指南章节（#935 起这些章节是这几条规则唯一的文本，仓库 `.bot/` 文件在升级时一次性导入，见[在角色配置里调整行为](rules.md#仓库里的-bot-文件不再读取)）；CI 观察、发行说明、Actions 失败处理的控制台提示词成为对应章节；
- 自定义工作流成为「通用回复」章节下的小节，写明原来的说明、触发源和写入；它们的写入取并集作为「通用回复」的写入，模型成为 `task_models.reply`，有任一开着的自定义工作流时「通用回复」打开；
- 内置工作流保存过的开关和写入成为工作类型的设置；
- 开着的工作流的触发源取并集成为事件开关和标签列表；触发源和默认流程不一致时（保存过触发源、关掉过内置工作流或有自定义工作流），「分派」章节附一张「升级前的触发配置」表，按事件列出原来启动的工作，Manager 按表分派；
- 原来的工作流行、相关策略字段和迁移报告（含需要人留意的差异，例如写入取并集、多个模型）保存在 `manager_migrations`，迁移产生的提示词是第 1 版，来源 `migration`，审计记录 `manager.migrated`。

「接入门禁」（`gate.onboarding`）已删除（#931）：升级时去掉它保存的开关、模型和 Manager 章节（章节的删除记为来源 `upgrade` 的新版本，旧版本和任务快照里的这一章节读取时跳过），结束未完成的门禁任务（`work_removed`），删除门禁对话记录；已完成的任务照常可读，仓库里已有的门禁文件和已开出的门禁 PR 不受影响。CI 改动改为普通开发任务交付的 bot PR，见[接入说明](onboarding-guide.md#22-ci-改动走-bot-pr)。

迁移前已经开始的阶段计划继续使用原来工作流行的指纹，不会因为升级暂停；之后改动某个工作类型的设置或章节，才会像以前修改工作流一样使旧的阶段结果失效。

## 控制台分派记录

在「角色 → Manager → 最近的分派」按收到时间、状态、决定和事件类型筛选。输入时间按浏览器时区解释，开始时间包含边界，结束时间不包含边界；更早记录使用稳定游标，期间新收到的事件不会把已读记录重复挤到下一页。详情按触发事件、Manager 判断、关联任务和人工重试展示；“不分派任务”只描述任务分派，不表示没有进行过工具操作，地址中的 `dispatch` 参数可恢复同一事件；模型字段仅是当时记录的名称，没有模型配置版本时不推断。读取失败保留上次记录并提示范围可能过期，首次失败明确未知；权限失效清空列表和详情，离开项目后的迟到响应不写回当前页。

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/repositories/:id/manager` | GET | 提示词（`revision`、`content`）、各章节（内置文本、是否写过、实际来源和生效文本）、工作类型（开关、写入、可选写入、模型）、分派模型、事件开关和迁移记录 |
| `/api/repositories/:id/manager` | PUT | `expected_revision` 必填，`prompt`（完整分派提示词）、旧 `content`（任务规则）、`work`（`{<工作类型>: {enabled, writes}}`）、`events`（事件开关和标签列表）可选；经管理服务的 `manager.update` 命令执行，审计相同；版本不一致返回 409 `manager_revision_conflict` |
| `/api/repositories/:id/dispatch` | GET | 事件记录，最新在前：类型、摘要、状态、结果、理由、简要说明、新建或续接的任务、模型、失败原因；`state`、`decision`（create/continue/ignore）、`type`、`from`（含）/`until`（不含，UTC ISO 时间）、`limit`（1–100）可选；`next_cursor` 用于更早分页，原 `offset` 仍兼容但不能和 cursor 同用。游标绑定项目与筛选，改变筛选后重新读取首页 |
| `/api/repositories/:id/dispatch/:event` | GET | 本项目的事件摘要、来源、原投递编号、已记录的模型名称、当前状态、实际关联任务和最近 50 条人工重试。排除原始 facts、候选任务输入、租约及凭据；不以当前模型配置补写历史 |
| `/api/repositories/:id/dispatch/:event/retry` | POST | 重试失败的分派 |
| `/api/tasks/:id/dispatch` | GET | 任务因哪些事件新建或续接，以及 Manager 的理由 |
| `/api/repositories/:id/workflows[/...]` | 任意 | 410 `workflows_removed`，说明里给出替代路径 |

管理服务的 `manager.update` 命令和上面的 PUT 相同；`get_effective_config` 返回 `manager`，另外的 `workflows` 按旧格式列出各工作类型的生效提示词，供旧客户端读取。旧命令 `workflow.update` 仍可用，`target.workflow_id` 是工作类型 id，只接受 `prompt`（改写该工作类型的章节）、`enabled` 和 `writes`；`triggers`、`model_id`、`settings`、`name` 等返回 410，说明里写明去处。

## 看板与统计

看板按工作类型分卡：检视 Issue、检视 PR、开发 Issue、跟进 bot PR、通用回复，以及「发版本」。原自定义工作流的任务都归入「通用回复」卡片；以前保存的视图里的 `custom.<id>` 筛选按「通用回复」处理，`review`、`development` 仍表示全部检视和全部开发。`GET /api/board` 的 `workflows` 字段保留原名，列出这些工作类型。用量统计同样按工作类型汇总，字段 `workflow` 是工作类型 id。
