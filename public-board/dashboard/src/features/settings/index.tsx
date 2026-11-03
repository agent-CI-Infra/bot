import { Outlet } from '@tanstack/react-router'
import { Palette } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { SidebarNav } from './components/sidebar-nav'

const sidebarNavItems = [
  {
    title: '外观',
    href: '/settings/appearance',
    icon: <Palette size={18} />,
  },
]

export function Settings() {
  return (
    <>
      {/* ===== Top Heading ===== */}
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>

      <Main fixed>
        <div className='space-y-0.5'>
          <h1 className='text-2xl font-bold tracking-tight md:text-3xl'>
            设置
          </h1>
          <p className='text-muted-foreground'>管理应用的外观与显示偏好。</p>
        </div>
        <Separator className='my-4 lg:my-6' />
        <div className='flex flex-1 flex-col space-y-2 overflow-hidden md:space-y-2 lg:flex-row lg:space-y-0 lg:space-x-12'>
          <aside className='top-0 lg:sticky lg:w-1/5'>
            <SidebarNav items={sidebarNavItems} />
          </aside>
          <div className='flex w-full overflow-y-hidden p-1'>
            <Outlet />
          </div>
        </div>
      </Main>
    </>
  )
}
