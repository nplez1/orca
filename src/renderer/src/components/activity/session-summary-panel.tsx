import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SessionSummaryLedgerView } from './session-summary-ledger-view'
import { resolveSessionSummaryHeaderState } from './session-summary-presentation'
import { useSessionSummary } from './use-session-summary'

/** Collapsed "Session summary" strip for the Activity thread detail pane.
 *
 *  The Activity page is not reachable from the current shell (nothing calls
 *  `openActivityPage`), so the right-sidebar summary pane is the live surface;
 *  this strip is kept so the pane still renders correctly if the view returns. */
export function SessionSummaryPanel({ paneKey }: { paneKey: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const snapshot = useSessionSummary(paneKey, expanded)
  const { hint, folding } = resolveSessionSummaryHeaderState(snapshot)

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 border-b border-border px-4 py-1.5 text-left hover:bg-muted/40"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
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
      </button>
      {expanded ? (
        <div className="border-b border-border">
          <ScrollArea className="max-h-[40vh]">
            <div className="px-4 py-3">
              <SessionSummaryLedgerView snapshot={snapshot} />
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}
