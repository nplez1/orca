import { ipcMain } from 'electron'
import {
  clearFireworksCredentials,
  hasFireworksCredentials,
  readFireworksCredentials,
  saveFireworksCredentials
} from '../fireworks/fireworks-credentials-store'
import type { RateLimitService } from '../rate-limits/service'

export type FireworksCredentialsStatus = {
  configured: boolean
  apiKeyConfigured: boolean
  accountIdOverride: string | null
}

function getFireworksCredentialsStatus(): FireworksCredentialsStatus {
  const apiKeyConfigured = hasFireworksCredentials()
  let accountIdOverride: string | null = null
  try {
    accountIdOverride = readFireworksCredentials()?.accountIdOverride ?? null
  } catch (error) {
    // Why: an undecryptable file must not break the whole Accounts pane; the
    // status call only exists to seed the form's draft fields.
    console.error('[fireworks] failed to read stored credentials:', error)
  }
  return { configured: apiKeyConfigured, apiKeyConfigured, accountIdOverride }
}

// Why: fire-and-forget — callers get the persisted credential status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterFireworksCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateFireworksCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[fireworks] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerFireworksCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('fireworksCredentials:getStatus', () => getFireworksCredentialsStatus())
  ipcMain.handle(
    'fireworksCredentials:save',
    (_event, apiKey: string, accountIdOverride: unknown) => {
      if (
        typeof apiKey !== 'string' ||
        (accountIdOverride !== null &&
          accountIdOverride !== undefined &&
          typeof accountIdOverride !== 'string')
      ) {
        throw new Error('Fireworks credentials must be an API key and an optional account ID')
      }
      const trimmedOverride = typeof accountIdOverride === 'string' ? accountIdOverride.trim() : ''
      // Why: the account-ID override has to be editable without re-pasting the key,
      // and the renderer never receives the stored key to send back. A blank key
      // therefore means "keep the stored one" once credentials exist.
      let nextApiKey = apiKey.trim()
      if (!nextApiKey) {
        nextApiKey = readFireworksCredentials()?.apiKey.trim() ?? ''
      }
      if (!nextApiKey) {
        throw new Error('Fireworks API key is required')
      }
      saveFireworksCredentials({ apiKey: nextApiKey, accountIdOverride: trimmedOverride || null })
      refreshAfterFireworksCredentialChange(rateLimits, 'save')
      return getFireworksCredentialsStatus()
    }
  )
  ipcMain.handle('fireworksCredentials:clear', () => {
    clearFireworksCredentials()
    refreshAfterFireworksCredentialChange(rateLimits, 'clear')
    return getFireworksCredentialsStatus()
  })
}
