# 外部执行端凭据代理与公开看板托管

本文说明两个面向外部集成的独立子系统设计：**外部执行端凭据代理与事件分发（`src/external/`）** 以及 **公开看板采集与单端口托管（`src/public-board/`、`public-board/`）**。使用说明见 [外部执行端](../features/external-executors.md) 与 [公开看板](../features/console-and-workspace.md#5-公共-dashboard-与单仓公开看板)。

## 1. 外部执行端凭据代理（`src/external/`）

外部执行端是一个受控 JSON 凭据 Broker + 事件分发器，避免向个人电脑或外部 CI 暴露 GitHub App 私钥或长期 PAT：

- **强认证与防重放（`POST /external/token`）**：
  - **个人电脑（`private_key_jwt`）**：登记 2048–4096 位 RSA SPKI 公钥，验签 RS256 JWT，严格核对 `iss/sub = client_id`、固定 HTTPS `aud`（不信任请求 `Host` 头）、`exp - iat ≤ 120s` 与 `jti = request_id`。
  - **GitHub Actions OIDC**：仅信任 `https://token.actions.githubusercontent.com` JWKS，严格比对登记的 `audience`、`subject`、仓库/组织数字 ID、`workflow_ref`、`ref` 且限定非 PR 事件。
  - **持久化防重放与限流**：签发前在 SQLite 事务内占用 `request_id` 与身份摘要（跨重启防重放），每客户端每小时限 20 次兑换；仅签发绑定单仓、权限固定为 `contents: read` + `issues: write` + `pull_requests: write` 的 GitHub App 安装令牌，响应 `Cache-Control: no-store`，库内仅存令牌哈希不存明文；支持 `POST /external/revoke` 幂等撤销。
- **Webhook 签名转发**：
  - Webhook 验签归档与转发任务入队在同一事务完成；后台按「至少一次」语义投递，携带 `X-Bot-Delivery`、`X-Bot-Event` 与原始字节 HMAC-SHA256 `X-Bot-Signature-256`，剥离原 GitHub 认证头。
  - **SSRF 防护**：默认只允许 HTTPS 且每次投递前校验并固定解析 IP（拒绝回环/私网/链路本地且不跟随重定向）；内网接收主机仅允许 `BOT_FORWARD_PRIVATE_HOSTS` 显式精确白名单。
- **事件轮询（`GET /external/events`）**：
  - 直接复用已兑换的 GitHub 安装令牌（通过 `external_grants.token_hash` 校验活跃状态与归属），不引入第二套令牌也不扣兑换额度；返回最近 24 小时已验签归档的 `issues` / `pull_request` 事件，并在 HTTP 200 写出完成后推进客户端独立持久化游标。

## 2. 公开看板增量采集与静态托管（`src/public-board/`、`public-board/`）

launchpad 放弃对外部 GitHub Pages 仓库与 `PRIVATE_SOURCE_TOKEN` 的依赖，直接在控制面 `8791` 端口内置托管公开看板（`/dashboard/`、`/boards/`、`/boards/<owner>/<repo>/`）：

- **可见性授权模型**：`public_board_settings` 按仓库持久化开关（公开仓默认开、私有仓默认关）；关闭开关、仓库卸载或删除后公开路由立即拦截并返回 404，杜绝历史快照泄漏。公开路由使用独立内容安全策略，与需登录的控制台会话完全隔离。
- **代次驱动的异步采集队列**：
  - 已验签 Webhook 在入库事务内递增目标仓库的采集代数（即使仓库未启动检视项目也生效）；后台持久化队列合并同仓高频投递、串行采集并在失败时退避重试且保留上一份有效快照。
  - 采集仅使用源仓最小只读安装令牌（`contents`、`issues`、`pull_requests`、`actions`、`checks`、`metadata` read），采集完成即撤销令牌。
- **通用 GitHub 原生指标采集器**：
  - Dashboard React 前端、单仓静态页与纯标准库 Python 增量采集器随镜像一并构建，数据落盘在数据库旁的 `public-boards/` 目录；
  - 仅采集任何仓库通用的 GitHub 原生数据（Issue/PR/贡献者/Release/近 30 天 Actions 运行态势与各 workflow/job 耗时统计），并对定时 workflow 自动解析 Check Run Markdown 表格、JUnit XML 或标准 JSON 指标产物，不依赖仓库私有门禁格式。
- **单仓坏数据隔离**：聚合输出 `/dashboard/data/index.json` 与 `/boards/` 时逐仓容错，单个仓库快照损坏或缺失仅记入 `unavailable`（不暴露内部路径），绝不拖垮整个 Dashboard。
