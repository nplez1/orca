// What the channel keeps on disk, as one schema file: the bot records a saga finishes, and the account
// settings beside them. Split from the store so the store is about reading and writing, not about shapes.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'

const PhotonAssignmentRecord = lazyZodSchema(() =>
  z.object({
    assignmentId: z.string().min(1),
    handle: z.string().min(1),
    phoneNumber: z.string().min(1)
  })
)
export type PhotonAssignmentRecord = z.infer<typeof PhotonAssignmentRecord>

/** How far a bot's provisioning got, so the reconciler knows what to read back and finish. */
export const PHOTON_SAGA_STEPS = ['project', 'key', 'assignment'] as const
export type PhotonSagaStep = (typeof PHOTON_SAGA_STEPS)[number]

const PhotonBotRecord = lazyZodSchema(() =>
  z.object({
    botId: z.string().min(1),
    projectId: z.string().min(1),
    /** The slug the project was created under. Stored, never re-derived: it is immutable upstream. */
    slug: z.string().min(1),
    organizationId: z.string().min(1),
    /** The last step that finished; absent while the first is still running. */
    completedThrough: z.enum(PHOTON_SAGA_STEPS).optional(),
    /** The key's id, so it can be revoked; the secret is sealed, never here. */
    keyId: z.string().min(1).optional(),
    /** The number this bot last answered on, as the provider reported it rather than as anyone typed it. */
    phoneNumber: z.string().min(1).optional(),
    /** The owner's handle as the provider normalised it, so the assignment list can say which entry is
     *  the owner without a second list: the assignments *are* the allowlist. */
    ownerHandle: z.string().min(1).optional(),
    assignments: z.array(PhotonAssignmentRecord).default([]),
    /** How many generations of replacement key this bot has been through, so each mint's idempotency key
     *  is distinct and a lost response cannot leave an orphan that is never revoked. */
    keyGeneration: z.number().int().nonnegative().default(0),
    /** Set when Orca let the bot go: the numbers and key are released, and the project is kept. The
     *  record stays so the project can still be deleted later — that is the only thing left to do with
     *  it, and the slug is the confirmation. */
    released: z.boolean().default(false),
    releasedAt: z.number().optional(),
    /** Messages from a handle that is not assigned here. Non-zero means Orca's mirror of the provider's
     *  allowlist is stale, which is a thing to repair rather than a sender to ignore silently. */
    unknownSenderCount: z.number().int().nonnegative().default(0),
    /** Messages Orca could not deliver and parked, so a listing can say so instead of the bot simply going
     *  quiet. The messages themselves stay in the inbox, with the reason. */
    parkedMessageCount: z.number().int().nonnegative().default(0),
    /** Why the most recent message was parked, for that listing. */
    lastParkedReason: z.string().optional(),
    /** Answers Orca could not send before the retry horizon passed. Non-zero means someone is owed a
     *  reply that never arrived, which the owner can see rather than infer from silence. */
    undeliveredAnswerCount: z.number().int().nonnegative().default(0),
    lastUndeliveredReason: z.string().optional(),
    createdAt: z.number()
  })
)
export type PhotonBotRecord = z.infer<typeof PhotonBotRecord>

const PhotonAccount = lazyZodSchema(() =>
  z.object({
    organizationId: z.string().min(1),
    /** Whether the owner chose to persist the account key. Off is the default, so a fresh install keeps
     *  nothing it was not asked to keep; the key still lives in memory for the rest of the session. */
    storesKey: z.boolean().default(false)
  })
)

export const StoredRecord = lazyZodSchema(() =>
  z.object({
    account: PhotonAccount.optional(),
    bots: z.array(PhotonBotRecord).default([])
  })
)
export type StoredRecord = z.infer<typeof StoredRecord>

/** A secret as written: sealed through the host's secret store when one can seal, else plain base64
 *  with a warning, which is the same degradation the bot tool credentials make explicit. */
const SealedSecret = lazyZodSchema(() => z.string().min(1))

export const StoredSecrets = lazyZodSchema(() =>
  z.object({
    accountKey: SealedSecret.optional(),
    /** Per bot, keyed by bot id: only its own project key, never another bot's. */
    projectKeys: z
      .record(z.string(), z.object({ keyId: z.string().min(1), secret: SealedSecret }))
      .default({})
  })
)
export type StoredSecrets = z.infer<typeof StoredSecrets>

export const emptyRecord = (): StoredRecord => ({ bots: [] })
export const emptySecrets = (): StoredSecrets => ({ projectKeys: {} })

export type PhotonAccountSettings = z.infer<typeof PhotonAccount>

/** What a caller may hand back after provisioning: the record fields, minus the ones only the store
 *  sets. Taken from the schema's *input* type, so a caller need not repeat the defaults. */
export type PhotonBotRecordInput = Omit<z.input<typeof PhotonBotRecord>, 'createdAt'> & {
  createdAt?: number
}
