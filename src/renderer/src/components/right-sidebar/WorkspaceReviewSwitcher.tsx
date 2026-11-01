import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceReviewSelectionEntry } from './workspace-review-selection'
import type { WorkspaceReviewSelection } from './use-workspace-review-selection'

/** What a review is called in the switcher: `PR #12` on GitHub and `MR !12` on GitLab. */
export function workspaceReviewLabel(
  entry: Pick<WorkspaceReviewSelectionEntry, 'provider' | 'number'>
): string {
  return entry.provider === 'gitlab' ? `MR !${entry.number}` : `PR #${entry.number}`
}

/** The chevron that picks which of a workspace's reviews a pane describes.
 *
 *  It is a sibling of the pane's own review link rather than a replacement for it: the link keeps
 *  the pane's primary action (open the review), and the chevron only changes what the pane reads.
 *  Both panes render this, and they share one selection, so the two can never disagree about which
 *  review is shown. */
export function WorkspaceReviewSwitcher({
  selection,
  className
}: {
  selection: WorkspaceReviewSelection
  className?: string
}): React.JSX.Element | null {
  const switchLabel = translate(
    'auto.components.right.sidebar.WorkspaceReviewSwitcher.switchReview',
    'Switch pull request'
  )
  if (!selection.hasMultiple) {
    return null
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="workspace-review-switcher"
              aria-label={switchLabel}
              className={cn(
                'shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent/60 data-[state=open]:text-foreground',
                className
              )}
            >
              <ChevronDown className="size-3" strokeWidth={2.5} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {switchLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup
          value={selection.selected?.key ?? ''}
          onValueChange={selection.selectReview}
        >
          {selection.entries.map((entry) => (
            <DropdownMenuRadioItem key={entry.key} value={entry.key} className="my-0.5 items-start">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-mono text-2xs text-foreground">
                  {workspaceReviewLabel(entry)}
                </span>
                <span className="truncate text-2xs text-muted-foreground">
                  {entry.title ||
                    translate(
                      'auto.components.right.sidebar.WorkspaceReviewSwitcher.untitledReview',
                      'Untitled review'
                    )}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
