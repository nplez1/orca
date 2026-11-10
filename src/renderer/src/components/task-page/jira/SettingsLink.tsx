import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

export function TaskPageJiraSettingsLink(): React.JSX.Element {
  const t = useTranslate()
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const label = t('auto.components.TaskPage.jiraTaskSettings', 'Jira task settings')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={label}
          onClick={() => {
            openSettingsPage()
            openSettingsTarget({
              pane: 'tasks',
              repoId: null,
              sectionId: 'tasks-jira-board'
            })
          }}
        >
          <Settings />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
