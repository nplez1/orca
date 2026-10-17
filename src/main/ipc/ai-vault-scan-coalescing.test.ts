import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessionsInService: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  ipcHandle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: mocks.scanAiVaultSessionsInService,
  resolveAiVaultSessionTitlesInService: mocks.resolveAiVaultSessionTitlesInService
}))
vi.mock('../wsl', () => ({
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  hasCachedWslDistros: vi.fn(() => false)
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
}))
const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-27T00:00:00.000Z'
}

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanAiVaultSessionsInService.mockResolvedValue(EMPTY_RESULT)
  mocks.resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(EMPTY_RESULT)
})

describe('Agent Session History scan coalescing', () => {
  it('never shares a compact reply with a caller missing its exact baseline', async () => {
    registerRuntimeHost()
    const fingerprint = 'a'.repeat(64)
    mocks.scanRuntimeAiVaultSessions.mockImplementation(async (_host, args) => {
      await Promise.resolve()
      return args.afterFingerprint === fingerprint
        ? { ...EMPTY_RESULT, fingerprint, unchanged: true }
        : { ...EMPTY_RESULT, scannedAt: 'full' }
    })
    const [conditional, legacy] = await Promise.all([
      _internals.listAiVaultSessions({
        executionHostScope: 'runtime:remote-server',
        afterFingerprint: fingerprint
      }),
      _internals.listAiVaultSessions({ executionHostScope: 'runtime:remote-server' })
    ])
    expect(conditional.unchanged).toBe(true)
    expect(legacy.unchanged).toBeUndefined()
    expect(legacy.scannedAt).toBe('full')
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(2)
  })

  it('does not forward conditional hints into truncated all-host merges', async () => {
    registerRuntimeHost()
    await _internals.listAiVaultSessions({
      executionHostScope: 'all',
      afterFingerprint: 'a'.repeat(64)
    })
    expect(mocks.scanRuntimeAiVaultSessions.mock.calls[0]?.[1]).not.toHaveProperty(
      'afterFingerprint'
    )
  })

  it.each([
    ['local', mocks.scanAiVaultSessionsInService],
    ['runtime:remote-server', mocks.scanRuntimeAiVaultSessions]
  ] as const)('coalesces %s scans while isolating caller cancellation', async (scope, scan) => {
    let resolveScan: ((result: AiVaultListResult) => void) | undefined
    scan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        })
    )
    registerRuntimeHost()
    const firstController = new AbortController()
    const first = _internals.listAiVaultSessions(
      { executionHostScope: scope },
      { signal: firstController.signal }
    )
    const second = _internals.listAiVaultSessions({ executionHostScope: scope })
    await vi.waitFor(() => expect(resolveScan).toBeDefined())

    firstController.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(scan).toHaveBeenCalledTimes(1)
    resolveScan?.(EMPTY_RESULT)
    await expect(second).resolves.toMatchObject(EMPTY_RESULT)
  })

  it('reuses one unbounded host scan for a second project', async () => {
    registerRuntimeHost()
    await _internals.listAiVaultSessions({
      executionHostScope: 'runtime:remote-server',
      unlimited: true,
      scopePaths: ['/repo/app']
    })
    await _internals.listAiVaultSessions({
      executionHostScope: 'runtime:remote-server',
      unlimited: true,
      scopePaths: ['/repo/other']
    })
    // Switching project at Unlimited asks the same question, so it is one scan.
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(1)
  })

  it('keeps a bounded scan per project, whose answer does depend on the scope', async () => {
    registerRuntimeHost()
    for (const scopePath of ['/repo/app', '/repo/other']) {
      await _internals.listAiVaultSessions({
        executionHostScope: 'runtime:remote-server',
        limit: 250,
        scopePaths: [scopePath]
      })
    }
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(2)
  })

  it("keeps two host queries in two scans rather than sharing the first one's rows", async () => {
    registerRuntimeHost()
    const resolvers: ((result: AiVaultListResult) => void)[] = []
    mocks.scanAiVaultSessionsInService.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const alpha = _internals.listAiVaultSessions({ executionHostScope: 'local', query: 'alpha' })
    const beta = _internals.listAiVaultSessions({ executionHostScope: 'local', query: 'beta' })

    // The host answers a filtered request from a different row set, so two queries
    // are two scans: sharing one hands the second caller the first one's rows.
    await vi.waitFor(() => expect(resolvers).toHaveLength(2), { timeout: 2000 })
    resolvers[0]?.({ ...EMPTY_RESULT, sessions: [sessionRow('alpha-hit')] })
    resolvers[1]?.({ ...EMPTY_RESULT, sessions: [sessionRow('beta-hit')] })

    await expect(alpha).resolves.toMatchObject({ sessions: [{ sessionId: 'alpha-hit' }] })
    await expect(beta).resolves.toMatchObject({ sessions: [{ sessionId: 'beta-hit' }] })
  })

  it('joins an in-flight runtime scan when only the query changes', async () => {
    registerRuntimeHost()
    const resolvers: ((result: AiVaultListResult) => void)[] = []
    mocks.scanRuntimeAiVaultSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const alpha = _internals.listAiVaultSessions({
      executionHostScope: 'runtime:remote-server',
      query: 'alpha'
    })
    const beta = _internals.listAiVaultSessions({
      executionHostScope: 'runtime:remote-server',
      query: 'beta'
    })

    // No runtime RPC carries the query, so beta asks the same question while alpha's
    // transfer is still open: a query-keyed scan would send the whole table twice.
    await vi.waitFor(() => expect(resolvers).toHaveLength(1), { timeout: 2000 })
    resolvers[0]?.(EMPTY_RESULT)
    await Promise.all([alpha, beta])
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(1)
  })

  it('reports a failed local scan as a host issue rather than rejecting', async () => {
    mocks.scanAiVaultSessionsInService.mockRejectedValue(new Error('transcript root is unreadable'))
    registerAiVaultHandlers()
    const list = ipcHandler('aiVault:listSessions')

    // The local leg degrades like the SSH legs above: a rejection reaches the
    // renderer as a raw string painted over the list instead of an issue row.
    const result = await list(
      { sender: Object.assign(new EventEmitter(), { id: 1 }) },
      { executionHostScope: 'local', requestToken: 'scan' }
    )
    expect(result).toMatchObject({
      sessions: [],
      scanId: expect.any(String),
      issues: [expect.objectContaining({ message: 'transcript root is unreadable', kind: 'host' })]
    })
    expect(result).not.toHaveProperty('cancelled')
  })
})

function registerRuntimeHost(): void {
  registerAiVaultHandlers({
    getActiveRuntimeAiVaultHostInfos: () => [
      { environmentId: 'remote-server', executionHostId: 'runtime:remote-server' }
    ],
    scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
  })
}

function sessionRow(sessionId: string): AiVaultSession {
  return {
    id: `local:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-07-04T01:00:00.000Z',
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

function ipcHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = mocks.ipcHandle.mock.calls.find(([registered]) => registered === channel)
  if (!registration) {
    throw new Error(`${channel} was not registered`)
  }
  return registration[1]
}
