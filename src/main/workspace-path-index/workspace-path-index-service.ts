import { WorkspacePathIndexServiceDelta } from './workspace-path-index-service-delta'

export type { WorkspacePathIndexEnsureResult } from './workspace-path-index-ensure'

export type { WorkspacePathIndexCheckpointRestore } from './workspace-path-index-checkpoint-adoption'

export type {
  WorkspacePathIndexSearchResult,
  WorkspacePathIndexServiceOptions,
  WorkspacePathIndexWorkerQuery
} from './workspace-path-index-service-options'

/** Execution-host owner for leases, authorization, byte admission, and worker scheduling. */
export class WorkspacePathIndexService extends WorkspacePathIndexServiceDelta {
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.searcher.dispose()
    this.buildLane.dispose()
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry)
    }
    this.leases.clear()
    this.options.shutdownWorker?.()
  }
}
