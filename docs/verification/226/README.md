# `#226` 待我处理：优先级与已等待时长

同一份 fixture、同一组视口，在 base 树与分支 tip 上各抓一次；只改 `static/shell.js` 里待处理行的第三行与原因行。

## Fixture

`e2e/inbox-priority.evidence.mjs` 造 3 条待处理任务（最近状态变更分别为 3 天前 / 5 小时前 / 30 分钟前，级别 P0 / P1 / P2），外加 1 条排队任务（P0，4 天前）用来证明排队不计入待处理。项目 `fixture/project-101`，管理员登录后打开 `#/inbox`。

## 视口

390 / 768 / 1024 / 1440 / 1920 CSS px；390 用 844 高，其余 900，`fullPage` 截图。每档都断言 `scrollWidth <= innerWidth`（无横向滚动）。

## 结果

| 视口 | before 高度 | after 高度 | 变化像素 | 最大通道差 |
| --- | --- | --- | --- | --- |
| 390 | 1223 | 1244 | —（高度 +21） | — |
| 768 | 1129 | 1129 | 7495 / 867072（0.86%） | 221 |
| 1024 | 962 | 962 | 7495 / 985088（0.76%） | 221 |
| 1440 | 962 | 962 | 7495 / 1385280（0.54%） | 221 |
| 1920 | 962 | 962 | 7495 / 1847040（0.41%） | 221 |

- 变化集中在第一条任务行的原因行与等待行，页面其余部分逐像素相同（同一处 7495 像素在四档一致，说明只有这一块重排）。
- 390 上页面高度增加 21px：级别加进原因行后换行，等待行同时换行；`scrollWidth` 仍等于视口宽度。
- 排队任务与已完成任务在两份截图里都不出现，未被这一改动带进列表。

## 复现

默认 `playwright.config.mjs` 只收 `*.spec.mjs`，证据脚本故意叫 `*.evidence.mjs`，所以用一个只改 `testMatch` 的临时配置跑：

```sh
cat > .tmp/pw-evidence.config.mjs <<'EOF'
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: process.cwd() + '/e2e', testMatch: ['*.evidence.mjs'], workers: 1,
  fullyParallel: false, timeout: 60000, reporter: 'list', use: { browserName: 'chromium', headless: true } });
EOF
EVIDENCE_DIR=before npx playwright test --config=.tmp/pw-evidence.config.mjs   # base 树
EVIDENCE_DIR=after  npx playwright test --config=.tmp/pw-evidence.config.mjs   # 分支 tip
```
