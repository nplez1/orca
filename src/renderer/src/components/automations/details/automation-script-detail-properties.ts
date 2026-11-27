import type { AutomationScript } from '../../../../../shared/automations/automation-definition'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import type { Translate } from '@/i18n/use-translate'
import {
  getAutomationReportOptions,
  getAutomationShellOptions
} from '../authoring/automation-script-option-copy'

export function getAutomationScriptDetailProperties(
  script: AutomationScript,
  t: Translate,
  intlLocale: string
): { key: string; label: string; value: string | undefined }[] {
  return [
    {
      key: 'shell',
      label: t('automations.command.shell', 'Shell'),
      value: getAutomationShellOptions(t).find((option) => option.value === script.shell)?.label
    },
    {
      key: 'timeout',
      label: t('automations.command.timeout', 'Timeout'),
      value: formatUiNarrowDuration(script.timeoutSeconds, 'second', intlLocale)
    },
    {
      key: 'report',
      label: t('automations.command.report', 'Report'),
      value: getAutomationReportOptions(t).find((option) => option.value === script.report)?.label
    }
  ]
}
