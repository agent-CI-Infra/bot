# Launchpad 文档索引

本目录是 `agent-CI-Infra/bot`（launchpad）的长期文档库。为避免文档按历史 Issue 零散堆砌，库内文档严格划分为 **功能（`docs/features/`）** 与 **设计（`docs/design/`）** 两个维度，并持续按这两个维度维护更新。

## 两个目录的分工

| 目录 | 维度与定位 | 目标读者 | 关注重点 |
| --- | --- | --- | --- |
| [`docs/features/`](features/README.md) | **功能地图（特性说明与使用说明）** | 仓库维护者、项目管理员、平台管理员与终端用户 | 站在用户视角描述软件做什么、各场景行为边界是什么、在控制台/GitHub/飞书里如何使用和配置。 |
| [`docs/design/`](design/README.md) | **架构与核心设计** | 研发工程师、代码检视者与 AI 编码助手 | 站在系统视角描述模块划分、核心抽象、关键数据流、权限与安全边界、隔离及持久化设计。 |

### 长期维护约定

1. **按维度归位，不在 `docs/` 根目录堆散文档**：后续所有新增特性、行为变更或架构演进，都必须分别更新到 `docs/features/`（用户可见行为与用法）与 `docs/design/`（模块设计与核心机制）对应的主题文档中，并在各自目录的 `README.md` 保持索引准确。
2. **只讲重点，不写流水账**：聚焦当前生效的行为与主要设计决策，不以 Issue/PR 编号按时间追加补丁段落，也不把单次验证报告或临时对比截图提交进 `docs/`。
3. **文档与代码同步**：新增功能、权限项、环境变量或核心设计变更时，在同一 PR 中同步更新对应维度的文档（例如新增飞书权限时同步 `docs/features/assistants-and-channels.md` 的权限表）。

## 目录导航

### 功能地图（`docs/features/`）

完整索引见 [`docs/features/README.md`](features/README.md)：

- [登录、系统初始化与仓库接入](features/onboarding-and-access.md)
- [GitHub 自动化：检视、开发、Actions 与 CI 改动](features/github-automation.md)
- [角色配置、规则、能力上限与自动合并](features/roles-and-rules.md)
- [控制台、项目总览、知识库、发版本与公开看板](features/console-and-workspace.md)
- [管理助手、飞书应用机器人与群聊助手](features/assistants-and-channels.md)
- [定时任务与事件通知订阅](features/schedules-and-notifications.md)
- [模型连接与用量成本](features/models-and-costs.md)
- [外部执行端](features/external-executors.md)
- [部署、升级与运维](features/deployment-and-operations.md)

### 架构与设计（`docs/design/`）

完整索引见 [`docs/design/README.md`](design/README.md)：

- [系统总体架构与安全边界](design/architecture.md)
- [身份登录、安装档案与统一授权](design/identity-and-installations.md)
- [事件分派、通用任务引擎与交付验收](design/dispatch-and-tasks.md)
- [Agent 运行时、RoleRun 协议、Harness 与虚拟电脑](design/agent-and-harness-runtime.md)
- [统一管理服务、服务角色与飞书渠道架构](design/assistants-and-channels.md)
- [持久化调度与事件通知引擎](design/schedules-and-events.md)
- [存储架构、轨迹文件、工作区与项目知识引擎](design/storage-and-knowledge.md)
- [控制台前端架构与管理 API 总览](design/console-and-api.md)
- [外部执行端凭据代理与公开看板托管](design/external-and-public-board.md)
- [测试分层、并行分片与防腐化设计](design/testing-architecture.md)

## 运行时固定路径资产

以下目录/文件由控制面代码或 Docker 构建直接读取，**路径固定，不可随意移动或删除**：

- [`docs/prompts/`](prompts/README.md)：内置默认提示词与六大场景分派规则（由 `src/` 启动时直接 `readFileSync` 读取，并随 `docker/control-plane.Dockerfile` 打包进控制面镜像）。
- [`docs/external-token-api.md`](external-token-api.md)：个人电脑兑换外部 GitHub 令牌的 HTTP 协议与 curl 示例（由控制面在 `/docs/external-token-api.md` 原样托管）。
- `docs/images/`：被 `docs/features/` 稳定文档引用的控制台界面预览图（界面改版时同步更新，不存放未被引用的图片或单次验收截图）。

## 相关根目录文档

- [项目简介（`README.md`）](../README.md)
- [贡献与开发验证指南（`CONTRIBUTING.md`）](../CONTRIBUTING.md)
- [AI 编码助手指引（`AGENTS.md`）](../AGENTS.md)
