# 外部执行端

当团队希望继续在**个人电脑**或 **GitHub Actions** 中运行自己的检视脚本/工具，同时借助 launchpad 统一验签分发 GitHub 事件并以 Bot 身份发表评论时，可启用「外部执行端」。该功能默认关闭，按项目按需开启。底层凭据代理与协议细节见 [外部执行端凭据代理与公开看板托管](../design/external-and-public-board.md) 及 [个人电脑兑换接口与 curl 示例](../external-token-api.md)。

## 1. 适用场景与前提

- **前提**：目标仓库必须通过 **GitHub App** 接入并授予 `Contents: read`、`Issues: write`、`Pull requests: write`（外部凭据兑换仅支持 GitHub App，绝不分发机器人账号长期 Token）。
- **与内置检视独立**：若只想使用外部检视，可保持仓库启用并将项目能力上限设为 `read`；转发订阅与内置检视互不冲突，也可同时开启。

## 2. 两种客户端认证方式

在目标项目的「项目设置 → 外部执行」中新增客户端（自动绑定当前仓库，不可跨仓复用）：

1. **个人电脑（公钥签名 `private_key_jwt`）**：
   - 在本机生成 2048–4096 位 RSA 密钥对，私钥始终留在个人电脑，仅将 SPKI PEM 公钥（`BEGIN PUBLIC KEY`）登记到控制台。
   - 兑换时用私钥签发 2 分钟内有效的 RS256 JWT，向 `<公网入口>/external/token` 兑换限定当前单仓的 GitHub App 安装令牌（权限固定为 `contents: read`、`issues: write`、`pull_requests: write`，不含代码写权限）。
   - 控制台项目「外部执行」页内置 4 步可复制短路径脚本及 **「复制给我的 AI agent」** 按钮，一键生成含客户端 ID、仓库 ID 和兑换/轮询地址的说明；详细 HTTP/OpenSSL/curl 示例见 [`docs/external-token-api.md`](../external-token-api.md)。
2. **GitHub Actions OIDC**：
   - 无需登记公钥，在客户端中配置精确的 audience、subject、工作流仓库/ID、组织 ID、workflow_ref 与分支 ref。
   - 仅接受 `schedule`、`workflow_dispatch`、`repository_dispatch` 与登记分支签发的 GitHub OIDC JWT（拒绝 PR 身份），每条 JWT 仅限单次兑换。

- **配额与撤销**：每客户端每小时最多兑换 20 次；使用完毕应调用 `POST /external/revoke` 及时撤销令牌。停用或删除客户端会立即阻止新兑换并取消待发送转发（已签发令牌需主动撤销或等待 1 小时到期）。

## 3. 获取 GitHub 事件的两种方式

- **Webhook 签名转发**：在项目「外部执行」创建转发订阅，指定接收 URL（默认仅允许公网 HTTPS，内网接收端需部署管理员通过 `BOT_FORWARD_PRIVATE_HOSTS` 显式批准主机名）和要订阅的事件/动作（可勾选排除草稿）。保存时展示一次签名密钥，接收端按 `X-Bot-Signature-256` 验签并按转发 ID 幂等去重；投递失败自动指数退避重试最多 5 次，也可在控制台手动重试。
- **主动事件轮询**：无需暴露公网接收端口——先按上述流程兑换临时令牌，再携带同一 `Authorization: Bearer <token>` 调用 `GET /external/events` 拉取绑定仓库最近 24 小时已验签归档的 `issues` / `pull_request` 事件（每批最多 100 条，服务端按客户端持久化保存消费游标，不额外消耗兑换配额）。
