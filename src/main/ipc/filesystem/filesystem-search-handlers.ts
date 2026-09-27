import { ipcMain } from 'electron'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { handleFilesystemTextSearch } from './filesystem-text-search-handler'
import { registerFilesystemPathSearchHandler } from './filesystem-path-search-handler'
import { registerFilesystemQuickOpenListingHandler } from './filesystem-quick-open-listing-handler'
import { registerWorkspacePathIndexIpc } from './workspace-path-index-ipc'

export function registerFilesystemSearchHandlers(context: FilesystemHandlerContext): void {
  const pathIndexService = registerWorkspacePathIndexIpc(context)
  ipcMain.handle('fs:search', (event, args) => handleFilesystemTextSearch(event, args, context))
  registerFilesystemQuickOpenListingHandler(context, pathIndexService)
  registerFilesystemPathSearchHandler(context, pathIndexService)
}
