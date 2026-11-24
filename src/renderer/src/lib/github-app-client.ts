// The GitHub App a host's bots can act as, read and changed on that host. Nothing here holds a token:
// the host mints them, and this side only ever learns the App's identity.
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { hostRefusalMessage, useHostRpcView, type HostRpcView } from './host-rpc-view'
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

/** `value` is the status; the shared host view keeps the four states one shape. */
export type GithubAppView = HostRpcView<GithubAppStatus>

/** A host's own refusal, which names the fix; null when the call never reached it. */
export const githubAppErrorMessage = hostRefusalMessage

/** The App as this host has it, re-read whenever `reload` is called or the host changes. */
export function useGithubApp(hostId: ExecutionHostId): {
  view: GithubAppView
  reload: () => void
} {
  return useHostRpcView(hostId, () => githubAppCalls(hostId).status())
}
