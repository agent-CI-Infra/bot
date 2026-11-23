# 部署、升级与运维

本文面向部署和运维 launchpad 的管理员，涵盖 Docker Compose 上手部署、源码构建、版本发布与生产自动部署、常用环境变量、备份恢复、存储与工具卷运维及故障排查。服务拓扑与隔离设计见 [系统总体架构与安全边界](../design/architecture.md)。

## 1. 准备与快速启动

### 前置条件

- **Docker Engine** 与 **Docker Compose v2**（使用助手电脑 HOME 卷 subpath 挂载需要 Docker Engine API 1.45+）
- 一个用于创建和安装 GitHub App 的 GitHub 组织或账号
- 一个公网 HTTPS 域名（控制台、登录、回调与 Webhook 共用唯一入口），支持自建 HTTPS 反向代理或内置 Cloudflare Tunnel
- 至少一个兼容 Chat Completions 的模型端点与 API Key

### 启动已发布镜像（推荐）

无需克隆仓库，直接下载 [`docker/compose.yaml`](../../docker/compose.yaml) 启动：

```sh
mkdir department-bot && cd department-bot
curl -fsSLO https://raw.githubusercontent.com/agent-CI-Infra/bot/main/docker/compose.yaml
docker compose up -d
```

启动后访问 `http://127.0.0.1:8791/`（远程服务器先执行 `ssh -L 8791:127.0.0.1:8791 <服务器>`）创建首位超级管理员，并按 [系统初始化](onboarding-and-access.md#2-系统初始化仅超级管理员) 完成七步配置。

### 从源码构建

如需验证未发布改动或无法拉取 GHCR 镜像，在仓库根目录叠加 [`docker/compose.build.yaml`](../../docker/compose.build.yaml)：

```sh
# 独立运行（以 docker/ 为 Compose 项目目录）
docker compose -f docker/compose.yaml -f docker/compose.build.yaml up -d --build

# 沿用仓库根目录为项目目录与 .env 基准
BOT_BUILD_CONTEXT=. docker compose --project-directory . -f docker/compose.yaml -f docker/compose.build.yaml up -d --build
```

四个核心镜像与对应服务：

| 镜像 | 用途 | Compose 服务 |
| --- | --- | --- |
| `ghcr.io/agent-ci-infra/bot-control-plane` | 控制面、密钥初始化与入口网关 | `bot`、`key-init`、`webhook` |
| `ghcr.io/agent-ci-infra/bot-computer-manager` | 管理动态项目电脑与助手电脑（唯一挂载 Docker socket） | `manager` |
| `ghcr.io/agent-ci-infra/bot-project-computer` | 项目电脑与助手电脑批准基础镜像（预装工具链、Chromium 与 X11 虚拟桌面） | `project-image` |
| `ghcr.io/agent-ci-infra/bot-cloudflare-tunnel` | 可选 Cloudflare Tunnel 连接器 | `tunnel` |

## 2. 端口与常用环境变量

控制面只暴露单一业务端口（容器 `8791`，默认仅绑定宿主机 `127.0.0.1:8791`）。在 `compose.yaml` 同目录 `.env` 中配置后重新 `docker compose up -d` 生效：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BOT_IMAGE_TAG` | `latest` | 固定镜像标签，如 `v0.4.8` 或 `sha-<12 位提交>` |
| `BOT_PORT` | `8791` | 业务端口的宿主机映射端口 |
| `BOT_BIND_ADDRESS` | `127.0.0.1` | 宿主机绑定地址；反向代理在另一台机器时才改为 `0.0.0.0` 并配防火墙 |
| `BOT_PUBLIC_ORIGIN` | 空 | 统一公网 HTTPS 入口（如 `https://bot.example.com`，不含路径）；同时作为合法写 Origin |
| `BOT_COOKIE_SECURE` | `false` | 设为 `true` 强制 Secure Cookie（经 HTTPS 访问也会自动启用） |
| `BOT_PROJECT_EGRESS` | `true` | 设为 `false` 关闭项目电脑默认外网出口 |
| `BOT_COMMAND_TIMEOUT_MAX_SECONDS` | `600` | 模型命令显式超时的统一上限（秒，1–2147363） |
| `BOT_MENTION_NAMES` | `bot,agent-ci-infra-bot` | 评论中 `@` 触发检视的名字（逗号分隔，`off` 关闭） |
| `BOT_OBSOLETE_FAILURE_DAYS` | `7` | 临时/平台类失败自动移出「待处理」的天数 |
| `BOT_TRUSTED_PROXIES` | 空 | 密码登录限流信任的代理 IP/CIDR（逗号分隔；仅填受控代理，切勿填 `0.0.0.0/0`） |
| `BOT_FORWARD_PRIVATE_HOSTS` | 空 | 外部执行端允许 Webhook 转发的内网主机名白名单（逗号分隔，不支持通配符） |
| `BOT_AGENT_TOOLS_DIR` | `/opt/agent-tools` | 非 Compose 启动时可指定的控制面工具卷目录。标准 Compose 固定在 `/opt/agent-tools` 挂载该卷，项目电脑只读挂载 |
| `BOT_AGENT_TOOLS_AUTO_INSTALL` | `1` | 设为 `0` 关闭控制面启动时后台自动安装工具卷默认版本（仅由 `src/main.ts` 触发；设为 `0` 后仍可在控制台按 Agent 手动安装） |
| `BOT_ACP_PRODUCT` | `container_acp` | 可在 Compose 的 `.env` 中设置。控制面按此标识从工具卷读取产品及其选定版本 |
| `BOT_HOST_STORAGE_DIR` | 空 | 可选宿主机整机磁盘采样目录（配合 `scripts/host-storage.py` 定时写入） |
| `BOT_GITHUB_API_URL` | `https://api.github.com` | GitHub API 地址 |
| `BOT_GITHUB_OAUTH_CLIENT_ID` / `_SECRET_FILE` | 空 | 未在向导保存 GitHub 登录配置时的部署级 OAuth 默认值 |
| `BOT_NOTES_RECLAIM_*` / `BOT_NOTES_ORPHAN_*` | 见源码默认 | 删除项目后孤儿笔记卷重试回收与 `/readyz` 告警阈值 |

> 若从早期双端口（`8791` + `8792`）部署升级，将 `BOT_WEBHOOK_PORT` 改为 `BOT_PORT`、`BOT_ADMIN_ORIGIN` 改为 `BOT_PUBLIC_ORIGIN` 并删除 `BOT_ADMIN_PORT`，反向代理统一转发到 `8791`，并在 OAuth App 与仓库 GitHub App 同步更新回调地址。

## 3. 日常升级、版本发布与服务器自动部署

### 日常手动升级

```sh
docker compose pull
docker compose up -d
```

> `docker compose down` 会保留数据卷；**切勿在日常升级或维护时执行 `docker compose down -v`**，否则会删除主密钥、数据库和账本。

### 标签发版与自动化部署（`release.yml`）

在 `main` 最新已构建镜像的提交上推送 `v*` 标签（如 `git tag v1.2.0 origin/main && git push origin v1.2.0`），[`.github/workflows/release.yml`](../../.github/workflows/release.yml) 会依次完成：

1. 校验该提交位于 `main` 并等待对应 `sha-<12 位提交>` 镜像发布完成；
2. 不重新构建，直接为四个镜像追加版本标签；
3. 创建 GitHub Release（带预发布后缀如 `-rc.1` 自动标记为 Pre-release）；
4. 若仓库 `production` Environment 配置了部署变量（`DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_PATH`、`DEPLOY_KNOWN_HOSTS`、`DEPLOY_SSH_KEY` 及可选跳板机 `DEPLOY_JUMP_*`），则经 SSH 自动发布：写入对应版本的 `compose.yaml` 与 `.env` 中的 `BOT_IMAGE_TAG`，清理中断残留的替换容器后拉取并重建服务。

**服务器超时前提与容错边界**：

- 目标服务器必须安装 **GNU coreutils 的 `timeout`**（需支持 `15m`/`35m` 等时长后缀，缺失会以退出码 `127` 失败）。
- 远端命令限时：`docker compose pull` 最多 **15 分钟**，`docker compose up -d --force-recreate` 最多 **35 分钟**（覆盖 manager 最长 30 分钟启动宽限），随后等待 `bot` 健康检查最多 **85 分钟**（包含启动时数据库压缩耗时），全部计入 Deploy 步骤的 145 分钟预算内。
- 超时后先发 `SIGTERM`，30 秒宽限期未退出再发 `SIGKILL`：正常超时退出码为 **`124`**，触发宽限期强杀退出码为 **`137`**。部署中断或失败排查后，在 Actions 中对该 Release 运行直接 **Re-run failed jobs** 即可幂等恢复。
- 可通过 Actions → Release → Run workflow 手动运行只读 SSH 连通性预检（不发版、不改容器）。

## 4. 数据卷、备份与存储维护

### 关键数据卷

| 卷名 | 内容与重要性 |
| --- | --- |
| `bot-data` | 控制面 `control.sqlite`、轨迹文件 `trajectories/`、共享 `blobs/`、Git 镜像缓存、公开看板快照、飞书加密附件 `channel-resources/` 与历史浏览器证据 |
| `bot-keys` | AES-256-GCM 加密主密钥（**丢了主密钥将无法解密任何已存凭据**） |
| `internal-keys` | 控制面与 manager 内部认证材料及部署 ID 种子 |
| `manager-data` | `manager.sqlite`、manager 轨迹与项目笔记卷元数据 |
| `assistant-homes` | 群聊与管理助手电脑的持久 HOME，承载助手私有长期记忆（`~/memory/`）与跨轮个人/群文件（须纳入一致备份） |
| `agent-tools` | 受信任的第三方容器 Agent 统一工具卷（Claude Code、Codex、iCode、WorkSwarm 及其受管 Node / `uv` 运行时与版本清单；内置 Pi 不在此卷）。各版本可并存 |
| `tunnel-keys` | Cloudflare Tunnel token 文件 |

### 备份与恢复要点

- **停写一致备份**：备份前先停止 `bot` 和 `manager`，保持 `control.sqlite`、`trajectories/`、`channel-resources/`、`bot-keys`、`internal-keys`、`manager-data` 与 `assistant-homes` 来自同一次停写。
- **知识卷恢复（`note_move_uncertain`）**：若项目知识文件因异常移动进入 `note_move_uncertain` 只读保护，切勿手工删除 `.write-history` 里的 pending journal、改 file ID 或直接降级镜像。标准恢复步骤：① 停止该项目的任务派发、项目电脑与访问该卷的 manager 操作；② 对当前整个笔记卷（含 `.write-history`、历史索引与 blob）做只读备份；③ 选取移动前停写状态下生成的整卷备份，在同版 manager/runner 隔离环境中验证目录、正文与历史可读；④ 在停写状态下用验证过的完整备份替换原卷（备份后的新增改动对照第 ② 步通过正常保存接口补录）；⑤ 恢复同版服务并验证读正常后再开放写入。
- **全局存储与按天数清理（「全局设置 → 存储」）**：超级管理员可查看整机/Launchpad/项目空间占比，配置轨迹文件、manager 重复正文（默认 2 天）、已完成/失败任务工作区（默认 1 天 / 7 天）和 Webhook 正文的保留天数，并按需触发「立即回收」；项目电脑区域同步列出各未结束任务当前持有的工作区目录数（区分在用与待清理目录），便于定位长时间循环的任务；飞书群聊与私聊记录的保留天数及手工清理在「飞书会话」页（`#/conversations`）按会话配置（仅超管），存储页做汇总展示。
- **Agent CLI 工具卷（「全局设置 → Agent CLI 工具卷」）**：仅超管可用，统一管理除内置 Pi 外的所有第三方容器 Agent（`Claude Code`、`Codex`、`iCode`、`WorkSwarm`；通用 `container_acp` 仅做只读说明展示）：
  - **启动自动安装**：控制面启动时（`src/main.ts`）会在后台无阻塞检查工具卷，对尚未安装兼容版本且未被手动删除的 Agent 自动下载并校验 SHA-256 安装默认版本；失败原因与指数退避重试时间持久化保存在工具卷 `.state.json`，设置 `BOT_AGENT_TOOLS_AUTO_INSTALL=0` 可关闭自动安装。
  - **按 Agent 安装 / 升级 / 删除**：页面按 Agent 分别提供「安装」「升级」「删除」按钮及按版本删除入口。运行中任务或角色会话正在使用的版本（含 Node/`uv` 运行时）受保护，修改或删除会返回 `409 agent_tool_version_in_use`；整项删除或删除最后一个版本会写入「已手动删除」标记，重启后不再自动重装，手动点击「安装」可恢复启用。
  - **WorkSwarm 隔离构建**：控制面下载并校验 `pyproject.toml`、`uv.lock` 与官方 wheel 摘要后，委托 `manager` 启动一次性隔离容器（仅挂载 `agent-tools` 卷，不接触主密钥、数据库或 `control` 网络）使用工具卷中的 `uv` 构建 Python 3.13.18 虚拟环境。

### 容器内 ACP 产品说明与离线安装兜底

常规部署可直接通过启动自动安装或在「全局设置 → Agent CLI 工具卷」一键安装/升级/删除 iCode 与 WorkSwarm；离线或无外网环境仍可使用 `scripts/install-acp-product.mjs` 作为兜底脚本。

#### iCode

默认由控制面从官方 GitHub Release 下载并核对本架构 SHA-256（v0.36.0 对应上游提交 `78802f87d07f053fe560d680e4696c2bf322e2c2`）。离线包自带 Python 运行时：

| 架构 | 资产 | SHA-256 |
| --- | --- | --- |
| x86_64 | `icode-linux-x86_64-v0.36.0-offline.tar.gz` | `3688097aaa6fd2a6eed530e19fb6046a0e6d8d58ace4b07d8490bea18cef2e00` |
| aarch64 | `icode-linux-aarch64-v0.36.0-offline.tar.gz` | `3212c67b84d58eea1d515ce0b13e73e6efac5fbeb6ed7804ccee13cfc5a7865e` |

离线手动安装命令（在与项目电脑同架构且可写挂载 `agent-tools` 的容器中执行）：

```sh
node scripts/install-acp-product.mjs install --product icode --version 0.36.0 --archive ./icode-linux-x86_64-v0.36.0-offline.tar.gz
node scripts/install-acp-product.mjs select --product icode --version 0.36.0
```

升级时在控制台点击「升级」或安装平台已核验并记录哈希的新版本；不再需要时点击「删除」即可移除。安装状态可在「全局设置 → Agent CLI 工具卷」与项目「角色配置」的后端可用性中查看，角色后端选用「iCode」。

如果项目电脑内的 iCode 不满足 ACP 握手要求，任务会暂停并等待处理。核对工具卷中选用的版本，重新安装受支持的离线包，然后重试任务。

v0.36.0 已在 x86_64 Docker 项目电脑验证。平台仅提供 HTTP MCP 和平台模型中转，iCode 的交互式人工回答、stdio / SSE MCP、供应商订阅、仓库钩子及仓库自带 MCP 配置均不可用。项目角色选择 iCode 后使用该角色当前的文件和命令权限。实际模型与用量由运行记录和模型账本记录。

#### WorkSwarm

WorkSwarm `0.2.9` 固定至上游提交 `453dce3054babf7f3a7000c8e57e068de01d8d2e`，使用工具卷托管的 `uv` `0.13.9` 管理 Python `3.13.18`（[发布资产](https://github.com/openJiuwen-ai/jiuwenswarm/releases/tag/v0.2.9) · [锁文件](https://github.com/openJiuwen-ai/jiuwenswarm/blob/453dce3054babf7f3a7000c8e57e068de01d8d2e/uv.lock)）。常规部署下控制面自动下载并校验三文件合并摘要、官方 wheel SHA-256（`241ed07f9a23f989984b68474e2b5147ad6907323c92fb8d139be8da6705130f`）与 `uv.lock` SHA-256（`5db141a6503cc93fa27d6defc3a97aed121e3fbc65ea2d395789956680f48c6e`），再经 `manager` 一次性隔离容器完成虚拟环境构建。

离线手动安装兜底（目录中仅放该提交的 `pyproject.toml`、`uv.lock` 与 `workswarm-0.2.9-py3-none-any.whl`；若已有兼容的 Python `3.13.18` 可附加 `--python-executable`）：

```sh
node scripts/install-acp-product.mjs install --product workswarm --version 0.2.9 --source ./workswarm-release
node scripts/install-acp-product.mjs select --product workswarm --version 0.2.9
```

项目「角色配置」中可选 WorkSwarm，并查看已安装和当前选用版本。模型使用 Chat Completions 或 Anthropic Messages。容器内运行时会核对 ACP 握手报告版本。Gateway 0.1.0 启动时会启动定时调度器，平台不预置定时任务，Gateway 的创建接口仍可用且新建任务默认启用。

#### 通用 Python 产品（`container_acp`）

通用 `container_acp` 不对应固定上游发行包，在工具卷管理页仅以只读说明展示，继续通过 `scripts/install-acp-product.mjs` 离线维护：

1. 在与项目电脑架构和系统兼容的独立 Linux 安装环境中，准备 `uv`、可信产品源码或发行包内容，以及固定 Python 补丁版本和依赖锁的预设。以可写方式将本部署的 `agent-tools` 卷挂载到 `/opt/agent-tools`。项目电脑使用同一卷的只读挂载。
2. 用 `node scripts/install-acp-product.mjs hash-source --source ./product-source` 核对预设中固定的源码摘要，再运行 `node scripts/install-acp-product.mjs install --product container_acp --version 1.0.0 --source ./product-source --preset ./preset.json` 安装并选定该版本。预设字段与锁文件格式见 [ACP 产品安装设计](../design/agent-and-harness-runtime.md#安装-python-产品)。
3. 用 `node scripts/install-acp-product.mjs select --product container_acp --version 1.0.0` 切换到已安装版本。新的运行读取选定版本，在途运行继续使用已绑定版本。只有在确认旧版本已取消选定且没有在途运行使用它后，才运行 `node scripts/install-acp-product.mjs remove --product container_acp --version <旧版本>` 清理。

## 5. 故障排查速查

- **任务失败或等待**：优先查看控制台任务详情页的「原因分类」与时间线（明确区分外部波动、GitHub 权限、模型配置、项目电脑、仓库内容与 Bot 自身故障）。
- **GitHub 限流**：在「全局设置 → 机器人账号 → GitHub 请求额度」查看每个安装与 Token 账号的剩余配额与重置时间（限流等待不消耗重试次数）。
- **服务日志与健康检查**：
  ```sh
  docker compose -p bot logs --since 1h bot       # 控制面：事件循环卡顿 [stall]、慢 SQL [slow-sql]、对账与任务异常
  docker compose -p bot logs --since 1h manager   # 虚拟电脑：Docker 失败、恢复失败与资源异常
  ```
  控制面 `/healthz` 检查数据库健康，`/readyz` 额外核对 manager 连通性与孤儿笔记卷阈值。
