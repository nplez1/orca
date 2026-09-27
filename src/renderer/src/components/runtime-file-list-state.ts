import type { WorkspacePathSearchResponse } from '../../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchCorrelationId } from '../../../shared/workspace-path-search-instrumentation'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'

export type RuntimeFileListState = {
  files: string[]
  loading: boolean
  loadError: string | null
  /** True as soon as a replacement is pending, before delayed visible loading feedback. */
  searching?: boolean
  /** The visible page belongs to an older query while its replacement is pending. */
  previousResults?: boolean
  resultQuery?: string
  correlationId?: WorkspacePathSearchCorrelationId
  workspacePathSearch?: WorkspacePathSearchResponse
  scopeIdentity?: string
  truncated?: boolean
  /** Exact match count a query-scoped host search scanned; null for an unscoped listing. */
  totalCount?: number | null
  /**
   * Subset of `files` the host already knows are gitignored, when it answered from its path
   * inventory. Undefined means the caller must resolve ignored status itself.
   */
  ignoredFiles?: string[]
  operationOwner?: FileExplorerOperationOwner
}
