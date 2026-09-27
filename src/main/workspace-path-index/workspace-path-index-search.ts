import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchCorrelationId } from '../../shared/workspace-path-search-instrumentation'
import { WorkspacePathIndexQueryScheduler } from './workspace-path-index-query-scheduler'
import { workspacePathIndexConsumerKey } from './workspace-path-index-lease'
import type { WorkspacePathIndexQueryCancellation } from './workspace-path-index-query-scheduler'

export type WorkspacePathIndexQueryRequest = {
  key: string
  identity: WorkspacePathSearchFenceIdentity
  correlationId: WorkspacePathSearchCorrelationId
  cancellation: WorkspacePathIndexQueryCancellation
}

/** Owns latest-per-consumer query scheduling and worker-loss fencing. */
export class WorkspacePathIndexSearch {
  private readonly queryEntryByConsumer = new Map<string, { entryKey: string; sequence: number }>()
  private readonly failedConsumers = new Set<string>()
  private readonly scheduler: WorkspacePathIndexQueryScheduler<
    Omit<WorkspacePathIndexQueryRequest, 'cancellation'>,
    WorkspacePathSearchResponse
  >

  constructor(args: {
    query: (request: WorkspacePathIndexQueryRequest) => Promise<WorkspacePathSearchResponse>
    cancelQuery?: (consumerKey: string) => void
    maxPendingConsumers: number
    onWorkerFailure: (consumerKey: string) => void
  }) {
    this.scheduler = new WorkspacePathIndexQueryScheduler(
      (request, cancellation) => args.query({ ...request, cancellation }),
      (consumerKey) => args.cancelQuery?.(consumerKey),
      args.maxPendingConsumers,
      (consumerKey) => {
        this.failedConsumers.add(consumerKey)
        args.onWorkerFailure(consumerKey)
      }
    )
  }

  async search(args: {
    key: string
    identity: WorkspacePathSearchFenceIdentity
    correlationId: WorkspacePathSearchCorrelationId
  }): Promise<
    { ready: true; response: WorkspacePathSearchResponse } | { ready: false; reason: string }
  > {
    const consumerKey = workspacePathIndexConsumerKey(args.identity)
    this.queryEntryByConsumer.set(consumerKey, {
      entryKey: args.key,
      sequence: args.identity.consumer.sequence
    })
    try {
      const response = await this.scheduler.submit(consumerKey, args)
      if (response) {
        return { ready: true, response }
      }
      const workerFailed = this.failedConsumers.delete(consumerKey)
      return { ready: false, reason: workerFailed ? 'failed' : 'cancelled' }
    } finally {
      if (
        this.queryEntryByConsumer.get(consumerKey)?.sequence === args.identity.consumer.sequence
      ) {
        this.queryEntryByConsumer.delete(consumerKey)
      }
    }
  }

  cancelLocalConsumer(consumerId: string): void {
    this.scheduler.cancel(`local:${process.pid}:${consumerId}`)
  }

  cancelEntry(entryKey: string): void {
    for (const [consumerKey, query] of this.queryEntryByConsumer) {
      if (query.entryKey === entryKey) {
        this.scheduler.cancel(consumerKey)
        this.queryEntryByConsumer.delete(consumerKey)
      }
    }
  }

  dispose(): void {
    this.scheduler.dispose()
    this.queryEntryByConsumer.clear()
    this.failedConsumers.clear()
  }
}
