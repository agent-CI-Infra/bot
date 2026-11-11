# 开发与验证

## 代码结构

`src/main.ts` 是控制面入口，`src/server.ts` 在唯一的业务监听上按路径分派控制台、OAuth、App 回调、Webhook 和外部执行端请求。`src/app/` 保存账号、登录、仓库授权、模型和投递归一化逻辑，`src/core/security.ts` 提供验签、慢哈希和凭据加密，`src/storage/database.ts` 管理 SQLite、事务及审计；`static/` 是同一管理入口。`src/agent/` 保存模型循环、任务认领及恢复，`src/review/` 保存触发和位置校验，`src/github/` 保存授权读取及发布 outbox。`src/projects/` 是环境网关，`manager/` 管理受管 Docker 资源，`runner/` 是容器内命令／文件协议，`images/project/` 构建批准镜像。manager／runner 独立实现，保留 Apache-2.0 及 NOTICE 中的上游设计归属，不携带完整员工平台。

## 独立工作区开发

每项开发使用独立分支和 git worktree，避免在共享 main 工作区修改或覆盖别人的未提交内容。依赖、测试数据和端口按工作区隔离；Docker 验证使用独立的 Compose 项目、容器名和端口，不替换正在运行的本机实例；构建出的镜像标签见下文。

```sh
git worktree add -b feature/<topic> .worktrees/<topic> main
cd .worktrees/<topic>
npm ci
npm run check
npm test
```

## 检查与测试

验证需要 Node.js 22.13+ 和 npm；这些是源码检查命令，部署方式见[部署细节](deployment.md)。

```sh
npm ci
npm run check
npm test
docker compose config --quiet
docker compose -f compose.yaml -f compose.build.yaml config --quiet
```

完整测试前需要安装项目内 runner 依赖：`npm ci --prefix runner --omit=dev --ignore-scripts`。`test/role-conversation.test.mjs` 的通用 Pi 会话用例与 `test/pi-controller.test.mjs` 都用本机 runner 和真实 Pi SDK；缺少 SDK 时通用会话会失败，部分旧用例会跳过。CI 安装依赖并设置 `BOT_REQUIRE_PI=1`，缺少 SDK 会失败而不是跳过。本机也可用这个变量确保实际覆盖 Pi 路径。

`test/claude-code.test.mjs` 启动 lockfile 固定的真实 Claude Code 二进制，以合成 provider 验证 MCP、受控代码修改、实际测试和精确恢复；另有明确标注的协议 fixture。它们不需要个人登录态，也不代替真实模型验收，部署和 opt-in probe 见 [Claude Code harness](claude-code.md)。在 `node:test` 内启动子进程 `node --test` 时要显式构造环境，避免继承 `NODE_TEST_CONTEXT` 导致子测试静默跳过，并断言实际执行项数和失败/成功状态。

`npm test` 覆盖并发初始化只成功一次、重启、权限收回、跨项目列表／详情／日志／模型隔离、凭据加密及不回显、验签、事务回滚重试、重复投递、先落库再确认和空配置不执行。SQLite 使用 Node 内置 `node:sqlite`，Node 22 会显示实验特性提示。

### 测试集与并行

`npm test` 构建之后由 [`scripts/test-sets.mjs`](../scripts/test-sets.mjs) 把 `test/*.test.mjs` 分成测试集运行。每个测试文件默认自成一个集。一个集在自己的 `node --test` 进程里运行，集内的文件依次运行，文件内的用例也按 `node:test` 的默认方式依次运行；不同的集同时运行，同时运行的集数默认等于 CPU 数，可用 `npm test -- --jobs 4` 或环境变量 `BOT_TEST_JOBS` 调整，`npm test -- test/board.test.mjs` 只运行指定文件。上次各集的耗时记在 `.tmp/test-set-durations.json`，耗时长的集先启动。每个集结束时整段打印它的 TAP 输出，最后列出各集相对开始时刻的起止秒数和合计的 TAP 汇总；任何一个集失败，`npm test` 都以非零状态退出。

运行器为每个集在 `.tmp/tests-*/<集名>/` 下准备独立资源：`TMPDIR` 指向其中的 `tmp/`，`HOME` 指向 `home/`（同时清除 `XDG_*` 目录变量，遵循 XDG 的程序回落到这个 HOME），`BOT_TEST_SET` 是集名，环境变量是这个集的进程自己的副本。集通过后删除它的目录，失败时保留并打印路径。集内的进程只能连接回环地址：[`scripts/test-network-guard.mjs`](../scripts/test-network-guard.mjs) 经 `NODE_OPTIONS` 加载到集内的每个 Node.js 进程，连接其他地址时按连接被拒绝处理，并让这个集失败，即使被测代码吞掉了这个错误。直接用 `node --test test/<文件>` 运行单个文件也可以，这时临时目录在系统临时目录下，也没有网络限制。

新测试放进已有文件，或新建一个文件自成一个集，并自备独立资源：

- 临时目录、SQLite 文件和其他产物放在 `mkdtempSync(join(tmpdir(), '<前缀>-'))` 建的目录里，在 `t.after` 中删除；数据库也可以用 `:memory:`。不要写死 `.tmp/` 或仓库里的其他路径，也不要删除不是自己建的目录。`test/helpers.mjs` 的 `harness` 已经这样准备数据库目录和端口。
- 服务一律 `listen(0, '127.0.0.1')`，把实际端口传给被测代码；不写死端口，也不先占一个空闲端口、关闭后再复用。
- 修改 `process.env` 只影响本文件的进程，用完恢复。
- 通过 `LocalManager` 或 runner 模块在本机运行进程的工作区，id 用 `test/helpers.mjs` 的 `randomWorkspaceId()`。这些进程带着工作区 id，清理（reap）会结束本机上所有同 id 的进程，固定 id 会让同时运行的集、甚至另一个工作树里的测试互相结束对方的进程。
- 不使用 Docker、全局 git 配置或其他本机共享状态；这些属于 `npm run test:docker` 等单独的验收。

集内串行：同一个文件里的用例本来就依次运行。如果几个文件共用一份无法拆开的资源、不能同时运行，在每个文件里写一行 `// test-set: <集名> <原因>`，运行器把它们放进同一个集依次运行；这一行缺少原因时 `npm test` 拒绝运行。优先给每个文件准备独立资源，而不是合并成一个集；目前所有文件都各自成集。

真实外部服务例外：会真实访问飞书开放平台、GitHub 或其他外部服务的测试放在 `test/<名字>.live.test.mjs`。`npm test` 不运行这类文件，运行器也拒绝把它们当作测试集；需要时带上所需凭据，用 `node --test test/<名字>.live.test.mjs` 单独运行。只在断言或夹具里出现 `api.github.com`、飞书字段，或者访问本地假服务器（`test/fixtures/`、`test/git-server.mjs` 等）的测试不属于例外，留在并行的测试集里。目前没有 `.live.test.mjs` 文件，现有单元测试都只连接本地假服务器。

浏览器验收使用固定在 lockfile 的 Playwright，先运行 `npx playwright install chromium --only-shell`，再执行 `npm run test:e2e`；测试在自己的临时 SQLite 和随机端口上启动服务，覆盖初始化、登录、登记账号、查看签名投递、项目权限以及宽屏／窄屏页面，不占用部署数据或固定试用端口。输出放在忽略提交的 `.tmp/`。

实际 Docker 验收运行 `npm run test:docker`，需要 Docker 和上述 Playwright 浏览器。它用 `compose.yaml` 加 [`compose.build.yaml`](../compose.build.yaml) 从当前源码构建镜像，标签是 `department-bot*:local`，和同一台机器上从源码构建的部署共用：运行中的容器不受影响，但那份部署下次 `up` 会用上测试构建的镜像；按 GHCR 镜像运行的部署不受影响。它使用独立 Compose 项目和 18881／18883 测试端口，18881 是业务端口，18883 仅在测试覆盖文件里映射 manager；生产 Compose 不发布该端口。测试会检查两个真实环境、串行与并行、文件／卷／网络隔离、无凭据、代次重置、重启和角色页面，并按本次部署标签清理容器、网络及卷。输出保存在 `.tmp/project-env/`。

`npm run test:agent` 同样从源码构建，使用假 GitHub、假模型和真实项目容器验收完整旅程，包括 Manager 创建／续接／忽略及检视后开发分派、Issue 到 bot PR、草稿忽略、COMMENT 行内评论、别人 PR 不推送、bot PR 跟进、重复投递／未知响应对账、测试失败、tree 不一致、模型配置故障、manager 中断恢复、凭据隔离及任务页面角色范围。Manager 通过真实模型网关选择请求提供的选项；Webhook 接收成功后，测试等待分派事件和任务结果，不把响应中的 `tasks_created` 当作已经建成的任务数。浏览器使用 lockfile 中的 Playwright。测试使用独立镜像标签、Compose 项目和 18891–18894 端口，与部署和人类试用数据隔离，结束后清理测试容器、网络和卷；产物放 `.tmp/review-dev/`，失败时保存任务、分派事件、假服务状态和服务日志并遮盖测试凭据。

`npm run test:external:docker` 使用独立临时镜像和无外网容器验证签名转发、兑换临时令牌和 Bot 身份评论；GitHub 为本地测试服务，结束后清理本次镜像及容器，不修改运行实例。

`npm run test:isolation:docker` 验收每次角色运行的独立容器：以本机已有的项目电脑镜像（`BOT_TEST_BASE_IMAGE`，默认 `department-bot-project-computer:local`）为底叠加本检出的 runner，构建带随机标签的测试镜像，在进程内启动本检出的 manager（独立 deployment id），检查 HOME／进程／环境／卷／网络隔离、恶意路径与符号链接、缓存污染、固定候选复制、资源与时限，以及 RoleRun 准入；结束后只删除该 deployment 标签下的容器、网络、卷和测试镜像，证据在 `.tmp/role-run-docker/`。

`npm run test:deploy:docker` 验收生产部署这一步：取出 `.github/workflows/release.yml` 中 Deploy 步骤发到服务器的脚本原文，在一次性的 Compose 项目 `bot-deploy-recovery-*` 里运行。项目里的 `bot`、`manager` 替身保持 `compose.yaml` 的依赖关系，并忽略停止信号；用例覆盖首次部署、发布新版本、在已创建替换容器时中断（旧容器仍在，以及只剩替换容器）后重跑，以及失败时输出每个容器的状态。基础镜像取本机已有的 `BOT_TEST_BASE_IMAGE`（默认 `department-bot-project-computer:local`，任何带 `sh` 的本机镜像都可以），不拉取镜像；结束后只删除本项目的容器和网络，日志在 `.tmp/deploy-recovery/`。

## CI 与合入

`main` 只能经 Pull request 合入，合入方式只有 rebase，并且经合并队列（merge queue）排队，不能强推或删除。必需检查在 Pull request 和合并队列上都运行：[`checks.yml`](../.github/workflows/checks.yml) 的 `unit`（`npm run check`、`npm test` 和两个 Compose 文件的校验）与 `e2e`（`npm run test:e2e`，失败时上传 `.tmp/e2e-results`），以及 [`images.yml`](../.github/workflows/images.yml) 构建的四个镜像。新增必需检查的工作流要同时监听 `pull_request` 和 `merge_group`，否则合并队列等不到结果。版本发布见[版本发布与服务器部署](deployment.md#版本发布与服务器部署)。

共享执行入口、任务扩展方式与权限边界见[共享 Agent 后端](agent-runtime.md)。

安装事实档案、持久化同步、回调与身份模块契约及独立容器验收见[安装档案与同步](installation-archive.md)。

默认关闭的 Actions 失败处理及其扫描、分类和一次重跑设计见 [Actions 失败分类与提报](actions-failures.md)。

GitHub 登录、统一授权、迁移和隔离验收见 [身份与授权](identity-authorization.md)。

管理服务、持久会话、命令 Schema、配置版本和审批/对账约定见 [统一管理服务与管理对话](management-agent.md)。

平台级服务角色（管理助手、仓库问答助手）的定义、权限、预算和按角色记账见 [服务角色](service-roles.md)。

飞书应用连接、双端绑定、群聊助手绑定、共享管理会话、通知目的地和发送队列见 [消息渠道与飞书应用机器人](message-channels.md)。

持久化调度、日报、事件订阅、受控触发契约和通知 outbox 见 [定时计划、日报与事件订阅](schedules.md)。

## 按任务选择模型

在项目「模型」页选择项目默认模型，再在「工作类型模型」表格中按需为工作类型覆盖模型；继承项目默认的工作类型不写入覆盖。覆盖保存在 `task_models` 里，键是工作类型 id，例如 `review.issue`、`review.pr`、`development.issue`、`development.pr`、`reply`、`release.observe`、`release.notes`、`actions.failures`、`gate.onboarding`、`task.request`；`manager` 是每个事件一次的 Manager 分派调用。升级前自定义工作流的模型迁移为 `reply` 的模型。已经保存在配置中的扩展任务标识会单独显示，可以改模型或移除，不要求修改选择器，也不需要用户手填内部标识。

`PATCH /api/repositories/:id/policy` 接受 `task_models` 对象，例如：

```json
{"task_models":{"review.pr":"review-model-id","development.issue":"coding-model-id","release.notes":"summary-model-id"}}
```

该对象完整替换映射；省略字段保持原值，发送 `{}` 清除全部任务覆盖并恢复项目默认。未配置覆盖的任务使用 `model_id`；已配置但不可用、已删除、撤销凭据或撤销项目共享授权的覆盖会等待配置，不静默切换到默认模型。模型必须属于当前项目或被明确共享给该项目；超级管理员选择共享模型时与默认模型选择一样同时授权该项目使用。

此配置仅由经过项目授权检查的管理 API 写入。Issue、PR、工具输出不能指定模型 ID、端点或密钥。调用 `selectedModel` 时由可信任务描述传入 task kind，模型请求账本仍保存实际使用模型及其计价快照。
