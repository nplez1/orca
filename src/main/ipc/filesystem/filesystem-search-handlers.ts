import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { registerFilesystemPathSearchHandler } from './filesystem-path-search-handler'
import { registerFilesystemQuickOpenListingHandler } from './filesystem-quick-open-listing-handler'
import { registerWorkspacePathIndexIpc } from './workspace-path-index-ipc'
import { registerFilesystemTextSearchHandler } from './filesystem-text-search-handler'

export function registerFilesystemSearchHandlers(context: FilesystemHandlerContext): void {
  const pathIndexService = registerWorkspacePathIndexIpc(context)
  registerFilesystemTextSearchHandler(context)
  registerFilesystemQuickOpenListingHandler(context, pathIndexService)
  registerFilesystemPathSearchHandler(context, pathIndexService)
}
