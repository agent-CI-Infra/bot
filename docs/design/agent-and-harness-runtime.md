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
  - **受控 GitHub 写入（`github_write`）**：类 REST 接口，按路由映射细粒度资源权限与能力上限，单次调用临时签发最小写权限安装令牌并在发出后立即撤销，支持按 scope+key 去重，**永远拒绝 `.github/workflows/`**。
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
| `claude_code` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | NDJSON 流协议启动受控版本 CLI，开放容器原生终端/文件/子 Agent，经 stdio MCP 桥（`runner/mcp-bridge.mjs`）调用平台工具，禁用不可信检出的本地 hooks/settings/MCP；支持原生直连或显式回环模型中转（`runner/model-relay.mjs`）。 |
| `codex` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | 启动 `codex app-server` JSON-RPC 协议，首轮前核验特性开关与唯一 `bot` MCP 服务，运行中实时拦截未授权工具或 `model/rerouted`，支持 `thread/resume` 与 turn 对账。 |
| `container_acp` | 项目容器任务工作区（`/opt/agent-tools` 只读卷） | ACP v1 stdio。会话、工具、审批和流式输出遵循 ACP，模型请求经现有邮箱中转，平台工具走回环 HTTP MCP 或 stdio MCP。 |

- **容器内短期 Git/`gh` 只读凭证**：`claude_code`、`codex` 和 `container_acp` 使用运行级身份，由 `runner/git-credential-bot.mjs` 与 `runner/gh-wrapper.mjs` 向 `harness-entry.mjs` 申请短期只读安装令牌并流式脱敏。
- **取消回收**：所有容器内 Harness 均以独立进程组运行，取消时先优雅中断，宽限期后经 `workspace_harness_interrupt` 杀死整个进程组并执行 `reap`。

### 容器内 ACP

`container_acp` 声明工作区执行、`writer` / `observer` 角色类型，以及模型中转支持的 Chat Completions、Responses 和 Anthropic Messages 格式。配置中原有的 `acp` 标识继续按退役规则迁移。ACP 客户端由项目电脑里的 runner 启动，产品以 JSON-RPC 帧写 stdout，诊断写 stderr。客户端握手时仅声明平台实际提供的能力，文件访问和命令由产品在任务工作区执行。

`session/new` 和 `session/load` 均接收工作区路径与本次运行的 MCP 配置。支持 `loadSession` 且会话可读时记录 `native_resume`。其余续跑从授权的任务记录重建并记录 `rebuilt_from_task_records`。平台立即响应许可请求并记录 `permission` 事件，产品预设可提供私有请求的即时答复。未注册的请求立即收到 JSON-RPC `-32601`。

HTTP MCP 按运行监听 `127.0.0.1` 动态端口，使用运行令牌作为 Bearer 凭据，和 stdio 共享工具清单、权限检查与提交校验。产品预设用 `{relay}`、`{token}`、`{model}` 填入模型地址、运行令牌与已解析的模型。中转请求沿用平台模型用量账本。取消时 runner 先发 `session/cancel`，随后回收整组进程。看门狗在控制面停止续租后也会执行该流程。配套进程各有回环端口、探活路径和独立运行目录，整组随运行结束。

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
  1. `setup_script` 构建期一律禁止 `root`，固定以 `USER 10001:10001` 安装到基础镜像预置的 `/opt/preinstalled`（自动纳入 `PATH`，运行期容器保持 `ReadonlyRootfs: true`）；系统 deb 包仅走正则校验的 `packages` 白名单模板；
  2. `setup_script` 与构建期环境变量均作为独立 tar 上下文文件（`setup.sh`、`env.sh`）注入，绝不字符串拼接进 Dockerfile；
  3. 构建期网络绑定专用 `enable_icc=false` 外网 bridge（与 `control` 网隔离），目标禁用 `egress` 时同步切换为 `networkmode=none`；
  4. 扩展 `reservedEnv` 黑名单，禁止 `LD_PRELOAD`、`LD_LIBRARY_PATH`、`NODE_OPTIONS`、`PYTHONSTARTUP`、`PYTHONPATH`、`BASH_ENV`、`UV_TOOL_BIN_DIR` 等动态注入变量，且绝不传入任何凭据。

### 项目电脑（`manager/projects.mjs`）

- **每仓一台、并发复用**：同一仓库共享一台长期容器、工作卷与笔记卷，支持 `N`（1–32）个任务并发执行各自目录；启停、重置、重建与配置操作在项目锁内排队独占执行（镜像预编译在锁外异步执行，构建完成后再原子切换容器）。
- **代次（`generation`）与权限分层**：重置电脑时停旧代容器、递增代次并创建新工作卷与新网络（旧代次封存不复用）；项目管理员可配置本项目增量 `packages`、`setup_script`、`env` 并手动停止构建，CPU/内存/进程数/`/tmp` 与 `egress` 保持仅超级管理员可写。
- **进程回收与崩溃恢复**：单命令结束后清理进程组，任务结束后按 `BOT_WORKSPACE_ID` 回收该任务全部进程（含 `keep_background` 服务）；最后一个任务结束时清扫残留进程，仅在清理失败或容器异常退出时触发独占重启。`manager` 重启时通过 journal 对账并恢复已登记电脑。

### 助手电脑（`manager/assistant-computers.mjs`）

- **按归属按需创建与全局镜像对齐**：仅在回合需要执行命令或访问 `/tmp`/`/workspace` 时启动短时容器（纯读写 HOME 由控制面经 `/proc/self/fd` 边界核验直读直写）；容器默认直接继承全局默认环境与全局预编译镜像（及全局 `env`），全球默认更新后空闲容器在下一回合平滑切换。
- **生命周期与 HOME 代次**：运行中每 30 秒续期，回合结束回收进程后空闲默认 5 分钟销毁，单台最长存活 4 小时，达到并发上限淘汰最久空闲容器；归属的仓库范围收缩或更换绑定/角色时推进 HOME 代次并封存旧代次，超过软容量上限（默认 5 GB）自动降为只读提示清理。
- **预装浏览器与 X11 虚拟桌面**：项目与助手基础镜像统一预装 Chromium（`/usr/local/bin/bot-chromium`）与虚拟桌面包装（`/usr/local/bin/bot-desktop`，封装 `Xvfb`、`openbox`、`xdotool`、`scrot`、`ffmpeg` 等），兼容只读根文件系统与非特权用户，控制面本身不安装浏览器。
