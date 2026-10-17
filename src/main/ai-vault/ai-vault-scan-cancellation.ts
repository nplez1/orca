import { AI_VAULT_SCAN_CANCELLED_MESSAGE } from '../../shared/ai-vault-types'

export function throwIfAiVaultScanCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  throw createAiVaultScanCancelledError()
}

// Why: the caller must not keep waiting for a leg whose every waiter left. The
// signal also reaches the transport (the page drain aborts its request), and
// this race is what stops the 'all'-scope merge from being held by it.
export function abandonRemoteSessionScanOnCancel<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise
  }
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // The scanner promise already exists; observe it so its later failure is
      // not an unhandled rejection after this caller walked away.
      void promise.catch(() => undefined)
      reject(createAiVaultScanCancelledError())
      return
    }
    const onAbort = (): void => reject(createAiVaultScanCancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function createAiVaultScanCancelledError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}
