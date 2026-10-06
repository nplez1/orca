import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  SessionSummaryLedger,
  SessionSummaryTimelineEntry,
  SessionSummaryTimelineKind
} from '../../../../shared/session-summary-types'
import { useSessionSummary } from './use-session-summary'

const TIMELINE_KIND_LABELS: Record<SessionSummaryTimelineKind, string> = {
  milestone: 'Milestone',
  decision: 'Decision',
  error: 'Error',
  'needs-input': 'Needs input',
  'tool-burst': 'Work',
  'user-input': 'Prompt'
}

function sectionLabel(text: string): React.JSX.Element {
  return (
    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {text}
    </div>
  )
}

function TimelineRow({ entry }: { entry: SessionSummaryTimelineEntry }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs">
      <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[11px] text-muted-foreground">
        {translate(`activity.sessionSummary.kind.${entry.kind}`, TIMELINE_KIND_LABELS[entry.kind])}
      </span>
      <span className="min-w-0 flex-1 break-words text-foreground">{entry.text}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        #{entry.sourceIndex}
      </span>
    </div>
  )
}

function TextList({ items }: { items: readonly string[] }): React.JSX.Element {
  return (
    <ul className="space-y-0.5 text-xs text-foreground">
      {items.map((item) => (
        <li key={item} className="leading-snug">
          {item}
        </li>
      ))}
    </ul>
  )
}

function SummarySkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="h-3 w-2/5 animate-pulse rounded-sm bg-muted/70" />
      <div className="h-3 w-3/5 animate-pulse rounded-sm bg-muted/50" />
      <div className="h-3 w-1/2 animate-pulse rounded-sm bg-muted/50" />
    </div>
  )
}

function LedgerContent({
  ledger,
  seenThrough
}: {
  ledger: SessionSummaryLedger
  seenThrough: number
}): React.JSX.Element {
  const newEntries = ledger.timeline.slice(seenThrough)
  const earlierEntries = ledger.timeline.slice(0, seenThrough)
  return (
    <div className="space-y-3">
      {ledger.inProgress ? (
        <div>
          {sectionLabel(translate('activity.sessionSummary.now', 'Now'))}
          <p className="text-sm leading-snug text-foreground">{ledger.inProgress}</p>
        </div>
      ) : null}
      {newEntries.length > 0 ? (
        <div>
          {sectionLabel(
            translate('activity.sessionSummary.sinceLastLook', 'Since you last looked')
          )}
          {newEntries.map((entry) => (
            <TimelineRow key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
      {earlierEntries.length > 0 ? (
        <div>
          {sectionLabel(
            seenThrough > 0
              ? translate('activity.sessionSummary.earlier', 'Earlier')
              : translate('activity.sessionSummary.timeline', 'Timeline')
          )}
          {earlierEntries.map((entry) => (
            <TimelineRow key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
      {ledger.goal ? (
        <div>
          {sectionLabel(translate('activity.sessionSummary.goal', 'Goal'))}
          <p className="text-xs leading-snug text-foreground">{ledger.goal}</p>
        </div>
      ) : null}
      {ledger.plan.length > 0 ? (
        <div>
          {sectionLabel(translate('activity.sessionSummary.plan', 'Plan'))}
          <TextList items={ledger.plan} />
        </div>
      ) : null}
      {ledger.done.length > 0 ? (
        <div>
          {sectionLabel(translate('activity.sessionSummary.done', 'Done'))}
          <TextList items={ledger.done} />
        </div>
      ) : null}
      {ledger.blockers.length > 0 ? (
        <div>
          {sectionLabel(translate('activity.sessionSummary.blockers', 'Blockers'))}
          <TextList items={ledger.blockers} />
        </div>
      ) : null}
      {ledger.decisions.length > 0 ? (
        <div>
          {sectionLabel(translate('activity.sessionSummary.decisions', 'Decisions'))}
          <TextList items={ledger.decisions} />
        </div>
      ) : null}
    </div>
  )
}

export function SessionSummaryPanel({ paneKey }: { paneKey: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const snapshot = useSessionSummary(paneKey, expanded)
  const ledger = snapshot?.ledger ?? null
  const backlogCount = snapshot?.facts?.backlogCount ?? 0
  const foldRunning = snapshot?.fold.running ?? false

  const hint = foldRunning
    ? translate('activity.sessionSummary.updating', 'Updating…')
    : backlogCount > 0
      ? translate('activity.sessionSummary.backlogHint', '{{count}} events to catch up on', {
          count: backlogCount
        })
      : translate('activity.sessionSummary.upToDate', 'Up to date')

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
            foldRunning && 'animate-pulse'
          )}
        >
          {hint}
        </span>
        {foldRunning ? (
          <span className="h-3 w-1.5 shrink-0 animate-pulse rounded-sm bg-muted-foreground/70" />
        ) : null}
      </button>
      {expanded ? (
        <div className="border-b border-border">
          <ScrollArea className="max-h-[40vh]">
            <div className="px-4 py-3">
              {ledger ? (
                <LedgerContent ledger={ledger} seenThrough={snapshot?.seenThrough ?? 0} />
              ) : snapshot?.status === 'failed' ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'activity.sessionSummary.failed',
                    'Could not summarize this session.',
                    { error: snapshot.error ?? '' }
                  )}
                </p>
              ) : snapshot?.status === 'unavailable' ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'activity.sessionSummary.unavailable',
                    'No readable transcript for this session yet.'
                  )}
                </p>
              ) : (
                <SummarySkeleton />
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}
