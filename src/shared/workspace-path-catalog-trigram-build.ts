import type { WorkspacePathCatalogBuildRecord } from './workspace-path-catalog-builder-collection'
import {
  encodeVarint,
  packTrigram,
  varintLength,
  type WorkspacePathCatalogTrigramPostings
} from './workspace-path-catalog-trigram-postings'

type GramBuildState = {
  count: number
  lastRank: number
  previousRank: number
  encodedBytes: number
  writeOffset: number
}

const TRANSIENT_BYTES_PER_GRAM = 128
const RETAINED_BYTES_PER_GRAM = 14

/** Three passes keep build scratch proportional to the gram dictionary, not posting count. */
export function buildWorkspacePathCatalogTrigramPostings(args: {
  records: readonly WorkspacePathCatalogBuildRecord[]
  naturalOrder: Uint32Array
  scratchBudgetBytes: number
  retainedBudgetBytes: number
}): WorkspacePathCatalogTrigramPostings | null {
  if (args.scratchBudgetBytes <= 0 || args.retainedBudgetBytes <= 0) {
    return null
  }
  const gramsByValue = new Map<number, GramBuildState>()
  let dictionaryScratchBytes = 0

  visitCatalogTrigrams(args, (rank, gram) => {
    let state = gramsByValue.get(gram)
    if (!state) {
      dictionaryScratchBytes += TRANSIENT_BYTES_PER_GRAM
      if (dictionaryScratchBytes > args.scratchBudgetBytes) {
        return false
      }
      state = { count: 0, lastRank: -1, previousRank: 0, encodedBytes: 0, writeOffset: 0 }
      gramsByValue.set(gram, state)
    }
    if (state.lastRank !== rank) {
      state.count += 1
      state.lastRank = rank
    }
    return true
  })
  if (dictionaryScratchBytes > args.scratchBudgetBytes) {
    return null
  }

  const sortedGrams = [...gramsByValue.keys()].sort((left, right) => left - right)
  for (const state of gramsByValue.values()) {
    state.lastRank = -1
    state.previousRank = 0
    state.encodedBytes = 0
  }
  visitCatalogTrigrams(args, (rank, gram) => {
    const state = gramsByValue.get(gram)
    if (!state) {
      return false
    }
    if (state.lastRank !== rank) {
      state.encodedBytes += varintLength(rank - state.previousRank)
      state.previousRank = rank
      state.lastRank = rank
    }
    return true
  })

  let encodedLength = 0
  for (const state of gramsByValue.values()) {
    encodedLength += state.encodedBytes
  }
  const retainedBytes = sortedGrams.length * RETAINED_BYTES_PER_GRAM + encodedLength + 132
  if (
    retainedBytes > args.retainedBudgetBytes ||
    dictionaryScratchBytes + retainedBytes > args.scratchBudgetBytes
  ) {
    return null
  }

  const gramCodeUnits = new Uint16Array(sortedGrams.length * 3)
  const postingOffsets = new Uint32Array(sortedGrams.length + 1)
  const postingCounts = new Uint32Array(sortedGrams.length)
  const encodedPostingRanks = new Uint8Array(encodedLength)
  let encodedOffset = 0
  for (let gramIndex = 0; gramIndex < sortedGrams.length; gramIndex += 1) {
    const gram = sortedGrams[gramIndex]
    const state = gram === undefined ? undefined : gramsByValue.get(gram)
    if (gram === undefined || !state) {
      continue
    }
    const gramOffset = gramIndex * 3
    gramCodeUnits[gramOffset] = Math.floor(gram / 0x1_0000_0000)
    gramCodeUnits[gramOffset + 1] = Math.floor(gram / 0x1_0000) % 0x1_0000
    gramCodeUnits[gramOffset + 2] = gram % 0x1_0000
    postingOffsets[gramIndex] = encodedOffset
    postingCounts[gramIndex] = state.count
    state.writeOffset = encodedOffset
    encodedOffset += state.encodedBytes
    state.lastRank = -1
    state.previousRank = 0
  }
  postingOffsets[sortedGrams.length] = encodedOffset

  visitCatalogTrigrams(args, (rank, gram) => {
    const state = gramsByValue.get(gram)
    if (!state) {
      return false
    }
    if (state.lastRank !== rank) {
      state.writeOffset = encodeVarint(
        rank - state.previousRank,
        encodedPostingRanks,
        state.writeOffset
      )
      state.previousRank = rank
      state.lastRank = rank
    }
    return true
  })

  return {
    gramCodeUnits,
    postingOffsets,
    postingCounts,
    encodedPostingRanks,
    retainedBytes
  }
}

function visitCatalogTrigrams(
  args: {
    records: readonly WorkspacePathCatalogBuildRecord[]
    naturalOrder: Uint32Array
  },
  visit: (rank: number, gram: number) => boolean
): boolean {
  for (let rank = 0; rank < args.naturalOrder.length; rank += 1) {
    const pathId = args.naturalOrder[rank]
    const foldedPath = pathId === undefined ? undefined : args.records[pathId]?.foldedPath
    if (foldedPath === undefined || foldedPath.length < 3) {
      continue
    }
    for (let offset = 0; offset <= foldedPath.length - 3; offset += 1) {
      const gram = packTrigram(
        foldedPath.charCodeAt(offset),
        foldedPath.charCodeAt(offset + 1),
        foldedPath.charCodeAt(offset + 2)
      )
      if (!visit(rank, gram)) {
        return false
      }
    }
  }
  return true
}
