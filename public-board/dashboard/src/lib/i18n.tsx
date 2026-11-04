import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getCookie, setCookie } from '@/lib/cookies'

export type Lang = 'zh' | 'en'

const LANG_COOKIE = 'vite-ui-lang'

/** zh/en string pairs for every UI string. */
const DICT = {
  'app.tagline': {
    zh: '社区运营与质量门禁',
    en: 'Community & quality gates',
  },
  'nav.community.group': { zh: '社区概览', en: 'Community' },
  'nav.community.pulls': { zh: 'Pull Requests', en: 'Pull Requests' },
  'nav.community.issues': { zh: 'Issues', en: 'Issues' },
  'nav.community.contributors': { zh: '贡献者', en: 'Contributors' },
  'nav.community.growth': { zh: '社区成长', en: 'Growth' },
  'nav.community.versions': { zh: '版本管理', en: 'Versions' },
  'nav.community.ecosystem': { zh: '生态影响力', en: 'Ecosystem' },
  'nav.about': { zh: '关于本站', en: 'About' },
  'nav.qualityGates': { zh: '质量门禁', en: 'Quality Gates' },

  'search.placeholder': {
    zh: '搜索仓库 / PR / 运行 ID',
    en: 'Search repos / PRs / run IDs',
  },
  'timeRange.24h': { zh: '近 24 小时', en: 'Last 24 hours' },
  'timeRange.7d': { zh: '近 7 天', en: 'Last 7 days' },
  'timeRange.30d': { zh: '近 30 天', en: 'Last 30 days' },
  'notify.label': { zh: '通知', en: 'Notifications' },
  'theme.light': { zh: '浅色', en: 'Light' },
  'theme.dark': { zh: '深色', en: 'Dark' },
  'theme.system': { zh: '跟随系统', en: 'System' },
  'theme.switch': { zh: '切换主题', en: 'Switch theme' },
  'lang.switch': { zh: '切换语言', en: 'Switch language' },
  'lang.zh': { zh: '中文', en: '中文' },
  'lang.en': { zh: 'English', en: 'English' },

  'community.title': { zh: '社区概览', en: 'Community Overview' },
  'community.description': {
    zh: '开源社区运营与健康度监控平台，动态展示社区规模、健康度、影响力与活跃度。',
    en: 'Open-source community operations and health monitoring — community scale, activity, health and influence at a glance.',
  },
  'community.dataUpdatedAt': { zh: '数据更新时间', en: 'Data updated' },
  'community.activity': { zh: '活跃度', en: 'Activity' },
  'community.topActivity': { zh: '活跃度最高', en: 'Most active' },
  'community.metric.contributors': { zh: '累计贡献者', en: 'Contributors' },
  'community.metric.activeContributors': {
    zh: '活跃贡献者',
    en: 'Active contributors',
  },
  'community.contributorsInfo': {
    zh: '统计最近 30 天内创建过 PR 或 Issue 的去重作者数（含外部作者）。',
    en: 'Unique authors who opened a PR or issue in the last 30 days (external authors included).',
  },
  'community.extSuffix': { zh: '(外部{n})', en: '({n} ext)' },
  'community.pr.total': { zh: 'PR累计', en: 'Total PRs' },
  'community.pr.open': { zh: 'Open', en: 'Open' },
  'community.issue.total': { zh: 'Issue累计', en: 'Total issues' },
  'community.internal': { zh: '内部', en: 'Internal' },
  'community.external': { zh: '外部', en: 'External' },
  'community.comments.total': { zh: '评论总数', en: 'Total comments' },
  'community.comments.avg': { zh: '平均每条评论数', en: 'Avg comments' },
  'community.score.title': {
    zh: '社区活跃度公式',
    en: 'Community activity formula',
  },
  'community.score.metric': { zh: '指标', en: 'Metric' },
  'community.score.threshold': { zh: '阈值', en: 'Threshold' },
  'community.score.weight': { zh: '权重', en: 'Weight' },
  'community.score.window': {
    zh: '统计最近 {days} 天，Sᵢ 为指标实际值。',
    en: 'Computed over the last {days} days; Sᵢ is the observed value.',
  },

  'state.loading': { zh: '正在加载数据…', en: 'Loading data…' },
  'state.empty.title': { zh: '暂无数据', en: 'No data' },
  'state.empty.desc': {
    zh: '该部分尚未采集到数据。',
    en: 'This section has not collected data yet.',
  },
  'state.error.title': { zh: '无法加载数据', en: 'Failed to load data' },
  'state.error.desc': {
    zh: '数据文件无法读取，可能尚未发布。',
    en: 'Data files could not be read; they may not be published yet.',
  },
  'state.retry': { zh: '重试', en: 'Retry' },

  'gate.title': { zh: '质量门禁', en: 'Quality Gates' },
  'gate.subtitle': {
    zh: '各仓库门禁通过率',
    en: 'Per-repository quality gate performance',
  },
  'gate.windowSelect': {
    zh: '切换统计窗口',
    en: 'Change the measurement window',
  },
  'gate.col.repo': { zh: '仓库', en: 'Repository' },
  'gate.col.build': { zh: '构建', en: 'Build' },
  'gate.col.ready': { zh: 'PR-Ready', en: 'PR-Ready' },
  'gate.col.merge': { zh: 'PR-Merge', en: 'PR-Merge' },
  'gate.col.daily': { zh: '每日', en: 'Daily' },
  'gate.col.release': { zh: '发布', en: 'Release' },
  'gate.col.coverage': { zh: '覆盖率', en: 'Coverage' },
  'gate.live': { zh: '实时 · 30s', en: 'Live · 30s' },
  'gate.branches': { zh: '分支', en: 'Branches' },
  'gate.demo': { zh: '演示', en: 'Demo' },
  'gate.casesPlanned': { zh: '计划', en: 'planned' },
  'gate.level': { zh: '等级', en: 'Level' },
  'gate.levelHint': { zh: '合规等级 C0–C4', en: 'Compliance level C0–C4' },
  'gate.stage.discovered': { zh: '已发现', en: 'Discovered' },
  'gate.stage.gatesRunning': { zh: '运行中', en: 'Running' },
  'gate.stage.casesPending': { zh: '待填用例', en: 'Cases pending' },
  'gate.stage.observing': { zh: '观察中', en: 'Observing' },
  'gate.stage.enforced': { zh: '已生效', en: 'Enforced' },
  'gate.stage.failing': { zh: '失败', en: 'Failing' },
  'gate.cases.todo': { zh: '待填 {n}', en: '{n} to fill' },
  'gate.cases.notRun': { zh: '未执行 {n}', en: '{n} not run' },
  'gate.cases.ready': {
    zh: '用例 {ready}/{total}',
    en: 'Cases {ready}/{total}',
  },
  'gate.openBoard': { zh: '打开完整看板', en: 'Open full board' },
  'gate.funnel.title': { zh: '接入漏斗', en: 'Onboarding funnel' },
  'gate.casesHint': {
    zh: '用例数：通过/计划（最近一次运行）',
    en: 'Cases passed/planned in the latest run',
  },
  'gate.openSource': {
    zh: '在数据来源看板中查看',
    en: 'View on the source dashboard',
  },
  'gate.demoHint': {
    zh: '该仓库尚未接入真实门禁数据，数值为设计占位',
    en: 'Real gate data is not wired in yet — these numbers are placeholders',
  },
  'gate.switchBranch': { zh: '切换分支', en: 'Switch branch' },
  'gate.synced': {
    zh: '数据同步自 GitHub · 2 分钟前',
    en: 'Synced from GitHub · 2 min ago',
  },
  'gate.summary': {
    zh: '{total} 个仓库 · {passed} 通过 · {failed} 失败 · {running} 运行中',
    en: '{total} repositories · {passed} passing · {failed} failing · {running} running',
  },
  'gate.boards.entry': { zh: '单仓看板', en: 'Repo boards' },
  'gate.onboarding.entry': { zh: '接入门禁', en: 'Add gates' },
  'gate.onboarding.title': { zh: '接入门禁', en: 'Add gates to your repo' },
  'gate.onboarding.subtitle': {
    zh: '把 CI-workflow 模板复制到你的仓库，四步跑通五条 lane。',
    en: 'Copy the CI-workflow template into your repository and run five lanes in four steps.',
  },
  'gate.onboarding.back': {
    zh: '返回质量门禁',
    en: 'Back to Quality Gates',
  },
  'gate.onboarding.hero.title': {
    zh: '从模板到自动门禁',
    en: 'From template to automatic gates',
  },
  'gate.onboarding.hero.desc': {
    zh: '门禁接入发生在源仓；单仓看板由本仓统一托管和汇总，不需要另建看板仓。',
    en: 'Gate onboarding happens in the source repository; this site hosts and aggregates repository boards, with no separate board repository.',
  },
  'gate.onboarding.issueHint': {
    zh: '公开仓默认开启看板；私有仓请管理员在仓库列表开启看板。',
    en: 'Boards are enabled by default for installed public repositories; ask an administrator to enable private snapshots locally in the repository list using the Board switch.',
  },
  'gate.onboarding.tutorial': {
    zh: '打开模板教程',
    en: 'Open template guide',
  },
  'gate.onboarding.request': {
    zh: '提交接入申请',
    en: 'Request onboarding',
  },
  'gate.onboarding.step1.title': { zh: '复制模板', en: 'Copy the template' },
  'gate.onboarding.step1.body': {
    zh: '在仓库根目录执行；如果已有 .github 或 scripts，合并而不是覆盖。',
    en: 'Run from the repository root; merge instead of overwriting existing .github or scripts.',
  },
  'gate.onboarding.step2.title': {
    zh: '配置 lane 命令',
    en: 'Configure lane commands',
  },
  'gate.onboarding.step2.body': {
    zh: '编辑 .github/ci-gates.json，把 build / lint / test 换成项目真实命令。',
    en: 'Edit .github/ci-gates.json and replace build / lint / test with your real commands.',
  },
  'gate.onboarding.step3.title': { zh: '登记用例', en: 'Register cases' },
  'gate.onboarding.step3.body': {
    zh: '在 test/cases/case-catalog.yaml 中加用例；ready 用例需要 file、owner 和 case 标记。',
    en: 'Add cases to test/cases/case-catalog.yaml; ready cases need file, owner and a case marker.',
  },
  'gate.onboarding.step4.title': {
    zh: '设置 required check',
    en: 'Require the check',
  },
  'gate.onboarding.step4.body': {
    zh: '管理员在 Rulesets / Branch protection 中把 CI Gates / gate 设为必需检查。',
    en: 'An admin makes CI Gates / gate a required check in Rulesets / Branch protection.',
  },
  'gate.onboarding.step4.mergeQueue': {
    zh: '启用 merge queue 后，merge_group 会自动跑 build + pr-merge。',
    en: 'With merge queue enabled, merge_group runs build + pr-merge automatically.',
  },
  'gate.onboarding.board.title': {
    zh: '单仓看板由公仓托管',
    en: 'Repository boards are hosted here',
  },
  'gate.onboarding.boardNote': {
    zh: '公开仓安装后默认提供 /boards/<owner>/<repo>/ 看板，由已验证 webhook 更新；私有仓需要管理员在仓库列表开启看板，启用后快照对外公开。门禁报告仍显示 lane 结论与用例数。',
    en: 'Installed public repositories default to hosting boards at /boards/<owner>/<repo>/ and updated by verified webhooks. An administrator must enable private snapshots locally in the repository list using the Board switch before they become public. Gate reports retain lane verdicts and case counts.',
  },
  'gate.onboarding.boardTemplate': {
    zh: '查看单仓看板',
    en: 'Browse repository boards',
  },
  'gate.onboarding.boardCreate': {
    zh: '查看托管看板',
    en: 'View hosted boards',
  },
  'gate.onboarding.boardLink': {
    zh: '查看当前门禁看板',
    en: 'View the current gate board',
  },
  'gate.empty': {
    zh: '没有匹配的仓库',
    en: 'No repositories match the current search',
  },
} as const

export type I18nKey = keyof typeof DICT

type LanguageContextValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  /** Translate a key, interpolating `{name}` params. */
  t: (key: I18nKey, params?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'zh',
  setLang: () => null,
  t: (key) => DICT[key].zh,
})

function resolveInitialLang(): Lang {
  const saved = getCookie(LANG_COOKIE)
  if (saved === 'zh' || saved === 'en') return saved
  return typeof navigator !== 'undefined' &&
    navigator.language?.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en'
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, _setLang] = useState<Lang>(resolveInitialLang)

  const setLang = useCallback((next: Lang) => {
    _setLang(next)
    setCookie(LANG_COOKIE, next, 60 * 60 * 24 * 365)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>) => {
      let text: string = DICT[key][lang]
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(value))
        }
      }
      return text
    },
    [lang]
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLang() {
  return useContext(LanguageContext)
}
