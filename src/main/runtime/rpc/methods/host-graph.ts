import type { z } from 'zod'
import {
  HOST_GRAPH_EXCHANGE_METHOD,
  HOST_GRAPH_PAYLOAD_VERSION,
  type HostGraphAdjacency,
  type HostGraphExchangeResult
} from '../../../../shared/host-graph/host-graph-contract'
import { HostGraphExchangeParams } from '../../../../shared/rpc-contract/host-graph-params'
import { hostGraphAnswerRevision } from '../../../../shared/host-graph/host-graph-compose'
import {
  getHostGraphHeardReports,
  type HostGraphHeardReports
} from '../../../host-graph/host-graph-heard-reports'
import { readLocalAdjacency } from '../../../host-graph/host-graph-local-adjacency'
import { defineMethod } from '../core'

type ParsedAdjacency = NonNullable<z.infer<typeof HostGraphExchangeParams>['self']>

// Why the shared instance: a host that is only ever called learns the fleet from these reports, so the
// driver that composes its own status bar has to read the same store this method writes.
const heardReports: HostGraphHeardReports = getHostGraphHeardReports()

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
      // Why excluded: a caller already holds its own adjacency, so echoing it back is payload it
      // cannot use and would have to filter.
      const heard = heardReports
        .list({ now: Date.now() })
        .filter((report) => report.reportedBy !== callerFingerprint)
      // Why the answer's revision and not the adjacency's: a new caller appearing here changes what
      // the next caller is told, while this host's own pairings have not moved.
      const revision = hostGraphAnswerRevision(own, heard)
      if (params.knownRevision === revision) {
        return { unchanged: true }
      }
      return { adjacency: own, heard, revision }
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
