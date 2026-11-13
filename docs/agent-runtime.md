# 共享 Agent 后端

## 边界

`src/agent/runtime.ts` 的 `runAgent(spec)` 是检视、开发、CI 观察和发布说明的共享执行入口。调用方提供 system/prompt、工具白名单、执行器、输出校验器和生命周期 guard；运行时不根据任务类型选择检查器，不绑定 pylint、语言或特定 CI。模型选择、凭据隔离、流式请求、90 秒无 token 超时、错误处理、脱敏和模型用量账本通过 `gateway.ts` 统一。

模型请求暂时失败时，`runAgent` 在同一步里重新发送，最多重试 5 次（`modelRetries`），依次等待 1、3、9、27、60 秒，然后才让这一轮或这次执行失败。暂时失败指：90 秒没有 token、连接断开或流中断、HTTP 408、429 和 5xx。认证失败、其他 4xx 和配置错误不重试。每次重试写入任务日志 `model_retry`（含原因和等待时间），调用方可以通过 `onModelRetry` 记录或清掉失败那次已流出的文字；回合被停止时，等待立即结束。重试用完后，错误说明末尾会注明“已自动重试 5 次仍失败”。每次失败请求的原因（例如“连续 90 秒没有 token 输出”或具体网络错误）写入该请求的响应记录，进程或容器替换后仍可查。Pi 执行进程等待模型回复的空闲窗口是 95 秒；控制面重试期间，会在第一次重试时立即、之后每 30 秒向它发送进度通知，执行进程因此一直等到重试结束。

两种 transport 使用同一入口：

- 工作区任务使用正式的 Pi harness（`src/agent/pi.ts` 的 `piAdapter`），在隔离项目电脑中读取文件、执行命令和产生修改；`loop.ts` 只组装任务的配置和工具回调。`profiles.ts` 把固定的硬限制和这类工作的 Manager 章节组合成系统提示，并按项目配置给这类工作的写入生成工具和显式 capabilities。同一个 harness 也运行项目主控会话（见 [Role-Pool](role-pool.md)）：会话配置里的 `control_tools` 由 runner 经控制邮箱交给控制面执行，等待没有期限；控制面只执行本次会话提供过的工具，并在回复里用 `finish` 标出被接受的提交。
- Pi 入口的完成工具（检视、回复和事件工作）在会话中交给控制面校验。字段或语义不合法时，工具结果说明原因，模型可在原会话内修正两次；仍然无效才按原错误码结束。事件校验不发布结果或改变事件状态，最终通过后才由所属模块接手；恢复已提交会话时重新校验原始提交。
- CI 观察（`release.observe`）、发行说明（`release.notes`）、Actions 失败处理（`actions.failures`）和接入门禁（`gate.onboarding`，对话的每一轮是一个任务）也是工作区任务：在项目电脑里检出相关提交，事件写在 `../context/`，用各自的结束工具交回结果，由所属模块核验后接手。运行时默认的 tool loop 用于 Native 角色后端；角色可以选择 Pi、Native、Process 或 ACP，工具和结果校验继续由调用方提供。

发布确认、幂等 outbox、发布状态机、仓库授权和 claim 是控制面的职责，不交给提示词决定。统一 Agent 不等于移除这些安全边界。

## 触发上下文与仓库探索

Issue、PR 或 Actions 失败提供任务起点，不限制证据只能来自这一个对象。`src/agent/exploration.ts` 的 `RepositoryExplorer` 为 CI 观察、检视和开发提供同一套只读工具：

- `github_read`：读取当前仓库的目录、文件、Git tree、提交、其他 Issue/PR 与讨论、Actions 和检查信息。路径相对当前仓库，文件内容解码为 UTF-8，可用 `ref` 选择固定提交并按 API 分页读取列表。
- `github_search`：搜索当前仓库的 Issue 与 PR，支持 GitHub issue search 语法和分页；仓库范围由执行器固定并核对返回项。
- `read_job_log`：读取当前仓库任意相关 Actions job 的日志片段，保留 run、attempt、job 与行号；日志下载和脱敏也由执行器完成。

先调用 `github_read_token` 建立只读访问。令牌只覆盖当前接入仓库，权限取安装已授予的内容、Issue、PR、Actions 等读取项；缺少权限时返回诊断，不回退到写令牌。CI 的令牌不离开控制面。Pi 的结构化读取工具通过任务邮箱调用同一个执行器；原有命令工具继续可使用同一次签发的只读令牌，真实凭据不进入模型上下文。任务结束、失败或中止后撤销签发的令牌。

Pi 在进程内串行执行 `github_read_token` 的令牌交换，控制面继续读取单个 `token-request.json`。活动或排队中的交换取消后及时返回 `github_read_token_cancelled`，后续调用可以继续；清理请求文件前核对请求 ID，避免删除其他调用的请求。`read_file`、发布与会话 boundary 不进入令牌队列。

升级时同步更新控制面、manager 和项目电脑镜像；Pi 的结构化读取使用新的 `workspace_agent_repository_tool` 邮箱操作，旧 manager/runner 不支持该操作。项目主控另用 `workspace_agent_runtime`（报告 runner 实际安装的 Pi SDK 版本）和 `workspace_agent_control_tool`（控制面工具的回复），旧项目电脑镜像会返回 `pi_runtime_unavailable` 并等待升级。Pi 的会话事件 `pi_session` 记录实际 SDK 版本、提供的工具以及没有混入的扩展、技能和上下文文件；`src/agent/pi.ts` 固定的版本与 `runner/package.json` 由 `npm run check` 核对一致。

Pi 在仓库工具内部串行使用邮箱，其他工具仍可并行执行。每个已进入邮箱的仓库请求最多等待 120 秒，超时返回 `repository_tool_timeout`；超时或取消后的迟到回复不会中断任务。共享执行器按现有 2 MiB 邮箱容量检查脱敏后 JSON 的 UTF-8 字节数，超出时向观察循环和 Pi 返回完整的 `repository_result_too_large` 工具错误。例如 `/git/trees/<sha>?recursive=1` 的结果无法投递时，模型应缩小 path、去掉 recursive 或继续分页，并用 page/per_page 减小每页结果；不会截断 JSON 后冒充成功结果。

## GitHub 写入（github_write）

所有 agent 用同一个写工具（#381，`src/github/write.ts`）：`github_write {method, path, body?, key}`，形状和 GitHub REST 一致。`method` 是 `POST`、`PATCH`、`PUT` 或 `DELETE`，`path` 相对仓库、不带查询串（例如 `POST /issues`、`POST /issues/12/comments`、`POST /issues/12/labels`、`PATCH /issues/12`、`POST /pulls`、`POST /pulls/7/reviews`、`PUT /pulls/7/merge`、`PUT /contents/docs/a.md`、`POST /git/refs`），`body` 是 REST 请求体。服务多个仓库的入口（群聊助手、管理助手）另带 `repository`；任务入口和 Manager 固定为任务或事件所在仓库。

- **授权**：每条路由按 GitHub 细粒度权限归到一个资源：Issue（Issue、评论、标签、指派人、里程碑）、Pull Request（PR、检视、行内评论、请求检视人、更新分支）、Contents（文件、Git 对象和引用、合并 PR）。按编号操作的 `/issues/{n}/…` 先用只读令牌查清对象是 Issue 还是 PR，再按它的资源判断；评论编号先查到所属对象。调用方角色对该资源有读写（或旧配置里对应的创建、评论、分类标签子集）才允许，发送前再核对一次实时权限。仓库外和未列出的路由一律拒绝。
- **令牌**：控制面为这一次调用签发只含该资源写权限加 Metadata 读的安装令牌，发送后撤销；GitHub 返回的令牌权限多于请求时不发送。Token 账号使用账号自身的令牌。agent 和命令环境只拿得到只读令牌。
- **文本**：给人看的 `title`、`body`（Issue、评论、PR、检视及其行内评论）转义 `@`，并按公开文本规则脱敏；其他字符串（代码、提交说明、引用）只去掉已知密钥，不转义。Base64 文件内容是 UTF-8 时按文本脱敏，二进制内容含已知密钥时拒绝。正文末尾加 `<!-- dept-bot-write:… -->` 标记，Token 账号以普通用户身份写入时，bot 自己的评论不会再作为新事件回来；角色任务或 Manager 开的 Issue、PR 也不作为新事件交给 Manager。
- **去重**：key 在一个范围内唯一：一个任务（重试同一任务不会重复写）、一个分派事件、一轮群聊或管理对话。已经写成功的 key 直接返回上次的结果（`replayed: true`）；同一 key 换了请求返回 `github_write_key_conflict`；结果未确认时返回 `github_write_unknown`，由 agent 先读 GitHub 核对，再换新 key 写。
- **结果与审计**：返回 GitHub 响应里有用的部分（编号、链接、sha、状态等）和 HTTP 状态。每次调用写一条 `github_writes`：范围、key、调用方（角色和任务、Manager 和事件、服务角色和会话、管理助手的用户）、仓库、方法、路径、请求摘要、状态、GitHub 状态码和结果链接；被拒绝的调用也记录。项目审计（`audit`）同时记一条 `github.write.<状态>`。

工具出现在每个工作类型、Pi 角色、Manager 分派、群聊助手和管理助手里，再按调用方角色的 GitHub 权限过滤：没有任何资源读写的角色看不到它，硬调也被拒绝。委派的任务还受来源角色的上限约束，角色不能把自己没有的写权限借给别人。内置角色默认只有 Manager 可写（Issue、Pull Request、Contents），其他内置角色对全部 GitHub 资源只读；升级时已保存的内置角色权限一次性重置为这些默认值（模型、后端和提示词等设置保留，自定义角色不变），配置记一个由 `migration:381` 保存的新版本。

框架交付不经过 `github_write`，也不需要角色的写权限：检视结论、测试通过的 PR、Actions 重跑与失败提报、发行说明和门禁方案沿用原流程，只看项目工作类型的写入，见 [Manager 与工作类型](workflows.md)。

2 MiB 是邮箱及观察循环的结果上限。Pi 还会在 `github_read`、`github_search`、`read_job_log` 的结果进入会话历史之前，使用同一 SDK 序列化包含当前历史与同轮已完成工具结果的下一次模型请求，并检查既有的 `estimateTokens({role:'user',content:raw,timestamp}) + 8192 > 128000` 条件。触及该上限的结果返回 `repository_result_too_large`，让模型缩小读取范围；放得下的结果原样返回，没有新增固定字节配额。序列化检查不会发起模型请求。

其他工具（`run_command`、`read_file`、记忆与任务记录查询等）的结果也在进入会话历史前检查，但只拒绝压缩也救不回来的结果。Pi 压缩会总结较早的历史，却总是保留最近一次工具调用和这一批全部结果；因此检查的请求只包含系统提示、这次工具调用和同批结果，再为压缩摘要预留两份 8192 token 的输出（历史摘要加拆分轮次的前缀摘要）。超出时模型收到 `tool_result_too_large`：命令保留 `exit_code`、`signal`、`timed_out`、`truncated` 等状态并说明命令已经执行，提示用 head、tail、grep、wc 或重定向到临时文件后分段读取；其他工具提示改读较小的部分。放得下的结果原样返回，由 Pi 照常压缩。没有这项检查时，例如一次把整个 `../notes/` 拼接输出的命令会让后续每次请求都超过上限，任务以 `agent_context_too_large` 失败，重试也会重复同一条命令。

“由 Pi 照常压缩”不保证请求超限之前一定压缩过。Pi 在每次请求前检查：模型服务上次报告的用量加上之后新增消息的 chars/4，超过 128000 − 24000 才压缩；而且它总要保留最近约 16000 token 的消息，超大的内容如果就在这一段里（例如一开始的提示本身很大，后面只有几轮小的工具调用），就没有可以切掉的部分，这次压缩什么也不做。runner 的上限则按整份原始请求 JSON 的 chars/4 估算，包括工具定义、系统提示和 JSON 转义，与 Pi 的口径也不同。所以一次请求可能在 Pi 压缩之前就超过 runner 上限。这样的请求不会发给模型服务，runner 像模型服务报告上下文溢出那样回 HTTP 413（`context_length_exceeded`），Pi 据此压缩一次再重试同一轮（这时通常已有足够的新消息可以切分）。只有压缩后仍放不下（例如最近一条人的更新或第一次请求本身就超过上限），或压缩本身失败时，任务才以 `agent_context_too_large` 失败，不再提示模型继续。

控制面自己的工具循环（`runTools`：请求任务的执行、验收、发布观察和未走 Pi 的角色）只受网关的 2 MiB 请求上限约束（超过时网关报 `model_request_invalid`），不套用 Pi 的 128k 上下文估算，上下文更大的模型可以用满。工具结果在进入对话前检查：即使把之前的工具结果全部省略也超过 2 MiB 的结果，模型收到 `tool_result_too_large`（命令保留 `exit_code` 等状态），改读较小的部分。每次请求前超过 2 MiB 时，从最早的工具结果开始省略，换成写明原长度的 `elided` 标记，模型需要时可以重新读取；省略之后仍超过的请求不发出，任务以 `agent_context_too_large` 失败。没有这项检查时，一次读到 1.87 MB 的上下文文件就会让下一次请求超过 2 MiB，任务以 `model_request_invalid` 失败。

单条模型消息里的工具调用数量不设上限，由模型自己决定（#333）：跨十个仓库各查一次是正常用法。各工具循环只校验结构（`src/agent/tool-context.ts` 的 `toolCallsProblem`）：`tool_calls` 为数组，每项是 `function` 调用、名称非空、参数为字符串或省略，`id` 为 1–128 个可见 ASCII 字符且同一条消息内不重复；结构不合法时默认循环以 `agent_tool_calls_invalid` 停止。参数不是 JSON 时，这一项调用返回 `invalid_arguments` 观察，由模型改正。上面的省略与拦截由同一模块的 `ToolTranscript` 实现，管理助手、群聊助手和服务角色的独立任务也使用它，规则见下一段。

管理助手、群聊助手和独立任务是对话，答案要放进模型的上下文窗口，而不只是不超过 2 MiB。它们在同一机制上多做两件事。第一，同一批工具结果共享 256 KiB 预算（`boundedBatch`）：小于平均份额的结果原样保留，剩下的预算由较大的结果平分，每个至少 8 KiB；被截断的结果写明原大小和缩小范围的提示，`revision`、`next_offset`、仓库名等较小的顶层字段完整保留。一个项目约 240 KB 的有效配置单独查询时仍完整返回。第二，请求超过 384 KiB（按项目对 Pi 采用的 128k 上下文估算，约 10 万 token）时，先省略模型已经看过的最早工具结果；尚未交给模型的最新一批只在仍超过 2 MiB 时才省略。

Native、Process 和非入口 Pi 角色采用相同的收尾预留公式：`min(8, max(2, ceil(maxTurns / 4)))`。配置了收尾工具的运行在预留区间提示剩余轮次并只保留指定收尾工具，最后一轮要求提交；累计剩余请求会限制本次可用轮次，不足以容纳至少一轮工作和收尾时，在启动前以 `role_budget_exhausted` 停止。Process 与共享工具循环使用相同的调用结构及 ID 校验，不限制单条回复的调用数量；参数 JSON 解析失败作为工具观察返回，模型可在原会话里改正。

Pi 会话要靠调用完成工具结束：检视是 `finish_review`，开发是 `create_pull_request`，事件类任务是各自的提交工具。模型有时没调用完成工具就停下了，比如模型服务返回空回答或错误回答，或者只写了一段文字。这时如果最后一条回答是一段 JSON 结果，就照旧把它当作结果；否则 runner 会在同一个会话里提示模型从停下的地方继续，用已经完成的工作调用完成工具，任务日志记一条 `agent_nudge`。最多提示 3 次，仍未完成就以 `agent_finish_missing` 失败，原因写明缺的是哪个完成工具。这样，偶发的空回答不会让整次尝试作废，也不会再出现与原因无关的报错。由控制面接管结束的会话（项目主控）不受影响。

仓库回复投递保留 runner 错误的 `detail`：只有直接返回的 `agent_request_changed`，或 `runner_operation_failed` 且 `detail` 恰为 `workspace_agent_repository_tool: agent_request_changed` 时，控制面才停止投递旧回复并继续轮询。分块偏移错误等其他投递故障仍中断任务；其他邮箱操作的中断条件保持不变。

读取范围扩大不改变写入范围。CI 观察仍以触发 run/attempt 为分析目标，重跑或授权变化时停止，最终 job 结论仍核对触发快照；相关运行的日志只作为带来源的旁证。检视与开发可以检查其他相关对象，但实施目标、检视结果校验、GitHub 发布授权和受控 publisher 都保留原边界。新工具固定使用 GET，不接受自选仓库、任意 URL、路径逃逸或写入方法；搜索也不能改写仓库范围。自动 Actions 失败分类与单次重试仍是既有触发流程，不由这些读取工具执行。

## 扩展任务

新任务可直接调用 `runAgent`，无需给 gateway 增加类型分支。示例（省略导入和业务上下文构造）：

```ts
const result = await runAgent({
  store, task: { id: runId, repository_id: repositoryId, kind: 'security.inspect' },
  redactor, guard,
  system: '分析提供的证据，自主选择必要工具。只报告有证据支持的问题。',
  prompt: JSON.stringify(context),
  tools: approvedToolSchemas,
  execute: async (name, args) => executeApprovedTool(name, args),
  validate: validateInspectionResult,
  maxTurns: 24,
  maxOutputChars: 32768
});
```

任务调度、触发与持久化仍由调用方负责。工具 schema、executor、guard 必须来自可信控制面配置，不能从 Issue/PR/模型结果直接生成权限。默认 tool loop 有轮数和输出上限，单条消息的工具调用数量不设上限，请求大小由上面的省略机制控制；它只执行已公布工具，且每次工具/模型调用前检查 guard。Pi adapter 保留原来的无总轮数限制行为。

项目通过 [Manager 与工作类型](workflows.md)配置任务：事件由项目 Manager 分派，提示词、工作类型的开关、写入和模型都保存在控制面。读取对所有工作类型开放，写入按工作类型在项目配置里勾选，并配置成平台工具；Manager 只能为单个任务收窄写入。工具、执行器和 guard 仍由可信代码按保存的配置生成，不能从 Issue、PR、仓库文件、Manager 提示词或模型结果取得权限。`task_models` 按工作类型 id 选择模型，`manager` 是分派调用的模型，见[开发说明](development.md#按任务选择模型)。

## 权限与隔离

显式 capabilities 分开声明本地读取、修改、笔记、shell、GitHub 只读范围、远端发布和是否可以启动独立 agent，每次任务由控制面按工作类型给出：读取、笔记、shell、全部 GitHub 只读范围和独立 agent 对所有工作类型开放，修改工作区和每种写入只给项目配置里勾选了它的工作类型，远端写入只经受控 publisher 和 `github_write`；`github_write`、`rerun_failed_run`、`report_failure` 经 runner 的仓库工具邮箱交给控制面执行。不再从工具列表是否出现 `create_pull_request` 推断写权限；没有的能力对应的工具不提供，runner 和控制面也各自拒绝。

`start_agent` 启动独立 agent：新会话的系统提示是固定说明加调用方写的角色说明，第一条消息是任务，不带调用方的消息；工具是调用方工具按收窄后的权限过滤出的子集，不含发布、结束任务和再启动 agent。Pi 在同一进程里另建会话，模型请求经同一个邮箱逐个转发；默认 tool loop 用 `AgentSpec.agents` 另起一组消息。检视的 GitHub token 只有读权限。开发也只向 shell 发放短期 GitHub 读 token；写 PR/推送由已有受控 publisher 执行。发布的写操作由既有状态机和授权控制，运行中的 Agent 不持有可任意写 GitHub 的凭据。

这是有意保留的安全边界：能力检查限制工具调用，不是任意 shell 的 OS 级只读沙箱。检视可运行测试，测试可能修改本地工作区，但不能因此获得 GitHub 写权限。项目电脑的网络与容器隔离仍依赖原 manager/runner 配置。

每次 `runAgent` 固定选择的模型及版本；请求前重新检查其项目授权、凭据和版本。变更/删除/撤销授权会停止，不能静默切换到默认或另一模型。任务映射仅改变后续运行。并发运行各自持有 spec、模型与消息上下文，不共享可变模型选择。

同一检视任务在发布前因新讨论恢复时，继续使用本轮固定的模型快照；新任务重新解析模型映射。模型快照只保留在控制面内存，不随检视会话历史持久化。

## 验证

新增测试覆盖任务模型 API/迁移/回退与失效、显式 capability、统一调用/模型计费/并发、流式授权检查，以及 CI 和发布说明回归。真实 Docker/Pi 集成仍须运行 `npm run test:agent`，单元测试不能代替容器端到端验证。
