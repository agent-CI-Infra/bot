# Agent 运行时、RoleRun 协议、Harness 与虚拟电脑

本文说明 launchpad 执行层的核心设计：共享 Agent 运行时、版本化 `bot.role-run/1` 协议、多后端 Harness 抽象，以及项目电脑与助手电脑的生命周期管理。

## 1. 共享 Agent 运行时与工具契约（`src/agent/`）

- **统一入口 `runAgent(spec)`**：所有模型循环共享同一执行入口与 `gateway.ts` 模型网关，统一处理：
  - 模型选择快照与请求前实时授权/Key 核验（变更或撤权立即停机，不静默换模型）；
  - 90 秒无 token 超时与暂时性故障自动重试（408/429/5xx/断流最多重试 5 次：1/3/9/27/60 秒）；
  - 多模态请求上限（纯文本 2 MiB、含内联图片 20 MiB，自动缩放与拒图降级恢复，避免会话锁死）；
  - 统一用量记账（`model_requests` 先落账后交付结果，记录当时单价快照与缓存命中 token，支持按 `repository_id` 或 `service_role_id` 归属）。
- **统一工具集与结果预算**：
  - **只读仓库探索（`RepositoryExplorer`）**：`github_read`、`github_search`、`read_job_log`、`download_artifact` 固定 GET 与当前仓库范围，返回前脱敏。任务内由 `github_read_token` 显式连接，流控（`github_rate_limited`）照常抛出，使本次尝试进入条件等待；群聊助手与管理助手没有该工具，经 `executeConnected` 在每次调用前自行连接，连接失败不留下半连接的读取器，流控作为观察返回给模型（bucket、`reset_at`，并说明凭证与权限无误），窗口重置前不再签发新令牌。
  - **受控 GitHub 写入（`github_write`）**：类 REST 接口，按路由映射细粒度资源权限与能力上限，单次调用临时签发最小写权限安装令牌并在发出后立即撤销，支持按 scope+key 去重，**永远拒绝直接写入 `.github/workflows/`，且永远拒绝合并/入队修改 `.github/workflows/` 的 PR**（即使在 `auto_merge_policy=allow_all` 下也须由人类维护者在 GitHub 合入）。
  - **超长结果分页**：超过预算或需折叠的工具输出统一脱敏写入 `tool-results` 卷（24 小时过期），仅向模型返回首尾预览与句柄，通过 `read_tool_result` 或容器内只读 `/results/<id>.utf8` 按需读取；`manager/docker.mjs` 保留默认 4 MiB 单次响应保护上限（允许调用方按需显式传入有限上限，防止异常大响应引发 OOM），`runner/workspace.mjs` 的 `workspace_read` 在超过 1 MiB 时返回首尾预览与可读文件路径（Git 对象落盘到任务 `logs/`，调用方分页接口保持 `complete: false`、`truncated: true` 而不误标完整），并支持 `max_bytes` / `skip_binary` 供验收预检跳过 >256 KiB 文件与二进制。
  - **孤儿笔记卷与已停止容器自愈**：`manager/projects.mjs` 将 `reclaimNotes`、`reclaimStaleNotes` 与项目删除（`delete_notes`）统一到共享安全清理入口 `purgeNotesVolume`：删除 `-notes` 卷前按容器实际 `Mounts` 精准识别仍挂载该卷的本部署已停止孤儿容器，仅清理其对应代次的网络与 `resources` 行（不误伤未挂载 `-notes` 卷的运行中容器或活跃项目行；若有运行中容器仍挂载该卷，则以 `409 notes_volume_in_use` / `503 notes_residue_unclearable` 拒绝，绝不误杀运行中实例）。
  - **全平台角色意见箱工具（`submit_feedback`，`src/feedback/`）**：声明在 `basicTools`（不列入 `NATIVE_CLI_REPLACED_TOOLS`），统一注入全部 6 类执行入口——项目工作角色（`src/roles/run.ts`，覆盖全部 5 种后端 `pi`/`claude_code`/`codex`/`icode`/`workswarm`）、对象 Manager 事件分派（`src/dispatch/manager.ts`）、角色对话（`src/roles/conversation.ts`）、个人管理助手（`src/management/agent.ts`，含 `start_own_task`）、飞书群聊助手（`src/channels/service-session.ts`，含 `start_own_task`）与夜间自动记忆整理（`src/memory/consolidation-engine.ts`，覆盖 project/group/personal 三轨）。工具严格为 append-only 只写（不向任何角色暴露读/列/搜/改/删反馈工具）、非终结且不扩大任何业务或 GitHub 权限；触发限流、超长、幂等重放或写盘保护（`store.disk?.check()`）时仅返回结构化观察文本，绝不中断主任务。除模型提交的结构化字段外，控制面在服务端权威采集完整环境与角色配置快照（launchpad 版本与 `BOT_IMAGE_TAG`、Node/OS、`source_kind`、`untrusted_context`、项目策略摘要、生效系统提示词及 SHA-256、角色完整权限矩阵/预算/提供工具/修订号、模型与 Harness/CLI 版本、Skill 清单与 `skills_read`、执行标识与最近工具摘要），API URL 剔除 userinfo/query/hash 并经脱敏与 `assertSecretFree` 后以明文 `.json.gz` 落盘；全局开关关闭时隐藏该工具。
  - **命令时限与后台进程**：`run_command` 支持 `timeout_seconds`（受 `BOT_COMMAND_TIMEOUT_MAX_SECONDS` 统一封顶）与 `keep_background: true`（自动将日志落盘到 `log_path` 并随任务结束回收进程组）。
  - **命令长度与传输上限**：任务电脑与助手电脑的 `run_command` 共用同一个命令上限，按 UTF-8 计 1 MiB（`runner/command-policy.mjs` 的 `commandLimit`），schema 的 `command` 描述里写明；超限回稳定 code `command_too_long`，带 `limit` 与 `length`，并提示改写成脚本文件。对于超过 64 KiB 的命令，`runner/command.mjs` 与 `runner/background-command.mjs` 自动写入 `TMPDIR` 下私有 `0600` 临时文件并立即 `unlink`，通过只读 fd 经 `/bin/sh /dev/fd/3` 执行（保持 stdin 为 `/dev/null`、零残留文件且不向 shell 参数拼接环境路径），绕开 Linux 单参数 128 KiB（`MAX_ARG_STRLEN`）限制。请求传输经容器内常驻 `runner/daemon.mjs` 的 HTTP/1.1 + WebSocket 私有 UDS（或本地 `runner.mjs --stdin`），`runnerRequestLimit` 提升至 8 MiB；未配置 `BOT_RUNNER_SOCKETS_DIR` 回退 `docker exec` 时，≤ 95 KiB（`legacyExecRequestLimit`）保留 base64url `argv` 兼容旧容器，> 95 KiB 至 8 MiB 自动切换 `AttachStdin` 经 `runner.mjs --stdin` 流式投递；控制面、manager 与 daemon 共用 `requestTooLarge`，超限回稳定 `413 runner_request_too_large`（全链路透传 `limit`、`length` 与 `detail`），不再退化成 `execution_interrupted` 与重启。文件与 Git Pack/Blob 分块统一提升至 1 MiB（`RUNNER_TRANSFER_CHUNK_BYTES`），并在 daemon 侧提供原生二进制流式 `/v1/blobs/:kind/:id` 端点。

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
| `pi`（默认推荐） | 项目/助手容器内（固定版本 Pi SDK） | 嵌入式 Node 会话，会话文件持久化在独立 `cli-state/pi/` 目录；经 `DefaultResourceLoader` 的 `additionalSkillPaths` 原生读取 `/opt/bot-skills/sets/<hash>/bot/skills` 只读 Skill；支持原生工具、SDK 压缩与跨重启会话续接；原生支持 Chat Completions / Responses / Anthropic Messages，模型经统一只读 UDS 透传网关直连控制面，工具/令牌与控制事件经任务邮箱通信。 |
| `claude_code` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | NDJSON 流协议启动受控版本 CLI，开放容器原生终端/文件/子 Agent，经 `--plugin-dir /opt/bot-skills/sets/<hash>/bot` 与 `--setting-sources ''`（`local_config` 为 `user`）原生按需加载只读 Skill 并隔离检出本地配置/hooks/MCP，经 stdio MCP 桥（`runner/mcp-bridge.mjs`）调用平台工具；支持平台模型（仅限 Anthropic Messages，经统一只读 UDS 透传网关转发，不做跨协议转换）与「项目电脑内自行配置」（`model_source: 'local_config'`）两种模式。 |
| `codex` | 项目/助手容器内（`/opt/agent-tools` 只读卷） | 启动 `codex app-server` JSON-RPC 协议，首轮前通过 `skills/extraRoots/set` 挂入 `/opt/bot-skills/sets/<hash>/bot/skills` 并经 `skills/list` + `skills/config/write` 显式禁用检出内自动发现的 repo/cwd Skill（复核失败关闭），同时核验特性开关与唯一 `bot` MCP 服务，运行中实时拦截未授权工具或 `model/rerouted`，支持 `thread/resume` 与 turn 对账；支持平台模型（仅限 Responses，启动时以进程级 `-c model_provider="bot_relay"` 锁定走统一只读 UDS 透传网关，遇到 `modelProviderMismatch` 等确定性配置错误按 `waiting_configuration` 处理）与「项目电脑内自行配置」（`model_source: 'local_config'`）两种模式。 |
| `icode`、`workswarm` | 项目容器任务工作区（`/opt/agent-tools` 只读卷） | ACP v1 stdio。iCode 通过 `agents/launchpad.yaml` 的 `skills.paths` 原生加载只读 Skill 并恒定关闭 `project.skills_enabled` / `auto_load_cwd_agents_skills`；WorkSwarm 因原生工具全禁而继续经受控 MCP `read_skill` 读取；模型请求经控制面统一只读 UDS 透传网关转发（iCode 支持全部三种协议，WorkSwarm 支持 Chat Completions 与 Anthropic Messages），平台工具走回环 HTTP MCP 或 stdio MCP。 |

- **统一只读 Skill 卷与五后端收敛（`skill-store`、`src/roles/skill-store.ts`）**：
  - 控制面独占 `skill-store` 卷可写挂载（`BOT_SKILL_STORE_DIR=/skill-store`，内置 `skills/` 目录亦支持 `BOT_SKILLS_DIR` 环境变量覆盖），在启动各入口（任务角色、事件分派 Manager、管理/群聊服务助手）前将有效 Skill 集合按内容寻址原子物化为单层目录 `sets/<hash>/bot/skills/<slug>/SKILL.md`（同步生成合法 frontmatter 与 `.claude-plugin/plugin.json`，并在 `umask 0077` 下显式赋予 `0755`/`0644` 权限），不再经配置邮箱传正文或落盘至容器可写 HOME（已移除 `runner/session-resources.mjs`）。
  - `manager` 只读挂载 `skill-store` 并按隔离域经 `VolumeOptions: { NoCopy: true, Subpath }` 挂入容器 `/opt/bot-skills`（项目电脑挂 `projects/<repository_id>`，助手电脑挂 `service`，严格拒绝符号链接；首次升级若目录尚未由控制面创建则宽容跳过并在创建后经 `skills_pending` 空闲轮换挂入）。
  - 四个原生加载后端（`pi`、`claude_code`、`codex`、`icode`）在只读挂载就绪且具备文件读取权限时不再重复暴露控制面 `read_skill` 工具（消除双轨重复）；仅在 WorkSwarm、无文件读取权限、冷缓存事件分派懒拉取或无挂载运行环境时保留 `read_skill` 兜底。
  - 非 QA 角色绑定自定义 Skill 包时仍自动叠加受信任基准分支 `.agents/skills/`（高优先级规则覆盖同 slug），非受信任检出（外部 PR / 未合入分支）对所有后端均不自动发现检出自带 Skill。`RunContext` 同步记录 `skill_revisions` 与 `skill_set_hash`，每日保留清理与手动回收在保护运行中 `task_runs` 引用及 24 小时宽限期后清理过期集合，删除项目时同步移除其 `projects/<repository_id>` 目录。
- **独立 Skill 版本库与整目录导入（`skills` / `skill_versions`、`src/roles/skill-library.ts`）**：
  - 控制面 SQLite 维护独立 `skills`（作用域 `builtin` / `project`，来源 `builtin` / `repository` / `console`，ID 形式 `builtin:<slug>`、`repository:<repo_id>:<slug>`、`console:<repo_id>:<slug>`）与不可变 `skill_versions`（单调递增整数 `version` + 基于规范路径/字节摘要/编码/可执行位的 SHA-256 `content_hash` 去重，内容未变不重复出版本）。
  - **内置启动自动登记**：`skillLibraryStorage` 启动扫描 `BOT_SKILLS_DIR`（默认镜像内置 `skills/`）下所有合法 Skill 目录并整目录归档（保留 `references/`、`scripts/`、`assets/` 与可执行位），内容变更时自动新增版本、永不覆写或删除既有版本。
  - **仓库受信任基准分支整目录导入**：支持实时从项目受信任基准分支（`source: 'live'`，取 `policies.base_branch` / 默认分支，拒绝任意 PR/未合入提交 SHA；完整保留 Git 可执行位 `100755` 与白名单受控静态资源）或从验证过的受信任规则缓存（`source: 'cache'`，`trustedCachedRuleFiles`，校验 `rules:trusted_sha:<repo>`；导入 UTF-8 文本快照，落盘至 `skill-store` 时仍按脚本规则赋予 `0755`）整目录导入 `.agents/skills/<name>/**`，记录 `commit`/`branch`/`path`。
  - **控制台版本化编辑与安全边界**：控制台创建/编辑强制校验标准 `SKILL.md` YAML frontmatter（必填合法 `name` 与 `description`）、凭据脱敏与乐观锁（`expected_version`）；全路径统一拒绝符号链接（`120000`）、子模块（`160000`）、路径逃逸、文件/目录前缀冲突（如同时含 `scripts` 与 `scripts/run.sh`）与未知二进制（仅允许有效 UTF-8 文本及白名单受控静态资源如常见图片/PDF/字体），强制单文件 ≤ 512 KiB、单 Skill ≤ 8 MiB 与 ≤ 256 文件。
  - **技能包兼容桥接、内置包、多包绑定与安全迁移（`skills/bundles.json`、`src/roles/builtin-bundles.ts`、`src/roles/skill-migration.ts`）**：
    - 内置技能包统一由 `skills/bundles.json` 声明（`planning`、`ci-gates`、`dev-practices`、`feishu-cards`），取代代码内硬编码默认 Skill 列表与基于 `workflowChanges()` 的隐式 Skill 注入（`pullRequestPermissions` 对 `.github/workflows/` 的 `workflows: write` 令牌边界保持不变）；Manager 事件分派（`src/dispatch/manager.ts`）与任务执行统一读取角色实际绑定的技能包及可信 `.agents/skills/`。
    - `RoleConfiguration.skills` 与 `roles.update` 统一支持最多 32 个技能包，在保留历史 `inline`/`repository`/`builtin` 技能包与只读 `role_snapshots` 兼容的同时支持 `source.type = 'library'`（`items: [{ skill_id, version }]`，单包上限 64 项 / 512 文件 / 16 MiB，展开至 `/opt/bot-skills` 时按原字节写出受控资源与脚本执行位）；每个角色通过 `skill_bundle_refs[]`（向后同步 `skill_bundle_ref = skill_bundle_refs[0] ?? null`）支持绑定多个技能包，包内与跨包同名 slug 的版本/来源冲突统一以 `400 skill_version_conflict` 拒绝。
    - `follows_default` 项目在 `roleConfiguration()` 读取时动态解析最新内置技能版本；自定义项目保存时将内置技能包版本锁定到 `skill_bundle_revisions`，并通过 `detectBuiltinBundleUpgrades` / `classifyProjectBundle` 在控制台提示升级而不静默覆盖。
    - 一次性启动迁移 `migration:1359`（`migrateSkillsToLibraryV3`）保持 `follows_default` 项目、历史 `role_snapshots`、`task_execution_configs` 与历史 `role_config_revisions` 不变；对已自定义项目将旧 `inline`/`repository` 技能包内容迁入项目 `skills`/`skill_versions`（无合规 frontmatter 的旧内联文件补齐默认 `SKILL.md` 并标注 `migrated_needs_review: true`）转为 `library` 包，按需补齐无 ID/slug 冲突的内置技能包及默认角色绑定。删除项目级 Skill 时校验 `expected_version` 且拒绝删除活跃角色配置引用项（`409 skill_in_use`），删除项目时级联清理该项目 `skills` / `skill_versions` 行（不影响内置 Skill）。

- **容器内短期 Git/`gh` 只读凭证（支持单仓与多仓按需签发）**：`pi`、`claude_code`、`codex`、`icode` 和 `workswarm` 均配置 `credential.useHttpPath=true`、`core.hooksPath=/dev/null` 与 `core.fsmonitor=false`，由 `runner/git-credential-bot.mjs`（解析仓库路径）与 `runner/gh-wrapper.mjs`（解析 `-R`/`--repo`、`gh api repos/...`、`gh repo`、`GH_REPO` 或当前仓库 remote）向回环凭证助手按 `(purpose, repository)` 申请并缓存短期只读安装令牌。控制面 `ScopedReadTokens` 实时校验当前会话仓库范围与 GitHub 读权限（`git` 用途仅签发 `contents: read + metadata: read`），对 PAT 仓库明确提示改用 `checkout_repository` 而不泄露长期凭据，全程经 `Redactor` 流式脱敏并在回合结束统一吊销。
- **Claude Code / Codex「项目电脑内自行配置」（`model_source: 'local_config'`）**：
  - `harness_ref.model_source` 规范值为 `'gateway' | 'local_config'`（旧配置 `'subscription'` 自动归一化为 `'local_config'`），与平台模型网关完全正交。
  - 选择 `local_config` 时，控制面不签发 `'model:invoke'` 令牌能力、不注册模型网关会话，且控制面与 `runner/harness-entry.mjs` **不注入**任何平台模型配置（无 `ANTHROPIC_*`、`--model`、`CODEX_RELAY_URL`、`OPENAI_*`、`config.toml` 或 `-c model_provider`），同时保持每次运行独立的 `HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。
  - 启动 CLI 前由 `runner/cli-config.mjs` 仅将 `/workspace/home` 下的白名单文件（Claude Code：`.claude/settings.json`、`.claude/.credentials.json`；Codex：`.codex/config.toml`、`.codex/auth.json`）以 `0600` 权限复制到当前会话目录（Claude Code 传 `--setting-sources user`），运行结束立即删除副本但保留会话 transcript。未检测到任一配置文件时以 `claude_local_config_missing` / `codex_local_config_missing` 失败关闭，绝不回退到平台模型。
  - 管理入口经 `GET/PUT/DELETE /api/environments/:id/cli-config` → `manager` → runner 非 journal 操作（`cli_config_status`/`write`/`delete`）直写 `/workspace/home`，控制面不读取、不落库、不记录日志；写入内容在控制面、manager 与 runner 三处统一限制上限为 32 KiB（超限返回 `400 invalid_cli_config_content`），常驻 daemon 模式下由 manager 经受保护 HTTP 请求头 `x-bot-cli-config-b64` 投递（daemon 显式按 `MAX_CLI_CONFIG_BYTES` 放宽 `maxHeaderSize` 至 64 KiB，确保 32 KiB 满额配置不进入 JSON body、journal 或进程 `argv` 且不触发 HTTP 431；`docker exec` 回退仍走 `BOT_CLI_CONFIG_B64` 环境变量，runner 读取后立即清除）。
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

### 统一只读 UDS 透传模型网关（`src/harness/model-gateway.ts`、`src/harness/model-formats.ts`、`runner/model-relay.mjs`）

所有容器化后端使用平台模型时，统一经控制面透传模型网关访问上游，历史 `direct` 直连轨、`BOT_HARNESS_MODEL_TRANSPORT` 与文件邮箱模型中转（`workspace_agent_model_*`、`workspace_agent_request/reply/progress`、`runner/model-reply.mjs`）已全部移除：

- **只读 UDS 传输与内存态回环桥**：控制面（`src/main.ts`）在独立命名卷 `model-gateway` 上监听 HTTP-over-UDS（`/run/model-gateway/gateway.sock`，权限 `0660`，UID/GID `10001:10001`）；`manager` 将该卷以只读（`:ro`）挂入全部项目电脑与助手电脑（容器无法删除、覆盖或替换套接字）。容器内 `runner/model-relay.mjs` 仅启动一个纯内存的 `127.0.0.1:0` → `/run/model-gateway/gateway.sock` TCP 字节转发桥（`socket.pipe`，零磁盘读写、零 JSON 解析、容器模式路径固定不可覆盖）；本地/进程内测试无 UDS 时由控制面按引用计数自动启停 `127.0.0.1:0` 回环端口。该通道不依赖容器外网，在 `egress=false` 时仍可工作。此时项目电脑接入 Docker internal bridge（`manager/projects.mjs` 创建网络时设置 `Internal: !spec.egress`）。长期 API Key 只驻留控制面。
- **纯透传、零跨协议转换**：网关校验短期运行令牌（`rrt_…` 或 Pi 短时网关令牌）、`lease_epoch`、实时模型授权与累计预算后，严格核对请求端点协议与所绑模型的有效接口协议（`openai-chat-completions`、`openai-responses`、`anthropic-messages`），不匹配直接返回 `400 model_protocol_mismatch`；仅替换上游目标 URL（保留查询参数）、真实上游鉴权头与 JSON 顶层 `model` 字段（附加输出 token 上限封顶、流式 Chat Completions 补齐 `stream_options.include_usage: true`、WorkSwarm 可信 `allowedTools` 工具过滤，以及边界安全的流式密钥脱敏）。上游响应字节流原样透传回下游，同时由旁路解析器（`PassthroughTap`）无侵入提取 `usage`、`text_delta` 与轨迹摘要写入统一 `model_requests` 账本；下游断开、任务取消或令牌撤销时立即中断上游请求。
- **协议兼容矩阵前置强校验**：角色保存、运行预览（`resolveRole`）与启动前统一核对后端声明的支持协议（`pi` / `icode` 支持全部三种协议，`codex` 仅 `openai-responses`，`claude_code` 仅 `anthropic-messages`，`workswarm` 支持 `openai-chat-completions` 与 `anthropic-messages`），不兼容立即返回 `harness_model_api_unsupported` 或进入 `waiting_configuration`。

### Pi 会话邮箱与事件驱动唤醒（`src/agent/pi.ts`、`runner/agent.mjs`、`runner/mailbox-watch.mjs`）

控制面和容器里的 Pi 进程通过任务目录 `agent/` 下的文件邮箱处理工具调用、短期只读令牌、回合边界与 harness 事件，由 manager 经容器内常驻 `runner/daemon.mjs` 的私有 UDS 通道直接进程内分发（零 `docker exec` 冷启动）；**模型请求不再走文件邮箱**，而是由容器内 Pi SDK 直接经内存态回环桥走控制面统一 UDS 透传网关（原生适配三种接口协议，并在网关钩子内完成请求体/图片大小上限拦截、实时授权、预算/最大请求数收尾、流式 `text_delta` 推送与轨迹入库）。

- **启动**：配置按 1 MiB（`RUNNER_TRANSFER_CHUNK_BYTES`）分块写入（2 MiB 上限下仅需 1–2 次调用），最后一块同时带 `start` 和角色固定的 Pi 版本。runner 先核对版本，不符时什么也不写、不启动，控制面报 `harness_version_mismatch`；版本相符时清理上一进程的邮箱、写入配置并启动，答复里带上实际运行时。工作卷写满时，runner 把带 `start` 的最后一块当作启动拒绝，答复 `disk_full`（`runner/disk.mjs`），什么也不清理、不写、不启动，任务进入等待环境，与单独的 `workspace_agent_start` 一致；只存配置的其他分块照常写入。旧 runner 不认识 `start`，答复里没有运行时，控制面按原流程再查运行时、再启动。续接（`workspace_agent_continue`）和重新附着的会话没有配置可带，仍先单独查运行时。
- **inotify 事件唤醒长轮询与 WS 推送**：控制面每次轮询带 `wait_ms`（Pi 3 s，其他容器 Harness 1 s）、事件 offset 与已在处理的请求 id。常驻 `runner/daemon.mjs` 通过 `runner/mailbox-watch.mjs` 对 `<task>/agent`、`tool-requests/`、`token-requests/` 挂载引用计数的 Linux `fs.watch`（inotify）监听，并同时支持 WebSocket `mailbox.watch` 实时推送；新事件、回合边界或工具/令牌请求落盘时即时唤醒等待中的轮询（无事件时以低频兜底复查并等满 `wait_ms`），消除高频 25–50 ms 空轮询开销。已在处理的工具和令牌请求只返回 id。
- **轮询节奏**：答复带 `long_poll: true` 时控制面立即发下一次轮询。旧 runner 或测试替身会立即答复、不带这个标记，控制面仍隔 500 ms 再轮询。等待期间会话被取消、网关发生致命配置/鉴权故障或后台工作失败，控制面立即结束等待并丢弃这次答复。每次轮询前控制面都检查任务状态（用户停止、权限变化），间隔不超过约 3 s，远低于 manager 的 90 s 执行超时。

### 服务助手回合（`src/harness/service-session.ts`）

管理助手和群聊助手的每一轮都由 `serviceHarnessTurn` 在会话归属的助手电脑上运行，会话绑定保存在 `service_harness_sessions`；控制面里没有服务助手自己的工具循环。独立任务（`start_own_task`，`src/service-roles/own-tasks.ts`）同样经宿主的 `run` 在同一后端上另开会话。声明了 `steered_turns` 的后端（生产中只有 Pi）按对话语义运行一轮（调用方传入 `ServiceTurnControl`，其他后端忽略它，改为得到 `finish` 工具）：

- **回答文字**：Pi 用普通文字作答，不提供 `finish` 工具。模型流式响应在控制面统一透传网关的旁路解析器中逐段提取 `text_delta` 并实时转给 `ServiceTurnControl.text`（子 Agent 请求携带 `x-bot-subagent: 1` 头跳过主回答流式输出）；Pi SDK 自身的自动重试（`model_retry`）仍写入事件流供控制面同步。
- **回合中的新消息**：会话启动前取到的消息随配置（`steer`）在提示词之后作为单独的用户消息发出；此后在每批工具调用结束的回合边界（runner 的 `finishTurn` → `boundary('turn')`）取新消息并 `session.steer()`。最终回答之后不再并入。模型输出文字时暂停并入，带工具调用的响应结束后恢复。
- **编辑后重启**：回合边界、每次经控制面的工具调用和会话结束时比较来源版本。版本变了就结束当前会话：旧版本下经控制面的工具调用不执行，答复不采用（Pi 自带的 `read`/`edit`/`write`/`bash` 直接在助手电脑上运行，不经这道检查）；清空会话绑定，用重建的上下文开新会话，已并入的消息重新提供。跨轮续接的会话在来源版本变化后也不再续接。
- **保持安静**：允许安静的轮次里，`stay_silent` 是会话的结束工具；被拒绝（例如 `reply_required`）时作为观察返回模型，回合继续。
- **工具被拒**：经控制面的工具返回 400/403/404/409/413/415 时，错误作为观察交回模型，回合继续；被拒的调用不执行。401 和内部失败结束本轮。
- **执行进度**（#1296）：`ServiceTurnControl.progress` 接收会话自己的进度。`serviceHarnessTurn` 把 Pi 的 harness 事件（`src/roles/harness.ts` 经 `onHarnessEvent` 转出的原生工具 `tool` 开始/结束、runner 仅为服务回合写的 `model_start` 与 `compaction`，以及 `image_recovery`）交给 `serviceProgressReader`（`src/harness/service-progress.ts`），再加上编辑后重启的提示。进度只带有界字段：命令首行或路径（≤160 字符）、耗时（runner 的 `duration_ms`，旧 runner 取控制面看到开始的时间）、bash 的退出码和输出末尾（≤5 行、≤300 字符）；这些文本经回合与部署的已知值（含编码形式）、令牌格式规则（`publicText`）和按名称识别的命令行凭据规则清洗。调用方用 `ProgressBudget` 限频：每轮先允许 30 步，之后每 2 秒 1 步，每轮最多 300 步；工具开始被放行时它的结束一定写入，被跳过的调用计数后作为一条提示写出。进度读取或写入出错不影响回合。
- **邮箱清理**：新会话写入配置时，runner 清除上一进程没答复的工具与令牌请求，新会话不会把它们当成自己的请求。

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

`workswarm` 复用 ACP 会话与控制面统一只读 UDS 透传模型网关，启动独立的 AgentServer 与 Gateway 并探测两个回环 WebSocket。每次运行提供独立 HOME、数据目录和三个回环端口。配套服务退出、取消、超时和租约失效由 ACP 运行回收逻辑处理。runner 核对 ACP 版本和产品版本。WorkSwarm 不支持 `session/load`，恢复时标记 `rebuilt_from_task_records`。

WorkSwarm 的 ACP 桥不接受客户端注入的 HTTP MCP。runner 用 WorkSwarm 自己的 `mcp.servers` 注册受运行令牌保护的回环 MCP。WorkSwarm 在独立目录启动，禁用钩子，通过平台工具读写任务检出和执行命令。runner 准备工作目录时跳过上游配置模板合并，核对默认拒绝和平台 MCP 工具许可表后才启动配套服务。控制面透传模型网关在请求入口按可信 `allowedTools` 仅放行许可的任务工具，任务邮箱再次按角色权限检查。ACP 会话声明无人可交互。Gateway 自带调度器仍启动，平台不创建定时任务或配置 WorkSwarm 自带消息渠道。

#### iCode

`icode` 注册为独立后端，复用 ACP 会话和工具转发。控制面读取选定的离线包清单，runner 在项目电脑内启动 `icode acp --approval bypass`，并核对握手版本与 HTTP MCP、会话关闭能力。每次运行写入独立 HOME 及最小配置，API 样式遵循平台选定模型，凭据字段保留运行令牌占位。仓库设置、钩子、自带 MCP 与 `cwd` 自动 Skill 扫描均关闭；可信仓库与角色 Skill 统一由控制面物化到只读 `/opt/bot-skills` 卷并经 `agents/launchpad.yaml` 的 `skills.paths` 原生加载，不可信检出仅使用平台提供的基准分支指令与只读 Skill。角色权限决定是否开放原生文件读取、写入、命令和 Skill 脚本。

会话状态由 `CHRYS_SESSION_ROOT_DIR` 写入角色实例持久目录。恢复在相同工作目录用 `session/load`，依上游工作目录校验和任务记录决定恢复或重建。iCode 的 `_chrys/request_input` 按问题即时用英文告知模型无人可答，请根据任务自行判断，并设置五秒超时。结束先发 `session/close`，取消、超时或失去租约时也走有时限的会话关闭。runner 用运行实例标识回收脱离进程组的后台 Shell，并移除该次 HOME。

#### 产品清单与安装

工具卷 `acp/<id>/<版本>/manifest.json` 记录产品来源、哈希和启动方式 `launch`，`acp/<id>/selected` 指向选定版本；`runner/acp-products.mjs` 的 `readAcpProduct` 校验清单并按产品核对平台固定的发行版本。iCode 从官方离线包只解出可执行文件；WorkSwarm 从固定提交的 `pyproject.toml`、`uv.lock` 和 wheel 用 uv 构建虚拟环境（`runner/acp-install-worker.mjs` 的 `buildWorkSwarmProduct`，常规由 manager 的隔离容器执行）。`scripts/install-acp-product.mjs` 只接受这两个产品，通用 Python 产品的 `--preset` 安装和 `hash-source` 已随 `container_acp` 删除（#1339）。管理员操作见 [iCode 与 WorkSwarm 说明与离线安装兜底](../features/deployment-and-operations.md#icode-与-workswarm-说明与离线安装兜底)。

`launch` 包含 `args`、`mcp`（`http` 或 `stdio`）、`access`、`untrustedCheckout`、`env`、`answers` 和 `sidecars`。在 `args` 与 `env` 中可使用 `{product}`、`{workspace}`、`{state}`、`{run}`、`{access}` 及模型变量。`{product}` 指向已校验的源码目录。`answers` 把私有 JSON-RPC 方法映射为即时返回值。每个配套进程声明 `name`、`args` 和 `healthPath`，用 `{port:名称}` 获取端口，自身的 `{state}`、`HOME` 和临时目录按运行隔离。

`access: full` 要求当前角色具有文件写入和命令权限。使用 `access: native` 的产品须把 `{access}` 中的约束落实到产品的文件与命令配置。产品只有在能禁用不可信检出中的本地指令、钩子和 MCP 配置时才声明 `untrustedCheckout: true`。可信仓库指令由平台按现有规则提供。

安装器核验后写入来源和哈希，再原子切换选定记录。已开始的运行保持原版本绑定。

## 4. 虚拟电脑生命周期、统一 Runner 网络协议与自动预编译镜像引擎（`manager/`、`runner/`）

项目电脑和助手电脑共用 `manager/computer-resources.mjs` 中的资源值校验、单容器宿主机内存上限计算和保守回退值，并通过统一常驻 Runner 守护进程通信。各自的生命周期与并发准入仍由对应的电脑管理器负责。

### 常驻 Runner 守护进程与统一 HTTP/WS 线协议（`runner/daemon.mjs`、`runner/wire-protocol.mjs`、`manager/runner-client.mjs`）

- **常驻进程内分发（零 `docker exec` 冷启动）**：所有项目电脑与助手电脑以 `node /opt/runner/daemon.mjs` 作为主进程常驻运行（取代原空转 `runner/idle.mjs`，后者保留兼容转发）。`daemon.mjs` 将既有 `runner/` 操作通过共享 ESM 模块 `runner/executor.mjs` 在进程内直接分发，不再为每次命令、文件、Git 或邮箱轮询冷启动 Node 子进程；`runner/runner.mjs` 保留薄 CLI 封装并支持 `--stdin`（供 `LocalManager` 与测试直接投递最高 8 MiB 请求，彻底脱离 `argv` 上限）。
- **每容器私有 UDS 传输与可选受控 TCP 端点**：
  - `docker/compose.yaml` 新增独立命名卷 `runner-sockets`（仅挂载至 `manager:/run/bot-runner`，`bot`/`webhook`/`tunnel` 均不挂载）。`manager` 为每个容器分配独立子路径 `/run/bot-runner/<sha256(name)[0..24]>`（启动前为 `0770` GID `10001`，daemon 应答健康检查后收为 `0750`，此后只有 manager 能增删其中的条目），仅将该子路径以 `VolumeOptions: { NoCopy: true, Subpath }` 挂入容器 `/run/bot-runner`，实现容器间隔离、对非 `manager` 服务不可见且不暴露宿主机端口（容器内代码与 `daemon.mjs` 共享 UID/GID `10001`，业务权限与凭据边界仍由控制面强制执行）。
  - 每次容器启动前，`manager` 清理遗留套接字并写入一次性 256-bit 随机 Bearer 令牌至 `.token`（`0640`）；`daemon.mjs` 启动读取后立即 `unlink` `.token`（或读取并清除 `BOT_RUNNER_TOKEN` 环境变量），监听 `/run/bot-runner/runner.sock`（`0660`），并对全部 HTTP 与 WebSocket 请求强制 `timingSafeEqual` 校验 Bearer 令牌（与 `egress=false`、`ReadonlyRootfs: true`、`UID 10001`、`cap_drop: [ALL]` 完全兼容）。
  - 同时支持通过 `BOT_RUNNER_LISTEN` 启用强制鉴权的受控明文 HTTP/WebSocket TCP 端点（`daemon.mjs` 本身不内置 TLS，远程节点部署时须配合外层 TLS 反向代理、SSH 隧道或受控内网隧道使用），为后续远程执行节点（Docker Agent 节点与轻量 SSH 后端，#1379/#1380）复用同一线协议与 `manager/runner-client.mjs` 客户端奠定统一契约。
- **异步流式命令执行与长连接保活**：
  - `POST /v1/commands` 立即持久化 `running` journal 并返回 `202` 与 `operation_id`；`manager/runner-client.mjs` 通过持久 WebSocket（`GET /v1/ws`）订阅 `command.output` 实时增量输出、`command.heartbeat`（默认 5 秒心跳）与 `command.done` 终态，彻底解除长耗时命令的 100 秒网关/代理超时风险。
  - 当 WebSocket 不可用、被反向代理阻断或连接中断时，客户端自动无损降级到有界 HTTP 长轮询（`GET /v1/commands/:id/wait?offset=...&timeout_ms=25000`，单次请求严格 ≤ 25 秒）续读增量输出直至终态；支持 `POST /v1/commands/:id/cancel` 精准回收目标操作进程组。
  - 原生二进制流式接口 `PUT/GET /v1/blobs/:kind/:id`（覆盖 `git_pack`、`workspace_artifact`、`assistant_archive`、`workspace_blob`、`command_output`）支持大对象直接字节流传输，避免 base64 膨胀。其中 manager 侧异步命令路由（`/v1/projects/:id/commands[/:opId/{wait,cancel}]`）与 daemon 侧 `/v1/blobs/*` 端点作为后续远程执行节点与控制面流式消费（#1379/#1380）的前置协议契约先行落地，当前控制面仍通过 `/execute` 无缝经 `RunnerClient` 自动享受 WS/长轮询流式保活。
  - 旧版容器镜像自动由 `provision()` 检测到 `Cmd` 或 `/run/bot-runner` 挂载差异后原地无损升级（保留工作卷与代次）；未配置 `BOT_RUNNER_SOCKETS_DIR` 时 `manager` 自动兼容回退 `docker exec`（≤ 95 KiB 沿用 base64url `argv` 兼容旧容器，> 95 KiB 至 8 MiB 经 `AttachStdin` + `runner.mjs --stdin` 流式投递）。

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

### SSH 主机与任务侧 SSH（#1379）

- **登记**：控制面 `ssh_targets` 保存别名、地址、端口、用户、主机公钥 SHA-256 指纹、认证方式（`key` / `password`）、通路（`direct` / `proxy_jump` / `tunnel`）、允许角色、`allow_untrusted_pr`（默认关）与预留字段 `relay_node`；`ssh_target_projects` 记录全局主机与项目的绑定。全局 SSH 主机池在「全局设置 → SSH 远程主机」（`#/settings/ssh-targets`）集中管理，`GET /api/ssh-targets` 为每条全局记录附带 `bound_projects`（`[{ id, full_name }]`）；项目侧「机器配置」（`#/projects/<id>/machine`）聚焦绑定/解绑全局主机与维护项目专属主机，`GET /api/repositories/:id/ssh-targets` 不返回跨项目 `bound_projects`。私钥与密码用 `SecretBox` 按目标 ID 密封，管理接口只投影配置字段。每台主机一把专用私钥：保存时由私钥算出公钥，同一公钥不能登记到第二台主机（`ssh_key_reused`），只接受未加密的 OpenSSH 或 PEM RSA/EC 私钥。超级管理员的「测试连通性」从控制面直连登记地址，校验指纹后认证一次即断开，不打开会话或转发通道。
- **授权（grant）**：控制面在启动进程的调用上附带本 run 的 SSH 授权：Pi 进程启动（`workspace_agent_config` 最后一片或 `workspace_agent_start`）、Claude Code / Codex 启动（`workspace_harness_start`），以及项目测试命令（`src/tasks/request.ts` 开 PR 前、`src/agent/engine.ts` 集成后与创建 PR 前、`src/tasks/acceptance.ts` 独立 QA 门禁）。已在运行的会话被再次启动或续接（`workspace_agent_continue`）时，同一调用带上新 run 的授权，这时 pid 来自任何任务都能写的 `state.json`，所以 daemon 只把它为同一任务目录（调用中的同一 `workspace_id`）拉起的 agent 进程换到新授权，指向别的任务的 agent 或其他进程都会被拒绝。旧的单执行入口（`src/agent/loop.ts`）没有 run 令牌，授权随任务的 claim 失效。授权包含一次性密钥、项目登记的全部别名和本 run 可用的目标 ID。可用目标在 run 开始时一次算定：角色在 `allowed_roles` 中，且检出可信（`HarnessAccess.trustedCheckout`；测试命令用 `taskCheckoutContext`）或目标开了 `allow_untrusted_pr`，跳板链上每一跳也须可用。授权不进入任务操作记录、manager 账本、轨迹和操作哈希；manager 只经 daemon 套接字转发，一次性 `docker exec` 通道直接丢弃。
- **电脑内配置**：manager 把 `ssh_config` 与各目标公钥写入该电脑的 runner 目录（容器内 `/run/bot-runner`），镜像在 `/etc/ssh/ssh_config.d/` 引入（OpenSSH 读 passwd 家目录而非 `$HOME`）。每个登记别名有一个 `Match originalhost <alias> exec "ssh-gate check"` 块；检查不通过时落到同名 `Host` 块，其 `ProxyCommand` 在 stderr 打印 `ssh_target_denied` 并以非 0 退出，不发起连接。配置不含 `Host *`，`git@github.com` 等其他主机照常。主机公钥只由 `KnownHostsCommand` 按登记指纹放行（`StrictHostKeyChecking yes`，不读写 known_hosts 文件）。daemon 就绪后 manager 把 runner 目录收为 `0750`，容器内进程不能替换 `runner.sock`、`ssh-agent.sock` 或配置。
- **调用者身份**：项目电脑上的任务共用 UID `10001`，环境变量和套接字名称都不能证明归属，`run_token` 不进入任务环境。daemon 在一个 `ssh-agent.sock`（`0660`）上提供 OpenSSH agent 协议和检查、取密、隧道三个扩展，连上套接字本身不授权。daemon 用 `SO_PEERCRED`（经 `python3` 读取）取得调用者 PID 并核对其进程组，只认两类：daemon 拉起时同步登记的进程组（命令的 shell 以 `detached` 拉起即组长），以及已登记 agent 进程（Pi、Harness 入口）的直接子进程作为组长的进程组（Pi 的 `run_command` 与原生 bash）。每次请求都核对组长 PID 与 `/proc` starttime；用 `setsid` 离开所在组的进程、其他 run 的进程都被拒绝。命令结束即注销其进程组。
- **签名**：`SIGN_REQUEST` 只标识密钥。daemon 只向该进程组列出获准目标的公钥，签名请求连同目标 ID 交给控制面；控制面复核授权仍有效（Pi / Harness 以 run 令牌和租约为准，测试命令以任务 claim 为准）、目标仍对项目可见且身份未变、角色与可信条件仍满足，再解封私钥签名。签名授权是密钥级别，能登录哪些主机由该密钥在远端的授权决定，这是每台主机一把专用密钥的原因。
- **口令**：只有 run 可用口令目标时才设置 `SSH_ASKPASS=/opt/runner/ssh-askpass.mjs` 与 `SSH_ASKPASS_REQUIRE=force`。daemon 只在 helper 的父进程是镜像的 `/usr/bin/ssh`（device 与 inode 一致）、两者同属已授权进程组、提示串中的 `user@host` 恰好对应该 run 的一个口令目标时，才从控制面取回口令，写给 helper 的 stdout；对不上或同时对上多台时 stdout 不写任何字节。按 OpenSSH `readpass.c` 的管道交接，helper 与当次 `ssh` 会短暂持有明文。口令不写文件、环境变量、argv、日志、轨迹或审计；命令输出与轨迹经 `configuredRedactor()` 按字面量脱敏，跨分片保持，短于 8 个字符也照样脱敏，因此登记时口令至少 4 个字符，避免一两个字符的口令把项目里的普通文本一起抹掉。`configuredRedactor()` 按项目分别缓存已解封的字面量。已授权进程组仍能借自定义 `ssh` 选项把口令交给别处，这是口令认证的固有风险，只限获准该目标的 run。
- **通路**：`direct` 与 `proxy_jump` 由容器内 OpenSSH 直接连接（`egress: false` 时项目电脑在 Docker internal bridge 上，见 `manager/projects.mjs` 的 `Internal: !spec.egress`），跳板必须是该 run 获准的登记目标。`tunnel` 的 `ProxyCommand` 只带目标 ID，daemon 与控制面都忽略调用方附带的地址，控制面只连接库中登记的 host:port，不提供 HTTP CONNECT、SOCKS 或任意端口转发；每个 run 同时 16 条、每台电脑 32 条，空闲 10 分钟、最长 2 小时。`relay_node` 为经计算节点中转（#1380）预留，设置后隧道返回 `ssh_relay_unavailable`。
- **撤销边界**：run 结束、取消或撤权（改角色、解绑、删除，或改地址、指纹、通路、密钥）后，新的签名、取密和隧道都失败；控制面关闭授权时同时关闭其隧道，run 先于授权失效时由巡检在 30 秒内关闭。已完成握手的 `direct` / `proxy_jump` 连接由容器直接持有，不承诺中断。签名、取密、隧道的成功与拒绝写入审计（`ssh_target.*`，只含目标 ID）。
- **限制**：本地执行（`BOT_LOCAL_EXECUTION`）没有常驻 daemon，任务侧 SSH 不可用。远端计算节点（#1380）上，授权随执行请求经节点驱动交给同一套 `Projects`，检查、签名与取密经节点的 `gateway.sock` 中转到控制面；节点的网关套接字尚不中转 HTTP Upgrade，`tunnel` 通路在远端节点上返回 `ssh_broker_unavailable`。Claude Code / Codex 若在 CLI 进程下另起新进程组执行命令，这些进程组不在授权范围。同 UID 进程之间不能互相读取内存依赖宿主机 Yama `ptrace_scope ≥ 1`。登记的指纹应对应 OpenSSH 默认协商的主机密钥类型。
