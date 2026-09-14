import { ipcMain } from 'electron'
import {
  clearCopilotCredentials,
  hasCopilotCredentials,
  readCopilotCredentials,
  saveCopilotCredentials
} from '../copilot-credentials/copilot-credentials-store'
import type { RateLimitService } from '../rate-limits/service'

export type CopilotCredentialsStatus = {
  configured: boolean
  enterpriseSlug: string | null
}

function getCopilotCredentialsStatus(): CopilotCredentialsStatus {
  const configured = hasCopilotCredentials()
  let enterpriseSlug: string | null = null
  try {
    // Why: the renderer never receives the token, only the slug it needs to echo back
    // into the form the way the Fireworks account-ID override does.
    enterpriseSlug = readCopilotCredentials()?.enterpriseSlug ?? null
  } catch (error) {
    console.error('[copilot] failed to read stored credentials:', error)
  }
  return { configured, enterpriseSlug }
}

// Why: fire-and-forget — callers get the persisted credential status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterCopilotCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateCopilotCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[copilot] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerCopilotCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('copilotCredentials:getStatus', () => getCopilotCredentialsStatus())
  ipcMain.handle('copilotCredentials:save', (_event, token: string, enterpriseSlug: unknown) => {
    if (typeof token !== 'string' || typeof enterpriseSlug !== 'string') {
      throw new Error('GitHub Copilot credentials must be a token and an enterprise slug')
    }
    // Why: the enterprise slug has to be editable without re-pasting the token, and the
    // renderer never receives the stored token to send back. A blank token therefore
    // means "keep the stored one" once credentials exist.
    let nextToken = token.trim()
    if (!nextToken) {
      nextToken = readCopilotCredentials()?.token.trim() ?? ''
    }
    if (!nextToken) {
      throw new Error('GitHub token is required')
    }
    saveCopilotCredentials({ token: nextToken, enterpriseSlug })
    refreshAfterCopilotCredentialChange(rateLimits, 'save')
    return getCopilotCredentialsStatus()
  })
  ipcMain.handle('copilotCredentials:clear', () => {
    clearCopilotCredentials()
    refreshAfterCopilotCredentialChange(rateLimits, 'clear')
    return getCopilotCredentialsStatus()
  })
}
