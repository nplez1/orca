// How a report reply becomes the stored report, and how that report stays bounded.
//
// Kept apart from the chain that asks for the replies: this half is pure and deterministic — given a
// reply and the report so far it produces the next report — which is what makes the ceiling testable
// without a model.
import type {
  SessionSummaryFullReport,
  SessionSummaryReportSection
} from '../../shared/session-summary-types'
import {
  SESSION_SUMMARY_REPORT_MAX_CHARS,
  SESSION_SUMMARY_REPORT_MAX_SECTIONS,
  SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS
} from '../../shared/session-summary-types'

/** One parsed link of the report chain. */
export type SessionSummaryReportReply = {
  headline: string
  section: { title: string; text: string }
  startNew: boolean
  since: string | null
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Append a section, or rewrite the newest one, then enforce the report's ceilings.
 *
 * Why the oldest sections merge rather than the newest being dropped: a report that loses its
 * beginning is the failure this whole change is about. Compression applied to the far past is both
 * what a human does and what keeps the recent work legible.
 */
export function applySessionSummaryReportSection(
  previous: SessionSummaryFullReport | null,
  reply: SessionSummaryReportReply,
  through: number,
  forceNewSection: boolean
): SessionSummaryFullReport {
  const sections = [...(previous?.sections ?? [])]
  const openNew = forceNewSection || reply.startNew || sections.length === 0
  if (openNew) {
    sections.push({
      id: `s${through}-${sections.length}`,
      title: reply.section.title,
      text: reply.section.text,
      through
    })
  } else {
    const last = sections.at(-1)
    if (last) {
      sections[sections.length - 1] = {
        ...last,
        title: reply.section.title,
        text: reply.section.text,
        through
      }
    }
  }
  const bounded = boundSections(sections)
  return {
    headline: reply.headline,
    sections: bounded,
    through,
    text: reportText(reply.headline, bounded)
  }
}

/** Deterministic compression: merge the two oldest until both ceilings hold. */
function boundSections(sections: SessionSummaryReportSection[]): SessionSummaryReportSection[] {
  const out = [...sections]
  while (
    out.length > SESSION_SUMMARY_REPORT_MAX_SECTIONS ||
    totalChars(out) > SESSION_SUMMARY_REPORT_MAX_CHARS
  ) {
    if (out.length < 2) {
      break
    }
    const [first, second] = out
    // Why each half is clamped: clamping the concatenation kept the first section whole and dropped
    // the second entirely, so the oldest phase survived every merge and the middle of the session
    // disappeared — the failure this change exists to remove.
    const half = Math.floor((SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS - 1) / 2)
    out.splice(0, 2, {
      id: first.id,
      title: first.title,
      text: `${clamp(first.text, half)} ${clamp(second.text, half)}`,
      through: second.through
    })
  }
  return out
}

function totalChars(sections: readonly SessionSummaryReportSection[]): number {
  return sections.reduce((total, section) => total + section.text.length + section.title.length, 0)
}

/** The prose an older client renders: it reads `reportFull.text` and knows nothing of sections. */
function reportText(headline: string, sections: readonly SessionSummaryReportSection[]): string {
  return [headline, ...sections.map((section) => section.text)].join('\n\n')
}
