import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultPagedListReply } from '../ai-vault/ai-vault-paged-list-reply'
import { resetAiVaultListSyncStoreForTests } from '../ai-vault/ai-vault-list-sync-store'
import { parseAiVaultListResult } from '../ai-vault/session-list-result-validation'
import { resetAiVaultHostLegCacheForTests, scanHostLegWithCache } from './ai-vault-host-leg-cache'
import {
  hostLegSyncScan,
  resetAiVaultHostLegSyncForTests,
  type AiVaultHostLegSyncBasis
} from './ai-vault-host-leg-sync'

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
    scan: hostLegSyncScan({
      syncBasisKey: 'leg|runtime:env-1',
      depth: 'unlimited',
      hostLabel: 'env-1',
      scan
    })
  }
}

const AI_VAULT_LEG_TTL_MS = 15_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})

afterEach(() => {
  // Why the full reset: the held lists survive invalidation, so they would leak between tests.
  resetAiVaultHostLegCacheForTests()
  resetAiVaultHostLegSyncForTests()
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
    let sentDelta = false
    const secondScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) => {
      const reply = hostReply(shrunk, syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
      sentDelta ||= reply.syncDelta !== undefined
      return reply
    }
    expireLegCache()
    const second = await scanHostLegWithCache(legArgs(secondScan))

    expect(sentDelta).toBe(true)

    expect(second.sessions.map((row) => row.sessionId)).toEqual(['two'])
    expect(second.fingerprint).not.toBe(first.fingerprint)

    expireLegCache()
    const third = await scanHostLegWithCache(legArgs(async () => hostReply(shrunk)))
    expect(third.fingerprint).toBe(second.fingerprint)
  })

  it('does not offer a list it could not fully read as a diff basis', async () => {
    const clientSkip = {
      agent: 'codex' as const,
      path: 'aiVault.listSessions',
      message: 'Skipped 1 invalid Agent Session History result entry.'
    }
    const held = { ...hostReply([session('one')]), issues: [clientSkip] }
    await scanHostLegWithCache(legArgs(async () => held))

    expireLegCache()
    let sentBasis: string | undefined = 'unset'
    const nextScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) => {
      sentBasis = syncFrom?.fingerprint
      return hostReply([session('one'), session('two')])
    }
    const next = await scanHostLegWithCache(legArgs(nextScan))

    // Why no basis: a diff never re-sends unchanged rows, so the notice could never be withdrawn
    // once the row was fixed. A full read derives it again from the rows actually in front of it.
    expect(sentBasis).toBeUndefined()
    expect(next.sessions.map((row) => row.sessionId)).toEqual(['one', 'two'])
    expect(next.issues).toEqual([])
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
    let sentDelta = false
    const forcedScan = async (syncFrom: AiVaultHostLegSyncBasis | undefined) => {
      sentBasis = syncFrom?.fingerprint
      // The wire request carries force, so the host's own forced path runs: unchanged is refused
      // and the diff is still answered.
      const reply = hostReply(rescanned, {
        force: true,
        ...(syncFrom ? { syncFromFingerprint: syncFrom.fingerprint } : {})
      })
      sentDelta ||= reply.syncDelta !== undefined
      return reply
    }
    const forced = await scanHostLegWithCache({ ...legArgs(forcedScan), force: true })

    expect(sentBasis).toBeDefined()
    expect(sentDelta).toBe(true)
    expect(forced.sessions.map((row) => row.sessionId)).toEqual(['three', 'two'])
    expect(forced.syncDelta).toBeUndefined()
  })
})
