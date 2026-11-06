// The fold's input transformation: every event represented at the detail its role deserves.
//
// Three things used to be conflated. *Truncation* dropped content by position once a character
// budget was hit, so which 1,500 characters survived depended on where they sat. *Paging* splits
// the work into bounded model calls. A *digest* is neither: it represents every event at a detail
// level chosen by its role and records the size of what it replaced, so no content is lost by
// accident and none is carried that the extract cannot use.
//
// Deterministic and local: line counts, exit codes and the first error line are extracted here, in
// one pass over text the read already holds. Digesting must not cost a model call per tool event,
// or the preprocessing would replace the expense it removes.
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'

export type SessionSummarySourceEvent = {
  role: 'user' | 'assistant' | 'tool'
  /** The event's text as the model sees it: full for prose, a one-line digest for a tool event. */
  text: string
  timestamp: string | null
  /** A reader bound replaced part of this event's text, and the text says which. */
  textTruncated?: true
  /** Decoded length before that bound, so the digest can name what it stands in for. */
  textOriginalLength?: number
}

/** A tool call's target, as the digest names it: enough to identify it, never a body. */
const TOOL_TARGET_MAX_CHARS = 200
/**
 * How much of a tool result is scanned for an exit code or a failure.
 *
 * Why a head and a tail and not the whole text: a 256 KB result must cost one bounded pass, and
 * a failure is announced either where the command started or in its last lines — never only in
 * the middle.
 */
const TOOL_SCAN_WINDOW_CHARS = 8_000

/** A tool name is a short identifier; anything else is a sentence that happens to contain a colon. */
const TOOL_NAME_PATTERN = /^[A-Za-z][\w.:-]{0,39}$/

/**
 * A harness-reported exit status, anchored to a whole line.
 *
 * Why anchored: `exit 1` appears in any shell script a tool reads, and an unanchored pattern
 * labelled every such read as a failed command — which the extract then turned into a blocker.
 */
const EXIT_CODE_PATTERN =
  /^(?:(?:Process|process|Command|command)? ?exited with (?:code|status)|Exit (?:code|status)):? (\d+)\s*$/m
/** Unambiguous evidence that the command failed, as opposed to a file that merely mentions errors. */
const FAILURE_TRIGGERS = [
  /^FAIL\b/,
  /^[✗×✖]/u,
  /^Traceback \(most recent call last\)/,
  /^panic:/,
  /^error\[E\d+\]/,
  /\bCommand failed\b/
]
const FAILURE_LINE_PATTERN =
  /^(?:error|Error|ERROR|FAIL|FAILED|failed|fatal|FATAL|panic:|Traceback|[✗×✖])/u

export type SessionSummaryEventDigester = {
  /** The digest event for one message, advancing any cross-message state. */
  digest(message: TranscriptMessage): SessionSummarySourceEvent
  /**
   * Advance state without producing an event.
   *
   * Why: messages before the ledger's cursor are counted rather than retained, but a tool result
   * after them still has to be attributed to the call before it.
   */
  skip(message: TranscriptMessage): void
}

/** A tool call whose result has not arrived yet. */
type PendingToolCall = { name: string | null; target: string | null }

export function createSessionSummaryEventDigester(): SessionSummaryEventDigester {
  // Why a queue and not "the last tool name": agents issue parallel calls, so results arrive
  // A, B after calls A, B. The pairing is FIFO, and prose closes the batch.
  const pending: PendingToolCall[] = []
  const note = (message: TranscriptMessage): PendingToolCall | null => {
    if (message.role !== 'tool') {
      pending.length = 0
      return null
    }
    if (message.toolKind === 'result') {
      return pending.shift() ?? null
    }
    const call = parseToolCall(message.text)
    pending.push(call)
    return call
  }
  return {
    digest(message) {
      const paired = note(message)
      return {
        role: message.role,
        text: digestEventText(message, paired),
        timestamp: message.timestamp,
        ...(message.textTruncated ? { textTruncated: true as const } : {}),
        ...(message.textOriginalLength === undefined
          ? {}
          : { textOriginalLength: message.textOriginalLength })
      }
    },
    skip(message) {
      note(message)
    }
  }
}

function digestEventText(message: TranscriptMessage, paired: PendingToolCall | null): string {
  if (message.role !== 'tool') {
    return message.textTruncated
      ? `${message.text}\n[truncated at ${formatBytes(message.textOriginalLength ?? 0)} read]`
      : message.text
  }
  if (message.toolKind === 'result') {
    return digestToolResult(message, paired)
  }
  return digestToolCall(message.text, paired)
}

/** `Read: src/foo.ts` → `Read src/foo.ts`, the call half of the pair the result completes. */
function digestToolCall(text: string, paired: PendingToolCall | null): string {
  const call = paired ?? parseToolCall(text)
  if (!call.name) {
    return boundLine(text)
  }
  return call.target ? `${call.name} ${call.target}` : call.name
}

function parseToolCall(text: string): PendingToolCall {
  const firstLine = firstLineOf(text)
  const separator = firstLine.indexOf(': ')
  if (separator === -1) {
    return { name: TOOL_NAME_PATTERN.test(firstLine) ? firstLine : null, target: null }
  }
  const name = firstLine.slice(0, separator)
  if (!TOOL_NAME_PATTERN.test(name)) {
    return { name: null, target: null }
  }
  return { name, target: boundLine(firstLine.slice(separator + 2)) }
}

/**
 * `Read src/foo.ts · 900 lines / 31.2 KB · ok`.
 *
 * The result carries the call's name and target because that is the one line a reader (and the
 * extract) needs: what was done, and whether it worked.
 */
function digestToolResult(message: TranscriptMessage, paired: PendingToolCall | null): string {
  const text = message.text
  const label = paired?.name
    ? paired.target
      ? `${paired.name} ${paired.target}`
      : paired.name
    : 'tool result'
  const parts = [label, `${countLines(text)} / ${formatBytes(text.length)}`]
  const outcome = describeOutcome(text)
  if (outcome) {
    parts.push(outcome)
  }
  if (message.textTruncated) {
    // Why no size: a tool result's cap stops counting once it is full, so the length it reports is
    // the cap rather than the truth. Naming the limit is accurate; a figure would not be.
    parts.push('truncated by the reader')
  }
  return parts.join(' · ')
}

/** Success, an exit code, or the failure — whichever the text actually evidences. */
function describeOutcome(text: string): string | null {
  const window = scanWindow(text)
  const exit = EXIT_CODE_PATTERN.exec(window)
  if (exit) {
    const code = Number.parseInt(exit[1], 10)
    if (code === 0) {
      return 'exit 0'
    }
    const errorLine = firstFailureLine(window)
    return errorLine ? `exit ${code} · ${errorLine}` : `exit ${code}`
  }
  const errorLine = firstFailureLine(window)
  return errorLine ? `failed · ${errorLine}` : 'ok'
}

function firstFailureLine(window: string): string | null {
  const lines = window.split('\n')
  const triggered = lines.some((line) => FAILURE_TRIGGERS.some((pattern) => pattern.test(line)))
  if (!triggered) {
    return null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && FAILURE_LINE_PATTERN.test(trimmed)) {
      return boundLine(trimmed)
    }
  }
  return null
}

/** The head and the tail, which is where a command announces what it did. */
function scanWindow(text: string): string {
  if (text.length <= TOOL_SCAN_WINDOW_CHARS * 2) {
    return text
  }
  return `${text.slice(0, TOOL_SCAN_WINDOW_CHARS)}\n${text.slice(-TOOL_SCAN_WINDOW_CHARS)}`
}

function firstLineOf(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function boundLine(text: string): string {
  const line = firstLineOf(text).trim()
  return line.length > TOOL_TARGET_MAX_CHARS ? `${line.slice(0, TOOL_TARGET_MAX_CHARS - 1)}…` : line
}

function countLines(text: string): string {
  let lines = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines += 1
  }
  return `${lines} ${lines === 1 ? 'line' : 'lines'}`
}

function formatBytes(chars: number): string {
  if (chars < 1_024) {
    return `${chars} B`
  }
  if (chars < 1_024 * 1_024) {
    return `${(chars / 1_024).toFixed(1)} KB`
  }
  return `${(chars / (1_024 * 1_024)).toFixed(1)} MB`
}
