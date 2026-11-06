// Paging for one fold: how many model calls a transcript takes, and what each call is shown.
//
// This is deliberately the *only* thing chunk sizing decides. It never decides what the model may
// see — that is the digest's job (`session-summary-event-digest.ts`), which represents every event
// at the detail its role deserves. Keeping the two apart is what makes a session of any length fold
// end to end: coverage is complete, and the budget only decides how many calls it takes.
import type { SessionSummarySourceEvent } from './session-summary-event-digest'

/**
 * How much text one chunk prompt may carry.
 *
 * Why characters and not events: the binding constraint is the prompt, and an agent CLI delivered
 * the prompt as an argv argument has a hard per-argument limit. Event count is the secondary bound,
 * because digest lines are short and would otherwise let one call cover a whole session.
 */
const CHUNK_MAX_CHARS = 24_000
const CHUNK_MAX_EVENTS = 120

/**
 * One model call's slice: whole events `[from, to)`, or the `[partFrom, partTo)` character span of
 * a single event too large to send in one prompt.
 *
 * Why parts: user and assistant text is no longer cut, so one message can reach the reader's 256 KB
 * per-message guard — larger than a prompt may be. Splitting it keeps the event index intact (it is
 * still one event) while keeping each call's prompt bounded.
 */
export type SessionSummaryChunkRange = {
  from: number
  to: number
  partFrom?: number
  partTo?: number
}

/** A part of the transcript the reader could not decode, placed by the messages read before it. */
export type SessionSummaryGap = { afterEventIndex: number; text: string }

/** Split [0, events.length) into bounded chunks. Deterministic: same inputs → same ranges, so cache keys are stable across resumes. */
export function buildSessionSummaryChunks(
  events: readonly SessionSummarySourceEvent[],
  chunkMaxChars = CHUNK_MAX_CHARS,
  chunkMaxEvents = CHUNK_MAX_EVENTS
): SessionSummaryChunkRange[] {
  const ranges: SessionSummaryChunkRange[] = []
  let from = 0
  let chars = 0
  const flush = (to: number): void => {
    ranges.push({ from, to })
    from = to
    chars = 0
  }
  for (let index = 0; index < events.length; index += 1) {
    const length = events[index].text.length
    if (length > chunkMaxChars) {
      // Why flush first: the events before this one are a chunk of their own, and mixing a part of
      // this event into it would make the part's index range ambiguous.
      if (index > from) {
        flush(index)
      }
      for (let offset = 0; offset < length; offset += chunkMaxChars) {
        ranges.push({
          from: index,
          to: index + 1,
          partFrom: offset,
          partTo: Math.min(length, offset + chunkMaxChars)
        })
      }
      from = index + 1
      chars = 0
      continue
    }
    chars += length
    if (chars >= chunkMaxChars || index - from + 1 >= chunkMaxEvents) {
      flush(index + 1)
    }
  }
  if (from < events.length) {
    ranges.push({ from, to: events.length })
  }
  return ranges
}

const CHUNK_EXTRACT_INSTRUCTIONS = `You are summarizing a slice of an agent coding session transcript.
Every fact is an object { "text": string, "sourceIndex": number } where "sourceIndex" is the message index shown in the transcript below for the message the fact came from.
Produce a JSON object with exactly these keys:
- "goal": fact or null — the objective the agent is working toward, if discernible
- "plan": fact[] — steps the agent laid out (at most 5, earliest first)
- "inProgress": fact or null — what the agent is doing at the END of this slice
- "done": fact[] — completed milestones (at most 5)
- "blockers": fact[] — errors, failed approaches, things awaiting input (at most 5)
- "decisions": fact[] — notable choices made (at most 5)
- "timeline": array of { "kind": one of "milestone"|"decision"|"error"|"needs-input"|"tool-burst"|"user-input", "text": one short sentence, "sourceIndex": number } — the notable events of this slice, chronological, at most 10.
Rules: respond with ONLY the JSON object. Use plain lowercase text. Keep each "text" to one short sentence. If the slice is ambiguous or low-signal, say so in few entries rather than inventing detail.
A "tool" line is a digest of what a tool did, not its output: read it as one action, and take failures from the exit code or the error line it names. A line marked "part N of M" is one piece of a single long message; do not treat the parts as separate messages.`

function renderChunkTranscript(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number,
  gaps: readonly SessionSummaryGap[]
): string {
  const lines: string[] = []
  // Why first: a gap before the slice's first message still has to be named in the slice that
  // covers it, and `afterEventIndex` counts messages read, so it sits between `p - 1` and `p`.
  for (const gap of gaps) {
    const belongs =
      range.from < gap.afterEventIndex
        ? gap.afterEventIndex <= range.to
        : gap.afterEventIndex === 0 && range.from === 0
    if (belongs && (range.partFrom === undefined || range.partFrom === 0)) {
      lines.push(`[gap after #${absoluteFrom + gap.afterEventIndex - 1}] ${gap.text}`)
    }
  }
  for (let index = range.from; index < range.to; index += 1) {
    const event = events[index]
    if (range.partFrom === undefined || range.partTo === undefined) {
      lines.push(`[#${absoluteFrom + index} ${event.role}] ${event.text}`)
      continue
    }
    const partCount = Math.ceil(event.text.length / (range.partTo - range.partFrom))
    const partNumber = Math.floor(range.partFrom / (range.partTo - range.partFrom)) + 1
    lines.push(
      `[#${absoluteFrom + index} ${event.role} · part ${partNumber} of ${partCount}] ${event.text.slice(
        range.partFrom,
        range.partTo
      )}`
    )
  }
  return lines.join('\n')
}

export function buildSessionSummaryChunkPrompt(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number,
  gaps: readonly SessionSummaryGap[] = []
): string {
  return `${CHUNK_EXTRACT_INSTRUCTIONS}\n\nTranscript slice:\n${renderChunkTranscript(
    events,
    range,
    absoluteFrom,
    gaps
  )}`
}

/** The event index a range's facts belong to: the slice's last message, or the part's own event. */
export function rangeLastEventIndex(range: SessionSummaryChunkRange): number {
  return Math.max(range.from, range.to - 1)
}

/**
 * Cache key for one slice, in absolute event indexes.
 *
 * Why absolute and not slice-relative: the next fold starts at the cursor and re-chunks the suffix,
 * which lands on the same boundaries — so the extracts after a failed chunk are reused rather than
 * paid for a second time.
 */
export function chunkCacheKey(range: SessionSummaryChunkRange, baseIndex: number): string {
  const prefix = `${baseIndex + range.from}-${baseIndex + range.to}`
  return range.partFrom === undefined ? prefix : `${prefix}:${range.partFrom}-${range.partTo}`
}
