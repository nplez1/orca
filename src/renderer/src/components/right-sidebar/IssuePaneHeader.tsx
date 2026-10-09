import { useEffect, useState } from 'react'
import { Ellipsis, Link, LoaderCircle, RefreshCw, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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

/** Unlink / re-link actions for a linked issue. Rendered only when the body
 *  supplies both — see `useLinkedIssuePaneActions`. */
function IssuePaneLinkMenu({
  identifier,
  providerLabel,
  disabledReason,
  onUnlinkIssue,
  onLinkAnotherIssue
}: {
  identifier: string
  providerLabel: string
  /** Why the actions cannot run here; disables them and explains instead. */
  disabledReason: string | null
  onUnlinkIssue: () => void
  onLinkAnotherIssue: () => void
}): React.JSX.Element {
  const moreActionsLabel = translate(
    'auto.components.right.sidebar.IssuePane.moreActions',
    'More issue actions'
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={moreActionsLabel}>
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {/* Why visible text rather than a tooltip: a disabled menu item is skipped
            by keyboard navigation and takes no pointer events, so an explanation
            hung off it can never be read. */}
        {disabledReason ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{disabledReason}</p>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem disabled={disabledReason !== null} onSelect={onUnlinkIssue}>
              <Unlink className="size-3.5" />
              {translate(
                'auto.components.right.sidebar.IssuePane.unlinkIssue',
                'Unlink issue from workspace'
              )}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={8} className="max-w-72">
            {translate(
              'auto.components.right.sidebar.IssuePane.unlinkIssueDescription',
              'Orca will hide {{value0}} from this workspace. The issue on {{value1}} won’t be changed.',
              { value0: identifier, value1: providerLabel }
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuItem disabled={disabledReason !== null} onSelect={onLinkAnotherIssue}>
          <Link className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.IssuePane.linkAnotherIssue',
            'Link another issue'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Shared pane header: provider mark, identifier, title, refresh, and the
 *  provider body's own link actions. Each provider body owns its own fetch, so
 *  the header is presentational and takes the resolved display values. */
export function IssuePaneHeader({
  provider,
  identifier,
  title,
  openUrl,
  titleLoading = false,
  titleSaving = false,
  refreshing = false,
  onRefresh,
  onTitleCommit,
  onOpenIssue,
  onUnlinkIssue,
  onLinkAnotherIssue,
  linkActionsDisabledReason = null
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
  /** When provided, the identifier becomes a link to the issue on its provider. */
  onOpenIssue?: (url: string, event: React.MouseEvent<HTMLButtonElement>) => void
  onUnlinkIssue?: () => void
  onLinkAnotherIssue?: () => void
  /** Why the link actions cannot run here; disables them and explains instead. */
  linkActionsDisabledReason?: string | null
}): React.JSX.Element {
  const providerLabel = issueProviderLabel(provider)
  const openTitle = translate(
    'auto.components.right.sidebar.IssuePane.openIn',
    'Open on {{value0}}',
    { value0: providerLabel }
  )

  return (
    <header className="flex-none border-b border-border/60 px-3 py-3">
      <div className="flex items-center gap-2">
        <IssueProviderIcon
          provider={provider}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        {openUrl && onOpenIssue ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded px-0.5 text-left font-mono text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={(event) => onOpenIssue(openUrl, event)}
              >
                {identifier}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {openTitle}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="min-w-0 flex-1 truncate px-0.5 font-mono text-[11px] text-muted-foreground">
            {identifier}
          </span>
        )}
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
        {onUnlinkIssue && onLinkAnotherIssue ? (
          <IssuePaneLinkMenu
            identifier={identifier}
            providerLabel={providerLabel}
            disabledReason={linkActionsDisabledReason}
            onUnlinkIssue={onUnlinkIssue}
            onLinkAnotherIssue={onLinkAnotherIssue}
          />
        ) : null}
      </div>

      {onTitleCommit ? (
        <IssuePaneEditableTitle title={title} saving={titleSaving} onCommit={onTitleCommit} />
      ) : (
        <h2
          className={cn(
            'mt-1.5 overflow-hidden text-sm font-semibold leading-snug text-foreground',
            // Why: clamp to three lines so a long summary cannot push the fields
            // out of a 280px pane.
            '[-webkit-box-orient:vertical] [-webkit-line-clamp:3] [display:-webkit-box]'
          )}
        >
          {title || (titleLoading ? '…' : identifier)}
        </h2>
      )}
    </header>
  )
}
