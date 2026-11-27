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
  type HostMeshOfferBackReply,
  type HostMeshOfferBackRequest,
  type HostMeshPendingReply,
  type HostMeshPendingRequest,
  type HostMeshRelayRequest,
  type HostMeshRemoveRequest,
  type HostMeshSealedOffer,
  type HostMeshState,
  type HostMeshSyncPayload
} from '../../shared/host-mesh/host-mesh-contract'
import { adoptHostMeshGroup } from '../../shared/host-mesh/host-mesh-adoption'
import {
  decideIntroduce,
  decideJoin,
  decideOfferBack
} from '../../shared/host-mesh/host-mesh-admission'
import {
  addHostMeshMember,
  createHostMeshState,
  removeHostMeshMember,
  setHostMeshInboundLink,
  setHostMeshOutboundLink,
  setHostMeshRoutes
} from '../../shared/host-mesh/host-mesh-membership'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { createHostMeshStore } from './host-mesh-store'
import { openHostMeshSealedOffer, sealHostMeshOffer } from './host-mesh-sealed-offer'
import type {
  HostMeshCaller,
  HostMeshDriverDeps,
  HostMeshRpcService,
  RedeemedPeer
} from './host-mesh-driver-contract'
import type { HostMeshWriteLock } from './host-mesh-write-lock'

function toBytes(base64: string): Uint8Array | null {
  const decoded = Buffer.from(base64, 'base64')
  return decoded.byteLength === nacl.box.publicKeyLength && decoded.toString('base64') === base64
    ? new Uint8Array(decoded)
    : null
}

/** The methods a peer calls. Each is one whole pass on this host's own store. */
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
    if (payload !== null) {
      if (store.hasSpentNonce(payload.nonce, deps.now())) {
        return { payload: null, reason: 'offer-replayed' }
      }
      store.spendNonce(payload.nonce, deps.now())
    }
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
  /** Mints for one recipient, recording the device row so removal has something to revoke. */
  async function mintFor(recipientHostKey: string): Promise<string> {
    const minted = await deps.mintRuntimeOffer({
      // Empty when this host holds no environment for the recipient, which is the ordinary inbound case: whoever is
      // calling reached this host, so this host's own reach is already what that machine can dial.
      environmentId: deps.environmentIdForHostKey(recipientHostKey) ?? '',
      recipientHostKey
    })
    store.recordPeer(recipientHostKey, { deviceRowId: minted.deviceId })
    return minted.offerUrl
  }

  function commit(state: HostMeshState): void {
    store.write(state)
    for (const member of state.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId !== null) {
        store.recordPeer(member.hostKey, { environmentId })
      }
    }
  }

  /** Keeps the addresses a minter published with its offer, so this host can dial it there if this path dies. */
  function rememberOfferedRoutes(
    state: HostMeshState,
    hostKey: string,
    endpoints: readonly string[] | undefined
  ): HostMeshState {
    if (endpoints === undefined || endpoints.length === 0) {
      return state
    }
    return setHostMeshRoutes(state, { hostKey, endpoints })
  }

  const service: HostMeshRpcService = {
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
      // Why adoption here: the first join is what creates the group, so a host in no group takes the
      // joiner's identity for it rather than minting a second one beside it.
      const groupId = state.groupId === '' ? params.groupId : state.groupId
      if (groupId !== params.groupId) {
        return { kind: 'refused', reason: 'group-mismatch' }
      }
      const epoch = Math.max(state.epoch, params.epoch) + 1
      let peer: RedeemedPeer
      try {
        peer = await deps.redeemOffer(
          decision.payload.offerUrl,
          decision.payload.minterHostKey,
          params.joiner.label
        )
      } catch {
        return { kind: 'refused', reason: 'redeem-failed' }
      }
      if (peer.hostKey !== params.joiner.hostKey) {
        return { kind: 'refused', reason: 'offer-not-from-joiner' }
      }
      // Why the offer's own candidates are kept: they are the addresses the joiner published with it, and this host
      // needs them the day that machine's path changes — before any sync can carry the new set.
      state = rememberOfferedRoutes(
        state,
        params.joiner.hostKey,
        decision.payload.endpointCandidates
      )
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
          offerUrl: await mintFor(params.joiner.hostKey)
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
      if (!deps.settings().enabled) {
        return { forwarded: 0, refused: ['mesh-disabled'] }
      }
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
      // Why a host with no group can still be introduced: the group id is derived per host, so a machine that
      // has never joined has none to match, and refusing it would leave every new machine permanently
      // outside — the opposite of one join pairing it with everyone. Adoption is still gated: the group must
      // name only machines this host is already paired with.
      const adoption = adoptHostMeshGroup(
        state,
        {
          groupId: params.groupId,
          epoch: params.epoch,
          hostKeys: [state.selfKey, params.introducerHostKey, params.newcomer.hostKey]
        },
        {
          isTrusted: (hostKey) => deps.environmentIdForHostKey(hostKey) !== null,
          // The introducer vouches for the newcomer; `decideIntroduce` below is what checks the box in the
          // envelope really came from that newcomer, so this cannot be used to name a stranger.
          vouched: [params.newcomer.hostKey]
        }
      )
      if (adoption.kind === 'refuse') {
        return { kind: 'refused', reason: adoption.reason }
      }
      if (adoption.kind === 'adopt') {
        state = adoption.state
      }
      const opened = openFrom(params.sealedForRecipient, params.newcomer.publicKeyB64)
      const decision = decideIntroduce(state, deps.settings(), {
        groupId: params.groupId,
        introducerHostKey: params.introducerHostKey,
        newcomer: { hostKey: params.newcomer.hostKey, label: params.newcomer.label },
        openedPayload: opened.payload,
        ...(opened.reason === undefined ? {} : { openReason: opened.reason }),
        introductionsThisHour: store.readAdmissions(params.groupId, deps.now()).length,
        now: deps.now()
      })
      if (decision.kind === 'refuse') {
        return { kind: 'refused', reason: decision.reason }
      }
      let peer: RedeemedPeer
      try {
        peer = await deps.redeemOffer(
          decision.payload.offerUrl,
          decision.payload.minterHostKey,
          params.newcomer.label
        )
      } catch {
        return { kind: 'refused', reason: 'redeem-failed' }
      }
      if (peer.hostKey !== params.newcomer.hostKey) {
        return { kind: 'refused', reason: 'offer-not-from-newcomer' }
      }
      state = rememberOfferedRoutes(
        state,
        params.newcomer.hostKey,
        decision.payload.endpointCandidates
      )
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
      // Why the inbound direction is NOT marked here: this host minted a box, which proves nothing about
      // whether the newcomer collected it. Only receiving a box proves the other half, so it stays absent.
      state = { ...state, epoch }
      store.recordAdmission(params.groupId, deps.now())
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
          offerUrl: await mintFor(params.newcomer.hostKey)
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

    /**
     * The reverse direction: a machine that already holds a credential here hands this host an offer of its own.
     *
     * Why this is the one method that makes an upgraded fleet converge without its owner touching each machine:
     * the side that paired by hand holds every environment, and a spoke holds none — so a spoke can neither dial
     * a member nor be introduced by one, because introductions travel to a member that already has a group. This
     * is the only call a host with nothing can answer.
     */
    offerBack: async (
      params: HostMeshOfferBackRequest,
      caller: HostMeshCaller
    ): Promise<HostMeshOfferBackReply> => {
      let state = loadState()
      // Why the cheap refusals come before opening the box: opening spends a nonce and writes the store, so a caller
      // that was never paired here, on a host with the mesh off, must be turned away before it costs that.
      if (caller.pairedDeviceId === undefined) {
        return { kind: 'refused', reason: 'caller-not-paired' }
      }
      if (!deps.settings().enabled) {
        return { kind: 'refused', reason: 'reverse-offers-disabled' }
      }
      const opened = openFrom(params.sealed, params.offerer.publicKeyB64)
      const decision = decideOfferBack(state, deps.settings(), {
        ...(caller.pairedDeviceId === undefined
          ? {}
          : { callerPairedDeviceId: caller.pairedDeviceId }),
        offererHostKey: params.offerer.hostKey,
        openedPayload: opened.payload,
        ...(opened.reason === undefined ? {} : { openReason: opened.reason }),
        now: deps.now()
      })
      if (decision.kind === 'refuse') {
        return { kind: 'refused', reason: decision.reason }
      }
      const epoch = Math.max(state.epoch, params.epoch) + 1
      // Why adoption is decided before the redemption: a group this host will not take must not leave an
      // environment record behind, which is a credential this host would then hold for no group at all.
      const adoption = adoptHostMeshGroup(
        state,
        {
          groupId: decision.payload.groupId,
          epoch,
          hostKeys: [state.selfKey, params.offerer.hostKey]
        },
        {
          // Why the offerer needs no local environment: it reached this method over a device token this host
          // issued, which is a pairing made in the other direction, and `decideOfferBack` is what checked it.
          isTrusted: (hostKey) => hostKey === params.offerer.hostKey
        }
      )
      if (adoption.kind === 'refuse') {
        return { kind: 'refused', reason: 'group-not-adoptable' }
      }
      let peer: RedeemedPeer
      try {
        peer = await deps.redeemOffer(
          decision.payload.offerUrl,
          decision.payload.minterHostKey,
          params.offerer.label
        )
      } catch {
        return { kind: 'refused', reason: 'redeem-failed' }
      }
      if (peer.hostKey !== params.offerer.hostKey) {
        return { kind: 'refused', reason: 'offer-not-from-offerer' }
      }
      if (adoption.kind === 'adopt') {
        state = adoption.state
      }
      // Why after adoption: that state was computed before this call, so writing the routes into the earlier one would
      // be discarded by the assignment above — and the candidates are exactly what a joined host needs first.
      state = rememberOfferedRoutes(
        state,
        params.offerer.hostKey,
        decision.payload.endpointCandidates
      )
      state = addHostMeshMember(state, {
        hostKey: params.offerer.hostKey,
        label: params.offerer.label,
        publicKeyB64: params.offerer.publicKeyB64,
        epoch
      }).state
      state = setHostMeshOutboundLink(state, {
        hostKey: params.offerer.hostKey,
        link: { kind: 'ok' }
      })
      // Why the inbound link IS marked here, where an introduction deliberately leaves it absent: this call
      // arrived over a credential this host issued to the offerer, so the offerer demonstrably holds a working
      // link in this direction. An introduction only proves a box was minted.
      state = setHostMeshInboundLink(state, {
        hostKey: params.offerer.hostKey,
        link: { kind: 'active' }
      })
      state = { ...state, epoch }
      commit(state)
      // Why the caller's own device row is recorded: the offerer authenticated with a token THIS host issued, so that
      // row is the credential to revoke — and an Eject on this side that revoked nothing would leave the other machine
      // still holding workspace access to this one.
      store.recordPeer(params.offerer.hostKey, { deviceRowId: caller.pairedDeviceId })
      // Why a pass of this host's own: the pairs with the *other* members were never this host's to mint, so the
      // one moment they can be offered is now — and the machine that just paired this one cannot do it for it.
      deps.requestOwnSync?.()
      return { kind: 'accepted', groupId: state.groupId, epoch }
    },

    sync: async (params: HostMeshPendingRequest): Promise<HostMeshSyncPayload> => {
      const state = loadState()
      // Why every reply publishes this host's own addresses: the caller is the one that needs them, and the pass it is
      // running is the only chance to say where this machine is before the path it dialed stops working.
      const endpoints = await deps.ownEndpoints()
      const ownEndpoints = endpoints.length === 0 ? {} : { endpoints: [...endpoints] }
      if (state.groupId !== '' && params.groupId !== '' && state.groupId !== params.groupId) {
        // Why a member still gets the list: two hosts upgraded from the same fleet derive different group
        // ids, and the id is precisely what has to converge — so refusing the list to a member on an id
        // mismatch would leave the fleet permanently split with each half unable to learn the other exists.
        // Membership is what is trusted here, not the id; a caller that is not a member still gets nothing.
        const isMember = state.members.some((member) => member.hostKey === params.hostKey)
        return {
          version: HOST_MESH_PAYLOAD_VERSION,
          groupId: state.groupId,
          epoch: state.epoch,
          selfKey: selfKey(),
          publicKeyB64: deps.ownKeypair().publicKeyB64,
          // The requester is left in the list on purpose: this reply is what tells it the group is one it
          // belongs to, and it can only learn that from a list that names it. A non-member gets an empty
          // list, so the group's membership is not disclosed to anyone outside it.
          members: isMember ? state.members : [],
          tombstones: [],
          links: {},
          ...ownEndpoints
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
        links: { [selfKey()]: state.links },
        // Why the whole map and not only this host's entry: a name is the group's, so a host that learned a better one
        // for a third machine has to be able to hand it on. A caller reads its own entry from here.
        names: state.names,
        ...ownEndpoints
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

  // Why the lock is at this boundary: the methods below read the store, await something, and write it back, and the
  // scheduled pass on this host does the same. Serialising only the pass would leave an inbound removal or offer open
  // to being overwritten by it — and an inbound call that waits behind a pass merely retries, which loses nothing.
  //
  // Why the two pure reads are NOT locked: they read and reply with no await in between, so a lock protects nothing
  // there — while holding one deadlocks two hosts. A's pass holds A's lock and awaits B's read; B's pass holds B's lock
  // and awaits A's read. Both would wait out the 20s call timeout, both would record the other as unreached, and both
  // would back off in step toward fifteen minutes.
  return deps.lock === undefined ? service : lockService(service, deps.lock)
}

function lockService(service: HostMeshRpcService, lock: HostMeshWriteLock): HostMeshRpcService {
  return {
    join: (params, caller) => lock(() => service.join(params, caller)),
    relayIntroductions: (params, caller) => lock(() => service.relayIntroductions(params, caller)),
    introduce: (params, caller) => lock(() => service.introduce(params, caller)),
    pending: service.pending,
    offerBack: (params, caller) => lock(() => service.offerBack(params, caller)),
    sync: service.sync,
    remove: (params, caller) => lock(() => service.remove(params, caller))
  }
}
