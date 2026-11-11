# #224 切片 3 · 共享导航按组织分组并显示当前项目的权限状态

真页面：管理员登录后打开 `#/projects/101/overview`（项目 `alpha/project-101`，机器人账号只有读权限，安装快照里存在 `access_gaps`）。五档视口 `390/768/1024/1440/1920`，每张都是整页。

| 视口 | before（base `e15e5a83e51e608610e0cfb584b2b7359a6bd3af`，本分支 rebase 后的基线） | after（本分支） |
| --- | --- | --- |
| 390 | `before/nav-390.png` | `after/nav-390.png` |
| 768 | `before/nav-768.png` | `after/nav-768.png` |
| 1024 | `before/nav-1024.png` | `after/nav-1024.png` |
| 1440 | `before/nav-1440.png` | `after/nav-1440.png` |
| 1920 | `before/nav-1920.png` | `after/nav-1920.png` |

## 变化

- 项目切换器从扁平列表变成按组织分组的 `<optgroup>`：`alpha` 组里是 `alpha/project-101`，`beta` 组里是 `beta/project-102`；`全部项目` 仍在组外。分组用的组织名来自 `full_name` 的所有者段（`/api/repositories` 的现有投影，不新增接口）。
- 作用域条从只写 `full_name` 改成 `组织 · 项目`（`alpha · project-101`），并在当前项目有 `access_gaps` 时挂上项目列表在用的同一个权限徽章（`权限不足 · 需要 GitHub App`）；点徽章打开同一份缺口对话框，Esc 关闭并回到徽章。切到没有缺口的 `beta/project-102` 时徽章消失。
- 五档都没有页面级横向溢出（断言 `documentElement.scrollWidth <= innerWidth`），移动底栏仍是四项，宽度与高度都 ≥44px。

## 像素对照（同视口，共同高度部分）

| 视口 | 高度 before→after | 变化像素 | 占比 |
| --- | --- | --- | --- |
| 390 | 1790 → 1842（+52） | 184821 | 26.47% |
| 768 | 1476 → 1488（+12） | 124016 | 10.94% |
| 1024 | 1385 → 1397（+12） | 140268 | 9.89% |
| 1440 | 1290 → 1302（+12） | 153959 | 8.29% |
| 1920 | 1290 → 1302（+12） | 178250 | 7.20% |

像素差占比偏大是**整页下移**造成的：作用域条多了一个权限徽章后比之前高（桌面 +12px，390 因换行 +52px），下面所有内容一起下移，于是差异覆盖整页；真正新增的元素只有切换器的两个组标题和作用域条里的徽章。

## 复现

```
cat > .tmp/pw-evidence.config.mjs <<'EOF'
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: process.cwd() + '/e2e', testMatch: ['*.evidence.mjs'], workers: 1,
  fullyParallel: false, timeout: 120000, outputDir: '.tmp/e2e-results', reporter: 'list',
  use: { browserName: 'chromium', headless: true } });
EOF
EVIDENCE_DIR=before npx playwright test --config=.tmp/pw-evidence.config.mjs e2e/nav-capability.evidence.mjs   # base 树
EVIDENCE_DIR=after  npx playwright test --config=.tmp/pw-evidence.config.mjs e2e/nav-capability.evidence.mjs   # 本分支
```
