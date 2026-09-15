import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, refreshCopilotGhCredentialsMock } = vi.hoisted(() => ({
  handleMock: vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(),
  refreshCopilotGhCredentialsMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../rate-limits/copilot/copilot-gh-credentials', () => ({
  refreshCopilotGhCredentials: refreshCopilotGhCredentialsMock
}))

import { registerCopilotCredentialsHandlers } from './copilot-credentials'

function statusHandler(): (...args: unknown[]) => unknown {
  const registration = handleMock.mock.calls.find(
    ([channel]) => channel === 'copilotCredentials:getStatus'
  )
  if (!registration) {
    throw new Error('copilotCredentials:getStatus is not registered')
  }
  return registration[1]
}

describe('registerCopilotCredentialsHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    refreshCopilotGhCredentialsMock.mockReset()
  })

  it('registers only the read, because the GitHub CLI owns the credential', () => {
    registerCopilotCredentialsHandlers()

    expect(handleMock.mock.calls.map(([channel]) => channel)).toEqual([
      'copilotCredentials:getStatus'
    ])
  })

  it('reports a serving sign-in as configured with nothing left to run', async () => {
    refreshCopilotGhCredentialsMock.mockResolvedValue({ status: 'ok' })
    registerCopilotCredentialsHandlers()

    await expect(statusHandler()(null)).resolves.toEqual({
      configured: true,
      ghStatus: 'ok',
      ghSetupHint: null
    })
  })

  it('names the scope the entitlement read needs when it is missing', async () => {
    refreshCopilotGhCredentialsMock.mockResolvedValue({
      status: 'missing-scope',
      missing: ['user']
    })
    registerCopilotCredentialsHandlers()

    await expect(statusHandler()(null)).resolves.toEqual({
      configured: false,
      ghStatus: 'missing-scope',
      ghSetupHint: 'gh auth refresh -s user'
    })
  })

  it('offers the sign-in command when gh is installed but signed out', async () => {
    refreshCopilotGhCredentialsMock.mockResolvedValue({ status: 'unauthenticated' })
    registerCopilotCredentialsHandlers()

    await expect(statusHandler()(null)).resolves.toEqual({
      configured: false,
      ghStatus: 'unauthenticated',
      ghSetupHint: 'gh auth login'
    })
  })

  it('offers no command when gh is not on PATH', async () => {
    refreshCopilotGhCredentialsMock.mockResolvedValue({ status: 'gh-missing' })
    registerCopilotCredentialsHandlers()

    await expect(statusHandler()(null)).resolves.toEqual({
      configured: false,
      ghStatus: 'gh-missing',
      ghSetupHint: null
    })
  })

  it('refreshes the probed cache so the fetch cycle sees the same answer', async () => {
    refreshCopilotGhCredentialsMock.mockResolvedValue({ status: 'ok' })
    registerCopilotCredentialsHandlers()

    await statusHandler()(null)

    // Why asserted: a plain resolve would leave the cycle reading a stale cache.
    expect(refreshCopilotGhCredentialsMock).toHaveBeenCalledTimes(1)
  })
})
