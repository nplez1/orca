import { z } from 'zod'
import { parseExecutionHostId } from '../execution-host'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../ai-vault-types'
import { aiVaultHostListQuery } from '../ai-vault-session-filters'
import { OptionalBoolean } from './rpc-param-primitives'
import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../ai-vault-session-title'

// Bound discovery input; scopePaths are host-local match prefixes, never traversal paths.
export const AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096

export const AI_VAULT_LIMIT_MAX = 2000

// Why: an offset the host pages from must stay a row index, not a client-chosen
// cursor that can address a list far past any scan.
export const AI_VAULT_LIST_OFFSET_MAX = 1_000_000

export const executionHostIdSchema = z.string().transform((value, ctx): `runtime:${string}` => {
  const parsed = parseExecutionHostId(value)
  if (parsed?.kind === 'runtime') {
    return parsed.id
  }
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid runtime execution host id'
  })
  return z.NEVER
})

export const AiVaultListSessionsParams = z
  .object({
    limit: z
      .unknown()
      .transform((value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      )
      .pipe(z.union([z.number().int(), z.undefined()]))
      .optional(),
    includeAntigravityIdeSessions: OptionalBoolean,
    unlimited: OptionalBoolean,
    force: OptionalBoolean,
    afterFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    scopePaths: z
      .array(z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH))
      // Clamp to preserve older uncapped clients; scopes only widen discovery.
      .transform((paths) => paths.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT))
      .optional(),
    // Why a transform and not a rejection, like scopePaths: the client and the
    // host both reduce this with `aiVaultHostListQuery`, so an operator query or
    // an oversized one arrives as "no host filter" — the client filters it itself
    // — rather than failing a listing over a refinement the host cannot express.
    query: z
      .string()
      .transform((value) => aiVaultHostListQuery(value))
      .optional(),
    // Why: desktop/web callers name the runtime host they are addressing; mobile
    // omits it. The scan itself is host-local either way, so the id must never
    // change what is scanned — it only restamps the shared cached result.
    executionHostId: executionHostIdSchema.optional(),
    // Why a separate field and not "offset was sent": page 0 must be bounded too,
    // and a client that predates paging must keep receiving one complete reply.
    paged: OptionalBoolean,
    // A client's own held-list fingerprint; only a paging client keeps one to send back.
    syncFromFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    // Why reject rather than coerce: an offset a client cannot follow would silently restart the
    // listing at page 0, and the drain would append the same rows twice.
    offset: z.number().int().min(0).max(AI_VAULT_LIST_OFFSET_MAX).optional()
  })
  .superRefine((params, ctx) => {
    if (params.unlimited !== true && params.limit && params.limit > AI_VAULT_LIMIT_MAX) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: 'Limit exceeds maximum' })
    }
  })

const AiVaultRowResumeParams = z
  .object({
    agent: z.enum(AI_VAULT_AGENTS),
    sessionId: z.string().min(1).max(512).optional(),
    filePath: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH),
    codexHome: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH).nullable(),
    executionHostId: z.string().optional(),
    fork: z.boolean().optional()
  })
  .strict()

export const AiVaultPrepareSessionResumeParams = z.union([
  AiVaultRowResumeParams,
  z
    .object({
      sourceChat: z
        .object({
          sessionId: z.string().min(1).max(512),
          workspaceId: z.string().min(1).max(512)
        })
        .strict(),
      executionHostId: z.string().optional(),
      fork: z.literal(true)
    })
    .strict()
])

export const AiVaultSessionTitlesParams = z.object({
  requests: z
    .array(
      z.object({
        agent: z.enum(['claude', 'codex']),
        sessionId: z.string().min(1).max(512),
        transcriptPath: z.string().min(1).max(32_768).optional()
      })
    )
    .max(AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)
})

// The host revalidates the path against its own roots; no host id travels because the host deletes only its own files.
export const AiVaultDeleteSessionParams = z.object({
  agent: z.enum(AI_VAULT_AGENTS),
  sessionId: z.string().min(1).max(512).optional(),
  filePath: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH)
})
