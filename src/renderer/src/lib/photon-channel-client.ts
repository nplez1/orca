// A host's iMessage channel, as Photon holds it: read here, changed on the host that holds the keys. An
// account key is typed here and sent to that host once; nothing reads one back, so this side only ever
// learns status.
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { hostRefusalMessage, useHostRpcView, type HostRpcView } from './host-rpc-view'
import type {
  PhotonAddMemberInput,
  PhotonChannelStatus,
  PhotonConnectInput,
  PhotonCreateBotInput,
  PhotonDeleteProjectInput,
  PhotonReleaseBotInput,
  PhotonReleaseMemberInput,
  PhotonSpectrumConnectInput
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
    /** Points this bot at a Spectrum project the owner already runs. Creates nothing upstream, so there is
     *  no project and no number to wait for: the call proves the pair and starts reading. */
    connectSpectrum: (params: PhotonSpectrumConnectInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.spectrum.connect', params),
    addMember: (params: PhotonAddMemberInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.member.add', params),
    releaseMember: (params: PhotonReleaseMemberInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.member.release', params),
    releaseBot: (params: PhotonReleaseBotInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.bot.release', params),
    deleteProject: (params: PhotonDeleteProjectInput): Promise<unknown> =>
      callRuntimeRpc(target, 'bots.photon.project.delete', params),
    reconcile: (botId: string): Promise<{ repaired: boolean; notes: string[] }> =>
      callRuntimeRpc(target, 'bots.photon.reconcile', { botId })
  }
}

export type PhotonChannelView = HostRpcView<PhotonChannelStatus>

/** A host's own refusal, which names the fix; null when the call never reached it. */
export const photonErrorMessage = hostRefusalMessage

/** The channel as this host has it, re-read whenever `reload` is called or the host changes. */
export function usePhotonChannel(hostId: ExecutionHostId): {
  view: PhotonChannelView
  reload: () => void
} {
  return useHostRpcView(hostId, () => photonCalls(hostId).status())
}
