import { z } from 'zod'
import { parsePairingCode } from './pairing'
import { MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from './ssh-types'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import {
  readEphemeralVmLifetime,
  type EphemeralVmLifetimeReadResult
} from './ephemeral-vm-lifetime'
import { ephemeralVmFailure, type EphemeralVmFailure } from './ephemeral-vm-failure-copy'

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const EPHEMERAL_VM_RECIPE_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 256 * 1024,
  nestingDepth: 64
} as const

const SavedPortForwardSchema = z
  .object({
    localPort: z.number().int().min(1).max(65535),
    remoteHost: z.string().min(1),
    remotePort: z.number().int().min(1).max(65535),
    label: z.string().min(1).optional()
  })
  .strict()

export const EphemeralVmRecipeSshTargetSchema = z
  .object({
    label: z.string().min(1),
    configHost: z.string().min(1).optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string(),
    identityFile: z.string().min(1).optional(),
    identityAgent: z.string().min(1).optional(),
    identitiesOnly: z.boolean().optional(),
    proxyCommand: z.string().min(1).optional(),
    jumpHost: z.string().min(1).optional(),
    relayGracePeriodSeconds: z
      .number()
      .int()
      .refine(
        (value) =>
          value === 0 ||
          (value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
            value <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS),
        `Relay grace period must be 0 or between ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS} and ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds.`
      )
      .optional(),
    portForwards: z.array(SavedPortForwardSchema).optional()
  })
  .strict()

const EphemeralVmRecipeOrcaServerConnectionSchema = z
  .object({
    type: z.literal('orca-server'),
    pairingCode: z.string().min(1),
    projectRoot: z.string().min(1)
  })
  .strict()

const EphemeralVmRecipeSshConnectionSchema = z
  .object({
    type: z.literal('ssh'),
    target: EphemeralVmRecipeSshTargetSchema,
    projectRoot: z.string().min(1)
  })
  .strict()

export const EphemeralVmRecipeConnectionSchema = z.discriminatedUnion('type', [
  EphemeralVmRecipeOrcaServerConnectionSchema,
  EphemeralVmRecipeSshConnectionSchema
])

export type EphemeralVmRecipeConnection = z.infer<typeof EphemeralVmRecipeConnectionSchema>

export const EphemeralVmRecipeLegacyResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    pairingCode: z.string().min(1),
    projectRoot: z.string().min(1),
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeConnectionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    connection: EphemeralVmRecipeConnectionSchema,
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeProvisionedRootLegacyResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    checkoutMode: z.literal('provisioned-root'),
    pairingCode: z.string().min(1),
    projectRoot: z.string().min(1),
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeProvisionedRootConnectionResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    checkoutMode: z.literal('provisioned-root'),
    connection: EphemeralVmRecipeConnectionSchema,
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeResultSchema = z.union([
  EphemeralVmRecipeLegacyResultSchema,
  EphemeralVmRecipeConnectionResultSchema,
  EphemeralVmRecipeProvisionedRootLegacyResultSchema,
  EphemeralVmRecipeProvisionedRootConnectionResultSchema
])

export type EphemeralVmRecipeResult = z.infer<typeof EphemeralVmRecipeResultSchema>

export type EphemeralVmRecipeResultParseResult =
  | { ok: true; result: EphemeralVmRecipeResult }
  | ({ ok: false } & EphemeralVmFailure)

export type EphemeralVmRecipeDoctorCheckStatus = 'pass' | 'warn' | 'fail'

export type EphemeralVmRecipeDoctorCheck = {
  id: string
  status: EphemeralVmRecipeDoctorCheckStatus
  message: string
  remediation?: string
}

export type EphemeralVmRecipeDoctorResult = {
  recipeId: string
  repoPath: string
  ok: boolean
  checks: EphemeralVmRecipeDoctorCheck[]
}

export function parseEphemeralVmRecipeResult(stdout: string): EphemeralVmRecipeResultParseResult {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { ok: false, ...ephemeralVmFailure('recipeResultMissing') }
  }
  let parsed: unknown
  try {
    assertJsonTextStructureWithinLimits(trimmed, EPHEMERAL_VM_RECIPE_JSON_STRUCTURE_LIMITS)
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, ...ephemeralVmFailure('recipeResultNotJsonObject') }
  }
  const result = EphemeralVmRecipeResultSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid recipe result.' }
  }
  const connection = getEphemeralVmRecipeResultConnection(result.data)
  if (connection.type === 'orca-server' && !parsePairingCode(connection.pairingCode)) {
    return { ok: false, ...ephemeralVmFailure('recipeResultPairingCodeInvalid') }
  }
  if (!isAbsoluteRuntimePath(connection.projectRoot)) {
    return { ok: false, ...ephemeralVmFailure('recipeResultProjectRootNotAbsolute') }
  }
  // Why a bad deadline is not a parse failure: `create` has already run, so refusing the whole
  // result here would leave a machine the provider is billing for with no record and no cleanup. It
  // is reported as a warning instead (see getEphemeralVmRecipeResultWarnings), so the recipe author
  // still sees a typo while the host itself is tracked and usable.
  return { ok: true, result: result.data }
}

export function getEphemeralVmRecipeResultLifetime(
  result: EphemeralVmRecipeResult
): EphemeralVmLifetimeReadResult {
  return readEphemeralVmLifetime(result.userData)
}

/**
 * Whether replacing `previous` with `next` would lose a release deadline the host already had.
 *
 * Why this is one shared rule: `extend` and `resume` both swap the stored result, and both must
 * refuse an answer whose deadline is missing or unreadable — otherwise a lease the user just paid for
 * keeps no countdown and no reconciliation, and the host can never be reclaimed. `action` names the
 * caller so the refusal reads as the thing the user asked for.
 *
 * Why creating a host is the deliberate exception: by then the provider is already billing, so
 * refusing the result would strand the machine with no record at all.
 */
export function getEphemeralVmLifetimeLossError(
  previous: EphemeralVmRecipeResult,
  next: EphemeralVmRecipeResult,
  action: string
): string | null {
  const previousLifetime = getEphemeralVmRecipeResultLifetime(previous)
  if (!previousLifetime.ok || !previousLifetime.lifetime) {
    return null
  }
  const nextLifetime = getEphemeralVmRecipeResultLifetime(next)
  if (!nextLifetime.ok) {
    return nextLifetime.error
  }
  return nextLifetime.lifetime
    ? null
    : `${action} returned no lifetime metadata, which would have discarded the release deadline.`
}

export function getEphemeralVmRecipeResultConnection(
  result: EphemeralVmRecipeResult
): EphemeralVmRecipeConnection {
  if ('connection' in result) {
    return result.connection
  }
  return {
    type: 'orca-server',
    pairingCode: result.pairingCode,
    projectRoot: result.projectRoot
  }
}

export function getEphemeralVmRecipeResultProjectRoot(result: EphemeralVmRecipeResult): string {
  return getEphemeralVmRecipeResultConnection(result).projectRoot
}

export function getEphemeralVmRecipeResultCheckoutMode(
  result: EphemeralVmRecipeResult
): 'orca-worktree' | 'provisioned-root' {
  return result.schemaVersion === 2 ? 'provisioned-root' : 'orca-worktree'
}

export function getEphemeralVmRecipeResultPairingCode(
  result: EphemeralVmRecipeResult
): string | null {
  const connection = getEphemeralVmRecipeResultConnection(result)
  return connection.type === 'orca-server' ? connection.pairingCode : null
}

export function isAbsoluteRuntimePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
}
