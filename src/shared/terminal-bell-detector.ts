/**
 * Stateful BEL detector that correctly ignores BEL (0x07) bytes
 * occurring inside terminal control strings.
 *
 * Shared between the renderer transport processor and main's per-PTY
 * side-effect tracker: bell semantics must not drift between the two parsing
 * authorities.
 *
 * Which strings swallow a BEL: OSC (ESC ]), APC (ESC _), DCS (ESC P),
 * PM (ESC ^) and SOS (ESC X). xterm carries 0x07 as an EXECUTABLE inside every
 * one of those states, so a BEL that terminates an APC/DCS/PM/SOS payload
 * never rings the bell — and agents emit them: Pi writes `ESC _ pi:c BEL` on
 * every prompt repaint. Tracking only OSC announced that as a terminal bell.
 *
 * Why stateful: PTY data arrives in arbitrary chunks, so a control string
 * may span multiple calls. The detector tracks in-progress escape state
 * across invocations so a BEL used as a string terminator is never
 * misinterpreted as a terminal bell.
 *
 * CAN (0x18) / SUB (0x1A) handling: per ECMA-48, these bytes cancel any
 * in-progress escape sequence. Without this, a malformed or truncated string
 * (e.g. from a crashed TUI) would pin the in-string state indefinitely
 * and silently drop the next real BEL as if it were a terminator.
 *
 * reset(): callers should invoke this whenever the underlying byte stream
 * is replaced (e.g. on PTY detach/attach) so state from a previous stream
 * that ended mid-escape does not leak into the next stream.
 */
export type BellDetector = {
  /** `hints.containsOscIntroducer`: `true` short-circuits the introducer scan;
   *  `false` is only a conservative "no string introducer here" signal, never a
   *  negative lookup (a caller that scanned for `\x1b]` alone still lets the
   *  detector check APC/DCS/PM/SOS itself). Lets the title-extraction gate
   *  share its scan instead of paying a second pass per chunk on the hot path. */
  chunkContainsBell(data: string, hints?: { containsOscIntroducer?: boolean }): boolean
  reset(): void
}

/** Introducers of every control string whose payload can contain a BEL. */
const CONTROL_STRING_INTRODUCERS = ['\x1b]', '\x1b_', '\x1bP', '\x1b^', '\x1bX'] as const

function containsControlStringIntroducer(data: string): boolean {
  if (!data.includes('\x1b')) {
    return false
  }
  for (const introducer of CONTROL_STRING_INTRODUCERS) {
    if (data.includes(introducer)) {
      return true
    }
  }
  return false
}

function isControlStringIntroducer(char: string): boolean {
  return char === ']' || char === '_' || char === 'P' || char === '^' || char === 'X'
}

export function createBellDetector(): BellDetector {
  let pendingEscape = false
  let inControlString = false
  let pendingStringEscape = false

  return {
    chunkContainsBell(data: string, hints: { containsOscIntroducer?: boolean } = {}): boolean {
      if (!inControlString && !pendingEscape && !data.includes('\x07')) {
        // Why: chunks with no BEL and no control-string introducer cannot affect
        // bell state; avoid walking every byte of normal terminal output.
        const hasIntroducer =
          hints.containsOscIntroducer === true || containsControlStringIntroducer(data)
        if (!hasIntroducer) {
          pendingEscape = data.endsWith('\x1b')
          return false
        }
      }

      for (let i = 0; i < data.length; i += 1) {
        const char = data[i]

        if (inControlString) {
          if (char === '\x9c' || char === '\x18' || char === '\x1a') {
            // 0x9c is the 8-bit ST; CAN/SUB abort. Either way the string is over,
            // so a malformed/truncated one cannot swallow the next BEL.
            inControlString = false
            pendingStringEscape = false
            continue
          }

          if (pendingStringEscape) {
            pendingStringEscape = char === '\x1b'
            if (char === '\\') {
              inControlString = false
              pendingStringEscape = false
            }
            continue
          }

          if (char === '\x07') {
            // Why: a BEL inside a control string is the string's payload or its
            // terminator, never the terminal bell (xterm carries 0x07 as an
            // EXECUTABLE inside APC/DCS/PM/SOS rather than as a terminator).
            // Deliberate divergence from xterm, which keeps those four open
            // until ST: Pi terminates its APC with BEL and never sends ST, so
            // xterm-strict semantics would pin the string and swallow every
            // later real bell. Do not "fix" this to match xterm.
            inControlString = false
            continue
          }

          pendingStringEscape = char === '\x1b'
          continue
        }

        if (pendingEscape) {
          if (char === '\x18' || char === '\x1a') {
            // ECMA-48 escape-cancel codes also abort a pending ESC.
            pendingEscape = false
            continue
          }
          pendingEscape = false
          if (isControlStringIntroducer(char)) {
            inControlString = true
            pendingStringEscape = false
          } else if (char === '\x1b') {
            pendingEscape = true
          } else if (char === '\x07') {
            // A bare ESC is not a valid introducer for any sequence that
            // consumes a following BEL. Treat the BEL as a real terminal
            // bell rather than silently swallowing it with the orphan ESC.
            return true
          }
          continue
        }

        if (char === '\x1b') {
          pendingEscape = true
          continue
        }

        if (char === '\x07') {
          return true
        }
      }

      return false
    },
    reset(): void {
      pendingEscape = false
      inControlString = false
      pendingStringEscape = false
    }
  }
}
