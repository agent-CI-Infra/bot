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
  - **超长结果分页**：超过预算或需折叠的工具输出统一脱敏写入 `tool-results` 卷（24 小时过期），仅向模型返回首尾预览与句柄，通过 `read_tool_result` 或容器内只读 `/results/<id>.utf8` 按需读取；`manager/docker.mjs` 保留默认 4 MiB 单次响应保护上限（允许调用方按需显式传入有限上限，防止异常大响应引发 OOM），`runner/workspace.mjs` 的 `workspace_read` 在超过 1 MiB 时返回首尾预览与可读文件路径（Git 对象落盘到任务 `logs/`，调用方分页接口保持 `complete: false`、`truncated: true` 而不误标完整），并支持 `max_bytes` / `skip_binary` 供验收预检跳过 >256 KiB 文件与二进制。
  - **孤儿笔记卷与已停止容器自愈**：`manager/projects.mjs` 将 `reclaimNotes`、`reclaimStaleNotes` 与项目删除（`delete_notes`）统一到共享安全清理入口 `purgeNotesVolume`：删除 `-notes` 卷前按容器实际 `Mounts` 精准识别仍挂载该卷的本部署已停止孤儿容器，仅清理其对应代次的网络与 `resources` 行（不误伤未挂载 `-notes` 卷的运行中容器或活跃项目行；若有运行中容器仍挂载该卷，则以 `409 notes_volume_in_use` / `503 notes_residue_unclearable` 拒绝，绝不误杀运行中实例）。
  - **命令时限与后台进程**：`run_command` 支持 `timeout_seconds`（受 `BOT_COMMAND_TIMEOUT_MAX_SECONDS` 统一封顶）与 `keep_background: true`（自动将日志落盘到 `log_path` 并随任务结束回收进程组）。
  - **命令长度**：任务电脑与助手电脑的 `run_command` 共用同一个命令上限，按 UTF-8 计 64 KiB（`runner/command-policy.mjs` 的 `commandLimit`），schema 的 `command` 描述里写明；超限回稳定 code `command_too_long`，带 `limit` 与 `length`，并提示改写成脚本文件。上限不为无限：整条 runner 请求会 base64url 成一个 `docker exec` 参数，Linux 单参数上限 128 KiB，所以 `runnerRequestLimit`（95 KiB JSON）是传输兜底。传输按 JSON 编码后的字节计，引号与换行会再转义一次，因此 64 KiB 以内的命令也可能超传输上限；控制面与 manager 共用 `requestTooLarge`，命中时回稳定 code `runner_request_too_large`，带 `limit`、`length`（编码后字节）和改写成脚本文件的提示，不再变成 `execution_interrupted` 与重启；再大需要改成 stdin 投递。

## 2. `bot.role-run/1` 协议与 `TaskToolGateway`（`src/roles/`）

每次角色执行都是 `task_runs` 中的一次版本化 RoleRun，统一经历 `prepare → start → events / checkpoint / cancel → collect / recover`：

- **不可变运行快照（`RunContext`）**：启动时按内容哈希固化角色定义、模型版本、Skill 文件与哈希、有效权限、环境、预算及不可变 `source_ref`/`candidate_ref`；写入前强制经 `assertSecretFree` 校验无密钥泄漏。
- **单调租约（`lease_epoch`）与短时运行令牌（`rrt_…`）**：
  - 每次绑定分配单调递增 `lease_epoch` 并签发 15 分钟续期运行令牌（仅存哈希，绑定租户/项目/任务/run/epoch/角色/能力）；新 run 接管或取消时旧令牌立即撤销，旧 epoch 迟到事件/提交全部拒绝。
- **能力准入（`admitRun`）与累计预算**：
  - 启动前对照驱动能力矩阵校验（`cancel`、`version_binding`、`output_validation`、`raw_evidence`、`fixed_candidate_read`、`fresh_context`），缺失即 `waiting_configuration`，不静默降级后端。
  - `metered` 预算按角色实例跨重试/恢复持续累计（token、请求数、工具数、墙钟时间），耗尽立即中断并撤销令牌；连续长耗时运行满 60 分钟及之后每 20 分钟向 Manager 发送 `long_execution_report` 而非粗暴强杀。Manager 对每份报告只做一次结构化模型请求：报告点名的证据（最近工具记录、检查点、交接输入、该次运行的配置）按 Manager 的知识权限预先附在请求里并限长，唯一的工具是必须调用的 `submit_long_execution_decision`，只能对这次运行选择继续或停止，不能验收、发布或改验收标准。
- **`TaskToolGateway`**：角色读取任务历史、直连项目物理知识卷（`../notes/` / `manager/file-tree`）与保存共享经验笔记统一经网关鉴权（复核 `rrt_…`、epoch、发起人实时权限与角色策略），屏蔽跨任务/跨项目引用；支持同一任务多角色在共享工作区协作、按需为并发开发任务分配独立 `git worktree`。持续多轮 bot PR 开发任务跨轮保留同一 `role_instances` 会话/Harness 状态与工作区（`rebind` 在后端变更时清空旧会话重建，同后端模型/提示词变更则平滑切到新快照），`workspace-cleanup.ts` 在 PR 开放期保护其 `workspace_id`、worktree 与 `stateWorkspaceId` 并结合 `bot_pr_states` / `review_objects` 在 PR 关闭或合入后回收。

## 3. 多后端 Harness 抽象（`src/harness/`、`runner/`）

`roleHarness(id).createSession(spec, services)` 屏蔽执行器差异，统一提供 `run / send / cancel / close` 与规范化恢复模式（`native_resume`、`checkpoint_transcript`、`rebuilt_from_task_records`、`fresh_evaluation`）。所有内置后端都在项目电脑或助手电脑内运行；在控制面以子进程运行的 `process` 后端已删除（#1338），`checkpoint_transcript` 仍是协议词汇，目前只有测试专用的脚本化驱动使用：


| 后端 | 运行位置 | 关键设计要点 |
| --- | --- | --- |
| `pi`（默认推荐） | 项目/助手容器内（固定版本 Pi SDK） | 嵌入式 Node 会话，会话文件持久化在独立 `cli-state/pi/` 目录；支持原生工具、SDK 压缩与跨重启会话续接；经文件邮箱与控制面通信。 |
| `claude_code` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | NDJSON 流协议启动受控版本 CLI，开放容器原生终端/文件/子 Agent，经 stdio MCP 桥（`runner/mcp-bridge.mjs`）调用平台工具，禁用不可信检出的本地 hooks/settings/MCP；支持平台模型（原生直连或回环中转）与「项目电脑内自行配置」（`model_source: 'local_config'`）两种模式。 |
| `codex` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | 启动 `codex app-server` JSON-RPC 协议，首轮前核验特性开关与唯一 `bot` MCP 服务，运行中实时拦截未授权工具或 `model/rerouted`，支持 `thread/resume` 与 turn 对账；支持平台模型与「项目电脑内自行配置」（`model_source: 'local_config'`）两种模式。 |
| `icode`、`workswarm` | 项目容器任务工作区（`/opt/agent-tools` 只读卷） | ACP v1 stdio。会话、工具、审批和流式输出遵循 ACP，模型请求经现有邮箱中转，平台工具走回环 HTTP MCP 或 stdio MCP。 |

- **容器内短期 Git/`gh` 只读凭证（支持单仓与多仓按需签发）**：`pi`、`claude_code`、`codex`、`icode` 和 `workswarm` 均配置 `credential.useHttpPath=true`、`core.hooksPath=/dev/null` 与 `core.fsmonitor=false`，由 `runner/git-credential-bot.mjs`（解析仓库路径）与 `runner/gh-wrapper.mjs`（解析 `-R`/`--repo`、`gh api repos/...`、`gh repo`、`GH_REPO` 或当前仓库 remote）向回环凭证助手按 `(purpose, repository)` 申请并缓存短期只读安装令牌。控制面 `ScopedReadTokens` 实时校验当前会话仓库范围与 GitHub 读权限（`git` 用途仅签发 `contents: read + metadata: read`），对 PAT 仓库明确提示改用 `checkout_repository` 而不泄露长期凭据，全程经 `Redactor` 流式脱敏并在回合结束统一吊销。
- **Claude Code / Codex「项目电脑内自行配置」（`model_source: 'local_config'`）**：
  - `harness_ref.model_source` 规范值为 `'gateway' | 'local_config'`（旧配置 `'subscription'` 自动归一化为 `'local_config'`）。
  - 选择 `local_config` 时，控制面与 `runner/harness-entry.mjs` **不注入**任何平台模型配置（无 `ANTHROPIC_*`、`--model`、`CODEX_RELAY_URL`、`OPENAI_*`、`BOT_NATIVE_MODEL_KEY`、`config.toml` 或 `-c model_providers.bot_direct`），同时保持每次运行独立的 `HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。
  - 启动 CLI 前由 `runner/cli-config.mjs` 仅将 `/workspace/home` 下的白名单文件（Claude Code：`.claude/settings.json`、`.claude/.credentials.json`；Codex：`.codex/config.toml`、`.codex/auth.json`）以 `0600` 权限复制到当前会话目录（Claude Code 传 `--setting-sources user`），运行结束立即删除副本但保留会话 transcript。未检测到任一配置文件时以 `claude_local_config_missing` / `codex_local_config_missing` 失败关闭，绝不回退到平台模型。
  - 管理入口经 `GET/PUT/DELETE /api/environments/:id/cli-config` → `manager` → runner 非 journal 操作（`cli_config_status`/`write`/`delete`）直写 `/workspace/home`，控制面不读取、不落库、不记录日志；写入内容在控制面、manager 与 runner 三处统一限制上限为 32 KiB（超限返回 `400 invalid_cli_config_content`），由 manager 经 Docker exec 环境变量 `BOT_CLI_CONFIG_B64` 传入（不进入命令行 `argv`，runner 读取后立即清除环境变量）。
- **取消回收**：所有容器内 Harness 均以独立进程组运行，取消时先优雅中断，宽限期后经 `workspace_harness_interrupt` 杀死整个进程组并执行 `reap`。

### 默认后端与固定 Pi 的角色

管理助手、群聊助手、Manager 和 QA 只在 `pi` 上运行（#1337）。服务助手的可选后端 `serviceHarnesses` 只有 `pi`（`src/service-roles/roles.ts`），服务角色与群绑定提交其他后端返回 `unknown_role_harness`，控制台不再提供选择。项目角色仍按注册表声明的 `kinds` 准入：只有 Pi 声明 `controller`（Manager）和 `evaluator`（QA），所以保存配置时这两个角色选其他后端返回 `harness_role_unsupported`，`resolveRole` 对容器后端的入口覆盖同样拒绝；Codex、Claude Code 的运行时身份检查也只接受 `writer` 和 `observer`。Dev、Test、Reviewer、UX 和自定义角色的可选后端不变。

旧库在启动时由 `pinAssistantsToPi`（`src/roles/native-to-pi.ts`，标记 `migration:1337:assistants-on-pi`）在一个事务里一次性改写，有改动时启动日志写一行 `[migration:1337]` 计数：服务角色改为 `pi` 并递增 revision；群绑定改为 `pi`、revision 不变（群的授权围栏）；Manager 与 QA 由通用的 `moveRolesToPi`（`src/roles/definition.ts`）改写已保存配置（V2 生成新配置版本，旧格式 `harnesses` 条目原地改写）、`task_execution_configs` 冻结快照和 `role_instances`（清空 `session` 与 `harness_state`）。角色固定的模型保留，Pi 不支持其模型 API 时计入日志，角色停在等待配置，不改用其他模型。

项目角色、管理助手和群聊助手的默认后端都是 `pi`：推荐配置（`defaultRoles`）、旧格式角色配置里没写后端的角色（`src/roles/pool.ts`）、`service_roles.harness` 与 `channel_service_bindings.harness` 的读写缺省值和新建库的列默认值，以及控制台新建表单。升级库的这两列保留加列时的 `DEFAULT 'native'`（`ALTER TABLE ... ADD COLUMN` 只在加列时执行一次），但所有写入都显式给出后端，列默认值不影响行为。`native` 后端已删除（#1257，见下文）。

旧库在启动时由 `migrateNativeToPi`（`src/roles/native-to-pi.ts`，标记 `migration:1255:native-to-pi`）在一个事务里一次性改写，并在启动日志写一行计数：

- 服务角色：`native` → `pi`，递增 revision，旧页面不能悄悄把 `native` 存回去。
- 群绑定：`native` → `pi`，revision 不变：它属于群的授权围栏，后端不改变群能做什么。
- 项目角色：V2 配置里的 `native` 角色改为 `pi`，生成新配置版本（`updated_by: migration:1255`）；旧格式配置里写明 `native` 的条目改为 `pi`。角色覆写的模型要求 `text_json` 输出时 Pi 用不了，保持 `native` 并计入日志（由下文 `migration:1257` 迁走）。

新库启动时迁移无事可做、直接记下标记。

`native` 后端已删除（#1257）：控制面里不再有自己的工具循环，`runAgent` 必须带适配器（缺少时抛出 `agent_adapter_required`），每个注册的后端都自带传输。角色配置提交 `native` 由已有校验返回 `unknown_role_harness`。

- 服务助手：提交 `native` 由已有校验返回 `unknown_role_harness`（#1337 起只接受 `pi`，见上文）。`migration:1255` 之后手动选成 `native` 的残留值，由 `retireNativeServiceAssistants`（`src/roles/native-to-pi.ts`）在每次启动时改为 `pi`：服务角色递增 revision，群绑定 revision 不变，有改动时启动日志写 `[migration:1257]` 计数。没有任何写入能再存回 `native`，所以首次启动之后它什么也找不到。
- 项目角色：`retireNativeProjectRoles`（标记 `migration:1257:retire-native-roles`）在一个事务里一次性改写 `migration:1255` 之后剩下的 `native`：已保存配置里的 V2 角色（生成新配置版本，`updated_by: migration:1257`）和旧格式 `harnesses` 条目、冻结在 `task_execution_configs` 里的任务配置快照（照 #705 退役 ACP 的做法，等待中或重新唤醒的任务能继续运行），以及 `role_instances`（改为 `pi`，并清空 `session` 与 `harness_state`，下次运行从任务记录重建）。所有角色都改为 `pi`；角色覆写的模型若要求 `text_json` 输出，改为 `tool_call`（见下条）。#1338 之前这类角色改为 `process`。有改动时启动日志写一行 `[migration:1257]` 计数。

`process` 后端已删除（#1338）：注册表、`runner/role-worker.mjs` 和只为它服务的请求预留（`src/roles/run.ts` 的收尾预留现在只用于 Pi）一并删除，角色配置提交 `process` 由已有校验返回 `unknown_role_harness`。`text_json` 结构化输出只有 Process 读取，现在没有后端声明它：保存 `text_json` 返回 `harness_structured_output_unsupported`，角色编辑器在后端只有一种输出方式时不再显示「结构化输出方式」。旧库在启动时由 `retireProcessRoles`（`src/roles/native-to-pi.ts`，标记 `migration:1338:retire-process`）经 `moveRolesToPi` 一次性把已保存配置、冻结快照和角色实例中的 `process` 改为 `pi`；迁移的角色保留固定的模型，`text_json` 改为 `tool_call`，等待中的任务因此能在 Pi 上继续。有改动时启动日志写一行 `[migration:1338]` 计数。

通用容器 ACP 后端 `container_acp` 已删除（#1339）：注册表只保留 `icode` 和 `workswarm` 两个 ACP 后端，各自运行工具卷里同名的产品，不再由 `BOT_ACP_PRODUCT` 选择；角色配置提交 `container_acp` 由已有校验返回 `unknown_role_harness`。旧库在启动时由 `retireContainerAcpRoles`（`src/roles/native-to-pi.ts`，标记 `migration:1339:retire-container-acp`）经 `moveRolesToPi` 一次性把已保存配置、冻结快照和角色实例中的 `container_acp` 和更早的 `acp`（#705）改为 `pi`，有改动时启动日志写一行 `[migration:1339]` 计数。工具卷里已安装的 `acp/container_acp` 不再被读取，也不自动删除。

### Pi 会话邮箱（`src/agent/pi.ts`、`runner/agent.mjs`）

控制面和容器里的 Pi 进程通过任务目录 `agent/` 下的文件邮箱通信，每次调用都由 manager 在容器里执行一次 runner（`docker exec`）。

- **启动**：配置按 30000 字节分块写入，最后一块同时带 `start` 和角色固定的 Pi 版本。runner 先核对版本，不符时什么也不写、不启动，控制面报 `harness_version_mismatch`；版本相符时清理上一进程的邮箱、写入配置并启动，答复里带上实际运行时。工作卷写满时，runner 把带 `start` 的最后一块当作启动拒绝，答复 `disk_full`（`runner/disk.mjs`），什么也不清理、不写、不启动，任务进入等待环境，与单独的 `workspace_agent_start` 一致；只存配置的其他分块照常写入。旧 runner 不认识 `start`，答复里没有运行时，控制面按原流程再查运行时、再启动。续接（`workspace_agent_continue`）和重新附着的会话没有配置可带，仍先单独查运行时。
- **长轮询**：控制面每次轮询带 `wait_ms`（3 s）、事件 offset，以及已在处理的请求 id：后台运行中或已答复的工具和令牌请求、已答复的模型请求和回合边界。runner 每 50 ms 检查一次，出现控制面没见过的东西就立即返回，包括会话离开运行状态、新的回合边界、模型请求（`request.json`）、工具或令牌请求，以及超过一页的事件。只有新事件时，最早在等待开始 200 ms 后返回，和流式文字 200 ms 一批对齐；什么都没有就等满 3 s。已在处理的工具和令牌请求只返回 id。`model_requests` 属于其他后端的模型中转，不算 Pi 会话的变化。
- **轮询节奏**：答复带 `long_poll: true` 时控制面立即发下一次轮询。旧 runner 或测试替身会立即答复、不带这个标记，控制面仍隔 500 ms 再轮询。等待期间会话被取消或后台工作失败，控制面立即结束等待并丢弃这次答复。每次轮询前控制面都检查任务状态（用户停止、权限变化），间隔不超过约 3 s，远低于 manager 的 90 s 执行超时。

### 服务助手回合（`src/harness/service-session.ts`）

管理助手和群聊助手的每一轮都由 `serviceHarnessTurn` 在会话归属的助手电脑上运行，会话绑定保存在 `service_harness_sessions`；控制面里没有服务助手自己的工具循环。独立任务（`start_own_task`，`src/service-roles/own-tasks.ts`）同样经宿主的 `run` 在同一后端上另开会话。声明了 `steered_turns` 的后端（生产中只有 Pi）按对话语义运行一轮（调用方传入 `ServiceTurnControl`，其他后端忽略它，改为得到 `finish` 工具）：

- **回答文字**：Pi 用普通文字作答，不提供 `finish` 工具。经网关时，控制面模型请求的逐 token 回调转出文字；直连时，runner 把流式文字（约 200 ms 一批的 `text_delta`）和 Pi 自身的重试（`model_retry`）写入事件流，控制面转给会话，`text_delta` 不进会话日志。
- **回合中的新消息**：会话启动前取到的消息随配置（`steer`）在提示词之后作为单独的用户消息发出；此后在每批工具调用结束的回合边界（runner 的 `finishTurn` → `boundary('turn')`）取新消息并 `session.steer()`。最终回答之后不再并入。模型输出文字时暂停并入，带工具调用的响应结束后恢复。
- **编辑后重启**：回合边界、每次经控制面的工具调用和会话结束时比较来源版本。版本变了就结束当前会话：旧版本下经控制面的工具调用不执行，答复不采用（Pi 自带的 `read`/`edit`/`write`/`bash` 直接在助手电脑上运行，不经这道检查）；清空会话绑定，用重建的上下文开新会话，已并入的消息重新提供。跨轮续接的会话在来源版本变化后也不再续接。
- **保持安静**：允许安静的轮次里，`stay_silent` 是会话的结束工具；被拒绝（例如 `reply_required`）时作为观察返回模型，回合继续。
- **工具被拒**：经控制面的工具返回 400/403/404/409/413/415 时，错误作为观察交回模型，回合继续；被拒的调用不执行。401 和内部失败结束本轮。
- **执行进度**（#1296）：`ServiceTurnControl.progress` 接收会话自己的进度。`serviceHarnessTurn` 把 Pi 的 harness 事件（`src/roles/harness.ts` 经 `onHarnessEvent` 转出的原生工具 `tool` 开始/结束、runner 仅为服务回合写的 `model_start` 与 `compaction`，以及 `image_recovery`）交给 `serviceProgressReader`（`src/harness/service-progress.ts`），再加上编辑后重启的提示。进度只带有界字段：命令首行或路径（≤160 字符）、耗时（runner 的 `duration_ms`，旧 runner 取控制面看到开始的时间）、bash 的退出码和输出末尾（≤5 行、≤300 字符）；这些文本经回合与部署的已知值（含编码形式）、令牌格式规则（`publicText`）和按名称识别的命令行凭据规则清洗。调用方用 `ProgressBudget` 限频：每轮先允许 30 步，之后每 2 秒 1 步，每轮最多 300 步；工具开始被放行时它的结束一定写入，被跳过的调用计数后作为一条提示写出。进度读取或写入出错不影响回合。
- **邮箱清理**：新会话写入配置时，runner 清除上一进程没答复的工具、令牌和模型请求，新会话不会把它们当成自己的请求。

### 第三方 Agent 工具卷统一管理（`runner/agent-products.mjs`、`src/harness/agent-tools.ts`）

- **单一产品注册表**：除内置于项目电脑镜像的 `pi` 外，所有容器内第三方 Agent（`claude_code`、`codex`、`icode`、`workswarm`）的默认版本、兼容范围、受支持架构与发行包 SHA-256 摘要统一声明在 `runner/agent-products.mjs`，并派生到 `src/harness/agent-tools.ts`、`src/roles/backends.ts`、`runner/acp-products.mjs` 与离线安装脚本。
- **启动自动安装与状态持久化**：仅 `src/main.ts` 在监听启动后拉起非阻塞的 `AgentToolsAutoInstaller`（受 `BOT_AGENT_TOOLS_AUTO_INSTALL=0` 开关控制，`createControlPlane` 内部不自动联网）。工具卷根目录 `.state.json` 记录各 Agent 的 `removed` 标记、失败原因与指数退避重试时间（5m / 15m / 1h / 6h）；整项删除或删除最后一个版本会写入 `removed: true` 防止重启自动重装，手动安装/升级成功后清除。
- **按产品分流的安装与安全边界**：
  - `claude_code`（npm + 受管 Node 22.15.0）、`codex`（GitHub Release）、`icode`（GitHub Release 离线包纯 JS 解包）以及 `uv` 0.13.9（GitHub musl 静态包，落地至 `/opt/agent-tools/uv/<ver>/bin/uv`，无需改动控制面镜像）均在控制面校验可信来源与 SHA-256 后原子落盘。
  - `workswarm` 因上游 `uv.lock` 含源码包（需执行 PEP 517 构建），控制面仅下载并校验 `pyproject.toml`、`uv.lock`、`workswarm` wheel 及合并 `sourceSha256` 到 `.staging/`，随后调用 `manager` 的 `POST /v1/agent-tools/install-acp` 启动一次性隔离容器（`BOT_PROJECT_IMAGE`、`USER 10001:10001`、`ReadonlyRootfs: true`、`CapDrop: ALL`、`no-new-privileges:true`、专用外网构建网络且**仅挂载 `agent-tools` 卷**，零接触 `/keys/master.key`、`control.sqlite`、`manager.token` 与 `control` 网络）执行 `runner/acp-install-worker.mjs`。缺少隔离安装器时以 `agent_tool_isolated_installer_required` 失败关闭。
  - 运行中版本保护：`remove`、`install` 与 `prune` 均校验 `activeCliVersions`（含 Node/`uv` 运行时依赖）并返回 `409 agent_tool_version_in_use`；ACP 的 `selected` 指针在 `prune` 中受保护，单版本删除时自动切换到剩余最高合法版本或清空。

### ACP 后端（iCode、WorkSwarm）

`icode` 和 `workswarm` 共用 `src/harness/acp.ts` 的 ACP 会话代码，在注册表中各是一项，声明工作区执行、`writer` / `observer` 角色类型，以及模型中转支持的格式（iCode 支持 Chat Completions、Responses 和 Anthropic Messages，WorkSwarm 不支持 Responses）。控制面按后端 id 读取工具卷 `acp/<id>/` 中选定的产品清单，以 `harness: 'acp'` 加 `acp_product` 交给 runner。ACP 客户端由项目电脑里的 runner 启动，产品以 JSON-RPC 帧写 stdout，诊断写 stderr。客户端握手时仅声明平台实际提供的能力，文件访问和命令由产品在任务工作区执行。

`session/new` 和 `session/load` 均接收工作区路径与本次运行的 MCP 配置。支持 `loadSession` 且会话可读时记录 `native_resume`。其余续跑从授权的任务记录重建并记录 `rebuilt_from_task_records`。平台立即响应许可请求并记录 `permission` 事件，产品清单可提供私有请求的即时答复。未注册的请求立即收到 JSON-RPC `-32601`。

HTTP MCP 按运行监听 `127.0.0.1` 动态端口，使用运行令牌作为 Bearer 凭据，和 stdio 共享工具清单、权限检查与提交校验。产品清单用 `{relay}`、`{token}`、`{model}` 填入模型地址、运行令牌与已解析的模型。中转请求沿用平台模型用量账本。取消时 runner 先发 `session/cancel`，随后回收整组进程。看门狗在控制面停止续租后也会执行该流程。配套进程各有回环端口、探活路径和独立运行目录，整组随运行结束。

#### WorkSwarm

`workswarm` 复用 ACP 会话和模型邮箱，启动独立的 AgentServer 与 Gateway 并探测两个回环 WebSocket。每次运行提供独立 HOME、数据目录和三个回环端口。配套服务退出、取消、超时和租约失效由 ACP 运行回收逻辑处理。runner 核对 ACP 版本和产品版本。WorkSwarm 不支持 `session/load`，恢复时标记 `rebuilt_from_task_records`。

WorkSwarm 的 ACP 桥不接受客户端注入的 HTTP MCP。runner 用 WorkSwarm 自己的 `mcp.servers` 注册受运行令牌保护的回环 MCP。WorkSwarm 在独立目录启动，禁用钩子，通过平台工具读写任务检出和执行命令。runner 准备工作目录时跳过上游配置模板合并，核对默认拒绝和平台 MCP 工具许可表后才启动配套服务。模型中转仅提供许可的任务工具，任务邮箱再次按角色权限检查。ACP 会话声明无人可交互。Gateway 自带调度器仍启动，平台不创建定时任务或配置 WorkSwarm 自带消息渠道。

#### iCode

`icode` 注册为独立后端，复用 ACP 会话和工具转发。控制面读取选定的离线包清单，runner 在项目电脑内启动 `icode acp --approval bypass`，并核对握手版本与 HTTP MCP、会话关闭能力。每次运行写入独立 HOME 及最小配置，API 样式遵循平台选定模型，凭据字段保留运行令牌占位。仓库设置、钩子及自带 MCP 均关闭。仓库指令和 Skill 仅从可信检出按 iCode 原生方式加载，不可信检出由平台提供基准分支指令。角色权限决定是否开放原生文件读取、写入、命令和 Skill 脚本。

会话状态由 `CHRYS_SESSION_ROOT_DIR` 写入角色实例持久目录。恢复在相同工作目录用 `session/load`，依上游工作目录校验和任务记录决定恢复或重建。iCode 的 `_chrys/request_input` 按问题即时用英文告知模型无人可答，请根据任务自行判断，并设置五秒超时。结束先发 `session/close`，取消、超时或失去租约时也走有时限的会话关闭。runner 用运行实例标识回收脱离进程组的后台 Shell，并移除该次 HOME。

#### 产品清单与安装

工具卷 `acp/<id>/<版本>/manifest.json` 记录产品来源、哈希和启动方式 `launch`，`acp/<id>/selected` 指向选定版本；`runner/acp-products.mjs` 的 `readAcpProduct` 校验清单并按产品核对平台固定的发行版本。iCode 从官方离线包只解出可执行文件；WorkSwarm 从固定提交的 `pyproject.toml`、`uv.lock` 和 wheel 用 uv 构建虚拟环境（`runner/acp-install-worker.mjs` 的 `buildWorkSwarmProduct`，常规由 manager 的隔离容器执行）。`scripts/install-acp-product.mjs` 只接受这两个产品，通用 Python 产品的 `--preset` 安装和 `hash-source` 已随 `container_acp` 删除（#1339）。管理员操作见 [iCode 与 WorkSwarm 说明与离线安装兜底](../features/deployment-and-operations.md#icode-与-workswarm-说明与离线安装兜底)。

`launch` 包含 `args`、`mcp`（`http` 或 `stdio`）、`access`、`untrustedCheckout`、`env`、`answers` 和 `sidecars`。在 `args` 与 `env` 中可使用 `{product}`、`{workspace}`、`{state}`、`{run}`、`{access}` 及模型变量。`{product}` 指向已校验的源码目录。`answers` 把私有 JSON-RPC 方法映射为即时返回值。每个配套进程声明 `name`、`args` 和 `healthPath`，用 `{port:名称}` 获取端口，自身的 `{state}`、`HOME` 和临时目录按运行隔离。

`access: full` 要求当前角色具有文件写入和命令权限。使用 `access: native` 的产品须把 `{access}` 中的约束落实到产品的文件与命令配置。产品只有在能禁用不可信检出中的本地指令、钩子和 MCP 配置时才声明 `untrustedCheckout: true`。可信仓库指令由平台按现有规则提供。

安装器核验后写入来源和哈希，再原子切换选定记录。已开始的运行保持原版本绑定。

## 4. 虚拟电脑生命周期与自动预编译镜像引擎（`manager/`、`runner/`）

项目电脑和助手电脑共用 `manager/computer-resources.mjs` 中的资源值校验、单容器宿主机内存上限计算和保守回退值。各自的生命周期与并发准入仍由对应的电脑管理器负责。

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
- **项目隔离只读工具卷（`project-tools`、`src/projects/tools.ts`）**：控制面独享 `project-tools` 卷可写挂载（`/project-tools/<repository_id>/rev-<N>`），`manager` 仅只读挂载用于校验目标版本目录存在性并经 `VolumeOptions: { NoCopy: true, Subpath }` 挂入项目电脑 `/opt/project-tools`（`ReadOnly: true`）。基础镜像与 `runner/command.mjs` 将 `/opt/project-tools/bin` 严格追加至 `PATH` 末尾，绝不遮蔽系统或 `/opt/preinstalled` 二进制。发布、回滚或清空时通过 `PUT /v1/projects/:id/tools` 更新目标版本并上报 `tools_pending`（`manager` 不可达时控制面 `view()` 显式返回 `tools_pending: null` 与 `rotation_status: 'unknown'`），运行中任务继续使用旧快照；`ProjectService.reconcileProject` 复用 `task_claims` + `environment_operations` 单事务空闲门禁发起 `refresh` 整卷轮换（清空时同步卸载）。项目任务与管理助手提示词统一声明三层工具优先级（基础镜像预装 → 预编译镜像 `packages`/`setup_script` → 私有/离线二进制才使用项目工具卷）。
- **进程回收与崩溃恢复**：单命令结束后清理进程组，任务结束后按 `BOT_WORKSPACE_ID` 回收该任务全部进程（含 `keep_background` 服务）；最后一个任务结束时清扫残留进程，仅在清理失败或容器异常退出时触发独占重启。`manager` 重启时通过 journal 对账并恢复已登记电脑；若基础镜像升级或规格未命中缓存，容器先以匹配当前基础镜像的镜像（确保 runner 协议版本一致）快速就绪，后台串行队列以 `commitSpec: false` 异步预编译新镜像并在 `projects.build` 持久化 `deferred: true` 标记。在延后构建排队/进行中及构建完成等待切换（`image_pending: true`）期间（含复用同基础镜像旧镜像的场景），`describe()` 统一上报 `toolchain_pending: true` 并持久化到 `project_environments.toolchain_pending`。控制面启动时通过 `startProjectRuntime()` 先将已保存的 `project_environments.toolchain_pending` 置为 `1`（fail-closed）再立即启动 `engine.start()`（不等待长耗时 `environment_operations`），随后后台 `reconcile()` 通过独立的只读快路径 `syncStates()` 逐仓回填实时 `toolchain_pending`（`manager_not_ready` / `manager_unavailable` 保持门禁不清除）；`claimQueuedTask` 在写事务内同时受 `environment_operations (state='pending')` 与 `toolchain_pending=1` 约束，暂缓认领任务；构建完成后由控制面结合 `environment_operations` 排他门禁于空闲时发起 `refresh` 平滑切换并清除 `toolchain_pending`；若延后构建最终失败或被手动停止，则清除 `toolchain_pending` 解除门禁并上报仅用于展示的 `toolchain_missing: true`（管理员主动触发的新构建进行中时不误报），避免项目永久饿死（下次重启或管理员保存/重建时重新触发）。

### 助手电脑（`manager/assistant-computers.mjs`）

- **按归属按需创建、临时磁盘卷与全局镜像对齐**：服务助手每一轮都在会话归属的短时容器里运行，回合一开始就申请（经控制面的 `list_files`/`read_file`/`write_file`/`delete_file` 纯列举与读写 HOME 不经容器，由控制面经 `O_NOFOLLOW` 与 `/proc/self/fd` 边界核验直通服务，统一支撑 `~/memory/` 助手私有记忆文件）；容器默认直接继承全局默认环境与全局预编译镜像（默认 16 GB 内存；单容器统一按宿主机内存 75% 安全上限收紧并拒绝保存超限值，预留 25% 给宿主机与控制面，`/info` 异常或返回缺失字段且无缓存时均保守回退至 4 GB / 2 核；项目电脑的 Docker `--memory` 为单容器 cgroup 突发上限而非常驻物理内存预留，空闲 `ready` 项目容器仅运行 `idle.mjs` 约占 ~7.5 MiB RSS，因此多仓部署的 `register`/`recover`/`start` 不按空闲项目上限之和拒启；并发忙碌助手容器按 `2×` 安全上限即 `1.5×` 宿主机内存严格扣除当前处于 `busy` 执行态的项目电脑内存做准入排队，无无条件保底绕过，既避免活跃构建与助手叠加挤爆内存，也防止多仓空闲容器饿死助手；`/workspace` 与 `/tmp` 各默认 20 GB 应用层软限额，项目电脑 `/tmp` 保持默认 4 GB 内存型 `tmpfs` 并受容器生效内存上限约束），全局默认更新后空闲容器在下一回合平滑切换。为避免大仓库检出与构建产物挤占容器 16 GB cgroup 内存上限（禁用 swap），助手电脑的 `/workspace` 与 `/tmp` 采用随容器生命周期自动创建、随容器销毁/`remove`/`recover`/`shutdown` 彻底回收的命名临时磁盘卷（标记 `department.bot.kind=assistant-workspace` / `assistant-tmp`），通过环境变量注入 `BOT_WORKSPACE_LIMIT_MB` / `BOT_TMP_LIMIT_MB` 应用层软限额（`runner/assistant-files.mjs` 以短时缓存计数加增量更新避免逐块全盘遍历，并在覆盖解包时计入峰值占用），并接入 `manager/disk.mjs` `DiskGuard`（数据盘低于安全预留时先回收空闲助手临时卷，仍不足则拒绝创建与写入返回 `disk_full`）及 `runner/disk.mjs`（同时监测 `/workspace` 与 `/tmp`）写保护，继续保持 `ReadonlyRootfs: true`、`cap_drop: [ALL]` 与无特权隔离边界。控制面 `GitCache.archive` 以流式字节上限（256 MiB）和解包前 tree 大小校验硬截断超大归档，防止写爆控制面卷。
- **Harness 回合提前申请**：服务助手的 Pi 回合整轮都在助手电脑上运行，所以回合一开始就调用 `AssistantComputer.warm()`，与上下文拼装、权限核对同时申请电脑。它按 Harness 运行环境的语义申请（同 `sessionWorkspace`，不要求 `run_command`）；首次使用与它共用同一次 HOME 准备和容器申请；申请失败不记住，首次使用会再遇到并报告；回合在申请完成前结束时，电脑一到手就归还。容量满时排队提示与原来相同。
- **生命周期与 HOME 代次**：运行中每 30 秒续期，回合结束回收进程后空闲默认 30 分钟销毁（同一人或同一群隔几分钟再问时直接复用；设置只保存管理员改过的值，旧版本连同默认值存下的 5 分钟及旧默认资源值 2048 MB / 512 MB 在升级时改为跟随新默认），单台最长存活 4 小时，达到并发上限淘汰最久空闲容器；归属的仓库范围收缩或更换绑定/角色时推进 HOME 代次并封存旧代次，超过软容量上限（默认 5 GB）自动降为只读提示清理。
- **必需组件提示**：启用管理助手或群绑定时，助手电脑不可用（控制面没配 manager、控制面没挂 `assistant-homes`、manager 不响应、manager 没挂 `assistant-homes`）会在控制面启动时写一条 `[assistant-computers]` 警告日志；控制台在管理助手和群配置的编辑处（`GET /api/assistant-computers/status`）和「助手电脑」设置页给出原因。
- **群聊助手只读项目工具挂载与空闲切换**：群聊助手仅在助手电脑与 `project-tools` 卷可用时才于 `context.scope.project_tools` 宣告本群可达项目的只读工具路径，并在 `acquire` 时传入活跃工具版本列表（`project_tools`）；`manager/assistant-computers.mjs` 校验目录后按项目隔离只读挂入 `/opt/project-tools/<owner>__<repo>`（若 `project-tools` 卷或单个版本目录缺失，仅跳过对应挂载并记录告警，不中断群聊回合），并将版本集合签名（`projectToolsSignature`）纳入空闲容器复用条件——运行中的回合绝不中断，下一空闲回合自动重建切换新版本。管理助手（控制台与飞书私聊）可通过 `assistant_archive_pack` / `assistant_archive_read` / `assistant_archive_cleanup` 流式导出 `/workspace` 或 `/tmp` 中已验证的文件/目录，经控制面安全校验后发布到目标项目的工具卷；群聊助手不具备工具卷写入权限。
- **预装浏览器与 X11 虚拟桌面**：项目与助手基础镜像统一预装 Chromium（`/usr/local/bin/bot-chromium`）与虚拟桌面包装（`/usr/local/bin/bot-desktop`，封装 `Xvfb`、`openbox`、`xdotool`、`scrot`、`ffmpeg` 等），兼容只读根文件系统与非特权用户，控制面本身不安装浏览器。
