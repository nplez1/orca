import { runAsyncTaskWithFailure } from './async-task-with-cleanup'

/** A side read that settles loading/error only while its request is still the current one. */
export async function runGuardedSideRead<T>(options: {
  isCurrent: () => boolean
  read: () => Promise<T>
  apply: (value: T) => void
  onError: (error: unknown) => void
  done: () => void
}): Promise<void> {
  await runAsyncTaskWithFailure(
    async () => {
      const value = await options.read()
      if (options.isCurrent()) {
        options.apply(value)
      }
    },
    (error) => {
      if (options.isCurrent()) {
        options.onError(error)
      }
    },
    () => {
      if (options.isCurrent()) {
        options.done()
      }
    }
  )
}
