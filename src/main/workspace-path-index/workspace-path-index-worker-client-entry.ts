import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'

export const WORKSPACE_PATH_INDEX_WORKER_ENTRY_FILENAME = 'workspace-path-index-worker-entry.js'

export function createDefaultWorkspacePathIndexWorker(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKSPACE_PATH_INDEX_WORKER_ENTRY_FILENAME
  )
  if (!existsSync(workerPath)) {
    throw new Error(`Workspace path index worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}
