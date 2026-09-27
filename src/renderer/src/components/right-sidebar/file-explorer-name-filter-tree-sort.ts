import { compareFileNames } from '../../../../shared/file-name-sort'
import type { TreeNode } from './file-explorer-types'
import type { SyntheticTreeEntry } from './file-explorer-name-filter-tree-nodes'

function compareSyntheticTreeEntries(a: SyntheticTreeEntry, b: SyntheticTreeEntry): number {
  if (a.node.isDirectory !== b.node.isDirectory) {
    return a.node.isDirectory ? -1 : 1
  }
  return compareFileNames(a.node.name, b.node.name)
}

// Keep the comparator authoritative while avoiding sorts for already ordered groups.
function getSortedNameFilteredEntries(
  children: ReadonlyMap<string, SyntheticTreeEntry>
): SyntheticTreeEntry[] {
  const entries = Array.from(children.values())
  for (let index = 1; index < entries.length; index += 1) {
    if (compareSyntheticTreeEntries(entries[index - 1], entries[index]) > 0) {
      return entries.sort(compareSyntheticTreeEntries)
    }
  }
  return entries
}

export function getSingleSyntheticChild(
  children: ReadonlyMap<string, SyntheticTreeEntry>
): SyntheticTreeEntry | null {
  if (children.size !== 1) {
    return null
  }
  return children.values().next().value ?? null
}

export async function sortNameFilteredEntriesInChunks(
  children: ReadonlyMap<string, SyntheticTreeEntry>,
  yieldIfNeeded: () => Promise<void> | null
): Promise<SyntheticTreeEntry[]> {
  let source = Array.from(children.values())
  if (source.length < 2) {
    return source
  }
  let isSorted = true
  for (let index = 1; index < source.length; index += 1) {
    if (compareSyntheticTreeEntries(source[index - 1], source[index]) > 0) {
      isSorted = false
      break
    }
    const pause = yieldIfNeeded()
    if (pause) {
      await pause
    }
  }
  if (isSorted) {
    return source
  }
  let target: SyntheticTreeEntry[] = []
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      let left = start
      let right = Math.min(start + width, source.length)
      const leftEnd = right
      const rightEnd = Math.min(start + width * 2, source.length)
      let output = start
      while (left < leftEnd || right < rightEnd) {
        const leftEntry = source.at(left)
        const rightEntry = source.at(right)
        if (leftEntry === undefined) {
          if (rightEntry !== undefined) {
            target[output] = rightEntry
            right += 1
          }
        } else if (
          rightEntry === undefined ||
          (left < leftEnd && compareSyntheticTreeEntries(leftEntry, rightEntry) <= 0)
        ) {
          target[output] = leftEntry
          left += 1
        } else {
          target[output] = rightEntry
          right += 1
        }
        output += 1
        const pause = yieldIfNeeded()
        if (pause) {
          await pause
        }
      }
    }
    const previousSource = source
    source = target
    target = previousSource
  }
  return source
}

export function appendNameFilteredEntries(
  children: ReadonlyMap<string, SyntheticTreeEntry>,
  visibleFlatRows: TreeNode[],
  rowsByPath: Map<string, TreeNode>,
  collapsedPaths?: ReadonlySet<string>
): void {
  const entries = children.size < 2 ? children.values() : getSortedNameFilteredEntries(children)
  for (const entry of entries) {
    visibleFlatRows.push(entry.node)
    rowsByPath.set(entry.node.path, entry.node)
    if (entry.children.size > 0 && !collapsedPaths?.has(entry.node.path)) {
      appendNameFilteredEntries(entry.children, visibleFlatRows, rowsByPath, collapsedPaths)
    }
  }
}
