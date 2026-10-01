import { CircleDot, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** Loading / unavailable / no-link states for the Issue pane. */
export function IssuePaneMessage({
  kind,
  providerLabel,
  onRetry
}: {
  kind: 'loading' | 'unavailable' | 'none'
  providerLabel?: string
  onRetry?: () => void
}): React.JSX.Element {
  if (kind === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (kind === 'unavailable') {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.IssuePane.unavailable',
            "Couldn't load this {{value0}} issue.",
            { value0: providerLabel ?? '' }
          )}
        </p>
        {onRetry ? (
          <Button variant="outline" size="xs" className="w-fit" onClick={onRetry}>
            <RefreshCw className="size-3" />
            {translate('auto.components.right.sidebar.IssuePane.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <CircleDot className="size-6 text-muted-foreground/60" />
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.IssuePane.noIssue',
          'No issue is linked to this workspace.'
        )}
      </p>
    </div>
  )
}
