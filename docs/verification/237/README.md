# #237 安装档案/机器人账号 — 证据

同一份 fixture（真实控制面 + `identityFixture`：一条 App 123 的安装 77，带一条签名 `installation.created` 事件；另有一条 App 999 的安装 88，其账号已不存在），真实 Chromium，1440 与 390 两档。

| 文件 | 说明 |
| --- | --- |
| `before/*.png` | base `ecae98c6`：安装卡只有目标/状态/证据；账号行只有凭据状态，看不出「装在哪、授权从哪来」 |
| `after/*.png` | 本片 tip `a0daa606`：安装卡多出「所属账号 / 授权来源 / 安装授权（GitHub 返回）」；账号行多出「凭据来源」 |

写法对比：

- **安装档案**：`fixture · 安装 77` 现在写「所属账号 Test account（GitHub App · App ID 123）」「授权来源 GitHub App 安装事件（签名验证）」「安装授权（GitHub 返回）未同步到权限，不能据此判断缺什么」；账号凭据还在时，卡片内直接给「检查权限和事件订阅」按钮（复用既有 `/api/accounts/:id/permissions`）。孤儿安装（App 999）写「未匹配到已登记账号（App 已删除或凭据已撤销）」与「历史证据缺失，授权来源未知」，不猜账号、不留空。
- **机器人账号**：每行多出「凭据来源：GitHub App 安装（私钥换安装临时令牌）」/「用户 Token（按 Token 所属用户的仓库权限）」；凭据撤销时行内点明「已撤销，需要重新登记」。这个列表页不新开请求：账号取自启动时已加载的清单，「装在哪」与安装目标都不在这里取，安装档案详情页 `#/settings/installations/<ref>` 随 `#344` 提供（这颗 head 上 `settingsSection()` 只认 `#/settings/<key>`，该地址会回落「常规」，所以图里不引用它）。

复现（`after` 四张必须在**本片 tip** 上重拍，否则会和代码对不上）：

```sh
# before：在 base 上拍
git checkout ecae98c6 -- static/settings.js
node e2e/installation-profiles.evidence.mjs docs/verification/237/before
# after：换回本片 tip 再拍
git checkout a0daa606 -- static/settings.js && git restore --staged --worktree static/settings.js
node e2e/installation-profiles.evidence.mjs docs/verification/237/after
```

拍完可用面板文本复核（这颗 head 的实际渲染）：`installations` 面板含「所属账号 / 授权来源 / 安装授权（GitHub 返回）」、不含「控制台登录来源」「安装目标」；`accounts` 面板含「凭据来源」、不含「安装目标」。

红 → 绿（`e2e/installation-profiles.spec.mjs`，真 Chromium）：

- base `ecae98c6`：`1 failed` — `expect(panel).toContainText('所属账号')`，实际安装卡只有 `fixture · 安装 77 GitHub 目标 ID 10 …`，没有账号与授权来源。
- 本片 tip：`1 passed (1.4s)`；同跑 `e2e/installation-target.spec.mjs` → `2 passed (9.8s)`。
