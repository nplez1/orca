import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import {
  MERGED_SEARCH_FANOUT_CONCURRENCY,
  discoverHostSearchLegs,
  probeHostStatus,
  type AiVaultSearchAllHostDeps
} from './ai-vault-search-host-fanout'

/**
 * Aggregate status over every reachable host.
 *
 * Documented as a summary, not a per-host report: counts are sums, times are the
 * newest observation, generation is the highest, and degraded roots are
 * concatenated. A host that does not answer contributes nothing — the search
 * response's `hosts` field is where per-host outcomes live.
 */
export async function searchAllExecutionHostsStatus(
  deps: AiVaultSearchAllHostDeps
): Promise<AiVaultSearchStatus> {
  const { legs, discoveryFailures } = discoverHostSearchLegs(deps)
  for (const failure of discoveryFailures) {
    console.error(`[ai-vault] ${failure} host discovery failed for an all-hosts status read`)
  }
  const probed = await mapWithConcurrency(legs, MERGED_SEARCH_FANOUT_CONCURRENCY, probeHostStatus)
  return aggregateHostSearchStatuses(probed.flatMap((status) => (status ? [status] : [])))
}

function aggregateHostSearchStatuses(
  statuses: readonly AiVaultSearchStatus[]
): AiVaultSearchStatus {
  if (statuses.length === 0) {
    return unavailableSessionSearchStatus()
  }
  const contentEnabled = statuses.every((status) => status.contentEnabled !== undefined)
    ? statuses.every((status) => status.contentEnabled === true)
    : undefined
  return {
    enabled: statuses.some((status) => status.enabled),
    ...(contentEnabled === undefined ? {} : { contentEnabled }),
    phase: aggregateHostPhase(statuses),
    filesIndexed: sum(statuses.map((status) => status.filesIndexed)),
    filesDue: sum(statuses.map((status) => status.filesDue)),
    filesFailed: sum(statuses.map((status) => status.filesFailed)),
    degradedRoots: statuses.flatMap((status) => status.degradedRoots),
    lastReconcileAt: newestTime(statuses.map((status) => status.lastReconcileAt)),
    lastSweepCompletedAt: newestTime(statuses.map((status) => status.lastSweepCompletedAt)),
    generation: Math.max(...statuses.map((status) => status.generation))
  }
}

function aggregateHostPhase(
  statuses: readonly AiVaultSearchStatus[]
): AiVaultSearchStatus['phase'] {
  if (statuses.some((status) => status.phase === 'degraded')) {
    return 'degraded'
  }
  if (statuses.some((status) => status.phase === 'indexing')) {
    return 'indexing'
  }
  if (statuses.every((status) => status.phase === 'closed')) {
    return 'closed'
  }
  return statuses.every((status) => status.phase === 'current') ? 'current' : 'idle'
}

function newestTime(values: readonly (number | null)[]): number | null {
  const times = values.filter((value): value is number => value !== null)
  return times.length === 0 ? null : Math.max(...times)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
