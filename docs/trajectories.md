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

删除项目时删除它的轨迹目录和入口，清理会话历史时删除该会话的轨迹文件。控制面的轨迹暂不过期。

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
- **任务**：剩余低于底线（总容量的 1% 与 1 GiB 中较小者）时，任务在准备工作区之前以 `disk_full` 停在「等待环境」；任务运行中写盘失败（控制面自己的写入，或 manager 返回的 `disk_full`，HTTP 507）也以 `disk_full` 停止，而不是记成随机的运行异常。`disk_full` 不消耗自动重试次数，有空间后自动继续。

## 存储页

全局设置的「存储」一节（`GET /api/storage`）只读，列出 bot 用到的每一类存储（#671）。超级管理员看到全部项目和整块数据盘；项目管理员只能进入这一节，只看到自己项目的轨迹和项目电脑。

- **数据盘**（超级管理员）：控制面所在磁盘的总量、已用、剩余和保留空间；已知占用逐项列出：`control.sqlite`（含 WAL）、控制面轨迹文件与 blob、`git-cache`、`public-boards`、`manager.sqlite`（含 WAL）、manager 轨迹文件、各项目电脑的工作卷、Docker 镜像和构建缓存；「其他」为已用减去这些之和（助手电脑的 HOME、系统和不归 bot 管理的目录，只显示、不清理）；还没测量到的项（git 缓存尚未测、Docker 用量尚未读、manager 没有应答）显示「尚未测量」而不是 0，这时「其他」包含它们，并注明。任务工作区按电脑扫描时最大的 5000 个目录分类，目录更多时注明总数。Compose 部署里这些都在同一块数据盘上。
- **可回收与最近清理**：两个数据库的空闲页（压缩后回收）、待删除的任务工作区、没有使用的 Docker 构建缓存和没有容器使用的镜像（不含与在用镜像共享的层）；manager 过期删除和任务工作区清理最近一次删除的个数与字节。
- **数据库与磁盘、历史数据迁移**：两个数据库的文件大小、实际数据、空闲页和 WAL，各自所在磁盘的剩余空间，两边后台迁移的进度（每张表已迁移、跳过、失败、已搬出的字节、按 rowid 估计的待检查行数、完成时间、因空间不足暂停、最近一分钟的速度和最近一个错误），manager 过期删除的保留天数和最近一遍；剩余空间低于保留空间的磁盘另有告警。
- **按项目**：轨迹文件的数量和字节、按类型的记录（模型请求/响应、工具调用/结果、日志与事件）、blob、manager 侧的轨迹文件（及已过期删除的文件），以及仍在写入的文件。
- **项目电脑**：每台电脑工作卷的合计；任务工作区按保留规则分为运行中（任务未结束或有后续任务）、为 PR 保留（对应 PR 仍打开）、待删除（已结束，到期后由工作区清理删除，含没有记录的目录）；runner journal、git 存储、HOME（列出最大的几项缓存）、其他（`/workspace/tmp` 和卷根目录下的其他文件）；扫描时间和扫描是否完整（有读不了的目录或超时为未扫完）。挂在 `/workspace/project-notes` 的项目笔记是 manager 数据目录里单独的卷，不算工作卷，扫描时跳过（它的历史目录电脑用户本就读不了）。

打开页面只读文件关闭时累加的 `trajectory_usage`（manager 有自己的一份）、一次 statfs 和控制面每 5 分钟的后台快照，不遍历文件、不扫描数据表，加载时间不随数据量增长。快照给少数未关闭的文件取大小、读数据库头部的 PRAGMA、向 manager 取 `GET /v1/storage`，并对新扫描到的电脑按任务记录给工作区分类（每次扫描只分类一次）；`git-cache` 和 `public-boards` 每小时用 `du` 以最低优先级测一次。manager 在后台测量：每台运行中的电脑每 6 小时一次、同一时间只扫一台，runner 的 `storage_scan` 以最低优先级对 `/workspace` 做一遍两层的 `du`（30 分钟为限，超时或有读不了的目录时标为未扫完），manager 保存最后一次结果（`computer_storage`）；Docker 的镜像和构建缓存每 30 分钟经 `GET /system/df` 读一次（不让 Docker 计算卷大小）。迁移期间仍在行里的正文按表给出估计的待检查行数，不按项目细分（那需要扫描表）。

## 历史数据迁移

升级前写进行里的正文由后台迁移搬进文件（`src/storage/migration.ts`）。控制面开始监听、封口任务跑完之后才启动，就绪不等它；启动阶段只加列、重建触发器，不读大表的行。

- 依次处理 `task_tools`、`role_conversation_operations`、`service_role_operations`、`model_requests`、`task_logs`、`tasks`（输入里的文件清单改存 blob）、`task_history`，每张表按 rowid 顺序走。
- 每一片先读行，读满约 25 ms（单行再大也只多读这一行）就停；把这些行的正文追加到文件，等文件 `fdatasync` 落盘（不占事件循环），按定位串逐条读回核对哈希，然后在一个短事务里把这些行的正文列换成表头和定位串、并保存游标。两片之间至少让出与这一片同样长的时间。
- 游标、已迁移/跳过/失败条数、字节数和最后一个错误保存在 `settings` 的 `trajectory_migration`；重启后从游标继续，已迁移的行不会再搬一次。剩余量按 `max(rowid)` 与游标之差估计，不数行。
- 只迁移已结束的记录：`task_tools` 等只搬 `completed` 的调用（仍在 `pending` 的可能正被执行），`model_requests` 只搬已 `finished_at` 的请求，`task_logs` 只搬超过 2 KiB 的 JSON 日志，`task_history` 只搬超过 2 KiB 的 `operation`、`runtime_log` 快照。
- 记录写进任务的 `legacy.jsonl`（`trajectories/<repository_id>/<task_id>/legacy.jsonl`，原来的运行已无从得知）或会话的 `conversations/<conversation_id>/legacy.jsonl`；会话里原先加密的正文以明文写入，库里不再留任何字段。模型快照原样保存为 `{"$snapshot":…}`，`task_history` 快照原样保存，行里留 `{"$trajectory":"<定位串>","characters":<原长度>}`。
- 一轮走完后每 10 分钟再看一次新行（没有运行可归属、仍写在行里的记录）。

迁移不缩小 SQLite 文件：清出的页留在空闲页里给新行复用。回收磁盘（维护窗口里的 `VACUUM` / `VACUUM INTO`）不在这里做，存储页会显示空闲页数供维护者判断。

## 命令完整输出与模型分页

命令超过 1 MiB 输出后继续执行；成功与失败由 `exit_code`、`timed_out` 和 `error` 决定，`truncated` 仅表示返回的预览省略了中间内容。runner 只在内存保留固定大小的首尾缓冲，完整输出脱敏后流式写入 journal；控制面按操作 ID 分页复制到轨迹目录的 `results/<id>.utf8`。SQLite 的 `tool_result_files` 只保存所有者、来源、长度和来源消息指纹。项目或会话删除时，结果文件随轨迹清理。runner 的原始 journal 由已有保留策略回收，助手电脑的临时 journal 在本轮结束时清理。

模型收到 `head`、`tail`、`file`、`bytes`、`encoding` 和读取提示，用 `read_tool_result({file, position, length})` 读取原结果；`position`、`length` 均为 UTF-8 字节，默认一页 16384 字节、最多 65536 字节，按 `next_position` 继续直到 `eof`。边界不足以容纳一个字符时返回范围错误，读取不会重复原命令。小输出保持原有直接返回行为；上下文压缩或批预算收紧仍保留文件引用。存储失败明确返回错误，不提供失效的文件入口。

`keep_background: true` 返回时服务可能仍在运行，其预览及不可变 `file` 只覆盖启动请求返回时已经写入的日志，读取提示会明确说明启动快照。服务后续输出继续写入 `log_path`，需要用同一任务的后续命令读取；读取旧结果文件不会等待服务结束或追踪新增输出。

读取只允许原任务角色或原会话主体使用，并复核当前权限，不需要命令或工作区写权限。撤回或编辑作为结果输入的消息后，该文件不可再读；后续结果仍归同一会话，不因此重建整场会话。隔离运行环境和助手电脑使用各自作用域的输出接口；通用 Pi 在自己的工作区保存相同形状的不可变结果文件，绑定工作区和子会话，工作区清理时一并回收。模型不会获得控制面宿主路径。
