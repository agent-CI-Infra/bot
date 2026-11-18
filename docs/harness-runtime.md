# Harness Runtime

Role 服务选择执行器并组装角色说明、assignment 和任务事实引用；Harness 负责会话连接与执行，不负责组队、验收或发布。定义、持续会话与本轮执行分别映射现有 Harness 注册、`role_instances`、`task_runs`；没有第二套任务系统。

## 公共边界与后端目录

`roleHarness(id).createSession(spec, services)` 创建公共会话；原 adapter 入口保留为兼容包装，实际执行统一经过该会话。`HarnessSession<T>` 提供 `id / run / send(message) / cancel / close`。持续上下文按后端类型保存在 `role_instances` 或容器持久化目录，下一轮按恢复协议续接或从任务事实重建，不要求控制面常驻子进程。

当前已注册的 Agent 后端：

- **内部驱动（`pi`、`native`、`process`）**：支持 `controller`、`writer`、`observer`、`evaluator` 四类角色；新角色默认推荐 `pi`。`pi` 在项目容器中运行 Pi SDK 会话，`native` 使用控制面内置工具循环，`process` 运行独立 Node worker 子进程。
- **容器内外部 CLI 驱动（`claude_code`、`codex`）**：支持四类角色（`controller`、`writer`、`observer`、`evaluator`），Manager 与 Coordinator 也可选择。两者均在项目容器（`Workspace`）及每运行隔离容器（`RunEnvironments`，声明 `isolation: run_environment`）内执行，直接以 `<task_dir>/repo` 为工作目录开放原生终端、文件读写/编辑与子 Agent 能力，默认使用原生供应商直连；显式配置 gateway 时通过容器内回环模型中转（`127.0.0.1:0`）访问平台多格式模型网关，并通过 stdio MCP 服务 `bot`（`runner/mcp-bridge.mjs`）调用平台管理工具。历史通用 `acp` 驱动与 `opencode` 待接入占位已下线。

公共协作与安全边界：

- **Role/Manager**：选择角色、assignment、人设、记忆入口与 Harness；Review 反馈通过持久化引用回到同一 `dev` 实例。
- **任务与平台工具**：`claude_code` 与 `codex` 在容器内经 `runner/mcp-bridge.mjs`（stdio MCP `bot`）调用与内置路径相同的平台工具、执行器与完成提交校验器；已被容器原生工具替代的底层 `read_file`/`write_file`/`run_command`/`start_agent` 不在 MCP 重复提供。提交通过后不再接受后续工具修改。
- **工作区与凭据隔离**：容器内 CLI 在 `<task_dir>/repo` 直接操作任务检出；默认由 CLI/Pi 原生客户端直接连接供应商：使用其已配置的登录，或把选定项目模型的凭据通过私有启动配置交给原生客户端。此模式下模型凭据属于运行环境中的 Harness，不能宣称它对原生 Shell 不可见；长期 GitHub 凭据仍不下发。显式网关模式才用 `rrt_…` 经文件邮箱转发模型请求；Git 与 `gh` 通过 `runner/git-credential-bot.mjs` 和 `runner/gh-wrapper.mjs` 按需申请短期只读安装令牌并流式脱敏。
- **命令路径**：CLI 的 `PATH` 依次是 `gh` 包装目录、Node 目录、电脑用户的 `~/.local/bin`、`~/.cargo/bin`、`~/.npm-global/bin` 和系统目录，同一值也放在 `BOT_LOGIN_PATH` 里。Debian 的 `/etc/profile` 会在登录 shell（`bash -lc`、`sh -lc`）里重设 `PATH`；CLI 状态目录里的 `.profile`（`runner/login-profile.mjs`）随后按原顺序恢复它，系统 profile 新加的目录排在最后。因此原生终端能直接运行装在电脑用户 HOME 下的工具，`gh` 仍解析到包装器。
- **公共事件与 Trace**：原生工具活动、会话绑定与公开文本进入运行事件；Codex 原生命令/文件结果有脱敏回执引用，Pi 保存原生 transcript 入口。平台 MCP、模型用量及结束原因继续关联原运行；不留存私有 `reasoning`/`thinking`。
- **QA/Publisher**：执行器正常结束不代表任务验收通过；角色结果继续经框架校验，QA 始终使用全新上下文与固定候选检出，远端发布和合入仍由受控 Publisher 执行。

Claude Code 的完整说明见 [Claude Code harness](claude-code.md)；下文说明容器内 Codex（`codex app-server`）驱动。

## 容器内 Codex（`codex app-server`）

`codex` 驱动（`src/harness/codex.ts` + `src/harness/app-server.ts`）通过 `runner/harness-entry.mjs` 在容器内以独立进程组启动 `codex app-server`（stdio JSON-RPC 协议），兼容范围由 `src/harness/agent-tools.ts` 管理（当前 `>=0.166.0 <1.0.0`，协议基线 `0.166.0`；可用 `node test/live/codex/codex-protocol-lock.mjs` 复核协议摘要）。

### 工具卷与配置

- **正式运行（只读工具卷 `/opt/agent-tools`）**：由控制面 `AgentToolManager`（`/api/agent-tools/install`）安装静态链接 musl 二进制至 `/opt/agent-tools/codex/<version>/bin/codex`（校验 SHA-256 并记录 `manifest.json`）。`prepare` 自动选择最高兼容版本并记录到 `task_runs.cli_version`。
- **模型连接**：默认 `direct`，CLI 使用原生 provider/login；平台配置的 Responses 模型通过 `bot_direct` 原生 provider 连接，不创建回环模型代理，也不覆盖现有 `CODEX_HOME/config.toml`。需要转换协议或集中代理时，显式设置启动配置 `modelTransport: "gateway"`、可信运行参数 `containerOptions.modelTransport` 或环境变量 `BOT_HARNESS_MODEL_TRANSPORT=gateway`。网关模式保留 `bot_relay` 和原有用量/请求记录。原生模式不支持的供应商协议会给出配置原因，不会偷偷转到网关。历史角色字段 `model_source: "gateway"` 表示选用平台模型配置，并非模型传输开关；受托管的 `subscription` 凭据接口仍是预留功能。
- **宿主机回退配置（开发/合约测试）**：设置 `BOT_CODEX_CONFIG=/absolute/path/codex.json` 可显式指定本地二进制或协议替身、状态目录与测试供应商配置。

角色配置示例：

```json
{
  "expected_revision": 3,
  "enabled": true,
  "roles": [
    {
      "role_id": "dev",
      "harness_ref": { "id": "codex" },
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
- **用量记账**：直连只采集原生 Harness 提供的事件、用量与回执；Codex 使用 `codex_events`，Claude 使用 CLI usage，Pi 使用已观察消息的用量下界。未报告的请求与成本保持未知，不伪造完整请求轨迹。显式网关模式保留控制面请求计量，并与原生事件去重、对账。

## 长耗时运行汇报（Long execution reporting）

运行耗时长不等于卡死。连续执行的 RoleRun 在满 60 分钟及之后每 20 分钟（80、100……）向任务的 Manager 汇报进度，不中断正在工作的角色；旧配置中的整轮 `timeoutMs` 不再强制杀死运行。初始化、单次命令、授权租约以及显式角色/阶段资源预算仍按各自语义生效。

`long_execution_report` 记录精确的 run/assignment、已运行时间、近期活动、工具证据与检查点引用；`long_execution_decision` 记录 Manager 的继续或停止决定。用户取消、权限撤销与预算耗尽仍立即中断。


## 会话边界与原生资源（#834）

`send` 接受后续输入；`cancel` 中断当前轮，后续轮可继续；`close` 关闭连接。一次原生轮次正常结束与业务 Task 完成是两个事实。Manager 可留下观察结果并交回调度，只有正式候选、独立 QA 与既有发布流程才能完成交付。

Pi 自己管理会话（#1040）：会话文件按任务和角色实例放在独立的任务目录（与 Claude Code、Codex 的 CLI 状态目录同一个 `/workspace/tasks/<由角色实例算出的 ID>`），`role_instances.harness_state` 保存会话 ID 和文件。下一次运行用 `SessionManager.open` 在当前工作目录下打开它（`native_resume`），文件不在时新开会话（`rebuilt_from_task_records`），QA 每次新开（`fresh_evaluation`）；运行实际的恢复方式在会话绑定时记入 `task_runs.recovery_mode`。上下文超限或被取消的会话清掉绑定，下次新开。压缩、重试等使用 Pi 自己的设置。

Pi SDK 使用默认资源加载器和原生文件、搜索、编辑、Shell 工具，按有效权限开启；不再将原生工具名当作 Bot MCP 工具来鉴权。角色固定 Skill 作为补充资源装入专用配置目录，保留项目指令和 Skills 的原生发现。Claude Code 保留项目指令原生加载和技能文件按需读取，但禁用项目/local 运行设置、hooks、额外 MCP 服务以及候选 slash commands/Skills 自动激活，Codex 保留原生扩展配置。每个角色使用专用 Harness HOME，不继承宿主私有配置或凭证。撤权、取消和明确预算仍由既有运行入口检查。

服务角色也可选择 `native / pi / codex / claude_code`。非项目会话通过同一 Driver 使用会话所有者的助手电脑，不创建虚假的业务项目/任务。旧部署保持 Native；已有角色的显式权限不会因升级自动扩大。`service_harness_sessions` 保存绑定，`service_harness_events` 保存加密公共事件；超级管理员可读 `GET /api/service-roles/:role/sessions` 及 `/sessions/:session/events`（最近 100 条）。项目角色继续使用 `role_instances / task_runs / task_history`。

有效权限由 `HarnessAccess` 从现有角色权限与调用来源权限交集生成，并传入原生启动配置：文件工具、Shell、网络与仓库凭证范围分开表达。GitHub 原生凭证当前仍只签发仓库只读 App token，写操作仍走既有平台接口；**尚未实现原生 GitHub 读写凭证模式**。文件工具开关与文件系统权限分开记录：现有授权若允许任意 Shell，有效工作区权限如实记为可写，即使直接文件编辑工具关闭；对话来源只有 tasks.read 时不会获得 Shell/写权限。Pi/Claude 暂不支持严格只读文件系统同时开放任意 Shell；由现有 computer 权限生成的访问配置在开放 Shell 时明确记为可写，不能把关闭编辑工具宣称为只读隔离。外部传入的只读加 Shell 配置会在启动前被拒绝。助手电脑保留其既有无网络策略。

开发验证中应区分真实 CLI + 合成模型协议测试、真实模型实验和 Docker 隔离测试。LocalManager 不提供容器隔离，不能用其通过结果代替权限/网络隔离验收。完整验收清单以 #834 为准，阶段性代码通过回归不代表全部清单完成。

GitHub 事件分派也使用 Manager 配置的 Harness；Native 只在明确配置 Native 时走兼容循环，不会因缺少项目运行环境而隐式降级。`dispatch_harness_sessions` 按 event/attempt 保存绑定，模型与原生事件写入既有 dispatch 轨迹，不制造业务 Task。Coordinator 和恢复轮次同样为 Pi/Codex 准备运行环境。原生 CLI 的 PATH 保留电脑中已安装的用户级工具目录，专用 HOME 与短期凭证规则不变。

模型网关在成功响应缺少 SSE 类型时，最多检查前 1 KiB 来识别实际 SSE 帧，修正响应类型并逐字节回放。某些 Responses 服务返回 SSE 却标记为 JSON；不能因此把完整事件流当作 JSON 对象解析。正常 JSON 和 HTTP 错误响应保持原协议，原生 Harness 的流式读取和取消仍生效。

### 默认直连的配置

Codex 的 `BOT_CODEX_CONFIG` 可以只声明 executable、专用 `env.CODEX_HOME`、stateDirectory 和 CLI version；原生登录与 provider 配置保留。Claude Code 可以省略 provider，使用显式提供的 `env.CLAUDE_CONFIG_DIR` 或原生认证环境变量。Pi 把当前选定的项目模型交给原生 SDK，不再起本机模型代理；工具邮箱只承担任务工具、取消和交接。项目网络配置必须能到达供应商，直连不会绕过既有网络策略。

显式项目模型直连会把供应商凭据交给运行环境；网关模式仍把长期供应商凭据留在控制面。直连保留原生事件、会话绑定、MCP 调用与原生用量回执，不生成不存在的请求/响应正文。Pi 的原生用量是已观察消息的下界，失败请求的完整计量不能伪装为已知零。

委派前的能力不匹配会作为 `delegate_role` / `delegate_roles` 的工具结果返回给当前 Manager，包含 `started:false`、required/missing/available、各能力的依据与持久化 admission_ref。Manager 可在同一会话修订可选计划、选择可用环境或明确等待/求助；框架不会自动降低要求或切换后端。并行委派保留其他角色的成功结果。能力准入本身仍会拒绝不满足要求的运行，权限撤销、取消及执行后的异常继续保留原有处理。

阶段 `retry.max_attempts` 保留为总运行次数的提醒阈值，包含成功运行，并非连续失败次数；达到阈值不再产生 `stage_retry_exhausted` 或自动暂停。下一次委派先向当前 Manager 返回持久化报告与最近运行结果。Manager 可带 `attempt_report_ref` 继续本次执行、调整可选计划或主动等待/求助；报告只对应当前阶段、计划、候选及次数，不能无限批准后续运行。显式的时间/工具资源预算、权限和必需验收条件仍按原规则执行。
任务里的真实浏览器、源站允许范围和截图证据见 [任务浏览器与执行证据](browser.md)。生产项目电脑镜像预装 Chromium 由独立单跟踪，不在本文展开。

交付提名可以引用当前任务的最新 Dev `task_history:` 记录，也可以引用同项目已验收的后代任务 `task:<id>`（可用 `supporting_refs` 附带更多来源）。引用只是复用交付说明与证据，不导入或覆盖文件；Manager 应先检查父任务实际工作区并自行决定集成、测试或委派。框架保存来源任务、契约版本、候选和验收版本，后续策略测试和独立 QA 仍针对父任务的当前候选与完整目标，不继承子任务通过结论。

提交拒绝在产生处携带原因、期望、实际记录类型/角色/版本以及可查询入口；不可读的引用不泄露其归属。Native、Process、Pi 与 MCP/mailbox 使用同类纠正反馈：没有“两次纠正后抛出”的次数上限，有 tasks 记录的任务会话中，同类拒绝每 3 次保存并返回一次 Manager 提醒，累计次数从 task_history 恢复；非任务 dispatch 等会话仅保留拒绝证据入口，不返回虚构次数或 Manager 提醒，角色/任务现有资源预算及权限检查仍生效。Manager 可通过任务上下文的 submission_reports 和历史查询读取提醒、拒绝及工具原始记录。

Coordinator 的单轮自动尝试保留三次边界；运行失败或连续争议到达边界后返回 `manager_review`，将错误、争议和原始记录入口交给请求方 Task Manager，不按次数判为必须人工处理。Manager 使用 `decide_coordination` 选择 retry（可调整 proposal）或 dismiss；主动求助仍用既有 finish_coordination。重试保留累计次数及证据，重复相同决定返回已有结果；撤回建议不修改任务目标或通过 QA，并通知受影响的等待任务。

事件分派的失败保持 pending 并退避，稳定状态最多每十分钟自动尝试一次；每第三次失败记录持久化报告。下一次同一事件的普通 Manager 调用会收到此前失败证据，不另起一层 Manager。分派错误次数本身不会调用 declined hook，也不会被当作 ignore；明确取消仍结束当前事件。已有事件详情入口返回恢复记录，`failure_before` 可向前分页；人工重试可跳过冷却期，历史次数不清零。历史版本已经 failed 的事件仍可用既有重试入口恢复，不自动重新触发曾被拒绝的工作。

### 关联交付物的渐进式披露

QA 输入、`context/related-deliveries.json` 与 `read_related_artifact` 共用精简索引。首页最多 5 个交付物、24 Ki 字符元数据；每项提供目标摘要、验收状态、候选/树版本、文件数量与读取入口，不嵌入整个仓库文件清单。截断和未展示的页面都有标识；完整页面不再建议翻到不存在的下一页。摘要不能代替原始要求或验收证据。

复用现有 `read_related_artifact`，传 `task_id` 和提供的 `candidate_id`。不传 path 时按 `directory`/路径子串 `query` 过滤文件名，用 offset/limit 翻页；传 path 时从候选记录的本地 SHA 读取原文并返回 blob SHA。文件原文、`section: contract` 和 `section: delivery` 用 offset/length 分段（默认 8000、最多 16000 字符），沿 next_offset 读取直到 complete。恢复全文时 goal_truncated 为 false。候选改变时返回 related_candidate_changed，不能悄悄切换版本。超大清单条目显式报错并推进游标，避免原地循环。读取不改变源任务工作区；这些预算限制关联信息披露，不是任意 QA 输入字段的总截断器。
