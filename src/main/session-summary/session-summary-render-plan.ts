// What one chunk prompt is shown: a line per thing that happened, not per event.
//
// The digest gives every event its own line, and a tool call is *two* events — the call and the
// result that names it. Rendering is where that is collapsed. An adjacent call and result are one
// call, and a run of calls is one burst line naming the count and the mix, with its failures kept
// expanded because a failure is the evidence the extract turns into a blocker.
//
// Items are the unit of both rendering and paging, so a chunk boundary always falls between two of
// them: no burst is ever cut in half, and the event range a chunk covers is still `[from, to)` —
// which is what keeps `foldedThrough`, every fact's `sourceIndex` and the chunk cache key stable.
//
// Deterministic and local: no model call, and the same events always plan to the same items.
import type { SessionSummarySourceEvent } from './session-summary-event-digest'

/** One rendered line (or, for a burst, one line plus its expanded failures). */
export type SessionSummaryRenderItem = {
  /** First event index this item covers. */
  from: number
  /** Exclusive end; `from + 1` for a single event. */
  to: number
  role: SessionSummarySourceEvent['role']
  /** The rendered text, without the `[#from-#to role]` anchor. */
  text: string
  /**
   * Several calls collapsed into one line, so the anchor names the whole span.
   *
   * Why a flag and not `to - from > 1`: a single call is still two events, and anchoring it to a
   * range made the prompt call one call a burst.
   */
  burst?: true
}

/** One tool call, with the result that completes it merged in. */
export type SessionSummaryToolCall = {
  /** Event index of the call, which is also where the entry is anchored. */
  from: number
  /**
   * Exclusive end of the slice of the run this call covers.
   *
   * Not necessarily its own result: an interleaved parallel call's result sits after a later
   * call's index, and the slices have to partition the run so a chunk boundary can fall between
   * two of them. The whole run collapses to one line, so only the anchor matters.
   */
  to: number
  /** The tool's name, when the call line named one. */
  name: string | null
  /** `<name> <target>`: how the call is identified in a burst's failure lines. */
  label: string
  /** The full digest line, used when the call renders on its own. */
  text: string
  failed: boolean
  /** How the digest states the outcome: `ok`, `exit 2`, `exit 1 · FAIL …`. */
  outcome: string | null
  /** The failure line the result quoted, which a bare exit code does not have. */
  failureLine: string | null
}

/** A maximal run of consecutive tool events. */
export type SessionSummaryToolRun = {
  from: number
  to: number
  calls: SessionSummaryToolCall[]
}

/**
 * A run of calls shorter than this renders as its own lines rather than a burst.
 *
 * Why two: a call and its result are already merged, so a run of two is a pair of genuine actions
 * — collapsing them names the count and the mix, which is what the extract needs and what one
 * line per call does not give it.
 */
const BURST_MIN_CALLS = 2
/**
 * Ceiling on one burst item's text, so an item is always bounded and paging can treat it as atomic.
 *
 * Why bounded at all: a run of five hundred failing calls would otherwise become one 100 KB line
 * that no chunk budget could split, because items are the unit of paging.
 */
const BURST_MAX_CHARS = 4_000
/** Tool names a burst line lists before it counts the rest. */
const BURST_MAX_NAMED_TOOLS = 4

/**
 * Maximal runs of consecutive tool events, each call+result pair merged into one call.
 *
 * Exported because the timeline's markers are read from the same runs: a burst is one thing that
 * happened, and the prompt and the timeline must agree on where a run starts and ends.
 */
export function planSessionSummaryToolRuns(
  events: readonly SessionSummarySourceEvent[]
): SessionSummaryToolRun[] {
  const runs: SessionSummaryToolRun[] = []
  let index = 0
  while (index < events.length) {
    if (events[index].role !== 'tool') {
      index += 1
      continue
    }
    const from = index
    while (index < events.length && events[index].role === 'tool') {
      index += 1
    }
    runs.push({ from, to: index, calls: readRunCalls(events, from, index) })
  }
  return runs
}

/**
 * One entry per call in `[from, to)`, its result folded in wherever it sits.
 *
 * Why pair by id and not by adjacency: agents issue parallel calls, so the transcript records
 * call A, call B, result A, result B. Pairing those by adjacency found no pair at all and counted
 * two reads as four calls. The id comes from the digester's own FIFO pairing, so it is the answer
 * to "which call does this result complete".
 *
 * Why the spans are then assigned by partition: an interleaved pair's result sits after a later
 * call's index, so the natural spans overlap — and overlapping spans would let a chunk boundary
 * fall inside one. The anchor is the call, and the whole run collapses to one line anyway.
 */
function readRunCalls(
  events: readonly SessionSummarySourceEvent[],
  from: number,
  to: number
): SessionSummaryToolCall[] {
  const calls: SessionSummaryToolCall[] = []
  const byPair = new Map<number, SessionSummaryToolCall>()
  for (let index = from; index < to; index += 1) {
    const event = events[index]
    const facts = event.tool
    if (facts?.kind === 'call') {
      const call: SessionSummaryToolCall = {
        from: index,
        to: index + 1,
        name: facts.name,
        label: facts.label,
        text: event.text,
        failed: false,
        outcome: null,
        failureLine: null
      }
      calls.push(call)
      byPair.set(facts.pair, call)
      continue
    }
    const paired = facts ? byPair.get(facts.pair) : undefined
    if (paired && facts) {
      // The result's line: it already names the call and adds the outcome.
      paired.text = event.text
      paired.label = facts.label
      paired.failed = facts.failed
      paired.outcome = facts.outcome
      paired.failureLine = facts.failureLine
      byPair.delete(facts.pair)
      continue
    }
    calls.push({
      from: index,
      to: index + 1,
      name: facts?.name ?? null,
      label: facts?.label ?? event.text,
      text: event.text,
      failed: facts?.failed ?? false,
      outcome: facts?.outcome ?? null,
      failureLine: facts?.failureLine ?? null
    })
  }
  for (let position = 0; position < calls.length; position += 1) {
    calls[position].to = calls[position + 1]?.from ?? to
  }
  return calls
}

/** The whole event array as rendered lines: prose one each, tool activity collapsed. */
export function planSessionSummaryRenderItems(
  events: readonly SessionSummarySourceEvent[]
): SessionSummaryRenderItem[] {
  const runsByStart = new Map<number, SessionSummaryToolRun>()
  for (const run of planSessionSummaryToolRuns(events)) {
    runsByStart.set(run.from, run)
  }
  const items: SessionSummaryRenderItem[] = []
  for (let index = 0; index < events.length; index += 1) {
    const run = runsByStart.get(index)
    if (!run) {
      items.push({ from: index, to: index + 1, role: events[index].role, text: events[index].text })
      continue
    }
    pushRunItems(items, run)
    index = run.to - 1
  }
  return items
}

function pushRunItems(items: SessionSummaryRenderItem[], run: SessionSummaryToolRun): void {
  // Why the group can be smaller than the run: an item is bounded, so a long run becomes several
  // consecutive bursts rather than one line no chunk budget could split.
  let group: SessionSummaryToolCall[] = []
  let chars = 0
  const flush = (): void => {
    const first = group[0]
    const last = group.at(-1)
    if (!first || !last) {
      return
    }
    const burst = group.length >= BURST_MIN_CALLS
    items.push({
      from: first.from,
      to: last.to,
      role: 'tool',
      text: burst ? renderBurst(group) : last.text,
      ...(burst ? { burst: true as const } : {})
    })
    group = []
    chars = 0
  }
  for (const call of run.calls) {
    if (group.length > 0 && chars + call.text.length > BURST_MAX_CHARS) {
      flush()
    }
    group.push(call)
    chars += call.text.length + 1
  }
  flush()
}

function renderBurst(calls: readonly SessionSummaryToolCall[]): string {
  const headline = describeSessionSummaryToolBurst(calls)
  // Why every failure and not only a quoted one: a command that exited 2 without a line the
  // digest recognises is still the command a blocker is about, and dropping it left the extract
  // less than it was shown before bursts existed.
  const failures = calls
    .filter((call) => call.failed && call.outcome)
    .map((call) => `  #${call.from} ${call.label} · ${call.outcome}`)
  return [headline, ...failures].join('\n')
}

/**
 * `46 tool calls · Read 18, Edit 12, Bash 9, Grep 7 · 3 failed`
 *
 * Exported because the timeline's burst marker says the same thing: the prompt and the timeline
 * must not disagree about what a run of calls was. They can disagree about how many lines it
 * takes — the prompt splits a run too long for one item, the timeline does not.
 */
export function describeSessionSummaryToolBurst(calls: readonly SessionSummaryToolCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) {
    const name = call.name ?? 'tool'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  // Why first-seen breaks a tie: two tools with the same count would otherwise swap places between
  // folds, and the prompt has to be reproducible from the same events.
  const order: string[] = []
  for (const call of calls) {
    const name = call.name ?? 'tool'
    if (!order.includes(name)) {
      order.push(name)
    }
  }
  order.sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))
  const named = order
    .slice(0, BURST_MAX_NAMED_TOOLS)
    .map((name) => `${name} ${counts.get(name)}`)
    .join(', ')
  const rest = order.length - BURST_MAX_NAMED_TOOLS
  const failed = calls.filter((call) => call.failed).length
  return [
    `${calls.length} tool calls`,
    rest > 0 ? `${named}, +${rest} more` : named,
    ...(failed > 0 ? [`${failed} failed`] : [])
  ].join(' · ')
}
