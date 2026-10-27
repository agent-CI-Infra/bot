# 管理 API

管理页面的操作都经由下列接口，它们和管理页面一起在管理端口（默认 `127.0.0.1:8792`）；只有 `/hooks/github/...` 在 Webhook 端口。部署见[部署细节](deployment.md)。

除初始化状态、初始化、登录和健康检查外，管理 API 都需要登录会话。登录／初始化响应设置 `HttpOnly; SameSite=Strict` Cookie，并返回 `csrf_token`；之后的写请求必须提供同值 `X-CSRF-Token` 和 `Content-Type: application/json`。登录后 `GET /api/auth/me` 可读取当前会话的 CSRF 值。接口不接受额外字段，不支持传入 `role` 将自己升级。HTTP 失败只返回稳定错误码，不回显输入或内部异常。

| 路径 | 方法 | 功能和范围 |
| --- | --- | --- |
| `/healthz` | GET | 两个监听端口的数据库健康检查 |
| `/api/setup` | GET / POST | 初始化状态／仅首次创建超级管理员，POST 字段 `username,password` |
| `/api/auth/login`、`/api/auth/logout`、`/api/auth/me` | POST / POST / GET | 登录、退出、会话与仓库权限 |
| `/api/users`、`/api/users/:id` | GET / POST、PATCH / DELETE | 超级管理员列出／创建用户、停用或启用；创建可带 `role,repository_ids`。DELETE 需 `confirm:true`，删除会话、项目成员分配和个人看板设置，审计保留；最后一名活跃超级管理员返回 409 `last_super_admin`，删除自己成功后会话失效 |
| `/api/settings` | GET / PATCH | 仅超级管理员，项目管理员得到 403。返回 `settings:{task_concurrency,task_concurrency_bounds}` 和 `version`；PATCH 字段 `task_concurrency`，是每台虚拟电脑默认同时运行的任务数，1–32 的整数，未设置时为 1，超出范围返回 400 `invalid_task_concurrency` |
| `/api/version` | GET | 仅超级管理员；控制面进程环境 `BOT_IMAGE_TAG` 给出的镜像标签 `{image_tag,source:"image"}`，源码直接运行、变量为空时为 `{image_tag:null,source:"source"}` |
| `/api/project-admin-assignments` | GET / PUT | 超级管理员查询／替换用户仓库分配，PUT 字段 `user_id,repository_ids` |
| `/api/accounts`、`/api/accounts/:id` | GET / POST、GET / PATCH / DELETE | 超级管理员管理 GitHub App／机器人账号；POST 字段 `name,type,app_id,private_key,token,webhook_secret` 按账号类型选用。DELETE 需 `confirm:true`，仍有项目使用该账号时返回 409 `account_has_projects`；只从本系统删除账号、Webhook 入口、安装同步记录和凭据，不调用 GitHub |
| `/api/accounts/:id/credentials/revoke` | POST | 超级管理员撤销账号认证材料 |
| `/api/accounts/:id/permissions` | GET | 超级管理员检查 GitHub App 权限：返回所需权限 `required`、App 缺少的项 `app.missing` 与 App 权限设置页 `app.settings_url`、每个安装缺少的项 `installations[].missing` 与确认页 `review_url`，全部满足时 `ok:true`；机器人账号返回 409 |
| `/api/accounts/:id/endpoints`、`/api/accounts/:id/endpoints/:endpoint` | POST、PATCH | 创建签名入口／轮换签名材料；PATCH 带 `webhook_secret` 或 `revoke:true` |
| `/api/repositories`、`/api/repositories/:id` | GET | 范围内列表／详情；仓库由安装同步发现，经 `POST /api/installations/:id/activate` 启动后登记 |
| `/api/repositories/:id/policy` | GET / PATCH | 范围内策略，字段 `model_id,review_enabled,development_enabled,enabled,test_command,base_branch,max_revisions,task_concurrency`；`task_concurrency` 是这台虚拟电脑同时运行的任务数，1–32 的整数，`null` 跟随全局默认，项目管理员可以改自己的项目，响应另带全局默认 `task_concurrency_default`；选择模型、启用检视／开发、指定必需测试和跟进预算；基准分支留空时读取仓库默认分支；检视规则字段 `review_issues`、`review_pull_requests`、`review_pr_updates`（布尔，分别控制 Issue 打开、PR 打开／转为可检视、PR 新提交是否触发检视）和 `review_language`（`auto`／`zh`／`en`）。检视指引和检视标签不是策略字段，写在规则文件里，见下一行 |
| `/api/repositories/:id/rules` | GET / PUT | 每份规则文件的内置默认、项目控制台、仓库文件三层和最终内容；PUT `{path,content}` 保存或（`content: null`）清除某个 `.bot/` 规则文件的控制台覆盖，`content` 超过 16384 个 UTF-8 字节或含 NUL 时返回 `invalid_rule_content`。`POST …/rules/refresh` 重新读取默认分支文件，`POST …/rules/apply-computer` 由超级管理员立即应用 `.bot/computer.yaml` |
| `/api/environments`、`/api/environments/:id` | GET | 按账号、组织 ID、仓库过滤环境；项目管理员无筛选也只见被分配仓库。列表和详情带这台电脑上正在运行的任务 `running_tasks`；详情另含生效并发度 `task_concurrency`、manager 给出的容器／卷／网络／镜像／资源限制、最近 20 个任务和最近 30 条命令 |
| `/api/environments/:id/start`、`/stop`、`/reset` | POST | 仓库管理员操作；字段 `operation_id,generation`，操作 ID 为 48 位随机十六进制；重试必须复用同一 ID |
| `/api/environments/:id/configure` | POST | 仅超级管理员；字段 `operation_id,generation,spec`，`spec` 可含 `cpus`（0.25–16，默认 2）、`memory_mb`（256–65536，默认 4096）、`pids`（64–16384，默认 1024）、`tmp_mb`（16–16384，默认 1024）、`egress`、`packages`（最多 100 个 Debian 包名）、`env`（最多 64 个非机密变量，`PATH`、`HOME`、`BOT_*`、`GIT_*` 等保留名拒绝）、`setup_script`（≤16 KiB）和一次性的 `rerun_setup`。范围由 manager 校验；规格随项目保存、跨重启和重置保留，保存后在项目锁内重建容器，工作卷和代次不变；软件包镜像构建失败时不改动正在运行的电脑 |
| `/api/environments/:id/stats` | GET | 范围内实时资源：CPU、内存、进程数、网络、磁盘读写和工作区占用（工作区每分钟最多统计一次），不占用项目锁 |
| `/api/environments/:id/delete` | POST | 仅超级管理员，另需 `confirm:true`；删除容器／网络，保留卷 |
| `/api/models`、`/api/models/:id` | GET / POST、GET / PATCH | 范围内模型，字段 `repository_id,api_url,api_key,model_name`；PATCH 带 `version` |
| `/api/models/:id/projects`、`/api/models/:id/credentials/revoke` | PUT、POST | 超级管理员分配共享模型；有权编辑者撤销模型 Key |
| `/api/models/endpoints?api_url=` | GET | 不需要 Key 的地址解析：返回 `chat_url`、`models_url` 和 `has_v1`（去掉末尾 `/` 和 `/chat/completions` 后，路径是否以 `/v1` 结尾）；不会添加或删除 `/v1`。模型的读写响应也带同样内容的 `endpoints` |
| `/api/models/upstream`、`/api/models/test` | POST | 未保存的模型：用提交的 `api_url,api_key` 获取上游模型列表；测试另带 `model_name`，发一次最小的 Chat Completions 请求。带 `repository_id` 时要求该项目的管理权限，为 null 时只允许超级管理员；不写数据库 |
| `/api/models/:id/upstream`、`/api/models/:id/test` | POST | 已保存的模型用自己的 URL、Key 和模型名获取列表／测试，正文 `{}`；权限与编辑该模型相同（共享模型只允许超级管理员），审计记为 `model.upstream_listed`／`model.tested`；Key 已撤销返回 409 `model_key_missing` |
| `/api/events`、`/api/events/:id` | GET | 范围内投递列表／正文和响应；列表可筛选 `repository_id,account_id,owner_id,event,status,delivery_id,limit,offset` |
| `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/logs` | GET | 范围内任务列表、结果、发布回执和带时间的过程日志；支持 `kind=review|development`、仓库／账号／组织过滤及分页。日志包含模型每步的思考摘要、工具调用与结果（长文本截断），不返回认领令牌或原始模型会话 |
| `/api/tasks/:id/live` | GET | 运行中任务当前正在执行的命令及其已产生的输出，参数 `offset` 为已读字节数 |
| `/api/board` | GET | 当前用户的视图、自定义单选字段及选项、六个固定 bot 阶段；阶段带 `hint` 说明，PR 看板措辞不同时带 `pr:{name,hint}` |
| `/api/board/cards` | GET | 按对象去重的卡片，参数 `view_id`（默认 `default`）、`group_by`、`filters`（JSON 数组）、`limit`（1–100）、`offset`（0–100000）；返回 `cards,has_more,limit,offset,counts`，始终限制在当前仓库授权范围。`counts` 为 `{issue,pr}` 总数，忽略 `object_type` 条件、保留其余条件，供 Issue／PR 切换显示；卡片的 `development_pr_number` 是最近开发任务结果里的 PR 编号 |
| `/api/board/cards/:repository/:type/:number/tasks` | GET | 同一对象的关联任务摘要，`type` 为 `issue` 或 `pr`，支持同样的有界分页；任务详情沿用 `/api/tasks/:id` |
| `/api/board/cards/:repository/:type/:number` | PATCH | `{field_id,option_id}` 修改当前用户的自定义单选值，`option_id:null` 清空；禁止写执行阶段，不创建或修改任务 |
| `/api/board/fields`、`/api/board/fields/:id/options` | POST | `{name}` 新建个人单选字段／新增选项（即加列），每用户最多 30 个字段、每字段最多 50 个选项 |
| `/api/board/views`、`/api/board/views/:id` | POST、PATCH / DELETE | 个人视图，字段 `name,group_by,filters,hidden_columns`；最多 50 个自建视图。内置 `default` 仅允许保存筛选和隐藏列，不能删除、改名或切换分组字段 |
| `/api/installations`、`/api/installations/sync` | GET、POST | 仅超级管理员；每个仓库一行，合并 GitHub 安装范围、登记、启用和环境状态，以及各账号最近同步结果；POST 立即全量同步 |
| `/api/installations/:id/activate`、`/api/installations/:id/disable` | POST | 仅超级管理员；启动（可带 `model_id,development_enabled,account_id`）或再次启用／禁用一个仓库 |
| `/api/installations/:id` | DELETE | 仅超级管理员，需 `confirm:true`；当场向 GitHub 核对后删除项目（未启动的仓库只删安装列表行）。仍能访问返回 409 `repository_still_accessible`，权限不足返回 409 `repository_permissions_insufficient`，GitHub 不可用、限流或答复不确定返回 502，凭据缺失返回 409 `github_credentials_missing`，以上都不删除；容器和网络删除失败或任务未停下时项目保持禁用、记录保留 |
| `/api/installations/permissions/check` | POST | 仅超级管理员；重读各账号授予的权限，返回每行的 `permission_missing,permissions_checked_at,permissions_stale` 和各账号错误，不改变安装状态 |
| `/api/tasks/:id/retry` | POST | 有权项目管理员重试故障任务；发布未知时仍先对账，不直接重复 POST |
| `/api/audit`、`/api/status` | GET | 范围内最近 100 条操作审计／当前能力状态 |
| `/api/costs` | GET | 范围内按 UTC 日期、项目聚合的模型估算费用。参数 `from,to` 为 `YYYY-MM-DD`（含首尾，默认最近 30 天，最多 366 天），`repository_id` 可省略，`currency` 为 `USD`（默认）或 `CNY`。最多 5000 个日期／项目分组，超限要求缩小范围；返回 `days,summary,collection_started_at`，不返回模型密钥或原始请求 |
| `/hooks/github/:account/:endpoint` | POST | 仅 Webhook 端口，按已登记入口验签和归档 |

Webhook 对原始字节计算 HMAC-SHA256 并以恒定时间比较，验签后才解析和关联仓库。签名错误返回 401，未知入口返回 404，非法 JSON 返回 400，超过 2 MiB 返回 413（归档截断正文并标记不完整）。请求头中的认证、签名和 Cookie 等内容脱敏。请求正文、响应记录和 `(account_id,endpoint_id,delivery_id)` 去重键在同一个 SQLite `BEGIN IMMEDIATE` 事务提交后才返回成功；写库失败返回 503 且回滚去重。重复投递保存独立档案，响应标记 `duplicate:true`。失败投递不消费去重键，重试可成功。空仓库配置、未启动或已禁用的仓库只归档，不生成任务。

项目列表接口 `GET /api/repositories` 与超级管理员的 `GET /api/installations` 在每个仓库上返回 `running_tasks` 和 `queued_tasks`。`GET /api/installations` 另返回 `permission_missing`：仍在安装列表中的仓库所缺权限（`permission,required,current`；机器人账号为 `repository_role`），未读到授予权限或不在安装列表时为 null；`permissions_stale` 表示授予权限已超过 10 分钟未重读。前者仅统计实际执行阶段，后者统计 queued；配置等待、环境等待与已结束任务不计入执行中。返回范围沿用项目管理员的仓库权限。列表开关调用 `PATCH /api/repositories/{id}/policy`，仅提交本次切换的 `review_enabled` 或 `development_enabled`，不更改项目总启用状态。

看板筛选格式为 `[{"field":"object_type","value":"pr"},{"field":"text","value":"research"}]`，最多 20 条，条件之间为“且”。支持 `repository_id`（仓库 ID）、`object_type`（`issue`／`pr`，不添加该条件表示全部）、`bot_stage`（`unreviewed,reviewing,reviewed,developing,developed,attention`）、`text`（编号可带 `#`，否则按标题文字匹配）、`include_closed`（布尔，默认 false）。`group_by` 为 `bot_stage` 或当前用户的单选字段 ID；空值列 ID 为 `unassigned`。筛选和隐藏列可在浏览器先预览，点击“保存视图”后持久保存。分页与列计数只表示已加载的卡片，不冒充全库总量；全量只看 `counts`。

任务列表、任务详情、项目最近任务和看板关联任务现在带 `metrics`：`runtime_ms`（累计已观测执行时长，不含排队／等待）、`running`、`complete`（历史或进程中断时可能不完整）、`input_tokens,output_tokens,cached_input_tokens,cache_hit_rate`、`requests,usage_missing_requests,cache_missing_requests,unpriced_requests` 和按币种分开的 `costs`。缓存是输入的子集，命中率用累计缓存 token 除以累计输入 token；缺少必要统计时返回 null，不用 0 冒充。`complete:false` 时显示的是已经观测到的部分。

模型创建和带 `version` 的 PATCH 还可提交 `pricing:{currency,input_per_million,output_per_million,cache_per_million}`，单价为每百万 token 的非负数（最多 1000000）。`pricing:null` 清除单价；读模型时返回当前单价，原有模型凭据及共享模型编辑权限不变。每次模型请求保存价格快照，费用为 `((输入-缓存)×输入单价 + 缓存×缓存单价 + 输出×输出单价) / 1000000`。缺少用量或单价时费用为 null；未返回缓存数据且缓存价不同于普通输入价时，也不能完整计价。费用页只汇总所选币种及尚未定价的请求，币种之间不作换算。

获取模型列表和测试模型的上游结果都在成功响应里返回：`ok` 表示上游是否成功，`status` 是上游的 HTTP 状态码（没有收到响应时为 null）。列表成功时返回 `models_url,total,truncated,models`，按名称排序，最多 200 个 id；测试成功时返回 `chat_url`、`model`（上游答复中的模型名）、`reply`（回复摘录，最多 200 个字符）、`finish_reason` 和 `elapsed_ms`。失败时返回 `error`（`upstream_http_error`、`upstream_timeout`、`upstream_unreachable`、`upstream_redirect`、`upstream_response_invalid`、`upstream_response_too_large`）和简短的 `message`：它只取自上游 JSON 的错误字段（`error.message`，或字符串形式的 `error`、`message`、`detail`、`msg`），重定向时是 `Location`，连接失败时是错误码；其他响应正文一律不回显。两类请求都在 15 秒后超时、不跟随重定向，结果中出现的 Key 先整体替换为 `[REDACTED]`，再截断。模型 URL 只接受 http(s)，不能带用户名、密码、查询串（`?`）或片段（`#`），否则保存、解析、获取列表和测试都返回 400 `invalid_api_url`；这条规则之前保存的这类 URL 也不能获取列表或测试。测试请求的内容是一句不含项目数据的探测，只带 `max_completion_tokens: 32`，不带 `max_tokens`；任务中的模型请求不受影响，仍只带一个输出上限字段，数值 8192。
