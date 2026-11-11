// Paging for one fold: how many model calls a transcript takes, and what each call is shown.
//
// This is deliberately the *only* thing chunk sizing decides. It never decides what the model may
// see — that is the digest's job (`session-summary-event-digest.ts`), which represents every event
// at the detail its role deserves, and the render plan's (`session-summary-render-plan.ts`), which
// decides which of those events read as one line. Keeping them apart is what makes a session of any
// length fold end to end: coverage is complete, and the budget only decides how many calls it takes.
import type { SessionSummaryRenderItem } from './session-summary-render-plan'

/**
 * How many rendered lines one chunk prompt may carry.
 *
 * Why characters and not events: the binding constraint is the prompt, and an agent CLI delivered
 * the prompt as an argv argument has a hard per-argument limit. Why lines as well: prose renders
 * one line per message, so without a second bound a chatty session would put a whole session in one
 * call. Lines, not events — a run of tool calls is one line now, and counting the events it stands
 * for would keep a tool-heavy session at five calls for no gain in what the model reads.
 */
const CHUNK_MAX_CHARS = 24_000
const CHUNK_MAX_LINES = 120

/**
 * One model call's slice: whole events `[from, to)`, or the `[partFrom, partTo)` character span of
 * a single event too large to send in one prompt.
 *
 * Why parts: user and assistant text is not cut, so one message can reach the reader's 256 KB
 * per-message guard — larger than a prompt may be. Splitting it keeps the event index intact (it is
 * still one event) while keeping each call's prompt bounded.
 */
export type SessionSummaryChunkRange = {
  from: number
  to: number
  partFrom?: number
  partTo?: number
  /**
   * This part's position and the event's total, computed once at planning time.
   *
   * Why not derived from the span at render time: the last part of a message is narrower than the
   * others, so a label derived from its own width called a three-part message "part 5 of 5".
   */
  partIndex?: number
  partCount?: number
}

/** A part of the transcript the reader could not decode, placed by the messages read before it. */
export type SessionSummaryGap = { afterEventIndex: number; text: string }

/**
 * Split [0, items.length) into bounded chunks. Deterministic: same inputs → same ranges, so cache
 * keys are stable across resumes.
 *
 * Why it pages items and not events: a chunk boundary has to fall between two rendered lines, or a
 * burst would be cut in half and the two halves would each name a count that never happened. The
 * ranges it returns are still *event* ranges, which is what every index downstream counts.
 */
export function buildSessionSummaryChunks(
  items: readonly SessionSummaryRenderItem[],
  chunkMaxChars = CHUNK_MAX_CHARS,
  chunkMaxLines = CHUNK_MAX_LINES
): SessionSummaryChunkRange[] {
  const ranges: SessionSummaryChunkRange[] = []
  let from = 0
  let chars = 0
  let lines = 0
  const flush = (to: number): void => {
    ranges.push({ from, to })
    from = to
    chars = 0
    lines = 0
  }
  for (const item of items) {
    const length = item.text.length
    // Why only a single-event item can be split: the parts are a paging device over one message's
    // text, and a burst item is already bounded (`BURST_MAX_CHARS`) so it never needs one.
    if (length > chunkMaxChars && item.to - item.from === 1) {
      // Why flush first: the items before this one are a chunk of their own, and mixing a part of
      // this item into it would make the part's index range ambiguous.
      if (item.from > from) {
        flush(item.from)
      }
      const partCount = Math.ceil(length / chunkMaxChars)
      for (let offset = 0; offset < length; offset += chunkMaxChars) {
        ranges.push({
          from: item.from,
          to: item.to,
          partFrom: offset,
          partTo: Math.min(length, offset + chunkMaxChars),
          partIndex: Math.floor(offset / chunkMaxChars),
          partCount
        })
      }
      from = item.to
      chars = 0
      lines = 0
      continue
    }
    chars += length
    lines += 1
    if (chars >= chunkMaxChars || lines >= chunkMaxLines) {
      flush(item.to)
    }
  }
  const last = items.at(-1)
  if (last && from < last.to) {
    ranges.push({ from, to: last.to })
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
Rules: respond with ONLY the JSON object. Use plain lowercase text. Keep each "text" to one short sentence. If the slice is ambiguous or low-signal, say so in few entries rather than inventing detail.
A "tool" line is a digest of what a tool did, not its output: read it as one action, and take failures from the exit code or the error line it names. A "tool" line anchored to a range of messages is one burst of consecutive tool calls: read it as one phase of work, take the count and the tool mix from that line, and take its failures from the "#index call · failure" lines beneath it. A line marked "part N of M" is one piece of a single long message; do not treat the parts as separate messages.`

function renderChunkTranscript(
  items: readonly SessionSummaryRenderItem[],
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
  for (const item of items) {
    // A chunk boundary always falls between items, so this never renders half of one.
    if (item.to <= range.from || item.from >= range.to) {
      continue
    }
    const anchor =
      item.to - item.from > 1
        ? `#${absoluteFrom + item.from}-#${absoluteFrom + item.to - 1}`
        : `#${absoluteFrom + item.from}`
    if (range.partFrom === undefined || range.partTo === undefined) {
      lines.push(`[${anchor} ${item.role}] ${item.text}`)
      continue
    }
    lines.push(
      `[${anchor} ${item.role} · part ${(range.partIndex ?? 0) + 1} of ${
        range.partCount ?? 1
      }] ${item.text.slice(range.partFrom, range.partTo)}`
    )
  }
  return lines.join('\n')
}

export function buildSessionSummaryChunkPrompt(
  items: readonly SessionSummaryRenderItem[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number,
  gaps: readonly SessionSummaryGap[] = []
): string {
  return `${CHUNK_EXTRACT_INSTRUCTIONS}\n\nTranscript slice:\n${renderChunkTranscript(
    items,
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
