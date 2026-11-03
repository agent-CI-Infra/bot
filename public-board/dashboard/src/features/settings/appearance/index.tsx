import { ContentSection } from '../components/content-section'
import { AppearanceForm } from './appearance-form'

export function SettingsAppearance() {
  return (
    <ContentSection
      title='外观'
      desc='自定义应用的外观。在日间和夜间主题之间自动切换。'
    >
      <AppearanceForm />
    </ContentSection>
  )
}
