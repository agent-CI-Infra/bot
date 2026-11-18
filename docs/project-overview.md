# 项目总览与工作台

项目列表的「项目总览」、侧栏项目选择器、项目分类和手机的「当前页面」均可进入 `#/projects/<id>/overview`。原 `basic`、`activity` 和其他项目设置地址保持独立；工作台不混放角色或策略编辑表单，复用独立任务详情页 `#/tasks/<id>`、待处理中心、角色配置及项目设置，不提供绕过授权的快捷写入。

## 角色视图与任务视图

全局顶栏集中展示项目标题、启停标记、GitHub 入口、权限和事件缺口，以及「角色视图」（默认，`#/projects/<id>/overview`）与「任务视图」（`#/projects/<id>/overview/tasks`）切换，总览内容区不再重复标题条。内容区顶栏展示实时活跃角色数、与筛选胶囊同口径的 `queued` 排队中任务数（存在 `#283` 等角色槽位任务时另标明等槽位数）、项目并发槽位，以及按 `can_write_tasks`（`tasks.write`）门控的「+ 新建任务」入口。底部保留环境记录状态与角色并发配置、待处理中心、项目电脑状态快捷链接。

- **角色视图**：读取 `GET /api/repositories/<id>/role-board`，按启用角色列出职责分类、执行后端与已解析模型名、配置容量上限、正在执行任务芯片（主控已委派子角色活跃执行时标记 `delegated_active`，避免重复计入活跃占用）及可唯一归属的排队队列（含默认主控编排入口、`release.observe` / `release.notes` 单执行器归属及 `#283` `role_capacity` 槽位等待；多候选阶段策略在调度前保持 `unsupported: ['role_queue']` 并明确说明）。
- **任务视图**：读取 `GET /api/tasks?repository_id=<id>&summary=1&flow=1&group=<group>&q=<query>&limit=10&offset=0`，单行呈现任务简介、优先级、关联 `Issue #N` / `PR #N` / `GitHub Actions` 检查简标、状态徽章与内联横向**角色流转框图**（已完成 `✓`、并行观察角色上下并列框、退回/暂停警示、当前运行中脉冲节点、排队 `…` 与虚线门禁 `QA 验收`），支持按简介、任务 ID 或 `#编号` 搜索。

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

`test/project-overview.test.mjs`、`test/role-board.test.mjs` 与 `test/task-detail-flow.test.mjs` 验证分组统计、角色队列归属、并行角色日志隔离、Webhook 检查入库、实时检查同步、保留清理与只读权限边界。`e2e/project-overview.spec.mjs` 与 `e2e/task-views-952.spec.mjs` 通过真实控制面 API 与多断点视口验证角色视图、任务流转视图、`#/tasks/<id>` 两层独立折叠、键盘导航、故障恢复及权限撤销。浏览器检查不代替真实设备软键盘或屏幕阅读器验收。
