import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { IssueProviderIcon, issueProviderLabel } from './issue-provider-presentation'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

/** Inline-editable title for the pane header. Commits on Enter or blur, resets
 *  on Escape, and only commits a real change. */
function IssuePaneEditableTitle({
  title,
  saving,
  onCommit
}: {
  title: string
  saving: boolean
  onCommit: (title: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(title)
  useEffect(() => {
    setDraft(title)
  }, [title])

  return (
    <div className="mt-1.5 flex items-center gap-1">
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim()
          if (next && next !== title) {
            onCommit(next)
          } else {
            setDraft(title)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(title)
            event.currentTarget.blur()
          }
        }}
        disabled={saving}
        aria-label={translate('auto.components.right.sidebar.IssuePane.title', 'Issue title')}
        className={cn(
          '-mx-1 w-full rounded bg-transparent px-1 py-0.5 text-sm font-semibold leading-snug',
          'text-foreground outline-none transition hover:bg-muted/40 focus:bg-muted/60 focus:ring-1 focus:ring-ring'
        )}
      />
      {saving ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  )
}

/** Shared pane header: provider mark, identifier, title, refresh, and the
 *  provider launch button. Each provider body owns its own fetch, so the
 *  header is presentational and takes the resolved display values. */
export function IssuePaneHeader({
  provider,
  identifier,
  title,
  openUrl,
  titleLoading = false,
  titleSaving = false,
  refreshing = false,
  onRefresh,
  onTitleCommit
}: {
  provider: SupportedWorkspaceLinkedIssue['provider']
  identifier: string
  title: string
  openUrl: string | null
  titleLoading?: boolean
  titleSaving?: boolean
  refreshing?: boolean
  onRefresh: () => void
  /** When provided, the title becomes inline-editable. */
  onTitleCommit?: (title: string) => void
}): React.JSX.Element {
  const providerLabel = issueProviderLabel(provider)
  return (
    <header className="flex-none border-b border-border/60 px-3 py-3">
      <div className="flex items-center gap-2">
        <IssueProviderIcon
          provider={provider}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {identifier}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={translate(
                'auto.components.right.sidebar.IssuePane.refresh',
                'Refresh issue'
              )}
            >
              {refreshing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.right.sidebar.IssuePane.refresh', 'Refresh issue')}
          </TooltipContent>
        </Tooltip>
      </div>

      {onTitleCommit ? (
        <IssuePaneEditableTitle title={title} saving={titleSaving} onCommit={onTitleCommit} />
      ) : (
        <h2
          className={cn(
            'mt-1.5 overflow-hidden text-sm font-semibold leading-snug text-foreground',
            // Why: clamp to three lines so a long summary cannot push the fields
            // out of a 280px pane; the provider link below carries the full text.
            '[-webkit-box-orient:vertical] [-webkit-line-clamp:3] [display:-webkit-box]'
          )}
        >
          {title || (titleLoading ? '…' : identifier)}
        </h2>
      )}

      {openUrl ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full justify-center"
          onClick={() => void window.api.shell.openUrl(openUrl)}
        >
          <ExternalLink className="size-4" />
          {translate('auto.components.right.sidebar.IssuePane.openIn', 'Open in {{value0}}', {
            value0: providerLabel
          })}
        </Button>
      ) : null}
    </header>
  )
}
