import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AiVaultSearchHit } from '../../shared/ai-vault-search-types'

const MERGED_SEARCH_ORDER_CACHE_MAX_ENTRIES = 8
/** A frozen order is a snapshot, so it does not stay publishable forever. */
const MERGED_SEARCH_ORDER_TTL_MS = 10 * 60_000

/**
 * A fused order plus the per-host generations it was fused from.
 *
 * Generation bumps on every index write, so it cannot fence rank stability. The
 * desktop instead freezes the order it fused and slices it for later pages; the
 * recorded generations are what later pages compare a probe against to report
 * that the snapshot has moved on.
 */
export type FrozenMergedSearchOrder = {
  /** Opaque cursor id, and the cache key. */
  seqId: string
  /** `sessionSearchPageKey` of the query this order answers. */
  pageKey: string
  perHostGeneration: Readonly<Record<string, number>>
  hits: readonly AiVaultSearchHit[]
  /** A host's fetched page was full, so ranks below the per-host ceiling are missing. */
  depthLimited: boolean
  queryTruncated: boolean
  /**
   * Truncated snippets across the rows the merge fetched.
   *
   * A count and not a per-row flag: `snippetTruncated` is an engine field the host
   * does not put on the wire, so these counts are all the desktop receives. The
   * field therefore covers the fused pool, not only the page a response returns.
   */
  snippetTruncationCount: number
  /** A host answered after its `wait-until-current` window expired during fusion. */
  freshnessAtFusion: boolean
  /** The highest index generation observed at fusion. */
  generation: number
  createdAt: number
}

const MergedSearchCursorSchema = z.object({
  k: z.string().min(1),
  s: z.string().min(1),
  o: z.number().int().nonnegative(),
  g: z.record(z.string().min(1), z.number().int().nonnegative())
})

export type DecodedMergedSearchCursor = {
  pageKey: string
  seqId: string
  /** Offset into the frozen sequence, which no client can compute for itself. */
  offset: number
  perHostGeneration: Record<string, number>
}

export function encodeMergedSearchCursor(order: FrozenMergedSearchOrder, offset: number): string {
  return Buffer.from(
    JSON.stringify({ k: order.pageKey, s: order.seqId, o: offset, g: order.perHostGeneration }),
    'utf-8'
  ).toString('base64url')
}

/** Null for anything this merger did not mint; a rejected cursor is not an error. */
export function decodeMergedSearchCursor(cursor: string): DecodedMergedSearchCursor | null {
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  const parsed = MergedSearchCursorSchema.safeParse(payload)
  if (!parsed.success) {
    return null
  }
  return {
    pageKey: parsed.data.k,
    seqId: parsed.data.s,
    offset: parsed.data.o,
    perHostGeneration: parsed.data.g
  }
}

/**
 * Frozen orders, oldest use evicted first.
 *
 * Why process state and not a stateless cursor: the fused sequence is the whole
 * point — re-deriving it on every page turn is re-fusing, which reorders rows the
 * user is already reading.
 */
export class MergedSearchOrderCache {
  private readonly orders = new Map<string, FrozenMergedSearchOrder>()

  constructor(
    private readonly maxEntries: number = MERGED_SEARCH_ORDER_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = MERGED_SEARCH_ORDER_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  put(order: FrozenMergedSearchOrder): void {
    this.evictExpired()
    // Delete-then-set so a re-put or a read moves the entry to the eviction tail.
    this.orders.delete(order.seqId)
    this.orders.set(order.seqId, order)
    while (this.orders.size > this.maxEntries) {
      const oldest = this.orders.keys().next().value
      if (oldest === undefined) {
        return
      }
      this.orders.delete(oldest)
    }
  }

  get(seqId: string): FrozenMergedSearchOrder | null {
    const order = this.orders.get(seqId)
    if (!order) {
      return null
    }
    if (this.now() - order.createdAt > this.ttlMs) {
      this.orders.delete(seqId)
      return null
    }
    this.orders.delete(seqId)
    this.orders.set(seqId, order)
    return order
  }

  clear(): void {
    this.orders.clear()
  }

  private evictExpired(): void {
    for (const [seqId, order] of this.orders) {
      if (this.now() - order.createdAt > this.ttlMs) {
        this.orders.delete(seqId)
      }
    }
  }
}

export function createFrozenMergedSearchOrder(args: {
  pageKey: string
  perHostGeneration: Record<string, number>
  hits: readonly AiVaultSearchHit[]
  depthLimited: boolean
  queryTruncated: boolean
  snippetTruncationCount: number
  freshnessAtFusion: boolean
  generation: number
}): FrozenMergedSearchOrder {
  return { ...args, seqId: randomUUID(), createdAt: Date.now() }
}
