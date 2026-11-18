# 内置场景规则

本目录的 Markdown 是 Bot 的内置规则层，`manager-dispatch.md` 是完整的 Manager 分派默认提示词，其他文件用于各任务的内置规则。控制面启动时由 `src/rules/service.ts` 按文件读入 `defaults`（`onboarding.md` 和 `late-schedules.md` 除外：前者由 `src/management/onboarding.ts` 读入，作为仓库接入向导的系统提示词；后者由 `src/actions/late-schedules.ts` 读入；两者都不是规则层，也不能覆盖），规则接口、Manager 页的「内置文本」和模型系统提示用的都是这里的原文；运行镜像把本目录复制到 `/app/docs/prompts`。修改这些文件就是修改所有没有写对应章节的项目的默认行为。项目可以把 [定时检查章节的建议文本](../schedule-check.md) 自行写入 Manager「定时检查」章节；那份文本必须留在 `docs/` 下作为模板，不得加入本目录或登记为内置提示词（该章节默认保持为空，以免撑破管理助手单次工具结果的 256 KiB 上限）。

## 文件对应

| 文件 | Manager 章节 | 作用 |
| --- | --- | --- |
| [`labels.md`](labels.md) | `labels` | 检视标签的用法；从仓库已有标签里为 Issue 和 PR 选择 `type`、`source`、`priority`、`area`、`size` 等分类标签，需要人决定时选仓库已有的讨论类标签（没有就在总结里说明，不建），由控制面校验后添加；分类不等于授权 |
| [`issue-review.md`](issue-review.md) | `review.issue` | 新 Issue 的意图；用仓库证据补全缺失内容（标明推断，写在检视评论里）、确认 bug（复现或读代码）、根因因果链、带推荐的修改方案；根据指派人、关联 PR 和评论判断是否已被别人认领，写在建议里；结论（可开发、需要信息、需要人决定、不需要改代码）写在 `finish_review` 的 `conclusion` 里 |
| [`pr-review.md`](pr-review.md) | `review.pr` | PR 检视：一轮报全、实现是否合理（是否达成关联 Issue、是否符合现有架构、有无更简单做法、修复是否有测试证明）、严重度与处置、复审收敛、相关性判断、COMMENT 输出 |
| [`issue-development.md`](issue-development.md) | `development` | 开发任务的资格、范围、停止条件、测试与 PR 说明；开发 Issue 时用 `report_development_milestone` 提交分析与计划、完成、停止三类里程碑，由控制面写进 Issue 上的一条进展评论 |
| [`release-observe.md`](release-observe.md) | CI 观察章节 | CI 观察的提示词：读取运行、分析日志与代码、给出结论 |
| [`manager-dispatch.md`](manager-dispatch.md) | `dispatch` | 每个事件新建、续接还是不处理的默认流程 |
| [`late-schedules.md`](late-schedules.md) | 无，不可覆盖 | 定时运行延迟严重时的推荐（#1072）：怎样判断 workflow 的定时运行晚得多、先查重（同一仓库只推荐一次）、在 Issue 里推荐 bot 定时触发并附 workflow 改造的 YAML 示例。由 `src/actions/late-schedules.ts` 读入，作为 `late_scheduled_runs` 交给 Actions 失败处理、CI 观察和项目定时任务，并附在群聊助手（能读 Actions 时）和管理助手的系统提示后面，见[定时任务](../schedules.md#定时触发-workflow) |
| [`onboarding.md`](onboarding.md) | 无，不可覆盖 | 仓库接入向导：管理助手只读分析一个仓库，给出仓库画像、带推荐答案的问题和接入方案草稿，见[管理助手](../management-agent.md#仓库接入向导) |

三份检视和开发规则、CI 观察提示词以及接入向导提示词各带一张 ` ```mermaid ` 流程图（检视：检视 → 回复；开发：Issue 分析 → 开发 → 检视 → 测试，检视或测试发现问题时回到开发；接入：读仓库 → 画像 → 提问 → 方案），给 agent 说明步骤顺序，见[项目 Manager 与工作类型](../workflows.md)。

行为指南（`guide` 章节）的内置内容在 `src/rules/service.ts` 中；代码里这几条规则仍以它们替代的 `.bot/` 文件路径为键，但仓库里的 `.bot/` 文件已不再读取（#935）。

## 覆盖方式

在项目「角色 → Manager」的 Manager 提示词里写对应章节，整份替换内置文本，不限大小；只影响之后新建的任务。检视标签和开发标签的名字是项目设置（「项目设置 → 基本 → 标签」，默认 `bot-reviewed`／`bot-develop`），不写在这些文本里；模型在 `labels` 和 `development` 章节开头读到它们。完整说明见[在角色配置里调整行为](../rules.md)。开发标签是开发的依据之一（另有维护者在评论里的要求和 Manager 提示词里的规则，#815）；不想自动开发就把项目能力上限设在「可开发并开 PR」以下。

## 适配边界

文本最初整理自一个仓库已在运行的检视与认领规则，作为内置默认时做了这些调整：

- **检视输出**：PR 与 Issue 检视都通过 `finish_review` 返回，总结和每条发现分开；有真实 diff 位置的发现走行内，其余并入一条总结评论。GitHub review event 只用 COMMENT，模型不批准、不请求变更、不合并，也不调用标签接口。
- **工具边界**：PR 检视可以读代码、跑仓库已有的测试和 lint，不直接执行 PR 首次加入的脚本，不抓取 PR 文本里的 URL，不改工作树。这条只写在 `pr-review.md`；开发任务必须改文件。Issue 检视确认 bug 时也可以跑仓库已有的测试和命令，或在检出目录之外（例如 `mktemp -d`）写最小复现，检出目录保持不变（`issue-review.md`）。Issue 检视只能打开指向 GitHub（`github.com`、`*.githubusercontent.com`）的链接，其他主机的链接不打开。模型需要自己读本仓库的 Issue、PR、评论、行内检视、Actions 运行和检查状态时，调用 `github_read_token` 兑换只读令牌；令牌不能写，评论、标签、检视和 PR 仍由控制面发布。
- **开发资格**：开发别人开的 Issue 由项目 Manager 决定，并写明依据：有人（不是 App）加的开发标签、triage 以上权限的维护者在评论里的要求，或 Manager 提示词里的规则（内置提示词带一条自主开发规则：检视结论为「可开发」、方案明确且没有被别人认领时可以自行开发，#1026、#1047；是否被认领由模型根据控制面给的指派人、关联 PR 和评论原文判断，不做文本匹配；能力上限为 `develop` 时这是默认，仓库 README 或 CONTRIBUTING 里只要求「必须由人加开发标签」的句子不取消这条规则，怎么改代码、跑什么测试、用哪些已有标签仍按仓库自己的说明和 skill）；控制面建任务时核对依据并记在任务上，外人的评论不算（见 [manager-dispatch.md](manager-dispatch.md)）。以标签为依据的开发在发布前再查一次标签。限定 `type`／`size`、敏感区域必须人工这类额外条件，只在仓库自己的规则声明时才遵守。PR 由控制面从 Bot 自己的分支发布，PR 说明写明开发的依据和实现的目标。
- **标签**：可用标签就是仓库里已有的标签，控制面把清单作为 `repository_labels` 交给模型。模型在 `finish_review` 的 `labels` 里选标签，不调用标签接口；控制面在总结评论发布后校验并添加，和检视标签一起加。校验时丢弃以下几类：仓库里没有的标签、保留标签（检视标签、开发标签、`agent/*`、`blocker`、`priority/critical`、`pr/*`、`gate/*`）、Issue 或 PR 上已经有值的维度。`priority` 只保留一个。
