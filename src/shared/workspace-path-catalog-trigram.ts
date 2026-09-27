import type { WorkspacePathCatalog } from './workspace-path-catalog'
import {
  decodeWorkspacePathTrigramPosting,
  findWorkspacePathTrigramPosting,
  intersectSortedRanks,
  packTrigram
} from './workspace-path-catalog-trigram-postings'

export { buildWorkspacePathCatalogTrigramPostings } from './workspace-path-catalog-trigram-build'
export type { WorkspacePathCatalogTrigramPostings } from './workspace-path-catalog-trigram-postings'
export {
  decodeWorkspacePathTrigramPosting,
  findWorkspacePathTrigramPosting
} from './workspace-path-catalog-trigram-postings'

export type WorkspacePathCatalogTrigramCandidates = {
  strategy: 'ordered-scan' | 'trigram-postings'
  candidateRanks: Uint32Array | null
}

const BROAD_POSTING_FRACTION = 0.5

export function selectWorkspacePathCatalogTrigramCandidates(
  catalog: WorkspacePathCatalog,
  tokens: readonly string[]
): WorkspacePathCatalogTrigramCandidates {
  const postings = catalog.trigramPostings
  if (!postings) {
    return { strategy: 'ordered-scan', candidateRanks: null }
  }
  const seenGrams = new Set<number>()
  const postingIndexes: number[] = []
  for (const token of tokens) {
    for (let offset = 0; offset <= token.length - 3; offset += 1) {
      const gram = packTrigram(
        token.charCodeAt(offset),
        token.charCodeAt(offset + 1),
        token.charCodeAt(offset + 2)
      )
      if (seenGrams.has(gram)) {
        continue
      }
      seenGrams.add(gram)
      const postingIndex = findWorkspacePathTrigramPosting(postings, gram)
      if (postingIndex === undefined) {
        return { strategy: 'trigram-postings', candidateRanks: new Uint32Array() }
      }
      postingIndexes.push(postingIndex)
    }
  }
  if (postingIndexes.length === 0) {
    return { strategy: 'ordered-scan', candidateRanks: null }
  }
  postingIndexes.sort(
    (left, right) => (postings.postingCounts[left] ?? 0) - (postings.postingCounts[right] ?? 0)
  )
  const rarestPostingIndex = postingIndexes[0]
  if (rarestPostingIndex === undefined) {
    return { strategy: 'ordered-scan', candidateRanks: null }
  }
  const rarestCount = postings.postingCounts[rarestPostingIndex] ?? 0
  if (rarestCount >= catalog.pathCount * BROAD_POSTING_FRACTION) {
    return { strategy: 'ordered-scan', candidateRanks: null }
  }
  let candidates = decodeWorkspacePathTrigramPosting(postings, rarestPostingIndex)
  for (let index = 1; index < postingIndexes.length && candidates.length > 0; index += 1) {
    const postingIndex = postingIndexes[index]
    if (postingIndex === undefined) {
      continue
    }
    const nextCandidates = decodeWorkspacePathTrigramPosting(postings, postingIndex)
    candidates = intersectSortedRanks(candidates, nextCandidates)
  }
  return { strategy: 'trigram-postings', candidateRanks: candidates }
}
