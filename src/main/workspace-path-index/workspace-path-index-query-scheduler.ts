export type WorkspacePathIndexQueryCancellation = {
  isCancelled(): boolean
}

type ScheduledQuery<TRequest, TResult> = {
  consumerKey: string
  request: TRequest
  cancelled: boolean
  resolve: (value: TResult | null) => void
}

/** Latest-query scheduler with a bounded, fair queue across consumers. */
export class WorkspacePathIndexQueryScheduler<TRequest, TResult> {
  private readonly pendingByConsumer = new Map<string, ScheduledQuery<TRequest, TResult>>()
  private readonly readyConsumers: string[] = []
  private readonly runningByConsumer = new Map<string, ScheduledQuery<TRequest, TResult>>()
  private running: ScheduledQuery<TRequest, TResult> | null = null
  private disposed = false

  constructor(
    private readonly execute: (
      request: TRequest,
      cancellation: WorkspacePathIndexQueryCancellation
    ) => Promise<TResult>,
    private readonly sendCancellation: (consumerKey: string) => void,
    private readonly maxPendingConsumers = 64,
    private readonly onFailure?: (consumerKey: string) => void
  ) {}

  get pendingConsumerCount(): number {
    return this.pendingByConsumer.size
  }

  get activeConsumerKey(): string | null {
    return this.running?.consumerKey ?? null
  }

  submit(consumerKey: string, request: TRequest): Promise<TResult | null> {
    if (this.disposed) {
      return Promise.resolve(null)
    }
    const previousPending = this.pendingByConsumer.get(consumerKey)
    if (!previousPending && this.pendingByConsumer.size >= this.maxPendingConsumers) {
      return Promise.reject(new Error('Workspace path query scheduler is full'))
    }
    if (previousPending) {
      previousPending.resolve(null)
    } else if (!this.readyConsumers.includes(consumerKey)) {
      this.readyConsumers.push(consumerKey)
    }
    const running = this.runningByConsumer.get(consumerKey)
    if (running) {
      running.cancelled = true
      this.sendCancellation(consumerKey)
    }
    return new Promise((resolve) => {
      this.pendingByConsumer.set(consumerKey, { consumerKey, request, cancelled: false, resolve })
      this.pump()
    })
  }

  cancel(consumerKey: string): void {
    this.pendingByConsumer.get(consumerKey)?.resolve(null)
    this.pendingByConsumer.delete(consumerKey)
    removeConsumer(this.readyConsumers, consumerKey)
    const running = this.runningByConsumer.get(consumerKey)
    if (running) {
      running.cancelled = true
      this.sendCancellation(consumerKey)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [consumerKey, query] of this.pendingByConsumer) {
      query.resolve(null)
      removeConsumer(this.readyConsumers, consumerKey)
    }
    this.pendingByConsumer.clear()
    for (const [consumerKey, query] of this.runningByConsumer) {
      query.cancelled = true
      this.sendCancellation(consumerKey)
    }
  }

  private pump(): void {
    if (this.running || this.disposed) {
      return
    }
    const consumerKey = this.readyConsumers.shift()
    if (!consumerKey) {
      return
    }
    const query = this.pendingByConsumer.get(consumerKey)
    if (!query) {
      this.pump()
      return
    }
    this.pendingByConsumer.delete(consumerKey)
    this.running = query
    this.runningByConsumer.set(consumerKey, query)
    const cancellation = { isCancelled: (): boolean => query.cancelled || this.disposed }
    void this.execute(query.request, cancellation)
      .then((result) => query.resolve(query.cancelled ? null : result))
      .catch(() => {
        if (!query.cancelled && !this.disposed) {
          this.onFailure?.(consumerKey)
        }
        query.resolve(null)
      })
      .finally(() => {
        this.runningByConsumer.delete(consumerKey)
        if (this.running === query) {
          this.running = null
        }
        if (this.pendingByConsumer.has(consumerKey) && !this.readyConsumers.includes(consumerKey)) {
          this.readyConsumers.push(consumerKey)
        }
        this.pump()
      })
  }
}

function removeConsumer(queue: string[], consumerKey: string): void {
  const index = queue.indexOf(consumerKey)
  if (index !== -1) {
    queue.splice(index, 1)
  }
}
