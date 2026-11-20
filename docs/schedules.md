# 项目定时任务与事件订阅

定时运行有两种，各管各的（#1027）：

- **项目定时任务**挂在项目上：写清要做什么（指令）、什么时间、是否允许提 Issue，到点生成一个项目任务，由 Manager 安排项目的角色处理。结果留在项目里：任务记录，以及能力上限内的 GitHub 写入，例如提 Issue、评论。它没有飞书目的地，结果不发到飞书。例如「每天 09:00 检查 Nightly 的结果，指标变差就分析并提 Issue」就是一条项目定时任务。
- **会话定时任务**挂在飞书私聊或群上：到点由这个会话自己的助手（私聊的管理助手、群的群聊助手）处理，结果发回这个会话，群助手也可以在群里增删改本群的定时任务，见 [会话定时任务](message-channels.md#会话定时任务)。需要在飞书里定时看到项目情况，例如日报，就在那个私聊或群上挂一条会话定时任务，由会话的助手在自己的权限内去读项目信息。

控制台项目的「定时任务与通知」页管理项目定时任务和事件订阅：查看列表，预览和保存项目定时任务，修改、暂停、恢复、删除或立即运行一次。管理助手不再提供「快捷操作」或内嵌定时任务表单，需要使用这个控制台页面。显式表单、管理助手工具和飞书结构化命令都使用 `ManagementService` 的相同查询、命令、幂等回执。授权范围内的请求直接保存，没有审批步骤。

事件订阅（任务失败、CI 失败与恢复）是事件发生时的通知，不是定时任务，仍然发到飞书：目的地在订阅编辑器中直接选择，列表包括本人已绑定且能读取本项目的飞书私聊，以及本人能管理、范围覆盖本项目的群；保存订阅时自动登记（`destination_id` 传 `chat:<会话 id>`，保存后换成登记 id），已有登记继续有效。个人飞书绑定和群绑定的完整流程见 [消息渠道与飞书应用机器人](message-channels.md)。登记不表示送达。订阅保存和发送前都会重新检查当前目的地、安装、身份和项目权限：私聊目的地核对接收人的读取权限和飞书绑定，群聊目的地核对群绑定仍启用、绑定范围仍覆盖该项目。停用连接、撤销飞书绑定或停用群绑定后，旧 outbox 不能继续发送受保护内容。

## 列表、编辑与回执

列表分别展示个人或项目服务身份、IANA 时区、下次触发、最近成功、维护人、是否允许创建 Issue、状态及阻塞原因。没有记录明确显示尚无，不用零值代替。编辑器按要做什么、身份与维护人、触发时间和运行限制分区；手机可按步骤切换，时间预览仍调用服务端的真实解析逻辑。升级前留下的项目日报计划只在列表里显示（已停用，并写明迁到了哪个会话），不能再编辑、恢复或立即运行。

未保存的计划字段只保留在当前登录内存中。立即运行、暂停或订阅操作不会保存或清空计划草稿；重新显示保留的草稿后，切换计划仍会确认是否丢弃修改。版本变化后保留草稿，重新读取并比较当前计划后，再明确采用当前版本保存。预览失败显示未知，修改时区或表单会立即使旧预览失效；迟到结果不能覆盖新表单或另一项目。

写入结果未知时保留原管理命令与幂等键，禁止另发一个新操作，先用「核对同一次计划操作」读取同一回执。刷新回执不会重新创建计划。完整重载网页会清除本次登录的内存草稿；结果未知时应先在管理审计核对原操作，再决定是否另建计划。

## 身份和交接

个人计划的 actor、owner、maintainer 必须是当前操作者，不能修改为项目服务计划，也不能借用另一个用户的授权。后台工作使用当前 principal 授权，不保存或借用登录 token。失权后计划进入 `paused` 并保存原因。

项目服务计划（项目定时任务选「项目服务计划」时）以项目服务身份（service principal）运行，由项目管理员设置（#851）：创建、修改、暂停和删除要求操作者在该项目有 `config.write`，超级管理员也可以；只有 `schedules.manage` 的维护人不能修改。项目还没有服务身份时，计划面板的「高级身份选项」里提供「创建项目服务身份」（`POST /api/identity/service-principals`）：项目管理员创建的服务身份只拿到创建者本人在该项目拥有的项目能力，属于创建者的委托（`project_delegation`，#847），创建者失去这些能力时委托随之失效，计划在下一次检查时暂停；超级管理员创建的服务身份拿到全部项目能力，不依赖创建者。`list_schedule_destinations` 的 `can_manage_project` 表示调用者能否设置项目计划。新建时 owner 和维护人都必须是 active 且拥有该项目 `schedules.manage` 的人类。更新时 kind、服务身份、owner 和创建人保持不变，历史 owner 离职或失权不影响已有计划的更新和预览；新的维护人仍须 active 且有项目计划管理权限。预览已有计划需在 query arguments 中携带 `schedule_id`，服务端读取原记录并核对身份引用，未携带时按新建计划检查 owner。维护人下拉只表示可被指定的人，不授予保存权限。

服务身份必须有 project 范围的显式委托，计划保存创建人、owner、维护人、批准人、授权修订及委托快照。执行 Actor 只保留该计划批准的最小能力：`tasks.read`、`schedules.manage`，再加处理器声明的能力（项目定时任务 `manager.check` 为 `tasks.write`）。处理器需要的能力改变、委托撤销或改变、维护人失权、安装不可用都会暂停，不自动扩大能力。执行路径检查当前服务身份、显式委托和维护人，不依赖创建人或 owner 继续登录；项目定时任务没有飞书目的地，飞书绑定或群绑定的变化不会暂停它。拥有 `grants.manage` 的管理员可显式更换维护人；交接不改变服务身份的已批能力，原 owner 和创建人引用保留用于审计。新建 owner 不合格返回 `schedule_owner_required`，新维护人不合格返回 `schedule_maintainer_required`；历史 owner 已离职不会作为已有计划的拒绝原因。

## 时间和版本

计划包含 tenant/project、身份引用、workflow、参数、IANA 时区、五段 cron 或固定周期、启停、有效期、预算及 revision，没有目的地字段：带 `destination_id` 的计划不通过参数校验。有效期为 `[start_at,end_at)`。cron 使用数字、`*`、列表、范围和步长；周日为 0。日和星期都受限时采用 OR。不接受秒段、命名月份或任意脚本。固定周期从 `start_at` 按真实经过毫秒计算。

预览和 worker 调用同一个 `nextTime`。夏令时不存在的本地时间跳过，重复时间只选择第一次 UTC 对应时刻，即使第二次重复期间才轮询，也不会补出第二次。改变时区或 recurrence 从保存后的新版本开始重新计算未来时点；已产生的 occurrence 保留原始计划、配置和授权快照，不混用新参数。每次修改需要管理服务 `expected_revision`，修改已有计划还需要它的数字 `revision`。

默认 `misfire=skip, grace_ms=60000`：轮询延迟不足一分钟且仍在宽限期时正常触发，超过该范围只记一条 `skipped/misfire`。选择 `once` 时，可以在 `grace_ms` 内补一个持久化游标指向的最早遗漏时点；仍只补一次，然后直接跳到当前时间之后。不会枚举全部历史遗漏。`run-now` 要求计划 active，使用本次命令的持久幂等键产生独立实例，不移动周期游标。重复提交同一命令回读同一个 occurrence；新的显式命令可以产生新的立即运行实例。

## 持久化及业务触发契约

`src/schedules/storage.ts` 增量建立 schedules、notification_subscriptions、schedule_occurrences、schedule_business_runs、notification_outbox、notification_attempts、事件 outbox、预算账本和审计表。SQLite `BEGIN IMMEDIATE`、`UNIQUE(schedule_id,logical_key)` 和稳定 ID 共同约束竞争。occurrence 保存计划 revision、逻辑时间、实际调度时间、授权和配置快照、run_id、租约及累计尝试。有效租约不能被另一个 worker 认领；过期后用同一 ID 恢复。旧 worker 不能用旧租约提交结果。

`ScheduleService.register(workflow, handler)` 是 #168 统一触发接入点。计划只能保存已注册处理器的 workflow，生产中只注册了项目定时任务 `manager.check`，因此它是唯一的项目定时任务类型；其他 workflow（包括已移除的 `report.daily` 和 `release.scheduled`）保存时返回 `schedule_workflow_unsupported`，旧版本保存的这类计划在下一次检查时以同一原因暂停，也不能恢复或立即运行。处理器声明 capability，并在短同步事务中用 `ControlledTrigger.occurrence_id/run_id` 持久化唯一业务运行，返回同一个 run_id 和真实业务状态。不能在该事务里发网络请求、执行用户脚本或调用模型。业务运行 queued/running 时 occurrence 为 `dispatched`，只表示运行已被接受，不表示开发或发布完成；业务服务回报最终结果后才写成功及最近成功时间。测试中的假处理器只验证契约，生产没有安装假开发或假发布处理器。

业务运行保存 occurrence_id，在每次工具或模型动作前调用 `ScheduleService.authorizeAction(occurrenceId, capability, usage)`；重启后也使用该入口检查原快照、当前授权、安装、维护归属、运行时长和累计预算。queued/running 业务运行持续占用计划、项目和租户并发名额，不能在 dispatch 返回时就释放；业务服务通过可信的 `settleRun` 回写最终事实。超时运行被标记为 budget_exhausted，之后的工具动作被拒绝。模型动作需要预留调用次数及已知价格的费用上界；不能把未知价格当作零。项目启停仍在 dispatch 时检查（#1122 起不再有工作类型开关），业务服务继续承担它自己的门禁、工具能力、安装权限、角色和成本限制。

`manager.check` 即项目定时任务，也是自定义主动任务和预置检查工作流共用的计划类型（#893）。`parameters.instruction` 写要检查什么。`parameters.file_issues` 是计划对 Issue 写入的显式开关，会覆盖执行角色的 GitHub 写权限：为 `true` 时，由此产生的 `task.request` 即使角色没有写权限也可以通过 `github_write` 在本仓库创建或回复 Issue；为 `false` 时即使角色有写权限也被拒绝；未设置时回退到角色策略，角色允许则可以提报或回复。无论哪种选择，写入仍先经过项目能力上限（#850）：上限至少为 `comment` 时才可以提报 Issue、在 Issue 和 PR 上评论（#851），上限为 `read` 时这些写入被拒绝且不会发出。到期时成为 `schedule.due` 事件：计划已写明检查内容时，分派按默认选项直接发起普通任务，不再等待 Manager 另行决定；没有检查内容时，仍交给 Manager，按其提示词处理（内置提示词第 ⑥ 章「CI 失败与定时主动发现」；没有可做的就忽略）。项目可以把 [定时检查的建议文本](schedule-check.md) 自行写进 Manager 提示词；这份建议文本不得登记为内置提示词，以免把管理助手的 `get_effective_config` 撑过单次工具结果的 256 KiB 上限。这项任务的交付终点是报告，不交付代码；它由 Manager 角色执行。任务的执行身份是计划的服务主体或个人计划的操作者。它关着时不建任务。这次计划运行在事件写入分派队列时即算完成，不占用计划的并发名额；分派调用和之后的任务按项目的模型用量计。同一计划若已有尚未结束的到期（含排队中的 occurrence、未决的 `schedule.due`、或尚未结束的检查任务），新的到期会记为 `skipped` / `overlap`，「立即运行一次」则返回 `schedule_occurrence_in_progress`。写入只针对本项目绑定的仓库；日志和审计不保存凭证。任务的结果留在任务记录和 GitHub 上，不发飞书。见[项目 Manager 与工作类型](workflows.md)。

定时发布没有处理器，`release.scheduled` 不能保存。#146/#147 可以通过同一注册入口接入；本模块不选择版本、不打标签、不创建 Release，不改变无变更不发布、检查失败不发布、SemVer 升高、手动草稿和定时正式发布的既定边界。

## 定时触发 workflow

GitHub Actions 的 `schedule` 触发在 GitHub 负载高时会推迟，有时被丢掉，整点是高峰（#1072）。需要按时跑的构建（例如 Nightly）可以改由 bot 触发：不新增处理器，就用一条项目定时任务，指令写明在哪个分支上触发哪个 workflow，例如：

> 在 main 上触发 .github/workflows/nightly.yml（github_write POST /actions/workflows/nightly.yml/dispatches，ref 为 main）。触发前先用 github_read 查看这个 workflow 有没有排队或正在运行的运行，有就不再触发，只在报告里说明；触发后在报告里写上 GitHub 返回的运行链接。

「定时任务与通知」页的「常用模板」里有「使用定时触发 workflow 模板」，填好这条指令和每天 00:00 的时间，改成自己的 workflow 文件名、分支和时间即可；管理助手的提示词里有同一个示例，可以直接在对话里让它建。

- **怎么触发**：Manager 执行这条任务，用 `github_write` 调 `POST /actions/workflows/{文件名或 id}/dispatches`，正文是 `ref` 和可选的 `inputs`。控制面总是带上 `return_run_details: true`，GitHub 返回 200 和这次运行的 `workflow_run_id`、`run_url`、`html_url`，agent 拿到运行链接写进报告，写入账本记下 `html_url`。每次调用单独签发只带 `actions: write` 的令牌，用完撤销；同一个 key 不会触发第二次，和其他写入一样记账本和审计。触发前查运行用 `github_read`（例如 `GET /actions/workflows/nightly.yml/runs?status=in_progress`）：第一次读取时签发只读令牌，范围是执行角色和任务来源都允许读的 GitHub 资源，每次读取重新核对，任务结束时撤销。只读令牌只能由 GitHub App 签发，机器人账号的项目读取时返回 `github_app_required`，agent 在报告里说明没查成。
- **谁可以**：项目能力上限至少「可评论和打标签」（`comment`），执行角色有 Actions 读写（Manager 默认有，见[共用角色权限](role-pool.md#shared-role-permissions)）。GitHub 账户还要有 `actions: write`：GitHub App 缺这项时，项目列表的权限缺口里会列出「触发 Actions 工作流」；机器人账号需要仓库 Write 角色。管理助手和「可评论和打标签」及以上档位的飞书群也可以触发，例如在群里说「跑一下 Nightly」。计划的「创建 Issue 的权限」选「拒绝」时，这条任务不提供 `github_write`，也就不能触发；用于触发的计划保持「跟随角色」（模板的默认值）或「允许」。项目团队执行这类报告任务时，`github_write` 由 Manager 自己调用，只读的工作角色拿不到。
- **平台不预先检查**：workflow 有没有声明 `workflow_dispatch`、`ref` 对不对、有没有运行正在跑，都交给 GitHub 的返回（例如 422）和 agent 自己判断。「触发前先看有没有正在跑的」写在指令里，不是固定流程。

workflow 这边建议同时改造，保留 `schedule` 兜底：加上 `workflow_dispatch`，`concurrency` 设 `cancel-in-progress: false`（定时运行等手动运行跑完，而不是取消它），第一个 job 检查到本次是 `schedule` 触发、并且上一个定时时点以来已经有成功的手动运行时，跳过后面所有 job。完整 YAML 示例在 [`docs/prompts/late-schedules.md`](prompts/late-schedules.md)。

bot 在看 Actions 时（Actions 失败处理、CI 观察、项目定时任务、群聊助手和管理助手的问答）如果发现某个 workflow 的定时运行经常比 cron 晚很多（参考：经常晚 1 小时以上），会在 Issue 里推荐这个方案：先查重，同一个仓库只推荐一次，已经有相关 Issue 就在下面评论；没有 `github_write` 时写在结果或回复里。推荐什么、怎么判断都写在 [`docs/prompts/late-schedules.md`](prompts/late-schedules.md) 里，这份文本原样交给模型，是提示词，不是固定流程。管理助手在接入仓库时看到带 `on.schedule` 的 workflow 也会在对话里提出这一建议，确认后可直接登记定时计划或生成待确认的 workflow 改造任务，见[仓库接入指南](onboarding-guide.md)。

## 升级：项目日报迁到会话定时任务（#1027）

原来的项目计划可以选 `report.daily`（确定性统计的项目日报）并发到飞书私聊或群。这类「项目定时往飞书发」的计划已经移除。升级后控制面启动时把每一条项目日报计划迁一次：

- **迁到哪里**：同一会话上的一条会话定时任务。私聊的定时任务属于当初登记这个目的地的人（必须仍是这个私聊的主人），由他的管理助手执行；群的定时任务由本群的群聊助手执行，作者记为原计划的 owner。名称为「原计划名称（仓库全名）」，时区和 Cron 照搬；固定周期取整到整分钟、至少 5 分钟，从迁移时开始计算。提示词是「汇报项目 X 过去 N 小时的情况：这段时间更新过的任务和它们现在的状态，失败的任务和原因，CI 与 GitHub Actions 的失败……只汇报，不要提 Issue、评论或修改任何东西」，N 取原计划的统计窗口（默认 24 小时）。助手在会话自己的权限内读取，读不到的项目信息不会因为迁移而多出来。启用中的计划迁成启用的定时任务，暂停的迁成暂停的；会话定时任务没有有效期，原计划的结束时间不带过去，在迁移记录里注明。
- **原计划停用**：迁成功的原计划改为暂停（原因 `migrated_to_chat_schedule`），没迁成的也暂停（原因 `daily_report_retired`），版本递增；已删除或已过期的计划不迁（`skipped`）。原计划的保存内容（包括原目的地）不改，仍在列表里可读；还没发出的旧日报通知改为阻止（`schedule_notifications_retired`），不再发送。不会静默删除任何计划。
- **迁移报告**：每条项目日报计划在 `schedule_migrations` 里有一行：原计划、迁移结果（`migrated`、`failed`、`skipped`）、会话类型、新建的会话定时任务、失败原因（例如 `schedule_destination_unavailable` 原目的地登记已不存在、`channel_chat_not_found`、`channel_schedule_owner_unavailable` 私聊主人已不在、`channel_service_binding_missing` 群没有群聊助手绑定）和说明（`interval_rounded`、`end_at_not_carried`）。管理查询 `list_schedule_migrations` 按项目返回，控制台「定时任务与通知」页的「项目日报迁移记录」逐条列出，计划列表的对应计划也写明迁到了哪里；控制面日志每条记一行 `[schedules] daily report plan …`。审计记 `schedule_audit` 的 `migration.<结果>` 和 `channel.schedule.migrated`。有记录的计划不会再迁，重启或多个进程同时启动都不会重复。
- **事件订阅**：`project.daily` 事件只来自项目日报，也一并移除。已有订阅里的这个事件在升级时去掉，只订阅了它的订阅改为暂停（原因 `daily_report_retired`）并递增版本；同时订阅了其他事件的照常运行。

## 事件订阅口径

支持事件为 `task.failed`、`ci.failed` 和 `ci.recovered`。取消审批流程后不再有 `approval.waiting`：升级时从已有订阅的事件里移除，只订阅了它的订阅改为暂停（原因 `approval_event_retired`）并递增版本。任务失败由数据库触发器与业务状态原子落入事件 outbox；验签接受的 CI 投递与事件记录也在同一事务。没有此前故障的 CI success 不称为恢复。

订阅按项目保存事件筛选、目的地、聚合窗口、静默时段、时区、revision 和消费游标。关注多个项目时建立多个独立授权订阅。新订阅从当前游标开始，不推送此前全部历史事件。消费事件时，游标前进和通知 outbox fan-out 在同一事务提交。同一 run/incident 在聚合窗口内合并，后续窗口和恢复消息保存 `parent_id` 关联原通知；静默时段延后发送。暂停、更新或解除订阅会立即阻断旧 pending/retry 消息，发送前仍重检订阅状态和 revision。

## 通知发送及预算

通知只来自事件订阅；项目定时任务不产生通知。通知 worker 独立认领发送租约，调用 #165 的 `ChannelAdapter.send`，复用稳定逻辑消息键作为渠道幂等键。发送状态包括 pending、sending、sent、retry、unknown、dead 和 blocked；进入队列不能显示为已送达。尝试记录包含 worker、时间、累计次数、授权版本和错误原因。

网络中断、超时或 sending 租约过期可能已跨过外部系统提交边界，因此进入 unknown，不自动重发。可信 transport 可以提供 `reconcile`；默认飞书适配器没有可靠的 UUID 结果查询实现，保留 unknown 供人工核对。人工补发 unknown 必须显式接受可能重复送达，并继续使用原幂等键。这里保证本地逻辑去重，不声称跨系统网络层绝对 exactly-once。

确定的平台拒绝和 429 使用指数退避，读取 Retry-After，并保存连接级限流等待；累计尝试到自动重试上限后进入 dead。`manual_retries` 提供独立、有限的人工补发次数，追加尝试而不重置原次数。发送前重新检查安装、当前执行权限、目的地、群数据范围及有效订阅；重试同样不能绕过。

预算按 schedule（或订阅）、project、tenant 逐层取约束，通知（`report`）与计划运行（`development`）分开记账。默认计划并发 1，项目 3，租户 10；单次最长 60 秒，计划每天 100 次、项目和租户分别 1000 次；默认模型调用与费用为 0。自动重试默认 3 次、人工补发 1 次；通知默认每计划每分钟 10 条、项目和租户各 30 条。可信部署可通过 `schedule_budgets(scope,scope_id,category,limits)` 配置项目/租户限制，普通管理命令不能改这个表。用量按 UTC 日桶计量，重试继续使用原 occurrence 逻辑日的累计运行/模型/费用账本，跨午夜也不重新获得该实例预算；通知速率按真实当前分钟限制。超预算停止后续动作并保留诊断状态。

## 管理接口和诊断

均通过 `/api/management/query` 或 `/api/management/commands`，沿用 #164 的 target、expected_revision、idempotency_key 和来源会话/消息。

| 类型 | operation |
| --- | --- |
| 预览 | `preview_schedule` |
| 读取 | `list_schedules`、`list_subscriptions`、`list_schedule_destinations`（订阅目的地、服务身份和维护人） |
| 迁移报告 | `list_schedule_migrations` |
| 诊断 | `list_occurrences`、`list_notification_deliveries`、`list_schedule_audit` |
| 计划 | `schedule.register/update/pause/resume/delete/run-now` |
| 订阅 | `notification.register`、`subscription.update/pause/resume/delete` |
| 人工补发 | `notification.retry` |

闭合 Schema 见 `src/schedules/schema.ts`，不能在客户端注入 actor、tenant、能力或 SQL。面板展示时区、未来触发、最近成功、跳过/暂停原因、交接人和迁移去向；诊断记录关联事件、occurrence、业务运行和消息。

验证：`npm ci`、`npm run check`、`npm test`（`test/st/src/schedules/schedules.test.mjs` 覆盖项目定时任务、事件订阅通知和日报迁移，`test/st/src/channels/channel-schedules.test.mjs` 覆盖会话定时任务）；用户场景为 `npx playwright test -c test/e2e/playwright.config.mjs test/e2e/schedules/schedules.spec.mjs test/e2e/management/management.spec.mjs`。浏览器证据输出到工作树忽略目录 `.tmp/schedules-166/`，测试使用独立 SQLite、随机 localhost 端口、本地模型和渠道夹具，不接触部署数据或真实 GitHub 写入。

### 控制台运行与通知记录

记录区将定时运行、通知发送和触发审计分别读取，按页加载真实记录。升级前留下的项目日报通知仍按该次 occurrence 的保存快照显示名称、时区、版本、逻辑时间和执行结果，标为「项目日报（已停用）」。事件通知列出保存的聚合事件；订阅版本已经变化时不拿当前配置冒充历史配置。没有记录与读取失败分别显示，刷新失败保留已读记录并标明最新状态未知。

通知详情按来源、逻辑窗口、执行、当前接收范围、发送尝试和当前结果展开。目的地核验只是当前观测，实际发送仍重新授权；失效时显示原因并引导到身份与权限页核验。人工补发沿用原 `notification.retry`、配置版本和回执；结果未知须勾选接受可能重复送达并再次确认。请求结果丢失时保留原幂等键，核对同一次操作；已排队的补发不显示为已经送达。记录查看和补发回执不重绘或清除计划表单。

### 事件订阅时间预览

管理查询 `preview_subscription` 接受项目 target 和 `arguments.subscription`，复用保存订阅时的项目范围、时区、静默窗口和目的地校验。返回服务端 `preview_at`、假设事件收到时间 `event_received_at`、聚合结束时间 `aggregation_ends_at` 与最早发送时间 `first_send_at`；静默延后使用发送器相同的 `quietUntil`，包含跨午夜与夏令时处理。暂停草稿的 `first_send_at` 为 null。结果明确标记 `hypothetical: true`：它只说明“若此刻收到一条事件”的时间，不预测未来事件，也不创建订阅、触发、发送或审批记录。

目的地可以直接选择当前有权使用的聊天会话；预览只检查当前可选范围，不登记目的地，实际保存才复用原自动登记逻辑。每条订阅独立授权一个项目；多项目须分别配置。订阅列表的 `editable` 表示当前主体是否为未删除订阅的所有者，其他主体的记录可读而不能借此改写其订阅。最终保存仍核对原订阅版本、项目能力和目的地受众，预览不代替发送时的重新授权。

事件订阅与项目定时任务使用独立的列表和草稿。订阅编辑器展示单个项目范围、事件筛选、聚合窗口、IANA 时区、静默时间和当前接收方，手机分四步编辑。发送时间预览假设服务端此刻收到一条事件，不创建触发或实际通知；暂停订阅不会显示已安排发送。列表区分当前身份可编辑的订阅、其他身份的只读记录和已解除记录，支持分页及准确恢复之前选择的记录。失去项目授权时清空两类表单，普通读取失败保留上次记录和读取时间；失效目的地保留草稿并要求重新核验。版本冲突必须对比并明确采用当前版本，结果未知时复用同一次管理命令与回执。
