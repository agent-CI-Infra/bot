# 部门公共 Bot

一个 Node.js 22.13+ / TypeScript 控制面，使用系统内账号管理多个 GitHub App、机器人账号、仓库权限、模型配置和 Webhook 投递。许可证为 Apache-2.0。

当前提供多账号控制面、每仓库一个长期 Docker 环境，以及可读代码、运行命令和修改文件的检视／开发 Agent。没有内置账号或仓库；开启仓库检视后接收事件并创建任务，满足开发条件时自动实现、测试、发布 bot 分支和 PR。`/api/status` 的项目环境、检视、开发及模型调用能力均可用；具体任务缺配置或失败会显示故障状态。

## Docker 部署

安装 Docker Engine 和 Compose，然后在仓库根目录运行：

```sh
docker compose up --build -d
docker compose ps
```

打开 <http://127.0.0.1:8792/>，创建第一名超级管理员。初始化只允许成功一次，重启不会重新开放。用户名和密码属于本系统；密码长度为 12–256 字符，使用随机盐的 scrypt 慢哈希保存。先完成初始化，再将入口开放给其他人。

`8791` 是 Webhook 接收入口，宿主端口默认绑定 `0.0.0.0`，对所有 IPv4 网卡开放；`8792` 是管理页面和管理 API，仍仅绑定宿主回环地址 `127.0.0.1`，只在本机访问。管理员可在机器人账号页面登记账号，取得 `/hooks/github/<account_id>/<endpoint_id>`，通过自己的 HTTPS 反向代理将 GitHub Webhook 路由到 `8791`。不要把两个监听端口混接。可用 `BOT_WEBHOOK_PORT`、`BOT_ADMIN_PORT` 调整宿主端口。需要远程访问管理页面时，另行配置独立的 HTTPS 反向代理，并设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN` 为自己的管理站 origin；这些变量通过 Compose 环境传入，不包含上游凭据。管理 API 不开放跨域访问。

Compose 包含长运行的 `bot` 和 `manager`，以及一次性的 `key-init` 与 `project-image`。`project-image` 仅确保批准的项目镜像已构建，不是某个仓库的长期环境。manager 按仓库创建动态项目容器，项目容器不属于 Compose 静态服务，不对宿主或公网发布端口。

`bot-data` 保存控制面 SQLite，`bot-keys` 保存加密主密钥，仅 bot 可读；`internal-keys` 保存 bot 与 manager 的内部认证，manager 不挂载上游凭据或控制面数据库。`manager-data` 保存环境和操作账本。每个环境代次拥有独立具名工作卷和内部网络，标签同时绑定部署、仓库 ID、代次和资源类型。部署 ID 从独立内部认证材料派生，不同部署不会共用资源名。

只有 manager 挂载 Docker socket；它以 UID 0、GID 10001 访问 socket 和只读内部认证卷，丢弃所有 capabilities、禁止提权、根文件系统只读。Docker socket 本身仍赋予 manager 管理宿主 Docker 的能力，因此不对宿主发布 manager 端口，也不向项目网络提供该接口。它只接受登记项目的固定生命周期和 runner 请求，不能指定任意镜像、挂载、容器 ID 或 Docker API。bot 和项目容器没有 socket，项目容器也不挂载任何认证卷。bot／manager 使用独立控制网络，项目之间使用各自独立的内部网络；当前项目没有外网出口。

备份前停止 bot 和 manager，并备份四个部署卷及项目具名卷；数据库停止写入后再复制，恢复时使用同一套内部认证和管理账本。丢失主密钥会无法解密凭据，丢失内部认证会改变部署 ID，不能用新的空账本直接接管旧容器。`docker compose down` 保留卷；`--volumes` 会删除部署认证和账本，日常升级不要使用。动态项目资源需要通过环境接口管理，Compose down 不会直接删除它们。

## 使用与权限

超级管理员登记 GitHub App（App ID、RSA 私钥）或机器人账号（Token），为入口保存签名凭据，然后登记需要启用的 GitHub 仓库 ID、owner/repo、所有者 ID 和关联账号。当前由管理员显式登记仓库，尚未定期自动同步安装列表。任务执行时校验账号、实际仓库 ID 和所有者；App 在控制面签发 JWT、取得目标仓库安装令牌，机器人账号使用已保存的 Token，均不进入项目环境。仓库 ID 使用字符串提交，避免 JavaScript 大整数丢精度。

超级管理员可创建用户和分配项目管理员。每名项目管理员可分配多个仓库，每个仓库可有多名项目管理员。项目管理员只看到并操作自己的仓库、投递、模型、策略及任务读取接口；无筛选查询同样受限，未关联仓库或验签失败的投递仅超级管理员可见。账号凭据、全局用户和授权关系接口只允许超级管理员调用。用户停用会撤销已有会话，仓库分配调整在后续请求立即生效；不能停用最后一名超级管理员。

模型配置包含接口 URL、API Key、模型名。超级管理员可管理全部模型；项目管理员可为自己的仓库创建和更新模型。部署共享模型由超级管理员通过 `models/:id/projects` 指定可用仓库，项目管理员只能读配置状态、选用，不能修改共享模型。仓库策略保存选用的模型 ID。保存即信任，可以发送本项目代码、日志和测试材料，不增加数据授权等待状态。接口采用兼容 Chat Completions 的 JSON 工具调用协议；URL 可填写基础路径或完整 `/chat/completions` 路径，基础路径会自动追加该后缀。没有模型配置、撤销 Key、认证失败会显示 waiting_configuration；网络／限流故障退避重试，持续故障停止任务。

账号凭据、入口签名材料和模型 Key 用 AES-256-GCM 加密，密文绑定记录 ID。读取和写入响应均只返回是否已配置，不返回明文或密文。更新时留空或仅空白的凭据保持原值；撤销使用专用动作，不能靠提交空字符串撤销。模型 PATCH 必须带读取到的 `version`，旧版本返回 409。撤销账号凭据不会连带撤销入口签名；要禁用入口需单独撤销该入口。

浏览器管理入口支持初始化、登录、投递列表与详情、项目环境（虚拟电脑）列表与详情及启动／停止／重置，检视和开发两个独立任务页，以及账号／仓库／模型／用户新增。任务详情按时间线展示 Agent 工作过程：工作区准备、每一步模型思考与工具选择、读写的文件、在项目容器中执行的命令及退出码和输出、GitHub 发布和故障；运行中每 2 秒刷新。任务详情旁显示所用的虚拟电脑，即该仓库的长期项目容器：容器、代次、资源与网络限制，并可直接启停或重置。虚拟电脑详情列出卷、网络、镜像、正在执行的任务、最近任务和最近执行的命令。授权分配调整、策略更新、凭据轮换及撤销通过下列管理 API 完成；这些操作尚未提供完整表单。投递页支持仓库、账号和组织 ID 过滤及分页；项目管理员不显示账号管理入口。

## 接口

除初始化状态、初始化、登录和健康检查外，管理 API 都需要登录会话。登录／初始化响应设置 `HttpOnly; SameSite=Strict` Cookie，并返回 `csrf_token`；之后的写请求必须提供同值 `X-CSRF-Token` 和 `Content-Type: application/json`。登录后 `GET /api/auth/me` 可读取当前会话的 CSRF 值。接口不接受额外字段，不支持传入 `role` 将自己升级。HTTP 失败只返回稳定错误码，不回显输入或内部异常。

| 路径 | 方法 | 功能和范围 |
| --- | --- | --- |
| `/healthz` | GET | 两个监听端口的数据库健康检查 |
| `/api/setup` | GET / POST | 初始化状态／仅首次创建超级管理员，POST 字段 `username,password` |
| `/api/auth/login`、`/api/auth/logout`、`/api/auth/me` | POST / POST / GET | 登录、退出、会话与仓库权限 |
| `/api/users`、`/api/users/:id` | GET / POST、PATCH | 超级管理员列出／创建用户、停用或启用；创建可带 `role,repository_ids` |
| `/api/project-admin-assignments` | GET / PUT | 超级管理员查询／替换用户仓库分配，PUT 字段 `user_id,repository_ids` |
| `/api/accounts`、`/api/accounts/:id` | GET / POST、GET / PATCH | 超级管理员管理 GitHub App／机器人账号；POST 字段 `name,type,app_id,private_key,token,webhook_secret` 按账号类型选用 |
| `/api/accounts/:id/credentials/revoke` | POST | 超级管理员撤销账号认证材料 |
| `/api/accounts/:id/endpoints`、`/api/accounts/:id/endpoints/:endpoint` | POST、PATCH | 创建签名入口／轮换签名材料；PATCH 带 `webhook_secret` 或 `revoke:true` |
| `/api/repositories`、`/api/repositories/:id` | GET / POST、GET | 范围内列表／详情；创建仅超级管理员，字段 `id,full_name,owner_id,account_id` |
| `/api/repositories/:id/policy` | GET / PATCH | 范围内策略，字段 `model_id,review_enabled,development_enabled,enabled,test_command,base_branch,max_revisions,review_label`；选择模型、启用检视／开发、指定必需测试和跟进预算；基准分支留空时读取仓库默认分支；`review_label` 为可选标签名（最多 50 字符），留空不打标签 |
| `/api/environments`、`/api/environments/:id` | GET | 按账号、组织 ID、仓库过滤环境；项目管理员无筛选也只见被分配仓库。列表带当前执行任务；详情另含 manager 给出的容器／卷／网络／镜像／资源限制、当前任务、最近 20 个任务和最近 30 条命令 |
| `/api/environments/:id/start`、`/stop`、`/reset` | POST | 仓库管理员操作；字段 `operation_id,generation`，操作 ID 为 48 位随机十六进制；重试必须复用同一 ID |
| `/api/environments/:id/delete` | POST | 仅超级管理员，另需 `confirm:true`；删除容器／网络，保留卷 |
| `/api/models`、`/api/models/:id` | GET / POST、GET / PATCH | 范围内模型，字段 `repository_id,api_url,api_key,model_name`；PATCH 带 `version` |
| `/api/models/:id/projects`、`/api/models/:id/credentials/revoke` | PUT、POST | 超级管理员分配共享模型；有权编辑者撤销模型 Key |
| `/api/events`、`/api/events/:id` | GET | 范围内投递列表／正文和响应；列表可筛选 `repository_id,account_id,owner_id,event,status,delivery_id,limit,offset` |
| `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/logs` | GET | 范围内任务列表、结果、发布回执和带时间的过程日志；支持 `kind=review|development`、仓库／账号／组织过滤及分页。日志包含模型每步的思考摘要、工具调用与结果（长文本截断），不返回认领令牌或原始模型会话 |
| `/api/tasks/:id/retry` | POST | 有权项目管理员重试故障任务；发布未知时仍先对账，不直接重复 POST |
| `/api/audit`、`/api/status` | GET | 范围内最近 100 条操作审计／当前能力状态 |
| `/hooks/github/:account/:endpoint` | POST | 仅 Webhook 端口，按已登记入口验签和归档 |

Webhook 对原始字节计算 HMAC-SHA256 并以恒定时间比较，验签后才解析和关联仓库。签名错误返回 401，未知入口返回 404，非法 JSON 返回 400，超过 2 MiB 返回 413（归档截断正文并标记不完整）。请求头中的认证、签名和 Cookie 等内容脱敏。请求正文、响应记录和 `(account_id,endpoint_id,delivery_id)` 去重键在同一个 SQLite `BEGIN IMMEDIATE` 事务提交后才返回成功；写库失败返回 503 且回滚去重。重复投递保存独立档案，响应标记 `duplicate:true`。失败投递不消费去重键，重试可成功。空仓库配置和未登记的仓库只归档，不自动登记仓库或生成任务。

## 仓库自动化规则

PR 门禁、标签规范和合并队列是仓库策略，不写进每个仓库的 GitHub Actions：`src/automation/` 提供规则引擎和内置模块（`label-lint`、`pr-status`、`gate`、`merge-queue`）。每个仓库用 `config/repositories/<owner>__<repo>.yml` 声明自己的标签轴、门禁、合并策略和 CI 阶段（仓库示例见 [Jianyu010__PPMA.yml](config/repositories/Jianyu010__PPMA.yml)），policy 的 `automation` 字段仍可覆盖，默认 dry-run、默认不自动合并。webhook 落库时规划动作并写入 `automation_runs`，执行器接入 outbox 后再产生真实写入。配置 schema 与新增模块的步骤见 [docs/automation.md](docs/automation.md)。

## 源码与验证

`src/main.ts` 是控制面入口，`src/server.ts` 分离管理与 Webhook 两个监听。`src/app/` 保存账号、登录、仓库授权、模型和投递归一化逻辑，`src/core/security.ts` 提供验签、慢哈希和凭据加密，`src/storage/database.ts` 管理 SQLite、事务及审计；`static/` 是同一管理入口。`src/agent/` 保存模型循环、任务认领及恢复，`src/review/` 保存触发和位置校验，`src/github/` 保存授权读取及发布 outbox。`src/projects/` 是环境网关，`manager/` 管理受管 Docker 资源，`runner/` 是容器内命令／文件协议，`images/project/` 构建批准镜像。manager／runner 独立实现，保留 Apache-2.0 及 NOTICE 中的上游设计归属，不携带完整员工平台。

验证需要 Node.js 22.13+ 和 npm；这些是源码检查命令，部署仍使用上面的 Docker 方式。

```sh
npm ci
npm run check
npm test
docker compose config --quiet
```

`npm test` 覆盖并发初始化只成功一次、重启、权限收回、跨项目列表／详情／日志／模型隔离、凭据加密及不回显、验签、事务回滚重试、重复投递、先落库再确认和空配置不执行。SQLite 使用 Node 内置 `node:sqlite`，Node 22 会显示实验特性提示。

浏览器验收使用固定在 lockfile 的 Playwright，先运行 `npx playwright install chromium --only-shell`，再执行 `npm run test:e2e`；测试在自己的临时 SQLite 和随机端口上启动服务，覆盖初始化、登录、登记账号、查看签名投递、项目权限以及宽屏／窄屏页面，不占用部署数据或固定试用端口。输出放在忽略提交的 `.tmp/`。

## 项目环境生命周期

新增仓库默认启用，后台登记一个环境；创建与周期对账均按仓库 ID 幂等，不随 Issue 或 PR 结束而删除。启动和后续命令复用同一容器及卷。同仓库的生命周期和执行请求持有同一串行锁，不同仓库可并行；命令退出、超时或输出超限时清理进程组，并在释放锁前停止／启动同一个容器、重新检查 runner，清除另建会话的守护进程；卷和 generation 保持不变。测试服务与测试请求应放在同一个命令中，后台服务不跨命令保留。

停止会将仓库 enabled 设为 false，停容器并保留卷；再次启动复用原代次和数据。签名可信的 App 卸载／暂停事件按账号和所有者范围停用，移除仓库事件按账号和仓库 ID 停用；这些意图随投递事务保存，再由后台停止环境，不在 webhook 响应链路调用 Docker。安装范围完整同步仍属后续工作。

重置先停止所有旧代容器并确认不再运行，然后增加 generation、保存旧卷，创建新代容器、新卷和新网络。失败进入 reset_failed，禁止普通启动旧环境，必须显式重试重置。删除默认只删除受管容器和网络，保留卷；停用和卸载不会删除资源。旧代容器始终停止，旧卷仅保留待备份／清理，不挂到新项目环境。

manager 重启会先停止不确定的执行，标记未完成操作 interrupted，再用同一代容器和卷检查 runner／journal 后恢复 ready；重置中断则保持 reset_failed。运行期发现容器重启或退出同样重新恢复，不以 Docker running 代替 ready。操作 ID 持久化去重，代次检查阻止旧请求写新环境，状态 revision 防止旧响应覆盖新状态。控制面保存操作意图并以原 ID 重试丢失响应，不自动重复重置。

当前 runner 为无网络监听的一次性固定执行入口：manager 通过 Docker exec 发送校验后的请求，返回 JSON 与持久 journal，调用者不能指定 exec argv 或用户。支持工作区相对文件读取／写入和最长 60 秒的 shell 命令；单次写入 48 KiB、读取 1 MiB、命令输出 1 MiB。项目运行用户为 10001，根文件系统只读，工作卷可写，CPU／内存／PID 限制固定；项目镜像提供 Node、Git 和 shell，Git 操作在容器内执行。任务工具支持隔离工作目录、分块文件与 Git 候选；上游 API 认证始终由控制面代理。执行入口仅供内部控制面和验收调用，管理页面没有通用终端。

实际 Docker 验收运行 `npm run test:docker`，需要 Docker 和上述 Playwright 浏览器。它使用独立 Compose 项目和 18881／18882／18883 测试端口，18883 仅在测试覆盖文件里映射 manager；生产 Compose 不发布该端口。测试会检查两个真实环境、串行与并行、文件／卷／网络隔离、无凭据、代次重置、重启和角色页面，并按本次部署标签清理容器、网络及卷。输出保存在 `.tmp/project-env/`。

## 检视与开发数据流

在仓库 policy 中选择 `model_id`，打开 `review_enabled`，需要自动实现时再打开 `development_enabled`，建议设置可信的 `test_command`。Issue 只在 opened 时检视一次；PR 在 opened、ready_for_review、synchronize 且非草稿时检视当前 head。普通评论、编辑和重新打开不额外触发。未启用检视的仓库只归档，草稿不建检视任务。投递去重和任务逻辑去重独立；归档、去重与入队在同一事务提交后才确认成功。

后台按仓库串行认领任务，拉取本仓 Issue／PR、讨论、完整分页 diff 与固定 SHA 的代码材料。已保存模型只收到这个项目的上下文，并可调用 read_file、write_file、run_command 等受任务约束的工具。仓库材料属于不可信输入，不能修改权限、镜像、发布目标或认证。单个任务最多 16 次模型响应，工具命令限时 60 秒；临时调用失败最多重试 5 次，配置故障单独显示。

每次检视发布一条总结讨论评论，包含总结、非行内 finding 和检视 SHA。Issue 只用普通评论。PR 每条 finding 由模型选择普通评论或行内评论并给出理由，服务端用真实 diff 校验 path／line／side；缺少可核对位置时转普通评论，不猜行号。行内 Review 的 event 恒为 COMMENT，模型不能选择批准或请求变更，没有自动合并接口。发布前重新检查 head，过时任务标为 superseded；评论写明实际检视 SHA，Review 和每条行内评论的 GitHub ID 保存到任务回执。policy 设置了 `review_label` 时，总结评论发布成功后由控制面用同一安装令牌给 Issue／PR 加这一个标签，仓库没有该标签时由 GitHub 创建；标签不由模型选择，重复执行不会重复添加。

Issue 检视结果明确要求代码变更、存在原文证据且无需补充信息时，若仓库打开开发，创建关联开发任务。在同一项目容器的新任务工作目录中修改代码，模型完成后服务端再次运行仓库指定测试；未配置固定测试时使用模型给出的测试命令，不能没有测试。失败不会推分支或开 PR。成功后检查测试前后候选 tree 一致，再由控制面发布唯一 `bot/issue-...` 分支，并创建 PR、回填链接。默认分支从 GitHub 元数据或仓库 policy 获取，不写死。

别人的 PR 只检视，不产生向作者分支提交的任务；分支名或机器人名称不能代替归属记录。由本系统创建的 PR 保存不可变 PR ID、作者、head 仓库、分支和发布 SHA，只有这些身份仍匹配、策略允许且确有修改项时才在原分支跟进。跟进默认最多 3 轮，可在 policy 的 max_revisions 中设置 0–10；不另开 PR，不强推，不自动合并。

## 无凭据代码代理与发布

当前采用 Git 数据 API 的有界快照传输：控制面读取固定 commit 的 tree/blob，经 manager 将文件分块交给 runner；runner 校验 blob 与源 tree，构建本地 Git 快照。它不是完整上游历史克隆，模型上下文和评论覆盖说明明确标识这一点。单文件最多 1 MiB，快照最多 2000 文件／32 MiB，超限、子模块或截断 tree 进入明确故障，不用不完整工作区开发。二进制和符号链接按 Git 对象处理，相对文件工具不跟随越界符号链接。

开发候选由容器内 Git 生成，控制面保存候选 tree、文件清单、测试输出与本地提交映射，经 Git 数据 API 上传 blob/tree/commit。只有 GitHub 返回 tree 与已验证候选完全一致，才创建或更新登记的 bot 分支。更新固定 force:false；未知或变化的分支 head 会阻止发布。容器里没有 GitHub remote 认证、私钥或模型 Key；控制面不运行仓库 shell 或 git 命令。真实仓库访问仍需为 App／账号提供相应 Contents、Issues 和 Pull requests 权限。

评论、Review、分支和 PR 都有持久 outbox。请求结果未知时按任务 marker、head 和远端对象先对账；未能确认就保持 waiting_publication，不盲目重复。控制面重启后恢复未完成阶段，已完成任务不重新入队；manager 中断的命令不当作通过，重新检查环境后在新 attempt 工作目录继续，旧目录保留。同代已完成工具通过原操作 ID 回放，generation 变化会阻止旧任务直接写入新环境。

## 验证与当前限制

`npm run test:agent` 使用假 GitHub、假模型和真实项目容器验收完整旅程，包括 Issue 到 bot PR、草稿忽略、COMMENT 行内评论、别人 PR 不推送、bot PR 跟进、重复投递／未知响应对账、测试失败、tree 不一致、配置故障、manager 中断恢复、凭据隔离及任务页面角色范围。浏览器使用 lockfile 中的 Playwright。测试端口 18891–18894，与部署和人类试用数据隔离，结束后清理测试容器、网络和卷；产物放 `.tmp/review-dev/`。

尚未接入完整安装列表同步、Git smart HTTP／完整历史传输、子模块／LFS 和长命令跨重启续跑。项目当前没有外网出口，因此需要下载依赖或访问外部测试地址的任务会显示实际失败，受控依赖出口和更多开发工具链仍需后续配置。命令输出在命令结束后出现，不是逐行流式。策略编辑和部分授权管理继续通过已有管理 API 完成。没有聊天、图形桌面、浏览器接管或远程桌面能力。
