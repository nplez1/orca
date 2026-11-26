import { z } from 'zod'
import {
  HOST_MESH_MAX_LABEL_CHARS,
  HOST_MESH_MAX_MEMBERS,
  HOST_MESH_PAYLOAD_VERSION
} from '../host-mesh/host-mesh-contract'

/**
 * Params for the host mesh, both directions.
 *
 * Why these live in the shared contract and not beside the methods: the params catalog indexes this
 * directory, and a schema declared in `src/main` is invisible to it, which makes the method name
 * uncatalogued and fails the params-parity typecheck.
 */

// Base64 is bounded by length only: the crypto layer re-checks canonical form, and duplicating that
// here would refuse payloads it would accept.
const KEY_B64_MAX_CHARS = 128
const NONCE_MAX_CHARS = 128
// A box holds an offer URL plus up to HOST_MESH_MAX_ENDPOINT_CANDIDATES endpoints, so it is the widest field.
const CIPHERTEXT_MAX_CHARS = 16_384
const GROUP_ID_MAX_CHARS = 256

const keyB64 = z.string().min(1).max(KEY_B64_MAX_CHARS)
// Why empty is allowed: the first call a newcomer makes asks which group the member is in, and carries
// no group of its own yet.
const groupId = z.string().max(GROUP_ID_MAX_CHARS)
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

export const HostMeshOfferBackParamsSchema = z
  .object({
    version: z.literal(HOST_MESH_PAYLOAD_VERSION),
    groupId,
    epoch,
    offerer: joinerWithPublicKey,
    sealed: HostMeshSealedOfferSchema
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

/** The local surface an owner CLI or the settings pane drives, as opposed to what a peer calls. */
export const HostMeshLocalSnapshotParamsSchema = z.object({}).strict()

export const HostMeshLocalJoinParamsSchema = z
  .object({ environmentId: z.string().min(1).max(256) })
  .strict()

export const HostMeshLocalRemoveParamsSchema = z
  .object({ hostKey: z.string().min(1).max(KEY_B64_MAX_CHARS) })
  .strict()

export const HostMeshSettingsPatchParamsSchema = z
  .object({ enabled: z.boolean().optional() })
  .strict()
