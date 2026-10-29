import { afterEach, describe, expect, it } from 'vitest'
import { pinnedWorkspacePathCatalogCheckpoints } from './workspace-path-catalog-checkpoint-store'
import {
  pinRestoredWorkspacePathCheckpoint,
  releaseRestoredWorkspacePathCheckpoint,
  releaseSupersededRestoredWorkspacePathCheckpoint,
  resetRestoredWorkspacePathCheckpointPinsForTests
} from './workspace-path-index-worker-checkpoint-pins'

/**
 * Why: host-budget eviction drops the oldest checkpoint directory, and a restored one is the oldest
 * — so the pin has to end exactly when that generation stops being read here.
 */

const ROOT = 'local::restored-root'
const DIRECTORY = '/checkpoints/identity-hash'

afterEach(() => {
  resetRestoredWorkspacePathCheckpointPinsForTests()
})

function pinned(): readonly string[] {
  return pinnedWorkspacePathCatalogCheckpoints()
}

describe('restored checkpoint pins', () => {
  it('pins a restored generation directory', () => {
    pinRestoredWorkspacePathCheckpoint({
      rootKey: ROOT,
      checkpointDirectory: DIRECTORY,
      generationId: 'generation-restored'
    })

    expect(pinned()).toEqual([DIRECTORY])
  })

  it('releases the pin when the restored generation becomes the served one no longer', () => {
    pinRestoredWorkspacePathCheckpoint({
      rootKey: ROOT,
      checkpointDirectory: DIRECTORY,
      generationId: 'generation-restored'
    })

    // The restore's own publish must not release the pin it just took.
    releaseSupersededRestoredWorkspacePathCheckpoint(ROOT, 'generation-restored')
    expect(pinned()).toEqual([DIRECTORY])

    releaseSupersededRestoredWorkspacePathCheckpoint(ROOT, 'generation-built')
    expect(pinned()).toEqual([])
  })

  it('releases on a drop of that generation, and keeps it for another', () => {
    pinRestoredWorkspacePathCheckpoint({
      rootKey: ROOT,
      checkpointDirectory: DIRECTORY,
      generationId: 'generation-restored'
    })

    releaseRestoredWorkspacePathCheckpoint(ROOT, 'generation-built')
    expect(pinned()).toEqual([DIRECTORY])

    releaseRestoredWorkspacePathCheckpoint(ROOT, 'generation-restored')
    expect(pinned()).toEqual([])
  })

  it('releases on a whole-root drop', () => {
    pinRestoredWorkspacePathCheckpoint({
      rootKey: ROOT,
      checkpointDirectory: DIRECTORY,
      generationId: 'generation-restored'
    })

    releaseRestoredWorkspacePathCheckpoint(ROOT)

    expect(pinned()).toEqual([])
  })
})
