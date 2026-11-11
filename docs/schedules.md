# 定时计划、日报与事件订阅

控制台项目「计划与通知」可以查看真实计划列表，预览和保存定时日报、修改计划、暂停、恢复、删除或立即运行一次；管理对话的「快捷操作」保留同一入口。显式表单、管理对话工具和飞书结构化命令都使用 `ManagementService` 的相同查询、命令、幂等回执。授权范围内的请求直接保存，没有审批步骤。

通知目的地在项目面板中直接选择：列表包括本人已绑定且能读取本项目的飞书私聊，以及本人能管理、范围覆盖本项目的群；保存计划或订阅时自动登记（`destination_id` 传 `chat:<会话 id>`，保存后换成登记 id），已有登记继续有效。用提示词驱动、挂在私聊或群上的定时任务见 [会话定时任务](message-channels.md#会话定时任务)。个人飞书绑定和群绑定的完整流程见 [消息渠道与飞书应用机器人](message-channels.md)。登记不表示送达。计划保存和发送前都会重新检查当前目的地、安装、身份和项目权限：私聊目的地核对接收人的读取权限和飞书绑定，群聊目的地核对群绑定仍启用、绑定范围仍覆盖该项目。停用连接、撤销飞书绑定或停用群绑定后，旧 outbox 不能继续发送受保护内容。

## 列表、编辑与回执

计划列表分别展示个人或项目服务身份、IANA 时区、下次触发、最近成功、维护人、状态及阻塞原因。没有记录明确显示尚无，不用零值代替。编辑器按执行内容、身份与维护人、触发时间、目的地和运行限制分区；手机可按步骤切换，时间预览仍调用服务端的真实解析逻辑。未注册处理器不提供立即运行入口。

未保存的计划字段只保留在当前登录内存中。立即运行、暂停或订阅操作不会保存或清空计划草稿；重新显示保留的草稿后，切换计划仍会确认是否丢弃修改。版本变化后保留草稿，重新读取并比较当前计划后，再明确采用当前版本保存。预览失败显示未知，修改时区或表单会立即使旧预览失效；迟到结果不能覆盖新表单或另一项目。

写入结果未知时保留原管理命令与幂等键，禁止另发一个新操作，先用「核对同一次计划操作」读取同一回执。刷新回执不会重新创建计划。完整重载网页会清除本次登录的内存草稿；结果未知时应先在管理审计核对原操作，再决定是否另建计划。

## 身份和交接

个人计划的 actor、owner、maintainer 必须是当前操作者，不能修改为项目服务计划，也不能借用另一个用户的授权。后台工作使用当前 principal 授权，不保存或借用登录 token。失权后计划进入 `paused` 并保存原因。

项目计划选择 #163 已有的项目 service principal；创建和修改始终要求操作者拥有 `grants.manage`，只有 `schedules.manage` 的维护人不能修改。新建时 owner 和维护人都必须是 active 且拥有该项目 `schedules.manage` 的人类。更新时 kind、服务身份、owner 和创建人保持不变，历史 owner 离职或失权不影响已有计划的更新和预览；新的维护人仍须 active 且有项目计划管理权限。预览已有计划需在 query arguments 中携带 `schedule_id`，服务端读取原记录并核对身份引用，未携带时按新建计划检查 owner。维护人下拉只表示可被指定的人，不授予保存权限。

服务身份必须有 project 范围的显式委托，计划保存创建人、owner、维护人、批准人、授权修订及委托快照。执行 Actor 只保留该计划批准的最小能力；日报为 `tasks.read` 和 `schedules.manage`，其他计划（例如 Manager 定时检查 `manager.check`）再增加处理器声明的能力。处理器需要的能力改变、委托撤销或改变、维护人失权、安装不可用都会暂停，不自动扩大能力。执行路径检查当前服务身份、显式委托、维护人及目的地，不依赖创建人或 owner 继续登录。拥有 `grants.manage` 的管理员可显式更换维护人；交接不改变服务身份的已批能力，原 owner 和创建人引用保留用于审计。新建 owner 不合格返回 `schedule_owner_required`，新维护人不合格返回 `schedule_maintainer_required`；历史 owner 已离职不会作为已有计划的拒绝原因。

## 时间和版本

计划包含 tenant/project、身份引用、workflow、参数、IANA 时区、五段 cron 或固定周期、启停、有效期、目的地、预算及 revision。有效期为 `[start_at,end_at)`。cron 使用数字、`*`、列表、范围和步长；周日为 0。日和星期都受限时采用 OR。不接受秒段、命名月份或任意脚本。固定周期从 `start_at` 按真实经过毫秒计算。

预览和 worker 调用同一个 `nextTime`。夏令时不存在的本地时间跳过，重复时间只选择第一次 UTC 对应时刻，即使第二次重复期间才轮询，也不会补出第二次。改变时区或 recurrence 从保存后的新版本开始重新计算未来时点；已产生的 occurrence 保留原始计划、配置和授权快照，不混用新参数。每次修改需要管理服务 `expected_revision`，修改已有计划还需要它的数字 `revision`。

默认 `misfire=skip, grace_ms=60000`：轮询延迟不足一分钟且仍在宽限期时正常触发，超过该范围只记一条 `skipped/misfire`。选择 `once` 时，可以在 `grace_ms` 内补一个持久化游标指向的最早遗漏时点；仍只补一次，然后直接跳到当前时间之后。不会枚举全部历史遗漏。`run-now` 要求计划 active，使用本次命令的持久幂等键产生独立实例，不移动周期游标。重复提交同一命令回读同一个 occurrence；新的显式命令可以产生新的立即运行实例。

## 持久化及业务触发契约

`src/schedules/storage.ts` 增量建立 schedules、notification_subscriptions、schedule_occurrences、schedule_business_runs、notification_outbox、notification_attempts、事件 outbox、预算账本和审计表。SQLite `BEGIN IMMEDIATE`、`UNIQUE(schedule_id,logical_key)` 和稳定 ID 共同约束竞争。occurrence 保存计划 revision、逻辑时间、实际调度时间、授权和配置快照、run_id、租约及累计尝试。有效租约不能被另一个 worker 认领；过期后用同一 ID 恢复。旧 worker 不能用旧租约提交结果。

`ScheduleService.register(workflow, handler)` 是 #168 统一触发接入点。处理器声明 capability，并在短同步事务中用 `ControlledTrigger.occurrence_id/run_id` 持久化唯一业务运行，返回同一个 run_id 和真实业务状态。不能在该事务里发网络请求、执行用户脚本或调用模型。业务运行 queued/running 时 occurrence 为 `dispatched`，只表示运行已被接受，不表示开发或发布完成；业务服务回报最终结果后才写成功及最近成功时间。测试中的假处理器只验证契约，生产没有安装假开发或假发布处理器。

业务运行保存 occurrence_id，在每次工具或模型动作前调用 `ScheduleService.authorizeAction(occurrenceId, capability, usage)`；重启后也使用该入口检查原快照、当前授权、安装、维护归属、运行时长和累计预算。queued/running 业务运行持续占用计划、项目和租户并发名额，不能在 dispatch 返回时就释放；业务服务通过可信的 `settleRun` 回写最终事实。超时运行被标记为 budget_exhausted，之后的工具动作被拒绝。模型动作需要预留调用次数及已知价格的费用上界；不能把未知价格当作零。工作类型的开关仍在 dispatch 时检查，业务服务继续承担它自己的门禁、工具能力、安装权限、角色和成本限制。

`manager.check` 是 Manager 定时检查：到期时成为一个 `schedule.due` 事件交给项目 Manager，`parameters.instruction` 写要检查什么。Manager 按提示词的「定时检查」章节决定是否发起一项只读的普通任务（`task.request`，执行身份是计划的服务主体，合同来自 Manager 的简要说明）；它关着或 Manager 决定不处理时不建任务。这次计划运行在事件交给 Manager 时即算完成，不占用计划的并发名额；分派调用和之后的任务按项目的模型用量计。见[项目 Manager 与工作类型](workflows.md)。

`release.scheduled` 目前明确返回 `unsupported/trigger_handler_not_registered`。#146/#147 可以通过同一注册入口接入；本模块不选择版本、不打标签、不创建 Release，不改变无变更不发布、检查失败不发布、SemVer 升高、手动草稿和定时正式发布的既定边界。

## 日报和订阅口径

首个报告模板 `report.daily` 使用确定性统计，不调用模型。默认窗口是截至逻辑触发时间的过去 24 个真实小时，可以通过 `parameters.window_ms` 调整；这不是隐含的自然日。报告同时打印本地起止时间、IANA 时区和实际小时数。预览中的样例报告截至预览时刻，未来触发列表则使用正式调度算法。

取数来自真实持久记录：窗口内最后更新的任务和 PR 快照、窗口内收到的 GitHub Actions/check 记录，以及当前 Actions 故障报告。故障报告表没有可信观察时间，因此单独标为当前快照，不当作窗口内新故障。每条证据带任务、PR、命令或 GitHub 来源链接。缺少观测明确写缺数；仍未结束的任务不计作成功。这里不是 GitHub 全量实时扫描，也不推断没有记录就表示成功。确定性模板在未配置或不可用模型时仍能输出这些事实，不生成未经证据支持的模型叙述。

支持事件为 `project.daily`、`task.failed`、`ci.failed` 和 `ci.recovered`。取消审批流程后不再有 `approval.waiting`：升级时从已有订阅的事件里移除，只订阅了它的计划改为暂停（原因 `approval_event_retired`）并递增版本。任务失败由数据库触发器与业务状态原子落入事件 outbox；验签接受的 CI 投递与事件记录也在同一事务。没有此前故障的 CI success 不称为恢复。日报完成、业务运行和其直接通知在同一事务提交；日报完成同时产生可订阅事件。

订阅按项目保存事件筛选、目的地、聚合窗口、静默时段、时区、revision 和消费游标。关注多个项目时建立多个独立授权订阅。新订阅从当前游标开始，不推送此前全部历史事件。消费事件时，游标前进和通知 outbox fan-out 在同一事务提交。同一 run/incident 在聚合窗口内合并，后续窗口和恢复消息保存 `parent_id` 关联原通知；静默时段延后发送。暂停、更新或解除订阅会立即阻断旧 pending/retry 消息，发送前仍重检订阅状态和 revision。

## 通知发送及预算

通知 worker 独立认领发送租约，调用 #165 的 `ChannelAdapter.send`，复用稳定逻辑消息键作为渠道幂等键。发送状态包括 pending、sending、sent、retry、unknown、dead 和 blocked；进入队列不能显示为已送达。尝试记录包含 worker、时间、累计次数、授权版本和错误原因。

网络中断、超时或 sending 租约过期可能已跨过外部系统提交边界，因此进入 unknown，不自动重发。可信 transport 可以提供 `reconcile`；默认飞书适配器没有可靠的 UUID 结果查询实现，保留 unknown 供人工核对。人工补发 unknown 必须显式接受可能重复送达，并继续使用原幂等键。这里保证本地逻辑去重，不声称跨系统网络层绝对 exactly-once。

确定的平台拒绝和 429 使用指数退避，读取 Retry-After，并保存连接级限流等待；累计尝试到自动重试上限后进入 dead。计划中的 `manual_retries` 提供独立、有限的人工补发次数，追加尝试而不重置原次数。发送前重新检查安装、当前执行权限、目的地、群数据范围及有效订阅；重试同样不能绕过。

预算按 schedule、project、tenant 逐层取约束，report/development 分开记账。默认计划并发 1，项目 3，租户 10；单次最长 60 秒，计划每天 100 次、项目和租户分别 1000 次；默认模型调用与费用为 0。自动重试默认 3 次、人工补发 1 次；通知默认每计划每分钟 10 条、项目和租户各 30 条。可信部署可通过 `schedule_budgets(scope,scope_id,category,limits)` 配置项目/租户限制，普通管理命令不能改这个表。用量按 UTC 日桶计量，重试继续使用原 occurrence 逻辑日的累计运行/模型/费用账本，跨午夜也不重新获得该实例预算；通知速率按真实当前分钟限制。超预算停止后续动作并保留诊断状态。

## 管理接口和诊断

均通过 `/api/management/query` 或 `/api/management/commands`，沿用 #164 的 target、expected_revision、idempotency_key 和来源会话/消息。

| 类型 | operation |
| --- | --- |
| 预览 | `preview_schedule` |
| 读取 | `list_schedules`、`list_subscriptions`、`list_schedule_destinations` |
| 诊断 | `list_occurrences`、`list_notification_deliveries`、`list_schedule_audit` |
| 计划 | `schedule.register/update/pause/resume/delete/run-now` |
| 订阅 | `notification.register`、`subscription.update/pause/resume/delete` |
| 人工补发 | `notification.retry` |

闭合 Schema 见 `src/schedules/schema.ts`，不能在客户端注入 actor、tenant、能力或 SQL。面板展示时区、未来触发、最近成功、跳过/暂停原因、交接人和处理器是否可用；诊断记录关联事件、occurrence、业务运行和消息。业务侧的异步工作在注册处理器接入前明确不支持。

验证：`npm ci`、`npm run check`、`npm test`；用户场景为 `npx playwright test e2e/schedules.spec.mjs e2e/management.spec.mjs`。浏览器证据输出到工作树忽略目录 `.tmp/schedules-166/`，测试使用独立 SQLite、随机 localhost 端口、本地模型和渠道夹具，不接触部署数据或真实 GitHub 写入。

### 控制台运行与通知记录

计划快捷操作中的记录区将定时运行、通知发送和触发审计分别读取，按页加载真实记录。定时通知的名称、时区、版本、逻辑时间和执行结果来自该次 occurrence 的保存快照，不使用后来修改的计划覆盖历史。事件通知列出保存的聚合事件；订阅版本已经变化时不拿当前配置冒充历史配置。没有记录与读取失败分别显示，刷新失败保留已读记录并标明最新状态未知。

通知详情按来源、逻辑窗口、执行、当前接收范围、发送尝试和当前结果展开。目的地核验只是当前观测，实际发送仍重新授权；失效时显示原因并引导到身份与权限页核验。人工补发沿用原 `notification.retry`、配置版本和回执；结果未知须勾选接受可能重复送达并再次确认。请求结果丢失时保留原幂等键，核对同一次操作；已排队的补发不显示为已经送达。记录查看和补发回执不重绘或清除计划表单。
