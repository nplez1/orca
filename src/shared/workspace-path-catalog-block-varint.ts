/** Unsigned-varint and shared-prefix primitives for the version-1 prefix block codec. */

export function commonPrefixLength(
  left: string,
  right: string,
  avoidSurrogateSplit: boolean
): number {
  const length = Math.min(left.length, right.length)
  let prefix = 0
  while (prefix < length && left.charCodeAt(prefix) === right.charCodeAt(prefix)) {
    prefix += 1
  }
  if (
    avoidSurrogateSplit &&
    prefix > 0 &&
    left.charCodeAt(prefix - 1) >= 0xd800 &&
    left.charCodeAt(prefix - 1) <= 0xdbff
  ) {
    prefix -= 1
  }
  return prefix
}

export function varintLength(value: number): number {
  let remaining = value >>> 0
  let length = 1
  while (remaining >= 0x80) {
    remaining >>>= 7
    length += 1
  }
  return length
}

export function writeVarint(value: number, destination: Uint8Array, offset: number): number {
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    destination[offset] = (remaining & 0x7f) | 0x80
    offset += 1
    remaining >>>= 7
  }
  destination[offset] = remaining
  return offset + 1
}

export function readVarint(
  bytes: Uint8Array,
  startOffset: number
): { value: number; nextOffset: number } {
  let value = 0
  let multiplier = 1
  let offset = startOffset
  while (offset < bytes.length && multiplier <= 0x100_0000) {
    const byte = bytes[offset] ?? 0
    offset += 1
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset }
    }
    multiplier *= 0x80
  }
  throw new Error('Workspace path catalog block has an invalid varint')
}
