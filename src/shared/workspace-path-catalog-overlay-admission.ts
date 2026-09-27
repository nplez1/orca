import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'

/** Admission reservation for one delta entry, sized by path length and ASCII-ness. */
export function estimateWorkspacePathCatalogOverlayEntryReservation(path: string): number {
  let ascii = true
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) > 127) {
      ascii = false
      break
    }
  }
  return path.length * (ascii ? 8 : 12) + 256
}

export function emitWorkspacePathCatalogOverlayStage(args: {
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  correlationId: WorkspacePathSearchCorrelationId
  stage: 'normalization' | 'sort' | 'index-publication'
  milliseconds: number
}): void {
  args.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId: args.correlationId,
      stage: args.stage,
      duration: { milliseconds: args.milliseconds, clock: 'execution-host-monotonic' }
    }
  })
}
