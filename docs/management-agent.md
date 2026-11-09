# 统一管理服务与管理对话

管理控制台的「管理助手」是登录后始终可唤起的悬浮聊天窗口。项目页顶部的「管理对话」和项目设置里的「管理对话」会选中该项目；右下角入口保持当前管理范围。窗口顶部始终显示管理范围，支持全部有权项目、组织和单项目作用域。切换页面不会重建窗口或悄悄切换范围，收起会保留会话、输入草稿及正在运行的请求，有新回复时入口会提示。退出登录会移除窗口并清理本次草稿。旧的 `#/management` 和项目 `/management` 链接仍可唤起窗口。

窗口以对话为主，按消息列出用户请求、助手回复和可展开的事实与命令回执；「会话记录」可以切换或新建持久会话。「快捷操作」集中放置查询、工作流表单、任务管理及定时计划，执行配置或任务命令后返回对话查看结果。Ctrl / ⌘ + Enter 发送，Escape 收起；收起和重新连接不会重复提交命令。工作流助手保留独立的草稿对话，打开任一助手会收起另一窗口。工作流助手打开时隐藏右下角管理入口，避免遮挡页头或被拖动的助手；仍可通过顶部「管理对话」切回管理窗口，收起工作流助手后入口恢复。

查询、显式表单和自然语言工具调用使用 `ManagementService`。已有工作流编辑、项目策略、角色配置与 Task 操作也进入相同命令服务。ActorContext 由服务端的 `resolveActor` 创建；可信 IM 适配器可使用身份模块解析后的 actor，不能反序列化客户端 actor 或自行授予权限。

飞书应用机器人已接入相同服务，安装、双端身份证明、群范围和渠道回执的使用方式见 [消息渠道与飞书应用机器人](message-channels.md)。

## 查询与命令契约

`POST /api/management/query` 接受 `{ operation, target, arguments }`。目录与 JSON Schema 见 `src/management/catalog.ts`；`get_capabilities` 返回当前作用域和可用注册项。分页使用 `offset`、`limit`，Task run、事件与角色记录中的 offset 对应返回的 `next_after`。

查询包括 `list_projects`、`list_tasks`、`get_task`、`get_effective_config`、`get_usage`、`list_audit`、`search_knowledge`。`get_task` 可选 detail、logs、runs、events、roles 或 source。日志与原始证据保留来源引用，原始来源展开额外要求 `knowledge.read`；知识记录不能从 trace 前缀绕过 ACL。读取只使用现有 Task、run、日志和模型用量表，不创建业务任务。

`POST /api/management/commands` 的必填字段：

| 字段 | 含义 |
| --- | --- |
| `operation` | 目录中的确定性业务操作 |
| `target` | `project_id`，以及适用的 `task_id` / `workflow_id` |
| `arguments` | 此操作的闭合 Schema 业务参数 |
| `expected_revision` | 最近一次查询返回的版本摘要 |
| `idempotency_key` | 操作者范围内唯一的请求标识 |
| `source_conversation` / `source_message` | 原始会话与消息引用 |

命令包括 `project.update`、`workflow.update`、`roles.update`、`task.create`、`task.pause`、`task.cancel`、`task.retry`、`task.instructions`、`task.contract`、`task.adopt-config` 和扩展注册入口。模型只有 query / command 工具，不能指定 actor、tenant、capabilities、SQL、后台地址或控制面 shell。模型调用的来源和幂等键由会话服务生成。

命令回执包含操作者、渠道、目标、参数、修改前后版本、状态和结果。`GET /api/management/commands/:id` 回读；重复键和相同参数返回原回执，参数变化返回 `idempotency_conflict`。版本冲突返回 `management_revision_conflict`，客户端必须重读并重新形成修改，不能覆盖新配置。配置回执提供 diff 和重新绑定当前版本后可提交的回滚参数。

实际执行重新检查账号、授权 revision、项目状态、安装范围、凭据和预算。待执行期间安装、执行账号或组织策略变化会停止原命令。配置查询不受执行预算限制。预算来自受信任控制面配置表 `management_budgets`；未配置表示不限额，有限预算遇到缺少价格的用量时停止并要求对账，不把未知成本当成零。

## 提示词的三种含义

工作流或角色默认行为只影响之后新建的任务。可用的模型选择、工作流和 RoleDefinitionV2 配置在任务创建时保存，首次读取的规则/Skill 也固定在 `task_execution_configs` 与既有 run 快照中。模型凭据密封保存，不进入公开快照；凭据撤销、权限、停用、预算和模型版本仍实时检查。

当前任务补充指令用 `task.instructions` 追加历史，后续步骤读取，不改写旧 run、目标或验收条件。改变正在使用的执行配置时先 `task.pause`，等待旧执行释放检查点，再 `task.adopt-config`；同一 task /角色实例采用新配置 revision，保留旧 run 引用，清除旧候选和验收。新配置 revision 也参与候选身份计算，旧验收不能匹配新候选。

RoleDefinitionV2 的显式角色 apply 仍在安全检查点结束旧 run，并在同一实例上以新 snapshot_id、config_revision 和 role_revision 续接；后续默认设置变更不会覆盖该实例已显式采用的版本。Pi prepare、环境释放和实时角色权限检查保持在原角色执行路径中。

改变目标、范围或验收条件必须显式 `task.contract`，增加 contract revision 并清除旧候选和验收；已经发布成果的合同禁止原地修改。`task.create` 必须有目标、范围、验收条件和交付终点，进入普通 Task 调度、统一交付和独立 QA。

## 生效来源与配置 PR

`get_effective_config` 返回 builtin / console / repository 的来源和版本。默认分支 `.bot` 文件高于控制台：只改控制台时，回执为 `console_overridden`、`effective:false`，界面明确显示实际行为尚未改变。

`configuration.pr` 只允许受限 `.bot` Markdown 规则与 Skill 路径，使用已有 GitHub App installation token，不接受个人写 Token。必须先刷新默认分支规则来源；默认分支变化后要求重新读取。创建 PR 返回 `pending_merge` 和链接，合入并刷新来源之前不宣称生效。分支和 PR 使用持久命令 ID 对账；任何未知外部响应都进入 `unknown`，`POST /api/management/commands/:id/resume` 先查原 PR，未查到仍保留未知状态，绝不盲目重复创建。

## 会话、停止和审批

`/api/management/conversations` 创建与列出本人会话，scope 为 `platform`、`tenant:<tenant id>` 或 `project:<project id>`，其中 platform 仅表示全部当前有权项目。会话由 principal、tenant 和 scope 隔离；授权修订后隐藏旧权限下的消息，范围撤回后旧会话不可访问。

`POST /conversations/:id/messages` 接受一个自然语言 content、结构化 query 或 command，以及唯一 `source_message`。消息先持久化再运行，重复消息不会再次执行。`GET /conversations/:id/events?after=<sequence>&stream=1` 输出 NDJSON；重连只读事件。`POST /conversations/:id/messages/:message/stop` 停止后续模型/工具调用，已提交命令保留回执。重启将未完成消息标记为 interrupted，不能自动重放外部写入。

普通授权操作直接执行。仅受信任组织策略 `management_policies.approval_operations` 指定的操作进入 awaiting_approval。审批绑定参数 hash、目标版本和有效期；批准接口要求 `grants.manage`，执行仍检查原操作者权限，不借用批准者权限。审批接口为 `POST /commands/:id/approval`，参数为 `parameter_hash`、`expected_revision`、`decision`（approve / reject）。日志、引用文本和模型回复不能批准操作。

## 扩展与验证

`ManagementService.register` 为配置发布、知识修订、计划和通知提供可信 execute / reconcile 注册接口。`knowledgeSearch` 是受限检索接入点。计划和通知由 [持久化调度模块](schedules.md) 注册，表单和管理工具走同一服务；未注册的业务工作流处理器明确不支持。知识模块未注册时返回明确不可用。角色配置沿用 RoleDefinitionV2 接口与版本检查；Pi prepare、角色快照和显式 revision 续接与项目主控共用现有实现。

`test/management.test.mjs` 覆盖权限、并发、幂等、配置来源、审批、未知结果、停止和会话隔离；`e2e/management.spec.mjs` 使用独立 SQLite、随机监听端口和本地模型协议夹具验证真实持久化查询、配置修改、任务管理及浏览器/API 一致性。全部临时产物应放在工作树 `.tmp/`，运行测试时设置 `TMPDIR` 为该目录。
