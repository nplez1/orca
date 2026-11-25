/* eslint-disable max-lines -- Why: the peer-facing half of the protocol: six methods that each run one whole pass on this host's own store, sharing the admission rules and the seal/open wrappers; splitting them would duplicate that context per file. */
import { randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import {
  HOST_MESH_INTRODUCE_METHOD,
  HOST_MESH_OFFER_TTL_MS,
  HOST_MESH_PAYLOAD_VERSION,
  type HostMeshIntroduceReply,
  type HostMeshIntroduceRequest,
  type HostMeshJoinReply,
  type HostMeshJoinRequest,
  type HostMeshPendingReply,
  type HostMeshPendingRequest,
  type HostMeshRelayRequest,
  type HostMeshRemoveRequest,
  type HostMeshSealedOffer,
  type HostMeshState,
  type HostMeshSyncPayload
} from '../../shared/host-mesh/host-mesh-contract'
import { decideIntroduce, decideJoin } from '../../shared/host-mesh/host-mesh-admission'
import {
  addHostMeshMember,
  createHostMeshState,
  removeHostMeshMember,
  setHostMeshInboundLink,
  setHostMeshOutboundLink
} from '../../shared/host-mesh/host-mesh-membership'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { createHostMeshStore } from './host-mesh-store'
import { openHostMeshSealedOffer, sealHostMeshOffer } from './host-mesh-sealed-offer'
import type {
  HostMeshDriverDeps,
  HostMeshRpcService,
  RedeemedPeer
} from './host-mesh-driver-contract'

function toBytes(base64: string): Uint8Array | null {
  const decoded = Buffer.from(base64, 'base64')
  return decoded.byteLength === nacl.box.publicKeyLength && decoded.toString('base64') === base64
    ? new Uint8Array(decoded)
    : null
}

/** The six methods a peer calls. Each is one whole pass on this host's own store. */
export function createHostMeshRpcService(deps: HostMeshDriverDeps): HostMeshRpcService {
  const store = createHostMeshStore({ userDataPath: deps.userDataPath })
  const selfKey = () => orcaHostKeyOf(deps.ownKeypair().publicKeyB64)

  function loadState(): HostMeshState {
    return store.read() ?? createHostMeshState({ selfKey: selfKey(), groupId: '', epoch: 1 })
  }

  function openFrom(sealed: HostMeshSealedOffer, senderPublicKeyB64: string | undefined) {
    const senderKey = senderPublicKeyB64 ? toBytes(senderPublicKeyB64) : null
    if (senderKey === null) {
      return { payload: null, reason: 'offer-sender' }
    }
    let reason: string | undefined
    const payload = openHostMeshSealedOffer({
      sealed,
      recipientHostKey: selfKey(),
      recipientSecretKey: deps.ownKeypair().secretKey,
      senderPublicKey: senderKey,
      now: deps.now(),
      onInvalid: (why) => {
        reason = why
      }
    })
    return { payload, reason }
  }

  function sealTo(args: {
    recipientHostKey: string
    recipientPublicKeyB64: string
    groupId: string
    epoch: number
    introducedBy: string
    offerUrl: string
  }): HostMeshSealedOffer | null {
    const recipientKey = toBytes(args.recipientPublicKeyB64)
    if (recipientKey === null) {
      return null
    }
    return sealHostMeshOffer({
      payload: {
        version: HOST_MESH_PAYLOAD_VERSION,
        groupId: args.groupId,
        epoch: args.epoch,
        minterHostKey: selfKey(),
        recipientHostKey: args.recipientHostKey,
        introducedBy: args.introducedBy,
        offerUrl: args.offerUrl,
        endpointCandidates: [],
        expiresAt: deps.now() + HOST_MESH_OFFER_TTL_MS,
        nonce: randomUUID()
      },
      senderSecretKey: deps.ownKeypair().secretKey,
      recipientPublicKey: recipientKey
    })
  }

  // The peer index is what removal later keys on, so every commit re-states it from the environment table.
  function commit(state: HostMeshState): void {
    store.write(state)
    for (const member of state.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId !== null) {
        store.recordPeer(member.hostKey, { environmentId })
      }
    }
  }

  return {
    join: async (params: HostMeshJoinRequest): Promise<HostMeshJoinReply> => {
      let state = loadState()
      const opened = openFrom(params.sealedForIntroducer, params.joiner.publicKeyB64)
      const decision = decideJoin(state, deps.settings(), {
        joiner: params.joiner,
        openedPayload: opened.payload,
        ...(opened.reason === undefined ? {} : { openReason: opened.reason }),
        now: deps.now()
      })
      if (decision.kind === 'refuse') {
        return { kind: 'refused', reason: decision.reason }
      }
      if (decision.kind === 'ask') {
        // No pending-approval surface yet, so this is refused rather than silently held forever.
        return { kind: 'refused', reason: 'awaiting-approval' }
      }
      // Why adoption here: the first join is what creates the group, so a host in no group takes the
      // joiner's identity for it rather than minting a second one beside it.
      const groupId = state.groupId === '' ? params.groupId : state.groupId
      if (groupId !== params.groupId) {
        return { kind: 'refused', reason: 'group-mismatch' }
      }
      const epoch = Math.max(state.epoch, params.epoch) + 1
      let peer: RedeemedPeer
      try {
        peer = await deps.redeemOffer(decision.payload.offerUrl)
      } catch {
        return { kind: 'refused', reason: 'redeem-failed' }
      }
      if (peer.hostKey !== params.joiner.hostKey) {
        return { kind: 'refused', reason: 'offer-not-from-joiner' }
      }
      state = {
        ...state,
        groupId,
        epoch,
        members: state.members,
        tombstones: state.tombstones,
        links: state.links
      }
      state = addHostMeshMember(state, {
        hostKey: params.joiner.hostKey,
        label: params.joiner.label,
        publicKeyB64: params.joiner.publicKeyB64,
        epoch
      }).state
      state = setHostMeshOutboundLink(state, {
        hostKey: params.joiner.hostKey,
        link: { kind: 'ok' }
      })
      commit(state)

      let sealedForJoiner: HostMeshSealedOffer | null = null
      try {
        sealedForJoiner = sealTo({
          recipientHostKey: params.joiner.hostKey,
          recipientPublicKeyB64: params.joiner.publicKeyB64,
          groupId,
          epoch,
          introducedBy: selfKey(),
          offerUrl: await deps.mintRuntimeOffer()
        })
      } catch {
        sealedForJoiner = null
      }
      return {
        kind: 'joined',
        groupId,
        epoch,
        members: state.members.filter((member) => member.hostKey !== params.joiner.hostKey),
        tombstones: state.tombstones,
        sealedForJoiner
      }
    },

    relayIntroductions: async (params: HostMeshRelayRequest) => {
      const state = loadState()
      if (state.groupId !== params.groupId) {
        return { forwarded: 0, refused: ['group-mismatch'] }
      }
      if (!state.members.some((member) => member.hostKey === params.joiner.hostKey)) {
        return { forwarded: 0, refused: ['joiner-not-member'] }
      }
      let forwarded = 0
      const refused: string[] = []
      for (const sealed of params.sealed) {
        const recipient = state.members.find((member) => member.hostKey === sealed.recipientHostKey)
        const environmentId = recipient ? deps.environmentIdForHostKey(recipient.hostKey) : null
        if (environmentId === null) {
          refused.push(sealed.recipientHostKey)
          continue
        }
        try {
          const reply = await deps.send<HostMeshIntroduceReply>(
            environmentId,
            HOST_MESH_INTRODUCE_METHOD,
            {
              version: HOST_MESH_PAYLOAD_VERSION,
              groupId: params.groupId,
              epoch: params.epoch,
              introducerHostKey: selfKey(),
              newcomer: params.joiner,
              sealedForRecipient: sealed
            } satisfies HostMeshIntroduceRequest
          )
          if (reply.kind === 'accepted') {
            forwarded += 1
            if (reply.sealedForNewcomer !== null) {
              store.addPendingBox(params.joiner.hostKey, reply.sealedForNewcomer)
            }
          } else {
            refused.push(`${sealed.recipientHostKey}:${reply.reason}`)
          }
        } catch {
          refused.push(`${sealed.recipientHostKey}:unreachable`)
        }
      }
      return { forwarded, refused }
    },

    introduce: async (params: HostMeshIntroduceRequest): Promise<HostMeshIntroduceReply> => {
      let state = loadState()
      const opened = openFrom(params.sealedForRecipient, params.newcomer.publicKeyB64)
      const decision = decideIntroduce(state, deps.settings(), {
        groupId: params.groupId,
        introducerHostKey: params.introducerHostKey,
        newcomer: { hostKey: params.newcomer.hostKey, label: params.newcomer.label },
        openedPayload: opened.payload,
        ...(opened.reason === undefined ? {} : { openReason: opened.reason }),
        introductionsThisHour: 0,
        now: deps.now()
      })
      if (decision.kind === 'refuse') {
        return { kind: 'refused', reason: decision.reason }
      }
      if (decision.kind === 'ask') {
        return { kind: 'refused', reason: 'awaiting-approval' }
      }
      let peer: RedeemedPeer
      try {
        peer = await deps.redeemOffer(decision.payload.offerUrl)
      } catch {
        return { kind: 'refused', reason: 'redeem-failed' }
      }
      if (peer.hostKey !== params.newcomer.hostKey) {
        return { kind: 'refused', reason: 'offer-not-from-newcomer' }
      }
      const epoch = Math.max(state.epoch, params.epoch) + 1
      state = addHostMeshMember(state, {
        hostKey: params.newcomer.hostKey,
        label: params.newcomer.label,
        ...(params.newcomer.publicKeyB64 === undefined
          ? {}
          : { publicKeyB64: params.newcomer.publicKeyB64 }),
        introducedBy: params.introducerHostKey,
        epoch
      }).state
      state = setHostMeshOutboundLink(state, {
        hostKey: params.newcomer.hostKey,
        link: { kind: 'ok' }
      })
      state = setHostMeshInboundLink(state, {
        hostKey: params.newcomer.hostKey,
        link: { kind: 'active' }
      })
      state = { ...state, epoch }
      commit(state)

      const newcomerPublicKey = params.newcomer.publicKeyB64
      if (newcomerPublicKey === undefined) {
        // Without its public key this host cannot seal its own offer back, so the pair would stay one-way.
        return { kind: 'accepted', sealedForNewcomer: null }
      }
      try {
        const sealedForNewcomer = sealTo({
          recipientHostKey: params.newcomer.hostKey,
          recipientPublicKeyB64: newcomerPublicKey,
          groupId: state.groupId,
          epoch,
          introducedBy: selfKey(),
          offerUrl: await deps.mintRuntimeOffer()
        })
        return { kind: 'accepted', sealedForNewcomer }
      } catch {
        return { kind: 'accepted', sealedForNewcomer: null }
      }
    },

    pending: async (params: HostMeshPendingRequest): Promise<HostMeshPendingReply> => {
      const state = loadState()
      if (state.groupId === '' || state.groupId !== params.groupId) {
        return { sealed: [] }
      }
      // A box can only be opened by the machine it is addressed to, so a caller that collects another
      // machine's box denies it delivery rather than gaining anything from it.
      return { sealed: store.takePendingBoxes(params.hostKey) }
    },

    sync: async (params: HostMeshPendingRequest): Promise<HostMeshSyncPayload> => {
      const state = loadState()
      if (state.groupId !== '' && params.groupId !== '' && state.groupId !== params.groupId) {
        return {
          version: HOST_MESH_PAYLOAD_VERSION,
          groupId: state.groupId,
          epoch: state.epoch,
          selfKey: selfKey(),
          publicKeyB64: deps.ownKeypair().publicKeyB64,
          members: [],
          tombstones: [],
          links: {}
        }
      }
      // Why our own key is skipped in `members`: a member's list never contains itself.
      return {
        version: HOST_MESH_PAYLOAD_VERSION,
        groupId: state.groupId,
        epoch: state.epoch,
        selfKey: selfKey(),
        publicKeyB64: deps.ownKeypair().publicKeyB64,
        members: state.members.filter((member) => member.hostKey !== params.hostKey),
        tombstones: state.tombstones,
        links: { [selfKey()]: state.links }
      }
    },

    remove: async (params: HostMeshRemoveRequest) => {
      let state = loadState()
      if (state.groupId === '' || state.groupId !== params.groupId) {
        return { applied: false }
      }
      if (params.hostKey === selfKey()) {
        return { applied: false }
      }
      if (!state.members.some((member) => member.hostKey === params.hostKey)) {
        // Still recorded: a member that already dropped this host must not be resurrected by a later sync.
        state = removeHostMeshMember(state, {
          hostKey: params.hostKey,
          removedBy: params.removedBy,
          epoch: params.epoch
        })
        commit(state)
        return { applied: true }
      }
      state = removeHostMeshMember(state, {
        hostKey: params.hostKey,
        removedBy: params.removedBy,
        epoch: params.epoch
      })
      const environmentId = deps.environmentIdForHostKey(params.hostKey)
      deps.forgetDevice(params.hostKey)
      if (environmentId !== null) {
        deps.forgetEnvironment(environmentId)
      }
      store.forgetPeer(params.hostKey)
      commit(state)
      return { applied: true }
    }
  }
}
