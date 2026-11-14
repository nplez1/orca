import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import {
  clearLocalWorkspacePathIndex,
  createLocalWorkspacePathIndexService
} from './workspace-path-index-runtime'

const electronMock = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>(() => '') }))
const captured = vi.hoisted(
  (): {
    service: { hasResidentGeneration: () => boolean } | null
    serviceOptions: { restoreCheckpoint?: (args: unknown) => Promise<unknown> } | null
    clientOptions: { keepAlive?: () => boolean } | null
    resident: boolean
  } => ({ service: null, serviceOptions: null, clientOptions: null, resident: false })
)

vi.mock('electron', () => ({ app: { getPath: electronMock.getPath } }))

vi.mock('./workspace-path-index-service', () => ({
  WorkspacePathIndexService: class FakeWorkspacePathIndexService {
    constructor(options: { restoreCheckpoint?: (args: unknown) => Promise<unknown> }) {
      captured.serviceOptions = options
      captured.service = this
    }
    hasResidentGeneration(): boolean {
      return captured.resident
    }
    dispose(): void {}
  }
}))

vi.mock('./workspace-path-index-worker-client', () => ({
  createDefaultWorkspacePathIndexWorker: () => {
    throw new Error('the wiring test never spawns a worker')
  },
  WorkspacePathIndexWorkerClient: class FakeWorkspacePathIndexWorkerClient {
    constructor(options: { keepAlive?: () => boolean }) {
      captured.clientOptions = options
    }
    discardOptionalStructures(): Promise<number> {
      return Promise.resolve(0)
    }
    restoreCheckpoint(): Promise<{ status: 'absent'; reason: string }> {
      return Promise.resolve({ status: 'absent', reason: 'absent' })
    }
  }
}))

// Why (issue #301): the hold only works if the client this runtime creates asks the service whether a
// published generation is resident. Deleting that one argument leaves every other test green.
describe('local workspace path index worker keepAlive wiring', () => {
  afterEach(() => {
    clearLocalWorkspacePathIndex()
  })

  it('asks the service whether a resident generation holds the worker', async () => {
    electronMock.getPath.mockReturnValue('/workspace/hold-user-data')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creating the service stores the Store handle and never reads a member here.
    const service = createLocalWorkspacePathIndexService({
      getSettings: () => ({})
    } as unknown as Store)

    await captured.serviceOptions?.restoreCheckpoint?.({
      owner: {
        executionHost: { provider: 'local', incarnationId: '1' },
        authorizedCanonicalRoot: '/workspace/hold'
      },
      entryKey: 'entry'
    })
    const keepAlive = captured.clientOptions?.keepAlive
    expect(keepAlive).toBeTypeOf('function')

    captured.resident = true
    expect(keepAlive?.()).toBe(true)
    expect(captured.service).toBe(service)

    // Nothing resident, and then no service at all: the worker must not be held forever.
    captured.resident = false
    expect(keepAlive?.()).toBe(false)
    captured.resident = true
    clearLocalWorkspacePathIndex()
    expect(keepAlive?.()).toBe(false)
  })
})
