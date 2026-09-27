import type { TransferListItem } from 'node:worker_threads'
import type { WorkerRequestTransport } from './lazy-worker-thread-host'

type ConcurrentCall<TRequest, TResponse> = {
  request: TRequest
  timeoutMs: number
  resolve: (response: TResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

/** Bounded by the caller's domain scheduler; requests bypass the serial build lane. */
export class WorkerThreadConcurrentRequestRegistry<
  TRequest extends { id: number },
  TResponse extends { id: number }
> {
  private readonly calls = new Map<number, ConcurrentCall<TRequest, TResponse>>()
  private disposed = false

  constructor(
    private readonly options: {
      ensureWorker: () => WorkerRequestTransport | null
      clearIdleTimer: () => void
      scheduleIdleTeardown: () => void
      transferList?: (request: TRequest) => readonly TransferListItem[]
      isProgress?: (response: { id: number }) => boolean
      createUnavailableError: (message: string) => Error
      describeTimeout: (timeoutMs: number) => string
      onTimeout: (error: Error) => void
      maxConcurrentCalls?: number
    }
  ) {}

  get size(): number {
    return this.calls.size
  }

  dispatch(request: TRequest, timeoutMs: number): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(this.options.createUnavailableError('worker request queue is disposed'))
        return
      }
      if (this.calls.size >= (this.options.maxConcurrentCalls ?? 4)) {
        reject(new Error('worker concurrent request limit reached'))
        return
      }
      const worker = this.options.ensureWorker()
      if (!worker) {
        reject(this.options.createUnavailableError('worker spawn failed'))
        return
      }
      this.options.clearIdleTimer()
      const call: ConcurrentCall<TRequest, TResponse> = {
        request,
        timeoutMs,
        resolve,
        reject,
        timer: null
      }
      this.calls.set(request.id, call)
      this.armDeadline(call)
      try {
        worker.postMessage(request, this.options.transferList?.(request))
      } catch (error) {
        this.calls.delete(request.id)
        this.settle(call, () => reject(asError(error)))
      }
    })
  }

  handleMessage(response: TResponse): boolean {
    const call = this.calls.get(response.id)
    if (!call) {
      return false
    }
    if (this.options.isProgress?.(response)) {
      this.armDeadline(call)
      return true
    }
    this.calls.delete(response.id)
    this.settle(call, () => call.resolve(response))
    this.options.scheduleIdleTeardown()
    return true
  }

  failAll(error: Error): void {
    for (const call of this.calls.values()) {
      this.settle(call, () => call.reject(error))
    }
    this.calls.clear()
  }

  dispose(error: Error): void {
    this.disposed = true
    this.failAll(error)
  }

  private armDeadline(call: ConcurrentCall<TRequest, TResponse>): void {
    if (call.timer) {
      clearTimeout(call.timer)
    }
    call.timer = setTimeout(() => {
      if (this.calls.delete(call.request.id)) {
        this.options.onTimeout(new Error(this.options.describeTimeout(call.timeoutMs)))
      }
    }, call.timeoutMs)
    call.timer.unref?.()
  }

  private settle(call: ConcurrentCall<TRequest, TResponse>, run: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    run()
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Worker request failed')
}
