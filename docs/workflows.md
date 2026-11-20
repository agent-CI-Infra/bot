# 统一任务调度与对象 Manager

从 #1122 起，固定工作类型目录（`src/work/*`）、11 个 Manager 提示章节、`work_settings` 与按任务类型模型覆盖（`policies.task_models`）已退役。平台只保留一套 **通用任务引擎（`kind = 'task.request'`）**、每个 Issue / 独立 PR 的 **单对象持久 Manager 线程（`dispatch_threads`）**，以及统一收口在 `capability_ceiling`、`task_write_grants` 与角色权限之下的确定性交付工具。历史已完成任务的旧 `kind`（`review.pr`、`development.issue`、`workflow.*` 等）在看板、任务详情、动态和用量统计中保持只读兼容（`src/projects/legacy-kinds.ts`）。

## 项目监听与触发

项目设置中的「监听与触发」（`#/projects/<id>/triggers`）集中管理项目的能力上限、事件来源和标签触发。Manager 提示词、常设规则与分派记录在「角色 → Manager」维护（提示词卡片默认是阅读视图，按 Markdown 排版并把 ` ```mermaid ` 代码块画成流程图，「编辑源码」显示保存的原文和实时预览，#1123）；各角色（含 Manager）的模型与 Agent 后端在「角色」页配置，项目默认模型在「模型」页配置。

## 项目能力上限

每个项目有一个能力上限（策略字段 `capability_ceiling`，`src/projects/ceiling.ts`），是全项目唯一的最高写闸门：

| 档位 | 含义 | GitHub 写入 |
| --- | --- | --- |
| `read` 只读问答 | 在飞书和控制台里回答、拉分支跑测试诊断 | 无 |
| `comment` 可评论和打标签 | 写 Issue 和 PR：评论、加删标签、改标题和正文、指派人、关闭或重开、提 Issue、发检视（`post_review`）、维护开发进度评论（`report_development_milestone`）、重跑失败 Actions（`rerun_failed_run`）与触发工作流；不改代码 | Issues、Pull requests、Actions |
| `develop` 可开发并开 PR | 还可以改代码、推送 bot 分支并创建或更新 bot PR（`open_pull_request`） | 再加 Contents（文件、分支和引用、合并 PR） |

所有写入工具（`post_review`、`open_pull_request`、`report_development_milestone`、`rerun_failed_run`、`github_write`）均受 `capability_ceiling`、任务写入授权 `task_write_grants`（`pull_request`、`review`、`github`、`actions_rerun`）与来源策略三重约束：

- **通用检出目标（`target`）**：`POST /api/tasks`、`task.create`、`create_task`、`create_project_task` 与 Manager 分派均支持绑定 `target: { type: 'issue' | 'pr' | 'branch' | 'commit', number?, ref? }`。绑定 PR 时自动检出 `refs/pull/<n>/head` 与基准分支，并在 `../context/` 准备 `object.json`、`files.json`、`comments.json`、`reviews.json`、`review_comments.json`、`repository_labels.json`；绑定 Issue 且存在关联 bot PR 并持有 `pull_request` 授权时自动续接该 bot PR 分支。
- **正式检视（`post_review`）**：要求 `review` 授权与至少 `comment` 能力上限；发布前对行内评论执行 diff 锚点预检（越界行号在任何 GitHub 请求前拒绝，0 次 GitHub 写入，绝不向 GitHub 发送 422 请求），通过轻量守门人 QA 后复用 `Publisher.review` 原位更新同一条总结评论（`review_summaries`）、关闭已修复的行内讨论串（`resolveFixed`）并按策略添加检视与分类标签。
- **分支与 PR 交付（`open_pull_request`）**：要求 `pull_request` 授权与 `develop` 能力上限；强制通过项目 `test_command` 与独立 `qa` 验收，仅向登记的 `bot/*` 分支非强推提交并创建或更新 bot PR，严禁强推他人分支；触碰 `.github/workflows/` 仍需管理员显式确认（`workflow_changes`）。
- **Actions 单次重跑（`rerun_failed_run`）**：要求 `actions_rerun` 授权与至少 `comment` 能力上限，受单次 run 重跑预算与幂等账本保护。

调低能力上限不会取消任务：需要更高档位的操作会被拒绝或以 `capability_ceiling_lowered` 进入 `waiting_permission` 并保留现场，调回后可重试。

## 事件过滤与单对象持久 Manager 线程

控制面先按安装范围、项目启停、防自循环、草稿/关闭状态及事件开关过滤事件（被过滤的人类事件记录为 `state = 'filtered'`）。通过过滤的事件进入对应对象的持久线程（`dispatch_threads`）：

- 根 Issue 及其关联的 bot PR 共用 `<repo>:issue:<issueNumber>` 线程；
- 独立 PR 使用 `<repo>:pr:<prNumber>` 线程；
- 发版本、Actions 失败与定时检查按各自确定性键归入独立线程。

同一 `thread_key` 的事件串行分派，并在 `object_thread` 中携带最近分派历史与滚动摘要，使后续评论、追加修改要求或飞书追问直接在同一对象上下文中决策，不再出现预计算选项集锁死（原 `dispatch_option_not_offered` 已移除）。Manager 可执行以下动作并给出理由：

- **直接处理 + `ignore_event`**：在授权范围内用 `github_write` 直接回复简单问题或修改标签/标题/指派，无需启动容器检出；
- **`create_task`**：创建 `kind = 'task.request'` 通用任务，指定 `role`（如 `reviewer`、`test`、`dev` 或留空由主控编排）、`writes`（`review`、`pull_request`、`github`、`actions_rerun`）、`target`、任务 `brief` 与开发 `basis`；
- **`continue_task`**：把新事件并入同一对象上排队、运行中或可续接的任务（含已完成检视的下一轮，自动迁移到最新 PR head 并原位更新总结评论）。

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
