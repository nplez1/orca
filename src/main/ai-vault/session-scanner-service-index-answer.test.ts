import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultServiceChildMessage,
  AiVaultServiceParentMessage
} from './session-scanner-service-protocol'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'

const scanAiVaultSessions = vi.hoisted(() => vi.fn())
const listSessions = vi.hoisted(() => vi.fn())

vi.mock('./session-scanner', () => ({ scanAiVaultSessions }))
vi.mock('./session-scanner-parse-cache', () => ({ invalidateSessionParseCacheEntry: vi.fn() }))
vi.mock('./session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist: vi.fn(async () => undefined),
  initSessionParseCachePersistence: vi.fn()
}))
vi.mock('./session-scanner-service-search', () => ({
  SessionScannerServiceSearch: class {
    handles(): boolean {
      return false
    }
    listSessions(...args: unknown[]): Promise<unknown> {
      return listSessions(...args)
    }
    close(): void {}
  }
}))

const indexedResult = {
  sessions: [
    {
      id: 'local:claude:s1:/transcripts/s1.jsonl',
      agent: 'claude' as const,
      sessionId: 's1',
      title: 'Indexed session',
      filePath: '/transcripts/s1.jsonl',
      scannedAt: '2026-09-15',
      cwd: '/repo'
    }
  ],
  issues: [],
  scannedAt: '2026-09-15'
}

const scannedResult = { sessions: [], issues: [], scannedAt: '2026-09-15' }

const sent: AiVaultServiceChildMessage[] = []
let restoreProcess = (): void => undefined

function emit(message: AiVaultServiceParentMessage): void {
  process.emit('message', message)
}

function scan(id: number, query?: string): void {
  emit({
    type: 'request',
    id,
    operation: 'scan',
    options: {},
    ...(query === undefined ? {} : { query })
  })
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function isResult(
  message: AiVaultServiceChildMessage
): message is Extract<AiVaultServiceChildMessage, { type: 'result' }> {
  return message.type === 'result'
}

function scanResponse(
  id: number
): Extract<AiVaultServiceChildMessage, { type: 'result' }> | undefined {
  const message = sent.find((candidate) => candidate.type === 'result' && candidate.id === id)
  return message && isResult(message) ? message : undefined
}

/** The `scan` value of a settled scan request, or null when it did not answer as one. */
function scanValue(id: number): { result: unknown; durationMs: number; work: unknown } | null {
  const message = scanResponse(id)
  return message?.operation === 'scan' ? message.value : null
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  sent.length = 0
  listSessions.mockResolvedValue(indexedResult)
  scanAiVaultSessions.mockResolvedValue(scannedResult)
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
  const disconnectDescriptor = Object.getOwnPropertyDescriptor(process, 'disconnect')
  const messageListeners = new Set(process.listeners('message'))
  const disconnectListeners = new Set(process.listeners('disconnect'))
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (message: AiVaultServiceChildMessage) => {
      sent.push(message)
      return true
    }
  })
  Object.defineProperty(process, 'disconnect', { configurable: true, value: vi.fn() })
  restoreProcess = () => {
    for (const listener of process.listeners('message')) {
      if (!messageListeners.has(listener)) {
        process.removeListener('message', listener)
      }
    }
    for (const listener of process.listeners('disconnect')) {
      if (!disconnectListeners.has(listener)) {
        process.removeListener('disconnect', listener)
      }
    }
    if (sendDescriptor) {
      Object.defineProperty(process, 'send', sendDescriptor)
    } else {
      Reflect.deleteProperty(process, 'send')
    }
    if (disconnectDescriptor) {
      Object.defineProperty(process, 'disconnect', disconnectDescriptor)
    } else {
      Reflect.deleteProperty(process, 'disconnect')
    }
  }
  await import('./session-scanner-service-entry')
  emit({
    type: 'init',
    protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
    sessionParseCache: null,
    sessionSearch: null
  })
})

afterEach(async () => {
  emit({ type: 'shutdown' })
  await settle()
  restoreProcess()
})

describe('AI Vault service scan answered from the session index', () => {
  it('lists from the index without scanning, and answers with no work tally', async () => {
    scan(1)
    await settle()

    // The fork's index-first rule: the scanner is the fallback, never a second pass.
    expect(scanAiVaultSessions).not.toHaveBeenCalled()
    expect(listSessions).toHaveBeenCalledWith({}, false, undefined)
    // `work: null` is what tells the window no scan ran, so its progress strip stays away
    // rather than publishing a finished row that would read "Scanned 0 files".
    expect(scanValue(1)).toMatchObject({ result: indexedResult, work: null })
  })

  it('passes the request query to the index, so a filtered list is filtered by the host', async () => {
    scan(2, 'needle')
    await settle()

    expect(listSessions).toHaveBeenCalledWith({}, false, 'needle')
  })

  it('falls back to the scanner when the index cannot answer, and reports its tally', async () => {
    listSessions.mockResolvedValueOnce(null)
    scan(3)
    await settle()

    expect(scanAiVaultSessions).toHaveBeenCalledTimes(1)
    const value = scanValue(3)
    expect(value?.result).toEqual(scannedResult)
    // A scan that ran always tallies, even when it finds nothing — the distinction the
    // index answer's null relies on.
    expect(value?.work).toEqual(expect.objectContaining({ agents: expect.any(Array) }))
  })
})
