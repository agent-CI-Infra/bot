# 统一管理服务与管理对话

顶部「管理对话」进入整页管理助手（`#/management`），刷新或分享地址仍打开该页；从项目页点击时选中该项目。项目设置里的「管理对话」仍在当前页面唤起悬浮窗口并选中该项目。打开管理范围按「页内显式选择（项目页带来的项目，或本页下拉里选的项目/组织）> 顶部项目切换器所选项目 > 全部有权项目」决定，`全部项目` 即全部有权项目；浏览器里以前存下的管理范围不再决定打开范围，页内临时选择标注为覆盖、只在本次打开期间有效。窗口顶部始终显示管理范围及其来源，支持全部有权项目、组织和单项目作用域。整页与悬浮窗口共用会话、输入草稿及正在运行的请求，切换展示方式不会重新发送消息。离开整页时助手收回入口，再唤起可继续对话；悬浮状态切页不改范围，收起后有新回复时入口会提示。手机（767px 及以下）没有悬浮入口：底栏「助手」就是唯一入口，收起后焦点回到它，处理中与未读状态也显示在它上面，打开的仍是同一个助手实例与同一条会话。退出登录会移除窗口并清理本次草稿。旧的项目 `/management` 链接仍在项目旁唤起窗口。

悬浮窗口左上角可拖动调节宽高，也可聚焦该手柄后用方向键微调；大小记在当前用户的浏览器里，并随视口限制在可见范围内。「全屏」覆盖整个可见区域，「退出全屏」或 Escape 恢复原来的展示方式和悬浮尺寸；悬浮时再按 Escape 收起。整页中的「悬浮窗口」返回此前页面并继续同一会话；直接打开或刷新整页后，默认返回项目列表。

窗口以连续对话为主，发送后立即显示处理状态与耗时。助手回答按实际模型流逐步显示，查询和修改操作以可展开的执行步骤呈现，区分进行中、已完成、失败和结果待确认；回执与请求参数可展开核对。中间说明与最终回答分别保留，停止或失败时保留已经收到的内容，服务重启中断也会明确标注。助手可以用 `send_message` 发送阶段消息（每轮最多 10 条，每并入一条新消息再多 1 条，见[服务角色](service-roles.md#阶段消息与一轮回答的结束)），它们以「进展消息 N」单独标注、按顺序显示在最终回答之前，不算执行步骤；从飞书私聊发起时同时发到私聊。工具进展只反映实际调用，不以模型文字推断操作成功。

回答支持 Markdown 标题、列表、代码块、引用、表格、任务清单和链接，并可复制原始 Markdown。渲染使用随服务提供的 Marked 与 DOMPurify，限制为文档标签，移除脚本、事件属性、危险协议及自动加载的图片；外部链接在新标签打开。新消息默认跟随底部，向上翻阅后暂停跟随，可用「回到最新消息」返回。断线时直接提供「重新连接」，只续读事件，不重发请求；处理中可以继续写下一条草稿。

「新建会话」位于顶部，「会话记录」可切换持久会话。「快捷操作」集中放置查询、Manager 章节表单、任务管理及定时计划，执行配置或任务命令后返回对话查看结果。Ctrl / ⌘ + Enter 发送，Escape 收起；收起和重新连接不会重复提交命令。

查询、显式表单和自然语言工具调用使用 `ManagementService`。「角色」页的 Manager 配置、项目策略、角色配置与 Task 操作也进入相同命令服务。ActorContext 由服务端的 `resolveActor` 创建；可信 IM 适配器可使用身份模块解析后的 actor，不能反序列化客户端 actor 或自行授予权限。

飞书个人私聊与控制台使用同一管理 Agent 和工具目录。问候和跨项目概览不要求选择项目，按真实查询结果使用项目名称，需要目标而存在歧义时自然追问。模型和用量属于服务角色「管理助手」（`management-assistant`），在「全局设置 → 服务角色」配置，不取账户可读的第一个项目，也不会改用项目的模型；管理助手没有配置模型时直接提示到控制台配置，详见 [服务角色](service-roles.md)。当前授权下最近 20 轮用户请求与回答用于续接，每条较早的回答最多取 4000 字，整段历史超过 96 KiB 时从最早的一轮开始略去并注明略去轮数；写入前重新查询事实和版本。一轮回答不限步数，在模型不再调用工具、用户停止或授权被撤回时结束；助手可以在同一步里对多个项目各发一个查询，数量不设上限；调用了未提供的工具、参数不是 JSON 或不符合格式时，结果作为这次调用的观察交还模型改正，不让整轮对话失败；权限拒绝、版本冲突等其他失败仍结束本轮，并按原因显示。工具结果的预算和省略规则见 [Agent 运行时](agent-runtime.md)。飞书群聊由绑定到群的服务角色回答，权限和项目范围在控制台为每个群单独设置，见 [消息渠道](message-channels.md#群聊助手绑定)。飞书应用机器人已接入相同服务，安装、双端身份证明、群范围和渠道回执的使用方式见 [消息渠道与飞书应用机器人](message-channels.md)。

## 查询与命令契约

`POST /api/management/query` 接受 `{ operation, target, arguments }`。目录与 JSON Schema 见 `src/management/catalog.ts`；`get_capabilities` 返回当前作用域和可用注册项。分页使用 `offset`、`limit`，Task run、事件与角色记录中的 offset 对应返回的 `next_after`。

查询包括 `list_projects`、`list_tasks`、`get_task`、`get_effective_config`、`get_usage`、`list_audit`、`search_knowledge`。`get_task` 可选 detail、logs、runs、events、roles 或 source。日志与原始证据保留来源引用，原始来源展开额外要求 `knowledge.read`；知识记录不能从 trace 前缀绕过 ACL。读取只使用现有 Task、run、日志和模型用量表，不创建业务任务。

`POST /api/management/commands` 的必填字段：

| 字段 | 含义 |
| --- | --- |
| `operation` | 目录中的确定性业务操作 |
| `target` | `project_id`，以及适用的 `task_id`；`workflow.update` 的 `workflow_id` 是工作类型 id |
| `arguments` | 此操作的闭合 Schema 业务参数 |
| `expected_revision` | 最近一次查询返回的版本摘要 |
| `idempotency_key` | 操作者范围内唯一的请求标识 |
| `source_conversation` / `source_message` | 原始会话与消息引用 |

命令包括 `project.update`、`manager.update`（Manager 提示词、工作类型的开关和写入、事件开关）、`workflow.update`（兼容旧名称：改一个工作类型的章节、开关或写入）、`roles.update`、`task.create`、`task.pause`、`task.cancel`、`task.retry`、`task.instructions`、`task.contract`、`task.adopt-config` 和扩展注册入口。模型只有 query / command 工具，以及管理助手自己的独立任务工具（`start_own_task`、`continue_own_task`、`list_own_tasks`，见[服务角色](service-roles.md#独立任务)），不能指定 actor、tenant、capabilities、SQL、后台地址或控制面 shell。模型调用的来源和幂等键由会话服务生成。

命令回执包含操作者、渠道、目标、参数、修改前后版本、状态和结果。`GET /api/management/commands/:id` 回读；重复键和相同参数返回原回执，参数变化返回 `idempotency_conflict`。版本冲突返回 `management_revision_conflict`，客户端必须重读并重新形成修改，不能覆盖新配置。配置回执提供 diff 和重新绑定当前版本后可提交的回滚参数。

实际执行重新检查账号、授权 revision、项目状态、安装范围、凭据。待执行期间安装、执行账号或组织策略变化会停止原命令。金额只做用量统计，不拦截管理命令、任务或对话；已知费用按币种展示，未计价请求单独计数。

## 提示词的三种含义

Manager 或角色默认行为只影响之后的分派和新建任务。可用的模型选择、工作类型的写入和 RoleDefinitionV2 配置在任务创建时保存，首次读取的规则/Skill 也固定在 `task_execution_configs` 与既有 run 快照中。模型凭据密封保存，不进入公开快照；凭据撤销、权限、停用、资源上限和模型版本仍实时检查。

当前任务补充指令用 `task.instructions` 追加历史，后续步骤读取，不改写旧 run、目标或验收条件。改变正在使用的执行配置时先 `task.pause`，等待旧执行释放检查点，再 `task.adopt-config`；同一 task /角色实例采用新配置 revision，保留旧 run 引用，清除旧候选和验收。新配置 revision 也参与候选身份计算，旧验收不能匹配新候选。

RoleDefinitionV2 的显式角色 apply 仍在安全检查点结束旧 run，并在同一实例上以新 snapshot_id、config_revision 和 role_revision 续接；后续默认设置变更不会覆盖该实例已显式采用的版本。Pi prepare、环境释放和实时角色权限检查保持在原角色执行路径中。

改变目标、范围或验收条件必须显式 `task.contract`，增加 contract revision 并清除旧候选和验收；已经发布成果的合同禁止原地修改。`task.create` 必须有目标、范围、验收条件和交付终点，进入普通 Task 调度、统一交付和独立 QA。

## 生效来源与配置 PR

`get_effective_config` 返回 builtin / console / repository 的来源和版本。默认分支 `.bot` 文件高于控制台：只改控制台时，回执为 `console_overridden`、`effective:false`，界面明确显示实际行为尚未改变。

`configuration.pr` 只允许受限 `.bot` Markdown 规则与 Skill 路径，使用已有 GitHub App installation token，不接受个人写 Token。必须先刷新默认分支规则来源；默认分支变化后要求重新读取。创建 PR 返回 `pending_merge` 和链接，合入并刷新来源之前不宣称生效。分支和 PR 使用持久命令 ID 对账；任何未知外部响应都进入 `unknown`，`POST /api/management/commands/:id/resume` 先查原 PR，未查到仍保留未知状态，绝不盲目重复创建。

## 会话、停止和执行

`/api/management/conversations` 创建与列出本人会话，scope 为 `platform`、`tenant:<tenant id>` 或 `project:<project id>`，其中 platform 仅表示全部当前有权项目：会话若已选定组织或项目，就是该范围内有权的项目，而不是拒绝（403）。项目管理员可以在自己已启动的项目上使用管理对话；还没有已启动项目时创建会话会得到 403 `scope_forbidden`，界面应说明原因并给出重试，而不是一直转圈。会话由 principal、tenant 和 scope 隔离；授权修订后隐藏旧权限下的消息，范围撤回后旧会话不可访问。

`POST /conversations/:id/messages` 接受一个自然语言 content、结构化 query 或 command，以及唯一 `source_message`。消息先持久化再运行，重复消息不会再次执行。`GET /conversations/:id/events?after=<sequence>&stream=1` 输出 NDJSON；重连只读事件。阶段消息是 `message` 事件，数据为 `{text,sequence,remaining}`；最终回答仍是 `reply` 事件。`POST /conversations/:id/messages/:message/stop` 停止后续模型/工具调用，已提交命令保留回执。重启将未完成消息标记为 interrupted，不能自动重放外部写入。

授权范围内的命令直接执行，没有审批或人工确认步骤：一个人或服务角色能做什么，都在控制台的授权和角色权限里配置好。旧版本的组织审批策略 `management_policies.approval_operations` 不再读取；升级时仍在等待审批的命令标记为失败（`approval_retired`），不会执行，需要时重新发起。以前的审批记录和“已拒绝”回执保留可查。日志、引用文本和模型回复都不能授权操作。

管理会话有新内容时才显示「回到最新消息」。阅读旧记录、选中回复文字或在输入框起草下一条消息时，新内容不会把记录区自动滚到底；明确点击该按钮后才回到最新位置。正在选中的回答暂缓 Markdown 重绘，避免流式回复替换节点后丢失选区；取消选区后补齐内容并保留阅读位置。停止生成、收起窗口和取消已提交业务操作仍按各自的原语义处理。

## 扩展与验证

`ManagementService.register` 为配置发布、知识修订、计划和通知提供可信 execute / reconcile 注册接口。`knowledgeSearch` 是受限检索接入点。计划和通知由 [持久化调度模块](schedules.md) 注册，表单和管理工具走同一服务；未注册的业务工作流处理器明确不支持。知识模块未注册时返回明确不可用。角色配置沿用 RoleDefinitionV2 接口与版本检查；Pi prepare、角色快照和显式 revision 续接与项目主控共用现有实现。

`e2e/management-live.spec.mjs` 通过真实模型 SSE 和管理事件流验证完成前渲染、工具进展、多轮文本、Markdown 安全边界、停止、失败、重连、滚动及历史回读。阶段消息（事件流、10 条上限、私聊送达）和不限步数由 `test/channel-stage-messages.test.mjs` 与 `e2e/stage-messages.spec.mjs` 覆盖。`test/management.test.mjs` 覆盖权限、并发、幂等、配置来源、直接执行（旧审批策略不再生效、遗留待审批命令不执行）、未知结果、停止和会话隔离；`e2e/management.spec.mjs` 使用独立 SQLite、随机监听端口和本地模型协议夹具验证真实持久化查询、配置修改、任务管理及浏览器/API 一致性。全部临时产物应放在工作树 `.tmp/`，运行测试时设置 `TMPDIR` 为该目录。
