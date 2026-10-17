import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

const callRuntimeResult = vi.hoisted(() => vi.fn())
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'owning-host' })
}))
import { createWebAiVaultApi } from './web-ai-vault-api'
import { resetBrowserAiVaultListSyncForTests } from './web-ai-vault-list-sync'

const SCANNED_AT = '2026-07-27T00:00:00.000Z'
const FINGERPRINT = 'a'.repeat(64)

function session(sessionId: string, modifiedAt = SCANNED_AT): AiVaultSession {
  return {
    id: `runtime:owning-host:claude:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'runtime:owning-host',
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

const SCOPE = { scopePaths: ['/workspaces/project'] }

beforeEach(() => {
  callRuntimeResult.mockReset()
  resetBrowserAiVaultListSyncForTests()
})

describe('web session listing pages and syncs', () => {
  it('drains a bounded listing page by page', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({
        sessions: [session('a')],
        issues: [],
        scannedAt: SCANNED_AT,
        fingerprint: FINGERPRINT,
        hasMore: true,
        nextOffset: 1
      })
      .mockResolvedValueOnce({
        sessions: [session('b')],
        issues: [],
        scannedAt: SCANNED_AT
      })

    const result = await createWebAiVaultApi().listSessions({ ...SCOPE })

    expect(result.sessions.map((row) => row.sessionId)).toEqual(['a', 'b'])
    expect(result.fingerprint).toBe(FINGERPRINT)
    expect(callRuntimeResult).toHaveBeenNthCalledWith(2, 'aiVault.listSessions', {
      ...SCOPE,
      paged: true,
      offset: 1,
      executionHostId: 'runtime:owning-host'
    })
  })

  it('keeps the issues a later page reports instead of only page 0', async () => {
    const scanIssue = { agent: 'codex', kind: 'host', path: 'owning-host', message: 'one' }
    const skippedRow = {
      agent: 'codex',
      path: 'aiVault.listSessions',
      message: 'Skipped 1 invalid'
    }
    callRuntimeResult
      .mockResolvedValueOnce({
        sessions: [session('a')],
        issues: [scanIssue],
        scannedAt: SCANNED_AT,
        hasMore: true,
        nextOffset: 1
      })
      // A page can report rows it had to skip; dropping that hides the only sign rows are missing.
      .mockResolvedValueOnce({
        sessions: [session('b')],
        issues: [skippedRow],
        scannedAt: SCANNED_AT
      })

    const result = await createWebAiVaultApi().listSessions({ ...SCOPE })

    expect(result.issues).toEqual([scanIssue, skippedRow])
  })

  it('asks the host for the difference from the list this tab holds', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [session('a'), session('b')],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT
    })
    const api = createWebAiVaultApi()
    await api.listSessions({ ...SCOPE })

    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T01:00:00.000Z',
      fingerprint: 'b'.repeat(64),
      syncDelta: { upserts: [session('c')], removedIds: [session('a').id] }
    })
    const synced = await api.listSessions({ ...SCOPE })

    expect(callRuntimeResult).toHaveBeenLastCalledWith('aiVault.listSessions', {
      ...SCOPE,
      paged: true,
      offset: 0,
      syncFromFingerprint: FINGERPRINT,
      executionHostId: 'runtime:owning-host'
    })
    // Equal mtimes, so the id tiebreak decides — the same order a full listing would produce.
    expect(synced.sessions.map((row) => row.sessionId)).toEqual(['b', 'c'])
    expect(synced.fingerprint).toBe('b'.repeat(64))
  })

  it('answers a forced refresh with a diff, not a fresh download', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [session('a')],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT
    })
    const api = createWebAiVaultApi()
    await api.listSessions({ ...SCOPE })

    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T03:00:00.000Z',
      fingerprint: 'd'.repeat(64),
      syncDelta: { upserts: [session('b')], removedIds: [session('a').id] }
    })
    const forced = await api.listSessions({ ...SCOPE, force: true })

    // Force means "rescan the host": the request still names the list this tab holds, and the
    // answer is the host's diff against it — not the whole listing again.
    expect(callRuntimeResult).toHaveBeenLastCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ force: true, syncFromFingerprint: FINGERPRINT })
    )
    expect(forced.sessions.map((row) => row.sessionId)).toEqual(['b'])

    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T04:00:00.000Z',
      fingerprint: 'd'.repeat(64),
      syncDelta: { upserts: [], removedIds: [] }
    })
    await api.listSessions({ ...SCOPE })
    expect(callRuntimeResult).toHaveBeenLastCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ syncFromFingerprint: 'd'.repeat(64) })
    )
  })

  it('reuses the held body for an unchanged reply', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [session('a')],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT
    })
    const api = createWebAiVaultApi()
    await api.listSessions({ ...SCOPE })

    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T02:00:00.000Z',
      fingerprint: FINGERPRINT,
      unchanged: true
    })
    // `unchanged` answers a fingerprint the request carried, as the renderer's refresh does.
    const reused = await api.listSessions({ ...SCOPE, afterFingerprint: FINGERPRINT })

    expect(reused.sessions.map((row) => row.sessionId)).toEqual(['a'])
    expect(reused.scannedAt).toBe('2026-07-27T02:00:00.000Z')
  })

  it('passes an unchanged reply through when this tab holds no list to reuse', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT,
      unchanged: true
    })

    const result = await createWebAiVaultApi().listSessions({
      ...SCOPE,
      afterFingerprint: FINGERPRINT
    })

    // The renderer treats `unchanged` as "ask again for the body", so it must not be an error.
    expect(result).toMatchObject({ unchanged: true, sessions: [] })
  })

  it('keeps the held list when the first page fails, so the next refresh can diff', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [session('a')],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT
    })
    const api = createWebAiVaultApi()
    await api.listSessions({ ...SCOPE })

    callRuntimeResult.mockRejectedValueOnce(new Error('The connection closed.'))
    await expect(api.listSessions({ ...SCOPE })).rejects.toThrow('The connection closed.')

    // The body this tab holds is still the list its fingerprint names, so the next refresh asks
    // for the difference instead of the whole history.
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T05:00:00.000Z',
      fingerprint: FINGERPRINT,
      syncDelta: { upserts: [], removedIds: [] }
    })
    await api.listSessions({ ...SCOPE })

    expect(callRuntimeResult).toHaveBeenLastCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ syncFromFingerprint: FINGERPRINT })
    )
  })

  it('keeps the held list when a later page fails', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      sessions: [session('a')],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: FINGERPRINT
    })
    const api = createWebAiVaultApi()
    await api.listSessions({ ...SCOPE })

    callRuntimeResult
      .mockResolvedValueOnce({
        sessions: [session('a')],
        issues: [],
        scannedAt: SCANNED_AT,
        fingerprint: 'b'.repeat(64),
        hasMore: true,
        nextOffset: 1
      })
      .mockRejectedValueOnce(new Error('The connection closed.'))
    await api.listSessions({ ...SCOPE })

    callRuntimeResult.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T06:00:00.000Z',
      fingerprint: FINGERPRINT,
      syncDelta: { upserts: [], removedIds: [] }
    })
    await api.listSessions({ ...SCOPE })

    // Still the list from before the failed read, not the failed read's page 0.
    expect(callRuntimeResult).toHaveBeenLastCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ syncFromFingerprint: FINGERPRINT })
    )
  })

  it('degrades a failed later page to the rows already read and retries full next time', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({
        sessions: [session('a')],
        issues: [],
        scannedAt: SCANNED_AT,
        fingerprint: FINGERPRINT,
        hasMore: true,
        nextOffset: 1
      })
      .mockRejectedValueOnce(new Error('The connection closed.'))
    const api = createWebAiVaultApi()
    const partial = await api.listSessions({ ...SCOPE })

    expect(partial.sessions.map((row) => row.sessionId)).toEqual(['a'])
    expect(partial.issues).toContainEqual(
      expect.objectContaining({
        kind: 'host',
        message: expect.stringContaining('Only part of the session list loaded.')
      })
    )

    callRuntimeResult.mockResolvedValueOnce({
      sessions: [session('a'), session('b')],
      issues: [],
      scannedAt: SCANNED_AT,
      fingerprint: 'c'.repeat(64)
    })
    await api.listSessions({ ...SCOPE })
    expect(callRuntimeResult).toHaveBeenLastCalledWith(
      'aiVault.listSessions',
      expect.not.objectContaining({ syncFromFingerprint: expect.anything() })
    )
  })

  it('rejects a failed first page', async () => {
    callRuntimeResult.mockRejectedValueOnce(new Error('reply_too_large'))
    await expect(createWebAiVaultApi().listSessions({ ...SCOPE })).rejects.toThrow(
      'reply_too_large'
    )
  })
})
