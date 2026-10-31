# 接入指南：把一个代码仓交给部门 bot

这份文档面向**使用 bot 的仓库维护者**：从"我有一个代码仓"到"门禁、单仓看板、公共 Dashboard 都接好了"，全部流程和需要你亲手做的几步。

---

## 0. 开始之前

| 你的仓库需要 | 说明 |
| --- | --- |
| 是 **Node** 仓库 | 根目录有 `package.json` |
| 有构建或测试脚本 | `scripts.build` 或 `scripts.test` 至少一个 |
| 依赖有锁文件 | 有 `dependencies` 就要有 `package-lock.json` 等 |
| 没有 `.github/workflows/ci.yml` | 已存在则视为"已接入门禁"，不再覆盖 |
| 是公开或私有仓库 | 两种仓库都能接门禁、单仓看板和 Dashboard 登记；私有仓库需要 dashboard 仓库一次性配置只读 secret `PRIVATE_SOURCE_TOKEN` |

另外，你需要在 GitHub 上有该仓库的管理权限，并且是控制台的超管（或找超管帮你点）。

---

## 1. 把仓库加入管理面

### 1.1 安装 GitHub App

打开安装页，选择你的账号或组织，勾选这个仓库：

```
https://github.com/apps/agent-ci-infra-bot/installations/new
```

> 这一步只能你本人做：GitHub 要求仓库所有者确认授权，别人代替不了。

装好后 GitHub 会跳回控制台。

### 1.2 同步到管理面

控制台仓库列表右上角点 **同步安装列表**（或让超管点）。

新仓库会以 `未启动` 出现，右侧有 `已移出安装` 之类的 badge 说明当前安装状态。

### 1.3 启动项目

在该行点 **启动**：

- 选择模型（决定后续检视/开发用哪个模型）；
- 决定是否打开 **开发** 开关（关掉的话 bot 只会检视，不会改代码）；
- 确认后这一行变成 `工作中`，`已启用`。

启动之后 bot 才会收这个仓库的 Issue / PR 事件。

---

## 2. 一键接入（自动化部分）

在项目行点 **公共配置**，里面有三个可以单独执行、也可以一次全部执行的项：

| 项 | 它做什么 | 产物 |
| --- | --- | --- |
| **门禁 PR** | 从 `CI-workflow` 复制门禁模板到你的仓库 | 分支 `bot/gate-onboarding-*` 上的 PR，含 `.github/workflows/ci.yml`、`.github/workflows/nightly.yml`、`.github/ci-gates.json`、`scripts/gate/gate.mjs`、锁文件 |
| **单仓看板** | 在 `agent-CI-Infra/dashboard` 触发 `Create board`，并触发首轮 `Collect board data` | 数据分支 `board/<owner>/<repo>`，站点 `https://agent-ci-infra.github.io/dashboard/boards/<owner>/<repo>/` |
| **Dashboard 登记** | 往 dashboard 提登记 PR（PR 写明公开/私有可见性） | 改 `config/gate-sources.json` 和 `config/internal-contributors.json` |

执行顺序建议：**门禁 PR → 单仓看板 → Dashboard 登记**。第三项依赖第二项（看板分支要先建好），前两项互不依赖。

公开仓库和私有仓库走同一套看板：分支都在 dashboard 仓库里，叫 `board/<owner>/<repo>`，不会在用户账号下新建仓库。私有仓库的看板分支只发布 `site/data/` 快照，不含源码或凭据；采集时由 dashboard 仓库一次性配置的只读 secret `PRIVATE_SOURCE_TOKEN` 读取源仓，不需要给每个源仓单独放 secret。

### 2.1 私有仓库的一次性准备

私有仓库不需要额外的接入项，只要求 dashboard 维护者提前做一次：

1. 在 `agent-CI-Infra/dashboard` 的 **Settings → Secrets and variables → Actions** 添加 repository secret `PRIVATE_SOURCE_TOKEN`；
2. 令牌只需能只读访问私有源仓（读取仓库内容和元数据），不要给它写权限；
3. 每个私有源仓共用这一个 secret，不需要逐仓配置。

没有配置时，「单仓看板」会以 `dashboard_private_token_missing` 停下；补上 secret 后重新执行该项即可。

点之前可以先点 **预演**：它只读不写，把每一步会做什么列出来，不产生任何改动。

每一项的结果会分别记录，互不影响：某一项缺权限只停它自己，其他项照常执行。

---

## 3. 需要你亲手做的三件事

自动化到"PR 开出来"为止，下面三件是刻意留给人把关的：

1. **合并门禁 PR**：合并后 CI 门禁才真正生效；
2. **合并 Dashboard 登记 PR**：合并后下一次采集，你的仓库才会出现在公共 Dashboard；
3. **给需要开发的 Issue 加 `bot-develop` 标签**：bot 只处理带这个标签的 Issue，这是"允许 bot 改代码"的唯一开关。

---

## 4. 接入之后会发生什么

```
你 push / 开 PR
  └─ CI 跑门禁（CI-workflow 的 workflow）
       └─ 上传 ci-gates-reports
            └─ dashboard 采集 → board/<owner>/<repo> 分支 → Pages
                 └─ https://agent-ci-infra.github.io/dashboard/boards/<owner>/<repo>/
```

- **检视**：你开 PR 后 bot 会自动检视并评论；也可以在 Issue/PR 里 @ 它再检视一次；
- **开发**：给 Issue 加 `bot-develop` 后，bot 会开分支改代码并回 PR；
- **看板**：`agent-CI-Infra/dashboard` 的 `Collect board data` 定时采集，数据更新后自动重新部署。

---

## 5. 常见问题

**列表里"门禁未知 / 看板未知"？**
检查器会实时读你的仓库确认。出现未知通常是 App 没装到该仓库、或安装权限还没被批准。装/批之后点一次同步即可。

**"单仓看板"报缺少权限？**
需要 App 拥有 `Workflows`（写）、`Administration`（写）、`Pages`（写），并且在**安装**里批准过这些权限。App 声明和安装批准是两层，两层都完成才生效。

**私有仓库能接吗？**
能，和公开仓库一样接门禁、单仓看板和 Dashboard 登记。区别只有一处：dashboard 仓库要一次性配置只读 secret `PRIVATE_SOURCE_TOKEN`，采集私有源仓时用它读取；看板分支仍然在 dashboard 仓库里，只发布 `site/data/` 数据。

**想撤销某个项目的接入？**
控制台项目行的 **删除** 只清理本系统记录（仓库、策略、运行记录），**不会**卸载 App，也不会删除 GitHub 上的仓库。GitHub 侧请自行处理。

**接入失败了怎么排查？**
每个项都会显示失败原因和错误码（如 `app_permissions_missing`、`dashboard_app_not_installed`、`dashboard_private_token_missing`、`board_not_ready`），对着提示处理即可；也可以先跑一次预演看它想做什么。
