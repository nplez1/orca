import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  handleHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handleHandlers.set(channel, handler)
    }
  }
}))

const hasFireworksCredentialsMock = vi.hoisted(() => vi.fn(() => false))
const readFireworksCredentialsMock = vi.hoisted(() => vi.fn())
const saveFireworksCredentialsMock = vi.hoisted(() => vi.fn())
const clearFireworksCredentialsMock = vi.hoisted(() => vi.fn())

vi.mock('../fireworks/fireworks-credentials-store', () => ({
  hasFireworksCredentials: hasFireworksCredentialsMock,
  readFireworksCredentials: readFireworksCredentialsMock,
  saveFireworksCredentials: saveFireworksCredentialsMock,
  clearFireworksCredentials: clearFireworksCredentialsMock
}))

import { registerFireworksCredentialsHandlers } from './fireworks-credentials'

type FireworksServiceArg = Parameters<typeof registerFireworksCredentialsHandlers>[0]

// Why: the handler only ever calls these two members, so a two-method stub stands
// in for the concrete service without constructing the whole class.
function makeRefreshStub(): {
  refresh: ReturnType<typeof vi.fn>
  invalidateFireworksCredentialState: ReturnType<typeof vi.fn>
  service: FireworksServiceArg
} {
  const refresh = vi.fn(() => Promise.resolve())
  const invalidateFireworksCredentialState = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only refresh and invalidateFireworksCredentialState are reachable from this handler, so the missing members of RateLimitService can never be observed by the code under test.
  const service = { refresh, invalidateFireworksCredentialState } as unknown as FireworksServiceArg
  return { refresh, invalidateFireworksCredentialState, service }
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcState.handleHandlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return await handler({}, ...args)
}

describe('registerFireworksCredentialsHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
    hasFireworksCredentialsMock.mockReset()
    hasFireworksCredentialsMock.mockReturnValue(false)
    readFireworksCredentialsMock.mockReset()
    readFireworksCredentialsMock.mockReturnValue(null)
    saveFireworksCredentialsMock.mockReset()
    clearFireworksCredentialsMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers all three Fireworks credential channels', () => {
    registerFireworksCredentialsHandlers(null)
    expect(ipcState.handleHandlers.has('fireworksCredentials:getStatus')).toBe(true)
    expect(ipcState.handleHandlers.has('fireworksCredentials:save')).toBe(true)
    expect(ipcState.handleHandlers.has('fireworksCredentials:clear')).toBe(true)
  })

  it('reports the stored override alongside the configured flag', async () => {
    hasFireworksCredentialsMock.mockReturnValue(true)
    readFireworksCredentialsMock.mockReturnValue({
      apiKey: 'fw_secret',
      accountIdOverride: 'acct-7'
    })
    registerFireworksCredentialsHandlers(null)

    expect(await invoke('fireworksCredentials:getStatus')).toEqual({
      configured: true,
      apiKeyConfigured: true,
      accountIdOverride: 'acct-7'
    })
  })

  it('survives an undecryptable credential file without failing the status call', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    hasFireworksCredentialsMock.mockReturnValue(true)
    readFireworksCredentialsMock.mockImplementation(() => {
      throw new Error('Fireworks credentials could not be decrypted')
    })
    registerFireworksCredentialsHandlers(null)

    expect(await invoke('fireworksCredentials:getStatus')).toEqual({
      configured: true,
      apiKeyConfigured: true,
      accountIdOverride: null
    })
    expect(errorSpy).toHaveBeenCalled()
  })

  it('persists a pasted key together with a trimmed override', async () => {
    hasFireworksCredentialsMock.mockReturnValue(true)
    registerFireworksCredentialsHandlers(null)

    await invoke('fireworksCredentials:save', '  fw_new_key  ', '  acct-9  ')

    expect(saveFireworksCredentialsMock).toHaveBeenCalledWith({
      apiKey: 'fw_new_key',
      accountIdOverride: 'acct-9'
    })
  })

  it('stores a blank override as null so auto-discovery stays on', async () => {
    registerFireworksCredentialsHandlers(null)

    await invoke('fireworksCredentials:save', 'fw_new_key', '   ')

    expect(saveFireworksCredentialsMock).toHaveBeenCalledWith({
      apiKey: 'fw_new_key',
      accountIdOverride: null
    })
  })

  it('keeps the stored key when the save carries a blank key', async () => {
    readFireworksCredentialsMock.mockReturnValue({ apiKey: 'fw_stored', accountIdOverride: null })
    registerFireworksCredentialsHandlers(null)

    await invoke('fireworksCredentials:save', '', 'acct-42')

    // Why: this is the only way to change the account-ID override — the renderer
    // never receives the stored key, so it cannot send it back.
    expect(saveFireworksCredentialsMock).toHaveBeenCalledWith({
      apiKey: 'fw_stored',
      accountIdOverride: 'acct-42'
    })
  })

  it('rejects a blank key when nothing is stored to keep', async () => {
    readFireworksCredentialsMock.mockReturnValue(null)
    registerFireworksCredentialsHandlers(null)

    await expect(invoke('fireworksCredentials:save', '   ', 'acct-42')).rejects.toThrow(
      /API key is required/
    )
    expect(saveFireworksCredentialsMock).not.toHaveBeenCalled()
  })

  it('rejects a non-string API key', async () => {
    registerFireworksCredentialsHandlers(null)
    await expect(invoke('fireworksCredentials:save', 12_345, null)).rejects.toThrow(
      /must be an API key/
    )
    expect(saveFireworksCredentialsMock).not.toHaveBeenCalled()
  })

  it('rejects a non-string account ID override', async () => {
    registerFireworksCredentialsHandlers(null)
    await expect(invoke('fireworksCredentials:save', 'fw_key', 42)).rejects.toThrow(
      /must be an API key/
    )
    expect(saveFireworksCredentialsMock).not.toHaveBeenCalled()
  })

  it('triggers a rate-limit refresh after a save when a service is provided', async () => {
    const { refresh, invalidateFireworksCredentialState, service } = makeRefreshStub()
    registerFireworksCredentialsHandlers(service)
    await invoke('fireworksCredentials:save', 'fw_key', null)
    // Why: the save handler is fire-and-forget — wait a microtask cycle so the
    // queued `void rateLimits?.refresh()` resolves before asserting.
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateFireworksCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('logs but does not throw when the post-save refresh rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refresh = vi.fn(() => Promise.reject(new Error('refresh boom')))
    const invalidateFireworksCredentialState = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same two-member stub as makeRefreshStub; only these members are reachable from the handler, and the rejection is the behaviour under test.
    const service = {
      refresh,
      invalidateFireworksCredentialState
    } as unknown as FireworksServiceArg
    registerFireworksCredentialsHandlers(service)

    await invoke('fireworksCredentials:save', 'fw_key', null)
    await new Promise((resolve) => setImmediate(resolve))

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to trigger rate-limit refresh after save'),
      expect.any(Error)
    )
  })

  it('clears stored credentials, drops the override, and refreshes', async () => {
    const { refresh, invalidateFireworksCredentialState, service } = makeRefreshStub()
    registerFireworksCredentialsHandlers(service)

    expect(await invoke('fireworksCredentials:clear')).toEqual({
      configured: false,
      apiKeyConfigured: false,
      accountIdOverride: null
    })
    expect(clearFireworksCredentialsMock).toHaveBeenCalledTimes(1)
    expect(invalidateFireworksCredentialState).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
