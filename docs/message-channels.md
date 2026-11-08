# 消息渠道与飞书应用机器人

飞书与 Web 共用 `ManagementAgent`、`ManagementService`、工具目录、统一授权、版本检查、审批和审计。渠道适配器只证明来源，不能从消息正文、卡片参数、姓名、邮箱、群主身份或飞书管理员身份生成权限。外部身份键包含 provider、连接与 App ID、操作者 tenant_key 和 open_id；安装 tenant_key 独立保存并参与检查。

## 配置与权限

在后台「消息渠道」配置项目所属 GitHub 组织、App ID、安装 tenant_key、允许的操作者 tenant_key 和机器人 open_id。组织配置需要当前租户的 `config.write`，项目群映射需要该项目的 `config.write`；项目权限仍由身份服务决定。凭据写入独立密封记录，连接只保存引用；后台不回显密钥。必须配置稳定的 `BOT_ADMIN_ORIGIN`，绑定链接和结果链接才有可信后台地址。

SaaS / 商店应用使用 HTTP 回调 `/hooks/feishu/:connector_id`；企业自建可选择官方 SDK 长连接。HTTP 原始请求体按飞书规则验签，校验五分钟时间窗、Verification Token、App ID 和安装 tenant_key，支持 Encrypt Key 的 AES-256-CBC 解密。长连接由服务端持有应用凭据认证，两种方式复用同一持久收件队列、来源检查和去重。

同一商店 App 可登记多个安装租户，使用其中一个连接的回调 URL；验签后按安装 tenant_key 路由到明确登记且独立信任该签名的连接。v1 `app_ticket` 事件在确认前加密持久化，并按事件时间防止旧票据覆盖新票据；发送走 `app_access_token`、安装租户 `tenant_access_token` 的商店应用流程。尚未收到有效票据时返回 `channel_app_ticket_required`，不尝试用自建应用端点代替。安装租户停用后，同一 App 的其他已登记租户仍可通过该 URL 收件。

只订阅 `im.message.receive_v1`、`card.action.trigger`、v1 应用票据/卸载/状态变更和群成员增删事件，并只申请私聊、群内 @ 机器人消息及发送/更新卡片所需权限。不申请读取全部群消息或群历史的权限。应用生命周期变化先停用受影响连接，需管理员复核后显式重新启用。添加机器人或管理群不授予项目权限。自定义群 webhook 不提供管理入口。

连接配置和群范围写入要求 `expected_revision`（创建为 0），冲突返回 `channel_revision_conflict`。保存返回持久化 `operation_id` 与 `state:succeeded`，可通过 `/api/channels/operations/:id` 回读。连接健康显示启用状态、长连接状态、最近收件时间、稳定错误码、待处理量和发送失败量。停用连接立即阻断新消息、模型后续调用、卡片和发送队列；接收到卸载事件时先持久停用，再确认事件。

## 双端绑定

1. 在飞书私聊发送 `绑定` 或 `/bind`。机器人创建五分钟、一次性的 challenge，并将链接发回发起私聊。
2. 打开链接，在当前浏览器完成 GitHub OAuth。GitHub state 使用既有浏览器绑定、S256 PKCE 和单次消费契约，并关联渠道 challenge。此时尚未绑定飞书。
3. 后台「消息渠道」展示 GitHub 数字身份、飞书 App、安装/操作者租户及 open_id。核对后，将页面显示的 `确认绑定 <一次性值>` 发回原飞书私聊。
4. 服务端验证同一应用、安装租户、操作者租户、open_id、私聊和线程，再通过身份模块的 `ExternalBindings` 完成持久关联。

只打开链接、转发链接、错误浏览器、错误飞书操作者、超时和重复确认均不能完成绑定。已有映射属于其他 principal 时返回 `external_identity_conflict`；撤销的映射仍归原 principal，不能通过重新绑定接管。绑定不写入 `scoped_grants`；没有项目权限的 GitHub 用户也可以关联身份，但管理请求仍被拒绝。

`身份` / `/identity` 查询当前关联状态；`解绑` / `/unbind` 撤销原身份服务中的映射；`重新认证` / `/reauth` 重新走双端证明。后台也可查看和解绑。验证失败使用明确错误码，不打印凭据、OAuth code、challenge 或个人聊天正文到日志和审计。

## 管理会话与结果

私聊与群内 @ 使用相同命令。每条请求显式指定项目，例如 `/project 101 查询任务为什么停止`、`/project 101 修改检视提示词`；不从自然语言猜测写入项目。项目 ID 只是用户选择，服务端仍检查该项目与连接所属租户以及当前操作者授权。

结构化客户端可发送 `/project <id> /query <JSON>` 或 `/project <id> /command <JSON>`，JSON 沿用管理工具 Schema，不能指定 ActorContext、来源、幂等键或管理员身份。命令必须包含从当前查询得到的 `expected_revision`。自然语言使用原管理模型与相同工具；不在飞书 handler 内实现 SQL、工作流或 GitHub 写入。

渠道会话由连接、安装租户、操作者租户、操作者、chat/thread、项目和 principal 共同隔离。群内不同发送者独立建会话。Web 可直接读取相同 `conversation_id`、管理消息、命令 `operation_id`、修改前后版本、状态、差异和审计。发送 `/project <id> /link <conversation_id>` 显式续接本人同一项目的 Web 会话，不自动关联或复制其他聊天。

`queued` 表示只落入渠道队列；`submitted` 表示管理消息已受理。管理消息 `completed` 表示模型/工具回合结束，业务命令必须另看回执的 `succeeded`、`awaiting_approval`、`failed` 或 `unknown`。IM 发送成功只表示送达卡片，不能证明管理/GitHub 操作成功。需要审批时在原管理服务批准；Web 恢复 IM 命令也重新验证持久渠道来源、绑定、连接与群范围。

卡片只携带一次性、不透明刷新引用。点击时重新验证实际点击者、租户、chat、实际已发送的消息、当前授权、绑定、连接、命令版本和十分钟有效期。刷新通过同一发送队列更新原卡片。旧卡片不能触发隐含写入或重新审批。

## 群范围

个人能读私有项目不代表群可以接收。管理员必须为项目与群批准字段和敏感级别，并明确核实群受众；核实最多一小时，任何已订阅的成员增删事件立即使它失效。不能确定群受众或项目归属时拒绝；仓库私有性未知时按私有级别检查。

字段包括 `summary`、`status`、`operation`、`result`。`summary` 是固定安全提示；状态、会话/操作引用和详细结果各按批准字段控制。私有仓库要求 `sensitivity:private`；`result` 可能含项目提示词或任务日志，即使仓库公开也按私有级别检查。未授权群只获得固定拒绝说明和需登录链接，不执行管理查询；只批准摘要的群收到摘要，详细结果发送给已绑定本人私聊。发送和卡片更新在获取应用访问令牌之后、发出内容之前再次检查当前范围。

群映射可在后台撤销；连接、绑定、成员或项目权限变化不会被旧会话、旧卡片、排队回复或待审批命令绕过。后台身份页继续提供统一项目撤权入口。

## 去重、恢复和发送队列

事件按连接与 event_id 持久去重，消息再按 message_id 去重。只接受用户消息并过滤机器人自己、未 @ 的群消息、五分钟前的消息和已处理会话中逆序到达的消息。HTTP 只做验证、持久收件和必要的即时安全失效；模型和业务执行由独立 worker 执行，慢模型不阻塞回调。

重启不会重放已提交的管理消息：管理服务标记中断，需要查看原会话/回执；尚未提交的收件继续处理。发送 outbox 独立保存 `queued`、`sending`、`retry`、`sent`、`failed`、尝试次数和稳定错误码，网络失败指数退避，使用相同 Feishu uuid 对账重发。连接/身份/范围失效为终止失败。所有发送内容和入站正文密封保存，SDK 原始日志关闭，访问令牌只在服务端调用期间使用。

`ChannelService.enqueue` 是 `NotificationOutbox` 的授权目的地注册入口，返回 `registered`、`sent:false`，不会进入即时回复 worker。用户可以发送 `/project <项目ID> /destination` 登记当前会话；[持久化调度模块](schedules.md) 消费该授权目的地，负责定时日报、事件订阅及可靠发送。登记仍不表示送达，发送前重检当前权限和群范围。

## 验证

`npm ci`、`npm run check`、`npm test` 是基础检查；`test/channels.test.mjs` 覆盖验签/解密、重投、慢模型、双端绑定、群字段范围、会话隔离、审批、撤权、旧卡片、发送重试和重启恢复。

`e2e/channels.spec.mjs` 使用独立 SQLite、随机本地 HTTP 端口、官方事件结构的合法签名样本以及 GitHub/模型/飞书协议夹具验证用户路径。截图和结构化证据保存在 `.tmp/channels-165/`。测试中只使用测试凭据，不调用真实飞书租户，也不接触正在运行的部署。运行 Playwright 时，将 `TMPDIR` 和 `PLAYWRIGHT_BROWSERS_PATH` 设为工作树内目录。

实现依据：[飞书回调验签与解密](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)、[官方 Node SDK](https://github.com/larksuite/node-sdk)、[长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)。实际开通时仍需按应用类型核对权限与可用事件。
