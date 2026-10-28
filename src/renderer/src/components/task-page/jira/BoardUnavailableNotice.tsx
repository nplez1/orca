import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** Why a configured board is not on screen: the runtime serving Jira predates the board view. */
export function TaskPageJiraBoardUnavailableNotice({
  onRetry
}: {
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border/50 bg-muted/35 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Info className="size-3.5 flex-none" />
      <span className="min-w-0 flex-1">
        {translate(
          'auto.components.TaskPage.jiraBoardRequiresNewRuntime',
          'This Jira runtime does not support board views. Showing the issue list instead.'
        )}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        {translate('auto.components.TaskPage.0bfbf62f75', 'Retry')}
      </Button>
    </div>
  )
}
