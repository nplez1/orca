import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const deepSeekApiKeyStore = createEncryptedApiKeyFileStore({
  fileName: 'deepseek-api-key.enc',
  envelopePrefix: 'orca-deepseek-api-key:v1:',
  providerLabel: 'DeepSeek',
  logScope: 'deepseek'
})

export function hasDeepSeekApiKey(): boolean {
  return deepSeekApiKeyStore.has()
}

export function saveDeepSeekApiKey(key: string): void {
  deepSeekApiKeyStore.save(key)
}

export function readDeepSeekApiKey(): string | null {
  return deepSeekApiKeyStore.read()
}

export function clearDeepSeekApiKey(): void {
  deepSeekApiKeyStore.clear()
}
