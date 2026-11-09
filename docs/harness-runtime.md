# Harness Runtime（第一阶段）

Role 服务选择执行器并组装角色说明、assignment 和任务事实引用；Harness 负责会话连接与执行，不负责组队、验收或发布。定义/持续会话/本轮执行分别映射现有 Harness 注册、role_instances、task_runs；没有第二套任务系统。

## 公共边界

真实 Claude Code 工作角色使用独立的 `claude_code` 驱动，锁定版本、受限网关、工具与恢复约束见 [Claude Code harness](claude-code.md)。它复用下述会话与 RoleRun 生命周期，不改变主控、验收和发布边界。

`roleHarness(id).createSession(spec, services)` 创建公共会话；原 adapter 入口保留为兼容包装，实际执行也经过该会话。`HarnessSession<T>` 提供 `id / run / cancel / close`。第一版 handle 绑定一次运行的输入和资源；持续上下文保存在 role instance，下一轮可重新连接，不要求进程常驻。Native 使用原工具循环，Process 使用原 Node worker，ACP 使用通用协议客户端；都经过公共生命周期及结果/错误事件。任务取消沿用 task guard；ACP 在等待远端期间也检查 guard 并发送 cancel，有限等待后回收自己的进程组。

- Role/Manager：选择角色、assignment、人设、记忆入口与 Harness；Review 反馈通过持久化引用回到同一 Dev。
- 任务工具：外部 ACP 经本轮 loopback MCP HTTP 服务调用与内置路径相同的 offered tools、execute、finish validators。只有本轮工具可用，提交后不再执行后续工具操作。
- 工作区：仓库仍在现有项目电脑；ACP cwd 是每个 role instance 的本地会话目录，不是仓库。角色使用 MCP read_file/write_file/run_command 访问当前角色工作区，保持现有 Dev writer/观察角色固定候选方式。不宣称 ACP cwd 或提示词是 OS sandbox。
- Trace：tool_started/tool_observation 与公开 Harness 事件写入现有 task_history，关联实际 run/role/assignment；协议 tool call ID 保留。忽略 thought chunk、think 工具及其后续更新，不留存私有推理。外部执行器的模型网关明细不可获取时为 unknown，不能记为 Native 的模型请求或伪造零费用。
- QA/Publisher：执行器正常结束不代表任务验收通过。角色结果继续校验，QA 使用干净上下文；发布和合入复用原服务。

## 启用 ACP

安装经过选择的 ACP Agent/桥接到 Bot 运行主机，确保其可通过 stdio 使用 ACP v1 和 MCP HTTP。Bot 使用锁定的 `@agentclientprotocol/sdk@2.1.0`，第一阶段验证 `@agentclientprotocol/codex-acp@2.5.0` 与 Codex CLI `0.167.0`。这条 ACP 路径不含 Codex 专用协议；直接驱动 `codex app-server` 见下一节，它是同一客户端的第二种协议方言。CLI 认证和模型配置由操作人提供，不能假设现有 DeepSeek Chat Completions 配置可驱动 Codex。

设置 `BOT_ACP_CONFIG=/absolute/path/acp.json`，文件由部署操作人维护，不作为任务或项目 API 的任意可执行输入：

```json
{
  "command": "/opt/acp/bin/agent",
  "args": [],
  "env": {"HOME": "/data/acp-home"},
  "stateDirectory": "/data/acp-sessions",
  "version": "operator-pinned-agent-version",
  "timeoutMs": 1200000
}
```

`env` 是显式附加环境；默认只传 PATH、LANG、TMPDIR，不继承控制面的模型或 GitHub 凭据。配置自身可能包含认证环境，须按部署凭据保护，不入仓。可选 `model` 用 ACP session/set_config_option（model）设置，可选 `mode` 用 session/set_mode 设置；省略使用执行器默认值。实际支持依赖 Agent 能力，配置失败如实报错，不静默换模型。

然后用 RoleDefinitionV2 给工作角色选择 ACP（`expected_revision` 取当前 revision，详见 [Role-Pool](role-pool.md)）：

```json
{"expected_revision":3,"enabled":true,"roles":[{"role_id":"dev","harness_ref":{"id":"acp"}},{"role_id":"test","harness_ref":{"id":"acp"}},{"role_id":"reviewer","harness_ref":{"id":"acp"}},{"role_id":"ux","harness_ref":{"id":"acp"}}]}
```

Native、Pi、Process、ACP 作为并列 Agent 后端，均可为主控、工作角色和 QA 配置。新配置对所有角色默认推荐 Pi；显式保存的选择继续保留。ACP 使用相同的受控任务工具和角色结果校验，选择它作为主控不会获得产品执行或发布权限。ACP 使用执行器自带的模型，角色上不能再写 `model_profile_ref`，运行快照里模型来源记为 `external_harness`。第一版只配置一个外部 ACP 启动 profile；将来多个厂商/profile 可复用客户端扩展，不作为本期验收前提。API 可选择已注册执行器，但不修改可信启动文件。V2 配置下新的委派按当前 revision 解析；V2 之前保存的旧格式配置下，已有 role instance 保持最初 Harness 绑定。

## 启用 Codex app-server

Harness `codex` 与 `acp` 是同一个客户端（`src/harness/acp.ts`）：启动配置、自有进程组、task guard、超时、取消后回收、本轮 MCP 任务工具、提交校验和会话绑定都相同，只是线协议换成 `codex app-server` 的 stdio JSON-RPC（`src/harness/app-server.ts`）。协议锁定在 Codex CLI `0.166.0`；`node scripts/codex-protocol-lock.mjs`（先 `npm run build`）用已安装的 CLI 在临时 CODEX_HOME 下重新生成 JSON Schema，比对 CLI 版本和客户端所依赖定义的摘要，并确认每种服务器请求都有明确答复。升级 CLI 时先跑它，摘要变化就要复核客户端后再改锁定值。

安装锁定版本（例如 `npm install -g @openai/codex@0.166.0`），为 Bot 准备专用的 CODEX_HOME（登录状态或受限 API key 只放在这里），设置 `BOT_CODEX_CONFIG=/absolute/path/codex.json`：

```json
{
  "command": "/opt/codex/bin/codex",
  "args": ["app-server"],
  "env": {"CODEX_HOME": "/data/codex-home"},
  "stateDirectory": "/data/codex-sessions",
  "version": "0.166.0",
  "model": "operator-chosen-model",
  "modelProvider": "openai",
  "sandbox": "read-only",
  "timeoutMs": 1200000
}
```

- 启动：`args` 必须启动自己的 stdio `app-server`，不接受 `proxy`、`daemon`、`--listen` 或 socket，不连接其他用户或项目共用的后台服务。`env.CODEX_HOME` 必填且是绝对路径，不能是宿主用户的 `~/.codex`；HOME 默认也指向它。`version`、CLI 在 initialize 中报告的版本和协议锁定版本三者必须一致，app-server 报告的 `codexHome` 也必须是这个目录，否则 `codex_version_unsupported` / `codex_home_unexpected`。
- 握手与 thread：`initialize`（声明不接收 delta 与推理流）→ `initialized` → `thread/start`，或对已绑定的 thread 先核验再 `thread/resume`。角色说明作为 thread 的 `developerInstructions`，本轮唯一的 MCP 服务是 `bot`（本轮 loopback 任务工具）。首个 turn 之前用 `mcpServerStatus/list` 核对：只有 `bot`、已连接、暴露的工具恰好是本轮 offered tools；CODEX_HOME 里另配的 MCP 服务或插件不是平台能力，以 `codex_unauthorized_tool_servers` 拒绝。实际加载的指令来源（`instructionSources`）、model/provider、sandbox 与工具清单记在 `session_bound` 事件里。
- 模型：`model`/`modelProvider` 可选；配置了而 app-server 实际用的不同，以 `codex_model_mismatch` 拒绝；turn 中出现 `model/rerouted` 时中断并以 `codex_model_rerouted` 停止。都不静默换模型或后端。
- turn：`turn/start` 的应答不是完成；只有该 turn 的 `turn/completed` 终结它。`completed` 之后仍要经提交工具校验结果，`interrupted`/`failed` 不算完成（认证失败为 `codex_authentication_failed`），终结前断流为 `codex_connection_lost`。消息按行分片重组（含被切开的多字节字符）；对未知 id 的应答、重复 item、未知通知只记一次 `protocol_anomaly`，不改变结果；格式不符的消息以 `codex_protocol_invalid` 失败。
- 事件：item 开始/完成映射为 `tool`（命令含退出码和截断输出、文件变更含路径与截断 diff、MCP/动态工具只记状态，Bot 工具的完整观察另有 `tool_observation`），公开回复为 `message`，turn 生命周期为 `turn`，用量为 `usage`；都带 threadId、turnId、itemId，并进入该 run 的 RoleRun 事件流。reasoning item 与用户输入不留存。Codex 内置 review 记为 `builtin_review`，不是平台的独立检视或 QA。
- 权限请求（thread 以 `approvalPolicy: on-request` 启动）按角色授权直接答复，不等管理员：`bot` MCP 服务自身的确认表单允许（每次调用仍由控制面复核 offered tool、运行令牌与租约）；本机 shell 命令、文件变更、sandbox 提权一律拒绝（角色只经任务工具操作仓库）；向用户提问不作答；动态工具未注册；客户端不刷新账号令牌；其他 thread 的请求一律拒绝。拒绝记 `capability_denied`（`codex:<method>`）和 `permission` 事件。角色确实缺权限而无法继续时，在提交工具中说明阻塞，由现有流程形成需人处理的缺口。外层挂载、网络与 OS 约束照常生效，CLI sandbox 不是唯一边界。
- 取消：发 `turn/interrupt`，在 `cancelGraceMs`（默认 5 秒）内等待终结回执（`turn` 事件 `interrupt_receipt` 记 `terminal` 或 `timeout`），之后回收进程组；迟到的 `completed` 不能改写已取消的运行。
- 用量：`thread/tokenUsage/updated` 的线程累计值按增量计入（每次一条 `usage`，视为一次未定价请求），累计值与绑定一起保存，恢复后重述的总量不重复计；没有任何用量报告的 turn 记为 unknown。`metered` 预算因此跨恢复、重试累计 Codex 用量；金额无法估算。

Codex 只运行工作角色（writer、observer、evaluator），不能选作 manager 或 coordinator；角色以 `{"harness_ref":{"id":"codex"}}` 选择。

## 恢复与查询

`role_instances.harness_state` 保留外部 session ID、cwd、Agent 信息、配置哈希及恢复方式；`GET /api/tasks/:id/roles` 返回该状态、现有 assignment 列表、各次角色运行及其快照，不返回密钥或会话全文。

Codex 绑定另存协议、thread 的 model/provider、CLI 版本、最近 turn 及其确认状态和线程累计用量。恢复时先核对：配置的 model/provider 与绑定不同则 `codex_resume_incompatible`（还原配置重试，或应用新 revision 以新 thread 重建）；`thread/resume` 返回的 thread 必须是同一 ID、位于这个 role instance 的会话目录、仍是同一 model/provider，否则 `codex_thread_ownership_mismatch` / `codex_resume_incompatible`。上次 turn 没有确认完成时，先用 `thread/turns/list` 读回它的实际状态（`session_bound.reconciled`），并在本轮提示中要求先核对其副作用。本地 thread 丢失（`no rollout found`）时记 `native_resume_failed`，新建 thread 并记为 rebuilt_from_task_records。

ACP 支持 loadSession 时优先恢复原 session，并抑制加载回放；失败/不支持时新建 session，用本轮 task 及证据引用重建。task_runs.recovery_mode 与 session_bound 事件记录实际 new_session/native_resume/rebuilt_from_task_records，QA 始终 fresh_evaluation。role_input 的 external_session_pending 是连接前状态，不是恢复成功证明。Pi 主控的 native_resume 另有来源：只在控制面崩溃、项目电脑里的 Pi 会话仍在运行时接回；会话被取消（harness_cancelled）或已经结束时，下一次运行记为 rebuilt_from_task_records。重建后原会话对话可能不可得，应重新查询已有事实、核对副作用，而非无条件重跑。

## 验证与限制

`test/codex-harness.test.mjs` 用 app-server 协议替身（`test/fixtures/codex-app-server.mjs`，不是 Codex）验证握手顺序、工具核对、分片、重复/未知事件、权限答复、失败/断流/中断与迟到结果、恢复、重建与对账、版本/模型/工具/归属不符和启动配置限制。`test/harness.test.mjs` 使用协议测试替身验证 MCP、持久化恢复、重建、角色隔离、QA 新会话、私有内容过滤、取消、进程退出及未提交结果；`test/roles.test.mjs` 验证现有 Native/Process 与协调/验收边界。真实 Codex 和 OpenToday 证据见 issue #176 验收报告。

第一版不提供完整隔离、权限代理、精确计费、跨 Harness 会话转换、执行中追加输入或自动故障接管；其后的 [RoleRun 协议](role-run.md) 在同一会话之上补充了版本化输入、租约 epoch、运行令牌、任务工具网关、准入、每运行容器、预算和恢复模式，内置驱动仍不声明隔离。Codex 的权限答复见上文。ACP permission request 对既有执行授权允许一次（无此选项则取消）；这是现有授权下的轻量运行方式，不是细粒度权限防线。远端 Agent 自有工具也不保证经 Bot 代理；验收以公共任务工具留下的实际证据为准。运行主机必须适合执行受信任的 Agent；不把部署共享 HOME 或管理员凭据作为默认配置。

真实 ACP 最小复核（会实际调用已认证 Agent，不属于默认测试）：先构建并配置 `BOT_ACP_CONFIG`，连续运行两次 `node scripts/acp-smoke.mjs .tmp/acp-smoke`。两个独立驱动进程使用同一数据库，实际经 MCP 读取随机任务事实并校验提交；proof 文件保留 session ID、恢复方式、run 与事实读取次数。恢复还是重建以实际 Agent 能力为准，不预设成功结论。该 probe 不访问 GitHub、不修改产品仓库，不代替 OpenToday 开发 E2E。

真实 Codex 复核同一脚本：配置 `BOT_CODEX_CONFIG` 后运行 `node scripts/acp-smoke.mjs .tmp/codex-smoke codex`，加 `--cancel-after-turn` 则在 turn 开始后取消任务以观察 `turn/interrupt` 和终结回执。失败的运行也写 proof（错误码、thread 绑定、turn 状态、权限答复）并以 1 退出；没有认证的 CODEX_HOME 会在真实 turn 上以 `codex_authentication_failed` 结束，这能验证握手、thread、工具核对、恢复和取消，但不能代替带模型的任务验收。

## 后端目录与兼容

角色 API 返回统一 `backends` 目录、是否已接入及推荐默认值，角色页可以逐角色选择。原 `harness_ref` 和运行快照字段保留兼容。Native/Process 的消息检查点、ACP 的外部会话绑定及 Pi 的活会话重接分别记录，不把切换后端描述为跨协议恢复原会话。Pi 的 QA 和 Coordinator 直接从本轮固定候选或持久化事实开始，不接回旧评价对话。

Claude Code 已注册为 `claude_code` 工作角色后端，支持 writer、observer、evaluator，不支持 controller，不能用于 manager/coordinator；版本、授权与限制见 [Claude Code harness](claude-code.md)。Codex App Server 已注册为 `codex` 工作角色后端，同样只支持 writer、observer、evaluator，见上文「启用 Codex app-server」。OpenCode 的原生驱动仍待 #172 接入；目录中的待接入状态不是可执行适配器。缺少驱动时配置明确报错，不会换成 Native、Pi 或 ACP 冒充执行。已部署的通用 Codex ACP 仍可选择 ACP 使用。
