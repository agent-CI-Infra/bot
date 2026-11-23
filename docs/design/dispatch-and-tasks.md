# 事件分派、通用任务引擎与交付验收

本文说明 launchpad 从接收 GitHub 事件到对象 Manager 分派、通用任务调度、协作执行、独立 QA 与幂等发布的完整核心设计。功能行为见 [GitHub 自动化](../features/github-automation.md) 与 [角色配置与规则](../features/roles-and-rules.md)。

## 1. 单对象持久 Manager 线程（`src/dispatch/`）

平台已退役早期固定工作类型目录，统一采用 **单对象持久 Manager 线程（`dispatch_threads`）+ 通用任务引擎（`kind = 'task.request'`）**：

```mermaid
flowchart TD
  Event["Verified GitHub / Schedule / Actions Event"] --> Filter["Entrance Filter (scope, enabled, anti-loop, switches)"]
  Filter --> Thread["Object Thread (dispatch_threads, serial per thread_key)"]
  Thread --> Standing{"Hit standing_rules?"}
  Standing -- Yes --> Action["Direct create / continue / ignore (no LLM)"]
  Standing -- No --> Manager["Project Manager (persistent thread history + facts)"]
  Manager --> Direct["github_write + ignore_event"]
  Manager --> Create["create_task (task.request + target + writes + basis)"]
  Manager --> Continue["continue_task (merge updates / next round)"]
```

- **确定性线程键**：
  - 根 Issue 及其关联的 bot PR 共用 `<repo>:issue:<issueNumber>`（使 Issue 检视、开发、bot PR 检查失败 `pull_request.checks_failed` 与合并冲突 `pull_request.conflicted` 唤醒在同一上下文中闭环决策）；
  - 独立 PR 使用 `<repo>:pr:<prNumber>`；
  - Actions 失败、发版本与定时检查归入各自确定性线程。
- **串行决策与常设规则**：同一 `thread_key` 严格串行处理并维护滚动摘要；例行事件优先命中无模型开销的 `standing_rules`（永不自动启动开发），需要判断的事件交由 Manager 使用内置六大场景或项目自定义提示词处理。
- **开发依据硬核验**：创建开发任务时，控制面在 `create_task` 入口强制校验 `basis`（`label` / `maintainer_request` / `project_rule`）并持久化记录，同时提供结构化认领事实（指派人、关联 PR、近期评论）供 Manager 判断，不依赖脆弱正则。
- **Bot PR 防自循环与后台巡检**：通过 `bot_pull_requests` 归属表与真实发布记录/actor 身份识别 bot 自有 PR（不轻信公开可伪造注释），过滤自身打开与推送事件；`BotPrWakeScanner` 结合 Webhook 检测检查失败（按 `(pr, head_sha, run_or_suite_id, attempt)` 聚合）与合并冲突（按 `(pr, head_sha, base_sha)` 单次去重），运行中收到的晚到事件在任务收尾或失败时自动回交 Manager。

## 2. 通用任务引擎、队列与恢复（`src/tasks/`）

- **统一任务抽象**：所有新任务统一为 `task.request`，携带通用检出目标 `target`（`issue` / `pr` / `branch` / `commit`）、版本化合同 `contract`（目标、范围、验收标准、交付终点）、可选直派角色 `executor_role` 与显式写入授权集合 `task_write_grants`（`review`、`pull_request`、`github`、`actions_rerun`）。
- **三重写入闸门**：每次外部写入同时校验 **项目能力上限 `capability_ceiling` ∩ 任务 `task_write_grants` ∩ 来源/角色实时授权**；`grant_writes` 允许 Manager 或管理员在不越过上限的前提下动态调整运行中任务的写入授权。
- **优先级队列与并发认领**：
  - 持久化 `priority`（`P0`–`P3`，默认 `P2`）与单调 `queue_seq`，在 `BEGIN IMMEDIATE` 事务中按优先级 + 序号原子认领，并受项目并发上限（1–32）约束；不抢占运行中任务。
  - **条件等待 vs 失败退避**：限流（`github_rate_limited`）、等待电脑/配置/PR head/事件订阅（`waiting_event`）属于条件等待，不消耗失败重试计数；真正执行失败按 5s → 15s → 45s → 135s → 300s 短退避，同码连续 5 次后转入每任务 **8 小时重试周期**。
- **无打断更新与下一轮续接**：
  - 排队或运行中的检视收到评论、编辑或 PR 新推送时直接写入更新收件箱；运行中在回合边界刷新 `../context/` 或原地推进 git worktree 到新 head（`workspace_advance`），不作废原任务。
  - 已发布检视收到新更新时在同一任务上启动下一轮（`round + 1`），通过 `updates_through` 游标保证已覆盖更新不重复开轮、未覆盖更新不遗漏。
  - 每次发布决定都以 `publication_decision` 记入任务历史：发布写 `publish`，Manager 推迟（`manager_disposition` 的 continue/wait，含 Harness 回合结束未提名）写 `defer`，发布后仍有未覆盖更新续接下一轮写 `next_round`，都带覆盖范围、未覆盖与顺延的更新编号、轮次和来源引用。`read_publication_context` 用 `decisions` / `latest_decision` 返回这些可审计决定，与 `publication_state` 的尝试记录各自独立分页（`next_before` / `decisions_next_before` 及截断标记）。覆盖范围无法取得时记 `coverage: unavailable` 与 `null` 计数，不写成零。
- **代码改动默认经团队与独立检视（内置引导，非门禁）**：bot PR 开出后平台不再检视，所以分派 Manager 的 `create_task` 与 Task Manager 的协调提示词都把会开 PR 的代码改动默认交给团队（省略 `role` / `executor_role`；填主控角色本身，或在 Issue 上用开发选项 `development` 的简写，也按团队处理，不会变成 Manager 或 dev 单独执行。分派侧这条归一只作用于对象事件新建的通用任务 `task.request`，定时检查、发版观察与发行说明等领域事件仍按各自的执行方式；Task Manager 的 `create_task` 按团队新建时，任务输入和来源记录都不写执行角色，`runRequest` 因此走团队；bot PR 上同一 id 的选项是修订，仍默认 `dev`；显式 `role: "dev"` 照旧由 dev 单独执行）。提名事实由 `candidateParticipation`（`src/roles/participation.ts`）计算：最新一条 `dev` 的 `role_result` 是候选，其后记录的观察者结果检视的是这个候选（候选在检视中途变化时 `run.ts` 会拒收该结果），之前的属于更早的候选。它出现在 Manager 输入、每次 `delegate_role` 的回复和 `delivery_nominated` 记录里（连同 Manager 可选的 `checks_note`），QA 输入里的 `candidate_participation` 是同一份事实。这些只是事实，提名和验收都不因此被拒绝。
- **任务协作与拆解**：
  - **父子拆解**：Manager 按需通过 `create_task(as_child=true)` 与 `wait_for_children` 拆解复杂目标并释放槽位，子任务完成不自动代表父任务通过。
  - **跨任务只读查询与显式依赖等待**：原独立 `Task Coordinator` 角色与顾问式请求/通知/签收流程已退役，Manager 直接使用 `list_project_tasks` / `read_project_task` 按需分页读取同项目任务记录，用 `relate_task` 记录任务关联（不挂起运行中任务），并在存在明确先后依赖时调用 `wait_for_tasks`（支持 `delivered` / `merged` 条件、环检测与释放执行槽位，依赖满足或阻塞后自动唤醒）。历史 `task_coordinations` / `coordination_notices` 表仅保留只读兼容，升级前滞留在 `waiting_coordination` 且无显式依赖的旧任务会在 tick 自动恢复到 Manager。
  - **轻量事件订阅（`waiting_event`）**：任务可调用 `subscribe_event` 登记外部仓库事件并释放执行槽位，Webhook 到达直接唤醒或由 Manager 兜底关联，超时自动唤醒核查。

## 3. 交付候选、独立 QA 与幂等发布（`src/review/`、`src/github/`）

```mermaid
flowchart LR
  Exec["Worker (Dev / Reviewer / Team)"] --> Cand["Immutable Candidate Snapshot (tree_sha / report + evidence refs)"]
  Cand --> Preflight["Deterministic Preflight (test_command, secret/conflict/diff-anchor check)"]
  Preflight --> QA["Fresh Gatekeeper QA (clean context, 1-3 turns)"]
  QA -- "return / insufficient_evidence" --> Exec
  QA -- "pass / pass_with_issues" --> Outbox["Durable Publisher Outbox (idempotent key + unknown reconciliation)"]
  Outbox --> GH["GitHub API (PR / COMMENT Review / Labels / Merge Queue)"]
```

- **不可变候选快照与渐进披露**：代码交付固定工作树快照并保留 Git tree/commit 引用，测试生成的脏文件不进入候选；任务上下文与 QA 输入只携带精简索引和哈希引用（通过 `read_evidence` / `read_related_artifact` 按需分页读取），避免把数百 KB 原始日志塞进每轮模型请求。
- **轻量守门人独立 QA**：
  - 纯内部只读问答跳过 QA；对外交付（开 PR、正式检视、提报）先在共享任务工作区原地执行确定性预检（策略 `test_command`、敏感文件/冲突标记校验、行内评审 diff 锚点预检防止 422），再以全新上下文运行独立 QA，产出五类明确结论：`pass`、`pass_with_issues`、`return`、`insufficient_evidence`、`needs_human`。
  - 允许项目显式关闭 `delivery_gates.pull_request_qa`（前提是配置了有效 `test_command`）。
- **幂等发布与未知状态对账**：
  - 评论、行内 Review（恒为 `COMMENT`，自动关闭已修复旧线程）、分支推送与 PR 创建全部经过持久 Outbox 与稳定写入键；大仓库使用 `base_tree` 增量构建 Git tree 并校验返回 tree 与候选完全一致。
  - 网络中断导致远端结果未知时停留在 `waiting_publication`，重试前先按任务 marker/head 对账（bot 分支更新幂等则自动查证续发），避免重复发评论或开重复 PR。
- **自动合并与并行集成**：
  - 人工合并（`POST /api/tasks/:id/merge`）持久化合并意图，核验候选、QA 与远端检查并支持三路集成与 Merge Queue 入队；
  - Agent 经 `github_write PUT /pulls/{n}/merge` 或直接写默认分支时，统一经过 `auto_merge_policy` 策略校验与真实 `merge_request` 来源核实（协作者缓存或当前合法对话消息），并自动适配目标分支 Merge Queue。
- **动作失败扫描与发版本**：
  - `src/actions/` 结合 Webhook 与持久化固定时间窗分页扫描发现默认分支/版本标签失败运行，限制单 run 最多一次 `rerun_failed_run`。
  - `src/releases/` 强校验 SemVer 递增与新增提交，创建注释标签跟踪 Release 工作流，基于提交区间事实生成草稿，最终发布权始终留给人。
