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

安装经过选择的 ACP Agent/桥接到 Bot 运行主机，确保其可通过 stdio 使用 ACP v1 和 MCP HTTP。Bot 使用锁定的 `@agentclientprotocol/sdk@2.1.0`，第一阶段验证 `@agentclientprotocol/codex-acp@2.5.0` 与 Codex CLI `0.167.0`；不在 Bot 内实现 Codex 专用协议。CLI 认证和模型配置由操作人提供，不能假设现有 DeepSeek Chat Completions 配置可驱动 Codex。

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

## 恢复与查询

`role_instances.harness_state` 保留外部 session ID、cwd、Agent 信息、配置哈希及恢复方式；`GET /api/tasks/:id/roles` 返回该状态、现有 assignment 列表、各次角色运行及其快照，不返回密钥或会话全文。

支持 loadSession 时优先恢复原 session，并抑制加载回放；失败/不支持时新建 session，用本轮 task 及证据引用重建。task_runs.recovery_mode 与 session_bound 事件记录实际 new_session/native_resume/rebuilt_from_task_records，QA 始终 fresh_evaluation。role_input 的 external_session_pending 是连接前状态，不是恢复成功证明。Pi 主控的 native_resume 另有来源：只在控制面崩溃、项目电脑里的 Pi 会话仍在运行时接回；会话被取消（harness_cancelled）或已经结束时，下一次运行记为 rebuilt_from_task_records。重建后原会话对话可能不可得，应重新查询已有事实、核对副作用，而非无条件重跑。

## 验证与限制

`test/harness.test.mjs` 使用协议测试替身验证 MCP、持久化恢复、重建、角色隔离、QA 新会话、私有内容过滤、取消、进程退出及未提交结果；`test/roles.test.mjs` 验证现有 Native/Process 与协调/验收边界。真实 Codex 和 OpenToday 证据见 issue #176 验收报告。

第一版不提供完整隔离、权限代理、精确计费、跨 Harness 会话转换、执行中追加输入或自动故障接管；其后的 [RoleRun 协议](role-run.md) 在同一会话之上补充了版本化输入、租约 epoch、运行令牌、任务工具网关、准入、每运行容器、预算和恢复模式，内置驱动仍不声明隔离。ACP permission request 对既有执行授权允许一次（无此选项则取消）；这是现有授权下的轻量运行方式，不是细粒度权限防线。远端 Agent 自有工具也不保证经 Bot 代理；验收以公共任务工具留下的实际证据为准。运行主机必须适合执行受信任的 Agent；不把部署共享 HOME 或管理员凭据作为默认配置。

真实 ACP 最小复核（会实际调用已认证 Agent，不属于默认测试）：先构建并配置 `BOT_ACP_CONFIG`，连续运行两次 `node scripts/acp-smoke.mjs .tmp/acp-smoke`。两个独立驱动进程使用同一数据库，实际经 MCP 读取随机任务事实并校验提交；proof 文件保留 session ID、恢复方式、run 与事实读取次数。恢复还是重建以实际 Agent 能力为准，不预设成功结论。该 probe 不访问 GitHub、不修改产品仓库，不代替 OpenToday 开发 E2E。

## 后端目录与兼容

角色 API 返回统一 `backends` 目录、是否已接入及推荐默认值，角色页可以逐角色选择。原 `harness_ref` 和运行快照字段保留兼容。Native/Process 的消息检查点、ACP 的外部会话绑定及 Pi 的活会话重接分别记录，不把切换后端描述为跨协议恢复原会话。Pi 的 QA 和 Coordinator 直接从本轮固定候选或持久化事实开始，不接回旧评价对话。

Codex App Server、Claude Code、OpenCode 的原生驱动仍由 #171/#170/#172 实现；目录中的待接入状态不是可执行适配器。缺少驱动时配置明确报错，不会换成 Native、Pi 或 ACP 冒充执行。已部署的通用 Codex ACP 可继续选择 ACP 使用。
