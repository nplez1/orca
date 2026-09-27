import type {
  RendererMonotonicDuration,
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchStageTiming,
  WorkspacePathSearchTimingStage
} from '../../../../shared/workspace-path-search-instrumentation'
type RendererProjectionChunkTiming = {
  correlationId: WorkspacePathSearchCorrelationId
  stage: 'projection-chunk'
  duration: RendererMonotonicDuration
}
type RendererPathSearchDiagnostics = readonly (
  | WorkspacePathSearchStageTiming
  | RendererProjectionChunkTiming
)[]

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __orcaWorkspacePathSearchTimings?: () => Promise<RendererPathSearchDiagnostics>
  }
}

const MAX_RENDERER_TIMING_RECORDS = 500
const rendererTimings: WorkspacePathSearchStageTiming[] = []
const projectionPreparedAtByCorrelationId = new Map<string, number>()

export function recordRendererPathSearchDuration(
  correlationId: WorkspacePathSearchCorrelationId,
  stage: Extract<
    WorkspacePathSearchTimingStage,
    'input-to-dispatch' | 'projection' | 'commit' | 'query-tagged-paint'
  >,
  milliseconds: number
): void {
  if (!import.meta.env.DEV || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return
  }
  const duration: RendererMonotonicDuration = {
    milliseconds,
    clock: 'renderer-monotonic'
  }
  rendererTimings.push({ correlationId, stage, duration })
  if (rendererTimings.length > MAX_RENDERER_TIMING_RECORDS) {
    rendererTimings.splice(0, rendererTimings.length - MAX_RENDERER_TIMING_RECORDS)
  }
}

export function recordRendererPathSearchProjectionChunk(
  correlationId: WorkspacePathSearchCorrelationId,
  milliseconds: number
): void {
  if (!import.meta.env.DEV || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return
  }
  rendererTimings.push({
    correlationId,
    stage: 'projection-chunk',
    duration: { milliseconds, clock: 'renderer-monotonic' }
  })
  if (rendererTimings.length > MAX_RENDERER_TIMING_RECORDS) {
    rendererTimings.splice(0, rendererTimings.length - MAX_RENDERER_TIMING_RECORDS)
  }
}

export function markRendererPathSearchProjectionReady(
  correlationId: WorkspacePathSearchCorrelationId
): void {
  if (!import.meta.env.DEV) {
    return
  }
  projectionPreparedAtByCorrelationId.set(correlationId, performance.now())
  while (projectionPreparedAtByCorrelationId.size > MAX_RENDERER_TIMING_RECORDS) {
    const oldestId = projectionPreparedAtByCorrelationId.keys().next().value
    if (oldestId === undefined) {
      return
    }
    projectionPreparedAtByCorrelationId.delete(oldestId)
  }
}

export function recordRendererPathSearchCommit(
  correlationId: WorkspacePathSearchCorrelationId
): void {
  if (!import.meta.env.DEV) {
    return
  }
  const preparedAt = projectionPreparedAtByCorrelationId.get(correlationId)
  if (preparedAt === undefined) {
    return
  }
  projectionPreparedAtByCorrelationId.delete(correlationId)
  recordRendererPathSearchDuration(
    correlationId,
    'commit',
    Math.max(0, performance.now() - preparedAt)
  )
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      recordRendererPathSearchDuration(
        correlationId,
        'query-tagged-paint',
        Math.max(0, performance.now() - preparedAt)
      )
    })
  })
}

if (
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  !window.__orcaWorkspacePathSearchTimings
) {
  window.__orcaWorkspacePathSearchTimings = async () => rendererTimings.slice()
}
