// The evidence behind the brief: the ledger's facts and the session's timeline.
//
// Apart from the pane because these are lists with their own bounds — a fact list shows the newest
// twelve, the timeline pages a hundred at a time — and the bounds are what keep a days-long session
// openable.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
  SESSION_SUMMARY_LIST_MAX_ITEMS,
  type SessionSummaryFact,
  type SessionSummaryTimelineEntry,
  type SessionSummaryTimelineKind
} from '../../../../shared/session-summary-types'

/** Facts and a timeline entry, windowed to what the reader has not seen. */
export type LedgerWindowFacts = {
  inProgress: SessionSummaryFact | null
  plan: SessionSummaryFact[]
  done: SessionSummaryFact[]
  blockers: SessionSummaryFact[]
  decisions: SessionSummaryFact[]
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
    <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
      {text}
    </div>
  )
}

export function TimelineRow({ entry }: { entry: SessionSummaryTimelineEntry }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs">
      <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-2xs text-muted-foreground">
        {t(`activity.sessionSummary.kind.${entry.kind}`, TIMELINE_KIND_LABELS[entry.kind])}
      </span>
      <span className="min-w-0 flex-1 break-words text-foreground">{entry.text}</span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground">
        #{entry.sourceIndex}
      </span>
    </div>
  )
}

function FactList({ items }: { items: readonly SessionSummaryFact[] }): React.JSX.Element {
  const t = useTranslate()
  // Why the newest: the ledger is append-only history, so the end of a list is the current state of
  // that kind of fact. The cap is a view bound — the ledger itself is not truncated.
  const visible =
    items.length > SESSION_SUMMARY_LIST_MAX_ITEMS
      ? items.slice(-SESSION_SUMMARY_LIST_MAX_ITEMS)
      : items
  const hidden = items.length - visible.length
  return (
    <>
      <ul className="space-y-0.5 text-xs text-foreground">
        {visible.map((item) => (
          <li key={item.text} className="leading-snug">
            {item.text}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t('activity.sessionSummary.moreFacts', '+{{count}} earlier', { count: hidden })}
        </p>
      ) : null}
    </>
  )
}

export function LedgerFacts({ facts }: { facts: LedgerWindowFacts }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      {facts.inProgress ? (
        <div>
          {sectionLabel(t('activity.sessionSummary.now', 'Now'))}
          <p className="text-xs leading-snug text-foreground">{facts.inProgress.text}</p>
        </div>
      ) : null}
      {facts.plan.length > 0 ? (
        <div>
          {sectionLabel(t('activity.sessionSummary.plan', 'Plan'))}
          <FactList items={facts.plan} />
        </div>
      ) : null}
      {facts.done.length > 0 ? (
        <div>
          {sectionLabel(t('activity.sessionSummary.done', 'Done'))}
          <FactList items={facts.done} />
        </div>
      ) : null}
      {facts.blockers.length > 0 ? (
        <div>
          {sectionLabel(t('activity.sessionSummary.blockers', 'Blockers'))}
          <FactList items={facts.blockers} />
        </div>
      ) : null}
      {facts.decisions.length > 0 ? (
        <div>
          {sectionLabel(t('activity.sessionSummary.decisions', 'Decisions'))}
          <FactList items={facts.decisions} />
        </div>
      ) : null}
    </div>
  )
}
