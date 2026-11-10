import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** Why a configured board is not on screen: the runtime serving Jira predates the board view. */
export function TaskPageJiraBoardUnavailableNotice({
  onRetry
}: {
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border/50 bg-muted/35 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Info className="size-3.5 flex-none" />
      <span className="min-w-0 flex-1">
        {t(
          'auto.components.TaskPage.jiraBoardRequiresNewRuntime',
          'This Jira runtime does not support board views. Showing the issue list instead.'
        )}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        {t('auto.components.TaskPage.0bfbf62f75', 'Retry')}
      </Button>
    </div>
  )
}
