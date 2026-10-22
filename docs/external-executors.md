# 外部执行端：临时授权与事件转发

外部执行端可继续使用自己的检视工具。Bot 负责验证 GitHub 投递、过滤转发，并在执行端完成工作后兑换 Bot 身份的临时 GitHub 凭据。两项功能均默认关闭，没有预置客户端、仓库或订阅。

## 一次完整接入

1. 超级管理员登记 GitHub App 和目标仓库，并在 App 安装中授予 Contents read、Issues write、Pull requests write。外部凭据兑换只支持 GitHub App；不会把机器人账号的长期 Token 当作临时凭据分发。
2. 在管理入口的「外部执行端」选择「新增客户端」，绑定一个仓库。个人电脑选择客户端凭据认证；GitHub Actions 选择 OIDC。项目管理员只能配置分配给自己的仓库。
3. 客户端凭据只显示一次。保存到执行端的独立凭据存储，不放入源码或日志；读取 API 不返回它。可轮换凭据、停用客户端。
4. 新增转发订阅，指定接收 URL、事件和动作。例如事件 `pull_request`，动作 `opened,ready_for_review,synchronize`，勾选排除草稿。保存后显示一次签名密钥，在接收端保存并校验签名。客户端认证和转发签名使用不同凭据。
5. 外部接收端收到消息后，按转发 ID 去重，再运行原来的检视工具。检视完成后调用公开的临时凭据接口，再用取得的令牌请求 GitHub 评论／Review API。完成后调用撤销接口。

若只想使用外部检视，可保留仓库 enabled，但关闭内置 review_enabled；转发订阅有自己的启用开关，不依赖内置模型或检视开关。两边同时启用时都会处理事件，Bot 不会自动关闭其中一边。

## 个人电脑认证与兑换

公开的 Webhook 监听入口同时提供 `POST /external/token`。管理 API 仍只在管理入口提供。HTTPS 反向代理应按需路由 `/hooks/github/` 和 `/external/`；不转发管理端口。部署方式仍为 Docker。

请求使用 `Content-Type: application/json`，`Authorization: Bearer <客户端凭据>`，正文：

```json
{
  "client_id": "<登记后返回的客户端 ID>",
  "request_id": "<新生成的至少16位随机请求ID>"
}
```

成功响应包含 `grant_id`、`token`、`token_type: Bearer`、`expires_at`、`repository_id` 和权限。`token` 是该 GitHub App 对指定单仓库的安装令牌，可以作为 GitHub API 的 Bearer 凭据。权限固定为 `contents: read`、`issues: write`、`pull_requests: write`，不包含 Contents write 或合并权限；客户端不能通过请求增加权限或更换仓库。仓库、所有者和 App 安装关系在签发时复核。

响应使用 `Cache-Control: no-store`，不进入 Webhook 归档，数据库只保留请求／身份摘要、令牌摘要、状态和过期时间。管理页面的授权记录不展示令牌。每客户端每小时最多 20 次兑换，失败签发也占用配额；同一 request_id 只尝试一次。上游结果未知时不会用同一请求重新签发，需在排查后使用新请求 ID。

GitHub 安装令牌通常有效一小时，以实际 `expires_at` 为准。它不能限定到某一条 PR，也不能限定只调用某一个 GitHub API；外部执行端应遵守仓库策略。内置检视仍只提交 COMMENT；可信外部工具应同样采用 COMMENT，不进行审批或自动合并。停用客户端阻止新的签发，已领取令牌到期前仍有效，需主动撤销。Bot 不分发 App 私钥、入口签名密钥、模型 Key 或长期账号 Token。

撤销使用 `POST /external/revoke`，正文 `{ "grant_id": "<签发ID>", "token": "<已领取令牌>" }`，不需要管理会话。只有与签发记录摘要匹配的令牌可以撤销，重复撤销幂等。接收端应在成功和失败清理路径中都尝试撤销；无法撤销时由令牌本身的有效期兜底。

## GitHub Actions OIDC

客户端选择 GitHub Actions OIDC 时不生成客户端凭据。管理员需要配置精确的 audience、subject、工作流仓库名、不可变仓库 ID、组织 ID、workflow_ref 和分支 ref。只信任 GitHub 的固定 issuer `https://token.actions.githubusercontent.com` 及其 JWKS，验证 RS256、签名、nbf/iat/exp、最大十分钟身份年龄和 jti。

兑换接口和请求正文相同，Authorization 改为 GitHub 签发的 OIDC JWT。必须满足所有已登记身份条件；若包含 job_workflow_ref，也必须匹配登记的工作流。仅接受 schedule、workflow_dispatch、repository_dispatch 事件和明确登记的分支，拒绝 PR 身份。相同 JWT 身份只能兑换一次，记录持久化，重启后也不能重放。这是凭据 broker，不是完整的 OpenID Provider，也没有把任意传入的 JWT 当作受信任身份。

## 转发协议

接收端须可从 Bot 控制面访问。默认只接受 HTTPS，并拒绝解析到私网、回环或本地地址的目标。若接收端位于部门内网，由部署管理员在 Docker 环境变量 `BOT_FORWARD_PRIVATE_HOSTS` 中显式批准准确主机名，逗号分隔，不支持通配符。例如可登记自己的内网接收主机；不要批准管理服务或元数据地址。只有这些主机允许 HTTP 和私网连接。

DNS 检查在每次投递前执行，连接固定使用已验证的地址；不跟随重定向。网络及响应超时有界。接收端不需要开放项目容器端口，Bot 也不会改变现有项目容器的网络隔离。

请求为 JSON，包含：

```json
{
  "version": 1,
  "id": "<稳定的转发ID>",
  "subscription_id": "<订阅ID>",
  "client_id": "<授权客户端ID>",
  "repository_id": "<仓库ID>",
  "event": "pull_request",
  "delivery_id": "<GitHub delivery ID>",
  "received_at": "<首次归档时间>",
  "payload": { "action": "opened", "pull_request": {} }
}
```

`X-Bot-Delivery` 与正文 id 相同；`X-Bot-Event` 给出事件类型；`X-Bot-Signature-256` 为 `sha256=` 加 HMAC-SHA256 的十六进制摘要，计算输入是收到的原始请求字节，密钥为订阅签名密钥。应先验签再解析和执行，校验头部 ID 与正文 ID 一致，并持久保存已处理的转发 ID。原 GitHub Authorization、Cookie 和签名头不会转发；正文不包含客户端凭据或临时令牌。

归档与转发入队在同一 SQLite 事务中完成，验签失败、范围外仓库、不匹配事件和草稿不会入队。重复 delivery 不重复入队。后台在提交后投递，2xx 视为已接收；网络故障、408、429 和 5xx 指数退避重试，最多五次，其他状态失败。返回 2xx 前，接收端应已可靠接收任务，而不必等待长时间检视完成。不要让耗时检视阻塞有五秒超时的 Webhook 响应。

转发采用至少一次投递。响应丢失或 Bot 重启时可能再次发送同一个 ID，接收端负责幂等；不能把内存去重当作生产保证。订阅变更、停用或客户端轮换会取消尚未发送的旧任务；已经发出的网络请求无法撤回。失败投递可在管理页面重试，仍使用同一个转发 ID。

## 管理 API

这些接口使用既有登录会话和 CSRF 校验，列表即使不筛选，也只返回项目管理员已分配仓库的数据。

| 路径 | 方法 | 内容 |
| --- | --- | --- |
| `/api/external/clients` | GET / POST | 客户端列表／创建；字段 name、repository_id、auth_type、OIDC 时的 trust |
| `/api/external/clients/:id` | GET / PATCH | 读取元数据；enabled 启停、rotate_secret 轮换，一次性返回新客户端凭据 |
| `/api/external/subscriptions` | GET / POST | 列表／创建，字段 client_id、name、url、filters；签名密钥只在创建时返回 |
| `/api/external/subscriptions/:id` | GET / PATCH | 更新 name、url、filters、enabled 或 rotate_secret；读取不含密钥 |
| `/api/external/deliveries` | GET | 最近 100 条转发状态、尝试次数与错误码 |
| `/api/external/deliveries/:id/retry` | POST | 重试失败投递 |
| `/api/external/grants` | GET | 最近 100 条签发记录，无原始凭据和身份 JWT |

列表均可用 repository_id 筛选。创建／轮换响应中的凭据是唯一显示机会，普通 GET 及日志不回显。凭据兑换失败不降级为长期 PAT，不调用模型或读取其他项目材料。

## 参考

- [GitHub App 安装令牌及权限限制](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [撤销安装令牌](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token)
- [GitHub Actions OIDC 身份字段](https://docs.github.com/en/actions/reference/security/oidc)
