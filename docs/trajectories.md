# 轨迹文件

Agent 工作的大块正文（模型请求与响应、工具调用与结果、大日志）不再写进 SQLite 的行里，而是按运行追加到 JSONL 轨迹文件。SQLite 只保留状态、计费、每个文件一条入口，以及已有行上指向单条记录的定位串。设计与取舍见 issue #436。

## 文件

文件在数据库同目录的 `trajectories/` 下，随 `bot-data` 卷一起备份；目录 0700、文件 0600，只有服务用户可读。

- 任务的每次运行（`task_runs` 的一行）一个文件：`trajectories/<repository_id>/<task_id>/<run_id>.jsonl`。
- 没有任务的会话轮次（管理助手、群聊助手、项目角色会话）：`trajectories/conversations/<conversation_id>/<turn>.jsonl`。
- Manager 对一个事件的一次分派：`trajectories/<repository_id>/dispatch/<event_id>-<attempt>.jsonl`。
- 文件关闭后不再追加。同一运行之后还有记录（例如运行结束后才返回的调用）时，另开续写文件 `<run_id>.2.jsonl`，依此类推。

文件不加密。写入前照旧脱敏：工具请求和结果经任务的 Redactor，模型请求和响应同样；会话原先用 SecretBox 加密的操作和模型快照，新记录也以明文写进文件。

凭据命中与日志字段过滤分别处理：私钥、已知令牌前缀、JWT、带密码的 URL、明确的密码字段和形似令牌的 Bearer／Basic 或 token 赋值仍会脱敏。普通的 “bearer token”“basic validation”、函数表达式、纯数字配置与格式化 JSON 不因字面关键词被拒绝或改写。管理输入、命令和记忆只根据实际凭据命中拒绝；日志仍可移除私密推理等内部字段，字段过滤和 JSON 格式变化不作为输入敏感的依据。

每行是一个 JSON 对象：

```json
{"seq":1,"at":"2026-11-12T08:00:00.000Z","type":"tool_result","id":"<记录 id>","prev":null,"data":{}}
```

- `type`：`model_request`、`model_response`、`tool_call`、`tool_result`、`log` 或 `event`。
- `id`：已有记录的 id（操作 id、模型请求 id、日志 id）。
- `prev`：上一行（不含换行符）的 sha256，首行为 `null`。整个文件是一条哈希链。
- 模型请求只记相对同一文件上一次请求新增的消息：`data` 为 `{"previous":"<上一请求的定位串>","from":<沿用的消息条数>,"body":{…}}`；上一次请求的消息不是这次的前缀（例如压缩之后），或链已连续 64 次增量时，`data` 为 `{"body":{…完整请求…}}`。

## blob

大块、会被复用的值按内容存一次：`blobs/sha256/<前两位>/<sha256>`（与 `trajectories/` 同在数据库目录，0600），写入时先 `fdatasync` 再原子改名，读取时核对哈希。目前用于任务输入 `tasks.input` 里的 `files`（PR 改动文件及补丁）、`snapshot_files`、`skipped_files`（仓库文件清单）：JSON 超过 2 KiB 时在库里换成 `{"$blob":"<sha256>","bytes":n}`。读这三个键的代码经 `blobValue` 取回原值；其他键和整体拷贝输入再写回的代码不受影响。`trajectory_blobs` 记录每个项目存过的 blob，同一内容多个项目共用一个文件，最后一个项目删除时文件才删除。

## SQLite 里的记录

`trajectory_files` 每个文件一行：打开文件（写第一行）时插入一次，关闭时更新一次，写入行数、字节数、最后一行哈希和按类型的行数与字节。追加行不写数据库。关闭时同一提交把这些数加到 `trajectory_usage`（按项目、按类型的累计），存储页读这张表。

需要单独查找的记录在已有行上存定位串 `<文件 id>:<偏移>:<长度>:<该行 sha256>`，写在本来就要做的那次插入或更新里：

| 表 | 定位串列 | 原正文列现在存什么 |
|---|---|---|
| `task_tools` | `request_ref`、`result_ref`；另有 `request_sha256` 判断重复调用是否同一请求 | 请求和结果的表头 |
| `role_conversation_operations`、`service_role_operations` | 同上 | 请求为 `{}`、结果为 NULL（原先加密，不在库里留任何字段） |
| `model_requests` | `request_ref`、`response_ref` | `request_snapshot`、`response_snapshot` 为 NULL |
| `task_logs` | `content_ref`（只给运行中超过 2 KiB 的日志） | 日志的表头 |

表头只留顶层（以及下一层对象里）不超过 256 字符的标量，日志的 `detail` 保留到 8000 字符（更长时保留首尾），所以按 `type`、`code`、`phase_key`、`workspace_id`、`error`、`tree_sha` 等字段的现有查询照常工作。需要全文的读者统一经 `src/storage/payloads.ts`：有定位串读文件，没有就读旧列，所以迁移前后读到的内容相同。

`task_history` 里由触发器写的 `operation`（`task_tools` 插入和状态变化）和 `runtime_log` 快照随之只含表头和定位串；按 `task_tools:<id>`、`task_logs:<id>`、`task_history:<id>`、`model_requests:<id>:request|response` 解析证据时，从文件重建出与原快照逐字节相同的内容。`task_tools` 的更新触发器只在 `state` 变化时触发。

## 写入顺序、崩溃与校验

先写文件行，再提交指向它的数据库更新；重复调用要重放的工具结果在提交前 `fdatasync`。进程在两者之间停止，文件里多出一行没有任何行引用的记录，读者不会看到它；数据库从不指向没写出的字节。

运行结束（`endRun`）时关闭它的文件；文件 30 分钟没有追加也会关闭；正常停机关闭所有文件。进程异常停止后留下的未关闭入口，由服务开始监听后的后台封口任务处理：截掉不完整的尾行、校验整条链，再写入行数、字节和最后哈希。

读单条记录按定位串读出该行，核对长度、换行和 sha256；读整个文件时校验每行的 `seq`、`prev`，并与关闭时记录的行数、字节和最后哈希比对。被截断报 `trajectory_truncated`，被改动报 `trajectory_corrupt`；证据和控制台显示为不可用的记录。重复调用要重放的结果校验不通过时，任务以 `trajectory_unreadable` 停止，不重新执行这次调用。

删除项目时删除它的轨迹目录和入口，以及它自己的会话轮次文件；一个会话目录可以同时存着多个项目的轮次，只有该会话不再有入口时才删整个目录。清理会话历史时删该会话的轨迹文件。行先删、文件后删，中途停机只会在盘上留下没有入口的字节，不会留下指向已删文件的行；反过来，文件被绕过存储删掉时，启动时和每十分钟一次的孤儿扫描会收走没有文件的活入口并退回用量。按保留期主动删掉文件后的过期入口不算孤儿，扫描既不会删它的行，也不会再扣一次账。控制面的轨迹暂不过期。

## manager 账本

manager 把每次 runner 调用的输入和结果写进自己数据卷里的轨迹文件（`manager/trajectories.mjs`，格式和规则与上文相同）：`trajectories/<repository_id>/<workspace_id>.jsonl`，一个任务工作区一个文件；启动、停止、配置等不属于工作区的调用写进 `trajectories/<repository_id>/project.jsonl`。任务释放工作区（`reap`）时关闭它的文件，30 分钟没有追加也会关闭。

`operations` 每行保留调用的状态、一个小表头（操作 id、generation、请求类型和工作区）、输入的 sha256（`input_sha256`，判断同一操作 id 的重复调用是否同一请求），以及输入和结果的定位串（`input_ref`、`result_ref`），`result` 为 NULL。结果先写入并 `fdatasync`，再提交指向它的更新；重复调用从文件重放结果，校验不通过时以 `operation_record_unreadable` 拒绝，不重新执行。

manager 就绪（恢复完成）之后，后台先封口上次留下的未关闭文件，再按 rowid 分片迁移已结束（`completed`、`interrupted`）的旧行，做法与控制面相同，进度在 manager 数据库的 `settings.trajectory_migration`。仍在运行的调用留给它自己的调用写完。账本行不删除，manager 的轨迹文件也不随项目删除，而是过了保留期后按下文删除。

### 过期删除（#671）

manager 只在同一操作 id 重复调用时读取保存的结果，这只发生在发起调用的任务仍在运行时（runner 的 journal 也覆盖第一天）；控制面在自己的轨迹（`task_tools`）里另存了同样的请求和结果。所以 manager 的轨迹文件是重复数据，过了保留期就在后台删除（`TrajectoryExpiry`，`manager/trajectories.mjs`）：

- **条件**：`trajectory_files` 的入口关闭（`closed_at`）早于保留期，且文件里没有仍在运行（`running`）的调用的输入。保留期默认 2 天，存在 manager 的 `settings.payload_retention`（`{"days":n}`）。仍在运行的调用很少，经部分索引 `operations_running` 读出；关闭的文件不会再追加，所以之后开始的调用不会落进待删的文件。命令运行超过 30 分钟时它的输入文件会因空闲关闭，结果写进续写文件；输入文件删掉后，只要结果文件还在，重复调用照常重放。
- **做法**：按 `closed_at` 顺序、每批最多 20 个文件。一个短事务把这批入口标记为过期（`expired_at`），并在 `trajectory_usage` 里把它们的字节和按类型的行数从 `files`、`records:*` 移到 `expired`；随后在事件循环之外删除文件，再记下 `deleted_at`。批与批之间至少让出与这一批同样长的时间。manager 就绪并封口之后跑一遍，之后每小时一遍；每遍先删掉上次停机前已标记、文件还在的入口。最近一遍的时间、删除的文件数和字节、最近一个错误存在 `settings.trajectory_expiry`。
- **重放**：定位串指向已过期的文件时读出 `trajectory_expired`；重复调用因此得到 `operation_result_expired`（HTTP 410），绝不重新执行，也不返回别的结果。控制面收到后以 `operation_result_expired` 停止任务，下一次尝试用新的操作 id 重新开始。
- **保留什么**：`operations` 的行（状态、表头、输入哈希和定位串）不改：按定位串找出一个文件的所有行需要扫描整个账本，而文件入口只有一行，标记它就让这些定位串都解析为「已过期」。文件入口本身也保留。

删除文件不会让 `manager.sqlite` 变小，那是数据库自己的空闲页，见上文。

## 剩余空间保护

两个服务各自盯着数据所在磁盘的剩余空间（控制面 `src/storage/disk.ts`，manager `manager/disk.mjs`，规则相同），statfs 结果最多缓存 10 秒：

- **保留空间**：总容量的 5% 与 50 GiB 中较小者。剩余低于它时，会写盘的后台任务暂停：控制面的历史数据迁移和 manager 的账本迁移每片开始前检查，暂停时进度里的 `paused` 为 `low_disk`，每分钟再看一次；日志在开始暂停和恢复时各写一行（`[disk] …`）；存储页给超级管理员显示告警。删除过期文件只会腾出空间，照常运行。
- **写满**：迁移写文件、落盘或提交时遇到磁盘已满（`ENOSPC`、`EDQUOT`、SQLite 的 `SQLITE_FULL`），这一片在出错的行之前结束，`paused` 为 `disk_full`，这一行不算失败；有了空间后从游标继续，所以没搬的行都还留着正文。
- **任务开始的底线**：任务准备工作区之前检查控制面数据盘（Compose 部署里项目电脑的工作卷也在这块盘上），剩余低于底线就以 `disk_full` 停在「等待环境」。底线按工作负载定：10 GiB（不足 200 GiB 的盘取总容量的 5%）；本项目最近单个任务在项目电脑上最多占用的空间（一个任务的各个工作区目录之和，取自存储页对项目电脑工作卷的最近一次扫描）的 3 倍更大时取后者；但最多为总容量的 1/4。它和保留空间分开：大盘低于保留空间时后台写入暂停，任务照常开始。控制面重启后，到各电脑的扫描结果读回来之前只按 10 GiB 算。
- **任务运行中**：写盘失败（控制面自己的写入，或 manager 返回的 `disk_full`，HTTP 507）以 `disk_full` 停止，而不是记成随机的运行异常。
- **项目电脑里写满**：任务主要写在项目电脑的工作卷里（检出、装依赖、测试输出），由 runner 自己看卷的剩余空间（`runner/disk.mjs`）。「写满」指剩余低于总容量的 1% 与 1 GiB 中较小者：
  - 会写盘的调用在卷写满时直接拒绝，不执行；调用因为空间不足（`ENOSPC`、`EDQUOT`）失败，或失败时卷已写满，都答 `disk_full`（`{ok:false,error:'disk_full',detail}`），不再答 `runner_operation_failed`。只读的调用（读文件、读 blob、轮询执行进程等）不受影响；给运行中执行进程的回复很小，不拒绝，快结束的任务仍能结束。
  - 命令运行时每秒看一次剩余空间。命令失败时，如果运行中卷曾写满，或输出里说没有空间而卷的剩余低于 10 GiB（不足 200 GiB 的盘为 5%），结果带上 `disk_full`（运行中最少剩余、结束时剩余和总量）；卷还有余量时这类输出只当普通失败，项目自己的测试可能就会打印它。
  - 控制面见到这两种结果，就把任务以 `disk_full` 停在「等待环境」，不把失败交给模型，也不当成测试没过。这次回答和别的结果一样记录下来、重复调用会得到同样回答，所以任务换一次新的尝试（新的操作 ID），和 `operation_result_expired` 一样；发布阶段除外。
  - Pi 执行进程里模型自己的 `run_command`、`write_file` 遇到同样情况时，不再给模型下一轮，执行进程以 `disk_full` 结束；执行进程没来得及写下原因就退出、而卷已写满时，轮询也报 `disk_full`。
- `disk_full` 不消耗自动重试次数，有空间后自动继续。

## 存储页

全局设置的「存储」页通过 `GET /api/storage` 读取后台快照。平台管理员可以查看整机、Launchpad 分类和项目占比，并按已保存的策略发起回收。项目管理员仅能读取有权限项目的轨迹与电脑明细。

- **整机磁盘**使用下面的 Linux 主机采样，汇总已挂载的本地块设备文件系统，每个设备只计一次。空闲包含保留块，已用等于总容量减去空闲。只将设备号和文件系统标识都匹配的 Launchpad 已测文件占用计入对应文件系统，剩余已用包含系统、其他应用及未归类空间。一个设备的两次测量无法对齐时只显示已用和空闲。缺少有效主机采样时标明整机未知，另列控制面数据盘。
- **Launchpad 用量**以已分配磁盘块计量。后台每小时用低优先级 `du` 统计控制面和 manager 的数据库（含 WAL、SHM）、轨迹目录和共享 blob、知识文件及历史、其他数据目录。工作区使用当前代项目电脑最近的完整工作卷扫描（每 6 小时，跳过挂入的知识卷）。其他文件包括工具结果、浏览器证据、镜像仓库缓存、公开看板和已挂载的助手 HOME 与工具目录。标准 `/data` 卷中的其他文件也计入；自定义数据库位置只统计已知路径。数据库内的知识记录已包含在数据库项。未测、旧代、尚未扫完的卷及嵌套文件系统不计入已测合计。主机 Docker 镜像、容器层、构建缓存及未认领卷单独展示。
- **项目空间占比**的分母是同一快照的 Launchpad 已测总量。项目行包括按仓库编号存放的轨迹与知识文件，以及该项目的工作卷。数据库、共享 blob、会话目录和未能归到现有项目的文件归入「公共或未归属」。右侧容量表与饼图共用这组数据。
- **空间回收**按已保存策略执行控制面每日清理、manager 过期正文清理及项目工作区清扫。管理员通过 `POST /api/storage/reclaim` 启动，在 `GET /api/storage/reclaim` 查看运行状态、结果和时间。多次点击共用当前执行，完成后重新采集控制面目录与报告；发生删除的工作卷会撤下旧读数，并由下一轮后台检查重扫。删除文件的字节与数据库内清除的正文字节分开列出，数据库空闲页按原压缩机制归还。Docker 清理仍由主机管理员操作。
- **明细**保留按项目的轨迹、运行日志、工作卷和保留分类，以及数据库空闲页、压缩、迁移进度、Docker 采样和最近回收结果。磁盘低于保留空间会在概要上方告警。manager 读取失败时保留最后一次成功结果并标注时间。

### 接入整机采样

在 Docker 所在的 Linux 主机上运行 `python3 scripts/host-storage.py /path/to/host-metrics`，用主机定时器每 5 分钟运行一次。将 Compose 的 `BOT_HOST_STORAGE_DIR` 设为该目录的绝对路径后重建 bot 服务；控制面只读挂载这一目录。源码部署可直接将同名环境变量指向采样目录。采样文件不含路径和设备名，采用原子替换，主机重启前或超过 15 分钟的采样会失效。

采样需要 Python 3、GNU stat 及 Linux 挂载表。支持有独立空间计数的本地块设备文件系统，排除网络盘、内存文件系统、容器层、loop 镜像和未挂载设备。共享池文件系统（如 Btrfs 或 ZFS）及无法验证的根文件系统会使本次整机采样不可用。默认部署没有宿主机采样时仍可查看 Launchpad、项目和数据盘用量。

## 按天数清理

全局设置「存储」页的「保留天数与项目设置」（`GET`/`PUT /api/storage/retention`，只有超级管理员；保存时校验范围并记入审计 `storage.retention.updated`）把各类数据的保留天数放在一处，存在 `settings.storage_retention`。没设置的类别不过期（#436 的决定），manager 重复正文和任务工作区保持各自的默认值。

| 设置 | 默认 | 范围 | 删除什么，保留什么 |
|---|---|---|---|
| `trajectory_days`，可按项目覆盖（`trajectory_days_by_project`） | 不过期 | 1–3650 天 | 已结束任务和 Manager 分派的轨迹文件，关闭超过天数后删除；文件入口标为过期（`expired_at`），引用它的行都保留，读出「已过期」（`trajectory_expired`）。同一次运行的各类记录在同一个文件里，所以按文件整体删除，不按记录类型。任务还没结束（等待重试、有后续任务）时不删；会话的轨迹不删，继续对话时会读之前的轮次。 |
| `manager_payload_days` | 2 天 | 1–365 天 | manager 的重复正文（见上文过期删除），保存时和每日清理时同步给 manager（`PUT /v1/storage/retention`）。 |
| `workspace_finished_days`、`workspace_failed_days` | 1 天、7 天 | 1–365 天 | 项目电脑上任务结束、失败后的工作区（[部署：任务工作区清理](deployment.md#任务工作区清理)），每小时的工作区清理按它们执行。 |
| `webhook_payload_days` | 不过期 | 7–3650 天 | Webhook 投递正文清空，投递记录、状态和请求头保留，另存正文的 sha256、字节数和删除时间；外部执行端还没送达的投递不清。 |

群聊记录在频道控制台按群设置保留天数，这里只汇总。blob 随项目删除；判断某个 blob 是否还被引用要读遍任务输入（每行约 1 MB），所以不做按天回收。

每日清理在控制面启动 10 分钟后第一次运行，之后每天一次：先把 manager 的天数同步过去，再按项目、按 `closed_at` 顺序分批删除过期的轨迹文件（每批 50 个，批间暂停；先标记入口、移出计数到 `trajectory_usage` 的 `expired`，再在事件循环之外删文件；停机前已标记、文件还在的，下次先删），随后按 `received_at` 顺序分批清空 Webhook 正文（游标存在 `settings.retention_cleanup`，处理过的行不再读），最后分批删除 `updated_at` 超过 30 天的提交检查状态缓存行（`commit_checks`，每批最多 500 条；Webhook 接收检查事件时也会每 10 分钟顺带裁剪一次超龄行）。每次删了多少文件、多少字节以及裁剪了多少条提交检查记录记在 `settings.retention_cleanup`，存储页显示。一个文件或一行处理失败（例如文件删不掉）只记入失败数和最近一个错误，留到下次，不影响其他项目和其他类别；外部执行端还没送达而保留的投递正文，其 id 记下来，每次先看一遍，送达后就清。停机时等正在进行的清理在下一步结束。删除项目时，它已过期文件的计数从 `expired` 一并去掉，项目的计数行全部删除。任务再用到已删除的工具调用结果时，以 `operation_result_expired` 换新的尝试。

## 历史数据迁移

升级前写进行里的正文由后台迁移搬进文件（`src/storage/migration.ts`）。控制面开始监听、封口任务跑完之后才启动，就绪不等它；启动阶段只加列、重建触发器，不读大表的行。

- 依次处理 `task_tools`、`role_conversation_operations`、`service_role_operations`、`model_requests`、`task_logs`、`tasks`（输入里的文件清单改存 blob）、`task_history`，每张表按 rowid 顺序走。
- 每一片先读行，读满约 25 ms（单行再大也只多读这一行）就停；把这些行的正文追加到文件，等文件 `fdatasync` 落盘（不占事件循环），按定位串逐条读回核对哈希，然后在一个短事务里把这些行的正文列换成表头和定位串、并保存游标。两片之间至少让出与这一片同样长的时间。
- 游标、已迁移/跳过/失败条数、字节数和最后一个错误保存在 `settings` 的 `trajectory_migration`；重启后从游标继续，已迁移的行不会再搬一次。剩余量按 `max(rowid)` 与游标之差估计，不数行。
- 只迁移已结束的记录：`task_tools` 等只搬 `completed` 的调用（仍在 `pending` 的可能正被执行），`model_requests` 只搬已 `finished_at` 的请求，`task_logs` 只搬超过 2 KiB 的 JSON 日志，`task_history` 只搬超过 2 KiB 的 `operation`、`runtime_log` 快照。
- 记录写进任务的 `legacy.jsonl`（`trajectories/<repository_id>/<task_id>/legacy.jsonl`，原来的运行已无从得知）或会话的 `conversations/<conversation_id>/legacy.jsonl`；会话里原先加密的正文以明文写入，库里不再留任何字段。模型快照原样保存为 `{"$snapshot":…}`，`task_history` 快照原样保存，行里留 `{"$trajectory":"<定位串>","characters":<原长度>}`。
- 一轮走完后每 10 分钟再看一次新行（没有运行可归属、仍写在行里的记录）。

迁移不缩小 SQLite 文件：清出的页留在空闲页里给新行复用。空闲页还给磁盘由服务启动时的压缩和之后的增量回收完成，见[部署：启动时压缩数据库](deployment.md#启动时压缩数据库)。

## 完整工具结果与模型分页

所有控制面工具共用结果预算：小结果直接返回，超过本批预算或需要从较早上下文省略的结果，先脱敏保存完整内容，再返回首尾预览及 `file`、`bytes`、`encoding`、`expires_at`。非命令结果按 JSON 保存；命令输出保持原始 UTF-8 文本。`github_read` 超过 2 MiB 也使用结果文件，不再要求重新缩小查询。`task_history`、模型轨迹和工具观察只记录模型收到的预览与句柄，不内联已转成文件的完整内容。写入失败返回 `tool_result_storage_failed`，不提供不可读的句柄。

命令 stdout 与 stderr 合计超过 1 MiB 后继续运行，不因输出量而终止。runner 保留固定大小的首尾缓冲，并将完整脱敏输出流式写入临时 journal；控制面按可信操作 ID 复制到统一结果存储。本地 Pi 同样把 journal 分页交给控制面，不再生成绑定子会话的另一套结果文件。runner 的原始 journal 仍由已有工作区清理策略回收。

`read_tool_result({file, position, length})` 不重复原操作，`position`、`length` 单位为 UTF-8 字节，默认 16384、最多 65536。按 `next_position` 继续直到 `eof`；拆开字符的非法位置返回范围错误。所有角色都可使用它，无须命令权限，也不会为读取而启动电脑。

结果文件属于执行电脑：项目电脑按项目，助手电脑按群或本人（同一人的飞书私信与控制台共用），隔离运行容器按本次运行。文件跨任务、角色和回合可读，其他电脑归属不可读；现有授权检查继续生效。编辑或撤回消息不使已有文件失效，模型通过 `source_updates` 判断是否重新核实。

Compose 使用独立的 `tool-results` 磁盘卷，控制面在 `/tool-results/<电脑归属>/<id>.utf8` 写入，不属于轨迹备份。默认生成后 24 小时过期，后台每分钟清理；读取过期句柄返回 `tool_result_expired`，过期元数据再保留七天以解释旧句柄。项目删除、会话历史清理和助手归属数据删除同步移除相关结果。升级时迁移旧轨迹目录中的命令结果并按生成时间补齐过期时间。

配置了结果卷时，各执行电脑仅将本归属子目录只读挂到 `/results`。有命令权限的循环同时收到 `path: /results/<id>.utf8`，可用 jq、Python 等处理完整结果；派生数据写到工作目录或 HOME。修改、删除和新建 `/results` 文件均被只读挂载拒绝。Manager 分派及无命令权限的循环只收到 `file`。未配置结果卷的部署仍可用分页工具，不提供电脑路径；配置后挂载失败按电脑创建失败报错。

`keep_background: true` 的不可变结果只覆盖启动请求返回时已有的日志，提示中会说明这是启动快照。后续日志继续写入 `log_path`，需用后续命令读取；读取旧结果文件不会等待服务结束或追踪新输出。
