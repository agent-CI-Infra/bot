# `#224` 切片 2：项目对话地址的深链与刷新

`#/projects/<id>/management` 是项目导航里 `管理对话` 给出的地址，但项目页没有 `management` 这一节：冷加载时路由器把这串 hash 改写成 `/basic`，页面显示基本设置，聊天再以悬浮窗盖在上面。同一地址「点击」时是对的（保持当前分区、只开聊天），所以缺口只在深链/刷新一侧。

修复是 `static/app.js` 里一行改写目标：保留项目、以**项目总览**为底层页面，聊天仍按该项目作用域打开。`e2e/management.spec.mjs` 原先钉住旧行为（改写去 `basic`）的那条断言同步改成 `overview`，并在注释里写明原因。

## 复现

`e2e/nav-shell.evidence.mjs`：造一个仓库（`fixture/project-101`）、管理员登录、直接打开 `#/projects/101/management`，等聊天连上后按视口截图。同一份 fixture 在 base 树与分支 tip 上各跑一次：

```sh
cat > .tmp/pw-evidence.config.mjs <<'EOF'
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: process.cwd() + '/e2e', testMatch: ['*.evidence.mjs'], workers: 1,
  fullyParallel: false, timeout: 60000, reporter: 'list', use: { browserName: 'chromium', headless: true } });
EOF
EVIDENCE_DIR=before npx playwright test --config=.tmp/pw-evidence.config.mjs   # base 树
EVIDENCE_DIR=after  npx playwright test --config=.tmp/pw-evidence.config.mjs   # 分支 tip
```

## 结果

| 视口 | before | after |
| --- | --- | --- |
| 390 | hash `#/projects/101/basic`、当前分区「基本设置」、高 2058 | hash `#/projects/101/overview`、当前分区「项目总览」、高 1749 |
| 768 | 同上、高 1402 | 同上、高 1373 |
| 1024 | 同上、高 1311 | 同上、高 1318 |
| 1440 | 同上、高 1289 | 同上、高 1248 |
| 1920 | 同上、高 1289 | 同上、高 1248 |

两张图是**不同页面**（这正是缺陷所在），所以这里不报「变化像素」而是报「当前分区与地址」：before 全部是「基本设置」，after 全部是「项目总览」；高度差来自两页内容不同，不是布局回归。每档都断言 `scrollWidth <= innerWidth`。

刷新后仍停在 `#/projects/101/overview` 且当前分区是「项目总览」，聊天可见——这条由 `e2e/nav-shell.spec.mjs` 钉住。
