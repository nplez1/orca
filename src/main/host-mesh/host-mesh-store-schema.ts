import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  DEFAULT_HOST_MESH_SETTINGS,
  type HostMeshSettings
} from '../../shared/host-mesh/host-mesh-admission'
import { HOST_MESH_MAX_ENDPOINT_CANDIDATES } from '../../shared/host-mesh/host-mesh-contract'

/**
 * The file's shape, kept apart from the store that reads and writes it.
 *
 * Why its own module: every schema here is a compatibility promise to a build that wrote the file, and reading them
 * without the I/O around them is how that promise is checked.
 */

export const memberSchema = lazyZodSchema(() =>
  z.looseObject({
    hostKey: z.string().min(1),
    label: z.string(),
    introducedBy: z.string().min(1).optional(),
    addedAtEpoch: z.number()
  })
)

export const tombstoneSchema = lazyZodSchema(() =>
  z.looseObject({
    hostKey: z.string().min(1),
    epoch: z.number(),
    removedBy: z.string().min(1)
  })
)

// A version per name: the group's word for a machine changes by rename, and two owners must converge.
export const nameSchema = lazyZodSchema(() =>
  z.looseObject({ label: z.string().min(1), version: z.number() })
)

export const outboundLinkSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.looseObject({ kind: z.literal('ok') }),
    z.looseObject({
      kind: z.literal('awaitingOffer'),
      requestedAtEpoch: z.number(),
      expiresAt: z.number()
    }),
    z.looseObject({
      kind: z.literal('redeemFailed'),
      reason: z.string(),
      attempts: z.number(),
      retryAt: z.number()
    }),
    z.looseObject({ kind: z.literal('unreachable'), since: z.number() }),
    // A peer on a build that predates the group answers `method_not_found`, which is a state worth keeping:
    // it is what stops the repair minting offers at a machine that cannot redeem them.
    z.looseObject({ kind: z.literal('unsupported'), since: z.number() })
  ])
)

export const inboundLinkSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.looseObject({ kind: z.literal('active') }),
    z.looseObject({ kind: z.literal('awaitingRedeem'), expiresAt: z.number() }),
    z.looseObject({ kind: z.literal('absent') })
  ])
)

export const stateSchema = lazyZodSchema(() =>
  z.looseObject({
    groupId: z.string(),
    epoch: z.number(),
    selfKey: z.string().min(1),
    members: z.array(memberSchema),
    tombstones: z.array(tombstoneSchema),
    links: z.looseObject({
      outbound: z.record(z.string().min(1), outboundLinkSchema),
      inbound: z.record(z.string().min(1), inboundLinkSchema)
    }),
    names: z.record(z.string().min(1), nameSchema).default({}),
    // A file written before routes existed has none, and an empty map is the right "nothing learned yet".
    // Why trimmed rather than bounded: a value past the cap is a build that raised it, and refusing the whole state
    // would make one long array cost this host its group — the extra entries are only ever guesses.
    routes: z
      .record(
        z.string().min(1),
        z
          .array(z.string())
          .transform((endpoints) => endpoints.slice(0, HOST_MESH_MAX_ENDPOINT_CANDIDATES))
      )
      .default({})
  })
)

export const peerEntrySchema = lazyZodSchema(() =>
  z.looseObject({
    deviceRowIds: z.array(z.string().min(1)),
    environmentId: z.string().min(1).nullable(),
    // The name a redemption wrote into this host's pairing row, so a later pass can tell an invented word from one
    // the owner typed.
    // Why no length cap here: this host writes a name it already suffixed (`Mac mini (2)`) or one an owner typed, so a
    // cap would reject a value of its own making and drop the entry — losing the device rows removal needs.
    redeemedLabel: z.string().nullable().optional()
  })
)

/** Partial on purpose: a build that adds a rule leaves this one's booleans at their defaults. */
export const settingsSchema = lazyZodSchema(() =>
  z.looseObject({
    enabled: z.boolean()
  })
)

export type HostMeshMigrationRecord = {
  version: number
  appliedAt: number
  /** Machines the group was created from; 0 records that this install had none to group. */
  peerCount: number
}

export type HostMeshPeerIndexEntry = {
  deviceRowIds: readonly string[]
  environmentId: string | null
  /** Set when this host named the pairing itself; absent when the owner did. */
  redeemedLabel?: string | null
}

/**
 * `peerIndex` values are held as `unknown` so an entry a newer build wrote is carried back out verbatim:
 * this build cannot parse it, and deleting it would forget the device rows removal has to delete.
 */
export const storedFileSchema = lazyZodSchema(() =>
  z.looseObject({
    version: z.literal(1),
    state: z.unknown(),
    peerIndex: z.record(z.string().min(1), z.unknown()).default({}),
    /** Boxes a member asked this host to hold for a newcomer, keyed by the machine they are addressed to. */
    pendingBoxes: z.record(z.string().min(1), z.array(z.unknown())).default({}),
    /** Admission timestamps per group, kept so the introduction limit survives a restart. */
    admissions: z.record(z.string().min(1), z.array(z.number())).default({}),
    /** Box nonces already redeemed, with when, so a replay fails rather than joining twice. */
    spentNonces: z.record(z.string().min(1), z.number()).default({}),
    /** The group's own admission rules, which belong with the group rather than with this install's settings. */
    settings: z.unknown().default(null),
    /** What an upgrade found and grouped, so the panel can say where this group came from. */
    migration: z.unknown().default(null)
  })
)
export type StoredFile = z.infer<typeof storedFileSchema>

export const emptyFile = (): StoredFile => ({
  version: 1,
  state: null,
  peerIndex: {},
  pendingBoxes: {},
  admissions: {},
  spentNonces: {},
  migration: null,
  settings: null
})

/** A value this build cannot read is the defaults, not a refusal: the rules decide who joins, not the file. */
export function settingsFrom(raw: unknown): HostMeshSettings {
  const parsed = settingsSchema.partial().safeParse(raw)
  return parsed.success
    ? { ...DEFAULT_HOST_MESH_SETTINGS, ...parsed.data }
    : { ...DEFAULT_HOST_MESH_SETTINGS }
}
