import type { WorkspacePathIndexEntry } from './workspace-path-index-lease'

/** Retains released roots by recency and disposes expired or excess generations. */
export class WorkspacePathIndexRetention {
  constructor(
    private readonly entries: Map<string, WorkspacePathIndexEntry>,
    private readonly maxRoots: number,
    private readonly retentionMilliseconds: number,
    private readonly disposeEntry: (entry: WorkspacePathIndexEntry) => void
  ) {}

  afterRelease(now = Date.now()): void {
    for (const entry of this.entries.values()) {
      if (entry.leases.size === 0 && now - entry.lastUsedAt >= this.retentionMilliseconds) {
        this.disposeEntry(entry)
      }
    }
    this.enforceLimit()
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
}
