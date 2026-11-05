# 共享 Agent 后端

## 边界

`src/agent/runtime.ts` 的 `runAgent(spec)` 是检视、开发、CI 观察和发布说明的共享执行入口。调用方提供 system/prompt、工具白名单、执行器、输出校验器和生命周期 guard；运行时不根据任务类型选择检查器，不绑定 pylint、语言或特定 CI。模型选择、凭据隔离、流式请求、90 秒无 token 超时、错误处理、脱敏和模型用量账本通过 `gateway.ts` 统一。

两种 transport 使用同一入口：

- 工作区任务使用 `loop.ts` 的 Pi mailbox adapter，在隔离项目电脑中读取文件、执行命令和产生修改。`profiles.ts` 把固定的硬限制和工作流提示词组合成系统提示，并按工作流保存的权限生成工具和显式 capabilities。
- `release.observe` 和 `release.notes` 使用运行时默认的 tool loop，在控制面调用有限工具或生成结构化结果。CI 观察与工作区任务共享仓库只读探索工具，发布说明仍检查完整且不重复的来源 ID。

发布确认、幂等 outbox、发布状态机、仓库授权和 claim 是控制面的职责，不交给提示词决定。统一 Agent 不等于移除这些安全边界。

## 触发上下文与仓库探索

Issue、PR 或 Actions 失败提供任务起点，不限制证据只能来自这一个对象。`src/agent/exploration.ts` 的 `RepositoryExplorer` 为 CI 观察、检视和开发提供同一套只读工具：

- `github_read`：读取当前仓库的目录、文件、Git tree、提交、其他 Issue/PR 与讨论、Actions 和检查信息。路径相对当前仓库，文件内容解码为 UTF-8，可用 `ref` 选择固定提交并按 API 分页读取列表。
- `github_search`：搜索当前仓库的 Issue 与 PR，支持 GitHub issue search 语法和分页；仓库范围由执行器固定并核对返回项。
- `read_job_log`：读取当前仓库任意相关 Actions job 的日志片段，保留 run、attempt、job 与行号；日志下载和脱敏也由执行器完成。

先调用 `github_read_token` 建立只读访问。令牌只覆盖当前接入仓库，权限取安装已授予的内容、Issue、PR、Actions 等读取项；缺少权限时返回诊断，不回退到写令牌。CI 的令牌不离开控制面。Pi 的结构化读取工具通过任务邮箱调用同一个执行器；原有命令工具继续可使用同一次签发的只读令牌，真实凭据不进入模型上下文。任务结束、失败或中止后撤销签发的令牌。

Pi 在进程内串行执行 `github_read_token` 的令牌交换，控制面继续读取单个 `token-request.json`。活动或排队中的交换取消后及时返回 `github_read_token_cancelled`，后续调用可以继续；清理请求文件前核对请求 ID，避免删除其他调用的请求。`read_file`、发布与会话 boundary 不进入令牌队列。

升级时同步更新控制面、manager 和项目电脑镜像；Pi 的结构化读取使用新的 `workspace_agent_repository_tool` 邮箱操作，旧 manager/runner 不支持该操作。

Pi 在仓库工具内部串行使用邮箱，其他工具仍可并行执行。每个已进入邮箱的仓库请求最多等待 120 秒，超时返回 `repository_tool_timeout`；超时或取消后的迟到回复不会中断任务。共享执行器按现有 2 MiB 邮箱容量检查脱敏后 JSON 的 UTF-8 字节数，超出时向观察循环和 Pi 返回完整的 `repository_result_too_large` 工具错误。例如 `/git/trees/<sha>?recursive=1` 的结果无法投递时，模型应缩小 path、去掉 recursive 或继续分页，并用 page/per_page 减小每页结果；不会截断 JSON 后冒充成功结果。

2 MiB 是邮箱及观察循环的结果上限。Pi 还会在 `github_read`、`github_search`、`read_job_log` 的结果进入会话历史之前，使用同一 SDK 序列化包含当前历史与同轮已完成工具结果的下一次模型请求，并检查既有的 `estimateTokens({role:'user',content:raw,timestamp}) + 8192 > 128000` 条件。触及该上限的结果返回 `repository_result_too_large`，让模型缩小读取范围；放得下的结果原样返回，没有新增固定字节配额。序列化检查不会发起模型请求。

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

任务调度、触发与持久化仍由调用方负责。工具 schema、executor、guard 必须来自可信控制面配置，不能从 Issue/PR/模型结果直接生成权限。默认 tool loop 有轮数、输出和工具调用上限；它只执行已公布工具，且每次工具/模型调用前检查 guard。Pi adapter 保留原来的无总轮数限制行为。

项目通过[工作流](workflows.md)配置任务：触发源、提示词（含流程图）、权限和模型都保存在控制面，管理员在网页上新增的工作流不需要代码注册。工具、执行器和 guard 仍由可信代码按保存的权限生成；工作流只能在固定上限内选择，不能从 Issue、PR、仓库文件或模型结果取得权限。`task_models` 管理 API 仍可按任意精确 task kind 选择模型，内置工作流的 id 就是 task kind，见[开发说明](development.md#按任务选择模型)。

## 权限与隔离

显式 capabilities 分开声明本地读取、修改、笔记、shell、GitHub 只读范围、远端发布和是否可以启动独立 agent，取自工作流保存的权限，每次任务从存储读取。不再从工具列表是否出现 `create_pull_request` 推断写权限；没有的能力对应的工具不提供，runner 和控制面也各自拒绝。

`start_agent` 启动独立 agent：新会话的系统提示是固定说明加调用方写的角色说明，第一条消息是任务，不带调用方的消息；工具是调用方工具按收窄后的权限过滤出的子集，不含发布、结束任务和再启动 agent。Pi 在同一进程里另建会话，模型请求经同一个邮箱逐个转发；默认 tool loop 用 `AgentSpec.agents` 另起一组消息。检视的 GitHub token 只有读权限。开发也只向 shell 发放短期 GitHub 读 token；写 PR/推送由已有受控 publisher 执行。发布的写操作由既有状态机和授权控制，运行中的 Agent 不持有可任意写 GitHub 的凭据。

这是有意保留的安全边界：能力检查限制工具调用，不是任意 shell 的 OS 级只读沙箱。检视可运行测试，测试可能修改本地工作区，但不能因此获得 GitHub 写权限。项目电脑的网络与容器隔离仍依赖原 manager/runner 配置。

每次 `runAgent` 固定选择的模型及版本；请求前重新检查其项目授权、凭据和版本。变更/删除/撤销授权会停止，不能静默切换到默认或另一模型。任务映射仅改变后续运行。并发运行各自持有 spec、模型与消息上下文，不共享可变模型选择。

同一检视任务在发布前因新讨论恢复时，继续使用本轮固定的模型快照；新任务重新解析模型映射。模型快照只保留在控制面内存，不随检视会话历史持久化。

## 验证

新增测试覆盖任务模型 API/迁移/回退与失效、显式 capability、统一调用/模型计费/并发、流式授权检查，以及 CI 和发布说明回归。真实 Docker/Pi 集成仍须运行 `npm run test:agent`，单元测试不能代替容器端到端验证。
