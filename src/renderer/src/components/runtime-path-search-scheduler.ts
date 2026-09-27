import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import type { WorkspacePathSearchCorrelationId } from '../../../shared/workspace-path-search-instrumentation'

export type RuntimePathSearchRequest = {
  requestKey: string
  scopeKey: string
  correlationId: WorkspacePathSearchCorrelationId
  inputAt: number
  controller: AbortController
  run: (signal: AbortSignal) => Promise<FilePathSearchResult>
  cancel: () => void
  onQueued: () => void
  onDispatch: () => void
  onResult: (result: FilePathSearchResult) => void
  onError: (error: unknown) => void
  onFinish: () => void
}

export type RuntimePathSearchScheduler = {
  scopeKey: string | null
  latestRequestId: WorkspacePathSearchCorrelationId | null
  active: RuntimePathSearchRequest | null
  pending: RuntimePathSearchRequest | null
  frameId: number | null
  disposed: boolean
}

export function createRuntimePathSearchScheduler(): RuntimePathSearchScheduler {
  return {
    scopeKey: null,
    latestRequestId: null,
    active: null,
    pending: null,
    frameId: null,
    disposed: false
  }
}

export function scheduleLatestRuntimePathSearch(scheduler: RuntimePathSearchScheduler): void {
  if (scheduler.disposed || scheduler.active || !scheduler.pending || scheduler.frameId !== null) {
    return
  }
  scheduler.frameId = window.requestAnimationFrame(() => {
    scheduler.frameId = null
    if (scheduler.disposed || scheduler.active || !scheduler.pending) {
      return
    }
    const request = scheduler.pending
    scheduler.pending = null
    scheduler.active = request
    request.onDispatch()
    void request
      .run(request.controller.signal)
      .then((result) => {
        if (
          !scheduler.disposed &&
          scheduler.scopeKey === request.scopeKey &&
          scheduler.latestRequestId === request.correlationId
        ) {
          request.onResult(result)
        }
      })
      .catch((error: unknown) => {
        if (
          !scheduler.disposed &&
          scheduler.scopeKey === request.scopeKey &&
          scheduler.latestRequestId === request.correlationId &&
          !request.controller.signal.aborted
        ) {
          request.onError(error)
        }
      })
      .finally(() => {
        request.onFinish()
        if (scheduler.active === request) {
          scheduler.active = null
        }
        if (scheduler.pending) {
          scheduleLatestRuntimePathSearch(scheduler)
        }
      })
  })
}

export function queueLatestRuntimePathSearch(
  scheduler: RuntimePathSearchScheduler,
  request: RuntimePathSearchRequest
): void {
  if (scheduler.disposed || scheduler.scopeKey !== request.scopeKey) {
    return
  }
  scheduler.pending?.controller.abort()
  scheduler.pending = request
  scheduler.latestRequestId = request.correlationId
  request.onQueued()
  if (!scheduler.active && scheduler.frameId !== null) {
    window.cancelAnimationFrame(scheduler.frameId)
    scheduler.frameId = null
  }
  scheduleLatestRuntimePathSearch(scheduler)
}

export function changeRuntimePathSearchScope(
  scheduler: RuntimePathSearchScheduler,
  scopeKey: string | null
): void {
  if (scheduler.scopeKey === scopeKey) {
    return
  }
  if (scheduler.frameId !== null) {
    window.cancelAnimationFrame(scheduler.frameId)
    scheduler.frameId = null
  }
  scheduler.pending?.controller.abort()
  scheduler.pending?.cancel()
  scheduler.pending = null
  scheduler.active?.controller.abort()
  scheduler.active?.cancel()
  scheduler.latestRequestId = null
  scheduler.scopeKey = scopeKey
}

export function disposeRuntimePathSearchScheduler(scheduler: RuntimePathSearchScheduler): void {
  if (scheduler.disposed) {
    return
  }
  changeRuntimePathSearchScope(scheduler, null)
  scheduler.disposed = true
}
