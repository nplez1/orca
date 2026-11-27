import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { isUsageProviderDisabled } from '../../../shared/usage-provider-enablement'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { disabledCursorAccountStatus, getCursorAccountStatus } from '../../cursor-accounts/status'

export function registerCursorAccountHandlers(
  getSettings: () => Pick<GlobalSettings, 'disabledUsageProviders'>,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('cursorAccounts:getStatus', () =>
    // Why: the status read hits the macOS Keychain and the Cursor IDE database,
    // so a disabled Cursor must be answered without any local credential read.
    isUsageProviderDisabled(getSettings().disabledUsageProviders, 'cursor')
      ? disabledCursorAccountStatus()
      : getCursorAccountStatus()
  )
}
