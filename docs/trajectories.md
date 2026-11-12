# 轨迹文件

Agent 工作的大块正文（模型请求与响应、工具调用与结果、大日志）不再写进 SQLite 的行里，而是按运行追加到 JSONL 轨迹文件。SQLite 只保留状态、计费、每个文件一条入口，以及已有行上指向单条记录的定位串。设计与取舍见 issue #436。

## 文件

文件在数据库同目录的 `trajectories/` 下，随 `bot-data` 卷一起备份；目录 0700、文件 0600，只有服务用户可读。

- 任务的每次运行（`task_runs` 的一行）一个文件：`trajectories/<repository_id>/<task_id>/<run_id>.jsonl`。
- 没有任务的会话轮次（管理助手、群聊助手、项目角色会话）：`trajectories/conversations/<conversation_id>/<turn>.jsonl`。
- Manager 对一个事件的一次分派：`trajectories/<repository_id>/dispatch/<event_id>-<attempt>.jsonl`。
- 文件关闭后不再追加。同一运行之后还有记录（例如运行结束后才返回的调用）时，另开续写文件 `<run_id>.2.jsonl`，依此类推。

文件不加密。写入前照旧脱敏：工具请求和结果经任务的 Redactor，模型请求和响应同样；会话原先用 SecretBox 加密的操作和模型快照，新记录也以明文写进文件。

每行是一个 JSON 对象：

```json
{"seq":1,"at":"2026-11-12T08:00:00.000Z","type":"tool_result","id":"<记录 id>","prev":null,"data":{}}
```

- `type`：`model_request`、`model_response`、`tool_call`、`tool_result`、`log` 或 `event`。
- `id`：已有记录的 id（操作 id、模型请求 id、日志 id）。
- `prev`：上一行（不含换行符）的 sha256，首行为 `null`。整个文件是一条哈希链。
- 模型请求只记相对同一文件上一次请求新增的消息：`data` 为 `{"previous":"<上一请求的定位串>","from":<沿用的消息条数>,"body":{…}}`；上一次请求的消息不是这次的前缀（例如压缩之后），或链已连续 64 次增量时，`data` 为 `{"body":{…完整请求…}}`。

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

删除项目时删除它的轨迹目录和入口，清理会话历史时删除该会话的轨迹文件。轨迹暂不过期。

## 历史数据迁移

升级前写进行里的正文由后台迁移搬进文件（`src/storage/migration.ts`）。控制面开始监听、封口任务跑完之后才启动，就绪不等它；启动阶段只加列、重建触发器，不读大表的行。

- 依次处理 `task_tools`、`role_conversation_operations`、`service_role_operations`、`model_requests`、`task_logs`、`task_history`，每张表按 rowid 顺序走。
- 每一片先读行，读满约 25 ms（单行再大也只多读这一行）就停；把这些行的正文追加到文件，等文件 `fdatasync` 落盘（不占事件循环），按定位串逐条读回核对哈希，然后在一个短事务里把这些行的正文列换成表头和定位串、并保存游标。两片之间至少让出与这一片同样长的时间。
- 游标、已迁移/跳过/失败条数、字节数和最后一个错误保存在 `settings` 的 `trajectory_migration`；重启后从游标继续，已迁移的行不会再搬一次。剩余量按 `max(rowid)` 与游标之差估计，不数行。
- 只迁移已结束的记录：`task_tools` 等只搬 `completed` 的调用（仍在 `pending` 的可能正被执行），`model_requests` 只搬已 `finished_at` 的请求，`task_logs` 只搬超过 2 KiB 的 JSON 日志，`task_history` 只搬超过 2 KiB 的 `operation`、`runtime_log` 快照。
- 记录写进任务的 `legacy.jsonl`（`trajectories/<repository_id>/<task_id>/legacy.jsonl`，原来的运行已无从得知）或会话的 `conversations/<conversation_id>/legacy.jsonl`；会话里原先加密的正文以明文写入，库里不再留任何字段。模型快照原样保存为 `{"$snapshot":…}`，`task_history` 快照原样保存，行里留 `{"$trajectory":"<定位串>","characters":<原长度>}`。
- 一轮走完后每 10 分钟再看一次新行（没有运行可归属、仍写在行里的记录）。

迁移不缩小 SQLite 文件：清出的页留在空闲页里给新行复用。回收磁盘（维护窗口里的 `VACUUM` / `VACUUM INTO`）不在这里做，存储页会显示空闲页数供维护者判断。
