import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { EmptyState } from './components/states'

export function EcosystemInfluence() {
  return (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>生态影响力</h1>
          <p className='text-sm text-muted-foreground'>
            GitHub 之外的传播与触达。
          </p>
        </div>

        <EmptyState
          title='暂未开放'
          description='该功能正在建设中，敬请期待。'
        />
      </Main>
    </>
  )
}
