import type { HostGraphSnapshot } from '../../shared/host-graph/host-graph-snapshot'

export type HostGraphApi = {
  /** The last composed fleet, refreshed when it is older than a minute. */
  read: () => Promise<HostGraphSnapshot>
}
