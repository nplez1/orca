import { HOST_GRAPH_METHODS } from '../runtime/rpc/methods/host-graph'
import { HOST_MESH_METHODS } from '../runtime/rpc/methods/host-mesh'

/**
 * This fork's RPC methods, in one array so the upstream registry needs one import and one spread.
 *
 * Why aggregate rather than let each domain register itself: the registry is upstream's list, and every line
 * a fork adds to it is a line a sync has to reconcile. One seam instead of two.
 */
export const FORK_RPC_METHODS = [...HOST_GRAPH_METHODS, ...HOST_MESH_METHODS]
