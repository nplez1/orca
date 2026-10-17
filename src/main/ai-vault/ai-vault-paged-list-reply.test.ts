import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

const store = vi.hoisted(() => ({
  retainedAiVaultListDigests: vi.fn(),
  retainAiVaultListSnapshot: vi.fn(),
  aiVaultListSyncDelta: vi.fn()
}))
vi.mock('./ai-vault-list-sync-store', () => store)
import { aiVaultPagedListReply } from './ai-vault-paged-list-reply'

const SCANNED_AT = '2026-07-27T00:00:00.000Z'
const FINGERPRINT = 'a'.repeat(64)

function session(sessionId: string): AiVaultSession {
  return {
    id: `local:claude:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title: sessionId,
    cwd: '/tmp',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: SCANNED_AT,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume ${sessionId}`,
    subagent: null
  }
}

function listing(): AiVaultListResult {
  return { sessions: [session('a')], issues: [], scannedAt: SCANNED_AT }
}

beforeEach(() => {
  store.retainAiVaultListSnapshot.mockReset()
  store.retainedAiVaultListDigests.mockReset().mockReturnValue(new Map())
  store.aiVaultListSyncDelta.mockReset().mockReturnValue({ upserts: [], removedIds: [] })
})

describe('aiVaultPagedListReply', () => {
  it('looks the client snapshot up before retaining the new one that may evict it', () => {
    aiVaultPagedListReply({
      result: listing(),
      offset: 0,
      force: false,
      syncFromFingerprint: FINGERPRINT
    })

    const lookupOrder = store.retainedAiVaultListDigests.mock.invocationCallOrder[0]!
    const retainOrder = store.retainAiVaultListSnapshot.mock.invocationCallOrder[0]!
    expect(lookupOrder).toBeLessThan(retainOrder)
  })

  it('pages without retaining or diffing a later page', () => {
    const reply = aiVaultPagedListReply({
      result: listing(),
      offset: 1,
      force: false,
      syncFromFingerprint: FINGERPRINT
    })

    expect(reply.sessions).toEqual([])
    expect(reply.syncDelta).toBeUndefined()
    expect(store.retainAiVaultListSnapshot).not.toHaveBeenCalled()
    expect(store.retainedAiVaultListDigests).not.toHaveBeenCalled()
  })

  it('refuses unchanged on a forced refresh but still answers the diff', () => {
    const reply = aiVaultPagedListReply({
      result: listing(),
      offset: 0,
      force: true,
      afterFingerprint: FINGERPRINT,
      syncFromFingerprint: FINGERPRINT
    })

    // Why unchanged is refused: a forced refresh has to paint a body the caller will apply.
    expect(reply.unchanged).toBeUndefined()
    // Why the diff is not refused: forcing rescans the host, and the diff is that fresh scan.
    expect(reply.syncDelta).toEqual({ upserts: [], removedIds: [] })
    expect(store.aiVaultListSyncDelta).toHaveBeenCalled()
  })
})
