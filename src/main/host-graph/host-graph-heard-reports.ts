import {
  HOST_GRAPH_MAX_HEARD,
  HOST_GRAPH_NODE_TTL_MS,
  type HostGraphAdjacency,
  type HostGraphHeardReport
} from '../../shared/host-graph/host-graph-contract'

/**
 * What this host last heard from each caller that reported itself.
 *
 * Why memory only: these are other machines' claims about themselves, re-sent on every exchange, so a
 * restart loses nothing but a refresh period — and persisting them would let a stale claim outlive the
 * pairing that admitted it.
 */

export type HostGraphHeardReports = {
  record(input: {
    callerFingerprint: string
    adjacency: HostGraphAdjacency
    receivedAt?: number
  }): void
  list(input?: { now?: number }): HostGraphHeardReport[]
  forget(callerFingerprint: string): void
}

/**
 * The process-wide store.
 *
 * Why one instance shared by the method and the driver: a host that is only ever *called* learns the
 * fleet from these reports and nothing else. A per-request store would leave its own status bar showing
 * none of the machines that asked it.
 */
let shared: HostGraphHeardReports | null = null

export function getHostGraphHeardReports(): HostGraphHeardReports {
  shared ??= createHostGraphHeardReports()
  return shared
}

export function resetHostGraphHeardReports(): void {
  shared = null
}

export function createHostGraphHeardReports(
  options: { now?: () => number } = {}
): HostGraphHeardReports {
  const clock = options.now ?? Date.now
  const reports = new Map<string, HostGraphHeardReport>()

  const prune = (now: number): void => {
    for (const [fingerprint, report] of reports) {
      if (now - report.receivedAt > HOST_GRAPH_NODE_TTL_MS) {
        reports.delete(fingerprint)
      }
    }
    // Why newest-first eviction: a caller that stopped asking must lose its slot to one that still is.
    while (reports.size > HOST_GRAPH_MAX_HEARD) {
      const oldest = [...reports.values()].reduce((left, right) =>
        left.receivedAt <= right.receivedAt ? left : right
      )
      reports.delete(oldest.reportedBy)
    }
  }

  return {
    record: (input) => {
      const receivedAt = input.receivedAt ?? clock()
      reports.set(input.callerFingerprint, {
        adjacency: input.adjacency,
        reportedBy: input.callerFingerprint,
        receivedAt
      })
      prune(clock())
    },
    list: (input) => {
      const now = input?.now ?? clock()
      prune(now)
      return [...reports.values()]
        .filter((report) => now - report.receivedAt <= HOST_GRAPH_NODE_TTL_MS)
        .sort((left, right) => right.receivedAt - left.receivedAt)
        .slice(0, HOST_GRAPH_MAX_HEARD)
    },
    forget: (callerFingerprint) => {
      reports.delete(callerFingerprint)
    }
  }
}
