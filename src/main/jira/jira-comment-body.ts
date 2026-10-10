import type { JiraSite } from '../../shared/jira-types'
import type { JiraRecord } from './jira-record-pages'

/** What the composer's editor can emit, plus the characters a user types. */
type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }

type Block =
  | { kind: 'paragraph'; line: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; language: string; lines: string[] }

// Why this order: an escape first so `\*` never reaches the emphasis branches,
// then code, so a `**` inside a span stays literal. `**` precedes the single-`*`
// branch, and both emphasis branches are boundary-anchored because `a_b_c` and
// `a*b*c` are identifiers, not emphasis — the same rule CommonMark applies.
const INLINE_TOKEN_PATTERN =
  /(\\.|`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w])\*[^*\n]+\*(?![\w])|(?<![\w])_[^_\n]+_(?![\w]))/g
const FENCE_PATTERN = /^\s*```(\S*)\s*$/
const QUOTE_PREFIX_PATTERN = /^>\s?/
const LIST_PREFIX_PATTERN = /^[-*]\s+/

const ADF_MARKS: Record<'bold' | 'italic' | 'code', string> = {
  bold: 'strong',
  italic: 'em',
  code: 'code'
}

const WIKI_WRAPPERS: Record<'bold' | 'italic' | 'code', [string, string]> = {
  bold: ['{*}', '{*}'],
  italic: ['{_}', '{_}'],
  code: ['{{', '}}']
}

const NAMED_CHARACTER_REFERENCES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0'
}

function codePointFrom(digits: string, radix: number, raw: string): string {
  const codePoint = Number.parseInt(digits, radix)
  const isScalarValue =
    Number.isFinite(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  return isScalarValue ? String.fromCodePoint(codePoint) : raw
}

/** Why a comment body needs this: the composer's Markdown serializer escapes
 *  `&`, `<` and `>` as character references, and a comment is prose — `if a < b`
 *  has to reach Jira as `if a < b`, not as `if a &lt; b`. `&` is left as-is
 *  rather than double-decoded, so a body that already escaped itself survives. */
export function decodeCharacterReferences(body: string): string {
  return body
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) => codePointFrom(hex, 16, raw))
    .replace(/&#(\d+);/g, (raw, decimal: string) => codePointFrom(decimal, 10, raw))
    .replace(
      /&([a-z]+);/gi,
      (raw, name: string) => NAMED_CHARACTER_REFERENCES[name.toLowerCase()] ?? raw
    )
}

/** Splits one line into literal text and the constructs the toolbar emits. */
function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let cursor = 0
  for (const match of line.matchAll(INLINE_TOKEN_PATTERN)) {
    const index = match.index
    const raw = match[0]
    if (index > cursor) {
      tokens.push({ kind: 'text', value: line.slice(cursor, index) })
    }
    if (raw.startsWith('\\') && raw.length > 1) {
      // An escaped marker is the literal character, never formatting.
      tokens.push({ kind: 'text', value: raw.slice(1) })
    } else if (raw.startsWith('`')) {
      tokens.push({ kind: 'code', value: raw.slice(1, -1) })
    } else if (raw.startsWith('**')) {
      tokens.push({ kind: 'bold', value: raw.slice(2, -2) })
    } else {
      tokens.push({ kind: 'italic', value: raw.slice(1, -1) })
    }
    cursor = index + raw.length
  }
  if (cursor < line.length) {
    tokens.push({ kind: 'text', value: line.slice(cursor) })
  }
  // Why decoding here and not on the whole body: a code span is verbatim, so a
  // literal `&amp;` the user typed inside one has to survive as those characters.
  return tokens.map((token) =>
    token.kind === 'code' ? token : { ...token, value: decodeCharacterReferences(token.value) }
  )
}

/** One block per source line (and one per quote/list/code run), so a body with no
 *  Markdown in it re-renders exactly as the plain-text path used to.
 *
 *  Fenced code is a protected region: nothing inside it is reinterpreted, which is
 *  what keeps a `- item` line in a pasted snippet from becoming a list. */
function parseBlocks(body: string, stripCarriageReturns: boolean): Block[] {
  const lines = body.split('\n').map((line) => {
    return stripCarriageReturns && line.endsWith('\r') ? line.slice(0, -1) : line
  })
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fence = line.match(FENCE_PATTERN)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !FENCE_PATTERN.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      // Skip the closing fence; an unterminated block simply ends the body.
      index += 1
      if (code.some((entry) => entry.trim().length > 0)) {
        blocks.push({ kind: 'code', language: fence[1] ?? '', lines: code })
      }
      continue
    }
    const quote = line.match(QUOTE_PREFIX_PATTERN)
    if (quote) {
      const previous = blocks.at(-1)
      const text = line.slice(quote[0].length)
      if (previous?.kind === 'quote') {
        previous.lines.push(text)
      } else {
        blocks.push({ kind: 'quote', lines: [text] })
      }
      index += 1
      continue
    }
    const list = line.match(LIST_PREFIX_PATTERN)
    if (list) {
      const previous = blocks.at(-1)
      const text = line.slice(list[0].length)
      if (previous?.kind === 'list') {
        previous.items.push(text)
      } else {
        blocks.push({ kind: 'list', items: [text] })
      }
      index += 1
      continue
    }
    blocks.push({ kind: 'paragraph', line })
    index += 1
  }
  return blocks
}

function inlineToAdf(line: string): JiraRecord[] {
  return parseInline(line).map((token) => {
    if (token.kind === 'text') {
      return { type: 'text', text: token.value }
    }
    return { type: 'text', text: token.value, marks: [{ type: ADF_MARKS[token.kind] }] }
  })
}

function inlineToWiki(line: string): string {
  return parseInline(line)
    .map((token) => {
      if (token.kind === 'text') {
        return token.value
      }
      const [open, close] = WIKI_WRAPPERS[token.kind]
      return `${open}${token.value}${close}`
    })
    .join('')
}

/** The body as an ADF document, the only shape Cloud's v3 comment endpoint takes. */
export function markdownToAdf(body: string): JiraRecord {
  return {
    type: 'doc',
    version: 1,
    content: parseBlocks(body, true)
      .map((block) => {
        if (block.kind === 'paragraph') {
          return { type: 'paragraph', content: inlineToAdf(block.line) }
        }
        if (block.kind === 'quote') {
          return {
            type: 'blockquote',
            content: block.lines.map((line) => ({ type: 'paragraph', content: inlineToAdf(line) }))
          }
        }
        if (block.kind === 'code') {
          const text = block.lines.join('\n')
          return text.trim().length === 0
            ? null
            : {
                type: 'codeBlock',
                ...(block.language ? { attrs: { language: block.language } } : {}),
                // Why `text` not a mark: ADF code blocks carry one verbatim node.
                content: [{ type: 'text', text }]
              }
        }
        return {
          type: 'bulletList',
          content: block.items.map((item) => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: inlineToAdf(item) }]
          }))
        }
      })
      .filter((node) => node !== null)
  }
}

/** The body as Jira wiki markup, which Server/DC v2 stores verbatim. */
export function markdownToJiraWiki(body: string): string {
  return parseBlocks(body, false)
    .map((block) => {
      if (block.kind === 'paragraph') {
        return inlineToWiki(block.line)
      }
      if (block.kind === 'quote') {
        return `{quote}\n${block.lines.map(inlineToWiki).join('\n')}\n{quote}`
      }
      if (block.kind === 'code') {
        const macro = block.language ? `{code:${block.language}}` : '{code}'
        return `${macro}\n${block.lines.join('\n')}\n{code}`
      }
      return block.items.map((item) => `* ${inlineToWiki(item)}`).join('\n')
    })
    .join('\n')
}

/** A comment body the composer typed in Markdown, in the format its site accepts.
 *
 *  Only Markdown bodies come here. Every other caller — the CLI, a paired client,
 *  a body that is already wiki markup — keeps the plain-text path it always had,
 *  because this conversion cannot tell a literal `- item` from a list marker and
 *  must not be applied to text it did not author. */
export function markdownCommentBody(site: JiraSite, body: string): unknown {
  return site.authType === 'server' ? markdownToJiraWiki(body) : markdownToAdf(body)
}
