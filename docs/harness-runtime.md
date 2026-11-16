# Harness Runtime

Role 服务选择执行器并组装角色说明、assignment 和任务事实引用；Harness 负责会话连接与执行，不负责组队、验收或发布。定义、持续会话与本轮执行分别映射现有 Harness 注册、`role_instances`、`task_runs`；没有第二套任务系统。

## 公共边界与后端目录

`roleHarness(id).createSession(spec, services)` 创建公共会话；原 adapter 入口保留为兼容包装，实际执行统一经过该会话。`HarnessSession<T>` 提供 `id / run / cancel / close`。持续上下文按后端类型保存在 `role_instances` 或容器持久化目录，下一轮按恢复协议续接或从任务事实重建，不要求控制面常驻子进程。

当前已注册的 Agent 后端：

- **内部驱动（`pi`、`native`、`process`）**：支持 `controller`、`writer`、`observer`、`evaluator` 四类角色；新角色默认推荐 `pi`。`pi` 在项目容器中运行 Pi SDK 会话，`native` 使用控制面内置工具循环，`process` 运行独立 Node worker 子进程。
- **容器内外部 CLI 驱动（`claude_code`、`codex`）**：仅支持工作与评估角色（`writer`、`observer`、`evaluator`），不支持 `controller`（不能选作 `manager` 或 `coordinator`）。两者均在项目容器（`Workspace`）及每运行隔离容器（`RunEnvironments`，声明 `isolation: run_environment`）内执行，直接以 `<task_dir>/repo` 为工作目录开放原生终端、文件读写/编辑与子 Agent 能力，通过容器内回环模型中转（`127.0.0.1:0`）访问平台多格式模型网关，并通过 stdio MCP 服务 `bot`（`runner/mcp-bridge.mjs`）调用平台管理工具。历史通用 `acp` 驱动与 `opencode` 待接入占位已下线。

公共协作与安全边界：

- **Role/Manager**：选择角色、assignment、人设、记忆入口与 Harness；Review 反馈通过持久化引用回到同一 `dev` 实例。
- **任务与平台工具**：`claude_code` 与 `codex` 在容器内经 `runner/mcp-bridge.mjs`（stdio MCP `bot`）调用与内置路径相同的平台工具、执行器与完成提交校验器；已被容器原生工具替代的底层 `read_file`/`write_file`/`run_command`/`start_agent` 不在 MCP 重复提供。提交通过后不再接受后续工具修改。
- **工作区与凭据隔离**：容器内 CLI 在 `<task_dir>/repo` 直接操作任务检出；长期上游模型密钥与长期 GitHub 凭据永不进入容器。模型请求携带运行级身份令牌 `rrt_…` 经文件邮箱中转至控制面；Git 与 `gh` 通过 `runner/git-credential-bot.mjs` 和 `runner/gh-wrapper.mjs` 按需申请短期只读安装令牌并流式脱敏。
- **安静日志与 Trace**：容器内原生 shell 命令与文件编辑不逐条刷写控制面运行事件；公开 `task_history` 记录平台 MCP 工具调用、模型网关请求轨迹与公开文本摘要，不留存私有 `reasoning`/`thinking`。
- **QA/Publisher**：执行器正常结束不代表任务验收通过；角色结果继续经框架校验，QA 始终使用全新上下文与固定候选检出，远端发布和合入仍由受控 Publisher 执行。

Claude Code 的完整说明见 [Claude Code harness](claude-code.md)；下文说明容器内 Codex（`codex app-server`）驱动。

## 容器内 Codex（`codex app-server`）

`codex` 驱动（`src/harness/codex.ts` + `src/harness/app-server.ts`）通过 `runner/harness-entry.mjs` 在容器内以独立进程组启动 `codex app-server`（stdio JSON-RPC 协议），兼容范围由 `src/harness/agent-tools.ts` 管理（当前 `>=0.166.0 <1.0.0`，协议基线 `0.166.0`；可用 `node scripts/codex-protocol-lock.mjs` 复核协议摘要）。

### 工具卷与配置

- **正式运行（只读工具卷 `/opt/agent-tools`）**：由控制面 `AgentToolManager`（`/api/agent-tools/install`）安装静态链接 musl 二进制至 `/opt/agent-tools/codex/<version>/bin/codex`（校验 SHA-256 并记录 `manifest.json`）。`prepare` 自动选择最高兼容版本并记录到 `task_runs.cli_version`。
- **模型与模型来源**：默认使用 `model_source: "gateway"`，按角色 `model_profile_ref`、工作类型模型或项目默认模型解析，由 `harness-entry.mjs` 生成独立 `CODEX_HOME/config.toml`，将 `model_provider` 设为指向本轮回环中转（`http://127.0.0.1:<port>/v1`，`wire_api = "responses"`，`env_key = "BOT_RUN_TOKEN"`）的 `bot_relay`。`model_source: "subscription"` 接口与配置项已预留，选择后展示“未实现”并在解析/准备阶段返回 `subscription_mode_not_implemented`。
- **宿主机回退配置（开发/合约测试）**：设置 `BOT_CODEX_CONFIG=/absolute/path/codex.json` 可显式指定本地二进制或协议替身、状态目录与测试供应商配置。

角色配置示例：

```json
{
  "expected_revision": 3,
  "enabled": true,
  "roles": [
    {
      "role_id": "dev",
      "harness_ref": { "id": "codex", "model_source": "gateway" },
      "model_profile_ref": { "model_id": "<model id>" },
      "environment_profile_ref": { "id": "isolated-workspace" }
    }
  ]
}
```

### 协议、原生工具与护栏

- **握手与 thread**：`initialize`（屏蔽 delta 与私有推理流）→ `initialized` → `thread/start`（或核验后 `thread/resume`）。`CODEX_HOME` 位于 `/workspace/tasks/<state_workspace_id>/cli-state/<session_key>/codex-home`，不共享宿主或跨角色目录；`initialize` 返回的版本与 `codexHome` 不符即以 `codex_version_unsupported` / `codex_home_unexpected` 拒绝。
- **容器原生工具与 MCP 核验**：容器本身提供只读根、UID 10001、capability 丢弃与网络隔离，因此容器内 thread 以 `approvalPolicy: "never"`、`sandbox: "danger-full-access"` 启动，显式开启 `shell_tool`、`unified_exec`、`view_image`、`multi_agent`，关闭 `apps`、`plugins`、`goals`、`sleep_tool`、`hooks`、`memories`，并根据容器 `egress` 开关控制 `web_search`（无外网时固定 `disabled`）。唯一注册的 MCP 服务是 stdio `bot`（`runner/mcp-bridge.mjs`，`tool_timeout_sec = 3600`）。首个 turn 开始前通过 `experimentalFeature/list` 与 `mcpServerStatus/list` 逐项核对：功能开关不符、出现额外 MCP/插件服务或暴露工具与本轮平台工具不一致时，立即以 `codex_builtin_tools_enabled`、`codex_unauthorized_tool_servers` 或 `codex_task_tools_mismatch` 终止。
- **运行中实时拦截**：运行中若出现未注册动态工具（`dynamicToolCall`）、无外网权限下的 `webSearch` 或非 `bot` 的外部 `mcpToolCall`，立即记录 `capability_denied`、拒绝后续平台工具调用、发送 `turn/interrupt` 并在宽限期后回收整个容器进程组，以 `codex_builtin_tool_refused` 失败。同样，若收到 `model/rerouted`，立即中断并以 `codex_model_rerouted` 失败，绝不静默切换模型。
- **服务器请求答复**：容器内工作区命令与文件变更请求在角色具备计算权限且租约有效时允许，沙箱提权、交互式提问、动态工具调用、账号令牌刷新及跨 thread 请求一律拒绝并记录 `permission` 事件。
- **取消与进程组回收**：取消时若 `turn/start` 已获知或随后流式到达 turn ID，立即发送 `turn/interrupt` 并在 `cancelGraceMs`（默认 5 秒）内等待该 turn 自身的终结回执（`interrupt_receipt` 记录 `terminal` 或 `timeout`），随后通过 `workspace_harness_interrupt` 杀死容器内整个进程组并执行 `reap`；迟到的 `completed` 或工具提交一律拒绝。
- **恢复与对账**：`role_instances.harness_state` 保存协议、thread ID、model/provider、CLI 版本、最近 turn 状态（`lastTurnId`/`lastTurnStatus` 与 `knownTurnId`）及累计用量。恢复前核对模型与配置一致性（漂移返回 `codex_resume_incompatible` 或 `model_revision_changed`）；未确认完成的上一轮 turn 先经 `thread/turns/list` 对账（`session_bound.reconciled`）并在本轮提示中要求核实副作用；仅当容器重建或本地 rollout 明确缺失（`-32600 no rollout found for thread id …`）时新建 thread 并如实记录 `rebuilt_from_task_records`。
- **双源用量记账**：控制面 `model-gateway.ts` 记录每次经容器内模型中转转发的真实上游请求与 token 明细；同时 `app-server.ts` 按 `thread/tokenUsage/updated` 增量与未上报 turn 的 `unknown_requests` 维护线程对账（存在未知请求时语义为 `lower_bound`），`metered` 预算跨恢复和重试累计生效。

## 长耗时运行汇报（Long execution reporting）

运行耗时长不等于卡死。连续执行的 RoleRun 在满 60 分钟及之后每 20 分钟（80、100……）向任务的 Manager 汇报进度，不中断正在工作的角色；旧配置中的整轮 `timeoutMs` 不再强制杀死运行。初始化、单次命令、授权租约以及显式角色/阶段资源预算仍按各自语义生效。

`long_execution_report` 记录精确的 run/assignment、已运行时间、近期活动、工具证据与检查点引用；`long_execution_decision` 记录 Manager 的继续或停止决定。用户取消、权限撤销与预算耗尽仍立即中断。

任务里的真实浏览器、源站允许范围和截图证据见 [任务浏览器与执行证据](browser.md)。生产项目电脑镜像预装 Chromium 由独立单跟踪，不在本文展开。
