# 测试分层、并行分片与防腐化设计

本文档定义 launchpad 自动化测试体系的分层职责、并行执行与 CI 分片机制，以及长期防止测试架构腐化的核心设计不变量。命令入口与本地开发步骤见 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。

## 测试分层与职责边界

全部自动化测试集中在 `test/` 下，各层职责互斥互补，**每一类缺陷优先落到能可靠捕获它的最轻层级**：

| 层级与目录 | 执行器 | 适用范围 | 不应放入的内容 |
| --- | --- | --- | --- |
| **UT (`test/ut/`)** | `node --test`（`test-sets.mjs`） | 纯函数、算法、状态机、协议解析、安全边界单测；前端文案/词典/错误格式化/分页/轮询退避状态机（在 `test/ut/static/` 通过 `loadConsole` 毫秒级验证）；跨文件架构红线守卫（如设计令牌、原始错误文案清扫）。 | 需要真实多模块 SQLite 协同或真实浏览器布局引擎才能验证的逻辑。 |
| **ST (`test/st/`)** | `node --test`（`test-sets.mjs`） | 进程内控制面集成测试：真实 SQLite + 本地 HTTP API + 本地假 GitHub/模型/飞书夹具 + 多 Harness 协议（Native / Process / Pi / Claude Code / Codex / ACP）、权限边界、恢复与状态机。 | 真实外网访问、真实 Docker 镜像操作；与前端渲染强绑定的交互。 |
| **E2E (`test/e2e/`)** | Playwright Chromium | **用户视角的完整端到端主流程**（真实导航、登录/登出/会话切换、跨页流转、表单提交与持久化回显）以及**依赖真实浏览器渲染引擎的布局与可访问性验证**（多视口溢出、表格折叠、`elementFromPoint` 遮挡、焦点迁移、实时区语义）。 | 已在 `test/ut/static/` 覆盖的纯文案/错误码/时间格式矩阵；为单个微回归新开独立文件重复走一遍后端与登录冷启动。 |
| **Docker (`test/docker/`)** | 独立脚本（`npm run test:*:docker`） | 真实容器隔离、只读根文件系统、降权用户、预装软件、部署与恢复验收。 | 不并入日常 `npm test` 单元测试池。 |
| **Live (`test/live/`)** | 独立 `node --test` | 真实外部服务（GitHub、飞书、外部模型）或本机 CLI 实况探针（`*.live.test.mjs`）。 | 禁止进入默认并行池。 |
| **Framework (`test/framework/`)** | 基础设施 | 测试集发现（`test-plan.mjs`）、并发调度（`test-sets.mjs`）、回环网络守卫（`test-network-guard.mjs`）、双分片汇总与权重计算（`unit-shards.mjs`）。 | 业务断言。 |

进程内用假模型驱动角色与任务机制的 ST 用例，把项目角色配置为只在测试进程注册的脚本化驱动 `scripted`（`test/fixtures/scripted-driver.mjs`，由 `scripted-roles.mjs` 写入角色配置）。它自带模型与工具往返，不经过控制面的 Native 工具循环：角色运行与 `process` 驱动的 worker 循环相同；服务助手的一轮与 Pi 相同。管理助手和群聊助手的夹具（`management-fixture`、`channel-fixture`、`onboarding-fixture`）也让服务助手使用它。它和 Pi 一样声明 `steered_turns`，在进程内按 Pi 的服务回合协议运行：工具经 harness 工具分发器执行，回合中的新消息在工具批次之间并入，回答流式输出，来源被编辑后重启，`stay_silent` 结束安静的轮次。会话工作区由夹具借给它一个空工作区。真实 Pi 会话由 `service-turn-pi`、`pi-service-assistants` 覆盖。生产进程不注册它；它以不列出（`listed: false`）的方式注册，所以即使在长期存活的测试进程（如 Playwright worker）里，角色编辑器和 Agent 后端列表也不会出现它。

## 并行执行、资源隔离与 CI 分片

### 1. UT / ST 测试集并行模型

- **集内串行、集间并行**：默认每个 `test/ut/**/*.test.mjs` 与 `test/st/**/*.test.mjs` 文件自成一个测试集，各自运行在独立的 `node --test --test-concurrency=1` 子进程中；确需共享状态的多文件通过文件头 `// test-set: <name> <reason>` 合并为同一集。
- **进程级资源隔离**：`test-sets.mjs` 为每个测试集分配独立 `.tmp/tests-*/<set>/` 下的 `TMPDIR` 与 `HOME`，清掉 `XDG_*` 与 `TMP`/`TEMP` 环境变量。用例内部遵循：临时目录用 `mkdtempSync(join(tmpdir(), '<prefix>-'))` 并在 `t.after` 清理、HTTP 监听 `127.0.0.1` 随机端口 `listen(0)`、宿主机 runner 工作区使用 `randomWorkspaceId()`。
- **回环外网络硬拦截**：`test-network-guard.mjs` 通过 `NODE_OPTIONS=--import=...` 注入每个测试集子进程，拦截任何回环外 TCP 连接并记入集日志，即便被测代码吞掉错误也会判该集失败。
- **真实 Pi SDK 一致性**：CI 预先安装 `runner/` 依赖并传 `BOT_REQUIRE_PI=1` 强制零 `skip`；本地全量复现 CI 用例集合时须先执行 `npm ci --prefix runner --omit=dev --ignore-scripts` 并携带 `BOT_REQUIRE_PI=1`。

### 2. CI 双分片与权重确定性

- `.github/workflows/checks.yml` 将 UT/ST 拆为 2 个独立 runner（`BOT_TEST_SHARD=1/2`、`2/2`，每台固定 `BOT_TEST_JOBS=4`），基于仓内签入的 `test/framework/test-set-weights.json` 做确定性贪心负载均衡（本地 `.tmp/test-set-durations.json` 只影响启动顺序，绝不改变分片成员）。
- 汇总作业 `unit` 运行 `node test/framework/unit-shards.mjs merge .tmp/unit-shards`，强校验两片在同一 `planHash`/`corpusHash`/`revision` 下互斥、全覆盖、零失败、零取消。
- E2E 由 `test/e2e/playwright.config.mjs` 按 spec 文件级并行（文件内串行、文件间共享本机 worker 池，CI 上为 4 workers）。

## 防止测试架构腐化的五条设计红线

快速迭代下，测试套件容易因“逐 Issue 叠加微文件”“顺手保留调试截图”“在重型层级重复覆盖轻逻辑”而迅速膨胀并拖慢门禁。所有新增与评审均须守住以下五条红线：

### 1. 分层归属不越位，E2E 不与 UT 重复
- **先问能否在 UT 测完**：纯前端文案、国际化词典、错误码映射、时间格式化、分页边界计算与轮询退避状态机，优先放在 `test/ut/static/`（`loadConsole` 单测耗时通常在数十毫秒级）。
- **E2E 只承担浏览器不可替代的价值**：聚焦用户视角完整主链路、真实后端接口联动、鉴权跳转、真实浏览器网络/焦点行为及多视口布局检验；当 `test/ut/static/` 已覆盖完整分支矩阵时，E2E 至多在对应主题 spec 中保留 1 条端到端冒烟流，禁止再把全部错误码或文案分支逐条在 Playwright 中起独立后端重复验证。

### 2. 按业务主题内聚，杜绝“一 Issue 一文件”碎片化
- 新增回归测试优先并入对应页面或模块的既有主题 spec，复用夹具与登录会话；不要为单个细微缺陷新建只有 1 个用例的独立 E2E 文件，避免让大量微文件反复支付 worker 调度、SQLite 建库与页面登录的固定冷启动开销。
- 同理，极小的纯静态校验（如检查同一 Dockerfile 预装包）应归并到同主题 UT 文件，避免为两行正则单起一个独立 Node 测试进程。

### 3. 长期测试严禁残留一次性验收副产物
- **禁止提交无断言的 `page.screenshot(...)` 与 `.tmp/.../evidence.json` 写盘**：PR 评审所需的界面前后对比图属于一次性验证证据，应按仓库卫生规则在本地验证阶段采集并附在 PR 描述/评论（或独立资产分支），绝不能写死进长期 CI 用例中，否则每次门禁都会白白执行数百次无意义的全页渲染与磁盘写入。
- 仅在测试确实对视觉输出或下载产物做程序化断言时，才允许写入测试自有临时目录并在结束时清理。

### 4. 主动规避四类慢测试反模式
- **多秒真实 `waitForTimeout` 死等**：轮询间隔、退避重试与超时提示在 E2E 中应使用 Playwright `page.clock.install()` + `page.clock.runFor(...)`（配合 `waitForResponse` 等显式事件同步，防止异步竞态），或下沉到 `test/ut/static/` 用受控时钟验证；不得用 5–15 秒真实睡眠硬等定时器触发。
- **大循环串行 HTTP 造数**：需要数十/上百条前置数据时（如跨页分页、超出目录首屏上限），通过单次 `store.transaction(...)` 批量写入 SQLite，而非在 `for` 循环中串行发上百次 HTTP 请求与 fsync。
- **无收益的后端 × 入口完整笛卡尔积**：多 Harness 后端（`native`、`process`、`pi` 等）与多业务入口组合测试时，采用覆盖矩阵——所有业务入口都在轻量 `native` 上验证接线与契约，重型后端（尤其需冷启动真实 SDK 的 `pi`）只覆盖有差异的代表性入口（如单角色与团队委派各一），不盲目铺满全乘积。
- **与行为测试重复的易碎源码正则**：跨文件架构红线守卫（如禁止直接插值 `err.message`、设计令牌单源声明、工作流超时上限）属于高价值静态检查；但针对单文件局部实现细节（具体变量名、三元表达式写法）的正则断言若已有同文件真实 DOM/行为测试覆盖，应直接移除，避免重构即误报。

### 5. 定期保鲜 CI 分片权重
- `test/framework/test-set-weights.json` 只对已登记集生效；未登记的新增测试集会按文件字节数线性估算权重，若新增多个重型 ST 集（尤其是真实 Pi / 多模态 / 大型集成测试），极易被集中分到同一分片造成同机型持续失衡。
- 当新增或大幅调整重型测试集，或巡检发现大量未计权集引发同机型双片持续失衡时，使用至少 3 次完整可比 CI 运行的 `unit-balance.json` 执行 `node test/framework/unit-shards.mjs weights <b1> <b2> <b3> [...]` 刷新 `test-set-weights.json` 并随 PR 合入。
