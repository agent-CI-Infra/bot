import { Check, Languages } from 'lucide-react'
import { useLang, type Lang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const OPTIONS: { value: Lang; labelKey: 'lang.zh' | 'lang.en' }[] = [
  { value: 'zh', labelKey: 'lang.zh' },
  { value: 'en', labelKey: 'lang.en' },
]

/** Chinese / English language switch for the topbar. */
export function LanguageSwitch() {
  const { lang, setLang, t } = useLang()

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={t('lang.switch')}
        title={t('lang.switch')}
        className='flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
      >
        <Languages className='size-[18px]' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='min-w-32'>
        {OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => setLang(option.value)}
            className='text-[12px] font-medium'
          >
            {t(option.labelKey)}
            <Check
              size={14}
              className={cn('ms-auto', lang !== option.value && 'hidden')}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
