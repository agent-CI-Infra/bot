# Issue #171：Codex app-server Harness 验收

实现基线 `638afa4`（main，已在其上变基）。本项没有新写 Codex 客户端：`codex` harness 与 `acp` 是同一个外部执行器客户端（`src/harness/acp.ts`），公共生命周期不变，新增的是第二种线协议方言 `src/harness/app-server.ts`。用法与边界见 [Harness Runtime](harness-runtime.md#启用-codex-app-server)，RoleRun 事件与用量见 [RoleRun 协议](role-run.md)。

## 在通用客户端上补的部分

原 ACP 客户端只有 ACP v1（`initialize`、`session/new|load`、`session/prompt`、`session/cancel`）。为直接驱动 `codex app-server`，在同一客户端上补了：

- 启动：`BOT_CODEX_CONFIG`，只接受自己的 stdio `app-server`、专用的绝对路径 CODEX_HOME（不能是宿主 `~/.codex`）、固定版本和 `read-only` sandbox。
- 线协议：不带 `jsonrpc` 成员的 JSON-RPC 行，按字节分片重组（含多字节字符），请求按 id 关联，未知/重复应答与未知通知记为异常，格式不符或断流使所有待决请求失败。
- 握手：`initialize` → `initialized`，核对 CLI 版本（配置、实际报告、协议锁定三者一致）和实际 CODEX_HOME。
- thread：`thread/start`；已有绑定时先核对 model/provider，再显式 `thread/resume`，核对返回的 thread ID、会话目录和 model/provider。只有服务器明确回答 `no rollout found` 时才记 `native_resume_failed` 并以新 thread 重建，且重建的 model/provider 必须与绑定一致；其他恢复错误以 `codex_resume_failed` 失败并保留绑定。绑定分开记录正在跟踪的 turn（可能未确认）和最后一个确实存在的 turn（`knownTurnId`）：发出 `turn/start` 前前者记为「可能已开始」，应答未到时通知里的新 turn id（含 `turn/started` 的 `params.turn.id`）立即写入并可被中断，明确拒绝时绑定原样恢复；上次 turn 未确认完成时用 `thread/turns/list` 对账，只知道「可能已开始」时按线程最新的 turn 与 `knownTurnId` 比较。
- 内建工具：thread 配置关闭 `shell_tool`、`view_image`、`multi_agent`、`apps`、`plugins`、`goals`、`sleep_tool` 并禁用网页搜索；首个 turn 前核对 sandbox/审批策略，并用带 threadId 的 `experimentalFeature/list` 读回开关，未关闭即拒绝。运行中出现命令执行、图片读取、网页搜索、未经批准已应用的补丁或子 agent 时，经公共停止路径立即结束运行（任务工具拒绝、中断、宽限期后回收进程组）。
- 工具：thread 只配置本轮 loopback MCP `bot`；首个 turn 前用 `mcpServerStatus/list` 核对只有 `bot` 且工具恰为 offered tools。
- turn：`turn/start` 后只以该 turn 的 `turn/completed` 为终结，`interrupted`/`failed` 不算完成；`model/rerouted` 走同一停止路径，宽限期内以 `codex_model_rerouted` 失败；取消用 `turn/interrupt` 并等待终结回执，超时后回收进程组。
- 事件与权限：item、turn、usage 映射为统一事件（带 thread/turn/item ID），reasoning 不留存；全部 10 种服务器请求按角色授权明确答复。会话绑定提交前收到的用量随绑定一起提交，绑定前被拒时不记录；已开始而没有用量回执的 turn 在运行结束后计为未知请求。
- 协议锁：`codexAppServer`（CLI `0.166.0`、所依赖 schema 定义的摘要）与 `scripts/codex-protocol-lock.mjs`。

平台侧的接入：`codex` 注册在 `src/roles/harness.ts`（与 ACP 相同的能力声明，`isolation: none`）；RoleRun 事件新增 `turn`、`usage` 两种类型；`metered` 预算计入 Codex 上报的用量；Codex 绑定的协议、model/provider、CLI 版本、最近 turn 及线程累计用量进入可保留的检查点状态；新增失败码进入既有分类与提示。

## 合约测试（协议替身，不是 Codex）

`test/codex-harness.test.mjs` 对 `test/fixtures/codex-app-server.mjs` 运行，59 项：

- 握手顺序、工具核对先于首个 turn、thread/turn 绑定、分片输出（按 7 字节切开行与中文字符）、重复 item/未知通知/未知应答只记异常、私有推理与配置密钥不进 trace、RoleRun 事件流与用量。
- 权限：锁定版本全部 10 种服务器请求（另加一条其他 thread 的请求）分别得到的答复，以及 `capability_denied` 与事件分类。
- 内建工具：thread 参数里的关闭项与 read-only/on-request、分两页读回的开关状态；服务器没应用开关或 sandbox 时不开始 turn；服务器不发审批请求就执行命令、应用补丁或派生子 agent 时（含应答与越权 item 同块到达），宽限期内停止、拒绝之后的工具调用并回收进程。
- 改路由时忽略中断仍在宽限期内以 `codex_model_rerouted` 结束并回收进程。
- 恢复：同一 thread 的 native_resume、恢复后重述的用量不重复计、本地 thread 丢失后的显式重建、`-32603` 等其他恢复错误保留绑定并失败、thread 丢失时不借重建换默认模型/provider、终结前断流失败且下一轮先对账；turn/start 未应答时，已知 turn id 写入绑定，没有 id 时绑定记为「可能已开始」，下一轮都先 `thread/turns/list` 对账并提示核对副作用；上一 turn 的迟到通知不会被当成这次开始的 turn，对账为 `not_started` 之后也一样；只有标准 `turn/started` 时取消对该 turn 发出 interrupt 并收到终结回执；明确拒绝的 start 不改变绑定；应答 C 与更早 turn B 的迟到 item、终结同块到达时只由 C 的终结结束这次 turn，绑定不会变成 B/completed；没有应答时，`turn/started` 会替换由迟到 item 猜出的旧 turn；B 的终结也不能充当取消 C 的回执，C 忽略中断时等满宽限期，回执为 `timeout`；应答 C、B 的 item 与终结、C 的越权 item 同块到达时，停止也中断并等待 C；应答已确定 C 之后保存或记录 started 失败（故障注入），无论之前有没有旧 hint，绑定都保留 C 为未确认完成，不发 `start_unconfirmed`，下一轮对账 C；C 的第一次绑定写库失败时，从数据库读回的仍是 C 而不是 hint B；started 没写进去时 C 以 `answered` 事件计一次未知（A 后为 2 次请求、1 次未知、110 token、lower_bound，恢复后 D 只新增 D，C 之后有用量回执时按 id 去重）。
- 用量：断流、中断超时、turn/start 未应答且没有用量时记为未知请求（`lower_bound`），仍在进行的 turn 不提前计入；turn/start 未应答但先收到该 turn 的 110 token 用量时只计 1 次请求、0 次未知（`exact`）；绑定前两次被拒后，重述的同一增量在成功绑定时只计一次（账本 110 → 330，而不是重复累计）。
- 失败：认证失败、未提交、CLI/配置版本不符、实际模型不符、额外 MCP 服务、模型改路由、任务工具启动失败、CODEX_HOME 不符、进程退出、恢复时模型改变、thread 归属不符；都不产生角色结果。会话在绑定前被拒时，原有 thread 绑定原样保留。
- 取消：有终结回执、忽略中断（超时回收）、中断后迟到的 `completed` 都不能完成运行。
- 角色隔离与 QA 新 thread；`LineRpc` 单元；启动配置限制。

## 真实 Codex CLI（无模型凭据）

本机 Codex CLI `0.166.0`，专用的空 CODEX_HOME（没有登录状态，没有读取宿主 Codex 配置），用 `node scripts/acp-smoke.mjs <dir> codex` 走完整的 `runRole` 路径，连续三次运行同一个 role instance：

| 运行 | 观察 |
| --- | --- |
| 1 | 握手与版本、CODEX_HOME 核对通过；`thread/start` 得到 thread `01a1be32-c7cc-7b92-b45f-37d6d3fde15e`（`openai/gpt-6.1-sol`，CLI 默认）；Codex 实际连上本轮 MCP，`mcpServerStatus/list` 只有 `bot`，工具为 `read_task_record`、`submit_role_result`；`instructionSources` 为空。turn `01a1be32-c86b-…` 在 401 后以 `failed` 终结，映射为 `codex_authentication_failed`（等待配置），run 记 fault，没有角色结果。 |
| 2 | 另一个进程打开同一 SQLite：实际 `thread/resume` 同一 thread，`recovery_mode`/`protocol_recovery` 为 `native_resume`；上次 turn 状态经 `thread/turns/list` 对账为 `failed`。新 turn 同样因认证失败结束。 |
| 3 | `--cancel-after-turn`：turn 开始后取消任务，客户端发出 `turn/interrupt`，收到真实的 `interrupted` 终结回执（`interrupt_receipt: terminal`）后回收进程，run 为 fault，错误 `task_cancelled`。 |

### 真实 CLI 对接脚本化端点（不是模型）

`node scripts/codex-scripted-probe.mjs` 让同一 CLI 对接本地脚本化的 Responses 端点（专用 CODEX_HOME 声明本地 provider，不用凭据），走完整 `runRole` 路径。脚本先尝试 `exec_command` 读 `/etc/hostname` 和 `apply_patch` 写文件，再经 Bot MCP 读取并提交任务事实。

| 模型族 | CLI 交给模型的工具 | 结果 |
| --- | --- | --- |
| `gpt-6.1-sol`（CLI 默认，code mode） | `exec`（V8 isolate，内嵌 `apply_patch`、MCP 资源读取、时钟）、`wait`、`request_user_input`、子 agent 工具；没有 `exec_command`/`write_stdin`/`view_image` | 没有命令执行；`apply_patch` 触发真实 `item/fileChange/requestApproval`，客户端拒绝，文件未写入；两次 MCP 调用各触发一次 `bot` 的 elicitation，客户端允许；3 条用量事件；角色结果经任务工具提交 |
| `gpt-5.1-codex`（函数工具） | MCP 资源读取、`request_user_input`、`mcp__bot` 命名空间下的两个任务工具 | 调用 `exec_command` 没有对应工具，未执行；MCP 调用与 elicitation 同上；3 条用量事件；角色结果提交 |

同一脚本对检视前的实现（`6e78259`）运行时，两种模型族都提供 `exec_command`，宿主命令在没有任何审批请求的情况下执行完成（`commandExecution` completed），角色结果照样提交：这就是 P1 缺口的真实复现。子 agent 工具在 `gpt-6.1-sol` 上无法用配置关闭；探测确认子 agent 继承同样受限的工具集，客户端仍在其出现时停止运行。

`node scripts/codex-protocol-lock.mjs` 在同一 CLI 上重新生成 schema，版本与摘要一致、46 个定义齐全、10 种服务器请求都有答复。

## 尚未验证

- 没有带真实模型的运行。以下三项仍未完成，需要提供专用 CODEX_HOME 的登录或受限 API key 后补做；空 CODEX_HOME 的 CLI 记录和脚本化端点的探测都不能当作已完成：
  1. 真实 Pi 委派经 Codex 完成小型代码任务和实际测试，并通过框架独立 QA；
  2. 真实模型发起的权限请求，以及授权允许、越权拒绝与外层约束的对照；
  3. 真实模型的用量事件、增量累计、跨恢复去重与预算行为。
- 运行环境：Codex 与 ACP 一样在控制面主机上运行，声明 `isolation: none`；不能用于要求 `run_isolation` 的角色。控制面镜像没有内置 Codex CLI，由部署操作人安装锁定版本。
- 本项没有修改阶段门禁（#168）、控制台页面或任务队列；没有在 GitHub 上试验。
