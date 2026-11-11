# #237 T3-min · 公网接入页只读呈现 GitHub 登录配置

## 改了什么

`#/settings/access`（公网接入）本来只有两张卡：公网 HTTPS 地址、Cloudflare Tunnel。登录配置只在接入向导第 3 步，
读的人要跳两次页面才能判断「地址、它的验证结果、Tunnel 状态、登录回调」是否一致。

这一片在最下面加一张只读卡 **GitHub 登录（只读）**，和另外两张卡同屏，内容全部来自页面已经取过的那一次
`GET /api/onboarding`（`github_login` 字段），**不新增任何请求**：

- 登录状态（已启用／只有本地账号）
- OAuth App 是独立 OAuth App，还是仍复用仓库 GitHub App（迁移提示）
- Client ID、Client secret 是否已保存（接口不回读，值不显示）
- 登录 Callback URL 与它的来源（已验证的公网地址／部署配置的入口／本机地址）
- 配置来源（控制台向导／部署环境变量／未配置）
- 保存时留下的旧回调地址（`previous_callback_url`）→ 明确指出要去 OAuth App 里改
- 改动登录配置的影响：换 OAuth App／Client ID 后现有会话失效、旧授权要到 GitHub 撤销、
  仓库 GitHub App 与安装不受影响
- 一条指向 `#/settings/onboarding/2`（向导第 3 步）的链接

卡里没有输入框、选择框或按钮：编辑仍只属于向导，这一页不改登录流程，也不复用 `#225` 的编辑组件。

## 截图（真实控制台页面，全页）

三种宽度都是同一个页面 `#/settings/access` 的全页截图。fixture 状态：已验证公网地址 `https://bot.example.com`、
已启用独立 OAuth App（Client ID `Ov23.login`、secret 已保存）。

| 宽度 | before（本片 base `dcddf86`，不含这一片） | after（本片） |
| --- | --- | --- |
| 1440 CSS px | [before/access-1440.png](before/access-1440.png) | [after/access-1440.png](after/access-1440.png) |
| 768 CSS px | [before/access-768.png](before/access-768.png) | [after/access-768.png](after/access-768.png) |
| 390 CSS px | [before/access-390.png](before/access-390.png) | [after/access-390.png](after/access-390.png) |

对比：

- **before**：只有「公网 HTTPS 地址」「Cloudflare Tunnel」两张卡。地址是 `https://bot.example.com`，
  但页面上没有任何地方说明 GitHub 登录会把人送回哪个域名、用的是哪个 OAuth App。
- **after**：多出「GitHub 登录（只读）」卡，把 Client ID、secret 是否已保存、登录 Callback URL
  （`https://bot.example.com/auth/github/callback`）、回调地址来源、配置来源与改动影响写在同一屏，
  可以和上面的地址、Tunnel 状态直接对照。
- 390 px：三张卡纵向排列，事实表折成单列，页面没有横向滚动（spec 断言
  `document.documentElement.scrollWidth <= innerWidth`）。

## 复现

```bash
# before：只看页面本身，不含本片
git checkout <base dcddf86> -- static/settings.js
node e2e/public-access.evidence.mjs docs/verification/237/public-access/before
# after：本片
git checkout <tip> -- static/settings.js
node e2e/public-access.evidence.mjs docs/verification/237/public-access/after
git restore --staged --worktree static/settings.js
```

截图脚本 `e2e/public-access.evidence.mjs` 用真实控制台和真实接口：它保存一个已验证的公网地址、用
`PUT /api/onboarding/github-login` 启用一个独立 OAuth App，然后按 1440 / 768 / 390 三种宽度拍
`#/settings/access` 的全页图。

## 测试

`e2e/public-access.spec.mjs`（新增，三条）：

1. 同屏三张卡 + 未配置时逐项写「未填写／未保存」，卡内无控件、只有一条向导链接；
   `/api/onboarding` 只读一次、没有 `github-login` 请求。
2. 启用独立 OAuth App 后显示 Client ID、`已保存（接口不回读）`、`控制台向导保存`，
   整页文本不含刚保存的 secret；390 px 无横向滚动。
3. 入口是 `https://bot.example.com`、登录仍复用仓库 App 且回调停在旧域名时，
   点名「仍复用仓库 GitHub App」并给出旧回调地址与要改的地方。

base `dcddf86` 上三条全红（卡不存在），tip 上三条全绿。既有 `e2e/console-addresses.spec.mjs` 的
「公网接入」卡列表断言同步加上第三张卡（这是本片要改的行为，不是测试落后）。
