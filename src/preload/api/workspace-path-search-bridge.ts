import { ipcRenderer } from 'electron'
import type { FilePathSearchResult } from '../../shared/file-path-search-result'
import type { PathSearchMode } from '../../shared/quick-open-path-search'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchDiagnosticsSummary,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'

export type SearchFilePathArgs = {
  rootPath: string
  connectionId?: string
  excludePaths?: string[]
  requestToken?: string
  query: string
  limit?: number
  mode?: PathSearchMode
  includeIgnoredFiles?: boolean
  includeDotfiles?: boolean
  correlationId?: WorkspacePathSearchCorrelationId
  consumerId?: string
  consumerSequence?: number
}

export type AcquireQuickOpenPathInventoryLeaseArgs = {
  rootPath: string
  includeIgnoredFiles: boolean
  correlationId?: WorkspacePathSearchCorrelationId
}

export type WorkspacePathSearchInstrumentationExportRecord = {
  correlationId: WorkspacePathSearchCorrelationId
  workspaceIdentityHash: string
  events: readonly WorkspacePathSearchInstrumentationEvent[]
}

/** The bridge half of the fork's workspace-path-search surface, as the preload API declares it. */
export type WorkspacePathSearchApi = {
  searchFilePaths: (args: SearchFilePathArgs) => Promise<FilePathSearchResult>
  acquireQuickOpenPathInventoryLease: (
    args: AcquireQuickOpenPathInventoryLeaseArgs
  ) => Promise<{ leaseId: string | null }>
  releaseQuickOpenPathInventoryLease: (args: { leaseId: string }) => Promise<void>
  /** Available only in development builds for explicit performance-artifact export. */
  exportWorkspacePathSearchInstrumentation: () => Promise<
    WorkspacePathSearchInstrumentationExportRecord[]
  >
  getWorkspacePathSearchDiagnosticsSummary: () => Promise<WorkspacePathSearchDiagnosticsSummary>
}

/**
 * The fork's workspace-path-search bridge methods, spread into `fsApi` so upstream's bridge file
 * carries one import and one spread instead of five method bodies and their argument types.
 */
export const workspacePathSearchBridgeApi: WorkspacePathSearchApi = {
  searchFilePaths: (args: SearchFilePathArgs): Promise<FilePathSearchResult> =>
    ipcRenderer.invoke('fs:searchFilePaths', args),
  acquireQuickOpenPathInventoryLease: (
    args: AcquireQuickOpenPathInventoryLeaseArgs
  ): Promise<{ leaseId: string | null }> =>
    ipcRenderer.invoke('fs:acquireQuickOpenPathInventoryLease', args),
  releaseQuickOpenPathInventoryLease: (args: { leaseId: string }): Promise<void> =>
    ipcRenderer.invoke('fs:releaseQuickOpenPathInventoryLease', args),
  exportWorkspacePathSearchInstrumentation: (): Promise<
    WorkspacePathSearchInstrumentationExportRecord[]
  > => ipcRenderer.invoke('fs:exportWorkspacePathSearchInstrumentation'),
  getWorkspacePathSearchDiagnosticsSummary: (): Promise<WorkspacePathSearchDiagnosticsSummary> =>
    ipcRenderer.invoke('fs:getWorkspacePathSearchDiagnosticsSummary')
}
