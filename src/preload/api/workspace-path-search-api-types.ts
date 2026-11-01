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

/**
 * The fork's workspace-path-search surface. Electron-free on purpose: `FilesystemApi` is upstream's
 * electron-free type module and must not reach a module that imports `electron`.
 */
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
