import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'

// Agents own these configs and may write them as JSONC (Copilot 1.0.105 heads its config.json with
// `//` lines, #165), so edits touch only the trust key and keep comments, keys and line endings.

/** The config's top-level object, or null when it is not one. Throws, like JSON.parse, on a syntax error. */
export function parseAgentTrustConfig(text: string): Record<string, unknown> | null {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors)
  if (errors.length > 0) {
    throw new SyntaxError(`Invalid JSONC at offset ${errors[0].offset}`)
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : null
}

/** `text` with `value` set at `path`; an index of -1 appends and an undefined value removes. */
export function editAgentTrustConfig(
  text: string,
  path: (string | number)[],
  value: unknown
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return applyEdits(
    text,
    modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } })
  )
}
