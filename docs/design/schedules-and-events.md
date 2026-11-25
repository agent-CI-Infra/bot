# 持久化调度与事件通知引擎

本文说明项目定时任务、飞书会话定时任务与事件通知订阅的持久化调度、受控触发契约、预算控制与 Outbox 投递设计。功能与用法见 [定时任务与事件通知订阅](../features/schedules-and-notifications.md)。

## 1. 持久化调度模型（`src/schedules/`）

调度系统由 SQLite 事务、唯一逻辑触发键与租约共同保障幂等性与崩溃恢复：

- **统一时间解析（`nextTime`）**：预览接口与后台 Worker 共用同一计算器，支持标准五段 Cron 与固定周期、IANA 时区和有效期 `[start_at, end_at)`；夏令时跳过不存在的本地时刻、重复时刻仅取首次 UTC 映射。
- **Occurrence 幂等与租约**：
  - 每个逻辑触发点以 `UNIQUE(schedule_id, logical_key)` 持久化为一条 `schedule_occurrences` 记录，保存当时的计划 revision、配置和授权快照；
  - Worker 在 `BEGIN IMMEDIATE` 事务内获取带过期时间的租约执行，崩溃后过期租约由新 Worker 接管，旧租约提交的结果一律拒绝；
  - 遗漏策略默认 `misfire = skip`（60 秒宽限期），可选 `once` 补跑单次，绝不回放历史积压；`run-now` 携带独立幂等键产生实例且不移动周期游标。

## 2. 受控业务触发契约（`ControlledTrigger`）

- **`ScheduleService.register(workflow, handler)`**：所有项目定时处理器必须显式注册（当前生产注册 `manager.check`）。处理器在短同步事务内以 `occurrence_id` / `run_id` 持久化业务运行并返回真实状态，严禁在事务中发网络请求或调用模型。
- **`authorizeAction` 运行期重验**：业务运行在每次模型/工具动作前调用 `ScheduleService.authorizeAction`，复核原始快照、当前授权（个人计划检查本人，项目服务计划检查服务身份 + 显式委托 + 维护人状态）、安装范围与累计预算；任何一项失效即暂停或终止。
- **执行身份解析**：新计划的 `owner_id`/`maintainer_id` 为 `self`、个人计划 `actor_id` 为 `self`、项目计划 `actor_id` 为 `auto` 时，由 `resolveIdentities` 统一展开，`schedule.register` 与 `preview_schedule` 共用。`auto` 指项目第一个仍在维护的服务身份，没有时 `schedule.register` 调用 `createProjectServicePrincipal` 新建；`preview_schedule` 在 SAVEPOINT 内同样新建并完整校验（授权、委托、维护人与执行范围），随后回滚，返回 `service_identity.created_on_register`，不留下任何身份、授权或审计记录。`grants()` 遇到不属于本项目的执行身份报 409 `project_service_identity_missing`（detail 说明 `auto`），与真正停用的服务身份 `service_paused` 区分；用 409 是因为控制台计划面板把 403 当作访问权限失效。
- **防重叠与项目任务衔接**：`manager.check` 到期写入 `schedule.due` 分派事件——计划已有明确指令时直接发起 `task.request` 报告任务，否则交由项目 Manager 决策；同一计划已有未结束到期或运行中任务时新到期记为 `skipped / overlap`。

## 3. 会话定时任务（`src/channels/schedules.ts`）

- 与项目定时任务解耦，挂在飞书私聊或已绑定群上，以 `(schedule_id, logical_key)` 持久化去重在 `channel_schedule_runs` 中。
- 触发时、每次工具调用前和发送前均复核计划存在性、绑定有效性与群围栏/个人授权版本；私聊解绑或群停用即暂停计划，普通瞬时故障不永久停摆（群定时支持 1–30 分钟退避重试，私聊定时等待下一周期）。
- 群定时运行启动即占住该群会话并补核验授权人权限，期间到达的群消息按回合消息并入机制自然衔接，不另起冲突回合。
- 无论群聊还是私聊定时任务，执行回合均禁用 `send_message` 并解除助手电脑排队提示与中途 `stage` 投递通道，确保单次定时运行仅向飞书发送一条完整最终结果（文本或单张卡片），或在允许且无异常时经 `stay_silent` 静默结束。
- 三个入口共用同一套群定时记录与运行路径：控制台 API（`list/create/update/remove`）、群聊助手的 `conversation_schedules`（以绑定主体为作者），以及管理助手的 `group_schedules`（`ChannelSchedules.managed`）。`group_schedules` 只是控制台 API 的对话封装：`groups` 列出当前用户可管理的已启用群（与控制台同一 `manage` 判定，带群名），其余动作直接调用控制台方法并由工具读取当前 revision；私聊定时器不经此工具。仅当当前用户至少能管理一个已绑定群时才提供该工具。

## 4. 事件订阅与通知 Outbox

- **事件源原子落库**：任务失败（`task.failed`）由 SQLite 触发器与业务状态同事务写入事件 Outbox；CI 失败（`ci.failed`）与恢复（`ci.recovered`，仅限此前存在故障）在 Webhook 验签事务内入队。
- **游标推进与聚合静默**：消费事件时，订阅游标推进与通知 Outbox fan-out 同事务提交；同一 run/incident 在聚合窗口内合并，后续恢复消息以 `parent_id` 关联原通知；命中静默时段则顺延至窗口结束（预测接口 `preview_subscription` 复用同一 `quietUntil` 逻辑）。
- **投递状态机与多级预算**：
  - 通知 Worker 认领租约调用 `ChannelAdapter.send`（复用稳定逻辑消息键），区分 `pending`、`sending`、`sent`、`retry`、`unknown`、`dead`、`blocked`。网络中断或租约过期可能已跨过外部提交边界，统一记为 `unknown` 停止自动重发，仅在人工显式确认接受可能重复送达后沿用原幂等键补发。
  - 发送前每次均重验目的地绑定、安装与权限，暂停或更新订阅立即阻断旧 `pending`/`retry` 消息。
  - 预算按 **计划/订阅 → 项目 → 租户** 三层取交集（并发上限、每日次数、通知每分钟速率与单次最长时长），按逻辑日 UTC 桶计量，重试不刷新当日预算。
