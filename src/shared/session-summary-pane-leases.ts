// Which viewers hold a pane's summary.
//
// A viewer is a lease: `open` takes one, `close` returns it. Two viewers of one pane — two
// windows, or two paired clients on a host — must not cancel each other's fold, so a fold
// outlives the first close.
//
// Leases are never expired on a timer. A timer cannot tell a reader who has watched for an
// hour from a window that died, and expiring the first would drop its place in the timeline
// and (on a host) its seen cursor with it. What a stale lease actually costs is memory and a
// fold that runs to completion with no reader — both bounded — because the seen cursor is
// recorded on every close, whoever else still holds the pane.
export type SessionSummaryPaneLeasesDeps = {
  /** Oldest leases are dropped past this, so a long session cannot grow them forever. */
  maxPanes?: number
}

const DEFAULT_MAX_PANES = 512

export class SessionSummaryPaneLeases {
  private readonly leases = new Map<string, number>()

  constructor(private readonly deps: SessionSummaryPaneLeasesDeps = {}) {}

  /** Takes a lease for a viewer opening this pane. */
  touch(paneKey: string): void {
    // Re-insert at the end so the map order is least-recently-opened first.
    const existing = this.leases.get(paneKey) ?? 0
    this.leases.delete(paneKey)
    this.leases.set(paneKey, existing + 1)
    const max = this.deps.maxPanes ?? DEFAULT_MAX_PANES
    while (this.leases.size > max) {
      const oldest = this.leases.keys().next()
      if (oldest.done) {
        break
      }
      this.leases.delete(oldest.value)
    }
  }

  /** Returns one lease; the remaining count, or 0 when nothing holds the pane. */
  release(paneKey: string): number {
    const existing = this.leases.get(paneKey)
    if (!existing) {
      return 0
    }
    const remaining = existing - 1
    if (remaining > 0) {
      this.leases.set(paneKey, remaining)
      return remaining
    }
    this.leases.delete(paneKey)
    return 0
  }

  /** Forgets the pane outright, whoever still claimed it. */
  drop(paneKey: string): void {
    this.leases.delete(paneKey)
  }

  count(paneKey: string): number {
    return this.leases.get(paneKey) ?? 0
  }
}
