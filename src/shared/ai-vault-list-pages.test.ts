import { describe, expect, it } from 'vitest'
import type { AiVaultListArgs, AiVaultListResult, AiVaultSession } from './ai-vault-types'
import {
  AI_VAULT_LIST_MAX_PAGES,
  AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE,
  readAiVaultListPages
} from './ai-vault-list-pages'

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

function page(ids: readonly string[], nextOffset?: number): AiVaultListResult {
  return {
    sessions: ids.map(session),
    issues: [],
    scannedAt: SCANNED_AT,
    ...(nextOffset === undefined ? {} : { hasMore: true as const, nextOffset })
  }
}

const FIRST_PAGE_ARGS: AiVaultListArgs = {
  force: true,
  afterFingerprint: FINGERPRINT,
  syncFromFingerprint: FINGERPRINT,
  limit: 25
}

describe('readAiVaultListPages', () => {
  it('drains every page and keeps the host order', async () => {
    const requests: AiVaultListArgs[] = []
    const pages = [page(['a', 'b'], 2), page(['c'], 3), page(['d', 'e'])]
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        requests.push(args)
        return pages[requests.length - 1]!
      }
    })

    expect(read.kind).toBe('complete')
    if (read.kind !== 'complete') {
      throw new Error('expected a complete listing')
    }
    expect(read.result.sessions.map((row) => row.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(read.result.hasMore).toBeUndefined()
    expect(requests.map((args) => args.offset)).toEqual([0, 2, 3])
  })

  it('sends the fingerprint and force on the first page only', async () => {
    const requests: AiVaultListArgs[] = []
    await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        requests.push(args)
        return requests.length === 1 ? page(['a'], 1) : page(['b'])
      }
    })

    expect(requests[0]).toMatchObject({
      afterFingerprint: FINGERPRINT,
      syncFromFingerprint: FINGERPRINT,
      force: true,
      paged: true
    })
    // Why: a later page is a different body, so comparing a fingerprint there would answer
    // "unchanged" for rows the caller has never seen; forcing would also rescan per page.
    expect(requests[1]).not.toHaveProperty('afterFingerprint')
    expect(requests[1]).not.toHaveProperty('syncFromFingerprint')
    expect(requests[1]).not.toHaveProperty('force')
    expect(requests[1]).toMatchObject({ paged: true, offset: 1, limit: 25 })
  })

  it('returns an unchanged reply without asking for another page', async () => {
    const fetchPage = async (): Promise<AiVaultListResult> => ({
      sessions: [],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT,
      unchanged: true
    })
    const read = await readAiVaultListPages({ firstPageArgs: FIRST_PAGE_ARGS, fetchPage })

    expect(read).toMatchObject({ kind: 'complete', result: { unchanged: true } })
  })

  it('ends the drain at a delta reply instead of asking for a next page', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async () => ({
        sessions: [],
        issues: [],
        scannedAt: SCANNED_AT,
        fingerprint: FINGERPRINT,
        syncDelta: { upserts: [session('a')], removedIds: ['gone'] }
      })
    })

    expect(read.kind).toBe('complete')
    if (read.kind !== 'complete') {
      throw new Error('expected a complete read')
    }
    expect(read.result.syncDelta?.removedIds).toEqual(['gone'])
  })

  it('reports a first-page failure with no rows', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async () => {
        throw new Error('reply_too_large')
      }
    })

    expect(read).toMatchObject({ kind: 'failed', error: new Error('reply_too_large') })
  })

  it('keeps the rows from earlier pages when a later page fails', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        if (args.offset === 0) {
          return { ...page(['a', 'b'], 2), fingerprint: FINGERPRINT }
        }
        throw new Error('The connection closed.')
      }
    })

    expect(read.kind).toBe('partial')
    if (read.kind !== 'partial') {
      return
    }
    expect(read.result.sessions.map((row) => row.sessionId)).toEqual(['a', 'b'])
    // The fingerprint still describes the whole corpus, so a later refresh can reuse it.
    expect(read.result.fingerprint).toBe(FINGERPRINT)
    expect(read.error).toEqual(new Error('The connection closed.'))
  })

  it('stops when a host says hasMore without a usable cursor', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async () => ({
        sessions: [session('a')],
        issues: [],
        scannedAt: SCANNED_AT,
        hasMore: true
      })
    })

    expect(read.kind).toBe('complete')
    if (read.kind !== 'complete') {
      throw new Error('expected a complete listing')
    }
    expect(read.result.sessions).toHaveLength(1)
  })

  it('stops at the page cap instead of draining forever', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => page([`row-${args.offset}`], (args.offset ?? 0) + 1)
    })

    expect(read.kind).toBe('partial')
    if (read.kind !== 'partial') {
      return
    }
    expect(read.result.sessions).toHaveLength(AI_VAULT_LIST_MAX_PAGES)
    expect(read.error).toEqual(new Error(AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE))
  })
})
