# Contributing to launchpad

欢迎参与 `agent-CI-Infra/bot`（launchpad）的开发与维护。本文档说明本地开发方式、代码组织、检查与测试分层、CI 合入规范及文档维护要求。

## 前置要求

- **Node.js 22.13+** 与 `npm`（项目使用 Node 内置 `node:sqlite` 与 `node:test`）
- **Docker Engine** 与 **Docker Compose v2**（运行容器集成验收或本地源码部署时需要）
- **Playwright Chromium**（运行浏览器 E2E 测试时需要：`npx playwright install chromium --only-shell`）

## 代码结构速览

| 目录 | 职责 |
| --- | --- |
| `src/` | TypeScript 控制面核心：`main.ts` / `server.ts` 入口，`app/`、`identity/`、`installations/`、`dispatch/`、`tasks/`、`agent/`、`roles/`、`harness/`、`github/`、`review/`、`actions/`、`releases/`、`management/`、`channels/`、`schedules/`、`memory/`、`projects/`、`storage/`、`external/`、`public-board/` 等模块。 |
| `manager/` | 受管 Docker 资源管理器（纯 Node ESM），唯一挂载 Docker socket 的组件，负责项目电脑、助手电脑与笔记卷操作。 |
| `runner/` | 容器内一次性固定执行入口与协议（命令执行、文件读写、Git/worktree、Pi/Codex/Claude Code 启动与工具邮箱）。 |
| `static/` | 控制台单页前端（原生 ESM + CSS，无外部打包框架）。 |
| `public-board/` | 公共 Dashboard（React/Vite workspace）与单仓公开看板采集器/静态页。 |
| `webhook/`、`tunnel/` | 入口网关与可选 Cloudflare Tunnel 容器入口。 |
| `docker/` | 四个镜像的 Dockerfile、容器包装脚本与 Compose 编排文件。 |
| `docs/` | 长期文档库，分为 [`docs/features/`](docs/features/README.md)（功能地图）与 [`docs/design/`](docs/design/README.md)（架构设计）；另含运行时固定路径资产 `docs/prompts/` 与 `docs/external-token-api.md`。 |
| `skills/` | 随平台发布的内置工作 Skill（如 `roadmap-decomposition`、`layered-ci-gates`）。 |
| `test/` | 按测试分层组织的全部自动化测试与夹具。 |

## 独立工作区开发

每项改动请在独立的分支与 `git worktree` 中进行，避免修改共享 `main` 工作树：

```sh
git fetch origin main
git worktree add -b feat/<topic> .worktrees/<topic> origin/main
cd .worktrees/<topic>
npm ci
npm ci --prefix runner --omit=dev --ignore-scripts
```

> 说明：完整运行单元测试前需要安装 `runner/` 依赖（`npm ci --prefix runner --omit=dev --ignore-scripts`），否则依赖真实 Pi SDK 的测试集（如 `role-conversation`、`integration-engine`）会失败。CI 会设置 `BOT_REQUIRE_PI=1` 强制校验。

## 检查与测试

### 常用检查命令

```sh
# 1. TypeScript 类型检查 + 运行时 JS 语法与 Pi 版本一致性检查
npm run check

# 2. 构建并运行全部单元与进程内集成测试
npm test

# 3. 校验 Docker Compose 配置
docker compose -f docker/compose.yaml config --quiet
docker compose -f docker/compose.yaml -f docker/compose.build.yaml config --quiet

# 4. 浏览器端到端测试（首次需先安装 Playwright Chromium）
npx playwright install chromium --only-shell
npm run test:e2e
```

常用定向运行方式：

- 运行单个测试文件：`npm test -- test/st/src/channels/channel-setup.test.mjs`
- 调整并行度：`npm test -- --jobs 4` 或 `BOT_TEST_JOBS=4`
- 单个测试集默认最多运行 1800 秒，到点先 `SIGTERM`、10 秒后 `SIGKILL`（连同它拉起的进程），该集记为失败，其余集照常运行；机器很忙或调试挂住的集时用 `BOT_TEST_SET_TIMEOUT=<秒>` 调整。本机默认仍是 1800 秒；CI 的 `npm test` 把它设为 900 秒，好在外层 1500 秒的 `timeout --signal=KILL` 之前点名卡住的集。
- 仅运行单个 E2E spec：`npm run test:e2e -- test/e2e/console/console-shell.spec.mjs`

### 测试分层与编写约定

全部测试集中在 `test/` 下：

- `test/ut/`：单元测试，目录结构与源码对应；纯前端文案、错误码格式化、分页与轮询状态机应优先放在 `test/ut/static/`（通过 `loadConsole` 在毫秒级完成覆盖）。
- `test/st/`：进程内服务集成测试（启动真实 SQLite、本地 HTTP 服务与本地夹具）。
- `test/e2e/`：Playwright 浏览器端到端测试（配置见 `test/e2e/playwright.config.mjs`），聚焦**用户视角的完整主流程与真实浏览器布局/交互**，避免重复覆盖已在 `test/ut/static/` 测过的纯文案或错误码矩阵。
- `test/docker/`：真实 Docker 容器与 Compose 系统测试（`npm run test:docker`、`test:agent`、`test:external:docker`、`test:assistant:docker`、`test:deploy:docker`、`test:commands:docker`）。
- `test/live/`：需要真实外部服务或本机 CLI 的实况/探针测试（`*.live.test.mjs`），不包含在 `npm test` 中。
- `test/framework/`：并行测试集发现、分片与回环网络守卫。

编写测试须遵守：

1. **资源隔离**：临时目录与 SQLite 放在 `mkdtempSync(join(tmpdir(), '<prefix>-'))` 并在 `t.after` 中清理；HTTP 服务一律监听 `127.0.0.1` 随机端口（`listen(0, '127.0.0.1')`）；使用本机 runner 工作区时用 `randomWorkspaceId()` 生成唯一 ID。
2. **禁止访问外网**：`npm test` 经 `test/framework/test-network-guard.mjs` 阻止任何非回环网络连接；涉及真实外网的测试只能放进 `test/live/`。
3. **测试纳入 CI**：新增测试必须能被 `test/framework/test-sets.mjs` 或 `test/e2e/playwright.config.mjs` 自动发现；`npm run check` 会对 `manager/`、`runner/`、`static/`、`test/` 等目录的 JS/MJS 做语法检查。
4. **保持 E2E 精简高效与架构不腐化**（完整设计原则见 [`docs/design/testing-architecture.md`](docs/design/testing-architecture.md)）：
   - 优先按业务主题归并回归用例并复用夹具，避免“一 Issue 一文件”式的单用例微 E2E 碎片化；与 `test/ut/static/` 重复的纯文案/错误码矩阵留在 UT。
   - 不在长期提交的 E2E 用例中保留无断言的 `page.screenshot(...)` 验收截图或 `evidence.json` 写盘（PR 贴图应在独立验证时采集并按规范附在 PR 描述或评论中）。
   - 轮询与定时等待优先使用 Playwright `page.clock` 推进虚拟时钟或在 `test/ut/static/` 测状态机，避免多秒真实 `page.waitForTimeout(...)` 死等；批量造数优先走 SQLite 事务而非大循环串行 HTTP 请求；多后端组合测试使用覆盖矩阵而非无收益的完整笛卡尔积。
   - 新增或大幅改动重型 UT/ST 测试集导致 CI 双分片失衡时，用 `node test/framework/unit-shards.mjs weights` 从近期完整 CI `unit-balance.json` 刷新 `test/framework/test-set-weights.json`。
   - 临时日志、失败 trace 等产物一律写入被 git 忽略的 `.tmp/`，禁止提交进仓库。

### 其他常用开发约束

- **新增静态资源**：新增 `static/` 下的脚本或样式时，必须同步更新 `static/index.html` 与 `src/server.ts` 中的静态资源白名单。
- **新增飞书权限**：只在 `src/channels/feishu.ts` 的 `FEISHU_SCOPES` 新增条目，并同步更新 [`docs/features/assistants-and-channels.md`](docs/features/assistants-and-channels.md) 中的权限表（`test/st/src/channels/channel-setup.test.mjs` 会校验两者严格一致）。
- **不再新增 `.bot/` 配置**：仓库级行为调整统一由控制台项目配置（Manager 提示词、角色配置、项目设置、机器配置）承载，仓库内仅支持 `.agents/skills/` 协作 Skill。
- **Docker 镜像依赖**：新增跨目录引用或运行时静态资源时，同步检查 `docker/*.Dockerfile` 的 `COPY` 清单。

## 文档维护规范

本仓库文档在 `docs/` 下严格按 **两个维度** 组织，并要求长期按此维度同步更新：

- **[`docs/features/`](docs/features/README.md)**：功能地图、特性说明与使用说明（用户视角）。改动用户可见行为、页面交互、配置项或权限时同步更新。
- **[`docs/design/`](docs/design/README.md)**：模块架构与主要设计（研发视角）。改动模块划分、核心协议、存储结构或安全边界时同步更新。

仓库卫生要求：

- 仓库只收录产品代码、长期测试和稳定文档。
- 单次改动的验收报告、前后对比截图、一次性取证脚本一律**不要提交进代码分支**，改放 PR 描述或评论中。
- `docs/images/` 中只保留被稳定文档引用的当前界面截图；界面变动时同步更新或清理。

## CI 与合入流程

- `main` 分支仅允许经 Pull Request 通过 **rebase + Merge Queue** 合入，禁止强推。
- PR 与合并队列必须通过全部必需检查：
  - [`.github/workflows/checks.yml`](.github/workflows/checks.yml)：`unit`（`npm run check`、两片并行 `npm test`、Compose 配置校验）与 `e2e`（`npm run test:e2e`）。
  - [`.github/workflows/images.yml`](.github/workflows/images.yml)：四个 Docker 镜像构建及项目电脑基础镜像的 Chromium/虚拟桌面冒烟测试。
- 每日定时 [`.github/workflows/nightly.yml`](.github/workflows/nightly.yml) 复用上述工作流并执行 [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) 代码扫描。
- 请保持分支提交历史线性整洁，避免混入 merge commit 或与当前 PR 无关的改动。

## 参考文档

- [文档总入口（`docs/README.md`）](docs/README.md)
- [功能地图入口（`docs/features/README.md`）](docs/features/README.md)
- [架构与设计入口（`docs/design/README.md`）](docs/design/README.md)
- [AI 编码助手指引（`AGENTS.md`）](AGENTS.md)
- [部署与发布运维（`docs/features/deployment-and-operations.md`）](docs/features/deployment-and-operations.md)
- [控制台前端与管理 API（`docs/design/console-and-api.md`）](docs/design/console-and-api.md)
