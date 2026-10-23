# 内置场景规则

本目录的四份 Markdown 就是 Bot 的内置规则层。控制面启动时由 `src/rules/service.ts` 按文件读入 `defaults`，规则接口、引导页的「内置默认」和模型系统提示用的都是这里的原文；运行镜像把本目录复制到 `/app/docs/prompts`。修改这些文件就是修改所有没有覆盖的项目的默认行为。

## 文件对应

| 文件 | 内置到的路径 | 作用 |
| --- | --- | --- |
| [`labels.md`](labels.md) | `.bot/rules/labels.md` | 检视标签声明；只在仓库有标签清单时建议 `type`、`source`、`priority`、`area`、`size`，分类不等于授权 |
| [`issue-review.md`](issue-review.md) | `.bot/rules/issue-review.md` | 新 Issue 的意图、缺失信息、代码证据与授权判断，以及哪些检视结果会启动开发 |
| [`pr-review.md`](pr-review.md) | `.bot/rules/pr-review.md` | PR 检视：一轮报全、严重度与处置、复审收敛、相关性判断、COMMENT 输出 |
| [`issue-development.md`](issue-development.md) | `.bot/rules/issue-development.md` | 开发任务的资格、范围、停止条件、测试与 PR 说明 |

`.bot/guide.md` 与 `.bot/computer.yaml` 的内置内容仍在 `src/rules/service.ts` 中。

## 覆盖方式

优先级是「内置默认 → 项目控制台 → 默认分支仓库文件」，每层整份替换，单份上限 16 KiB。

1. **仓库文件**：把改好的文本放到默认分支的 `.bot/rules/<name>.md`。PR 内的改动不会成为当次任务的规则。
2. **项目控制台**：在项目页对应规则卡片上「添加控制台覆盖」，编辑框从内置文本开始。仓库已经有同名文件时，控制台内容不会悄悄盖过它。
3. 覆盖 `labels.md` 时保留 `review_label:` 行，它决定检视成功后由控制面加上的标签；去掉这一行就不再打检视标签。
4. `issue-development.md` 第一行 `development_label:` 是开发标签名，默认 `bot-develop`。覆盖时去掉这一行仍按 `bot-develop` 要求，开发标签这道要求不能通过改规则关闭；不想自动开发就关掉项目的开发开关。

标签名最长 50 个字符，不能有控制字符。

## 适配边界

文本最初整理自一个仓库已在运行的检视与认领规则，作为内置默认时做了这些调整：

- **检视输出**：PR 与 Issue 检视都通过 `finish_review` 返回，总结和每条发现分开；有真实 diff 位置的发现走行内，其余并入一条总结评论。GitHub review event 只用 COMMENT，模型不批准、不请求变更、不合并，也不调用标签接口。
- **工具边界**：PR 检视可以读代码、跑仓库已有的测试和 lint，不直接执行 PR 首次加入的脚本，不抓取 PR 文本里的 URL，不改工作树。这条只写在 `pr-review.md`；开发任务必须改文件。Issue 检视只能打开指向 GitHub（`github.com`、`*.githubusercontent.com`）的链接，其他主机的链接不打开。
- **开发资格**：控制面在以下条件同时满足时才创建开发任务：开发已开启；检视评论已发布，并判定 Issue 原文明确要求改代码；Issue 上有人（不是 App）加了开发标签；Issue 没有指派人。人在检视前或检视后加标签都可以。控制面在发布前再查一次标签和指派人，任一条件不再满足就停下，等人重试。限定 `type`／`size`、敏感区域必须人工这类额外条件，只在仓库自己的规则声明时才遵守。PR 由控制面从 Bot 自己的分支发布，PR 说明引用 Issue 中授权的原句。
- **标签**：不写死任何组织的标签清单。模型只在检视正文里建议仓库清单里已有的标签，`agent/*`、`blocker`、`priority/critical`、`pr/*`、`gate/*` 和开发标签不由模型提出。
