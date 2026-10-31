# 接入指南：把一个代码仓交给部门 bot

这份文档面向**使用 bot 的仓库维护者**：从"我有一个代码仓"到"门禁、单仓看板、公共 Dashboard 都接好了"，全部流程和需要你亲手做的几步。

---

## 访问入口

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| **管理面（控制台）** | https://agent-ci-infra-bot-admin.llmbots.co/ | 启动项目、跑一键接入、管理用户与仓库授权 |
| **公共 Dashboard** | https://agent-ci-infra.github.io/dashboard/ | 看所有已登记仓库的门禁与时延等指标 |
| **单仓看板** | `https://agent-ci-infra.github.io/dashboard/boards/<owner>/<repo>/` | 单个仓库的看板，`<owner>/<repo>` 用小写 |
| **GitHub App 安装页** | https://github.com/apps/agent-ci-infra-bot/installations/new | 把 bot 安装到你的账号/组织 |

### 管理面怎么登录

1. 打开 https://agent-ci-infra-bot-admin.llmbots.co/ ；
2. 如果出现 Cloudflare Access 的验证页，先填**你的邮箱**，收邮件验证码完成验证（这一步是网关鉴权，不是 bot 账号）；
3. 进入控制台登录页后，用管理员分配的**用户名 + 密码**登录；
4. 首次部署时首页会显示「创建第一名超级管理员」，由部署者初始化，之后这里只提供登录。

登录后顶部导航里有「接入向导」和各个列表页；普通使用者通常是**项目管理员**，只看到分配给自己的仓库，超级管理员能看到全部。

> 忘记密码或需要账号，找超级管理员在「用户管理」里重置或新建；控制台的写操作需要登录会话，长时间无操作后会要求重新登录。

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

私有仓库的接入项和公开仓完全一样，只是 dashboard 需要一份**只读令牌**才能读到私仓数据。这件事由 dashboard 维护者做一次：

**① 建一个只读 fine-grained token**

1. 打开 https://github.com/settings/personal-access-tokens/new
2. 填写：
   - **Token name**：`dashboard-private-source`
   - **Expiration**：按团队策略选（到期需要换新）
   - **Resource owner**：**必须是有那个私仓的账号或组织**（私仓属于个人就选个人，属于组织就选组织）——选错了 token 完全看不到该仓
3. **Repository access** 二选一：
   - `Only select repositories`：勾上每个要接的私仓。**每新增一个私仓都要回来补勾**，否则采集会报“读不到源仓”；
   - `All repositories`：以后新私仓自动可用，权限仍然只有下面两项只读。
4. **Permissions → Repository permissions** 只开三项：
   | 权限 | 值 |
   | --- | --- |
   | Contents | Read-only |
   | Actions | Read-only |
   | Metadata | Read-only（勾上面两项后自动带上） |
5. 点 **Generate token**，复制 `github_pat_...`（只显示一次）

**② 存进 dashboard 仓库**

1. 打开 https://github.com/agent-CI-Infra/dashboard/settings/secrets/actions
2. **New repository secret**
3. Name 填 `PRIVATE_SOURCE_TOKEN`（大小写必须一致），Secret 粘贴上一步的值，保存

**③ 以后加新的私仓时**

只改 token 的 `Repository access` 勾选（或保持 `All repositories`），点 **Update** 即可，**不需要**重新生成 token，也不需要改 dashboard 的 secret——改动立即生效。

**④ 常见失败提示**

| 提示 | 原因 | 处理 |
| --- | --- | --- |
| `dashboard_private_token_missing` | dashboard 没有这个 secret，或值无效 | 重做 ①②，确认名字拼写 |
| `PRIVATE_SOURCE_TOKEN cannot read private source <repo>` | token 的 `Repository access` 没勾这个仓，或 resource owner 选错、已过期 | 回到 token 设置页补勾/改正，或重新生成 |
| 看板 404 | 分支刚建、Pages 还在部署 | 等 1–2 分钟再刷新 |

> 用经典 PAT（勾 `repo`）也能跑通，但它能读你名下所有仓库，权限过大；仅在临时排查时使用，用完换成 fine-grained token。

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
