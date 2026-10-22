# 仓库自动化规则（#1）

公共 Bot 的 webhook、任务和审阅是通用的；PR 门禁、标签规范和合并队列是仓库策略。本目录把后者做成**框架 + 可插拔能力模块 + 仓库级配置**，避免为每个仓库复制一套 GitHub Actions。

## 结构

```
src/automation/
  types.ts      事件、动作、事实、模块接口
  config.ts     仓库配置的 schema、默认值、合并与校验
  repository-config.ts  仓库 YAML 文件加载（<owner>__<repo>.yml）
  registry.ts   内置模块清单（加能力 = 加一个模块）
  engine.ts     逐模块规划、去重、记录模块失败
  runner.ts     读取策略、规划并写入 automation_runs（执行器接口在此）
  modules/
    labels.ts       label-lint、pr-status
    gate.ts         ready 标签守卫、merge-gate 状态
    merge-queue.ts  合并队列
```

模块是**纯函数**：输入事件、仓库配置和调用方能核实的事实，输出动作列表；不访问网络，不写数据库。这样规则可以用固定事件回放测试，也不会因为某条规则写坏 GitHub 状态。

## 仓库级配置

每个仓库用一份 YAML 声明自己的标签、门禁、合并策略和 CI 阶段：`config/repositories/<owner>__<repo>.yml`（文件名里的 `/` 写成 `__`，例如 `Jianyu010__PPMA.yml`）。启动时加载；目录不存在表示没有仓库文件，全部使用平台默认值。文件名不合法、重复或字段拼错都会让启动失败，而不是带着错误配置运行。

```yaml
# config/repositories/Jianyu010__PPMA.yml
dry_run: true

labels:
  axes:                       # 标签轴：值不用写前缀，清单自动展开为 type/bug 等
    type: [bug, feature, docs]
    source: [user, ci, review]
    priority: [critical, high, medium, low]
    area: [api, runtime, storage]
    size: [s, m, l]
    status: [triage, claimed, blocked, needs-info]
    pr: [ready, hold, no-issue]
  manifest: [blocker]         # 不属于任何轴的单体标签
  lint:
    require: [type, source]
    exactly_one: [priority]
    triage: status/triage
  pr_status:
    ready: pr/ready
    no_issue: pr/no-issue

gate:
  ready_label: ready
  status: merge-gate
  required_checks: [check, hygiene]
  maintainer_roles: [admin, maintain]
  review_must_be_answered: true

merge:
  enabled: false
  oldest_first: true
  skip_labels: [pr/hold]

ci:
  stages:
    - id: check
      workflow: ci.yml
      runner_labels: [self-hosted, ppma-ci-cn-check]
      required: true
    - id: hygiene
      workflow: hygiene.yml
      runner_labels: [self-hosted, ppma-ci-cn-hygiene]
      required: true
    - id: review
      workflow: opencode-review.yml
      runner_labels: [self-hosted, opencode-review]
      required: false
```

YAML 是仓库的**基础配置**；`policies.automation`（JSON，通过 `PATCH /api/repositories/:id/policy` 的 `automation` 字段维护）仍会合并在其上，冲突时以 API 保存的值为准。补丁按字段合并，未知字段直接拒绝，避免拼写错误静默关闭规则。`ci.stages` 描述每个阶段的 runner 池；`required: true` 的阶段必须恰好覆盖 `gate.required_checks`，否则配置校验失败。配置目录可用 `BOT_REPOSITORY_CONFIG_DIR` 覆盖。

等价的 JSON 结构（API 存储形式）：

```json
{
  "automation": {
    "dryRun": true,
    "labels": {
      "enabled": true,
      "axes": { "type": ["bug"], "source": ["user"], "priority": ["high", "medium"] },
      "manifest": [],
      "lint": { "enabled": true, "require": ["type", "source"], "exactlyOne": ["priority"], "triageLabel": "status/triage" },
      "prStatus": { "enabled": true, "ready": "pr/ready", "noIssue": "pr/no-issue" }
    },
    "gate": {
      "enabled": true,
      "readyLabel": "ready",
      "status": "merge-gate",
      "requiredChecks": ["check", "hygiene"],
      "maintainerRoles": ["admin", "maintain"],
      "reviewMustBeAnswered": true
    },
    "merge": { "enabled": false, "method": "merge", "oldestFirst": true, "skipLabels": ["pr/hold"] },
    "ci": { "stages": [{ "id": "check", "workflow": "ci.yml", "runnerLabels": ["self-hosted"], "required": true }] }
  }
}
```

默认值在 `config.ts` 的 `DEFAULT_AUTOMATION`：`dryRun: true`，`merge.enabled: false`。

## 规划与执行

- webhook 落库的同一个事务里，`recordAutomation` 读取该仓库配置（策略行未保存过配置时用 YAML 文件）、跑全部模块，把计划写入 `automation_runs`（`dry_run`、动作、说明）。任何规则异常只记在该运行上，**不会让投递失败**。
- `GET /api/automation` 返回调用者有权限仓库的最近 100 条计划，管理页面可直接展示"本应做什么"。
- 真正的 GitHub 写入由 `runner.ts` 的 `ActionExecutor` 接口承接，并接入现有 outbox（与评论、Review、分支发布同一套对账规则）。在本 PR 中执行器尚未接线，所有运行都是 dry-run。

## 事实与 fail-closed

webhook 载荷里没有"检查是否全绿""当前用户是否 maintainer""是否有未回复的 finding"这些事实。模块通过 `AutomationFacts` 接收调用方核实过的结果：

- 事实**缺失**时不猜测：`ready` 标签守卫只把 `merge-gate` 置为 pending（拒绝通过），不会凭载荷做出放行决定。
- 事实齐全且任一条件不满足时，移除 `ready` 并留下一条按 head 标记的评论。
- 合并队列只接受调用方提供的候选列表；`merge.enabled` 未开启时模块不产生任何动作。

## 模块

| 模块 | 触发 | 动作 | 对应 PPMA |
|---|---|---|---|
| `label-lint` | `issues` | 缺 `type/*` `source/*` 或 `priority/*` 不唯一时加 `status/triage` 并 upsert 评论；满足时移除 | `label-lint.yml` |
| `pr-status` | `pull_request(_target)` | `ready_for_review` 加 `pr/ready`；转草稿或关闭时移除 | `pr-status.yml` |
| `gate` | `pull_request(_target)` | 新 head、改标题/正文、同步提交、转草稿时回 pending 并按需撤 `ready`；`ready` 被添加时验证 maintainer、草稿、冲突、必需检查和 finding 答复 | `gate.yml`、`ci_gate.py` |
| `merge-queue` | 有候选事实时 | 对 gate 绿、非草稿、无冲突、无 skip 标签的 PR 按旧到新计划 merge | `gate-queue.yml`、`ci_merge.py` |

## 新增一个能力

1. 在 `modules/` 新建文件，实现 `AutomationModule`（`id` + `plan`），只做规划。
2. 在 `registry.ts` 的 `builtInModules` 注册。
3. 如需要新的仓库开关，在 `config.ts` 的 schema、默认值和校验里加字段，在 `repository-config.ts` 的 YAML 字段映射里放行 snake_case 写法，并在 `management.ts` 的 PATCH 字段列表放行。
4. 在 `test/automation.test.mjs` 里用事件 + 事实固定行为，覆盖"事实缺失 → fail closed"。

## 信任边界

配置、标签清单和规则都只属于**控制面**：由拥有该仓库权限的项目管理员通过管理 API 修改，不从 PR head 读取。PR 内容只作为数据进入模块，模块不执行仓库代码，也不把事件文本拼进命令或 URL。
