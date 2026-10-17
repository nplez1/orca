import { describe, expect, it } from 'vitest'
import type { AiVaultListArgs, AiVaultListResult, AiVaultSession } from './ai-vault-types'
import {
  AI_VAULT_LIST_CHANGING_SCAN_MESSAGE,
  AI_VAULT_LIST_MAX_PAGES,
  AI_VAULT_LIST_MAX_SCAN_RESTARTS,
  AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE,
  AI_VAULT_LIST_UNREADABLE_CURSOR_MESSAGE,
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

function page(
  ids: readonly string[],
  nextOffset?: number,
  listToken = 'scan-a'
): AiVaultListResult {
  return {
    sessions: ids.map(session),
    issues: [],
    scannedAt: SCANNED_AT,
    listToken,
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
    // Why drop the fingerprint: it names the whole listing, and reusing it would let the host
    // answer `unchanged` for rows this caller never received.
    expect(read.result.fingerprint).toBeUndefined()
    expect(read.error).toEqual(new Error('The connection closed.'))
  })

  it('reports a host that says hasMore without a usable cursor instead of truncating quietly', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async () => ({
        sessions: [session('a')],
        issues: [],
        scannedAt: SCANNED_AT,
        hasMore: true
      })
    })

    expect(read.kind).toBe('partial')
    if (read.kind !== 'partial') {
      throw new Error('expected a partial listing')
    }
    expect(read.result.sessions).toHaveLength(1)
    expect(read.error).toEqual(new Error(AI_VAULT_LIST_UNREADABLE_CURSOR_MESSAGE))
  })

  it('starts the listing again when a later page came from a different scan', async () => {
    const requested: number[] = []
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        requested.push(args.offset ?? -1)
        // Scan A serves page 0, then the listing is rescanned before page 1 is read.
        if (requested.length === 1) {
          return page(['a', 'b'], 2, 'scan-a')
        }
        if (requested.length === 2) {
          return page(['c'], 3, 'scan-b')
        }
        return requested.length === 3
          ? page(['a', 'b'], 2, 'scan-b')
          : page(['c'], undefined, 'scan-b')
      }
    })

    expect(requested).toEqual([0, 2, 0, 2])
    expect(read.kind).toBe('complete')
    if (read.kind !== 'complete') {
      throw new Error('expected a complete listing')
    }
    // Every row in the answer belongs to scan B; scan A's page is not mixed in.
    expect(read.result.sessions.map((row) => row.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('restarts onto a delta and lets the caller apply it to its own list', async () => {
    const requested: number[] = []
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        requested.push(args.offset ?? -1)
        if (requested.length === 1) {
          return page(['a', 'b'], 2, 'scan-a')
        }
        if (requested.length === 2) {
          return page(['c'], 3, 'scan-b')
        }
        // The restarted page 0 comes back as the host's diff against the fingerprint sent.
        return {
          sessions: [],
          issues: [],
          scannedAt: SCANNED_AT,
          fingerprint: FINGERPRINT,
          syncDelta: { upserts: [session('a')], removedIds: [] }
        }
      }
    })

    expect(requested).toEqual([0, 2, 0])
    expect(read.kind).toBe('complete')
    if (read.kind !== 'complete') {
      throw new Error('expected a complete read')
    }
    expect(read.result.syncDelta?.upserts).toHaveLength(1)
    expect(read.result.sessions).toEqual([])
  })

  it('restarts onto an unchanged reply and passes it through', async () => {
    const requested: number[] = []
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        requested.push(args.offset ?? -1)
        if (requested.length === 1) {
          return page(['a', 'b'], 2, 'scan-a')
        }
        if (requested.length === 2) {
          return page(['c'], 3, 'scan-b')
        }
        return {
          sessions: [],
          issues: [],
          scannedAt: SCANNED_AT,
          fingerprint: FINGERPRINT,
          unchanged: true
        }
      }
    })

    expect(requested).toEqual([0, 2, 0])
    expect(read).toMatchObject({ kind: 'complete', result: { unchanged: true } })
  })

  it('reports a listing that keeps changing instead of retrying forever', async () => {
    let token = 0
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        if ((args.offset ?? 0) === 0) {
          token += 1
          return page(['a'], 1, `scan-${token}`)
        }
        return page(['b'], undefined, `scan-${token}-other`)
      }
    })

    expect(AI_VAULT_LIST_MAX_SCAN_RESTARTS).toBeGreaterThan(0)
    expect(read.kind).toBe('partial')
    if (read.kind !== 'partial') {
      throw new Error('expected a partial listing')
    }
    expect(read.error).toEqual(new Error(AI_VAULT_LIST_CHANGING_SCAN_MESSAGE))
  })

  it('publishes no fingerprint with rows that are only part of a listing', async () => {
    const read = await readAiVaultListPages({
      firstPageArgs: FIRST_PAGE_ARGS,
      fetchPage: async (args) => {
        if ((args.offset ?? 0) === 0) {
          return { ...page(['a'], 1), fingerprint: FINGERPRINT }
        }
        throw new Error('The connection closed.')
      }
    })

    expect(read.kind).toBe('partial')
    if (read.kind !== 'partial') {
      throw new Error('expected a partial listing')
    }
    // Why: a fingerprint would make the host answer `unchanged` about rows never received.
    expect(read.result.fingerprint).toBeUndefined()
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
