// The GitHub App a host's bots can act as, read and changed on that host. Nothing here holds a token:
// the host mints them, and this side only ever learns the App's identity.
import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type {
  GithubAppConnectParams,
  GithubAppStatus
} from '../../../shared/rpc-contract/github/github-app-params'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botHostTarget } from './bot-hosts'

export function githubAppCalls(hostId: ExecutionHostId) {
  const target = botHostTarget(hostId)
  return {
    status: (): Promise<GithubAppStatus> => callRuntimeRpc(target, 'github.app.status', null),
    connect: (params: GithubAppConnectParams): Promise<GithubAppStatus> =>
      callRuntimeRpc(target, 'github.app.connect', params),
    refresh: (): Promise<GithubAppStatus> => callRuntimeRpc(target, 'github.app.refresh', null),
    disconnect: (): Promise<null> => callRuntimeRpc(target, 'github.app.disconnect', null)
  }
}

export type GithubAppView =
  | { status: 'loading' }
  | { status: 'ready'; app: GithubAppStatus }
  /** The host predates this feature, so Settings offers nothing rather than an error to fix. */
  | { status: 'unavailable' }
  | { status: 'failed'; error: unknown }

/** A host's own refusal, which names the fix; null when the call never reached it. */
export function githubAppErrorMessage(error: unknown): string | null {
  return error instanceof RuntimeRpcCallError && error.code === 'runtime_error'
    ? error.message
    : null
}

/** The App as this host has it, re-read whenever `reload` is called or the host changes. */
export function useGithubApp(hostId: ExecutionHostId): {
  view: GithubAppView
  reload: () => void
} {
  const [view, setView] = useState<GithubAppView>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const reload = useCallback(() => setReads((count) => count + 1), [])
  useEffect(() => {
    let live = true
    void githubAppCalls(hostId)
      .status()
      .then(
        (app) => live && setView({ status: 'ready', app }),
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
  }, [hostId, reads])
  return { view, reload }
}
