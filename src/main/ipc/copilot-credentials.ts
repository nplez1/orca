import { ipcMain } from 'electron'
import {
  clearCopilotCredentials,
  hasCopilotCredentials,
  readCopilotCredentials,
  saveCopilotCredentials
} from '../copilot-credentials/copilot-credentials-store'
import {
  resolveGhCopilotCredentials,
  type CopilotGhCredentialsResult
} from '../rate-limits/copilot/copilot-gh-credentials'
import type { RateLimitService } from '../rate-limits/service'

/** Where Copilot usage credentials came from, so the pane can explain itself. */
export type CopilotCredentialsSource = 'stored' | 'github-cli' | 'none'

export type CopilotCredentialsStatus = {
  configured: boolean
  enterpriseSlug: string | null
  source: CopilotCredentialsSource
  /** The command that would make the GitHub CLI usable, when that is the blocker. */
  ghSetupHint: string | null
}

/** The exact command to grant the scopes Copilot billing reads need. */
function ghSetupHintFor(gh: CopilotGhCredentialsResult): string | null {
  if (gh.status === 'missing-scope') {
    return `gh auth refresh ${gh.missing.map((scope) => `-s ${scope}`).join(' ')}`
  }
  return gh.status === 'unauthenticated' ? 'gh auth login' : null
}

function readStoredEnterpriseSlug(): string | null {
  try {
    return readCopilotCredentials()?.enterpriseSlug ?? null
  } catch (error) {
    // Why: an undecryptable file must not break the pane; the form only needs a draft.
    console.error('[copilot] failed to read stored credentials:', error)
    return null
  }
}

async function getCopilotCredentialsStatus(): Promise<CopilotCredentialsStatus> {
  const storedSlug = readStoredEnterpriseSlug()
  const storedConfigured = hasCopilotCredentials() && storedSlug !== null
  if (storedConfigured) {
    return { configured: true, enterpriseSlug: storedSlug, source: 'stored', ghSetupHint: null }
  }
  const gh = await resolveGhCopilotCredentials()
  if (gh.status === 'ok') {
    return {
      configured: true,
      enterpriseSlug: null,
      source: 'github-cli',
      ghSetupHint: null
    }
  }
  return {
    configured: false,
    enterpriseSlug: null,
    source: 'none',
    ghSetupHint: ghSetupHintFor(gh)
  }
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
  ipcMain.handle(
    'copilotCredentials:save',
    async (_event, token: string, enterpriseSlug: unknown) => {
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
      return await getCopilotCredentialsStatus()
    }
  )
  ipcMain.handle('copilotCredentials:clear', async () => {
    clearCopilotCredentials()
    refreshAfterCopilotCredentialChange(rateLimits, 'clear')
    return await getCopilotCredentialsStatus()
  })
}
