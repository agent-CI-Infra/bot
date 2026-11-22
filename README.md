# launchpad

launchpad 是一个开源的多账号 GitHub 自动化与 AI 协作平台（Apache-2.0），面向代码仓库提供 Issue/PR 自动检视、按需与自主开发交付、CI 失败排查、手动发版本、控制台与飞书助手协作、定时任务及公开看板托管。

## 核心能力速览

- **Issue 与 PR 检视**：仓库启用后自动检视新开 Issue、开放/更新的 PR 以及讨论与 `@` 提及；每个对象只维护一条原位更新的总结评论，行内意见固定使用 `COMMENT`，不擅自批准或修改他人分支。
- **可控的自动开发与 PR 跟进**：项目能力上限设为「可开发并开 PR」（`develop`）后，项目 Manager 按明确依据（开发标签、维护者评论或项目规则）在独立虚拟电脑内改代码、跑测试、经独立 QA 后推送 `bot/*` 分支并开 PR；后续持续跟进仓库成员评论、检查失败与合并冲突。
- **多角色与多后端执行**：通过单对象持久 Manager 与项目角色池编排协作，按角色支持 `Pi`（默认推荐）、`Native`、`Process` 及容器内 `Claude Code`、`Codex` 执行器，并统一受 RoleRun 协议、能力上限与自动合并策略约束。
- **控制台与飞书助手**：提供统一的 Web 管理控制台、控制台与飞书私聊管理助手、支持三维独立权限的飞书群聊助手，以及项目定时任务、会话定时任务与事件通知订阅。
- **手动发版本与公开看板**：支持版本预检、打标签、跟踪 Release 工作流、生成发行说明草稿与人工发布；单端口托管公共 Dashboard（`/dashboard/`）与单仓看板（`/boards/<owner>/<repo>/`）。
- **外部执行端**：支持个人电脑（公钥签名）和 GitHub Actions（OIDC）兑换单仓受限 Bot 令牌，并接收签名 Webhook 转发或轮询事件。

## 快速开始

### 将 bot 安装到你的仓库

1. 打开安装页选择组织/个人账号及目标仓库：<https://github.com/apps/agent-ci-infra-bot/installations/select_target>
2. 登录控制台，在项目列表点击「开始接入」由管理助手只读分析仓库并确认启动与配置（未受信任组织提交启动申请由超级管理员同意）。
3. 完整上手步骤见 [登录、系统初始化与仓库接入](docs/features/onboarding-and-access.md)。

### 自行部署

无需克隆仓库，使用 Docker Compose 即可启动：

```sh
mkdir department-bot && cd department-bot
curl -fsSLO https://raw.githubusercontent.com/agent-CI-Infra/bot/main/docker/compose.yaml
docker compose up -d
```

启动后访问 `http://127.0.0.1:8791/` 创建首位超级管理员并完成七步系统初始化。详细步骤与运维说明见 [部署、升级与运维](docs/features/deployment-and-operations.md)。

## 文档导航

本仓库文档在 `docs/` 下按 **功能** 与 **设计** 两个维度组织（详见 [文档总入口](docs/README.md)）：

- **功能地图与使用指南（`docs/features/`）**：见 [`docs/features/README.md`](docs/features/README.md)
  - [登录、系统初始化与仓库接入](docs/features/onboarding-and-access.md)
  - [GitHub 自动化：检视、开发、Actions 与 CI 改动](docs/features/github-automation.md)
  - [角色配置、规则、能力上限与自动合并](docs/features/roles-and-rules.md)
  - [控制台、项目总览、知识库、发版本与公开看板](docs/features/console-and-workspace.md)
  - [管理助手、飞书应用机器人与群聊助手](docs/features/assistants-and-channels.md)
  - [定时任务与事件通知订阅](docs/features/schedules-and-notifications.md)
  - [模型连接与用量成本](docs/features/models-and-costs.md)
  - [外部执行端](docs/features/external-executors.md)
  - [部署、升级与运维](docs/features/deployment-and-operations.md)
- **架构与核心设计（`docs/design/`）**：见 [`docs/design/README.md`](docs/design/README.md)
  - [系统总体架构与安全边界](docs/design/architecture.md)
  - [身份登录、安装档案与统一授权](docs/design/identity-and-installations.md)
  - [事件分派、通用任务引擎与交付验收](docs/design/dispatch-and-tasks.md)
  - [Agent 运行时、RoleRun 协议、Harness 与虚拟电脑](docs/design/agent-and-harness-runtime.md)
  - [统一管理服务、服务角色与飞书渠道架构](docs/design/assistants-and-channels.md)
  - [持久化调度与事件通知引擎](docs/design/schedules-and-events.md)
  - [存储架构、轨迹文件、工作区与项目知识引擎](docs/design/storage-and-knowledge.md)
  - [控制台前端架构与管理 API 总览](docs/design/console-and-api.md)
  - [外部执行端凭据代理与公开看板托管](docs/design/external-and-public-board.md)
- **研发与协作**：
  - [贡献与开发验证指南（`CONTRIBUTING.md`）](CONTRIBUTING.md)
  - [AI 编码助手指引（`AGENTS.md`）](AGENTS.md)
  - [内置默认提示词（`docs/prompts/`）](docs/prompts/README.md)
  - [外部执行端令牌兑换协议（`docs/external-token-api.md`）](docs/external-token-api.md)

## 反馈

使用过程中遇到问题或有功能建议，欢迎在本仓库提交 Issue：<https://github.com/agent-CI-Infra/bot/issues>
