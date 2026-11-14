import type { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity
} from '../../shared/workspace-path-search-contract'
import { createCompleteWorkspacePathSearchResponse } from '../../shared/workspace-path-search-response'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'
import type { WorkspacePathIndexWorkerRequest } from './workspace-path-index-worker-protocol'

const OWNER: WorkspacePathSearchOwnerIdentity = {
  executionHost: { provider: 'local', incarnationId: 'hold-host' },
  authorizedCanonicalRoot: '/workspace/hold'
}
const IDLE_TEARDOWN_MS = 5 * 60_000
const GENERATION_ID = 'restored-generation'

function identity(sequence: number): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId: 'hold-window', sequence },
    owner: OWNER,
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'included',
      includeDotfiles: false,
      includeIgnoredFiles: false,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 10, maxSerializedBytes: 10_000 }
  }
}

/** Answers the worker requests the client sends, holding one restored generation. */
class FakeWorker {
  terminated = false
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: WorkspacePathIndexWorkerRequest): void {
    const response = respond(request)
    queueMicrotask(() => {
      for (const listener of Array.from(this.listeners.get('message') ?? [])) {
        listener(response)
      }
    })
  }
}

function respond(request: WorkspacePathIndexWorkerRequest): unknown {
  if (request.type === 'restore-checkpoint') {
    return {
      id: request.id,
      ok: true,
      checkpoint: {
        status: 'restored',
        generationId: GENERATION_ID,
        publishedScope: 'both',
        retainedBytes: 64,
        pathCount: 1,
        loadMilliseconds: 1,
        directoryValidationMilliseconds: 0
      }
    }
  }
  if (request.type === 'query') {
    return {
      id: request.id,
      ok: true,
      response: createCompleteWorkspacePathSearchResponse({
        requestIdentity: request.identity,
        paths: ['src/hold.ts'],
        totalCount: 1,
        generationId: request.identity.generationId ?? GENERATION_ID
      })
    }
  }
  return { id: request.id, ok: true }
}

function createHoldingService(workers: FakeWorker[]): {
  service: WorkspacePathIndexService
  client: WorkspacePathIndexWorkerClient
} {
  let service: WorkspacePathIndexService | undefined
  const client: WorkspacePathIndexWorkerClient = new WorkspacePathIndexWorkerClient({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeWorker implements every Worker member the host touches (on/off/removeAllListeners/unref/terminate/postMessage).
    workerFactory: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
    log: () => {},
    // The wiring under test, expressed as the runtime expresses it.
    keepAlive: () => service?.hasResidentGeneration() ?? false
  })
  service = new WorkspacePathIndexService({
    authorize: async (owner) => owner.authorizedCanonicalRoot,
    // Never settles: a reconciled build would replace the generation this test holds.
    build: () => new Promise<never>(() => {}),
    query: (request) => client.query(request.key, request.identity, request.correlationId),
    restoreCheckpoint: async (args) => {
      const outcome = await client.restoreCheckpoint({
        key: args.entryKey,
        checkpointDirectory: '/workspace/hold-checkpoints'
      })
      return outcome.status === 'restored'
        ? {
            generationId: outcome.generationId,
            publishedScope: outcome.publishedScope,
            retainedBytes: outcome.retainedBytes,
            loadMilliseconds: outcome.loadMilliseconds
          }
        : null
    }
  })
  return { service, client }
}

function search(service: WorkspacePathIndexService, sequence: number) {
  return service.search({
    identity: identity(sequence),
    listingPolicyVersion: 'listing-v1',
    foldVersion: 'fold-v1',
    buildReservationBytes: 256,
    correlationId: '123e4567-e89b-42d3-a456-426614174301'
  })
}

describe('WorkspacePathIndexService worker hold', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Issue #301 "Done when": publish a generation, advance past the idle teardown, then search.
  it('answers a search after the idle window because a resident generation holds the worker', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const { service, client } = createHoldingService(workers)

    expect(service.hasResidentGeneration()).toBe(false)
    await expect(search(service, 1)).resolves.toMatchObject({ ready: true })
    expect(service.hasResidentGeneration()).toBe(true)
    expect(workers).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
    expect(workers[0]?.terminated).toBe(false)

    await expect(search(service, 2)).resolves.toMatchObject({ ready: true })
    expect(workers).toHaveLength(1)
    client.dispose()
    service.dispose()
  })

  it('releases the worker once the last resident generation is revoked', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const { service, client } = createHoldingService(workers)

    await expect(search(service, 1)).resolves.toMatchObject({ ready: true })
    service.revoke(OWNER)
    expect(service.hasResidentGeneration()).toBe(false)

    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
    expect(workers[0]?.terminated).toBe(true)
    client.dispose()
    service.dispose()
  })
})
