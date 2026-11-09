# Claude Code harness

工作角色可选择 `claude_code`；项目主控继续使用 Pi。该驱动执行真实 Claude Code 原生二进制，不调用普通 Chat Completions 代替 CLI。RoleRun 仍是现有 `task_runs`、assignment、lease epoch、TaskToolGateway 和 Publisher；没有新增任务队列或阶段调度。

## 版本和部署

`package-lock.json` 锁定 `@anthropic-ai/claude-code@2.1.319` 及各平台原生可选包的版本和 integrity。当前驱动支持 Linux x64/arm64 的 glibc/musl 版本。控制面镜像通过已有的 production dependencies 阶段携带包；保持 optional dependencies，不要使用 `--omit=optional`。驱动直接定位原生包，因而 `npm ci --ignore-scripts` 不需要执行第三方 postinstall，也不会误运行 npm 的占位 launcher。

安装后 `prepare` 在空 HOME 中以 argv 执行 `--version`，要求精确返回 `2.1.319 (Claude Code)`。不同版本、模型别名、任意环境变量/argv 和未支持的能力直接拒绝。协议定义在 `src/harness/claude-code-protocol.ts`，升级版本需要重新验证实际二进制、流协议和合约测试。

由部署操作人提供 `BOT_CLAUDE_CODE_CONFIG=/absolute/path/claude-code.json`，例如：

```json
{
  "version": "2.1.319",
  "stateDirectory": "/data/claude-code",
  "model": "claude-sonnet-4-5-20250929",
  "provider": {
    "baseUrl": "https://api.anthropic.com",
    "credentialFile": "/run/credentials/claude-service-key"
  },
  "timeoutMs": 1200000
}
```

可选 `command` 只接受操作人维护的绝对二进制路径；默认使用 lockfile 中的原生包。配置文件和状态目录不得由任务内容或项目 API 写入。状态目录需要独占、0700 权限的持久存储，不能挂宿主 HOME 或跨租户共享目录。CLI 原生会话文件是敏感运行状态，不暴露为任务证据或公共日志；公开 trace 只记录白名单字段。

角色配置通过已有 V2 API 保存，例如：

```json
{"expected_revision":3,"enabled":true,"roles":[{"role_id":"dev","harness_ref":{"id":"claude_code","version":"2.1.319"}}]}
```

与 ACP 相同，CLI 使用自己的真实 provider/model，角色不能再指定项目的 `model_profile_ref`。现有 OpenAI-compatible 模型配置不会被自动转换。模型完整 ID、CLI 版本和启动配置 digest 进入 RunContext 和运行快照；同一角色 revision 恢复时变更模型/启动配置会拒绝，不静默换模型。

## 受控网关和授权

默认 `provider` 配置启用控制面内置的本轮 loopback 网关。供应商服务凭据文件必须是仅所有者可读的普通文件；只有网关读取它。网关对每个请求、排队后的请求和响应分片复核 #169 的运行令牌、当前租约及角色 guard，限定 `/v1/models`、`/v1/messages`、精确模型、已获准的客户端工具和输出上限，拒绝服务端工具、MCP 服务和任意端点；结束或撤销时中止上游连接。CLI 的 `ANTHROPIC_API_KEY` 是本轮短期能力令牌，长期供应商密钥不会传给 CLI。不会读取 `.env`、宿主凭据、keychain、OAuth 登录或管理员个人订阅。

部署也可省略 `provider`，改为 `gatewayUrl` 指定已有的 Anthropic Messages 兼容受控网关，两者互斥。已有网关必须向控制面验证令牌的 hash、有效期、当前 lease、tenant/project/task/run、模型授权和撤销状态，不能只看请求头里的 run_id。它不是任意 OpenAI-compatible endpoint。CLI 只能通过获准出口访问网关；部署操作人负责 OS、网络和挂载限制。

启动前的 `/v1/models` 请求携带 `x-api-key`、`x-bot-run-id`、`x-bot-lease-epoch`。网关确认授权后必须在响应头回传实际验证的 `x-bot-run-id` 和 `x-bot-lease-epoch`，响应 `data` 中包含精确模型 ID。403/401、缺少绑定回执、不支持的模型分别进入可诊断配置等待。之后真实 CLI 使用同一令牌访问 `/v1/messages`；网关必须对每次模型请求重新验证令牌，不能凭预检结果持续放行。此契约不把 CLI 本身的登录成功当成受限凭据证明。

## 工具、配置和证据边界

CLI 在每个 assignment 的专属目录中运行，HOME、cwd、TMPDIR 和配置路径均显式设置；不继承控制面环境。使用固定 argv：`--bare --restricted -p --input-format stream-json --output-format stream-json --verbose --tools "" --disable-slash-commands --setting-sources "" --strict-mcp-config`。显式配置只禁用 hooks 和项目 MCP 自动启用；不装插件，不使用 `--add-dir`、`--continue`、fork 或无条件权限绕过。

所有内置文件、终端、网络和子 agent 工具均关闭。唯一 MCP 服务是本轮 `bot` bridge，`--allowedTools` 精确列出已经过角色策略筛选的工具名。`dontAsk` 加 `--permission-prompts none` 拒绝其他权限请求，协议权限请求也明确 deny。CLI 初始化若出现额外工具、额外 MCP 或模型不符立即终止。

技能仅通过 `read_skill` 读取 #167 固定的获准 bundle；不会让 CLI 自动扫描仓库技能目录。这仍是实际技能正文加载，文件 hash 和读取回执沿用现有记录，不用提示词模拟权限。任务/原始观察/知识引用通过同一 TaskToolGateway 在调用时展开，旧 lease、越权引用和撤销授权由控制面拒绝。

文件修改、测试命令和工作区快照沿用已有项目电脑工具；GitHub 写入继续只走 Publisher。`taskToolServer` 复核排队后和提交后的 lease，调用既有 `screen`，记录实际 tool_started/tool_observation 的关联。CLI 报告或退出码不会成为测试证据；只有真实工具观察、固定文件快照和已有 finish 校验器产生的交付可以 collect。后续任务验收仍由框架决定。

该驱动的 CLI 进程目前运行在控制面所在环境，声明 `isolation: none`。独立 HOME/cwd 和关闭工具不等于每运行容器。选择 `isolated-workspace` / `isolated-candidate` 会被现有准入检查拒绝；不能把它用于要求 `run_isolation` 的正式阶段。需要此能力时须先接入实际每运行容器传输并重新验证，不通过界面警告继续执行。

## 流、恢复、取消和预算

输入是 NDJSON user 消息，显式绑定 session UUID。输出按锁定 schema 解析，支持任意 UTF-8 分片，拒绝非法编码、未知协议、未终止 JSON 行、缺少 result、非零退出、result 后迟到消息与无有效提交。每行上限 2 MiB、总流 32 MiB；公开文本最多 32 KiB，截断会留标记。thinking/redacted_thinking、签名和原始 stderr 不进入 trace；工具原始观察以 broker 留下的记录为准。

checkpoint 沿用公共接口，保留精确 session_id、版本、配置 hash、输入 hash、run/epoch、原始事件游标、已确认/未确认工具回执以及可用的工作区快照。恢复创建新的 run_id/epoch。只有同一 tenant/project/task/role instance/assignment、相同候选/合同/技能/模型/配置且原生 transcript 确实存在时才使用 `--resume <UUID>`。原生会话缺失、输入版本改变或新的 assignment 从任务事实重建，并记录新会话和恢复缺失；身份不符拒绝恢复。上一轮未确认的工具操作随输入提供，必须先核对实际状态，不能当成已成功或无条件重试。

observer 和 evaluator 每次都创建干净会话，永不恢复或 fork 开发会话。内部 CLI 子 agent 被关闭，也不会被计作平台独立检视或 QA。

取消先发送 print-stream `control_request/interrupt`，500 ms 后回收进程组；同时沿用 RoleRun 令牌撤销、guard 和迟到结果拒绝。CLI 的 `--max-turns`、最大输出 token、墙钟和框架工具预算共同约束运行。外部用量按每个原生 assistant message ID 的运行内快照统计，在角色实例所有恢复运行间累计；缺失计数标 unknown、已知值为下限，不伪造 Native 模型请求或零费用。会话级 `total_cost_usd` 是 CLI 估算，包含历史恢复成本，不写入确定账单；由于尚无确定金额账本，选择 `max_cost` 会在启动 CLI 前拒绝为 `claude_cost_budget_unsupported`。

## 验证分层与集成缺口

- `npm ci`、`npm run check`、`npm test`：普通回归；`test/claude-code.test.mjs` 包含明确标注的协议 fixture，以及真实锁定 CLI + 合成 provider 的 MCP/恢复合约。fixture 不是 Claude Code，合成 provider 不是真实模型验收。
- 真实模型验收需要上述网关和授权，使用独立数据库/工作区；须保留版本、候选 hash、真实命令/退出码/原始观察、result_ref、恢复方式和独立 reviewer/QA 证据。没有凭据时应记录阻塞，不借用个人订阅，也不把合约测试报成通过了真实模型验收。
- 可运行 `node scripts/claude-code-smoke.mjs .tmp/claude-code-live` 验证实际 provider。显式提供 `BOT_CLAUDE_CODE_CONFIG`；在协作环境也可使用凭据库中的 `CLAUDE_CODE_ANTHROPIC_API_KEY`，脚本只生成引用它的本地启动文件，不复制密钥。脚本完成受控代码修改、实际 Node 测试、候选 commit/tree、同一开发实例续接和干净 reviewer/QA 报告；`--seed-review-defect` 在独立候选中预置缺陷，要求 fresh reviewer 发现问题且 QA 不通过。文件和证据保留在参数目录，不碰 GitHub或运行中的服务。probe 报告 provider 来源仍须操作人核对，不能把接到合成端点的运行列为真实模型证据。
- #168 正式阶段门禁未合入时，仅走当前 RoleRun/assignment/acceptance 接口，正式阶段集成验收保留待补；不实现第二套阶段调度，也不引入 #171/#172。

官方接口依据：[headless](https://code.claude.com/docs/en/headless)、[CLI reference](https://code.claude.com/docs/en/cli-reference)。滚动文档只用于定位接口，实际保证来自锁定版本和二进制合约。
