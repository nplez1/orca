import React from 'react'
import { Info, RefreshCw, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SessionSummaryLedgerView } from '@/components/activity/session-summary-ledger-view'
import { resolveSessionSummaryHeaderState } from '@/components/activity/session-summary-presentation'
import { useSessionSummary } from '@/components/activity/use-session-summary'
import { useAppStore } from '@/store'
import {
  useSessionSummaryExecutionHostId,
  useSessionSummaryHostSupported,
  useSessionSummaryPaneKey,
  useSessionSummarySessionRef,
  hasSessionSummaryBridge
} from './session-summary-subject'

function SessionSummarySubjectBody({
  paneKey,
  executionHostId,
  isOpen
}: {
  paneKey: string
  executionHostId: string | null
  isOpen: boolean
}): React.JSX.Element {
  // Why the pane's own records: this window is the process holding the pane, so what it knows
  // about the session outranks the folding side's row — which may be absent (a paired host
  // that only runs the PTY) or relayed without the agent's transcript path.
  const session = useSessionSummarySessionRef(paneKey)
  const agentUpdatedAt = useAppStore((state) => state.agentStatusByPaneKey[paneKey]?.updatedAt ?? 0)
  const { snapshot, refresh, refreshing } = useSessionSummary(
    paneKey,
    isOpen,
    executionHostId,
    session,
    agentUpdatedAt
  )
  const { hint, folding } = resolveSessionSummaryHeaderState(snapshot)

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5">
        <StickyNote className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('activity.sessionSummary.label', 'Session summary')}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs text-muted-foreground',
            folding && 'animate-pulse'
          )}
        >
          {hint}
        </span>
        {folding ? (
          <span className="h-3 w-1.5 shrink-0 animate-pulse rounded-sm bg-muted-foreground/70" />
        ) : null}
        {/* Why a button: the fold spends a model call, so it runs on a timer rather than on
            every chunk the agent produces — this is the "now, please" the reader controls. */}
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          aria-label={translate('activity.sessionSummary.refresh', 'Refresh summary')}
          title={translate('activity.sessionSummary.refresh', 'Refresh summary')}
          className={cn(
            'shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground',
            refreshing && 'animate-spin opacity-60'
          )}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="px-4 py-3">
          <SessionSummaryLedgerView snapshot={snapshot} />
        </div>
      </div>
    </>
  )
}

/** Right-sidebar pane briefing the agent session this workspace is running.
 *
 *  The fold only runs while the pane is on screen (`isOpen`), which is the whole
 *  point of the feature: no LLM cost for sessions nobody reads. */
export default function SessionSummaryPane({
  isVisible
}: {
  isVisible: boolean
}): React.JSX.Element {
  const paneKey = useSessionSummaryPaneKey()
  const executionHostId = useSessionSummaryExecutionHostId()
  const hostSupported = useSessionSummaryHostSupported()
  // A new agent session can start inside the pane the user is already focused on, so the
  // key includes its identity: the service resets the ledger on open(), and without this the
  // pane would keep briefing the previous conversation. Read from the same resolver as the
  // request, so a session that parked its identity still keys the pane.
  const sessionId = useSessionSummarySessionRef(paneKey)?.providerSession?.id ?? ''

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {!hasSessionSummaryBridge() ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Info className="size-6 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {translate(
              'activity.sessionSummary.unavailableInWindow',
              'Session summaries are not available in this window.'
            )}
          </p>
        </div>
      ) : paneKey ? (
        // Why key: focus moves between agents while the pane stays mounted, and a
        // last-seen cursor belongs to one session — a fresh instance starts the next
        // one clean instead of inheriting the previous session's read count.
        <SessionSummarySubjectBody
          key={`${paneKey}:${sessionId}`}
          paneKey={paneKey}
          executionHostId={executionHostId}
          isOpen={isVisible}
        />
      ) : !hostSupported ? (
        // Why: this is not "nothing is focused" — the workspace's host is one this build
        // cannot place, so telling the reader to focus an agent would be wrong.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Info className="size-6 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {translate(
              'activity.sessionSummary.unsupportedHost',
              'Session summaries are not available for a workspace on this host.'
            )}
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Info className="size-6 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {translate(
              'activity.sessionSummary.notFocused',
              'Focus an agent session to see its summary.'
            )}
          </p>
        </div>
      )}
    </div>
  )
}
