import {
  applyEdits,
  createScanner,
  modify,
  parse as parseJsonc,
  parseTree,
  type Node,
  type ParseError
} from 'jsonc-parser'

// Agents own these configs and may write them as JSONC (Copilot 1.0.105 heads its config.json with
// `//` lines, #165), so edits touch only the trust array and keep comments, keys and line endings.

export type AgentTrustConfigKey = 'trustedFolders' | 'trustedWorkspaces'

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

/** `text` with `entry` appended to the `key` array, or null when the edit cannot be verified. */
export function appendAgentTrustEntry(
  text: string,
  key: AgentTrustConfigKey,
  entry: string
): string | null {
  const before = parseAgentTrustConfig(text)
  if (!before) {
    return null
  }
  const current = before[key]
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const next = applyEdits(
    text,
    modify(
      text,
      Array.isArray(current) ? [key, -1] : [key],
      Array.isArray(current) ? entry : [entry],
      {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol }
      }
    )
  )
  const expected = [...(Array.isArray(current) ? current : []), entry]
  try {
    return trustArrayEquals(next, key, expected) ? next : null
  } catch {
    return null
  }
}

/** `text` without the `entry` items of the `key` array. Throws when the edit cannot be verified. */
export function removeAgentTrustEntry(
  text: string,
  key: AgentTrustConfigKey,
  entry: string
): string {
  const before = parseAgentTrustConfig(text)
  const current = before?.[key]
  if (!Array.isArray(current) || !current.includes(entry)) {
    return text
  }
  let next = text
  for (let removed = 0; removed < current.length; removed += 1) {
    const array = trustArrayNode(next, key)
    const items = array?.children ?? []
    const index = items.findLastIndex((item) => item.type === 'string' && item.value === entry)
    if (!array || index === -1) {
      break
    }
    next = removeArrayItem(next, array, index)
  }
  if (
    !trustArrayEquals(
      next,
      key,
      current.filter((existing) => existing !== entry)
    )
  ) {
    throw new Error(`Removing a ${key} entry would not leave the expected array`)
  }
  return next
}

/** The array the parsed value reads: the last `key` property, as duplicate keys resolve to it. */
function trustArrayNode(text: string, key: AgentTrustConfigKey): Node | undefined {
  const root = parseTree(text)
  const property = root?.children?.findLast((child) => child.children?.[0]?.value === key)
  const value = property?.children?.[1]
  return value?.type === 'array' ? value : undefined
}

/** Delete one item with its own separator, keeping the comments that belong to its neighbours. */
function removeArrayItem(text: string, array: Node, index: number): string {
  const items = array.children ?? []
  const item = items[index]
  const itemEnd = item.offset + item.length
  if (items.length === 1) {
    return `${text.slice(0, array.offset)}[]${text.slice(array.offset + array.length)}`
  }
  const next = items[index + 1]
  if (next) {
    // Cut the item, its trailing comma and the whitespace up to the next token; the gap before it,
    // which can end in the previous item's `//` comment, stays as it is.
    const gap = scanGap(text, itemEnd, next.offset)
    return text.slice(0, item.offset) + text.slice(itemEnd + gap.firstSolidAfterComma)
  }
  // The last item: drop the previous item's comma and the whitespace leading into the item, so a
  // comment after `"/a",` stays with `"/a"`.
  const previousEnd = items[index - 1].offset + items[index - 1].length
  const gap = scanGap(text, previousEnd, item.offset)
  return (
    text.slice(0, previousEnd + gap.comma.start) +
    text.slice(previousEnd + gap.comma.end, previousEnd + gap.lastSolidEnd) +
    text.slice(itemEnd)
  )
}

/** Offsets, relative to `from`, of the comma between two items and of the solid tokens around it. */
function scanGap(
  text: string,
  from: number,
  to: number
): { comma: { start: number; end: number }; lastSolidEnd: number; firstSolidAfterComma: number } {
  const gap = text.slice(from, to)
  const scanner = createScanner(gap, false)
  let comma: { start: number; end: number } | null = null
  let lastSolidEnd = 0
  let firstSolidAfterComma = gap.length
  // An empty token is the end of the gap (SyntaxKind is a const enum isolatedModules cannot read).
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const start = scanner.getTokenOffset()
    const token = gap.slice(start, start + scanner.getTokenLength())
    if (token.trim() === '') {
      continue
    }
    if (comma && firstSolidAfterComma === gap.length) {
      firstSolidAfterComma = start
    }
    if (token === ',' && !comma) {
      comma = { start, end: start + 1 }
    }
    lastSolidEnd = start + token.length
  }
  if (!comma) {
    throw new Error('Array items are not separated by a comma')
  }
  return { comma, lastSolidEnd, firstSolidAfterComma }
}

function trustArrayEquals(text: string, key: AgentTrustConfigKey, expected: unknown[]): boolean {
  const actual = parseAgentTrustConfig(text)?.[key]
  // Why serialized: items other agents keep can be objects, which never compare equal by identity.
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected)
}
