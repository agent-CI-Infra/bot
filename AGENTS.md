# AGENTS.md

本文件为在本仓库（`agent-CI-Infra/bot` / launchpad）中工作的 AI 编码助手提供项目导航、核心约束与必读参考。

## 项目概览

launchpad 是一个基于 **Node.js 22.13+ / TypeScript** 的多账号 GitHub 自动化与 AI 协作平台，由控制面（`src/`、`static/`）、Docker 管理器（`manager/`）、容器内执行器（`runner/`）、入口网关（`webhook/`、`tunnel/`）与公开看板（`public-board/`）组成。

- 控制面负责认证授权、GitHub/飞书事件接入、对象 Manager 分派、通用任务引擎、模型网关、管理助手、定时调度与持久化存储（SQLite + 轨迹文件）。
- 每个启用的仓库拥有一台独立的长期 Docker 项目电脑；管理助手与飞书群聊助手使用按归属隔离的短时助手电脑。

## 关键代码目录

- `src/main.ts`、`src/server.ts`：控制面启动与统一业务端口（`8791`）路由分派。
- `src/app/`、`src/identity/`、`src/installations/`：账号、OAuth 登录、安装档案同步、成员缓存与统一授权（`ActorContext`）。
- `src/dispatch/`、`src/tasks/`、`src/review/`、`src/actions/`、`src/releases/`：单对象持久 Manager 线程、通用任务引擎（`task.request`）、检视与开发交付、Actions 失败排查、手动发版本。
- `src/agent/`、`src/roles/`、`src/harness/`、`src/github/`：共享 Agent 运行时、`bot.role-run/1` 协议、多后端 Harness（`pi`、`process`、`claude_code`、`codex`）、受控 `github_write` 与只读探索。
- `src/management/`、`src/service-roles/`、`src/channels/`、`src/schedules/`：统一管理服务、服务角色、飞书应用连接与本地消息账本、持久化定时与通知订阅。
- `src/storage/`、`src/memory/`、`src/projects/`、`src/external/`、`src/public-board/`：SQLite/轨迹/Blob 存储、项目知识、项目电脑网关、外部执行端与公开看板托管。
- `manager/`、`runner/`、`docker/`：受管 Docker 生命周期、容器内命令/文件/MCP/模型中转协议、四镜像构建与 Compose 编排。
- `static/`：原生 ESM 控制台前端（公共设计令牌统一声明在 `static/shell.css`）。

## 核心约束与红线

1. **运行时固定路径文档不可随意移动**：
   - `docs/prompts/` 下的内置提示词由 `src/` 直接读取并打包进 `docker/control-plane.Dockerfile`；修改前须核对对应单测（如 `test/ut/src/dispatch/manager-prompt.test.mjs`、`test/st/src/onboarding/onboarding.test.mjs`）。
   - `docs/external-token-api.md` 由 `src/server.ts` 直接在 `/docs/external-token-api.md` 提供并随控制面镜像打包。
2. **安全与权限边界由控制面强制执行**：
   - GitHub 写凭据、模型长期 API Key 与加密主密钥只驻留控制面（AES-256-GCM 密封），绝不进入项目电脑/助手电脑、日志、轨迹或浏览器响应。
   - 提示词、仓库内容和 `.agents/skills/` 不能扩大工具或权限；修改 `.github/workflows/` 通过具备开发交付权限的任务以 bot PR 交付（发布前按需申请 `workflows: write` 令牌），`github_write` 永不写工作流文件且永不自动合并/入队修改 `.github/workflows/` 的 PR（须由人类维护者在 GitHub 合入）。
   - 外部 PR 或未合入分支属于非受信任检出：不得从不可信检出自动加载 `.agents/skills/`、`.pi/skills/`、仓库根 `AGENTS.md`/`CLAUDE.md` 或本地 hooks/MCP。
3. **不再引入 `.bot/` 仓库规则覆盖**：
   - 仓库行为统一在控制台项目配置（Manager 提示词、角色配置、项目设置、机器配置）中维护；仓库内只读取可信基准分支的 `.agents/skills/`。
4. **单一声明源同步**：
   - **飞书权限**：仅在 `src/channels/feishu.ts` 的 `FEISHU_SCOPES` 声明，并同步更新 `docs/features/assistants-and-channels.md` 的权限表（`test/st/src/channels/channel-setup.test.mjs` 强校验）。
   - **前端静态文件与令牌**：新增 `static/` 资源须同步更新 `static/index.html` 与 `src/server.ts` 白名单；控制台公共 CSS 变量只在 `static/shell.css` 的 `:root` 声明（`test/ut/static/console-tokens.test.mjs` 强校验）。
   - **Pi SDK 版本**：`src/agent/pi.ts` 中固定版本须与 `runner/package.json` 一致（`npm run check` 强校验）。
   - **Docker COPY 清单**：新增跨目录导入、脚本或静态资产时，核对 `docker/*.Dockerfile` 的多阶段 `COPY`。
5. **仓库内容卫生**：
   - 只提交产品代码、长期测试和稳定文档。严禁将单次验收报告、对比截图（如 `docs/verification/`）或一次性取证脚本提交到分支历史中。
6. **测试分层与防腐化约束**（详见 `docs/design/testing-architecture.md` 与 `CONTRIBUTING.md`）：
   - `test/e2e/` 聚焦用户视角的完整主流程与真实浏览器布局/交互，不得把已在 `test/ut/static/` 覆盖的纯文案/错误码/格式矩阵重复塞进 E2E，也不按 Issue 堆砌单用例碎片 E2E 文件。
   - 长期提交的 E2E 用例严禁保留无断言的 `page.screenshot(...)` 或 `.tmp/.../evidence.json` 写盘；轮询等待优先使用 Playwright `page.clock`，批量造数走单事务 SQLite，多后端测试用覆盖矩阵而非无收益笛卡尔积。
   - 新增或大幅调整重型 UT/ST 集导致分片失衡时，同步维护 `test/framework/test-set-weights.json`。
7. **语言约定**：
   - 面向人的控制台界面与 `docs/` 使用简体中文；代码内置给模型读取的提示词、工具/参数描述保持英文契约一致，避免在同一模型请求中混杂中英文指令。

## 文档双维度维护规则

`docs/` 下的长期文档固定分为两个维度，**修改功能或架构时必须同步更新对应维度**：

- **`docs/features/`（功能维度）**：面向用户与管理员的功能地图、特性说明与使用说明。凡改动软件对外行为、页面入口、配置项、权限或运维操作，更新此目录。
- **`docs/design/`（设计维度）**：面向开发者与维护者的模块架构与核心设计。凡改动模块职责、状态机、协议契约、存储或安全边界，更新此目录。

保持精炼、聚焦重点，不按 Issue 编号记流水账，不在 `docs/` 根目录新增零散 Markdown 文档。

## 常用验证命令

```sh
# 安装依赖（含 runner 依赖）
npm ci && npm ci --prefix runner --omit=dev --ignore-scripts

# 类型与运行时语法检查
npm run check

# 单元与进程内集成测试（支持按文件过滤）
npm test
npm test -- test/ut/workflows/release-workflow-timeouts.test.mjs

# Compose 配置校验
docker compose -f docker/compose.yaml config --quiet
docker compose -f docker/compose.yaml -f docker/compose.build.yaml config --quiet

# 浏览器 E2E 测试
npm run test:e2e
```

## 文档参考（References）

- 总索引：[`docs/README.md`](docs/README.md)
- 贡献与测试指南：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 功能地图入口：[`docs/features/README.md`](docs/features/README.md)
  - 接入与权限：[`docs/features/onboarding-and-access.md`](docs/features/onboarding-and-access.md)
  - GitHub 自动化：[`docs/features/github-automation.md`](docs/features/github-automation.md)
  - 角色、规则与能力上限：[`docs/features/roles-and-rules.md`](docs/features/roles-and-rules.md)
  - 控制台、知识与看板：[`docs/features/console-and-workspace.md`](docs/features/console-and-workspace.md)
  - 管理助手与飞书渠道：[`docs/features/assistants-and-channels.md`](docs/features/assistants-and-channels.md)
  - 定时任务与通知：[`docs/features/schedules-and-notifications.md`](docs/features/schedules-and-notifications.md)
  - 模型与成本：[`docs/features/models-and-costs.md`](docs/features/models-and-costs.md)
  - 外部执行端：[`docs/features/external-executors.md`](docs/features/external-executors.md)
  - 部署与运维：[`docs/features/deployment-and-operations.md`](docs/features/deployment-and-operations.md)
- 架构与设计入口：[`docs/design/README.md`](docs/design/README.md)
  - 总体架构与隔离：[`docs/design/architecture.md`](docs/design/architecture.md)
  - 身份、安装档案与授权：[`docs/design/identity-and-installations.md`](docs/design/identity-and-installations.md)
  - 分派与通用任务引擎：[`docs/design/dispatch-and-tasks.md`](docs/design/dispatch-and-tasks.md)
  - Agent/Harness 运行时与虚拟电脑：[`docs/design/agent-and-harness-runtime.md`](docs/design/agent-and-harness-runtime.md)
  - 管理服务与飞书架构：[`docs/design/assistants-and-channels.md`](docs/design/assistants-and-channels.md)
  - 调度与通知引擎：[`docs/design/schedules-and-events.md`](docs/design/schedules-and-events.md)
  - 存储、轨迹与知识引擎：[`docs/design/storage-and-knowledge.md`](docs/design/storage-and-knowledge.md)
  - 控制台架构与管理 API：[`docs/design/console-and-api.md`](docs/design/console-and-api.md)
  - 外部执行端与公开看板：[`docs/design/external-and-public-board.md`](docs/design/external-and-public-board.md)
  - 测试分层与防腐化设计：[`docs/design/testing-architecture.md`](docs/design/testing-architecture.md)
- 运行时协议与内置提示词：[`docs/prompts/README.md`](docs/prompts/README.md)、[`docs/external-token-api.md`](docs/external-token-api.md)
