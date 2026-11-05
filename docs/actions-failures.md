# Actions 失败分类与提报

每个仓库的 `actions_failures_enabled` 默认关闭。在项目「任务总览」的「检视设置」中开启「Actions 失败处理」，或通过 `PATCH /api/repositories/:id/policy` 保存布尔值。关闭后不再为本功能重跑、提报或启动开发；`development_enabled` 单独关闭时仍处理分类、重跑和提报。

## 配置前提

App 管理员需要在已有 App 的事件订阅中添加 `workflow_run`。新建 App 的 manifest 不能替代这个操作。此事件不属于全局 `appEvents`，因此未启用本功能的安装继续使用现有接入要求。处理器读取该仓库实际使用的安装的 `events`；没有订阅时，在项目设置和仓库读取 API 的 `actions_failures.error` 中显示 `actions_workflow_run_subscription_missing`，本功能不写 GitHub。修改事件订阅本身不要求新增权限批准；只有实际增加安装权限时才需要安装管理员批准。

已有 App 权限包含 Actions write；处理器只请求 Contents read、Actions write、Issues write。运行读取、日志读取及写入都经过现有 GitHub 客户端、配额判断和仓库启停检查。身份检查绑定仓库 id 和所有者；按仓库持久租约串行处理，写入前再次检查功能开关和租约。

## 运行范围与扫描

签名验证通过的 `workflow_run.completed` 事件只记入持久收件记录。每 5 秒检查待处理事件；后台扫描间隔为 60 秒，每页 50 个 run。只处理 `conclusion=failure`，忽略 PR 事件、带有 PR 关联的 run，以及成功、取消和跳过。普通 run 必须属于默认分支；Release 的 tag push 还需通过 compare 确认该 SHA 是默认分支的祖先。不会修改任何目标仓库工作流。

首次开启保存精确的 `enabled_at`。已经在该时刻前完成的运行不补报，之前开始且仍在运行的任务会跟踪到完成。为发现这种较早开始的运行，首次扫描读取历史 run 的元数据，但不读取已完成历史运行的日志、不处理其失败。之后只扫描新增创建时间窗口；已发现的未完成 run 和已发送重跑的 run 单独轮询到结束。

人工重跑不改变 run 的创建时间，创建时间窗口不会再返回已结束且不在跟踪中的 run。这类重跑首先由 `workflow_run.completed` 事件送达；为防投递丢失，每 10 分钟再列一次最近 72 小时创建的 run，取最新一次 attempt 已结束、结论为 failure、在开启之后完成且尚未记录的 attempt，按同一个 `repository + run id + attempt` 记录处理。GitHub 单次查询最多返回 1,000 条，更早的部分仍依赖事件。

GitHub 的 run 列表支持 `created` 范围，不支持完成时间范围。扫描使用固定创建时间上下界，且不按可变的 status 过滤，避免运行完成或重跑时改变分页成员。窗口结束时间落后当前时间 2 秒；相邻周期重叠一个创建时间秒，由 run/attempt 去重。超过 API 1,000 条查询上限时，先按创建时间对半拆分窗口；单秒也超过上限则显示错误并保留位置，不跳过。

窗口、页号、当前页内容及页内位置保存在 SQLite。每项成功处理或安全忽略后推进页内位置，当前页全部处理后才推进页号；失败页在重启后继续。未完成运行写入独立跟踪表就算已接收，它的最终结果仍需处理。已跟踪 run 逐条隔离处理错误，一条提报状态未知不会阻断其他重跑运行的完成轮询，但仍保留当前未处理扫描页。扫描不依赖收到 webhook，两个入口共用 `repository + run id + attempt` 记录。

## 分类器

`src/actions/classifier.ts` 是测试和线上唯一入口，使用确定性规则，避免模型波动使重跑预算或开发判断改变。

只分析 `failure` job 中失败 step 的时间区间，读取完整且不超过现有 GitHub 客户端 8 MiB 下载边界的 job 日志；超限不返回截断内容，归为 unknown。没有失败 step、时间戳、完整日志或可辨认因果记录时也归为 unknown。失败 step 里没有可辨认的错误行时，另外保留该 step 自身输出的最后 8 行，只用于提报展示，不参与分类和去重签名。只取该 step 的 `##[group]Run` 脚本块之后、通用退出码行之前的输出；step 时间只精确到秒，短任务同一秒内的准备和清理行不计入。成功 step、命令回显、文档中偶然出现的错误关键词和通用 exit-code 包装不算因果证据。

外部规则识别错误记录中的 HTTP 429/502/503、arXiv 406/429、连接超时或连接中断、DNS 错误、磁盘耗尽、runner 断联或 Actions 队列故障。代码规则识别断言、明确语言异常、TypeScript 编译错误、lint 和编译器诊断。任何失败 step 证据缺失、未识别错误和已知错误并存，或 external/code 混合，都归为 unknown；多个失败 job 不能由单一类别解释时，整个 run 归为 unknown。保守分类不等于确认产品缺陷，后续仍需现有检视。

## 一次自动重跑

仅 external 且原提交的工作流文件已经声明 `workflow_dispatch` 时，调用原 run id 的 `POST /actions/runs/{id}/rerun`。不调用 dispatch，不改变原 SHA/ref，也不增加目标工作流触发器。tag Release 没有该触发器时只提报。

一次预算按 `repository + run id` 保存，在发送前落库 `before_attempt`、`expected_attempt`、SHA、ref、发送时间和 `sending` 状态。收到明确成功保存 sent；拒绝保存 denied 并提报；响应不明保存 unknown，先查询原 run，之后只对账，不再次 POST。重启、重复事件、人工 rerun、关闭再开启功能都不重置预算。请求超过 5 分钟仍未观测到下一 attempt 时提报未确认状态，并继续监测该 run。

首次 external 重跑已发送时不提报。其后 external 失败才提报，并说明一次预算已用完。运行成功则结束跟踪。不能重跑的工作流或安装令牌拒绝重跑，也只提报，不进入循环。

## 公开提报与去重

每个失败 job 使用 `repository + workflow name + job name + normalized error signature` 查找本功能已登记且仍打开的 Issue。签名去掉 SHA、时间戳、耗时及行号差异。相同签名的新 run/attempt 在原 Issue 评论；关闭后再次出现、不同 job 或不同签名才新开 Issue。

Issue 正文为英文，包含 job URL、run URL、SHA、分类和最多 2,400 字符的证据摘录。先移除数据库中已知凭据、当前安装令牌及明确的 token/password/API key、JWT、云访问密钥、私钥和带凭据 URL，再截取公开摘录。无法安全判断的高熵内容不公开，正文说明省略原因并保留链接和 SHA。正文区分三种情况：可辨认的错误行因安全原因不公开；没有可辨认错误行，附失败 step 最后的输出；既无错误行也无输出。日志作为缩进的不可信数据展示，不能贡献开发批准或 request quote。

提报发送前有持久 outbox。丢失 Issue/评论响应后，通过唯一 marker 在 Issue/评论列表对账；找不到则显示 `actions_report_write_unknown` 并暂停该项，不盲目重发。不会依赖 GitHub 搜索索引的更新时机。每个失败 job 一份报告；整个 run 的保守分类用于该 run 的全部报告。

## 复用检视和开发

提报通过现有 `queueWebhook(..., issues.opened, ...)` 进入检视，和实际 GitHub webhook 使用同一 opened 唯一键。检视关闭时只保留 Issue。external 和 unknown 的来源类别保存在本地，不论后续日志指令或标签内容如何，都不能进入开发。

code 来源还必须保留 Current behavior、Expected behavior、Requested code change 正文，检视明确返回 `product_defect=true`，通过现有 `requires_code_change`、`issue_requests_code`、无需澄清、非空目标和原文 quote 检查，并由人应用配置的开发标签。quote 必须来自日志区之前的正文。Bot 不加开发标签。进入开发及发布前继续检查功能开关、开发开关、实际安装的事件订阅、Issue 开放、标签仍在且无人指派；对应 bot PR 的修订也保留原 Issue 的开关和批准边界。仍由现有流程测试、发布 `bot/issue-...` 分支和 PR，不合并。

面向 `openJiuwen-ai/sciencediscovery` 的 PR 通过工具参数 `release_label` 指定类别；实现任务需要读取当前 CONTRIBUTING、release.yml 和 create-github-pr skill 选择类别。控制面再次读取这三份文件，校验类别来自当前分组，添加后读回实际标签并确认恰好一个 `release:*`。有冲突或无法添加则报告发布未完成，不声称标签已就位。其他仓库不受该目标仓库契约影响。

## 验证

`test/actions-failures.test.mjs` 通过签名 webhook、独立控制面 SQLite 和 HTTP GitHub 夹具覆盖分类、扫描、分页断点、重启、一次重跑、未知响应对账、提报去重、凭据过滤和现有开发门槛。`test/release-label.test.mjs` 验证类别读回及失败状态。`e2e/actions-failures.spec.mjs` 覆盖真实管理页面的默认关闭、开关保存、配置错误和窄屏展示。现有开发测试继续验证批准和发布前检查。

真实验收只使用 `agent-test-zone` 组织。若该组织中的安装未订阅 `workflow_run`，应记录现场阻断，不能修改生产配置来绕过它；不得在生产仓库试重跑、试打标签或创建自动化失败 Issue。生产仓库开启开关是验证完成后的独立配置步骤。
