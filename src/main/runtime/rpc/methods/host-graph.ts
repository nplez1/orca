import type { z } from 'zod'
import {
  HOST_GRAPH_EXCHANGE_METHOD,
  HOST_GRAPH_PAYLOAD_VERSION,
  type HostGraphAdjacency,
  type HostGraphExchangeResult
} from '../../../../shared/host-graph/host-graph-contract'
import { HostGraphExchangeParams } from '../../../../shared/rpc-contract/host-graph-params'
import {
  createHostGraphHeardReports,
  type HostGraphHeardReports
} from '../../../host-graph/host-graph-heard-reports'
import { readLocalAdjacency } from '../../../host-graph/host-graph-local-adjacency'
import { defineMethod } from '../core'

type ParsedAdjacency = NonNullable<z.infer<typeof HostGraphExchangeParams>['self']>

// Why one process-wide store: what a caller reported is what the next caller is told, so a per-request
// instance would answer with an empty fleet every time.
const heardReports: HostGraphHeardReports = createHostGraphHeardReports()

/**
 * The host-graph exchange, as a paired host answers it.
 *
 * Why `workspace`: describing which machines this one is paired with is the same act as running a
 * command here, and a paired desktop already holds it. `accounts-admin` would refuse the desktop that
 * is the only caller this is for. A phone is refused by the mobile allowlist, not by this permission.
 */
export const HOST_GRAPH_METHODS = [
  defineMethod({
    name: HOST_GRAPH_EXCHANGE_METHOD,
    permission: 'workspace',
    params: HostGraphExchangeParams,
    handler: async (params, ctx): Promise<HostGraphExchangeResult> => {
      const callerFingerprint = ctx.authenticatedCallerFingerprint
      const reported = params.self ? ownPayloadOf(params.self) : null
      if (reported && callerFingerprint !== undefined) {
        heardReports.record({
          callerFingerprint,
          adjacency: reported,
          receivedAt: Date.now()
        })
      }
      const own = await readLocalAdjacency()
      if (params.knownRevision === own.revision) {
        return { unchanged: true }
      }
      // Why excluded: a caller already holds its own adjacency, so echoing it back is payload it
      // cannot use and would have to filter.
      return {
        adjacency: own,
        heard: heardReports
          .list({ now: Date.now() })
          .filter((report) => report.reportedBy !== callerFingerprint)
      }
    }
  })
]

/**
 * Why rebuilt rather than spread: the parsed payload types `version` as a number, and storing a
 * version this build does not speak would put another host's payload into an answer unchanged.
 */
function ownPayloadOf(parsed: ParsedAdjacency): HostGraphAdjacency | null {
  if (parsed.version !== HOST_GRAPH_PAYLOAD_VERSION) {
    return null
  }
  return { ...parsed, version: HOST_GRAPH_PAYLOAD_VERSION }
}
