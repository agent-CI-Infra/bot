# Actions 失败分类与提报

Actions 失败处理是工作类型 `actions.failures`。它的开关就是每个仓库的 `actions_failures_enabled`。经 GitHub App 安装首次启动、能力上限至少为 `comment` 的新项目默认打开（#851）：只分析、每个失败的运行最多重跑一次、提报 Issue，不会自己开始开发；机器人账号的项目和以 `read` 启动的项目默认关闭，再次启用已禁用的项目保留原来的选择。在「项目设置 → 监听与触发」中开关「接收默认分支和版本标签的 Actions 失败事件」并保存，或通过 `PATCH /api/repositories/:id/policy` 保存布尔值。每个失败的运行 attempt 是一个 `actions.run_failed` 事件，由项目 Manager 决定是否分析；Manager 决定不处理时这次失败记为 `ignored`，不重跑也不提报。失败原因由这类工作的模型分析，提示词是 Manager 提示词的「Actions 失败处理」章节；它和所有工作类型一样能读取仓库的全部 GitHub 内容、启动独立 agent，见下文「分析与分类」。它还要求项目能力上限至少为 `comment`（见[项目能力上限](workflows.md#项目能力上限)），上限为 `read` 时开关打开也不会运行。关闭后不再为本功能重跑、提报或启动开发；上限为 `comment`（没有开发）时仍处理分类、重跑和提报。

## 配置前提

App 管理员需要在已有 App 的事件订阅中添加 `workflow_run`，即 GitHub App 设置 Permissions & events → Subscribe to events 里的「Workflow run」。它是 Webhook 事件订阅，不是 Workflows 权限：GitHub 只要求 App 至少有 Actions read 才能订阅；Workflows 权限只用于修改 `.github/workflows` 下的文件，确认为 CI 改动的 bot PR 需要它，本功能不需要。新建 App 的 manifest 不能替代这个操作。此事件不属于全局 `appEvents`，因此未启用本功能的安装继续使用现有接入要求。

处理器读取该仓库实际使用的安装的 `permissions` 和 `events`，在项目设置和仓库读取 API 的 `actions_failures.error` 中报告最先缺少的一项：安装没有 Actions 权限时为 `actions_permission_missing`（这时 GitHub 不会提供 Workflow run 订阅，先补权限）；有 Actions 权限但没有订阅时为 `actions_workflow_run_subscription_missing`。两者都让本功能停在读取运行之前，不写 GitHub。超级管理员的项目列表按安装记录的事件，在缺少 `workflow_run` 的每个仓库行显示「事件未订阅」，开启本功能的仓库为琥珀色，未开启的为蓝色；「同步安装列表」的结论和「机器人账号」的 App 检查也会列出它，但它不计入检视和开发的基线。GitHub 文档只要求新增权限时由安装所有者批准；安装设置出现待批准的变更时接受即可。

已有 App 权限包含 Actions write；处理器只请求 Contents read、Actions write、Issues write。运行读取、日志读取及写入都经过现有 GitHub 客户端、配额判断和仓库启停检查。身份检查绑定仓库 id 和所有者；按仓库持久租约串行处理，写入前再次检查功能开关和租约。

## 运行范围与扫描

签名验证通过的 `workflow_run.completed` 事件只记入持久收件记录。每 5 秒检查待处理事件；后台扫描间隔为 60 秒，每页 50 个 run。只处理 `conclusion=failure`，忽略 PR 事件、带有 PR 关联的 run，以及成功、取消和跳过。普通 run 必须属于默认分支。推送标签触发的 run（版本标签运行，#1028）不限 workflow 名字：GitHub 给这类 run 的 `event` 是 `push`，`head_branch` 是标签名，控制面用 `GET /git/ref/tags/<标签名>` 确认这个标签存在、并且（附注标签解到它指向的对象后）指向 run 的提交，再通过 compare 确认该提交是默认分支的祖先。GitHub 不给这类 run 标出引用类型，所以判断只看同名标签：已删除或已改指别的提交的标签、不在默认分支历史上的提交都不进入；分支推送的 run 只有在恰好有同名标签指向同一个提交时，才会被当作版本标签运行（这个提交同样在默认分支历史上）。不会修改任何目标仓库工作流。

版本标签运行和默认分支的失败走同一套处理：同样作为 `actions.run_failed` 事件交给 Manager，先调查，最多重跑一次，按原因合并报告，同一 `repository + run id + attempt` 重复投递只处理一次。为了让 Manager 和分析任务区分，事件摘要和分析任务的标题写明「版本标签运行」和标签名，事件和 `run.json` 里的 `run` 用 `tag_run: true` 和 `tag` 代替 `branch`，分析可以按需要在正文说明标签。它和「发版本」是两件事：本功能不读写发版本记录，不影响发版本页面的流程；发版本页面请求的 CI 观察和发行说明（`release.observe`、`release.notes`）照旧是独立任务，不依赖本功能，两者互不取消。

首次开启保存精确的 `enabled_at`。已经在该时刻前完成的运行不补报，之前开始且仍在运行的任务会跟踪到完成。为发现这种较早开始的运行，首次扫描读取历史 run 的元数据，但不读取已完成历史运行的日志、不处理其失败。之后只扫描新增创建时间窗口；已发现的未完成 run 和已发送重跑的 run 单独轮询到结束。

人工重跑不改变 run 的创建时间，创建时间窗口不会再返回已结束且不在跟踪中的 run。这类重跑首先由 `workflow_run.completed` 事件送达；为防投递丢失，每 10 分钟再列一次最近 72 小时创建的 run，取最新一次 attempt 已结束、结论为 failure、在开启之后完成且尚未记录的 attempt，按同一个 `repository + run id + attempt` 记录处理。GitHub 单次查询最多返回 1,000 条，更早的部分仍依赖事件。

GitHub 的 run 列表支持 `created` 范围，不支持完成时间范围。扫描使用固定创建时间上下界，且不按可变的 status 过滤，避免运行完成或重跑时改变分页成员。窗口结束时间落后当前时间 2 秒；相邻周期重叠一个创建时间秒，由 run/attempt 去重。超过 API 1,000 条查询上限时，先按创建时间对半拆分窗口；单秒也超过上限则显示错误并保留位置，不跳过。

窗口、页号、当前页内容及页内位置保存在 SQLite。每项成功处理或安全忽略后推进页内位置，当前页全部处理后才推进页号；失败页在重启后继续。未完成运行写入独立跟踪表就算已接收，它的最终结果仍需处理。已跟踪 run 逐条隔离处理错误，一条提报状态未知不会阻断其他重跑运行的完成轮询，但仍保留当前未处理扫描页。扫描不依赖收到 webhook，两个入口共用 `repository + run id + attempt` 记录。

## 分析与分类

失败原因由这类工作的模型分析（`src/actions/analysis.ts`），模型按 `task_models['actions.failures']` 选择，没有单独设置时用项目默认模型；提示词默认是 [`docs/prompts/actions-failures.md`](prompts/actions-failures.md)，可以由 Manager 提示词的同名章节覆盖。

控制面先读取每个失败 job 的完整日志（不超过现有 GitHub 客户端 8 MiB 下载边界；超限不返回截断内容），取出失败 step 时间区间内的输出（`src/actions/classifier.ts`），然后为这个 attempt 排一个分析任务。任务和其他工作流一样在项目电脑里运行，检出失败运行的提交；run、job 和失败 step 的名字写在 `../context/run.json`，每个失败 job 的失败 step 输出写在 `../context/failed-steps/<job id>.log`（只放最后 400 行、4 万字符）。agent 需要更多时用 `read_job_log` 读完整日志，也可以在检出里运行命令、读工作流文件和代码、其他运行、Issue 和 PR，按提示词启动独立 agent。日志、job 名和 step 名都是不可信数据。

agent 先调查，再决定是否值得提报。应按需查看完整日志、产物、失败提交的工作流／源码／测试、历史成功运行和已有 Issue，说明预期与实际、具体机制、因果链、已查内容、不确定性及可操作的修正或下一步验证。断言失败和非零退出只是症状，不能直接认定产品代码有缺陷；不要编造复现、源码位置或已排除的原因，也不要求为了确定根因重复执行昂贵测试。

- `external`：外部服务、网络或 runner 等原因使相同提交重跑很可能通过。
- `code`：仓库证据支持该提交存在缺陷，需要说明失败机制；分类不等于确认产品缺陷或批准开发。
- `unknown`：调查后仍无法确定原因。如实记录已查与缺口，Manager 可通过任务指令和写权限决定是否值得提交可操作的调查单；不要求完全确定根因才能报告。

`report_failure` 接受稳定且具体的 `cause`、受影响的 `job_ids`（上游 job 在前）、`kind`、英文 `title`、完整 Markdown `diagnosis`、提报价值 `report_reason` 和类型化来源 `evidence`。同一上游问题及下游 accounting／gate／reporter 检查合并为一份诊断；关联必须由分析显式给出，不从 job 名猜测。独立原因分别报告，即使错误行相同。重复登记同一原因会替换整份报告，需提交完整 job 列表与诊断。没有 `issue` 写权限时不提供该工具。

`finish_analysis` 的 summary 保留完整调查，包括所有失败 job 的关联或缺口、提报／不提报决定和下一步。工具登记的完整诊断独立进入结果和公开正文，不再压成一两句理由，也不折叠段落或截取 1,200 字符。报告应包含预期与实际、因果链、来源、已查内容、置信度与不确定性、具体修正或验证建议，而非固定的“修复失败检查”模板。不以空洞字数门槛替代质量判断。

控制面核验引用并保留写入边界：

- 日志引用 `{type:"log",job_id,lines}` 必须逐字来自对应 job 的完整失败 step 输出，忽略首尾空白和时间戳；保留原有逐字核验。
- 源码引用 `{type:"source",path,lines}` 由控制面在失败 SHA 读取并逐字核验。
- 产物引用 `{type:"artifact",artifact_id}` 的元数据必须属于原 run 和 SHA；产物内容、attempt 归属及复现限制由调查如实说明。
- code／external 报告没有任何来源核验通过时不发布，不自动降为 unknown 再提单。显式选择的 unknown 调查单可以没有核验通过的引用，但必须说明缺口及调查价值。
- 缺日志仍可开展源码／产物调查；漏 job、没有报告、任务失败或结果不可用均不自动创建 Issue。记录保守分类和调查缺口后完成该 attempt。
- 模型服务不可用、限流或没有配置时不写任何东西：任务等待，扫描显示原因（例如 `model_not_configured`），恢复后继续。

## 一次自动重跑

`rerun_failed_run` 与提报是两个显式决定。只有每个失败 job 都通过失败 step 日志核验为 external，且原提交工作流已经声明 `workflow_dispatch`，才调用原 run id 的 `POST /actions/runs/{id}/rerun`。不调用 dispatch，不改变 SHA/ref，也不添加触发器。没有 `actions_rerun` 写权限就不重跑。

一次预算按 `repository + run id` 保存，发送前落库 before/expected attempt、SHA、ref、时间和 sending 状态。成功为 sent，拒绝为 denied，响应不明为 unknown，先查询原 run，之后只对账，不再次 POST。重启、重复事件、人工 rerun、关闭再开启均不重置预算。

首次 external 重跑已发送时不发布已登记的报告；成功则结束跟踪。重跑失败、预算已用完、工作流不支持或令牌拒绝时，只发布调查中显式选择的报告。请求超过 5 分钟仍未观测到下一 attempt 时，也只发布原调查显式选择的报告并继续跟踪，不凭超时自动建单；当前 Issue 写权限和任务来源必须仍有效。

## 公开提报与去重

新报告按 `repository + workflow id + cause` 去重，job 只描述影响范围，不参与新报告身份。原因标识应稳定描述底层问题，不能使用 run/attempt/job id 或笼统退出症状。控制面向后续分析的 run.json 和 Manager 事件提供同一工作流最近已发报告的原因标识及 Issue 编号（最多读取 50 条元数据、保留 20 个不同原因，不读取旧正文）；确认为同一问题时复用原标识，不能因错误行相似就合并。相同原因的新 run/attempt 在本功能已登记且仍打开的 Issue 评论并保留新证据；不同原因或原 Issue 已关闭时新建。每个原因在一个 attempt 只有一个持久 outbox 回执，重复处理不重复写入。

分析任务的英文 `title` 和 Markdown `diagnosis` 分别作为 Issue 标题和完整正文。同一原因的跟进评论也只展示本次诊断。作者决定如何说明根因、引用证据、放置稳定的 Actions 链接及表达不确定性。`evidence` 和 `report_reason` 用于内部核验与分类。公开前仅遮盖已知密钥、凭据字段或请求头、私钥块和签名参数，保留普通路径、SHA、链接和相邻诊断文字。Base64 或 Base64url 数据中含有已注册凭据或可识别的凭据字段时，只遮盖那段编码；按行折叠的编码作为一个载荷核验，包括 Markdown 引用、列表、带时间戳的日志行和用空白连接的折行，保留时间戳及编码旁的诊断文字。平台附加隐藏的回执标记用于对账；模型文本中的标记不能作为平台标记。超过 GitHub 65,536 字符上限时保留完整调查及未发布原因。实际写入前再次用最新凭据集合处理标题、正文和已保存的待发送内容，并复核权限与任务来源。

丢失 Issue／评论响应后，按发布账号的 GitHub 用户 ID 和唯一 marker 从 Issue／评论列表对账；找不到则显示 `actions_report_write_unknown` 并保留该项，绝不盲目重发，不依赖搜索索引。

升级不重写历史表：旧 task verdict 或缓存的按 job evidence 继续保留并可用于原重跑预算，但不生成新报告；已有 outbox 沿用原 id 和 marker 恢复或确认，旧正文中的日志附录不再发送，不重发已 sent 回执。同一原 run 的后续 attempt 可用上游 job 的相同旧签名及分类接续已发旧 Issue，前提是它尚未被另一个新原因认领；其余新报告只用显式 cause 去重。旧记录保持可读，不全表迁移或回填提单。

## 复用检视和开发

提报通过现有 `queueWebhook(..., issues.opened, ...)` 进入检视，和实际 GitHub webhook 使用同一 opened 唯一键。检视关闭时只保留 Issue。external 和 unknown 的来源类别保存在本地，不论后续日志指令或标签内容如何，都不能进入开发。

code 来源还必须保留 Current behavior、Expected behavior、Requested code change 三个顶层二级标题及其内容。段落、列表、代码块、表格和引用块均可提供章节内容，摘录中的标题不能代替顶层标题。进入开发前，检视明确返回 `product_defect=true`，而且没有人被指派。这是 bot 自己提报的 Issue，开发它不需要别的依据，由 Manager 决定（#815 之前还要原文 quote 和人加的开发标签）。Bot 不加开发标签。进入开发及发布前继续检查功能开关、项目能力上限为 develop、实际安装的事件订阅、Issue 开放且无人指派；对应 bot PR 的修订也保留原 Issue 的开关和批准边界。仍由现有流程测试、发布 `bot/issue-...` 分支和 PR，不合并。

PR 需要的标签（例如仓库要求的一个 `release:*` 类别）由仓库自己的规则告诉 agent，经 `create_pull_request` 的 `labels` 提交，规则见[架构](architecture.md#检视与开发数据流)。

## 验证

`test/st/src/actions/actions-failures.test.mjs` 通过签名 webhook、独立控制面 SQLite、HTTP GitHub 夹具和扮演分析任务的假 agent（`test/fixtures/event-tasks.mjs`）覆盖分析结果的核验与降级、扫描、分页断点、重启、一次重跑、未知响应对账、提报去重、凭据过滤和现有开发门槛。`test/ut/src/github/pull-request-labels.test.mjs` 验证 PR 标签的规则、可改正的拒绝和幂等添加。`test/e2e/projects/actions-failures.spec.mjs` 覆盖真实管理页面的默认关闭、开关保存、配置错误和窄屏展示。现有开发测试继续验证批准和发布前检查。

真实验收只在专门用于测试的 GitHub 组织里进行。若该组织中的安装未订阅 `workflow_run`，应记录现场阻断，不能修改生产配置来绕过它；不得在生产仓库试重跑、试打标签或创建自动化失败 Issue。生产仓库开启开关是验证完成后的独立配置步骤。
