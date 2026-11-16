# 内置场景规则

本目录的 Markdown 是 Bot 的内置规则层，`manager-dispatch.md` 是完整的 Manager 分派默认提示词，其他文件用于各任务的内置规则。控制面启动时由 `src/rules/service.ts` 按文件读入 `defaults`（`onboarding.md` 除外：它由 `src/management/onboarding.ts` 读入，作为仓库接入向导的系统提示词，不是规则层，也不能覆盖），规则接口、Manager 页的「内置文本」和模型系统提示用的都是这里的原文；运行镜像把本目录复制到 `/app/docs/prompts`。修改这些文件就是修改所有没有写对应章节的项目的默认行为。

## 文件对应

| 文件 | Manager 章节 | 作用 |
| --- | --- | --- |
| [`labels.md`](labels.md) | `labels` | 检视标签的用法；从仓库已有标签里为 Issue 和 PR 选择 `type`、`source`、`priority`、`area`、`size` 等分类标签，由控制面校验后添加；分类不等于授权 |
| [`issue-review.md`](issue-review.md) | `review.issue` | 新 Issue 的意图、缺失信息、代码证据与授权判断，以及哪些检视结果会启动开发 |
| [`pr-review.md`](pr-review.md) | `review.pr` | PR 检视：一轮报全、严重度与处置、复审收敛、相关性判断、COMMENT 输出 |
| [`issue-development.md`](issue-development.md) | `development` | 开发任务的资格、范围、停止条件、测试与 PR 说明 |
| [`release-observe.md`](release-observe.md) | CI 观察章节 | CI 观察的提示词：读取运行、分析日志与代码、给出结论 |
| [`manager-dispatch.md`](manager-dispatch.md) | `dispatch` | 每个事件新建、续接还是不处理的默认流程 |
| [`onboarding.md`](onboarding.md) | 无，不可覆盖 | 仓库接入向导：管理助手只读分析一个仓库，给出仓库画像、带推荐答案的问题和接入方案草稿，见[管理助手](../management-agent.md#仓库接入向导) |

三份检视和开发规则、CI 观察提示词以及接入向导提示词各带一张 ` ```mermaid ` 流程图（检视：检视 → 回复；开发：Issue 分析 → 开发 → 检视 → 测试，检视或测试发现问题时回到开发；接入：读仓库 → 画像 → 提问 → 方案），给 agent 说明步骤顺序，见[项目 Manager 与工作类型](../workflows.md)。

行为指南（`guide` 章节）的内置内容在 `src/rules/service.ts` 中；代码里这几条规则仍以它们替代的 `.bot/` 文件路径为键，但仓库里的 `.bot/` 文件已不再读取（#935）。

## 覆盖方式

在项目「角色 → Manager」的 Manager 提示词里写对应章节，整份替换内置文本，不限大小；只影响之后新建的任务。检视标签和开发标签的名字是项目设置（「项目设置 → 基本 → 标签」，默认 `bot-reviewed`／`bot-develop`），不写在这些文本里；模型在 `labels` 和 `development` 章节开头读到它们。完整说明见[在角色配置里调整行为](../rules.md)。

## 适配边界

文本最初整理自一个仓库已在运行的检视与认领规则，作为内置默认时做了这些调整：

- **检视输出**：PR 与 Issue 检视都通过 `finish_review` 返回，总结和每条发现分开；有真实 diff 位置的发现走行内，其余并入一条总结评论。GitHub review event 只用 COMMENT，模型不批准、不请求变更、不合并，也不调用标签接口。
- **工具边界**：PR 检视可以读代码、跑仓库已有的测试和 lint，不直接执行 PR 首次加入的脚本，不抓取 PR 文本里的 URL，不改工作树。这条只写在 `pr-review.md`；开发任务必须改文件。Issue 检视只能打开指向 GitHub（`github.com`、`*.githubusercontent.com`）的链接，其他主机的链接不打开。模型需要自己读本仓库的 Issue、PR、评论、行内检视、Actions 运行和检查状态时，调用 `github_read_token` 兑换只读令牌；令牌不能写，评论、标签、检视和 PR 仍由控制面发布。
- **开发资格**：控制面只要求开发已开启、Issue 上有人（不是 App）加了开发标签；能不能开发由项目 Manager 根据检视结论、Issue、指派人和已有任务判断，不开发时新建检视在 Issue 上回复缺什么（见 [manager-dispatch.md](manager-dispatch.md)）。人在检视前或检视后加标签都可以。控制面在发布前再查一次标签，被去掉就停下。限定 `type`／`size`、敏感区域必须人工这类额外条件，只在仓库自己的规则声明时才遵守。PR 由控制面从 Bot 自己的分支发布，PR 说明引用 Issue 中提出请求的原句；没有原句时写明由开发标签发起和实现的目标。
- **标签**：可用标签就是仓库里已有的标签，控制面把清单作为 `repository_labels` 交给模型。模型在 `finish_review` 的 `labels` 里选标签，不调用标签接口；控制面在总结评论发布后校验并添加，和检视标签一起加。校验时丢弃以下几类：仓库里没有的标签、保留标签（检视标签、开发标签、`agent/*`、`blocker`、`priority/critical`、`pr/*`、`gate/*`）、Issue 或 PR 上已经有值的维度。`priority` 只保留一个。
