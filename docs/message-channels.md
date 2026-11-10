# 消息渠道与飞书应用机器人

飞书与 Web 共用 `ManagementAgent`、`ManagementService`、工具目录、统一授权、版本检查、审批和审计。渠道适配器只证明来源，不能从消息正文、卡片参数、姓名、邮箱、群主身份或飞书管理员身份生成权限。外部身份键包含 provider、连接与 App ID、操作者 tenant_key 和 open_id；安装 tenant_key 独立保存并参与检查。

## 配置与权限

飞书应用连接由全局管理员配置，全系统共用，不绑定 GitHub 组织，未接入 GitHub 项目时也可先连接。已有按组织保存的连接在启动时自动移除组织字段，连接 ID、凭据、个人身份绑定、收发队列和群授权记录保持不变；连接不会为任何人增加项目权限。

升级前应停止写入并备份控制面数据库。启动迁移会移除旧组织字段及操作者企业白名单字段 `actor_tenants`；已有连接同步取消操作者企业限制。若回退到仍使用这些字段的版本，需在停写后恢复迁移前的数据库，不能只切换旧镜像。

全局管理员从「全局设置 → 飞书连接」（`/#/settings/feishu`）进入应用连接向导；个人飞书身份在「身份与权限 → 飞书身份绑定」（`/#/identity/feishu`）中关联。顶部不再单列「消息渠道」，旧 `/#/channels` 地址会跳转到个人绑定入口，GitHub 绑定回调也直接返回该入口。

连接列表优先显示应用名称和安装企业名称，同时保留 App ID、启用状态和接收方式。自建应用自动发现机器人和安装企业时一并保存名称；已有连接或商店应用可点击“刷新应用信息”补齐或更新。名称保存在本地，页面加载不会重复查询飞书。企业名称查询需要应用身份权限 `tenant:tenant:readonly`；商店应用还需先收到有效票据。查询失败或飞书暂未返回名称时保留已缓存的名称，并提示缺失信息或失败原因。仅更新名称不改变配置版本；切换应用或安装企业时清除旧名称，避免显示前一个连接的企业信息。

向导分五步，可从已保存连接继续：

1. **创建应用**：打开飞书开发者后台，开启机器人能力，按应用类型复制默认权限 JSON。两种类型均包含消息收发和卡片创建更新；企业自建另含应用身份权限“获取企业信息”（`tenant:tenant:readonly`），需先发布包含机器人能力与该权限的初始版本、通过必要审核，再保存连接。企业自建可选择 SDK 长连接或 HTTP，商店应用只能使用 HTTP。
2. **应用凭据**：填写 App ID 和 App Secret。机器人 open_id 无需填写；自建应用保存时由服务端用有效凭据自动读取机器人身份和安装 tenant_key，读取失败则不保存改动，需先启用机器人能力并发布初始版本后重试。商店应用另需指定安装 tenant_key，才能换取该企业的访问令牌。两种应用均不限制操作者所属企业，无需填写企业白名单。HTTP 另需 Verification Token 和 Encrypt Key。编辑时空白凭据保留原值，填写其中一项只替换该项。保存时显式选择是否启用连接。
3. **事件与回调**：页面将操作集中为三个编号步骤：配置事件、配置新版卡片回调、保存并前往发布。先在“事件配置”设置接收方式并添加 `im.message.receive_v1`、应用生命周期、群成员变更及商店应用票据事件；再在“回调配置”单独设置接收方式，在“添加回调 → 卡片”选择推荐的新版“卡片回传交互” `card.action.trigger`；最后确认两个页签均已保存，再进入发布步骤。HTTP 在两个页签分别选择发送至开发者服务器，填写本部署公网入口下的同一个回调 URL，并分别通过地址验证；长连接等待连接建立后，在两个页签分别保存“使用长连接接收事件”和“使用长连接接收回调”。旧版“消息卡片回传交互（旧）” `card.action.trigger_v1` 不支持长连接，本系统使用新版回调。
4. **发布与检查**：在飞书发布版本、设置可用范围并完成必要审核，再检查机器人信息；检查自动同步保存机器人身份。商店应用先保存连接配置、接收 app_ticket，再完成此检查，未获取机器人身份时拒绝处理消息和卡片。检查只证明凭据和机器人信息可读，不证明消息或卡片回调已经送达。
5. **绑定与试用**：每位用户完成个人双端绑定，实际发送项目查询并点击返回卡片上的“刷新执行状态”，确认收到更新结果后才完成接入；此页可查看收件、发送状态，批准或撤销群接收范围。卡片点击无响应时，检查“回调配置”的接收方式、新版 `card.action.trigger` 订阅和已发布版本；仅凭据检查或聊天成功不能证明回调可用。

卡片是默认功能。向导的基础权限 JSON 按当前应用类型生成，默认包含以下应用身份权限，个人身份权限为空；获取企业信息仅加入企业自建应用的权限 JSON：

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群内 @ 机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息、发送和更新交互卡片 |
| `cardkit:card:write` | 创建与更新卡片 |
| `im:message.group_msg` | 接收全量群消息并读取机器人可见群历史，属于需审批的敏感权限 |
| `im:message:readonly` | 读取机器人所在会话的可见历史及接收撤回事件 |
| `im:chat.members:bot_access` | 接收机器人进群、移出事件 |
| `im:chat.members:read`、`im:chat:read` | 读取成员和群信息，供群范围复核；具体可用能力仍需接入时验证 |
| `tenant:tenant:readonly` | 企业自建应用自动获取安装 tenant_key；保存连接前需开通并发布生效 |

导入权限不会自动订阅卡片操作回调。新应用和已有应用都必须补齐权限、分别配置事件与回调，再创建并发布新版本。卡片实体权限见[创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)，回调结构见[卡片回传交互](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)。

连接列表、创建、修改、凭据检查、收发诊断及应用配置回执均要求 `platform.manage`，组织管理员不能修改全局应用。项目群映射及其回执要求该项目的 `config.write`，可映射不同 GitHub 组织的项目。消息、卡片和定时通知仍逐次校验操作者或接收者对目标项目的权限及来源；项目组织由目标项目决定。个人页面只读取自己的绑定及全部已启用应用的公开标识，未获项目授权的人也可绑定，不返回应用凭据或安装策略。凭据写入独立密封记录，后台不回显密钥。绑定和结果链接需要稳定的后台地址：使用统一入口，即接入向导验证的公网地址，未验证时使用部署的 `BOT_PUBLIC_ORIGIN`（旧名 `BOT_ADMIN_ORIGIN`）；两者都没有时，使用保存 GitHub 登录配置时的控制台地址。

安装 tenant_key 必须是机器人实际安装的企业，用来匹配事件头，不限制消息发送者或卡片点击者所属企业。企业自建应用首次保存时自动调用[获取企业信息](https://open.feishu.cn/document/server-docs/tenant-v2/tenant/query)，读取 `data.tenant.tenant_key`。该接口需要应用身份权限 `tenant:tenant:readonly`，必须先在飞书开通此权限并发布包含该权限的版本、通过必要审核，再保存连接；仅导入权限但尚未发布仍可能失败。后续编辑沿用已保存的安装企业，切换应用时重新读取。商店应用从应用启用事件或登录授权信息取得对应企业的 tenant_key 后填写。企业名称、`display_id`、App ID 和 `tenant_access_token` 不能代替它。旧 API 客户端仍可显式提供安装 tenant_key；已废弃的 `actor_tenants` 输入兼容接收但不生效，连接读取结果不再包含该字段。

bot 不设操作者企业白名单。飞书侧的应用可用范围、对外共享能力及安装状态决定用户能否接触机器人；收到可信事件后，bot 仍要求个人双端身份绑定和目标项目授权，群数据另受项目—群范围控制。操作者 tenant_key 继续作为外部身份、会话和卡片操作者校验的一部分：不同企业的相同 open_id 不共享绑定或会话，也不能互用卡片。

`GET /api/channels/setup` 返回管理员可见连接及当前入口地址；`POST /api/channels/feishu/probe` 用自建应用的 `{app_id,app_secret}` 临时检查，或用 `{connector_id,expected_revision}` 检查已保存连接。请求仅访问固定的飞书 API，不保存临时凭据、不修改个人身份和授权、不发送测试消息。成功返回机器人名称、open_id、`state:verified` 和 `event_delivery_verified:false`；已保存连接还返回 `revision`、`tenant_name`，企业名称查询失败时另含 `tenant_error` 并保留缓存名称，机器人身份变化时自动更新并递增连接版本。版本变化、鉴权失败和商店应用票据缺失分别返回稳定错误码；保存时获取安装企业失败返回 `channel_tenant_unavailable`，提示开通 `tenant:tenant:readonly` 并发布生效后重试，不保存部分连接或凭据。平台原始错误和访问令牌不返回客户端。

SaaS / 商店应用使用 HTTP 回调 `/hooks/feishu/:connector_id`；企业自建可选择官方 SDK 长连接。HTTP 原始请求体按飞书规则验签，校验五分钟时间窗、Verification Token、App ID 和安装 tenant_key，支持 Encrypt Key 的 AES-256-CBC 解密。长连接由服务端持有应用凭据认证，两种方式复用同一持久收件队列、来源检查和去重。

同一商店 App 可登记多个安装租户，使用其中一个连接的回调 URL；验签后按安装 tenant_key 路由到明确登记且独立信任该签名的连接。v1 `app_ticket` 事件在确认前加密持久化，并按事件时间防止旧票据覆盖新票据；发送走 `app_access_token`、安装租户 `tenant_access_token` 的商店应用流程。尚未收到有效票据时返回 `channel_app_ticket_required`，不尝试用自建应用端点代替。安装租户停用后，同一 App 的其他已登记租户仍可通过该 URL 收件。

订阅 `im.message.receive_v1`、`im.message.recalled_v1`、`im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.disbanded_v1`、`card.action.trigger`、v1 应用票据/卸载/状态变更和群成员增删事件。新增全量群消息及历史读取权限后必须由应用管理员审核、重新发布，不能只修改本地向导。应用生命周期变化先停用受影响连接，需管理员复核后显式重新启用。添加机器人或管理群不授予项目权限。自定义群 webhook 不提供管理入口。

连接配置和群范围写入要求 `expected_revision`（创建为 0），冲突返回 `channel_revision_conflict`。保存返回持久化 `operation_id` 与 `state:succeeded`，可通过 `/api/channels/operations/:id` 回读。连接健康显示启用状态、长连接状态、最近收件时间、稳定错误码、待处理量和发送失败量。停用连接立即阻断新消息、模型后续调用、卡片和发送队列；接收到卸载事件时先持久停用，再确认事件。

## 双端绑定

1. 在飞书私聊发送 `绑定` 或 `/bind`。机器人创建五分钟、一次性的 challenge，并将链接发回发起私聊。
2. 打开链接，使用本地账户或已配置的 GitHub 登录进入平台；已有会话可直接使用。飞书不要求先关联 GitHub，也不依赖 GitHub OAuth 配置。使用当前平台会话时，通过受 CSRF 保护的 `POST /api/channels/bindings/claim` 明确确认绑定目标；绑定链接的 GET 请求只导航，不认领账户。主动选择 GitHub 登录时，使用既有浏览器绑定、S256 PKCE 和单次消费契约，回调为已验证的平台账户生成待确认信息；升级前已发起的 GitHub 回调继续兼容。两种方式都尚未完成飞书绑定，仍须在下一步核对平台账户并回原私聊确认。
3. 后台「身份与权限 → 飞书身份绑定」展示平台账户、飞书 App、安装/操作者租户及 open_id。核对后，复制页面显示的 `确认绑定 <一次性值>` 发回原飞书私聊。
4. 服务端验证同一应用、安装租户、操作者租户、open_id、私聊和线程，再通过身份模块的 `ExternalBindings` 完成持久关联。

只打开链接、只登录平台、转发链接、错误飞书操作者、超时和重复确认均不能完成绑定。已有映射属于其他 principal 时返回 `external_identity_conflict`；撤销的映射仍归原 principal，不能通过重新绑定接管。绑定不写入 `scoped_grants`；没有仓库权限的平台账户也可以关联飞书，但项目查询、卡片和写操作仍按该账户实际有效的授权拒绝。本地账户的显式项目委派与 GitHub 登录后的有效派生授权使用同一套权限检查，登录方式本身不增加权限。

`身份` / `/identity` 查询当前关联状态；`解绑` / `/unbind` 撤销原身份服务中的映射；`重新认证` / `/reauth` 重新走双端证明。个人绑定页面提供步骤说明、待确认身份与指令、刷新状态和解除飞书绑定；撤销后提示重新认证。验证失败使用明确错误码，不打印凭据、OAuth code、challenge 或个人聊天正文到日志和审计。

## 管理会话与结果

私聊与群内 @ 使用相同命令。每条请求显式指定项目，例如 `/project 101 查询任务为什么停止`、`/project 101 修改检视提示词`；不从自然语言猜测写入项目。项目 ID 只是用户选择，服务端仍检查该项目与连接所属租户以及当前操作者授权。

结构化客户端可发送 `/project <id> /query <JSON>` 或 `/project <id> /command <JSON>`，JSON 沿用管理工具 Schema，不能指定 ActorContext、来源、幂等键或管理员身份。命令必须包含从当前查询得到的 `expected_revision`。自然语言使用原管理模型与相同工具；不在飞书 handler 内实现 SQL、Manager 配置或 GitHub 写入。

渠道会话由连接、安装租户、操作者租户、操作者、chat/thread、项目和 principal 共同隔离。群内不同发送者独立建会话。Web 可直接读取相同 `conversation_id`、管理消息、命令 `operation_id`、修改前后版本、状态、差异和审计。发送 `/project <id> /link <conversation_id>` 显式续接本人同一项目的 Web 会话，不自动关联或复制其他聊天。

`queued` 表示只落入渠道队列；`submitted` 表示管理消息已受理。管理消息 `completed` 表示模型/工具回合结束，业务命令必须另看回执的 `succeeded`、`awaiting_approval`、`failed` 或 `unknown`。IM 发送成功只表示送达卡片，不能证明管理/GitHub 操作成功。需要审批时在原管理服务批准；Web 恢复 IM 命令也重新验证持久渠道来源、绑定、连接与群范围。

卡片只携带一次性、不透明刷新引用。点击时重新验证实际点击者、租户、chat、实际已发送的消息、当前授权、绑定、连接、命令版本和十分钟有效期。刷新通过同一发送队列更新原卡片。旧卡片不能触发隐含写入或重新审批。

## 群范围

个人能读私有项目不代表群可以接收。管理员必须为项目与群批准字段和敏感级别，并明确核实群受众；核实最多一小时，任何已订阅的成员增删事件立即使它失效。不能确定群受众或项目归属时拒绝；仓库私有性未知时按私有级别检查。

字段包括 `summary`、`status`、`operation`、`result`。`summary` 是固定安全提示；状态、会话/操作引用和详细结果各按批准字段控制。私有仓库要求 `sensitivity:private`；`result` 可能含项目提示词或任务日志，即使仓库公开也按私有级别检查。未授权群只获得固定拒绝说明和需登录链接，不执行管理查询；只批准摘要的群收到摘要，详细结果发送给已绑定本人私聊。发送和卡片更新在获取应用访问令牌之后、发出内容之前再次检查当前范围。

群映射可在后台撤销；连接、绑定、成员或项目权限变化不会被旧会话、旧卡片、排队回复或待审批命令绕过。后台身份页继续提供统一项目撤权入口。

## 去重、恢复和发送队列

事件按连接与 event_id 持久去重，消息再按 message_id 去重。合法消息不因发送者、类型、是否 @ 或原发送时间而丢弃；HTTP 与 SDK 在同一事务提交 inbox、本地账本、同步发现和必要的安全失效，再返回成功，数据库失败返回失败。记录与业务处理分开：当前个人管理入口只处理新鲜的用户文本、私聊及群内 @；bot、附件、未 @ 和过期消息安静入库，不重放旧命令。原管理入口仍拒绝逆序业务写入。模型和业务执行由独立 worker 执行，慢模型不阻塞回调。

重启不会重放已提交的管理消息：管理服务标记中断，需要查看原会话/回执；尚未提交的收件继续处理。发送 outbox 独立保存 `queued`、`sending`、`retry`、`sent`、`failed`、尝试次数和稳定错误码，网络失败指数退避，使用相同 Feishu uuid 对账重发。连接/身份/范围失效为终止失败。所有发送内容和入站正文密封保存，SDK 原始日志关闭，访问令牌只在服务端调用期间使用。

`ChannelService.enqueue` 是 `NotificationOutbox` 的授权目的地注册入口，返回 `registered`、`sent:false`，不会进入即时回复 worker。用户可以发送 `/project <项目ID> /destination` 登记当前会话；[持久化调度模块](schedules.md) 消费该授权目的地，负责定时日报、事件订阅及可靠发送。登记仍不表示送达，发送前重检当前权限和群范围。

## 本地消息账本与历史同步

`channel_chats` 使用 `provider + app_id + installation_tenant + chat_id` 唯一标识群或私信；连接凭据轮换不创建新记录。它不直接拼接旧 `channel_sessions` 中的个人管理会话。原文和资源引用密封保存于 `channel_messages`，按会话和 message_id 合并实时/历史版本。较旧页面不覆盖较新内容，实时版本优先于同版本历史，撤回 tombstone 不被补读复活；消息变更使本地派生摘要失效。绑定串及可识别凭据在查询中隐藏，附件当前只保留元数据和资源引用，没有下载或解析能力。

机器人入群或首次接触会话时持久建立 `channel_sync_jobs`。入群只发送固定记录说明，不调用业务模型或生成项目授权。同步单页使用官方最大值 50，固定升序和 chat 查询时间上界，持续分页直到 `has_more=false`；没有产品总条数上限。普通对话群的 thread 回复需要单独分页，发现 thread 后建立同一主聊天下的作业。飞书 thread 查询不支持时间范围，因此诊断保留这一限制。每页内容、发现的 thread、游标、完成区间同事务提交；过期租约可恢复，活跃租约不可抢占，重复或循环游标停止并报诊断。

429 遵守 Retry-After，网络错误退避重试，缺权限、不在群、不可见话题等保持受阻状态，不标已同步完成。启动或 SDK 重连补读已完成范围的重叠增量；未完成作业保留原游标继续。撤回事件直接更新本地。官方 SDK 当前未提供通用消息编辑事件，编辑仅在同步读取时按 update_time 合并；管理员可显式全量重新同步，不能承诺编辑均被实时捕获。机器人被移出、群解散或应用停用停止后续同步和受保护发送。

「连接诊断与群范围」下的本地历史页支持消息 ID、时间、关键词、发送者、回复关系与分页。`ChannelLedger` 不持有 HTTP client，页面与 API 查询不触发飞书请求；未命中只代表本地已同步范围没有结果。返回 `sync_state/coverage/gaps`，其中 `visible_range_complete` 只表示本轮遍历了平台返回的可见分页，入群前历史、真实平台可见范围及消息编辑仍显式标为未核验。现阶段历史 API 仅向 `platform.manage` 开放，项目读取权限不自动开放群记录或个人私信。

默认保留策略明确为保留至管理员显式清理，`retention_days=null`；管理员可配置 1–3650 天，由同步维护周期按日清理，也可显式清理指定时间之前的记录。清理同时删除派生摘要并保留 `retained_after` 覆盖边界，旧历史补读不能恢复已清理内容。操作保留审计，客户端不能通过搜索触发清理或同步。

## 验证

`npm ci`、`npm run check`、`npm test` 是基础检查；`test/channels.test.mjs` 覆盖验签/解密、重投、慢模型、双端绑定、群字段范围、会话隔离、审批、撤权、旧卡片、发送重试和重启恢复。`test/channel-setup.test.mjs` 覆盖向导和凭据检查的管理员边界、个人应用范围、敏感信息过滤、异步版本检查及部分凭据更新。

`e2e/channels.spec.mjs` 使用独立 SQLite、随机本地 HTTP 端口、官方事件结构的合法签名样本以及 GitHub/模型/飞书协议夹具验证用户路径。截图和结构化证据保存在 `.tmp/channels-165/`。测试中只使用测试凭据，不调用真实飞书租户，也不接触正在运行的部署。运行 Playwright 时，将 `TMPDIR` 和 `PLAYWRIGHT_BROWSERS_PATH` 设为工作树内目录。

`e2e/feishu-setup.spec.mjs` 经实际页面验证管理员创建/恢复连接、失败提示、版本冲突，以及用户从合法飞书绑定事件开始，经本地平台登录或可选 GitHub OAuth、原私聊确认到查看与解绑的完整路径。本地登录场景不配置 GitHub OAuth，并核对绑定不增加仓库授权。桌面和手机截图保存在 `.tmp/feishu-setup-165/`；同样使用本地协议夹具，不代表已连接真实飞书应用。

`test/channel-ledger.test.mjs` 验证事务回滚、官方 SDK frame 的失败/成功 ACK、数据库重启、全部分页和 thread、过期租约、429、异常游标、撤回合并、敏感信息、本地零回源及保留边界。`e2e/channel-history.spec.mjs` 在桌面和手机验证超过 100 条、跨成员/thread/日期的本地消息分页、搜索、同步诊断和保留配置；均为本地协议夹具，不是飞书或 GitHub 真实集成。

实现依据：[飞书回调验签与解密](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)、[官方 Node SDK](https://github.com/larksuite/node-sdk)、[长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)。实际开通时仍需按应用类型核对权限与可用事件。

历史范围与协议依据：[获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)、[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[撤回消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/recalled)、[机器人进群](https://open.feishu.cn/document/server-docs/im-v1/chat-member-bot/events/added)。历史权限不能保证平台提供全部历史；普通群的根消息与话题回复分页、机器人在群状态、群历史可见设置均影响实际结果。
