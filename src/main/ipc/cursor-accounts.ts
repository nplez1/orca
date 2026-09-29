import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isUsageProviderDisabled } from '../../shared/usage-provider-enablement'
import { disabledCursorAccountStatus, getCursorAccountStatus } from '../cursor-accounts/status'

export function registerCursorAccountHandlers(
  getSettings: () => Pick<GlobalSettings, 'disabledUsageProviders'>
): void {
  ipcMain.handle('cursorAccounts:getStatus', () =>
    // Why: the status read hits the macOS Keychain and the Cursor IDE database,
    // so a disabled Cursor must be answered without any local credential read.
    isUsageProviderDisabled(getSettings().disabledUsageProviders, 'cursor')
      ? disabledCursorAccountStatus()
      : getCursorAccountStatus()
  )
}
