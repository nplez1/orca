import type {
  AutomationCommandReport,
  AutomationCommandShell
} from '../../../../../shared/automations/automation-definition'
import type { Translate } from '@/i18n/use-translate'

type ScriptOption<T> = { value: T; label: string; description: string }

export function getAutomationShellOptions(t: Translate): ScriptOption<AutomationCommandShell>[] {
  return [
    {
      value: 'login',
      label: t('automations.command.shellLogin', 'Login shell'),
      description: t(
        'automations.command.shellLoginHelp',
        'Your login shell, so your PATH applies.'
      )
    },
    {
      value: 'plain',
      label: t('automations.command.shellPlain', 'Plain shell'),
      description: t('automations.command.shellPlainHelp', 'Skips your shell’s login files.')
    }
  ]
}

export function getAutomationReportOptions(t: Translate): ScriptOption<AutomationCommandReport>[] {
  return [
    {
      value: 'on-output',
      label: t('automations.command.reportOnOutput', 'When it prints something'),
      description: t(
        'automations.command.reportOnOutputHelp',
        'Delivers the output; a run that prints nothing stays quiet.'
      )
    },
    {
      value: 'silent',
      label: t('automations.command.reportSilent', 'Never'),
      description: t(
        'automations.command.reportSilentHelp',
        'Output is only kept in the run’s details.'
      )
    },
    {
      value: 'always',
      label: t('automations.command.reportAlways', 'Every run'),
      description: t(
        'automations.command.reportAlwaysHelp',
        'Reports each run, even when it prints nothing.'
      )
    }
  ]
}
