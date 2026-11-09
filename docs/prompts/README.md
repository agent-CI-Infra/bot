# 内置场景规则

本目录的 Markdown 是 Bot 的内置规则层，也是 Manager 提示词各章节的内置文本（`manager-dispatch.md` 是「分派」章节）。控制面启动时由 `src/rules/service.ts` 按文件读入 `defaults`，规则接口、引导页的「内置默认」和模型系统提示用的都是这里的原文；运行镜像把本目录复制到 `/app/docs/prompts`。修改这些文件就是修改所有没有覆盖的项目的默认行为。

## 文件对应

| 文件 | 内置到的路径 | 作用 |
| --- | --- | --- |
| [`labels.md`](labels.md) | `.bot/rules/labels.md` | 检视标签声明；从仓库已有标签里为 Issue 和 PR 选择 `type`、`source`、`priority`、`area`、`size` 等分类标签，由控制面校验后添加；分类不等于授权 |
| [`issue-review.md`](issue-review.md) | `.bot/rules/issue-review.md` | 新 Issue 的意图、缺失信息、代码证据与授权判断，以及哪些检视结果会启动开发 |
| [`pr-review.md`](pr-review.md) | `.bot/rules/pr-review.md` | PR 检视：一轮报全、严重度与处置、复审收敛、相关性判断、COMMENT 输出 |
| [`issue-development.md`](issue-development.md) | `.bot/rules/issue-development.md` | 开发任务的资格、范围、停止条件、测试与 PR 说明 |
| [`release-observe.md`](release-observe.md) | 无仓库文件，可由 Manager 章节覆盖 | CI 观察的提示词：读取运行、分析日志与代码、给出结论 |
| [`manager-dispatch.md`](manager-dispatch.md) | 无仓库文件，可由 Manager 的「分派」章节覆盖 | 每个事件新建、续接还是不处理的默认流程 |

三份检视和开发规则以及 CI 观察提示词各带一张 ` ```mermaid ` 流程图（检视：检视 → 回复；开发：Issue 分析 → 开发 → 检视 → 测试，检视或测试发现问题时回到开发），给 agent 说明步骤顺序，见[项目 Manager 与工作类型](../workflows.md)。

`.bot/guide.md` 与 `.bot/computer.yaml` 的内置内容仍在 `src/rules/service.ts` 中。

## 覆盖方式

优先级是「内置默认 → 项目控制台 → 默认分支仓库文件」，每层整份替换，不限大小。

1. **仓库文件**：把改好的文本放到默认分支的 `.bot/rules/<name>.md`。PR 内的改动不会成为当次任务的规则。
2. **项目控制台**：在项目「Manager 与角色」页的 Manager 提示词里写对应章节（检视 Issue、检视 PR、开发、标签规则、行为指南），可以先插入内置文本再改。仓库已经有同名文件时，控制台内容不会悄悄盖过它。
3. 覆盖 `labels.md` 时保留 `review_label:` 行，它决定检视成功后由控制面加上的标签；去掉这一行就不再打检视标签。
4. `issue-development.md` 第一行 `development_label:` 是开发标签名，默认 `bot-develop`。覆盖时去掉这一行仍按 `bot-develop` 要求，开发标签这道要求不能通过改规则关闭；不想自动开发就关掉项目的开发开关。

标签名最长 50 个字符，不能有控制字符。两行标签声明的完整写法、文件大小和出错时的处理见[用仓库文件调整规则](../rules.md)。

## 适配边界

文本最初整理自一个仓库已在运行的检视与认领规则，作为内置默认时做了这些调整：

- **检视输出**：PR 与 Issue 检视都通过 `finish_review` 返回，总结和每条发现分开；有真实 diff 位置的发现走行内，其余并入一条总结评论。GitHub review event 只用 COMMENT，模型不批准、不请求变更、不合并，也不调用标签接口。
- **工具边界**：PR 检视可以读代码、跑仓库已有的测试和 lint，不直接执行 PR 首次加入的脚本，不抓取 PR 文本里的 URL，不改工作树。这条只写在 `pr-review.md`；开发任务必须改文件。Issue 检视只能打开指向 GitHub（`github.com`、`*.githubusercontent.com`）的链接，其他主机的链接不打开。模型需要自己读本仓库的 Issue、PR、评论、行内检视、Actions 运行和检查状态时，调用 `github_read_token` 兑换只读令牌；令牌不能写，评论、标签、检视和 PR 仍由控制面发布。
- **开发资格**：控制面在以下条件同时满足时才创建开发任务：开发已开启；检视评论已发布，并判定 Issue 原文明确要求改代码；Issue 上有人（不是 App）加了开发标签；Issue 没有指派人。人在检视前或检视后加标签都可以。控制面在发布前再查一次标签和指派人，任一条件不再满足就停下，等人重试。限定 `type`／`size`、敏感区域必须人工这类额外条件，只在仓库自己的规则声明时才遵守。PR 由控制面从 Bot 自己的分支发布，PR 说明引用 Issue 中授权的原句。
- **标签**：可用标签就是仓库里已有的标签，控制面把清单作为 `repository_labels` 交给模型。模型在 `finish_review` 的 `labels` 里选标签，不调用标签接口；控制面在总结评论发布后校验并添加，和检视标签一起加。校验时丢弃以下几类：仓库里没有的标签、保留标签（检视标签、开发标签、`agent/*`、`blocker`、`priority/critical`、`pr/*`、`gate/*`）、Issue 或 PR 上已经有值的维度。`priority` 只保留一个。
