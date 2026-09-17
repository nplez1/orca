import { resolveSessionSearchLimit, SESSION_SEARCH_LIMIT_MAX } from './ai-vault-search-limit'
import { z } from 'zod'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from './ai-vault-types'

export const AiVaultSearchFiltersSchema = z.object({
  agents: z.array(z.enum(AI_VAULT_AGENTS)).optional(),
  scopePaths: z.array(z.string().min(1).max(4096)).max(AI_VAULT_SCOPE_PATHS_MAX_COUNT).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['relevance', 'newest']).optional()
})

// Strip unknown fields so legacy tier/refresh are accepted without affecting the query.
export const AiVaultSearchRequestSchema = z.object({
  query: z.string(),
  scope: z.enum(['conversation', 'all']).optional(),
  freshness: z.enum(['indexed', 'wait-until-current']).optional(),
  limit: z.number().optional().transform(resolveSessionSearchLimit),
  cursor: z.string().optional(),
  filters: AiVaultSearchFiltersSchema.optional(),
  debug: z.boolean().optional()
})

export const AiVaultSearchSourceSchema = z.object({
  presence: z.enum(['present', 'unverifiable', 'missing']),
  filePath: z.string().optional(),
  codexHome: z.string().optional()
})
export const AiVaultSearchEvidenceSchema = z.object({
  snippet: z.string(),
  role: z.enum(['user', 'assistant', 'tool', 'system', 'unknown']),
  timestamp: z.string().nullable()
})
// Older hosts may omit attribution; the desktop stamps remote answers.
const executionHostIdSchema = z.string().min(1)

export const AiVaultSearchHitSchema = z
  .object({
    agent: z.enum(AI_VAULT_AGENTS),
    executionHostId: executionHostIdSchema.optional(),
    sessionId: z.string(),
    title: z.string(),
    cwd: z.string().nullable(),
    branch: z.string().nullable(),
    updatedAt: z.string().nullable(),
    messageCount: z.number().int().nonnegative(),
    score: z.number(),
    source: AiVaultSearchSourceSchema,
    evidence: AiVaultSearchEvidenceSchema.nullable(),
    resumeCommand: z.string().optional()
  })
  .refine((hit) => hit.source.presence === 'present' || hit.resumeCommand === undefined, {
    message: 'Only present sources may have a resume command'
  })
export const AiVaultSearchPageSchema = z.object({
  cursor: z.string().nullable(),
  hasMore: z.boolean()
})
export const AiVaultSearchTruncationSchema = z.object({
  candidates: z.boolean(),
  snippets: z.number().int().nonnegative(),
  query: z.boolean(),
  freshness: z.boolean()
})
// Fixed vocabulary for a merged page. Loss of contact is `unavailable`, never a
// dead/exited verdict, and a raw transport message would carry host paths to a
// client — see docs/reference/ssh-execution-boundary.md.
export const AiVaultSearchHostStatusSchema = z.object({
  executionHostId: z.string().min(1),
  outcome: z.enum(['contributed', 'unavailable', 'error']),
  reason: z
    .enum(['no-service', 'disabled', 'not-ready', 'timeout', 'failed', 'malformed'])
    .optional()
})
const routeSchema = z.enum(['phrase', 'and', 'or', 'typo+phrase', 'typo+and', 'typo+or'])
export const AiVaultSearchPlannerReportSchema = z.object({
  route: routeSchema,
  repairedTerms: z.array(z.string()).optional(),
  scope: z.enum(['conversation', 'all'])
})
export const AiVaultSearchDebugSchema = z.object({
  route: routeSchema,
  repairedTerms: z.array(z.string()).optional(),
  plannerReport: AiVaultSearchPlannerReportSchema
})
export const AiVaultSearchResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('results'),
    hits: z.array(AiVaultSearchHitSchema).max(SESSION_SEARCH_LIMIT_MAX),
    page: AiVaultSearchPageSchema,
    generation: z.number().int().nonnegative(),
    truncated: AiVaultSearchTruncationSchema,
    durationMs: z.number().nonnegative(),
    // Additive and optional (remote-wire rule 1): only an all-hosts merge fills
    // it, and a single-host answer or an older host omits it.
    hosts: z.array(AiVaultSearchHostStatusSchema).optional(),
    debug: AiVaultSearchDebugSchema.optional()
  }),
  z.object({
    kind: z.literal('stale-cursor'),
    generation: z.number().int().nonnegative(),
    expectedGeneration: z.number().int().nonnegative().optional()
  }),
  z.object({ kind: z.literal('malformed-cursor') }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['disabled', 'not-ready', 'no-service'])
  })
])
export const AiVaultSearchStatusRequestSchema = z.object({})
export const AiVaultSearchStatusSchema = z.object({
  enabled: z.boolean(),
  // Additive and optional: a host that predates the metadata/content split
  // reports neither, and a client must not fail its status read over that.
  // Absent means "content search was not consented on that host".
  contentEnabled: z.boolean().optional(),
  phase: z.enum(['idle', 'indexing', 'current', 'degraded', 'closed']),
  filesIndexed: z.number().int().nonnegative(),
  filesDue: z.number().int().nonnegative(),
  filesFailed: z.number().int().nonnegative(),
  // `root` is a host path, withheld over the relay; the array length is the count.
  degradedRoots: z.array(z.object({ root: z.string().optional(), reason: z.string() })),
  lastReconcileAt: z.number().nullable(),
  lastSweepCompletedAt: z.number().nullable(),
  generation: z.number().int().nonnegative()
})
