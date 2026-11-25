// One host's view of an RPC that reads a value: loading, ready, unavailable on a host that predates the
// method, or failed. Shared by the bot connectors, so each does not carry its own copy of the same four
// states and the same `method_not_found` special case.
import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'

export type HostRpcView<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  /** The host predates this feature, so Settings offers nothing rather than an error to fix. */
  | { status: 'unavailable' }
  | { status: 'failed'; error: unknown }

/** `read` as the host has it, re-read whenever `reload` is called or the host changes. */
export function useHostRpcView<T>(
  hostKey: string,
  read: () => Promise<T>
): { view: HostRpcView<T>; reload: () => void } {
  const [view, setView] = useState<HostRpcView<T>>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const reload = useCallback(() => setReads((count) => count + 1), [])
  // `read` is rebuilt each render by its caller, so the host and the reload count are the identity;
  // an effect event reads the latest closure without making it one.
  const readLatest = useEffectEvent(() => read())
  useEffect(() => {
    let live = true
    void readLatest().then(
      (value) => live && setView({ status: 'ready', value }),
      (error: unknown) =>
        live &&
        setView(
          error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
            ? { status: 'unavailable' }
            : { status: 'failed', error }
        )
    )
    return () => {
      live = false
    }
  }, [hostKey, reads])
  return { view, reload }
}

/** A host's own refusal, which names the fix; null when the call never reached it. */
export function hostRefusalMessage(error: unknown): string | null {
  return error instanceof RuntimeRpcCallError &&
    (error.code === 'runtime_error' || error.code === 'invalid_argument')
    ? error.message
    : null
}
