import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import type * as ZcodePlanApiKeyStore from './zcode-plan-api-key-store'

const secretStoreMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeSecureFileMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca-np/zcode-plan-api-key.enc'
const envelope = (kind: 'encrypted' | 'plaintext', value: string): string =>
  `orca-zcode-plan-api-key:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof ZcodePlanApiKeyStore> {
  setSecretStore({ ...secretStoreMock, describeProtectionGap: () => null })
  return await import('./zcode-plan-api-key-store')
}

describe('zcode-plan-api-key-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    writeSecureFileMock.mockReturnValue(true)
    secretStoreMock.isEncryptionAvailable.mockReset()
    secretStoreMock.encryptString.mockReset()
    secretStoreMock.decryptString.mockReset()
    secretStoreMock.isEncryptionAvailable.mockReturnValue(true)
    secretStoreMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    secretStoreMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    homedirMock.mockReturnValue('/home/test')
    vi.resetModules()
  })

  it('reports unconfigured while no key file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()

    expect(store.hasZcodePlanApiKey()).toBe(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
  })

  it('saves an encrypted envelope and reads it back through the cache', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()

    store.saveZcodePlanApiKey(' glm-secret ')

    expect(writeSecureFileMock).toHaveBeenCalledWith(storePath, envelope('encrypted', 'glm-secret'))
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'glm-secret')))
    expect(store.hasZcodePlanApiKey()).toBe(true)
    expect(store.readZcodePlanApiKey()).toBe('glm-secret')
  })

  it('warns and writes plaintext when the secret store cannot seal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()

    store.saveZcodePlanApiKey('glm-secret')

    expect(writeSecureFileMock).toHaveBeenCalledWith(storePath, envelope('plaintext', 'glm-secret'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret encryption unavailable'))
    warn.mockRestore()
  })

  it('reads a plaintext envelope back without requiring the secret store', async () => {
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'glm-secret')))
    const store = await loadStore()

    expect(store.readZcodePlanApiKey()).toBe('glm-secret')
    expect(secretStoreMock.decryptString).not.toHaveBeenCalled()
  })

  it('refuses to seal when no secret store is installed', async () => {
    // Why this test exists: the global test setup installs a store, so dropping it is the only
    // way to reach the uninstalled path — and a save consults the port unconditionally.
    _resetSecretStoreForTests()
    const store = await import('./zcode-plan-api-key-store')

    expect(() => store.saveZcodePlanApiKey('glm-secret')).toThrow(/SecretStore not initialized/)
  })

  it('reads a plaintext envelope with no secret store installed at all', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'glm-secret')))
    _resetSecretStoreForTests()
    const store = await import('./zcode-plan-api-key-store')

    expect(store.readZcodePlanApiKey()).toBe('glm-secret')
  })

  it('classifies a sealed envelope read with no store installed as a decrypt failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'glm-secret')))
    _resetSecretStoreForTests()
    const store = await import('./zcode-plan-api-key-store')

    // Why the port's own error is logged and not surfaced: an uninstalled store is unreachable
    // in production (main-process-preflight and orcad-entry both install one) and this read is
    // read-only, so the caller's decrypt classification stands — the siblings fetch the store
    // inside the same try too (openai-api-key-store, integration-credential-file).
    expect(() => store.readZcodePlanApiKey()).toThrow('could not be decrypted')
    expect(error).toHaveBeenCalledWith(
      '[zcode] failed to decode/decrypt GLM Coding Plan API key',
      expect.objectContaining({ message: expect.stringContaining('SecretStore not initialized') })
    )
    error.mockRestore()
  })

  it.each(['encrypted', 'plaintext'] as const)(
    'reports %s protection without decrypting',
    async (kind) => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(Buffer.from(envelope(kind, 'glm-secret')))
      const store = await loadStore()
      expect(store.getZcodePlanApiKeyProtection()).toBe(
        kind === 'encrypted' ? 'sealed' : 'plaintext'
      )
      expect(secretStoreMock.decryptString).not.toHaveBeenCalled()
    }
  )

  it('rejects saving an empty key', async () => {
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('   ')).toThrow('GLM Coding Plan API key is required')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('rejects a key with an interior newline instead of saving it', async () => {
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('glm\r\nsecret')).toThrow('must be a single line')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('refuses to keep an unrestricted plaintext key when hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    writeSecureFileMock.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'glm-secret')))
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('glm-secret')).toThrow(
      'could not be stored securely on this device'
    )
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    warn.mockRestore()
  })

  it('restores the previous envelope when a plaintext replacement cannot be restricted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    const previous = Buffer.from(envelope('encrypted', 'old-key'))
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock
      .mockReturnValueOnce(previous)
      .mockReturnValueOnce(Buffer.from(envelope('plaintext', 'new-key')))
      .mockReturnValue(previous)
    writeSecureFileMock.mockReturnValueOnce(false).mockReturnValueOnce(true)
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('new-key')).toThrow(
      'could not be stored securely on this device'
    )
    // Reject unrestricted replacement but restore the old envelope so the previous key survives failure.
    expect(writeSecureFileMock).toHaveBeenCalledTimes(2)
    expect(writeSecureFileMock).toHaveBeenLastCalledWith(storePath, previous.toString('utf8'), {
      shouldPublish: expect.any(Function)
    })
    expect(rmSyncMock).not.toHaveBeenCalledWith(storePath, expect.anything())
    warn.mockRestore()
  })

  it('removes a rejected plaintext replacement when restoring the previous key fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    const previous = Buffer.from(envelope('encrypted', 'old-key'))
    const attempted = envelope('plaintext', 'new-key')
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValueOnce(previous).mockReturnValue(Buffer.from(attempted))
    writeSecureFileMock.mockReturnValueOnce(false).mockImplementationOnce(() => {
      throw new Error('restore failed before publish')
    })
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('new-key')).toThrow(
      'could not be stored securely on this device'
    )
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    warn.mockRestore()
  })

  it('keeps a restored key when rollback fails after the previous envelope is published', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    const previous = Buffer.from(envelope('encrypted', 'old-key'))
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock
      .mockReturnValueOnce(previous)
      .mockReturnValueOnce(Buffer.from(envelope('plaintext', 'new-key')))
      .mockReturnValue(previous)
    writeSecureFileMock.mockReturnValueOnce(false).mockImplementationOnce(() => {
      throw new Error('restore failed after publish')
    })
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('new-key')).toThrow(
      'could not be stored securely on this device'
    )
    expect(rmSyncMock).not.toHaveBeenCalledWith(storePath, expect.anything())
    warn.mockRestore()
  })

  it('keeps an identical plaintext key when restore fails after publishing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    const sameKey = Buffer.from(envelope('plaintext', 'same-key'))
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(sameKey)
    writeSecureFileMock.mockReturnValueOnce(false).mockImplementationOnce(() => {
      throw new Error('restore failed after publish')
    })
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('same-key')).toThrow(
      'could not be stored securely on this device'
    )
    expect(rmSyncMock).not.toHaveBeenCalledWith(storePath, expect.anything())
    warn.mockRestore()
  })

  it('refuses to decrypt an encrypted envelope once the secret store cannot seal', async () => {
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'glm-secret')))
    const store = await loadStore()

    expect(() => store.readZcodePlanApiKey()).toThrow('could not be decrypted')
  })

  it('throws on an unreadable envelope instead of returning a partial key', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('not-an-envelope'))
    const store = await loadStore()

    expect(() => store.readZcodePlanApiKey()).toThrow('could not be decrypted')
  })

  it('clearing removes the file and resets the cached value', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveZcodePlanApiKey('glm-secret')

    existsSyncMock.mockReturnValue(true)
    store.clearZcodePlanApiKey()

    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    existsSyncMock.mockReturnValue(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
  })
})

afterEach(() => {
  _resetSecretStoreForTests()
  vi.restoreAllMocks()
})
