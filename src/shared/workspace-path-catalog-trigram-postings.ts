export type WorkspacePathCatalogTrigramPostings = {
  /** Sorted three-code-unit dictionary, packed as consecutive UTF-16 triples. */
  gramCodeUnits: Uint16Array
  postingOffsets: Uint32Array
  postingCounts: Uint32Array
  /** Delta-varint encoded natural-order ranks for each dictionary entry. */
  encodedPostingRanks: Uint8Array
  retainedBytes: number
}

export function findWorkspacePathTrigramPosting(
  postings: WorkspacePathCatalogTrigramPostings,
  gram: number
): number | undefined {
  let low = 0
  let high = postings.postingCounts.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const comparison = compareDictionaryGram(postings.gramCodeUnits, middle, gram)
    if (comparison === 0) {
      return middle
    }
    if (comparison < 0) {
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return undefined
}

export function decodeWorkspacePathTrigramPosting(
  postings: WorkspacePathCatalogTrigramPostings,
  postingIndex: number
): Uint32Array {
  const start = postings.postingOffsets[postingIndex]
  const end = postings.postingOffsets[postingIndex + 1]
  const count = postings.postingCounts[postingIndex]
  if (start === undefined || end === undefined || count === undefined) {
    return new Uint32Array()
  }
  const ranks = new Uint32Array(count)
  let offset = start
  let previousRank = 0
  for (let index = 0; index < count; index += 1) {
    let value = 0
    let multiplier = 1
    while (offset < end) {
      const byte = postings.encodedPostingRanks[offset] ?? 0
      offset += 1
      value += (byte & 0x7f) * multiplier
      if ((byte & 0x80) === 0) {
        break
      }
      multiplier *= 0x80
    }
    previousRank += value
    ranks[index] = previousRank
  }
  return ranks
}

export function intersectSortedRanks(left: Uint32Array, right: Uint32Array): Uint32Array {
  const intersection = new Uint32Array(Math.min(left.length, right.length))
  let leftIndex = 0
  let rightIndex = 0
  let retained = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftRank = left[leftIndex]
    const rightRank = right[rightIndex]
    if (leftRank === rightRank) {
      if (leftRank !== undefined) {
        intersection[retained] = leftRank
        retained += 1
      }
      leftIndex += 1
      rightIndex += 1
    } else if ((leftRank ?? 0) < (rightRank ?? 0)) {
      leftIndex += 1
    } else {
      rightIndex += 1
    }
  }
  return intersection.subarray(0, retained)
}

export function packTrigram(first: number, second: number, third: number): number {
  return first * 0x1_0000_0000 + second * 0x1_0000 + third
}

export function compareDictionaryGram(
  dictionary: Uint16Array,
  gramIndex: number,
  gram: number
): number {
  const offset = gramIndex * 3
  const dictionaryGram =
    (dictionary[offset] ?? 0) * 0x1_0000_0000 +
    (dictionary[offset + 1] ?? 0) * 0x1_0000 +
    (dictionary[offset + 2] ?? 0)
  return dictionaryGram - gram
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

export function encodeVarint(value: number, destination: Uint8Array, offset: number): number {
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    destination[offset] = (remaining & 0x7f) | 0x80
    offset += 1
    remaining >>>= 7
  }
  destination[offset] = remaining
  return offset + 1
}
