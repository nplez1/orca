import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import {
  DASHBOARD_BUCKET_ORDER,
  dashboardCardRevealArgs,
  type DashboardBucket,
  type DashboardCard,
  type DashboardSnapshot,
  type DashboardRevealAgentArgs as AgentRevealArgs
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { cn } from '@/lib/class-names'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { AgentKanbanLaneCardList } from './AgentKanbanLaneCardList'
import { AgentDashboardToolbar } from './AgentDashboardToolbar'
import { AgentTerminalDialog } from '../terminal-preview/AgentTerminalDialog'
import { EMPTY_DASHBOARD_FILTERS, type DashboardFilters } from './agent-board-filtering'
import './agent-board-transitions.css'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { createDashboardBoardProjection, type DashboardLane } from './agent-board-projection'
import { dashboardCardIndex } from '../snapshot/dashboard-card-changes'

function bucketLabel(bucket: DashboardBucket, t: Translate = translate): string {
  switch (bucket) {
    case 'attention':
      return t('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return t('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return t('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return t('dashboardPopout.bucket.idle', 'Idle')
  }
}

function KanbanColumn({
  bucket,
  cards,
  lane,
  repoIconsByRepoId,
  now,
  dialogPaneKey,
  onOpenTerminal
}: {
  bucket: DashboardBucket
  cards: DashboardCard[]
  lane: DashboardLane
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  dialogPaneKey: string | null
  onOpenTerminal: (card: DashboardCard) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = bucketLabel(bucket, t)
  // State, not a ref: the list's virtualizer must re-render once the parent scroller attaches.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  return (
    // Cards carry attention color; keep the column neutral to avoid duplicate signaling.
    <section
      aria-label={label}
      className="flex min-w-[264px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto rounded-full bg-background px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {lane.indexes.length}
        </span>
      </header>
      <div
        ref={setScrollElement}
        className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {lane.indexes.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {t('dashboardPopout.bucket.empty', 'None')}
          </p>
        ) : (
          <AgentKanbanLaneCardList
            cards={cards}
            lane={lane}
            scrollElement={scrollElement}
            repoIconsByRepoId={repoIconsByRepoId}
            now={now}
            dialogPaneKey={dialogPaneKey}
            onOpenTerminal={onOpenTerminal}
          />
        )}
      </div>
    </section>
  )
}

type AgentKanbanBoardProps = {
  snapshot: DashboardSnapshot
  /** Sizing for the outermost container. The dashboard page fills its host
   *  (`h-full w-full`). */
  containerClassName?: string
  /** Marks an agent as seen. */
  onAckAgent: (paneKey: string) => void
  /** Focuses the agent's pane. */
  onRevealAgent: (args: AgentRevealArgs) => void
  /** When provided, renders a close control in the header. */
  onClose?: () => void
  onBrowserForeground?: () => void
  /** Header controls rendered before the close button. */
  headerActions?: React.ReactNode
}

/** The agent board: status columns fed by a snapshot. */
export function AgentKanbanBoard({
  snapshot,
  containerClassName = 'h-full w-full',
  onAckAgent,
  onRevealAgent,
  onClose,
  onBrowserForeground,
  headerActions
}: AgentKanbanBoardProps): React.JSX.Element {
  const t = useTranslate()
  const visibleBuckets = useMemo(
    () =>
      DASHBOARD_BUCKET_ORDER.filter((bucket) => bucket !== 'idle' || snapshot.showIdle === true),
    [snapshot.showIdle]
  )
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS)
  const [projectBoard] = useState(createDashboardBoardProjection)
  const { lanes, visibleCards, hasRelativeTimestamps } = projectBoard(
    snapshot.cards,
    snapshot.showIdle === true,
    query,
    filters
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!hasRelativeTimestamps) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => setNow(Date.now()),
      intervalMs: 30_000
    })
  }, [hasRelativeTimestamps])

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent): void => {
      const usesPlatformModifier = navigator.userAgent.includes('Mac')
        ? event.metaKey
        : event.ctrlKey
      if (!usesPlatformModifier || event.key.toLowerCase() !== 'k') {
        return
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"], .xterm')
      ) {
        return
      }
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    document.addEventListener('keydown', handleSearchShortcut)
    return () => document.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  // Why: the setting decides where a click lands — the workspace itself (the
  // default) or the live terminal preview. The board owns the choice so both
  // hosts behave identically without threading another prop.
  const cardClickAction = snapshot.cardClickAction ?? 'workspace'
  // The open terminal dialog survives bucket moves: only the paneKey is
  // remembered, and the card data is re-resolved from each fresh snapshot.
  // The opened card is kept as a fallback so the dialog also survives the
  // card vanishing entirely (pane closed) — the user dismisses it explicitly.
  // Its live routing is cleared because daemon PTY ids can be reused.
  const [openedCard, setOpenedCard] = useState<DashboardCard | null>(null)
  const dialogCard = useMemo(() => {
    if (!openedCard) {
      return null
    }
    return (
      snapshot.cards[dashboardCardIndex(snapshot.cards, openedCard.paneKey)] ?? {
        ...openedCard,
        ptyId: null,
        leafId: null
      }
    )
  }, [snapshot.cards, openedCard])
  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setOpenedCard(null)
    }
  }, [])

  // Seen-state is the app-wide ack map (same signal as the sidebar's bold/mute
  // rows): activating an agent acks it, and the next snapshot comes back with
  // unseen=false.
  const handleOpenTerminal = useCallback(
    (card: DashboardCard) => {
      onAckAgent(card.paneKey)
      if (cardClickAction === 'workspace') {
        onRevealAgent(dashboardCardRevealArgs(card))
        return
      }
      setOpenedCard(card)
    },
    [cardClickAction, onAckAgent, onRevealAgent]
  )
  // Acknowledge state changes while watched so open-dialog cards do not become unseen again.
  useEffect(() => {
    if (dialogCard?.unseen) {
      onAckAgent(dialogCard.paneKey)
    }
  }, [dialogCard?.paneKey, dialogCard?.unseen, onAckAgent])

  return (
    // Pop-outs have no app provider; supply the card tooltip provider in either host.
    <TooltipProvider>
      <div
        className={cn('relative flex flex-col bg-background text-foreground', containerClassName)}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5 pr-[max(1rem,var(--window-controls-width,0px))]">
          <h1 className="text-[13px] font-semibold">{t('dashboardPopout.title', 'Agents')}</h1>
          <span className="text-[11px] text-muted-foreground">
            {t('dashboardPopout.total', '{{count}} total', {
              count: visibleCards.length
            })}
          </span>
          {headerActions || onClose ? (
            <div className="ml-auto flex items-center gap-1">
              {headerActions}
              {onClose ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t('dashboardPopout.close', 'Close dashboard')}
                  className="rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <XIcon className="size-4" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <AgentDashboardToolbar
          cards={visibleCards}
          filterOptions={snapshot.filterOptions}
          filteredCount={visibleBuckets.reduce(
            (count, bucket) => count + lanes[bucket].indexes.length,
            0
          )}
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          onFiltersChange={setFilters}
          searchInputRef={searchInputRef}
        />
        <div className="scrollbar-sleek flex min-h-0 flex-1 overflow-x-auto p-3">
          {/* Auto margins center the capped board and collapse during horizontal overflow. */}
          <div className="mx-auto flex w-full max-w-[1280px] gap-3">
            {visibleBuckets.map((bucket) => (
              <KanbanColumn
                key={bucket}
                bucket={bucket}
                cards={snapshot.cards}
                lane={lanes[bucket]}
                repoIconsByRepoId={snapshot.repoIconsByRepoId}
                now={now}
                dialogPaneKey={openedCard?.paneKey ?? null}
                onOpenTerminal={handleOpenTerminal}
              />
            ))}
          </div>
        </div>
        <AgentTerminalDialog
          card={dialogCard}
          onOpenChange={handleDialogOpenChange}
          onReveal={onRevealAgent}
          onBrowserForeground={onBrowserForeground}
        />
      </div>
    </TooltipProvider>
  )
}
