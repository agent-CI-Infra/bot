# #237 T2-A 账号详情页 — 证据

同一份 fixture（真实控制面 + `identityFixture`：GitHub App 账号 `Test account`，App ID 123，带一个 Webhook 入口与两个已登记项目 `fixture/project-101`、`other/project-201`），真实 Chromium，1440 / 768 / 390 三档全页截图。

| 文件 | 说明 |
| --- | --- |
| `before/*.png` | base `82aa4014`：`#/settings/accounts/<id>` 的地址段被忽略，落在「机器人账号」列表，没有任何账号详情 |
| `after/*.png` | 本片 tip：同一地址打开「账号详情」——类型/凭据/登记时间、`使用项目（2）` 与项目名、Webhook 入口表，以及改名、轮换凭据、删除账号三处操作 |

写法对比：

- **列表页**：账号行只多一个「详情」链接，仍然是启动时已加载的数据——`#341` 的教训（列表页零新请求）照旧成立。
- **详情页**：所有请求只在这里发（`GET /api/accounts/<id>` + `GET /api/installations`）。「使用项目」用 `/api/installations` 每行已有的 `account_id` 在本地计数，不新开接口。
- **改名**：`PATCH /api/accounts/<id>` `{name}`；服务端答应后才提示「名称已保存」。
- **轮换凭据**：GitHub App 账号填私钥（PEM），Token 账号填 Token；服务端校验失败时给中文原因（例如「这不是有效的 RSA 私钥……」），旧凭据保持已配置，不是静默清空。
- **删除账号**：走控制台自己的确认框；服务端拒绝（`account_has_projects` 等）时，确认框就地显示中文原因，可以取消，不用刷新页面。

复现（`after` 必须在**本片 tip** 上拍）：

```sh
# before：在 base 上拍
git checkout 82aa4014 -- static/settings.js static/views.css
node e2e/account-detail.evidence.mjs docs/verification/237/t2a/before
# after：换回本片 tip 再拍
git checkout <tip> -- static/settings.js static/views.css && git restore --staged --worktree static/settings.js static/views.css
node e2e/account-detail.evidence.mjs docs/verification/237/t2a/after
```

红 → 绿（`e2e/account-detail.spec.mjs`，真 Chromium）：

- base `82aa4014`：`1 failed` — `expect(panel).toContainText('账号详情')`，实际面板是「接入向导使用的 GitHub App … 已登记的账号」，地址段被忽略。
- 本片 tip：`1 passed (5.3s)`；同跑 `e2e/settings-details.spec.mjs`（`#344` 合进来的详情页断言）→ `1 passed (7.5s)`。

顺带收掉的 `#344` 判词非阻断项（不是新红→绿）：

- 安装详情页「重新同步」失败时改用 `view-error` 色调（原先走 `view-success`）。
- `.rule-table-wrap` 改为容器内横向滚动，`rule-table td` 允许任意位置断行；320px 下文档不再横向溢出，spec 里带 320 断言。
