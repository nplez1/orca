import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { AppState } from '../types'

const settingsSet = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { settings: { set: settingsSet } } })
})

function makeStore(disabledTuiAgents: string[]) {
  const store = createTestStore()
  store.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice reads only disabledTuiAgents, and a real GlobalSettings needs every field.
    settings: { disabledTuiAgents, notifications: {} } as AppState['settings']
  })
  const refreshDetectedAgents = vi.fn().mockResolvedValue([])
  store.setState({ refreshDetectedAgents })
  return { store, refreshDetectedAgents }
}

describe('createSettingsSlice agent enablement re-detection', () => {
  it('re-probes the host agent lists when a write enables an agent', async () => {
    const { store, refreshDetectedAgents } = makeStore(['pi'])
    settingsSet.mockResolvedValueOnce({ disabledTuiAgents: [], notifications: {} })

    await store.getState().updateSettingsOrThrow({ disabledTuiAgents: [] })

    expect(refreshDetectedAgents).toHaveBeenCalledTimes(1)
  })

  it('leaves agent detection alone when a write changes nothing about enablement', async () => {
    const { store, refreshDetectedAgents } = makeStore([])
    settingsSet.mockResolvedValueOnce({ disabledTuiAgents: ['pi'], notifications: {} })

    await store.getState().updateSettingsOrThrow({ disabledTuiAgents: ['pi'] })

    expect(refreshDetectedAgents).not.toHaveBeenCalled()
  })

  it('does not re-probe agent detection when the write fails', async () => {
    const { store, refreshDetectedAgents } = makeStore(['pi'])
    settingsSet.mockRejectedValueOnce(new Error('settings IPC failed'))

    await expect(store.getState().updateSettingsOrThrow({ disabledTuiAgents: [] })).rejects.toThrow(
      'settings IPC failed'
    )

    expect(refreshDetectedAgents).not.toHaveBeenCalled()
  })
})
