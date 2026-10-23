# 部门公共 Bot

部门公共的 GitHub App 检视和开发 bot。一个控制面负责管理页面、接收 GitHub Webhook 和调度任务；每个启用的仓库各有一台长期运行的 Docker 容器（下文称“虚拟电脑”），bot 在里面读代码、跑命令。新开的 Issue 和 PR 会收到一条检视总结评论；打开自动开发后，明确要求改代码的 Issue 由 bot 实现、测试并开 PR。许可证为 Apache-2.0。

## 准备

- Docker Engine 和 Docker Compose v2（`docker compose version` 能输出版本）。
- 一个 GitHub 组织，以及能在其中创建和安装 GitHub App 的账号（组织所有者或 GitHub App 管理员）。
- 一个公网 HTTPS 入口，让 GitHub 能把 Webhook 送到这台机器：自己的域名加 HTTPS 反向代理，或者 Cloudflare Tunnel。
- 一个兼容 Chat Completions 的模型：接口 URL、API Key 和模型名。

## 启动

不需要克隆仓库，也不在本机构建：

```sh
mkdir department-bot && cd department-bot
curl -fsSLO https://raw.githubusercontent.com/agent-CI-Infra/bot/main/compose.yaml
docker compose up -d
```

然后在这台机器的浏览器打开 <http://127.0.0.1:8792/>。Bot 装在远程服务器上时，先 `ssh -L 8792:127.0.0.1:8792 <服务器>`，再在自己电脑上打开同一地址。

镜像发布在 GHCR，匿名拉取要求这些包已公开；如果拉取报 `denied` 或 `unauthorized`，克隆本仓库后[从源码构建](docs/deployment.md#从源码构建)。

## 第一次配置

1. **创建超级管理员。** 首页显示「创建第一名超级管理员」：填用户名和 12–256 位密码，点「初始化并登录」。初始化只成功一次，之后这里只有登录。
2. **走完接入向导。** 首次登录会自动打开「接入向导」（之后从顶部导航进入），按顶部的六步走：
   1. 公网 HTTPS：选「自建 HTTPS 中转」，把一个专用域名整个反向代理到 `http://<这台机器>:8791`，填 `https://<你的域名>`，点「检查并使用」。或者选「Cloudflare Tunnel」，粘贴 tunnel token 点「保存 token」，在 Cloudflare 的 Published application 把 Service URL 设为 `http://webhook:8791`，回到向导点该路由的「检查并使用此域名」。两种方式都不要把 8792 转出去，管理页留在本机 `127.0.0.1:8792`。
   2. GitHub App：填「目标组织」和「App 名称」，点「准备 GitHub 确认页」→「前往 GitHub 确认创建」，在 GitHub 上确认后会回到向导。权限固定为 Contents、Issues、Pull requests 写，Metadata、Actions、Checks、Commit statuses 读（后三项让检视和开发任务能用只读令牌查看 CI 状态；之前创建的 App 要在 GitHub 上补加），只订阅 `issues` 和 `pull_request`；Webhook 地址 `https://<你的域名>/hooks/github/<account_id>/<endpoint_id>` 由向导写进 App，不用手填。已在「机器人账号」登记过的 App 点「使用此 App」。
   3. 安装：点「在 GitHub 安装此 App」，选好仓库后回来点「重新检查安装」。
   4. 模型：在「添加模型」填接口 URL、API Key、模型名，点「保存并继续」。
   5. 规则：看一下内置规则，点「下一步」。
   6. 完成：点「同步已安装仓库」，在要用的仓库那一行点「启动并启用检视」，最后点「完成向导」。
3. **确认跑通。** 在已启用的仓库新开一个 Issue，bot 会在上面回复一条检视总结评论；第一次要先启动该仓库的虚拟电脑，会慢一些。没等到时，先在「Webhook 投递」页看投递是否到达、验签是否通过，再在「检视」页看任务状态。

## 日常使用

- **启用更多仓库**：在「项目」页点「同步安装列表」，在仓库行点「启动」，选好模型后确认。只有需要 bot 自动改代码时才勾选「同时开启自动开发」；开启后，bot 只开发由人加了开发标签（默认 `bot-develop`）且没有指派人的 Issue。仓库启动前收到的事件只存档，不会补跑。不再需要时点「禁用」，数据保留，之后可以再启用。
- **调整一个仓库**：在「项目」页点该仓库的「设置」。「检视」里开关 Issue／PR 触发、选评论语言、编辑检视规则；「开发」里打开自动开发、填测试命令；「使用的模型」换模型；「机器配置」改虚拟电脑的资源、软件包和初始化脚本；「规则总览」看每份规则文件哪一层生效。仓库也可以在默认分支用 `.bot/` 下的文件覆盖规则，见[接入向导与规则文件](docs/onboarding.md)。
- **看 bot 在做什么**：「检视」「开发」页列出任务，点开能看到每一步的思考、命令和输出；「Webhook 投递」页列出 GitHub 送来的每次投递。
- **按 Issue / PR 看进展**：「看板」把已收到的对象按 bot 执行阶段分成六列，同一对象的检视和开发任务放在同一张卡片。默认只显示打开或状态未知的对象，可逐条添加仓库、对象类型、阶段、编号或标题、包含已关闭对象等筛选，再保存或另存个人视图。「加列」会引导创建自定义单选字段；按该字段分列后，拖动卡片或选择选项只修改个人字段值，不会改变执行阶段或触发任务。空列也显示，可隐藏不需要的列。
- **给别人权限**：在「用户」页新建项目管理员，再在仓库「设置」→「成员」分配；项目管理员只能看到和操作分给自己的仓库。

## 升级与数据

在 `compose.yaml` 所在目录运行：

```sh
docker compose pull
docker compose up -d
```

数据在四个部署卷里：`bot-data`（控制面数据库）、`bot-keys`（加密凭据的主密钥）、`internal-keys`（bot 与 manager 的内部认证）和 `manager-data`（虚拟电脑账本）；`tunnel-keys` 只放 Cloudflare Tunnel token。丢了主密钥，已保存的 App 私钥和模型 Key 都解不开。`docker compose down` 会保留卷；日常升级不要加 `-v`（`--volumes`），它会删掉这些卷。备份见[备份与恢复](docs/deployment.md#备份与恢复)。

以前在仓库根目录用 `docker compose up --build -d` 从源码部署的实例，更新代码后再运行 `docker compose up -d` 会改为拉取 GHCR 镜像（同一目录，数据卷不变）；要继续从源码构建，改用 `docker compose -f compose.yaml -f compose.build.yaml up -d --build`。

## 常用设置

在 `compose.yaml` 同目录的 `.env` 里写变量，然后重新 `docker compose up -d`：

- 改宿主端口：`BOT_WEBHOOK_PORT`（默认 `8791`）、`BOT_ADMIN_PORT`（默认 `8792`）。
- 远程管理：另做一个 HTTPS 反向代理到 `127.0.0.1:8792`（和 Webhook 用不同域名），设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN=https://<管理站域名>`。
- 虚拟电脑不访问外网：`BOT_PROJECT_EGRESS=false`。

全部变量见[端口与环境变量](docs/deployment.md#端口与环境变量)。

## 文档

- [接入向导与规则文件](docs/onboarding.md)：向导每一步的细节、`.bot/` 规则文件和 `computer.yaml`
- [部署细节](docs/deployment.md)：镜像、从源码构建、端口与环境变量、服务隔离、备份与恢复
- [外部执行端](docs/external-executors.md)：在个人电脑或 GitHub Actions 里检视，再以 Bot 身份回复
- [仓库自动化规则](docs/automation.md)：标签、门禁、合并队列和 CI 阶段
- [架构与行为](docs/architecture.md)：权限模型、虚拟电脑生命周期、检视与开发数据流、当前限制
- [管理 API](docs/api.md)
- [开发与验证](docs/development.md)：代码结构、测试命令和 Docker 验收
