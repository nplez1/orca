import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import { HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-glm-key-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  mkdirSync(join(home, HOME_DIRECTORY_NAME))
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
    describeProtectionGap: () => null
  })
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it('stores the envelope under the Orca NP home', async () => {
  const store = await import('./zcode-plan-api-key-store')
  expect(store.getZcodePlanApiKeyPath()).toBe(
    join(home, HOME_DIRECTORY_NAME, 'zcode-plan-api-key.enc')
  )
})
it('rejects a key with an interior newline instead of saving it', async () => {
  const store = await import('./zcode-plan-api-key-store')
  await expect(store.saveZcodePlanApiKey('glm\r\nsecret')).rejects.toThrow('must be a single line')
})
it('refuses to decrypt an encrypted envelope once safeStorage becomes unavailable', async () => {
  writeFileSync(
    join(home, HOME_DIRECTORY_NAME, 'zcode-plan-api-key.enc'),
    'orca-zcode-plan-api-key:v1:encrypted:Z2xtLXNlY3JldA=='
  )
  const store = await import('./zcode-plan-api-key-store')
  await expect(store.readZcodePlanApiKey()).rejects.toThrow('could not be decrypted')
})
it('throws on an unreadable envelope instead of returning a partial key', async () => {
  writeFileSync(join(home, HOME_DIRECTORY_NAME, 'zcode-plan-api-key.enc'), 'not-an-envelope')
  const store = await import('./zcode-plan-api-key-store')
  await expect(store.readZcodePlanApiKey()).rejects.toThrow('could not be decrypted')
})
