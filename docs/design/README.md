# 架构与设计（Design）

本目录是 launchpad 的 **设计维度文档**，说明系统各核心模块的架构拓扑、关键抽象、数据流、安全边界与容错设计。

## 目录分工

- **本目录（`docs/design/`）**：站在系统设计与研发维护的视角，讲清主要模块如何划分、核心机制如何运作以及关键不变量是什么；聚焦架构与核心设计，不罗列历史 Issue 变更流水账或逐行代码细节。
- **配套功能目录（[`docs/features/`](../features/README.md)）**：站在用户视角，充当功能地图、特性说明与使用手册。
- **更新约定**：后续凡涉及模块职责调整、核心协议/状态机演进、存储结构或安全边界变更，均应同步更新本目录对应文档，并维护本页索引；不在 `docs/` 根目录堆放零散设计稿。

## 模块设计索引

| 领域 | 文档 | 覆盖模块与核心设计 |
| --- | --- | --- |
| 总体架构 | [系统总体架构与安全边界](architecture.md) | 控制面 / Manager / Runner / Webhook / Tunnel 拓扑、容器与网络隔离、凭据边界与可观测性。 |
| 身份与安装 | [身份登录、安装档案与统一授权](identity-and-installations.md) | 独立 OAuth 登录、GitHub App 安装档案与持久化同步、本地成员缓存、`ActorContext` 与授权版本。 |
| 分派与任务 | [事件分派、通用任务引擎与交付验收](dispatch-and-tasks.md) | 单对象持久 Manager 线程、常设规则、`task.request` 通用任务引擎、任务优先级/父子拆解/协调、候选快照、独立 QA 与幂等发布。 |
| 运行时与电脑 | [Agent 运行时、RoleRun 协议、Harness 与虚拟电脑](agent-and-harness-runtime.md) | `runAgent` 与模型网关、`github_write`/只读探索工具、`bot.role-run/1` 协议与 `TaskToolGateway`、Pi/Process/Claude Code/Codex/容器内 ACP 后端、项目电脑与助手电脑生命周期及预装桌面环境。 |
| 助手与渠道 | [统一管理服务、服务角色与飞书渠道架构](assistants-and-channels.md) | `ManagementService` 闭集查询/命令与回执、服务角色体系、飞书长连接/HTTP 适配器、本地消息账本、回合消息并入与 Outbox 投递。 |
| 调度与事件 | [持久化调度与事件通知引擎](schedules-and-events.md) | 持久化 Schedule/Occurrence 租约与 `ControlledTrigger` 契约、事件 Outbox、聚合与静默窗口、多级预算与发送重试。 |
| 存储与知识 | [存储架构、轨迹文件、工作区与项目知识引擎](storage-and-knowledge.md) | SQLite + JSONL 哈希链轨迹 + Blob 架构、工具结果卷、启动压缩与按天回收、剩余空间保护、共享 Git Worktree 工作区、项目知识自由文件与版本历史。 |
| 前端与 API | [控制台前端架构与管理 API 总览](console-and-api.md) | 控制台壳层与路由架构、单源设计令牌与安全 Markdown/Mermaid 渲染、管理 API 鉴权与主要端点总览。 |
| 外部与看板 | [外部执行端凭据代理与公开看板托管](external-and-public-board.md) | 非对称 JWT / OIDC 凭据 Broker、受控内网转发与事件轮询、公开看板增量采集与静态托管。 |
| 测试架构 | [测试分层、并行分片与防腐化设计](testing-architecture.md) | UT/ST/E2E/Docker/Live 分层职责、`test-sets.mjs` 并行隔离与回环网络守卫、CI 双分片权重均衡与防测试架构腐化红线。 |

## 延伸入口

- 查看面向用户的功能地图与使用指南：[`docs/features/README.md`](../features/README.md)
- 查看文档库总入口与维护约定：[`docs/README.md`](../README.md)
- 查看开发、测试分层、CI 与合入流程：[`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- 查看 AI 编码助手仓库指引：[`AGENTS.md`](../../AGENTS.md)
