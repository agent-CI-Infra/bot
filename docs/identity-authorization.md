# GitHub 登录与统一授权

## 当前行为

一个租户对应 `github.com` 上的一个数字 owner account ID，一个项目对应数字 repository ID。名称用于展示，改名不会合并或重建身份。GitHub 身份以 provider、host 和数字 user ID 关联；同名、同邮箱的本地账号不会自动合并。首次部署仍先初始化本地超级管理员，GitHub 新账号始终从无平台权限的项目用户开始。本地登录是原有超级管理员的恢复入口，保留密码、限流、CSRF 和最后一名超级管理员保护。

`/auth/github/start` 和 `/auth/github/callback` 实现用户 authorization-code 登录；App manifest 注册 `/onboarding/github/callback` 和安装 `/onboarding/github/setup` 分别处理。OAuth state 与发起浏览器绑定，10 分钟过期，换 code 前事务消费，采用 S256 PKCE，固定回调地址。绑定既有账号由已登录会话通过 `POST /api/identity/github/bind` 发起，回调再次核对原会话。失败、重复、过期和冲突均显示确定错误，不能重新分配已绑定身份。用户 access/refresh token 和 PKCE verifier 使用 SecretBox 加密并绑定记录 AAD，读取接口不返回密文或明文凭据。

系统超级管理员在「全局设置 → 接入向导 → GitHub 登录」配置独立 OAuth App 的 Client ID 和 Client secret；回调地址取统一入口。部署地址始终可用于登录和写入，向导地址只增加可接受的 Origin。仓库 GitHub App 的选择与登录配置独立，仓库 App 凭据不会预填到登录表单。保存前保留原生效登录配置；升级前复用仓库 App 的登录明确提示迁移。配置与 secret 加密保存且不回读，保存立即生效；仅在没有向导配置时使用部署环境默认值。任何修改都会作废未完成的 OAuth state，并使派生授权等待重新验证；停用或更换 Client ID 还会清除用户 token 和 GitHub 身份会话。本地恢复账号、显式委派和原任务保留，停用配置在重启后仍有效。项目与组织管理员不能读取或修改此系统配置。具体操作见[接入向导](onboarding.md#github-用户登录)。

控制台的「身份与权限」显示身份状态、组织选择、角色、能力和每条授权来源。组织选择保存在服务端会话，后续列表、资源详情和写入按当前范围检查。可以重新验证 GitHub 权限或解除绑定；解除绑定结束使用该身份建立的会话，并撤销 GitHub 派生授权。已有本地账号和独立显式委派保留。

当前账户在页头、账户菜单、身份与飞书绑定页面统一显示 GitHub `@login` 或本地用户名；内部系统用户名仅在身份页的高级诊断中展示。权限范围使用当前会话已可见的仓库全名，无法解析时明确显示「项目（ID …）」，不会为显示名称额外读取未授权仓库。

`GET /api/identity` 在 `github_connection` 中给出一句可展示的 GitHub 连接状态，以及对应的下一步。它和身份行上的「已验证」不是一回事：「已验证」只表示绑定仍有效。该字段区分：尚未连接、授权已失效、授权待验证、已连接且可访问 N 个已启动仓库、有授权的仓库不在当前选定的组织里（`outside_tenant`，下一步是切换到「所有已授权组织与项目」）、有授权但当前项目列表读不到（`not_listed`，下一步是重新验证）、仓库已安装但尚未由管理员启动、已登录但还没有授权任何仓库。「可访问 N 个仓库」只数这次会话的项目列表（`GET /api/repositories`）实际会列出的仓库，两处不会给出不同的数字。同时返回已启动且当前可访问的仓库名（`repositories`）以及已安装、本人有管理权但尚未启动的仓库名（`pending_repositories`）。`outside_tenant` / `not_listed` 另给出项目列表看不到的已授权仓库数（`hidden_repository_count`，其他状态为 0），`outside_tenant` 还给出当前组织的显示名（`tenant_name`，其他状态为 `null`）；控制台按状态码翻译中英文文案，用这两个字段填入数量和组织名，不解析中文 `next_step`。项目列表用这个字段展示「等待管理员启动」，不打开 `/api/installations`。`pending_repositories` 的每一项带 `self_start`：仓库所属的 owner 已被超级管理员信任时为 `true`，项目列表在这一行给出「启动」，由这位管理员自己启动（见[架构与行为](architecture.md#使用与权限)）；否则只能等超级管理员启动。身份页在 `connected` 状态下按全名列出 `repositories` 并链到对应项目总览；`pending_repositories` 另列并保留「待超级管理员启动」，两边都有时补一句「另有 N 个仓库已安装，等待超级管理员启动」；其他状态不列已启动仓库。无法从已有记录可靠区分「App 没装到自己的仓库」和「装了但不是仓库 Admin」（安装属于整个部署），这两种情况同为 `no_repositories`，下一步同时提示去 GitHub 选择仓库、需要管理员权限，以及必要时联系管理员。响应不含凭据或授权证据原文。身份页默认显示这句连接状态、对应的主按钮（连接 GitHub、去 GitHub 选择仓库、重新连接、重新验证，或切换到所有已授权组织），以及上面两个仓库列表；账户名、授权来源和读取时间收在「高级／诊断」里，展开后一项不少；权限记录版本放在「切换组织」下方默认折叠的「高级说明」里。个人飞书绑定卡片留在身份页第一屏，不放进「高级／诊断」。页内不再另放「刷新身份与授权」——重新读取用顶栏「刷新」，向 GitHub 复核用「重新验证 GitHub 权限」。从 GitHub App 安装返回时（`/?github_setup=<status>#/identity`），页面自动调用 `POST /api/identity/refresh` 并显示结果；从 GitHub 登录或绑定返回时（`/?github_auth=1#/identity`）不再另起核验，等登录时开始的那次核验结束后显示结果（见[何时核验 GitHub 权限](#何时核验-github-权限)）。「最近核验」「授权有效期」「本页读取时间」按浏览器时区显示并标出时区（如 UTC+8）；有效期优先写成「还剩 N 分钟」，并附带绝对时间。若本部署已配置仓库 GitHub App，`install_url` 是该 App 在 GitHub 上公开的安装/选择仓库地址（`https://github.com/apps/<slug>/installations/select_target`；已存的 `/installations/new` 在读取时改写）；App 所有者的设置页、账号 ID 和 Webhook 地址仍只通过超级管理员的接入向导接口提供。

GitHub 登录后的页头显示 GitHub 用户名和头像，内部账号 ID 仍用于身份关联；本地密码会话保持本地登录名。全局设置的用户列表按与请求鉴权相同的范围和安装检查展示账号在全部组织中的当前可见项目，分别标明 GitHub 继承权限与 Bot 显式委派，并标注是否具有配置权限。过期、待验证和撤销的派生权限不计入有效项目；手工分配单独展示和编辑，未手工分配不代表没有 GitHub 继承权限。

## 权限来源和安装范围

| 当前证明 | 派生授权 |
| --- | --- |
| 个人安装目标本人 | 有效安装范围内项目管理 |
| 组织 owner，all 安装 | 租户 org_admin；仅覆盖有效安装中的项目 |
| 组织 owner，selected 安装 | 选中的已安装项目管理 |
| 仓库 admin | 对应已安装项目管理 |
| 仓库 Write、Maintain | 对应已安装项目的成员（`project_member`）：`tasks.read`、`tasks.write`、`tasks.manage_own`，即提问、创建任务、管理自己发起的任务 |
| 仓库 Triage、Read | 对应已安装项目的读者（`project_reader`）：`tasks.read`，即提问和查看任务 |
| 普通成员、历史 sender、requester | 不自动授予管理权限 |

独立 OAuth App 明确请求空 scope，用户 token 仅读取 `/user`；返回额外 scope 时拒绝保存与登录。权限核验使用另行签发的只读 GitHub App 安装令牌：读取安装详情和完整仓库列表，查询 `/orgs/{org}/memberships/{username}` 和 `/repos/{owner}/{repo}/collaborators/{username}/permission`，比对数字用户、组织和仓库 ID 后形成证明。临时安装令牌只申请 Metadata 读和安装已具备的 Members 读，查询结束后撤销。组织 owner 必须得到 `active/admin` 成员证明；App 自身全仓权限、安装事件和历史操作者不构成人类管理权限。权限计算与 #162 的安装状态、仓库范围和投影版本相交。暂时失败、SSO 或权限不足显示待验证，不能把失败推断成离职，也不能继续使用过期派生权限；GitHub 流控不算失败，见[何时核验 GitHub 权限](#何时核验-github-权限)。

授权分为 `github_derived` 和 `explicit_delegation`，分别保存范围、能力、授权者、策略、证据、验证时间、有效期、撤销和安装版本。安装领域事件由持久化游标消费；安装状态也在授权与 GitHub 请求检查，事件尚未被消费时仍不能绕过暂停或卸载。每轮核验按安装分别处理：已确认删除或暂停的安装，以及已确认不再具备的权限，对应派生授权被撤销；状态、安装范围或权限读取无法确定的安装，其派生授权只转为待验证，等下次证明恢复，不被撤销。造成不确定的安装和错误码记在身份的 `verification_issues`（不含凭据），全部确定后清空。

## 何时核验 GitHub 权限

- **有效期**：派生授权自核验起有效 30 分钟。
- **登录时核验**：GitHub 登录、已绑定 GitHub 身份的本地账号用密码登录，以及「重新验证 GitHub 权限」。若此时已有一次核验在进行，会等它结束后再发起自己的一次；因并发版本变化未能落库的核验会重试。
- **登录不等核验**：登录在核验开始后立即完成并进入控制台。核验进行时，`GET /api/auth/me` 的 `github_verification` 给出进度 `{ checked, total }`（已读完的安装数和本部署的安装总数，连接 GitHub 阶段 `total` 为 0），没有核验在进行时为 `null`。控制台在每页顶部显示这行进度；项目列表为空时显示「正在核验 GitHub 权限」而不是「尚无可管理的项目」，身份页等核验结束再显示授权。核验结束后，项目列表、身份页的根视图和项目切换器按新的授权更新，其他页面（例如正在编辑的表单）不重画；若这次读取项目列表失败，核验仍算完成：顶部那行改成「权限核验已完成，但项目列表读取失败。」并给出「重新读取项目列表」，只重读这一条；项目列表与身份页的根视图照常按已完成的核验重画，不再显示「正在核验 GitHub 权限」，也不保留旧列表；重读成功即清掉这行并重画受影响页面。身份子页（飞书应用连接向导、飞书绑定页）不依赖本次核验证明的授权，其中有未提交的输入、打开的对话框或焦点时也不重画，只更新项目列表与项目切换器。控制台只在标签页可见时读取这行进度，回到前台立即读一次；读取失败（5xx、超时、网络错误）按 1.5 秒起翻倍退避、封顶 30 秒，连续三次失败后这行改为「核验进度读取失败」并给出「立即重新读取」按钮，读取成功即恢复进度文案与正常节奏；会话过期（401）仍立即停止并交给登录过期提示，不重试。
- **后台刷新**：每 10 分钟一轮，核验仍在使用派生授权的账号：有未过期控制台会话的账号、有启用中飞书个人绑定的账号，以及启用中群绑定的授权人；5 分钟内刚核验过的（例如刚登录）留到下一轮。同时最多核验 2 个账号，相邻两次开始至少间隔 2 秒，等待期间不再符合这些条件的账号跳过。三者都不是的账号不发任何 GitHub 请求，其派生授权 30 分钟后过期，下次登录时重新核验。
- **飞书回合先补核验**：飞书私聊回合、群回合（核验该绑定的授权人）和会话定时任务在读取权限前，与写请求一样，对证明已过期的账号先核验一次，共用正在进行的核验。私聊消息在核验期间留在待处理队列，同一私聊之后的消息按顺序排在它后面，不阻塞其他会话；一分钟内由飞书回合核验过的账号不因后续消息重复核验。
- **写请求不等待 GitHub**：按已保存的授权（最新有效权限，见[授权版本](#授权版本)）判断，不发 GitHub 请求。只有账号的 GitHub 证明已过期，即 30 分钟内没有一次核验成功时，这个请求才先核验一次，并发请求共用同一次核验。刚失败的核验（身份转为待验证）一分钟内不因写请求重复，GitHub 要求等待期间也不重复。
- **从不核验**：平台超级管理员，以及持有有效显式委派（包括控制台手工分配的项目或组织）的账号；项目管理员授予的委派不在此列，见[项目内委派](#项目内委派)。他们的访问不依赖 GitHub，也不再获得 GitHub 派生授权：下一次登录或「重新验证」时撤销已有派生授权，不发 GitHub 请求。
- **流控**：GitHub 报告流控时（429，或 403 带 `Retry-After`、`X-RateLimit-Remaining: 0`），本次核验不再发送请求；受影响安装的派生授权保留剩余有效期，身份不转为待验证、最近核验时间不变，`verification_issues` 记 `github_rate_limited`。后台刷新暂停到 GitHub 给出的恢复时间，未给出时暂停一分钟。

撤权时效：webhook 带来的撤权立即生效。用户撤销 App 授权（`github_app_authorization` `revoked`）撤销身份并结束其会话；组织成员移除（`organization` `member_removed`、`member` `removed`）使该账号的派生授权立即过期，仍成立的部分在下一次核验时恢复；安装删除或暂停使对应派生授权立即失效。GitHub 上的其他变化，如移除 owner、收回仓库 admin，在下一次核验时生效：后台刷新覆盖的账号（控制台会话、飞书个人绑定、群绑定授权人）不超过 10 分钟，其他账号在下次登录时。

后台工作同样按已保存的授权判断。以发起人身份继续的异步任务等不会触发核验：账号既没有登录、也没有飞书绑定或群绑定时，派生授权 30 分钟后过期，这些工作因授权过期被拒绝，直到账号再次登录。

核验后仍没有可用权限时，飞书里说明原因而不是只回答「没有可访问的项目」：GitHub 不再接受保存的授权（在 GitHub 上撤销了授权、登录配置更换后凭据被清除，或核验返回需要重新授权）时，私聊回答需要登录控制台并用 GitHub 重新登录；核验暂时无法完成时说明会自动重试；核验已完成但没有权限时说明 GitHub 的最新核验结果。群绑定的仓库全部暂停时，@ 助手的消息直接得到一条说明，写出是哪位授权人、需要他做什么（重新登录、等待核验，或请项目管理员重新配置本群），不调用模型；部分暂停时同样的说明出现在 `list_projects` 和助手上下文里。

## 授权版本

principal 的 `authorization_revision` 只在账号失去原有有效权限时递增。判断比较变化前后实际可用的权限范围：已过期、待验证或撤销的授权不参与比较，平台角色或其他授权仍覆盖的能力不算失去；权限不变或只增加时版本不变。递增的情形包括停用账号、移除超级管理员、撤销委派或手工分配、解除身份绑定、GitHub 核验确认失去权限或转为待验证、安装变化使仍有效的派生授权失效，以及渠道员工、服务绑定停用或缩小范围。

授权版本只用于后台内容类场景：管理助手对话历史按版本分段，待发送渠道消息、群定时投递和管理命令按创建时的版本校验，任务来源与个人助手电脑的围栏随版本失效，GitHub 权限核验写入授权时用它做并发保护。失去权限后，这些内容不再沿用。需要反映新增权限的视图（如项目记忆可见范围）按当前有效授权计算，不依赖版本。后台执行身份（`resolvePrincipalActor`、`resolveServiceActor`）在版本变化后返回 `409 authorization_changed`，由调用方按当前权限重新解析。

网页控制台不比较会话的授权版本。写请求不等待 GitHub 核验（见[何时核验 GitHub 权限](#何时核验-github-权限)），在每次落库或调用 GitHub 前按最新有效权限判断：守卫对目标项目调用 `authorize`；请求期间版本变化时，下一次落库或 GitHub 调用前重放本请求已通过的授权检查和请求开始时的超级管理员身份，全部仍成立就继续，失去其中一项返回 `403`。账号或主体停用、会话过期或撤销返回 `401 login_required`。因此刷新页面或会话停留在旧版本不会导致写入失败，只有真实失去所需权限才会被拒绝。

平台超级管理员拥有恢复和显式委派管理能力，org_admin 与 project_admin 不会取得平台能力或无限转授能力。派生 owner 不提供 `grants.manage`。显式委派 API 只接受委派者有权授予的能力和范围，禁止自授与平台能力注入。普通配置修改直接保存并审计，不引入默认人工审批。

### 项目内委派

项目管理员（在该项目有 `config.write`，无论来自 GitHub、组织授权还是委派）可以在这个项目里授出和撤销自己拥有的能力，包括任命其他项目管理员；整个组织的授权、平台角色和 `knowledge.review` 这类只能由授权管理员开启的能力仍只归超级管理员。项目管理员授出的授权记为 `policy: project_delegation`，只在授予人仍然拥有这些能力时有效：授予人失去 GitHub 权限、被撤销或停用后，这条授权显示为暂停（`state: suspended`，`reason: grantor_authority`），授予人恢复后自动生效。判断授予人的权限时，不计入经由已在这条委派链上的人得到的委派，所以两位管理员互相授权也不能在 GitHub 收回权限后保住对方，派生权限无法这样固化。这类委派是在 GitHub 权限之外追加的，持有人仍按[何时核验 GitHub 权限](#何时核验-github-权限)核验，派生授权不受影响。超级管理员授出的委派（`policy: independent`）与以前一样独立保存。

## 服务端契约

`GET /api/repositories/:id/members` 是按项目过滤的只读授权投影，要求当前项目的 `tasks.read` 与 `config.write`。它只返回该项目或其组织范围内的授权摘要；组织级 GitHub 派生授权还须命中该安装的当前仓库范围。响应不包含身份凭据或授权证据原文，也不会开放组织级成员列表。每条授权带 `grantor_name` 和 `can_revoke`（当前用户能否在这里撤销），响应另有 `tenant_id`、`can_delegate` 和 `delegable_capabilities`（当前用户能在本项目授出的能力）。`can_manage_legacy` 仅说明当前平台管理员能否使用原有项目分配接口，既有写入能力和服务端版本检查保持不变。项目详情返回 `can_configure`，供只读页面隐藏修改入口。

`POST /api/identity/grants` 接受 `tenant_id`、可选的 `project_id`、`capabilities`，以及 `principal_id` 或 `github_login` 二选一（`github_login` 按 GitHub 最近报告的用户名匹配已用 GitHub 登录过的账号，找不到返回 `404 principal_not_found`，多个账号同名返回 `409 github_login_ambiguous`）。超级管理员可授出任意范围；项目管理员只能授出所在项目、自己拥有的能力，且只能授给人，不带 `project_id` 返回 `403 organization_delegation_forbidden`，超出自己的能力返回 `403 capability_forbidden`。`DELETE /api/identity/grants/:id` 同样允许项目管理员撤销本项目里不超出自己能力的委派；来自 GitHub、旧版分配和群绑定的授权返回 `409 use_source_revocation`。项目「成员」页按 GitHub 用户名提供只读、成员、项目管理员三档授权和逐条撤销。

`src/identity/authorization.ts` 提供 `resolveActor(store, sessionRef, options)`、`authorize(actor, capability, resource)` 和 `listEffectiveScopes(store, principalId)`。ActorContext 字段为 `principal_id, tenant_id, project_id?, channel, capabilities, authorization_revision, request_id`。它由可信服务端建立；对象副本、浏览器 JSON、IM 文本或模型参数不能成为已认证 Actor。旧 Actor 由 `src/app/auth.ts` 适配，继续用于现有控制台服务。

能力包括 `tasks.read/tasks.write`、`roles.edit`、`knowledge.read/knowledge.write`、`schedules.manage`、`config.write`、`release.manage`；平台另外拥有授权管理能力。授权检查同时校验租户和项目归属。读取接口继续使用服务端范围过滤；写请求在事务开始或每次独立落库前、GitHub 请求发出前按当前授权检查（见[授权版本](#授权版本)）。异步人类任务与发布使用发起人的当前项目能力；新项目自动化使用独立 service principal、项目显式授权和组织维护归属，不借用创建人的个人 token。创建人停用后 service principal 可以继续按项目授权执行；缺少维护归属或项目授权时暂停。调度器、管理助手与 IM SDK 属于后续模块。

`src/identity/bindings.ts` 提供 `beginExternalBinding`、`completeExternalBinding`、`revokeExternalBinding`、`resolveExternalPrincipal`。服务端接入方构造 `ExternalBindings(store, verifier)`，verifier 只接受渠道侧已校验的可信证明。challenge 绑定平台会话、平台租户、provider/host、connector、外部租户、外部 actor 和 5 分钟有效期。完成时核对双方证明，事务内消费并建立唯一映射；相同完成幂等，转发、跨租户、冲突、过期和不同证明重放拒绝。撤销保留归属与审计并立即失效旧 Actor。该服务没有接受自填 open_id 的 HTTP 接口，不包含飞书 SDK 或绑定交互。

`GitHubIdentity` 实现 #162 的 `InstallationIdentity`：公开用户身份与只读安装权限 API 核实后，目标 owner 可读安装快照，受限用户仅能读取经核实的仓库子集；同步还要求当前管理能力。安装 Setup 状态由经过用户 OAuth 验证后的不透明会话引用关联，Setup 查询参数不能指定人类身份。

## 发布语义

保留 #148：有效控制台项目管理员可以发起发布，不额外要求个人 GitHub 写权限。标签、Release 和其他项目副作用继续使用 App installation token。用户 token 仅用于身份核实，权限证明由只读安装令牌读取，不进入模型上下文。App 暂停、卸载、仓库移出或安装范围待核实时禁止执行；人类发布者被撤权后，后续发布检查点也拒绝继续写入。

## 迁移和检查

启动增量迁移建立 principal、tenant、project 归属和 scoped grants，并在 `identity_migrations` 保存版本与首次校验报告。现有本地用户和手工 repo/org grants 记为 legacy explicit delegation，不造 GitHub 身份，不更改 task、role、memory 的 ID 或状态。未知项目或授权归属保存在 `identity_quarantine`，不进入默认租户。平台管理员可读 `GET /api/identity/migration` 查看报告与待处理条目。重复迁移不会重复创建授权或更改原记录。

```sh
npm ci
npm run check
npm test
npx playwright test e2e/github-identity.spec.mjs e2e/admin-grants.spec.mjs
node test/github-identity-docker.mjs
```

Docker 验收使用随机 `bot-github-163-*` Compose 项目、专用镜像、卷与 localhost 随机端口，配本地 GitHub 固件，无真实 GitHub 写入。证据在 `.tmp/github-login-163/`，脚本只清理自己创建的资源。

官方协议参考：[OAuth App 授权与 PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[用户可访问的安装](https://docs.github.com/en/rest/apps/installations)、[组织成员角色](https://docs.github.com/en/rest/orgs/members)。
