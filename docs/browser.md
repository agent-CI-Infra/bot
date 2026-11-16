# 任务浏览器与执行证据

任务可以在**独立的真实浏览器**里打开事先允许的站点，并把每一步和截图留下来事后查看。这是 harness 的通用能力，供巡检等预置工作流复用，不是把外部产品的界面搬进控制台。

## 启用

在任务 `input.browser` 里声明允许访问的源：

```json
{
  "browser": {
    "origins": ["http://127.0.0.1:8080"],
    "allow_destructive": false,
    "timeout_ms": 60000
  }
}
```

只有列出了至少一个合法 `http`/`https` 源时，任务才会得到 `browser` 工具。地址里不能带账号口令，也不能是 `0.0.0.0` 或未指定地址。跳转到未允许的源会被中止。默认只允许观察、打开、点击和输入；删除、支付、结算一类动作需要 `allow_destructive` 为 `true`，或给出允许的路径前缀。

## 运行时边界

- 使用 Playwright 启动真实 Chromium（或 headless shell），每次任务用全新的用户目录，不读取主机桌面、已有浏览器会话或其中的 cookie。
- 可执行文件按 `BOT_BROWSER_EXECUTABLE`、Playwright 已安装路径、系统 Chromium 的顺序解析。找不到时任务得到明确错误 `browser_runtime_unavailable`，不会用假页面代替。
- 当前生产项目电脑镜像尚未预装 Chromium，由 [#916](https://github.com/agent-CI-Infra/bot/issues/916) 跟踪。控制面与 CI 使用 Playwright 缓存中的浏览器。
- 助手电脑的无外网边界不变。任务浏览器也不是默认的公网出口，只打开本任务列出的源。
- 超时或任务取消时关闭浏览器并删除临时用户目录；已经写下的截图和步骤保留，供事后查看。
- 向口令或密钥字段输入后，本轮不再保存截图。日志和 `execution_evidence` 里也不会留下口令、cookie 或同类字段的值。

## 查看证据

步骤元数据（路径、校验和、尺寸、结果）记在任务的 `execution_evidence` 里，像素本身只保存在数据库旁的 `browser-evidence/` 目录。控制台任务详情在有证据时显示「浏览器证据」。接口：

- `GET /api/tasks/:id/browser-evidence`：步骤列表（JSON）。
- `GET /api/tasks/:id/browser-evidence/step-N.png`：对应截图。仅任务可见范围内的调用者可读取，且只提供步骤清单里出现过的 PNG。

## 测试

默认 `npm test` 只覆盖策略与接口，不启动浏览器。真实浏览器验收在 `npm run test:e2e` 中的 `test/browser-runtime.mjs`：对本地受控夹具打开页面、截图，并拒绝越权和未授权的破坏性操作。本机或 CI 未安装 Chromium 时该测试失败，不会跳过算通过。
