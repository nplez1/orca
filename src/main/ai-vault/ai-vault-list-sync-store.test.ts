import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  AI_VAULT_LIST_SYNC_RETAINED_BYTES,
  aiVaultListSyncDelta,
  resetAiVaultListSyncStoreForTests,
  retainedAiVaultListDigests,
  retainAiVaultListSnapshot
} from './ai-vault-list-sync-store'

const SCANNED_AT = '2026-07-27T00:00:00.000Z'

function session(sessionId: string, title = sessionId): AiVaultSession {
  return {
    id: `local:claude:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title,
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

function snapshot(sessions: readonly AiVaultSession[], fingerprint: string) {
  return {
    fingerprint,
    digests: new Map(sessions.map((row) => [row.id, `${row.id}:${row.title}`.slice(0, 32)]))
  }
}

afterEach(() => {
  resetAiVaultListSyncStoreForTests()
})

describe('retained list snapshots', () => {
  it('hands back the digests a fingerprint names, until it is evicted', () => {
    const held = [session('a'), session('b')]
    retainAiVaultListSnapshot(snapshot(held, 'a'.repeat(64)))
    expect(retainedAiVaultListDigests('a'.repeat(64))?.size).toBe(2)
    expect(retainedAiVaultListDigests('b'.repeat(64))).toBeNull()
  })

  it('evicts oldest snapshots once the retained bytes are spent', () => {
    // Small snapshots are cheap to build; the bound is on the sum, not on one entry.
    const many = Array.from({ length: 1_000 }, (_, index) => session(`s-${index}`))
    const perEntry = Buffer.byteLength(many[0]!.id) + 32 + 128
    const batches = Math.ceil(AI_VAULT_LIST_SYNC_RETAINED_BYTES / (perEntry * many.length)) + 2
    for (let index = 0; index < batches; index += 1) {
      retainAiVaultListSnapshot(snapshot(many, index.toString(16).padStart(64, '0')))
    }

    expect(retainedAiVaultListDigests('0'.repeat(64))).toBeNull()
    expect(retainedAiVaultListDigests((batches - 1).toString(16).padStart(64, '0'))).not.toBeNull()
  })
})

describe('aiVaultListSyncDelta', () => {
  it('names the rows that changed and the ids that vanished', () => {
    const held = [session('a'), session('b'), session('c')]
    const current = [session('a'), session('b', 'renamed'), session('d')]
    const delta = aiVaultListSyncDelta({
      previous: snapshot(held, 'old').digests,
      current: snapshot(current, 'new'),
      sessions: current,
      issues: []
    })

    expect(delta?.upserts.map((row) => row.sessionId)).toEqual(['b', 'd'])
    expect(delta?.removedIds).toEqual([held[2]!.id])
  })

  it('refuses a delta whose issues alone would overrun one reply', () => {
    const held = [session('a')]
    const current = [session('a'), session('b')]
    const delta = aiVaultListSyncDelta({
      previous: snapshot(held, 'old').digests,
      current: snapshot(current, 'new'),
      sessions: current,
      issues: [
        {
          agent: 'codex',
          kind: 'host',
          path: '/srv/app',
          message: 'x'.repeat(3 * 1024 * 1024)
        }
      ]
    })

    expect(delta).toBeNull()
  })
})
