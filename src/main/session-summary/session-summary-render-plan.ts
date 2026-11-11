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
}

/** One tool call, with the result that completes it merged in. */
export type SessionSummaryToolCall = {
  /** Event index of the call. */
  from: number
  /** Exclusive end: the call's own event, or the pair's two. */
  to: number
  /** The tool's name, when the call line named one. */
  name: string | null
  /** `<name> <target>`: how the call is identified in a burst's failure lines. */
  label: string
  /** The full digest line, used when the call renders on its own. */
  text: string
  failed: boolean
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
 * happened, and the prompt and the timeline must agree on where it starts and ends.
 */
export function planSessionSummaryToolRuns(
  events: readonly SessionSummarySourceEvent[]
): SessionSummaryToolRun[] {
  const runs: SessionSummaryToolRun[] = []
  let current: SessionSummaryToolRun | null = null
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.role !== 'tool') {
      current = null
      continue
    }
    const call = readToolCall(events, index)
    if (!current) {
      current = { from: index, to: call.to, calls: [call] }
      runs.push(current)
    } else {
      current.to = call.to
      current.calls.push(call)
    }
    // A merged pair consumed the result, so the loop must not read it again.
    index = call.to - 1
  }
  return runs
}

function readToolCall(
  events: readonly SessionSummarySourceEvent[],
  index: number
): SessionSummaryToolCall {
  const event = events[index]
  const facts = event.tool
  // Why the adjacency check and not just the pair id: agents issue parallel calls, so results
  // arrive in call order after both calls. Merging a call with a result that is not next to it
  // would label one call's line with another's numbers.
  const next = events[index + 1]
  const completes =
    facts?.kind === 'call' &&
    next?.role === 'tool' &&
    next.tool?.kind === 'result' &&
    next.tool.pair === facts.pair
  if (!completes) {
    return {
      from: index,
      to: index + 1,
      name: facts?.name ?? null,
      label: facts?.label ?? event.text,
      text: event.text,
      failed: facts?.failed ?? false,
      failureLine: facts?.failureLine ?? null
    }
  }
  return {
    from: index,
    to: index + 2,
    name: facts.name,
    label: next.tool?.label ?? facts.label,
    // The result's line: it already names the call and adds the outcome.
    text: next.text,
    failed: next.tool?.failed ?? false,
    failureLine: next.tool?.failureLine ?? null
  }
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
    items.push({
      from: first.from,
      to: last.to,
      role: 'tool',
      text: group.length >= BURST_MIN_CALLS ? renderBurst(group) : last.text
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
  const failures = calls
    .filter((call) => call.failed && call.failureLine)
    .map((call) => `  #${call.from} ${call.label} · ${call.failureLine}`)
  return [headline, ...failures].join('\n')
}

/**
 * `46 tool calls · Read 18, Edit 12, Bash 9, Grep 7 · 3 failed`
 *
 * Exported because the timeline's burst marker says the same thing: the prompt and the timeline
 * must not disagree about what a run of calls was.
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
