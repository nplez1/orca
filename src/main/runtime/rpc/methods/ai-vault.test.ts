import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeAiVaultCommands } from '../../runtime-ai-vault-commands'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultServiceScanOptions } from '../../../ai-vault/session-scanner-service-protocol'
import {
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'

const { scanAiVaultSessionsInService, resolveAiVaultSessionTitlesInService } = vi.hoisted(() => ({
  scanAiVaultSessionsInService:
    vi.fn<
      (options: AiVaultServiceScanOptions, signal?: AbortSignal) => Promise<AiVaultListResult>
    >(),
  resolveAiVaultSessionTitlesInService: vi.fn()
}))

vi.mock('../../../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService,
  resolveAiVaultSessionTitlesInService
}))

import {
  AI_VAULT_METHODS,
  AiVaultListSessionsParams,
  AiVaultPrepareSessionResumeParams
} from './ai-vault'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { recordStructuredAgentSessionHostInstallRefusal } from '../../structured-agent-session-host-refusal'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { installCopyingChat } from '../../../ai-vault/structured-session-ownership.test-support'
import { resetAiVaultListSyncStoreForTests } from '../../../ai-vault/ai-vault-list-sync-store'
import { parseAiVaultListResult } from '../../../ai-vault/session-list-result-validation'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from '../../../ai-vault/cached-session-list'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const SCANNED_AT = '2026-06-29T00:00:00.000Z'

function makeResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: SCANNED_AT }
}

function makeSession(): AiVaultSession {
  return {
    id: 'local:claude:sess-1:/tmp/t.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'sess-1',
    title: 'Test session',
    cwd: '/tmp',
    branch: null,
    model: null,
    filePath: '/tmp/t.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: SCANNED_AT,
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume sess-1',
    subagent: null
  }
}

function makeDispatcher(): RpcDispatcher {
  // Exercise the same shared vault cache used by desktop IPC.
  const vault = new RuntimeAiVaultCommands(() => null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only these three runtime members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    listAiVaultSessions: vault.list.bind(vault),
    resolveAiVaultSessionTitles: (requests: unknown[], signal?: AbortSignal) =>
      resolveAiVaultSessionTitlesInService(requests, signal)
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

function makeFailingDispatcher(error: Error): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    listAiVaultSessions: vi.fn().mockRejectedValue(error)
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

describe('aiVault.resolveSessionTitles handler', () => {
  beforeEach(() => {
    resolveAiVaultSessionTitlesInService.mockReset()
  })

  it('advertises and routes the bounded exact-title capability', async () => {
    resolveAiVaultSessionTitlesInService.mockResolvedValue({
      titles: [{ agent: 'codex', sessionId: 'session-1', title: 'Exact title' }]
    })
    const dispatcher = makeDispatcher()
    const requests = [
      { agent: 'codex', sessionId: 'session-1', transcriptPath: '/tmp/session.jsonl' }
    ]

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.resolveSessionTitles', { requests }))
    ).resolves.toMatchObject({
      ok: true,
      result: { titles: [{ sessionId: 'session-1', title: 'Exact title' }] }
    })
    expect(resolveAiVaultSessionTitlesInService).toHaveBeenCalledWith(requests, undefined)
    expect(RUNTIME_CAPABILITIES).toContain(AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY)
  })

  it('forwards transport cancellation to the background scanner', async () => {
    resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
    const dispatcher = makeDispatcher()
    const controller = new AbortController()
    const requests = [{ agent: 'codex', sessionId: 'session-1' }]

    await dispatcher.dispatch(makeRequest('aiVault.resolveSessionTitles', { requests }), {
      signal: controller.signal
    })

    expect(resolveAiVaultSessionTitlesInService).toHaveBeenCalledWith(requests, controller.signal)
  })

  it('rejects more than 64 title identities before reaching the host', async () => {
    const dispatcher = makeDispatcher()
    const requests = Array.from({ length: 65 }, (_, index) => ({
      agent: 'codex',
      sessionId: `session-${index}`
    }))

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.resolveSessionTitles', { requests }))
    ).resolves.toMatchObject({ ok: false })
    expect(resolveAiVaultSessionTitlesInService).not.toHaveBeenCalled()
  })
})

describe('aiVault.listSessions params schema', () => {
  it('accepts a bounded request', () => {
    const parsed = AiVaultListSessionsParams.safeParse({
      limit: 500,
      force: true,
      scopePaths: ['/home/user/repo']
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a limit above the cap', () => {
    const parsed = AiVaultListSessionsParams.safeParse({ limit: 5000 })
    expect(parsed.success).toBe(false)
  })

  it('accepts Unlimited without applying the numeric cap', () => {
    const parsed = AiVaultListSessionsParams.safeParse({ limit: 5000, unlimited: true })
    expect(parsed.success).toBe(true)
  })

  it('clamps scopePaths past the cap instead of rejecting', () => {
    // Older/web producers may exceed this bound; truncation only narrows optional discovery paths.
    const scopePaths = Array.from({ length: 65 }, (_, index) => `/p/${index}`)
    const parsed = AiVaultListSessionsParams.safeParse({ scopePaths })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.scopePaths).toEqual(scopePaths.slice(0, 64))
  })

  it('rejects an over-long scopePath', () => {
    const parsed = AiVaultListSessionsParams.safeParse({ scopePaths: ['/'.padEnd(5000, 'a')] })
    expect(parsed.success).toBe(false)
  })

  it('rejects an offset a page loop cannot follow instead of coercing it to page 0', () => {
    expect(AiVaultListSessionsParams.safeParse({ offset: -1 }).success).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ offset: 1.5 }).success).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ offset: 1_000_001 }).success).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ offset: 2 }).success).toBe(true)
  })

  it('rejects non-runtime execution host ids before dispatch', () => {
    expect(
      AiVaultListSessionsParams.safeParse({ executionHostId: 'not-a-runtime-host' }).success
    ).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ executionHostId: 'local' }).success).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ executionHostId: 'ssh:dev-box' }).success).toBe(
      false
    )
  })
})

describe('aiVault.prepareSessionResume', () => {
  it('validates bounded paths and executes against the receiving host identity', async () => {
    expect(
      AiVaultPrepareSessionResumeParams.safeParse({
        agent: 'codex',
        filePath: '/managed/sessions/rollout-a.jsonl',
        codexHome: '/managed'
      }).success
    ).toBe(true)
    const prepareAiVaultSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      prepareAiVaultSessionResume
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('aiVault.prepareSessionResume', {
        agent: 'codex',
        filePath: '/managed/sessions/rollout-a.jsonl',
        codexHome: '/managed',
        executionHostId: 'ssh:spoofed'
      })
    )

    expect(response).toMatchObject({ ok: true, result: { useRealCodexHome: true } })
    expect(prepareAiVaultSessionResume).toHaveBeenCalledWith({
      agent: 'codex',
      filePath: '/managed/sessions/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'local'
    })
  })

  it('carries a fork request through to the host preparation', async () => {
    const prepareAiVaultSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      prepareAiVaultSessionResume
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })

    await dispatcher.dispatch(
      makeRequest('aiVault.prepareSessionResume', {
        agent: 'codex',
        filePath: '/managed/sessions/rollout-a.jsonl',
        codexHome: '/managed',
        fork: true
      })
    )

    expect(prepareAiVaultSessionResume).toHaveBeenCalledWith(
      expect.objectContaining({ fork: true, executionHostId: 'local' })
    )
  })
})

describe('aiVault.prepareSessionResume for a chat whose host makes the copy', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it("has the server's chat copy an OMP conversation and answers the copy", async () => {
    const providerSessionId = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'
    const copy = vi.fn(async () => ({
      sessionId: 'copy-1',
      filePath: '/sessions/copy-1.jsonl'
    }))
    installCopyingChat({ transport: 'acp', agent: 'omp', nativeId: providerSessionId }, copy)
    const prepareAiVaultSessionResume = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      prepareAiVaultSessionResume
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('aiVault.prepareSessionResume', {
        agent: 'omp',
        sessionId: providerSessionId,
        filePath: `/home/me/.omp/agent/sessions/--repo--/x_${providerSessionId}.jsonl`,
        codexHome: null,
        fork: true
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        useRealCodexHome: false,
        forkedSession: {
          sessionId: 'copy-1',
          filePath: '/sessions/copy-1.jsonl',
          agent: 'omp'
        }
      }
    })
    expect(copy).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId }))
    expect(prepareAiVaultSessionResume).not.toHaveBeenCalled()
  })
})

// Chat-host refusal must not disable transcript history or terminal resume; other host failures still propagate.
describe('aiVault methods without a structured host', () => {
  const refusal = agentSessionRefusalError(
    'agent_session_journal_unreadable',
    { reason: 'journalCorrupt' },
    'Unable to load this chat.'
  )

  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockReset()
    scanAiVaultSessionsInService.mockResolvedValue(makeResult())
    recordStructuredAgentSessionHostInstallRefusal(refusal)
  })

  afterEach(() => {
    recordStructuredAgentSessionHostInstallRefusal(null)
    resetAiVaultSessionListCacheForTests()
  })

  function refusedDispatcher(installError: Error): RpcDispatcher {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two aiVault handlers read only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn().mockRejectedValue(installError),
      listAiVaultSessions: (
        args?: Parameters<typeof listAiVaultSessions>[0],
        signal?: AbortSignal
      ) => listAiVaultSessions(args, { signal }),
      prepareAiVaultSessionResume: vi.fn().mockResolvedValue({ useRealCodexHome: true })
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
  }

  it('lists and prepares a resume while chats are refused', async () => {
    const dispatcher = refusedDispatcher(refusal)

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({ ok: true, result: makeResult() })
    await expect(
      dispatcher.dispatch(
        makeRequest('aiVault.prepareSessionResume', {
          agent: 'codex',
          filePath: '/managed/sessions/rollout-a.jsonl',
          codexHome: '/managed'
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { useRealCodexHome: true } })
  })

  it('still fails on a host error that refuses nothing', async () => {
    const dispatcher = refusedDispatcher(new Error('the record store would not open'))

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({ ok: false })
  })
})

describe('aiVault.listSessions handler + shared cache', () => {
  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockReset()
    scanAiVaultSessionsInService.mockResolvedValue(makeResult())
    resolveAiVaultSessionTitlesInService.mockReset()
    resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  })

  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
  })

  it('aborts the host scan when its last RPC caller disconnects', async () => {
    scanAiVaultSessionsInService.mockImplementation(
      (_options, signal) =>
        new Promise<AiVaultListResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('scan aborted')), { once: true })
        })
    )
    const dispatcher = makeDispatcher()
    const caller = new AbortController()
    const response = dispatcher.dispatch(makeRequest('aiVault.listSessions', {}), {
      signal: caller.signal
    })
    await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledOnce())
    const scanSignal = scanAiVaultSessionsInService.mock.calls[0]?.[1]

    caller.abort()

    expect(scanSignal?.aborted).toBe(true)
    await expect(response).resolves.toMatchObject({ ok: false })
  })

  it('isolates IDE opt-in scans from legacy clients sharing the host cache', async () => {
    const dispatcher = makeDispatcher()
    await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { includeAntigravityIdeSessions: true })
    )
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      includeAntigravityIdeSessions: true
    })
    expect(scanAiVaultSessionsInService.mock.calls[1]?.[0]?.includeAntigravityIdeSessions).not.toBe(
      true
    )
  })

  it('omits unchanged session bodies only for clients with the matching fingerprint', async () => {
    const dispatcher = makeDispatcher()
    const first = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { afterFingerprint: null })
    )
    if (
      !first.ok ||
      typeof first.result !== 'object' ||
      first.result === null ||
      !('fingerprint' in first.result) ||
      typeof first.result.fingerprint !== 'string'
    ) {
      throw new Error('Opt-in response did not include a fingerprint')
    }
    const afterFingerprint = first.result.fingerprint
    expect(afterFingerprint).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { afterFingerprint }))
    ).resolves.toMatchObject({
      ok: true,
      result: { unchanged: true, fingerprint: afterFingerprint }
    })
    const legacy = await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    expect(legacy).toMatchObject({ ok: true, result: makeResult() })
    if (legacy.ok) {
      expect(legacy.result).not.toHaveProperty('fingerprint')
    }
  })

  it('keeps unlimited history un-hashed and full even with an opt-in request', async () => {
    const dispatcher = makeDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        unlimited: true,
        afterFingerprint: null
      })
    )
    expect(response).toMatchObject({ ok: true, result: makeResult() })
    if (response.ok) {
      expect(response.result).not.toHaveProperty('fingerprint')
      expect(response.result).not.toHaveProperty('unchanged')
    }
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({ unlimited: true })
  })

  it('fingerprints live projected content even when the cached scan stamp does not change', async () => {
    const source = { ...makeResult(), sessions: [makeSession()] }
    scanAiVaultSessionsInService.mockResolvedValue(source)
    const dispatcher = makeDispatcher()
    const first = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { afterFingerprint: null })
    )
    if (
      !first.ok ||
      typeof first.result !== 'object' ||
      first.result === null ||
      !('fingerprint' in first.result) ||
      typeof first.result.fingerprint !== 'string'
    ) {
      throw new Error('Expected fingerprint')
    }
    source.sessions[0].title = 'Changed without a new scan stamp'
    const changed = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        afterFingerprint: first.result.fingerprint
      })
    )
    expect(changed).toMatchObject({
      ok: true,
      result: {
        sessions: [{ title: 'Changed without a new scan stamp' }],
        scannedAt: SCANNED_AT
      }
    })
    if (changed.ok) {
      expect(changed.result).not.toHaveProperty('unchanged')
      expect(changed.result).not.toMatchObject({ fingerprint: first.result.fingerprint })
    }
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    const forced = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        afterFingerprint: first.result.fingerprint,
        force: true
      })
    )
    expect(forced.ok).toBe(true)
    if (forced.ok) {
      expect(forced.result).not.toHaveProperty('unchanged')
    }
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
  })

  it('returns the AiVaultListResult unchanged', async () => {
    const dispatcher = makeDispatcher()
    const response = await dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    expect(response).toMatchObject({ ok: true, result: makeResult() })
  })

  it('humanizes scanner supervision errors for remote clients', async () => {
    const dispatcher = makeFailingDispatcher(new Error('AI Vault service restart circuit is open.'))

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'Session scanning paused after repeated failures. Refresh to try again.' }
    })
  })

  it('preserves structured runtime error metadata while humanizing its message', async () => {
    const error = Object.assign(new Error('AI Vault service restart circuit is open.'), {
      code: 'runtime_timeout',
      data: { retryAfterMs: 5000 }
    })
    const dispatcher = makeFailingDispatcher(error)

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'runtime_timeout',
        message: 'Session scanning paused after repeated failures. Refresh to try again.',
        data: { retryAfterMs: 5000 }
      }
    })
  })

  it('passes only the first 64 scopePaths to the scanner when a request exceeds the cap', async () => {
    const dispatcher = makeDispatcher()
    const scopePaths = Array.from({ length: 65 }, (_, index) => `/p/${index}`)
    const response = await dispatcher.dispatch(makeRequest('aiVault.listSessions', { scopePaths }))
    expect(response).toMatchObject({ ok: true })
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      scopePaths: scopePaths.slice(0, 64)
    })
  })

  it('shares one cache between the IPC entry point and the RPC method', async () => {
    const dispatcher = makeDispatcher()
    await listAiVaultSessions({ limit: 500 })
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
  })

  it('keeps completed scans cached for one minute', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-05T00:00:00.000Z') })
    try {
      await listAiVaultSessions({ limit: 500 })
      await vi.advanceTimersByTimeAsync(59_999)
      await listAiVaultSessions({ limit: 500 })
      expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await listAiVaultSessions({ limit: 500 })
      expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves lower depths from a larger completed scan', async () => {
    await listAiVaultSessions({ limit: 1000 })
    await listAiVaultSessions({ limit: 250 })
    await listAiVaultSessions({ limit: 500 })

    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
  })

  it('shares a cache entry across equivalent scope path ordering', async () => {
    await listAiVaultSessions({ limit: 500, scopePaths: ['/repo/a', '/repo/b'] })
    await listAiVaultSessions({ limit: 500, scopePaths: ['/repo/b', '/repo/a'] })

    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
  })

  it('forwards Unlimited without a numeric limit', async () => {
    const dispatcher = makeDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { limit: 5000, unlimited: true })
    )

    expect(response).toMatchObject({ ok: true })
    expect(scanAiVaultSessionsInService).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined, unlimited: true }),
      expect.any(AbortSignal),
      // The fork's third argument: no refresh or query for a plain listing.
      {},
      expect.objectContaining({ work: expect.any(Function) })
    )
  })

  it('keeps a newer different-key scan dedupable after an older scan resolves', async () => {
    // A completed scan must not clear a different pending key and permit duplicate work.
    const deferreds: ((result: AiVaultListResult) => void)[] = []
    scanAiVaultSessionsInService.mockImplementation(
      () => new Promise<AiVaultListResult>((resolve) => deferreds.push(resolve))
    )
    // WSL-home resolution defers scanner invocation; wait for registration before resolving scans.
    const scanA = listAiVaultSessions({ limit: 100 })
    await vi.waitFor(() => expect(deferreds).toHaveLength(1))
    const scanB = listAiVaultSessions({ limit: 200 })
    await vi.waitFor(() => expect(deferreds).toHaveLength(2))
    deferreds[0]?.(makeResult())
    await scanA
    const scanBAgain = listAiVaultSessions({ limit: 200 })
    // Flush a macrotask so an erroneous duplicate scan reaches the mock; assert the call count instead of hanging on its unresolved promise.
    await new Promise((resolve) => setTimeout(resolve))
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    deferreds[1]?.(makeResult())
    await Promise.all([scanB, scanBAgain])
  })

  it('restamps the shared cached result as the addressed runtime host', async () => {
    scanAiVaultSessionsInService.mockResolvedValue({
      sessions: [makeSession()],
      issues: [{ executionHostId: 'local', agent: 'claude', path: '/tmp', message: 'boom' }],
      scannedAt: SCANNED_AT
    })
    const dispatcher = makeDispatcher()
    const localResponse = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { limit: 500 })
    )) as { ok: boolean; result: AiVaultListResult }
    const runtimeResponse = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        limit: 500,
        executionHostId: 'runtime:remote-server'
      })
    )) as { ok: boolean; result: AiVaultListResult }

    // Host identity changes response stamps, never host-local scan/cache identity.
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      executionHostId: 'local'
    })

    expect(localResponse.result.sessions[0]?.executionHostId).toBe('local')
    expect(runtimeResponse.result.sessions[0]?.executionHostId).toBe('runtime:remote-server')
    expect(runtimeResponse.result.sessions[0]?.id).toBe(
      'runtime:remote-server:claude:sess-1:/tmp/t.jsonl'
    )
    expect(runtimeResponse.result.issues[0]?.executionHostId).toBe('runtime:remote-server')
  })

  it('injects codex-home dirs sourced from the runtime (serve-mode reachable)', async () => {
    configureAiVaultSessionSources({
      getAdditionalCodexHomePaths: () => ['/runtime/codex/home']
    })
    const dispatcher = makeDispatcher()
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    const options = scanAiVaultSessionsInService.mock.calls[0]?.[0]
    // Serve mode must source Codex homes from runtime, without window-only handler registration.
    expect(options?.additionalCodexSessionsDirs).toContain('/runtime/codex/home/sessions')
    expect(options?.wslHomeDirs).toEqual([])
  })

  it('forwards codex-home through the real OrcaRuntimeService construction path', async () => {
    // Use a real runtime to prove constructor-to-cache forwarding; directly seeding cache would miss a broken link.
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAdditionalAiVaultCodexHomePaths: () => ['/ctor/codex/home']
    })
    await runtime.listAiVaultSessions({})
    const options = scanAiVaultSessionsInService.mock.calls[0]?.[0]
    expect(options?.additionalCodexSessionsDirs).toContain('/ctor/codex/home/sessions')
  })
})

describe('aiVault.listSessions paging and change sync', () => {
  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetAiVaultListSyncStoreForTests()
    scanAiVaultSessionsInService.mockReset()
    resolveAiVaultSessionTitlesInService.mockReset()
    resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  })

  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetAiVaultListSyncStoreForTests()
  })

  it('answers a long history with byte-bounded pages the client can drain', async () => {
    const sessions = Array.from({ length: 5 }, (_, index) =>
      largeSession(`sess-${index}`, 600 * 1024)
    )
    scanAiVaultSessionsInService.mockResolvedValue(listOf(sessions))
    const dispatcher = makeDispatcher()

    const first = await listResult(dispatcher, { paged: true, unlimited: true })
    expect(first.sessions.length).toBeGreaterThan(0)
    expect(first.sessions.length).toBeLessThan(sessions.length)
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(first.sessions.length)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Why: the whole reply, not just the content budget, has to fit one encrypted frame.
    expect(Buffer.byteLength(JSON.stringify({ result: first }), 'utf8')).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )

    const second = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      offset: first.nextOffset
    })
    expect(second.hasMore).toBeUndefined()
    expect(second.fingerprint).toBeUndefined()
    expect([...first.sessions, ...second.sessions].map((row) => row.sessionId)).toEqual(
      sessions.map((row) => row.sessionId)
    )
  })

  it('keeps a client that predates paging on one complete reply', async () => {
    const sessions = [makeSession(), largeSession('sess-big', 600 * 1024)]
    scanAiVaultSessionsInService.mockResolvedValue(listOf(sessions))
    const result = await listResult(makeDispatcher(), { unlimited: true })

    expect(result.sessions).toHaveLength(2)
    expect(result.hasMore).toBeUndefined()
    expect(result.fingerprint).toBeUndefined()
  })

  it('sends only the changed rows and removed ids when the client names the list it holds', async () => {
    const held = [makeSession(), session('sess-b', 'kept'), session('sess-c', 'dropped')]
    scanAiVaultSessionsInService.mockResolvedValue(listOf(held))
    const dispatcher = makeDispatcher()
    const first = await listResult(dispatcher, { paged: true, unlimited: true })
    if (!first.fingerprint) {
      throw new Error('Paged reply carried no fingerprint')
    }

    // A new scan: one row changed, one dropped, one added.
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockResolvedValue(
      listOf([session('sess-b', 'kept'), session('sess-c', 'changed'), session('sess-d', 'added')])
    )
    const synced = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      syncFromFingerprint: first.fingerprint
    })

    expect(synced.sessions).toEqual([])
    expect(synced.fingerprint).not.toBe(first.fingerprint)
    expect(synced.syncDelta?.removedIds).toEqual([held[0]!.id])
    expect(synced.syncDelta?.upserts.map((row) => row.sessionId)).toEqual(['sess-c', 'sess-d'])
  })

  it('answers an unchanged list with an empty delta rather than a body the retry cannot use', async () => {
    scanAiVaultSessionsInService.mockResolvedValue(listOf([makeSession()]))
    const dispatcher = makeDispatcher()
    const first = await listResult(dispatcher, { paged: true, unlimited: true })
    const synced = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      syncFromFingerprint: first.fingerprint
    })

    expect(synced.unchanged).toBeUndefined()
    expect(synced.syncDelta).toEqual({ upserts: [], removedIds: [] })
    expect(synced.fingerprint).toBe(first.fingerprint)
  })

  it('falls back to a full page when the fingerprint was never retained', async () => {
    scanAiVaultSessionsInService.mockResolvedValue(listOf([makeSession()]))
    const result = await listResult(makeDispatcher(), {
      paged: true,
      unlimited: true,
      syncFromFingerprint: 'b'.repeat(64)
    })

    expect(result.syncDelta).toBeUndefined()
    expect(result.sessions).toHaveLength(1)
  })

  it('answers the legacy fingerprint question with unchanged on the paged path', async () => {
    scanAiVaultSessionsInService.mockResolvedValue(listOf([makeSession()]))
    const dispatcher = makeDispatcher()
    const first = await listResult(dispatcher, { paged: true, afterFingerprint: null })
    const second = await listResult(dispatcher, {
      paged: true,
      afterFingerprint: first.fingerprint
    })

    expect(second).toMatchObject({
      unchanged: true,
      sessions: [],
      fingerprint: first.fingerprint
    })
  })

  it('answers a forced refresh with a diff, but never with unchanged', async () => {
    scanAiVaultSessionsInService.mockResolvedValue(listOf([makeSession()]))
    const dispatcher = makeDispatcher()
    const first = await listResult(dispatcher, { paged: true, unlimited: true })

    // Forcing means "rescan the host". The diff is computed against that fresh scan, so a routine
    // forced refresh — a delete, a new session, the Refresh button — stays cheap.
    const forced = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      force: true,
      syncFromFingerprint: first.fingerprint
    })
    expect(forced.unchanged).toBeUndefined()
    expect(forced.syncDelta).toEqual({ upserts: [], removedIds: [] })

    // `unchanged` is still refused, so a forced refresh always carries a body to paint.
    const forcedWithoutToken = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      force: true,
      afterFingerprint: first.fingerprint
    })
    expect(forcedWithoutToken.unchanged).toBeUndefined()
    expect(forcedWithoutToken.syncDelta).toBeUndefined()
    expect(forcedWithoutToken.sessions).toHaveLength(1)
  })

  it('names the served rows with the page token, across pages and across rescans', async () => {
    const sessions = Array.from({ length: 3 }, (_, index) =>
      largeSession(`sess-${index}`, 600 * 1024)
    )
    scanAiVaultSessionsInService.mockResolvedValue(listOf(sessions))
    const dispatcher = makeDispatcher()
    const first = await listResult(dispatcher, { paged: true, unlimited: true })
    const second = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      offset: first.nextOffset
    })

    expect(first.listToken).toMatch(/^[0-9a-f]{64}$/)
    expect(second.listToken).toBe(first.listToken)

    // Why a rescan must keep the token: a drain slower than the host's scan cache outlives it, and
    // restarting on an unchanged rescan would leave a long history unable to finish loading.
    resetAiVaultSessionListCacheForTests()
    const rescanned = await listResult(dispatcher, { paged: true, unlimited: true })
    expect(rescanned.listToken).toBe(first.listToken)

    // A served row that is gone is a different list, so its pages cannot be mixed.
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockResolvedValue(listOf(sessions.slice(0, 2)))
    const shrunk = await listResult(dispatcher, { paged: true, unlimited: true })
    expect(shrunk.listToken).not.toBe(first.listToken)
  })

  it('prefers a full page over a delta too large for one reply', async () => {
    const small = listOf([makeSession()])
    scanAiVaultSessionsInService.mockResolvedValue(small)
    const dispatcher = makeDispatcher()
    const first = await listResult(dispatcher, { paged: true, unlimited: true })

    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockResolvedValue(
      listOf([makeSession(), largeSession('sess-huge', 3 * 1024 * 1024)])
    )
    const synced = await listResult(dispatcher, {
      paged: true,
      unlimited: true,
      syncFromFingerprint: first.fingerprint
    })

    expect(synced.syncDelta).toBeUndefined()
    expect(synced.sessions.map((row) => row.sessionId)).toEqual(['sess-1'])
  })
})

function listOf(sessions: readonly AiVaultSession[]): AiVaultListResult {
  return { sessions: [...sessions], issues: [], scannedAt: SCANNED_AT }
}

function session(sessionId: string, title = sessionId): AiVaultSession {
  return {
    ...makeSession(),
    id: `local:claude:${sessionId}:/tmp/${sessionId}.jsonl`,
    sessionId,
    title
  }
}

function largeSession(sessionId: string, previewBytes: number): AiVaultSession {
  return {
    ...session(sessionId),
    previewMessages: [{ role: 'user', text: 'x'.repeat(previewBytes), timestamp: null }]
  }
}

async function listResult(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>
): Promise<AiVaultListResult> {
  const response = await dispatcher.dispatch(makeRequest('aiVault.listSessions', params))
  if (!response.ok) {
    throw new Error(`listSessions failed: ${response.error.message}`)
  }
  // Parsed with the wire's own reader, so every assertion here also proves the reply is shippable.
  return parseAiVaultListResult(response.result)
}
