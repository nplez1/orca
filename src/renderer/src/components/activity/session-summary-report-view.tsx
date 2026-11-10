// The prose half of the pane: the report, in whichever of its two shapes is on screen.
//
// Apart from the ledger and the timeline because it answers a different question — "where does this
// stand" rather than "what is the evidence" — and because the two shapes (`reportSince`, and the
// structured whole-session report) must not be conflated: one is a sentence about the window since
// the reader's last message, the other is a headline plus ordered phases.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  SessionSummaryFullReport,
  SessionSummaryLedger
} from '../../../../shared/session-summary-types'

/** The prose part of the pane, in whichever of the two shapes is on screen. */
export type SessionSummaryReportView = {
  headline: string | null
  sections: SessionSummaryFullReport['sections']
  /** The "since your last message" sentence, when that is what is being shown. */
  text: string | null
  through: number | null
}

function fullReportView(report: SessionSummaryFullReport | null): SessionSummaryReportView {
  return {
    headline: report?.headline ?? null,
    sections: report?.sections ?? [],
    text: null,
    through: report?.through ?? null
  }
}

export function sinceReportView(
  ledger: SessionSummaryLedger,
  fullSession: boolean
): SessionSummaryReportView {
  // Why the fallback: with one reader message the window *is* the session, so the fold writes one
  // report and both views must show it.
  if (fullSession || (!ledger.reportSince && ledger.userMessageCount <= 1)) {
    return fullReportView(ledger.reportFull)
  }
  return {
    headline: ledger.reportFull?.headline ?? null,
    sections: [],
    text: ledger.reportSince?.text ?? null,
    through: ledger.reportSince?.through ?? null
  }
}

export function ReportBody({
  ledger,
  report
}: {
  ledger: SessionSummaryLedger
  report: SessionSummaryReportView
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {report.sections.length > 0 ? (
        <div className="space-y-2">
          {report.sections.map((section) => (
            <div key={section.id}>
              <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </div>
              <p className="whitespace-pre-line text-xs leading-relaxed text-foreground">
                {section.text}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {report.text ? (
        <div>
          {report.through !== null && report.through < ledger.foldedThrough ? (
            <span className="mr-1 text-2xs text-muted-foreground">
              {t('activity.sessionSummary.asOf', '(as of #{{index}})', {
                index: report.through
              })}
            </span>
          ) : null}
          <p className="whitespace-pre-line text-xs leading-relaxed text-foreground">
            {report.text}
          </p>
        </div>
      ) : null}
    </>
  )
}

/** The pane's top line: the report's headline, or the goal while the report phase has not run. */
export function reportTitleOf(ledger: SessionSummaryLedger): string | null {
  return ledger.reportFull?.headline ?? ledger.goal?.text ?? ledger.inProgress?.text ?? null
}
