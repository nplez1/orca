import type { WorkspacePathSearchResponse } from './workspace-path-search-contract'

export type WorkspacePathSearchTransportBudget = {
  maxPageSerializedBytes: number
  transportByteCeilings: readonly number[]
  envelopeHeadroomBytes: number
}

/** Retain one prefix while charging escaped JSON bytes for rows, flags, metadata, and envelopes. */
export function limitWorkspacePathSearchResponseBySerializedBytes<
  T extends WorkspacePathSearchResponse
>(response: T, budget: WorkspacePathSearchTransportBudget): T {
  const transportContentBudgets = budget.transportByteCeilings.map((ceiling) =>
    Math.max(0, ceiling - budget.envelopeHeadroomBytes)
  )
  const contentBudget = Math.min(budget.maxPageSerializedBytes, ...transportContentBudgets)
  const emptyPage = { ...response, rows: [], rowClassificationFlags: [], retainedCount: 0 }
  const emptyPageBytes = Buffer.byteLength(JSON.stringify(emptyPage), 'utf8')
  if (emptyPageBytes > contentBudget) {
    throw new Error('Workspace path search metadata exceeds the remote transport budget')
  }

  const rows: T['rows'][number][] = []
  const flags: T['rowClassificationFlags'][number][] = []
  let serializedBytes = emptyPageBytes
  for (let index = 0; index < response.rows.length; index += 1) {
    const row = response.rows[index]
    const flag = response.rowClassificationFlags[index]
    if (row === undefined || flag === undefined) {
      break
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
    const flagBytes = Buffer.byteLength(JSON.stringify(flag), 'utf8')
    const separatorsBytes = rows.length === 0 ? 0 : 2
    const nextBytes = serializedBytes + rowBytes + flagBytes + separatorsBytes
    if (nextBytes > contentBudget) {
      break
    }
    rows.push(row)
    flags.push(flag)
    serializedBytes = nextBytes
  }

  return { ...response, rows, rowClassificationFlags: flags, retainedCount: rows.length }
}
