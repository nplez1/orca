// A host's iMessage channel, as Photon holds it: read here, changed on the host that holds the keys. The
// account key and a bot's project key never leave that host, so this side only ever learns status.
import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type {
  PhotonAddMemberInput,
  PhotonChannelStatus,
  PhotonConnectInput,
  PhotonCreateBotInput,
  PhotonDeleteProjectInput,
  PhotonReleaseBotInput,
  PhotonReleaseMemberInput
} from '../../../shared/rpc-contract/bots-photon-params'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botHostTarget } from './bot-hosts'

export function photonCalls(hostId: ExecutionHostId) {
  const target = botHostTarget(hostId)
  return {
    status: (): Promise<PhotonChannelStatus> => callRuntimeRpc(target, 'bots.photon.status', {}),
    connect: (params: PhotonConnectInput): Promise<PhotonChannelStatus> =>
      callRuntimeRpc(target, 'bots.photon.connect', params),
    createBot: (params: PhotonCreateBotInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.create', params),
    addMember: (params: PhotonAddMemberInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.member.add', params),
    releaseMember: (params: PhotonReleaseMemberInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.member.release', params),
    releaseBot: (params: PhotonReleaseBotInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.bot.release', params),
    deleteProject: (params: PhotonDeleteProjectInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.project.delete', params),
    reconcile: (botId: string): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.reconcile', { botId })
  }
}

export type PhotonChannelView =
  | { status: 'loading' }
  | { status: 'ready'; channel: PhotonChannelStatus }
  /** The host predates the channel, so Settings offers nothing rather than an error to fix. */
  | { status: 'unavailable' }
  | { status: 'failed'; error: unknown }

/** A host's own refusal, which names the fix; null when the call never reached it. */
export function photonErrorMessage(error: unknown): string | null {
  return error instanceof RuntimeRpcCallError && error.code === 'runtime_error'
    ? error.message
    : null
}

/** The channel as this host has it, re-read whenever `reload` is called or the host changes. */
export function usePhotonChannel(hostId: ExecutionHostId): {
  view: PhotonChannelView
  reload: () => void
} {
  const [view, setView] = useState<PhotonChannelView>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const reload = useCallback(() => setReads((count) => count + 1), [])
  useEffect(() => {
    let live = true
    void photonCalls(hostId)
      .status()
      .then(
        (channel) => live && setView({ status: 'ready', channel }),
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
