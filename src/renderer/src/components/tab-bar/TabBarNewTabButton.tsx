import React, { useCallback, useEffect, useRef } from 'react'
import { ChevronDown, Loader2, Plus } from 'lucide-react'
import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useTabBarDefaultAgent, type DefaultAgentSource } from './use-tab-bar-default-agent'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** How long the primary control must be held before the create menu opens. */
export const NEW_TAB_HOLD_TO_OPEN_MENU_MS = 350

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: React's CSSProperties omits Electron's WebkitAppRegion titlebar property.
const NO_DRAG_STYLE: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

const PLAIN_BUTTON_CLASS =
  'ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

const SPLIT_GROUP_CLASS =
  'group/new-tab ml-2 my-auto flex h-7 shrink-0 select-none items-stretch rounded-md [-webkit-touch-callout:none]'

const SPLIT_PRIMARY_CLASS =
  'flex w-7 items-center justify-center rounded-l-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'

// Why: opacity keeps the chevron clickable and focusable; `hidden`/`display:none` would drop it
// out of the tab order and make the menu unreachable by keyboard. Width matches the quick-commands
// split-button chevron so both tab-bar split controls read the same.
const SPLIT_CHEVRON_CLASS =
  'flex w-5 items-center justify-center rounded-r-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover/new-tab:opacity-100 group-focus-within/new-tab:opacity-100 data-[state=open]:opacity-100'

const preventContextMenu = (event: React.MouseEvent): void => event.preventDefault()

/**
 * Press-and-hold on a button that also has a primary click action. The release after a
 * completed hold emits a click on top of the just-opened menu; the caller suppresses that
 * click by reading the menu state rather than by tracking a flag, so a hold released off the
 * control can never swallow a later activation.
 */
function useHoldToOpenMenu(onOpenMenu: () => void): {
  onPointerDown: () => void
  onPointerUp: () => void
} {
  const timerRef = useRef<number | null>(null)
  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) {
      return
    }
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  const onPointerDown = useCallback((): void => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      onOpenMenu()
    }, NEW_TAB_HOLD_TO_OPEN_MENU_MS)
  }, [clearTimer, onOpenMenu])

  return { onPointerDown, onPointerUp: clearTimer }
}

function PlainNewTabTrigger(): React.JSX.Element {
  const label = translate('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="new-tab-button"
            className={PLAIN_BUTTON_CLASS}
            style={NO_DRAG_STYLE}
            // Why: with no launchable agent this is the "+" E2E matches by its exact "New tab" name; the
            // split controls below are addressed by data-testid because their labels name the agent.
            aria-label={label}
          >
            <Plus className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function SplitNewTabTrigger({
  agent,
  isAgentLaunchPending,
  isMenuOpen,
  onLaunchAgent,
  onOpenMenu
}: {
  agent: TuiAgent
  isAgentLaunchPending: boolean
  isMenuOpen: boolean
  onLaunchAgent: (agent: TuiAgent) => void
  onOpenMenu: () => void
}): React.JSX.Element {
  const agentLabel = getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
  const launchLabel = translate(
    'auto.components.tab.bar.TabBarDefaultAgentButton.2a0cbdc8a1',
    'Open {{value0}} in a new tab',
    { value0: agentLabel }
  )
  const moreOptionsLabel = translate(
    'auto.components.tab.bar.TabBarNewTabButton.729bccd8bd',
    'More options'
  )
  const holdHint = translate(
    'auto.components.tab.bar.TabBarNewTabButton.6417e68a08',
    'Hold for all new tab options'
  )
  const hold = useHoldToOpenMenu(onOpenMenu)

  return (
    <div className={SPLIT_GROUP_CLASS} style={NO_DRAG_STYLE}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="new-tab-button"
            className={SPLIT_PRIMARY_CLASS}
            aria-label={launchLabel}
            disabled={isAgentLaunchPending}
            onClick={() => {
              // Why: the release after a hold emits a click while the menu it just opened is up;
              // launching there would fire the primary action underneath the menu.
              if (isMenuOpen) {
                return
              }
              onLaunchAgent(agent)
            }}
            onPointerDown={hold.onPointerDown}
            onPointerUp={hold.onPointerUp}
            onPointerLeave={hold.onPointerUp}
            onPointerCancel={hold.onPointerUp}
            onContextMenu={preventContextMenu}
          >
            {isAgentLaunchPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <AgentIcon agent={agent} size={14} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          <span className="block">{launchLabel}</span>
          <span className="block text-[10px] text-background/70">{holdHint}</span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="new-tab-menu-trigger"
              className={SPLIT_CHEVRON_CLASS}
              aria-label={moreOptionsLabel}
            >
              <ChevronDown className="size-3" strokeWidth={2.5} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {moreOptionsLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The tab bar's new-tab control. With a launchable default agent it is a split button —
 * click launches that agent, hold (or the chevron) opens the create menu. Without one it
 * degrades to the original single "+" that opens the menu on click.
 */
export function TabBarNewTabButton({
  worktreeId,
  agentSource = 'detected',
  isMenuOpen,
  onLaunchAgent,
  onOpenMenu
}: {
  worktreeId: string
  /** Floating panels ask for `configured`: their synthetic worktree has no detected agents. */
  agentSource?: DefaultAgentSource
  /** The create menu's open state, owned by the tab bar; a hold-release click must not launch under it. */
  isMenuOpen: boolean
  onLaunchAgent: (agent: TuiAgent) => void
  onOpenMenu: () => void
}): React.JSX.Element {
  const { agent, isAgentLaunchPending } = useTabBarDefaultAgent(worktreeId, agentSource)
  if (agent === null) {
    return <PlainNewTabTrigger />
  }
  return (
    <SplitNewTabTrigger
      agent={agent}
      isAgentLaunchPending={isAgentLaunchPending}
      isMenuOpen={isMenuOpen}
      onLaunchAgent={onLaunchAgent}
      onOpenMenu={onOpenMenu}
    />
  )
}
