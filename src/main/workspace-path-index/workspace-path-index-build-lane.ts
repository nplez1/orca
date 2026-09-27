type BuildJob = {
  priority: boolean
  sequence: number
  signal: AbortSignal
  run: () => Promise<void>
  reject: (error: Error) => void
  abort: () => void
}

/** One host-wide build at a time; active workspaces sort ahead of background warming. */
export class WorkspacePathIndexBuildLane {
  private readonly pending: BuildJob[] = []
  private active = false
  private disposed = false
  private sequence = 0

  constructor(private readonly maxPendingBuilds = 8) {}

  run<T>(args: {
    signal: AbortSignal
    activeWorkspace: boolean
    run: () => Promise<T>
  }): Promise<T> {
    if (this.disposed || args.signal.aborted) {
      return Promise.reject(new Error('Workspace path catalog build was cancelled'))
    }
    return new Promise<T>((resolve, reject) => {
      const job: BuildJob = {
        priority: args.activeWorkspace,
        sequence: this.sequence++,
        signal: args.signal,
        run: async () => {
          try {
            resolve(await args.run())
          } catch (error) {
            reject(toError(error))
            throw error
          }
        },
        reject,
        abort: () => {
          const index = this.pending.indexOf(job)
          if (index !== -1) {
            this.pending.splice(index, 1)
            reject(new Error('Workspace path catalog build was cancelled'))
          }
        }
      }
      if (this.pending.length >= this.maxPendingBuilds && this.active) {
        reject(new Error('Workspace path build lane is full'))
        return
      }
      args.signal.addEventListener('abort', job.abort, { once: true })
      this.pending.push(job)
      this.pending.sort((left, right) =>
        left.priority === right.priority ? left.sequence - right.sequence : left.priority ? -1 : 1
      )
      this.pump()
    })
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.pending.splice(0)) {
      job.signal.removeEventListener('abort', job.abort)
      job.reject(new Error('Workspace path build lane is disposed'))
    }
  }

  private pump(): void {
    if (this.active || this.disposed) {
      return
    }
    const job = this.pending.shift()
    if (!job) {
      return
    }
    this.active = true
    job.signal.removeEventListener('abort', job.abort)
    void job
      .run()
      .catch(() => undefined)
      .finally(() => {
        this.active = false
        this.pump()
      })
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Workspace path catalog build failed')
}
