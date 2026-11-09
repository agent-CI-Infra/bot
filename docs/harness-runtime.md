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
  "timeoutMs": 1200000
}
```

- 启动：`args` 必须启动自己的 stdio `app-server`，不接受 `proxy`、`daemon`、`--listen` 或 socket，不连接其他用户或项目共用的后台服务。`env.CODEX_HOME` 必填且是绝对路径，不能是宿主用户的 `~/.codex`；HOME 默认也指向它。`version`、CLI 在 initialize 中报告的版本和协议锁定版本三者必须一致，app-server 报告的 `codexHome` 也必须是这个目录，否则 `codex_version_unsupported` / `codex_home_unexpected`。
- 握手与 thread：`initialize`（声明不接收 delta 与推理流）→ `initialized` → `thread/start`，或对已绑定的 thread 先核验再 `thread/resume`。角色说明作为 thread 的 `developerInstructions`，本轮唯一的 MCP 服务是 `bot`（本轮 loopback 任务工具）。首个 turn 之前用 `mcpServerStatus/list` 核对：只有 `bot`、已连接、暴露的工具恰好是本轮 offered tools；CODEX_HOME 里另配的 MCP 服务或插件不是平台能力，以 `codex_unauthorized_tool_servers` 拒绝。实际加载的指令来源（`instructionSources`）、model/provider、sandbox 与工具清单记在 `session_bound` 事件里。
- 内建工具：角色只经本轮任务工具操作仓库。锁定的 0.166.0 在 `on-request` 下会直接执行未提权、未被判为危险的沙箱内命令，不发审批请求，所以只拒绝审批挡不住它。因此 thread 以 `approvalPolicy: on-request`、`sandbox: read-only` 启动（启动配置只接受 `read-only`），配置里关闭 `shell_tool`（同时去掉 `exec_command`/`write_stdin`）、`view_image`、`multi_agent`、`apps`、`plugins`、`goals`、`sleep_tool`，并设 `web_search = disabled`。首个 turn 之前核对 app-server 报告的 sandbox 与审批策略，并用带 threadId 的 `experimentalFeature/list` 读回这些开关，任一未关闭即 `codex_builtin_tools_enabled`，不开始 turn。仍会留下的是 `apply_patch`（read-only 下每次写入都要审批，客户端拒绝）、code mode 的 `exec`（在无文件系统、无网络的 V8 isolate 里只能调用上述工具）、MCP 资源读取（只有 `bot`）、`request_user_input`，以及部分模型族自带、无法关闭的子 agent 工具。运行中一旦出现命令执行、图片读取、网页搜索、未经批准就已应用的文件变更或子 agent，就记 `capability_denied`（`codex:<itemType>`）并立即停止整个运行：任务工具立即拒绝调用，发 `turn/interrupt`，宽限期后回收进程组，以 `codex_builtin_tool_refused` / `codex_subagent_refused` 失败。这是对 Codex 工具面的限制和失败关闭，不是新的操作系统隔离：Codex 仍在控制面主机上运行，声明 `isolation: none`。
- 模型：`model`/`modelProvider` 可选；配置了而 app-server 实际用的不同，以 `codex_model_mismatch` 拒绝；turn 中出现 `model/rerouted` 时按上面的停止路径结束运行，宽限期内即以 `codex_model_rerouted` 失败。都不静默换模型或后端。
- turn：`turn/start` 的应答不是完成；只有该 turn 的 `turn/completed` 终结它。`completed` 之后仍要经提交工具校验结果，`interrupted`/`failed` 不算完成（认证失败为 `codex_authentication_failed`），终结前断流为 `codex_connection_lost`。消息按行分片重组（含被切开的多字节字符）；对未知 id 的应答、重复 item、未知通知只记一次 `protocol_anomaly`，不改变结果；格式不符的消息以 `codex_protocol_invalid` 失败。
- 事件：item 开始/完成映射为 `tool`（被拒停的命令仍记退出码和截断输出、文件变更含路径与截断 diff、MCP/动态工具只记状态，Bot 工具的完整观察另有 `tool_observation`），公开回复为 `message`，turn 生命周期为 `turn`，用量为 `usage`；都带 threadId、turnId、itemId，并进入该 run 的 RoleRun 事件流。reasoning item 与用户输入不留存。Codex 内置 review 记为 `builtin_review`，不是平台的独立检视或 QA。
- 权限请求（thread 以 `approvalPolicy: on-request` 启动）按角色授权直接答复，不等管理员：`bot` MCP 服务自身的确认表单允许（每次调用仍由控制面复核 offered tool、运行令牌与租约）；Codex 仍发来的命令、文件变更、sandbox 提权审批一律拒绝；向用户提问不作答；动态工具未注册；客户端不刷新账号令牌；其他 thread 的请求一律拒绝。拒绝记 `capability_denied`（`codex:<method>`）和 `permission` 事件。角色确实缺权限而无法继续时，在提交工具中说明阻塞，由现有流程形成需人处理的缺口。外层挂载、网络与 OS 约束照常生效，CLI sandbox 不是唯一边界。
- 取消：发 `turn/interrupt`，在 `cancelGraceMs`（默认 5 秒）内等待终结回执（`turn` 事件 `interrupt_receipt` 记 `terminal` 或 `timeout`），之后回收进程组；迟到的 `completed` 不能改写已取消的运行。
- 用量：`thread/tokenUsage/updated` 的线程累计值按增量计入（每次一条 `usage`，视为一次未定价请求），累计值与绑定一起保存，恢复后重述的总量不重复计。会话绑定提交之前收到的用量（例如恢复时重述的总量）随绑定一起提交：会话在绑定前被拒时，这个增量和新的累计游标都不记录，下一次成功绑定时只计一次。已开始而没有任何用量报告的 turn 记为未知请求：它结束时，或它所在的运行结束时仍没有终结回执（断流、中断超时）。服务器没有应答的 turn/start 同样按 turn 计一次：通知里已知 turn id 且已收到该 turn 的用量时只按这些用量计，没有用量或始终不知道 id 时计一次未知。有未知请求时用量语义是下限（`lower_bound`），不是精确的零。`metered` 预算因此跨恢复、重试累计 Codex 用量；金额无法估算。

Codex 只运行工作角色（writer、observer、evaluator），不能选作 manager 或 coordinator；角色以 `{"harness_ref":{"id":"codex"}}` 选择。

## 恢复与查询

`role_instances.harness_state` 保留外部 session ID、cwd、Agent 信息、配置哈希及恢复方式；`GET /api/tasks/:id/roles` 返回该状态、现有 assignment 列表、各次角色运行及其快照，不返回密钥或会话全文。

Codex 绑定另存协议、thread 的 model/provider、CLI 版本、最近 turn 及其确认状态和线程累计用量。恢复时先核对：配置的 model/provider 与绑定不同则 `codex_resume_incompatible`（还原配置后重试；确需换模型时暂停任务并执行 `POST /api/tasks/:id/adopt-config`，按新配置重建角色会话）；`thread/resume` 返回的 thread 必须是同一 ID、位于这个 role instance 的会话目录、仍是同一 model/provider，否则 `codex_thread_ownership_mismatch` / `codex_resume_incompatible`。绑定分开记录两件事：正在跟踪的 turn（`lastTurnId`/`lastTurnStatus`，可能尚未确认）和最后一个确实存在的 turn（`knownTurnId`）。发出 `turn/start` 之前，前者先记为「可能已开始」（`startRequested`），后者不变；应答还没到时，通知里出现的新 turn id（`turn/started` 取 `params.turn.id`，其他通知取 `turnId`）只要不是 `knownTurnId`，就立即以未确认完成的状态写入绑定，取消也对它发 `turn/interrupt`；这只是推测，其他通知猜出的 id 会被随后的 `turn/started` 替换。收到应答后只认应答里的 turn：应答之前到达的终结通知先暂存，只有应答里那个 turn 的终结能结束这次 turn，别的 turn（包括迟到的旧 turn）的终结既不算成功，也不改写绑定；推测的 turn 的终结只作为取消回执，start 始终没有应答时才连同它的终结状态写入绑定。服务器明确拒绝 start 时，绑定恢复成请求前的样子。上次 turn 没有确认完成时，先用 `thread/turns/list` 读回它的实际状态（`session_bound.reconciled`）：已知 id 按 id 核对；只知道「可能已开始」时，线程最新的 turn 若不是 `knownTurnId`，就是这次开始的 turn，否则记为 `not_started`，`knownTurnId` 保持不变，之后迟到的旧 turn 通知不会冒充新 turn。随后在本轮提示中要求先核对其副作用。只有服务器明确回答本地 thread 不存在（`-32600 no rollout found for thread id …`）时才记 `native_resume_failed`，新建 thread 并记为 rebuilt_from_task_records；新 thread 的 model/provider 仍须与绑定一致，否则同样 `codex_resume_incompatible`，不会借重建换模型。其他恢复错误以 `codex_resume_failed` 失败并保留原绑定，问题消失后重试即续接同一 thread。

ACP 支持 loadSession 时优先恢复原 session，并抑制加载回放；失败/不支持时新建 session，用本轮 task 及证据引用重建。task_runs.recovery_mode 与 session_bound 事件记录实际 new_session/native_resume/rebuilt_from_task_records，QA 始终 fresh_evaluation。role_input 的 external_session_pending 是连接前状态，不是恢复成功证明。Pi 主控的 native_resume 另有来源：只在控制面崩溃、项目电脑里的 Pi 会话仍在运行时接回；会话被取消（harness_cancelled）或已经结束时，下一次运行记为 rebuilt_from_task_records。重建后原会话对话可能不可得，应重新查询已有事实、核对副作用，而非无条件重跑。

## 验证与限制

`test/codex-harness.test.mjs` 用 app-server 协议替身（`test/fixtures/codex-app-server.mjs`，不是 Codex）验证握手顺序、工具核对、内建工具关闭与运行中拦截、分片、重复/未知事件、10 种服务器请求的答复、失败/断流/中断与迟到结果、改路由与拦截在宽限期内停止并回收、恢复、仅对缺失 thread 重建且不换模型、对账、无用量 turn 计为未知、绑定前被拒不重复计量、版本/模型/工具/归属不符和启动配置限制。`test/harness.test.mjs` 使用协议测试替身验证 MCP、持久化恢复、重建、角色隔离、QA 新会话、私有内容过滤、取消、进程退出及未提交结果；`test/roles.test.mjs` 验证现有 Native/Process 与协调/验收边界。经 ACP 桥接的真实 Codex 与 OpenToday 证据见 [Issue #176 验收](issue-176-acceptance.md)；直接驱动 `codex app-server` 的真实 CLI 记录与仍未完成的验收项见 [Issue #171 验收](issue-171-acceptance.md)。

第一版不提供完整隔离、权限代理、精确计费、跨 Harness 会话转换、执行中追加输入或自动故障接管；其后的 [RoleRun 协议](role-run.md) 在同一会话之上补充了版本化输入、租约 epoch、运行令牌、任务工具网关、准入、每运行容器、预算和恢复模式，内置驱动仍不声明隔离。Codex 的权限答复见上文。ACP permission request 对既有执行授权允许一次（无此选项则取消）；这是现有授权下的轻量运行方式，不是细粒度权限防线。远端 Agent 自有工具也不保证经 Bot 代理；验收以公共任务工具留下的实际证据为准。运行主机必须适合执行受信任的 Agent；不把部署共享 HOME 或管理员凭据作为默认配置。

真实 ACP 最小复核（会实际调用已认证 Agent，不属于默认测试）：先构建并配置 `BOT_ACP_CONFIG`，连续运行两次 `node scripts/acp-smoke.mjs .tmp/acp-smoke`。两个独立驱动进程使用同一数据库，实际经 MCP 读取随机任务事实并校验提交；proof 文件保留 session ID、恢复方式、run 与事实读取次数。恢复还是重建以实际 Agent 能力为准，不预设成功结论。该 probe 不访问 GitHub、不修改产品仓库，不代替 OpenToday 开发 E2E。

真实 Codex 复核同一脚本：配置 `BOT_CODEX_CONFIG` 后运行 `node scripts/acp-smoke.mjs .tmp/codex-smoke codex`，加 `--cancel-after-turn` 则在 turn 开始后取消任务以观察 `turn/interrupt` 和终结回执。失败的运行也写 proof（错误码、thread 绑定、turn 状态、权限答复）并以 1 退出；没有认证的 CODEX_HOME 会在真实 turn 上以 `codex_authentication_failed` 结束，这能验证握手、thread、工具核对、恢复和取消，但不能代替带模型的任务验收。`node scripts/codex-scripted-probe.mjs .tmp/codex-scripted-probe`（先 `npm run build`）让真实 CLI 对接脚本化的本地 Responses 端点，不用任何凭据：脚本先尝试宿主命令和文件补丁，再经 Bot MCP 读取并提交任务事实，核对 CLI 实际交给模型的工具、命令没有执行、补丁被拒和用量上报。它验证 CLI 与客户端，不代表任何真实模型的行为。

## 后端目录与兼容

角色 API 返回统一 `backends` 目录、是否已接入及推荐默认值，角色页可以逐角色选择。原 `harness_ref` 和运行快照字段保留兼容。Native/Process 的消息检查点、ACP 的外部会话绑定及 Pi 的活会话重接分别记录，不把切换后端描述为跨协议恢复原会话。Pi 的 QA 和 Coordinator 直接从本轮固定候选或持久化事实开始，不接回旧评价对话。

Claude Code 已注册为 `claude_code` 工作角色后端，支持 writer、observer、evaluator，不支持 controller，不能用于 manager/coordinator；版本、授权与限制见 [Claude Code harness](claude-code.md)。Codex App Server 已注册为 `codex` 工作角色后端，同样只支持 writer、observer、evaluator，见上文「启用 Codex app-server」。OpenCode 的原生驱动仍待 #172 接入；目录中的待接入状态不是可执行适配器。缺少驱动时配置明确报错，不会换成 Native、Pi 或 ACP 冒充执行。已部署的通用 Codex ACP 仍可选择 ACP 使用。
