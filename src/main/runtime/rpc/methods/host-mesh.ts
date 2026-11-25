import { z } from 'zod'
import {
  HOST_MESH_INTRODUCE_METHOD,
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_MAX_LABEL_CHARS,
  HOST_MESH_MAX_MEMBERS,
  HOST_MESH_PAYLOAD_VERSION,
  HOST_MESH_PENDING_METHOD,
  HOST_MESH_RELAY_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_SYNC_METHOD
} from '../../../../shared/host-mesh/host-mesh-contract'
import type {
  HostMeshCaller,
  HostMeshRpcService
} from '../../../host-mesh/host-mesh-driver-contract'
import { hostMeshRpcService } from '../../../host-mesh/host-mesh-runtime'
import { defineMethod, type RpcContext } from '../core'

// Base64 is bounded by length only: the crypto layer re-checks canonical form, and duplicating that
// here would refuse payloads it would accept.
const KEY_B64_MAX_CHARS = 128
const NONCE_MAX_CHARS = 128
// A box holds an offer URL plus up to HOST_MESH_MAX_ENDPOINT_CANDIDATES endpoints, so it is the widest field.
const CIPHERTEXT_MAX_CHARS = 16_384
const GROUP_ID_MAX_CHARS = 256

const keyB64 = z.string().min(1).max(KEY_B64_MAX_CHARS)
const groupId = z.string().min(1).max(GROUP_ID_MAX_CHARS)
const epoch = z.number().int().nonnegative()
const hostLabel = z.string().min(1).max(HOST_MESH_MAX_LABEL_CHARS)
const joiner = z.object({ hostKey: keyB64, label: hostLabel }).strict()
const joinerWithPublicKey = joiner.extend({ publicKeyB64: keyB64 })
const joinerWithOptionalPublicKey = joiner.extend({ publicKeyB64: keyB64.optional() })

export const HostMeshSealedOfferSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    recipientHostKey: keyB64,
    senderHostKey: keyB64,
    nonceB64: z.string().min(1).max(NONCE_MAX_CHARS),
    ciphertextB64: z.string().min(1).max(CIPHERTEXT_MAX_CHARS)
  })
  .strict()

export const HostMeshJoinParamsSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    groupId,
    epoch,
    joiner: joinerWithPublicKey,
    sealedForIntroducer: HostMeshSealedOfferSchema
  })
  .strict()

export const HostMeshRelayParamsSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    groupId,
    epoch,
    joiner: joinerWithOptionalPublicKey,
    // One box per member the joiner still needs, so the batch cannot outgrow the group.
    sealed: z.array(HostMeshSealedOfferSchema).max(HOST_MESH_MAX_MEMBERS)
  })
  .strict()

export const HostMeshIntroduceParamsSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    groupId,
    epoch,
    introducerHostKey: keyB64,
    newcomer: joinerWithOptionalPublicKey,
    sealedForRecipient: HostMeshSealedOfferSchema
  })
  .strict()

export const HostMeshPendingParamsSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    groupId,
    hostKey: keyB64
  })
  .strict()

export const HostMeshRemoveParamsSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    groupId,
    hostKey: keyB64,
    removedBy: keyB64,
    epoch
  })
  .strict()

// The context wins so a test can supply the service; the runtime throws host_mesh_runtime_unavailable
// when nothing configured it, which is an error answer rather than a crash.
function meshService(ctx: RpcContext): HostMeshRpcService {
  return ctx.hostMesh ?? hostMeshRpcService()
}

// The inbound path knows only the paired device and its fingerprint; a member's claimed host key is
// attribution, never the trust anchor (host-mesh-driver-contract.ts HostMeshCaller).
function meshCaller(ctx: RpcContext): HostMeshCaller {
  return { pairedDeviceId: ctx.pairedDeviceId, fingerprint: ctx.authenticatedCallerFingerprint }
}

/**
 * The mesh's six methods, as a member answers them.
 *
 * Why `workspace` for five of them: a caller at `workspace` already runs host-user code, so learning who
 * the group's members are is not a new capability, and every dangerous effect is bounded by a sealed offer
 * only the newcomer's key could have minted. Removal is the exception: it changes who may connect.
 */
export const HOST_MESH_METHODS = [
  defineMethod({
    name: HOST_MESH_JOIN_METHOD,
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
  })
]
