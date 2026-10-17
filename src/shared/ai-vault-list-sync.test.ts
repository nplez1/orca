import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from './ai-vault-types'
import { applyAiVaultListDelta } from './ai-vault-list-sync'
import { aiVaultSessionSortTime, sortAiVaultSessionsByRecency } from './ai-vault-session-sort'

function session(sessionId: string, modifiedAt: string, title = sessionId): AiVaultSession {
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
    modifiedAt,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume ${sessionId}`,
    subagent: null
  }
}

const EARLY = '2026-07-01T00:00:00.000Z'
const LATE = '2026-07-27T00:00:00.000Z'

describe('applyAiVaultListDelta', () => {
  it('replaces changed rows, drops removed ids and keeps the rest', () => {
    const held = [session('a', LATE), session('b', EARLY), session('c', EARLY)]
    const applied = applyAiVaultListDelta(held, {
      upserts: [session('b', LATE, 'renamed')],
      removedIds: [session('c', EARLY).id]
    })

    // Both rows now carry LATE, so the id tiebreak decides.
    expect(applied.map((row) => row.sessionId)).toEqual(['a', 'b'])
    expect(applied[1]?.title).toBe('renamed')
  })

  it('adds rows the host reported for the first time', () => {
    const applied = applyAiVaultListDelta([session('a', EARLY)], {
      upserts: [session('b', LATE)],
      removedIds: []
    })

    expect(applied.map((row) => row.sessionId)).toEqual(['b', 'a'])
  })

  it('re-derives order from the rows rather than from the delta', () => {
    const held = [session('a', EARLY), session('b', LATE)]
    const applied = applyAiVaultListDelta(held, { upserts: [], removedIds: [] })

    expect(applied.map((row) => row.sessionId)).toEqual(['b', 'a'])
  })

  it('is a no-op for an empty delta on an empty list', () => {
    expect(applyAiVaultListDelta([], { upserts: [], removedIds: [] })).toEqual([])
  })
})

describe('sortAiVaultSessionsByRecency', () => {
  it('orders by recency and breaks ties by id, so both sides of a sync agree', () => {
    const sorted = sortAiVaultSessionsByRecency([
      session('b', LATE),
      session('a', LATE),
      session('c', EARLY)
    ])

    expect(sorted.map((row) => row.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('sorts an unparsable timestamp last instead of poisoning the comparator', () => {
    const sorted = sortAiVaultSessionsByRecency([
      session('broken', 'not-a-date'),
      session('recent', LATE)
    ])

    expect(sorted.map((row) => row.sessionId)).toEqual(['recent', 'broken'])
    expect(aiVaultSessionSortTime(session('broken', 'not-a-date'))).toBeNaN()
  })

  it('prefers updatedAt over modifiedAt', () => {
    const updated = { ...session('a', EARLY), updatedAt: LATE }

    expect(aiVaultSessionSortTime(updated)).toBe(Date.parse(LATE))
  })
})
