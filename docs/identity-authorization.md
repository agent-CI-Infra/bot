# GitHub 登录与统一授权

## 当前行为

一个租户对应 `github.com` 上的一个数字 owner account ID，一个项目对应数字 repository ID。名称用于展示，改名不会合并或重建身份。GitHub 身份以 provider、host 和数字 user ID 关联；同名、同邮箱的本地账号不会自动合并。首次部署仍先初始化本地超级管理员，GitHub 新账号始终从无平台权限的项目用户开始。本地登录是原有超级管理员的恢复入口，保留密码、限流、CSRF 和最后一名超级管理员保护。

`/auth/github/start` 和 `/auth/github/callback` 实现用户 authorization-code 登录；App manifest 注册 `/onboarding/github/callback` 和安装 `/onboarding/github/setup` 分别处理。OAuth state 与发起浏览器绑定，10 分钟过期，换 code 前事务消费，采用 S256 PKCE，固定回调地址。绑定既有账号由已登录会话通过 `POST /api/identity/github/bind` 发起，回调再次核对原会话。失败、重复、过期和冲突均显示确定错误，不能重新分配已绑定身份。用户 access/refresh token 和 PKCE verifier 使用 SecretBox 加密并绑定记录 AAD，读取接口不返回密文或明文凭据。

系统超级管理员在「全局设置 → 接入向导 → GitHub 登录」配置独立 OAuth App 的 Client ID 和 Client secret；回调地址取统一入口。部署地址始终可用于登录和写入，向导地址只增加可接受的 Origin。仓库 GitHub App 的选择与登录配置独立，仓库 App 凭据不会预填到登录表单。保存前保留原生效登录配置；升级前复用仓库 App 的登录明确提示迁移。配置与 secret 加密保存且不回读，保存立即生效；仅在没有向导配置时使用部署环境默认值。任何修改都会作废未完成的 OAuth state，并使派生授权等待重新验证；停用或更换 Client ID 还会清除用户 token 和 GitHub 身份会话。本地恢复账号、显式委派和原任务保留，停用配置在重启后仍有效。项目与组织管理员不能读取或修改此系统配置。具体操作见[接入向导](onboarding.md#github-用户登录)。

控制台的「身份与权限」显示身份状态、组织选择、角色、能力和每条授权来源。组织选择保存在服务端会话，后续列表、资源详情和写入按当前范围检查。可以重新验证 GitHub 权限或解除绑定；解除绑定结束使用该身份建立的会话，并撤销 GitHub 派生授权。已有本地账号和独立显式委派保留。

`GET /api/identity` 在 `github_connection` 中给出一句可展示的 GitHub 连接状态，以及对应的下一步。它和身份行上的「已验证」不是一回事：「已验证」只表示绑定仍有效。该字段区分：尚未连接、授权已失效、授权待验证、已连接且可访问 N 个已启动仓库、仓库已安装但尚未由管理员启动、已登录但还没有授权任何仓库。同时返回已启动且当前可访问的仓库名（`repositories`）以及已安装、本人有管理权但尚未启动的仓库名（`pending_repositories`）。项目列表用这个字段展示「等待管理员启动」，不打开 `/api/installations`，也不能自行启动。身份页同样列出这些仓库名。无法从已有记录可靠区分「App 没装到自己的仓库」和「装了但不是仓库 Admin」（安装属于整个部署），这两种情况同为 `no_repositories`，下一步同时提示去 GitHub 选择仓库、需要管理员权限，以及必要时联系管理员。响应不含凭据或授权证据原文。身份页默认只显示这句连接状态和对应的主按钮（连接 GitHub、去 GitHub 选择仓库、重新连接，或重新验证）；账户名、权限更新序号、授权来源和读取时间收在「高级／诊断」里，展开后一项不少。个人飞书绑定卡片留在身份页第一屏，不放进「高级／诊断」。若本部署已配置仓库 GitHub App，`install_url` 是该 App 在 GitHub 上公开的安装/选择仓库地址（`https://github.com/apps/<slug>/installations/select_target`；已存的 `/installations/new` 在读取时改写）；App 所有者的设置页、账号 ID 和 Webhook 地址仍只通过超级管理员的接入向导接口提供。


GitHub 登录后的页头显示 GitHub 用户名和头像，内部账号 ID 仍用于身份关联；本地密码会话保持本地登录名。全局设置的用户列表按与请求鉴权相同的范围和安装检查展示账号在全部组织中的当前可见项目，分别标明 GitHub 继承权限与 Bot 显式委派，并标注是否具有配置权限。过期、待验证和撤销的派生权限不计入有效项目；手工分配单独展示和编辑，未手工分配不代表没有 GitHub 继承权限。

## 权限来源和安装范围

| 当前证明 | 派生授权 |
| --- | --- |
| 个人安装目标本人 | 有效安装范围内项目管理 |
| 组织 owner，all 安装 | 租户 org_admin；仅覆盖有效安装中的项目 |
| 组织 owner，selected 安装 | 选中的已安装项目管理 |
| 仓库 admin | 对应已安装项目管理 |
| 仓库 Write、Maintain、Triage、Read | 不自动授予管理权限；可由 Bot 管理员显式委派 |
| 普通成员、历史 sender、requester | 不自动授予管理权限 |

独立 OAuth App 明确请求空 scope，用户 token 仅读取 `/user`；返回额外 scope 时拒绝保存与登录。权限核验使用另行签发的只读 GitHub App 安装令牌：读取安装详情和完整仓库列表，查询 `/orgs/{org}/memberships/{username}` 和 `/repos/{owner}/{repo}/collaborators/{username}/permission`，比对数字用户、组织和仓库 ID 后形成证明。临时安装令牌只申请 Metadata 读和安装已具备的 Members 读，查询结束后撤销。组织 owner 必须得到 `active/admin` 成员证明；App 自身全仓权限、安装事件和历史操作者不构成人类管理权限。权限计算与 #162 的安装状态、仓库范围和投影版本相交。暂时失败、SSO 或权限不足显示待验证，不能把失败推断成离职，也不能继续使用过期派生权限。

授权分为 `github_derived` 和 `explicit_delegation`，分别保存范围、能力、授权者、策略、证据、验证时间、有效期、撤销和安装版本。派生证明有效期 5 分钟，登录、显式刷新和写操作重新核验；若此时已有一次核验在进行，会等它结束后再发起一次新的核验，新核验若因并发版本变化未能落库则重试，避免沿用过期的授权截止时间。进程每分钟对账，安装领域事件由持久化游标消费。安装状态也在授权与 GitHub 请求检查，事件尚未被消费时仍不能绕过暂停或卸载。每轮核验按安装分别处理：已确认删除或暂停的安装，以及已确认不再具备的权限，对应派生授权被撤销；状态、安装范围或权限读取无法确定的安装，其派生授权只转为待验证，等下次证明恢复，不被撤销。造成不确定的安装和错误码记在身份的 `verification_issues`（不含凭据），全部确定后清空。

## 授权版本

principal 的 `authorization_revision` 只在账号失去原有有效权限时递增。判断比较变化前后实际可用的权限范围：已过期、待验证或撤销的授权不参与比较，平台角色或其他授权仍覆盖的能力不算失去；权限不变或只增加时版本不变。递增的情形包括停用账号、移除超级管理员、撤销委派或手工分配、解除身份绑定、GitHub 核验确认失去权限或转为待验证、安装变化使仍有效的派生授权失效，以及渠道员工、服务绑定停用或缩小范围。

授权版本只用于后台内容类场景：管理助手对话历史按版本分段，待发送渠道消息、群定时投递和管理命令按创建时的版本校验，任务来源与个人助手电脑的围栏随版本失效，GitHub 权限核验写入授权时用它做并发保护。失去权限后，这些内容不再沿用。需要反映新增权限的视图（如项目记忆可见范围）按当前有效授权计算，不依赖版本。后台执行身份（`resolvePrincipalActor`、`resolveServiceActor`）在版本变化后返回 `409 authorization_changed`，由调用方按当前权限重新解析。

网页控制台不比较会话的授权版本。写请求先重新核验 GitHub 权限，再在每次落库或调用 GitHub 前按最新有效权限判断：守卫对目标项目调用 `authorize`；请求期间版本变化时，下一次落库或 GitHub 调用前重放本请求已通过的授权检查和请求开始时的超级管理员身份，全部仍成立就继续，失去其中一项返回 `403`。账号或主体停用、会话过期或撤销返回 `401 login_required`。因此刷新页面或会话停留在旧版本不会导致写入失败，只有真实失去所需权限才会被拒绝。

平台超级管理员拥有恢复和显式委派管理能力，org_admin 与 project_admin 不会取得平台能力或无限转授能力。派生 owner 不提供 `grants.manage`，不能自授或互授把派生权限固化。显式委派 API 只接受委派者有权授予的能力和范围，禁止自授与平台能力注入。普通配置修改直接保存并审计，不引入默认人工审批。

## 服务端契约

`GET /api/repositories/:id/members` 是按项目过滤的只读授权投影，要求当前项目的 `tasks.read` 与 `config.write`。它只返回该项目或其组织范围内的授权摘要；组织级 GitHub 派生授权还须命中该安装的当前仓库范围。响应不包含身份凭据或授权证据原文，也不会开放组织级成员列表。`can_manage_legacy` 仅说明当前平台管理员能否使用原有项目分配接口，既有写入能力和服务端版本检查保持不变。项目详情返回 `can_configure`，供只读页面隐藏修改入口。

`src/identity/authorization.ts` 提供 `resolveActor(store, sessionRef, options)`、`authorize(actor, capability, resource)` 和 `listEffectiveScopes(store, principalId)`。ActorContext 字段为 `principal_id, tenant_id, project_id?, channel, capabilities, authorization_revision, request_id`。它由可信服务端建立；对象副本、浏览器 JSON、IM 文本或模型参数不能成为已认证 Actor。旧 Actor 由 `src/app/auth.ts` 适配，继续用于现有控制台服务。

能力包括 `tasks.read/tasks.write`、`roles.edit/roles.publish`、`knowledge.read/knowledge.write`、`schedules.manage`、`config.write`、`release.manage`；平台另外拥有授权管理能力。授权检查同时校验租户和项目归属。读取接口继续使用服务端范围过滤；写请求在事务开始或每次独立落库前、GitHub 请求发出前按当前授权检查（见[授权版本](#授权版本)）。异步人类任务与发布使用发起人的当前项目能力；新项目自动化使用独立 service principal、项目显式授权和组织维护归属，不借用创建人的个人 token。创建人停用后 service principal 可以继续按项目授权执行；缺少维护归属或项目授权时暂停。调度器、管理对话与 IM SDK 属于后续模块。

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
