import { createSecureCredentialStore } from '../credentials/secure-credential-store'

const minimaxApiKeyStore = createSecureCredentialStore({
  fileName: 'minimax-api-key.enc',
  envelopePrefix: 'orca-minimax-api-key:v1:',
  description: 'MiniMax API key',
  logTag: '[minimax]'
})

export function hasMiniMaxApiKey(): boolean {
  return minimaxApiKeyStore.has()
}

export function saveMiniMaxApiKey(key: string): void {
  minimaxApiKeyStore.save(key)
}

export function readMiniMaxApiKey(): string | null {
  return minimaxApiKeyStore.read()
}

export function clearMiniMaxApiKey(): void {
  minimaxApiKeyStore.clear()
}
