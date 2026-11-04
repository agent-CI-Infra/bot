# 共享 Agent 后端

## 边界

`src/agent/runtime.ts` 的 `runAgent(spec)` 是检视、开发、CI 观察和发布说明的共享执行入口。调用方提供 system/prompt、工具白名单、执行器、输出校验器和生命周期 guard；运行时不根据任务类型选择检查器，不绑定 pylint、语言或特定 CI。模型选择、凭据隔离、流式请求、90 秒无 token 超时、错误处理、脱敏和模型用量账本通过 `gateway.ts` 统一。

两种 transport 使用同一入口：

- 工作区任务使用 `loop.ts` 的 Pi mailbox adapter，在隔离项目电脑中读取文件、执行命令和产生修改。`profiles.ts` 组合内置检视/开发提示词、工具及显式 capabilities。
- `release.observe` 和 `release.notes` 使用运行时默认的 tool loop，在控制面调用有限工具或生成结构化结果。CI 观察仍只能读取指定 run/attempt/job，发布说明仍检查完整且不重复的来源 ID。

发布确认、幂等 outbox、发布状态机、仓库授权和 claim 是控制面的职责，不交给提示词决定。统一 Agent 不等于移除这些安全边界。

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

现有项目规则/行为文件可改变具体检查关注点和执行策略。`task_models` 管理 API 可按任意精确 task kind 选择模型，见[开发说明](development.md#按任务选择模型)。此版本没有新增“任意用户 YAML 动态注册全部任务/工具”的配置语言；添加新的工作区 profile 或 trigger 仍需要可信代码注册，而不需要复制模型后端。

## 权限与隔离

显式 capabilities 分开声明本地读取、修改、笔记、shell 和远端发布能力。不再从工具列表是否出现 `create_pull_request` 推断写权限。检视的 GitHub token 只有读权限。开发也只向 shell 发放短期 GitHub 读 token；写 PR/推送由已有受控 publisher 执行。发布的写操作由既有状态机和授权控制，运行中的 Agent 不持有可任意写 GitHub 的凭据。

这是有意保留的安全边界：能力检查限制工具调用，不是任意 shell 的 OS 级只读沙箱。检视可运行测试，测试可能修改本地工作区，但不能因此获得 GitHub 写权限。项目电脑的网络与容器隔离仍依赖原 manager/runner 配置。

每次 `runAgent` 固定选择的模型及版本；请求前重新检查其项目授权、凭据和版本。变更/删除/撤销授权会停止，不能静默切换到默认或另一模型。任务映射仅改变后续运行。并发运行各自持有 spec、模型与消息上下文，不共享可变模型选择。

同一检视任务在发布前因新讨论恢复时，继续使用本轮固定的模型快照；新任务重新解析模型映射。模型快照只保留在控制面内存，不随检视会话历史持久化。

## 验证

新增测试覆盖任务模型 API/迁移/回退与失效、显式 capability、统一调用/模型计费/并发、流式授权检查，以及 CI 和发布说明回归。真实 Docker/Pi 集成仍须运行 `npm run test:agent`，单元测试不能代替容器端到端验证。
