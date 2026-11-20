# 内置场景规则

本目录的 Markdown 是 Bot 的内置规则层，`manager-dispatch.md` 是完整的 Manager 分派默认提示词，其他文件用于各任务的内置规则。控制面启动时由 `src/rules/service.ts` 按文件读入 `defaults`（`onboarding.md`、`manager-flows.md` 和 `late-schedules.md` 除外：前两者分别由 `src/management/onboarding.ts` 和 `src/dispatch/settings.ts` 读入并附在管理助手的系统提示后面，用于引导仓库接入和讲解、修改协作流程；后者由 `src/actions/late-schedules.ts` 读入；三者都不是规则层，也不能覆盖），规则接口、Manager 页的「内置文本」和模型系统提示用的都是这里的原文；运行镜像把本目录复制到 `/app/docs/prompts`。修改这些文件就是修改所有项目的内置规则（只有 #935 一次性导入过 `.bot/` 规则的项目沿用导入的文本）；`manager-dispatch.md` 只对没有保存自己 Manager 提示词的项目生效。项目可以把 [定时检查的建议文本](../schedule-check.md) 自行写进 Manager 提示词；那份文本必须留在 `docs/` 下作为模板，不得加入本目录或登记为内置提示词（以免撑破管理助手单次工具结果的 256 KiB 上限）。

## 文件对应

| 文件 | 旧 Manager 章节 id（#1122 前） | 作用 |
| --- | --- | --- |
| [`labels.md`](labels.md) | `labels` | 检视标签的用法；从仓库已有标签里为 Issue 和 PR 选择 `type`、`source`、`priority`、`area`、`size` 等分类标签，需要人决定时选仓库已有的讨论类标签（没有就在总结里说明，不建），由控制面校验后添加；分类不等于授权 |
| [`issue-review.md`](issue-review.md) | `review.issue` | 新 Issue 的意图；用仓库证据补全缺失内容（标明推断，写在检视评论里）、确认 bug（复现或读代码）、根因因果链、带推荐的修改方案；根据指派人、关联 PR 和评论判断是否已被别人认领，写在建议里；结论（可开发、需要信息、需要人决定、不需要改代码）写在 `finish_review` 的 `conclusion` 里 |
| [`pr-review.md`](pr-review.md) | `review.pr` | PR 检视：一轮报全、实现是否合理（是否达成关联 Issue、是否符合现有架构、有无更简单做法、修复是否有测试证明）、严重度与处置、复审收敛、相关性判断、COMMENT 输出 |
| [`issue-development.md`](issue-development.md) | `development` | 开发任务的资格、范围、停止条件、测试与 PR 说明；开发 Issue 时用 `report_development_milestone` 提交分析与计划、完成、停止三类里程碑，由控制面写进 Issue 上的一条进展评论 |
| [`release-observe.md`](release-observe.md) | CI 观察章节 | CI 观察的提示词：读取运行、分析日志与代码、给出结论 |
| [`manager-dispatch.md`](manager-dispatch.md) | `dispatch` | 每个事件新建、续接还是不处理的默认流程，按六大场景分章，每章一句话能力说明、一张流程图和 3～5 条边界准则（#1123，见[统一任务调度与对象 Manager](../workflows.md#内置-manager-提示词六大场景1123)） |
| [`manager-flows.md`](manager-flows.md) | 无，不可覆盖 | 讲解和修改协作流程（#1123）：附在管理助手系统提示后面，回答「怎么工作」时引用项目当前 Manager 提示词的流程图，改流程时先给「当前流程 vs 修改后流程」两张图和变更要点，确认后才用 `manager.update` 写回，见[管理助手](../management-agent.md#讲解和修改协作流程1123) |
| [`actions-failures.md`](actions-failures.md) | 无，不可覆盖 | Actions 失败任务的排查、查重与按仓库约定提报指引。Manager 分派的通用任务会收到这份提示词和运行上下文。 |
| [`late-schedules.md`](late-schedules.md) | 无，不可覆盖 | 定时运行延迟严重时的推荐（#1072）：怎样判断 workflow 的定时运行晚得多、先查重（同一仓库只推荐一次）、在 Issue 里推荐 bot 定时触发并附 workflow 改造的 YAML 示例。由 `src/actions/late-schedules.ts` 读入，作为 `late_scheduled_runs` 交给 Actions 失败处理、CI 观察和项目定时任务，并附在群聊助手（能读 Actions 时）和管理助手的系统提示后面，见[定时任务](../schedules.md#定时触发-workflow) |
| [`onboarding.md`](onboarding.md) | 无，不可覆盖 | 仓库接入指引（#1133）：附在管理助手系统提示后面，引导助手对已安装仓库做只读分析、给出画像与关键选项、经确认后调用 `start_repository` 启动或申请启动，并通过标准管理命令与控制台确认卡片落地配置，见[管理助手](../management-agent.md#仓库接入启动申请与控制台确认卡片) |

三份检视和开发规则、CI 观察提示词以及仓库接入提示词各带一张 ` ```mermaid ` 流程图（检视：检视 → 回复；开发：Issue 分析 → 开发 → 检视 → 测试，检视或测试发现问题时回到开发；接入：读仓库与现配置 → 画像与提问 → 启动或申请启动 → 应用配置／生成待确认 CI 任务），给 agent 说明步骤顺序，见[统一任务调度与对象 Manager](../workflows.md)。

行为指南（`guide` 章节）的内置内容在 `src/rules/service.ts` 中；代码里这几条规则仍以它们替代的 `.bot/` 文件路径为键，但仓库里的 `.bot/` 文件已不再读取（#935）。

## 覆盖方式

#1122 起没有按章节覆盖内置文本的方式：Manager 提示词是一整份文本（`manager.update`），迁移时把旧的检视、标签自定义章节并入 reviewer 角色指令，开发章节并入 dev 角色指令。项目要调整检视或开发的做法，改「角色」页对应角色的指令（`roles.update`），或写进 Manager 提示词；内置规则文本本身不能按项目替换（规则接口的写入返回 410 `rules_update_removed`）。这些改动只影响之后新建的任务。检视标签和开发标签的名字是项目设置（「项目设置 → 基本 → 标签」，默认 `bot-reviewed`／`bot-develop`），不写在这些文本里；模型在标签规则和开发规则的开头读到它们。完整说明见[在角色配置里调整行为](../rules.md)。开发标签是开发的依据之一（另有维护者在评论里的要求和 Manager 提示词里的规则，#815）；不想自动开发就把项目能力上限设在「可开发并开 PR」以下。

## 适配边界

文本最初整理自一个仓库已在运行的检视与认领规则，作为内置默认时做了这些调整：

- **检视输出**：PR 与 Issue 检视都通过 `finish_review` 返回，总结和每条发现分开；有真实 diff 位置的发现走行内，其余并入一条总结评论。GitHub review event 只用 COMMENT，模型不批准、不请求变更、不合并，也不调用标签接口。
- **工具边界**：PR 检视可以读代码、跑仓库已有的测试和 lint，不直接执行 PR 首次加入的脚本，不抓取 PR 文本里的 URL，不改工作树。这条只写在 `pr-review.md`；开发任务必须改文件。Issue 检视确认 bug 时也可以跑仓库已有的测试和命令，或在检出目录之外（例如 `mktemp -d`）写最小复现，检出目录保持不变（`issue-review.md`）。Issue 检视只能打开指向 GitHub（`github.com`、`*.githubusercontent.com`）的链接，其他主机的链接不打开。模型需要自己读本仓库的 Issue、PR、评论、行内检视、Actions 运行和检查状态时，调用 `github_read_token` 兑换只读令牌；令牌不能写，评论、标签、检视和 PR 仍由控制面发布。
- **开发资格**：开发别人开的 Issue 由项目 Manager 决定，并写明依据：有人（不是 App）加的开发标签、triage 以上权限的维护者在评论里的要求，或 Manager 提示词里的规则（内置提示词带一条自主开发规则：检视结论为「可开发」、方案明确且没有被别人认领时可以自行开发，#1026、#1047；是否被认领由模型根据控制面给的指派人、关联 PR 和评论原文判断，不做文本匹配；能力上限为 `develop` 时这是默认，仓库 README 或 CONTRIBUTING 里只要求「必须由人加开发标签」的句子不取消这条规则，怎么改代码、跑什么测试、用哪些已有标签仍按仓库自己的说明和 skill）；控制面建任务时核对依据并记在任务上，外人的评论不算（见 [manager-dispatch.md](manager-dispatch.md)）。以标签为依据的开发在发布前再查一次标签。限定 `type`／`size`、敏感区域必须人工这类额外条件，只在仓库自己的规则声明时才遵守。PR 由控制面从 Bot 自己的分支发布，PR 说明写明开发的依据和实现的目标。
- **标签**：可用标签就是仓库里已有的标签，控制面把清单作为 `repository_labels` 交给模型。模型在 `finish_review` 的 `labels` 里选标签，不调用标签接口；控制面在总结评论发布后校验并添加，和检视标签一起加。校验时丢弃以下几类：仓库里没有的标签、保留标签（检视标签、开发标签、`agent/*`、`blocker`、`priority/critical`、`pr/*`、`gate/*`）、Issue 或 PR 上已经有值的维度。`priority` 只保留一个。
