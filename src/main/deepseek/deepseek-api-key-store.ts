import { createSecureCredentialStore } from '../credentials/secure-credential-store'

const deepSeekApiKeyStore = createSecureCredentialStore({
  fileName: 'deepseek-api-key.enc',
  envelopePrefix: 'orca-deepseek-api-key:v1:',
  description: 'DeepSeek API key',
  logTag: '[deepseek]'
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
