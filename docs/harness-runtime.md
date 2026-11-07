# Harness Runtime（第一阶段）

Role 服务选择执行器并组装角色说明、assignment 和任务事实引用；Harness 负责会话连接与执行，不负责组队、验收或发布。定义/持续会话/本轮执行分别映射现有 Harness 注册、role_instances、task_runs；没有第二套任务系统。

## 公共边界

`HarnessSession<T>` 提供 `id / run / cancel / close`。第一版 handle 绑定一次运行的输入和资源；持续上下文保存在 role instance，下一轮可重新连接，不要求进程常驻。Native 使用原工具循环，Process 使用原 Node worker，ACP 使用通用协议客户端；都经过公共生命周期及结果/错误事件。任务取消沿用 task guard；ACP 在等待远端期间也检查 guard 并发送 cancel，有限等待后回收自己的进程组。

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

然后 `PUT /api/repositories/:repo/roles`：

```json
{"enabled":true,"harnesses":{"dev":"acp","test":"acp","reviewer":"acp","ux":"acp"}}
```

Manager/QA 默认仍为 Native。第一版只配置一个外部 ACP 启动 profile；将来多个厂商/profile 可复用客户端扩展，不作为本期验收前提。API 可选择已注册执行器，但不修改可信启动文件。已有 role instance 保持最初 Harness 绑定，配置修改作用于新实例。

## 恢复与查询

`role_instances.harness_state` 保留外部 session ID、cwd、Agent 信息、配置哈希及恢复方式；`GET /api/tasks/:id/roles` 返回该状态及现有 assignment 列表，不返回密钥或会话全文。

支持 loadSession 时优先恢复原 session，并抑制加载回放；失败/不支持时新建 session，用本轮 task 及证据引用重建。task_runs.recovery_mode 与 session_bound 事件记录实际 new_session/native_resume/rebuilt_from_task_records，QA 始终 fresh_evaluation。role_input 的 external_session_pending 是连接前状态，不是恢复成功证明。重建后原会话对话可能不可得，应重新查询已有事实、核对副作用，而非无条件重跑。

## 验证与限制

`test/harness.test.mjs` 使用协议测试替身验证 MCP、持久化恢复、重建、角色隔离、QA 新会话、私有内容过滤、取消、进程退出及未提交结果；`test/roles.test.mjs` 验证现有 Native/Process 与协调/验收边界。真实 Codex 和 OpenToday 证据见 issue #176 验收报告。

第一版不提供完整隔离、权限代理、精确计费、跨 Harness 会话转换、执行中追加输入或自动故障接管。ACP permission request 对既有执行授权允许一次（无此选项则取消）；这是现有授权下的轻量运行方式，不是细粒度权限防线。远端 Agent 自有工具也不保证经 Bot 代理；验收以公共任务工具留下的实际证据为准。运行主机必须适合执行受信任的 Agent；不把部署共享 HOME 或管理员凭据作为默认配置。
