import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import {
  AI_VAULT_CACHE_TTL_MS,
  invalidateAiVaultHostLegCache,
  scanHostLegWithCache,
  type AiVaultHostLegSyncBasis
} from './ai-vault-host-leg-cache'

const SCANNED_AT = '2026-10-02T00:00:00.000Z'
const FIRST_FINGERPRINT = 'a'.repeat(64)
const SECOND_FINGERPRINT = 'b'.repeat(64)

function session(sessionId: string, modifiedAt = SCANNED_AT): AiVaultSession {
  return {
    id: `runtime:env-1:codex:${sessionId}:/srv/${sessionId}.jsonl`,
    executionHostId: 'runtime:env-1',
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/srv/app',
    branch: null,
    model: null,
    filePath: `/srv/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

const EARLY = '2026-10-01T00:00:00.000Z'

function listing(sessions: readonly AiVaultSession[], fingerprint?: string): AiVaultListResult {
  return {
    sessions: [...sessions],
    issues: [],
    scannedAt: SCANNED_AT,
    ...(fingerprint ? { fingerprint } : {})
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})

afterEach(() => {
  invalidateAiVaultHostLegCache()
  vi.useRealTimers()
})

describe('host leg change sync', () => {
  it('asks for the difference from the list it holds and applies it', async () => {
    const scan = vi.fn<(basis: AiVaultHostLegSyncBasis | undefined) => Promise<AiVaultListResult>>()
    const held = [session('one'), session('two', EARLY)]
    scan.mockResolvedValueOnce(listing(held, FIRST_FINGERPRINT))
    const args = {
      cacheKey: 'leg',
      depth: 'unlimited' as const,
      force: false,
      hostLabel: 'runtime:env-1',
      syncBasisKey: 'leg|runtime:env-1',
      scan
    }

    const first = await scanHostLegWithCache(args)
    expect(scan).toHaveBeenNthCalledWith(1, undefined)
    expect(first.fingerprint).toBe(FIRST_FINGERPRINT)

    // Past the TTL, so the leg asks the host again — for the change, not the whole list.
    vi.setSystemTime(1_000 + AI_VAULT_CACHE_TTL_MS + 1)
    scan.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-10-03T00:00:00.000Z',
      fingerprint: SECOND_FINGERPRINT,
      syncDelta: { upserts: [session('three')], removedIds: [held[0]!.id] }
    })

    const second = await scanHostLegWithCache(args)

    expect(scan).toHaveBeenNthCalledWith(2, {
      fingerprint: FIRST_FINGERPRINT,
      sessions: held
    })
    expect(second.sessions.map((row) => row.sessionId)).toEqual(['three', 'two'])
    expect(second.fingerprint).toBe(SECOND_FINGERPRINT)
    expect(second.syncDelta).toBeUndefined()
  })

  it('syncs the next refresh from the applied fingerprint', async () => {
    const scan = vi.fn<(basis: AiVaultHostLegSyncBasis | undefined) => Promise<AiVaultListResult>>()
    scan.mockResolvedValueOnce(listing([session('one')], FIRST_FINGERPRINT))
    const args = {
      cacheKey: 'leg',
      depth: 'unlimited' as const,
      force: false,
      hostLabel: 'runtime:env-1',
      syncBasisKey: 'leg|runtime:env-1',
      scan
    }
    await scanHostLegWithCache(args)

    vi.setSystemTime(1_000 + AI_VAULT_CACHE_TTL_MS + 1)
    scan.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: SECOND_FINGERPRINT,
      syncDelta: { upserts: [session('two')], removedIds: [] }
    })
    await scanHostLegWithCache(args)

    vi.setSystemTime(1_000 + 2 * (AI_VAULT_CACHE_TTL_MS + 1))
    scan.mockResolvedValueOnce(listing([session('one'), session('two')]))
    await scanHostLegWithCache(args)

    // Equal mtimes, so the id tiebreak orders the held list the same way a full listing would.
    expect(scan).toHaveBeenNthCalledWith(3, {
      fingerprint: SECOND_FINGERPRINT,
      sessions: [session('one'), session('two')]
    })
  })

  // The wire parser already refuses a delta the request did not ask for, so this is the defence
  // behind it: an in-process caller that sends a token of its own cannot be handed a delta that
  // names a list this leg does not hold.
  it('asks again for a full listing when a delta arrives with no list to apply it to', async () => {
    const scan = vi.fn<(basis: AiVaultHostLegSyncBasis | undefined) => Promise<AiVaultListResult>>()
    scan
      .mockResolvedValueOnce({
        sessions: [],
        issues: [],
        scannedAt: SCANNED_AT,
        fingerprint: SECOND_FINGERPRINT,
        syncDelta: { upserts: [session('two')], removedIds: [] }
      })
      .mockResolvedValueOnce(listing([session('one'), session('two')], SECOND_FINGERPRINT))

    const result = await scanHostLegWithCache({
      cacheKey: 'leg',
      depth: 'unlimited',
      force: false,
      hostLabel: 'runtime:env-1',
      syncBasisKey: 'leg|runtime:env-1',
      scan
    })

    // Why retry rather than fail: under 'all', a throw here would take every host's list down.
    expect(scan).toHaveBeenNthCalledWith(1, undefined)
    expect(scan).toHaveBeenNthCalledWith(2, undefined)
    expect(result.sessions.map((row) => row.sessionId)).toEqual(['one', 'two'])
  })
})
