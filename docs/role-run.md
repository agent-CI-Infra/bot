# RoleRun 协议、隔离环境与能力/预算

RoleRun 是一个 assignment 在 `task_runs` 里的一次执行尝试，不是新的任务系统。协议在 [Harness Runtime](harness-runtime.md) 的公共会话（`roleHarness(id).createSession`）之上增加版本化的输入、事件、检查点、取消、收集和恢复语义；Native、Process、ACP、Pi 仍是同一批驱动。代码在 `src/roles/protocol.ts`（schema）、`src/roles/role-run.ts`（租约、令牌、事件、预算、准入、检查点）、`src/roles/run.ts`（`runRole` 与 `roleRuns`）、`src/roles/gateway.ts`（TaskToolGateway）、`manager/run-environments.mjs` 与 `src/projects/run-environment.ts`（每次运行的容器）。

## 协议 `bot.role-run/1`

| 操作 | 入口 | 结果 |
| --- | --- | --- |
| prepare(ctx) | `roleRuns.prepare(spec, role, assignment?, harness?)` | 组装快照、工具和预算，执行准入，返回 PreparedRun（含必需、已声明、已验证、缺失的能力） |
| start(prepared, operation_id) | `roleRuns.start` | RunHandle。相同 operation id 返回同一个 handle；重启后已用过的 operation id 返回 `role_run_operation_used`；同一委派已有运行中的 run 返回 `role_run_already_active` |
| events(handle, after_cursor) | `roleRuns.events` | 至多 500 条规范化事件、`next_cursor`、`more`、`ended` |
| checkpoint(handle) | `roleRuns.checkpoint` | `role_run_checkpoint` 记录：可保留的会话引用、已确认/未确认的工具回执、工作区快照 |
| cancel(handle, reason) | `roleRuns.cancel` | 先经会话协议中断，再有限等待；超时则把 run 记为 `stopped/cancel_timeout`，释放运行环境（容器与进程组）并撤销令牌，返回回执 |
| collect(handle) | `roleRuns.collect` | 校验后的结果、`role_result` 引用、输出 CandidateRef 与 RunContext |
| recover(ctx, checkpoint_ref) | `roleRuns.recover(spec, role, assignment, previous_run_id, checkpoint_ref?)` | 同一 role instance、同一 assignment 的新 run（新 `task_runs.id`、新 epoch、`resume_from_run_id`）及恢复模式 |

`runRole` 就是 prepare → start → collect；角色在安全检查点因新 revision 结束时，同一 assignment 以新 run 续接。业务成功只来自通过校验的提交工具，不从文字或退出码推断；角色提交仍不是任务验收。

### RunContext 与 CandidateRef

每个 run 的 `task_runs.run_context` 保存校验过的 RunContext：`task_id`、`assignment_id`、`run_id`、`tenant_id`、`project_id`、`principal_ref`、`source_ref`、`candidate_ref`、`configuration_snapshot_ref`（`role_snapshots:<hash>`）、`lease_epoch`、`resume_from_run_id`、`contract_revision`、`policy_revision`、`role_revision`、`harness_revision`、`skill_revisions`、`model_revision`、`budget`，以及映射到 ExecutionContext 的 `execution_context`（instance、role、kind、环境 profile）。

- `assignment_id`：委派时是 `role_assignments.id`；主控和 QA 没有委派记录，用 `entry:<instance>:<attempt>:<candidate>` 表示入口自身的委派。
- `tenant_id`：项目在身份迁移后的租户；尚未迁移时为 `account:<账号>`。`principal_ref`：人发起的任务为 `principal:<id>`，GitHub 事件任务为 `installation:<账号>`。
- `source_ref`：执行基线提交 `commit:<sha>`，没有时为不可变的 `contract:revision:<n>`。`latest`、`HEAD`、分支名等可变引用被 schema 拒绝。
- CandidateRef 三种：`code`（`ref`、`commit_sha`、`tree_hash`）、`artifact`（`ref`、`revision`、`content_hash`）、`no_changes`（`ref`、`source_ref`、`record_hash`）。观察角色的输入是其检出所依据的 `role_candidate` 快照，QA 是被评估的候选；写者的输出按结果给出三种之一，非代码成果不要求 SHA 或 PR。
- 写入前 RunContext、事件和检查点都经过 `assertSecretFree`：密钥形状的键或值（模型密钥、GitHub 令牌、Bearer、运行令牌、带口令的 URL）直接拒绝，不靠事后脱敏。

### 租约 epoch 与令牌

- epoch 只由控制面在 run 绑定时分配（`allocateLease`），按任务单调递增，并写入 RunContext、运行令牌、事件、检查点。租约还记录调用方执行时持有的任务 claim（引擎的任务执行）；claim 被重新领取同样使旧租约失效。协调者等不在任务 claim 下运行的角色不绑定任务 claim，以自己的 worker claim 和租约 epoch 为准。
- 同一 scope 的新 run 接管租约，旧 run 的令牌立即撤销；旧 run 之后的工具调用、事件、检查点和结果都以 `lease_epoch_stale` 拒绝，它的失败也不会改动 assignment 状态。
- 网络断开后用 `events(handle, cursor)` 续读仍是原 run；重新执行或恢复才新建 run 和 epoch。
- 运行令牌 `rrt_…` 只存哈希，绑定 tenant、project、task、run、epoch 和能力列表（`gateway:<tool>` 等）。默认 15 分钟有效，控制面持有该 run 时每分钟续期，崩溃后自然过期；结束、取消、预算耗尽或被接管时撤销。跨项目/任务/运行复用、过期、撤销、旧租约和伪造均被拒绝。令牌进入运行的脱敏器，trace 再按形状脱敏。
- Process worker 在每次工具 RPC 上出示令牌；ACP 与 Codex 的 MCP loopback 地址路径就是该令牌，每个请求都复核，失效返回 401；运行自身的 guard 发现令牌失效即以 `run_token_revoked` 停止。

### 事件

`role_run_events` 是每个 run 的序号索引，事件正文在 `task_history`（`role_run_event`）。事件含 `run_id`、`seq`、`lease_epoch`、`type`、`category`、`operation_id`、`source_version`。内置事件有 `run_started`、`tool_call`/`tool_result`（同一 operation id）、Harness 公共事件的映射（`session_bound`、`message`、`artifact`、`permission`、`configuration`，以及外部执行器上报的 `turn` 生命周期和 `usage`）、`checkpoint`、`budget`、`cancel_requested`、`ended`。相同序号且内容相同记为重复确认；序号回退、跳号、同号不同内容、同一操作重复、结束后迟到、旧 epoch 均拒绝，并记录 `role_run_event_rejected`。

## TaskToolGateway

### 通用任务管理与来源权限

角色的 `task_management`（禁用／只读／读写）与 `delegation` 独立。前者控制 `list_managed_tasks`、`read_managed_task`、`create_task`、`manage_task`；创建默认由调用角色本人执行，`execute=false` 只记录事项。指定其他执行者还须具有委派权限，目标必须存在并启用。独立 QA 是既有验收门，不由模型选择为执行者。`task_records` 继续控制当前运行的证据和事实记录，不会隐式授予创建或调度其他任务的权限。

无业务 task 的连续会话复用同一角色定义、实例表、Harness、runAgent、预算函数与账本。其协议上下文明确为 `task_id=null, conversation_id=...`，没有候选或正式验收阶段；不能拿会话 finish 代替 QA 或伪造 task。任务实例原键不变，会话实例用 `(conversation_id, project_id, role)` 保持身份，每轮物理输入从当前获准原文／摘要重建。工具次数等计数独立于可清理的私密日志；独立 task 仍使用自己的实例预算，费用可按原来源会话聚合。外部回执共用入账函数，任务预算读取原协议用量时不会再叠加同一回执的账本投影。

模型不能提交 principal、角色、项目、会话或权限字段。入口在控制面签发不可序列化的调用上下文，固定来源消息和权限快照；同一个 `TaskCommands` 服务处理创建、追加、继续、暂停和结束，使用原有任务表、任务记录、角色实例、调度、租约、预算与用量记录。角色只能操作该来源拥有或当前明确分派的任务。Web 人类操作保留已有项目管理授权，不冒充员工角色。事件入口也检查 Manager 当前的任务管理和委派权限；恢复、工具网关及 Publisher 同时检查固定上限与当前授权，来源角色、执行角色或授权人的权限撤销后不能靠重试恢复。有效权限变化时，同一逻辑角色实例丢弃物理会话及 Harness 恢复状态，再从可见事实重建。

旧配置只有原先明确允许 `dispatch` 的角色迁移为任务管理读写；未配置的观察／写者保持禁用。本人执行的普通事项不依赖团队协调开关，也不自动转交 Manager 或 Dev；原有项目团队任务仍保留原流程。角色可通过同一任务服务管理事项，不增加另一套消息专用队列。

任务归属约束与 principal 授权相交：`tasks.manage_own` 可单独授予，已有 `tasks.write` 包含此窄能力，旧授权无需回填。角色来源除工具快照外还固定当时实际具备的 principal 项目能力；恢复和知识读取使用这个上限，后来增加授权不会扩大旧任务。关联子任务逐层检查来源链，根角色的委派、任务管理或工具权限撤销后，不能通过新角色／新 task_id 延续已撤销能力。

普通事项的项目写入集合默认为空；明确允许 `issue` 且来源和执行角色均有 Issue 权限时，才提供 `create_issue`。写入使用既有 Publisher 副作用账本与未知结果对账，稳定 key 重试不会重复建单；不添加开发标签或分派开发。Issue 能力不授予 PR、分支、评论或配置写入，软件交付可在同一 create_task 显式选 reviewable_pull_request 终点；项目需另行允许普通事项 code／pull_request 写集合（默认仍空）且开发开关打开，来源和执行者分别有文件／PR 能力。它与普通 report 共用任务／角色实例／调度／预算，默认本人执行；换人仍要委派。候选、项目测试、独立 QA、Publisher、unknown 对账均沿用原机制，QA 与发布之间权限或策略变化会停止推进；无 Issue 来源不生成关闭编号。

角色读取任务事实、原始记录、证据、项目知识以及提出经验候选，都经 `TaskToolGateway.call(token, request)`。服务端每次复核令牌绑定与有效期、当前 epoch、run 仍在运行、项目与租户、发起人的当前授权（人发起的任务按 `tasks.read`/`knowledge.read`/`knowledge.write`）、角色当前策略（`roleAuthority`）。工具：

| 工具 | 受哪项策略约束 | 说明 |
| --- | --- | --- |
| `read_task_record` | `read_task_record` | 按引用分页展开本任务记录，返回内容与 `version`（sha256），并记 `role_record_read` |
| `list_task_records` | `read_task_history` | 只列引用与类型，不带正文 |
| `search_knowledge` / `read_knowledge` | `search_project_memory` / `read_project_memory` | 复用 ProjectMemory；其他角色的作用域记忆读作不存在 |
| `propose_experience` | `remember_project_memory` | 带本角色可见的证据引用，写入未验证经验；同一 `request_id` 在整个委派内不重复写入 |

引用不是读取全部内容的通行证：其他任务、其他 role instance 的模型交换（`model_requests:`）、run 快照（`task_runs:`）和角色输入、其他角色的作用域记忆，与猜测的 ID 一样返回 `task_record_not_found`/`knowledge_not_found`，不泄露是否存在。网关没有 SQL、shell、发布、合并或配置工具；调用、拒绝（`capability_denied`，`transport: gateway`）和实际读取版本进入 trace（`gateway_call`）。现有驱动都通过网关展开 `read_task_record`：Native 在进程内调用，Process 经 JSON-line RPC，ACP 与 Codex 经 MCP，Pi 经项目电脑 mailbox；`gateway.mcp(token, message)` 提供同一组工具的 MCP JSON-RPC 处理，供后续 CLI 适配器使用。GitHub 写入仍只由控制面 Publisher 执行。

## 准入

`admitRun` 在启动前比较本次运行需要的能力与驱动声明、环境实际验证的能力；缺任何一项即 `unsupported_capability`（`waiting_configuration`），不启动、不换后端，并记 `role_run_admission`（含 required、missing、各项依据）。

| 能力 | 谁需要 | 如何满足 |
| --- | --- | --- |
| `cancel`、`version_binding`、`output_validation` | 所有角色 | 驱动声明，且快照固定、存在框架校验器 |
| `raw_evidence` | 非主控 | 驱动声明 `control_plane_tools` 或 `task_tools` |
| `fixed_candidate_read` | 观察者、QA | 代码候选须有树哈希校验过的检出证据（`role_candidate` 或 `acceptance_started`）；其他候选为不可变记录 |
| `fresh_context` | QA | 驱动声明，且本次没有会话与外部状态 |
| `run_isolation` | 选了隔离环境 profile 的角色 | 驱动声明 `isolation: run_environment`，且控制面复核了这个容器的检查结果 |

内置驱动的声明见 `src/roles/harness.ts`：Native/Pi/Process/Claude Code 为 `control_plane_tools`，ACP 与 Codex 为 `task_tools`；全部 `isolation: none`。它们是兼容后端，注册成功不代表满足隔离；选隔离 profile 时在创建任何环境之前就被拒绝。`registerRoleHarness` 只接受协议词汇的 `capabilities`，未声明即不支持，因此未声明的扩展驱动不能用于任何正式阶段。

## 每次运行的隔离环境

角色配置可选两个新的环境 profile：写者 `isolated-workspace`，观察者与 QA `isolated-candidate`。选中后，控制面经 manager 为这次运行创建一个容器（`POST /v1/projects/:id/runs`，`GET`/`DELETE …/runs/:run`，`POST …/runs/:run/execute`）：

- 复用项目电脑的批准镜像和加固：uid 10001、只读根、丢弃全部 capability、`no-new-privileges`、init。
- 整个 `/workspace`（含 HOME、git store、检出、缓存）和 `/tmp` 都是该容器自己的限额 tmpfs，随容器销毁；没有任何卷或 bind：不挂开发者工作区、项目笔记、宿主 HOME、Docker socket 或其他项目状态，因此也没有共享的可写依赖缓存。
- 网络默认 `none`（只有回环）；需要外网时是该 run 自己的 bridge 网络，不与项目电脑或其他 run 共享网络身份。
- 限制 CPU、内存（不允许额外 swap）、进程数、tmpfs 大小和运行时限；命令不能超过时限，到期由 manager 删除，manager 重启时删除所有遗留的 run 容器。项目配置的环境变量不传入。
- 操作只允许 allowlist 中的类型，且只能指向本 run 自己的 workspace id。

固定候选通过 `git_export`（只含该提交的树与 blob）复制进 run 容器再检出并核对树哈希，而不是挂载开发者卷；开发者之后修改原工作区不会改变检视输入。观察者收集结果时若固定候选已变化，结果以 `candidate_changed` 拒绝，旧环境不能认证新内容。控制面用 `verifyRunEnvironment` 自行核对 manager 报告的检查结果（用户、只读根、capability、挂载、socket、网络、PID/IPC 命名空间、资源限制、凭据形状的环境变量名），任一不符即视为未验证并立即释放。

这不是绝对安全保证：内核、Docker 守护进程和镜像本身仍在信任边界内；本地 `LocalManager` 没有容器，不提供 run 环境。

## 恢复

recover 只返回四种模式：`native_resume`、`checkpoint_restore`（Native/Process 的会话记录恢复，`task_runs.recovery_mode` 仍记 `checkpoint_transcript`）、`rebuilt_from_task_records`、`unsupported`（拒绝恢复，`role_recovery_unsupported`）。`task_runs.protocol_recovery` 记录实际模式；ACP 在 `session_bound` 后才确定。`role_run_recovery` 事件写明依据、丢失范围、被恢复的 run 与 epoch，以及**已开始但没有记录结果的工具调用**，角色应先核验这些副作用再决定是否重试。同一角色 revision 恢复时若解析出不同模型（项目或工作流默认模型被改），恢复以 `model_revision_changed` 拒绝，不静默换模型；显式保存的新 revision 不受此限。

## 预算与用量

`entry-default` 保持入口自身的单次运行上限；`bounded` 沿用 #167 的语义，只压低每次运行的上限。新的 `metered` 按角色实例（任务里的这个角色）累计它的全部运行：恢复、检查点续接、引擎自动重启的新尝试、人工「重试」、后续委派和子代理都算，所以自动重启和重试都不会重开预算。RunContext 的 `budget.accounting` 写明 `per_run` 或 `role_instance`。预算只作用于角色运行，主控不接管的入口仍按入口自身上限执行：

- `metered` 可设 `max_turns`、`max_output_tokens`、`max_total_tokens`、`max_model_requests`、`max_tool_calls`、`max_wall_seconds`、`max_cost`（`{amount, currency}`）。
- 用量来自模型请求账本，加上 Codex 这类自带模型的执行器上报的用量（每条 `usage` 增量算一次未定价请求；已开始却没有任何上报的 turn，在它结束或所在运行结束后算 unknown）：缺少 token 数的请求计入 `unknown_requests`，此时已知用量只是下限（`semantics: lower_bound`），不记为 0；缓存输入是输入的一部分，不重复相加；金额是价格快照的估算，不是供应商账单，存在测量延迟与有限超额。
- 请求数、工具调用数和墙钟时间由控制面确定执行；墙钟计时器即使在工具调用中也会中断会话。
- 耗尽时记录预算事件和检查点、撤销令牌、取消运行（`role_budget_exhausted`，等待配置），已有产物保留；该角色之后的运行在启动前即被拒绝，直到提高预算，不换模型重开预算。已开始的任务固定了启动时的角色配置：提高预算后用 `POST /api/tasks/:id/roles/apply` 把新 revision 应用到该角色，任务随引擎的等待配置轮询继续，也可以重试。

## 查询

```sql
SELECT id, role, assignment_id, lease_scope, lease_epoch, resume_from_run_id, recovery_mode, protocol_recovery, status, stop_reason
FROM task_runs WHERE task_id = '<task>' ORDER BY rowid;
SELECT type, data FROM task_history WHERE task_id = '<task>'
  AND type IN ('role_run_admission','role_run_event','role_run_checkpoint','role_run_recovery','role_run_cancelled','gateway_call','role_run_environment')
ORDER BY id;
```

验证命令：`npm test`（`test/role-run.test.mjs`、`test/run-environments.test.mjs`）与真实 Docker 隔离验收 `npm run test:isolation:docker`（验收记录在 Issue #169）。

正式 task 与主会话使用同一外部模型账本。ACP 每次 prompt 尝试留下 acp_prompt 回执；它不能证明真实 provider 调用次数或 token，原任务预算查询因此返回 unknown_requests 与 lower_bound，金额保持未知，不当成免费或已知零用量。Claude provider 渐进回执和 Codex 线程 delta 记入同一发票后，任务预算仍以原协议事件为准，不再把投影账单加一次。

普通事项的执行提示和主会话任务读取使用同一 TaskRecords.context，只携带候选 artifact／evidence 引用，不把完整命令日志复制进之后的每次模型请求。read_managed_task 可按已提供的 source、offset、length 复用原 readEvidence 分页读取；原任务归属、来源失效与知识访问检查仍生效，原始任务审计不被裁剪。
