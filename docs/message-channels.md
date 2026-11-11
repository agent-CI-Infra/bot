# 消息渠道与飞书应用机器人

飞书与 Web 共用 `ManagementAgent`、`ManagementService`、工具目录、统一授权、版本检查和审计。渠道适配器只证明来源，不能从消息正文、卡片参数、姓名、邮箱、群主身份或飞书管理员身份生成权限。外部身份键包含 provider、连接与 App ID、操作者 tenant_key 和 open_id；安装 tenant_key 独立保存并参与检查。

## 配置与权限

飞书应用连接由全局管理员配置，全系统共用，不绑定 GitHub 组织，未接入 GitHub 项目时也可先连接。已有按组织保存的连接在启动时自动移除组织字段，连接 ID、凭据、个人身份绑定、收发队列和群授权记录保持不变；连接不会为任何人增加项目权限。

升级前应停止写入并备份控制面数据库。启动迁移会移除旧组织字段及操作者企业白名单字段 `actor_tenants`；已有连接同步取消操作者企业限制。若回退到仍使用这些字段的版本，需在停写后恢复迁移前的数据库，不能只切换旧镜像。

全局管理员从「全局设置 → 飞书连接」（`/#/settings/feishu`）进入应用连接向导；个人飞书身份在「身份与权限 → 飞书身份绑定」（`/#/identity/feishu`）中关联。顶部不再单列「消息渠道」，旧 `/#/channels` 地址会跳转到个人绑定入口，GitHub 绑定回调也直接返回该入口。

连接列表优先显示应用名称和安装企业名称，同时保留 App ID、启用状态和接收方式。自建应用自动发现机器人和安装企业时一并保存名称；超级管理员打开连接列表时自动刷新应用信息并检查飞书权限（见下文「权限检查」），也可点击“刷新应用信息与权限”。除机器人接口外，服务端查询[当前应用信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/application/get)，优先使用中文应用名称，避免机器人接口仍返回改名前名称；该查询只接受当前连接的 App ID。缺少权限时提示开通 `admin:app.info:readonly` 并发布，也可使用已有的 `application:application:self_manage` 权限，系统不会自动修改飞书权限。企业名称查询需要应用身份权限 `tenant:tenant:readonly`；商店应用还需先收到有效票据。查询失败或飞书暂未返回名称时保留已缓存的名称，并提示缺失信息或失败原因。仅更新名称不改变配置版本；切换应用或安装企业时清除旧名称，避免显示前一个连接的企业信息。个人绑定页读取缓存，不因普通用户刷新而调用飞书管理接口。

向导分五步，可从已保存连接继续：

1. **创建应用**：打开飞书开发者后台，开启机器人能力，按应用类型复制完整权限 JSON，在飞书「权限管理 → 批量导入/导出」一次导入。两种类型均包含消息收发和卡片创建更新；企业自建另含应用身份权限“获取企业信息”（`tenant:tenant:readonly`），需先发布包含机器人能力与该权限的初始版本、通过必要审核，再保存连接。企业自建可选择 SDK 长连接或 HTTP，商店应用只能使用 HTTP。
2. **应用凭据**：填写 App ID 和 App Secret。机器人 open_id 无需填写；自建应用保存时由服务端用有效凭据自动读取机器人身份和安装 tenant_key，读取失败则不保存改动，需先启用机器人能力并发布初始版本后重试。商店应用另需指定安装 tenant_key，才能换取该企业的访问令牌。两种应用均不限制操作者所属企业，无需填写企业白名单。HTTP 另需 Verification Token 和 Encrypt Key。编辑时空白凭据保留原值，填写其中一项只替换该项。保存时显式选择是否启用连接。
3. **事件与回调**：页面将操作集中为三个编号步骤：配置事件、配置新版卡片回调、保存并前往发布。先在“事件配置”设置接收方式并添加 `im.message.receive_v1`、应用生命周期、群成员变更及商店应用票据事件；再在“回调配置”单独设置接收方式，在“添加回调 → 卡片”选择推荐的新版“卡片回传交互” `card.action.trigger`；最后确认两个页签均已保存，再进入发布步骤。HTTP 在两个页签分别选择发送至开发者服务器，填写本部署公网入口下的同一个回调 URL，并分别通过地址验证；长连接等待连接建立后，在两个页签分别保存“使用长连接接收事件”和“使用长连接接收回调”。旧版“消息卡片回传交互（旧）” `card.action.trigger_v1` 不支持长连接，本系统使用新版回调。
4. **发布与检查**：在飞书发布版本、设置可用范围并完成必要审核，再检查机器人信息；检查自动同步保存机器人身份。商店应用先保存连接配置、接收 app_ticket，再完成此检查，未获取机器人身份时拒绝处理消息和卡片。检查只证明凭据和机器人信息可读，不证明消息或卡片回调已经送达。
5. **绑定与试用**：每位用户完成个人双端绑定，在私聊直接发送“你好”或“我能管理哪些项目”，收到助手回复后才完成接入；此页可查看收件和发送状态。群聊的项目范围不在这里设置，而是在「身份与权限 → 飞书群聊助手」为每个群绑定服务角色和项目范围。结果卡片只带“登录后台查看”链接，不再有回调按钮；较早版本发出的“刷新执行状态”按钮点击后提示已过期。

卡片是默认功能。所需权限只在服务端 `FEISHU_SCOPES`（`src/channels/feishu.ts`）维护一份，经 `GET /api/channels/setup` 的 `feishu_scopes` 下发：向导第 1 步和连接列表里的完整权限 JSON、连接的自动权限检查都由它生成。下表与它逐项一致，`test/channel-setup.test.mjs` 会核对。JSON 按当前应用类型生成，包含以下应用身份权限，个人身份权限为空；获取企业信息和包含机器人消息的权限仅加入企业自建应用的权限 JSON：

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群内 @ 机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息、发送和更新交互卡片 |
| `im:message.reactions:write_only` | 在正在处理的原消息下添加表情，回复送达后删除 |
| `cardkit:card:write` | 创建与更新卡片 |
| `im:message.group_msg` | 接收群内用户消息，并满足群历史读取接口的额外权限要求；不包含其他机器人的实时消息 |
| `im:message.group_msg.include_bot:read` | 企业自建应用接收群内用户及其他机器人的消息，不推送本机器人自己发送的消息；商店应用不申请 |
| `im:message:readonly` | 读取机器人所在会话的可见历史及接收撤回事件 |
| `im:chat.members:bot_access` | 接收机器人进群、移出事件 |
| `im:chat.members:read` | 判断当前 bot 是否在群中并完整分页核验维护人及来源成员；保存群聊助手绑定时必需，缺少时保存返回 `channel_audience_permission_required` |
| `tenant:tenant:readonly` | 企业自建应用自动获取安装 tenant_key；保存连接前需开通并发布生效 |

这两项群消息权限用途不同：根据[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)，`im:message.group_msg` 只推送用户消息，`include_bot:read` 还推送其他机器人消息，且当前仅支持企业自建应用。企业自建连接同时申请两项，因为[获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)仍明确要求 `im:message.group_msg` 与消息读取权限；新增的事件权限不替代历史接口权限。机器人消息安静进入本地记录，后续用户 @ 时可作为上下文，消息来源仍保留为 bot/app；机器人消息本身不触发模型或业务操作。当前机器人的群回复通过本地发送记录保留，不能依赖接收事件回传。

**权限检查**：连接列表每次打开或刷新时，服务端用该连接的应用身份调用飞书[查询租户授权状态](https://open.feishu.cn/api-explorer?project=application&resource=scope&apiName=list&version=v6)（`GET /open-apis/application/v6/scopes`，不需要额外权限），把返回的应用身份权限与上表比对：`grant_status` 为 1 的算已开通，其他状态算已申请但未审核或未发布，用户身份的同名授权不算。全部开通时显示“所需的 N 项均已开通”；有缺少时逐项列出权限和用途，标出已申请待审核的项，并给出两种补齐方式：在飞书「权限管理 → 批量导入/导出」导入完整权限 JSON（已开通的不受影响），或打开飞书权限页 `https://open.feishu.cn/app/<App ID>/auth?q=<缺少的权限>`，一次申请缺少的全部权限。补齐后仍须创建并发布新版本、通过必要审核，再回到连接列表刷新。向导「应用凭据」和「发布与检查」两步的检查也显示同样结果。查询失败时只提示暂时无法自动检查，不影响凭据和机器人检查的结论。

导入权限不会自动订阅卡片操作回调。新应用和已有应用都必须补齐权限、分别配置事件与回调，再创建并发布新版本。卡片实体权限见[创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)，回调结构见[卡片回传交互](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)。

连接列表、创建、修改、凭据检查、收发诊断及应用配置回执均要求 `platform.manage`，组织管理员不能修改全局应用。群聊助手绑定要求配置人对所选仓库（或整个组织）有 `config.write`，可以包含不同 GitHub 组织的仓库。私聊消息和定时通知仍逐次校验操作者或接收者对目标项目的权限及来源；项目组织由目标项目决定。个人页面只读取自己的绑定及全部已启用应用的公开标识，未获项目授权的人也可绑定，不返回应用凭据或安装策略。凭据写入独立密封记录，后台不回显密钥。绑定和结果链接需要稳定的后台地址：使用统一入口，即接入向导验证的公网地址，未验证时使用部署的 `BOT_PUBLIC_ORIGIN`（旧名 `BOT_ADMIN_ORIGIN`）；两者都没有时，使用保存 GitHub 登录配置时的控制台地址。

安装 tenant_key 必须是机器人实际安装的企业，用来匹配事件头，不限制消息发送者或卡片点击者所属企业。企业自建应用首次保存时自动调用[获取企业信息](https://open.feishu.cn/document/server-docs/tenant-v2/tenant/query)，读取 `data.tenant.tenant_key`。该接口需要应用身份权限 `tenant:tenant:readonly`，必须先在飞书开通此权限并发布包含该权限的版本、通过必要审核，再保存连接；仅导入权限但尚未发布仍可能失败。后续编辑沿用已保存的安装企业，切换应用时重新读取。商店应用从应用启用事件或登录授权信息取得对应企业的 tenant_key 后填写。企业名称、`display_id`、App ID 和 `tenant_access_token` 不能代替它。旧 API 客户端仍可显式提供安装 tenant_key；已废弃的 `actor_tenants` 输入兼容接收但不生效，连接读取结果不再包含该字段。

bot 不设操作者企业白名单。飞书侧的应用可用范围、对外共享能力及安装状态决定用户能否接触机器人；收到可信事件后，私聊仍要求个人双端身份绑定和目标项目授权，群聊由控制台为该群设置的群聊助手绑定决定可用范围。操作者 tenant_key 继续作为外部身份和会话校验的一部分：不同企业的相同 open_id 不共享绑定或会话，也不能互用卡片。

`GET /api/channels/setup` 返回管理员可见连接及当前入口地址；`POST /api/channels/feishu/probe` 用自建应用的 `{app_id,app_secret}` 临时检查，或用 `{connector_id,expected_revision}` 检查已保存连接。请求仅访问固定的飞书 API，不保存临时凭据、不修改个人身份和授权、不发送测试消息。成功返回机器人名称、open_id、`state:verified` 和 `event_delivery_verified:false`；已保存连接还返回 `revision`、`tenant_name`，企业名称查询失败时另含 `tenant_error` 并保留缓存名称，机器人身份变化时自动更新并递增连接版本。两种检查都附带权限检查结果 `scopes: {required, missing, pending}`（`missing` 含尚未开通的全部所需权限，`pending` 是其中已申请、待审核或发布的部分）；授权状态读取失败时改为返回 `scope_error: "channel_scope_check_unavailable"`，请求本身仍然成功。版本变化、鉴权失败和商店应用票据缺失分别返回稳定错误码；保存时获取安装企业失败返回 `channel_tenant_unavailable`，提示开通 `tenant:tenant:readonly` 并发布生效后重试，不保存部分连接或凭据。平台原始错误和访问令牌不返回客户端。

SaaS / 商店应用使用 HTTP 回调 `/hooks/feishu/:connector_id`；企业自建可选择官方 SDK 长连接。HTTP 原始请求体按飞书规则验签，校验五分钟时间窗、Verification Token、App ID 和安装 tenant_key，支持 Encrypt Key 的 AES-256-CBC 解密。长连接由服务端持有应用凭据认证，两种方式复用同一持久收件队列、来源检查和去重。

同一商店 App 可登记多个安装租户，使用其中一个连接的回调 URL；验签后按安装 tenant_key 路由到明确登记且独立信任该签名的连接。v1 `app_ticket` 事件在确认前加密持久化，并按事件时间防止旧票据覆盖新票据；发送走 `app_access_token`、安装租户 `tenant_access_token` 的商店应用流程。尚未收到有效票据时返回 `channel_app_ticket_required`，不尝试用自建应用端点代替。安装租户停用后，同一 App 的其他已登记租户仍可通过该 URL 收件。

订阅 `im.message.receive_v1`、`im.message.recalled_v1`、`im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.disbanded_v1`、`card.action.trigger`、v1 应用票据/卸载/状态变更和群成员增删事件。新增全量群消息及历史读取权限后必须由应用管理员审核、重新发布，不能只修改本地向导。应用生命周期变化先停用受影响连接，需管理员复核后显式重新启用。添加机器人或管理群不授予项目权限。自定义群 webhook 不提供管理入口。

连接配置写入要求 `expected_revision`（创建为 0），冲突返回 `channel_revision_conflict`。保存返回持久化 `operation_id` 与 `state:succeeded`，可通过 `/api/channels/operations/:id` 回读。连接健康显示启用状态、长连接状态、最近收件时间、稳定错误码、待处理量和发送失败量。停用连接立即阻断新消息、模型后续调用和发送队列；接收到卸载事件时先持久停用，再确认事件。

## 双端绑定

个人绑定列表默认展示已读取的飞书姓名、机器人名称和机器人所属企业，不以 open_id、App ID 或租户 key 作为用户称呼。飞书姓名尚不可读取时，明确显示“<平台用户名> 的飞书账号”和“关联平台账户”，不将平台用户名当作已核验的飞书姓名；待确认及已解绑记录也使用可读文案。机器人所属企业是应用安装企业，不代表操作者所属企业。

绑定页先展示本地缓存和可读替代信息，再异步读取缺失姓名；普通读取绑定列表不请求飞书。当前账户可通过 `POST /api/channels/bindings/:id/name` 刷新本人的有效绑定姓名。查询使用当前启用连接，仅针对该安装企业内已绑定的用户，复核返回 open_id 和请求对象一致，并在异步请求后重新检查会话、绑定和连接版本。姓名只更新 `display_name`，不改变身份键、验证时间、状态或授权；不返回或保存用户信息接口中的邮箱、电话等其他字段。机器人缺少用户信息读取权限、通讯录可见范围不足或姓名不可用时，仍可使用原绑定和已有姓名。

用户信息来源为[获取单个用户信息](https://open.feishu.cn/document/server-docs/contact-v3/user/get)。[对外共享机器人](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group?lang=zh-CN)不能通过外部用户 ID 查询其通讯录信息，因此外部账号显示关联的平台账户作为替代；此功能不会自动扩大飞书权限或访问其他企业的通讯录。

个人绑定页仅向超级管理员显示应用管理入口。所有用户均能看到已启用应用的企业名称和机器人名称，并通过“打开机器人私聊”链接进入飞书会话；链接使用飞书 AppLink `https://applink.feishu.cn/client/bot/open?appId=<App ID>`，仍由飞书检查应用可用范围。没有已启用连接时提示“请联系超级管理员配置飞书应用”，不展示可提交的绑定表单。

默认使用私聊认证字符串：

1. 在飞书机器人私聊发送 `绑定` 或 `/bind`，机器人返回 `FSB-` 开头、五分钟内有效的一次性认证字符串。
2. 使用本地账户或 GitHub 登录控制台，在「身份与权限 → 飞书身份绑定」选择对应机器人并粘贴字符串，核对当前平台账户后点击“确认绑定到当前账户”。此流程不依赖 GitHub 登录配置，也不要求部署已配置公网入口。
3. 服务端通过受会话和 CSRF 保护的 `POST /api/channels/bindings/confirm` 接收 `{code,connector_id}`，只从可信私聊记录恢复来源，重新检查连接与会话，再通过 `ExternalBindings` 完成关联。超时、重复使用、选择其他应用、来源停用、会话撤销或身份属于其他账户均拒绝；认证字符串不授予项目权限。认证字符串是私聊持有证明，请勿转发给他人，数据库只保存其摘要。

已有绑定链接流程继续可用，其 challenge 与认证字符串分别随机生成。转发旧链接不能代替私聊认证字符串；链接已进入平台认领流程后，仍须回原私聊完成确认：

1. 在飞书私聊发送 `绑定` 或 `/bind`。机器人创建五分钟、一次性的 challenge，并将链接发回发起私聊。
2. 打开链接，使用本地账户或已配置的 GitHub 登录进入平台；已有会话可直接使用。飞书不要求先关联 GitHub，也不依赖 GitHub OAuth 配置。使用当前平台会话时，通过受 CSRF 保护的 `POST /api/channels/bindings/claim` 明确确认绑定目标；绑定链接的 GET 请求只导航，不认领账户。主动选择 GitHub 登录时，使用既有浏览器绑定、S256 PKCE 和单次消费契约，回调为已验证的平台账户生成待确认信息；升级前已发起的 GitHub 回调继续兼容。两种方式都尚未完成飞书绑定，仍须在下一步核对平台账户并回原私聊确认。
3. 后台「身份与权限 → 飞书身份绑定」展示平台账户、飞书 App、安装/操作者租户及 open_id。核对后，复制页面显示的 `确认绑定 <一次性值>` 发回原飞书私聊。
4. 服务端验证同一应用、安装租户、操作者租户、open_id、私聊和线程，再通过身份模块的 `ExternalBindings` 完成持久关联。

只打开链接、只登录平台、转发链接、错误飞书操作者、超时和重复确认均不能完成绑定。已有映射属于其他 principal 时返回 `external_identity_conflict`；撤销的映射仍归原 principal，不能通过重新绑定接管。绑定不写入 `scoped_grants`；没有仓库权限的平台账户也可以关联飞书，但项目查询、卡片和写操作仍按该账户实际有效的授权拒绝。本地账户的显式项目委派与 GitHub 登录后的有效派生授权使用同一套权限检查，登录方式本身不增加权限。

`身份` / `/identity` 查询当前关联状态；`解绑` / `/unbind` 撤销原身份服务中的映射；`重新认证` / `/reauth` 重新走双端证明。个人绑定页面提供步骤说明、待确认身份与指令、刷新状态和解除飞书绑定；撤销后提示重新认证。验证失败使用明确错误码，不打印凭据、OAuth code、challenge 或个人聊天正文到日志和审计。

## 管理会话与结果

私聊和群聊都不需要先选项目，也没有命令写法（#312）。`/project …`（含 `/query`、`/command`、`/link`、`/destination`）和 `/chat` 前缀都不再触发特殊流程，原样作为自然语言交给助手：私聊交给管理助手，按本人当前权限查询和管理；已绑定的群交给群聊助手；未绑定的群在被 @ 时只回复如何绑定，不执行任何管理请求。只有绑定相关的 `绑定`、`确认绑定`、`解绑`、`身份`、`重新认证` 及其英文写法仍是固定指令。管理助手的查询和命令走原管理模型与相同工具，不在飞书 handler 内实现 SQL、Manager 配置或 GitHub 写入。

私聊会话由连接、安装租户、操作者租户、操作者、chat 和 principal 共同隔离。Web 可直接读取相同 `conversation_id`、管理消息、命令 `operation_id`、修改前后版本、状态、差异和审计。

`queued` 表示只落入渠道队列；`submitted` 表示管理消息已受理。管理消息 `completed` 表示模型/工具回合结束，业务命令必须另看回执的 `succeeded`、`failed` 或 `unknown`。IM 发送成功只表示送达卡片，不能证明管理/GitHub 操作成功。命令没有审批步骤，授权范围内直接执行；Web 对账恢复 IM 命令时也重新验证持久渠道来源、绑定和连接：私聊命令核对本人的飞书绑定，群聊命令核对群绑定、来源消息、角色权限和授权者权限。

结果卡片只带“登录后台查看”链接，不携带回调操作；较早版本卡片上的“刷新执行状态”按钮点击后按过期处理（`channel_card_stale`），不会触发任何写入。

## 群聊

### 群聊助手绑定

群聊由服务角色回答（服务角色的定义、模型、预算与计费见[服务角色](service-roles.md)）。「身份与权限 → 飞书群聊助手」为一个群保存一条绑定：一个服务角色、一份项目范围（整个组织，或多选仓库）和发言范围（仅回应 @／回应 @ 及以问号结尾的文字／读取每条新文字后判断是否发言），以及配置人和 revision。一个群只绑定一个角色，不切换；默认推荐内置的「仓库问答助手」（可以查询 Issue／PR、解释代码，不能派活）。需要更大权限的群（例如可信 committer 群）可以绑定超级管理员新建的自定义服务角色。管理助手的权限继承当前用户，不能绑定到群。

配置人必须已绑定飞书、当前在该群中（保存时用应用身份完整分页核验群成员；应用没有读取群成员的权限时，飞书返回 99991672，保存返回 403 `channel_audience_permission_required`，页面提示超级管理员到「全局设置 → 飞书连接」查看缺少的权限，开通 `im:chat.members:read` 并发布新版本），并对所选的每个仓库有 `config.write`；选整个组织时需要组织级 `config.write`。范围写入这条绑定专用 service principal 的 `scoped_grants`（每个仓库一条，或组织一条），授权者记为配置人；这个 principal 最多持有 `tasks.read`／`tasks.write`，没有项目配置、授权管理、知识或计划能力。修改或重新启用时整份范围按当前配置人重写；停用要求配置人本人、超级管理员，或对全部范围有 `config.write` 的维护人。保存要求 `expected_revision`，冲突返回 `channel_revision_conflict`，每次修改写审计 `channel.service_binding.*`。页面提示：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。

群内有效权限 = 服务角色的权限项 ∩ 绑定范围 ∩ 授权者当前仍有效的授权（该仓库的 `config.write` 及工具所需能力）。授权者失去某个仓库的权限时只暂停这个仓库；全部仓库都不可达时绑定显示暂停。不再校验群内发言人的绑定、权限或成员快照，未绑定的普通成员也按绑定配置使用助手；来源真实性仍由飞书事件签名、连接版本和本地消息账本校验。服务角色被停用时群内说明原因，不改用其他角色；仍有启用中绑定的服务角色不能删除（`service_role_in_use`）。

群聊助手获得的工具都在服务端按绑定范围校验，一次请求可以跨多个仓库，不需要先选项目：

- `list_projects`：当前可用的仓库全名和 GitHub 链接，不返回内部 ID；
- `conversation_history`：本群本地记录的检索、摘要和分段读取（`search_conversation_history`／`read_conversation_summary`／`read_conversation_message`），不回源飞书；
- `github: read`：`github_read`、`github_search`、`read_job_log`，复用任务的仓库只读工具并增加 `repository` 参数；范围外的仓库直接拒绝且不发出请求。每次回答按仓库换取只读安装令牌，回答结束即撤销；令牌不进入模型或日志；
- `project_tasks: read`：`list_project_tasks`、`read_project_task`；`write` 另有 `manage_project_task`（暂停、取消、重试、追加指令），经 `ManagementService` 的版本检查、幂等和审计，回执与控制台一致。命令以绑定的 principal 提交，执行和对账恢复时都重新核对绑定、来源消息、角色权限和授权者权限；
- `delegation: allow`（派活）：`create_project_task` 在范围内的仓库新建任务，参数为需求和交付约定（目标、范围、验收条件、终点）；同时提供 `list_project_tasks`、`read_project_task` 和 `manage_project_task` 的追加说明、修改约定（`task.contract`）与取消。见下文「派活」；
- 独立任务：`start_own_task`、`continue_own_task`、`list_own_tasks`，不受权限项控制，见[服务角色](service-roles.md#独立任务)。

#### 派活

服务角色只能经项目的 Manager 间接派活：新建的任务与控制台创建的任务相同，交给项目团队、由 Manager 规划和分派；不能指定执行角色，也不能直接操作某个角色的运行。群里提交的任务命令按操作检查服务角色的权限：

| 操作 | 需要 |
| --- | --- |
| 新建任务 `task.create`、修改约定 `task.contract` | `delegation: allow` |
| 追加说明 `task.instructions`、取消 `task.cancel` | `delegation: allow` 或 `project_tasks: write` |
| 暂停 `task.pause`、重试 `task.retry` | `project_tasks: write` |

新建任务经 `ManagementService.submit('task.create')` 以绑定的 principal 提交：服务端读取当前项目版本作为 `expected_revision`，幂等键由群、来源消息和工具调用生成；授权者对该仓库须仍有 `config.write` 和 `tasks.write`；审计和回执与控制台一致。任务创建时记入 `channel_service_tasks`，关联到这条绑定和来源消息。任务完成、提交 PR、取消或失败时，结果发回原群；入队和发送前复核绑定仍启用、授权者仍能读该仓库以及任务的来源权限。结果消息记在本绑定的范围内，并带上当时的群围栏，之后的回答可以引用它；绑定或权限变化后不再进入上下文。

任务执行期间，任务引擎每次复核来源时也检查这条绑定：绑定仍是该群当前且启用的绑定、服务角色仍是 `delegation: allow`、授权者对该仓库仍有 `config.write` 和 `tasks.write`；任一不满足就停止后续步骤（`channel_service_delegation_revoked` 或 `channel_service_scope_paused`）。

群里没有审批或人工确认：群助手在服务角色权限、绑定范围和授权者权限之内的操作直接执行，与控制台和私聊一致，见[统一管理服务与管理对话](management-agent.md#会话停止和执行)。

#### 旧群员工的迁移

升级时，每个有已启用旧群员工的群自动转为一条「仓库问答助手」绑定：范围是原来启用的项目，各项目的授权者沿用原维护人，发言范围在各项目一致时沿用、否则改为仅回应 @。迁移只执行一次（设置项 `channel_service_bindings_migrated`）。旧群员工不再接收新消息，旧接口 `PUT /api/channels/chats/:id/employee` 只能停用（启用返回 `channel_employee_retired`）；它们已创建的任务继续按原授权、成员核验和来源守卫执行并向原群通知结果，直到维护人在页面「旧群员工」中停用。只有仍有未结束任务的旧授权才会继续定时核验群成员。

维护绑定的人（配置人、超级管理员或对全部范围有配置权限者）可以查看连续会话、查询和分页搜索本地群记录、显式安排重新同步；这些读取只使用本地账本，不以历史或成员 API 回源。私信和其他群不因此开放。全局管理员继续管理连接、全部本地诊断和保留策略。

群使用 `provider + app_id + installation_tenant + chat_id` 对应的稳定本地会话，换成员、thread、日期不另起会话。个人私聊使用绑定账户的共享 `ManagementAgent`，与控制台共用管理工具、有效权限、幂等、版本检查和审计。个人管理历史与群聊历史分别保存，个人授权不会扩展群聊助手的能力。

绑定后可以直接发送“你好”“我能管理哪些项目”“看看 bot 项目的任务”或“暂停刚才那个任务”。问候、帮助和跨项目查询不要求先选项目；助手通过真实项目查询发现名称，使用仓库全名和可读链接回答，同名或多候选写入先自然追问，用户可继续选择和切换项目。模型、预算和用量属于服务角色「管理助手」，与请求实际操作的项目分别处理，不会默认选中业务目标或授予权限。没有可访问项目时明确说明授权不足；缺少可用模型时提示检查配置，不虚报完成。

同一绑定账户在同一私聊跨项目与 thread 延续管理问答，历史按当前授权重建；来源编辑、撤回或清理后丢弃旧派生上下文，发送前重新校验身份、来源及授权。解绑、换绑或撤权不恢复旧范围。以前 `/project` 指令留下的命令回执仍可在控制台按原会话追溯。个人绑定页展示共享管理问答与真实执行状态；失败和执行结果待确认均区别于已执行，未知结果先对账。

默认仅回应 @；配置人可让助手回应以问号结尾的文字，或读取每条新文字并由助手决定是否保持安静。所有合法可见消息仍独立落库，机器人消息、历史同步和超过实时窗口的旧消息不会触发模型工作。扩大发言范围会增加服务角色的用量，仍受服务角色预算限制。

群聊助手的主上下文使用最近 40 条本地消息、每批最多 100 条的滚动摘要与本地检索。一次回答可以在同一步里对多个仓库各发一个工具调用，数量不设上限；同一批工具结果共享预算，请求变大时先省略较早的工具结果，规则见 [Agent 运行时](agent-runtime.md)。上下文与搜索使用明确标记的文本摘录；`read_conversation_message` 可分段读取完整本地原文／资源引用，附件不会因此下载。摘要记录来源范围、水位、截断清单和授权围栏；编辑、撤回、清理、绑定或角色权限变化以及授权者授权变化都会使旧摘要和派生回答失效，进行中的回答随之停止且不发送。助手的回复以 `binding:<绑定 id>` 范围记入本地账本，其他绑定或项目范围的机器人消息不会进入本群上下文。每轮回答记一条 `channel_service_turns`，请求／响应快照密封保存，用量只在 `model_requests` 中按服务角色记录一次（`repository_id` 为空）。

旧群员工的任务结果按 task 与结果版本进入原渠道 outbox；游标与入队事务提交，发送前复核来源消息、当前授权与执行权限版本。任务执行仍只有原调度器。源消息撤回、变更或清理后停止后续任务操作与披露；已经发出的群消息不能承诺全部收回。「查看连续会话」展示群聊助手当前获准的回答、覆盖与未知费用。任务审计事实仍保留在原受控任务页面，不被聊天记录清理静默删除。

官方协议见[获取群成员列表](https://open.feishu.cn/document/server-docs/group/chat-member/get)、[判断用户或机器人是否在群里](https://open.feishu.cn/document/server-docs/group/chat-member/is_in_chat)。后者判断当前 access token 对应的主体，不能用 bot token 直接证明任意维护人还在群里。

## 去重、恢复和发送队列

事件按连接与 event_id 持久去重，消息再按 message_id 去重。合法消息不因发送者、类型、是否 @ 或原发送时间而丢弃；HTTP 与 SDK 在同一事务提交 inbox、本地账本、同步发现和必要的安全失效，再返回成功，数据库失败返回失败。记录与业务处理分开：当前个人管理入口只处理新鲜的用户文本、私聊及群内 @；bot、附件、未 @ 和过期消息安静入库，不重放旧命令。原管理入口仍拒绝逆序业务写入。模型和业务执行由独立 worker 执行，慢模型不阻塞回调。

重启不会重放已提交的管理消息：管理服务标记中断，需要查看原会话/回执；尚未提交的收件继续处理。发送 outbox 独立保存 `queued`、`sending`、`retry`、`sent`、`failed`、尝试次数和稳定错误码，网络失败指数退避，使用相同 Feishu uuid 对账重发。连接/身份/范围失效为终止失败。所有发送内容和入站正文密封保存，SDK 原始日志关闭，访问令牌只在服务端调用期间使用。

收到需要处理的新用户文本后，独立 worker 在原消息下添加 `Typing` 表情，表示请求已收到并正在处理；模型完成但回复尚在发送或重试时继续保留，卡片实际送达后移除。群助手决定保持安静、处理终止或发送最终失败时也会清理。重复投递不重复添加，安静入库的消息、历史同步、机器人消息与卡片事件不添加。表情请求不阻塞回调、模型或发送队列；添加和清理状态按收件持久保存，重启或添加响应丢失后用[获取消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/list)查询本应用的 `Typing` 表情恢复，不删除其他人的表情。该查询使用已有的 `im:message:readonly` 权限，新增的写入权限须由飞书应用管理员开通并发布。缺权限或平台拒绝时保留 `reaction_state` / `reaction_error` 诊断，消息照常处理；网络故障和限流退避重试，平台永久拒绝时无法保证移除。接口依据：[添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)、[删除消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete)、[表情文案说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)。

## 会话定时任务

每个飞书私聊和已绑定群聊助手的群都可以挂一个或多个定时任务（#330），在「身份与权限」页的「我的飞书私信会话」或对应的群聊助手下管理：名称、任务提示词、IANA 时区、五段 Cron 或固定间隔（5 分钟到 31 天），可以预览接下来的触发时间、立即运行一次、暂停或恢复、编辑和删除，并查看最近一次运行的状态与原因。私聊的定时任务只能由这个私聊的绑定主人管理；群的定时任务由能管理该群聊助手绑定的人管理（配置人、超级管理员或对全部范围有配置权限者）。平台管理员还可以查看并停用私聊的定时任务。

到点或立即运行时，提示词交给这个会话自己的助手执行，结果发回同一会话：私聊用管理助手，以绑定主人当前的有效权限在一个专属的管理会话里跨项目查询和处理；群聊用本群绑定的服务角色，工具和仓库范围与群里提问时完全相同，派出的任务完成后同样回到本群。提示词只是任务说明，不扩大工具或项目范围；范围外的仓库和未授权的操作照常被拒绝。触发时、每次工具调用前和发送前都会重新检查：定时任务未被修改或删除、私聊主人的飞书绑定仍有效且授权修订未变，或群绑定仍启用、服务角色可用且群围栏未变。私聊主人解绑、群聊助手停用或服务角色停用时，这次运行失败，定时任务暂停并记下原因；模型或网络故障只让这一次失败，之后照常触发。助手返回空回复时（提示词允许没有内容就不通知）本次记为“无需通知”，不发送空卡片。

每个逻辑触发点只运行一次：`channel_schedule_runs` 以 `(schedule_id, logical_key)` 唯一，重启或并发不会重复执行；服务停止期间错过超过 10 分钟的触发点记为跳过，上一次运行尚未结束时的触发点也记为跳过。重启时运行中的记录标为中断，不自动重放。群里正在回答消息时，定时运行稍后开始，运行期间群里的新消息排队。模型用量和预算属于对应的服务角色（管理助手或群绑定的服务角色），与在会话里提问相同。接口见 [控制台 API](api.md)，审计动作为 `channel.schedule.*`。

项目级「定时计划」和事件订阅仍按 [持久化调度模块](schedules.md) 运行，目的地不再需要先登记：项目面板的目的地列表直接列出可以选择的会话，即本人已绑定且能读取该项目的私聊，以及本人能管理、范围覆盖该项目的群；保存计划或订阅时按原规则自动登记，同一会话、项目和登记人只登记一次。已有登记继续有效。每次发送前重新检查：私聊目的地核对接收人的读取权限和飞书绑定，群聊目的地核对群绑定仍启用且范围仍覆盖该项目；登记不表示送达。

## 本地消息账本与历史同步

`channel_chats` 使用 `provider + app_id + installation_tenant + chat_id` 唯一标识群或私信；连接凭据轮换不创建新记录。它不直接拼接旧 `channel_sessions` 中的个人管理会话。原文和资源引用密封保存于 `channel_messages`，按会话和 message_id 合并实时/历史版本。较旧页面不覆盖较新内容，实时版本优先于同版本历史，撤回 tombstone 不被补读复活；消息变更使本地派生摘要失效。绑定串及可识别凭据在查询中隐藏，附件当前只保留元数据和资源引用，没有下载或解析能力。

机器人入群或首次接触会话时持久建立 `channel_sync_jobs`。入群只发送固定记录说明，不调用业务模型或生成项目授权。同步单页使用官方最大值 50，固定升序和 chat 查询时间上界，持续分页直到 `has_more=false`；没有产品总条数上限。普通对话群的 thread 回复需要单独分页，发现 thread 后建立同一主聊天下的作业。飞书 thread 查询不支持时间范围，因此诊断保留这一限制。每页内容、发现的 thread、游标、完成区间同事务提交；过期租约可恢复，活跃租约不可抢占，重复或循环游标停止并报诊断。

429 遵守 Retry-After，网络错误退避重试，缺权限、不在群、不可见话题等保持受阻状态，不标已同步完成。启动或 SDK 重连补读已完成范围的重叠增量；未完成作业保留原游标继续。撤回事件直接更新本地。官方 SDK 当前未提供通用消息编辑事件，编辑仅在同步读取时按 update_time 合并；管理员可显式全量重新同步，不能承诺编辑均被实时捕获。机器人被移出、群解散或应用停用停止后续同步和受保护发送。

「连接健康与收发记录」下的本地历史页支持消息 ID、时间、关键词、发送者、回复关系与分页。`ChannelLedger` 不持有 HTTP client，页面与 API 查询不触发飞书请求；未命中只代表本地已同步范围没有结果。返回 `sync_state/coverage/gaps`，其中 `visible_range_complete` 只表示本轮遍历了平台返回的可见分页，入群前历史、真实平台可见范围及消息编辑仍显式标为未核验。现阶段历史 API 仅向 `platform.manage` 开放，项目读取权限不自动开放群记录或个人私信。

默认保留策略明确为保留至管理员显式清理，`retention_days=null`；管理员可配置 1–3650 天，由同步维护周期按日清理，也可显式清理指定时间之前的记录。清理同时删除派生摘要并保留 `retained_after` 覆盖边界，旧历史补读不能恢复已清理内容。操作保留审计，客户端不能通过搜索触发清理或同步。

## 验证

`npm ci`、`npm run check`、`npm test` 是基础检查；`test/channel-service-bindings.test.mjs` 用本地 GitHub App 和飞书协议夹具覆盖群聊绑定的授权条件、飞书应用缺少成员权限时的拒绝、跨仓库问答与范围拒绝、任务读写与撤权、经 Manager 派活（新建、追加说明、修改约定、取消，不能暂停或指定角色）与结果回群、撤销派活后停止任务、群聊助手的独立任务与围栏变化后隐藏、两个群的范围隔离、授权者失权、迁移和删除检查，`test/channel-conversation.test.mjs` 覆盖发言范围、长原文、滚动摘要和来源变化；`test/channel-schedules.test.mjs` 覆盖私聊和群聊定时任务的管理权限、跨项目执行、范围与工具拒绝、撤权暂停、逻辑触发点去重和用量归属；`test/channels.test.mjs` 覆盖项目面板直接选择会话作为目的地、聊天文本不再触发 `/project` 流程、验签/解密、重投、慢模型、双端绑定、群字段范围、会话隔离、撤权、旧卡片、发送重试和重启恢复。`test/channel-setup.test.mjs` 覆盖向导和凭据检查的管理员边界、个人应用范围、敏感信息过滤、异步版本检查及部分凭据更新。

`e2e/channels.spec.mjs` 使用独立 SQLite、随机本地 HTTP 端口、官方事件结构的合法签名样本以及 GitHub/模型/飞书协议夹具验证用户路径。截图和结构化证据保存在 `.tmp/channels-165/`。测试中只使用测试凭据，不调用真实飞书租户，也不接触正在运行的部署。运行 Playwright 时，将 `TMPDIR` 和 `PLAYWRIGHT_BROWSERS_PATH` 设为工作树内目录。

`e2e/feishu-setup.spec.mjs` 经实际页面验证管理员创建/恢复连接、失败提示、版本冲突，以及用户从合法飞书绑定事件开始，经本地平台登录或可选 GitHub OAuth、原私聊确认到查看与解绑的完整路径。本地登录场景不配置 GitHub OAuth，并核对绑定不增加仓库授权。桌面和手机截图保存在 `.tmp/feishu-setup-165/`；同样使用本地协议夹具，不代表已连接真实飞书应用。

`e2e/channel-service-bindings.spec.mjs` 在桌面和手机宽度验证维护人选择仓库绑定仓库问答助手、查询本地群记录和停用，并验证应用缺少成员权限和入口返回网关错误页时保存给出可读提示；`e2e/channel-conversation.spec.mjs` 验证群聊助手与个人私聊的连续会话页面。截图保存在 `.tmp/channel-service-bindings-312/` 和 `.tmp/channel-conversation-312/`。

`test/channel-ledger.test.mjs` 验证事务回滚、官方 SDK frame 的失败/成功 ACK、数据库重启、全部分页和 thread、过期租约、429、异常游标、撤回合并、敏感信息、本地零回源及保留边界。`e2e/channel-history.spec.mjs` 在桌面和手机验证超过 100 条、跨成员/thread/日期的本地消息分页、搜索、同步诊断和保留配置；均为本地协议夹具，不是飞书或 GitHub 真实集成。

实现依据：[飞书回调验签与解密](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)、[官方 Node SDK](https://github.com/larksuite/node-sdk)、[长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)。实际开通时仍需按应用类型核对权限与可用事件。

历史范围与协议依据：[获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)、[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[撤回消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/recalled)、[机器人进群](https://open.feishu.cn/document/server-docs/im-v1/chat-member-bot/events/added)。历史权限不能保证平台提供全部历史；普通群的根消息与话题回复分页、机器人在群状态、群历史可见设置均影响实际结果。
