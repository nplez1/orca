/**
 * First-page budget for a restored (provisional last-known) spilled catalog. A full spilled scan
 * costs 142 ms at 100k realistic paths but 1.16–3.79 s at 1M, so a restart answers from a bounded
 * natural-order prefix instead and reports coverage `partial` until reconciliation promotes the
 * root. Every bound is strict: the prefix is a real prefix of the same `compareFileNames` order the
 * complete scan would return, so the page needs no re-sort, and the count is never extrapolated.
 */
export const WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_BLOCKS = 128
export const WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_ENCODED_BYTES = 16 * 1024 * 1024
export const WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_MILLISECONDS = 100

export type WorkspacePathProvisionalPageBudget = {
  maxBlocks: number
  maxEncodedBytes: number
  maxMilliseconds: number
}

export const WORKSPACE_PATH_PROVISIONAL_PAGE_BUDGET: WorkspacePathProvisionalPageBudget = {
  maxBlocks: WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_BLOCKS,
  maxEncodedBytes: WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_ENCODED_BYTES,
  maxMilliseconds: WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_MILLISECONDS
}

/**
 * True once the bounded prefix is spent. Blocks and encoded bytes are deliberate hard ceilings (a
 * slow page cannot buy time); the millisecond bound caps decode on a machine slower than the one the
 * other two were sized on. Callers stop the scan, not merely the retention.
 */
export function workspacePathProvisionalPageBudgetExhausted(args: {
  blocksRead: number
  encodedBytesRead: number
  startedAt: number
  budget: WorkspacePathProvisionalPageBudget
}): boolean {
  return (
    args.blocksRead >= args.budget.maxBlocks ||
    args.encodedBytesRead >= args.budget.maxEncodedBytes ||
    performance.now() - args.startedAt >= args.budget.maxMilliseconds
  )
}
