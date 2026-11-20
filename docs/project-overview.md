# 项目总览与工作台

项目列表的「项目总览」、侧栏项目选择器、项目分类和手机的「当前页面」均可进入 `#/projects/<id>/overview`。原 `basic`、`activity` 和其他项目设置地址保持独立；工作台不混放角色或策略编辑表单，复用独立任务详情页 `#/tasks/<id>`、待处理中心、角色配置及项目设置，不提供绕过授权的快捷写入。

## 角色视图与任务视图

全局顶栏集中展示项目标题、启停标记、GitHub 入口及权限和事件缺口。内容区第一行并列「角色视图」（默认，`#/projects/<id>/overview`）与「任务视图」（`#/projects/<id>/overview/tasks`）切换、实时活跃角色数、与筛选胶囊同口径的 `queued` 排队中任务数（存在 `#283` 等角色槽位任务时另标明等槽位数）、项目并发槽位、「刷新总览」，以及按 `can_write_tasks`（`tasks.write`）门控的「+ 新建任务」入口；视图选择与其控制的内容和操作保持在同一行，窄屏按现有规则换行。底部保留环境记录状态与角色并发配置、待处理中心、项目电脑状态快捷链接。

- **角色视图**：读取 `GET /api/repositories/<id>/role-board`，按启用角色列出职责分类、执行后端与已解析模型名、配置容量上限、正在执行任务芯片（主控已委派子角色活跃执行时标记 `delegated_active`，避免重复计入活跃占用）及可唯一归属的排队队列（含默认主控编排入口、`release.observe` / `release.notes` 单执行器归属及 `#283` `role_capacity` 槽位等待；多候选阶段策略在调度前保持 `unsupported: ['role_queue']` 并明确说明）。
- **任务视图**：读取 `GET /api/tasks?repository_id=<id>&summary=1&flow=1&group=<group>&q=<query>&limit=10&offset=0`，单行呈现任务简介、优先级、关联 `Issue #N` / `PR #N` / `GitHub Actions` 检查简标、状态徽章与内联横向**角色流转框图**（已完成 `✓`、并行观察角色上下并列框、退回/暂停警示、当前运行中脉冲节点、排队 `…` 与虚线门禁 `QA 验收`），支持按简介、任务 ID 或 `#编号` 搜索。

## 我们能干什么 · 实时能力速览（#1123）

两个视图的顶部都有可折叠的「我们能干什么 · 实时能力速览」卡片，读取 `GET /api/repositories/<id>/capabilities`，随总览每 5 秒刷新：在别处调整能力上限、事件开关、角色或群绑定后，下一次刷新就显示新状态，折叠状态在刷新中保持。卡片标题旁列出能力上限、按档位统计的已绑定飞书群数量和启用的定时检查数量；下面是内置 Manager 提示词的六大场景（见[统一任务调度与对象 Manager](workflows.md#内置-manager-提示词六大场景1123)），每项一个状态、一句原因和设置入口，最后一个入口「看流程」打开 Manager 提示词。

状态由 `src/projects/capabilities.ts` 的 `capabilityStates()` 从已有设置投影，不新增存储：

| 状态 | 含义 |
| --- | --- |
| 已开启 | 触发它的事件或请求入口是开的，需要的角色已启用，能力上限够它在 GitHub 上完成 |
| 仅提及触发 | 检视、开发的自动事件（Issue/PR 打开、开发标签、Issue 检视发布）都关着，只有有人 @bot 时才会做 |
| 受能力上限约束 | 有入口，但项目能力上限低于它在 GitHub 上需要的档位（问答、日常管理、检视、测试回帖、CI 处理要「可评论和打标签」，开发要「可开发并开 PR」）|
| 未开启 | 没有任何入口（事件开关、GitHub 提及、相应档位的飞书群、定时检查都没有），需要的角色未启用，或项目已停用 |

飞书群按它实际拥有的权限项算入口（#1156 检视），不按档位名：能读仓库的群算问答入口，有 Issue 或 PR 写入的算日常管理入口，允许创建任务的算测试入口；标题旁的数量仍按档位分（逐项设置的群记为「逐项设置」）。各场景的入口：问答看 Issue/PR 提及和能读仓库的飞书群（群里在只读上限下也能回答）；日常管理看提及和有写入的群；检视看 Issue/PR 打开事件和提及，需要 `reviewer`；开发看开发标签、Issue 检视发布（内置提示词的自主开发规则，不论这次检视是怎么开始的）和 Issue 提及，需要 `dev`；测试看 PR 提及、能创建任务的群和 PR 标签触发，需要 `test`；CI 失败看 Actions 失败事件和启用的 `manager.check` 定时检查。提及开关没有单独保存时跟随 Issue/PR 打开开关；`BOT_MENTION_NAMES=off` 时不算提及入口。

接口要求读项目的权限（`tasks.read`），项目成员都能看。飞书群只按档位给数量，定时检查只给数量，不返回群名和计划内容。

## 任务范围与数据来源

`GET /api/tasks?repository_id=<id>&summary=1&flow=1&group=<group>&limit=10&offset=0` 在同一数据库事务中读取完整范围的统计与当前页。授权、项目、优先级、工作类型与关键词 `q` 条件先应用，再按状态分组，最后分页；不从最近一页或 RoleRun 行数估计任务数。

| group | 口径 |
| --- | --- |
| `active` | running、preparing、implementing、validating、publishing、result_ready；包括结果待发布，不宣称都在执行命令 |
| `queued` | queued，正常等待调度（与顶栏「排队中」计数一致；`retry_wait` 的 `role_capacity` 单独计为等槽位） |
| `attention` | failed、paused、waiting_configuration、waiting_environment、waiting_permission、waiting_publication、needs_replan，与待处理中心复用状态集合 |
| `completed` | succeeded、pr_opened、completed，已结束或已开出 PR 的任务记录 |
| `all` | 当前授权及筛选范围内的全部任务记录，包含历史，不等同于 Issue/PR 或角色运行数 |

`summary` 返回 `all/active/queued/attention` 和 `sampled_at`；带 `flow=1` 时另返回同筛选口径下的 `completed_count`，并为本页任务批量附带 `external`（关联 Issue、PR 与来自 `commit_checks` / `merge_checks` 的 GitHub Actions 检查摘要）和 `role_flow`。原 `attention=1` 接口兼容，未知 `group`/`summary`/`flow` 和冲突筛选返回 400，越权项目仍由服务端拒绝。

总览地址兼容 `overview/tasks`、`overview/queued`、`overview/queued.10` 及 `overview/tasks.queued.10` 等范围和偏移；刷新、返回及分享保留地址。每页 10 项，任务状态变化后本页为空时可返回上一页。点击角色芯片或任务行进入独立路由 `#/tasks/<id>` 查看目标、外部关联、流转框图与两层可折叠执行过程；返回或按 `Escape` 恢复原视图滚动位置与触发控件焦点。

## 刷新与异常

工作台每 5 秒只刷新当前只读投影，后台标签页暂停读取；角色运行耗时、排队等待时长与任务相对更新时间随轮询原地刷新，未变化的行保持原 DOM 节点，焦点、搜索输入和阅读位置不受定时刷新影响；离开页面、切换项目或登录用户后丢弃迟到响应。

角色看板、任务列表与环境记录分别读取、分别记录成功时间。首次失败显示未知，不显示假零；后续失败保留上次成功内容并明确可能过期，可用「刷新总览」恢复。401/403/404 清除当前总览数据并提示重新加载授权，不继续呈现为有效数据。项目「已启用」仅表示配置；环境就绪不代表实时任务或 CI 成功。

## 验证

`test/ut/src/projects/capabilities.test.mjs` 固定六项状态的判定，`test/st/src/projects/capabilities-api.test.mjs` 验证接口随能力上限、事件开关、群绑定和定时检查变化、成员可读而无权者不可读；`test/e2e/projects/project-overview.spec.mjs` 的能力卡用例验证在别处修改后自动刷新、设置链接，以及 1440 / 768 / 390 宽度下三列 / 两列 / 一列且页面不横向滚动。

`test/st/src/projects/project-overview.test.mjs`、`test/st/src/roles/role-board.test.mjs` 与 `test/st/src/tasks/task-detail-flow.test.mjs` 验证分组统计、角色队列归属、并行角色日志隔离、Webhook 检查入库、实时检查同步、保留清理与只读权限边界。`test/e2e/projects/project-overview.spec.mjs` 与 `test/e2e/tasks/task-views-952.spec.mjs` 通过真实控制面 API 与多断点视口验证角色视图、任务流转视图、`#/tasks/<id>` 两层独立折叠、键盘导航、故障恢复及权限撤销。浏览器检查不代替真实设备软键盘或屏幕阅读器验收。
