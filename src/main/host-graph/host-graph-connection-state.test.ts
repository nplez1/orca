import { beforeEach, describe, expect, it } from 'vitest'
import {
  connectedHostGraphEnvironmentIds,
  observeHostGraphEnvironmentConnection,
  resetHostGraphConnectionState
} from './host-graph-connection-state'

beforeEach(() => {
  resetHostGraphConnectionState()
})

describe('which paired hosts this machine can reach', () => {
  it('counts a pairing connected only while its transport is ready', () => {
    observeHostGraphEnvironmentConnection({
      environmentId: 'env-1',
      transportGeneration: 1,
      state: 'ready'
    })
    expect(connectedHostGraphEnvironmentIds()).toEqual(new Set(['env-1']))

    observeHostGraphEnvironmentConnection({
      environmentId: 'env-1',
      transportGeneration: 2,
      state: 'reconnecting'
    })
    expect(connectedHostGraphEnvironmentIds().size).toBe(0)
  })

  it('drops a host that closed rather than leaving it connected for ever', () => {
    observeHostGraphEnvironmentConnection({
      environmentId: 'env-1',
      transportGeneration: 1,
      state: 'ready'
    })
    observeHostGraphEnvironmentConnection({
      environmentId: 'env-1',
      transportGeneration: 1,
      state: 'closed'
    })

    expect(connectedHostGraphEnvironmentIds().size).toBe(0)
  })
})
