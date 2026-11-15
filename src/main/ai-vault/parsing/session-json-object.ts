import { asRecord } from './session-record-fields'

/**
 * Byte-order mark a Windows editor leaves at the start of a file (Notepad, PowerShell's utf8).
 *
 * Why it needs stripping rather than trimming: U+FEFF counts as whitespace for `trim()` but not for
 * `JSON.parse`, so a BOM-prefixed first record both looks non-empty and fails to parse — that is
 * how a session loses its header and its workspace.
 */
const BYTE_ORDER_MARK = '\uFEFF'

function stripLeadingByteOrderMark(line: string): string {
  return line.startsWith(BYTE_ORDER_MARK) ? line.slice(BYTE_ORDER_MARK.length) : line
}

export function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = stripLeadingByteOrderMark(line).trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return asRecord(parsed)
  } catch {
    return null
  }
}
