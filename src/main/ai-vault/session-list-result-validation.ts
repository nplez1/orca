import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../shared/execution-host'

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
      status: z.enum(['running', 'completed', 'failed', 'stopped']).nullable()
    })
    .nullable()
    .default(null)
})

const aiVaultScanIssueSchema = z.object({
  executionHostId: executionHostIdSchema.optional(),
  agent: z.string().min(1),
  // Why (#15036): a `kind` this build has never heard of used to fail the whole
  // issue, which the fallback re-reported as an *unkinded* "invalid entry" — i.e.
  // a newer host's source-level failure came back as a skipped transcript. An
  // unknown kind degrades to 'scope' (its own muted row); absent stays absent.
  kind: z
    .union([z.enum(['host', 'scope', 'notice']), z.string().transform(() => 'scope' as const)])
    .optional(),
  path: z.string(),
  message: z.string()
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
} {
  const sessions: AiVaultSession[] = []
  let malformed = 0
  let wellFormed = 0
  for (const row of rows) {
    const parsed = aiVaultSessionSchema.safeParse(row)
    if (!parsed.success) {
      malformed += 1
      continue
    }
    wellFormed += 1
    if (isAiVaultAgent(parsed.data.agent)) {
      sessions.push({ ...parsed.data, agent: parsed.data.agent })
    }
  }
  return { sessions, malformed, wellFormed }
}

export function parseAiVaultListResult(value: unknown): AiVaultListResult {
  const envelope = aiVaultListResultEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new Error(envelope.error.issues[0]?.message ?? 'unexpected result shape')
  }
  const listed = parseSessions(envelope.data.sessions)
  if (envelope.data.sessions.length > 0 && listed.malformed > 0 && listed.wellFormed === 0) {
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
  const invalidCount = malformedSessionCount + malformedIssueCount
  if (invalidCount > 0) {
    issues.push({
      agent: 'codex',
      path: 'aiVault.listSessions',
      message: `Skipped ${invalidCount} invalid Agent Session History result ${invalidCount === 1 ? 'entry' : 'entries'}.`
    })
  }
  return {
    sessions,
    issues,
    scannedAt: envelope.data.scannedAt,
    ...(envelope.data.fingerprint ? { fingerprint: envelope.data.fingerprint } : {}),
    ...(envelope.data.unchanged ? { unchanged: true as const } : {}),
    ...(envelope.data.hasMore ? { hasMore: true as const } : {}),
    ...(envelope.data.nextOffset !== undefined ? { nextOffset: envelope.data.nextOffset } : {}),
    ...(envelope.data.syncDelta
      ? {
          syncDelta: {
            upserts: deltaUpserts?.sessions ?? [],
            removedIds: envelope.data.syncDelta.removedIds
          }
        }
      : {})
  }
}
