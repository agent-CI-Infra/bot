# 角色编排与单对象持久调度

从 #1122 起，固定工作类型（`src/work/*`）与项目级阶段策略 DAG（`StageDefinition`、`required_stages`）已退役。平台统一为 **单对象持久 Manager 线程 + 通用任务引擎（`task.request`）+ 角色池执行 + 独立 QA 门禁**：

1. **单对象持久 Manager 线程（`dispatch_threads`）**：每个根 Issue 或独立 PR 共享一条连续的对象级 Manager 线程（bot 为某个 Issue 创建的 PR 自动归入源 Issue 的线程）。例行事件（如 Issue/PR 打开、PR 推送新提交）先匹配常设规则直接直派或续接，零额外 Manager 模型调用；需要判断的事件（提及 bot、开发标签、检视发布、后续评论、飞书派单等）进入同一对象线程，由 Manager 直接调用受控工具、新建通用任务或续接在途任务。
2. **直派单角色与多角色协作**：
   - 明确归属单一角色的任务（如 `executor_role: "reviewer"` 的 PR/Issue 检视、`executor_role: "test"` 的拉分支跑测试诊断、简单 `dev` 修改）直接由该角色在目标检出工作区执行并提交结构化交付（`post_review`、`submit_report`、`open_pull_request`），不再经过 Task Manager 二次委派或 `workers: ['dev']` 包装。
   - 需要多角色协作的复杂任务由 `manager` 主控通过 `delegate_role` / `delegate_roles` 委派 `dev`、`reviewer`、`test`、`ux` 等角色，并通过 `nominate_delivery` 提名候选交付。
3. **确定性交付门禁与独立 QA**：
   - 代码与 PR 交付（`open_pull_request`）强制经过项目 `test_command` 验证、分支归属与非强推保护、`.github/workflows/` 显式确认，以及全新上下文的独立 `qa` 验收（除非项目配置了 `test_command` 且显式关闭 `pull_request_qa`）。
   - 正式检视交付（`post_review`）强制经过行内 diff 锚点预检（越界行号在任何 GitHub 请求发出前本地拒绝，0 次 GitHub 写入）、轻量守门人 QA 核验、同一总结评论原位更新（`review_summaries`）与已修复行内线程自动关闭。

## 默认角色与恢复

没有自定义角色配置的项目使用内置推荐配置（`RoleDefinitionV2`，见[默认配置](role-pool.md#default-configuration-1068)），仅 `manager` 与 `qa` 为必需角色（`requiredRoles = ['manager', 'qa']`），`coordinator` 等其余角色可按需停用或删除。

每个 `(task, role)` 实例保留角色运行上下文与检查点（`role_instances`、`role_assignments`、`task_runs`），lease_epoch 与运行级令牌 `rrt_…` 仍由控制面统一签发和吊销；角色停用或权限收窄在下一个工具调用前以 `role_authority_revoked` 生效，能力上限下调以 `capability_ceiling_lowered` 暂停并保留进度。

验证：`npm run check`、`BOT_TEST_JOBS=8 npm test`、`npm run test:e2e -- --workers 4`。
