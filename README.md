# 部门公共 Bot

部门公共的 GitHub App 检视和开发 bot。一个控制面负责管理页面、接收 GitHub Webhook 和调度任务；每个启用的仓库各有一台长期运行的 Docker 容器（下文称“虚拟电脑”），bot 在里面读代码、跑命令。新开的 Issue 和 PR 会收到一条检视总结评论；打开自动开发后，明确要求改代码的 Issue 由 bot 实现、测试并开 PR。许可证为 Apache-2.0。

## 快速上手

准备：

- Docker Engine 和 Docker Compose v2（`docker compose version` 能输出版本）。
- 一个 GitHub 组织，以及能在其中创建和安装 GitHub App 的账号（组织所有者或 GitHub App 管理员）。
- 一个公网 HTTPS 入口，让 GitHub 能把 Webhook 送到这台机器：自己的域名加 HTTPS 反向代理，或者 Cloudflare Tunnel。
- 一个兼容 Chat Completions 的模型：接口 URL、API Key 和模型名。

**1. 启动。** 不需要克隆仓库，也不在本机构建：

```sh
mkdir department-bot && cd department-bot
curl -fsSLO https://raw.githubusercontent.com/agent-CI-Infra/bot/main/compose.pull.yaml
docker compose -f compose.pull.yaml up -d
```

然后在这台机器的浏览器打开 <http://127.0.0.1:8792/>。Bot 装在远程服务器上时，先 `ssh -L 8792:127.0.0.1:8792 <服务器>`，再在自己电脑上打开同一地址；需要长期远程管理时，另做一个 HTTPS 反向代理，并设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN`（见[端口与环境变量](#端口与环境变量)）。镜像发布在 GHCR，匿名拉取要求这些包已公开；如果拉取报 `denied` 或 `unauthorized`，可以克隆本仓库，在根目录用 `docker compose up --build -d` 从源码构建（见[镜像与两份 Compose](#镜像与两份-compose)）。

**2. 创建超级管理员。** 首页显示「创建第一名超级管理员」：填用户名和 12–256 位密码，点「初始化并登录」。初始化只成功一次，之后这里只有登录。

**3. 接上 GitHub。** 首次登录会自动打开「接入向导」（之后从顶部导航进入），按顶部的六步走：

1. 公网 HTTPS：选「自建 HTTPS 中转」，把一个专用域名整个反向代理到 `http://<这台机器>:8791`，填 `https://<你的域名>`，点「检查并使用」。或者选「Cloudflare Tunnel」，粘贴 tunnel token 点「保存 token」，在 Cloudflare 的 Published application 把 Service URL 设为 `http://webhook:8791`，回到向导点该路由的「检查并使用此域名」。两种方式都不要把 8792 转出去，管理页留在本机 `127.0.0.1:8792`。
2. GitHub App：填「目标组织」和「App 名称」，点「准备 GitHub 确认页」→「前往 GitHub 确认创建」，在 GitHub 上确认后会回到向导。权限固定为 Contents、Issues、Pull requests 写和 Metadata 读，只订阅 `issues` 和 `pull_request`；Webhook 地址 `https://<你的域名>/hooks/github/<account_id>/<endpoint_id>` 由向导写进 App，不用手填。已在「机器人账号」登记过的 App 点「使用此 App」。
3. 安装：点「在 GitHub 安装此 App」，选好仓库后回来点「重新检查安装」。
4. 模型：在「添加模型」填接口 URL、API Key、模型名，点「保存并继续」。
5. 规则：看一下内置规则，点「下一步」。
6. 完成：点「同步已安装仓库」，在要用的仓库那一行点「启动并启用检视」，最后点「完成向导」。

**4. 启用更多仓库。** 在「项目」页点「同步安装列表」，在仓库行点「启动」，选好模型后确认。只有需要 bot 自动改代码时才勾选自动开发，也可以以后在该仓库的「设置」→「开发」打开。仓库启动前收到的事件只存档，不会补跑。

**5. 确认跑通。** 在已启用的仓库新开一个 Issue，bot 会在上面回复一条检视总结评论；第一次要先启动该仓库的虚拟电脑，会慢一些。没等到时，先在「Webhook 投递」页看投递是否到达、验签是否通过，再在「检视」页看任务状态。

**升级和数据。** 在同一目录运行：

```sh
docker compose -f compose.pull.yaml pull
docker compose -f compose.pull.yaml up -d
```

数据在四个部署卷里：`bot-data`（控制面数据库）、`bot-keys`（加密凭据的主密钥）、`internal-keys`（bot 与 manager 的内部认证）和 `manager-data`（虚拟电脑账本）；`tunnel-keys` 只放 Cloudflare Tunnel token。丢了主密钥，已保存的 App 私钥和模型 Key 都解不开。`docker compose -f compose.pull.yaml down` 会保留卷；日常升级不要加 `-v`（`--volumes`），它会删掉这些卷。备份见[备份与恢复](#备份与恢复)。

## 概览

一个 Node.js 22.13+ / TypeScript 控制面，使用系统内账号管理多个 GitHub App、机器人账号、仓库权限、模型配置和 Webhook 投递。

当前提供多账号控制面、每仓库一个长期 Docker 环境，以及可读代码、运行命令和修改文件的检视／开发 Agent。没有内置账号或仓库；开启仓库检视后接收事件并创建任务，满足开发条件时自动实现、测试、发布 bot 分支和 PR。`/api/status` 的项目环境、检视、开发及模型调用能力均可用；具体任务缺配置或失败会显示故障状态。

## 部署细节

### 镜像与两份 Compose

`main` 分支每次推送后，[`.github/workflows/images.yml`](.github/workflows/images.yml) 构建并发布下列 `linux/amd64` 镜像，标签为 `latest` 和 `sha-<12 位提交>`；Pull request 只构建、不发布。

| 镜像 | Dockerfile | Compose 服务 |
| --- | --- | --- |
| `ghcr.io/agent-ci-infra/bot` | `Dockerfile` | `key-init`、`bot` |
| `ghcr.io/agent-ci-infra/bot-manager` | `manager/Dockerfile` | `manager` |
| `ghcr.io/agent-ci-infra/bot-project` | `images/project/Dockerfile` | `project-image`，也是每台虚拟电脑的批准镜像 |
| `ghcr.io/agent-ci-infra/bot-tunnel` | `tunnel/Dockerfile` | `tunnel` |
| `ghcr.io/agent-ci-infra/bot-webhook` | `webhook/Dockerfile` | `webhook` |

`compose.pull.yaml` 直接运行这些镜像。`compose.yaml` 用同样的服务、卷和网络从源码构建，本地标签为 `department-bot*:local`，供开发或镜像不可用时在仓库根目录使用：

```sh
docker compose up --build -d
```

两份文件的 Compose 项目名都取所在目录名，所以在同一目录里从 `compose.yaml` 换成 `compose.pull.yaml`（或反过来）会沿用原来的卷；虚拟电脑在下次准备时换成新的批准镜像，工作卷和代次不变。manager 不拉取镜像，只检查 `BOT_PROJECT_IMAGE` 指向的本机镜像，所以它必须和 `project-image` 服务的镜像引用（含标签）完全一致。

### 端口与环境变量

`8791` 是 Webhook 接收入口，宿主端口默认绑定 `0.0.0.0`，对所有 IPv4 网卡开放；`8792` 是管理页面和管理 API，仍仅绑定宿主回环地址 `127.0.0.1`，只在本机访问。公网域名整个转发到 `8791`：除了 GitHub Webhook 的 `/hooks/github/<account_id>/<endpoint_id>`，向导检查地址用 `/.well-known/bot-webhook-probe`，外部执行端兑换令牌也走这个入口。不要把两个监听端口混接。需要远程访问管理页面时，另行配置独立的 HTTPS 反向代理（与 Webhook 用不同域名），并设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN` 为自己的管理站 origin。管理 API 不开放跨域访问。

下列变量从启动 Compose 的 shell 环境或 Compose 文件同目录的 `.env` 读取，都不包含上游凭据：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `BOT_WEBHOOK_PORT` | `8791` | Webhook 的宿主端口，绑定 `0.0.0.0` |
| `BOT_ADMIN_PORT` | `8792` | 管理页的宿主端口，只绑定 `127.0.0.1` |
| `BOT_COOKIE_SECURE` | `false` | 管理页经 HTTPS 反向代理访问时设为 `true` |
| `BOT_ADMIN_ORIGIN` | 空 | 管理站的 HTTPS origin；创建 GitHub App 后 GitHub 也回调到这里 |
| `BOT_PROJECT_EGRESS` | `true` | 设为 `false` 时虚拟电脑没有外网出口 |
| `BOT_GITHUB_API_URL` | `https://api.github.com` | GitHub API 地址 |
| `BOT_FORWARD_PRIVATE_HOSTS` | 空 | 外部执行端允许转发到的内网主机名，逗号分隔，见[外部执行端](docs/external-executors.md) |

### 服务、卷与隔离

Compose 包含长运行的 `bot`、`manager`、`webhook`、`tunnel`，以及一次性的 `key-init` 与 `project-image`。`key-init` 首次启动时生成主密钥和内部认证。`project-image` 仅确保批准的项目镜像已在本机 Docker 中（`compose.pull.yaml` 拉取，`compose.yaml` 构建），不是某个仓库的长期环境。`tunnel` 在向导保存 Cloudflare Tunnel token 之前不连接任何账号；它只在独立的 `edge` 网络，经 `webhook` 网关固定转发到 `bot:8791`，不能连接管理端口。manager 按仓库创建动态项目容器，项目容器不属于 Compose 静态服务，不对宿主或公网发布端口。

`bot-data` 保存控制面 SQLite，`bot-keys` 保存加密主密钥，仅 bot 可读；`internal-keys` 保存 bot 与 manager 的内部认证，manager 不挂载上游凭据或控制面数据库。`manager-data` 保存环境和操作账本。每个环境代次拥有独立具名工作卷和内部网络，标签同时绑定部署、仓库 ID、代次和资源类型。部署 ID 从独立内部认证材料派生，不同部署不会共用资源名。

只有 manager 挂载 Docker socket；它以 UID 0、GID 10001 访问 socket 和只读内部认证卷，丢弃所有 capabilities、禁止提权、根文件系统只读。Docker socket 本身仍赋予 manager 管理宿主 Docker 的能力，因此不对宿主发布 manager 端口，也不向项目网络提供该接口。它只接受登记项目的固定生命周期和 runner 请求，不能指定任意镜像、挂载、容器 ID 或 Docker API。bot 和项目容器没有 socket，项目容器也不挂载任何认证卷。bot／manager 使用独立控制网络，每个项目使用自己的 bridge 网络，项目之间互不可达。项目容器默认可以访问外网，用于安装依赖和访问测试地址；设置 `BOT_PROJECT_EGRESS=false` 可改回无出口的内部网络。外网出口意味着仓库代码也能访问宿主在 `0.0.0.0` 上发布的端口（例如 Webhook `8791`），管理端口只绑定回环地址，不受影响；GitHub 和模型凭据仍不进入项目容器。

### 备份与恢复

备份前停止 bot 和 manager，并备份四个部署卷及项目具名卷；数据库停止写入后再复制，恢复时使用同一套内部认证和管理账本。丢失主密钥会无法解密凭据，丢失内部认证会改变部署 ID，不能用新的空账本直接接管旧容器。`docker compose down` 保留卷；`--volumes` 会删除部署认证和账本，日常升级不要使用。动态项目资源需要通过环境接口管理，Compose down 不会直接删除它们。

## 使用与权限

超级管理员登记 GitHub App（App ID、RSA 私钥）或机器人账号（Token），为入口保存签名凭据，控制面随后自动同步每个账号可见的仓库：GitHub App 列出全部安装及其仓库，机器人账号列出 `/user/repos`；启动时和每 10 分钟全量对账一次，`installation`／`installation_repositories` 投递在同一事务里即时更新，并随后触发一次全量同步。同步只记录“已安装”，不登记、不启用：超级管理员在仓库页点“启动”，选择模型（部署共享模型会同时授权给该仓库）和是否开启自动开发后，才登记仓库、创建虚拟电脑并开始检视；启动前收到的事件只归档，不补跑。已启用的仓库可以“禁用”：停止处理新事件、中止正在执行的任务并停止虚拟电脑，数据保留，之后可再启用。仓库只能经同步出现、再由超级管理员启动，没有手动登记入口。任务执行时校验账号、实际仓库 ID 和所有者；App 在控制面签发 JWT、取得目标仓库安装令牌，机器人账号使用已保存的 Token，均不进入项目环境。仓库 ID 使用字符串提交，避免 JavaScript 大整数丢精度。

超级管理员可创建用户和分配项目管理员。每名项目管理员可分配多个仓库，每个仓库可有多名项目管理员。项目管理员只看到并操作自己的仓库、投递、模型、策略及任务读取接口；无筛选查询同样受限，未关联仓库或验签失败的投递仅超级管理员可见。账号凭据、全局用户和授权关系接口只允许超级管理员调用。用户停用会撤销已有会话，仓库分配调整在后续请求立即生效；不能停用最后一名超级管理员。

模型配置包含接口 URL、API Key、模型名。超级管理员可管理全部模型；项目管理员可为自己的仓库创建和更新模型。部署共享模型由超级管理员通过 `models/:id/projects` 指定可用仓库，项目管理员只能读配置状态、选用，不能修改共享模型。超级管理员在仓库策略或“启动”中选择共享模型时，会同时把它授权给该仓库。仓库策略保存选用的模型 ID。保存即信任，可以发送本项目代码、日志和测试材料，不增加数据授权等待状态。接口采用兼容 Chat Completions 的 JSON 工具调用协议；URL 可填写基础路径或完整 `/chat/completions` 路径，基础路径会自动追加该后缀。没有模型配置、撤销 Key、认证失败会显示 waiting_configuration；网络／限流故障退避重试，持续故障停止任务。

账号凭据、入口签名材料和模型 Key 用 AES-256-GCM 加密，密文绑定记录 ID。读取和写入响应均只返回是否已配置，不返回明文或密文。更新时留空或仅空白的凭据保持原值；撤销使用专用动作，不能靠提交空字符串撤销。模型 PATCH 必须带读取到的 `version`，旧版本返回 409。撤销账号凭据不会连带撤销入口签名；要禁用入口需单独撤销该入口。

浏览器管理入口以项目为单位组织：“项目”页列出已安装和已登记的仓库及“未启动／工作中／已禁用／已移出安装”状态，超级管理员可同步安装列表、启动、启用或禁用；点每行的“设置”进入该项目独立的设置页（`#/projects/<仓库 ID>/<类别>`，可直接分享和刷新），左侧类别为基本设置（仓库信息、处理账号、基准分支）、机器配置（虚拟电脑状态、实时资源、软件安装与初始化结果、启停与重置，以及 CPU、内存、进程数、/tmp、外网、额外软件包、环境变量和初始化脚本）、使用的模型（选择部署共享或本项目专属模型，添加模型、更换或撤销 Key）、检视（检视开关、Issue／PR 打开与 PR 新提交三个触发、评论语言，以及 Issue 检视规则、PR 检视规则、检视标签三份规则文件）、开发（自动开发、测试命令、bot PR 修订轮数和开发规则文件）、规则总览（一张表列出每份规则文件的作用、路径、用于哪些任务，以及内置默认／项目控制台／仓库文件哪一层生效；行为指南和仓库 skill 也在这里）、成员（仅超级管理员，分配项目管理员）和运行记录（当前任务、最近任务与命令）。项目管理员只看到自己的项目，机器配置只读。“检视”“开发”两个任务页的任务详情按时间线展示 Agent 工作过程：工作区准备、每一步模型思考与工具选择、读写的文件、在项目容器中执行的命令及退出码和输出、GitHub 发布和故障；运行中每 2 秒刷新，正在执行的命令单独显示并实时追加输出。账号／用户新增在各自页面完成，凭据轮换等其余管理操作通过下列 API 完成。

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
| `/api/repositories`、`/api/repositories/:id` | GET | 范围内列表／详情；仓库由安装同步发现，经 `POST /api/installations/:id/activate` 启动后登记 |
| `/api/repositories/:id/policy` | GET / PATCH | 范围内策略，字段 `model_id,review_enabled,development_enabled,enabled,test_command,base_branch,max_revisions`；选择模型、启用检视／开发、指定必需测试和跟进预算；基准分支留空时读取仓库默认分支；检视规则字段 `review_issues`、`review_pull_requests`、`review_pr_updates`（布尔，分别控制 Issue 打开、PR 打开／转为可检视、PR 新提交是否触发检视）和 `review_language`（`auto`／`zh`／`en`）。检视指引和检视标签不是策略字段，写在规则文件里，见下一行 |
| `/api/repositories/:id/rules` | GET / PUT | 每份规则文件的内置默认、项目控制台、仓库文件三层和最终内容；PUT `{path,content}` 保存或（`content: null`）清除某个 `.bot/` 规则文件的控制台覆盖。`POST …/rules/refresh` 重新读取默认分支文件，`POST …/rules/apply-computer` 由超级管理员立即应用 `.bot/computer.yaml` |
| `/api/environments`、`/api/environments/:id` | GET | 按账号、组织 ID、仓库过滤环境；项目管理员无筛选也只见被分配仓库。列表带当前执行任务；详情另含 manager 给出的容器／卷／网络／镜像／资源限制、当前任务、最近 20 个任务和最近 30 条命令 |
| `/api/environments/:id/start`、`/stop`、`/reset` | POST | 仓库管理员操作；字段 `operation_id,generation`，操作 ID 为 48 位随机十六进制；重试必须复用同一 ID |
| `/api/environments/:id/configure` | POST | 仅超级管理员；字段 `operation_id,generation,spec`，`spec` 可含 `cpus`（0.25–16，默认 2）、`memory_mb`（256–65536，默认 4096）、`pids`（64–16384，默认 1024）、`tmp_mb`（16–16384，默认 1024）、`egress`、`packages`（最多 100 个 Debian 包名）、`env`（最多 64 个非机密变量，`PATH`、`HOME`、`BOT_*`、`GIT_*` 等保留名拒绝）、`setup_script`（≤16 KiB）和一次性的 `rerun_setup`。范围由 manager 校验；规格随项目保存、跨重启和重置保留，保存后在项目锁内重建容器，工作卷和代次不变；软件包镜像构建失败时不改动正在运行的电脑 |
| `/api/environments/:id/stats` | GET | 范围内实时资源：CPU、内存、进程数、网络、磁盘读写和工作区占用（工作区每分钟最多统计一次），不占用项目锁 |
| `/api/environments/:id/delete` | POST | 仅超级管理员，另需 `confirm:true`；删除容器／网络，保留卷 |
| `/api/models`、`/api/models/:id` | GET / POST、GET / PATCH | 范围内模型，字段 `repository_id,api_url,api_key,model_name`；PATCH 带 `version` |
| `/api/models/:id/projects`、`/api/models/:id/credentials/revoke` | PUT、POST | 超级管理员分配共享模型；有权编辑者撤销模型 Key |
| `/api/events`、`/api/events/:id` | GET | 范围内投递列表／正文和响应；列表可筛选 `repository_id,account_id,owner_id,event,status,delivery_id,limit,offset` |
| `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/logs` | GET | 范围内任务列表、结果、发布回执和带时间的过程日志；支持 `kind=review|development`、仓库／账号／组织过滤及分页。日志包含模型每步的思考摘要、工具调用与结果（长文本截断），不返回认领令牌或原始模型会话 |
| `/api/tasks/:id/live` | GET | 运行中任务当前正在执行的命令及其已产生的输出，参数 `offset` 为已读字节数 |
| `/api/installations`、`/api/installations/sync` | GET、POST | 仅超级管理员；每个仓库一行，合并 GitHub 安装范围、登记、启用和环境状态，以及各账号最近同步结果；POST 立即全量同步 |
| `/api/installations/:id/activate`、`/api/installations/:id/disable` | POST | 仅超级管理员；启动（可带 `model_id,development_enabled,account_id`）或再次启用／禁用一个仓库 |
| `/api/tasks/:id/retry` | POST | 有权项目管理员重试故障任务；发布未知时仍先对账，不直接重复 POST |
| `/api/audit`、`/api/status` | GET | 范围内最近 100 条操作审计／当前能力状态 |
| `/hooks/github/:account/:endpoint` | POST | 仅 Webhook 端口，按已登记入口验签和归档 |

Webhook 对原始字节计算 HMAC-SHA256 并以恒定时间比较，验签后才解析和关联仓库。签名错误返回 401，未知入口返回 404，非法 JSON 返回 400，超过 2 MiB 返回 413（归档截断正文并标记不完整）。请求头中的认证、签名和 Cookie 等内容脱敏。请求正文、响应记录和 `(account_id,endpoint_id,delivery_id)` 去重键在同一个 SQLite `BEGIN IMMEDIATE` 事务提交后才返回成功；写库失败返回 503 且回滚去重。重复投递保存独立档案，响应标记 `duplicate:true`。失败投递不消费去重键，重试可成功。空仓库配置、未启动或已禁用的仓库只归档，不生成任务。

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
docker compose -f compose.pull.yaml config --quiet
```

`npm test` 覆盖并发初始化只成功一次、重启、权限收回、跨项目列表／详情／日志／模型隔离、凭据加密及不回显、验签、事务回滚重试、重复投递、先落库再确认和空配置不执行。SQLite 使用 Node 内置 `node:sqlite`，Node 22 会显示实验特性提示。

浏览器验收使用固定在 lockfile 的 Playwright，先运行 `npx playwright install chromium --only-shell`，再执行 `npm run test:e2e`；测试在自己的临时 SQLite 和随机端口上启动服务，覆盖初始化、登录、登记账号、查看签名投递、项目权限以及宽屏／窄屏页面，不占用部署数据或固定试用端口。输出放在忽略提交的 `.tmp/`。

## 项目环境生命周期

新增仓库默认启用，后台登记一个环境；创建与周期对账均按仓库 ID 幂等，不随 Issue 或 PR 结束而删除。启动和后续命令复用同一容器及卷。同仓库的生命周期和执行请求持有同一串行锁，不同仓库可并行；命令结束后容器继续运行，不再重启：默认清理命令的进程组，再由 runner 结束容器内除 init、空闲进程和自身以外的残留进程（另建会话的守护进程也会被结束）；清理失败时才回退为重启容器。命令可声明 `keep_background`，这时它启动的后台进程保留给同一任务后续的命令使用，任务结束或其他任务开始使用这台虚拟电脑前统一结束。容器以 Docker init 运行以回收僵尸进程；批准镜像、init 或网络策略变化后，下次 provision 时原地重建容器，卷和 generation 不变。

停止会将仓库 enabled 设为 false，停容器并保留卷；再次启动复用原代次和数据。签名可信的 App 卸载／暂停事件按账号和所有者范围停用，移除仓库事件按账号和仓库 ID 停用；这些意图随投递事务保存，再由后台停止环境，不在 webhook 响应链路调用 Docker。全量同步发现仓库不再安装时只标记“已移出安装”，不自动改变启用状态。停止、重置或删除会先中断正在执行的长命令。

重置先停止所有旧代容器并确认不再运行，然后增加 generation、保存旧卷，创建新代容器、新卷和新网络。失败进入 reset_failed，禁止普通启动旧环境，必须显式重试重置。删除默认只删除受管容器和网络，保留卷；停用和卸载不会删除资源。旧代容器始终停止，旧卷仅保留待备份／清理，不挂到新项目环境。

manager 重启会先停止不确定的执行，标记未完成操作 interrupted，再用同一代容器和卷检查 runner／journal 后恢复 ready；重置中断则保持 reset_failed。运行期发现容器重启或退出同样重新恢复，不以 Docker running 代替 ready。操作 ID 持久化去重，代次检查阻止旧请求写新环境，状态 revision 防止旧响应覆盖新状态。控制面保存操作意图并以原 ID 重试丢失响应，不自动重复重置。

当前 runner 为无网络监听的一次性固定执行入口：manager 通过 Docker exec 发送校验后的请求，返回 JSON 与持久 journal，调用者不能指定 exec argv 或用户。支持工作区相对文件读取／写入和 shell 命令，命令不限时长，运行到结束为止；要中断正在执行的命令，在机器配置中停止或重置虚拟电脑；单次写入 48 KiB、读取 1 MiB、命令输出 1 MiB。命令运行中输出同步写入 journal 旁的临时文件，manager 的只读 `output` 接口按字节偏移读取，不占用项目锁；命令完成后该文件删除，完整结果保存在 journal。项目运行用户为 10001，根文件系统只读，工作卷可写，CPU、内存、进程数和 /tmp 默认为 2 核、4096 MB、1024、1024 MB，超级管理员可按仓库在 manager 允许的范围内修改。批准的项目镜像自带 Node.js 22（npm、corepack 的 pnpm／yarn）、Python 3.11（pip、venv、uv）、gcc／g++／make、git、git-lfs、curl、wget、jq、ripgrep、sqlite3、zip／unzip，镜像自带包清单在 `/opt/bot/image-packages`。仓库需要的系统软件包由 manager 以批准镜像为底、用固定的 apt 命令构建派生镜像（按底层镜像和包集合缓存，root 只出现在构建阶段）；非机密环境变量注入容器并传给每条命令；初始化脚本以项目用户在 `/workspace` 运行，`HOME=/workspace/home` 在工作卷中，`~/.local/bin`、`~/.cargo/bin`、`~/.npm-global/bin` 在 PATH 上，脚本或代次变化时重新运行，结果和输出在虚拟电脑页可见。Git 操作在容器内执行。任务工具支持隔离工作目录、分块文件与 Git 候选；上游 API 认证始终由控制面代理。执行入口仅供内部控制面和验收调用，管理页面没有通用终端。

实际 Docker 验收运行 `npm run test:docker`，需要 Docker 和上述 Playwright 浏览器。它使用独立 Compose 项目和 18881／18882／18883 测试端口，18883 仅在测试覆盖文件里映射 manager；生产 Compose 不发布该端口。测试会检查两个真实环境、串行与并行、文件／卷／网络隔离、无凭据、代次重置、重启和角色页面，并按本次部署标签清理容器、网络及卷。输出保存在 `.tmp/project-env/`。

## 检视与开发数据流

在仓库 policy 中选择 `model_id`，打开 `review_enabled`，需要自动实现时再打开 `development_enabled`，建议设置可信的 `test_command`。Issue 只在 opened 时检视一次；PR 在 opened、ready_for_review、synchronize 且非草稿时检视当前 head。这三类触发可在项目的「检视」中分别关闭（关闭 PR 新提交触发后，bot PR 的自动跟进也随之停止）。普通评论、编辑和重新打开不额外触发。未启用检视的仓库只归档，草稿不建检视任务。投递去重和任务逻辑去重独立；归档、去重与入队在同一事务提交后才确认成功。

后台按仓库串行认领任务，拉取本仓 Issue／PR、讨论、完整分页 diff 与固定 SHA 的代码材料。已保存模型只收到这个项目的上下文，并可调用 read_file、write_file、run_command 等受任务约束的工具。仓库材料属于不可信输入，不能修改权限、镜像、发布目标或认证。单个任务不限模型调用次数，也没有总时长上限，禁用项目或停止虚拟电脑可以中止正在执行的任务；模型调用 run_command 时命令不限时长，可选 `timeout_seconds` 为可能卡住的命令自设超时，服务和监视进程用 `keep_background` 放到后台；仓库测试验证同样不限时长；任务上下文包含虚拟电脑的资源、工具链、额外软件包和环境变量名；临时调用失败最多重试 5 次，配置故障单独显示。

每次检视发布一条总结讨论评论，包含总结、非行内 finding 和检视 SHA。Issue 只用普通评论。PR 每条 finding 由模型选择普通评论或行内评论并给出理由，服务端用真实 diff 校验 path／line／side；缺少可核对位置时转普通评论，不猜行号。行内 Review 的 event 恒为 COMMENT，模型不能选择批准或请求变更，没有自动合并接口。发布前重新检查 head，过时任务标为 superseded；评论写明实际检视 SHA，Review 和每条行内评论的 GitHub ID 保存到任务回执。policy 设置了 `review_label` 时，总结评论发布成功后由控制面用同一安装令牌给 Issue／PR 加这一个标签，仓库没有该标签时由 GitHub 创建；标签不由模型选择，重复执行不会重复添加。

Issue 检视结果明确要求代码变更、存在原文证据且无需补充信息时，若仓库打开开发，创建关联开发任务。在同一项目容器的新任务工作目录中修改代码，模型完成后服务端再次运行仓库指定测试；未配置固定测试时使用模型给出的测试命令，不能没有测试。失败不会推分支或开 PR。成功后检查测试前后候选 tree 一致，再由控制面发布唯一 `bot/issue-...` 分支，并创建 PR、回填链接。默认分支从 GitHub 元数据或仓库 policy 获取，不写死。

别人的 PR 只检视，不产生向作者分支提交的任务；分支名或机器人名称不能代替归属记录。由本系统创建的 PR 保存不可变 PR ID、作者、head 仓库、分支和发布 SHA，只有这些身份仍匹配、策略允许且确有修改项时才在原分支跟进。跟进默认最多 3 轮，可在 policy 的 max_revisions 中设置 0–10；不另开 PR，不强推，不自动合并。

## 无凭据代码代理与发布

当前采用 Git 数据 API 的有界快照传输：控制面读取固定 commit 的 tree/blob，经 manager 将文件分块交给 runner；runner 校验 blob 与源 tree，构建本地 Git 快照。它不是完整上游历史克隆，模型上下文和评论覆盖说明明确标识这一点。单文件最多 1 MiB，快照最多 2000 文件／32 MiB，超限、子模块或截断 tree 进入明确故障，不用不完整工作区开发。二进制和符号链接按 Git 对象处理，相对文件工具不跟随越界符号链接。

开发候选由容器内 Git 生成，控制面保存候选 tree、文件清单、测试输出与本地提交映射，经 Git 数据 API 上传 blob/tree/commit。只有 GitHub 返回 tree 与已验证候选完全一致，才创建或更新登记的 bot 分支。更新固定 force:false；未知或变化的分支 head 会阻止发布。容器里没有 GitHub remote 认证、私钥或模型 Key；控制面不运行仓库 shell 或 git 命令。真实仓库访问仍需为 App／账号提供相应 Contents、Issues 和 Pull requests 权限。

评论、Review、分支和 PR 都有持久 outbox。请求结果未知时按任务 marker、head 和远端对象先对账；未能确认就保持 waiting_publication，不盲目重复。控制面重启后恢复未完成阶段，已完成任务不重新入队；manager 中断的命令不当作通过，重新检查环境后在新 attempt 工作目录继续，旧目录保留。同代已完成工具通过原操作 ID 回放，generation 变化会阻止旧任务直接写入新环境。

## 验证与当前限制

`npm run test:agent` 使用假 GitHub、假模型和真实项目容器验收完整旅程，包括 Issue 到 bot PR、草稿忽略、COMMENT 行内评论、别人 PR 不推送、bot PR 跟进、重复投递／未知响应对账、测试失败、tree 不一致、配置故障、manager 中断恢复、凭据隔离及任务页面角色范围。浏览器使用 lockfile 中的 Playwright。测试端口 18891–18894，与部署和人类试用数据隔离，结束后清理测试容器、网络和卷；产物放 `.tmp/review-dev/`。

尚未接入 Git smart HTTP／完整历史传输、子模块／LFS、按域名白名单的出口代理和长命令跨 manager 重启续跑（manager 重启会中断正在执行的命令）。命令输出由控制台每 2 秒轮询增量读取，不是推送。策略编辑和部分授权管理继续通过已有管理 API 完成。没有聊天、图形桌面、浏览器接管或远程桌面能力。


## 外部执行端

管理入口的「外部执行端」可登记逐仓库客户端、配置 Webhook 事件过滤与签名转发，并查看投递和临时授权记录。个人电脑登记公钥、用本机私钥签发两分钟内有效的证明，GitHub Actions 使用受信任 OIDC 身份；检视完成后向公开 `/external/token` 兑换限定仓库的 Bot 安装令牌，再以 Bot 身份回复结果。只有 GitHub App 能签发此类临时 GitHub 凭据，不分发长期账号 Token。超级管理员需先在该页设置实际 HTTPS 兑换地址；旧客户端保留 ID 和订阅，但须登记公钥后才能继续兑换。完整接入、重试、权限与撤销边界见 [外部执行端](docs/external-executors.md)。`npm run test:external:docker` 使用独立临时镜像和无外网容器验证签名转发、兑换临时令牌和 Bot 身份评论；GitHub 为本地测试服务，结束后清理本次镜像及容器，不修改运行实例。

## 独立工作区开发

每项开发使用独立分支和 git worktree，避免在共享 main 工作区修改或覆盖别人的未提交内容。依赖、测试数据和端口按工作区隔离；Docker 验证使用独立的镜像名、容器名和端口，不替换正在运行的本机实例。

```sh
git worktree add -b feature/<topic> .worktrees/<topic> main
cd .worktrees/<topic>
npm ci
npm run check
npm test
```

## 接入向导与现成 Agent

超级管理员从「接入向导」依次准备公网 HTTPS、GitHub App、安装、模型与规则。新部署首次登录自动进入；已有部署可随时从导航打开，保留账号和数据。只发布 webhook，管理端口仍绑定本机。完整配置、规则路径与故障说明见 [Onboarding](docs/onboarding.md)。

检视和开发由固定版本 Pi SDK 在项目长期容器内运行。真实 GitHub 凭据和模型 Key 仅在控制面；Pi 的 loopback 模型入口通过任务专属 runner 邮箱请求控制面代理，没有跨项目共享服务或新增公网端口。控制面继续独立验证测试、diff 位置、head、bot 分支归属并负责发布，Review 只允许 COMMENT，不自动合并。
