# Issue #171：Codex app-server Harness 验收

实现基线 `87906e0`（main）。本项没有新写 Codex 客户端：`codex` harness 与 `acp` 是同一个外部执行器客户端（`src/harness/acp.ts`），公共生命周期不变，新增的是第二种线协议方言 `src/harness/app-server.ts`。用法与边界见 [Harness Runtime](harness-runtime.md#启用-codex-app-server)，RoleRun 事件与用量见 [RoleRun 协议](role-run.md)。

## 在通用客户端上补的部分

原 ACP 客户端只有 ACP v1（`initialize`、`session/new|load`、`session/prompt`、`session/cancel`）。为直接驱动 `codex app-server`，在同一客户端上补了：

- 启动：`BOT_CODEX_CONFIG`，只接受自己的 stdio `app-server`、专用的绝对路径 CODEX_HOME（不能是宿主 `~/.codex`）和固定版本。
- 线协议：不带 `jsonrpc` 成员的 JSON-RPC 行，按字节分片重组（含多字节字符），请求按 id 关联，未知/重复应答与未知通知记为异常，格式不符或断流使所有待决请求失败。
- 握手：`initialize` → `initialized`，核对 CLI 版本（配置、实际报告、协议锁定三者一致）和实际 CODEX_HOME。
- thread：`thread/start`；已有绑定时先核对 model/provider，再显式 `thread/resume`，核对返回的 thread ID、会话目录和 model/provider；本地 thread 丢失时记 `native_resume_failed` 并以新 thread 重建；上次 turn 未确认完成时用 `thread/turns/list` 对账。
- 工具：thread 只配置本轮 loopback MCP `bot`；首个 turn 前用 `mcpServerStatus/list` 核对只有 `bot` 且工具恰为 offered tools。
- turn：`turn/start` 后只以该 turn 的 `turn/completed` 为终结，`interrupted`/`failed` 不算完成；`model/rerouted` 停止；取消用 `turn/interrupt` 并等待终结回执，超时后回收进程组。
- 事件与权限：item、turn、usage 映射为统一事件（带 thread/turn/item ID），reasoning 不留存；全部 10 种服务器请求按角色授权明确答复。
- 协议锁：`codexAppServer`（CLI `0.166.0`、所依赖 schema 定义的摘要）与 `scripts/codex-protocol-lock.mjs`。

平台侧的接入：`codex` 注册在 `src/roles/harness.ts`（与 ACP 相同的能力声明，`isolation: none`）；RoleRun 事件新增 `turn`、`usage` 两种类型；`metered` 预算计入 Codex 上报的用量；Codex 绑定的协议、model/provider、CLI 版本、最近 turn 及线程累计用量进入可保留的检查点状态；新增失败码进入既有分类与提示。

## 合约测试（协议替身，不是 Codex）

`test/codex-harness.test.mjs` 对 `test/fixtures/codex-app-server.mjs` 运行，25 项：

- 握手顺序、工具核对先于首个 turn、thread/turn 绑定、分片输出（按 7 字节切开行与中文字符）、重复 item/未知通知/未知应答只记异常、私有推理与配置密钥不进 trace、RoleRun 事件流与用量。
- 权限：shell 命令、文件变更、sandbox 提权、其他 MCP 服务、URL elicitation、用户提问、动态工具、令牌刷新、其他 thread 的请求分别得到的答复，以及 `capability_denied` 与事件分类。
- 恢复：同一 thread 的 native_resume、恢复后重述的用量不重复计、本地 thread 丢失后的显式重建、终结前断流失败且下一轮先对账。
- 失败：认证失败、未提交、CLI/配置版本不符、实际模型不符、额外 MCP 服务、模型改路由、任务工具启动失败、CODEX_HOME 不符、进程退出、恢复时模型改变、thread 归属不符；都不产生角色结果。会话在绑定前被拒时（即使期间已收到用量上报），原有 thread 绑定原样保留。
- 取消：有终结回执、忽略中断（超时回收）、中断后迟到的 `completed` 都不能完成运行。
- 角色隔离与 QA 新 thread；`LineRpc` 单元；启动配置限制。

## 真实 Codex CLI（无模型凭据）

本机 Codex CLI `0.166.0`，专用的空 CODEX_HOME（没有登录状态，没有读取宿主 Codex 配置），用 `node scripts/acp-smoke.mjs <dir> codex` 走完整的 `runRole` 路径，连续三次运行同一个 role instance：

| 运行 | 观察 |
| --- | --- |
| 1 | 握手与版本、CODEX_HOME 核对通过；`thread/start` 得到 thread `01a1be32-c7cc-7b92-b45f-37d6d3fde15e`（`openai/gpt-6.1-sol`，CLI 默认）；Codex 实际连上本轮 MCP，`mcpServerStatus/list` 只有 `bot`，工具为 `read_task_record`、`submit_role_result`；`instructionSources` 为空。turn `01a1be32-c86b-…` 在 401 后以 `failed` 终结，映射为 `codex_authentication_failed`（等待配置），run 记 fault，没有角色结果。 |
| 2 | 另一个进程打开同一 SQLite：实际 `thread/resume` 同一 thread，`recovery_mode`/`protocol_recovery` 为 `native_resume`；上次 turn 状态经 `thread/turns/list` 对账为 `failed`。新 turn 同样因认证失败结束。 |
| 3 | `--cancel-after-turn`：turn 开始后取消任务，客户端发出 `turn/interrupt`，收到真实的 `interrupted` 终结回执（`interrupt_receipt: terminal`）后回收进程，run 为 fault，错误 `task_cancelled`。 |

`node scripts/codex-protocol-lock.mjs` 在同一 CLI 上重新生成 schema，版本与摘要一致、41 个定义齐全、10 种服务器请求都有答复。

## 尚未验证

- 没有带模型的真实运行：本机没有可用于 Codex 的受控模型凭据，因此 item 映射、服务器权限请求、用量事件与真实任务完成只由协议替身覆盖；真实 Pi 委派经 Codex 完成小型代码任务并经框架 QA，以及真实权限请求，需要提供专用 CODEX_HOME 的登录或受限 API key 后补做。
- 运行环境：Codex 与 ACP 一样在控制面主机上运行，声明 `isolation: none`；不能用于要求 `run_isolation` 的角色。控制面镜像没有内置 Codex CLI，由部署操作人安装锁定版本。
- 本项没有修改阶段门禁（#168）、控制台页面或任务队列；没有在 GitHub 上试验。
