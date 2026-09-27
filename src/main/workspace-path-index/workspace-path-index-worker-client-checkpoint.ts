import { assertWorkerResponse } from './workspace-path-index-worker-response'
import type { WorkspacePathIndexWorkerRequestQueue } from './workspace-path-index-worker-client-queue'
import type { WorkspacePathCheckpointWorkerResult } from './workspace-path-index-worker-protocol'

/**
 * Checkpoint round trips are the client's slowest calls — a write may compact and re-encode a
 * resident catalog in the worker — so they carry their own timeouts rather than the query default.
 */
export async function restoreWorkspacePathCatalogCheckpointInWorker(
  requests: WorkspacePathIndexWorkerRequestQueue,
  args: { key: string; checkpointDirectory: string }
): Promise<WorkspacePathCheckpointWorkerResult> {
  const response = await requests.dispatch(
    (id) => ({ id, type: 'restore-checkpoint', ...args }),
    60_000
  )
  assertWorkerResponse(response)
  return response.checkpoint ?? { status: 'absent', reason: 'absent' }
}

export async function writeWorkspacePathCatalogCheckpointInWorker(
  requests: WorkspacePathIndexWorkerRequestQueue,
  spillDirectory: string | undefined,
  args: {
    key: string
    generationId: string
    checkpointDirectory: string
    maxBytes: number
  }
): Promise<WorkspacePathCheckpointWorkerResult> {
  const response = await requests.dispatch(
    (id) => ({ id, type: 'write-checkpoint', ...args, spillDirectory }),
    300_000
  )
  assertWorkerResponse(response)
  return response.checkpoint ?? { status: 'absent', reason: 'absent' }
}
