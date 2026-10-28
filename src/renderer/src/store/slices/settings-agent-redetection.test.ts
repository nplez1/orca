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
  const refreshLocal = vi.fn().mockResolvedValue([])
  store.setState({ refreshDetectedAgents: refreshLocal })
  return { store, refreshLocal }
}

describe('createSettingsSlice agent enablement re-detection', () => {
  it('re-reads the host agent inventories when a write enables an agent', async () => {
    const { store, refreshLocal } = makeStore(['pi'])
    settingsSet.mockResolvedValueOnce({ disabledTuiAgents: [], notifications: {} })

    await store.getState().updateSettingsOrThrow({ disabledTuiAgents: [] })

    expect(refreshLocal).toHaveBeenCalled()
  })

  it('leaves agent detection alone when a write changes nothing about enablement', async () => {
    const { store, refreshLocal } = makeStore([])
    settingsSet.mockResolvedValueOnce({ disabledTuiAgents: ['pi'], notifications: {} })

    await store.getState().updateSettingsOrThrow({ disabledTuiAgents: ['pi'] })

    expect(refreshLocal).not.toHaveBeenCalled()
  })

  it('does not re-read agent detection when the write fails', async () => {
    const { store, refreshLocal } = makeStore(['pi'])
    settingsSet.mockRejectedValueOnce(new Error('settings IPC failed'))

    await expect(store.getState().updateSettingsOrThrow({ disabledTuiAgents: [] })).rejects.toThrow(
      'settings IPC failed'
    )

    expect(refreshLocal).not.toHaveBeenCalled()
  })
})
