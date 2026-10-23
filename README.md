# 部门公共 Bot

一个 Node.js 22.13+ / TypeScript 控制面，使用系统内账号管理多个 GitHub App、机器人账号、仓库权限、模型配置和 Webhook 投递。许可证为 Apache-2.0。

当前提供多账号控制面、每仓库一个长期 Docker 环境，以及可读代码、运行命令和修改文件的检视／开发 Agent。没有内置账号或仓库；开启仓库检视后接收事件并创建任务，满足开发条件时自动实现、测试、发布 bot 分支和 PR。`/api/status` 的项目环境、检视、开发及模型调用能力均可用；具体任务缺配置或失败会显示故障状态。

仓库级策略（标签规范、PR 门禁、合并队列、CI 阶段、事件转发）放在 YAML 里，不为每个仓库复制一套 GitHub Actions。配置入口和字段见[配置 Bot](#配置-bot-从零到可用)与 [docs/automation.md](docs/automation.md)。

## 目录

- [快速开始](#快速开始)
- [配置 Bot 从零到可用](#配置-bot-从零到可用)
- [配置参考](#配置参考)
- [运行与运维](#运行与运维)
- [权限与安全](#权限与安全)
- [自动化规则与执行](#自动化规则与执行)
- [项目环境生命周期](#项目环境生命周期)
- [检视与开发数据流](#检视与开发数据流)
- [无凭据代码代理与发布](#无凭据代码代理与发布)
- [源码与验证](#源码与验证)
- [当前限制](#当前限制)

## 快速开始

需要 Docker Engine、Docker Compose，以及一个能被 GitHub 访问的 HTTPS 地址（反向代理到 Webhook 端口）。在仓库根目录运行：

```sh
docker compose up --build -d
docker compose ps
```

打开 <http://127.0.0.1:8792/>，创建第一名超级管理员。初始化只允许成功一次，重启不会重新开放。用户名和密码属于本系统；密码长度为 12–256 字符，使用随机盐的 scrypt 慢哈希保存。先完成初始化，再将入口开放给其他人。

`8791` 是 Webhook 接收入口，宿主端口默认绑定 `0.0.0.0`；`8792` 是管理页面和管理 API，默认只绑定 `127.0.0.1`。两个端口不要混接：GitHub Webhook 只能走 `8791` 的 `/hooks/github/...`。管理页面需要远程访问时，另配 HTTPS 反向代理，并设置 `BOT_COOKIE_SECURE=true` 与 `BOT_ADMIN_ORIGIN`。

Webhook 入口必须能被 GitHub 访问，因此通常还要把 `8791` 通过 HTTPS 反向代理暴露到公网；只暴露 `/hooks/github/` 路径即可。管理 API 默认留在回环地址；如果外部执行端需要调用 `/api/agent/reviews`，只反向代理这一个路径，并使用 HTTPS。

## 配置 Bot 从零到可用

配置顺序如下：

```text
GitHub 仓库
   │  ① Webhook（签名密钥）
   ▼
[8791] 控制面
   │  ② 登记账号与入口
   │  ③ 登记仓库、模型与策略
   │  ④ 仓库 YAML：标签 / 门禁 / 合并 / CI 阶段
   │  ⑤ 可选：事件转发 → 外部执行端 → 临时 token 回写检视
   ▼
任务队列 → manager → 项目容器（检视 / 开发）
```

### 第 1 步：准备 GitHub 凭据

支持两种账号，任选一种：

| 类型 | 创建位置 | 登记字段 | 适用场景 |
| --- | --- | --- | --- |
| GitHub App（推荐） | GitHub → Settings → Developer settings → GitHub Apps → New GitHub App | `app_id`、`private_key`（`.pem`） | 多仓库、按仓库签发安装令牌、私钥不进入项目容器 |
| 机器人账号 | 单独 GitHub 用户 + Fine-grained PAT 或 classic PAT | `token` | 已有机器人账号、希望直接复用 PAT |

GitHub App 需要安装到目标仓库，并至少授予：

- **Contents**：Read and write（读取代码、发布 `bot/issue-*` 分支）
- **Issues**：Read and write（读取 Issue、发布评论、加标签）
- **Pull requests**：Read and write（读取 PR、发布 Review／评论）
- **Metadata**：Read（必需）

机器人账号的 PAT 至少需要同样的仓库权限。凭据由控制面用 AES-256-GCM 加密保存，不进入项目环境；更新时提交新值，撤销使用专用接口，不能靠提交空字符串撤销。

### 第 2 步：登记账号并取得 Webhook 地址

下面的示例使用管理 API。未初始化时先调用 `POST /api/setup`；已初始化则登录：

```sh
ADMIN=http://127.0.0.1:8792

# 仅首次部署：创建超级管理员（返回 csrf_token）
curl -sS -c cookie.txt -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<12 位以上密码>"}' \
  "$ADMIN/api/setup"

# 日常登录
curl -sS -c cookie.txt -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<密码>"}' \
  "$ADMIN/api/auth/login"
```

登录响应会设置 `bot_session` Cookie 并返回 `csrf_token`。所有写请求都要带同一个 Cookie、`X-CSRF-Token` 和 `Content-Type: application/json`。下面用 `jq` 读取 token；没有安装时也可以手动复制响应里的值：

```sh
CSRF=$(curl -sS -b cookie.txt "$ADMIN/api/auth/me" | jq -r .csrf_token)
api() { curl -sS -b cookie.txt -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' "$@"; }
```

登记 GitHub App（`private_key` 里的换行可以写成 `\n`）：

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

机器人账号把 `type` 改为 `bot_account`，去掉 `app_id`，改用 `token`：

```sh
api -X POST "$ADMIN/api/accounts" -d '{
  "name": "department-bot",
  "type": "bot_account",
  "token": "github_pat_...",
  "webhook_secret": "<与 GitHub Webhook 一致的随机串>"
}'
```

创建账号时会自动创建一个签名入口，响应里直接给出路径：

```json
{
  "account": {
    "id": "<account_id>",
    "name": "department-bot",
    "type": "github_app",
    "credentials_configured": true,
    "endpoints": [
      {
        "id": "<endpoint_id>",
        "webhook_path": "/hooks/github/<account_id>/<endpoint_id>",
        "secret_configured": true
      }
    ]
  }
}
```

记下 `account.id` 和 `webhook_path`。需要第二个入口或轮换密钥时，单独调用：

```sh
# 新建入口，响应返回新的 webhook_path
api -X POST "$ADMIN/api/accounts/<account_id>/endpoints" -d '{"webhook_secret":"<新密钥>"}'

# 轮换已有入口（也可传 "revoke": true 关闭入口）
api -X PATCH "$ADMIN/api/accounts/<account_id>/endpoints/<endpoint_id>" \
  -d '{"webhook_secret":"<新密钥>"}'
```

### 第 3 步：在 GitHub 配置 Webhook

在目标仓库（建议）或 GitHub App 级别添加 Webhook：

| 字段 | 值 |
| --- | --- |
| Payload URL | `https://<公网域名>/hooks/github/<account_id>/<endpoint_id>` |
| Content type | `application/json` |
| Secret | 与登记账号时提交的 `webhook_secret` 完全一致 |
| SSL verification | Enable |
| Events | Issues、Pull requests；建议同时勾选 Installation、Installation repositories |
| Active | 勾选 |

说明：

- 路径必须命中 Webhook 端口 `8791`，不是管理端口 `8792`。
- 只需要 `Issues` 和 `Pull requests` 就能触发检视／开发任务；`Installation`、`Installation repositories` 用于卸载、暂停或移除仓库时自动停用策略。
- 保存后 GitHub 会发送一次 `ping`。在管理页面的投递列表或 `GET /api/events` 中应能看到记录；签名错误返回 `401`，未知入口返回 `404`。
- 仓库必须先在第 4 步登记，未登记仓库的事件只归档，不创建任务。

### 第 4 步：登记仓库、模型和运行策略

先创建模型（只有启用检视或开发时才需要）。模型可以是仓库私有模型，也可以由超级管理员创建共享模型后再分配到仓库：

```sh
api -X POST "$ADMIN/api/models" -d '{
  "repository_id": "123456789",
  "api_url": "https://api.example.com/v1",
  "api_key": "sk-...",
  "model_name": "your-model"
}'
```

`api_url` 可以填基础路径或完整的 `/chat/completions` 路径；基础路径会自动追加后缀。响应中的 `model.id` 在策略里引用。

登记仓库。`id` 和 `owner_id` 必须是 GitHub 的数字 ID（字符串提交，避免大整数丢精度），不是 owner/repo 名称：

```sh
api -X POST "$ADMIN/api/repositories" -d '{
  "id": "123456789",
  "full_name": "Jianyu010/PPMA",
  "owner_id": "1234567",
  "account_id": "<第 2 步的 account_id>"
}'
```

- `id`：GitHub 仓库 ID。
- `full_name`：`owner/repo`，必须与 GitHub 一致。
- `owner_id`：仓库所有者（用户或组织）的数字 ID；任务执行时会再次核对。
- `account_id`：本系统中的账号 ID，不是 GitHub App ID。

GitHub 侧的 ID 可以从 `GET https://api.github.com/repos/<owner>/<repo>` 的 `id`、`owner.id` 读取，也可以从任意一次 Webhook 载荷的 `repository.id`、`repository.owner.id` 取得。

然后设置仓库策略：

```sh
api -X PATCH "$ADMIN/api/repositories/123456789/policy" -d '{
  "enabled": true,
  "model_id": "<model id>",
  "review_enabled": true,
  "development_enabled": false,
  "test_command": "npm ci && npm test",
  "base_branch": "main",
  "max_revisions": 3,
  "review_label": "bot-reviewed"
}'
```

| 字段 | 作用 |
| --- | --- |
| `enabled` | 是否接收并处理该仓库事件；停用后环境也会停止 |
| `model_id` | 检视／开发使用的模型；共享模型必须已分配给该仓库 |
| `review_enabled` | 对 Issue `opened`、PR `opened` / `ready_for_review` / `synchronize` 创建检视任务 |
| `development_enabled` | 允许从检视结果自动创建开发任务、推送 `bot/issue-*` 分支和 PR |
| `test_command` | 开发任务完成后强制运行的测试命令；开发模式建议必填 |
| `base_branch` | PR 的基准分支；留空使用仓库默认分支 |
| `max_revisions` | 对自有 bot PR 的最大跟进轮数，`0`–`10`，默认 `3` |
| `review_label` | 检视总结发布成功后给 Issue／PR 加的单个标签；留空不加 |
| `automation` | 仓库自动化 JSON；一般改用 YAML 维护，见第 5 步 |

`GET /api/status` 用于查看控制面当前开放的能力。缺少模型或 Key 被撤销时，任务显示 `waiting_configuration`，不会带着空配置运行。

### 第 5 步：用 YAML 配置仓库自动化（推荐）

每个仓库一份文件，放在 `config/repositories/<owner>__<repo>.yml`，文件名里的 `/` 写成 `__`：

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

字段说明：

| 区块 | 字段 | 说明 |
| --- | --- | --- |
| 根 | `dry_run` | 默认 `true`；规则只生成计划，不写 GitHub |
| `labels` | `axes` | 标签轴到值的映射；轴名小写，值不能带 `/` |
| `labels` | `manifest` | 额外单体标签；与轴展开结果合并 |
| `labels.lint` | `require`、`exactly_one`、`triage` | 必选轴、只能取一个值的轴、缺失时加的标签 |
| `labels.pr_status` | `ready`、`no_issue` | PR 状态标签 |
| `gate` | `ready_label`、`status`、`required_checks`、`maintainer_roles`、`review_must_be_answered` | PR 门禁；`required_checks` 必须被 `ci.stages` 中 `required: true` 的阶段覆盖 |
| `merge` | `enabled`、`oldest_first`、`skip_labels` | 合并队列；默认关闭，`method` 目前只能是 `merge` |
| `ci` | `stages` | 阶段 ID、workflow 文件名、runner 标签、是否必需 |
| `dispatch` | `target`、`events`、`labels` | 可选的事件转发规则，见第 6 步 |

生效方式和优先级：

- **优先级**：平台默认值 → 仓库 YAML → 通过 `PATCH /api/repositories/:id/policy` 保存的 `automation` JSON。后两者按字段深度合并，API 保存的值优先。
- **YAML 在启动时加载**。文件写错（字段拼错、轴名非法、`required_checks` 未被覆盖、文件名重复）会让启动失败，而不是带着错误配置运行。
- Docker 镜像会把 `config/` 复制进去；修改 YAML 后需要 `docker compose up --build -d`。也可以把配置目录挂载为只读卷，并用 `BOT_REPOSITORY_CONFIG_DIR` 指向它。
- 想快速试验而不重启，可以用 `POST /api/repositories/:id/labels/bootstrap` 的 `apply: true`，或直接 PATCH `automation`；这些值保存在 SQLite，重启后仍然生效。
- **当前版本执行器尚未接线**：规则会把计划写入 `automation_runs`（`dry_run`、动作、说明），可在 `GET /api/automation` 查看，但不会真的改标签、状态或合并 PR。可以先用它验证配置和回放事件，不会误改仓库。事件转发和外部检视回写不受此限制。

字段级 schema、模块行为和 fail-closed 规则见 [docs/automation.md](docs/automation.md)。仓库示例见 [Jianyu010__PPMA.yml](config/repositories/Jianyu010__PPMA.yml)。

### 第 6 步（可选）：把事件转发给外部执行端

典型场景：某个仓库的 PR 检视要跑在维护者自己的电脑上。Bot 只负责收事件、过滤、签名转发；个人电脑用自己的模型完成检视，再申请短期 token，以 Bot 身份把结果写回 GitHub。

```text
GitHub → Bot 收单 → 按仓库/事件/标签过滤 → 签名 POST → 个人电脑
                                                     │ 本地检视
                                                     ▼
                                       POST /api/agent/reviews（Bearer token）
                                                     │
                                                     ▼
                                         Bot 以自己身份发布 COMMENT Review
```

**1）登记转发目标**（仅超级管理员）。URL 支持 `http`/`https`，不能带用户名密码：

```sh
api -X POST "$ADMIN/api/dispatch-targets" -d '{
  "name": "review-laptop",
  "url": "https://laptop.example/hooks/bot",
  "webhook_secret": "<至少 32 字节随机串>"
}'
```

响应里的 `target.id` 用于仓库规则。目标名称唯一；停用用 `PATCH /api/dispatch-targets/<id>` 传 `{"active":false}`，删除前需先确认没有历史投递。

**2）在仓库配置里声明转发规则**（YAML 或 `automation` JSON 均可）：

```yaml
dispatch:
  - target: <target id>
    events: [pull_request.opened, pull_request.synchronize, pull_request.ready_for_review]
    labels: []          # 可选；非空时事件至少带一个指定标签才转发
```

`events` 支持三种写法：`event`（如 `issues`）、`event.action`（如 `pull_request.opened`）、`event.*`（如 `pull_request.*`）。

**3）外部端验签并处理**。Bot 发来的是 JSON 信封：

```json
{
  "event": "pull_request",
  "action": "opened",
  "repository_id": "123456789",
  "delivery_id": "<GitHub delivery id>",
  "payload": { "...": "原始 GitHub 事件" }
}
```

请求头：

| 请求头 | 含义 |
| --- | --- |
| `X-Bot-Event` | `event.action`，例如 `pull_request.opened` |
| `X-Bot-Delivery` | GitHub delivery ID |
| `X-Bot-Target` | 转发目标 ID |
| `X-Bot-Signature-256` | `sha256=HMAC-SHA256(webhook_secret, 原始请求体)` |

验签必须对**原始字节**计算并恒定时间比较，例如：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
const given = request.headers['x-bot-signature-256'] || '';
const ok = given.length === expected.length
  && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
```

返回任意 `2xx` 即确认；非 `2xx` 或超时会按 `5s / 10s / 20s / 40s` 退避，最多 5 次（首次发送加 4 次重试，约 75 秒），之后标记 `failed`。目标停用或删除不会影响 Webhook 收单。因为重试窗口有限，外部端应保持在线；原始事件仍可在 `GET /api/events` 查看。

**4）申请临时身份 token**（仓库管理员）。token 只返回一次，库里只存 SHA-256：

```sh
api -X POST "$ADMIN/api/repositories/123456789/agent-tokens" -d '{
  "subject": "review-laptop",
  "scopes": ["review:submit"],
  "ttl_seconds": 3600
}'
```

`ttl_seconds` 范围 60–86400，默认 3600；scope 目前只有 `review:submit`。撤销：

```sh
api -X DELETE "$ADMIN/api/agent-tokens/<token id>" -d '{}'
```

**5）以 Bot 身份回写检视结果**（外部端调用，不使用 Cookie／CSRF）：

```sh
curl -sS -X POST "https://<bot-admin>/api/agent/reviews" \
  -H "Authorization: Bearer botagent_<48 位十六进制>" \
  -H 'Content-Type: application/json' \
  -d '{
    "pull_number": 42,
    "head_sha": "<40 位小写 commit SHA>",
    "body": "检视结论……"
  }'
```

Bot 会在指定 head 上发布一条 `COMMENT` Review。`token + PR + head + 正文摘要` 幂等：网络重试不会重复发评论，返回 `duplicate: true`。token 对应单个仓库，不能跨仓库使用；过期、撤销或仓库不存在都返回 `401`。外部端始终不接触 GitHub App 私钥或 PAT。

### 第 7 步：初始化标签清单

当仓库既没有保存的 `automation`，也没有 `config/repositories/<owner>__<repo>.yml` 时，可以让 Bot 按仓库架构生成一份起始配置：

```sh
api -X POST "$ADMIN/api/repositories/123456789/labels/bootstrap" -d '{
  "areas": ["src/api", "src/runtime", "src/automation"],
  "apply": false
}'
```

响应包含：

| 字段 | 用途 |
| --- | --- |
| `source` | `generated`（本次生成）或 `repository`（已有保存配置／YAML） |
| `applied` | 是否已写入仓库策略 |
| `config` | 完整的自动化配置对象 |
| `yaml` | 可直接保存为 `config/repositories/<owner>__<repo>.yml` |
| `labeling` | 可直接作为仓库 `LABELING.md` 提交 |

行为约定：

- 内置清单包含 `type`、`source`、`priority`、`size`、`agent`、`status`、`pr`、`gate` 和 `blocker`；请求里的 `areas` 会清洗成小写 `area/*`（非字母数字转为 `-`，去重，最多 50 个）。
- 如果已有保存的策略或 YAML，返回 `source: "repository"`，**不会覆盖**；此时 `apply` 不生效。
- `apply: true` 会立刻写入 `policies.automation`；`apply: false` 只生成文件，适合走 PR 评审后提交。
- 生成的是起点，不是最终答案。建议按仓库真实模块调整 `axes.area`，再提交 YAML 和 `LABELING.md`，让配置进入版本控制。

### 配置检查清单

- [ ] `docker compose ps` 中 `bot`、`manager` 正常；`key-init`、`project-image` 已成功退出。
- [ ] 管理页面能登录，`GET /healthz` 返回 `{"ok":true}`。
- [ ] `GET /api/accounts` 中 `credentials_configured: true`，目标入口 `secret_configured: true`。
- [ ] 在 GitHub 查看 Webhook 最近一次 `ping` 为 `200`，并在 `GET /api/events` 中看到该投递。
- [ ] 仓库已登记，`id` / `owner_id` 与 GitHub 数字 ID 一致，`account_id` 指向正确账号。
- [ ] 策略中 `enabled: true`；启用检视时 `model_id` 可用且 `review_enabled: true`。
- [ ] YAML 文件名是 `<owner>__<repo>.yml`；修改后已重启或重建容器；启动日志没有配置错误。
- [ ] 事件触发后 `GET /api/automation` 能看到对应计划。
- [ ] 若配置了转发：目标 URL 从 Bot 容器可达，外部端验签通过；token 未过期，用完后撤销。
- [ ] 若远程访问管理页面：已配置 HTTPS、`BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN`。

## 配置参考

### 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `BOT_WEBHOOK_PORT` | `8791` | Compose 映射到宿主机的 Webhook 端口 |
| `BOT_ADMIN_PORT` | `8792` | Compose 映射到宿主机的管理端口（默认只绑回环） |
| `BOT_COOKIE_SECURE` | `false` | 管理站使用 HTTPS 时设为 `true`，Cookie 加 `Secure` |
| `BOT_ADMIN_ORIGIN` | 空 | 管理站 origin，例如 `https://bot-admin.example.com`；写请求会校验 Origin |
| `BOT_GITHUB_API_URL` | `https://api.github.com` | GitHub API 地址；GitHub Enterprise Server 改为对应地址 |
| `BOT_DATABASE_PATH` | `/data/control.sqlite` | 控制面 SQLite 路径 |
| `BOT_MASTER_KEY_FILE` | 无（必填） | AES-256-GCM 主密钥文件；Compose 由 `key-init` 生成 |
| `BOT_MANAGER_TOKEN_FILE` | 无（必填） | bot 与 manager 的内部认证文件 |
| `BOT_MANAGER_URL` | `http://manager:8793` | manager 内部地址 |
| `BOT_REPOSITORY_CONFIG_DIR` | `<应用目录>/config/repositories` | 仓库 YAML 目录；文件损坏会导致启动失败 |
| `BOT_PROJECT_IMAGE` | `department-bot-project:local` | manager 启动项目容器使用的镜像 |
| `BOT_MANAGER_DATABASE` | `/data/manager.sqlite` | manager 环境账本路径 |

`BOT_WEBHOOK_PORT`、`BOT_ADMIN_PORT`、`BOT_COOKIE_SECURE`、`BOT_ADMIN_ORIGIN`、`BOT_GITHUB_API_URL` 由 `compose.yaml` 读取并在容器内生效，可以写在同目录的 `.env` 或 shell 环境里。其余变量需要直接在 `compose.yaml` 的 `environment` 中追加，例如自定义配置目录：

```yaml
services:
  bot:
    environment:
      BOT_REPOSITORY_CONFIG_DIR: /config/repositories
    volumes:
      - ./config/repositories:/config/repositories:ro
```

注意：`BOT_REPOSITORY_CONFIG_DIR` 指向的目录必须在容器内存在；只设置变量而不挂载或复制文件会得到空配置。

### 管理 API

除初始化状态、初始化、登录、健康检查和 `/api/agent/reviews` 外，管理 API 都需要登录会话。登录／初始化响应设置 `HttpOnly; SameSite=Strict` Cookie，并返回 `csrf_token`；之后的写请求必须提供同值 `X-CSRF-Token` 和 `Content-Type: application/json`。登录后 `GET /api/auth/me` 可读取当前会话的 CSRF 值。接口不接受额外字段，不支持传入 `role` 将自己升级。HTTP 失败只返回稳定错误码，不回显输入或内部异常。

| 路径 | 方法 | 功能和范围 |
| --- | --- | --- |
| `/healthz` | GET | 两个监听端口的数据库健康检查 |
| `/api/setup` | GET / POST | 初始化状态／仅首次创建超级管理员，POST 字段 `username,password` |
| `/api/auth/login`、`/api/auth/logout`、`/api/auth/me` | POST / POST / GET | 登录、退出、会话与仓库权限 |
| `/api/users`、`/api/users/:id` | GET / POST、PATCH | 超级管理员列出／创建用户、停用或启用；创建可带 `role,repository_ids` |
| `/api/project-admin-assignments` | GET / PUT | 超级管理员查询／替换用户仓库分配，PUT 字段 `user_id,repository_ids` |
| `/api/accounts`、`/api/accounts/:id` | GET / POST、GET / PATCH | 超级管理员管理 GitHub App／机器人账号；POST 字段 `name,type,app_id,private_key,token,webhook_secret` 按账号类型选用 |
| `/api/accounts/:id/credentials/revoke` | POST | 超级管理员撤销账号认证材料 |
| `/api/accounts/:id/endpoints`、`/api/accounts/:id/endpoints/:endpoint` | POST、PATCH | 创建签名入口／轮换或关闭签名材料；PATCH 带 `webhook_secret` 或 `revoke:true` |
| `/api/dispatch-targets`、`/api/dispatch-targets/:id` | GET / POST、PATCH / DELETE | 超级管理员登记、停用或删除外部转发目标；字段 `name,url,webhook_secret,active` |
| `/api/repositories`、`/api/repositories/:id` | GET / POST、GET | 范围内列表／详情；创建仅超级管理员，字段 `id,full_name,owner_id,account_id` |
| `/api/repositories/:id/policy` | GET / PATCH | 范围内策略，字段 `model_id,review_enabled,development_enabled,enabled,test_command,base_branch,max_revisions,review_label,automation` |
| `/api/repositories/:id/labels/bootstrap` | POST | 按仓库架构生成标签清单；字段 `areas,apply`，返回 `config,yaml,labeling` |
| `/api/repositories/:id/agent-tokens` | GET / POST | 仓库管理员列出／签发外部执行端 token；POST 字段 `subject,scopes,ttl_seconds` |
| `/api/agent-tokens/:id` | DELETE | 立即撤销外部执行端 token |
| `/api/agent/reviews` | POST | 外部执行端用 `Authorization: Bearer botagent_…` 以 Bot 身份回写检视；字段 `pull_number,head_sha,body` |
| `/api/automation` | GET | 范围内最近 100 条自动化计划（`automation_runs`） |
| `/api/environments`、`/api/environments/:id` | GET | 按账号、组织 ID、仓库过滤环境；项目管理员无筛选也只见被分配仓库 |
| `/api/environments/:id/start`、`/stop`、`/reset` | POST | 仓库管理员操作；字段 `operation_id,generation`，操作 ID 为 48 位随机十六进制；重试必须复用同一 ID |
| `/api/environments/:id/delete` | POST | 仅超级管理员，另需 `confirm:true`；删除容器／网络，保留卷 |
| `/api/models`、`/api/models/:id` | GET / POST、GET / PATCH | 范围内模型，字段 `repository_id,api_url,api_key,model_name`；PATCH 带 `version` |
| `/api/models/:id/projects`、`/api/models/:id/credentials/revoke` | PUT、POST | 超级管理员分配共享模型；有权编辑者撤销模型 Key |
| `/api/events`、`/api/events/:id` | GET | 范围内投递列表／正文和响应；列表可筛选 `repository_id,account_id,owner_id,event,status,delivery_id,limit,offset` |
| `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/logs` | GET | 范围内任务列表、结果、发布回执和日志；支持仓库／账号／组织过滤及分页，不返回认领令牌或模型会话 |
| `/api/tasks/:id/retry` | POST | 有权项目管理员重试故障任务；发布未知时仍先对账，不直接重复 POST |
| `/api/audit`、`/api/status` | GET | 范围内最近 100 条操作审计／当前能力状态 |
| `/hooks/github/:account/:endpoint` | POST | 仅 Webhook 端口，按已登记入口验签和归档 |

Webhook 对原始字节计算 HMAC-SHA256 并以恒定时间比较，验签后才解析和关联仓库。签名错误返回 401，未知入口返回 404，非法 JSON 返回 400，超过 2 MiB 返回 413（归档截断正文并标记不完整）。请求头中的认证、签名和 Cookie 等内容脱敏。请求正文、响应记录和 `(account_id,endpoint_id,delivery_id)` 去重键在同一个 SQLite `BEGIN IMMEDIATE` 事务提交后才返回成功；写库失败返回 503 且回滚去重。重复投递保存独立档案，响应标记 `duplicate:true`。失败投递不消费去重键，重试可成功。空仓库配置和未登记的仓库只归档，不自动登记仓库或生成任务。

## 运行与运维

Compose 包含长运行的 `bot` 和 `manager`，以及一次性的 `key-init` 与 `project-image`。`project-image` 仅确保批准的项目镜像已构建，不是某个仓库的长期环境。manager 按仓库创建动态项目容器，项目容器不属于 Compose 静态服务，不对宿主或公网发布端口。

`bot-data` 保存控制面 SQLite，`bot-keys` 保存加密主密钥，仅 bot 可读；`internal-keys` 保存 bot 与 manager 的内部认证，manager 不挂载上游凭据或控制面数据库。`manager-data` 保存环境和操作账本。每个环境代次拥有独立具名工作卷和内部网络，标签同时绑定部署、仓库 ID、代次和资源类型。部署 ID 从独立内部认证材料派生，不同部署不会共用资源名。

只有 manager 挂载 Docker socket；它以 UID 0、GID 10001 访问 socket 和只读内部认证卷，丢弃所有 capabilities、禁止提权、根文件系统只读。Docker socket 本身仍赋予 manager 管理宿主 Docker 的能力，因此不对宿主发布 manager 端口，也不向项目网络提供该接口。它只接受登记项目的固定生命周期和 runner 请求，不能指定任意镜像、挂载、容器 ID 或 Docker API。bot 和项目容器没有 socket，项目容器也不挂载任何认证卷。bot／manager 使用独立控制网络，项目之间使用各自独立的内部网络；当前项目没有外网出口。

备份前停止 bot 和 manager，并备份四个部署卷及项目具名卷；数据库停止写入后再复制，恢复时使用同一套内部认证和管理账本。丢失主密钥会无法解密凭据，丢失内部认证会改变部署 ID，不能用新的空账本直接接管旧容器。`docker compose down` 保留卷；`--volumes` 会删除部署认证和账本，日常升级不要使用。动态项目资源需要通过环境接口管理，Compose down 不会直接删除它们。

修改仓库 YAML 后：

```sh
docker compose up --build -d   # 重新构建镜像并复制 config/
docker compose logs -f bot     # 确认没有配置解析错误
```

配置解析失败会直接阻止启动，日志中会给出字段名或文件路径；修好后再启动，不会带错误配置继续运行。

## 权限与安全

超级管理员登记 GitHub App（App ID、RSA 私钥）或机器人账号（Token），为入口保存签名凭据，然后登记需要启用的 GitHub 仓库 ID、owner/repo、所有者 ID 和关联账号。当前由管理员显式登记仓库，尚未定期自动同步安装列表。任务执行时校验账号、实际仓库 ID 和所有者；App 在控制面签发 JWT、取得目标仓库安装令牌，机器人账号使用已保存的 Token，均不进入项目环境。仓库 ID 使用字符串提交，避免 JavaScript 大整数丢精度。

超级管理员可创建用户和分配项目管理员。每名项目管理员可分配多个仓库，每个仓库可有多名项目管理员。项目管理员只看到并操作自己的仓库、投递、模型、策略及任务读取接口；无筛选查询同样受限，未关联仓库或验签失败的投递仅超级管理员可见。账号凭据、全局用户和授权关系接口只允许超级管理员调用。用户停用会撤销已有会话，仓库分配调整在后续请求立即生效；不能停用最后一名超级管理员。

模型配置包含接口 URL、API Key、模型名。超级管理员可管理全部模型；项目管理员可为自己的仓库创建和更新模型。部署共享模型由超级管理员通过 `models/:id/projects` 指定可用仓库，项目管理员只能读配置状态、选用，不能修改共享模型。仓库策略保存选用的模型 ID。保存即信任，可以发送本项目代码、日志和测试材料，不增加数据授权等待状态。接口采用兼容 Chat Completions 的 JSON 工具调用协议；URL 可填写基础路径或完整 `/chat/completions` 路径，基础路径会自动追加该后缀。没有模型配置、撤销 Key、认证失败会显示 waiting_configuration；网络／限流故障退避重试，持续故障停止任务。

账号凭据、入口签名材料、转发目标密钥和模型 Key 用 AES-256-GCM 加密，密文绑定记录 ID。读取和写入响应均只返回是否已配置，不返回明文或密文。更新时留空或仅空白的凭据保持原值；撤销使用专用动作，不能靠提交空字符串撤销。模型 PATCH 必须带读取到的 `version`，旧版本返回 409。撤销账号凭据不会连带撤销入口签名；要禁用入口需单独撤销该入口。

委托 token 只属于一个仓库和一组 scope，默认 1 小时有效，库里只存 SHA-256，可随时撤销。外部执行端拿不到 GitHub 私钥、PAT 或模型 Key，也不能让控制面执行外部代码或指定任意仓库。控制面只接受它的检视正文，并在对应 head 上以 Bot 身份发布 `COMMENT` Review。

浏览器管理入口支持初始化、登录、投递列表与详情、项目环境列表和启动／停止／重置、检视／开发任务的状态／结果／日志／重试，以及账号／仓库／模型／用户新增。授权分配调整、策略更新、凭据轮换及撤销通过管理 API 完成；这些操作尚未提供完整表单。投递页支持仓库、账号和组织 ID 过滤及分页；项目管理员不显示账号管理入口。

## 自动化规则与执行

PR 门禁、标签规范和合并队列是仓库策略，不写进每个仓库的 GitHub Actions：`src/automation/` 提供规则引擎和内置模块（`label-lint`、`pr-status`、`gate`、`merge-queue`）。每个仓库用 `config/repositories/<owner>__<repo>.yml` 声明自己的标签轴、门禁、合并策略和 CI 阶段，policy 的 `automation` 字段仍可覆盖，默认 dry-run、默认不自动合并。

webhook 落库的同一个事务里，`recordAutomation` 读取该仓库配置（策略行未保存过配置时用 YAML 文件）、跑全部模块，把计划写入 `automation_runs`（`dry_run`、动作、说明）。规则异常只记在该运行上，不会让 Webhook 投递失败。`GET /api/automation` 返回调用者有权限仓库的最近 100 条计划，可以直接看到“本应做什么”。

模块是纯函数：输入事件、仓库配置和调用方能核实的事实，输出动作列表；不访问网络，不写数据库。事实缺失时 fail-closed，例如无法确认 maintainer、冲突状态或必需检查时，不会凭载荷放行 `ready`。真正的 GitHub 写入由 `runner.ts` 的 `ActionExecutor` 接口承接，并接入现有 outbox；当前执行器尚未接线，所以所有规则运行都是 dry-run。

事件转发是独立链路：`enqueueDispatches` 在同一个事务里只写 `dispatch_deliveries`（`pending`），`DispatchWorker` 每 5 秒取到期行，签名并发送，失败按退避重试。它不做 GitHub 写入，也不依赖 dry-run；目标停用或删除不会阻塞 Webhook 收单。

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

## 源码与验证

`src/main.ts` 是控制面入口，`src/server.ts` 分离管理与 Webhook 两个监听。`src/app/` 保存账号、登录、仓库授权、模型和投递归一化逻辑，`src/core/security.ts` 提供验签、慢哈希和凭据加密，`src/storage/database.ts` 管理 SQLite、事务及审计；`static/` 是同一管理入口。`src/automation/` 是仓库规则引擎、YAML 加载、事件转发和标签初始化。`src/agent/` 保存模型循环、任务认领及恢复，`src/review/` 保存触发和位置校验，`src/github/` 保存授权读取及发布 outbox。`src/projects/` 是环境网关，`manager/` 管理受管 Docker 资源，`runner/` 是容器内命令／文件协议，`images/project/` 构建批准镜像。manager／runner 独立实现，保留 Apache-2.0 及 NOTICE 中的上游设计归属，不携带完整员工平台。

验证需要 Node.js 22.13+ 和 npm；这些是源码检查命令，部署仍使用上面的 Docker 方式。

```sh
npm ci
npm run check
npm test
docker compose config --quiet
```

`npm test` 覆盖并发初始化只成功一次、重启、权限收回、跨项目列表／详情／日志／模型隔离、凭据加密及不回显、验签、事务回滚重试、重复投递、先落库再确认、空配置不执行，以及仓库 YAML 校验、标签清单生成、事件过滤与签名转发、委托 token 的签发／幂等回写／撤销。SQLite 使用 Node 内置 `node:sqlite`，Node 22 会显示实验特性提示。

浏览器验收使用固定在 lockfile 的 Playwright，先运行 `npx playwright install chromium --only-shell`，再执行 `npm run test:e2e`；测试在自己的临时 SQLite 和随机端口上启动服务，覆盖初始化、登录、登记账号、查看签名投递、项目权限以及宽屏／窄屏页面，不占用部署数据或固定试用端口。输出放在忽略提交的 `.tmp/`。

## 当前限制

尚未接入完整安装列表同步、Git smart HTTP／完整历史传输、子模块／LFS 和长命令跨重启续跑。仓库自动化规则只生成计划，执行器尚未接入 GitHub 写入。事件转发要求外部端在线，重试窗口约 75 秒（单次请求超时另计）。项目当前没有外网出口，因此需要下载依赖或访问外部测试地址的任务会显示实际失败，受控依赖出口和更多开发工具链仍需后续配置。任务页面支持检视与开发结果，策略编辑和部分授权管理继续通过已有管理 API 完成。没有聊天、图形桌面、浏览器接管或远程桌面能力。
