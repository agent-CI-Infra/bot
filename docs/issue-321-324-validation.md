# C 场景整改：#321、#323、#324

基线：`a4f82c5`。本次没有实现已撤回的 #322 独立恢复改造。

## 修改

- **#321**：失败、阈值汇报与 Manager 决策复用 `task_history`。累计第3/6/9次失败尝试汇报（沿用现有 retry_count 的口径：初次失败为1）；相同任务/操作组跨 session、SHA 和重启累计，成功恢复后结束一轮。同一次失败回执不重复计数。保留受限 Git stderr；Manager 能从既有历史/记录工具读取失败和 CI job 的步骤、日志。Manager 可继续重试或返回正常团队调查修复；通知失败不覆盖原错误或要求人工审批。
- **#323**：已发布候选被 QA return 后，复用原有恢复引用和 Manager/Dev 流程继续修订。已退回候选不再走 clean-integration 快捷发布；保留原 PR，并为修订使用已有 Publisher 的独立操作 key，避免复用旧写入回执。没有移除 QA、合入检查或新增自动合入授权。
- **#324**：QA 同时识别既有 `input.context.context_files` 路径数组与旧顶层文件映射。明确派生合同是摘要，原始需求的行为/边界约束仍适用；使用原有文件读取、证据分页和调用记录，没有新需求库或读取审批闸门。

## 受控回归

`npm run check` 通过；完整 `npm test -- --jobs=4` 为 **1326/1326通过，零失败、零跳过**。最终相关四组回归另跑 **90/90通过**；冲突标记用例进一步以真实文件内容校验 QA 的退回理由。

相关测试文件：`retry-reports.test.mjs`、`integration-engine.test.mjs`、`retry-recovery.test.mjs`、`task-acceptance.test.mjs`。

- 持久化3/6/9计数、重复回执、重启/新SHA不清零，恢复后同目标重新失败可重新计数。
- Native 工具循环读取失败及 CI job 原始记录后分别选择 continue_retry/investigate；调查决定在后续尝试中仍有效，直至新决定或成功恢复。
- 真实 Git 索引锁注入，使 finalize 返回包含具体 index.lock 原因的 Git stderr。
- 三次失败 CI 集成后，Manager 可以继续自动集成，也可以转入 Dev 修复；前两次保持原自动路径。
- 已有 PR 的集成候选被 QA 退回后，重新进入 Manager/Dev，重新验收、更新同一个 PR，再沿已有授权合入。Git、Runner、SQLite 与 Publisher 为真实实现，模型/GitHub 响应为夹具。
- QA 收到正确的原始 Issue 路径，并通过实际 read_file 工具读到明确验收条件；兼容父任务和旧文件映射，不产生 `../context/0` 等错误路径。

## 真实模型验证

### Manager 的两种选择

使用 `deepseek-v4.1-flash-1017` 的真实 Native Manager 和正式角色运行/工具协议；输入为记录下来的失败事实，GitHub 传输受控，不修改真实项目。

| 场景 | 模型请求 | 实际决定 |
|---|---:|---|
| runner 短暂连接中断，健康探测已恢复 ready，尚未开始写源码/采集 | 2 | continue_retry |
| 同类 CI 安装失败，读取 job 步骤和 `liblz4-tool` 无安装候选的日志 | 3 | investigate，建议修复 CI 安装环境 |

这证明 Manager 实际取得了信息并产生不同决策，不是由测试脚本指定真实模型的动作。

### 发布后 QA 退回的真实续修

`test/c-replay.live.test.mjs` 为手动启用的真实模型测试，不加入普通单元测试池。

- 初始 PR 和历史通过状态由夹具种入；后续 QA、Manager、Dev 均使用真实 Native 模型。
- QA 发现 `calc.cjs` 未满足 [0,2] 限幅要求并 return。
- Manager 读取缺口、委派 Dev；修复后新的 QA pass。
- 更新并合入同一个 PR，保留其他任务的 `other.txt`；没有修改任何真实 GitHub PR。
- 实际32次模型请求，3次验收入口调用（含1次种入的初始通过），2次分支发布、1次合入；用时约434秒。GitHub 为本地受控服务，Git、Runner、SQLite 和正式执行链真实。

### min_depth 的 Codex 复验

固定原 C 的错误 tree `a10c00105df19707d65c754f58da4dae535d3e69`、原始历史截止点、模型 `gpt-6.1-sol`、Codex CLI 0.166.0，每次新线程，无旧 QA 结论泄漏。

| 上下文 | 有效次数 | 结果 |
|---|---:|---|
| 原实验条件（整改前对照） | 10 | 10次错误 pass |
| 使用本次实际导出的文件索引修复，不加摘要说明 | 5 | 5次读取原文并识别 FR3，return |
| 文件索引修复 + 本次实际导出的摘要说明 | 5 | 5次读取原文并识别 FR3，return |
| 修正 min/max 归一化的评测用正确候选 + 修复后的上下文 | 1 | pass |

正确候选只在评测副本修正，未写回原实验仓库；其142项单元、5项集成、6项文档测试及 cargo check 已实际通过并绑定新树。一次连接中断和一次评测源缺基线引用的准备失败分别保留、排除并补跑，不计作业务 verdict。

上述样本验证该已知缺陷及上下文入口，不代表平台整体误判率，也不证明任意需求都会被正确验收。

本地原始记录：`bot-benchmark/runs/c-replay-development-001/` 和 `bot-benchmark/runs/ripgrep-001/qa-fixed-{paths,source-note,correct}-001/`。私有凭据与数据库未提交到仓库；这里只发布复现方式与汇总。

手动真实模型入口：设置 `BOT_C_REPLAY_RUNTIME`、`BOT_C_REPLAY_MODEL_DB` 和 `BOT_C_REPLAY_KEY` 后，以 Node 22 运行 `node --test --test-name-pattern='live C replay' test/c-replay.live.test.mjs`。路径指向操作人准备的独立评测数据库/运行目录；不把认证内容写进命令参数或报告。
