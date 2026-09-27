import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import { errorMessage } from './workspace-path-index-worker-response'
import { workerTransferList } from './workspace-path-index-worker-transfer'
import type {
  WorkspacePathIndexWorkerRequest,
  WorkspacePathIndexWorkerResponse
} from './workspace-path-index-worker-protocol'

export type WorkspacePathIndexWorkerRequestQueue = WorkerThreadRequestQueue<
  WorkspacePathIndexWorkerRequest,
  WorkspacePathIndexWorkerResponse
>

/** Request-queue policy for the path-index worker: idle teardown, queue cap, crash-loop limit. */
export function createWorkspacePathIndexWorkerRequestQueue(args: {
  workerFactory: WorkerThreadFactory
  log: (message: string) => void
  maxConsecutiveDeaths: number
}): WorkspacePathIndexWorkerRequestQueue {
  return new WorkerThreadRequestQueue({
    factory: args.workerFactory,
    idleTeardownMs: 5 * 60_000,
    maxConsecutiveDeaths: args.maxConsecutiveDeaths,
    queueCap: {
      maxQueuedCalls: 128,
      describeFull: () => 'Workspace path index worker queue is full'
    },
    transferList: workerTransferList,
    createUnavailableError: (message) => new Error(message),
    describeTimeout: (timeoutMs) => `Workspace path index worker stalled for ${timeoutMs}ms`,
    describeExit: (code) => `Workspace path index worker exited with code ${code}`,
    describeCrashLoop: (lastError) =>
      `Workspace path index worker crashed repeatedly (${lastError})`,
    onUnavailable: (error) =>
      args.log(
        `[workspace-path-index] worker unavailable; search will degrade. ${errorMessage(error)}`
      )
  })
}
