# AI 场景验收脚本

每轮验收起一套全新的 Bot：镜像用被测提交的 `sha-<12 位>` 标签，测试仓用 [`agent-CI-Infra/bot-acceptance-fixture`](https://github.com/agent-CI-Infra/bot-acceptance-fixture)，测完整套删除。这里的脚本负责一轮中确定的部分：起停、重置夹具、初始化和预检、等待、取证。剧本里需要判断的部分（编写 Issue 和 PR、扮演用户、判断结果是否合理、写报告）由测试 AI 完成，它只能通过 `console.mjs` 和 `wait.mjs` 接触 Bot。

脚本都是 Node.js 22 的 ES 模块，不依赖 `npm ci`；它们只调用控制台 API（与接入向导相同的接口）和 GitHub REST API，不读写 Bot 的数据库。

## 一轮的顺序

| 步骤 | 命令 | 做什么 |
| --- | --- | --- |
| 1 | `node bot-acceptance/reset.mjs` | 用测试者令牌重置夹具仓：删规则集和 main 的分支保护，关闭打开的 PR 和 Issue，删除 main 以外的分支，把 main 强推回 `seed` 标签。写 `fixture.json` |
| 2 | `node bot-acceptance/stack.mjs up` | 以 Compose 项目 `bot-acceptance` 拉起 `ACCEPTANCE_IMAGE_TAG` 的全部镜像，业务端口只绑本机回环。快速隧道模式下打印随机的 `trycloudflare.com` 地址。写 `stack.json` |
| 3 | `node bot-acceptance/bootstrap.mjs` | 建超级管理员（密码当场随机生成）→ 交隧道 token（命名隧道时）→ 验证公网地址 → 登记 App 并把它的 Webhook 改到本实例 → 登记并测试模型 → 同步安装、启动夹具仓项目、写入基线策略、完成向导 → 建只管夹具仓的项目管理员 → 预检（能力、项目行、权限缺口、项目电脑就绪、版本、GitHub 额度）。写 `target.json` |
| 4 | 测试 AI | 按剧本操作 GitHub；用 `console.mjs` 读写控制台，用 `wait.mjs` 等 Bot 处理完 |
| 5 | `node bot-acceptance/evidence.mjs`、`node bot-acceptance/stack.mjs logs` | 导出版本、项目行、策略、全部任务的详情和公开日志、投递、费用，以及各服务的容器日志，放到 `evidence/` |
| 6 | `node bot-acceptance/stack.mjs down` | 删除 Compose 项目和卷，以及 manager 按部署标签创建的项目电脑容器、卷、网络和镜像 |

重置放在初始化之前：这时 App 的 Webhook 还没有指向新实例，重置产生的关闭和推送不会变成本轮的任务。

## 环境变量

| 变量 | 用于 | 说明 |
| --- | --- | --- |
| `ACCEPTANCE_STATE_DIR` | 全部 | 本轮的文件目录，默认 `.tmp/bot-acceptance` |
| `ACCEPTANCE_GITHUB_TOKEN` | reset | 测试者账号只授权夹具仓的细粒度令牌：Administration、Contents、Issues、Pull requests、Workflows 写 |
| `ACCEPTANCE_IMAGE_TAG` | stack | 被测镜像标签，如 `sha-21430295709d` |
| `ACCEPTANCE_PROJECT`、`ACCEPTANCE_PORT`、`ACCEPTANCE_TUNNEL` | stack | Compose 项目名（必须以 `bot-acceptance` 开头，默认就是它）、本机端口（默认 8791）、`named`（默认）或 `quick` |
| `ACCEPTANCE_BOT_URL` | bootstrap | 本机控制台地址，默认 `http://127.0.0.1:8791` |
| `ACCEPTANCE_PUBLIC_ORIGIN` | bootstrap | GitHub 投递 Webhook 的 HTTPS 入口 |
| `ACCEPTANCE_TUNNEL_TOKEN` | bootstrap | 命名隧道的 token；快速隧道不需要 |
| `ACCEPTANCE_APP_ID`、`ACCEPTANCE_APP_PRIVATE_KEY`、`ACCEPTANCE_APP_WEBHOOK_SECRET` | bootstrap | 验收专用 App `bot-acceptance`。它要有 Workflows 写权限（门禁接入要提交 workflow）并订阅 Workflow run（Actions 失败处理），缺了初始化会直接停下并写明缺什么 |
| `ACCEPTANCE_BOT_MODEL_URL`、`ACCEPTANCE_BOT_MODEL_NAME`、`ACCEPTANCE_BOT_MODEL_API_KEY` | bootstrap | 被测 Bot 用的模型，登记为部署共享模型 |
| `ACCEPTANCE_ENVIRONMENT_TIMEOUT_MINUTES` | bootstrap | 第一次启动项目电脑最多等多久，默认 20 |

## 状态目录

| 文件 | 内容 |
| --- | --- |
| `target.json` | 被测对象：控制台地址、公网入口、App 和 Bot 的 GitHub 登录名、模型、项目 ID、版本、夹具起点。不含凭据，测试 AI 读它 |
| `fixture.json`、`stack.json` | 重置结果、栈的设置 |
| `admin.json`、`operator.json`、`*.session.json` | 超级管理员、项目管理员的账号和会话，权限 0600，从不打印 |
| `evidence/` | 取证结果 |

## 测试 AI 能用的命令

```sh
node bot-acceptance/console.mjs GET '/api/tasks?repository_id={repo}&limit=20'
node bot-acceptance/console.mjs PATCH /api/repositories/{repo}/policy '{"test_command":"sh scripts/test.sh"}'
node bot-acceptance/wait.mjs --number 12            # Issue/PR #12 的任务出现且全部不再排队或运行，并保持 60 秒不变
node bot-acceptance/wait.mjs --number 7 --allow-none   # 预期 Bot 不处理时（如草稿 PR）也能结束
```

`{repo}` 换成夹具仓的项目 ID。`console.mjs` 只接受本实例的 `/api/` 路径，会话是项目管理员的，能看什么、改什么由 Bot 自己的权限决定；部署级设置和超级管理员凭据它拿不到。`wait.mjs` 结束时退出码 0，超时（默认 30 分钟）退出码 2，两种情况都打印匹配任务的摘要。

## 安全约定

- 凭据只从环境变量读，写进状态目录时权限为 0600；脚本的报错只带 HTTP 状态和 API 错误码，不带请求正文。
- `reset.mjs` 只认 `agent-CI-Infra/bot-acceptance-fixture`，仓库名写在代码里，不从环境变量读。
- `stack.mjs` 只操作以 `bot-acceptance` 开头的 Compose 项目，删不到本机部署 `bot`。
- `bootstrap.mjs` 拒绝已经初始化过的实例：每轮都从空数据开始。

## 本机开发时运行

用快速隧道，不需要 Cloudflare 账号；端口和项目名与本机部署分开。快速隧道要请求 `api.trycloudflare.com`，`compose.quick-tunnel.yaml` 把宿主的 CA 文件只读挂进 tunnel 容器（tunnel 镜像本身不带系统根证书）。

```sh
export ACCEPTANCE_PROJECT=bot-acceptance-dev ACCEPTANCE_PORT=18791 ACCEPTANCE_TUNNEL=quick \
  ACCEPTANCE_STATE_DIR=.tmp/bot-acceptance-dev ACCEPTANCE_IMAGE_TAG=sha-$(git rev-parse --short=12 origin/main)
node bot-acceptance/reset.mjs
node bot-acceptance/stack.mjs up
ACCEPTANCE_BOT_URL=http://127.0.0.1:18791 \
  ACCEPTANCE_PUBLIC_ORIGIN=$(node -p "require('./.tmp/bot-acceptance-dev/stack.json').public_origin") \
  node bot-acceptance/bootstrap.mjs      # 另需 App、模型变量
node bot-acceptance/stack.mjs down
```

新的快速隧道域名大约一分钟后才能从公网解析，`bootstrap.mjs` 会重试公网地址验证，最多 3 分钟。

## 测试

`test/bot-acceptance-scripts.test.mjs` 让 `bootstrap.mjs` 对真实控制面和本地 GitHub、模型夹具走完整个初始化，并覆盖 `reset.mjs` 的调用顺序和 `wait.mjs` 的结束条件；它在 `npm test` 里运行，控制台 API 变了而脚本没跟上时会失败。
