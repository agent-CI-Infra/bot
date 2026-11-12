# 持久化角色调度

项目 Manager 负责事件分派：每个通过控制面过滤的事件由它决定新建任务、续接已有任务还是不处理（见[项目 Manager 与工作类型](workflows.md)）；工作类型的开关、写入和模型是项目配置；角色配置负责主控、角色职责和执行器；Task 引擎继续负责队列、claim、合同、候选、独立 QA、验收及发布。任务按交付类型和主控的计划在角色之间流转，不用工作流区分执行方式。为任务选择执行顺序时，修改 Manager 提示词、项目主控和阶段策略；提示词只是说明，不会创建角色，也不会授予权限。

新保存的角色配置使用 RoleDefinitionV2，项目主控运行在 Pi。尚未重新保存的旧配置继续使用原 Native 主控。未开启角色协调的入口使用原执行器；没有配置 `required_stages` 时保留最小团队行为，所有业务任务仍须独立 QA。

## 配置阶段

通过既有 `PUT /api/repositories/:id/roles` 保存 `required_stages`，请求仍须带 `expected_revision`。省略该字段保留已有策略，`[]` 表示移除项目新增门禁；已启动任务须在安全检查点显式采用新配置。角色 persona 和 Skill 都不能修改这个策略。

下面的阶段对象适用于代码交付，可放进 `required_stages` 数组：

```json
{
  "stage_id": "review",
  "depends_on": ["dev"],
  "delivery_types": ["code"],
  "role_constraints": {
    "kinds": ["observer"],
    "role_ids": ["reviewer"],
    "capabilities": ["version_binding", "output_validation", "raw_evidence", "fixed_candidate_read", "fresh_context"],
    "independent": true
  },
  "required": true,
  "completion": {"evidence_types": ["tool_observation"], "min_evidence": 1, "no_findings": true},
  "retry": {"max_attempts": 3},
  "budget": {"max_tool_calls": 32, "max_wall_seconds": 900}
}
```

数组须包含所引用的 `dev` 阶段。开发阶段使用 `kinds: ["writer"]`、`role_ids: ["dev"]`、`independent: false`、`completion.no_findings: false`，可以用 `role_result` 作为交付证据。观察阶段通常要求实际 `tool_observation`；也可以选择入口记录的 `execution_evidence`，证据必须属于本次真实运行，报错、超时、截断或非零退出的观察不计入合格证据。`completion.tools` 可进一步限定证据工具，例如测试阶段配置 `["run_command"]`，避免把文件读取当成测试执行。`no_findings: true` 同时要求 findings 和 unknowns 为空，不把摘要中的“通过”作为证明。

串行开发→检视→测试：`dev.depends_on=[]`、`review.depends_on=["dev"]`、`test.depends_on=["review"]`。同候选并行检视/测试：后两者都依赖 `dev`。每种交付最多一个开发阶段，开发阶段没有前置观察阶段；否则开发产生新候选后，旧观察不可能证明新内容。

`delivery_types` 支持 `code`、`artifact`、`no_changes`。开发入口默认为 code，普通请求按其合同 endpoint 判断；代码阶段不会自动应用到报告或 no_changes。观察者必须满足实际运行准入，角色名称或模型不同不能证明独立性。要求 `run_isolation` 的阶段必须使用具备该能力且通过实际隔离验证的后端；不满足时等待配置，不降级到共享环境。

保存时校验唯一 stage_id、依赖存在、适用类型可达、无环、角色可达、必需阶段不依赖可选阶段，以及重试/预算界限。阶段依赖必须对所有适用交付成立。

角色页的「阶段策略」入口用只读依赖层级展示当前草稿；桌面横向分层，手机纵向排列。点击阶段可定位下方同一份表单，编辑适用交付、执行角色、能力、证据、重试和预算。卡片顺序只用于阅读，执行仍由依赖和服务端策略检查决定。依赖错误、重复标识或循环会暂停预览并保留草稿；保存失败会显示服务端配置项并定位对应阶段。重命名阶段会同步其原有引用，不会把短暂重名的其他阶段依赖改接过来。阶段页与概览、角色页共用一份草稿和版本比较，保存仍使用原角色接口，不创建任务或改变授权。空阶段列表表示没有项目新增阶段要求，原有独立验收规则继续生效。

## 主控与执行

主控使用 `read_stage_schedule` 查看下一步；`plan_task` 带合同 `expected_revision` 和修改时的 `expected_plan_revision` 保存计划。主控只能新增/调整可选工作，项目必需阶段必须原样保留。对象键顺序不影响内容比较；查询返回的阶段状态、等待原因、次数和证据等展示字段可随阶段回填，保存时由框架重新计算。重复提交相同计划不新建版本；普通重入保留已规划的可选工作。

`delegate_role` 可以指定 `stage_id`，委派仍只携带角色、目的和任务记录引用。独立只读角色可通过 `delegate_roles` 并行运行，写者不能进入并行批次。工作区用异步上下文隔离各自的读取目标；同一候选只有一个写者，存在观察者时不能启动写者。

计划、assignment 关联和结果分别存于 `task_stage_plans`、`task_stage_assignments`、`task_stage_results`，全部从属于原 task。没有新增任务队列、任务 claim 或业务完成状态。阶段等待/可运行状态从这些记录、原 role_assignments 和 task_runs 重建。

每条结果绑定合同、候选内容、阶段策略/工作类型设置、角色快照、模型/技能/执行器、run、assignment、epoch 和本次实际证据。结果收集、阶段记录和 assignment 完成在同一事务提交；重复相同回执复用记录，冲突回执拒绝。主控不能提交阶段的 passed 字段，框架根据证据数量、能力准入、findings、unknowns 和预算计算结果。

阶段重试数、工具调用和墙钟预算累计包含恢复运行；主控修改可选计划不能重开必需阶段的额度。重试或预算耗尽、阶段策略变化及计划过期使用 `paused` 并保留原错误码，直到人显式重试或采用新配置，引擎不会自动轮询主控。项目停用、任务取消或暂停沿用原撤销机制；缺候选、证据不足及依赖未完成仍由主控安排补齐。已经启动但没有阶段的旧快照也会阻止后来新增的适用必需门禁。采用新合同/策略会创建新计划，保留旧计划和证据作为历史；旧通过结果不会认证新合同或相关门禁策略。

只关闭角色协调（角色配置 `enabled:false`）不会取消任务：持有阶段的任务以 `role_authority_revoked` 暂停，阶段等待原因是 `role_coordination_disabled`。重新开启角色协调后点「重试」继续，不会自动恢复。仓库策略 `policies.enabled=0` 仍按 `repository_policy_disabled` 取消，两者不能混用。

## 恢复与验收

复用原任务 claim 和 RoleRun 协议。lease_epoch 仅由控制面启动 run 时分配；恢复创建新的 task_runs.id，保留 role_instance、assignment 和 resume_from_run_id。工具、事件、检查点、结果继续受 epoch/令牌约束。RunContext 额外记录 stage_id、plan_revision 和 policy_hash；独立 QA 另外绑定 stage_policy_hash，门禁策略变化后旧 QA 判决也不能放行。

进程重启先结束原运行，然后从持久事实继续；已确认结果复用，不根据 CLI 退出或主控文字认定完成。已确认副作用和未确认调用仍使用原回执与恢复对账机制；网络上的未知发布结果仍先查证，不承诺绝对 exactly-once。

发布已开始（存在非 `pending` 的 `github_effects`）后，`adopt-config` 仍拒绝并返回 `task_config_after_publication`。如果此时修改必需阶段导致 `stage_policy_changed` 暂停，应把项目角色配置恢复到任务启动快照对应的阶段定义和角色能力约束，再点「重试」；版本号可以前进，但阶段定义和角色能力约束必须匹配原快照，不能只再次保存已改变的策略。在其他门禁条件未变时，原计划、候选和有效的 fresh QA 证据得以复用，已发送的副作用不会重发，尚未发送的步骤可继续。若还修改了测试命令，或该工作类型的设置、Manager 章节（升级前是工作流），需要另外核对这些门禁条件，本操作不会绕过它们。不要放宽发布后采用配置的限制。

提名、独立验收、记录通过和 Publisher 推进发布的实际写入均检查当前候选的必需阶段。撤回 GitHub 合并队列不受交付门禁阻止，仍需原有权限。阶段齐备不能跳过 fresh QA；主控不能代签 QA。`return` 仍返回原开发实例修复，修复轮可省略已通过写者的 `stage_id`；`insufficient_evidence` 补证，`needs_human` 只处理必要决定或授权。余项生成和发布不确定性沿用原 TaskRecords/Publisher 事务与 outbox 语义。

## 查询与界面范围

既有任务详情的 `record.stage_schedule` 提供当前阶段、输入版本、等待原因、证据和下一步；`GET /api/tasks/:id/roles` 的 `stage_schedule` 另外提供最近 20 个计划和 100 条历史阶段结果，与任务/角色查询共用项目授权。

`task_history` 保留 `stage_plan`、`stage_result`，原 trace 可以继续按引用查证。角色页提供上述项目策略编辑与草稿依赖预览；它不表示某次任务的实时阶段进度，具体运行状态仍以任务记录及角色查询为准。

验证：`npm run check`、`npm test`；重点用例在 `test/role-schedule.test.mjs`，真实 Pi 主控用例在 `test/pi-controller.test.mjs`（先安装 runner 依赖，见开发文档）。
