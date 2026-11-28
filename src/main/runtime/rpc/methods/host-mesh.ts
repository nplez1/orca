import {
  HOST_MESH_INTRODUCE_METHOD,
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_OFFER_BACK_METHOD,
  HOST_MESH_PENDING_METHOD,
  HOST_MESH_RELAY_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_SYNC_METHOD
} from '../../../../shared/host-mesh/host-mesh-contract'
import {
  HostMeshIntroduceParamsSchema,
  HostMeshJoinParamsSchema,
  HostMeshLocalJoinParamsSchema,
  HostMeshLocalRemoveParamsSchema,
  HostMeshLocalSnapshotParamsSchema,
  HostMeshOfferBackParamsSchema,
  HostMeshPendingParamsSchema,
  HostMeshRelayParamsSchema,
  HostMeshRemoveParamsSchema,
  HostMeshSettingsPatchParamsSchema,
  HostMeshSyncParamsSchema
} from '../../../../shared/rpc-contract/host-mesh-params'
import type {
  HostMeshCaller,
  HostMeshRpcService
} from '../../../host-mesh/host-mesh-driver-contract'
import {
  hostMeshRpcServiceIfAvailable,
  joinHostMesh,
  leaveHostMeshGroup,
  readHostMeshSnapshot,
  removeHostMeshMember,
  syncHostMesh,
  updateHostMeshSettings
} from '../../../host-mesh/host-mesh-runtime'
import { defineMethod, type RpcContext } from '../core'

/**
 * The configured service, or a refusal.
 *
 * Why it is resolved here rather than threaded through `RpcContext`: the mesh is one configured singleton for
 * the whole process, so a context field would be a per-call copy of a constant — and it would put this feature
 * into four upstream files (`core`, the admission prologue, the mobile pairing subclass, the stream options)
 * that a fork otherwise need not touch at all.
 */
function meshService(): HostMeshRpcService {
  const service = hostMeshRpcServiceIfAvailable()
  if (!service) {
    throw new Error('host_mesh_runtime_unavailable')
  }
  return service
}

/**
 * Who called, as far as the inbound path knows.
 *
 * Why only these two: there is no environment id or host key on a paired-device request, so a caller's
 * claim to be a particular member is attribution the UI can show and never a trust anchor. What a member
 * can actually cause is bounded by the sealed boxes it carries, and only the newcomer's key can mint one.
 */
function meshCaller(ctx: RpcContext): HostMeshCaller {
  return {
    ...(ctx.pairedDeviceId === undefined ? {} : { pairedDeviceId: ctx.pairedDeviceId }),
    ...(ctx.authenticatedCallerFingerprint === undefined
      ? {}
      : { fingerprint: ctx.authenticatedCallerFingerprint })
  }
}

export const HOST_MESH_METHODS = [
  defineMethod({
    name: HOST_MESH_JOIN_METHOD,
    // A `workspace` caller already runs host-user code, so learning membership is not a new capability;
    // admitting anyone still needs a box only the joining machine's key could have minted.
    permission: 'workspace',
    params: HostMeshJoinParamsSchema,
    handler: async (params, ctx) => await meshService().join(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_RELAY_METHOD,
    permission: 'workspace',
    params: HostMeshRelayParamsSchema,
    handler: async (params, ctx) => await meshService().relayIntroductions(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_INTRODUCE_METHOD,
    permission: 'workspace',
    params: HostMeshIntroduceParamsSchema,
    handler: async (params, ctx) => await meshService().introduce(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_PENDING_METHOD,
    permission: 'workspace',
    params: HostMeshPendingParamsSchema,
    handler: async (params, ctx) => await meshService().pending(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_OFFER_BACK_METHOD,
    // The caller already holds `workspace` here, and the box it hands over is an offer it minted for itself,
    // so this adds no capability to the connection that carries it; this host's Mesh mode is the consent.
    permission: 'workspace',
    params: HostMeshOfferBackParamsSchema,
    handler: async (params, ctx) => await meshService().offerBack(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_SYNC_METHOD,
    permission: 'workspace',
    // Why not `pending`'s schema: a sync publishes where the sender can be dialed, so the narrower strict object
    // refused the only call a pass needs (#492).
    params: HostMeshSyncParamsSchema,
    handler: async (params, ctx) => await meshService().sync(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_REMOVE_METHOD,
    // Removal changes who may connect to this host, so it stays administrative.
    permission: 'host-admin',
    params: HostMeshRemoveParamsSchema,
    handler: async (params, ctx) => await meshService().remove(params, meshCaller(ctx))
  }),
  // The local surface: what an owner's CLI or the settings pane drives, as opposed to what a peer calls.
  // Why `host-admin`: joining, syncing and ejecting change who may reach this machine. Note a paired desktop
  // also holds `host-admin` (rpc-caller-scope.ts RUNTIME_PAIRED_STANDARD), so this tier is not a barrier to
  // it — the barrier is this host's own Mesh mode, which no caller can set and only its owner can turn on.
  defineMethod({
    name: 'hostMesh.snapshot',
    permission: 'workspace',
    params: HostMeshLocalSnapshotParamsSchema,
    handler: () => readHostMeshSnapshot()
  }),
  defineMethod({
    name: 'hostMesh.joinGroup',
    permission: 'host-admin',
    params: HostMeshLocalJoinParamsSchema,
    handler: (params) => joinHostMesh(params.environmentId)
  }),
  defineMethod({
    name: 'hostMesh.syncNow',
    permission: 'host-admin',
    params: HostMeshLocalSnapshotParamsSchema,
    handler: () => syncHostMesh()
  }),
  defineMethod({
    name: 'hostMesh.removeMember',
    permission: 'host-admin',
    params: HostMeshLocalRemoveParamsSchema,
    handler: (params) => removeHostMeshMember(params.hostKey)
  }),
  defineMethod({
    name: 'hostMesh.leaveGroup',
    permission: 'host-admin',
    params: HostMeshLocalSnapshotParamsSchema,
    handler: () => leaveHostMeshGroup()
  }),
  defineMethod({
    name: 'hostMesh.settings',
    permission: 'host-admin',
    params: HostMeshSettingsPatchParamsSchema,
    handler: (params) => updateHostMeshSettings(params)
  })
]
