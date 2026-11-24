# 控制台前端架构与管理 API 总览

本文说明控制台原生前端的壳层/样式/渲染安全架构，以及统一业务端口 `8791` 的管理 API 鉴权与端点总览。用户界面使用指南见 [控制台、项目总览、知识库、发版本与公开看板](../features/console-and-workspace.md)。

## 1. 控制台前端架构（`static/`）

控制台采用 **无打包框架的原生 ESM + CSS** 架构，由 `src/server.ts` 按显式静态文件白名单提供服务（新增前端资源必须同步登记到 `static/index.html` 与 `src/server.ts`）：

- **壳层与响应式路由（`shell.js`、`shell.css`）**：
  - 基于 Hash 路由，状态可刷新、可分享；采用三断点自适应（`≤767px` 四入口底栏 + 单列、`768–1023px` 192px 窄侧栏、`≥1024px` 224px 侧栏 + 右侧固定顶栏）。
  - 范围切换器是唯一项目切换入口，切项目、失权或退出登录时同步清除旧项目头部、选中态与内存草稿，并丢弃迟到的异步响应。
- **单源设计令牌与公共组件**：
  - 全部 `--color-*`、`--space-*`、`--radius-*`、`--font-size-*`、`--line-height-*`、`--control-min`、`--shadow-*` 变量**唯一声明在 `static/shell.css` 的 `:root`**（`test/ut/static/console-tokens.test.mjs` 强校验唯一性与 ≥ 4.5:1 对比度）。
  - 公共原语：`consoleState`（统一空/加载/失败态）、`askConfirm`（危险操作二次确认）、统一顶部保存栏（角色/基本设置/模型/机器配置共用）以及唯一错误文案出口 `readErrorText(err)`（屏蔽浏览器原生网络报错差异）。
  - 内置超级管理员专属设计样例页 `#/design` 用于令牌与组件视觉回归验证。
- **严格 CSP 下的安全 Markdown 与 Mermaid 渲染**：
  - 管理助手回复、项目知识 `.md` 与提示词阅读视图共用 `renderManagementMarkdown()`（Marked + DOMPurify 仅保留文档标签，移除脚本、内联事件与自动加载外链图片）。
  - Mermaid 图表采用固定版本 `@mermaid-js/tiny`（`securityLevel: 'strict'`，禁止 `foreignObject` 与 `%%{init}%%` 覆写），渲染出的 SVG 再经 DOMPurify 清洗全部 `<style>`、`href` 与可导航链接，样式全部走 `static/diagrams.css` 令牌，严格遵守控制台无内联样式/脚本的 CSP。

## 2. 管理 API 通用契约（`src/server.ts`、`src/app/`）

- **单一业务端口**：容器端口 `8791` 统一按路径分派管理 API、静态页、OAuth/App 回调、GitHub/飞书 Webhook、外部执行端（`/external/*`）、公开看板（`/dashboard/`、`/boards/`）与探针（`/healthz`、`/readyz`）。
- **认证与防跨站**：
  - 登录/初始化签发 `HttpOnly; SameSite=Strict` 会话 Cookie 并返回 `csrf_token`；所有写接口强制校验 `X-CSRF-Token`、`Content-Type: application/json` 与合法 `Origin`。
  - 所有接口严格拒绝未知字段，失败仅返回稳定错误码不泄漏内部异常；敏感字段在 API 输出层统一按键名闭集递归脱敏。
- **乐观锁与幂等**：配置与资源更新普遍要求 `expected_revision` / `version`（冲突返回 `409`）；管理命令与环境生命周期操作要求 `idempotency_key` / 48 位十六进制 `operation_id`。

## 3. 主要 API 端点分组总览

| 领域 | 核心路径 | 职责与权限边界 |
| --- | --- | --- |
| 健康与初始化 | `GET /healthz`、`GET /readyz`、`GET/POST /api/setup` | 存活/就绪探针（含孤儿笔记卷阈值）；一次性首位超管初始化。 |
| 认证与身份 | `/api/auth/*`、`/auth/github/*`、`/api/identity/*`、`/api/users*`、`/api/project-admin-assignments` | 本地与 GitHub 登录、会话与组织切换、成员委派（`POST/DELETE /api/identity/grants`）与用户管理。 |
| 账号与安装 | `/api/accounts*`、`/api/installations*`、`/api/trusted-organizations*`、`/api/github/rate-limits` | GitHub App/Token 账号登记与权限/限流探测、安装同步/启用/禁用/删除、安装档案与受信任组织（多为超管）。 |
| 项目与策略 | `/api/repositories*`、`.../policy`、`.../rules`、`.../manager`、`.../dispatch*`、`.../roles*`、`.../members` | 项目策略（能力上限、自动合并、标签、并发）、仓库 Skill 刷新、Manager 提示词与分派事件、RoleDefinitionV2 角色池配置。 |
| 任务与总览 | `/api/tasks*`（含 `/logs`、`/events`、`/runs`、`/source`、`/lineage`、`/live`、`/checks`、`/writes`、`/merge`、`/integrate`、`/subscriptions`、`/coordination`、`/browser-evidence*`）、`/api/board/issues*`、`/api/board/prs*`、`.../role-board` | 通用任务 CRUD、过程追踪与证据展开、历史只读浏览器截图兼容（`/browser-evidence` 与 `/browser-evidence/step-N.png`）、任务依赖与历史协调只读查询（`GET /api/tasks/:id/coordination`；旧 `POST .../coordination/:id/retry` 返回 `410 coordination_retired`）、动态写授权、合并意图、Issue/PR 进展聚合与角色看板；任务列表/详情与角色看板仅按轻量 `json_extract` 透出 `target`（`{ type, number?, ref? }`）而不下发原始 `input`，外链聚合（`attachExternalLinks`）在推送前即识别 `task.request` 的 PR/Issue 目标与 `bot_pr`，并通过 `bot_pull_requests.source_task_id` 反查 bot PR 的根 Issue。（旧 `/api/board/cards*` 等返回 `410 board_retired`。） |
| 环境与工具卷 | `/api/environments*`、`/api/repositories/:id/tools*`（含流式 `POST .../tools/upload`、`.../delete-files`、`.../rollback`、`.../clear`）、`/api/assistant-computers*`、`/api/agent-tools*`、`/api/settings` | 项目电脑启停/重置/规格配置/实时监控、按项目隔离只读工具卷流式发布与回滚（`config.write`）、助手电脑状态与 HOME 清理、Agent CLI 工具卷安装/清理、全局默认设置（含单项目工具卷配额 `project_tools_quota_gb`）。 |
| 模型与统计 | `/api/models*`（含 `/provider`、`/endpoints`、`/upstream`、`/test`、`/projects`）、`/api/costs`、`/api/storage*` | 供应商模型管理、目录与连通性探测、按时区汇总的用量成本统计、存储占用与按天回收。 |
| 知识库与发版本 | `/api/repositories/:id/knowledge-files*`、`.../knowledge-directories`、`.../releases*` | 单源物理知识文件、正文检索与版本历史管理（旧 `/memories*`、`/knowledge*` 返回 `410 project_memory_api_removed`）、手动发版本预检/标签跟踪/草稿发布。 |
| 管理助手与渠道 | `/api/management/*`、`/api/service-roles*`、`/api/channels/*`（含 `/conversations`、`.../chats/:id/timeline`、`.../schedules`、`.../sync`、`.../retention`） | 统一查询/命令/回执、流式持久会话、启动申请审批、全局管理助手配置（`#/settings/management-assistant`，旧 `#/settings/service-roles` 兼容跳转）、飞书连接/双端绑定/群绑定（独立群配置路由 `#/identity/feishu/groups/new`、`<chat-id>`，内联模型、提示词与三维权限；助手固定在 Pi 上运行）；`GET /api/channels/conversations` 支持可选 `connector_id` 过滤（先按会话鉴权再分页），`timeline` 在 `chat` 返回 `connector_id`、`state`、`revision`、`can_sync`、`can_manage_retention`、`can_view_schedules`，统一支撑「飞书会话」页的会话定时任务（`?section=schedules`）、本地消息检索、显式重同步（`POST .../sync`）与超管按会话保留/清理（`GET/PUT/DELETE .../retention`）。 |
| 外部执行与 Webhook | `/hooks/github/:account/:endpoint`、`/hooks/feishu/:connector`、`/external/token`、`/external/revoke`、`/external/events`、`/api/repositories/:id/external/*` | 验签入库、非对称 JWT/OIDC 凭据兑换与撤销、事件轮询、外部客户端与转发订阅管理。 |

## 4. 模型供应商与接口协议（`src/app/models.ts`、`src/models/`）

- **供应商分组**：供应商不是独立的表，而是同一范围（`models.repository_id`，`NULL` 为部署共享）内 `models.provider_name` 相同的模型。地址和密封的 Key 仍存在每个模型行上，由 `PATCH /api/models/:id/provider` 在一个事务里对全部成员统一更新；成员按 `provider_name` 确定，请求必须带上全部成员的 `versions` 防止并发覆盖。名称在同一范围内不区分大小写唯一（`409 provider_name_taken`），地址不参与分组，所以同一地址可以有多个供应商。
- **创建入口**：`POST /api/models/provider` 必填 `name`，可选 `interface_type`；`POST /api/models` 单独建模型时可带 `provider_name`，不带时取地址主机名，重名依次加 `-2`、`-3`；`key_from` 复制来源模型的地址、Key、供应商和协议，不能另给 `api_url`、`api_key`、`provider_name` 或 `interface_type`。
- **接口协议**：存放在 `model_catalog_overrides.interface_type`，作为供应商设置统一写到全部成员，之后加入的模型继承；`null` 表示「自动」。生效协议由 `modelProtocol()`（`src/models/catalog.ts`）按「手动 → URL 后缀 → 目录 → 默认」解析（OpenAI 官方地址上的 codex 模型默认 Responses，来源仍记为默认）；手动协议同时决定自动的 `auth_header`（Anthropic Messages 用 `x-api-key`，其余用 `bearer`），目录给出的头只在协议为自动时使用。`GET /api/models` 返回 `protocol`（生效值、来源和手动设置）和 `protocol.inferred`（「自动」会得到的结果），`endpoints` 按生效协议给出真实请求地址。单个模型的 `PATCH /api/models/:id` 不接受 `api_url` 和 `interface_type`，`POST /api/models` 也不加入已有供应商，所以一个供应商始终只有一个地址和一个协议。名称唯一性在写事务内检查：一个供应商有多行模型，数据库唯一索引无法表达「每个名称一个供应商」。
- **探测与预览**：`GET /api/models/endpoints` 接受 `interface_type`，按所选协议或仅凭 URL 的推断返回请求地址、协议和来源；`upstream`、`test` 探测把表单所选协议当作保存后的设置，按与任务相同的推断规则（含 `auth_header`）发出请求。地址解析统一在 `src/models/endpoints.ts`。
- **迁移**：`providerStorage()` 在启动时增加 `provider_name` 列，并为没有名称的模型命名：同一范围内原按 `chat_url` 分组的模型得到同一个名称（主机名，重名加后缀，按地址排序保证结果确定），分组和协议保持不变；同一地址下手动协议不一致的模型按协议拆成不同供应商，使每个供应商只有一个协议。名称和协议都不是模型契约的一部分，修改它们不增加 `models.version`。
