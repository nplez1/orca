import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { pageAiVaultListResult } from './session-list-page-bounds'

const SCANNED_AT = '2026-07-27T00:00:00.000Z'
const FINGERPRINT = 'a'.repeat(64)

function session(sessionId: string, titlePadding = 0): AiVaultSession {
  return {
    id: `local:claude:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title: sessionId + 'x'.repeat(titlePadding),
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

function listing(sessions: readonly AiVaultSession[]): AiVaultListResult {
  return {
    sessions: [...sessions],
    issues: [{ agent: 'codex', path: 'source', message: 'warning' }],
    scannedAt: SCANNED_AT,
    fingerprint: FINGERPRINT
  }
}

function rowBytes(session: AiVaultSession): number {
  return Buffer.byteLength(JSON.stringify(session), 'utf8') + 1
}

describe('pageAiVaultListResult', () => {
  it('takes a contiguous prefix of rows that fits the byte budget', () => {
    const rows = [session('a'), session('b'), session('c', 4000), session('d')]
    const budget = rowBytes(rows[0]!) + rowBytes(rows[1]!) + 10
    const page = pageAiVaultListResult({ ...listing(rows), issues: [] }, 0, budget)

    expect(page.sessions.map((row) => row.sessionId)).toEqual(['a', 'b'])
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(2)
  })

  it('returns the row it is looking at even when that row alone exceeds the budget', () => {
    const page = pageAiVaultListResult(listing([session('huge', 8000)]), 0, 16)

    expect(page.sessions.map((row) => row.sessionId)).toEqual(['huge'])
    expect(page.hasMore).toBeUndefined()
  })

  it('carries issues and the fingerprint on the first page only', () => {
    const rows = [session('a'), session('b')]
    const first = pageAiVaultListResult(listing(rows), 0, rowBytes(rows[0]!) + 10)
    const second = pageAiVaultListResult(listing(rows), first.nextOffset!, 4096)

    expect(first.issues).toHaveLength(1)
    expect(first.fingerprint).toBe(FINGERPRINT)
    expect(second.issues).toEqual([])
    expect(second.fingerprint).toBeUndefined()
  })

  it('keeps the host order across pages', () => {
    const rows = [session('a'), session('b'), session('c'), session('d')]
    const first = pageAiVaultListResult(listing(rows), 0, rowBytes(rows[0]!) + 10)
    const second = pageAiVaultListResult(listing(rows), first.nextOffset!, 4096)

    expect([...first.sessions, ...second.sessions].map((row) => row.sessionId)).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
  })

  it('answers an offset past the end with an empty final page', () => {
    const page = pageAiVaultListResult(listing([session('a')]), 9, 4096)

    expect(page.sessions).toEqual([])
    expect(page.hasMore).toBeUndefined()
    expect(page.fingerprint).toBeUndefined()
  })

  it('clamps a negative offset instead of slicing from the end', () => {
    const page = pageAiVaultListResult(listing([session('a'), session('b')]), -3, 4096)

    expect(page.sessions.map((row) => row.sessionId)).toEqual(['a', 'b'])
    expect(page.fingerprint).toBe(FINGERPRINT)
  })
})
