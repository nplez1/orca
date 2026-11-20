import { ipcMain } from 'electron'
import {
  clearDeepInfraApiKey,
  hasDeepInfraApiKey,
  saveDeepInfraApiKey
} from '../deepinfra/deepinfra-api-key-store'
import { noteReplicatedCredentialChanged } from '../host-sync/host-settings-replication-service'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import { recordSwallowedFailure } from '../observability/swallowed-failure'

export type DeepInfraCredentialsStatus = {
  configured: boolean
  apiKeyConfigured: boolean
}

async function getDeepInfraCredentialsStatus(): Promise<DeepInfraCredentialsStatus> {
  const apiKeyConfigured = await hasDeepInfraApiKey()
  return { configured: apiKeyConfigured, apiKeyConfigured }
}

// Why: fire-and-forget — callers get the persisted credential status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterDeepInfraCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateDeepInfraCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    recordSwallowedFailure(
      'deepinfra',
      error,
      `failed to trigger rate-limit refresh after ${action}`,
      'error'
    )
  })
}

export function registerDeepInfraCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('deepinfraCredentials:getStatus', () => getDeepInfraCredentialsStatus())
  ipcMain.handle('deepinfraCredentials:saveApiKey', async (_event, key: string) => {
    // Why: the renderer-declared type is compile-time only; the value arrives as unknown over IPC.
    if (typeof key !== 'string') {
      throw new Error('DeepInfra API key must be a string')
    }
    await saveDeepInfraApiKey(key)
    noteReplicatedCredentialChanged()
    refreshAfterDeepInfraCredentialChange(rateLimits, 'save')
    return await getDeepInfraCredentialsStatus()
  })
  ipcMain.handle('deepinfraCredentials:clearApiKey', async () => {
    await clearDeepInfraApiKey()
    noteReplicatedCredentialChanged()
    refreshAfterDeepInfraCredentialChange(rateLimits, 'clear')
    return await getDeepInfraCredentialsStatus()
  })
}
