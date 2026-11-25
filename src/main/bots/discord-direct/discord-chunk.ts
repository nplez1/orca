// Discord has no message splitting: content over the limit is refused, so a long reply is cut into
// messages here. The cut never breaks a surrogate pair or a fenced code block — a block that is open
// at a cut is closed at the end of that chunk and reopened with its language tag in the next one.
import { DISCORD_MAX_CHUNKS, DISCORD_MESSAGE_CONTENT_LIMIT } from './discord-contract'

type FenceOpen = { run: number; tag: string }
type FenceMarker = { index: number; after: number; open: FenceOpen | null }

/** A line that opens or closes a block: three or more backticks, then an optional language tag. */
const FENCE_LINE = /^[ \t]*(`{3,})([^\n]*)$/gm
const FENCE_CLOSE = '\n```'

/**
 * Splits `text` into messages of at most `limit` UTF-16 code units each — the unit `String.length`
 * counts, which is never more than Discord's character limit under either reading.
 *
 * Returns at most `DISCORD_MAX_CHUNKS + 1` chunks, so `length > DISCORD_MAX_CHUNKS` means the text is
 * too long to send at all rather than merely needing several messages.
 */
export function chunkDiscordMessage(text: string, limit = DISCORD_MESSAGE_CONTENT_LIMIT): string[] {
  if (text.trim() === '') {
    return []
  }
  const markers = fenceMarkers(text)
  const fenceLineEnds = new Set(markers.map((marker) => marker.after))
  const chunks: string[] = []
  let pos = 0
  while (pos < text.length && chunks.length <= DISCORD_MAX_CHUNKS) {
    const open = fenceStateAt(markers, pos)
    const prefix = open ? reopenFence(open) : ''
    const room = limit - prefix.length
    // A limit that cannot hold the reopening fence would emit over-limit chunks; stop instead.
    if (room < 1) {
      break
    }
    const tail = text.length - pos
    const tailClose = fenceStateAt(markers, text.length) ? FENCE_CLOSE.length : 0
    let end: number
    let close = false
    if (tail + tailClose <= room) {
      end = text.length
      close = tailClose > 0
    } else {
      end = chooseCut(text, pos, pos + room, fenceLineEnds)
      if (fenceStateAt(markers, end)) {
        const shorter = chooseCut(text, pos, pos + room - FENCE_CLOSE.length, fenceLineEnds)
        if (shorter > pos) {
          end = shorter
        }
        close = fenceStateAt(markers, end) !== null
      }
    }
    chunks.push(prefix + text.slice(pos, end) + (close ? FENCE_CLOSE : ''))
    pos = end
  }
  return chunks
}

/** Every fence marker that toggles block state, with the state it leaves behind. */
function fenceMarkers(text: string): FenceMarker[] {
  const markers: FenceMarker[] = []
  let open: FenceOpen | null = null
  for (const match of text.matchAll(FENCE_LINE)) {
    const index = match.index
    const run = match[1].length
    const tag = match[2].trim()
    const after = index + match[0].length + 1
    if (!open) {
      open = { run, tag }
      markers.push({ index, after, open })
    } else if (run >= open.run && tag === '') {
      open = null
      markers.push({ index, after, open })
    }
    // A shorter or tagged line inside a block is its content, not a marker.
  }
  return markers
}

function fenceStateAt(markers: readonly FenceMarker[], at: number): FenceOpen | null {
  let open: FenceOpen | null = null
  for (const marker of markers) {
    if (marker.index >= at) {
      break
    }
    open = marker.open
  }
  return open
}

function reopenFence(open: FenceOpen): string {
  return `${'`'.repeat(open.run)}${open.tag}\n`
}

/** Blank line, then line break, then space, then a hard cut — the least ugly break that fits. */
function chooseCut(
  text: string,
  from: number,
  to: number,
  fenceLineEnds: ReadonlySet<number>
): number {
  const end = Math.min(to, text.length)
  if (end <= from) {
    return from
  }
  for (const [needle, width] of [
    ['\n\n', 2],
    ['\n', 1],
    [' ', 1]
  ] as const) {
    const cut = cutAfter(text, from, end, needle, width, fenceLineEnds)
    if (cut > from) {
      return cut
    }
  }
  return withoutSplitPair(text, end, from)
}

/** The last `needle` ending at or before `end`, skipping cuts that would leave a bare fence header. */
function cutAfter(
  text: string,
  from: number,
  end: number,
  needle: string,
  width: number,
  fenceLineEnds: ReadonlySet<number>
): number {
  let at = text.lastIndexOf(needle, end - width)
  while (at >= from) {
    const cut = at + width
    if (!fenceLineEnds.has(cut)) {
      return cut
    }
    at = text.lastIndexOf(needle, at - 1)
  }
  return from
}

function withoutSplitPair(text: string, cut: number, from: number): number {
  if (cut >= text.length) {
    return text.length
  }
  const before = text.charCodeAt(cut - 1)
  const after = text.charCodeAt(cut)
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  if (!splitsPair) {
    return cut
  }
  // Back off a unit; with no room to back off, take the pair whole rather than split it.
  return cut - 1 > from ? cut - 1 : cut + 1
}
