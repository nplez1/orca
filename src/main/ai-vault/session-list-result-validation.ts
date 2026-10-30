import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_LIST_SKIP_ISSUE_PATH,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultAgent,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'

const aiVaultAgentSet = new Set<string>(AI_VAULT_AGENTS)

export function isAiVaultAgent(agent: string): agent is AiVaultAgent {
  return aiVaultAgentSet.has(agent)
}

const nodePlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
] satisfies NodeJS.Platform[])

const executionHostIdSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeExecutionHostId(value)
  if (normalized) {
    return normalized
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid execution host id' })
  return z.NEVER
})

const sessionPreviewMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
  text: z.string(),
  timestamp: z.string().nullable()
})

const aiVaultSessionSchema = z.object({
  id: z.string(),
  executionHostId: executionHostIdSchema,
  executionHostPlatform: nodePlatformSchema.nullable().optional(),
  agent: z.string().min(1),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  // Malformed aliases must not discard the entire session.
  cwdAliases: z
    .array(z.string().min(1).max(4096))
    .max(AI_VAULT_SCOPE_PATHS_MAX_COUNT)
    .optional()
    .catch(undefined),
  branch: z.string().nullable(),
  model: z.string().nullable(),
  filePath: z.string(),
  codexHome: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  modifiedAt: z.string(),
  messageCount: z.number(),
  totalTokens: z.number(),
  previewMessages: z.array(sessionPreviewMessageSchema),
  previewMessagesTruncated: z.boolean().optional(),
  firstUserPrompt: z.string().nullable().optional(),
  lastUserPrompt: z.string().nullable().optional(),
  queuedMessageCount: z.number().default(0),
  subagentTranscriptCount: z.number().default(0),
  resumeCommand: z.string(),
  structuredSession: z
    .object({
      sessionId: z.string().min(1).max(512),
      workspaceId: z.string().min(1).max(512)
    })
    .optional(),
  subagent: z
    .object({
      parentSessionId: z.string(),
      agentType: z.string().nullable(),
      status: z.enum(['running', 'completed', 'failed', 'stopped']).nullable(),
      // Why optional: only a link recorded by a scan-side marker crosses agents, and an older
      // peer answering this list has no such field.
      parentAgent: z.string().min(1).max(64).optional()
    })
    .nullable()
    .default(null)
})

const aiVaultScanIssueSchema = z.object({
  executionHostId: executionHostIdSchema.optional(),
  agent: z.string().min(1),
  // Future issue kinds degrade to scope banners; preserve absent kinds for skipped-transcript rows (#15036).
  kind: z
    .union([z.enum(['host', 'scope', 'notice']), z.string().transform(() => 'scope' as const)])
    .optional(),
  path: z.string(),
  message: z.string(),
  // Optional localization hints; malformed ones fall back to the English message.
  messageCode: z.string().optional().catch(undefined),
  messageParams: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .catch(undefined),
  messageDetail: z.string().optional().catch(undefined)
})

const aiVaultListResultEnvelopeSchema = z
  .object({
    sessions: z.array(z.unknown()),
    issues: z.array(z.unknown()),
    scannedAt: z.string(),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    unchanged: z.literal(true).optional(),
    // A bounded page: `hasMore` without a cursor to ask for can never make progress.
    hasMore: z.literal(true).optional(),
    nextOffset: z.number().int().min(1).optional(),
    // Why catch: a token is a consistency hint, so a longer one from a later host drops the hint
    // instead of failing the listing.
    listToken: z.string().max(128).optional().catch(undefined),
    syncDelta: z
      .object({ upserts: z.array(z.unknown()), removedIds: z.array(z.string()) })
      .optional()
  })
  .refine(
    (value) =>
      !value.unchanged ||
      (value.fingerprint !== undefined && value.sessions.length === 0 && value.issues.length === 0),
    'Invalid unchanged response'
  )
  .refine((value) => !value.hasMore || value.nextOffset !== undefined, 'Invalid paged response')
  .refine(
    (value) => !value.syncDelta || (value.sessions.length === 0 && value.hasMore === undefined),
    'Invalid session delta response'
  )

function parseSessions(rows: readonly unknown[]): {
  sessions: AiVaultSession[]
  malformed: number
  wellFormed: number
  /** Rows this build cannot represent, by the id they named; a delta has to drop them. */
  rejectedIds: string[]
} {
  const sessions: AiVaultSession[] = []
  const rejectedIds: string[] = []
  let malformed = 0
  let wellFormed = 0
  for (const row of rows) {
    const parsed = aiVaultSessionSchema.safeParse(row)
    if (!parsed.success) {
      malformed += 1
      const rejectedId = namedRowId(row)
      if (rejectedId !== null) {
        rejectedIds.push(rejectedId)
      }
      continue
    }
    wellFormed += 1
    if (isAiVaultAgent(parsed.data.agent)) {
      sessions.push({ ...parsed.data, agent: parsed.data.agent })
    }
  }
  return { sessions, malformed, wellFormed, rejectedIds }
}

const namedRowIdSchema = z.object({ id: z.string().min(1) })

/** The id an unreadable row still names, so a delta can drop it from the list it holds. */
function namedRowId(row: unknown): string | null {
  const parsed = namedRowIdSchema.safeParse(row)
  return parsed.success ? parsed.data.id : null
}

export function parseAiVaultListResult(
  value: unknown,
  options: { offset?: number } = {}
): AiVaultListResult {
  const envelope = aiVaultListResultEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new Error(envelope.error.issues[0]?.message ?? 'unexpected result shape')
  }
  const listed = parseSessions(envelope.data.sessions)
  // Why not for a paged read: a page whose rows all use a field this build does not know is
  // version skew, not a broken reply, and throwing would lose every page after it (the old single
  // reply showed the readable rows with a skip notice). The envelope schema still refuses a reply
  // of the wrong shape, which is what this check was for.
  if (
    options.offset === undefined &&
    envelope.data.sessions.length > 0 &&
    listed.malformed > 0 &&
    listed.wellFormed === 0
  ) {
    throw new Error('all supplied Agent Session History sessions were invalid')
  }
  const sessions = listed.sessions
  // A delta's rows are the same rows; one malformed row must not discard the rest of the change.
  const deltaUpserts = envelope.data.syncDelta
    ? parseSessions(envelope.data.syncDelta.upserts)
    : null
  const malformedSessionCount = listed.malformed + (deltaUpserts?.malformed ?? 0)
  const issues: AiVaultScanIssue[] = []
  let malformedIssueCount = 0
  for (const issue of envelope.data.issues) {
    const parsed = aiVaultScanIssueSchema.safeParse(issue)
    if (!parsed.success) {
      malformedIssueCount += 1
      continue
    }
    if (!isAiVaultAgent(parsed.data.agent)) {
      continue
    }
    issues.push({ ...parsed.data, agent: parsed.data.agent })
  }
  // Why drop the fingerprint only here: a rejected diff row that named no id cannot be removed from
  // the list this client holds, so that body would no longer match its fingerprint. A row this
  // build cannot read at all keeps it — the body still is the host's list minus rows this build
  // cannot show, an `unchanged` reply can still be honoured, and the skip row says so on every full
  // read. What such a body is *not* good for is a diff: see `hostLegSyncBasis`.
  const deltaHidItsId = (deltaUpserts?.malformed ?? 0) > (deltaUpserts?.rejectedIds.length ?? 0)
  const fingerprint =
    envelope.data.fingerprint && !deltaHidItsId ? envelope.data.fingerprint : undefined
  const invalidCount = malformedSessionCount + malformedIssueCount
  if (invalidCount > 0) {
    issues.push({
      agent: 'codex',
      path: AI_VAULT_LIST_SKIP_ISSUE_PATH,
      // The drain re-counts these across pages, so the wording is a contract with that reader.
      ...aiVaultScanIssueText('invalidResultsSkipped', {
        params: { count: invalidCount }
      })
    })
  }
  return {
    sessions,
    issues,
    scannedAt: envelope.data.scannedAt,
    ...(fingerprint ? { fingerprint } : {}),
    ...(envelope.data.unchanged ? { unchanged: true as const } : {}),
    ...(envelope.data.hasMore ? { hasMore: true as const } : {}),
    ...(envelope.data.nextOffset !== undefined ? { nextOffset: envelope.data.nextOffset } : {}),
    ...(envelope.data.listToken ? { listToken: envelope.data.listToken } : {}),
    ...(envelope.data.syncDelta
      ? {
          syncDelta: {
            upserts: deltaUpserts?.sessions ?? [],
            // Why also the rejected upsert ids: the change cannot be applied, so keeping the row
            // this client already holds would show stale data under the new fingerprint, and the
            // host would never send it again.
            removedIds: [
              ...envelope.data.syncDelta.removedIds,
              ...(deltaUpserts?.rejectedIds ?? [])
            ]
          }
        }
      : {})
  }
}
