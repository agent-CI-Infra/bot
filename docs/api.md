# 管理 API

管理页面的操作都经由下列接口，它们和管理页面一起在管理端口（默认 `127.0.0.1:8792`）；只有 `/hooks/github/...` 在 Webhook 端口。部署见[部署细节](deployment.md)。

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

项目列表接口 `GET /api/repositories` 与超级管理员的 `GET /api/installations` 在每个仓库上返回 `running_tasks` 和 `queued_tasks`。前者仅统计实际执行阶段，后者统计 queued；配置等待、环境等待与已结束任务不计入执行中。返回范围沿用项目管理员的仓库权限。列表开关调用 `PATCH /api/repositories/{id}/policy`，仅提交本次切换的 `review_enabled` 或 `development_enabled`，不更改项目总启用状态。
