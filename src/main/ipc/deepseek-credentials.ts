import { ipcMain } from 'electron'
import {
  clearDeepSeekApiKey,
  hasDeepSeekApiKey,
  saveDeepSeekApiKey
} from '../deepseek/deepseek-api-key-store'
import type { RateLimitService } from '../rate-limits/service'

export type DeepSeekCredentialsStatus = {
  configured: boolean
  apiKeyConfigured: boolean
}

function getDeepSeekCredentialsStatus(): DeepSeekCredentialsStatus {
  const apiKeyConfigured = hasDeepSeekApiKey()
  return { configured: apiKeyConfigured, apiKeyConfigured }
}

// Why: fire-and-forget — callers get the persisted credential status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterDeepSeekCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateDeepSeekCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[deepseek] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerDeepSeekCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('deepseekCredentials:getStatus', () => getDeepSeekCredentialsStatus())
  ipcMain.handle('deepseekCredentials:saveApiKey', (_event, key: string) => {
    // Validate the IPC argument in the main process; the renderer-declared type
    // is compile-time only and the value arrives as unknown over IPC.
    if (typeof key !== 'string') {
      throw new Error('DeepSeek API key must be a string')
    }
    saveDeepSeekApiKey(key)
    refreshAfterDeepSeekCredentialChange(rateLimits, 'save')
    return getDeepSeekCredentialsStatus()
  })
  ipcMain.handle('deepseekCredentials:clearApiKey', () => {
    clearDeepSeekApiKey()
    refreshAfterDeepSeekCredentialChange(rateLimits, 'clear')
    return getDeepSeekCredentialsStatus()
  })
}
