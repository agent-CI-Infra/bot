import { useLang, type I18nKey } from '@/lib/i18n'
import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { TeamSwitcher } from './team-switcher'

/** Sidebar labels by route so titles follow the active language. */
const NAV_LABEL: Record<string, I18nKey> = {
  '/': 'nav.community.group',
  '/pulls': 'nav.community.pulls',
  '/issues': 'nav.community.issues',
  '/contributors': 'nav.community.contributors',
  '/growth': 'nav.community.growth',
  '/versions': 'nav.community.versions',
  '/ecosystem': 'nav.community.ecosystem',
  '/about': 'nav.about',
  '/gate': 'nav.qualityGates',
  '/gate-onboarding': 'gate.onboarding.entry',
}

/** Fallback for group titles when no route-specific label applies. */
const NAV_TITLE_LABEL: Record<string, I18nKey> = {
  社区概览: 'nav.community.group',
}

type SidebarItem = (typeof sidebarData.navGroups)[number]['items'][number]

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const { t } = useLang()

  const translateItems = (items: SidebarItem[]): SidebarItem[] =>
    items.map((item) => {
      const labelKey =
        NAV_LABEL[item.url as string] ?? NAV_TITLE_LABEL[item.title]
      const title = labelKey ? t(labelKey) : item.title
      if ('items' in item && item.items) {
        // The spread keeps the collapsible shape; the cast re-narrows the
        // discriminated union after overriding `title`.
        return {
          ...item,
          title,
          items: translateItems(item.items),
        } as typeof item
      }
      return { ...item, title }
    })

  const navGroups = sidebarData.navGroups.map((group) => ({
    ...group,
    items: translateItems(group.items),
  }))
  const teams = sidebarData.teams.map((team) => ({
    ...team,
    plan: t('app.tagline'),
  }))

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <TeamSwitcher teams={teams} />
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
