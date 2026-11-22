import type { Row } from '../../../../../../shared/sidebar-list/row-types'

export type RowNode = { row: Row; children: RowNode[] }

function depthOf(row: Row): number | null {
  return row.type === 'item' || row.type === 'folder-workspace' ? row.depth : null
}

/** The list as a tree, so a merge can group siblings at any depth, not just the roots. */
export function buildRowForest(rows: readonly Row[]): RowNode[] {
  const roots: RowNode[] = []
  const open: { depth: number; node: RowNode }[] = []
  for (const row of rows) {
    const node: RowNode = { row, children: [] }
    const depth = depthOf(row)
    if (depth === null) {
      // Why the root and a closed stack: a section header separates sections, so
      // nothing above it may keep the rows below as its children.
      open.length = 0
      roots.push(node)
      continue
    }
    while (open.length > 0 && open.at(-1)!.depth >= depth) {
      open.pop()
    }
    const siblings = open.at(-1)?.node.children ?? roots
    siblings.push(node)
    open.push({ depth, node })
  }
  return roots
}

export function flattenRowForest(nodes: readonly RowNode[]): Row[] {
  const rows: Row[] = []
  for (const node of nodes) {
    rows.push(node.row)
    rows.push(...flattenRowForest(node.children))
  }
  return rows
}
