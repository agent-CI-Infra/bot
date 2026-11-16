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
    zh: '社区运营与仓库健康度',
    en: 'Community & repository health',
  },
  'nav.community.group': { zh: '社区概览', en: 'Community' },
  'nav.community.pulls': { zh: 'Pull Requests', en: 'Pull Requests' },
  'nav.community.issues': { zh: 'Issues', en: 'Issues' },
  'nav.community.contributors': { zh: '贡献者', en: 'Contributors' },
  'nav.community.growth': { zh: '社区成长', en: 'Growth' },
  'nav.community.versions': { zh: '版本管理', en: 'Versions' },
  'nav.community.ecosystem': { zh: '生态影响力', en: 'Ecosystem' },
  'nav.about': { zh: '关于本站', en: 'About' },
  'nav.boards': { zh: '单仓看板', en: 'Repository boards' },

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
