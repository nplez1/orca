import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { sortAiVaultSessionsByRecency } from '../../shared/ai-vault-session-sort'
import { dedupeScannedSessions } from './session-root-dedup'
import type { AiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import {
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult
} from '../../shared/ai-vault-session-depth'

export function aiVaultScanIssueResult({
  executionHostId,
  path,
  ...text
}: {
  executionHostId?: ExecutionHostId
  path: string
} & AiVaultScanIssueText): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        ...(executionHostId ? { executionHostId } : {}),
        agent: 'codex',
        kind: 'host',
        path,
        ...text
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

// Cancelled scans keep the existing list instead of repainting with this empty body.
export function cancelledAiVaultListResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: new Date().toISOString(), cancelled: true }
}

// Restamp the shared host-local cache for runtime callers, preserving the scanner's session-ID recipe.
export function restampAiVaultListResult(
  result: AiVaultListResult,
  executionHostId: ExecutionHostId
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) =>
      session.executionHostId === executionHostId
        ? session
        : {
            ...session,
            executionHostId,
            id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
          }
    ),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt
  }
}

export function mergeAiVaultListResults(
  results: readonly AiVaultListResult[],
  rawLimit: number | undefined,
  unlimited = false,
  scopePaths: readonly string[] = []
): AiVaultListResult {
  const depth = requestedAiVaultSessionDepth({ limit: rawLimit, unlimited })
  const byId = new Map<string, AiVaultSession>()
  const issues: AiVaultScanIssue[] = []
  for (const result of results) {
    for (const session of result.sessions) {
      byId.set(session.id, session)
    }
    issues.push(...result.issues)
  }
  // A scope path is a guarantee every leg already honoured, so the cap must not be
  // the one place that drops its own sessions: the shared truncation keeps the
  // newest page and the scope's rows beside it, exactly as one host's list does.
  return truncateAiVaultListResult(
    {
      // Recency order with the shared id tiebreak, so a merged list sorts like one host's.
      sessions: sortAiVaultSessionsByRecency([...byId.values()]),
      issues,
      // Reuse accepted scan times so unchanged host results cannot fabricate freshness.
      scannedAt: latestAiVaultScannedAt(results)
    },
    depth,
    scopePaths
  )
}

function latestAiVaultScannedAt(results: readonly AiVaultListResult[]): string {
  const nowMs = Date.now()
  let latestMs = Number.NEGATIVE_INFINITY
  for (const result of results) {
    const stampMs = Date.parse(result.scannedAt)
    // Reject invalid or future remote clocks; compare instants because ISO spellings can sort differently.
    if (Number.isNaN(stampMs) || stampMs > nowMs) {
      continue
    }
    latestMs = Math.max(latestMs, stampMs)
  }
  // Canonicalize equal instants so host enumeration order cannot change the merged stamp.
  return new Date(latestMs === Number.NEGATIVE_INFINITY ? nowMs : latestMs).toISOString()
}

/**
 * The global (already capped) list plus a scope's own sessions.
 *
 * A scope path is a guarantee that its sessions are listed even when they are
 * older than the recency cap, never a filter that hides everything else: the
 * panel narrows to the scope it is showing, and the host's answer is the
 * candidate pool it narrows. Both listing sources go through here — the
 * filesystem scanner and the index — so which of them answered cannot change
 * which sessions a scope's list contains.
 */
export function unionScopedSessions(
  cappedSessions: AiVaultSession[],
  scopeSessions: readonly AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return cappedSessions
  }
  const byId = new Map<string, AiVaultSession>()
  for (const session of cappedSessions) {
    byId.set(session.id, session)
  }
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  // Alias-deduped first: a rollout's copy in another Codex home is a second row under
  // a second id, which the id union above cannot collapse.
  return sortAiVaultSessionsByRecency(dedupeScannedSessions([...byId.values()]))
}
