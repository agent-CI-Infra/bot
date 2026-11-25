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
- 修改 `.github/workflows/` 的 PR 受安全边界保护：**即使在 `allow_all` 策略下，`github_write` 也永不合并或入队此类 PR**（无法核实 PR 文件列表时按失败关闭拒绝），必须由人类维护者在 GitHub 检视合并。
- 平台不替代仓库的分支保护和必需检查；若完全不希望 Manager 合并或写分支，可在「角色 → Manager」将 Contents 权限改为只读。
- 人类用户在控制台界面发起的合并（`POST /api/tasks/:id/merge`）走独立校验流程，不受自动合并策略限制。

## 3. Manager 流程、提示词与常设规则

在「项目设置 → 角色 → Manager」管理项目级决策行为：

- **内置六大场景提示词**：未自定义的仓库默认使用 [`docs/prompts/manager-dispatch.md`](../prompts/manager-dispatch.md)，覆盖六大场景：① 代码仓问答与调研、② Issue/PR 日常管理、③ Issue/PR 检视、④ 特性开发与缺陷修复、⑤ 分支/PR 自主测试、⑥ CI 失败与定时主动发现。每章配有可视化 Mermaid 流程图与边界准则。
- **可视化阅读与对话改流程**：提示词卡片默认展示排版与流程图阅读视图，可切换「编辑源码」直接编辑，也可点击「在管理助手中用对话改流程」——助手会先讲清变更背景，存在多种可行方案时给出推荐方案、备选与各自优缺点并展示修改前后两张流程图，经你确认后再写回。
- **代码改动的默认流程**：内置引导让会开 PR 的代码改动默认由 Task Manager 团队执行（`dev` → 独立 `reviewer`，行为改动再加 `test` → QA），只改文案、注释或文档的小改动可只走 `dev` → QA，详见 [GitHub 自动化](github-automation.md#开发过程与状态反馈)。平台没有检视阶段门禁：项目阶段策略 `required_stages` 已随工作类型一起退役（#1122），旧配置里的这一项读取时会被忽略。项目想更严格（例如所有代码改动都要 `reviewer`），在 Manager 提示词里写明，Manager 会按它安排，但仍是引导；能强制的只有项目 `test_command`（开 PR 前确定性运行）和独立 QA。
- **常设规则（`standing_rules`）**：对固定例行事件（如 Issue/PR 打开直派 `reviewer`、PR 新提交优先续接检视、普通更新并入活跃任务）直接确定性执行，不消耗 Manager 模型调用；常设规则永不直接触发开发。

## 4. 项目角色池与默认配置

在「项目设置 → 角色」配置项目协作角色（默认角色池为 `Manager`、`Developer`、`Tester`、`Reviewer`、`UX reviewer` 与 `Independent QA`；原独立 `Task Coordinator` 已退役，项目事件分派、任务内多角色编排与跨任务排期/依赖等待统一由 `Manager` 承担）：

- **跟随默认与自定义**：未修改过的项目自动跟随当前版本的推荐配置（默认推荐 `Pi` 后端）；`native` 后端已删除：升级时，自定义配置和任务里冻结的配置快照中选了 `native` 的角色一次性改为 `pi`（角色覆写的模型要求 `text_json` 输出时改为工具调用输出，模型不变），迁移数量写进控制面启动日志；一旦保存自定义修改即转为项目独立版本，随时可点击「恢复默认」回到跟随内置默认（历史版本保留可查）。升级前保存过 `coordinator` 的旧项目配置读取与重存时会自动平滑过滤，历史修订与任务详情快照保持只读可读。
- **单页表单编辑**：支持按角色配置名称、启停状态、职责说明、完整可编辑提示词、Agent 后端（`pi`、`claude_code`、`codex`、`icode`、`workswarm`；Manager 与 QA 固定使用 `pi`，表单只显示不提供选择）、角色覆写模型（所有平台模型统一经控制面透传网关调用，不做跨协议格式转换；各后端支持的模型协议为：`pi`、`icode` 支持 Chat Completions / Responses / Anthropic Messages，`codex` 仅支持 Responses，`claude_code` 仅支持 Anthropic Messages，`workswarm` 支持 Chat Completions / Anthropic Messages；所选模型协议与后端不匹配时在保存和启动阶段直接拒绝并返回 `harness_model_api_unsupported`；Claude Code 与 Codex 还支持切换模型来源为「项目电脑内自行配置（不注入模型配置）」，在「项目设置 → 机器配置」只写维护 `/workspace/home` 下的配置文件）、技能包、预算（轮次、输出 token、命令超时、累计用量上限）与逐项权限。Manager 与 QA 为必需角色，不可停用或删除。
- **Manager 与 QA 固定使用 Pi**：保存时为这两个角色选其他后端会被拒绝（`harness_role_unsupported`），检视、Actions 等入口也不能让它们换到其他后端运行；Dev、Test、Reviewer、UX 和自定义角色可选的后端不变。升级时，自定义配置、任务里冻结的配置快照和角色实例中这两个角色的其他后端一次性改为 `pi`（`migration:1337`，数量写进控制面启动日志）；原先固定的角色模型保留，Pi 不支持它的模型 API 时角色停在「等待配置」，需改选模型。
- **Process 后端已删除**：角色配置提交 `process` 返回 `unknown_role_harness`，后端列表和角色编辑器不再出现 Process。升级时，已保存配置、任务里冻结的配置快照和角色实例中的 `process` 一次性改为 `pi`（`migration:1338`，数量写进控制面启动日志），模型不变；原先要求 `text_json` 输出的角色改为工具调用输出，等待中的任务能继续运行。只有 Process 读取 `text_json`，现在保存 `text_json` 返回 `harness_structured_output_unsupported`。
- **通用容器 ACP 已删除**：ACP 产品只保留 iCode 和 WorkSwarm，后端列表只剩 Pi、Claude Code、Codex、iCode 和 WorkSwarm。角色配置提交 `container_acp` 返回 `unknown_role_harness`。升级时，已保存配置、任务里冻结的配置快照和角色实例中的 `container_acp`（以及更早的 `acp`）一次性改为 `pi`（`migration:1339`，数量写进控制面启动日志），模型不变，等待中的任务能继续运行。
- **WorkSwarm**：Dev、Test、Reviewer、UX 和自定义角色可选，使用项目电脑内的 WorkSwarm、AgentServer 与 Gateway。控制面启动自动安装或由超管在「全局设置 → Agent CLI 工具卷」按 Agent 安装/升级/删除，角色后端列表实时显示版本、安装状态和未就绪原因。模型经控制面统一透传网关转发，任务工具走平台中转，后续会话从任务记录重建。平台不给 WorkSwarm 配置飞书等内置渠道。Gateway 自带调度器在该版本仍会启动，初始任务列表为空，创建接口可用且新建任务默认启用。见 [Agent CLI 工具卷与 WorkSwarm](deployment-and-operations.md#workswarm)。
- **iCode**：Dev、Test、Reviewer、UX 和自定义角色可选，在项目电脑中使用控制面统一透传模型网关与用量统计。控制面启动自动安装或由超管在「全局设置 → Agent CLI 工具卷」按 Agent 安装/升级/删除，角色后端列表显示实际选用版本、就绪状态和未就绪原因。Manager、QA 及服务角色的选项中没有 iCode。见 [Agent CLI 工具卷与 iCode](deployment-and-operations.md#icode)。
- **两类细粒度权限**：
  - **平台权限**：`delegation`（委派角色）、`project_tasks`（同项目其他任务只读查询 `list_project_tasks`/`read_project_task`，读写还可修改任务、声明依赖等待 `wait_for_tasks`、调整优先级与关联任务）、`project_memory`（项目共享知识读/写）。
  - **GitHub 资源权限**：`github_issues`、`github_pull_requests`、`github_actions`、`github_contents`（无/只读/读写），以及 `github_checks`、`github_statuses`（无/只读）。默认仅 Manager 具备 GitHub 写权限，其余内置角色只读。
  - **内置基础能力**：使用虚拟电脑（文件与命令）是所有工作角色的内置能力，不单独设权限开关。全平台角色与助手（含全部 5 种后端 `pi`/`claude_code`/`codex`/`icode`/`workswarm`、项目工作角色、对象 Manager 分派、角色对话、个人管理助手、飞书群聊助手与夜间自动记忆整理）同时默认获得只写工具 `submit_feedback`（append-only），用于反馈真实、可复现的平台问题（Skill、工具、提示词、流程或环境）；该工具不扩大任何业务或 GitHub 权限，也不向任何角色暴露读取、检索、修改或删除意见箱的能力，并受全局意见箱开关与单次运行提交上限约束（在「全局设置 → 意见箱」配置）。
- **内置技能包与默认绑定（`skills/bundles.json`）**：平台内置四个技能包并在项目角色和服务角色中显式可见、可自由解绑或组合：
  - `planning`（`roadmap-decomposition`）：默认绑定给 `Manager`；
  - `ci-gates`（`layered-ci-gates`）：默认绑定给 `Manager`、`Developer`、`Reviewer` 与全局管理助手；
  - `dev-practices`（`test-driven-development`、`systematic-debugging`）：默认绑定给 `Developer`、`Tester`；
  - `feishu-cards`（`feishu-cards`，仅飞书渠道生效）：默认绑定给全局管理助手（Web 控制台自动过滤）与飞书群聊助手。
  - **版本演进策略**：使用默认配置（`follows_default`）的项目自动跟随最新内置 Skill 版本；已保存自定义配置的项目锁定原版本，当镜像带来新版内置 Skill 时，概览与技能包目录给出「有新版本」提示并支持一键升级，绝不静默覆盖。

## 5. 仓库 Skill（`.agents/skills/`）、独立技能库与技能包目录

代码仓库可在基准分支的 `.agents/skills/<名称>/` 目录下放置 `SKILL.md` 及同目录配套文件（`references/`、`scripts/`、`assets/` 等），平台同时提供按项目隔离的**独立 Skill 版本库**（覆盖平台内置 `builtin`、仓库整目录导入 `repository` 与控制台自定义 `console` 三类来源）与**多包组合绑定**：

- **可信来源与自动挂载**：任务与 Manager 事件分派始终从项目的**基准分支**（未配置时为默认分支）读取 `.agents/skills/` 并按需提供给 Agent，非 QA 角色即便显式绑定了技能包也会自动叠加可信基准分支的仓库 Skill（同名以显式绑定优先）；控制面统一物化后通过只读卷 `/opt/bot-skills` 供 Pi、Claude Code、Codex 与 iCode 原生按需读取（WorkSwarm 及无文件读取权限场景保留受控 `read_skill`），绝不从外部 PR 或未合入分支自动加载检出内 Skill（防止提示词/规则投毒）。
- **独立版本库与整目录导入（`#/projects/<id>/roles?view=library`）**：
  - 平台内置 Skill 在控制面启动时自动按内容哈希登记为不可变版本（内容未变不重复出版本，内置升级自动递增版本且历史版本保持可读）。
  - 具备 `roles.edit` 权限的项目管理员可在「角色 → 技能库」或通过接口、管理助手浏览内置/仓库/控制台三类 Skill 及其历史版本与正文，从受信任基准分支整目录导入 `.agents/skills/<名称>/**`（实时导入完整保留 `references/`、`scripts/` Git 可执行位与受控静态资源如常见图片/PDF/字体，缓存模式导入已校验的 UTF-8 文本快照，均记录可信提交 SHA），或按标准 `SKILL.md`（必填合法 YAML frontmatter `name` 与 `description`）新建与迭代项目自有控制台 Skill（自动脱敏已登记凭据，带 `expected_version` 并发校验；被活跃技能包引用时拒绝删除 `409 skill_in_use`）。
- **多技能包目录与角色生效预览（`#/projects/<id>/roles?view=skills`）**：
  - 技能包目录展示每个技能包的来源徽章（`内置` / `内置·已修改` / `项目`）与内置版本升级提示，支持按 `{ skill_id, version }` 直接从技能库挑选和锁定 Skill 版本，也保留对历史 `inline`/`repository` 技能包的只读与编辑兼容（单包聚合上限 64 项 / 512 文件 / 16 MiB，单项目技能包上限统一为 32 个）。
  - 单个角色支持同时多选绑定多个技能包（`skill_bundle_refs`），角色表单内实时展示合并后的**生效技能预览**（含可信 `.agents/skills/` 自动叠加说明）与同名冲突提示；同一技能包内或同一角色跨技能包引用同名 slug 的不同版本/来源时，保存返回 `400 skill_version_conflict`。
- **限制与边界**：独立技能库支持普通 UTF-8 文本与白名单受控静态资源（拒绝符号链接、子模块、路径逃逸、文件/目录前缀冲突及未知二进制），单文件上限 512 KiB、单 Skill 上限 8 MiB 且最多 256 个文件；仓库自动挂载规则缓存（`.agents/skills/`）维持最多 256 个文本文件、单文件 512 KiB、总计 1 MiB 边界，仓库其他业务目录里的 `SKILL.md` 不当作协作 Skill 加载。Skill 只指导工作方法，不能扩大权限或绕过控制面规则。
- **刷新与查看**：在「角色 → Manager」的「仓库 skill」区查看当前已加载列表并手动刷新，在「角色」顶栏进入「技能库」与「技能包目录」，或通过 `/api/repositories/:id/skills*` 及管理助手 `list_skills`/`get_skill`/`list_skill_versions` 与 `skill.save`/`skill.import`/`skill.delete` 管理版本库。

## 6. 标签与虚拟电脑规格

- **项目标签**（「项目设置 → 基本设置 → 标签」）：
  - 检视标签（默认 `bot-reviewed`，可留空不加）
  - 开发标签（默认 `bot-develop`，不可留空；关闭自动开发请调低能力上限）
  - 开发中标签（默认 `bot-developing`，可留空）
  - 需人工标签（默认 `bot-needs-human`，可留空）
  - 已开 PR 标签（固定保留 `bot-developed`）
- **机器配置**（「项目设置 → 机器配置」与「全局设置 → 工作电脑 → 虚拟电脑默认环境」）：
  - **并发任务数**：单台项目电脑允许同时运行的任务数（1–32，留空跟随全局默认 1），项目管理员可自行调整。
  - **统一全局默认环境（超级管理员）**：在「全局设置 → 工作电脑 → 虚拟电脑默认环境」维护全局默认 CPU（0.25–16 核，默认 2 核）、内存（256–65536 MiB，默认 16384 MiB / 16 GB；单容器受宿主机 75% 安全上限约束以预留 25% 给宿主机与控制面，继承默认超限时自动收紧至安全上限，禁止显式保存超过单容器安全上限的值；空闲项目容器仅占用极少量常驻内存，多仓库部署可同时保持就绪）、进程数（64–16384，默认 1024）、项目 `/tmp` 大小（16–65536 MiB，默认 4096 MiB / 4 GB 内存型 `tmpfs`，计入并受限于容器生效内存上限；项目 `/workspace` 为持久化磁盘卷）、默认外网开关（`egress`）、全局预装 Debian 软件包、非特权初始化脚本（`setup_script`）与非机密环境变量。管理助手电脑、群助手电脑与所有项目电脑共用此处全局默认 CPU/内存/进程数、外网开关、预编译镜像与环境变量；助手电脑拥有独立的临时磁盘卷 `/workspace` 与 `/tmp`（各默认 20480 MiB / 20 GB 应用层软限额，随容器生命周期自动创建与回收、不计入容器内存上限，并受宿主机数据盘安全预留门禁与并发忙碌容器 `2×` 安全上限（约 `1.5×` 宿主机内存，严格扣除正在执行任务的忙碌项目电脑后准入排队）突发上限准入保护）。
  - **单项目增量叠加与权限分层**：
    - **项目管理员**可配置本项目的增量 Debian 软件包、增量初始化脚本（`setup_script`）、非机密环境变量与强制重新预编译，并可实时查看构建进度/日志及随时点击 **「停止构建」**；项目配置自动叠加在全局默认之上，无需重复配置全局工具。
    - **超级管理员**额外控制单项目的 CPU、内存、进程数、`/tmp` 大小与外网出口开关（`egress`），并在「全局设置 → 存储」查看和清理无引用预编译镜像缓存。
  - **自动预编译镜像与安全防护**：软件包与初始化脚本在构建期自动预编译为两级内容寻址镜像（全局基座层 + 项目增量层）并缓存复用（重置项目或新建助手容器零重复安装）；`setup_script` 始终以非特权用户（UID `10001`）通过独立 tar 文件运行并安装到 `/opt/preinstalled`（自动加入 `PATH`），绝不以 `root` 执行，构建期按项目生效资源上限执行、全局并发固定为 1、不设超时且失败或手动停止均不中断运行中容器。运行期 `/workspace` 由项目工作卷挂载遮蔽，因此构建期向 `/workspace/home` 写入的内容会输出构建告警并从镜像层清理（保证升级与重置行为一致；持久工具请安装到 `$HOME` 或 `/opt/preinstalled`）。服务升级重启遇到缓存未命中时，项目电脑先以匹配当前基础镜像的镜像快速就绪，同时在后台串行队列异步预编译新镜像；在延后构建排队/进行中以及构建完成等待空闲切换（`image_pending`）期间，项目统一标记 `toolchain_pending` 并暂缓认领新任务，待控制面确认空闲经排他刷新切到新镜像后再恢复认领；若延后构建最终失败或被管理员停止，则自动解除 `toolchain_pending` 门禁并改以 `toolchain_missing` 提示降级运行（任务可继续认领，避免项目饿死，可在下次重启或管理员保存/重建时重试）。
  - **预装工具链**：批准的基础镜像自带 Node.js 22、Python 3.11（含 `uv`/Pillow）、ImageMagick、`gcc`/`g++`/`make`、`git`/`gh`、`ripgrep`、`jq`、`sqlite3`，以及 Chromium（`/usr/local/bin/bot-chromium`）和 X11 虚拟桌面套件（`/usr/local/bin/bot-desktop`、`xvfb`、`openbox`、`xdotool`、`scrot`、`ffmpeg`），供 Agent 直接完成界面测试、截图与录屏。
