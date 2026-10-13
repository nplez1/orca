import { z } from 'zod'

/**
 * Provider-enforced lease metadata for an ephemeral host.
 *
 * A recipe is free to publish anything it likes in its result `userData`; these four
 * keys are the ones Orca understands. Everything provider-specific stays in the script.
 */

export const EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS = {
  provider: 'provider',
  resourceId: 'resourceId',
  releaseAt: 'releaseAt',
  lifetimeSeconds: 'lifetimeSeconds'
} as const

/**
 * Bounds for a recipe's declared `extendDurations`.
 *
 * Why a floor: an extension under a minute is always a typo, and the recipe script would
 * spend longer running than the lease it bought. Why a ceiling: past a month the provider's
 * own TTL is not meaningfully different from "no deadline", and Orca would render a countdown
 * nobody can act on.
 */
export const EPHEMERAL_VM_LIFETIME_DURATION_LIMITS = {
  minSeconds: 60,
  maxSeconds: 30 * 24 * 60 * 60,
  maxDurations: 8
} as const

const DURATION_UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const
const DURATION_PATTERN = /^(\d{1,6})([smhd])$/i

type DurationUnit = keyof typeof DURATION_UNIT_SECONDS

/** Narrowing rather than asserting: the pattern above already guarantees one of these. */
function isDurationUnit(value: string): value is DurationUnit {
  return value === 's' || value === 'm' || value === 'h' || value === 'd'
}

/**
 * The coarse `12m` / `3h` / `2d` form used wherever a lease is summarised.
 *
 * Floored, so it never overstates how long is left — an over-generous label would make a
 * user miss the deadline it exists to warn about.
 */
export function formatEphemeralVmRemaining(remainingMs: number): string {
  const minutes = Math.max(0, Math.floor(remainingMs / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

/** The ticking `mm:ss` / `h:mm:ss` form, for a countdown the user watches. */
export function formatEphemeralVmCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1_000))
  const pad = (value: number): string => value.toString().padStart(2, '0')
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor(totalSeconds / 60) % 60
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** Seconds for a `<count><unit>` duration such as `30m`, `4h`, or `2d`; null when unusable. */
export function parseEphemeralVmLifetimeDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim())
  if (!match) {
    return null
  }
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  if (!isDurationUnit(unit)) {
    return null
  }
  const seconds = amount * DURATION_UNIT_SECONDS[unit]
  if (seconds < EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.minSeconds) {
    return null
  }
  return seconds > EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.maxSeconds ? null : seconds
}

/** Canonical `<count><unit>` spelling — the largest unit that divides evenly. */
export function formatEphemeralVmLifetimeDuration(seconds: number): string {
  for (const unit of ['d', 'h', 'm'] as const) {
    const unitSeconds = DURATION_UNIT_SECONDS[unit]
    if (seconds % unitSeconds === 0 && seconds >= unitSeconds) {
      return `${seconds / unitSeconds}${unit}`
    }
  }
  return `${seconds}s`
}

/** Canonical spelling of a declared duration, or null when it is not a usable duration. */
export function normalizeEphemeralVmLifetimeDuration(value: string): string | null {
  const seconds = parseEphemeralVmLifetimeDuration(value)
  return seconds === null ? null : formatEphemeralVmLifetimeDuration(seconds)
}

export type EphemeralVmLifetime = {
  /** Opaque to Orca; carried only so the UI can name the provider. */
  provider?: string
  /** Opaque to Orca; passed back to the recipe untouched. */
  resourceId?: string
  /** The provider's absolute deadline, exactly as reported. */
  releaseAt: string
  /** `releaseAt` as epoch milliseconds, for countdown arithmetic. */
  releaseAtMs: number
  /**
   * Lease length the provider reported. Context only — a provider may report the original
   * length or the remaining length, so it must never substitute for the absolute deadline.
   */
  lifetimeSeconds?: number
}

export type EphemeralVmLifetimeReadResult =
  | { ok: true; lifetime: EphemeralVmLifetime | null }
  | { ok: false; error: string }

const OpaqueIdentifierSchema = z.union([z.string().min(1), z.number().finite()])

const EphemeralVmLifetimeSchema = z.object({
  provider: OpaqueIdentifierSchema.optional(),
  resourceId: OpaqueIdentifierSchema.optional(),
  releaseAt: z.iso.datetime({ offset: true }),
  lifetimeSeconds: z.number().int().positive().optional()
})

function toOpaqueIdentifier(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value)
}

function describeLifetimeIssue(issue: z.core.$ZodIssue | undefined): string {
  const field = issue?.path.join('.') ?? EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS.releaseAt
  const key = `userData.${field}`
  if (field === EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS.releaseAt) {
    return `${key} must be an RFC 3339 timestamp with an offset, such as 2026-10-13T03:26:41Z.`
  }
  if (field === EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS.lifetimeSeconds) {
    return `${key} must be a positive whole number of seconds.`
  }
  return `${key} must be a non-empty string or a finite number.`
}

/**
 * Read the well-known lease metadata out of a recipe result's `userData`.
 *
 * Why `releaseAt` alone decides whether this is a lifetime: `provider` is a common key for a
 * recipe to set for unrelated reasons, so treating its presence as a lifetime declaration
 * would break recipes that predate this contract. Only a declared `releaseAt` opts a recipe
 * in, and only then are its sibling fields validated.
 */
export function readEphemeralVmLifetime(userData: unknown): EphemeralVmLifetimeReadResult {
  if (typeof userData !== 'object' || userData === null || Array.isArray(userData)) {
    return { ok: true, lifetime: null }
  }
  if (!Object.hasOwn(userData, EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS.releaseAt)) {
    return { ok: true, lifetime: null }
  }
  const parsed = EphemeralVmLifetimeSchema.safeParse(userData)
  if (!parsed.success) {
    return { ok: false, error: describeLifetimeIssue(parsed.error.issues[0]) }
  }
  const releaseAtMs = Date.parse(parsed.data.releaseAt)
  if (!Number.isFinite(releaseAtMs)) {
    return { ok: false, error: describeLifetimeIssue(undefined) }
  }
  const provider = toOpaqueIdentifier(parsed.data.provider)
  const resourceId = toOpaqueIdentifier(parsed.data.resourceId)
  return {
    ok: true,
    lifetime: {
      releaseAt: parsed.data.releaseAt,
      releaseAtMs,
      ...(provider === undefined ? {} : { provider }),
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(parsed.data.lifetimeSeconds === undefined
        ? {}
        : { lifetimeSeconds: parsed.data.lifetimeSeconds })
    }
  }
}

export function getEphemeralVmRemainingMs(lifetime: EphemeralVmLifetime, nowMs: number): number {
  return lifetime.releaseAtMs - nowMs
}

export function isEphemeralVmLifetimeExpired(
  lifetime: EphemeralVmLifetime,
  nowMs: number
): boolean {
  return getEphemeralVmRemainingMs(lifetime, nowMs) <= 0
}
