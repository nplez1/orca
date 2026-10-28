import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '../index'

beforeEach(() => {
  useAppStore.setState({ settingsProjectAddHostRequest: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('project host add request', () => {
  it('carries the project and host into Settings without persisting them', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = useAppStore

    store.getState().requestProjectHostAdd({
      projectId: 'git:acme/app',
      repoId: 'remote-repo',
      hostId: toSshExecutionHostId('box')
    })

    expect(store.getState().settingsProjectAddHostRequest).toEqual({
      projectId: 'git:acme/app',
      repoId: 'remote-repo',
      hostId: 'ssh:box'
    })
    expect(setUI).not.toHaveBeenCalled()

    store.getState().clearProjectHostAddRequest()

    expect(store.getState().settingsProjectAddHostRequest).toBeNull()
  })

  it('gives the same request a fresh identity so the flow re-opens', () => {
    const store = useAppStore
    const request = {
      projectId: 'git:acme/app',
      repoId: 'remote-repo',
      hostId: toSshExecutionHostId('box')
    } as const

    store.getState().requestProjectHostAdd(request)
    const first = store.getState().settingsProjectAddHostRequest
    store.getState().requestProjectHostAdd(request)

    expect(store.getState().settingsProjectAddHostRequest).not.toBe(first)
    expect(store.getState().settingsProjectAddHostRequest).toEqual(request)
  })
})
