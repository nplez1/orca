import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const deepSeekApiKeyStore = createEncryptedApiKeyFileStore({
  fileName: 'deepseek-api-key.enc',
  envelopePrefix: 'orca-deepseek-api-key:v1:',
  providerLabel: 'DeepSeek',
  logScope: 'deepseek'
})

export const hasDeepSeekApiKey = deepSeekApiKeyStore.has
export const getDeepSeekApiKeyProtection = deepSeekApiKeyStore.protection
export const saveDeepSeekApiKey = deepSeekApiKeyStore.save
export const readDeepSeekApiKey = deepSeekApiKeyStore.read
export const clearDeepSeekApiKey = deepSeekApiKeyStore.clear
