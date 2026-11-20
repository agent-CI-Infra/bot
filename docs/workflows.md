# 统一任务调度与对象 Manager

从 #1122 起，固定工作类型目录（`src/work/*`）、11 个 Manager 提示章节、`work_settings` 与按任务类型模型覆盖（`policies.task_models`）已退役。平台只保留一套 **通用任务引擎（`kind = 'task.request'`）**、每个 Issue / 独立 PR 的 **单对象持久 Manager 线程（`dispatch_threads`）**，以及统一收口在 `capability_ceiling`、`task_write_grants` 与角色权限之下的确定性交付工具。历史已完成任务的旧 `kind`（`review.pr`、`development.issue`、`workflow.*` 等）在看板、任务详情、动态和用量统计中保持只读兼容（`src/projects/legacy-kinds.ts`）。

## 项目监听与触发

项目设置中的「监听与触发」（`#/projects/<id>/triggers`）集中管理项目的能力上限、自动合并策略、事件来源和标签触发。Manager 提示词、常设规则与分派记录在「角色 → Manager」维护（提示词卡片默认是阅读视图，按 Markdown 排版并把 ` ```mermaid ` 代码块画成流程图，「编辑源码」显示保存的原文和实时预览，#1123）；各角色（含 Manager）的模型与 Agent 后端在「角色」页配置，项目默认模型在「模型」页配置。

## 项目能力上限

每个项目有一个能力上限（策略字段 `capability_ceiling`，`src/projects/ceiling.ts`），是全项目唯一的最高写闸门：

| 档位 | 含义 | GitHub 写入 |
| --- | --- | --- |
| `read` 只读问答 | 在飞书和控制台里回答、拉分支跑测试诊断 | 无 |
| `comment` 可评论和打标签 | 写 Issue 和 PR：评论、加删标签、改标题和正文、指派人、关闭或重开、提 Issue、发检视（`post_review`）、维护开发进度评论（`report_development_milestone`）、重跑失败 Actions（`rerun_failed_run`）以及经 `github_write` 触发、重跑或取消工作流运行与 job；不改代码 | Issues、Pull requests、Actions |
| `develop` 可开发并开 PR | 还可以改代码、推送 bot 分支并创建或更新 bot PR（`open_pull_request`） | 再加 Contents（文件、分支和引用；合并 PR 另按[自动合并策略](#项目自动合并策略)） |

所有写入工具（`post_review`、`open_pull_request`、`report_development_milestone`、`rerun_failed_run`、`github_write`）均受 `capability_ceiling`、任务写入授权 `task_write_grants`（`pull_request`、`review`、`github`、`actions_rerun`）与来源策略三重约束：

- **通用检出目标（`target`）**：`POST /api/tasks`、`task.create`、`create_task`、`create_project_task` 与 Manager 分派均支持绑定 `target: { type: 'issue' | 'pr' | 'branch' | 'commit', number?, ref? }`。绑定 PR 时自动检出 `refs/pull/<n>/head` 与基准分支，并在 `../context/` 准备 `object.json`、`files.json`、`comments.json`、`reviews.json`、`review_comments.json`、`repository_labels.json`；绑定 Issue 且存在关联 bot PR 并持有 `pull_request` 授权时自动续接该 bot PR 分支。
- **正式检视（`post_review`）**：要求 `review` 授权与至少 `comment` 能力上限；发布前对行内评论执行 diff 锚点预检（越界行号在任何 GitHub 请求前拒绝，0 次 GitHub 写入，绝不向 GitHub 发送 422 请求），通过轻量守门人 QA 后复用 `Publisher.review` 原位更新同一条总结评论（`review_summaries`）、关闭已修复的行内讨论串（`resolveFixed`）并按策略添加检视与分类标签。
- **分支与 PR 交付（`open_pull_request`）**：要求 `pull_request` 授权与 `develop` 能力上限；强制通过项目 `test_command` 与独立 `qa` 验收，仅向登记的 `bot/*` 分支非强推提交并创建或更新 bot PR，严禁强推他人分支；触碰 `.github/workflows/` 仍需管理员显式确认（`workflow_changes`）。
- **PR 正文媒体**：PR 交付工具的可选 `media` 列出本次明确选中的文件，例如 `[".tmp/result.png", ".tmp/demo.webm"]`。正文用 `![结果](workspace:.tmp/result.png)` 内嵌图片，用 `[录屏](workspace:.tmp/demo.webm)` 链接视频。文件可位于检出目录的 Git 忽略路径，浏览器证据也可用当前任务的 `../browser/evidence/<文件名>`。支持 PNG、JPEG、GIF、WebP（每张 5 MiB），以及 MP4、WebM（每段 20 MiB），每次最多 8 个文件、合计 30 MiB。选中前应检查画面和音轨中的敏感信息。
- PR 媒体和代码一起通过交付门禁。Bot 把媒体保存到本机数据卷，以已配置的公网 HTTPS 地址提供随机文件链接，确认文件入库后再用目标仓的 GitHub App 发布正文。图片可在公开和私有 PR 内嵌，录屏通过链接下载。视频和图片属于其来源项目，移除项目或撤销应用安装后，托管入口停止提供相应文件。
- 每条文件链接含 256 位随机访问凭证，服务只提供单文件读取。包括私有仓在内，获得链接的人和 GitHub 的图片代理均可读取相应文件。链接转发也会转移读取能力。请只选择允许按这种方式分享的媒体。
- **Actions 单次重跑（`rerun_failed_run`）**：要求 `actions_rerun` 授权与至少 `comment` 能力上限，受单次 run 重跑预算与幂等账本保护。

调低能力上限不会取消任务：需要更高档位的操作会被拒绝或以 `capability_ceiling_lowered` 进入 `waiting_permission` 并保留现场，调回后可重试。

## 项目自动合并策略

项目策略字段 `auto_merge_policy`（#1170，`src/github/merge-policy.ts`）决定 Agent 能否自行合并 PR，共三档，默认 `disallow`：

| 档位 | 含义 |
| --- | --- |
| `disallow` 不允许自动合并 | 包括 bot 自己的 PR 在内都不自行合并；只有对仓库有写权限的维护者在 GitHub 评论、飞书或管理会话里明确要求合并某条 PR 时才合并 |
| `non_bot_only` 不自动合并 bot 开发的 PR | bot 开的 PR 仍要维护者明确要求；其他 PR 满足仓库规则时可以自动合并。bot 开的 PR 指 `bot_pull_requests` 登记的，以及作者是 bot 自己 GitHub 账号的（例如经 `github_write POST /pulls` 开的）；读不到作者时按 bot 的算 |
| `allow_all` 允许所有自动合并 | 包括 bot 自己的 PR，满足仓库规则时都可以自动合并 |

档位在「监听与触发」页的「自动合并」卡片、`PATCH /api/repositories/:id/policy` 或管理命令 `project.update` 里设置，`get_effective_config` 返回当前档位；改变档位记一条审计 `policy.auto_merge`。

合并只有一个入口：`github_write` 的 `PUT /pulls/{n}/merge`。控制面先用只读令牌读 PR 和目标分支的规则（与 `POST /api/tasks/:id/merge` 共用 `src/github/merge-queue.ts`）：目标分支要求 merge queue 时改用 GraphQL `enqueuePullRequest` 送入队列，按 Agent 给的 `sha` 或读到的 head 固定，合并方式由队列设置决定，回执带 `queued: true` 和队列条目；否则直接合并；读不出目标分支是否要求队列（规则、分支保护和 GraphQL 都读不到）时返回 `merge_queue_unknown`，不发送，不会退回直接合并。两种方式同一道闸门：能力上限 `develop`、调用方角色对 Contents 和 Pull requests 都有写权限，以及本策略；写令牌只含这两项写权限。回执的 `via` 写明是 `merge` 还是 `merge_queue`。

档位要求维护者请求时（`disallow` 下的所有 PR、`non_bot_only` 下 bot 的 PR），调用要带 `merge_request`，控制面核实请求的来源，而不是相信模型的转述：

- **GitHub 链接**：这条 PR 上的普通评论（`#issuecomment-…`）、检视（`#pullrequestreview-…`）或行内评论（`#discussion_r…`）。作者不能是 bot（App 账号、本 bot 的账号或带 bot 标记的内容），并且在平台的仓库协作者缓存（#1158）里是 write、maintain 或 admin，或是安装所有者。
- **`current_message`**：管理助手或群聊助手正在回答的这条消息。管理会话看登录的这个人；飞书群看发这条消息的人自己关联的平台账号，不是群绑定的配置人。这个人要在该项目有写任务的权限（仓库写权限或项目管理员给的）。Manager 分派和任务里没有这样的消息，只能引用 GitHub 链接；它们的提示词因此只写 GitHub 链接，飞书或管理会话里的请求由那里的助手合并。

不经 PR 直接移动默认分支的写入同样受这个策略约束，按合并 bot 自己的改动处理：`PUT`/`DELETE /contents/...` 写在默认分支上（不写 `branch` 时就是默认分支）、`PATCH`/`DELETE /git/refs/heads/<默认分支>`、`POST /merges` 合进默认分支。`allow_all` 下由仓库自己的分支规则决定；`disallow` 和 `non_bot_only` 下要带 `merge_request`，链接可以在本仓库任一 Issue 或 PR 上，否则返回 `auto_merge_not_allowed`（带 `default_branch`），提示改走分支、PR 和 `PUT /pulls/{n}/merge`。写其他分支、建新 ref 不受影响。

请求的文字是不是真的要求合并这条 PR，由 Agent 判断并在回报时引用；批准、"LGTM" 或检查通过都不算。没有核实的请求时返回 `auto_merge_not_allowed`（带 `policy`、`bot_pull_request` 和原因），不签发写令牌、不发送，账本和审计记下这次拒绝；准备合并期间档位被调严，发送前同样拒绝。档位不要求请求时，`merge_request` 不核对也不影响合并。

平台不替仓库决定合并前要满足什么：必需检查、批准和确认标签（例如仓库自定义的 `committer_confirm`）由 GitHub 分支保护或规则集，以及仓库文档和项目提示词决定。Manager 分派、任务里的 Agent、管理助手和群聊助手的系统提示词按当前档位生成合并边界，不再一律写「绝不合并」；团队里的工作角色用自己的角色提示词，同一段边界写在它拿到的 `github_write` 工具说明里。开发角色仍不合并自己交付的 PR，合不合并交给之后的 Manager 或人。人在控制台合并走带校验的 `POST /api/tasks/:id/merge`，是人的明确操作，不受本策略限制，见[角色池](role-pool.md#authorized-merge)。

## 事件过滤与单对象持久 Manager 线程

控制面先按安装范围、项目启停、防自循环、草稿/关闭状态及事件开关过滤事件（被过滤的人类事件记录为 `state = 'filtered'`）。通过过滤的事件进入对应对象的持久线程（`dispatch_threads`）：

- 根 Issue 及其关联的 bot PR 共用 `<repo>:issue:<issueNumber>` 线程；
- 独立 PR 使用 `<repo>:pr:<prNumber>` 线程；
- 发版本、Actions 失败与定时检查按各自确定性键归入独立线程。

同一 `thread_key` 的事件串行分派，并在 `object_thread` 中携带最近分派历史与滚动摘要，使后续评论、追加修改要求或飞书追问直接在同一对象上下文中决策，不再出现预计算选项集锁死（原 `dispatch_option_not_offered` 已移除）。Manager 可执行以下动作并给出理由：

- **直接处理 + `ignore_event`**：在授权范围内用 `github_write` 直接回复简单问题或修改标签/标题/指派，无需启动容器检出；
- **`create_task`**：创建 `kind = 'task.request'` 通用任务，指定 `role`（如 `reviewer`、`test`、`dev` 或留空由主控编排）、`writes`（`review`、`pull_request`、`github`、`actions_rerun`）、`target`、任务 `brief` 与开发 `basis`；
- **`continue_task`**：把新事件并入同一对象上排队、运行中或可续接的任务（含已完成检视的下一轮，自动迁移到最新 PR head 并原位更新总结评论）。

## 内置 Manager 提示词：六大场景（#1123）

没有保存过自己提示词的项目使用内置的 [`docs/prompts/manager-dispatch.md`](prompts/manager-dispatch.md)。开头说明四种决定和控制面强制的边界，正文按六个场景分章：① 代码仓问答与调研、② Issue/PR 日常管理、③ Issue/PR 检视、④ 特性开发与缺陷修复、⑤ 分支/PR 自主测试、⑥ CI 失败与定时主动发现。每章都是「一句话能力说明 + 一张 ` ```mermaid ` `flowchart TD` 流程图 + 3～5 条可调的边界准则」，第 ④ 章另带「Starting development」小节（开发依据和 `project_rule` 引用的自主开发规则原句）。流程图和准则说的是同一件事：控制台「角色 → Manager」的阅读视图画出来的就是模型读到的指令，改流程时两者一起改。章节结构由 `test/ut/src/dispatch/manager-prompt.test.mjs` 固定。

两个分支的流程图在 1440 和 768 宽度下完整放进栏宽；手机（390）上按 70% 缩放后仍略宽，在自己的框内横向滚动，页面本身不横向滚动。

想让 bot 换一种做法时，在管理助手里用对话说明即可：助手先读项目当前的 Manager 提示词，回复「当前流程」和「修改后流程」两张图及变更要点，等确认后才用 `manager.update` 写回整份提示词，见[管理助手](management-agent.md#讲解和修改协作流程1123)。提示词不能放宽能力上限、写入授权、角色权限、开发依据和合并规则，需要改这些设置时助手会单独提出对应命令。

## 常设规则

例行事件优先由常设规则（`standing_rules`）直接决定，不调用 Manager 模型：

| 字段 | 含义 |
| --- | --- |
| `id` | 规则 id，项目内唯一 |
| `event` | 事件类型（如 `issue.opened`、`pull_request.opened`、`pull_request.synchronize`、`issue.updated`、`pull_request.updated`） |
| `action` | `create`、`continue`、`continue_active`、`continue_or_create`、`ignore` |
| `role` | 新建任务的直派角色（如 `reviewer`），兼容读取旧 `work` 简写 |
| `writes` | 新建任务授予的写入列表（如 `["review"]`） |
| `when` | 可选：`labels_any`、`labels_none` |
| `reason` | 记录在分派事件中的理由 |
| `enabled` | 可选，`false` 时停用 |

默认内置规则在 Issue / PR 打开时直派 `reviewer`（授予 `["review"]`），在 PR 推送新提交时优先续接已有检视否则新建 `reviewer` 检视，在 Issue / PR 普通更新时仅并入活跃任务；常设规则永不自动启动开发（开发须由 Manager 核验开发依据 `basis`）。

## 升级迁移

控制面启动时执行幂等迁移（`src/dispatch/migration.ts`）：

- 原 Manager 提示词中保存过的自定义检视章节迁入 `reviewer` 角色指令，自定义开发章节迁入 `dev` 角色指令，其余自定义章节合入统一 Manager 分派提示词；
- 原 `policies.task_models` 中无冲突的模型覆盖迁入对应角色的 `model_profile_ref`；
- 原常设规则中的旧工作类型标识自动归一化为 `role` + `writes`。

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/repositories/:id/manager` | GET / PUT | 读取或更新统一 Manager 分派提示词（`prompt`）、项目事件开关（`events`）、常设规则（`standing_rules`）及迁移记录；PUT 需 `expected_revision`，冲突返回 409 `manager_revision_conflict` |
| `/api/repositories/:id/dispatch` | GET | 分派事件列表（支持 `state`、`decision`、`type`、`from`、`until`、`limit`、`cursor`） |
| `/api/repositories/:id/dispatch/:event` | GET | 单条分派事件详情、拒绝记录（`refusals`）、常设规则命中、恢复历史与关联任务 |
| `/api/repositories/:id/dispatch/:event/retry` | POST | 重试失败或退避中的分派事件 |
| `/api/tasks/:id/dispatch` | GET | 查询创建或续接该任务的分派事件及理由 |
| `/api/repositories/:id/workflows[/...]` | 任意 | 410 `workflows_removed` |
| `/api/automation[/...]` | 任意 | 410 `automation_removed` |
