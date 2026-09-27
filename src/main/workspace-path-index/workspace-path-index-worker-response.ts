import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import type { WorkspacePathIndexWorkerResponse } from './workspace-path-index-worker-protocol'

export function assertWorkerResponse(response: WorkspacePathIndexWorkerResponse): void {
  if (!response.ok) {
    throw new Error(response.error ?? 'Workspace path index worker failed')
  }
}

export function collectEvents(
  events: readonly WorkspacePathSearchInstrumentationEvent[] | undefined,
  onEvent: ((event: WorkspacePathSearchInstrumentationEvent) => void) | undefined
): void {
  for (const event of events ?? []) {
    onEvent?.(event)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
