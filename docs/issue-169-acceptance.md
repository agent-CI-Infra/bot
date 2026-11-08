# Issue #169：独立 RoleRun、统一 Harness 协议与能力/预算 验收

实现基线 `331ec0c`（已含 #163、#167、#176），之后变基到 `6873033`（含 #189–#192 的任务协调，以及其后 Native 提交与协调上下文的修正）；下文证据在变基前取得，变基后重跑了全量单测。角色运行的 `rebuildContext` 选项（协调者使用）从空会话开始、记 `rebuilt_from_task_records`，仍走同一 RoleRun 协议。协调者（coordinator）以自己的 worker claim 运行，它的 RoleRun 租约不绑定任务 claim。协议与边界见 [RoleRun 协议](role-run.md)。本期交付协议、控制面事实、任务工具网关、准入、每运行容器、预算与恢复；三个 CLI 驱动（#170–#172）与阶段门禁（#168）不在本期。下文的证据来自确定性测试、真实 Docker 容器和本地 HTTP 控制面上的用户场景；没有使用真实模型或真实 GitHub，不对模型质量下结论。

## 复核方法

- `npm ci && npm ci --prefix runner --omit=dev --ignore-scripts && npm run check && npm test`。新增 `test/role-run.test.mjs`（协议、租约、令牌、网关、事件、准入、恢复、预算、取消、候选绑定）与 `test/run-environments.test.mjs`（manager 的 run 环境、API 与控制面复核）。
- `npm run test:isolation:docker`：以本机已有的项目电脑镜像为底叠加本检出的 runner，构建随机标签的测试镜像；manager 在进程内以独立 deployment id 运行；结束后只删除该 deployment 标签下的容器、网络、卷和测试镜像。证据写到 `.tmp/role-run-docker/evidence-<tag>.json`。

## 按验收标准

| 标准 | 证据 |
| --- | --- |
| 只给引用时经受控网关按权限展开；跨任务/角色受限来源、过期 epoch、猜测 ID 被拒绝；实际读取版本与观察进入 trace | `role-run.test.mjs` 网关用例：本任务 `task:`、共享的 `role_result` 可读并带 sha256 `version`；其他任务的记录、其他 role instance 的 `role_input`/`model_requests`/`task_runs` 快照、猜测的 `task_history:999999`、不存在的合同版本都返回同一个 `task_record_not_found`；其他角色的作用域记忆 `knowledge_not_found`；接管后令牌被撤销。所有 Native/Process/ACP 的 `read_task_record` 都经网关（`gateway_call`、`role_record_read` 含 `via: gateway`）。 |
| 真实隔离环境下，一个角色读不到另一角色/项目的 HOME、进程环境或可写卷；恶意绝对路径、符号链接、共享缓存污染被阻断 | Docker 验收：开发者 HOME 里的秘密与带秘密环境变量的后台进程在项目电脑上可见（正对照），在 reviewer 的 run 容器里 HOME 文件不存在、进程与 `/proc/*/environ` 均不可见；`/var/run/docker.sock`、项目笔记不存在；根与 `/opt/runner` 只读；网络只有回环且无 DNS。`/etc/passwd` 绝对路径、`../../home` 穿越、指向 `/etc/passwd` 与工作区外的符号链接、指定别的 workspace id 全部拒绝。第二个 run 写入的 npm 缓存、HOME 秘密和后台进程在它自己容器里存在（正对照），在第一个 run 里都不可见。控制面 `verifyRunEnvironment` 对 manager 报告逐项复核（`run-environments.test.mjs` 中挂 Docker socket 的容器被判 `external_mount`、`docker_socket` 并立即释放）。 |
| reviewer/test/QA 对固定候选执行，开发者并发修改原工作区不改变其输入；候选或策略变更后旧环境不能认证新内容 | Docker 验收：候选以 `git_export` 复制进 run 容器并核对树哈希；之后开发者改 `a.txt`、加 `b.txt`，reviewer 看到的内容与树不变；写者 run 的候选经提交复制交给新的 reviewer，写者之后的修改也不影响它。`role-run.test.mjs`：检视期间 `role_candidate` 变化时结果以 `candidate_changed` 拒绝，不写 `role_result`。策略收紧仍由 #167 的 `role_authority_revoked` 实时停止，collect 时再查一次。 |
| 令牌跨项目/任务/运行复用、过期、撤销、旧 lease 与伪造事件被拒绝；worker 不能推分支、合并或改控制面配置 | 令牌用例逐项得到 `run_token_scope_mismatch`、`run_token_expired`、`run_token_revoked`、`lease_epoch_stale`、`run_token_invalid`、`run_token_capability_denied`；任务 claim 变化也使旧租约失效。事件用例：重复确认、乱序、跳号、同号冲突、旧 epoch、结束后迟到均拒绝并记 `role_run_event_rejected`。Process worker 在令牌撤销后的下一步以 `run_token_revoked` 停止；MCP 桥返回 401。网关对 `create_pull_request`、`merge_pull_request`、`update_role_configuration`、`sql`、`run_command` 一律 `tool_not_allowed`；run 容器没有 GitHub 凭据、网络或 Docker socket，GitHub 写入仍只有控制面 Publisher。 |
| 重复 start、断流、进程崩溃、取消不响应和重启有确定结果；已确认操作不盲目重放；恢复模式与未知观察可查 | 同一 operation id 的 start 返回同一 handle；重启后已用过的 id 返回 `role_run_operation_used`；同一委派并发第二个 run 返回 `role_run_already_active`。事件游标分页续读得到完整且不重复的序列。模拟重启后同一 assignment 新建 run：新 `task_runs.id`、更大 epoch、相同 instance 与 assignment、`resume_from_run_id` 指向旧 run、`protocol_recovery=checkpoint_restore`；`role_run_recovery` 列出已开始但无结果的工具调用；被放弃的旧 run 迟到的结果以 `lease_epoch_stale` 拒绝。取消不响应时 200 ms 后记 `stopped/cancel_timeout`、撤销令牌；Process worker 在等待内被协议中断。经验候选按 `request_id` 不重复写入。同一角色 revision 解析出不同模型时恢复以 `model_revision_changed` 拒绝。manager 重启删除所有遗留 run 容器。 |
| 超时、超资源、超预算能中止受管子进程；用量未知不计零；清理后证据和诊断仍在任务记录中 | Docker 验收：进程数上限（fork 失败）、内存上限（137 被杀）、磁盘上限（tmpfs 256 MiB 写满即停）、输出上限（截断）、运行时限（命令 `timed_out`，到期后容器被删除）。`role-run.test.mjs`：`metered` 预算 `max_model_requests=3` 耗尽后记录检查点与预算事件、撤销令牌、运行以 `role_budget_exhausted` 结束；同一委派的下一次、同一角色的新委派、任务新尝试里的运行都在启动前被拒绝（预算按角色实例累计），未换模型；一次缺少用量的请求计入 `unknown_requests`，`semantics=lower_bound`，缓存 token 不重复相加。 |
| 不支持隔离、原始证据或取消的 adapter 被拒绝用于对应正式门禁；通过合约测试的 adapter 可正常接入 | 未声明能力的注册驱动在启动前 `unsupported_capability`（缺 cancel、version_binding、output_validation、raw_evidence），没有 run 行；Native、Process、ACP 选隔离 profile 时保存即被拒（字段 `roles.reviewer.environment_profile_ref.id`），运行时覆盖为 Native/Process 也在创建任何环境前被拒。声明合约并在环境内执行的驱动只在环境验证通过时准入。Docker 验收里这样的驱动在真实 run 容器内检视固定候选并提交，环境在收集后释放；内置 Native 对同一 profile 被拒且没有创建环境。 |
| trace/产物导出不含令牌、全局配置或私有推理；普通仓库提示词无法提升能力，标准授权开发无需反复人工确认 | 运行、事件、checkpoint 与令牌表中检不到模型密钥或 `rrt_` 令牌（令牌只存哈希，trace 按形状脱敏，RunContext 写入前拒绝密钥形状）；用户场景的事件导出同样检不到。能力只来自配置的策略与驱动声明，提示词、仓库内容和结果文本不参与准入；预授权范围内的工具直接执行，越权调用拒绝并记 `capability_denied`，不引入人工审批。 |

## 用户场景（本地 HTTP 控制面）

临时数据库上的真实控制面 HTTP API，项目管理员身份：「角色」接口列出 `isolated-workspace`、`isolated-candidate`、`metered` 与各驱动的 `isolation: none`；Native 选隔离 profile 返回 400 `unsupported_capability` 并指出字段，revision 不变；`max_cost` 币种错误与未知预算字段同样按字段拒绝；`metered` 预算保存成功。一个 dev 运行经网关读取任务事实、猜测的引用被拒，预算耗尽后 `/api/tasks/:id/roles` 显示 `fault/role_budget_exhausted`、epoch 和完整 RunContext，检查点可在事件中查到，再次运行被拒；reviewer 在模拟重启后由新 run（epoch 3、`resume_from_run_id` 指向 epoch 2 的 run、`checkpoint_restore`）完成，被放弃的 run 返回 `lease_epoch_stale`；事件导出不含模型密钥或运行令牌。剧本条目见文档库 `runbook/user-scenario-playbook/169-role-run.md`。

## 限制

- 内置 Native、Process、ACP、Pi 都不声明 run 隔离，仍在控制面或共享项目电脑执行；隔离 profile 需要在 run 容器内执行的驱动（#170–#172 等）。容器隔离依赖内核、Docker 守护进程与镜像，不是绝对安全保证；`LocalManager` 没有 run 环境。
- 写者 run 的候选可导出为提交（Docker 验收覆盖），但把它接入现有交付/发布路径属于后续驱动接入；本期的发布仍走原 Publisher。
- 金额预算基于价格快照估算，存在测量延迟与有限超额，不保证供应商账单不超过估算。
- 本机长期部署和真实 GitHub 均未变更；剧本中的真实 GitHub 场景需要部署包含本变更的版本后在 `agent-test-zone/bot-playbook` 上跑。
