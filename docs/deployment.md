# 部署细节

日常部署只需要仓库根目录的 `compose.yaml`，上手步骤见 [README](../README.md)。本文说明镜像、从源码构建、端口与环境变量、服务隔离和备份。

## 镜像

`main` 分支每次推送后，[`.github/workflows/images.yml`](../.github/workflows/images.yml) 构建并发布下列 `linux/amd64` 镜像，标签为 `latest` 和 `sha-<12 位提交>`；Pull request 只构建、不发布。

| 镜像 | 用途 | Dockerfile | Compose 服务 |
| --- | --- | --- | --- |
| `ghcr.io/agent-ci-infra/bot-control-plane` | 控制面：管理页、Webhook 接收、任务调度；也用来生成密钥和运行 Webhook 网关 | `Dockerfile` | `bot`、`key-init`、`webhook` |
| `ghcr.io/agent-ci-infra/bot-computer-manager` | 创建和运行各仓库的虚拟电脑，唯一挂载 Docker socket 的服务 | `manager/Dockerfile` | `manager` |
| `ghcr.io/agent-ci-infra/bot-project-computer` | 每台虚拟电脑的系统镜像（批准镜像） | `images/project/Dockerfile` | `project-image` |
| `ghcr.io/agent-ci-infra/bot-cloudflare-tunnel` | 可选的 Cloudflare Tunnel 连接器 | `tunnel/Dockerfile` | `tunnel` |

`webhook` 和 `bot` 用同一个镜像，但仍是单独的容器：只有它同时在 `control` 和 `edge` 两个网络，`tunnel` 只能经它连到 `bot:8791`。`compose.yaml` 使用 `latest`。manager 不拉取镜像，只检查 `BOT_PROJECT_IMAGE` 指向的本机镜像，所以它必须和 `project-image` 服务的镜像引用（含标签）完全一致；一次性的 `project-image` 服务负责让 Compose 把这个镜像拉到本机。

## 从源码构建

`compose.build.yaml` 只把镜像换成本地标签 `department-bot*:local` 并加上构建上下文，其余配置都来自 `compose.yaml`，所以两个文件一起使用：

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

需要验证未发布的改动、GHCR 包还没公开或者机器拉不到 GHCR 时用它。Compose 项目名取第一个文件所在的目录名，同一目录里在两种方式之间切换会沿用原来的卷；虚拟电脑在下次准备时换成新的批准镜像，工作卷和代次不变。以前在仓库根目录用 `docker compose up --build -d` 部署的实例，更新代码后如果只运行 `docker compose up -d`，会改为拉取已发布镜像；要继续从源码构建，就用上面的命令。

## 端口与环境变量

`8791` 是 Webhook 接收入口，宿主端口默认绑定 `0.0.0.0`，对所有 IPv4 网卡开放；`8792` 是管理页面和管理 API，仍仅绑定宿主回环地址 `127.0.0.1`，只在本机访问。公网域名整个转发到 `8791`：除了 GitHub Webhook 的 `/hooks/github/<account_id>/<endpoint_id>`，向导检查地址用 `/.well-known/bot-webhook-probe`，外部执行端兑换令牌也走这个入口。不要把两个监听端口混接。需要远程访问管理页面时，另行配置独立的 HTTPS 反向代理（与 Webhook 用不同域名），并设置 `BOT_COOKIE_SECURE=true` 和 `BOT_ADMIN_ORIGIN` 为自己的管理站 origin。管理 API 不开放跨域访问。

下列变量从启动 Compose 的 shell 环境或 Compose 文件同目录的 `.env` 读取，都不包含上游凭据：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `BOT_WEBHOOK_PORT` | `8791` | Webhook 的宿主端口，绑定 `0.0.0.0` |
| `BOT_ADMIN_PORT` | `8792` | 管理页的宿主端口，只绑定 `127.0.0.1` |
| `BOT_COOKIE_SECURE` | `false` | 管理页经 HTTPS 反向代理访问时设为 `true` |
| `BOT_ADMIN_ORIGIN` | 空 | 管理站的 HTTPS origin；创建 GitHub App 后 GitHub 也回调到这里 |
| `BOT_PROJECT_EGRESS` | `true` | 设为 `false` 时虚拟电脑没有外网出口 |
| `BOT_GITHUB_API_URL` | `https://api.github.com` | GitHub API 地址 |
| `BOT_FORWARD_PRIVATE_HOSTS` | 空 | 外部执行端允许转发到的内网主机名，逗号分隔，见[外部执行端](external-executors.md) |

## 服务、卷与隔离

Compose 包含长运行的 `bot`、`manager`、`webhook`、`tunnel`，以及一次性的 `key-init` 与 `project-image`。`key-init` 首次启动时生成主密钥和内部认证。`project-image` 仅确保批准的项目镜像已在本机 Docker 中（`compose.yaml` 拉取，加上 `compose.build.yaml` 时构建），不是某个仓库的长期环境。`tunnel` 在向导保存 Cloudflare Tunnel token 之前不连接任何账号；它只在独立的 `edge` 网络，经 `webhook` 网关固定转发到 `bot:8791`，不能连接管理端口。manager 按仓库创建动态项目容器，项目容器不属于 Compose 静态服务，不对宿主或公网发布端口。

`bot-data` 保存控制面 SQLite，`bot-keys` 保存加密主密钥，仅 bot 可读；`internal-keys` 保存 bot 与 manager 的内部认证，manager 不挂载上游凭据或控制面数据库。`manager-data` 保存环境和操作账本。`tunnel-keys` 只放 Cloudflare Tunnel token 文件。每个环境代次拥有独立具名工作卷和内部网络，标签同时绑定部署、仓库 ID、代次和资源类型。部署 ID 从独立内部认证材料派生，不同部署不会共用资源名。

只有 manager 挂载 Docker socket；它以 UID 0、GID 10001 访问 socket 和只读内部认证卷，丢弃所有 capabilities、禁止提权、根文件系统只读。Docker socket 本身仍赋予 manager 管理宿主 Docker 的能力，因此不对宿主发布 manager 端口，也不向项目网络提供该接口。它只接受登记项目的固定生命周期和 runner 请求，不能指定任意镜像、挂载、容器 ID 或 Docker API。bot 和项目容器没有 socket，项目容器也不挂载任何认证卷。bot／manager 使用独立控制网络，每个项目使用自己的 bridge 网络，项目之间互不可达。项目容器默认可以访问外网，用于安装依赖和访问测试地址；设置 `BOT_PROJECT_EGRESS=false` 可改回无出口的内部网络。外网出口意味着仓库代码也能访问宿主在 `0.0.0.0` 上发布的端口（例如 Webhook `8791`），管理端口只绑定回环地址，不受影响；GitHub 和模型凭据仍不进入项目容器。

## 备份与恢复

备份前停止 bot 和 manager，并备份四个部署卷及项目具名卷；数据库停止写入后再复制，恢复时使用同一套内部认证和管理账本。丢失主密钥会无法解密凭据，丢失内部认证会改变部署 ID，不能用新的空账本直接接管旧容器。`docker compose down` 保留卷；`--volumes` 会删除部署认证和账本，日常升级不要使用。动态项目资源需要通过环境接口管理，Compose down 不会直接删除它们。
