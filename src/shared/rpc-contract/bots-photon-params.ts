// `bots.photon.*`: connecting a Photon account, creating a bot's project, and the two halves of who may
// text it. Settings › Bots drives them, so the methods stay the surface and the card stays a client of
// it. Every method refuses politely when the channel is not connected rather than half-doing the work.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

const Id = lazyZodSchema(() => z.string().min(1).max(256))

/** A phone number, or an Apple-ID email: both are handles the provider assigns a line to. */
export function isPhotonHandle(value: string): boolean {
  const trimmed = value.trim()
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 320 &&
    (trimmed.includes('@') || /^\+?[0-9][0-9 ().-]{4,}$/.test(trimmed))
  )
}

const Handle = lazyZodSchema(() =>
  z
    .string()
    .trim()
    .min(3)
    .max(320)
    .refine(isPhotonHandle, { message: 'Give a phone number or an email address.' })
)

/** Connect once. The account key is stored only when the owner says so; off is the default. */
export const PhotonConnectParams = lazyZodSchema(() =>
  z.object({
    organizationId: Id,
    accountKey: z.string().trim().min(8).max(512),
    storesKey: z.boolean().default(false)
  })
)

/** Create the bot's project, mint its key and give it a number, in one retryable step. `accountKey` is
 *  the per-call alternative to storing the account service key: it is held in memory for the session
 *  and never written unless `bots.photon.connect` was told to keep it. */
export const PhotonCreateBotParams = lazyZodSchema(() =>
  z.object({
    botId: Id,
    handle: Handle,
    accountKey: z.string().trim().min(8).max(512).optional()
  })
)

/** Add someone by creating their assignment, which is the same call that returns their number. */
export const PhotonAddMemberParams = lazyZodSchema(() => z.object({ botId: Id, handle: Handle }))

/** Remove someone by releasing their number. Reversible: adding them again gives it back. */
export const PhotonReleaseMemberParams = lazyZodSchema(() =>
  z.object({ botId: Id, handle: Handle })
)

/** Delete a bot. Releases its numbers and revokes its key; the project stays. */
export const PhotonReleaseBotParams = lazyZodSchema(() => z.object({ botId: Id }))

/** Finish a half-provisioned bot: re-mint a missing key, rebuild the assignment list from the
 *  provider's, and say what was repaired. */
export const PhotonReconcileParams = lazyZodSchema(() => z.object({ botId: Id }))

/** The one irreversible step. `confirmSlug` must name the slug that will be burned. */
export const PhotonDeleteProjectParams = lazyZodSchema(() =>
  z.object({ botId: Id, confirmSlug: Id })
)

/**
 * A bot's channel on a Spectrum project the owner already has: the project id from its dashboard's
 * Settings page (`pho_prj_…`) and that project's own secret. Nothing is created and nothing is assigned
 * — the project, its lines and who may reach them stay in Spectrum — which is why this needs no
 * organization and no account service key.
 */
export const PhotonSpectrumConnectParams = lazyZodSchema(() =>
  z.object({
    botId: Id,
    /** The project's id, not the organization's: a pasted organization id reads as a project that does
     *  not exist rather than as this mistake, which is why the copy names it. Trimmed, because an id
     *  copied out of a dashboard arrives with whitespace around it. */
    projectId: z.string().trim().min(1).max(256),
    projectSecret: z.string().trim().min(8).max(512),
    /** Kept sealed on disk only when the owner says so; off is the default, and off still works for this
     *  session, which is the same choice `bots.photon.connect` offers for the account key. */
    storesSecret: z.boolean().default(false)
  })
)

export const PhotonStatusParams = lazyZodSchema(() => z.object({ botId: Id.optional() }))

export type PhotonConnectInput = z.infer<typeof PhotonConnectParams>
export type PhotonCreateBotInput = z.infer<typeof PhotonCreateBotParams>
export type PhotonAddMemberInput = z.infer<typeof PhotonAddMemberParams>
export type PhotonReleaseMemberInput = z.infer<typeof PhotonReleaseMemberParams>
export type PhotonReleaseBotInput = z.infer<typeof PhotonReleaseBotParams>
export type PhotonDeleteProjectInput = z.infer<typeof PhotonDeleteProjectParams>
export type PhotonSpectrumConnectInput = z.infer<typeof PhotonSpectrumConnectParams>

/** What the channel looks like right now, for a settings card or `orca bot connectors`. */
export type PhotonChannelStatus = {
  connected: boolean
  organizationId: string | null
  /** Whether the account key is stored, which is the owner's choice rather than a default. */
  accountKeyStored: boolean
  /** Whether this host can seal a key it is asked to keep. */
  accountKeySealed: boolean
  bots: {
    botId: string
    /** Which credential the bot's channel runs on: one Orca provisioned with the account key, or the
     *  owner's own Spectrum project. The rest of a row means what it means in that mode. */
    mode: 'account' | 'spectrum'
    /** The project's slug. Null when Spectrum answered a probe without one, which only a bot on an
     *  existing project can be. */
    slug: string | null
    projectId: string
    /** The number this bot last answered on, as the provider reported it. */
    phoneNumber: string | null
    /** The handles that may text it. This list is the allowlist, not a copy of one. */
    handles: string[]
    stream: 'live' | 'deaf' | 'stopped' | 'not started' | 'released'
    /** How far this bot's setup got: `assignment` is the only finished state, because that is where it
     *  has a number. Anything less is a repair, not a channel. */
    completedThrough: 'project' | 'key' | 'assignment' | null
    /** The channel was let go: its numbers and key are gone and its project is all that is left. */
    released: boolean
    /** A bot on the owner's own project whose secret was session-only and is gone after a restart: it reads
     *  nothing until the project is connected again. Always false for an account-provisioned bot, whose
     *  project key is what it reads with. */
    secretMissing: boolean
    /** Messages from handles this bot has no assignment for. Non-zero means the assignment list here
     *  has drifted from the provider's, and `bots.photon.reconcile` is the repair. */
    unknownSenderCount: number
    /** Messages Orca could not deliver and parked. Non-zero means the bot went quiet for a reason the
     *  owner can act on: the thread's chat was deleted or retired, and `lastParkedReason` says which. */
    parkedMessageCount: number
    lastParkedReason: string | null
    /** Answers Orca could not send before the retry horizon passed. Non-zero means someone is owed a
     *  reply that never arrived, which the owner can see rather than infer from silence. */
    undeliveredAnswerCount: number
    lastUndeliveredReason: string | null
  }[]
}
