# 个人电脑兑换 GitHub Token：接口与 curl 示例

这是与语言和客户端实现无关的接口协议。不要求 Node.js，也不要求下载 Bot 的脚本。下文用 OpenSSL 生成签名，用 curl 发送 HTTP 请求，用 jq 构造和读取 JSON；也可以用自己熟悉的语言实现相同协议。GitHub Actions OIDC 使用另一种身份，见[外部执行端说明](external-executors.md#github-actions-oidc)，不要套用个人电脑公钥流程。

## 接入前准备

超级管理员先在「外部执行端 → 设置兑换地址」保存实际的完整 HTTPS 地址，路径必须是 `/external/token`，不能带查询参数、片段或用户信息。这个完整地址也是签名证明的 `aud`，必须逐字一致，不能只写域名。地址尚未配置时先联系超级管理员，不要猜一个域名。

在目标项目设置的「外部执行」中新增个人电脑客户端，自动绑定当前已启用的 GitHub App 仓库，取得客户端 ID。客户端不能自行指定别的仓库或扩展权限。在自己的电脑上准备密钥，**先检查文件是否存在，不要覆盖已有私钥**；如果没有，在私有目录执行：

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out bot-client.pem
openssl pkey -in bot-client.pem -pubout -out bot-client.pub.pem
```

只把 `bot-client.pub.pem` 交给用户在该客户端的管理页登记，并等待登记成功。支持 2048–4096 位 RSA、SPKI PEM（`BEGIN PUBLIC KEY`），不接受 SSH 公钥格式。`bot-client.pem` 私钥始终留在个人电脑，不交给 Bot、聊天或日志。更换公钥后旧私钥立即不能用于新的兑换。

## 1. 本机签名规则

证明是 RS256 JWT，header 为 `{"alg":"RS256","typ":"JWT"}`。payload 的字段如下，均不可省略：

| 字段 | 规则 |
| --- | --- |
| `iss`、`sub` | 都是管理页中的客户端 ID |
| `aud` | 管理页配置的完整 HTTPS 兑换地址，字符串精确匹配 |
| `iat` | 当前 Unix 秒，JSON 数字 |
| `exp` | JSON 数字，大于 `iat` 且不超过 `iat + 120` |
| `jti` | 每次请求新生成的唯一 ID，16–128 位字母、数字、下划线或短横线；推荐 24 随机字节的十六进制编码 |

服务器允许五秒时钟偏差。将 header 和 payload 分别 UTF-8 JSON 编码，再做无填充 base64url 编码。用本机 RSA 私钥对 `base64url(header).base64url(payload)` 做 RSA-SHA256（PKCS#1 v1.5）签名，把无填充 base64url 签名作为 JWT 的第三段。不要使用 PS256、HS256、普通 base64 的 `+/=`，也不要添加外部密钥 URL。

以下步骤在同一个 shell 会话中运行。先把两个占位值换成管理页中的实际值；本例需要 POSIX shell、OpenSSL、curl 7.76+ 和 jq，不需要 Bot 脚本。不要开启 `set -x`、curl `--verbose` 或 `--trace`，这些选项可能泄露证明或 Token。

```sh
# token-setup
set -eu
umask 077
TOKEN_URL='<管理页配置的完整 HTTPS 兑换地址>'
CLIENT_ID='<管理页中的客户端 ID>'
KEY_FILE='./bot-client.pem'
WORK_DIR=$(mktemp -d ./bot-token.XXXXXXXX)
```

```sh
# token-sign
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
NOW=$(date +%s)
REQUEST_ID=$(openssl rand -hex 24)
HEADER=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(jq -cn --arg client "$CLIENT_ID" --arg aud "$TOKEN_URL" \
  --arg id "$REQUEST_ID" --argjson now "$NOW" \
  '{iss:$client,sub:$client,aud:$aud,iat:$now,exp:($now+120),jti:$id}')
SIGNING_INPUT="$HEADER.$(printf '%s' "$PAYLOAD" | b64url)"
SIGNATURE=$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign "$KEY_FILE" | b64url)
printf 'Authorization: Bearer %s.%s\n' "$SIGNING_INPUT" "$SIGNATURE" > "$WORK_DIR/proof-header.txt"
jq -cn --arg client "$CLIENT_ID" --arg id "$REQUEST_ID" \
  '{client_id:$client,request_id:$id}' > "$WORK_DIR/token-request.json"
```

## 2. POST /external/token

请求必须有 `Authorization: Bearer <签名JWT>` 和 `Content-Type: application/json`。正文只包含 `client_id` 和 `request_id`；`request_id` 必须与证明中的 `jti` 完全相同。这是 JSON 凭据接口，不是标准 OAuth 表单端点，不要提交 `client_secret`、私钥或自行添加 `scope`。

生成证明后立即发送，过期应重新签名。curl 从权限为 0600 的临时文件读取凭据，避免把实际证明放到进程命令行；不要加 `--location` 跟随重定向。

```sh
# token-exchange
curl --fail-with-body --silent --show-error --request POST "$TOKEN_URL" \
  --header 'Content-Type: application/json' \
  --header @"$WORK_DIR/proof-header.txt" \
  --data-binary @"$WORK_DIR/token-request.json" \
  --output "$WORK_DIR/token-response.json"
# 只显示元数据，不打印实际 Token。
jq '{grant_id,token_type,expires_at,repository_id,permissions}' "$WORK_DIR/token-response.json"
```

HTTP 200 返回 JSON：

```json
{
  "grant_id": "<本次签发 ID>",
  "token": "<GitHub App 安装令牌，按密钥保护>",
  "token_type": "Bearer",
  "expires_at": "<GitHub 返回的到期时间>",
  "repository_id": "<客户端绑定的仓库 ID>",
  "permissions": {"contents":"read","issues":"write","pull_requests":"write"}
}
```

`token` 是该客户端绑定仓库的 GitHub App 安装令牌，固定为 `contents: read`、`issues: write`、`pull_requests: write`。不能当 Contents write 使用，不能扩权限或切换仓库。令牌通常有效一小时，按实际 `expires_at` 到期；120 秒限制的是签名证明，而不是这个安装令牌。响应带 `Cache-Control: no-store`；仍需由接收端保护响应文件，不能打印进聊天、CI 日志或提交。

## 3. 用 Bearer Token 调用 GitHub

下面演示向绑定仓库的 Issue 或 PR 发普通评论。将 `COMMENT_URL` 中的占位值替换为该仓库和目标编号，不要请求别的仓库。也可按 GitHub API 使用相同 Bearer Token 读取内容或提交 PR 行内评论；检视使用 `COMMENT`，不自动合并，遵守仓库策略。

```sh
# token-use
COMMENT_URL='https://api.github.com/repos/<owner>/<repo>/issues/<编号>/comments'
jq -r '"Authorization: Bearer " + .token' "$WORK_DIR/token-response.json" > "$WORK_DIR/github-header.txt"
printf '%s' '{"body":"检视完成：请在这里填写结论。"}' > "$WORK_DIR/comment.json"
curl --fail-with-body --silent --show-error --request POST "$COMMENT_URL" \
  --header @"$WORK_DIR/github-header.txt" \
  --header 'Accept: application/vnd.github+json' \
  --header 'Content-Type: application/json' \
  --data-binary @"$WORK_DIR/comment.json" --output "$WORK_DIR/comment-response.json"
```

## 4. GET /external/events：用同一个 Token 轮询

轮询地址与兑换地址同源，路径为 `GET /external/events`，部署时沿用公开 Webhook 监听和 `/external/` 反向代理。将兑换响应中的**同一个 `token`** 放在 `Authorization: Bearer <token>` 中；它既用于 GitHub，也用于轮询，不会另发第二种令牌，不需要管理登录或重新提交签名 JWT。未知、过期、已撤销的令牌返回 `401 external_unauthorized`；客户端或项目停用后也不能轮询。每客户端每小时 20 次的限制只计算兑换，轮询不消耗此额度。

接口不接收仓库、客户端或游标查询参数。服务端从已保存的令牌摘要识别签发记录，只返回该客户端绑定仓库的有效归档 `issues` 和 `pull_request` 事件，不依赖是否配置了 Webhook 转发订阅，也不应用订阅的动作／草稿过滤。签名密钥和原始请求头不会返回。同一仓库的同一次 GitHub delivery 只保留一条轮询事件，按归档顺序每批最多返回 100 条。

```sh
# token-poll
EVENTS_URL="${TOKEN_URL%/external/token}/external/events"
jq -r '"Authorization: Bearer " + .token' "$WORK_DIR/token-response.json" > "$WORK_DIR/events-header.txt"
curl --fail-with-body --silent --show-error --request GET "$EVENTS_URL" \
  --header @"$WORK_DIR/events-header.txt" --output "$WORK_DIR/events-response.json"
```

HTTP 200 示例：

```json
{
  "events": [{
    "id": "<归档记录 ID>",
    "event": "issues",
    "delivery_id": "<GitHub delivery ID>",
    "action": "opened",
    "repository_id": "<绑定仓库 ID>",
    "object_number": 42,
    "received_at": "<首次归档时间>",
    "payload": {"action":"opened","repository":{},"issue":{"number":42}}
  }]
}
```

`payload` 是原本会转发的完整 GitHub 事件载荷；`object_number` 为 Issue 或 PR 编号。超过接收时间 24 小时的事件不再返回，这一窗口只限制轮询，不缩短管理页已有投递档案的保留时间。没有新事件时正常返回 `200 {"events":[]}`。

**每个外部客户端各自保存进度**，多个客户端即使绑定同一个仓库，也互不影响。进度按客户端 ID 持久保存，续换 Token 或服务重启都不会重置。同一个客户端的并发轮询串行处理，建议客户端也串行拉取并妥善保存每次响应。

服务端成功返回 200 并写出这批事件之后，进度前进，下次不再返回旧事件。响应在发出前失败时不推进进度。**如果客户端弄丢了已经成功返回的响应，服务端不补发**；本协议没有显式 ACK、回放游标或响应丢失补偿。与 Webhook 至少一次推送的语义不同，现有 Webhook 推送方式继续保留。

## 5. 用完撤销并清理

向与兑换地址同源的 `POST /external/revoke` 提交 `grant_id` 和 `token`。不需要管理会话或再签一个 JWT，但必须是该次签发对应的 Token。撤销成功返回 `{"ok":true}`，重复撤销幂等。

```sh
# token-revoke
REVOKE_URL="${TOKEN_URL%/external/token}/external/revoke"
jq '{grant_id,token}' "$WORK_DIR/token-response.json" > "$WORK_DIR/revoke-request.json"
curl --fail-with-body --silent --show-error --request POST "$REVOKE_URL" \
  --header 'Content-Type: application/json' \
  --data-binary @"$WORK_DIR/revoke-request.json" --output "$WORK_DIR/revoke-response.json"
jq -e '.ok == true' "$WORK_DIR/revoke-response.json"
```

确认撤销后删除临时证明、请求头、Token 响应等文件，保留本机私钥供下次接入。即使评论调用失败也应执行撤销；若撤销网络失败，安全保留 `grant_id` 和 `token`，稍后重试，或等待 `expires_at`。停用客户端或更换公钥只阻止新的签发，不能代替对已发 Token 的撤销。

```sh
# token-cleanup
rm -f "$WORK_DIR/proof-header.txt" "$WORK_DIR/token-request.json" \
  "$WORK_DIR/token-response.json" "$WORK_DIR/github-header.txt" \
  "$WORK_DIR/comment.json" "$WORK_DIR/comment-response.json" \
  "$WORK_DIR/revoke-request.json" "$WORK_DIR/revoke-response.json" \
  "$WORK_DIR/events-header.txt" "$WORK_DIR/events-response.json"
rmdir "$WORK_DIR"
unset SIGNATURE SIGNING_INPUT PAYLOAD HEADER REQUEST_ID
```

## 失败与重试

| HTTP / 错误码 | 处理方式 |
| --- | --- |
| `503 external_audience_not_configured` | 请超级管理员先设置完整 HTTPS 兑换地址 |
| `401 external_unauthorized` | 检查客户端启用、公钥已登记、RSA 算法、客户端 ID、aud、时间、jti 与 request_id 一致；撤销请求则检查 grant_id 与 token 匹配；轮询检查是否使用兑换得到的同一个 token，以及是否已到期、已撤销或项目／客户端已停用 |
| `400 invalid_request_id` | request_id 应为 16–128 位字母、数字、下划线或短横线 |
| `409 identity_already_exchanged` | 该证明／请求已使用，不可重放；确需另一令牌时生成新 jti 并重新签名 |
| `429 external_rate_limited` | 每客户端每小时最多 20 次兑换，失败签发也计入；稍后再试 |
| `502 external_token_unavailable` | 检查 App 安装、权限和上游状态；可能已消耗该请求，不能原样重发 |
| `502 external_revoke_unavailable` | 保存本次 grant_id 与 token，稍后重试撤销 |

成功响应丢失也不能原样重放证明；服务端会持久拒绝重复请求。不要用 curl 自动重试兑换 POST。现有 `scripts/external-token.mjs` 只是这一协议的可选客户端实现，不是使用接口的前提。
