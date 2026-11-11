# #237 安装档案详情 / 用户详情 — 证据

同一份 fixture（真实控制面 + `identityFixture`：App 123 的安装 77 带仓库 101；同 App 的安装 88 零仓库；另有一条 `signature_verified=0` 的投递），真实 Chromium，1440 与 390 两档。

| 文件 | 说明 |
| --- | --- |
| `before/*.png` | base `ecae98c6`：`#/settings/<section>/<id>` 不被识别，三个地址都落回「常规」页 |
| `after/*.png` | 本片 tip：安装 77 详情（快照 + 仓库表 + 事件表）、安装 88 零仓库详情、超管用户详情 |

after 里能直接看到的四处：

- `installation-77-*.png`：地址 `#/settings/installations/github.com/123/77` 直达该安装；facts 有状态/范围/完整性/最近成功同步/执行/版本；`历史证据缺失：不能判断申请者与批准者，也不能据此认为没有申请。`；仓库表列出 `fixture/project-101`；事件表把那条未验证投递标成红色「签名未验证」。
- `installation-88-zero-repo-*.png`：零仓库安装写「无仓库（零仓库安装也会保留；同步后新仓库会出现）」，不是空白表。
- `user-admin-*.png`：用户详情给出角色/状态/账号 ID/登录来源「本地账号」、可见项目与来源；底部「停用」按钮。最后一名活跃超管点击后，`PATCH /api/users/<id>` 的 409 `last_super_admin` 落成中文「这是最后一名活跃的超级管理员，不能停用。先启用或新增另一名超级管理员。」，状态保持「已启用」。

复现（before 先 `git checkout <base> -- static/settings.js`，after 再 `git checkout <tip> -- static/settings.js`，最后 `git restore --staged --worktree static/settings.js`）：

```sh
node e2e/settings-details.evidence.mjs docs/verification/237/detail-pages/before
node e2e/settings-details.evidence.mjs docs/verification/237/detail-pages/after
```

红 → 绿（`e2e/settings-details.spec.mjs`，真 Chromium）：

- base `ecae98c6`：`1 failed` — `expect(panel).toContainText('fixture · 安装 77')`，两段式地址落回「常规」页（实际读到「当前运行版本 / 同时运行的任务…」）。
- 本片 tip：`1 passed (2.2s)`；同跑 `installation-target` + `project-settings` + `role-settings` → **9 passed (28.0s)**。
- 原型名地址（`#/settings/__proto__`、`#/settings/constructor`）落到「常规」页且无 pageerror（base 实测同样回落，这层显式白名单是给 CodeQL 和新分派路径留的护栏）。
- 390px：两个详情页都断言 `documentElement.scrollWidth <= innerWidth`（无横向溢出），截图见 `*-390.png`；表格在自己的 `.rule-table-wrap` 内横向滚动，页面本身不撑破。
