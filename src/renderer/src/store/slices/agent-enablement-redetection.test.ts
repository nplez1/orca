import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  enablesNewTuiAgents,
  refreshDetectedAgentInventories,
  type AgentInventoryRefreshState
} from './agent-enablement-redetection'
import { getRuntimeAgentInventoryKey } from './runtime-agent-inventory-key'

function makeRefreshState(overrides: Partial<AgentInventoryRefreshState> = {}): {
  state: AgentInventoryRefreshState
  refreshLocal: ReturnType<typeof vi.fn>
  refreshRemote: ReturnType<typeof vi.fn>
  refreshRuntime: ReturnType<typeof vi.fn>
} {
  const refreshLocal = vi.fn<() => Promise<TuiAgent[]>>().mockResolvedValue([])
  const refreshRemote = vi.fn<(connectionId: string) => Promise<TuiAgent[]>>().mockResolvedValue([])
  const refreshRuntime = vi
    .fn<(environmentId: string, worktreeId?: string | null) => Promise<TuiAgent[]>>()
    .mockResolvedValue([])
  return {
    state: {
      refreshDetectedAgents: refreshLocal,
      remoteDetectedAgentIds: {},
      refreshRemoteDetectedAgents: refreshRemote,
      runtimeDetectedAgentIds: {},
      refreshRuntimeDetectedAgents: refreshRuntime,
      ...overrides
    },
    refreshLocal,
    refreshRemote,
    refreshRuntime
  }
}

describe('enablesNewTuiAgents', () => {
  it('reports an agent leaving the disabled list', () => {
    expect(enablesNewTuiAgents({ disabledTuiAgents: ['pi'] }, { disabledTuiAgents: [] })).toBe(true)
  })

  it('ignores a write that only disables an agent', () => {
    expect(enablesNewTuiAgents({ disabledTuiAgents: [] }, { disabledTuiAgents: ['pi'] })).toBe(
      false
    )
    expect(
      enablesNewTuiAgents({ disabledTuiAgents: ['pi'] }, { disabledTuiAgents: ['pi', 'codex'] })
    ).toBe(false)
  })

  it('ignores an unchanged list and a first write', () => {
    expect(enablesNewTuiAgents({ disabledTuiAgents: ['pi'] }, { disabledTuiAgents: ['pi'] })).toBe(
      false
    )
    expect(enablesNewTuiAgents(null, null)).toBe(false)
    expect(enablesNewTuiAgents(null, { disabledTuiAgents: [] })).toBe(false)
  })

  it('ignores entries that are not agents, and duplicates', () => {
    expect(
      enablesNewTuiAgents(
        { disabledTuiAgents: ['not-an-agent', 'pi', 'pi'] },
        { disabledTuiAgents: ['not-an-agent'] }
      )
    ).toBe(true)
    expect(
      enablesNewTuiAgents(
        { disabledTuiAgents: ['not-an-agent', 'pi'] },
        { disabledTuiAgents: ['pi', 'not-an-agent', 'not-an-agent'] }
      )
    ).toBe(false)
  })
})

describe('refreshDetectedAgentInventories', () => {
  it('re-probes the local host', () => {
    const { state, refreshLocal } = makeRefreshState()

    refreshDetectedAgentInventories(state)

    expect(refreshLocal).toHaveBeenCalledTimes(1)
  })

  it('re-probes each remote host someone has already read, and skips the rest', () => {
    const { state, refreshRemote } = makeRefreshState({
      remoteDetectedAgentIds: { 'ssh-read': ['claude'], 'ssh-unread': null }
    })

    refreshDetectedAgentInventories(state)

    expect(refreshRemote.mock.calls).toEqual([['ssh-read']])
  })

  it('splits a paired host inventory key back into its host and workspace', () => {
    const hostDefault = getRuntimeAgentInventoryKey('env-1')
    const workspace = getRuntimeAgentInventoryKey('env-1', 'wt-1')
    const { state, refreshRuntime } = makeRefreshState({
      runtimeDetectedAgentIds: { [hostDefault]: ['claude'], [workspace]: ['codex'], 'env-2': null }
    })

    refreshDetectedAgentInventories(state)

    expect(refreshRuntime.mock.calls).toEqual([
      ['env-1', undefined],
      ['env-1', 'wt-1']
    ])
  })

  it('keeps re-probing the other hosts when one refresh rejects', async () => {
    const { state, refreshLocal, refreshRemote, refreshRuntime } = makeRefreshState({
      remoteDetectedAgentIds: { 'ssh-1': null, 'ssh-2': ['claude'] },
      runtimeDetectedAgentIds: { 'env-1': ['claude'] }
    })
    refreshRemote.mockRejectedValue(new Error('relay gone'))
    refreshRuntime.mockRejectedValue(new Error('needs server update'))

    refreshDetectedAgentInventories(state)
    await Promise.resolve()

    expect(refreshLocal).toHaveBeenCalledTimes(1)
    expect(refreshRemote.mock.calls).toEqual([['ssh-2']])
    expect(refreshRuntime.mock.calls).toEqual([['env-1', undefined]])
  })
})
