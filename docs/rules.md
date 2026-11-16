# 在角色配置里调整行为

本文写给安装了这套 bot 的代码仓的管理员。bot 在一个仓库里怎样检视、打标签、开发和准备虚拟电脑，都在控制台的项目配置里调整，只有这一处来源：

| 要调整的行为 | 在哪里改 | 管理命令 |
| --- | --- | --- |
| 行为指南、检视 Issue、检视 PR、开发与跟进 bot PR、标签用法 | 「角色 → Manager」的 Manager 提示词，对应章节 `guide`、`review.issue`、`review.pr`、`development`、`labels` | `manager.update` |
| 各角色的提示词、模型、权限和预算 | 「角色」页的各个角色 | `roles.update` |
| 检视标签、开发标签的名字 | 「项目设置 → 基本 → 标签」 | `project.update` 的 `review_label`、`development_label` |
| 虚拟电脑的资源、软件包、环境变量和初始化脚本 | 「机器配置」 | `POST /api/environments/:id/configure` |
| 仓库自己的 skill | 仓库默认分支的 `.agents/skills/<名称>/SKILL.md` | 改仓库文件 |

章节没写时用内置原文，就是 [`docs/prompts/`](prompts/README.md) 下的 Markdown，见[项目 Manager 与工作类型](workflows.md)。保存只影响之后新建的任务，已经开始的任务按开始时的配置做完。

## 仓库里的 `.bot/` 文件不再读取

早期版本从仓库默认分支读取 `.bot/guide.md`、`.bot/rules/*.md` 和 `.bot/computer.yaml`，并允许管理员在控制台给它们加「控制台覆盖」。这三层已合并成上面的单一来源（#935）：

- **升级时一次性导入**：升级后第一次启动时，每个已有项目按当时生效的那一层导入。仓库里有的规则文件写进对应的 Manager 章节，章节开头注明「由 `.bot/<文件>` 导入（提交 <SHA>）」；`labels.md` 第一行的 `review_label` 和 `issue-development.md` 第一行的 `development_label` 成为项目设置里的标签名，这一行从章节里去掉；`.bot/computer.yaml` 的字段并入项目的机器配置。导入前后 bot 的行为相同。
- 升级时还没读过仓库规则的项目，在 bot 第一次为它读取仓库时导入一次（任务开始或「刷新默认分支文件」）。升级后新加的项目不导入，从内置原文开始。
- 已经开始的任务保留它读到的规则原文，做完为止。
- 每个项目的导入结果在「角色 → Manager」的「.bot/ 规则文件导入记录」里：导入了哪些文件、写进了哪些章节、标签名、机器配置字段和需要留意的问题，审计记录为 `rules.imported`。
- 之后修改仓库里的 `.bot/` 文件不再影响 bot。仓库还留着这些文件时，项目设置和「角色 → Manager」会提示它们已迁入角色配置、可以删除；PR 改动 `.bot/` 也不再被检视总结标为「改变 bot 行为」。
- 控制台覆盖层和 `rules.update` 管理命令已删除：旧的 `PUT /api/repositories/:id/rules` 和 `rules.update` 返回 `410 rules_update_removed`，说明改用 `manager.update`、`roles.update` 和项目设置；`POST /api/repositories/:id/rules/apply-computer` 同样返回 410。
- 今后不再新增 `.bot/` 覆盖，见[开发约定](development.md)。

## 仓库 skill

`.agents/skills/` 下各级目录里的 `SKILL.md` 是仓库的 skill，bot 像普通 agent 一样读取并遵循：

- 规则从分支读，不从正在处理的 PR 的提交里读：PR 检视和 bot 按检视意见修订自己的 PR 读默认分支；Issue 检视和 Issue 开发读项目的「基准分支」（没设时就是默认分支）；继续修改 bot 已经为 Issue 开的 PR 时读这条 PR 的基准分支。
- agent 先只看到每个 skill 的名称、用途（front matter 的 `description`，没有时取第一行）和路径，做到相应工作时再读全文。只加载文本，不加载 JS 扩展，最多 32 份；单份不限大小。
- PR 改动 `.agents/skills/` 下的文件（含移动、删除）时，检视总结会写明这些文件改变了 bot 的行为，需要人来决定。
- 「角色 → Manager」的「仓库 skill」列出默认分支上的 skill，可以刷新和查看全文。

**边界**：skill 只能指导与本仓库相关的工作，不能扩大权限或改变平台规则。系统提示词写明了这一点；下面这些照常由控制面拒绝并记录，不因 skill 的内容放开：

- 读取或外发凭据、令牌：agent 只拿得到本仓库的只读令牌，没有能写入的 GitHub 凭据和模型凭据；
- 访问其他仓库：GitHub 读写工具只对本项目的仓库生效；
- 绕过平台权限、能力上限或发布通道：评论、标签、分支和 PR 只能经控制面的工具发布，每次写入按角色的 GitHub 写权限和项目能力上限检查，`github_write` 永远不能改 `.github/workflows/`；
- 修改平台配置：任务里没有管理命令。

出错时任务在准备阶段停下，状态显示「配置待补」，原因归为「仓库内容或规则」：

| 错误码 | 原因 |
| --- | --- |
| `invalid_rule_content` | `SKILL.md` 含 NUL 字节 |
| `invalid_skill_file` | `SKILL.md` 是符号链接、子模块等，不是普通文件 |
| `unsafe_skill_file` | 检出的代码里 skill 路径上有符号链接 |
| `too_many_bot_skills` | `.agents/skills/` 下的 `SKILL.md` 超过 32 份 |

修好默认分支上的文件后，等待中的任务会自动重试。规则章节原文和 skill 索引每个任务都直接交给模型，它们和任务摘要合计超过 2 MiB 时，任务停下并报 `agent_context_too_large`。早期版本因 `.bot/` 文件停下的任务（`invalid_bot_label`、`invalid_bot_computer`、`invalid_bot_rule_file`、`unsafe_bot_rule`、`bot_rule_too_large`），点「重试」即可继续。

## 检视标签和开发标签

在「项目设置 → 基本 → 标签」里设置，或用 `project.update` 的 `review_label`、`development_label`：

- **检视标签**：检视评论发布后，控制面给 Issue 或 PR 加上这个标签。默认 `bot-reviewed`；留空表示不加。
- **开发标签**：有人（不是 App）给 Issue 加上这个标签，是[自动开发](#自动开发什么时候开始)的条件之一，比较时不区分大小写。默认 `bot-develop`，不能留空：不想让 bot 自动开发，请把项目的能力上限设在「可开发并开 PR」以下。
- 名字最长 50 个字符，不能有首尾空白和控制字符，不合法时报 `invalid_label`。
- 模型在 `labels` 和 `development` 章节开头读到当前的标签名；agent 不能给 PR 选这两个标签。

## 自动开发什么时候开始

自动开发默认关闭。控制面只检查「人放行了」这件事，能不能开发由项目 Manager 判断：

1. 管理员把该项目的能力上限设为「可开发并开 PR」（`develop`，见[项目能力上限](workflows.md#项目能力上限)）。
2. 有人（不是 App）给打开的 Issue 加了开发标签。由 Actions 失败提报的 Issue 另外要求检视确认是产品缺陷，见 [Actions 失败处理](actions-failures.md)。

满足这两条后，每次有人加上开发标签、以及标签在时每次检视发布，事件都会带着「开发 Issue」选项交给 Manager。Manager 读 Issue、最近一次检视的结论（是否需要改代码、Issue 是否提出了请求、原句、实现目标、是否需要人决定）、指派人和同一 Issue 上已有的任务，决定现在开发，还是不开发并新建一次检视来回复。加标签需要仓库的 triage 或写权限，所以 Manager 把它当作维护者的决定：它能回答「bot 可不可以开始」「Issue 正文里保留或认领的工作要不要交给 bot」，回答不了还没定的行为、范围或设计问题。检视提示词要求回应开发标签时先说能不能开发，不能时写明缺什么、人可以做什么，所以加了标签的人总会在 Issue 上收到回复。

检视没有给出实现目标时，Manager 必须写简要说明（目标和验收标准），开发按它进行。控制面发布 PR 前会再查一次标签，被人去掉就停下。同一 Issue 同时只有一个开发任务；每次重新加标签是一次新的放行，可以在上一次开发结束后再开发。`development` 章节里可以再写更严的条件（例如限定 `type`、`size`），由 bot 遵守。

检视认为 Issue 可以开发、但还没有人放行时，检视评论会写明在等什么：还没有人加开发标签，或者标签是 App 加的。

## bot 开的 PR 怎样跟进修改

bot 开出 PR 后，下面几种情况会让它在同一个分支上继续修改：

- **仓库成员的评论**：在 bot 的 PR 上评论、提交检视或写行内评论（作者是 `OWNER`、`MEMBER`、`COLLABORATOR`），bot 会再检视一次，由它判断这是不是要求修改：只是提问就回答，不改代码；要求修改就照做。人的要求不设次数上限，同一条评论只按一次。要求不清楚、和 Issue 冲突或需要产品决定时，bot 会在评论里列为需要人处理，不动手。
- **其他检视机器人的意见**：其他 App（例如别的代码检视机器人）在 bot 的 PR 上留的意见，bot 会判断合不合理，合理的才改；每个机器人对同一个 PR 最多促成一次修改，避免两个机器人互相循环。
- **bot 自己的检视**：PR 有新提交后，bot 的检视发现的必须修复的问题，在项目的「修订轮数」（默认 3）以内自动修改。上面两种修改不占这个轮数。

每次修改仍要通过项目的测试命令才会推送。这些修改只在 bot 分支上追加提交，不批准、不合并，也不会强推。

合并不在这个流程里，但不是只有人能做：GitHub 上合并 PR 属于 Contents 写，Manager 默认有 Pull Request 和 Contents 写权限，可以经 `github_write` 批准或合并 PR、写分支（包括默认分支）；其他角色、群助手和管理助手按各自的 Contents 写权限。这类写入不经过控制面的合并校验，也不限制目标分支，能不能合入由仓库的分支保护（或规则集）和必需检查决定，所以接入的仓库应打开这两项，见[接入指南](onboarding-guide.md#3-需要你亲手确认的事项)。不希望 Manager 合并时，在「角色 → Manager」把 Contents 改成只读。人在控制台合并走带校验的 `POST /api/tasks/:id/merge`，见[角色池](role-pool.md#authorized-merge)。

## 机器配置

在项目的「机器配置」里设置，保存后按新配置重建虚拟电脑：

| 字段 | 含义与范围 |
| --- | --- |
| `cpus` | CPU 核数，0.25–16，没写时跟随全局默认（内置 2） |
| `memory_mb` | 内存（MiB），256–65536，没写时跟随全局默认（内置 4096） |
| `pids` | 进程数上限，64–16384，没写时跟随全局默认（内置 1024） |
| `tmp_mb` | `/tmp` 大小（MiB），16–16384，没写时跟随全局默认（内置 1024） |
| `egress` | 是否允许访问外网，布尔值，默认跟随部署设置 |
| `packages` | 要安装的 Debian 包名，最多 100 个 |
| `env` | 非机密环境变量，最多 64 个；`PATH`、`HOME`、`BOT_*`、`GIT_*` 等保留名会被拒绝 |
| `setup_script` | 初始化脚本，以项目用户身份运行；内容变化后重新运行 |

环境变量对仓库代码可见，不要填写密钥。
