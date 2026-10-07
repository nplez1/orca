import React from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SessionSummaryLedgerView } from '@/components/activity/session-summary-ledger-view'
import { resolveSessionSummaryHeaderState } from '@/components/activity/session-summary-presentation'
import { useSessionSummary } from '@/components/activity/use-session-summary'
import { useAppStore } from '@/store'
import { useSessionSummaryPaneKey, hasSessionSummaryBridge } from './session-summary-subject'

function SessionSummarySubjectBody({
  paneKey,
  isOpen
}: {
  paneKey: string
  isOpen: boolean
}): React.JSX.Element {
  const snapshot = useSessionSummary(paneKey, isOpen)
  const { hint, folding } = resolveSessionSummaryHeaderState(snapshot)

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5">
        <Info className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
  // A new agent session can start inside the pane the user is already focused on, so the
  // key includes its identity: the service resets the ledger on open(), and without this the
  // pane would keep briefing the previous conversation.
  const sessionId = useAppStore((state) =>
    paneKey ? (state.agentStatusByPaneKey[paneKey]?.providerSession?.id ?? '') : ''
  )

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
          isOpen={isVisible}
        />
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
