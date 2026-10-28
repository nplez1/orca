import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  listEnvironments: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: mocks.listEnvironments,
  resolveEnvironment: mocks.resolveEnvironment
}))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))

const {
  deleteRuntimeAiVaultSession,
  getSavedRuntimeAiVaultHostInfos,
  prepareRuntimeAiVaultSessionResume,
  scanRuntimeAiVaultSessions
} = await import('./runtime-session-scanner')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listEnvironments.mockReturnValue([])
  mocks.resolveEnvironment.mockImplementation(() => {
    throw new Error('not saved')
  })
  mocks.callRuntimeEnvironment.mockResolvedValue({
    ok: true,
    result: result([session('runtime:env-1', 'session-1')])
  })
})

describe('runtime AI Vault session scanner', () => {
  it('lists saved runtime environments as runtime execution hosts', () => {
    mocks.listEnvironments.mockReturnValue([
      { id: 'env-1', name: 'Server 1' },
      { id: 'env-2', name: 'Server 2', connectionDependency: 'ssh-tunnel' }
    ])

    expect(getSavedRuntimeAiVaultHostInfos('/user-data')).toEqual([
      { environmentId: 'env-1', executionHostId: 'runtime:env-1' },
      {
        environmentId: 'env-2',
        executionHostId: 'runtime:env-2',
        connectionDependency: 'ssh-tunnel'
      }
    ])
  })

  it('forwards scan options to the runtime transport', async () => {
    await scanRuntimeAiVaultSessions(
      '/user-data',
      'env-1',
      {
        limit: 25,
        force: true,
        scopePaths: ['/srv/app']
      },
      { timeoutMs: 3000 }
    )

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      {
        limit: 25,
        force: true,
        scopePaths: ['/srv/app'],
        paged: true,
        offset: 0,
        executionHostId: 'runtime:env-1'
      },
      3000
    )
  })

  it('caps forwarded project paths and reports scope truncation', async () => {
    const scopePaths = Array.from({ length: 80 }, (_, index) => `/srv/repo-${index}`)

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      scopePaths
    })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      expect.objectContaining({ scopePaths: scopePaths.slice(0, 64) }),
      undefined
    )
    expect(scanResult.issues).toContainEqual(
      expect.objectContaining({
        kind: 'scope',
        message: expect.stringContaining('first 64 project paths')
      })
    )
  })

  it('stamps sessions and issues returned for a different execution host', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: result(
        [session('local', 'session-1')],
        [
          {
            executionHostId: 'ssh:dev-box',
            agent: 'codex',
            path: '/sessions/session-1.jsonl',
            message: 'could not parse session'
          }
        ]
      )
    })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

    expect(scanResult.sessions).toEqual([
      expect.objectContaining({
        id: 'runtime:env-1:codex:session-1:/sessions/session-1.jsonl',
        executionHostId: 'runtime:env-1'
      })
    ])
    expect(scanResult.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'runtime:env-1',
        agent: 'codex',
        path: '/sessions/session-1.jsonl'
      })
    ])
  })

  it('keeps full old-server replies and accepts only a marker matching the sent fingerprint', async () => {
    const fingerprint = 'a'.repeat(64)
    const old = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      afterFingerprint: fingerprint
    })
    expect(old.sessions).toHaveLength(1)
    expect(old.unchanged).toBeUndefined()
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: {
        sessions: [],
        issues: [],
        scannedAt: 'fresh',
        fingerprint,
        unchanged: true
      }
    })
    expect(
      await scanRuntimeAiVaultSessions('/user-data', 'env-1', { afterFingerprint: fingerprint })
    ).toMatchObject({ fingerprint, unchanged: true, scannedAt: 'fresh' })
    const invalid = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      afterFingerprint: 'b'.repeat(64)
    })
    expect(invalid.unchanged).toBeUndefined()
    expect(invalid.issues[0]?.kind).toBe('host')
  })

  it('drains a paged host listing into one complete leg', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ...result([session('runtime:env-1', 'session-1')]),
          fingerprint: 'a'.repeat(64),
          hasMore: true,
          nextOffset: 1
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: result([session('runtime:env-1', 'session-2')])
      })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', { unlimited: true })

    expect(scanResult.sessions.map((row) => row.sessionId)).toEqual(['session-1', 'session-2'])
    expect(scanResult.fingerprint).toBe('a'.repeat(64))
    expect(scanResult.hasMore).toBeUndefined()
    expect(mocks.callRuntimeEnvironment).toHaveBeenNthCalledWith(
      2,
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      expect.objectContaining({ paged: true, offset: 1 }),
      undefined
    )
  })

  it('asks for the difference from the list this leg holds and retags the changed rows', async () => {
    const fingerprint = 'a'.repeat(64)
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: {
        sessions: [],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z',
        fingerprint: 'b'.repeat(64),
        syncDelta: {
          upserts: [session('local', 'session-2')],
          removedIds: ['runtime:env-1:codex:session-1:/sessions/session-1.jsonl']
        }
      }
    })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      syncFromFingerprint: fingerprint
    })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      expect.objectContaining({ syncFromFingerprint: fingerprint, offset: 0 }),
      undefined
    )
    expect(scanResult.sessions).toEqual([])
    expect(scanResult.syncDelta).toEqual({
      upserts: [
        expect.objectContaining({
          id: 'runtime:env-1:codex:session-2:/sessions/session-2.jsonl',
          executionHostId: 'runtime:env-1'
        })
      ],
      removedIds: ['runtime:env-1:codex:session-1:/sessions/session-1.jsonl']
    })
  })

  it('stops reading pages when its caller cancels', async () => {
    const controller = new AbortController()
    mocks.callRuntimeEnvironment.mockImplementationOnce(async () => {
      controller.abort()
      return {
        ok: true,
        result: {
          ...result([session('runtime:env-1', 'session-1')]),
          hasMore: true,
          nextOffset: 1
        }
      }
    })

    const scanResult = await scanRuntimeAiVaultSessions(
      '/user-data',
      'env-1',
      { unlimited: true },
      { signal: controller.signal }
    )

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(1)
    expect(scanResult.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    expect(scanResult.fingerprint).toBeUndefined()
  })

  it('drains within the drain budget even when each page outlives the page timeout', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      let page = 0
      mocks.callRuntimeEnvironment.mockImplementation(async () => {
        // Each page takes longer than one request's timeout; only the drain budget bounds them all.
        vi.setSystemTime(Date.now() + 2_000)
        page += 1
        return {
          ok: true,
          result:
            page < 3
              ? {
                  ...result([session('runtime:env-1', `session-${page}`)]),
                  hasMore: true,
                  nextOffset: page
                }
              : result([session('runtime:env-1', `session-${page}`)])
        }
      })

      const scanResult = await scanRuntimeAiVaultSessions(
        '/user-data',
        'env-1',
        { unlimited: true },
        {
          timeoutMs: 1_500,
          drainTimeoutMs: 10_000
        }
      )

      expect(scanResult.sessions.map((row) => row.sessionId)).toEqual([
        'session-1',
        'session-2',
        'session-3'
      ])
      expect(scanResult.issues).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports what it read once the drain budget itself runs out', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      let page = 0
      mocks.callRuntimeEnvironment.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 2_000)
        page += 1
        return {
          ok: true,
          result: {
            ...result([session('runtime:env-1', `session-${page}`)]),
            hasMore: true,
            nextOffset: page
          }
        }
      })

      const scanResult = await scanRuntimeAiVaultSessions(
        '/user-data',
        'env-1',
        { unlimited: true },
        {
          timeoutMs: 1_500,
          drainTimeoutMs: 3_000
        }
      )

      // Two pages fit the budget; the third would start after it.
      expect(scanResult.sessions.map((row) => row.sessionId)).toEqual(['session-1', 'session-2'])
      expect(scanResult.fingerprint).toBeUndefined()
      expect(scanResult.issues).toContainEqual(
        expect.objectContaining({ kind: 'host', message: expect.stringContaining('took too long') })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes its signal to the transport so a page in flight can be abandoned', async () => {
    const controller = new AbortController()
    await scanRuntimeAiVaultSessions('/user-data', 'env-1', {}, { signal: controller.signal })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      expect.anything(),
      undefined,
      undefined,
      undefined,
      { signal: controller.signal }
    )
  })

  it('keeps the fingerprint when a later page had to skip a row', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ...result([session('runtime:env-1', 'session-1')]),
          fingerprint: 'a'.repeat(64),
          hasMore: true,
          nextOffset: 1
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          // A row with a value this build does not know: it cannot be shown, but the rest can.
          sessions: [
            {
              ...session('runtime:env-1', 'session-2'),
              previewMessages: [{ role: 'future-role', text: 'x', timestamp: null }]
            }
          ],
          issues: [],
          scannedAt: '2026-07-27T00:00:00.000Z'
        }
      })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', { unlimited: true })

    expect(scanResult.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    // The skip row is the only sign a row is missing; the fingerprint still names the body so an
    // `unchanged` reply can be honoured (the leg declines to diff a body it could not fully read).
    expect(scanResult.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Skipped 1 invalid') })
    )
    expect(scanResult.fingerprint).toBe('a'.repeat(64))
  })

  it('keeps the rows already read when a later page fails', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ...result([session('runtime:env-1', 'session-1')]),
          hasMore: true,
          nextOffset: 1
        }
      })
      .mockResolvedValueOnce({ ok: false, error: { code: 'connection_lost', message: 'gone' } })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', { unlimited: true })

    expect(scanResult.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    expect(scanResult.issues).toContainEqual(
      expect.objectContaining({
        kind: 'host',
        executionHostId: 'runtime:env-1',
        message: 'Only part of the session list loaded. gone'
      })
    )
  })

  it('refuses a delta this request never asked for', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: {
        sessions: [],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z',
        syncDelta: { upserts: [session('local', 'session-2')], removedIds: [] }
      }
    })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

    expect(scanResult.sessions).toEqual([])
    expect(scanResult.issues[0]).toMatchObject({
      kind: 'host',
      message: 'Invalid aiVault.listSessions response: Unexpected session delta'
    })
  })

  it('prepares a resume on the transcript-owning runtime', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: { useRealCodexHome: true }
    })
    const args = {
      agent: 'codex' as const,
      filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'runtime:env-1' as const
    }

    await expect(prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', args)).resolves.toEqual({
      useRealCodexHome: true
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.prepareSessionResume',
      args
    )
  })

  it('keeps a repinned account home instead of stripping it', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: {
        useRealCodexHome: false,
        substituteCodexHome: '/data/orca/codex-accounts/account-2/home'
      }
    })

    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'codex',
        filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
        codexHome: '/managed',
        executionHostId: 'runtime:env-1'
      })
    ).resolves.toEqual({
      useRealCodexHome: false,
      substituteCodexHome: '/data/orca/codex-accounts/account-2/home'
    })
  })

  it.each([
    { agent: 'opencode' as const, sessionId: 'opencode-copy' },
    { agent: 'omp' as const, sessionId: 'omp-copy', filePath: '/pinned-omp/sessions/copy.jsonl' }
  ])(
    'preserves the $agent copy identity and transcript across the paired-host response',
    async (forkedSession) => {
      mocks.callRuntimeEnvironment.mockResolvedValueOnce({
        ok: true,
        result: { useRealCodexHome: false, forkedSession }
      })
      await expect(
        prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
          agent: forkedSession.agent === 'opencode' ? 'opencode2' : 'omp',
          sessionId: 'source',
          filePath: '/source',
          codexHome: null,
          executionHostId: 'runtime:env-1',
          fork: true
        })
      ).resolves.toEqual({ useRealCodexHome: false, forkedSession })
    }
  )

  it('fails retryably when runtime preparation returns an invalid result', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: {} })

    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'codex',
        filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
        codexHome: '/managed',
        executionHostId: 'runtime:env-1'
      })
    ).rejects.toThrow('Invalid aiVault.prepareSessionResume response')
  })

  it('emits the desktop sentinel only for this exact missing RPC', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: aiVault.prepareSessionResume' }
    })

    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'claude',
        filePath: '/sessions/a.jsonl',
        codexHome: null,
        executionHostId: 'runtime:env-1'
      })
    ).rejects.toThrow('aiVault.prepareSessionResume: method_not_found')

    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: terminal.send' }
    })
    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'claude',
        filePath: '/sessions/a.jsonl',
        codexHome: null,
        executionHostId: 'runtime:env-1'
      })
    ).rejects.toThrow('Unknown method: terminal.send')
  })
})

function result(
  sessions: AiVaultSession[],
  issues: AiVaultListResult['issues'] = []
): AiVaultListResult {
  return { sessions, issues, scannedAt: '2026-07-04T00:00:00.000Z' }
}

function session(
  executionHostId: AiVaultSession['executionHostId'],
  sessionId: string
): AiVaultSession {
  return {
    id: `${executionHostId}:codex:${sessionId}:/sessions/${sessionId}.jsonl`,
    executionHostId,
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/srv/app',
    branch: null,
    model: null,
    filePath: `/sessions/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-07-04T03:00:00.000Z',
    modifiedAt: '2026-07-04T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

describe('deleteRuntimeAiVaultSession', () => {
  const args = {
    agent: 'claude' as const,
    sessionId: 'session-1',
    filePath: '/home/ada/.claude/projects/-repo/session-1.jsonl',
    executionHostId: 'runtime:env-1' as const
  }

  it('sends only the row identity; the owning host validates the path', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: { outcome: 'deleted' } })

    await expect(deleteRuntimeAiVaultSession('/user-data', 'env-1', args)).resolves.toEqual({
      outcome: 'deleted'
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.deleteSession',
      { agent: 'claude', sessionId: 'session-1', filePath: args.filePath },
      undefined,
      undefined
    )
  })

  it('fences the delete to the pairing the user confirmed against', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: { outcome: 'deleted' } })

    await deleteRuntimeAiVaultSession('/user-data', 'env-1', {
      ...args,
      expectedEnvironmentPairingRevision: 7
    })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.deleteSession',
      { agent: 'claude', sessionId: 'session-1', filePath: args.filePath },
      undefined,
      7
    )
  })

  it('asks for a host update only when the host lacks this exact RPC', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: aiVault.deleteSession' }
    })
    await expect(deleteRuntimeAiVaultSession('/user-data', 'env-1', args)).resolves.toEqual({
      outcome: 'rejected',
      agent: 'claude',
      reason: 'host-update-required'
    })

    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: 'Remote Orca server is unavailable.' }
    })
    await expect(deleteRuntimeAiVaultSession('/user-data', 'env-1', args)).resolves.toEqual({
      outcome: 'failed',
      agent: 'claude',
      error: 'Remote Orca server is unavailable.'
    })
  })
})

describe('runtime row pairing stamp', () => {
  it("stamps rows with this desktop's pairing, never the host's own claim", async () => {
    mocks.resolveEnvironment.mockReturnValue({ id: 'env-1', createdAt: 1, pairingRevision: 9 })
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: result([{ ...session('runtime:env-1', 'session-1'), hostPairingRevision: 3 }])
    })

    const listed = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

    expect(listed.sessions.map((row) => row.hostPairingRevision)).toEqual([9])
  })
})
