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
  - 根 Issue 及其关联的 bot PR 共用 `<repo>:issue:<issueNumber>`（使 Issue 检视、开发、bot PR 检查失败 `pull_request.checks_failed`、合并冲突 `pull_request.conflicted` 与内部巡检 `pull_request.patrol` 在同一上下文中闭环决策）；
  - 独立 PR 使用 `<repo>:pr:<prNumber>`；
  - Actions 失败、发版本与定时检查归入各自确定性线程。
- **串行决策与常设规则**：同一 `thread_key` 严格串行处理并维护滚动摘要；例行事件优先命中无模型开销的 `standing_rules`（永不自动启动开发），需要判断的事件交由 Manager 使用内置六大场景或项目自定义提示词处理。
- **开发依据硬核验**：创建开发任务时，控制面在 `create_task` 入口强制校验 `basis`（`label` / `maintainer_request` / `project_rule`）并持久化记录，同时提供结构化认领事实（指派人、关联 PR、近期评论）供 Manager 判断，不依赖脆弱正则。
- **Bot PR 防自循环、内部定期巡检与冲突防空烧**：通过 `bot_pull_requests` 归属表与真实发布记录/actor 身份识别 bot 自有 PR（不轻信公开可伪造注释），过滤自身打开与推送事件；`BotPrWakeScanner` 结合 Webhook 检测检查失败（按 `(pr, head_sha, run_or_suite_id, attempt)` 聚合）与合并冲突（按 `(pr, head_sha, base_sha)` 单次去重），运行中收到的晚到事件在任务收尾或失败时自动回交 Manager。同时，`bot_pr_states` 持久化每个未合入 open bot PR 的巡检元数据（`last_patrol_at`、`last_patrol_event_at`、`patrol_env_fingerprint`、`patrol_env_summary`、`patrol_head_sha`、`patrol_base_sha`、`patrol_status` 及冲突抑制字段 `conflict_suppressed_*`）：
  - **纯内部低频巡检（`pull_request.patrol`）**：复用扫描器的只读 GitHub 查询与限流保护，按配置周期（默认 `BOT_PR_PATROL_INTERVAL_MS` 6 小时、同 PR 冷却 `BOT_PR_PATROL_COOLDOWN_MS` 24 小时；环境/权限/能力指纹变化可绕过冷却及时复核）检查无活跃任务且无待决分派事件的非草稿 open bot PR；仅在命中明确变化信号（`environment_or_policy_changed`、`base_moved` + `checks_failed` / `conflicted`、`unresolved_changes_requested`、`stalled_task`）时向对象 Manager 线程投递 `source='control_plane'` 的 `pull_request.patrol` 事件（并附带 `changes_since_last_check` 与 `environment_changes`），对纯绿灯待人工合入 PR 仅刷新本地时间戳，零模型调用、零 GitHub 评论。全程严格停留在控制面内部，不写入 `schedule_events` / `notification_outbox` 且绝不触发飞书或任何外部通知渠道。
  - **抑制 `dirty` 冲突高频空烧**：当 Manager 对某 bot PR 的 `pull_request.conflicted`（或带冲突标记的 `pull_request.patrol`）在当前 `head_sha` 下明确 `ignore` 后，控制面在 `applyDecision` 内原子记录 `(head_sha, env_fingerprint, suppressed_at)` 抑制标记；在 `head_sha` 未变、环境/权限指纹未变且无新人类评论/评审前，60 秒扫描与主干推进 Webhook 不再随 `main` 每次前进重复投递 `pull_request.conflicted`，改为等待人类信号、环境变化或长冷却周期后经低频内部巡检复核；同时兼容 `github_app` 与 `bot_account` 双账号形态识别自身评论避免误解抑。

## 2. 通用任务引擎、队列与恢复（`src/tasks/`）

- **统一任务抽象与目标解析**：所有新任务统一为 `task.request`，携带通用检出目标 `target`（`issue` / `pr` / `branch` / `commit`）、版本化合同 `contract`（目标、范围、验收标准、交付终点）、可选直派角色 `executor_role` 与显式写入授权集合 `task_write_grants`（`review`、`pull_request`、`github`、`actions_rerun`）。其中 `target: { type: "issue", number, ref? }` 支持解析远端分支名作为检出基线与 PR `base`，且指名分支优先于既有 bot PR：只复用 `base` 与指名分支一致的开放 PR（未指名时沿用最新开放 PR），旧 PR 不动，新交付使用按基线区分的分支名（默认基线 `bot/issue-<N>`，其他基线 `bot/issue-<N>-<base>`（`/` 等字符写作 `-`），登记给当前任务）（去重键计入 `target.ref`；分支不存在明确报错 `target_branch_not_found` 而不回退默认分支；裸提交/标签仅允许只读任务，带 `pull_request` 写权限时报错 `target_ref_not_branch`）；仓库规则与 `.agents/skills/` 仍严格从项目可信基准分支（`policy.base_branch || defaultBranch`）加载。
- **全链路交付上下文透明化**：控制面通过 `buildDeliveryContext`（`src/tasks/delivery-context.ts`）从持久化字段确定性生成结构化 `delivery_context`（`target`、`base_branch`、`base_sha`、PR 基线语义说明、`goal`、`intended_delivery`、生效 `writes`），贯通 Task Manager、Dev 与 Observer（`reviewer`/`test`）；团队模式在 `latest_dev_result` 与 `delegate_role` 返回值中暴露 `delivery` 与改动文件数，在 `read_child_tasks` 暴露子任务 `target`/`base_branch`/`delivery`/`pr_url`，并在 Observer 输入中附带当前候选的变更文件摘要 `candidate_changes`。
- **团队提名 `delivery` 语义与子任务聚合**：`nominate_delivery` 支持可选 `delivery`（`pull_request` / `review` / `report`，仅 generic 任务生效且受父任务 `effectiveWrites` 约束），`validateNominationResult` 按实际目标收尾工具（`open_pull_request`/`post_review`/`submit_report`）校验而不再硬编码 `submit_report`。子任务结果不自动导入代码文件到父工作区：子任务已开出 PR（存在 `pr_url`）时，父任务缺省按 `report` 聚合汇报并保留 `child_pull_requests` 关联而不重复开 PR；父任务合同要求 `reviewable_pull_request` 且被提名子任务无 `pr_url` 时，未显式传入 `delivery` 明确拒收防静默降级。
- **任务一律以角色运行执行**：省略 `executor_role` 时由 Task Manager 团队协调（含重试报告评估），直派角色单独运行；Manager 开关退役前冻结、入口开关仍为关闭的旧任务，同样按退役开关解析、由 Manager 团队协调，不存在绕过角色的工具循环。
- **三重写入闸门**：每次外部写入同时校验 **项目能力上限 `capability_ceiling` ∩ 任务 `task_write_grants` ∩ 来源/角色实时授权**；`grant_writes` 允许 Manager 或管理员在不越过上限的前提下动态调整运行中任务的写入授权。
- **优先级队列与并发认领**：
  - 持久化 `priority`（`P0`–`P3`，默认 `P2`）与单调 `queue_seq`，在 `BEGIN IMMEDIATE` 事务中按优先级 + 序号原子认领，并受项目并发上限（1–32）约束；不抢占运行中任务。
  - **条件等待 vs 失败退避**：限流（`github_rate_limited`）、等待电脑/配置/PR head/事件订阅（`waiting_event`）属于条件等待，不消耗失败重试计数；真正执行失败按 5s → 15s → 45s → 135s → 300s 短退避，同码连续 5 次后转入每任务 **8 小时重试周期**。
  - **失败解释**：`src/agent/failures.ts` 负责错误归类、重试判断及解释组装，按错误码显示的处理提示集中在 `src/agent/failure-actions.ts`。
  - **排队票语义**：新任务进入队列、失败任务重试都取新票；用户 `暂停` 后 `重试`（`paused` + `error_code='user_pause'` 且 `attempt` 未前进）保留原 `queue_seq`，回到原位置继续。新建即暂停的任务从未占位，启动时入队尾；`adopt-config` 会推进 attempt，按重规划取新票。该重建触发器的语句在启动时以同一写事务 `DROP`/`CREATE`，旧数据库重开后即生效。
- **无打断更新与下一轮续接**：
  - 排队或运行中的检视收到评论、编辑或 PR 新推送时直接写入更新收件箱；运行中在回合边界刷新 `../context/` 或原地推进 git worktree 到新 head（`workspace_advance`），不作废原任务。
  - 已发布检视收到新更新时在同一任务上启动下一轮（`round + 1`），通过 `updates_through` 游标保证已覆盖更新不重复开轮、未覆盖更新不遗漏。
  - 每次发布决定都以 `publication_decision` 记入任务历史：发布写 `publish`，Manager 推迟（`manager_disposition` 的 continue/wait，含 Harness 回合结束未提名）写 `defer`，发布后仍有未覆盖更新续接下一轮写 `next_round`，都带覆盖范围、未覆盖与顺延的更新编号、轮次和来源引用。`read_publication_context` 用 `decisions` / `latest_decision` 返回这些可审计决定，与 `publication_state` 的尝试记录各自独立分页（`next_before` / `decisions_next_before` 及截断标记）。覆盖范围无法取得时记 `coverage: unavailable` 与 `null` 计数，不写成零。
- **代码改动默认经团队与独立检视（内置引导，非门禁）**：bot PR 开出后平台不再检视，所以分派 Manager 的 `create_task` 与 Task Manager 的协调提示词都把会开 PR 的代码改动默认交给团队（省略 `role` / `executor_role`；填主控角色本身，或在 Issue 上用开发选项 `development` 的简写，也按团队处理，不会变成 Manager 或 dev 单独执行。分派侧这条归一只作用于对象事件新建的通用任务 `task.request`，定时检查、发版观察与发行说明等领域事件仍按各自的执行方式；Task Manager 的 `create_task` 按团队新建时，任务输入和来源记录都不写执行角色，`runRequest` 因此走团队；bot PR 上同一 id 的选项是修订，仍默认 `dev`；显式 `role: "dev"` 照旧由 dev 单独执行）。提名事实由 `candidateParticipation`（`src/roles/participation.ts`）计算：最新一条 `dev` 的 `role_result` 是候选，其后记录的观察者结果检视的是这个候选（候选在检视中途变化时 `run.ts` 会拒收该结果），之前的属于更早的候选。它出现在 Manager 输入、每次 `delegate_role` 的回复和 `delivery_nominated` 记录里（连同 Manager 可选的 `checks_note`），QA 输入里的 `candidate_participation` 是同一份事实。这些只是事实，提名和验收都不因此被拒绝。
- **任务协作与拆解**：
  - **父子拆解**：Manager 按需通过 `create_task(as_child=true)` 与 `wait_for_children` 拆解复杂目标并释放槽位，子任务完成不自动代表父任务通过。任一已返回子任务仍立即唤醒父任务；若全部未返回子任务都停在 `waiting_environment` / `waiting_configuration`，父任务详情用 `childBlockSummary` 汇总各子任务的状态、原始错误码与恢复条件并提供子任务入口。聚合原因与恢复入口由每个子任务自身的 `failureCause` / `explainFailure`（状态 + 错误码）推导：所有子任务指向同一设置页时才给出对应入口，归因不一致或无设置页时回退为中性说明与子任务入口，不按等待状态猜测。父任务自身状态和事件契约（`task_children_pending`、`children_waiting`）保持不变，重复轮询不产生子任务返回事件。
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

- **不可变候选快照、HEAD 漂移护栏与 QA 交接摘要**：代码交付固定工作树快照并保留 Git tree/commit 引用，测试生成的脏文件不进入候选；`runner/workspace.mjs` 的 `workspace_finalize` 返回实际 `head_sha`，控制面在 `open_pull_request` 校验与 QA 确定性预检中拦截非冲突解冲/集成场景下的工作区 `HEAD` 脱离发布基线（`workspace_head_drifted`），防止向错误目标分支发出全量跨分支差异 PR。任务上下文与 QA 输入只携带精简索引和哈希引用（通过 `read_evidence` / `read_related_artifact` 按需分页读取），同时在 QA 输入顶层提供不会被 `boundedCandidate` 折叠的 `delivery_handoff`（目标与合同目标、预期 vs 实际交付方式、基线与 `head_matches_baseline`、变更路径增删改摘要及 `.github/workflows/` 标记、提名来源与说明）。
- **轻量守门人独立 QA**：
  - 纯内部只读问答跳过 QA；对外交付（开 PR、正式检视、提报）先在共享任务工作区原地执行确定性预检（策略 `test_command`、HEAD 基线一致校验、敏感文件/冲突标记/凭据扫描与行内评审 diff 锚点预检防止 422；其中 `privateKeyBlock` 文本启发式仅对任意层级测试目录 `tests?`/`__tests__`/`specs?` 及 `.test.`/`.spec.`/`test_*`/`*_test.*` 豁免，真实注册凭据 `redactor.contains` 与 `dirtyPathPattern` 保持严格不豁免），再以全新上下文运行独立 QA，产出五类明确结论：`pass`、`pass_with_issues`、`return`、`insufficient_evidence`、`needs_human`。
  - 允许项目显式关闭 `delivery_gates.pull_request_qa`（前提是配置了有效 `test_command`）。
- **幂等发布与未知状态对账**：
  - 评论、行内 Review（恒为 `COMMENT`，自动关闭已修复旧线程）、分支推送与 PR 创建全部经过持久 Outbox 与稳定写入键；大仓库使用 `base_tree` 增量构建 Git tree 并校验返回 tree 与候选完全一致。
  - 当候选变更实际涉及 `.github/workflows/` 时，`Publisher.branch` / `publishRequestPullRequest` 在推送分支前按需向 GitHub App 申请短期 `workflows: write` 安装令牌（用完即撤销）；若安装未授予 `Workflows: Read and write`，则在写入任何 Git 对象前以 `github_workflows_permission_missing`（`waiting_permission`）中止并提示开通。
  - 网络中断导致远端结果未知时停留在 `waiting_publication`，重试前先按任务 marker/head 对账（bot 分支更新幂等则自动查证续发），避免重复发评论或开重复 PR。
- **自动合并与并行集成**：
  - 人工合并（`POST /api/tasks/:id/merge`）持久化合并意图，核验候选、QA 与远端检查并支持三路集成与 Merge Queue 入队；
  - Agent 经 `github_write PUT /pulls/{n}/merge` 或直接写默认分支时，统一经过 `auto_merge_policy` 策略校验与真实 `merge_request` 来源核实（协作者缓存或当前合法对话消息），并自动适配目标分支 Merge Queue。
- **动作失败扫描与发版本**：
  - `src/actions/` 结合 Webhook 与持久化固定时间窗分页扫描发现默认分支/版本标签失败运行，限制单 run 最多一次 `rerun_failed_run`。
  - `src/releases/` 强校验 SemVer 递增与新增提交，创建注释标签跟踪 Release 工作流，基于提交区间事实生成草稿，最终发布权始终留给人。
