import { existsSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'

export const WORKSPACE_PATH_INDEX_WORKER_ENTRY_FILENAME = 'workspace-path-index-worker-entry.js'

export function createDefaultWorkspacePathIndexWorker(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKSPACE_PATH_INDEX_WORKER_ENTRY_FILENAME
  )
  if (!existsSync(workerPath)) {
    throw new Error(`Workspace path index worker entry not found: ${workerPath}`)
  }
  return spawnWorkerThread(workerPath)
}
