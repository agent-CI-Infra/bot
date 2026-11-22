# 功能地图（Features）

本目录是 launchpad 的 **功能维度文档**，充当产品的 **功能地图、特性说明与使用指南**。

## 目录分工

- **本目录（`docs/features/`）**：站在用户与管理员的视角，描述软件做什么、在各种触发条件下的实际行为、权限与安全边界，以及如何在控制台、GitHub 和飞书中配置与使用。重点讲清核心能力与操作方式，不展开内部实现细节。
- **配套设计目录（[`docs/design/`](../design/README.md)）**：站在开发者视角，说明各子系统的模块架构、数据流与核心设计。
- **更新约定**：后续凡涉及用户可见行为、页面入口、配置项、权限或操作流程的变化，均应同步更新本目录对应文档，并在本索引中保持导航一致；不按单次 Issue 另起零散文件。

## 功能总览

| 模块 | 文档 | 核心能力与使用场景 |
| --- | --- | --- |
| 接入与权限 | [登录、系统初始化与仓库接入](onboarding-and-access.md) | 首位管理员初始化、GitHub OAuth 登录、七步系统初始化、受信任组织与管理助手仓库接入、项目成员与委派权限。 |
| GitHub 自动化 | [GitHub 自动化：检视、开发、Actions 与 CI 改动](github-automation.md) | Issue/PR 自动与按需检视、满足条件时的自主/触发开发与 PR 交付、bot PR 跟进修订、Actions 失败排查提报、受控 CI 改动。 |
| 角色与策略 | [角色配置、规则、能力上限与自动合并](roles-and-rules.md) | 项目能力上限三档、自动合并策略三档、Manager 六大场景流程与常设规则、项目角色池、标签配置、虚拟电脑规格与 `.agents/skills/` 仓库 Skill。 |
| 控制台与看板 | [控制台、项目总览、知识库、发版本与公开看板](console-and-workspace.md) | 控制台导航、项目列表快捷开关、项目总览四视图（角色/任务/Issue/PR）、任务详情与待处理中心、项目知识库、手动发版本、公共 Dashboard 与单仓看板。 |
| 助手与飞书 | [管理助手、飞书应用机器人与群聊助手](assistants-and-channels.md) | 控制台与飞书私聊管理助手、飞书应用连接与权限清单、双端身份绑定、群聊助手绑定与三维权限、阶段消息/保持安静、富文本与多模态文件。 |
| 定时与通知 | [定时任务与事件通知订阅](schedules-and-notifications.md) | 项目定时任务（含准点触发 workflow）、飞书会话定时任务、任务/CI 失败与恢复事件通知订阅。 |
| 模型与成本 | [模型连接与用量成本](models-and-costs.md) | 供应商统一管理与探测、项目默认 + 按角色覆写两层模型选择、计费单价与用量成本统计。 |
| 外部执行端 | [外部执行端](external-executors.md) | 个人电脑公钥签名与 GitHub Actions OIDC 兑换受限 Bot 令牌、Webhook 签名转发与事件轮询。 |
| 部署与运维 | [部署、升级与运维](deployment-and-operations.md) | Docker Compose 快速部署、源码构建、版本发布与生产自动部署、端口环境变量、备份恢复、存储回收与故障排查。 |

## 延伸入口

- 查看系统架构、核心协议与模块设计：[`docs/design/README.md`](../design/README.md)
- 查看外部客户端 HTTP 兑换协议与 curl 示例：[`docs/external-token-api.md`](../external-token-api.md)
- 查看内置默认提示词原文：[`docs/prompts/README.md`](../prompts/README.md)
- 参与仓库代码开发与测试验证：[`CONTRIBUTING.md`](../../CONTRIBUTING.md)
