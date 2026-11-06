import React from 'react'
import { translate } from '@/i18n/i18n'
import {
  SESSION_SUMMARY_HOST_OUTDATED_MESSAGE,
  type SessionSummaryFact,
  type SessionSummaryLedger,
  type SessionSummarySnapshot,
  type SessionSummaryTimelineEntry
} from '../../../../shared/session-summary-types'
import { ReportBody, reportTitleOf, sinceReportView } from './session-summary-report-view'
import { LedgerFacts, TimelineRow, type LedgerWindowFacts } from './session-summary-evidence-view'

/**
 * Timeline rows rendered at a time.
 *
 * Why a page and not a virtualizer: a days-long session reaches thousands of entries, and mounting
 * them all is what made opening the disclosure hang. The newest page is what a reader wants first,
 * and one click reaches further back.
 */
const TIMELINE_PAGE_SIZE = 100

/** Facts and a timeline entry, windowed to what the reader has not seen. */
type LedgerWindow = {
  facts: LedgerWindowFacts
  timeline: SessionSummaryTimelineEntry[]
  /** Facts/timeline entries excluded because they happened before the reader's last message. */
  hiddenCount: number
}

/**
 * Everything that happened after the reader's last message to this agent.
 *
 * Why the transcript index and not a read cursor: a cursor that moves when the pane closes
 * measures *looking*, not *interacting* — opening a pane is not reading it, and a reader who
 * leaves the pane up all day was being told they had "seen" a day of work.
 */
export function windowSinceLastInteraction(
  ledger: SessionSummaryLedger,
  boundary = ledger.lastUserMessageIndex
): LedgerWindow {
  const inWindow = (sourceIndex: number | null): boolean =>
    boundary === null || (sourceIndex !== null && sourceIndex > boundary)
  const factsInWindow = (facts: readonly SessionSummaryFact[]): SessionSummaryFact[] =>
    facts.filter((fact) => inWindow(fact.sourceIndex))
  const hidden =
    ledger.plan.filter((fact) => !inWindow(fact.sourceIndex)).length +
    ledger.done.filter((fact) => !inWindow(fact.sourceIndex)).length +
    ledger.blockers.filter((fact) => !inWindow(fact.sourceIndex)).length +
    ledger.decisions.filter((fact) => !inWindow(fact.sourceIndex)).length
  return {
    facts: {
      inProgress:
        ledger.inProgress && inWindow(ledger.inProgress.sourceIndex) ? ledger.inProgress : null,
      plan: factsInWindow(ledger.plan),
      done: factsInWindow(ledger.done),
      blockers: factsInWindow(ledger.blockers),
      decisions: factsInWindow(ledger.decisions)
    },
    timeline: ledger.timeline.filter((entry) => inWindow(entry.sourceIndex)),
    hiddenCount: hidden + ledger.timeline.filter((entry) => !inWindow(entry.sourceIndex)).length
  }
}

function ledgerHasFacts(facts: LedgerWindowFacts): boolean {
  return Boolean(
    facts.inProgress ||
    facts.plan.length > 0 ||
    facts.done.length > 0 ||
    facts.blockers.length > 0 ||
    facts.decisions.length > 0
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

/** A collapsed section: one clickable line that says what is inside it. */
function Disclosure({
  label,
  detail,
  open,
  onToggle,
  children
}: {
  label: string
  detail: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-baseline gap-1.5 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden="true" className="w-2 shrink-0">
          {open ? '▾' : '▸'}
        </span>
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 flex-1 truncate font-normal normal-case tracking-normal">
          {detail}
        </span>
      </button>
      {open ? <div className="mt-1 pl-3.5">{children}</div> : null}
    </div>
  )
}

/**
 * The brief: a title, then the written summary, then the ledger and the timeline — with
 * everything defaulting to what happened since the reader last spoke to the agent, and one
 * switch for the whole session.
 *
 * Why the prose leads: the summary is what the reader came for; the disclosures are the
 * evidence behind it, so opening them is a deliberate step rather than the first thing seen.
 *
 * Why both windows are pre-built: the toggle must not cost a fold, so the whole-session report
 * is written by the fold alongside the windowed one, and the facts carry the index that places
 * them in either window.
 */
function LedgerContent({ ledger }: { ledger: SessionSummaryLedger }): React.JSX.Element {
  const [showFullSession, setShowFullSession] = React.useState(false)
  const [ledgerOpen, setLedgerOpen] = React.useState(false)
  const [timelineOpen, setTimelineOpen] = React.useState(false)
  const [timelinePage, setTimelinePage] = React.useState(TIMELINE_PAGE_SIZE)
  const window = windowSinceLastInteraction(ledger)
  const facts = showFullSession ? fullSessionFacts(ledger) : window.facts
  const timeline = showFullSession ? ledger.timeline : window.timeline
  const hasWindowedReport = Boolean(ledger.reportSince)
  const report = sinceReportView(ledger, showFullSession)
  // Why the report's headline and not the goal: it is written for the whole session on every fold,
  // so it answers "where does this stand" for a session of any length. The goal is the fallback for
  // a ledger whose report phase has not run yet.
  const title = reportTitleOf(ledger)
  const factsAvailable = ledgerHasFacts(facts)
  // A ledger a fold wrote but that found nothing worth reporting: an empty body under
  // "Up to date" reads as a broken pane, so this is its own state.
  const ledgerEmpty =
    !ledger.goal &&
    !ledger.inProgress &&
    !ledger.reportSince &&
    !ledger.reportFull &&
    ledger.plan.length === 0 &&
    ledger.done.length === 0 &&
    ledger.blockers.length === 0 &&
    ledger.decisions.length === 0 &&
    ledger.timeline.length === 0
  if (ledgerEmpty) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('activity.sessionSummary.nothingYet', 'Nothing notable in this session yet.')}
      </p>
    )
  }
  // Why the reader-message guard: with one interaction the only "earlier" facts came from the
  // reader's own first message, and offering to show them back is noise.
  const hasFullAlternative =
    !showFullSession &&
    ((hasWindowedReport && ledger.reportFull !== null) ||
      (ledger.userMessageCount > 1 && window.hiddenCount > 0))
  // Nothing in the window, but the session has history: say so rather than showing a blank.
  // Why the headline does not count as window content: it describes the whole session, so a window
  // with nothing in it still has to say so underneath it.
  const nothingSince =
    !showFullSession &&
    !factsAvailable &&
    timeline.length === 0 &&
    !report.text &&
    report.sections.length === 0
  const visibleTimeline =
    timeline.length > timelinePage ? timeline.slice(timeline.length - timelinePage) : timeline
  const hiddenTimeline = timeline.length - visibleTimeline.length

  return (
    <div className="space-y-3">
      {title ? <p className="text-sm font-medium leading-snug text-foreground">{title}</p> : null}
      <ReportBody ledger={ledger} report={report} />
      {nothingSince ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'activity.sessionSummary.nothingSince',
            'Nothing has happened since your last message.'
          )}
        </p>
      ) : null}
      {ledger.gaps.length > 0 ? (
        <p className="text-2xs text-muted-foreground" title={ledger.gaps.join('\n')}>
          {translate(
            'activity.sessionSummary.gaps',
            '{{count}} unreadable transcript record(s) were skipped; the rest of the session was summarized.',
            { count: ledger.gaps.length }
          )}
        </p>
      ) : null}
      {factsAvailable ? (
        <Disclosure
          label={translate('activity.sessionSummary.ledger', 'Ledger')}
          detail={factDetail(facts, showFullSession)}
          open={ledgerOpen}
          onToggle={() => setLedgerOpen((open) => !open)}
        >
          <LedgerFacts facts={facts} />
        </Disclosure>
      ) : null}
      {timeline.length > 0 ? (
        <Disclosure
          label={translate('activity.sessionSummary.timeline', 'Timeline')}
          detail={timelineDetail(timeline, showFullSession)}
          open={timelineOpen}
          onToggle={() => setTimelineOpen((open) => !open)}
        >
          {hiddenTimeline > 0 ? (
            <button
              type="button"
              onClick={() => setTimelinePage((page) => page + TIMELINE_PAGE_SIZE)}
              className="mb-1 text-2xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {translate('activity.sessionSummary.moreTimeline', 'Show {{count}} earlier', {
                count: Math.min(hiddenTimeline, TIMELINE_PAGE_SIZE)
              })}
            </button>
          ) : null}
          {visibleTimeline.map((entry) => (
            <TimelineRow key={entry.id} entry={entry} />
          ))}
        </Disclosure>
      ) : null}
      {hasFullAlternative || showFullSession ? (
        <button
          type="button"
          onClick={() => setShowFullSession((full) => !full)}
          className="text-2xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          {showFullSession
            ? translate('activity.sessionSummary.showSince', 'Show since your last message')
            : translate('activity.sessionSummary.showFullSession', 'Show the full session')}
        </button>
      ) : null}
    </div>
  )
}

function fullSessionFacts(ledger: SessionSummaryLedger): LedgerWindowFacts {
  return {
    inProgress: ledger.inProgress,
    plan: ledger.plan,
    done: ledger.done,
    blockers: ledger.blockers,
    decisions: ledger.decisions
  }
}

function factDetail(facts: LedgerWindowFacts, fullSession: boolean): string {
  const count =
    facts.plan.length + facts.done.length + facts.blockers.length + facts.decisions.length
  if (count === 0 && !facts.inProgress) {
    return ''
  }
  return fullSession
    ? translate('activity.sessionSummary.factCount', '{{count}} facts · whole session', {
        count
      })
    : translate('activity.sessionSummary.factCountSince', '{{count}} since your last message', {
        count
      })
}

function timelineDetail(
  timeline: readonly SessionSummaryTimelineEntry[],
  fullSession: boolean
): string {
  return fullSession
    ? translate('activity.sessionSummary.timelineCount', '{{count}} events · whole session', {
        count: timeline.length
      })
    : translate(
        'activity.sessionSummary.timelineCountSince',
        '{{count}} events since your last message',
        { count: timeline.length }
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
    return (
      <>
        {/* Why: with a brief on screen the header counts a backlog, so a failed refresh
            would otherwise never surface anywhere in the pane. */}
        {snapshot.status === 'failed' ? (
          <p className="mb-2 text-xs text-muted-foreground">
            {snapshot.error === SESSION_SUMMARY_HOST_OUTDATED_MESSAGE
              ? translate(
                  'activity.sessionSummary.hostOutdated',
                  'This host runs an older Orca. Update Orca there to summarize its sessions.'
                )
              : translate(
                  'activity.sessionSummary.stale',
                  "Couldn't refresh — showing the last summary."
                )}
          </p>
        ) : null}
        <LedgerContent ledger={snapshot.ledger} />
      </>
    )
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
      <>
        <p className="text-xs text-muted-foreground">
          {translate(
            'activity.sessionSummary.unavailable',
            'No readable transcript for this session yet.'
          )}
        </p>
        {/* Why: names which of the two it is — nothing written yet, or a transcript this
            fold could not reach — instead of one message for both. */}
        {snapshot.error ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">{snapshot.error}</p>
        ) : null}
      </>
    )
  }
  return <SummarySkeleton />
}
