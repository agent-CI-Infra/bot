# 内置场景规则

本目录的 Markdown 是 Bot 的**运行时内置提示词资产**（路径固定，由 `src/` 启动时直接读取并随 `docker/control-plane.Dockerfile` 打包进控制面镜像）：

- `src/rules/service.ts` 读取 `labels.md`、`issue-review.md`、`pr-review.md`、`issue-development.md`、`release-observe.md` 作为内置默认规则；
- `src/dispatch/settings.ts` 读取 `manager-dispatch.md`（未自定义项目默认的完整 Manager 分派提示词）与 `manager-flows.md`（管理助手讲解/修改流程指引，不可覆盖）；
- `src/management/onboarding.ts` 读取 `onboarding.md`（管理助手仓库接入指引，不可覆盖）；
- `src/memory/consolidation-engine.ts` 读取 `memory-consolidation.md`（全平台夜间自动记忆整理内置提示词，固定由 Pi 后端执行，不可覆盖）；
- `src/actions/analysis.ts` 与 `src/actions/late-schedules.ts` 分别读取 `actions-failures.md` 与 `late-schedules.md`（不可覆盖）。

## 文件对应

| 文件 | 作用 |
| --- | --- |
| [`labels.md`](labels.md) | 分类标签选择规则（只选仓库已有标签、不建新标签、分类不等于授权） |
| [`issue-review.md`](issue-review.md) | Issue 检视流程、根因分析、认领判断与 `finish_review` 结论 |
| [`pr-review.md`](pr-review.md) | PR 检视流程、一轮报全、复审收敛与 `COMMENT` 输出边界 |
| [`issue-development.md`](issue-development.md) | Issue 开发资格、范围、里程碑回报与 PR 说明规范 |
| [`release-observe.md`](release-observe.md) | 发版本 CI 观察提示词 |
| [`manager-dispatch.md`](manager-dispatch.md) | 默认 Manager 分派提示词（按六大场景分章，每章含 Mermaid 流程图与边界准则，见[角色配置与规则](../features/roles-and-rules.md#3-manager-流程提示词与常设规则)） |
| [`manager-flows.md`](manager-flows.md) | 管理助手讲解与修改协作流程指引（先展示修改前后对比流程图，确认后再通过 `manager.update` 写回） |
| [`actions-failures.md`](actions-failures.md) | Actions 失败运行排查、查重与提报指引 |
| [`late-schedules.md`](late-schedules.md) | 定时 workflow 长期延迟时的优化推荐及 `workflow_dispatch` 改造示例（见[定时任务](../features/schedules-and-notifications.md#2-项目定时任务)） |
| [`onboarding.md`](onboarding.md) | 管理助手仓库接入指引（只读分析 → 仓库画像与提问 → 启动/申请启动 → 应用配置） |
| [`memory-consolidation.md`](memory-consolidation.md) | 全平台夜间自动记忆整理提示词（自由深读全量历史、多分支并存不误删、去重纠偏与允许删除、维护 `INDEX.md`、零外部副作用） |

## 覆盖与边界

- 项目调整行为统一在控制台「项目设置 → 角色」中修改对应角色指令或 Manager 提示词，只影响后续新建任务（完整规则见[角色配置、规则、能力上限与自动合并](../features/roles-and-rules.md)）。
- 检视/开发/开发中/需人工标签名称在「项目设置 → 基本设置 → 标签」配置，不由本目录提示词写死。
- 提示词仅指导工作流程，不能扩大权限或绕过控制面的能力上限、写入授权、自动合并策略及独立 QA 门禁（架构边界见[事件分派、通用任务引擎与交付验收](../design/dispatch-and-tasks.md)）。
- 凡涉及需要人类参与、确认或决策的场景（检视待裁定、开发停止、任务求助、流程修改、仓库接入等），内置提示词均要求先讲清背景与阻塞点；存在多种可行方案时给出含明确推荐项的备选方案及各自优缺点，单一路径阻塞则直接说明所需动作而不编造备选（`late-schedules.md` 按设计仅推荐一套配套的两步改造方案，不列备选）。
