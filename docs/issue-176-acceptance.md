# Issue #176：统一 Harness 与 Codex ACP 验收

实现基线 `1d811be`，功能提交 `00cf4c6`，公共 session factory 提交 `77ffaa571bda979b02388713247439d0c8bb3913`。本期只对 Codex ACP 做真实执行验证，不声称已验证 Claude 或所有 ACP Agent。

## 接口和可控验证

公共入口 `roleHarness(id).createSession(spec, services)` 返回 run/cancel/close handle，原 adapter 是兼容包装。角色持续状态仍由 role instance 持有，每次 assignment 对应独立 run；ACP 协议客户端不依赖 Task、Role、SQLite 或 Publisher，`roles/acp.ts` 负责接入这些服务。

- `test/harness.test.mjs`：MCP 真正调用 offered tools、结果提交、SQLite 重新打开后的绑定、无恢复能力时重建、角色会话隔离、QA 新会话、公开事件/调用 ID、凭据脱敏、think 过滤、加载回放抑制、取消、进程退出、未提交结果不能成功，以及三个 Harness 的公共 factory 取消契约。这里是协议 fixture，不是模型 E2E。
- `test/roles.test.mjs`：原 Native/Process 上下文、引用交接、候选版本与 QA/残留任务语义继续有效，覆盖退回、证据不足、需要人、带问题通过。
- `test/failure-causes.test.mjs`：新增配置/协议/执行错误进入既有故障分类与提示。
- 上述定向验证合计 **55/55** 通过。全量单测 **773/773** 通过，`npm run check` 通过；功能提交的六项 CI 检查均通过，最终打包/文档提交的状态见 PR #177 检查。
- 本机浏览器回归 **41/41** 通过；首次执行缺少默认缓存路径中的浏览器，改用本机已安装的对应 Playwright Chromium 和依赖库后重跑。没有修改产品测试来绕过此环境问题。

## 真实 Codex 与重启

使用 SDK `2.1.0`、`@agentclientprotocol/codex-acp@2.5.0`、Codex CLI `0.167.0`。真实 worker 模型为 `gpt-6.1-sol`（CLI 默认值，来自会话配置/元数据）；Manager、Process Test 和 QA 继续使用 `deepseek-v4.1-flash-1017`。认证使用专用验收目录中的 Codex 登录状态；未把控制面的 GitHub/DeepSeek 凭据传给 ACP 子进程。

两个不同驱动进程 PID `1562812` / `1563679` 打开同一 SQLite：Dev instance `210a3dc0b232f07db74d0ea88ab5e0fddd7052390c254218`、Codex session `01a1b5cc-238a-7903-8158-b7562300d028` 不变。第一轮通过 MCP 读取事实并提交；驱动退出后第二轮实际 session/load，记录 native_resume，重新读取任务事实并提交。此为仓库内 `scripts/acp-smoke.mjs` 连续两次执行的真实恢复验证，实际事实读取次数从 1 增至 2，不是仅检查数据库字段；重建分支由协议 fixture 覆盖。脚本仅显式运行时访问真实模型，不进入默认测试。

首次真实 smoke 暴露 Codex 把内部评估作为 kind=think 工具事件发送，已按调用 ID 排除该工具及后续更新。正式任务记录检查不包含此类内容；不导出原始 CLI 会话或私有推理。

## OpenToday 连续演进

第一项：[OpenToday #27](https://github.com/zy95-12/OpenToday/issues/27)，task `af1a8d598aabca7a1c2e2b89204ecdf7350db20b0fa29526`。

Dev/Reviewer 使用 Codex ACP，Test 使用 Process，Manager/QA 使用 Native。透明安排审阅检查点，不故意引入产品缺陷：

| 事实引用 | 观察 |
| --- | --- |
| task_history:501 | Dev 提交可见分类标题与 aria-labelledby，首轮组件测试 55 项 |
| task_history:887 | Reviewer 独立检查，指出 DOM 关联断言与全类别点击覆盖两个具体测试缺口 |
| task_history:1260 | 原 Dev instance 恢复原 Codex session，补齐测试，候选更新为 cc697219ca6ae19469e779b67e1c38078517ad2b |
| task_history:1569 | Reviewer 同样恢复自己的独立 session，确认两个缺口已解决 |
| task_history:2124 | Process Test：58 项组件测试、真实 Chrome 19 项断言重复三轮通过；8 个有效变异体被捕获，另一个构造无效明确排除 |
| task_history:2229 | 独立 QA 对精确候选判定 pass |
| task_history:2253 | PR #29 合入，记录 repository_evolved |

第一项 [PR #29](https://github.com/zy95-12/OpenToday/pull/29) 已合入，SHA `8060f37aaa2b30f04f645641a7c09fd16a85b71e`。Dev instance `b4dafecae05b26748d3b803dae57a393ebb2404a47113c16` 两轮不变；Reviewer instance 也独立延续自己的会话。

第二项：[OpenToday #28](https://github.com/zy95-12/OpenToday/issues/28)，task `d989bfac2f6bb14871ec4ab58df3dc7068760036eebc21d2`，从第一项合入 SHA `8060f37...` 开始，运行记录固定 Bot 版本 `77ffaa571bda979b02388713247439d0c8bb3913`。

| 事实引用 | 观察 |
| --- | --- |
| task_history:2702 | Codex Dev 实现稳定挂载的 polite/atomic status 区域；空集合、无匹配、计数与清空恢复均有组件交互测试 |
| task_history:3112 | Codex Test 独立运行 19 项针对性测试、完整 60 项测试及构建，候选 tree 8c38ca1d650cbc3372e5257c2ace2c0a1edaafd4 未变化 |
| task_history:3430 | Codex UX 检视语义与交互证据，无阻断问题；明确未实际运行浏览器或屏幕阅读器 |
| task_history:3573 | Native QA 独立判定精确候选 pass |
| task_history:3597 | PR #30 合入，记录 repository_evolved |

第二项 [PR #30](https://github.com/zy95-12/OpenToday/pull/30) 已合入，SHA `890a22c4b89684737ec27eadc212238b64a19dc4`。Dev 验证旧源码配新交互测试失败 2 项，恢复候选后全套通过；这直接证明新结果通知行为及测试有区分能力。Codex Test/UX 各有独立 session，没有继承 Dev 对话。

两个任务合计实际经 MCP 调用 read_task_record **26 次**，不是只把全文注入 prompt 后声称读取。两个 QA 均为 fresh_evaluation、结果均 pass；带问题通过与退回等分支由明确标注的现有受控测试覆盖，不伪造本次真实 QA 发生过这些结果。task.status 保留交付阶段 pr_opened，合入通过 repository_evolved 和 GitHub merge SHA 单独记录。

验收脚本在第一项通过后自动调用现有 merge API，再启动第二项，第二项通过后同样合入。未绕过必需检查或分支保护，Manager/worker 没有获得合入工具；授权由既有操作人入口记录。验收结束时无 running run。

新增最小复核脚本和部署文档；打包复核发现控制面镜像漏装旧 Process worker，已补 `runner/role-worker.mjs`。本机未运行 Docker daemon，镜像构建由 PR CI 验证，不声称做过本机容器运行验收。

## 复核入口与限制

专用验收数据位于运行主机的 `opentoday-deployment/runtime/176/control.sqlite`，未替换原长期实例数据库。可通过现有任务 trace/source 查询入口、`GET /api/tasks/:id/roles` 或 SQLite 查询角色/session/run/证据关联。完整脱敏事实摘要留在该验收目录，不把凭据、原始模型对话和 CLI 会话文件提交到仓库。

初次创建 OpenToday 验收 issue 时误加了人工 assignee，现有开发准入正确阻止执行；移除 assignee、添加 bot-develop 后重试，失败记录保留，没有绕过 QA 或修改验收结论。第一项在开发期间已启动，随后完成协议/业务分层和公共 factory 的整理；第二项使用冻结后的实现。这是明确的实施/验收顺序，不声称从零干预连续运行。

第一期复用原权限/工作区机制，只配置一个 ACP 启动 profile；不承诺 OS sandbox、完整权限代理、执行中追加输入、跨 Harness 会话格式转换、精确费用或所有故障恢复。无法获得的外部模型用量记 unknown；context usage 不能充当逐请求计费。浏览器检查不等同于真实屏幕阅读器验证。


## 查询示例

以下查询使用上述 task ID，可核对同一个 role 的连续 run 与证据；正式服务中也可使用现有 task trace/source API 和角色 API（仍受项目授权约束）。

```sql
SELECT id, role, harness, role_instance_id, assignment_id, recovery_mode, status
FROM task_runs WHERE task_id = '<task-id>' ORDER BY rowid;
SELECT id, type, run_id, source_ref, caused_by
FROM task_history WHERE task_id = '<task-id>'
  AND type IN ('role_handoff','role_result','harness_event','acceptance_evaluated','repository_evolved')
ORDER BY id;
SELECT role, harness, sequence, harness_state FROM role_instances WHERE task_id = '<task-id>';
```
