import {
  Activity,
  BookOpen,
  CircleDot,
  GitPullRequest,
  Globe,
  Info,
  LayoutDashboard,
  LineChart,
  ShieldCheck,
  Tags,
  Users,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  teams: [
    {
      name: 'AI应用与软件创新Lab',
      logo: Activity,
      plan: '开源社区运营与健康度监控平台',
    },
  ],
  navGroups: [
    {
      title: '',
      items: [
        {
          // Collapsible group: its header links to the Overview page and
          // the sub-sections expand on click (see nav-group's
          // SidebarMenuCollapsible).
          title: '社区概览',
          url: '/',
          icon: LayoutDashboard,
          items: [
            {
              title: 'Pull Requests',
              url: '/pulls',
              icon: GitPullRequest,
            },
            {
              title: 'Issues',
              url: '/issues',
              icon: CircleDot,
            },
            {
              title: '贡献者',
              url: '/contributors',
              icon: Users,
            },
            {
              title: '社区成长',
              url: '/growth',
              icon: LineChart,
            },
            {
              title: '版本管理',
              url: '/versions',
              icon: Tags,
            },
            {
              title: '生态影响力',
              url: '/ecosystem',
              icon: Globe,
            },
          ],
        },
        {
          title: '质量门禁',
          url: '/gate',
          icon: ShieldCheck,
          items: [
            {
              title: '接入门禁',
              url: '/gate-onboarding',
              icon: BookOpen,
            },
          ],
        },
        {
          title: '关于本站',
          url: '/about',
          icon: Info,
        },
      ],
    },
  ],
}
