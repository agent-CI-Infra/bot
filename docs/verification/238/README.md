# #238 用量与成本 — 证据

同一份 fixture（4 条 `model_requests`：完整计价 / 缺单价 / 缺用量 / 从未计价），真实 Chromium，1440 与 390 两档。

| 文件 | 说明 |
| --- | --- |
| `before/costs-1440.png`, `before/costs-390.png` | base `a77f3a1`（未带本片修改）：缺失显示为 0 / `—`，没有「未定价 / 未计量 / 不完整」 |
| `after/costs-1440.png`, `after/costs-390.png` | 本片 tip：费用卡标「未定价」，token 卡标「未计量」，部分覆盖标「（不完整）」 |

复现（两次截图之间只切换 `static/costs.js`）：

```sh
mkdir -p .tmp && cat > .tmp/pw-evidence.config.mjs <<'CONF'
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: /evidence\.mjs$/, workers: 1, fullyParallel: false,
  timeout: 30000, outputDir: '.tmp/e2e-results', reporter: 'list', use: { browserName: 'chromium', headless: true } });
CONF
# before：干净的 base 文件
git checkout <base> -- static/costs.js
EVIDENCE_DIR=docs/verification/238/before npx playwright test --config=.tmp/pw-evidence.config.mjs e2e/costs-usage.evidence.mjs
# after：本片实现
git checkout <tip> -- static/costs.js
EVIDENCE_DIR=docs/verification/238/after npx playwright test --config=.tmp/pw-evidence.config.mjs e2e/costs-usage.evidence.mjs
git restore --staged --worktree static/costs.js
```

红 → 绿（`e2e/costs-usage.spec.mjs`，真 Chromium）：

- base `a77f3a1`：`1 failed` — `e2e/costs-usage.spec.mjs:39` `expect(panel.locator('[data-metric="input_tokens"] strong')).toHaveText('2,400')`，`Error: element(s) not found`。
- 本片 tip：`1 passed`（含空日断言：2026-11-09 无请求 → 费用 `USD 0.00`、三个 token 列为 `—`，不是「未计量」）。
