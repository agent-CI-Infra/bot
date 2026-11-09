# GitHub 登录与统一授权

## 当前行为

一个租户对应 `github.com` 上的一个数字 owner account ID，一个项目对应数字 repository ID。名称用于展示，改名不会合并或重建身份。GitHub 身份以 provider、host 和数字 user ID 关联；同名、同邮箱的本地账号不会自动合并。首次部署仍先初始化本地超级管理员，GitHub 新账号始终从无平台权限的项目用户开始。本地登录是原有超级管理员的恢复入口，保留密码、限流、CSRF 和最后一名超级管理员保护。

`/auth/github/start` 和 `/auth/github/callback` 实现用户 authorization-code 登录；App manifest 注册 `/onboarding/github/callback` 和安装 `/onboarding/github/setup` 分别处理。OAuth state 与发起浏览器绑定，10 分钟过期，换 code 前事务消费，采用 S256 PKCE，固定回调地址。绑定既有账号由已登录会话通过 `POST /api/identity/github/bind` 发起，回调再次核对原会话。失败、重复、过期和冲突均显示确定错误，不能重新分配已绑定身份。用户 access/refresh token 和 PKCE verifier 使用 SecretBox 加密并绑定记录 AAD，读取接口不返回密文或明文凭据。

系统超级管理员在「全局设置 → 接入向导 → GitHub 登录」配置同一 App 的 Client ID、Client secret 和管理 origin。部署地址始终可用于登录和写入，向导地址只增加可接受的 Origin。选择不同 App 时显示它的凭据草稿，保存前保留原生效登录配置。配置与 secret 加密保存且不回读，保存立即生效；仅在没有向导配置时使用部署环境默认值。任何修改都会作废未完成的 OAuth state，并使派生授权等待重新验证；停用或更换 Client ID 还会清除用户 token 和 GitHub 身份会话。本地恢复账号、显式委派和原任务保留，停用配置在重启后仍有效。项目与组织管理员不能读取或修改此系统配置。具体操作见[接入向导](onboarding.md#github-用户登录)。

控制台的「身份与权限」显示身份状态、组织选择、角色、能力和每条授权来源。组织选择保存在服务端会话，后续列表、资源详情和写入按当前范围检查。可以重新验证 GitHub 权限或解除绑定；解除绑定结束使用该身份建立的会话，并撤销 GitHub 派生授权。已有本地账号和独立显式委派保留。

## 权限来源和安装范围

| 当前证明 | 派生授权 |
| --- | --- |
| 个人安装目标本人 | 有效安装范围内项目管理 |
| 组织 owner，all 安装 | 租户 org_admin；仅覆盖有效安装中的项目 |
| 组织 owner，selected 安装 | 选中的已安装项目管理 |
| 仓库 admin | 对应已安装项目管理 |
| 普通成员、历史 sender、requester | 不自动授予管理权限 |

先以用户 token 读取 `/user`、`/user/installations`、用户可访问的安装仓库，再读取当前组织成员角色。所有分页完整成功才能形成证明。组织 owner 必须得到 `active/admin` 成员证明；App 自身全仓权限、安装事件和历史操作者不构成人类管理权限。权限计算与 #162 的安装状态、仓库范围和投影版本相交。暂时失败、SSO 或权限不足显示待验证，不能把失败推断成离职，也不能继续使用过期派生权限。

授权分为 `github_derived` 和 `explicit_delegation`，分别保存范围、能力、授权者、策略、证据、验证时间、有效期、撤销和安装版本。派生证明有效期 5 分钟，登录、显式刷新和写操作重新核验；进程每分钟对账，安装领域事件由持久化游标消费。安装状态也在授权与 GitHub 请求检查，事件尚未被消费时仍不能绕过暂停或卸载。授权变化递增 principal 的 `authorization_revision`，陈旧写请求返回 `409 authorization_changed`；客户端读取 `/api/auth/me` 更新会话后，仍按最新真实能力判断。

平台超级管理员拥有恢复和显式委派管理能力，org_admin 与 project_admin 不会取得平台能力或无限转授能力。派生 owner 不提供 `grants.manage`，不能自授或互授把派生权限固化。显式委派 API 只接受委派者有权授予的能力和范围，禁止自授与平台能力注入。普通配置修改直接保存并审计，不引入默认人工审批。

## 服务端契约

`src/identity/authorization.ts` 提供 `resolveActor(store, sessionRef, options)`、`authorize(actor, capability, resource)` 和 `listEffectiveScopes(store, principalId)`。ActorContext 字段为 `principal_id, tenant_id, project_id?, channel, capabilities, authorization_revision, request_id`。它由可信服务端建立；对象副本、浏览器 JSON、IM 文本或模型参数不能成为已认证 Actor。旧 Actor 由 `src/app/auth.ts` 适配，继续用于现有控制台服务。

能力包括 `tasks.read/tasks.write`、`roles.edit/roles.publish`、`knowledge.read/knowledge.write`、`schedules.manage`、`config.write`、`release.manage`；平台另外拥有授权管理能力。授权检查同时校验租户和项目归属。读取接口继续使用服务端范围过滤；写请求在事务开始或每次独立落库前检查当前版本，GitHub 请求发出前再检查。异步人类任务与发布使用发起人的当前项目能力；新项目自动化使用独立 service principal、项目显式授权和组织维护归属，不借用创建人的个人 token。创建人停用后 service principal 可以继续按项目授权执行；缺少维护归属或项目授权时暂停。调度器、管理对话与 IM SDK 属于后续模块。

`src/identity/bindings.ts` 提供 `beginExternalBinding`、`completeExternalBinding`、`revokeExternalBinding`、`resolveExternalPrincipal`。服务端接入方构造 `ExternalBindings(store, verifier)`，verifier 只接受渠道侧已校验的可信证明。challenge 绑定平台会话、平台租户、provider/host、connector、外部租户、外部 actor 和 5 分钟有效期。完成时核对双方证明，事务内消费并建立唯一映射；相同完成幂等，转发、跨租户、冲突、过期和不同证明重放拒绝。撤销保留归属与审计并立即失效旧 Actor。该服务没有接受自填 open_id 的 HTTP 接口，不包含飞书 SDK 或绑定交互。

`GitHubIdentity` 实现 #162 的 `InstallationIdentity`：官方用户安装、仓库与成员 API 核实后，目标 owner 可读安装快照，受限用户仅能读取经核实的仓库子集；同步还要求当前管理能力。安装 Setup 状态由经过用户 OAuth 验证后的不透明会话引用关联，Setup 查询参数不能指定人类身份。

## 发布语义

保留 #148：有效控制台项目管理员可以发起发布，不额外要求个人 GitHub 写权限。标签、Release 和其他项目副作用继续使用 App installation token。用户 token 仅用于登录与权限证明，不进入模型上下文。App 暂停、卸载、仓库移出或安装范围待核实时禁止执行；人类发布者被撤权后，后续发布检查点也拒绝继续写入。

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

官方协议参考：[GitHub App 用户授权与 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[用户可访问的安装](https://docs.github.com/en/rest/apps/installations)、[组织成员角色](https://docs.github.com/en/rest/orgs/members)。
