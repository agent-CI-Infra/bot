# 用仓库文件调整规则

本文写给安装了这套 bot 的代码仓用户。在仓库默认分支放下面这些文件，就能改变 bot 在这个仓库里检视、打标签、开发和准备虚拟电脑的方式；一份都不放时，bot 使用内置规则。最省事的做法是把内置原文复制到对应路径，改好后合入默认分支。

## 生效顺序

每份规则文件分三层，越往后优先级越高：

1. **内置默认**：打标签、Issue 检视、PR 检视和 Issue 开发四份规则就是 [`docs/prompts/`](prompts/README.md) 下的 Markdown 原文；`.bot/guide.md` 和 `.bot/computer.yaml` 的内置内容在 [`src/rules/service.ts`](../src/rules/service.ts)。
2. **项目控制台**：管理员在项目设置里给这份文件加的控制台覆盖。
3. **仓库文件**：仓库默认分支上的同名文件。

- 文本规则以生效那一层的整份内容为准，不和其他层合并。只想改一句，也要复制整份内置原文再改。`.bot/computer.yaml` 例外，按字段合并，见[机器配置](#机器配置)。
- 仓库里已经有某份文件时，管理员在控制台「添加控制台覆盖」不会悄悄盖过它；控制台内容要等仓库删掉这份文件后才生效。
- 规则从分支读，不从正在处理的 PR 的提交里读。正在检视的 PR 即使改了这些文件，也不会成为这一次任务的规则；改动合入后，之后的任务才按新内容执行。PR 改动 `.bot/` 或 `.agents/skills/` 下的文件（含移动、删除）时，检视总结会写明这些文件改变了 bot 的行为，需要人来决定。
- 各类任务读哪个分支：
  - PR 检视、bot 按检视意见修订自己的 PR：默认分支。
  - Issue 检视、Issue 开发：项目的「基准分支」；管理员没设时就是默认分支。
  - Issue 开发继续修改 bot 已经为它开的 PR：代码检出这条 PR 的 head，规则从这条 PR 的基准分支读。
  - 「规则总览」刷新时：默认分支。
- 模型收到的是每份文件生效后的全文，每份只出现一次，并注明来自哪一层；`.bot/computer.yaml` 只用来配置虚拟电脑，不发给模型。仓库文件生效后，被它盖过的控制台内容（包括早期版本从「项目检视指引」迁移过来的内容）不会再发给模型。
- 每份文件当前哪一层生效，可以请管理员在项目的「规则总览」查看。

## 文件一览

| 路径 | 作用 | 内置原文 | 覆盖方式 |
| --- | --- | --- | --- |
| `.bot/guide.md` | 总体行为指南 | 一段英文通用要求 | 整份替换 |
| `.bot/rules/labels.md` | 检视标签和分类标签 | [`labels.md`](prompts/labels.md) | 整份替换，`review_label` 行见[检视标签](#检视标签) |
| `.bot/rules/issue-review.md` | 新 Issue 的检视与授权意图判断 | [`issue-review.md`](prompts/issue-review.md) | 整份替换 |
| `.bot/rules/pr-review.md` | PR 检视 | [`pr-review.md`](prompts/pr-review.md) | 整份替换 |
| `.bot/rules/issue-development.md` | 按 Issue 改代码、测试并开 PR | [`issue-development.md`](prompts/issue-development.md) | 整份替换，`development_label` 行见[开发标签](#开发标签) |
| `.bot/computer.yaml` | 虚拟电脑的资源、软件包、环境变量和初始化脚本 | 空（`{}`） | 按字段合并进项目的机器配置 |
| `.agents/skills/<名称>/SKILL.md` | 仓库追加的文本 skill | 无 | 追加 |

只有表里这些路径算规则文件。`.agents/skills/` 下各级目录里的 `SKILL.md` 原文会交给模型；只加载文本，不加载 JS 扩展，最多 32 份。

## 通用限制

- 单份文件最多 16384 个 UTF-8 字节（16 KiB），仓库文件和控制台一样按字节计；中文一个字通常占 3 个字节。
- 规则文件是文本，不能含 NUL 字节。
- 规则文件必须是普通文件，不能是符号链接或子模块；`.bot/` 下和 skill 路径上的其他文件也不能是符号链接。
- 出错的文件整份拒绝，不会被截断、跳过或当作不存在：
  - 控制台保存时直接报错，内容不保存：超过 16384 字节或含 NUL 时报 `invalid_rule_content`，标签名不合法时报 `invalid_bot_label`。
  - 仓库文件出错时，管理员刷新「规则总览」会看到错误码。读到出错文件的检视和开发任务在准备阶段停下，此时还没有发评论；任务状态显示「配置待补」，任务详情写明具体错误码：

    | 错误码 | 原因 |
    | --- | --- |
    | `bot_rule_too_large` | 文件超过 16384 字节 |
    | `invalid_rule_content` | 文件含 NUL 字节 |
    | `invalid_bot_label` | `review_label` 或 `development_label` 不合法 |
    | `invalid_bot_computer` | `computer.yaml` 不是映射，或写了不支持的字段 |
    | `invalid_bot_rule_file` | 规则文件是符号链接、子模块等，不是普通文件 |
    | `too_many_bot_skills` | `.agents/skills/` 下的 `SKILL.md` 超过 32 份 |
    | `unsafe_bot_rule` | 检出的代码里 `.bot/` 或 skill 路径上有符号链接 |

    修好对应分支上的文件后，等待中的任务会自动重试，按新内容继续。

## 检视标签

在 `.bot/rules/labels.md` 里单独写一行，从行首开始：

```text
review_label: bot-reviewed
```

- 内置文件第一行就是 `review_label: bot-reviewed`。检视评论发布后，控制面给 Issue 或 PR 加上这个标签。
- 冒号后同一行的其余内容（去掉首尾空白）就是标签名，不会读到下一行。要保留确切字符时写成 JSON 字符串：`review_label: "<name>"`，引号内按 JSON 转义。
- 名字最长 50 个字符，不能有首尾空白（JSON 字符串里也不行），不能有控制字符。
- 文件里出现多行时，采用第一次出现的那一行。
- 去掉这一行、冒号后留空（`review_label:`），或写成 `review_label: ""`，就不再打检视标签。

## 开发标签

在 `.bot/rules/issue-development.md` 里单独写一行，从行首开始；内置文件把它放在第一行：

```text
development_label: bot-develop
```

- 有人（不是 App）给 Issue 加上这个标签，是[自动开发](#自动开发什么时候开始)的条件之一。比较标签名时不区分大小写。
- 写法和限制同检视标签：可以写成 `development_label: "<name>"`；名字最长 50 个字符，不能有首尾空白和控制字符；控制面采用文件里第一次出现的这一行。
- 去掉这一行、冒号后留空（`development_label:`），或写成 `development_label: ""`，标签名仍是 `bot-develop`。不能靠改规则关掉这道要求；不想让 bot 自动开发，请管理员关掉该项目的开发开关。

## 自动开发什么时候开始

自动开发默认关闭。下面几条同时满足时，控制面才创建开发任务：

1. 管理员打开了该项目的开发开关。
2. 新 Issue 的检视评论已发布，并判定 Issue 标题或正文明确要求改代码。
3. 有人（不是 App）给 Issue 加了开发标签；检视前或检视后加都可以。
4. Issue 仍打开，且没有指派人。

控制面发布 PR 前会再查一次标签和指派人，任一条件不再满足就停下，等人重试。这几条由控制面检查，改规则去不掉；`issue-development.md` 里可以再写更严的条件（例如限定 `type`、`size`），由 bot 遵守。

## 机器配置

`.bot/computer.yaml` 是一个 YAML 映射，写出的字段合并进该项目现有的机器配置：同名字段以仓库文件为准，没写的字段保持管理员在「机器配置」里设的值。之后的任务准备时，bot 按合并后的配置调整虚拟电脑。

```yaml
cpus: 2
memory_mb: 4096
packages: [jq]
setup_script: "python3 -m venv /workspace/home/venv"
```

| 字段 | 含义与范围 |
| --- | --- |
| `cpus` | CPU 核数，0.25–16，默认 2 |
| `memory_mb` | 内存（MiB），256–65536，默认 4096 |
| `pids` | 进程数上限，64–16384，默认 1024 |
| `tmp_mb` | `/tmp` 大小（MiB），16–16384，默认 1024 |
| `egress` | 是否允许访问外网，布尔值，默认跟随部署设置 |
| `packages` | 要安装的 Debian 包名，最多 100 个 |
| `env` | 非机密环境变量，最多 64 个；`PATH`、`HOME`、`BOT_*`、`GIT_*` 等保留名会被拒绝 |
| `setup_script` | 初始化脚本，以项目用户身份运行；内容变化后重新运行 |

写了其他字段，整份文件会被拒绝（`invalid_bot_computer`）；超出范围的值不会被调整到范围内，虚拟电脑无法按它配置，任务会停下。旧文件里的 `max_command_minutes` 会被忽略，命令不限时长。这份文件就在仓库里，不要把密钥写进 `env`。
