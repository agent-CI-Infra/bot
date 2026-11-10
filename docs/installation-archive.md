# GitHub App 安装档案与同步

安装档案与项目启停、控制台角色分别保存。安装目标是 GitHub 数字账号 ID；`accounts.id` 仅是本机凭据配置 ID。当前支持 `github.com`，契约使用 `github_host + app_id + installation_id` 标识安装，仓库和人员使用 GitHub 数字 ID；名称只是显示快照。

在「全局设置 → 安装档案」查看有效、等待同步、暂停及卸载的安装。即使组织没有仓库也有档案。档案分别显示安装事件的目标、`sender` 和可空的 `requester`；缺少申请者不表示从未申请。当前采用的事件不能独立核实批准者时显示「批准者未知」，不生成 `approved_by`。`created` 动作及操作者可在事件索引中核对。REST 回填保留「历史证据缺失」，不补造过去的申请或批准历史，也不从全仓安装或历史 sender 派生管理员角色。

## 持久化与恢复

验签后的控制事件包括 `installation`、`installation_repositories` 和 `installation_target`。接收事务一起写入普通投递、独立永久事件、每次接收凭证、投影变更及同步请求，然后响应；接收路径没有 GitHub API 调用。无效签名不会写入安装档案。

`installation_events` 保存验签结果、来源 delivery/endpoint、接收时间、原始 bytes 的 SHA-256、操作者/申请者索引和处理结果。原始有效 bytes 与每次重复接收的原文使用 SecretBox 加密，AAD 绑定各自记录。普通投递只留档案提示，管理 API 和页面不返回原始 payload、私钥或 token。备份数据库时必须同时保护原有主密钥；密文不能脱离主密钥恢复。

事实事件按安装与 delivery 去重，跨 endpoint 和普通投递清理仍有效；重复接收单独留凭证。档案、独立仓库快照、处理尝试和领域事件没有指向项目、用户、凭据配置或普通 deliveries 的删除外键。删除项目或凭据不会删除这些审计关联。

`installation_sync_jobs` 是每份凭据配置的持久化同步意图。worker 每秒检查待处理、退避重试和过期租约；启动即恢复。租约 60 秒，GitHub 请求时续期；进程崩溃后由新 worker 接管，旧 lease token 不能提交。失败按连续尝试次数退避，最多 10 分钟；成功清空错误和退避计数。`installation_sync_attempts` 保留成功、失败、租约过期与被新版本替代的结果。

全量同步只在所有安装及仓库分页完整成功后提交。页格式错误、重复仓库 ID、仓库 owner 与安装目标不符、`total_count` 不一致、分页未结束、403、限流、超时和网络错误均保留最近成功快照，标记 `completeness=error`。失败不代表零仓库或卸载。定期每 10 分钟对账，补齐遗漏投递、新仓、改名、转移与权限变更；管理员可以手动请求同步。

## 撤销与并发

暂停、卸载、明确移出的仓库在 webhook 事务内阻断执行。`all → selected` 即使 removed 为空，也先阻断安装执行并安排全量重算。任务检查点与每次 GitHub 请求检查当前投影，已经创建的 GitHub 客户端也不能绕过撤销。

被阻断的任务停在 `waiting_permission`，错误码 `github_installation_access_revoked`。这是等待安装投影的状态，不需要人点「重试」：引擎每秒对账一次，仓库的当前投影重新允许执行（安装有效、`scope_pending=0`、仓库仍在安装范围内）时，把这些任务放回 `queued`，清掉错误码，并在任务日志写一条「安装同步已确认仓库可以执行，任务自动恢复排队」。范围核实（升级后的第一次同步、扩缩范围的 webhook）通常几十秒内结束，期间被停下的任务随后自动继续。对账只读数据库里的当前状态，所以同步完成于重启前、重启后，或任务是旧版本留下的，都按同一规则恢复。安装仍暂停、已卸载或仓库已移出时，任务继续等待。放回队列的任务照常经过检查点：管理员停用了项目或关闭了这类工作时，任务按原策略结束，恢复安装本身不会重新启用项目。

正向 webhook 不直接恢复执行；`created/unsuspend` 只留证据并排队。恢复暂停安装时额外读取 `GET /app/installations/{id}` 核实当前状态。删除后的同一 installation ID 是终态，新安装应使用 GitHub 新分配的 ID。同步提交检查 job generation、lease token 和 App 投影版本，覆盖“同步过程中撤权”和“同一 App 存在多份凭据配置”的竞态；无法提交的旧结果会留在待重读状态。

同步保留原来的 hidden、管理员停用状态、策略和项目记录，不自动启动全仓项目。仓库使用稳定 ID 更新名称和 owner。原有暂停/卸载 webhook 的项目停用行为保留；确认恢复安装后仍需管理员按原流程重新启用项目。GitHub 副作用仍使用 App 安装权限，安装档案不引入人类 user token 发布要求。

## 给身份与执行模块的契约 v1

`src/installations/archive.ts` 导出 `InstallationRef`、`InstallationSnapshot`、`InstallationDomainEvent` 和 `InstallationArchive`。以下方法只接受可信服务端会话引用，不接受客户端自报角色：

| 方法 | 输入与结果 |
| --- | --- |
| `getInstallationSnapshot(sessionRef, ref)` | 核验整个安装目标的当前访问关系后返回目标、状态、完整性、范围、permissions/events、投影/范围/权限版本、最近成功时间、错误和证据摘要；尚未同步返回完整的 pending 契约 |
| `listInstallationRepositories(sessionRef, ref)` | 重新核验关系，按已核实的 repository IDs 过滤，返回仓库 ID/名称/owner/私有标志/present/最近成功时间及状态、完整性、三个版本；范围受限的用户不能读取安装级证据 |
| `requestInstallationSync(sessionRef, ref)` | 重新核验当前管理权限，事务排队，返回 `contract_version,status,generation`；webhook 尚未到达也可通过已配置的 App 请求同步 |

`InstallationIdentity.verifyInstallation(sessionRef, ref)` 是 #163 的接入点。它必须通过官方接口核实当前 GitHub 用户与安装/仓库关系，返回 `github_user_id,target_id,repository_ids,can_manage,authorization_revision`；`repository_ids=null` 只代表已验证整个目标账号的范围，数组代表经验证的仓库子集。适配器由服务端注入，默认缺省时拒绝范围披露。历史 sender、Setup 参数、本机凭据账号和普通控制台登录均不能替代这个验证。当前管理 HTTP API 只向原有超级管理员开放；项目管理员默认不能读取安装级档案，后续身份模块按核实范围接入服务方法。

`installation.changed` 与 `installation.access_revoked` 在状态事务内写入独立领域事件表。事件字段为 `contract_version,event_id,type,tenant,installation,projection_version,scope_version,permissions_version,status,repository_ids,actor_ref,occurred_at,source`。`tenant.account_id` 是 GitHub 安装目标 ID；未核实的人类操作者引用为 null。`repository_ids=[]` 的撤销表示整个安装范围需重新核验。可信下游 worker 用 `readInstallationDomainEvents(store, after, limit)` 按持久化 sequence 重放，保存自己的游标并按 event_id 幂等消费；执行前仍检查最新投影，不只依赖通知。该函数不直接暴露为租户 HTTP API。

## 三类回调

App manifest 注册回调仍是 `/onboarding/github/callback`；新增 Setup URL 为 `/onboarding/github/setup`，用户 OAuth 回调属于 #163，三者分别处理。新 manifest 带独立 setup_url，向导生成的安装链接带随机 state，状态保留 30 分钟。

`InstallationSetup.begin(accountId, expectedTargetId?)` 创建持久化意图；向导传入已核实的目标账号 ID，后续归属验证必须匹配。#163 在核验自己的 OAuth state 后调用 `bindIdentity(state, identitySessionRef)`，该方法不公开为接受 user ID 的 HTTP 接口。Setup 的 installation_id 只绑定查找目标，首次绑定后不能换成另一个 ID；身份与安装 ID 的首次绑定都在事务中完成。`callback(state, installationId, setupAction)` 和 `resume(state)` 返回 `waiting_identity`、`waiting_setup`、`waiting_approval`、`waiting_sync`、`ready` 或 `access_revoked`，归属验证失败返回 403。状态可以在 OAuth、Setup、webhook 的任何先后次序下重入；重复回调依附已有同步，不持续增加代次。待批准请求不生成有效安装。#163 尚未接入时，Setup 安全地停留在 waiting_identity，不要求重新安装。

GitHub 明确指出 Setup 的 installation_id 可被伪造，必须核实当前用户关系，见[Setup URL 文档](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)。事件字段及 all→selected 的空 removed 语义见[Webhook 事件文档](https://docs.github.com/en/webhooks/webhook-events-and-payloads)。

## 运维与验证

查看档案 `GET /api/installations/archive`；详情 `/api/installations/archive/:host/:appId/:installationId`，附加 `/repositories` 或 `/events` 读取范围或证据索引，`POST .../sync` 请求持久化重读。删除凭据后仍可看历史，重读返回 `installation_credentials_missing`。

故障排查先查看 `completeness,last_success_at,error`，再核对 job 的 state/generation/lease_until 与 attempts 的结果。不要为重试清空永久事件、修改 tombstone 或重新安装。补齐凭据/网络后手动同步，或者等待 worker 的退避重试。现有安装升级后先处于 pending_sync 并等待启动对账，历史操作者保持未知。

```sh
npm ci
npm run check
mkdir -p .tmp
TMPDIR="$PWD/.tmp" SQLITE_TMPDIR="$PWD/.tmp" npm test
node test/installation-archive-docker.mjs
```

Docker 验收使用一次性的 `bot-install-archive-162-*` 项目、独立镜像与随机 localhost 端口，真实控制面和浏览器配本地 GitHub 分页固件，覆盖容器重启、失败恢复及未知项展示。脚本仅清理本次项目及其卷，不替换既有部署或共享 local 镜像标签。浏览器使用 Playwright 已安装的 Chromium；产物在 `.tmp/install-archive-162/docker/`。真实 GitHub 登录与当前权限验证的集成留给 #163，本模块的适配器测试不冒充真实 OAuth 验收。
