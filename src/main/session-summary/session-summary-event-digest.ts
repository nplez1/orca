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
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'

/**
 * What a tool event *is*, apart from how it reads.
 *
 * Why structure on the event and not a second parse of `text`: a tool call and its result are two
 * events that say the same thing, so rendering has to know which of them completes which. The
 * digester is the only place that pairing exists.
 */
export type SessionSummaryToolFacts = {
  kind: 'call' | 'result'
  /** Shared by a call and the result that completes it, so rendering can merge the pair. */
  pair: number
  /** The tool's name, when the call line named one. */
  name: string | null
  /** `<name> <target>`: how a reader (and the extract) identifies the call. */
  label: string
  /** A result only: the text evidences a failure. */
  failed: boolean
  /** A result only: how the digest states the outcome — `ok`, `exit 2`, `exit 1 · FAIL …`. */
  outcome: string | null
  /** A result only: the failure line it quotes, which a bare exit code does not have. */
  failureLine: string | null
}

export type SessionSummarySourceEvent = {
  role: 'user' | 'assistant' | 'tool'
  /** The event's text as the model sees it: full for prose, a one-line digest for a tool event. */
  text: string
  timestamp: string | null
  /** A reader bound replaced part of this event's text, and the text says which. */
  textTruncated?: true
  /** Decoded length before that bound, so the digest can name what it stands in for. */
  textOriginalLength?: number
  /** Present on tool events; absent on prose and on an event built without the digester. */
  tool?: SessionSummaryToolFacts
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

/**
 * A tool name is an identifier; anything else is a sentence that happens to contain a colon.
 *
 * Why the length bound is generous and not tight: it is the character set that rejects prose, since
 * a sentence carries spaces. The bound only stops an unbounded `name` reaching every label, and an
 * MCP name — `mcp__<server>__<tool>` — routinely runs 40-80 characters.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z][\w.:-]{0,127}$/

/**
 * A harness-reported exit status, anchored to a whole line.
 *
 * Why anchored: `exit 1` appears in any shell script a tool reads, and an unanchored pattern
 * labelled every such read as a failed command — which the extract then turned into a blocker.
 */
const EXIT_CODE_PATTERN =
  /^(?:(?:Process|process|Command|command)? ?exited with (?:code|status)|Exit (?:code|status)):? (\d+)\s*$/m
/**
 * Unambiguous evidence that the command failed, as opposed to a file that merely mentions errors.
 *
 * Why escaped code points and not the glyphs: this file is bundled into the orcad server build, which
 * refuses non-ASCII source.
 */
const FAILURE_TRIGGERS = [
  /^FAIL\b/,
  /^[\u2717\u00d7\u2716]/u,
  /^Traceback \(most recent call last\)/,
  /^panic:/,
  /^error\[E\d+\]/,
  /\bCommand failed\b/
]
const FAILURE_LINE_PATTERN =
  /^(?:error|Error|ERROR|FAIL|FAILED|failed|fatal|FATAL|panic:|Traceback|[\u2717\u00d7\u2716])/u

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
type PendingToolCall = {
  pair: number
  name: string | null
  target: string | null
  /**
   * `<name> <target>`, or the call's own bounded line when it named no tool.
   *
   * Why the call keeps it: a result is that same call with an outcome, so it repeats the label the
   * call already resolved instead of naming the tool a second time from a parse that can fail.
   * `null` only for an orphan result, which no call named.
   */
  label: string | null
}

export function createSessionSummaryEventDigester(): SessionSummaryEventDigester {
  // Why a queue and not "the last tool name": agents issue parallel calls, so results arrive
  // A, B after calls A, B. The pairing is FIFO, and prose closes the batch.
  const pending: PendingToolCall[] = []
  // Why a counter and not the event index: `skip()` also advances the queue, and a skipped call
  // still owns the result that follows it.
  let pairs = 0
  const note = (message: TranscriptMessage): PendingToolCall | null => {
    if (message.role !== 'tool') {
      pending.length = 0
      return null
    }
    if (message.toolKind === 'result') {
      // An orphan result is still one tool call: it gets a pair of its own so nothing downstream
      // has to special-case a missing one.
      return pending.shift() ?? { pair: (pairs += 1), name: null, target: null, label: null }
    }
    const call = { ...parseToolCall(message.text), pair: (pairs += 1) }
    pending.push(call)
    return call
  }
  return {
    digest(message) {
      const paired = note(message)
      const digest = digestEvent(message, paired)
      return {
        role: message.role,
        text: digest.text,
        timestamp: message.timestamp,
        ...(digest.tool ? { tool: digest.tool } : {}),
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

/** An event's text, and what a tool event is, which its text alone cannot say. */
type DigestEvent = { text: string; tool?: SessionSummaryToolFacts }

function digestEvent(message: TranscriptMessage, paired: PendingToolCall | null): DigestEvent {
  if (message.role !== 'tool') {
    return {
      text: message.textTruncated
        ? `${message.text}\n[truncated at ${formatBytes(message.textOriginalLength ?? 0)} read]`
        : message.text
    }
  }
  if (message.toolKind === 'result') {
    return digestToolResult(message, paired)
  }
  return digestToolCall(message.text, paired)
}

/** `Read: src/foo.ts` → `Read src/foo.ts`, the call half of the pair the result completes. */
function digestToolCall(text: string, paired: PendingToolCall | null): DigestEvent {
  // `note()` always returns the call for a call event; the fallback keeps this total for a caller
  // that hands it a message the queue never saw.
  const call = paired ?? { ...parseToolCall(text), pair: 0 }
  const label = call.label ?? boundLine(text)
  return {
    text: label,
    tool: {
      kind: 'call',
      pair: call.pair,
      name: call.name,
      label,
      failed: false,
      outcome: null,
      failureLine: null
    }
  }
}

function parseToolCall(text: string): Omit<PendingToolCall, 'pair'> {
  const firstLine = firstLineOf(text)
  const separator = firstLine.indexOf(': ')
  const name = separator === -1 ? firstLine : firstLine.slice(0, separator)
  if (!TOOL_NAME_PATTERN.test(name)) {
    // Why the whole line and not nothing: a call whose name did not parse still identifies itself,
    // and its result repeats this label rather than falling back to `tool result`.
    return { name: null, target: null, label: boundLine(text) }
  }
  const target = separator === -1 ? null : boundLine(firstLine.slice(separator + 2))
  return { name, target, label: target ? `${name} ${target}` : name }
}

/**
 * `Read src/foo.ts · 900 lines / 31.2 KB · ok`.
 *
 * The result carries the call's name and target because that is the one line a reader (and the
 * extract) needs: what was done, and whether it worked.
 */
function digestToolResult(message: TranscriptMessage, paired: PendingToolCall | null): DigestEvent {
  const text = message.text
  // Why the call's own label: a result is that call plus an outcome, so the name it repeats is the
  // one the call already resolved — a long MCP name, or a line the name gate could not parse.
  const label = paired?.label ?? 'tool result'
  const parts = [label, `${countLines(text)} / ${formatBytes(text.length)}`]
  const outcome = describeOutcome(text)
  parts.push(outcome.text)
  if (message.textTruncated) {
    // Why no size: a tool result's cap stops counting once it is full, so the length it reports is
    // the cap rather than the truth. Naming the limit is accurate; a figure would not be.
    parts.push('truncated by the reader')
  }
  return {
    text: parts.join(' · '),
    tool: {
      kind: 'result',
      pair: paired?.pair ?? 0,
      name: paired?.name ?? null,
      label,
      failed: outcome.failed,
      outcome: outcome.text,
      failureLine: outcome.failureLine
    }
  }
}

type ToolOutcome = {
  /** How the digest states it: `ok`, `exit 0`, `exit 1 · FAIL …`. */
  text: string
  failed: boolean
  /** The line it quoted, which a bare exit code does not have. */
  failureLine: string | null
}

/** Success, an exit code, or the failure — whichever the text actually evidences. */
function describeOutcome(text: string): ToolOutcome {
  const window = scanWindow(text)
  const exit = EXIT_CODE_PATTERN.exec(window)
  if (exit) {
    const code = Number.parseInt(exit[1], 10)
    if (code === 0) {
      return { text: 'exit 0', failed: false, failureLine: null }
    }
    const errorLine = firstFailureLine(window)
    return errorLine
      ? { text: `exit ${code} · ${errorLine}`, failed: true, failureLine: errorLine }
      : { text: `exit ${code}`, failed: true, failureLine: null }
  }
  const errorLine = firstFailureLine(window)
  return errorLine
    ? { text: `failed · ${errorLine}`, failed: true, failureLine: errorLine }
    : { text: 'ok', failed: false, failureLine: null }
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
