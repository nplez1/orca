import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultPagedListReply } from '../ai-vault/ai-vault-paged-list-reply'
import { resetAiVaultListSyncStoreForTests } from '../ai-vault/ai-vault-list-sync-store'
import { parseAiVaultListResult } from '../ai-vault/session-list-result-validation'
import {
  invalidateAiVaultHostLegCache,
  scanHostLegWithCache,
  type AiVaultHostLegSyncBasis
} from './ai-vault-host-leg-cache'

const SCANNED_AT = '2026-10-02T00:00:00.000Z'

function session(sessionId: string, title = sessionId): AiVaultSession {
  return {
    id: `runtime:env-1:codex:${sessionId}:/srv/${sessionId}.jsonl`,
    executionHostId: 'runtime:env-1',
    agent: 'codex',
    sessionId,
    title,
    cwd: '/srv/app',
    branch: null,
    model: null,
    filePath: `/srv/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-01T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

/** The host's real reply, read by the parent's real wire parser. */
function hostReply(
  sessions: readonly AiVaultSession[],
  options: { syncFromFingerprint?: string; offset?: number; force?: boolean } = {}
): AiVaultListResult {
  return parseAiVaultListResult(
    aiVaultPagedListReply({
      result: { sessions: [...sessions], issues: [], scannedAt: SCANNED_AT },
      offset: options.offset ?? 0,
      force: options.force ?? false,
      ...(options.syncFromFingerprint ? { syncFromFingerprint: options.syncFromFingerprint } : {})
    })
  )
}

function legArgs(
  scan: (syncFrom: AiVaultHostLegSyncBasis | undefined) => Promise<AiVaultListResult>
) {
  return {
    cacheKey: 'leg',
    depth: 'unlimited' as const,
    force: false,
    hostLabel: 'env-1',
    syncBasisKey: 'leg|runtime:env-1',
    scan
  }
}

const AI_VAULT_LEG_TTL_MS = 15_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})

afterEach(() => {
  invalidateAiVaultHostLegCache()
  resetAiVaultListSyncStoreForTests()
  vi.useRealTimers()
})

/** Past the leg's TTL, so the next call asks the host again instead of reading the cache. */
function expireLegCache(): void {
  vi.setSystemTime(Date.now() + AI_VAULT_LEG_TTL_MS + 1)
}

describe('a host reply applied by the desktop leg', () => {
  it('turns a changed listing into the changed rows and rebuilds the full list', async () => {
    const held = [session('one'), session('two')]
    const scan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) =>
      hostReply(held, syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
    const first = await scanHostLegWithCache(legArgs(scan))

    expect(first.sessions.map((row) => row.sessionId)).toEqual(['one', 'two'])
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    const changed = [session('one'), session('two', 'renamed'), session('three')]
    let sentDelta = false
    const syncedScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) => {
      const reply = hostReply(
        changed,
        syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {}
      )
      sentDelta ||= reply.syncDelta !== undefined
      return reply
    }
    expireLegCache()
    const second = await scanHostLegWithCache(legArgs(syncedScan))

    // The host really answered with a diff, not with the whole list.
    expect(sentDelta).toBe(true)

    // The host answered with two upserts and no removals; the leg rebuilt the whole list from them.
    expect(second.sessions.map((row) => row.sessionId)).toEqual(['one', 'three', 'two'])
    expect(second.sessions.find((row) => row.sessionId === 'two')?.title).toBe('renamed')
    expect(second.syncDelta).toBeUndefined()
  })

  it('drops a row the host removed and keeps the fingerprint chain going', async () => {
    const held = [session('one'), session('two')]
    const firstScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) =>
      hostReply(held, syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
    const first = await scanHostLegWithCache(legArgs(firstScan))

    const shrunk = [session('two')]
    const secondScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) =>
      hostReply(shrunk, syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
    expireLegCache()
    const second = await scanHostLegWithCache(legArgs(secondScan))

    expect(second.sessions.map((row) => row.sessionId)).toEqual(['two'])
    expect(second.fingerprint).not.toBe(first.fingerprint)

    expireLegCache()
    const third = await scanHostLegWithCache(legArgs(async () => hostReply(shrunk)))
    expect(third.fingerprint).toBe(second.fingerprint)
  })

  it('rescans on a forced refresh and still applies only the diff', async () => {
    const held = [session('one'), session('two')]
    const firstScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) =>
      hostReply(held, syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
    await scanHostLegWithCache(legArgs(firstScan))

    // A forced refresh means "rescan the host", not "send the whole list again": the diff is
    // computed against that fresh scan, so it is still the real listing.
    const rescanned = [session('two'), session('three')]
    let sentBasis: string | undefined
    const forcedScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) => {
      sentBasis = syncFrom?.fingerprint
      return hostReply(rescanned, syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
    }
    const forced = await scanHostLegWithCache({ ...legArgs(forcedScan), force: true })

    expect(sentBasis).toBeDefined()
    expect(forced.sessions.map((row) => row.sessionId)).toEqual(['three', 'two'])
    expect(forced.syncDelta).toBeUndefined()
  })
})
