// Which viewers hold a pane's summary, and which of them has stopped reporting.
//
// A viewer is a lease: `open` takes one, `close` returns it. Two viewers of one pane — two
// windows, or two paired clients on a host — must not cancel each other's fold, so a fold
// outlives the first close. A viewer that dies without closing (a window torn down, a
// dropped paired client) never returns its lease, so an unrenewed one expires rather than
// pinning a fold for the life of the process.
export type SessionSummaryPaneLeasesDeps = {
  now: () => number
  ttlMs: number
}

export class SessionSummaryPaneLeases {
  private readonly leases = new Map<string, { count: number; touchedAt: number }>()

  constructor(private readonly deps: SessionSummaryPaneLeasesDeps) {}

  /** Takes a lease for a viewer opening this pane. */
  touch(paneKey: string): void {
    const existing = this.leases.get(paneKey)
    this.leases.set(paneKey, {
      count: (existing?.count ?? 0) + 1,
      touchedAt: this.deps.now()
    })
  }

  /** Returns one lease; the remaining count, or 0 when nothing holds the pane. */
  release(paneKey: string): number {
    const existing = this.leases.get(paneKey)
    if (!existing) {
      return 0
    }
    const remaining = existing.count - 1
    if (remaining > 0) {
      this.leases.set(paneKey, { count: remaining, touchedAt: this.deps.now() })
      return remaining
    }
    this.leases.delete(paneKey)
    return 0
  }

  /** Panes whose leases nobody renewed in time. */
  takeStale(): string[] {
    const now = this.deps.now()
    const stale = [...this.leases]
      .filter(([, lease]) => now - lease.touchedAt >= this.deps.ttlMs)
      .map(([paneKey]) => paneKey)
    for (const paneKey of stale) {
      this.leases.delete(paneKey)
    }
    return stale
  }

  /** Forgets the pane outright, whoever still claimed it. */
  drop(paneKey: string): void {
    this.leases.delete(paneKey)
  }

  count(paneKey: string): number {
    return this.leases.get(paneKey)?.count ?? 0
  }
}
