import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'

export type WorkspacePathIndexWorkerBuildResultBundle = {
  build: {
    buildId: string
    readyScope: WorkspacePathSearchPathSet
    generationId: string
    retainedBytes: number
    trigramPostingsBytes?: number
    storageMode?: 'packed-folded' | 'disk-spilled'
    spillFileBytes?: number
    complete: boolean
    degradationReason?: string
  }
  events: WorkspacePathSearchInstrumentationEvent[]
}

export function createWorkspacePathIndexPartialBuildResult(args: {
  buildId: string
  readyScope: WorkspacePathSearchPathSet
  generationId: string
  retainedBytes: number
  events: WorkspacePathSearchInstrumentationEvent[]
  degradationReason: string
  storageMode?: 'packed-folded' | 'disk-spilled'
  spillFileBytes?: number
}): WorkspacePathIndexWorkerBuildResultBundle {
  return {
    build: {
      buildId: args.buildId,
      readyScope: args.readyScope,
      generationId: args.generationId,
      retainedBytes: args.retainedBytes,
      ...(args.storageMode ? { storageMode: args.storageMode } : {}),
      ...(args.spillFileBytes === undefined ? {} : { spillFileBytes: args.spillFileBytes }),
      complete: false,
      degradationReason: args.degradationReason
    },
    events: args.events.splice(0)
  }
}
