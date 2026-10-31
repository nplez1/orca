import { ipcRenderer } from 'electron'
import type {
  AcquireQuickOpenPathInventoryLeaseArgs,
  SearchFilePathArgs,
  WorkspacePathSearchApi,
  WorkspacePathSearchInstrumentationExportRecord
} from './workspace-path-search-api-types'

/**
 * The fork's workspace-path-search bridge methods, spread into `fsApi` so upstream's bridge file
 * carries one import and one spread instead of five method bodies and their argument types.
 */
export const workspacePathSearchBridgeApi: WorkspacePathSearchApi = {
  searchFilePaths: (args: SearchFilePathArgs) => ipcRenderer.invoke('fs:searchFilePaths', args),
  acquireQuickOpenPathInventoryLease: (args: AcquireQuickOpenPathInventoryLeaseArgs) =>
    ipcRenderer.invoke('fs:acquireQuickOpenPathInventoryLease', args),
  releaseQuickOpenPathInventoryLease: (args: { leaseId: string }): Promise<void> =>
    ipcRenderer.invoke('fs:releaseQuickOpenPathInventoryLease', args),
  exportWorkspacePathSearchInstrumentation: (): Promise<
    WorkspacePathSearchInstrumentationExportRecord[]
  > => ipcRenderer.invoke('fs:exportWorkspacePathSearchInstrumentation'),
  getWorkspacePathSearchDiagnosticsSummary: () =>
    ipcRenderer.invoke('fs:getWorkspacePathSearchDiagnosticsSummary')
}
