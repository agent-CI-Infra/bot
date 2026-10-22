# 部门公共 Bot

一个 Node.js 22.13+ / TypeScript 控制面，使用系统内账号管理多个 GitHub App、机器人账号、仓库权限、模型配置和 Webhook 投递。许可证为 Apache-2.0。

当前交付的是控制面。没有内置账号或仓库；登记账号后，已验签的投递只被归档。模型配置保存后视为可信接口，但当前版本不会调用模型，也没有检视、开发调度或项目容器。仓库策略可以预先保存，接口和管理页均明确显示执行能力不可用，不会把空任务当作已完成的检视。

## Docker 部署

安装 Docker Engine 和 Compose，然后在仓库根目录运行：

```sh
docker compose up --build -d
docker compose ps
```

打开 <http://127.0.0.1:8792/>，创建第一名超级管理员。初始化只允许成功一次，重启不会重新开放。用户名和密码属于本系统；密码长度为 12–256 字符，使用随机盐的 scrypt 慢哈希保存。先完成初始化，再将入口开放给其他人。

`8792` 是管理页面和管理 API，`8791` 是 Webhook 接收入口，两者默认仅绑定宿主回环地址。管理员可在机器人账号页面登记账号，取得 `/hooks/github/<account_id>/<endpoint_id>`，通过自己的 HTTPS 反向代理将 GitHub Webhook 路由到 `8791`；管理页面经独立的 HTTPS 入口访问。不要把两个监听端口混接。可用 `BOT_WEBHOOK_PORT`、`BOT_ADMIN_PORT` 调整宿主端口。外部 HTTPS 管理入口需要设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN` 为自己的管理站 origin；这些变量通过 Compose 环境传入，不包含上游凭据。管理 API 不开放跨域访问。

Compose 只有一次性 `key-init` 和长运行的 `bot` 服务。`key-init` 使用同一镜像，首次在独立 `bot-keys` 卷创建 32 字节加密主密钥，重启保留原文件；`bot` 只读挂载该卷，将 SQLite 和 WAL 写入 `bot-data` 卷。两个容器均以 UID/GID 10001 运行，根文件系统只读，不挂 Docker socket，不执行仓库命令。镜像由 Dockerfile 多阶段构建，运行阶段只包含编译产物、静态页面和许可证，没有运行时 npm 依赖。

备份前先 `docker compose stop bot`，再同时备份 `bot-data` 和 `bot-keys` 两个卷；恢复时使用同一组卷，再启动服务。不要只复制正在写入的 SQLite 主文件。丢失密钥卷将无法解密已保存凭据。`docker compose down` 保留数据，附加 `--volumes` 会删除账号、归档和加密材料，日常升级不要使用。

## 使用与权限

超级管理员登记 GitHub App（App ID、RSA 私钥）或机器人账号（Token），为入口保存签名凭据，然后登记需要启用的 GitHub 仓库 ID、owner/repo、所有者 ID 和关联账号。此版本由管理员显式登记仓库；尚未从 GitHub 自动同步安装范围，也不会交换安装令牌或检查远端凭据有效性。仓库 ID 使用字符串提交，避免 JavaScript 大整数丢精度。

超级管理员可创建用户和分配项目管理员。每名项目管理员可分配多个仓库，每个仓库可有多名项目管理员。项目管理员只看到并操作自己的仓库、投递、模型、策略及任务读取接口；无筛选查询同样受限，未关联仓库或验签失败的投递仅超级管理员可见。账号凭据、全局用户和授权关系接口只允许超级管理员调用。用户停用会撤销已有会话，仓库分配调整在后续请求立即生效；不能停用最后一名超级管理员。

模型配置包含接口 URL、API Key、模型名。超级管理员可管理全部模型；项目管理员可为自己的仓库创建和更新模型。部署共享模型由超级管理员通过 `models/:id/projects` 指定可用仓库，项目管理员只能读配置状态、选用，不能修改共享模型。仓库策略保存选用的模型 ID。保存即信任，后续执行阶段可发送项目代码、日志和测试材料；本版不发起模型请求，不引入额外的数据授权等待状态。

账号凭据、入口签名材料和模型 Key 用 AES-256-GCM 加密，密文绑定记录 ID。读取和写入响应均只返回是否已配置，不返回明文或密文。更新时留空或仅空白的凭据保持原值；撤销使用专用动作，不能靠提交空字符串撤销。模型 PATCH 必须带读取到的 `version`，旧版本返回 409。撤销账号凭据不会连带撤销入口签名；要禁用入口需单独撤销该入口。

浏览器管理入口支持初始化、登录、投递列表与详情、账号／仓库／模型／用户新增。授权分配调整、策略更新、凭据轮换及撤销通过下列管理 API 完成；这些操作尚未提供完整表单。投递页支持仓库、账号和组织 ID 过滤及分页；项目管理员不显示账号管理入口。

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
| `/api/repositories/:id/policy` | GET / PATCH | 范围内策略，字段 `model_id,review_enabled,development_enabled`；保存不触发执行 |
| `/api/models`、`/api/models/:id` | GET / POST、GET / PATCH | 范围内模型，字段 `repository_id,api_url,api_key,model_name`；PATCH 带 `version` |
| `/api/models/:id/projects`、`/api/models/:id/credentials/revoke` | PUT、POST | 超级管理员分配共享模型；有权编辑者撤销模型 Key |
| `/api/events`、`/api/events/:id` | GET | 范围内投递列表／正文和响应；列表可筛选 `repository_id,account_id,owner_id,event,status,delivery_id,limit,offset` |
| `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/logs` | GET | 未来任务的受限读取契约；当前不创建任务，列表为空 |
| `/api/audit`、`/api/status` | GET | 范围内最近 100 条操作审计／当前不可用的执行能力 |
| `/hooks/github/:account/:endpoint` | POST | 仅 Webhook 端口，按已登记入口验签和归档 |

Webhook 对原始字节计算 HMAC-SHA256 并以恒定时间比较，验签后才解析和关联仓库。签名错误返回 401，未知入口返回 404，非法 JSON 返回 400，超过 2 MiB 返回 413（归档截断正文并标记不完整）。请求头中的认证、签名和 Cookie 等内容脱敏。请求正文、响应记录和 `(account_id,endpoint_id,delivery_id)` 去重键在同一个 SQLite `BEGIN IMMEDIATE` 事务提交后才返回成功；写库失败返回 503 且回滚去重。重复投递保存独立档案，响应标记 `duplicate:true`。失败投递不消费去重键，重试可成功。空仓库配置和未登记的仓库只归档，不自动登记仓库或生成任务。

## 源码与验证

`src/main.ts` 是控制面入口，`src/server.ts` 分离管理与 Webhook 两个监听。`src/app/` 保存账号、登录、仓库授权、模型和投递归一化逻辑，`src/core/security.ts` 提供验签、慢哈希和凭据加密，`src/storage/database.ts` 管理 SQLite、事务及审计；`static/` 是同一管理入口。新代码独立实现，不携带完整员工平台或执行环境。

验证需要 Node.js 22.13+ 和 npm；这些是源码检查命令，部署仍使用上面的 Docker 方式。

```sh
npm ci
npm run check
npm test
docker compose config --quiet
```

`npm test` 覆盖并发初始化只成功一次、重启、权限收回、跨项目列表／详情／日志／模型隔离、凭据加密及不回显、验签、事务回滚重试、重复投递、先落库再确认和空配置不执行。SQLite 使用 Node 内置 `node:sqlite`，Node 22 会显示实验特性提示。

浏览器验收使用固定在 lockfile 的 Playwright，先运行 `npx playwright install chromium --only-shell`，再执行 `npm run test:e2e`；测试在自己的临时 SQLite 和随机端口上启动服务，覆盖初始化、登录、登记账号、查看签名投递、项目权限以及宽屏／窄屏页面，不占用部署数据或固定试用端口。输出放在忽略提交的 `.tmp/`。

## 后续范围

下一阶段接入 GitHub 安装范围同步与令牌代理、检视总线及模型调用，再实现窄 manager／runner 和每仓库一个长期 Docker 环境。之后将检视结果按仓库策略接入 Issue 开发、bot 分支推送和 PR 发布；别人 PR 只评论，bot 自己的 PR 可继续提交，不自动合并。当前仓库没有这些执行能力，不提供环境重置或检视按钮。
