import { createSecureCredentialStore } from '../credentials/secure-credential-store'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

const minimaxApiKeyStore = createSecureCredentialStore({
  fileName: 'minimax-api-key.enc',
  envelopePrefix: 'orca-minimax-api-key:v1:',
  description: 'MiniMax API key',
  logTag: '[minimax]'
})

export function hasMiniMaxApiKey(): boolean {
  return minimaxApiKeyStore.has()
}

/**
 * How the stored key is protected, or null when none is stored.
 *
 * Reads the envelope kind only — no decrypt, so this cannot trigger a keychain prompt
 * and is safe to call from a status handler.
 */
export function getMiniMaxApiKeyProtection(): SecretAtRestProtection | null {
  return minimaxApiKeyStore.protection()
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
