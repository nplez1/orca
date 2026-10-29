import type { WorkspacePathIndexEntry } from './workspace-path-index-lease'

/** A delay above this overflows Node's timer, which fires at once and would re-arm forever. */
const MAX_TIMER_MILLISECONDS = 2_147_483_647

/** Retains released roots by recency and disposes expired or excess generations. */
export class WorkspacePathIndexRetention {
  private expiryTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly entries: Map<string, WorkspacePathIndexEntry>,
    private readonly maxRoots: number,
    private readonly retentionMilliseconds: number,
    private readonly disposeEntry: (entry: WorkspacePathIndexEntry) => void
  ) {}

  afterRelease(now = Date.now()): void {
    this.expireInactive(now)
    this.enforceLimit()
    // Why a timer as well as a release: expiry used to run only from another lease's release or a
    // publish, so the last root you closed kept its catalog until one of those happened.
    this.scheduleExpiry(now)
  }

  enforceLimit(): void {
    const inactive = [...this.entries.values()]
      .filter((entry) => entry.leases.size === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    while (this.entries.size > this.maxRoots && inactive.length > 0) {
      const oldest = inactive.shift()
      if (oldest) {
        this.disposeEntry(oldest)
      }
    }
  }

  /** Clears the pending expiry: a disposed service must not keep a timer alive. */
  dispose(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  private expireInactive(now: number): void {
    for (const entry of this.entries.values()) {
      if (entry.leases.size === 0 && now - entry.lastUsedAt >= this.retentionMilliseconds) {
        this.disposeEntry(entry)
      }
    }
  }

  private scheduleExpiry(now: number): void {
    let wait: number | null = null
    for (const entry of this.entries.values()) {
      if (entry.leases.size > 0) {
        continue
      }
      const remaining = entry.lastUsedAt + this.retentionMilliseconds - now
      wait = wait === null ? remaining : Math.min(wait, remaining)
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    if (wait === null) {
      return
    }
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null
        this.afterRelease()
      },
      Math.max(1, Math.min(wait, MAX_TIMER_MILLISECONDS))
    )
    this.expiryTimer.unref?.()
  }
}
