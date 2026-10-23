# 部门公共 Bot

一个 Node.js 22.13+ / TypeScript 控制面，使用内置账号与权限体系管理多个 GitHub App、机器人账号、仓库权限、模型配置和 Webhook 投递。许可证为 Apache-2.0。

控制面管理账号、仓库授权、模型和 Webhook；每个启用检视的仓库有一台长期 Docker 虚拟电脑，由固定版本的 Pi Agent 读取代码、运行命令、修改文件，必要时发布 `bot/issue-*` 分支和 PR。仓库级策略（标签、门禁、合并队列、CI 阶段）放在 YAML 中，不需要为每个仓库复制一套 GitHub Actions。

配置入口以管理页的「接入向导」为主。首次登录且尚未配置账号时会自动进入向导；已有部署可随时从导航打开。向导、规则文件和故障排查的完整说明见 [docs/onboarding.md](docs/onboarding.md)。

## 目录

- [快速开始](#快速开始)
- [配置 Bot](#配置-bot)
- [配置检查清单](#配置检查清单)
- [配置参考](#配置参考)
- [运行与运维](#运行与运维)
- [权限与安全](#权限与安全)
- [自动化规则与执行](#自动化规则与执行)
- [项目电脑生命周期](#项目电脑生命周期)
- [检视与开发数据流](#检视与开发数据流)
- [无凭据代码代理与发布](#无凭据代码代理与发布)
- [源码与验证](#源码与验证)
- [当前限制](#当前限制)

## 快速开始

安装 Docker Engine 和 Compose，然后在仓库根目录运行：

```sh
docker compose up --build -d
docker compose ps
```

打开 <http://127.0.0.1:8792/>，创建第一名超级管理员。初始化只允许成功一次，重启不会重新开放。用户名和密码属于本系统；密码长度为 12–256 字符，使用随机盐的 scrypt 慢哈希保存。先完成初始化，再将入口开放给其他人。

初始化后会自动进入「接入向导」。配置前先准备：

| 需要准备 | 说明 |
| --- | --- |
| Docker Engine + Compose | 运行控制面、manager 和一次性构建任务 |
| 公网 HTTPS 地址 | GitHub Webhook 与外部执行端兑换需要；可用自己的反向代理或 Compose 自带的 Cloudflare Tunnel |
| GitHub 账号权限 | 优先使用已有 GitHub App；没有时由向导创建组织私有 App |
| 模型服务 | 兼容 Chat Completions 的 URL、API Key 和模型名 |

`8791` 是公网 Webhook 接收入口，`8792` 是管理页面和管理 API。`8792` 默认只绑定宿主回环地址，不要把它和 `8791` 混接。用 `BOT_WEBHOOK_PORT`、`BOT_ADMIN_PORT` 可调整宿主机端口。

## 配置 Bot

推荐按下面的顺序配置。前五步在管理页完成，后三步按需使用仓库文件、YAML 和外部执行端。

```text
公网 HTTPS
   │
   ▼
GitHub App ──► 安装到仓库 ──► 启动项目（选择模型）
                                  │
                                  ├─ 项目设置：机器 / 模型 / 检视规则 / 开发
                                  ├─ 仓库文件：.bot 规则、computer.yaml、skills
                                  └─ 仓库 YAML：标签 / 门禁 / 合并 / CI 阶段
                                                   │
                                                   └─ 可选：外部执行端
```

### 第 1 步：准备公网 HTTPS

GitHub Webhook 和外部执行端兑换都需要公网 HTTPS。两种入口任选一种：

**方案 A：自己的反向代理**。准备证书，把公开域名转发到宿主机的 `8791`。推荐整个域名都转到 `8791`，至少必须覆盖：

| 路径 | 用途 |
| --- | --- |
| `/.well-known/bot-webhook-probe` | 向导检查公网地址时的一次性验证 |
| `/hooks/github/...` | GitHub Webhook |
| `/external/token`、`/external/revoke` | 外部执行端兑换／撤销 GitHub 临时令牌 |

管理页面仍走独立的 `8792`，不要放到同一个公开域名下。向导会检查公开地址的 `/`、`/api/setup` 和 `/app.js` 是否返回 404；如果管理页面或管理 API 被暴露，检查会失败。

**方案 B：Cloudflare Tunnel**。Compose 自带 `tunnel` 服务，初始没有 token，不会连接任何账号。配置步骤：

1. 在 Cloudflare 控制台的 Networks → Tunnels 创建 tunnel。
2. 在 Routes → Published application 添加自有域名，Service URL 填 `http://webhook:8791`。
3. 在「接入向导」粘贴 tunnel token。token 加密保存，并以 `0600` 文件交给非 root tunnel 进程；不会写入 Compose 环境变量、命令行或读取接口。
4. 向导会读取 tunnel 的连接状态和路由。指向 `8791` 的 webhook 路由会显示为正确；指到管理端口的路由会被标错。

`tunnel` 只加入独立的 `edge` 网络；`webhook` 是固定的边缘网关，只能转发到 `bot:8791`。即使远端路由填错，Tunnel 也不能直接连接管理端口。

### 第 2 步：配置 GitHub App 与安装

优先使用已有 GitHub App：

1. 在向导中选择「使用此 App」，填写已登记的 App 账号。
2. 向导会检查 App 和安装列表；勾选更新 Webhook 后，会把 Webhook 地址改成已验证的公网域名和该账号的入口路径，并回读确认。
3. App 私钥仍只在控制面加密保存，不会返回浏览器。

没有现成 App 时，由向导创建：

1. 填写 GitHub 组织和 App 名称，按需勾选「公开 App，允许安装到其他组织」。
2. 向导生成 App Manifest，跳转 GitHub 确认创建。权限固定为：

   | 权限 | 级别 | 用途 |
   | --- | --- | --- |
   | Contents | write | 读取代码、发布 `bot/issue-*` 分支 |
   | Issues | write | 读取 Issue、发布评论、加标签 |
   | Pull requests | write | 读取 PR、发布 Review／评论 |
   | Metadata | read | 必需 |

   `default_events` 只有 `issues`、`pull_request`；`installation` 和 `installation_repositories` 由 GitHub 自动投递。
3. GitHub 返回管理回调时使用一次性 state，绑定发起的超级管理员，15 分钟有效。manifest code 兑换不带 PAT。
4. 创建完成后，在安装页打开 GitHub 安装链接，把 App 安装到目标仓库；也可先跳过安装，继续配置模型和规则。

手工登记 App 或在自动化脚本中操作时，使用管理 API。先登录并取得 CSRF：

```sh
ADMIN=http://127.0.0.1:8792

curl -sS -c cookie.txt -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<密码>"}' \
  "$ADMIN/api/auth/login"

CSRF=$(curl -sS -b cookie.txt "$ADMIN/api/auth/me" | jq -r .csrf_token)
api() { curl -sS -b cookie.txt -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' "$@"; }
```

登记 App 账号（`private_key` 中的换行可写成 `\n`）：

```sh
APP_ID=123456
WEBHOOK_SECRET=$(openssl rand -hex 32)

api -X POST "$ADMIN/api/accounts" -d "{
  \"name\": \"department-bot\",
  \"type\": \"github_app\",
  \"app_id\": \"$APP_ID\",
  \"private_key\": \"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\",
  \"webhook_secret\": \"$WEBHOOK_SECRET\"
}"
```

响应中的 `account.endpoints[0].webhook_path` 就是 `/hooks/github/<account_id>/<endpoint_id>`。在 GitHub App 设置中添加 Webhook：

| 字段 | 值 |
| --- | --- |
| Payload URL | `https://<公网域名>/hooks/github/<account_id>/<endpoint_id>` |
| Content type | `application/json` |
| Secret | 与登记账号时的 `webhook_secret` 一致 |
| SSL verification | Enable |
| Events | Issues、Pull requests；建议同时勾选 Installation、Installation repositories |
| Active | 勾选 |

机器人账号也可以手工登记：`type` 改为 `bot_account`，去掉 `app_id`，改用 `token`（Fine-grained PAT 或 classic PAT），权限与上面的 App 相同。注意：**外部执行端的临时 GitHub 凭据只支持 GitHub App**，不会分发机器人账号的长期 Token。

### 第 3 步：配置模型

模型配置包含接口 URL、API Key 和模型名。两种来源：

- **部署共享模型**：超级管理员创建，可选择授权给多个仓库。
- **项目专属模型**：项目管理员为自己的仓库创建。

在向导中可以保存一个部署共享模型；真正启用项目时仍要选择该模型。模型 URL 可填基础路径或完整 `/chat/completions` 路径，基础路径会自动追加后缀。Key 只保存、不回显；留空更新保持原值，撤销使用专用接口。

```sh
api -X POST "$ADMIN/api/models" -d '{
  "api_url": "https://api.example.com/v1",
  "api_key": "sk-...",
  "model_name": "your-model"
}'
```

不带 `repository_id` 创建的是共享模型；超级管理员用 `PUT /api/models/:id/projects` 指定可用仓库。项目管理员创建时必须带自己的 `repository_id`，且不能修改共享模型。

### 第 4 步：安装、启动和禁用项目

控制面在启动时和每 10 分钟自动同步安装范围，`installation`／`installation_repositories` 事件也会即时更新。同步只记录“已安装”，**不会自动启用**：

1. 打开「项目」页，选择已安装的仓库。
2. 点「启动」，选择模型，决定是否开启自动开发。
3. 启动后才会登记仓库、创建虚拟电脑并开始检视；启动前收到的事件只归档，不补跑。

也可以用 API 启动。`id` 是 GitHub 仓库的数字 ID：

```sh
api -X POST "$ADMIN/api/installations/123456789/activate" -d '{
  "model_id": "<model id>",
  "development_enabled": false
}'
```

启动会把 `enabled` 和 `review_enabled` 置为 true。禁用使用 `POST /api/installations/<id>/disable`：停止处理新事件、中止正在执行的任务并停止虚拟电脑，数据保留，之后可再启用。全量同步发现仓库不再安装时只标记“已移出安装”，不会自动改变启用状态。

如果仓库不在自动同步结果中，仍可由超级管理员手工登记：

```sh
api -X POST "$ADMIN/api/repositories" -d '{
  "id": "123456789",
  "full_name": "Jianyu010/PPMA",
  "owner_id": "1234567",
  "account_id": "<第 2 步的 account_id>"
}'
```

`owner_id` 是仓库所有者（用户或组织）的数字 ID；`account_id` 是本系统账号 ID，不是 GitHub App ID。仓库 ID 使用字符串提交，避免 JavaScript 大整数丢精度。

### 第 5 步：配置项目

每个项目有独立设置页，可直接分享和刷新：`#/projects/<仓库 ID>/<类别>`。项目管理员只看到自己的项目，机器配置只读。

| 设置类别 | 需要配置的内容 |
| --- | --- |
| 基本设置 | 仓库信息、处理账号、基准分支（留空使用仓库默认分支） |
| 机器配置 | 虚拟电脑状态、实时资源、软件安装与初始化结果、启停与重置；CPU、内存、进程数、/tmp、单条命令时长、外网、额外软件包、环境变量和初始化脚本 |
| 使用的模型 | 选择部署共享模型或本项目专属模型；添加模型、更换或撤销 Key |
| 检视规则 | 检视开关、Issue／PR 打开与 PR 新提交三个触发、评论语言、项目检视指引、检视后标签 |
| 开发设置 | 自动开发、测试命令、bot PR 修订轮数 |
| 成员 | 仅超级管理员；分配项目管理员 |
| 运行记录 | 当前任务、最近任务与命令 |

对应的策略字段可以这样设置：

```sh
api -X PATCH "$ADMIN/api/repositories/123456789/policy" -d '{
  "model_id": "<model id>",
  "review_enabled": true,
  "development_enabled": false,
  "test_command": "npm ci && npm test",
  "base_branch": "main",
  "max_revisions": 3,
  "review_label": "bot-reviewed",
  "review_issues": true,
  "review_pull_requests": true,
  "review_pr_updates": true,
  "review_language": "zh",
  "review_instructions": "优先检查权限边界和失败恢复。"
}'
```

| 字段 | 作用 |
| --- | --- |
| `enabled` | 是否接收并处理该仓库事件 |
| `model_id` | 检视／开发使用的模型；共享模型必须已分配给该仓库 |
| `review_enabled` | 总开关；关闭后仓库只归档事件 |
| `review_issues` | Issue 打开时是否检视 |
| `review_pull_requests` | PR 打开或转为可检视时是否检视 |
| `review_pr_updates` | PR 新提交时是否检视；关闭后 bot PR 的自动跟进也停止 |
| `review_language` | `auto`、`zh` 或 `en` |
| `review_instructions` | 项目检视指引，最多 8000 字；仓库内容仍按不可信输入处理 |
| `development_enabled` | 允许从检视结果创建开发任务、发布分支和 PR |
| `test_command` | 设置后开发任务完成时强制运行的测试；建议必填 |
| `base_branch` | PR 的基准分支；留空读取仓库默认分支 |
| `max_revisions` | 对自有 bot PR 的最大跟进轮数，`0`–`10` |
| `review_label` | 检视总结发布成功后加的单个标签；留空不加 |
| `automation` | 仓库自动化 JSON；一般改用仓库 YAML 维护，见第 7 步 |

机器配置通过 `POST /api/environments/:id/configure` 修改，字段为 `operation_id,generation,spec`。`spec` 可包含 CPU、内存、进程数、/tmp、单条命令时长、`egress`、额外 Debian 软件包、非机密环境变量和初始化脚本；保存后在项目锁内重建容器，工作卷和代次不变。软件包镜像构建失败时不会改动正在运行的电脑。

### 第 6 步：用仓库文件配置 Agent 行为

仓库可以在默认分支放置固定文件，覆盖或补充 Agent 的行为。每个文本文件最多 16 KiB：

| 文件 | 作用 |
| --- | --- |
| `.bot/guide.md` | 总体行为指南 |
| `.bot/rules/labels.md` | 检视成功后的标签，使用 `review_label: bot-reviewed` 声明标签名 |
| `.bot/rules/issue-review.md` | 新 Issue 检视与授权意图判断 |
| `.bot/rules/pr-review.md` | PR 检视、证据位置与 COMMENT 输出 |
| `.bot/rules/issue-development.md` | 明确要求改代码时的实现与测试 |
| `.bot/computer.yaml` | 合并到项目电脑规格的资源、软件包、环境与初始化配置 |
| `.agents/skills/**/SKILL.md` | 仓库追加的 skill；只加载文本，不加载 JS 扩展 |

优先级为：内置默认 → 项目控制台 → 默认分支仓库文件。文本文件整份覆盖；仓库已经覆盖时，保存控制台内容不会悄悄盖过仓库文件。项目的「生效规则」按文件展示来源提交、每一层和最终内容，支持保存／清除控制台覆盖及刷新默认分支。

`computer.yaml` 使用机器配置的同一套字段，例如：

```yaml
cpus: 2
memory_mb: 4096
packages: [jq]
setup_script: "python3 -m venv /workspace/home/venv"
```

其余字段为 `pids`、`tmp_mb`、`max_command_minutes`、`egress`、`env`。manager 使用同一套范围校验、镜像派生和初始化逻辑；仓库覆盖不会被反写成控制台值。

PR 修改 `.bot` 或 `.agents/skills`（含移动、删除）时，检视总结会强制写明「这些文件改变了 bot 的行为，需要人来决定」。PR 里的新内容不会立即成为该次任务的生效规则／机器配置；规则取自默认分支。

### 第 7 步：用 YAML 配置仓库自动化

PR 门禁、标签规范、合并队列和 CI 阶段是仓库策略，放在每个仓库一份的 YAML 中：

```yaml
# config/repositories/Jianyu010__PPMA.yml
dry_run: true

labels:
  axes:                       # 值不用写前缀，清单自动展开为 type/bug 等
    type: [bug, feature, docs]
    source: [user, ci, review]
    priority: [critical, high, medium, low]
    area: [api, runtime, storage]
    size: [s, m, l]
    status: [triage, claimed, blocked, needs-info]
    pr: [ready, hold, no-issue]
  manifest: [blocker]         # 不属于任何轴的单体标签
  lint:
    require: [type, source]
    exactly_one: [priority]
    triage: status/triage
  pr_status:
    ready: pr/ready
    no_issue: pr/no-issue

gate:
  ready_label: ready
  status: merge-gate
  required_checks: [check, hygiene]
  maintainer_roles: [admin, maintain]
  review_must_be_answered: true

merge:
  enabled: false
  oldest_first: true
  skip_labels: [pr/hold]

ci:
  stages:
    - id: check
      workflow: ci.yml
      runner_labels: [self-hosted, ppma-ci-cn-check]
      required: true
    - id: hygiene
      workflow: hygiene.yml
      runner_labels: [self-hosted, ppma-ci-cn-hygiene]
      required: true
    - id: review
      workflow: opencode-review.yml
      runner_labels: [self-hosted, opencode-review]
      required: false
```

文件名必须是 `<owner>__<repo>.yml`（`/` 写成 `__`），放在 `config/repositories/`，或由 `BOT_REPOSITORY_CONFIG_DIR` 指向的目录。

| 区块 | 字段 | 说明 |
| --- | --- | --- |
| 根 | `dry_run` | 默认 `true`；当前没有执行器，这个标记只影响记录，不会产生 GitHub 写入 |
| `labels.axes` | 轴到值 | 轴名小写，值不能带 `/`；清单自动展开为 `axis/value` |
| `labels.manifest` | 额外标签 | 与轴展开结果合并 |
| `labels.lint` | `require`、`exactly_one`、`triage` | 必选轴、只能取一个值的轴、缺失时加的标签 |
| `labels.pr_status` | `ready`、`no_issue` | PR 状态标签 |
| `gate` | `ready_label`、`status`、`required_checks`、`maintainer_roles`、`review_must_be_answered` | PR 门禁；`required_checks` 必须被 `ci.stages` 中 `required: true` 的阶段覆盖 |
| `merge` | `enabled`、`oldest_first`、`skip_labels` | 合并队列；默认关闭，`method` 目前只能是 `merge` |
| `ci.stages` | `id`、`workflow`、`runner_labels`、`required` | 仓库的 CI 阶段与 runner 池 |

规则：

- 优先级为平台默认值 → 仓库 YAML → 通过 `PATCH /api/repositories/:id/policy` 保存的 `automation` JSON；API 保存的值优先。
- YAML 在启动时加载。字段拼错、轴名非法、`required_checks` 未被覆盖或文件名重复都会让启动失败，不会带着错误配置运行。
- Docker 镜像会复制 `config/`；修改后执行 `docker compose up --build -d`。也可以挂载只读配置目录并设置 `BOT_REPOSITORY_CONFIG_DIR`。
- **执行器尚未接线**：规则把计划写入 `automation_runs`，可在 `GET /api/automation` 查看“本应做什么”，但无论 `dry_run` 取何值，当前都不会真的改标签、状态或合并 PR。可以先用它验证配置和回放事件，不会误改仓库。

完整 schema、模块行为和 fail-closed 规则见 [docs/automation.md](docs/automation.md)。

### 第 8 步（可选）：配置外部执行端

外部执行端让个人电脑或 GitHub Actions 保留自己的检视工具：Bot 负责接收、过滤、签名转发 GitHub 事件；执行端完成检视后，向 Bot 兑换临时 GitHub 凭据，再以 Bot 身份回复。两项功能默认关闭，没有预置客户端、仓库或订阅。

配置入口是管理页的「外部执行端」。完整协议见 [docs/external-executors.md](docs/external-executors.md)，最短路径：

1. **准备 App**：外部凭据兑换只支持 GitHub App。App 至少需要 Contents read、Issues write、Pull requests write。
2. **登记客户端**：绑定一个仓库。个人电脑选择公钥签名认证（`private_key_jwt`）；GitHub Actions 选择 OIDC。
3. **个人电脑生成密钥**：只把 SPKI PEM 公钥粘贴到管理页，私钥留在本机。

   ```sh
   umask 077
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out bot-client.pem
   openssl pkey -in bot-client.pem -pubout -out bot-client.pub.pem
   ```

4. **设置兑换地址**：超级管理员在「外部执行端 → 设置兑换地址」填写实际完整 HTTPS 地址，以 `/external/token` 结尾。该地址同时作为签名证明的固定 audience，不从请求 Host 推导。
5. **新增转发订阅**：填写接收 URL、事件和动作，例如事件 `pull_request`、动作 `opened,ready_for_review,synchronize`，按需排除草稿。保存时显示一次签名密钥，接收端用它校验 `X-Bot-Signature-256`（对原始请求体做 HMAC-SHA256）。
6. **执行端处理**：按 `X-Bot-Delivery` 去重，验签后再解析；返回 `2xx` 表示已可靠接收，耗时检视不要阻塞 Webhook 响应。网络故障、408、429 和 5xx 会指数退避，最多五次；其他状态直接失败。
7. **兑换临时令牌**：个人电脑用 `scripts/external-token.mjs` 或自行实现 RS256 JWT，调用公开的 `POST /external/token`。返回 GitHub App 对指定单仓库的安装令牌，权限固定为 Contents read、Issues write、Pull requests write，通常有效一小时。
8. **回复结果并撤销**：用临时令牌调用 GitHub 评论／Review API，完成后调用 `POST /external/revoke`。

安全边界：

- 客户端私钥、原始签名 JWT 和 GitHub Token 不进入数据库；数据库保存公钥、指纹、请求摘要和签发状态。
- 每个客户端每小时最多兑换 20 次；同一个签名证明只能兑换一次，重启后也不能重放。
- 转发默认只接受 HTTPS，并拒绝私网、回环和本地地址。内网接收端必须由部署管理员在 `BOT_FORWARD_PRIVATE_HOSTS` 中显式列出准确主机名，不支持通配符。
- 更换公钥或停用客户端只阻止新的签发；已经领取的 GitHub Token 需主动撤销或等待到期。
- 想只使用外部检视时，可以保留仓库启用但关闭内置 `review_enabled`。转发订阅有自己的开关，不依赖内置模型或检视开关。

## 配置检查清单

- [ ] `docker compose ps` 中 `bot`、`manager`、`webhook`、`tunnel` 正常；`key-init`、`project-image` 已成功退出。
- [ ] 管理页面能登录，`GET /healthz` 返回 `{"ok":true}`。
- [ ] 公网 HTTPS 地址在向导中检查通过；`/.well-known/`、`/hooks/github/`、`/external/` 都转到 `8791`。
- [ ] GitHub App 已安装到目标仓库；Webhook 最近一次投递为 `200`，并能在投递列表中看到。
- [ ] App 权限包含 Contents write、Issues write、Pull requests write、Metadata read。
- [ ] 模型已创建，Key 可用；启动项目时已选择模型。
- [ ] 内置检视的项目状态为“工作中”；启动前的事件不会补跑，需要重新触发。
- [ ] 检视规则中的三个触发和评论语言符合预期；`review_label` 不超过 50 字符。
- [ ] 仓库 `.bot` 文件和 `computer.yaml` 在默认分支上；PR 修改这些文件会触发人工确认提示。
- [ ] 仓库 YAML 文件名是 `<owner>__<repo>.yml`；修改后已重建或重启；`GET /api/automation` 能看到计划。
- [ ] （可选）外部执行端：兑换地址已设置，客户端公钥已登记，订阅签名密钥已保存到接收端，`/external/token` 与 `/external/revoke` 可从公网访问。
- [ ] 远程访问管理页面时：使用独立 HTTPS 入口，并设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN`。

## 配置参考

### 端口与监听

| 位置 | 端口 | 用途 |
| --- | --- | --- |
| 宿主机 → `bot` | `8791` | 公网 Webhook、`/external/token`、`/external/revoke`、向导探测 |
| 宿主机 → `bot` | `8792` | 管理页面与管理 API；默认仅 `127.0.0.1` |
| `manager` | `8793` | 内部控制面调用，不对宿主发布 |
| `webhook` | `8794` | 读取 tunnel 状态与路由，仅供控制面 |
| `tunnel` → `webhook` | `8791` | Cloudflare Tunnel 的唯一上游 |

### 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `BOT_WEBHOOK_PORT` | `8791` | Compose 映射到宿主机的 Webhook 端口 |
| `BOT_ADMIN_PORT` | `8792` | Compose 映射到宿主机的管理端口（默认只绑回环） |
| `BOT_COOKIE_SECURE` | `false` | 管理站使用 HTTPS 时设为 `true`，Cookie 加 `Secure` |
| `BOT_ADMIN_ORIGIN` | 空 | 管理站 origin，例如 `https://bot-admin.example.com`；也用于 App manifest 回调 |
| `BOT_GITHUB_API_URL` | `https://api.github.com` | GitHub API 地址；GitHub Enterprise Server 改为对应地址 |
| `BOT_FORWARD_PRIVATE_HOSTS` | 空 | 允许转发到内网的主机名，逗号分隔，必须精确匹配 |
| `BOT_PROJECT_EGRESS` | `true` | 项目电脑是否允许访问外网；设为 `false` 使用无出口内部网络 |
| `BOT_DATABASE_PATH` | `/data/control.sqlite` | 控制面 SQLite 路径 |
| `BOT_MASTER_KEY_FILE` | 无（必填） | AES-256-GCM 主密钥文件；Compose 由 `key-init` 生成 |
| `BOT_MANAGER_TOKEN_FILE` | 无（必填） | bot 与 manager 的内部认证文件 |
| `BOT_MANAGER_URL` | `http://manager:8793` | manager 内部地址 |
| `BOT_REPOSITORY_CONFIG_DIR` | `<应用目录>/config/repositories` | 仓库 YAML 目录；损坏的配置会阻止启动 |
| `BOT_TUNNEL_TOKEN_FILE` | `/tunnel/token`（Compose） | Cloudflare Tunnel token 文件；由向导写入 |
| `BOT_TUNNEL_METRICS_URL` | `http://webhook:8794`（Compose） | 读取 tunnel 连接状态与路由 |
| `BOT_MANAGER_DATABASE` | `/data/manager.sqlite` | manager 环境账本路径 |
| `BOT_PROJECT_IMAGE` | `department-bot-project:local` | manager 启动项目容器使用的镜像 |

`BOT_WEBHOOK_PORT`、`BOT_ADMIN_PORT`、`BOT_COOKIE_SECURE`、`BOT_ADMIN_ORIGIN`、`BOT_GITHUB_API_URL`、`BOT_FORWARD_PRIVATE_HOSTS`、`BOT_PROJECT_EGRESS` 由 `compose.yaml` 读取，可写在同目录的 `.env` 或 shell 环境里。其余变量需要直接在 `compose.yaml` 的 `environment` 中追加。

### 管理 API

除初始化状态、初始化、登录和健康检查外，管理 API 都需要登录会话。登录／初始化响应设置 `HttpOnly; SameSite=Strict` Cookie，并返回 `csrf_token`；之后的写请求必须提供同值 `X-CSRF-Token` 和 `Content-Type: application/json`。登录后 `GET /api/auth/me` 可读取当前会话的 CSRF 值。接口不接受额外字段，不支持传入 `role` 将自己升级。HTTP 失败只返回稳定错误码，不回显输入或内部异常。

| 路径 | 方法 | 功能和范围 |
| --- | --- | --- |
| `/healthz` | GET | 两个监听端口的数据库健康检查 |
| `/api/setup` | GET / POST | 初始化状态／仅首次创建超级管理员，POST 字段 `username,password` |
| `/api/auth/login`、`/api/auth/logout`、`/api/auth/me` | POST / POST / GET | 登录、退出、会话与仓库权限 |
| `/api/onboarding` | GET | 向导状态：公网地址、tunnel、App、模型、安装是否跳过、是否完成 |
| `/api/onboarding/address`、`/tunnel`、`/use-app`、`/manifest`、`/installation`、`/model`、`/complete` | POST | 向导各步骤：验证公网地址、保存／撤销 tunnel token、使用已有 App、创建 App manifest、跳过安装、选择共享模型、完成 |
| `/api/users`、`/api/users/:id` | GET / POST、PATCH | 超级管理员列出／创建用户、停用或启用；创建可带 `role,repository_ids` |
| `/api/project-admin-assignments` | GET / PUT | 超级管理员查询／替换用户仓库分配，PUT 字段 `user_id,repository_ids` |
| `/api/accounts`、`/api/accounts/:id` | GET / POST、GET / PATCH | 超级管理员管理 GitHub App／机器人账号；POST 字段 `name,type,app_id,private_key,token,webhook_secret` 按账号类型选用 |
| `/api/accounts/:id/credentials/revoke` | POST | 超级管理员撤销账号认证材料 |
| `/api/accounts/:id/endpoints`、`/api/accounts/:id/endpoints/:endpoint` | POST、PATCH | 创建签名入口／轮换或关闭签名材料；PATCH 带 `webhook_secret` 或 `revoke:true` |
| `/api/installations`、`/api/installations/sync` | GET、POST | 仅超级管理员；合并安装范围、登记、启用和环境状态；POST 立即全量同步 |
| `/api/installations/:id/activate`、`/disable` | POST | 仅超级管理员；启动（可带 `model_id,development_enabled,account_id`）或禁用仓库 |
| `/api/repositories`、`/api/repositories/:id` | GET / POST、GET | 范围内列表／详情；创建仅超级管理员，字段 `id,full_name,owner_id,account_id` |
| `/api/repositories/:id/policy` | GET / PATCH | 范围内策略，字段 `model_id,review_enabled,development_enabled,enabled,test_command,base_branch,max_revisions,review_label,review_issues,review_pull_requests,review_pr_updates,review_language,review_instructions,automation` |
| `/api/automation` | GET | 范围内最近 100 条自动化计划（`automation_runs`） |
| `/api/environments`、`/api/environments/:id` | GET | 按账号、组织 ID、仓库过滤；列表带当前任务，详情含容器、资源、最近任务和命令 |
| `/api/environments/:id/start`、`/stop`、`/reset` | POST | 仓库管理员操作；字段 `operation_id,generation`，操作 ID 为 48 位随机十六进制；重试必须复用同一 ID |
| `/api/environments/:id/configure` | POST | 仅超级管理员；字段 `operation_id,generation,spec`；保存后代次和工作卷不变，重建容器 |
| `/api/environments/:id/stats` | GET | 实时 CPU、内存、进程、网络、磁盘和工作区占用 |
| `/api/environments/:id/delete` | POST | 仅超级管理员，另需 `confirm:true`；删除容器／网络，保留卷 |
| `/api/models`、`/api/models/:id` | GET / POST、GET / PATCH | 范围内模型，字段 `repository_id,api_url,api_key,model_name`；PATCH 带 `version` |
| `/api/models/:id/projects`、`/api/models/:id/credentials/revoke` | PUT、POST | 超级管理员分配共享模型；有权编辑者撤销模型 Key |
| `/api/events`、`/api/events/:id` | GET | 范围内投递列表／正文和响应；可筛选 `repository_id,account_id,owner_id,event,status,delivery_id,limit,offset` |
| `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/logs` | GET | 范围内任务列表、结果、发布回执和过程日志；支持 `kind=review|development` 及分页 |
| `/api/tasks/:id/live` | GET | 运行中任务当前正在执行的命令及已产生的输出；`offset` 为已读字节数 |
| `/api/tasks/:id/retry` | POST | 有权项目管理员重试故障任务 |
| `/api/audit`、`/api/status` | GET | 范围内最近 100 条操作审计／当前能力状态 |
| `/api/external/settings` | GET / PUT | 读取／设置临时凭据兑换地址；PUT 仅超级管理员 |
| `/api/external/clients`、`/api/external/clients/:id` | GET / POST、GET / PATCH | 外部客户端；创建字段 `name,repository_id,auth_type,public_key/trust`，PATCH 可启停或更换公钥 |
| `/api/external/subscriptions`、`/api/external/subscriptions/:id` | GET / POST、GET / PATCH | 事件转发订阅；创建字段 `client_id,name,url,filters`，签名密钥只显示一次 |
| `/api/external/deliveries`、`/api/external/deliveries/:id/retry` | GET、POST | 最近 100 条转发状态；重试失败投递 |
| `/api/external/grants` | GET | 最近 100 条临时凭据签发记录，不含原始凭据 |
| `/hooks/github/:account/:endpoint` | POST | 仅 Webhook 端口，按已登记入口验签和归档 |

Webhook 对原始字节计算 HMAC-SHA256 并以恒定时间比较，验签后才解析和关联仓库。签名错误返回 401，未知入口返回 404，非法 JSON 返回 400，超过 2 MiB 返回 413（归档截断正文并标记不完整）。请求头中的认证、签名和 Cookie 等内容脱敏。请求正文、响应记录和 `(account_id,endpoint_id,delivery_id)` 去重键在同一个 SQLite `BEGIN IMMEDIATE` 事务提交后才返回成功；写库失败返回 503 且回滚去重。重复投递保存独立档案，响应标记 `duplicate:true`。失败投递不消费去重键，重试可成功。空仓库配置、未启动或已禁用的仓库只归档，不生成任务。

### 公网接口

这些接口走 Webhook 监听 `8791`，不使用管理会话：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/hooks/github/:account/:endpoint` | POST | GitHub Webhook |
| `/external/token` | POST | 外部执行端用公钥 JWT 或 GitHub Actions OIDC 兑换临时 GitHub 凭据 |
| `/external/revoke` | POST | 撤销已签发的临时 GitHub 凭据，幂等 |
| `/.well-known/bot-webhook-probe` | GET | 向导检查公网地址 |

## 运行与运维

Compose 包含：

| 服务 | 作用 |
| --- | --- |
| `bot` | 控制面；管理页面、管理 API、Webhook 和外部凭据兑换 |
| `manager` | 按仓库创建和管理动态项目容器；唯一挂载 Docker socket 的服务 |
| `webhook` | 固定的边缘网关，只把请求转发到 `bot:8791`，并提供 tunnel 状态桥 |
| `tunnel` | 可选的 Cloudflare Tunnel；没有 token 时不连接任何账号 |
| `key-init` | 一次性生成主密钥和内部认证 |
| `project-image` | 一次性确保批准的项目镜像已构建 |

`bot-data` 保存控制面 SQLite；`bot-keys` 保存加密主密钥，仅 bot 可读；`internal-keys` 保存 bot 与 manager 的内部认证；`manager-data` 保存环境和操作账本；`tunnel-keys` 保存 tunnel token 文件。每个环境代次还有独立具名工作卷和内部网络，标签同时绑定部署、仓库 ID、代次和资源类型。

只有 manager 挂载 Docker socket；它以 UID 0、GID 10001 访问 socket 和只读内部认证卷，丢弃所有 capabilities、禁止提权、根文件系统只读。Docker socket 本身仍赋予 manager 管理宿主 Docker 的能力，因此不对宿主发布 manager 端口，也不向项目网络提供该接口。它只接受登记项目的固定生命周期和 runner 请求，不能指定任意镜像、挂载、容器 ID 或 Docker API。bot 和项目容器没有 socket，项目容器也不挂载任何认证卷。

`bot`／`manager` 使用独立控制网络；`tunnel` 与 `webhook` 使用 `edge` 网络，`bot` 不加入 `edge`。每个项目使用自己的 bridge 网络，项目之间互不可达。项目容器默认可以访问外网，用于安装依赖和访问测试地址；设置 `BOT_PROJECT_EGRESS=false` 可改回无出口内部网络。外网出口意味着仓库代码也能访问宿主在 `0.0.0.0` 上发布的端口（例如 Webhook `8791`）；管理端口只绑定回环地址，不受影响。GitHub 和模型凭据仍不进入项目容器。

备份前停止 bot 和 manager，并备份五个部署卷（`bot-data`、`bot-keys`、`internal-keys`、`manager-data`、`tunnel-keys`）及项目具名卷；数据库停止写入后再复制，恢复时使用同一套内部认证和管理账本。丢失主密钥会无法解密凭据，丢失内部认证会改变部署 ID，不能用新的空账本直接接管旧容器。`docker compose down` 保留卷；`--volumes` 会删除部署认证和账本，日常升级不要使用。动态项目资源需要通过环境接口管理，Compose down 不会直接删除它们。

修改仓库 YAML 后：

```sh
docker compose up --build -d   # 重新构建镜像并复制 config/
docker compose logs -f bot     # 确认没有配置解析错误
```

配置解析失败会直接阻止启动，日志会给出字段名或文件路径；修好后再启动，不会带错误配置继续运行。

## 权限与安全

超级管理员管理账号、全局用户、仓库启动／禁用、共享模型和外部执行端；项目管理员只看到并操作分配给自己的仓库、投递、模型、策略和任务。无筛选查询同样受限，未关联仓库或验签失败的投递仅超级管理员可见。用户停用会撤销已有会话，仓库分配调整在后续请求立即生效；不能停用最后一名超级管理员。

账号凭据、入口签名材料、模型 Key、外部转发签名密钥和 tunnel token 用 AES-256-GCM 加密，密文绑定记录 ID。读取和写入响应只返回是否已配置，不返回明文或密文。更新时留空或仅空白的凭据保持原值；撤销使用专用动作，不能靠提交空字符串撤销。模型 PATCH 必须带读取到的 `version`，旧版本返回 409。撤销账号凭据不会连带撤销入口签名；要禁用入口需单独撤销该入口。

任务执行时校验账号、实际仓库 ID 和所有者。GitHub App 在控制面签发 JWT、取得目标仓库安装令牌；机器人账号使用已保存的 Token；两者都不进入项目环境。控制面不运行仓库 shell 或 git 命令，真实仓库写入由控制面按 outbox 对账后发布。

仓库代码、Issue／PR 正文、评论和 `.bot` 文件都是不可信输入，不能修改权限、镜像、发布目标或认证。外部执行端拿不到 GitHub App 私钥、入口签名密钥、模型 Key 或长期账号 Token；兑换得到的 GitHub 安装令牌只限单个仓库，权限固定为 Contents read、Issues write、Pull requests write，且仍是 Bearer 凭据，不能限定到单条 PR。

## 自动化规则与执行

`src/automation/` 提供规则引擎和内置模块（`label-lint`、`pr-status`、`gate`、`merge-queue`）。模块是纯函数：输入事件、仓库配置和调用方能核实的事实，输出动作列表；不访问网络，不写数据库。事实缺失时 fail-closed，例如无法确认 maintainer、冲突状态或必需检查时，不会凭载荷放行 `ready`。

webhook 落库的同一个事务里，`recordAutomation` 读取仓库配置、跑全部模块，把计划写入 `automation_runs`（`dry_run`、动作、说明）。规则异常只记在该运行上，不会让 Webhook 投递失败。`GET /api/automation` 返回调用者有权限仓库的最近 100 条计划。

真正的 GitHub 写入由 `src/automation/runner.ts` 的 `ActionExecutor` 接口承接，并接入现有 outbox；当前执行器尚未接线，所以任何规则运行都不会写入 GitHub。新增能力的步骤见 [docs/automation.md](docs/automation.md)。

## 项目电脑生命周期

启用仓库时后台登记一个环境；创建与周期对账均按仓库 ID 幂等，不随 Issue 或 PR 结束而删除。启动和后续命令复用同一容器及卷。同仓库的生命周期和执行请求持有同一串行锁，不同仓库可并行；命令结束后容器继续运行，不再重启：默认清理命令的进程组，再由 runner 结束容器内除 init、空闲进程和自身以外的残留进程。命令可声明 `keep_background`，后台进程保留给同一任务后续命令使用；任务结束或其他任务开始使用这台虚拟电脑前统一结束。容器以 Docker init 运行以回收僵尸进程。

禁用会停止处理新事件、中止正在执行的任务并停止虚拟电脑，保留卷；再次启用复用原代次和数据。签名可信的 App 卸载／暂停事件按账号和所有者范围停用，移除仓库事件按账号和仓库 ID 停用；这些意图随投递事务保存，再由后台停止环境，不在 webhook 响应链路调用 Docker。全量同步发现仓库不再安装时只标记“已移出安装”，不自动改变启用状态。停止、重置或删除会先中断正在执行的长命令。

重置先停止所有旧代容器并确认不再运行，然后增加 generation、保存旧卷，创建新代容器、新卷和新网络。失败进入 reset_failed，禁止普通启动旧环境，必须显式重试重置。删除默认只删除受管容器和网络，保留卷；停用和卸载不会删除资源。旧代容器始终停止，旧卷仅保留待备份／清理，不挂到新项目环境。

manager 重启会先停止不确定的执行，标记未完成操作 interrupted，再用同一代容器和卷检查 runner／journal 后恢复 ready；重置中断则保持 reset_failed。运行期发现容器重启或退出同样重新恢复，不以 Docker running 代替 ready。操作 ID 持久化去重，代次检查阻止旧请求写新环境，状态 revision 防止旧响应覆盖新状态。

当前 runner 为无网络监听的一次性固定执行入口：manager 通过 Docker exec 发送校验后的请求，返回 JSON 与持久 journal，调用者不能指定 exec argv 或用户。支持工作区相对文件读取／写入和 shell 命令，单条命令时长受项目规格 `max_command_minutes` 限制（runner 绝对上限 4 小时）；单次写入 48 KiB、读取 1 MiB、命令输出 1 MiB。命令运行中输出同步写入 journal 旁的临时文件，manager 的只读 `output` 接口按字节偏移读取，不占用项目锁。项目运行用户为 10001，根文件系统只读，工作卷可写；CPU、内存、进程数和 /tmp 默认 2 核、4096 MB、1024、1024 MB，超级管理员可按仓库修改。

批准的项目镜像自带 Node.js 22（npm、corepack 的 pnpm／yarn）、Python 3.11（pip、venv、uv）、gcc／g++／make、git、git-lfs、curl、wget、jq、ripgrep、sqlite3、zip／unzip。仓库需要的系统软件包由 manager 以批准镜像为底、用固定的 apt 命令构建派生镜像；非机密环境变量注入容器并传给每条命令；初始化脚本以项目用户在 `/workspace` 运行，`HOME=/workspace/home` 在工作卷中。Git 操作在容器内执行；上游 API 认证始终由控制面代理。执行入口仅供内部控制面和验收调用，管理页面没有通用终端。

实际 Docker 验收运行 `npm run test:docker`，需要 Docker 和 Playwright 浏览器。它使用独立 Compose 项目和 18881／18882／18883 测试端口，按本次部署标签清理容器、网络及卷，输出保存在 `.tmp/project-env/`。

## 检视与开发数据流

在项目设置中选择 `model_id`，打开 `review_enabled`，需要自动实现时再打开 `development_enabled`，建议设置可信的 `test_command`。Issue 在 opened 时检视；PR 在 opened、ready_for_review、synchronize 且非草稿时检视当前 head。三类触发可分别关闭；关闭 PR 新提交触发后，bot PR 的自动跟进也停止。普通评论、编辑和重新打开不额外触发。未启用检视的仓库只归档，草稿不建检视任务。投递去重和任务逻辑去重独立；归档、去重与入队在同一事务提交后才确认成功。

后台按仓库串行认领任务，拉取本仓 Issue／PR、讨论、完整分页 diff 与固定 SHA 的代码材料。已保存模型只收到这个项目的上下文，并可调用 read_file、write_file、run_command 等受任务约束的工具。仓库材料属于不可信输入，不能修改权限、镜像、发布目标或认证。单个任务最多 32 次模型响应；模型调用 `run_command` 时可设 `timeout_seconds`（默认 120，最多为项目的 `max_command_minutes`）和 `keep_background`，仓库测试验证同样受该上限；任务上下文包含虚拟电脑的资源、工具链、额外软件包和环境变量名；临时调用失败最多重试 5 次，配置故障单独显示。

每次检视发布一条总结讨论评论，包含总结、非行内 finding 和检视 SHA。Issue 只用普通评论。PR 每条 finding 由模型选择普通评论或行内评论并给出理由，服务端用真实 diff 校验 path／line／side；缺少可核对位置时转普通评论，不猜行号。行内 Review 的 event 恒为 COMMENT，模型不能选择批准或请求变更，没有自动合并接口。发布前重新检查 head，过时任务标为 superseded；评论写明实际检视 SHA，Review 和每条行内评论的 GitHub ID 保存到任务回执。设置了 `review_label` 时，总结评论发布成功后由控制面用同一安装令牌给 Issue／PR 加这一个标签；仓库没有该标签时由 GitHub 创建。

Issue 检视结果明确要求代码变更、存在原文证据且无需补充信息时，若仓库打开开发，创建关联开发任务。在同一项目容器的新任务工作目录中修改代码，模型完成后服务端再次运行仓库指定测试；未配置固定测试时使用模型给出的测试命令，不能没有测试。失败不会推分支或开 PR。成功后检查测试前后候选 tree 一致，再由控制面发布唯一 `bot/issue-...` 分支，并创建 PR、回填链接。默认分支从 GitHub 元数据或仓库 policy 获取。

别人的 PR 只检视，不产生向作者分支提交的任务；分支名或机器人名称不能代替归属记录。由本系统创建的 PR 保存不可变 PR ID、作者、head 仓库、分支和发布 SHA，只有这些身份仍匹配、策略允许且确有修改项时才在原分支跟进。跟进默认最多 3 轮，可在 policy 的 `max_revisions` 中设置 0–10；不另开 PR，不强推，不自动合并。

## 无凭据代码代理与发布

当前采用 Git 数据 API 的有界快照传输：控制面读取固定 commit 的 tree/blob，经 manager 将文件分块交给 runner；runner 校验 blob 与源 tree，构建本地 Git 快照。它不是完整上游历史克隆，模型上下文和评论覆盖说明明确标识这一点。单文件最多 1 MiB，快照最多 2000 文件／32 MiB，超限、子模块或截断 tree 进入明确故障，不用不完整工作区开发。二进制和符号链接按 Git 对象处理，相对文件工具不跟随越界符号链接。

开发候选由容器内 Git 生成，控制面保存候选 tree、文件清单、测试输出与本地提交映射，经 Git 数据 API 上传 blob/tree/commit。只有 GitHub 返回 tree 与已验证候选完全一致，才创建或更新登记的 bot 分支。更新固定 force:false；未知或变化的分支 head 会阻止发布。容器里没有 GitHub remote 认证、私钥或模型 Key；控制面不运行仓库 shell 或 git 命令。真实仓库访问仍需为 App／账号提供相应 Contents、Issues 和 Pull requests 权限。

评论、Review、分支和 PR 都有持久 outbox。请求结果未知时按任务 marker、head 和远端对象先对账；未能确认就保持 waiting_publication，不盲目重复。控制面重启后恢复未完成阶段，已完成任务不重新入队；manager 中断的命令不当作通过，重新检查环境后在新 attempt 工作目录继续，旧目录保留。同代已完成工具通过原操作 ID 回放，generation 变化会阻止旧任务直接写入新环境。

## 源码与验证

`src/main.ts` 是控制面入口，`src/server.ts` 分离管理与 Webhook 两个监听。`src/app/` 保存账号、登录、仓库授权、模型、安装同步和投递归一化逻辑；`src/onboarding/` 是接入向导，`src/external/` 是外部执行端与凭据 broker；`src/core/security.ts` 提供验签、慢哈希和凭据加密，`src/storage/database.ts` 管理 SQLite、事务及审计；`static/` 是同一管理入口。`src/automation/` 是仓库规则引擎和 YAML 加载；`src/agent/` 保存模型循环、任务认领及恢复，`src/review/` 保存触发和位置校验，`src/github/` 保存授权读取及发布 outbox。`src/projects/` 是环境网关，`manager/` 管理受管 Docker 资源，`runner/` 是容器内命令／文件协议，`images/project/` 构建批准镜像，`webhook/` 与 `tunnel/` 是边缘入口。manager／runner 独立实现，保留 Apache-2.0 及 NOTICE 中的上游设计归属。

验证需要 Node.js 22.13+ 和 npm；这些是源码检查命令，部署仍使用 Docker：

```sh
npm ci
npm run check
npm test
docker compose config --quiet
```

浏览器验收使用固定在 lockfile 的 Playwright：

```sh
npx playwright install chromium --only-shell
npm run test:e2e
```

完整旅程和相关测试：

| 命令 | 覆盖内容 |
| --- | --- |
| `npm run test:docker` | 两个真实项目环境、串行与并行、文件／卷／网络隔离、代次重置、重启和角色页面 |
| `npm run test:agent` | Issue 到 bot PR、草稿忽略、COMMENT 行内评论、别人 PR 不推送、bot PR 跟进、重复投递／未知响应对账、manager 中断恢复、凭据隔离 |
| `npm run test:external:docker` | 独立临时镜像和无外网容器中的签名转发、临时令牌兑换和 Bot 身份评论 |

测试使用独立临时 SQLite、随机端口和独立 Compose 项目，不占用部署数据；产物放在忽略提交的 `.tmp/`。

## 当前限制

尚未接入 Git smart HTTP／完整历史传输、子模块／LFS、按域名白名单的出口代理和长命令跨 manager 重启续跑（manager 重启会中断正在执行的命令）。命令输出由控制台每 2 秒轮询增量读取，不是推送。仓库自动化规则只生成计划，执行器尚未接入 GitHub 写入。外部执行端的转发是至少一次投递，接收端必须按转发 ID 做幂等；已经发出的网络请求无法撤回。仓库自动化的 `automation` JSON 和部分授权管理继续通过管理 API 完成。没有聊天、图形桌面、浏览器接管或远程桌面能力。
