import { ipcMain } from 'electron'
import {
  refreshCopilotGhCredentials,
  type CopilotGhCredentialsResult
} from '../rate-limits/copilot/copilot-gh-credentials'

/** Whether the GitHub CLI sign-in can read the user's Copilot entitlement. */
export type CopilotGhStatus = CopilotGhCredentialsResult['status']

export type CopilotCredentialsStatus = {
  configured: boolean
  ghStatus: CopilotGhStatus
  /** The command that would make the GitHub CLI usable, when that is the blocker. */
  ghSetupHint: string | null
}

/** The exact command to grant the scope the entitlement read needs. */
function ghSetupHintFor(gh: CopilotGhCredentialsResult): string | null {
  if (gh.status === 'missing-scope') {
    return `gh auth refresh ${gh.missing.map((scope) => `-s ${scope}`).join(' ')}`
  }
  return gh.status === 'unauthenticated' ? 'gh auth login' : null
}

async function getCopilotCredentialsStatus(): Promise<CopilotCredentialsStatus> {
  // Why this probe rather than a plain resolve: the pane's Re-check lands here, and the
  // fetch cycle reads the same cache — a probe fresh enough to show the user their new
  // scope has to be the one the provider then refetches from.
  const gh = await refreshCopilotGhCredentials()
  return {
    configured: gh.status === 'ok',
    ghStatus: gh.status,
    ghSetupHint: ghSetupHintFor(gh)
  }
}

// Why no save/clear: the GitHub CLI's own sign-in is this provider's only credential —
// there is nothing for Orca to store, so the pane only ever reads this status.
export function registerCopilotCredentialsHandlers(): void {
  ipcMain.handle('copilotCredentials:getStatus', () => getCopilotCredentialsStatus())
}
