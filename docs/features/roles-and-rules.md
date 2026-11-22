# 角色配置、规则、能力上限与自动合并

launchpad 把单个仓库的行为集中收敛在控制台的项目配置里（不再读取历史 `.bot/` 目录）。本文说明如何通过能力上限、自动合并策略、Manager 流程、角色池、标签、机器配置与仓库 Skill 定制 bot 行为。

## 1. 项目能力上限（最高写闸门）

在「项目设置 → 监听与触发」（`#/projects/<id>/triggers`）设置项目的能力上限（`capability_ceiling`），它是全项目唯一的最高写边界，任何提示词、角色配置或群绑定都不能越过它：

| 档位 | 适用场景 | 允许的 GitHub 写入 |
| --- | --- | --- |
| `read` 只读问答 | 仅在控制台和飞书问答、拉分支跑测试诊断 | 无 |
| `comment` 可评论和打标签（新项目默认） | 自动检视 Issue/PR、打标签、排查并提报 Actions 失败、触发/重跑工作流 | Issues、Pull requests、Actions |
| `develop` 可开发并开 PR | 在 `comment` 基础上允许改代码、推送 `bot/*` 分支并创建/更新 PR | 再加 Contents（合并 PR 另受下方自动合并策略约束） |

调低能力上限不会取消正在运行的任务，需要更高权限的动作会暂停等待权限，调回后可继续。

## 2. 项目自动合并策略

在「项目设置 → 监听与触发」的「自动合并」卡片设置 `auto_merge_policy`，控制 Agent（包括 Manager、工作角色、管理助手与群聊助手）经 `github_write` 合并 PR 或直接写默认分支的权限：

| 档位 | 行为 |
| --- | --- |
| `disallow`（默认） | 任何 PR 都不自行合并；仅当有写权限的维护者在 GitHub 评论、飞书或控制台对话中明确要求合并某条 PR，且控制面核实请求来源后才执行。 |
| `non_bot_only` | bot 自己开的 PR 仍须维护者明确要求；他人 PR 满足仓库规则时可自动合并。 |
| `allow_all` | 包括 bot PR 在内，满足仓库规则时均可自动合并。 |

- 目标分支启用 Merge Queue 时，合并操作自动转为入队（`enqueuePullRequest`）；无法确认是否要求队列时拒绝直合。
- 平台不替代仓库的分支保护和必需检查；若完全不希望 Manager 合并或写分支，可在「角色 → Manager」将 Contents 权限改为只读。
- 人类用户在控制台界面发起的合并（`POST /api/tasks/:id/merge`）走独立校验流程，不受自动合并策略限制。

## 3. Manager 流程、提示词与常设规则

在「项目设置 → 角色 → Manager」管理项目级决策行为：

- **内置六大场景提示词**：未自定义的仓库默认使用 [`docs/prompts/manager-dispatch.md`](../prompts/manager-dispatch.md)，覆盖六大场景：① 代码仓问答与调研、② Issue/PR 日常管理、③ Issue/PR 检视、④ 特性开发与缺陷修复、⑤ 分支/PR 自主测试、⑥ CI 失败与定时主动发现。每章配有可视化 Mermaid 流程图与边界准则。
- **可视化阅读与对话改流程**：提示词卡片默认展示排版与流程图阅读视图，可切换「编辑源码」直接编辑，也可点击「在管理助手中用对话改流程」——助手会先对比给出修改前后两张流程图与变更要点，经你确认后再写回。
- **常设规则（`standing_rules`）**：对固定例行事件（如 Issue/PR 打开直派 `reviewer`、PR 新提交优先续接检视、普通更新并入活跃任务）直接确定性执行，不消耗 Manager 模型调用；常设规则永不直接触发开发。

## 4. 项目角色池与默认配置

在「项目设置 → 角色」配置项目协作角色（默认包含 Manager、Dev、Reviewer、Test、QA 等）：

- **跟随默认与自定义**：未修改过的项目自动跟随当前版本的推荐配置（默认推荐 `Pi` 后端）；一旦保存自定义修改即转为项目独立版本，随时可点击「恢复默认」回到跟随内置默认（历史版本保留可查）。
- **单页表单编辑**：支持按角色配置名称、启停状态、职责说明、完整可编辑提示词、Agent 后端（`pi`、`native`、`process`、`claude_code`、`codex`、`icode`、`container_acp`）、角色覆写模型、技能包、预算（轮次、输出 token、命令超时、累计用量上限）与逐项权限。Manager 与 QA 为必需角色，不可停用或删除。
- **iCode**：Dev、Test、Reviewer、UX 和自定义角色可选，在项目电脑中使用平台模型与用量统计。管理员安装并选用版本后，角色后端列表显示实际选用版本、就绪状态和未就绪原因。Manager、Coordinator、QA 及服务角色的选项中没有 iCode。安装操作见 [安装与维护容器内 ACP 产品](deployment-and-operations.md#安装与维护容器内-acp-产品)。
- **两类细粒度权限**：
  - **平台权限**：`delegation`（委派角色）、`project_tasks`（其他任务读/写）、`project_memory`（项目共享知识读/写）。
  - **GitHub 资源权限**：`github_issues`、`github_pull_requests`、`github_actions`、`github_contents`（无/只读/读写），以及 `github_checks`、`github_statuses`（无/只读）。默认仅 Manager 具备 GitHub 写权限，其余内置角色只读。
  - **内置基础能力**：使用虚拟电脑（文件与命令）是所有工作角色的内置能力，不单独设权限开关。
- **内置可选开发 Skill**：平台随包提供 `roadmap-decomposition`（Manager 默认自动加载）、`layered-ci-gates`（已确认 CI 改动任务自动加载）、`test-driven-development` 与 `systematic-debugging`（可在角色配置中按需绑定给 Dev）。

## 5. 仓库 Skill（`.agents/skills/`）

代码仓库可在基准分支的 `.agents/skills/<名称>/` 目录下放置 `SKILL.md` 及同目录配套文本文件（`references/`、`scripts/`、`assets/` 等），作为本仓专属协作 Skill：

- **可信来源与自动挂载**：任务始终从项目的**基准分支**（未配置时为默认分支）读取 `.agents/skills/` 并按需提供给 Agent，绝不从外部 PR 或未合入分支加载（防止提示词/规则投毒）。
- **限制与边界**：仅加载文本文件，上限 32 份 Skill、256 个文件、单文件 512 KiB、总计 1 MiB；仓库其他业务目录里的 `SKILL.md` 不当作协作 Skill 加载。Skill 只指导工作方法，不能扩大权限或绕过控制面规则。
- **刷新与查看**：在「角色 → Manager」的「仓库 skill」区查看当前已加载列表并手动刷新。

## 6. 标签与虚拟电脑规格

- **项目标签**（「项目设置 → 基本设置 → 标签」）：
  - 检视标签（默认 `bot-reviewed`，可留空不加）
  - 开发标签（默认 `bot-develop`，不可留空；关闭自动开发请调低能力上限）
  - 开发中标签（默认 `bot-developing`，可留空）
  - 需人工标签（默认 `bot-needs-human`，可留空）
  - 已开 PR 标签（固定保留 `bot-developed`）
- **机器配置**（「项目设置 → 机器配置」与「全局设置 → 工作电脑 → 虚拟电脑默认环境」）：
  - **并发任务数**：单台项目电脑允许同时运行的任务数（1–32，留空跟随全局默认 1），项目管理员可自行调整。
  - **统一全局默认环境（超级管理员）**：在「全局设置 → 工作电脑 → 虚拟电脑默认环境」维护全局默认 CPU（0.25–16 核）、内存（256–65536 MiB）、进程数（64–16384）、`/tmp` 大小（16–16384 MiB）、默认外网开关（`egress`）、全局预装 Debian 软件包、非特权初始化脚本（`setup_script`）与非机密环境变量。管理助手电脑、群助手电脑与所有项目电脑共用此全局默认环境与对应预编译镜像。
  - **单项目增量叠加与权限分层**：
    - **项目管理员**可配置本项目的增量 Debian 软件包、增量初始化脚本（`setup_script`）、非机密环境变量与强制重新预编译，并可实时查看构建进度/日志及随时点击 **「停止构建」**；项目配置自动叠加在全局默认之上，无需重复配置全局工具。
    - **超级管理员**额外控制单项目的 CPU、内存、进程数、`/tmp` 大小与外网出口开关（`egress`），并在「全局设置 → 存储」查看和清理无引用预编译镜像缓存。
  - **自动预编译镜像与安全防护**：软件包与初始化脚本在构建期自动预编译为两级内容寻址镜像（全局基座层 + 项目增量层）并缓存复用（重置项目或新建助手容器零重复安装）；`setup_script` 始终以非特权用户（UID `10001`）通过独立 tar 文件运行并安装到 `/opt/preinstalled`（自动加入 `PATH`），绝不以 `root` 执行，构建期按项目生效资源上限执行、全局并发固定为 1、不设超时且失败或手动停止均不中断运行中容器。
  - **预装工具链**：批准的基础镜像自带 Node.js 22、Python 3.11（含 `uv`/Pillow）、ImageMagick、`gcc`/`g++`/`make`、`git`/`gh`、`ripgrep`、`jq`、`sqlite3`，以及 Chromium（`/usr/local/bin/bot-chromium`）和 X11 虚拟桌面套件（`/usr/local/bin/bot-desktop`、`xvfb`、`openbox`、`xdotool`、`scrot`、`ffmpeg`），供 Agent 直接完成界面测试、截图与录屏。
