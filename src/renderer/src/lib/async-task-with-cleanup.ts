/**
 * Why these exist: React Compiler bails out of any function whose body holds a `try` with a
 * `finally`, so an async handler inside a component must keep its cleanup in a module function.
 */
export async function runAsyncTask<T>(task: () => Promise<T>, cleanup: () => unknown): Promise<T> {
  try {
    return await task()
  } finally {
    await cleanup()
  }
}

/** `runAsyncTask` for the catch-and-report shape; the task's value is dropped when it throws. */
export async function runAsyncTaskWithFailure<T>(
  task: () => Promise<T>,
  onError: (error: unknown) => unknown,
  cleanup: () => unknown
): Promise<T | undefined> {
  try {
    return await task()
  } catch (error) {
    await onError(error)
    return undefined
  } finally {
    await cleanup()
  }
}

/** `runAsyncTaskWithFailure` for a caller that returns the recovery's own value. */
export async function runAsyncTaskOrRecover<T, R>(
  task: () => Promise<T>,
  recover: (error: unknown) => R | Promise<R>,
  cleanup: () => unknown
): Promise<T | R> {
  try {
    return await task()
  } catch (error) {
    return await recover(error)
  } finally {
    await cleanup()
  }
}
