import { compareFileNames } from './file-name-sort'

/**
 * Bounded result retention for a path scan. Both Quick Open ranking and the Explore name
 * filter scan an unbounded number of paths but may only retain `limit` of them, so the retained
 * page is held in a max-heap on the result order and the caller counts matches separately.
 */

export type QuickOpenRankedResult = {
  path: string
  score: number
  inputIndex: number
}

export function retainTopResult(
  heap: QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult,
  limit: number
): void {
  if (heap.length === limit && compareRankedResult(candidate, heap[0]) >= 0) {
    return
  }
  if (heap.length < limit) {
    heap.push(candidate)
    siftResultUp(heap, heap.length - 1)
    return
  }
  heap[0] = candidate
  siftResultDown(heap)
}

function siftResultUp(heap: QuickOpenRankedResult[], startIndex: number): void {
  let index = startIndex
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (compareRankedResult(heap[index], heap[parentIndex]) <= 0) {
      return
    }
    ;[heap[index], heap[parentIndex]] = [heap[parentIndex], heap[index]]
    index = parentIndex
  }
}

function siftResultDown(heap: QuickOpenRankedResult[]): void {
  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    if (leftIndex >= heap.length) {
      return
    }
    const rightIndex = leftIndex + 1
    const worseChildIndex =
      rightIndex < heap.length && compareRankedResult(heap[rightIndex], heap[leftIndex]) > 0
        ? rightIndex
        : leftIndex
    if (compareRankedResult(heap[worseChildIndex], heap[index]) <= 0) {
      return
    }
    ;[heap[index], heap[worseChildIndex]] = [heap[worseChildIndex], heap[index]]
    index = worseChildIndex
  }
}

export function finalizeResults(
  results: QuickOpenRankedResult[]
): { path: string; score: number }[] {
  return results.sort(compareRankedResult).map(({ path, score }) => ({ path, score }))
}

export function compareRankedResult(a: QuickOpenRankedResult, b: QuickOpenRankedResult): number {
  return a.score - b.score || compareFileNames(a.path, b.path) || a.inputIndex - b.inputIndex
}
