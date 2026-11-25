import {
  HOST_MESH_INTRODUCE_METHOD,
  HOST_MESH_JOIN_METHOD,
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
  HostMeshPendingParamsSchema,
  HostMeshRelayParamsSchema,
  HostMeshRemoveParamsSchema,
  HostMeshSettingsPatchParamsSchema
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

/** Throws rather than answering an empty group, which would read as "you have no members". */
function meshService(ctx: RpcContext): HostMeshRpcService {
  const service = ctx.hostMesh ?? hostMeshRpcServiceIfAvailable()
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
    handler: async (params, ctx) => await meshService(ctx).join(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_RELAY_METHOD,
    permission: 'workspace',
    params: HostMeshRelayParamsSchema,
    handler: async (params, ctx) =>
      await meshService(ctx).relayIntroductions(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_INTRODUCE_METHOD,
    permission: 'workspace',
    params: HostMeshIntroduceParamsSchema,
    handler: async (params, ctx) => await meshService(ctx).introduce(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_PENDING_METHOD,
    permission: 'workspace',
    params: HostMeshPendingParamsSchema,
    handler: async (params, ctx) => await meshService(ctx).pending(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_SYNC_METHOD,
    permission: 'workspace',
    params: HostMeshPendingParamsSchema,
    handler: async (params, ctx) => await meshService(ctx).sync(params, meshCaller(ctx))
  }),
  defineMethod({
    name: HOST_MESH_REMOVE_METHOD,
    // Removal changes who may connect to this host, so it stays administrative.
    permission: 'host-admin',
    params: HostMeshRemoveParamsSchema,
    handler: async (params, ctx) => await meshService(ctx).remove(params, meshCaller(ctx))
  }),
  // The local surface: what an owner's CLI or the settings pane drives, as opposed to what a peer calls.
  // Why these are `host-admin` and not `workspace`: joining, syncing and ejecting change who may reach this
  // machine, and a paired desktop holds neither this tier nor the ability to widen itself.
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
