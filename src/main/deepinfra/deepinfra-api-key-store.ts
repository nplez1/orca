import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const deepInfraApiKeyStore = createEncryptedApiKeyFileStore({
  fileName: 'deepinfra-api-key.enc',
  envelopePrefix: 'orca-deepinfra-api-key:v1:',
  providerLabel: 'DeepInfra',
  logScope: 'deepinfra'
})

export function hasDeepInfraApiKey(): boolean {
  return deepInfraApiKeyStore.has()
}

export const getDeepInfraApiKeyProtection = deepInfraApiKeyStore.protection

export function saveDeepInfraApiKey(key: string): void {
  deepInfraApiKeyStore.save(key)
}

export function readDeepInfraApiKey(): string | null {
  return deepInfraApiKeyStore.read()
}

export function clearDeepInfraApiKey(): void {
  deepInfraApiKeyStore.clear()
}
