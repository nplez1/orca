import React from 'react'
import { translate } from '@/i18n/i18n'
import {
  SESSION_SUMMARY_HOST_OUTDATED_MESSAGE,
  type SessionSummaryLedger,
  type SessionSummarySnapshot,
  type SessionSummaryTimelineEntry,
  type SessionSummaryTimelineKind
} from '../../../../shared/session-summary-types'

const EMPTY_LEDGER_SECTIONS = [
  'inProgress',
  'goal',
  'plan',
  'done',
  'blockers',
  'decisions',
  'timeline'
] as const

type LedgerSection = (typeof EMPTY_LEDGER_SECTIONS)[number]

function isLedgerSectionFilled(ledger: SessionSummaryLedger, section: LedgerSection): boolean {
  switch (section) {
    case 'inProgress':
      return Boolean(ledger.inProgress)
    case 'goal':
      return Boolean(ledger.goal)
    case 'timeline':
      return ledger.timeline.length > 0
    default:
      return ledger[section].length > 0
  }
}

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
  // Why: a fold that found nothing worth reporting still produced a ledger; an empty body
  // under an "Up to date" header reads as a broken pane.
  if (!EMPTY_LEDGER_SECTIONS.some((section) => isLedgerSectionFilled(ledger, section))) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('activity.sessionSummary.nothingYet', 'Nothing notable in this session yet.')}
      </p>
    )
  }
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

/** The summary brief itself: ledger sections, or why there is nothing to show yet.
 *
 *  Host-agnostic: no scroll container, padding, or header — the activity strip and
 *  the right-sidebar pane each own their own chrome around it. */
export function SessionSummaryLedgerView({
  snapshot
}: {
  snapshot: SessionSummarySnapshot | null
}): React.JSX.Element {
  if (snapshot?.ledger) {
    return <LedgerContent ledger={snapshot.ledger} seenThrough={snapshot.seenThrough} />
  }
  if (snapshot?.status === 'failed') {
    // An out-of-date paired host is a remedy, not a failure of this session.
    if (snapshot.error === SESSION_SUMMARY_HOST_OUTDATED_MESSAGE) {
      return (
        <p className="text-xs text-muted-foreground">
          {translate(
            'activity.sessionSummary.hostOutdated',
            'This host runs an older Orca. Update Orca there to summarize its sessions.'
          )}
        </p>
      )
    }
    return (
      <>
        <p className="text-xs text-muted-foreground">
          {translate('activity.sessionSummary.failed', 'Could not summarize this session.')}
        </p>
        {snapshot.error ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">{snapshot.error}</p>
        ) : null}
      </>
    )
  }
  if (snapshot?.status === 'unsupported-host') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'activity.sessionSummary.unsupportedHost',
          'Session summaries are not available for a workspace on this host.'
        )}
      </p>
    )
  }
  if (snapshot?.status === 'unavailable') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'activity.sessionSummary.unavailable',
          'No readable transcript for this session yet.'
        )}
      </p>
    )
  }
  return <SummarySkeleton />
}
