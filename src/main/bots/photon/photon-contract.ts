// Photon's Beta (2.0) contract, in one place: the endpoint table, the version pin, and a zod schema
// for every shape Orca reads. Beta is a preview and this table is a reading of its docs, not a live
// account, so every response is parsed rather than trusted — an unknown shape is refused and logged,
// never read as an empty one. Keeping it in a single file makes a wrong guess one edit.
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Beta's API root. Provisioning is plain HTTPS; nothing here needs a public inbound endpoint. */
export const PHOTON_API_BASE = 'https://api.photon.codes/v1'

/** Pinned so a contract bump cannot change behaviour under a shipped build; the server serves this
 *  date when the header is omitted. */
export const PHOTON_VERSION = '2026-07-01'
export const PHOTON_VERSION_HEADER = 'Photon-Version'

/** The Socket.IO stream. Session recovery is disabled server-side, so a reconnect must resubscribe. */
export const PHOTON_STREAM_PATH = '/stream'
/** Where the stream connects: the API's own host, since Beta serves both from it. A wrong guess here
 *  is one edit, and the liveness assertion reports it as a stream that never subscribes rather than as
 *  silence. */
export const PHOTON_STREAM_URL = 'https://api.photon.codes'
export const PHOTON_STREAM_EVENTS = {
  subscribe: 'subscribe',
  subscribed: 'subscribed',
  message: 'message',
  error: 'error'
} as const

/** Who a project's stream is read for, so two integrations never overwrite each other's progress. */
export const PHOTON_CONSUMER_PURPOSE = 'orca-bot-inbound'

/** Project slugs: 3-63 lowercase alphanumerics with single separators, immutable and never reusable —
 *  not by an active project and not by a deleted one. */
export const PHOTON_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PHOTON_SLUG_MIN = 3
export const PHOTON_SLUG_MAX = 63

const NonEmpty = z.string().min(1)

export const PhotonProjectSchema = z.object({
  id: NonEmpty,
  slug: NonEmpty,
  name: z.string(),
  organizationId: NonEmpty
})
export type PhotonProject = z.infer<typeof PhotonProjectSchema>

/** The secret comes back only on the mint and on an idempotent replay of it; it is never readable. */
export const PhotonProjectKeySchema = z.object({
  id: NonEmpty,
  secret: NonEmpty
})
export type PhotonProjectKey = z.infer<typeof PhotonProjectKeySchema>

/** An assignment is also the allowlist: only the assigned handle reaches the shared-line stream. */
export const PhotonAssignmentSchema = z.object({
  id: NonEmpty,
  handle: NonEmpty,
  assignedPhoneNumber: NonEmpty
})
export type PhotonAssignment = z.infer<typeof PhotonAssignmentSchema>

export const PhotonAssignmentListSchema = z.object({
  assignments: z.array(PhotonAssignmentSchema)
})

/** The organization's projects, for adopting a slug that is already taken. */
export const PhotonProjectListSchema = z.object({ projects: z.array(PhotonProjectSchema) })

/** Project deletion is asynchronous and irreversible: the slug is burned for every future project. */
export const PHOTON_CLOSURE_STATES = ['closing', 'closed', 'failed'] as const
export const PhotonClosureSchema = z.object({ state: z.enum(PHOTON_CLOSURE_STATES) })
export type PhotonClosure = z.infer<typeof PhotonClosureSchema>

/** Only `closed` is a finished cleanup; `closing` is reported as still closing, never as success. */
export function photonClosureIsTerminal(closure: PhotonClosure): boolean {
  return closure.state !== 'closing'
}

/** A sender, as the stream reports them. The handle is the phone number or Apple-ID email. */
export const PhotonSenderSchema = z.object({
  handle: NonEmpty,
  name: z.string().optional()
})
export type PhotonSender = z.infer<typeof PhotonSenderSchema>

export const PhotonAttachmentSchema = z.object({
  id: NonEmpty,
  url: z.string().url().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional()
})
export type PhotonAttachment = z.infer<typeof PhotonAttachmentSchema>

/** One inbound message. `id` is the dedupe key — replay is not exactly-once, so it is mandatory. */
export const PhotonInboundMessageSchema = z.object({
  id: NonEmpty,
  conversationId: NonEmpty,
  sender: PhotonSenderSchema,
  text: z.string(),
  createdAt: z.number(),
  attachments: z.array(PhotonAttachmentSchema).optional()
})
export type PhotonInboundMessage = z.infer<typeof PhotonInboundMessageSchema>

/** A stream frame. Cursors are opaque non-negative safe integers and may contain gaps, so nothing here
 *  ever computes `seq + 1`. */
export const PhotonStreamFrameSchema = z.object({
  seq: z.number().int().nonnegative().safe(),
  message: PhotonInboundMessageSchema
})
export type PhotonStreamFrame = z.infer<typeof PhotonStreamFrameSchema>

/** `startSeq: 0` is new-events-only, and a positive cursor resumes *after* it. */
export const PHOTON_STREAM_START_NEW = 0

export const PhotonSubscribeAckSchema = z.object({
  projectId: NonEmpty,
  startSeq: z.number().int().nonnegative().safe()
})

/** What a refused frame or response reports, so a wrong shape names itself in the log. */
export class PhotonContractError extends Error {
  constructor(
    readonly what: string,
    readonly detail: string
  ) {
    super(`Photon ${what} did not match the pinned ${PHOTON_VERSION} contract: ${detail}`)
    this.name = 'PhotonContractError'
  }
}

/** Parses `value` as `schema`, or throws a PhotonContractError naming what was being read. */
export function photonParse<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new PhotonContractError(
      what,
      parsed.error.issues.map((issue) => issue.path.join('.') || 'root').join(', ')
    )
  }
  return parsed.data
}

/** The slug a bot's project is created under, from its name: deterministic, so a retried provisioning
 *  finds the existing project instead of creating a second one that costs plan capacity. */
export function photonSlugForBot(botName: string): string {
  const normalised = botName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // A name with no usable characters still needs a legal slug, and a constant one would collide with
  // every other such bot under a name that is immutable and can never be reused. A short digest of the
  // name keeps it deterministic per bot without being the same for two of them.
  const stem = normalised || createHash('sha256').update(botName).digest('hex').slice(0, 8)
  const prefixed = `orca-bot-${stem}`.replace(/-+/g, '-').replace(/-+$/g, '')
  const trimmed = prefixed.slice(0, PHOTON_SLUG_MAX).replace(/-+$/g, '')
  if (trimmed.length >= PHOTON_SLUG_MIN && PHOTON_SLUG_PATTERN.test(trimmed)) {
    return trimmed
  }
  return `orca-bot-${createHash('sha256').update(botName).digest('hex').slice(0, 8)}`
}
