# 接入指南：把一个代码仓交给部门 bot

这份文档面向**使用 bot 的仓库维护者**：从"我有一个代码仓"到"门禁、单仓看板、公共 Dashboard 都接好了"，全部流程和需要你亲手做的几步。

---

## 访问入口

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| **管理面（控制台）** | https://agent-ci-infra-bot-admin.llmbots.co/ | 启动项目、跑一键接入、管理用户与仓库授权 |
| **公共 Dashboard** | <webhook 公网地址>/dashboard/ | 看所有已登记仓库的门禁与时延等指标 |
| **单仓看板** | `<webhook 公网地址>/boards/<owner>/<repo>/` | 单个仓库的看板，`<owner>/<repo>` 用小写 |
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
| 检查命令由仓库维护者配置 | 不要求已有 build 或 test 脚本；接入 PR 不按 `package.json` 代选检查命令 |
| 依赖有锁文件 | 有 `dependencies` 就要有 `package-lock.json` 等 |
| 没有 `.github/workflows/ci.yml` | 已存在则视为"已接入门禁"，不再覆盖 |
| 是公开或私有仓库 | 公开仓安装后自动提供看板；私有仓由超管在公共配置中本地启用后公开 |

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
| **门禁 PR** | 从 `CI-workflow` 复制门禁框架到你的仓库 | 分支 `bot/gate-onboarding-*` 上的 PR，含 `.github/workflows/ci.yml`、版本标签触发的 `.github/workflows/release.yml`、补充门禁 workflow、`.github/ci-gates.json`、`scripts/gate/gate.mjs`、锁文件 |
| **单仓看板** | 在 bot 本地启用公开快照，由 webhook 更新 | webhook 端口站点 `<webhook 公网地址>/boards/<owner>/<repo>/` |
| **Dashboard 登记** | 在 bot 本地启用仓库汇总 | `<webhook 公网地址>/dashboard/` |

三个项可以独立执行。公开仓在安装 App 后自动提供单仓看板与 Dashboard 汇总，不必执行看板项。私有仓只有超管明确执行其中任意一个看板项后，才会在这两类公开页面显示；执行前请确认可以公开仓库指标，预演不会启用。门禁 PR 不作为私有仓公开开关。

门禁 PR 同时就是发版本的接入示例，不另建示例仓库。`release.yml` 优先来自 `agent-CI-Infra/CI-workflow` 的 `template/.github/workflows/release.yml`，缺少时使用同样只运行 release 门禁 lane 的本地模板；`v1.2.3`、`v1.2.3-beta.1` 等标签会触发 Release Actions。框架不含 PyPI、npm 或镜像发布步骤。

`.github/ci-gates.json` 保留 `build`、`pr-ready`、`pr-merge`、`daily`、`release` 的 lane 名字，但 `commands` 留空。空 lane 能运行并生成 `not_applicable` 报告，只说明还没有配置检查，不表示实际检查通过。仓库开发者应填写各 lane 的检查命令，并决定是否在自己的 Release workflow 中增加 PyPI、npm 或镜像发布步骤。控制面只提供框架、在人确认版本和完整提交 SHA 后打标签；具体检查及发包行为均由该仓库自己的 Release Actions 执行。没有 build/test 脚本的 Node 仓库也能先接入框架。

使用时，先合并并配置门禁 PR，再到项目页「发版本」检查版本和目标提交。相对上一枚可达的合法版本标签没有新提交时，页面说明跳过，不能确认；没有上一枚标签则按首次发布处理。有新提交时，人确认后创建标签，仓库 Release Actions 成功后生成草稿，再由人点击「正式发布」。定时发版本和自动计算版本号不在当前框架范围内。

公开页面与原看板使用同一套字段、统计方法和版式，由 webhook 端口 8791 托管，无需控制台登录。管理端口 8792 的控制台看板保持原样，不提供 `/dashboard/` 和 `/boards/`。

### 2.1 私有仓库的一次性启用

私有仓安装 App 后仍不会出现在公共页面。超管在公共配置中明确执行「单仓看板」或「Dashboard 登记」后，bot 只在本地记录公开授权，使用该源仓的只读安装令牌采集，后续由已验证 webhook 更新。不需要外部 dashboard 仓、登记 PR 或 `PRIVATE_SOURCE_TOKEN`。以前在外部 dashboard 登记过的私有仓，升级后也需要在本地启用一次。未启用私有仓的单仓路径返回 404。

首次采集尚未完成时，页面或数据接口会提示等待；后台失败时保留上一次有效快照并退避重试。请先在安装向导验证 webhook 公网地址，接入结果才会生成这个入口上的稳定链接。

---

## 3. 需要你亲手确认的事项

自动化到"PR 开出来"为止，门禁检查内容和开发授权仍留给人把关：

1. **配置并合并门禁 PR**：由本仓库开发者填写 lane 检查命令，并决定 Release workflow 是否需要发布包或镜像；空命令 lane 仅为框架；
2. **确认私有仓快照是否可以公开**：需要公开时，由超管执行本地看板项；公开仓不需要这一步；
3. **给需要开发的 Issue 加 `bot-develop` 标签**：bot 只处理带这个标签的 Issue，这是"允许 bot 改代码"的唯一开关。

---

## 4. 接入之后会发生什么

```
你 push / 开 PR
  └─ CI 跑门禁（CI-workflow 的 workflow）
       └─ 上传 ci-gates-reports
            └─ 已验证 webhook → bot 后台采集 → 本地快照
                 └─ <webhook 公网地址>/boards/<owner>/<repo>/
```

- **检视**：你开 PR 后 bot 会自动检视并评论；也可以在 Issue/PR 里 @ 它再检视一次；
- **开发**：给 Issue 加 `bot-develop` 后，bot 会开分支改代码并回 PR；
- **看板**：已验证 webhook 触发后台采集，单仓快照和 Dashboard 汇总一起更新，不再部署 Pages。

---

## 5. 常见问题

**列表里"门禁未知 / 看板未知"？**
检查器会实时读你的仓库确认。出现未知通常是 App 没装到该仓库、或安装权限还没被批准。装/批之后点一次同步即可。

**"单仓看板"报缺少权限？**
看板采集仅使用源仓只读权限：Contents、Issues、Pull requests、Actions、Metadata。安装需要允许读取对应数据；不需要 Pages、Administration 或 Workflows 写权限。

**私有仓库能接吗？**
能。安装 App 不代表同意公开私有仓；超管在公共配置中本地启用看板后，快照才会公开，由 webhook 更新。无需配置额外 secret。

**想撤销某个项目的接入？**
控制台项目行的 **删除** 只清理本系统记录（仓库、策略、运行记录），**不会**卸载 App，也不会删除 GitHub 上的仓库。GitHub 侧请自行处理。

**接入失败了怎么排查？**
每个项都会显示失败原因和错误码（如 `app_permissions_missing`、`public_address_not_verified`、`collection_failed`），对着提示处理即可；也可以先跑一次预演看它想做什么。
