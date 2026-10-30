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
import { IssueProviderIcon, issueProviderLabel } from './issue-provider-presentation'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

/** One attached issue as the switcher lists and selects it. */
export type IssuePaneIssueOption = {
  key: string
  provider: SupportedWorkspaceLinkedIssue['provider']
  identifier: string
  title: string | null
}

/** The pane-owned selection state the header and the switcher share. */
export type IssuePaneIssueSwitcherProps = {
  options: readonly IssuePaneIssueOption[]
  selectedKey: string
  onSelectIssue: (key: string) => void
}

/** The issue's identifier, as a link to its provider when there is a URL. */
export function IssuePaneIssueIdentifier({
  provider,
  identifier,
  openUrl,
  onOpenIssue,
  className
}: {
  provider: SupportedWorkspaceLinkedIssue['provider']
  identifier: string
  openUrl: string | null
  onOpenIssue?: (url: string, event: React.MouseEvent<HTMLButtonElement>) => void
  className?: string
}): React.JSX.Element {
  const shared = cn('min-w-0 truncate px-0.5 font-mono text-2xs text-muted-foreground', className)
  if (!openUrl || !onOpenIssue) {
    return <span className={shared}>{identifier}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Why the attribute: this is a button-styled link, so the app's link menu needs it declared.
          data-link-url={openUrl}
          className={cn(
            shared,
            'rounded text-left underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
          onClick={(event) => onOpenIssue(openUrl, event)}
        >
          {identifier}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.components.right.sidebar.IssuePane.openIn', 'Open on {{value0}}', {
          value0: issueProviderLabel(provider)
        })}
      </TooltipContent>
    </Tooltip>
  )
}

/** Split control for a workspace with more than one issue: the identifier keeps
 *  the pane's primary action (open the issue), the chevron picks which issue the
 *  pane shows.
 *
 *  The selection is the pane's own view, not the workspace's active issue: an
 *  active issue is a compatibility slot per provider, so promoting one across
 *  providers would clear a sibling link rather than reorder them. */
export function IssuePaneIssueSwitcher({
  provider,
  identifier,
  openUrl,
  onOpenIssue,
  switcher
}: {
  provider: SupportedWorkspaceLinkedIssue['provider']
  identifier: string
  openUrl: string | null
  onOpenIssue?: (url: string, event: React.MouseEvent<HTMLButtonElement>) => void
  switcher: IssuePaneIssueSwitcherProps
}): React.JSX.Element {
  const switchLabel = translate(
    'auto.components.right.sidebar.IssuePane.switchIssue',
    'Switch issue'
  )

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <IssuePaneIssueIdentifier
        provider={provider}
        identifier={identifier}
        openUrl={openUrl}
        onOpenIssue={onOpenIssue}
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="issue-pane-switcher"
                aria-label={switchLabel}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent/60 data-[state=open]:text-foreground"
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
            value={switcher.selectedKey}
            onValueChange={switcher.onSelectIssue}
          >
            {switcher.options.map((option) => (
              <DropdownMenuRadioItem
                key={option.key}
                value={option.key}
                className="my-0.5 items-start"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <IssueProviderIcon
                      provider={option.provider}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate font-mono text-2xs text-foreground">
                      {option.identifier}
                    </span>
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {option.title ?? issueProviderLabel(option.provider)}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
