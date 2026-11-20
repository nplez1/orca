import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const deepInfraApiKeyStore = createEncryptedApiKeyFileStore({
  fileName: 'deepinfra-api-key.enc',
  envelopePrefix: 'orca-deepinfra-api-key:v1:',
  providerLabel: 'DeepInfra',
  logScope: 'deepinfra'
})

export const hasDeepInfraApiKey = deepInfraApiKeyStore.has
export const getDeepInfraApiKeyProtection = deepInfraApiKeyStore.protection
export const saveDeepInfraApiKey = deepInfraApiKeyStore.save
export const readDeepInfraApiKey = deepInfraApiKeyStore.read
export const clearDeepInfraApiKey = deepInfraApiKeyStore.clear
