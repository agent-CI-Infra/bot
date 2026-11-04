import type { Lang } from '@/lib/i18n'

export type NeedKind = 'required' | 'optional' | 'gateRequired'

export type AboutCopy = {
  hero: { title: string; subtitle: string }
  site: {
    title: string
    description: string
    repoLabel: string
    siteLabel: string
    p1: string
    p2: string
  }
  add: {
    title: string
    description: string
    step1: { text: string; rulesTitle: string; rules: string[]; note: string }
    step2: { text: string; note: string }
    step3: { text: string }
    footer: string
  }
  info: {
    title: string
    description: string
    columns: { name: string; required: string; detail: string }
    needLabels: Record<NeedKind, string>
    rows: { label: string; need: NeedKind; detail: string }[]
  }
  gate: {
    title: string
    description: string
    intro: string
    configIntro: string
    bullets: string[]
    footer: string
  }
  data: {
    title: string
    description: string
    files: { codes: string[]; note: string }[]
    bullets: string[]
  }
  metrics: { title: string; bullets: string[] }
  notes: { title: string; bullets: string[] }
  feedback: { title: string; p1: string; p2: string }
}

export const ADD_SNIPPET = `{
  "your-org/your-repo": [
    "alice",
    "bob"
  ],
  "your-org/another-repo": []
}`

export const GATE_SNIPPET = `{
  "id": "your-repo",
  "name": "your-repo",
  "owner": "your-org",
  "defaultBranch": "main",
  "type": "status-board-lanes",
  "url": "/boards/your-org/your-repo/data/snapshot.json",
  "dashboardUrl": "/boards/your-org/your-repo/#overview",
  "boardBaseUrl": "/boards/your-org/your-repo/",
  "channelMap": [
    { "channel": "gate", "workflow": ["CI"] },
    { "channel": "daily", "workflow": ["Nightly"] },
    { "channel": "release", "workflow": ["Release"] }
  ],
  "laneRules": {
    "pr": { "channel": ["gate"], "event": ["pull_request"] },
    "main": { "channel": ["gate"], "event": ["push", "workflow_dispatch"] },
    "daily": { "channel": ["daily"] },
    "release": { "channel": ["release"] }
  },
  "coverageLine": "main",
  "coverage": {
    "artifacts": ["node-coverage-summary"],
    "summaryPaths": ["summary.json", "coverage/summary.json"]
  },
  "caseLayers": [
    {
      "name": "UT",
      "artifacts": ["ut-results"],
      "summaries": ["ut/tagged/group-*/summary.json"]
    }
  ]
}`

const ZH: AboutCopy = {
  hero: {
    title: '关于本站',
    subtitle:
      '开源社区运营与健康度监控平台：监控哪些仓库、如何接入新仓库、需要提供哪些信息，以及数据口径与更新节奏。',
  },
  site: {
    title: '站点与源码',
    description: '一个纯静态的监控看板：社区指标 + 可选接入的质量门禁。',
    repoLabel: '仓库：',
    siteLabel: '在线访问：',
    p1: '前端不携带任何 Token，所有展示数据都来自 bot 在 webhook 入口提供的公开数据快照；GitHub Token 只在数据采集时通过环境变量注入，不会写入任何产物。',
    p2: '页面包括社区总览、Pull Requests、Issues、社区成长、生态影响力（暂未开放）与质量门禁。已安装的公开仓默认进入汇总，私有仓需要管理员在仓库列表开启看板；{config} 仅保留内部贡献者分类规则。',
  },
  add: {
    title: '新增一个受监控仓库',
    description: '社区指标随已安装的公开仓默认提供；私有仓需要管理员在仓库列表开启看板。',
    step1: {
      text: '**安装仓库并确认公开范围。** 公开仓安装后默认提供；私有仓需管理员本地启用。可在 {config} 维护该仓库的 **内部贡献者** 分类规则，键为 `owner/name`，值为登录名数组：',
      rulesTitle: '该仓库的内 / 外部分类规则：',
      rules: [
        '数组内的登录名记为 **内部**；',
        '该仓库其余非 bot 作者记为 **外部**；',
        'bot 记为未知，不计入内部或外部。',
      ],
      note: '这份文件仅定义内部贡献者分类，不控制公开范围。私有仓必须由管理员在仓库列表开启看板。',
    },
    step2: {
      text: '**采集数据。** bot 使用源仓只读安装令牌采集，后续由已验证的 webhook 触发更新，无需运行外部工作流：',
      note: '安装令牌只用于后台采集，采集完成后撤销，不传给浏览器。',
    },
    step3: {
      text: '**确认结果。** 打开社区总览与社区成长，确认新仓库已出现。若数据为空，先看该仓库的 `meta.json` 中的 `errors`，再检查 bot 的本地采集状态。',
    },
    footer:
      '采集与镜像构建见 {collect} 和 {deploy}。安装状态及私有仓本地公开授权决定汇总范围，无需登记 PR。',
  },
  info: {
    title: '需要提供的信息',
    description: '除仓库全名外都可以后补：先接社区指标，再按需接入质量门禁。',
    columns: {
      name: '信息',
      required: '是否必须',
      detail: '说明 / 示例',
    },
    needLabels: {
      required: '必填',
      optional: '可选',
      gateRequired: '接入门禁时必填',
    },
    rows: [
      {
        label: '仓库全名',
        need: 'required',
        detail: '公开 GitHub 仓库的 `owner/name`，例如 `your-org/your-repo`。',
      },
      {
        label: '内部贡献者',
        need: 'optional',
        detail:
          'GitHub 登录名数组；留空 `[]` 时该仓库所有非 bot 作者都算外部。',
      },
      {
        label: '默认分支',
        need: 'optional',
        detail: '默认 `main`；接入质量门禁时用于定位覆盖率与分支线。',
      },
      {
        label: '是否接入质量门禁',
        need: 'optional',
        detail: '不接入时只展示社区指标；接入后质量门禁页增加该仓库一行。',
      },
      {
        label: '门禁看板快照',
        need: 'gateRequired',
        detail:
          'status board 的 `snapshot.json` 地址：`/boards/<owner>/<repo>/data/snapshot.json`',
      },
      {
        label: '门禁看板地址',
        need: 'optional',
        detail:
          '指标 pill 的深链，例如看板的 overview 页：`/boards/<owner>/<repo>/#overview`',
      },
      {
        label: '覆盖率产物',
        need: 'optional',
        detail:
          '覆盖率阈值为 75%；产物为 Actions artifact 名称前缀与包内 summary 路径，例如 `node-coverage-summary` 和 `summary.json`。',
      },
      {
        label: '用例分层',
        need: 'optional',
        detail:
          '层级名、artifact 前缀、summary glob，例如 `UT` / `ut-results` / `ut/tagged/group-*/summary.json`。',
      },
      {
        label: '联系人',
        need: 'optional',
        detail: '采集失败或数据异常时的联系人。',
      },
    ],
  },
  gate: {
    title: '可选：接入质量门禁',
    description:
      '按仓库 / 分支展示 PR-READY、PR-MERGE、DAILY、RELEASE 通过率与 UT 覆盖率，支持 24h / 7d / 30d 窗口。',
    intro:
      '质量门禁页的列与 SD status board 的车道一一对应：`pr → PR-READY`、`main → PR-MERGE`（SD 的「主干」）、`daily → DAILY`、`release → RELEASE`。`BUILD` 列保留但 SD 看板没有对应车道，因此为空。合并队列（`gh-readonly-queue/...`）会归到目标分支；cancelled / skipped 等未决结果不计入通过率分母。',
    configIntro: 'bot 从本地快照自动生成门禁来源，启用方式见 {gateConfig}。数据契约示例：',
    bullets: [
      '`url` / `dashboardUrl`：看板快照与看板入口；`boardBaseUrl` 用于生成指标深链。',
      '看板快照的 lane key 必须与上面的列映射一致（即 `pr`、`main`、`daily`、`release` 四种），否则该车道不会显示。',
      '`channelMap` / `laneRules`：把 workflow 名称归到 gate / daily / release 通道，并按 event / channel 定位每条车道的最新运行。',
      '`coverageLine` / `coverage`：在指定分支线上展示 UT 行覆盖率；缺少产物时显示为空，不影响通过率。',
      '`caseLayers`：每个测试层级的 artifact 前缀与 summary 文件，用于在门禁单元格上显示用例数；需要配合 `laneRules` 才能定位到最新运行。',
      '没有 status board 时，也可以用 `type: "actions-api"` 直接读 GitHub Actions，并在 `categoryMap` 中把 event / channel 映射到五个门禁列；具体匹配规则见 {gateCollect} 中的说明。',
    ],
    footer:
      '已验证的 webhook 触发本地采集，门禁汇总与单仓快照一起更新。单仓采集失败时保留上一次有效数据并重试。',
  },
  data: {
    title: '数据产物与更新节奏',
    description:
      '站点读取的是静态快照，不是实时 API；页面上的「数据更新于」就是采集时间。',
    files: [
      { codes: ['public/data/index.json'], note: '受监控仓库清单' },
      { codes: ['public/data/config.json'], note: '公开分类规则，不含密钥' },
      { codes: ['<owner>/<name>/meta.json'], note: '采集状态与错误' },
      {
        codes: ['latest.json', 'history.json'],
        note: '累计快照 / 每日历史',
      },
      {
        codes: ['pulls.json', 'issues.json', 'contributors.json'],
        note: '明细记录',
      },
      {
        codes: ['gate/index.json', 'gate/<owner>/<name>.json'],
        note: '门禁聚合数据',
      },
    ],
    bullets: [
      '**托管**：bot 在 webhook 入口直接提供 Dashboard 和单仓看板。',
      '**采集**：已验证 webhook 写入持久队列，后台增量采集并切换快照，不提交生成数据到 GitHub。',
      '**失败策略**：单个仓库失败不会中断其它仓库，失败时保留上一次有效数据，并把错误写进该仓库的 `meta.json`。',
      '**刷新视图**：页面读取最新本地快照；采集由已验证 webhook 触发。',
    ],
  },
  metrics: {
    title: '指标口径',
    bullets: [
      '**PR**：Open / 已合入（`merged_at` 非空）/ 关闭未合入；累计量与周期增量分开统计。',
      '**Issue**：统计时排除 PR；区分 Open / Closed；超过阈值（默认 30 天）的 Open Issue 计入长期未解决。',
      '**内 / 外部**：白名单制，按仓库区分；bot 记为未知，不计入内部或外部，各页面口径一致。',
      '**时间**：数据按 UTC 天切分存储，页面按访问者本地时区展示时间。',
      '**空值**：`null` 表示没有样本，`0` 表示真实的零，两者在图表和表格中不会混用。',
      '**门禁通过率**：窗口内 success 计为通过，failure / timed_out / startup_failure 计为失败，cancelled / skipped / neutral / stale / action_required 不计入分母；覆盖率低于 75% 标红。',
    ],
  },
  notes: {
    title: '注意事项',
    bullets: [
      '公开仓默认提供；私有仓只有管理员在仓库列表开启看板后才公开，启用会公开仓库名称与指标。',
      '私有仓公开启用需要控制台超管操作，不需要源仓写权限。',
      '新增后等待首轮本地采集；后续已验证 webhook 触发更新。',
      '不要把 Token 写进 `.env` 并提交；本地调试用命令行环境变量，CI 用 Actions secret。',
      '仓库改名或迁移组织后先同步安装状态，bot 会重新核对源仓身份与公开资格。',
      '采集失败时页面仍展示上次成功的数据；如果数字长期不更新，先看 `meta.json` 的 `errors` 与 bot 本地采集状态。',
    ],
  },
  feedback: {
    title: '反馈问题',
    p1: '接入过程中遇到问题，可以在 {issues} 提问。',
    p2: '提交 Issue 时请附上仓库全名、期望接入的页面（社区指标 / 质量门禁）、以及相关的 Actions 运行链接，便于快速定位。',
  },
}

const EN: AboutCopy = {
  hero: {
    title: 'About',
    subtitle:
      'A dashboard for open-source community operations and health: which repositories are monitored, how to add one, what information to provide, and how metrics are calculated and refreshed.',
  },
  site: {
    title: 'Site and source',
    description:
      'A fully static dashboard: community metrics plus optional Quality Gates.',
    repoLabel: 'Repository:',
    siteLabel: 'Live site:',
    p1: 'The frontend holds no tokens. All displayed data comes from public snapshots served by the bot on its webhook listener; the GitHub token is injected only as an environment variable during collection and is never written to any artifact.',
    p2: 'The site covers Community Overview, Pull Requests, Issues, Growth, Ecosystem (not yet available), and Quality Gates. The monitored list is defined by the keys in the {config} file: add a key to monitor another repository.',
  },
  add: {
    title: 'Add a monitored repository',
    description:
      'Boards are enabled by default for installed public repositories. An administrator must enable private snapshots locally in the repository list using the Board switch.',
    step1: {
      text: '**Register the repository and its internal contributors.** Add an entry to the {config} file. The key is the full repository name `owner/name`, and the value is the array of GitHub logins for the repository’s **internal contributors** (leave it empty if you do not have any yet):',
      rulesTitle:
        'How the repository classifies internal and external contributors:',
      rules: [
        'Logins in the array are counted as **internal**;',
        'Every other non-bot author is counted as **external**;',
        'Bots are counted as unknown and belong to neither group.',
      ],
      note: 'This file controls contributor classification only. Installation and local consent determine which repositories are public.',
    },
    step2: {
      text: '**Collect data.** The bot collects with source read tokens and verified webhooks trigger subsequent updates:',
      note: 'The source installation token stays in the background collector and is revoked afterwards.',
    },
    step3: {
      text: '**Verify the result.** Open Community Overview and Growth and confirm the new repository appears. If the data is empty, check `errors` in the repository’s `meta.json` first, then the local collection status in the bot.',
    },
    footer:
      'See {collect} and {deploy} for the collection and deploy flows. You can temporarily override the monitored list with the `MONITOR_REPOS` environment variable (comma-separated), but long-term additions should go in the config file.',
  },
  info: {
    title: 'What to provide',
    description:
      'Everything except the full repository name can be added later: start with community metrics, then connect Quality Gates when needed.',
    columns: {
      name: 'Item',
      required: 'Required?',
      detail: 'Details / example',
    },
    needLabels: {
      required: 'Required',
      optional: 'Optional',
      gateRequired: 'Required (Gates)',
    },
    rows: [
      {
        label: 'Full repository name',
        need: 'required',
        detail:
          '`owner/name` of a public GitHub repository, for example `your-org/your-repo`.',
      },
      {
        label: 'Internal contributors',
        need: 'optional',
        detail:
          'An array of GitHub logins. Leave it as `[]` to count every non-bot author as external.',
      },
      {
        label: 'Default branch',
        need: 'optional',
        detail:
          'Defaults to `main`. Used by Quality Gates to locate coverage and branch lines.',
      },
      {
        label: 'Connect Quality Gates?',
        need: 'optional',
        detail:
          'If omitted, only community metrics are shown. When connected, the repository gets a row on the Quality Gates page.',
      },
      {
        label: 'Gate board snapshot',
        need: 'gateRequired',
        detail:
          'The status board’s `snapshot.json` URL: `/boards/<owner>/<repo>/data/snapshot.json`',
      },
      {
        label: 'Gate board URL',
        need: 'optional',
        detail:
          'Deep link for metric pills, such as the board overview: `/boards/<owner>/<repo>/#overview`',
      },
      {
        label: 'Coverage artifacts',
        need: 'optional',
        detail:
          'The threshold is 75%. Provide the Actions artifact name prefix and the summary path inside the artifact, for example `node-coverage-summary` and `summary.json`.',
      },
      {
        label: 'Test case layers',
        need: 'optional',
        detail:
          'Layer name, artifact prefix, and summary glob, for example `UT` / `ut-results` / `ut/tagged/group-*/summary.json`.',
      },
      {
        label: 'Contact',
        need: 'optional',
        detail: 'Who to contact if collection fails or the data looks wrong.',
      },
    ],
  },
  gate: {
    title: 'Optional: connect Quality Gates',
    description:
      'Shows PR-READY, PR-MERGE, DAILY, and RELEASE pass rates plus UT coverage per repository and branch, with 24h / 7d / 30d windows.',
    intro:
      'The columns on the Quality Gates page map one-to-one to the SD status board lanes: `pr → PR-READY`, `main → PR-MERGE` (the SD “mainline”), `daily → DAILY`, and `release → RELEASE`. The `BUILD` column is kept but has no corresponding lane on the SD board, so it stays empty. Merge-queue refs (`gh-readonly-queue/...`) are attributed to the target branch; unresolved results such as cancelled / skipped are excluded from the pass-rate denominator.',
    configIntro:
      'The bot generates sources from its local snapshots; see {gateConfig} for enabling repositories. Data contract example:',
    bullets: [
      '`url` / `dashboardUrl`: the board snapshot and board entry point. `boardBaseUrl` is used to build metric deep links.',
      'The lane keys in the board snapshot must match the column mapping above (`pr`, `main`, `daily`, `release`). Otherwise the lane is not displayed.',
      '`channelMap` / `laneRules`: map workflow names to the gate / daily / release channels and locate the latest run for each lane by event / channel.',
      '`coverageLine` / `coverage`: show UT line coverage on the specified branch line. When artifacts are missing the value is blank and does not affect the pass rate.',
      '`caseLayers`: the artifact prefix and summary file for each test layer, used to show case counts in gate cells. It relies on `laneRules` to find the latest run.',
      'Without a status board, use `type: "actions-api"` to read GitHub Actions directly and map events / channels to the five gate columns in `categoryMap`. See {gateCollect} for the exact matching rules.',
    ],
    footer:
      'Verified webhooks update local repository snapshots and gate datasets together. Collection failures retain the last valid data and retry.',
  },
  data: {
    title: 'Data artifacts and refresh cadence',
    description:
      'The site reads static snapshots, not a live API. The “data updated” timestamp on the page is the collection time.',
    files: [
      { codes: ['public/data/index.json'], note: 'monitored repository list' },
      {
        codes: ['public/data/config.json'],
        note: 'public classification rules, no secrets',
      },
      {
        codes: ['<owner>/<name>/meta.json'],
        note: 'collection status and errors',
      },
      {
        codes: ['latest.json', 'history.json'],
        note: 'cumulative snapshot / daily history',
      },
      {
        codes: ['pulls.json', 'issues.json', 'contributors.json'],
        note: 'detailed records',
      },
      {
        codes: ['gate/index.json', 'gate/<owner>/<name>.json'],
        note: 'aggregated Quality Gates data',
      },
    ],
    bullets: [
      '**Hosting**: the bot directly serves Dashboard and repository boards on the webhook listener.',
      '**Collection**: verified webhooks enqueue durable incremental collection; generated data stays in the local data volume.',
      '**Failure handling**: one failing repository does not stop the others. The last valid data is kept and the error is written to that repository’s `meta.json`.',
      '**Refresh the view**: pages read the latest local snapshots; verified webhooks trigger collection.',
    ],
  },
  metrics: {
    title: 'Metric definitions',
    bullets: [
      '**PR**: Open / merged (`merged_at` is set) / closed without merging. Cumulative totals and period deltas are reported separately.',
      '**Issue**: PRs are excluded. Open and Closed are reported separately. Open issues older than the threshold (30 days by default) count as long-standing.',
      '**Internal / external**: allowlist-based and per repository. Bots are unknown and belong to neither group; every page uses the same rule.',
      '**Time**: data is bucketed by UTC day and rendered in the visitor’s local time zone.',
      '**Empty values**: `null` means no sample, while `0` means a real zero. Charts and tables never mix the two.',
      '**Gate pass rate**: within the window, success counts as passed; failure / timed_out / startup_failure count as failed; cancelled / skipped / neutral / stale / action_required are excluded from the denominator. Coverage below 75% is shown in red.',
    ],
  },
  notes: {
    title: 'Things to know',
    bullets: [
      'Installed public repositories are available automatically. Private names and metrics become public only after explicit local administrator consent.',
      'Private publication requires a console super administrator; it does not require repository write access.',
      'Wait for initial local collection; verified webhooks trigger subsequent updates.',
      'Never commit a token in `.env`. Use command-line environment variables locally and Actions secrets in CI.',
      'After a repository rename or transfer, synchronize installations so the bot can verify repository identity and publication eligibility.',
      'If collection fails, the page keeps showing the last successful data. If the numbers stay stale, check `errors` in `meta.json` and the local collection status.',
    ],
  },
  feedback: {
    title: 'Feedback',
    p1: 'If you run into a problem while connecting a repository, ask in {issues}.',
    p2: 'When opening an Issue, include the full repository name, the page you want to connect (community metrics / Quality Gates), and links to the relevant Actions runs so we can investigate quickly.',
  },
}

export const ABOUT_COPY: Record<Lang, AboutCopy> = { zh: ZH, en: EN }
