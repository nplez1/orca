import { HOST_GRAPH_METHODS } from '../runtime/rpc/methods/host-graph'
import { HOST_MESH_METHODS } from '../runtime/rpc/methods/host-mesh'
import { SESSION_SUMMARY_RPC_METHODS } from '../runtime/rpc/methods/session-summary'
import { HOST_SETTINGS_METHODS } from '../runtime/rpc/methods/host-settings'
import { BOT_PHOTON_METHODS } from '../runtime/rpc/methods/bots-photon'

/**
 * This fork's RPC methods, in one array so the upstream registry needs one import and one spread.
 *
 * Why aggregate rather than let each domain register itself: the registry is upstream's list, and every line
 * a fork adds to it is a line a sync has to reconcile. One seam instead of five.
 */
export const FORK_RPC_METHODS = [
  ...HOST_GRAPH_METHODS,
  ...HOST_MESH_METHODS,
  ...SESSION_SUMMARY_RPC_METHODS,
  ...HOST_SETTINGS_METHODS,
  ...BOT_PHOTON_METHODS
]
