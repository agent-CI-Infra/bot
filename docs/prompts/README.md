# 场景规则模板（从 PPMA 整理）

本目录把 [Jianyu010/PPMA](https://github.com/Jianyu010/PPMA) 中已经运行的四类规则，整理成可直接放进仓库的 `.bot/rules/` 文本。每一份都是完整文件、可整份覆盖内置默认，符合「内置默认 → 项目控制台 → 默认分支仓库文件」的优先级，单份上限 16 KiB。

## 文件对应

| 模板 | 放入仓库的路径 | PPMA 来源 | 作用 |
| --- | --- | --- | --- |
| [`labels.md`](labels.md) | `.bot/rules/labels.md` | `LABELING.md`、`scripts/ci_autolabel.py`、`.github/workflows/label-lint.yml` | 标签轴、基数、人工专属标签、分类不等于授权 |
| [`issue-review.md`](issue-review.md) | `.bot/rules/issue-review.md` | `LABELING.md`、`scripts/ci_issue_autonomy.py`、`AGENTS.md` | 新 Issue 的意图、缺失信息、代码证据与授权判断 |
| [`pr-review.md`](pr-review.md) | `.bot/rules/pr-review.md` | `tools/opencode-review/prompts/reviewer.md`、`tools/opencode-review/config/opencode.json` | PR 检视：一轮报全、严重度与处置、复审收敛、相关性判断 |
| [`issue-development.md`](issue-development.md) | `.bot/rules/issue-development.md` | `LABELING.md`「Unattended AI issue pickup」、`scripts/ci_issue_autonomy.py`、`AGENTS.md` | Issue 自动开发的资格、认领、范围、测试与停止条件 |

## 使用方式

1. **仓库文件（推荐）**：把模板复制到默认分支的 `.bot/rules/<name>.md`。Bot 从默认分支读取规则，PR 内的改动不会成为当次任务的规则。
2. **项目控制台**：在「生效规则」里把内容保存为控制台覆盖。仓库已经有同名文件时，控制台内容不会悄悄盖过它。
3. **只启用部分场景**：只放需要的那几份。没有仓库文件时使用内置默认；`labels.md` 的第一行 `review_label:` 是 Bot 解析检视标签所必需，覆盖时不要删。

`review_label: bot-reviewed` 只是示例值，按仓库自己的检视标签改。标签名最长 50 个字符，不能有控制字符。

## 与仓库配置的分工

模板只描述**行为与判断**，不定义标签清单、门禁或 CI 阶段：

- 标签名、轴、颜色：仓库的 `LABELING.md`，以及 `config/repositories/<owner>__<repo>.yml` 的 `labels`。
- 必需检查、`ready` 守卫、合并队列：同一份 YAML 的 `gate`、`merge`、`ci`。
- 执行器：控制面的 `ActionExecutor` 尚未接线，当前所有自动化计划都是 dry-run。模板描述的是执行器接线后应遵守的规则。

把规则写进模板不会让 Bot 获得新的权限。标签、评论、检视和分支仍由控制面按仓库策略执行。

## 从 PPMA 到 Bot 的适配

- **PR 检视**：PPMA 的检视器是无工具模型，输出一个严格 JSON；Bot 的检视在项目容器内运行、有文件和命令工具，并由控制面以 COMMENT 发布。因此模板保留严重的「一轮报全、严重度/处置、复审台账、相关性」判断，把输出改成稳定的 Markdown 结构（`F1`、`F2`……），并新增工具使用边界：可以读代码、跑仓库既有测试，不执行 PR 首次引入的脚本，不访问 PR 文本里的 URL，不改工作树。
- **Issue 检视**：PPMA 没有独立的 Issue 检视提示词。本模板从 `LABELING.md` 的规范、`ci_issue_autonomy.py` 的 fail-closed 判定和 `AGENTS.md` 的仓库约束归纳而成，并明确「检视 ≠ 授权改代码」。
- **Issue 自动开发**：PPMA 目前只有只读的候选队列（`.github/workflows/ai-issue-queue.yml`），没有自动编码执行器。模板是执行器接线后的目标行为，包含 PPMA 已写明的认领协议、敏感区域升级、停止条件和禁止事项；不能把现有队列当成已经可以自动开发。
- **打标签**：PPMA 的模型只提议 `type`、`source`、`priority`、`area`、`size`，代码再校验并丢弃清单外的值；已经有 `type/source/priority/agent` 人工标签的 Issue 不覆盖。模板沿用这一点，并显式列出 `blocker`、`priority/critical`、`agent/*`、`pr/*`、`gate/*` 不由模型决定。

## 维护

这些模板是 PPMA 规则的快照，不是共享库。PPMA 的 `LABELING.md` 或 `reviewer.md` 变化后，按上表重新对照一遍再更新；两边的标签值如果分叉，以各自仓库的 manifest 为准，模板不复制具体标签清单。
