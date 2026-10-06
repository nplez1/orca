// Fold protocol: bounded transcript slices → per-chunk extracts (in parallel)
// → one deterministic merge. A failed or unparseable extract fails the whole
// fold so the caller keeps the last good ledger; completed chunk extracts are
// cacheable so a cancelled fold resumes instead of restarting.
import type {
  SessionSummaryLedger,
  SessionSummaryLedgerDelta
} from '../../shared/session-summary-types'
import {
  applySessionSummaryDelta,
  mergeSessionSummaryDeltas,
  normalizeSessionSummaryDelta
} from './session-summary-ledger'

export type SessionSummarySourceEvent = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestamp: string | null
}

/** One structured-output completion; the brain is agent-CLI or direct-model. */
export type SessionFoldBrain = {
  complete(input: { prompt: string; signal: AbortSignal }): Promise<string>
}

export type SessionSummaryChunkCache = {
  get(key: string): SessionSummaryLedgerDelta | undefined
  set(key: string, delta: SessionSummaryLedgerDelta): void
}

const CHUNK_MAX_CHARS = 24_000
const CHUNK_MAX_EVENTS = 40
const EVENT_TEXT_MAX_CHARS = 1_500

export type SessionSummaryChunkRange = { from: number; to: number }

/** Split [0, events.length) into bounded chunks. Deterministic: same inputs → same ranges, so cache keys are stable across resumes. */
export function buildSessionSummaryChunks(
  events: readonly SessionSummarySourceEvent[],
  chunkMaxChars = CHUNK_MAX_CHARS,
  chunkMaxEvents = CHUNK_MAX_EVENTS
): SessionSummaryChunkRange[] {
  const ranges: SessionSummaryChunkRange[] = []
  const eventCount = events.length
  let from = 0
  let chars = 0
  for (let index = 0; index < eventCount; index += 1) {
    chars += Math.min(events[index].text.length, EVENT_TEXT_MAX_CHARS)
    if (chars >= chunkMaxChars || index - from + 1 >= chunkMaxEvents) {
      ranges.push({ from, to: index + 1 })
      from = index + 1
      chars = 0
    }
  }
  if (from < eventCount) {
    ranges.push({ from, to: eventCount })
  }
  return ranges
}

/** Pull the first JSON object out of a model reply (tolerates code fences and prose). */
export function extractSessionSummaryJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  if (start === -1) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const CHUNK_EXTRACT_INSTRUCTIONS = `You are summarizing a slice of an agent coding session transcript.
Produce a JSON object with exactly these keys:
- "goal": string or null — the objective the agent is working toward, if discernible
- "plan": string[] — steps the agent laid out (at most 5, earliest first)
- "inProgress": string or null — what the agent is doing at the END of this slice
- "done": string[] — completed milestones (at most 5)
- "blockers": string[] — errors, failed approaches, things awaiting input (at most 5)
- "decisions": string[] — notable choices made (at most 5)
- "timeline": array of { "kind": one of "milestone"|"decision"|"error"|"needs-input"|"tool-burst"|"user-input", "text": one short sentence, "sourceIndex": number } — the notable events of this slice, chronological, at most 10. Use the message index shown in the transcript below for "sourceIndex".
Rules: respond with ONLY the JSON object. Use plain lowercase text. If the slice is ambiguous or low-signal, say so in few entries rather than inventing detail.`

function renderChunkTranscript(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number
): string {
  const lines: string[] = []
  for (let index = range.from; index < range.to; index += 1) {
    const event = events[index]
    const text =
      event.text.length > EVENT_TEXT_MAX_CHARS
        ? `${event.text.slice(0, EVENT_TEXT_MAX_CHARS)}…`
        : event.text
    lines.push(`[#${absoluteFrom + index} ${event.role}] ${text}`)
  }
  return lines.join('\n')
}

export function buildSessionSummaryChunkPrompt(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number
): string {
  return `${CHUNK_EXTRACT_INSTRUCTIONS}\n\nTranscript slice:\n${renderChunkTranscript(events, range, absoluteFrom)}`
}

export type SessionSummaryFoldResult = {
  ledger: SessionSummaryLedger
  completedChunks: number
  totalChunks: number
}

/**
 * Fold events (events[0] is the transcript message at ledger.foldedThrough)
 * into the ledger. Atomic: on any chunk failure nothing is applied, so the
 * caller's stored ledger stays the last good one.
 */
export async function foldSessionSummaryEvents(args: {
  brain: SessionFoldBrain
  ledger: SessionSummaryLedger
  events: readonly SessionSummarySourceEvent[]
  signal: AbortSignal
  cache?: SessionSummaryChunkCache
  onProgress?: (result: SessionSummaryFoldResult) => void
}): Promise<SessionSummaryFoldResult> {
  const { brain, ledger, events, signal, cache } = args
  const baseIndex = ledger.foldedThrough
  const ranges = buildSessionSummaryChunks(events)
  let completedChunks = 0
  const progress = (): void =>
    args.onProgress?.({ ledger, completedChunks, totalChunks: ranges.length })

  const deltas = await Promise.all(
    ranges.map(async (range) => {
      const cacheKey = `${baseIndex + range.from}-${baseIndex + range.to}`
      const cached = cache?.get(cacheKey)
      if (cached) {
        completedChunks += 1
        progress()
        return cached
      }
      const raw = await brain.complete({
        prompt: buildSessionSummaryChunkPrompt(events, range, baseIndex),
        signal
      })
      signal.throwIfAborted()
      const delta = normalizeSessionSummaryDelta(extractSessionSummaryJson(raw))
      if (!delta) {
        throw new Error('fold extract returned no usable JSON')
      }
      cache?.set(cacheKey, delta)
      completedChunks += 1
      progress()
      return delta
    })
  )

  const merged = mergeSessionSummaryDeltas(deltas)
  const folded = applySessionSummaryDelta(ledger, merged, baseIndex + events.length, Date.now())
  return { ledger: folded, completedChunks: ranges.length, totalChunks: ranges.length }
}
