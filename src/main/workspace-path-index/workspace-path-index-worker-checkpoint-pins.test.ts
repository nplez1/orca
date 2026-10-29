import { afterEach, describe, expect, it } from 'vitest'
import { pinnedWorkspacePathCatalogCheckpoints } from './workspace-path-catalog-checkpoint-store'
import {
  pinRestoredWorkspacePathCheckpoint,
  releaseRestoredWorkspacePathCheckpoint,
  releaseRestoredWorkspacePathCheckpointIfUnused,
  resetRestoredWorkspacePathCheckpointPinsForTests
} from './workspace-path-index-worker-checkpoint-pins'

/**
 * Why: host-budget eviction drops the oldest checkpoint directory, and a restored one is the oldest
 * — so the pin has to end exactly when nothing in the worker reads out of that directory any more.
 */

const ROOT = 'local::restored-root'
const DIRECTORY = '/checkpoints/identity-hash'

afterEach(() => {
  resetRestoredWorkspacePathCheckpointPinsForTests()
})

function pinned(): readonly string[] {
  return pinnedWorkspacePathCatalogCheckpoints()
}

function pin(): void {
  pinRestoredWorkspacePathCheckpoint({
    rootKey: ROOT,
    checkpointDirectory: DIRECTORY,
    generationId: 'generation-restored'
  })
}

describe('restored checkpoint pins', () => {
  it('pins a restored generation directory', () => {
    pin()

    expect(pinned()).toEqual([DIRECTORY])
  })

  it('keeps the pin while any retained generation still reads out of that directory', () => {
    pin()

    releaseRestoredWorkspacePathCheckpointIfUnused(ROOT, ['/checkpoints/other-identity', DIRECTORY])

    expect(pinned()).toEqual([DIRECTORY])
  })

  it('releases the pin once nothing retained reads out of that directory', () => {
    pin()

    releaseRestoredWorkspacePathCheckpointIfUnused(ROOT, ['/checkpoints/other-identity'])

    expect(pinned()).toEqual([])
  })

  it('releases on a whole-root drop', () => {
    pin()

    releaseRestoredWorkspacePathCheckpoint(ROOT)

    expect(pinned()).toEqual([])
  })

  it('replaces a stale pin when the same root restores again', () => {
    pin()
    pinRestoredWorkspacePathCheckpoint({
      rootKey: ROOT,
      checkpointDirectory: '/checkpoints/replacement',
      generationId: 'generation-restored-2'
    })

    expect(pinned()).toEqual(['/checkpoints/replacement'])
  })
})
