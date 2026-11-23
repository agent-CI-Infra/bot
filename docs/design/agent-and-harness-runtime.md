# Agent 运行时、RoleRun 协议、Harness 与虚拟电脑

本文说明 launchpad 执行层的核心设计：共享 Agent 运行时、版本化 `bot.role-run/1` 协议、多后端 Harness 抽象，以及项目电脑与助手电脑的生命周期管理。

## 1. 共享 Agent 运行时与工具契约（`src/agent/`）

- **统一入口 `runAgent(spec)`**：所有模型循环共享同一执行入口与 `gateway.ts` 模型网关，统一处理：
  - 模型选择快照与请求前实时授权/Key 核验（变更或撤权立即停机，不静默换模型）；
  - 90 秒无 token 超时与暂时性故障自动重试（408/429/5xx/断流最多重试 5 次：1/3/9/27/60 秒）；
  - 多模态请求上限（纯文本 2 MiB、含内联图片 20 MiB，自动缩放与拒图降级恢复，避免会话锁死）；
  - 统一用量记账（`model_requests` 先落账后交付结果，记录当时单价快照与缓存命中 token，支持按 `repository_id` 或 `service_role_id` 归属）。
- **统一工具集与结果预算**：
  - **只读仓库探索（`RepositoryExplorer`）**：`github_read`、`github_search`、`read_job_log`、`download_artifact` 固定 GET 与当前仓库范围，返回前脱敏。
  - **受控 GitHub 写入（`github_write`）**：类 REST 接口，按路由映射细粒度资源权限与能力上限，单次调用临时签发最小写权限安装令牌并在发出后立即撤销，支持按 scope+key 去重，**永远拒绝直接写入 `.github/workflows/`，且永远拒绝合并/入队修改 `.github/workflows/` 的 PR**（即使在 `auto_merge_policy=allow_all` 下也须由人类维护者在 GitHub 合入）。
  - **超长结果分页**：超过预算或需折叠的工具输出统一脱敏写入 `tool-results` 卷（24 小时过期），仅向模型返回首尾预览与句柄，通过 `read_tool_result` 或容器内只读 `/results/<id>.utf8` 按需读取。
  - **命令时限与后台进程**：`run_command` 支持 `timeout_seconds`（受 `BOT_COMMAND_TIMEOUT_MAX_SECONDS` 统一封顶）与 `keep_background: true`（自动将日志落盘到 `log_path` 并随任务结束回收进程组）。

## 2. `bot.role-run/1` 协议与 `TaskToolGateway`（`src/roles/`）

每次角色执行都是 `task_runs` 中的一次版本化 RoleRun，统一经历 `prepare → start → events / checkpoint / cancel → collect / recover`：

- **不可变运行快照（`RunContext`）**：启动时按内容哈希固化角色定义、模型版本、Skill 文件与哈希、有效权限、环境、预算及不可变 `source_ref`/`candidate_ref`；写入前强制经 `assertSecretFree` 校验无密钥泄漏。
- **单调租约（`lease_epoch`）与短时运行令牌（`rrt_…`）**：
  - 每次绑定分配单调递增 `lease_epoch` 并签发 15 分钟续期运行令牌（仅存哈希，绑定租户/项目/任务/run/epoch/角色/能力）；新 run 接管或取消时旧令牌立即撤销，旧 epoch 迟到事件/提交全部拒绝。
- **能力准入（`admitRun`）与累计预算**：
  - 启动前对照驱动能力矩阵校验（`cancel`、`version_binding`、`output_validation`、`raw_evidence`、`fixed_candidate_read`、`fresh_context`），缺失即 `waiting_configuration`，不静默降级后端。
  - `metered` 预算按角色实例跨重试/恢复持续累计（token、请求数、工具数、墙钟时间），耗尽立即中断并撤销令牌；连续长耗时运行满 60 分钟及之后每 20 分钟向 Manager 发送 `long_execution_report` 而非粗暴强杀。
- **`TaskToolGateway`**：角色读取任务历史、项目知识与提交经验统一经网关鉴权（复核 `rrt_…`、epoch、发起人实时权限与角色策略），屏蔽跨任务/跨项目引用；支持同一任务多角色在共享工作区协作、按需为并发开发任务分配独立 `git worktree`。

## 3. 多后端 Harness 抽象（`src/harness/`、`runner/`）

`roleHarness(id).createSession(spec, services)` 屏蔽执行器差异，统一提供 `run / send / cancel / close` 与规范化恢复模式（`native_resume`、`checkpoint_transcript`、`rebuilt_from_task_records`、`fresh_evaluation`）：

| 后端 | 运行位置 | 关键设计要点 |
| --- | --- | --- |
| `pi`（默认推荐） | 项目/助手容器内（固定版本 Pi SDK） | 嵌入式 Node 会话，会话文件持久化在独立 `cli-state/pi/` 目录；支持原生工具、SDK 压缩与跨重启会话续接；经文件邮箱与控制面通信。 |
| `native` | 控制面进程内 | 内置标准工具循环与 `ToolTranscript` 折叠，适合轻量控制面/服务角色会话。 |
| `process` | 独立 Node 子进程 | 隔离事件循环、JSON-line RPC 通信，不继承控制面环境变量与凭据。 |
| `claude_code` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | NDJSON 流协议启动受控版本 CLI，开放容器原生终端/文件/子 Agent，经 stdio MCP 桥（`runner/mcp-bridge.mjs`）调用平台工具，禁用不可信检出的本地 hooks/settings/MCP；支持平台模型（原生直连或回环中转）与「项目电脑内自行配置」（`model_source: 'local_config'`）两种模式。 |
| `codex` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | 启动 `codex app-server` JSON-RPC 协议，首轮前核验特性开关与唯一 `bot` MCP 服务，运行中实时拦截未授权工具或 `model/rerouted`，支持 `thread/resume` 与 turn 对账；支持平台模型与「项目电脑内自行配置」（`model_source: 'local_config'`）两种模式。 |
| `icode`、`workswarm`、`container_acp` | 项目容器任务工作区（`/opt/agent-tools` 只读卷） | ACP v1 stdio。会话、工具、审批和流式输出遵循 ACP，模型请求经现有邮箱中转，平台工具走回环 HTTP MCP 或 stdio MCP。 |

- **容器内短期 Git/`gh` 只读凭证**：`claude_code`、`codex`、`icode` 和 `container_acp` 使用运行级身份，由 `runner/git-credential-bot.mjs` 与 `runner/gh-wrapper.mjs` 向 `harness-entry.mjs` 申请短期只读安装令牌并流式脱敏。
- **Claude Code / Codex「项目电脑内自行配置」（`model_source: 'local_config'`）**：
  - `harness_ref.model_source` 规范值为 `'gateway' | 'local_config'`（旧配置 `'subscription'` 自动归一化为 `'local_config'`）。
  - 选择 `local_config` 时，控制面与 `runner/harness-entry.mjs` **不注入**任何平台模型配置（无 `ANTHROPIC_*`、`--model`、`CODEX_RELAY_URL`、`OPENAI_*`、`BOT_NATIVE_MODEL_KEY`、`config.toml` 或 `-c model_providers.bot_direct`），同时保持每次运行独立的 `HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。
  - 启动 CLI 前由 `runner/cli-config.mjs` 仅将 `/workspace/home` 下的白名单文件（Claude Code：`.claude/settings.json`、`.claude/.credentials.json`；Codex：`.codex/config.toml`、`.codex/auth.json`）以 `0600` 权限复制到当前会话目录（Claude Code 传 `--setting-sources user`），运行结束立即删除副本但保留会话 transcript。未检测到任一配置文件时以 `claude_local_config_missing` / `codex_local_config_missing` 失败关闭，绝不回退到平台模型。
  - 管理入口经 `GET/PUT/DELETE /api/environments/:id/cli-config` → `manager` → runner 非 journal 操作（`cli_config_status`/`write`/`delete`）直写 `/workspace/home`，控制面不读取、不落库、不记录日志；写入内容在控制面、manager 与 runner 三处统一限制上限为 32 KiB（超限返回 `400 invalid_cli_config_content`），由 manager 经 Docker exec 环境变量 `BOT_CLI_CONFIG_B64` 传入（不进入命令行 `argv`，runner 读取后立即清除环境变量）。
- **取消回收**：所有容器内 Harness 均以独立进程组运行，取消时先优雅中断，宽限期后经 `workspace_harness_interrupt` 杀死整个进程组并执行 `reap`。

### 服务助手回合（`src/harness/service-session.ts`）

管理助手和群聊助手选用非 Native 后端时，整轮由 `serviceHarnessTurn` 在会话归属的助手电脑上运行，会话绑定保存在 `service_harness_sessions`。Pi 后端按 Native 循环的语义运行一轮（调用方传入 `ServiceTurnControl`，其他后端忽略它）：

- **回答文字**：Pi 用普通文字作答，不提供 `finish` 工具。经网关时，控制面模型请求的逐 token 回调转出文字；直连时，runner 把流式文字（约 200 ms 一批的 `text_delta`）和 Pi 自身的重试（`model_retry`）写入事件流，控制面转给会话，`text_delta` 不进会话日志。
- **回合中的新消息**：会话启动前取到的消息随配置（`steer`）在提示词之后作为单独的用户消息发出；此后在每批工具调用结束的回合边界（runner 的 `finishTurn` → `boundary('turn')`）取新消息并 `session.steer()`。最终回答之后不再并入。模型输出文字时暂停并入，带工具调用的响应结束后恢复。
- **编辑后重启**：回合边界、每次经控制面的工具调用和会话结束时比较来源版本。版本变了就结束当前会话：旧版本下经控制面的工具调用不执行，答复不采用（Pi 自带的 `read`/`edit`/`write`/`bash` 直接在助手电脑上运行，不经这道检查）；清空会话绑定，用重建的上下文开新会话，已并入的消息重新提供。跨轮续接的会话在来源版本变化后也不再续接。
- **保持安静**：允许安静的轮次里，`stay_silent` 是会话的结束工具；被拒绝（例如 `reply_required`）时作为观察返回模型，回合继续。
- **邮箱清理**：新会话写入配置时，runner 清除上一进程没答复的工具、令牌和模型请求，新会话不会把它们当成自己的请求。

### 第三方 Agent 工具卷统一管理（`runner/agent-products.mjs`、`src/harness/agent-tools.ts`）

- **单一产品注册表**：除内置于项目电脑镜像的 `pi` 外，所有容器内第三方 Agent（`claude_code`、`codex`、`icode`、`workswarm`）的默认版本、兼容范围、受支持架构与发行包 SHA-256 摘要统一声明在 `runner/agent-products.mjs`，并派生到 `src/harness/agent-tools.ts`、`src/roles/backends.ts`、`runner/acp-products.mjs` 与离线安装脚本。
- **启动自动安装与状态持久化**：仅 `src/main.ts` 在监听启动后拉起非阻塞的 `AgentToolsAutoInstaller`（受 `BOT_AGENT_TOOLS_AUTO_INSTALL=0` 开关控制，`createControlPlane` 内部不自动联网）。工具卷根目录 `.state.json` 记录各 Agent 的 `removed` 标记、失败原因与指数退避重试时间（5m / 15m / 1h / 6h）；整项删除或删除最后一个版本会写入 `removed: true` 防止重启自动重装，手动安装/升级成功后清除。
- **按产品分流的安装与安全边界**：
  - `claude_code`（npm + 受管 Node 22.15.0）、`codex`（GitHub Release）、`icode`（GitHub Release 离线包纯 JS 解包）以及 `uv` 0.13.9（GitHub musl 静态包，落地至 `/opt/agent-tools/uv/<ver>/bin/uv`，无需改动控制面镜像）均在控制面校验可信来源与 SHA-256 后原子落盘。
  - `workswarm` 因上游 `uv.lock` 含源码包（需执行 PEP 517 构建），控制面仅下载并校验 `pyproject.toml`、`uv.lock`、`workswarm` wheel 及合并 `sourceSha256` 到 `.staging/`，随后调用 `manager` 的 `POST /v1/agent-tools/install-acp` 启动一次性隔离容器（`BOT_PROJECT_IMAGE`、`USER 10001:10001`、`ReadonlyRootfs: true`、`CapDrop: ALL`、`no-new-privileges:true`、专用外网构建网络且**仅挂载 `agent-tools` 卷**，零接触 `/keys/master.key`、`control.sqlite`、`manager.token` 与 `control` 网络）执行 `runner/acp-install-worker.mjs`。缺少隔离安装器时以 `agent_tool_isolated_installer_required` 失败关闭。
  - 运行中版本保护：`remove`、`install` 与 `prune` 均校验 `activeCliVersions`（含 Node/`uv` 运行时依赖）并返回 `409 agent_tool_version_in_use`；ACP 的 `selected` 指针在 `prune` 中受保护，单版本删除时自动切换到剩余最高合法版本或清空。

### 容器内 ACP

`container_acp` 声明工作区执行、`writer` / `observer` 角色类型，以及模型中转支持的 Chat Completions、Responses 和 Anthropic Messages 格式。配置中原有的 `acp` 标识继续按退役规则迁移。ACP 客户端由项目电脑里的 runner 启动，产品以 JSON-RPC 帧写 stdout，诊断写 stderr。客户端握手时仅声明平台实际提供的能力，文件访问和命令由产品在任务工作区执行。

`session/new` 和 `session/load` 均接收工作区路径与本次运行的 MCP 配置。支持 `loadSession` 且会话可读时记录 `native_resume`。其余续跑从授权的任务记录重建并记录 `rebuilt_from_task_records`。平台立即响应许可请求并记录 `permission` 事件，产品预设可提供私有请求的即时答复。未注册的请求立即收到 JSON-RPC `-32601`。

HTTP MCP 按运行监听 `127.0.0.1` 动态端口，使用运行令牌作为 Bearer 凭据，和 stdio 共享工具清单、权限检查与提交校验。产品预设用 `{relay}`、`{token}`、`{model}` 填入模型地址、运行令牌与已解析的模型。中转请求沿用平台模型用量账本。取消时 runner 先发 `session/cancel`，随后回收整组进程。看门狗在控制面停止续租后也会执行该流程。配套进程各有回环端口、探活路径和独立运行目录，整组随运行结束。

#### WorkSwarm

`workswarm` 复用容器 ACP 和模型邮箱，启动独立的 AgentServer 与 Gateway 并探测两个回环 WebSocket。每次运行提供独立 HOME、数据目录和三个回环端口。配套服务退出、取消、超时和租约失效由 ACP 运行回收逻辑处理。runner 核对 ACP 版本和产品版本。WorkSwarm 不支持 `session/load`，恢复时标记 `rebuilt_from_task_records`。

WorkSwarm 的 ACP 桥不接受客户端注入的 HTTP MCP。runner 用 WorkSwarm 自己的 `mcp.servers` 注册受运行令牌保护的回环 MCP。WorkSwarm 在独立目录启动，禁用钩子，通过平台工具读写任务检出和执行命令。runner 准备工作目录时跳过上游配置模板合并，核对默认拒绝和平台 MCP 工具许可表后才启动配套服务。模型中转仅提供许可的任务工具，任务邮箱再次按角色权限检查。ACP 会话声明无人可交互。Gateway 自带调度器仍启动，平台不创建定时任务或配置 WorkSwarm 自带消息渠道。

#### iCode

`icode` 注册为独立后端，复用容器内 ACP 会话和工具转发。控制面读取选定的离线包清单，runner 在项目电脑内启动 `icode acp --approval bypass`，并核对握手版本与 HTTP MCP、会话关闭能力。每次运行写入独立 HOME 及最小配置，API 样式遵循平台选定模型，凭据字段保留运行令牌占位。仓库设置、钩子及自带 MCP 均关闭。仓库指令和 Skill 仅从可信检出按 iCode 原生方式加载，不可信检出由平台提供基准分支指令。角色权限决定是否开放原生文件读取、写入、命令和 Skill 脚本。

会话状态由 `CHRYS_SESSION_ROOT_DIR` 写入角色实例持久目录。恢复在相同工作目录用 `session/load`，依上游工作目录校验和任务记录决定恢复或重建。iCode 的 `_chrys/request_input` 按问题即时用英文告知模型无人可答，请根据任务自行判断，并设置五秒超时。结束先发 `session/close`，取消、超时或失去租约时也走有时限的会话关闭。runner 用运行实例标识回收脱离进程组的后台 Shell，并移除该次 HOME。

#### 安装 Python 产品

安装脚本校验源码目录摘要，用 uv 安装固定补丁版本的 Python，并按上游 `uv.lock` 或带哈希的 `requirements.txt` 安装依赖。控制面读取选定版本的清单，项目电脑从只读工具卷执行对应版本的解释器和入口。管理员操作见 [安装与维护容器内 ACP 产品](../features/deployment-and-operations.md#安装与维护容器内-acp-产品)。

`preset.json` 包含 `python`、`source`、`sourceSha256`、`lock` 和 `launch`。`launch` 包含 `args`、`mcp`（`http` 或 `stdio`）、`access`、`untrustedCheckout`、`env`、`answers` 和 `sidecars`。在 `args` 与 `env` 中可使用 `{product}`、`{workspace}`、`{state}`、`{run}`、`{access}` 及模型变量。`{product}` 指向已校验的源码目录。`answers` 把私有 JSON-RPC 方法映射为即时返回值。每个配套进程声明 `name`、`args` 和 `healthPath`，用 `{port:名称}` 获取端口，自身的 `{state}`、`HOME` 和临时目录按运行隔离。

`access: full` 要求当前角色具有文件写入和命令权限。使用 `access: native` 的预设须把 `{access}` 中的约束落实到产品的文件与命令配置。预设只有在能禁用不可信检出中的本地指令、钩子和 MCP 配置时才声明 `untrustedCheckout: true`。可信仓库指令由平台按现有规则提供。

安装器核验解释器版本并写入来源和哈希后，原子切换选定记录。已开始的运行保持原版本绑定。产品的安装来源可能包含 PyPI 和 Python 构建产物下载站，由安装环境提供网络访问。

## 4. 虚拟电脑生命周期与自动预编译镜像引擎（`manager/`、`runner/`）

### 统一环境与两级预编译镜像（`manager/precompiled-images.mjs`）

- **一套全局默认环境 + 项目增量叠加**：全局 `computer_defaults`（默认资源、外网开关、全局 `packages`、全局 `setup_script` 与全局 `env`）同时驱动管理助手电脑、群助手电脑与项目电脑；项目级软件配置自动叠加在全局默认之上。
- **两级内容寻址镜像缓存**：Level 1 构建全局基座镜像（`department-bot-computer-precompiled:<global_key>`，由管理助手、群助手与无增量项目直接复用），Level 2 以全局基座为 `FROM` 仅叠加项目增量包与增量脚本；重置项目或新起助手容器直接命中缓存镜像，零重复安装。`precompiled_images` 台账跟踪状态与占用，GC 自动保护全局当前镜像、活跃项目镜像、存活助手容器镜像及其父层。
- **串行构建队列与可控性**：全局构建并发固定为 `1`（FIFO 排队 + 同 `image_key` single-flight 订阅去重）；构建不设超时（`timeout = 0`），内存（禁 swap）与 CPU 上限与目标项目（或全局默认）一致；构建在项目独占锁外异步执行，流式刷新输出日志，并支持超管与项目管理员随时通过 `AbortSignal` 取消（不影响正在运行的容器）。
- **四项构建期硬防护**：
  1. `setup_script` 构建期一律禁止 `root`，固定以 `USER 10001:10001` 安装到基础镜像预置的 `/opt/preinstalled`（自动纳入 `PATH`，运行期容器保持 `ReadonlyRootfs: true`）；系统 deb 包仅走正则校验的 `packages` 白名单模板；构建期预建 `/workspace/home` 兼容旧脚本，并在脚本写入该目录时打印构建告警且清理临时写入内容，避免升级（已有工作卷遮蔽 `/workspace`）与重置（空卷）产生行为分歧；
  2. `setup_script` 与构建期环境变量均作为独立 tar 上下文文件（`setup.sh`、`env.sh`）注入，绝不字符串拼接进 Dockerfile；
  3. 构建期网络绑定专用 `enable_icc=false` 外网 bridge（与 `control` 网隔离），目标禁用 `egress` 时同步切换为 `networkmode=none`；
  4. 扩展 `reservedEnv` 黑名单，禁止 `LD_PRELOAD`、`LD_LIBRARY_PATH`、`NODE_OPTIONS`、`PYTHONSTARTUP`、`PYTHONPATH`、`BASH_ENV`、`UV_TOOL_BIN_DIR` 等动态注入变量，且绝不传入任何凭据。

### 项目电脑（`manager/projects.mjs`）

- **每仓一台、并发复用**：同一仓库共享一台长期容器、工作卷与笔记卷，支持 `N`（1–32）个任务并发执行各自目录；启停、重置、重建与配置操作在项目锁内排队独占执行（镜像预编译在锁外异步执行，构建完成后再原子切换容器）。
- **代次（`generation`）与权限分层**：重置电脑时停旧代容器、递增代次并创建新工作卷与新网络（旧代次封存不复用）；项目管理员可配置本项目增量 `packages`、`setup_script`、`env` 并手动停止构建，CPU/内存/进程数/`/tmp` 与 `egress` 保持仅超级管理员可写。
- **进程回收与崩溃恢复**：单命令结束后清理进程组，任务结束后按 `BOT_WORKSPACE_ID` 回收该任务全部进程（含 `keep_background` 服务）；最后一个任务结束时清扫残留进程，仅在清理失败或容器异常退出时触发独占重启。`manager` 重启时通过 journal 对账并恢复已登记电脑；若基础镜像升级或规格未命中缓存，容器先以匹配当前基础镜像的镜像（确保 runner 协议版本一致）快速就绪，后台串行队列以 `commitSpec: false` 异步预编译新镜像并在 `projects.build` 持久化 `deferred: true` 标记。在延后构建排队/进行中及构建完成等待切换（`image_pending: true`）期间（含复用同基础镜像旧镜像的场景），`describe()` 统一上报 `toolchain_pending: true` 并持久化到 `project_environments.toolchain_pending`。控制面启动时通过 `startProjectRuntime()` 先将已保存的 `project_environments.toolchain_pending` 置为 `1`（fail-closed）再立即启动 `engine.start()`（不等待长耗时 `environment_operations`），随后后台 `reconcile()` 通过独立的只读快路径 `syncStates()` 逐仓回填实时 `toolchain_pending`（`manager_not_ready` / `manager_unavailable` 保持门禁不清除）；`claimQueuedTask` 在写事务内同时受 `environment_operations (state='pending')` 与 `toolchain_pending=1` 约束，暂缓认领任务；构建完成后由控制面结合 `environment_operations` 排他门禁于空闲时发起 `refresh` 平滑切换并清除 `toolchain_pending`；若延后构建最终失败或被手动停止，则清除 `toolchain_pending` 解除门禁并上报仅用于展示的 `toolchain_missing: true`（管理员主动触发的新构建进行中时不误报），避免项目永久饿死（下次重启或管理员保存/重建时重新触发）。

### 助手电脑（`manager/assistant-computers.mjs`）

- **按归属按需创建与全局镜像对齐**：Native 回合仅在需要执行命令或访问 `/tmp`/`/workspace` 时启动短时容器（纯读写 HOME 由控制面经 `/proc/self/fd` 边界核验直读直写）；容器默认直接继承全局默认环境与全局预编译镜像（及全局 `env`），全球默认更新后空闲容器在下一回合平滑切换。
- **Harness 回合提前申请**：Pi、Codex、Claude Code 的服务助手回合整轮都在助手电脑上运行，所以回合一开始就调用 `AssistantComputer.warm()`，与上下文拼装、权限核对同时申请电脑。它按 Harness 运行环境的语义申请（同 `sessionWorkspace`，不要求 `run_command`）；首次使用与它共用同一次 HOME 准备和容器申请；申请失败不记住，首次使用会再遇到并报告；回合在申请完成前结束时，电脑一到手就归还。容量满时排队提示与原来相同。
- **生命周期与 HOME 代次**：运行中每 30 秒续期，回合结束回收进程后空闲默认 30 分钟销毁（同一人或同一群隔几分钟再问时直接复用；设置只保存管理员改过的值，旧版本连同默认值存下的 5 分钟在升级时改为跟随新默认），单台最长存活 4 小时，达到并发上限淘汰最久空闲容器；归属的仓库范围收缩或更换绑定/角色时推进 HOME 代次并封存旧代次，超过软容量上限（默认 5 GB）自动降为只读提示清理。
- **必需组件提示**：有服务助手或启用的群绑定用 Pi、Codex 或 Claude Code 时，助手电脑不可用（控制面没配 manager、控制面没挂 `assistant-homes`、manager 不响应、manager 没挂 `assistant-homes`）会在控制面启动时写一条 `[assistant-computers]` 警告日志；控制台在这些后端的选择旁（`GET /api/assistant-computers/status`）和「助手电脑」设置页给出原因。
- **预装浏览器与 X11 虚拟桌面**：项目与助手基础镜像统一预装 Chromium（`/usr/local/bin/bot-chromium`）与虚拟桌面包装（`/usr/local/bin/bot-desktop`，封装 `Xvfb`、`openbox`、`xdotool`、`scrot`、`ffmpeg` 等），兼容只读根文件系统与非特权用户，控制面本身不安装浏览器。
