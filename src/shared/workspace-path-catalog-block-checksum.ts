// One table lookup per byte instead of eight bit iterations. A spilled 1M scan validates ~0.6 GB
// of block payloads per query, where the bit loop dominated decode time.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let remainder = value
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = (remainder >>> 1) ^ (0xedb8_8320 & -(remainder & 1))
    }
    table[value] = remainder >>> 0
  }
  return table
})()

/** CRC-32/ISO-HDLC over catalog block payloads (original, folded, and flags streams). */
export function workspacePathCatalogBlockChecksum(bytes: Uint8Array): number {
  let checksum = 0xffff_ffff
  for (let index = 0; index < bytes.length; index += 1) {
    checksum = (checksum >>> 8) ^ (CRC32_TABLE[(checksum ^ (bytes[index] ?? 0)) & 0xff] ?? 0)
  }
  return (checksum ^ 0xffff_ffff) >>> 0
}
