import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { isUsageProviderDisabled } from '../../../shared/usage-provider-enablement'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { disabledGrokAccountStatus, getGrokAccountStatus } from '../../grok-accounts/status'

export function registerGrokAccountHandlers(
  getSettings: () => Pick<GlobalSettings, 'disabledUsageProviders'>,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('grokAccounts:getStatus', () =>
    // Why: the status read parses ~/.grok/auth.json, so a disabled Grok must be
    // answered without any local credential read.
    isUsageProviderDisabled(getSettings().disabledUsageProviders, 'grok')
      ? disabledGrokAccountStatus()
      : getGrokAccountStatus()
  )
}
