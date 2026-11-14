# Claude Code harness

`claude_code` 声明的 kind 为 writer、observer、evaluator；未声明 controller 能力，因此保存配置和运行时都拒绝 controller（包括 manager 与 coordinator）。其他后端保持既有能力和兼容约定。该驱动在项目容器（`Workspace`）及隔离运行容器（`RunEnvironments`，声明 `isolation: run_environment`）内执行真实 Claude Code 二进制，不调用普通 Chat Completions 代替 CLI。RoleRun 仍是现有 `task_runs`、assignment、lease epoch、TaskToolGateway 和 Publisher；没有新增任务队列或阶段调度。

## 工具卷、版本与部署

正式运行从容器只读工具卷 `/opt/agent-tools`（Docker 卷 `agent-tools`）加载已安装的 Claude Code 与配套 Node.js 运行时：

- 工具卷目录：`/opt/agent-tools/claude_code/<version>/bin/claude` 与 `/opt/agent-tools/node/<version>/bin/node`（由控制面 `AgentToolManager` / `/api/agent-tools/install` 安装，校验包 SHA-256 并写入 `manifest.json` 溯源记录）。
- 兼容范围：控制面在 `src/harness/agent-tools.ts` 中维护兼容 semver 范围（当前 `>=2.1.0 <3.0.0`，已验证版本 `2.1.319`），`prepare` 阶段自动选择卷内最高兼容版本，并把实际执行版本写入 `task_runs.cli_version`；超过保留数量且不被运行中任务引用的旧版本由清理接口（`/api/agent-tools/prune`）自动回收。
- 宿主机回退配置（开发/合约测试）：仍可通过环境变量 `BOT_CLAUDE_CODE_CONFIG=/absolute/path/claude-code.json` 显式指定兼容版本二进制、本地状态目录与文件凭据供应商，用于无容器或合成供应商合约测试；正式部署使用 `/opt/agent-tools` 只读工具卷与项目/角色模型配置。

角色配置通过已有 V2 API 保存，可绑定项目模型（`model_profile_ref`）并选择模型来源（`model_source`）：

```json
{
  "expected_revision": 3,
  "enabled": true,
  "roles": [
    {
      "role_id": "dev",
      "harness_ref": { "id": "claude_code", "model_source": "gateway" },
      "model_profile_ref": { "model_id": "<model id>" },
      "environment_profile_ref": { "id": "isolated-workspace" }
    }
  ]
}
```

- **平台网关模式（`model_source: "gateway"`，默认）**：按“角色显式 `model_profile_ref` → 工作类型模型 `task_models` → 项目默认模型”解析模型，经容器内回环模型中转与控制面多格式模型网关访问上游（支持 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 双向协议转换）。
- **供应商订阅模式（`model_source: "subscription"`，预留）**：接口与数据结构（`src/harness/subscription.ts`、角色配置页选择器）已预留，当前未实现；选择后保存配置会记录 `model_source: "subscription"`，控制台展示“未实现”，解析与运行准备阶段明确以 `subscription_mode_not_implemented` 拒绝，不会静默回退到网关或宿主凭据。

角色配置页展示 `claude_code` 的工具卷挂载状态、已安装版本、所选版本、兼容版本范围、模型中转就绪状态及不可用原因。模型完整 ID、CLI 版本和启动配置哈希进入 `RunContext` 和运行快照；同一角色 revision 恢复时变更模型或启动配置会以 `model_revision_changed` 拒绝，不静默换模型。

## 容器内模型中转、身份令牌与 GitHub 短期只读凭据

每次运行在容器内由 `runner/harness-entry.mjs` 以独立进程组启动：

1. **回环模型中转（`runner/model-relay.mjs`，`127.0.0.1:0`）**：`ANTHROPIC_BASE_URL` 指向容器内本轮临时端口，`ANTHROPIC_API_KEY` 设为控制面签发的运行级身份令牌 `rrt_…`。中转经任务目录文件邮箱（`model-requests/`、`model-replies/`）转发到控制面 `src/harness/model-gateway.ts`；长期上游模型 API Key 仅保存在控制面加密存储中，永不进入容器环境、命令行或文件。即使隔离运行容器处于 `--network none`，模型调用仍经文件邮箱正常工作。
2. **运行级身份令牌校验**：控制面在每次模型请求、每次平台工具调用和每次 GitHub 短期只读令牌签发时复核 `rrt_…` 的哈希、租约 `lease_epoch`、角色、项目与能力范围（`model:invoke`、`gateway:<tool>`、`github:read_token`）；撤销、过期或跨运行混用立即拒绝。
3. **GitHub 短期只读令牌辅助器（`runner/git-credential-bot.mjs`、`runner/gh-wrapper.mjs`）**：容器内不放置长期 GitHub Token，也不在 CLI 进程环境中设置 `GH_TOKEN`/`GITHUB_TOKEN`。需要远端只读访问时，Git credential helper 与 `gh` 包装器向 `harness-entry.mjs` 的本机凭据辅助端口申请短期只读安装令牌（剩余有效期不足 10 分钟自动续签），禁止 `gh auth token` / `--show-token` 导出明文，并对子进程输出做流式令牌脱敏；部分 GitHub 读取权限下引导改用平台结构化只读工具。GitHub 写入继续只走控制面受控 `github_write` 与 Publisher。

## 容器原生工具、平台 MCP 桥与证据边界

CLI 工作目录固定为容器内任务仓库检出 `<task_dir>/repo`；`HOME` 与 `CLAUDE_CONFIG_DIR` 指向角色实例专属状态目录 `/workspace/tasks/<state_workspace_id>/cli-state/<session_key>/`，随 `WorkspaceCleanup` 生命周期清理。

- **开放容器原生工具**：启用 `--tools default` 与 `--dangerously-skip-permissions`（安全边界由容器只读根、非特权 UID 10001、capability 丢弃、网络隔离与短期凭据提供），角色可直接在 `<task_dir>/repo` 中使用原生终端（`Bash`）、文件读写与编辑（`Read`、`Write`、`Edit`）、搜索（`Glob`、`Grep`）及原生子 Agent（`Agent`/`Task`）。无外网权限（`!egress`）时通过 `--disallowedTools` 禁用 `WebFetch`、`WebSearch`，同时禁用 `EnterWorktree`/`ExitWorktree` 及无关的宿主计划任务工具。
- **平台管理工具桥（`runner/mcp-bridge.mjs`）**：通过 `--strict-mcp-config` 仅注入 stdio MCP 服务 `bot`，并设置 `MCP_TOOL_TIMEOUT=3600000` 以容纳长耗时平台操作。桥接器经文件邮箱（`tool-requests/`、`tool-replies/`）调用控制面 `createTaskToolDispatcher`，提供任务记录读取（`read_task_record`）、角色记忆、技能读取（`read_skill`）、结构化 GitHub 读取/写入及结果提交工具（`finish` 等）；已被 CLI 原生工具替代的底层 `read_file`/`write_file`/`run_command`/`start_agent` 不再重复暴露在 MCP 中。
- **防仓库投毒**：固定携带 `--disable-slash-commands --setting-sources "" --strict-mcp-config`，并在独立 `settings.json` 中设置 `disableAllHooks: true`、`enableAllProjectMcpServers: false`，仓库检出内的 `.claude/settings.json`、`.mcp.json`、`CLAUDE.md` 钩子或恶意 MCP 配置不会自动执行。
- **安静的命令日志**：容器内原生命令与文件操作不再逐条刷写控制面运行事件日志；控制面只记录平台 MCP 工具调用回执、模型网关请求轨迹与公开消息摘要。

CLI 报告或退出码不会自动成为验收通过；writer 的 `collect` 由控制面取得候选快照并运行既有 finish 校验器，observer 只检视已固定的 `role_candidate`，独立 QA 始终使用全新上下文与独立检出。

## 流、恢复、取消与用量记账

输入是 NDJSON `user` 消息，显式绑定 session UUID。输出按锁定流协议解析，支持任意 UTF-8 分片，拒绝非法编码、未知协议、未终止 JSON 行、缺少 `result`、`result` 后迟到消息与无有效提交；单行上限 2 MiB、总流 32 MiB，公开文本上限 32 KiB，`thinking`/`redacted_thinking` 与签名不进入公开 trace。

恢复创建新的 `run_id` 与 `lease_epoch`。只有同一 tenant/project/task/role instance/assignment、相同候选/合同/技能/模型/配置且容器持久化目录中的原生会话文件确实存在时，才使用 `--resume <UUID>`（记录 `native_resume`）；容器重建导致会话目录缺失或输入版本变化时，自动从持久化任务记录重建新会话并如实记录 `rebuilt_from_task_records`。observer 和 evaluator 每次创建干净会话，永不恢复或 fork 开发会话。

取消先发送 `control_request/interrupt`，宽限期后经 `workspace_harness_interrupt` 对整个容器内进程组发送 `SIGKILL` 并执行工作区 `reap`，确保 CLI 派生的测试、构建与子 Agent 进程全部回收，同时撤销运行令牌并拒绝迟到提交。

模型用量与完整请求轨迹由控制面 `model-gateway.ts` 在转发响应时统一写入 `model_requests` 与外部模型账本：明确的 4xx 上游拒绝记已知 0 token，5xx 或断流未拿到完整计数的请求记入 `unknown_requests`（`lower_bound`），并在结束时与 CLI `result.usage` 对账（`usage_reconciliation`）。

## 验证分层

- `npm run check`、`npm test`：`test/claude-code.test.mjs` 与 `test/model-relay.test.mjs` 验证协议替身、容器内原生工具、stdio MCP 桥、回环模型中转、短期 GitHub 只读令牌脱敏、进程组取消回收、订阅模式预留拒绝，以及锁定真实 Claude Code 二进制对接合成供应商的完整链路。
- `npm run test:docker`、`npm run test:isolation:docker`：在真实 Docker 项目容器与 `--network none` 隔离运行容器中端到端验证只读 `/opt/agent-tools` 挂载、`<task_dir>/repo` 原生读写执行、MCP 工具桥、容器内模型中转、Git/`gh` 短期凭据脱敏、跨容器会话恢复及取消进程组回收。

官方接口依据：[headless](https://code.claude.com/docs/en/headless)、[CLI reference](https://code.claude.com/docs/en/cli-reference)。
