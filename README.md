# launchpad

launchpad 是一个开源的 GitHub 自动化与 AI 协作平台（Apache-2.0）。将它安装到你的 GitHub 仓库后，它能在 GitHub、Web 控制台和飞书中持续协助团队完成 Issue/PR 检视、自动开发与跟进、CI 失败排查、版本发布以及日常问答协作。

## 几分钟即可开始工作

接入一个仓库不需要改代码、不需要写配置文件，也不需要单独申请一套团队账号：

1. **安装到 GitHub 仓库**：打开 [GitHub App 安装页](https://github.com/apps/agent-ci-infra-bot/installations/select_target)，选择你的组织或个人账号，勾选要接入的公开或私有仓库。
2. **使用 GitHub 账号登录控制台**：登录只读取公开身份，系统会按你在 GitHub 上的仓库角色（Admin / Write / Read）自动同步对应项目的访问权限。
3. **一键开始接入**：在项目列表的「待接入的仓库」点击 **开始接入**，管理助手会自动只读分析仓库的技术栈、CI、标签和协作约定，提出关键选项供你确认，确认后即可启动工作（未受信任组织会先提交启动申请，由平台管理员一键同意）。

> 详细接入流程见 [登录、系统初始化与仓库接入](docs/features/onboarding-and-access.md)。

## 接入后可以做什么

### 1. 在 GitHub 上：从检视到开发交付

- **Issue 与 PR 自动检视**
  - 新开 Issue、打开或更新 PR、讨论出现新评论，或在评论里 `@bot` 时自动触发检视。
  - 每个 Issue / PR 只维护**一条原位更新的总结评论**（不刷屏），行内代码意见固定使用 `COMMENT`，自动添加分类标签，并在复审时自动关闭作者已修复的旧行内讨论串。
  - 绝不擅自批准、请求变更或修改他人分支；PR 触及 `.agents/skills/`、`AGENTS.md` 等影响 bot 行为的文件时会醒目提醒人工裁定。
- **可控的自动开发与 PR 跟进**
  - 当项目能力上限设为「可开发并开 PR」（`develop`）后，bot 可针对问题清晰且无人认领的 Issue 自主开发，也可通过给 Issue 加开发标签（默认 `bot-develop`）或维护者评论触发开发。
  - bot 在仓库专属的隔离虚拟电脑里改代码、跑测试、经过独立 QA 校验后推送 `bot/*` 分支并开出 PR，同时在原 Issue 上用一条持续更新的进展评论同步里程碑。
  - PR 开出后持续跟进：响应仓库成员的评论与评审意见、自动感知 CI 检查失败或合并冲突并安排修复。
- **Actions 失败排查与受控 CI 改动**
  - 自动监控默认分支与版本标签上失败的 Actions 运行：确认属外部波动时自动重跑一次失败作业；确认属真实缺陷时查重并按仓库规范提报 Issue。
  - 需要修改 `.github/workflows/` 时，由项目管理员在控制台显式确认后以普通 bot PR 交付，人工合并后才生效。
- **手动发版本与公开看板**
  - 在控制台「发版本」完成版本与提交预检、自动打标签、跟踪 Release 工作流并生成基于真实提交与 PR 的发行说明草稿，最后由人点击正式发布。
  - 内置公共 Dashboard（`/dashboard/`）与单仓看板（`/boards/<owner>/<repo>/`），无需配置 GitHub Pages，开关即用，实时呈现 Issue、PR、贡献者、发版与 Actions 趋势。

### 2. 在 Web 控制台：全局掌控与可视化配置

- **项目总览与任务追踪**：在单项目总览按 **角色视图 / 任务视图 / Issue 进展 / PR 进展** 实时查看所有自动化进度与角色流转；点开任意任务可查看每一步工具调用、命令输出与故障原因，异常项统一汇总在「待处理」。
- **可视化调整行为**：所有检视/开发规则、Manager 六大场景流程图、角色池（支持按角色选用 Pi、Claude Code、Codex 等执行器与独立模型）、项目共享知识库与虚拟电脑规格都在控制台直接管理，也可在管理助手里用自然语言改流程。

### 3. 连接飞书：把协作延伸到私聊与项目群

在控制台配置飞书应用并完成个人或群绑定后，团队无需切回浏览器即可在飞书里与 bot 协作：

- **飞书私聊（个人管理助手）**
  - 与控制台管理助手共享同一引擎与工具，严格使用**你自己的项目权限**，无需先选项目或记忆命令前缀。
  - **跨项目问答与排障**：直接询问「我负责的项目有哪些失败任务」「帮我看下昨晚 Nightly 为什么挂了」「查一下某个仓库的实现细节」。
  - **直接管理与派发任务**：在私聊里接入新仓库、用对话调整协作流程、新建/暂停/重试/取消任务；私聊里创建的任务完成后，结果卡片会自动发回该私聊。
  - **个人助手电脑与定时任务**：支持调用个人专属虚拟电脑运行命令、分析图片与文件，并可挂载**个人会话定时任务**（例如每天早上汇总你关注项目的进展）。
- **飞书群聊（团队群聊助手）**
  - 将机器人拉入项目群后，维护人在控制台为该群绑定一个或多个仓库（或整个组织），并按需配置**发言模式**（仅回应 `@` / 回应提问与求助 / 按需参与）以及**三维独立权限**：
    1. **GitHub 权限**：只读问答、Issue/PR/Actions 读写（评论、打标签、提 Issue、触发如「跑一下 Nightly」等工作流），或按项精细控制；
    2. **项目任务权限**：不可访问、只读查看、只读 + 经项目 Manager 派活（完成后结果自动回群），或完全管理；
    3. **平台能力**：按需开放项目共享知识、项目设置与定时任务读写。
  - 群内所有成员无需各自配权限，均可按该群绑定范围直接 `@` 助手查代码、问 Issue/PR、检索项目知识、收发图片/文件与派发任务。
  - 群内可直接用自然语言增删改**本群定时任务**（如每天 9 点巡检主干 CI，没异常保持沉默），并共用本群的助手电脑。
- **实时事件通知订阅**
  - 在项目的「定时任务与通知」页订阅 `task.failed`、`ci.failed`、`ci.recovered` 等事件，自动将告警推送到指定飞书私聊或群（支持聚合窗口与静默时段）。

> 飞书接入与权限细节见 [管理助手、飞书应用机器人与群聊助手](docs/features/assistants-and-channels.md) 与 [定时任务与事件通知订阅](docs/features/schedules-and-notifications.md)。

## 行为可控、边界清晰

- **权限分级可控**：每个项目有明确的能力上限（`read` 只读问答 / `comment` 评论打标签 / `develop` 开发并开 PR），新项目默认 `comment`，不经开启绝不自动改代码。
- **默认不自动合并**：自动合并策略默认关闭（`disallow`），仅在有写权限的维护者明确要求时才合并 PR（目标分支启用 Merge Queue 时自动入队），也可按项目灵活配置。
- **隔离与凭据安全**：GitHub 写凭据与模型 API Key 仅加密保存在控制面，绝不进入虚拟电脑或日志；每个仓库独占隔离的项目电脑容器，非受信任 PR 检出不会加载未合入的仓库 Skill 或配置。

## 自行部署

无需克隆仓库，使用 Docker Compose 即可拉取镜像启动：

```sh
mkdir department-bot && cd department-bot
curl -fsSLO https://raw.githubusercontent.com/agent-CI-Infra/bot/main/docker/compose.yaml
docker compose up -d
```

启动后访问 `http://127.0.0.1:8791/` 创建首位超级管理员并按七步向导完成公网入口、GitHub App、GitHub 登录与模型配置。完整部署、升级与运维说明见 [部署、升级与运维](docs/features/deployment-and-operations.md)。

## 文档导航

本仓库文档在 `docs/` 下按 **功能** 与 **设计** 两个维度长期维护（详见 [文档总入口](docs/README.md)）：

- **功能地图与使用指南（`docs/features/`）**：面向用户与管理员，见 [`docs/features/README.md`](docs/features/README.md)
  - [登录、系统初始化与仓库接入](docs/features/onboarding-and-access.md)
  - [GitHub 自动化：检视、开发、Actions 与 CI 改动](docs/features/github-automation.md)
  - [角色配置、规则、能力上限与自动合并](docs/features/roles-and-rules.md)
  - [控制台、项目总览、知识库、发版本与公开看板](docs/features/console-and-workspace.md)
  - [管理助手、飞书应用机器人与群聊助手](docs/features/assistants-and-channels.md)
  - [定时任务与事件通知订阅](docs/features/schedules-and-notifications.md)
  - [模型连接与用量成本](docs/features/models-and-costs.md)
  - [外部执行端](docs/features/external-executors.md)
  - [部署、升级与运维](docs/features/deployment-and-operations.md)
- **架构与核心设计（`docs/design/`）**：面向开发者与维护者，见 [`docs/design/README.md`](docs/design/README.md)
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
