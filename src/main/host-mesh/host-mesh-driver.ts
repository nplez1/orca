/* eslint-disable max-lines -- Why: one cohesive protocol step (the local lifecycle: snapshot, join, sync, repair, removal), and the four calls it orders are unreadable apart; the sealing and the peer-facing half already live in their own modules. */
import { randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import {
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_OFFER_TTL_MS,
  HOST_MESH_PAYLOAD_VERSION,
  HOST_MESH_PENDING_METHOD,
  HOST_MESH_RELAY_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_SYNC_METHOD,
  hostMeshPairStatus,
  type HostMeshJoinReply,
  type HostMeshJoinRequest,
  type HostMeshOfferPayload,
  type HostMeshPendingReply,
  type HostMeshPendingRequest,
  type HostMeshRelayRequest,
  type HostMeshRemoveRequest,
  type HostMeshSealedOffer,
  type HostMeshState,
  type HostMeshSyncPayload
} from '../../shared/host-mesh/host-mesh-contract'
import {
  DEFAULT_HOST_MESH_SETTINGS,
  membersAwaitingNewcomerOffer,
  type HostMeshSettings
} from '../../shared/host-mesh/host-mesh-admission'
import { adoptHostMeshGroup } from '../../shared/host-mesh/host-mesh-adoption'
import {
  addHostMeshMember,
  applyHostMeshSync,
  createHostMeshState,
  leaveHostMeshGroup,
  removeHostMeshMember,
  setHostMeshInboundLink,
  setHostMeshOutboundLink,
  summarizeHostMesh
} from '../../shared/host-mesh/host-mesh-membership'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { createHostMeshStore, type HostMeshStore } from './host-mesh-store'
import { HOST_MESH_MIGRATION_VERSION, planHostMeshMigration } from './host-mesh-migration'
import { createHostMeshRpcService } from './host-mesh-rpc-service'

export { createHostMeshRpcService }
import { openHostMeshSealedOffer, sealHostMeshOffer } from './host-mesh-sealed-offer'
import type {
  HostMeshDriver,
  HostMeshDriverDeps,
  HostMeshJoinOutcome,
  HostMeshMigrationOutcome,
  HostMeshMemberView,
  HostMeshSnapshot,
  RedeemedPeer
} from './host-mesh-driver-contract'

/**
 * The mesh, end to end: one join pairs the newcomer with every member.
 *
 * The shape of the protocol, and why it needs four calls instead of one:
 *
 *   1. the newcomer asks a member what group it is in (`sync`) — read-only, so a refusal costs nothing;
 *   2. it mints its OWN offer and hands it over (`join`); the member redeems it, so the credential lands
 *      on the side that chose to hand it out;
 *   3. the member mints ITS own offer back in the reply, because a pair with one direction recorded is the
 *      half-join this feature exists to avoid;
 *   4. the newcomer mints one more offer per remaining member and hands the batch over (`relayIntroductions`),
 *      and collects each member's reply offer by polling (`pending`) instead of being dialled back.
 *
 * Every box is `nacl.box` static-static, so a courier can neither open nor alter it, and the only machine
 * that can open a box is the one it was addressed to.
 */

function toBytes(base64: string): Uint8Array | null {
  const decoded = Buffer.from(base64, 'base64')
  return decoded.byteLength === nacl.box.publicKeyLength && decoded.toString('base64') === base64
    ? new Uint8Array(decoded)
    : null
}

function epochAfter(...values: readonly number[]): number {
  return Math.max(0, ...values) + 1
}

export function createHostMeshDriver(deps: HostMeshDriverDeps): HostMeshDriver {
  const store: HostMeshStore = createHostMeshStore({ userDataPath: deps.userDataPath })
  const keypair = () => deps.ownKeypair()
  const selfKey = () => orcaHostKeyOf(keypair().publicKeyB64)

  let lastError: string | null = null

  /** Read once per snapshot, and never allowed to fail a snapshot: it only annotates one. */
  function storedMigration(): { appliedAt: number; peerCount: number } | null {
    try {
      const record = store.readMigration()
      return record === null ? null : { appliedAt: record.appliedAt, peerCount: record.peerCount }
    } catch {
      return null
    }
  }

  function loadState(): HostMeshState {
    return store.read() ?? createHostMeshState({ selfKey: selfKey(), groupId: '', epoch: 1 })
  }

  function saveState(state: HostMeshState): void {
    store.write(state)
    settleLinks(state)
  }

  /** Keeps the peer index truthful, which is what removal later keys on rather than the pairing rows. */
  function settleLinks(state: HostMeshState): void {
    for (const member of state.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId !== null) {
        store.recordPeer(member.hostKey, { environmentId })
      }
    }
  }

  function confirmKey(hostKey: string, publicKeyB64: string | undefined): boolean {
    return publicKeyB64 !== undefined && orcaHostKeyOf(publicKeyB64) === hostKey
  }

  function sealTo(args: {
    recipientHostKey: string
    recipientPublicKeyB64: string | undefined
    groupId: string
    epoch: number
    introducedBy: string
    offerUrl: string
    endpoints?: readonly string[]
  }): HostMeshSealedOffer | null {
    const recipientKey = args.recipientPublicKeyB64 ? toBytes(args.recipientPublicKeyB64) : null
    if (recipientKey === null) {
      return null
    }
    const payload: HostMeshOfferPayload = {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId: args.groupId,
      epoch: args.epoch,
      minterHostKey: selfKey(),
      recipientHostKey: args.recipientHostKey,
      introducedBy: args.introducedBy,
      offerUrl: args.offerUrl,
      endpointCandidates: [...(args.endpoints ?? [])],
      expiresAt: deps.now() + HOST_MESH_OFFER_TTL_MS,
      nonce: randomUUID()
    }
    return sealHostMeshOffer({
      payload,
      senderSecretKey: keypair().secretKey,
      recipientPublicKey: recipientKey
    })
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
      recipientSecretKey: keypair().secretKey,
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

  /**
   * Cuts both directions to a machine: the device row first, because it is the credential that lets that
   * machine reach this host, then the environment, which is how this host reaches it.
   */
  function tearDownPeer(hostKey: string): void {
    const environmentId = deps.environmentIdForHostKey(hostKey)
    deps.forgetDevice(hostKey)
    deps.forgetEnvironment(environmentId ?? hostKey)
    store.forgetPeer(hostKey)
  }

  /** Mints an offer for one recipient and records the device row it created, which is what removal revokes. */
  async function mintFor(recipientHostKey: string): Promise<string> {
    const minted = await deps.mintRuntimeOffer()
    store.recordPeer(recipientHostKey, { deviceRowId: minted.deviceId })
    return minted.offerUrl
  }

  /** Redeems one box from a peer: the only place this host gains an outbound credential. */
  async function redeem(payload: HostMeshOfferPayload): Promise<RedeemedPeer | null> {
    try {
      const peer = await deps.redeemOffer(payload.offerUrl, payload.minterHostKey)
      store.recordPeer(peer.hostKey, { environmentId: peer.environmentId })
      return peer
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'redeem-failed'
      return null
    }
  }

  /**
   * Groups the machines this install is already paired with, once, the first time a build with the mesh runs.
   *
   * Why not a side effect of reading the state: this runs at startup and writes the store, and a read path
   * that quietly creates a group would fire from any RPC — including one a peer is driving.
   */
  function migrateFromPairings(): HostMeshMigrationOutcome {
    if (store.readMigration() !== null) {
      return { kind: 'already-recorded' }
    }
    // A group of this install's own is authoritative: this is an upgrade step, never a reset.
    if (store.read() !== null) {
      store.recordMigration({
        version: HOST_MESH_MIGRATION_VERSION,
        appliedAt: deps.now(),
        peerCount: 0
      })
      return { kind: 'already-recorded' }
    }
    const plan = planHostMeshMigration({ selfKey: selfKey(), peers: deps.listPairedHostKeys() })
    if (plan === null) {
      store.recordMigration({
        version: HOST_MESH_MIGRATION_VERSION,
        appliedAt: deps.now(),
        peerCount: 0
      })
      return { kind: 'nothing-to-group' }
    }
    store.write(plan.state)
    store.recordMigration({
      version: HOST_MESH_MIGRATION_VERSION,
      appliedAt: deps.now(),
      peerCount: plan.peerCount
    })
    return { kind: 'grouped', peerCount: plan.peerCount }
  }

  async function snapshot(): Promise<HostMeshSnapshot> {
    const state = loadState()
    const members: HostMeshMemberView[] = state.members.map((member) => ({
      hostKey: member.hostKey,
      label: member.label,
      ...(member.introducedBy === undefined ? {} : { introducedBy: member.introducedBy }),
      status: hostMeshPairStatus(member.hostKey, state.links),
      environmentId: deps.environmentIdForHostKey(member.hostKey)
    }))
    return {
      inGroup: state.groupId !== '',
      groupId: state.groupId,
      selfKey: state.selfKey,
      members,
      summary: summarizeHostMesh(state),
      settings: deps.settings(),
      lastError,
      migration: storedMigration()
    }
  }

  async function adoptGroup(args: {
    state: HostMeshState
    groupId: string
    epoch: number
    selfPublicKeyB64: string
  }): Promise<HostMeshState> {
    return args.state.groupId === args.groupId
      ? { ...args.state, epoch: Math.max(args.state.epoch, args.epoch) }
      : {
          ...args.state,
          groupId: args.groupId,
          epoch: Math.max(args.state.epoch, args.epoch),
          selfKey: args.state.selfKey || orcaHostKeyOf(args.selfPublicKeyB64)
        }
  }

  async function join(environmentId: string): Promise<HostMeshJoinOutcome> {
    let state = loadState()
    const own = keypair()
    const label = deps.labelForHostKey(selfKey()) ?? 'this host'

    let hello: HostMeshSyncPayload
    try {
      hello = await deps.send<HostMeshSyncPayload>(environmentId, HOST_MESH_SYNC_METHOD, {
        version: HOST_MESH_PAYLOAD_VERSION,
        groupId: state.groupId,
        hostKey: selfKey()
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unreachable'
      return { kind: 'refused', reason: 'unreachable', snapshot: await snapshot() }
    }

    if (!confirmKey(hello.selfKey, hello.publicKeyB64)) {
      lastError = 'peer-key-mismatch'
      return { kind: 'refused', reason: 'peer-key-mismatch', snapshot: await snapshot() }
    }

    const groupId = hello.groupId === '' ? randomUUID() : hello.groupId
    const epoch = epochAfter(state.epoch, hello.epoch)
    const selfPk = own.publicKeyB64

    let sealedForIntroducer: HostMeshSealedOffer | null = null
    try {
      const offerUrl = await mintFor(hello.selfKey)
      sealedForIntroducer = sealTo({
        recipientHostKey: hello.selfKey,
        recipientPublicKeyB64: hello.publicKeyB64,
        groupId,
        epoch,
        introducedBy: hello.selfKey,
        offerUrl
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'offer-mint-failed'
    }
    if (sealedForIntroducer === null) {
      lastError ??= 'offer-mint-failed'
      return { kind: 'refused', reason: 'offer-mint-failed', snapshot: await snapshot() }
    }

    const request: HostMeshJoinRequest = {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId,
      epoch,
      joiner: { hostKey: selfKey(), label, publicKeyB64: selfPk },
      sealedForIntroducer
    }

    let reply: HostMeshJoinReply
    try {
      reply = await deps.send<HostMeshJoinReply>(environmentId, HOST_MESH_JOIN_METHOD, request)
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'join-failed'
      return { kind: 'refused', reason: 'join-failed', snapshot: await snapshot() }
    }
    if (reply.kind === 'refused') {
      lastError = reply.reason
      return { kind: 'refused', reason: reply.reason, snapshot: await snapshot() }
    }

    state = await adoptGroup({
      state,
      groupId: reply.groupId,
      epoch: reply.epoch,
      selfPublicKeyB64: selfPk
    })
    state = addHostMeshMember(state, {
      hostKey: hello.selfKey,
      label: deps.labelForHostKey(hello.selfKey) ?? 'member',
      publicKeyB64: hello.publicKeyB64,
      epoch: reply.epoch
    }).state
    for (const member of reply.members) {
      state = addHostMeshMember(state, {
        hostKey: member.hostKey,
        label: member.label,
        ...(member.publicKeyB64 === undefined ? {} : { publicKeyB64: member.publicKeyB64 }),
        introducedBy: hello.selfKey,
        epoch: reply.epoch
      }).state
    }
    state = applyHostMeshSync(state, {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId: reply.groupId,
      epoch: reply.epoch,
      selfKey: hello.selfKey,
      publicKeyB64: hello.publicKeyB64,
      members: reply.members,
      tombstones: reply.tombstones,
      links: {}
    })

    // The introducer's own offer, so this host holds a credential for the member that admitted it.
    if (reply.sealedForJoiner !== null) {
      const opened = openFrom(reply.sealedForJoiner, hello.publicKeyB64)
      if (opened.payload !== null && (await redeem(opened.payload)) !== null) {
        state = setHostMeshOutboundLink(state, { hostKey: hello.selfKey, link: { kind: 'ok' } })
        state = setHostMeshInboundLink(state, { hostKey: hello.selfKey, link: { kind: 'active' } })
      }
    }
    saveState(state)

    const muted = await relayToMembers({
      state,
      environmentId,
      carrierHostKey: hello.selfKey,
      groupId,
      epoch,
      label,
      selfPk
    })
    state = loadState()
    const collected = await collectPending({ state, environmentId, groupId })
    state = collected.state
    saveState(state)

    // Why one more pass: a join leaves this host holding credentials whose counterparts only exist as the
    // members' own records, and a sync is what turns those into a truthful per-pair status.
    await sync()
    // Why not cleared: a join that reached the introducer but not every member is a half-join, and the
    // surface has to be able to say so rather than reporting a clean group.
    return { kind: 'joined', snapshot: await snapshot(), muted }
  }

  /** One offer per member the newcomer is not yet joined to, batched into a single relay call. */
  async function relayToMembers(args: {
    state: HostMeshState
    environmentId: string
    /** The host that will carry this batch, and therefore the one each box names as its voucher. */
    carrierHostKey: string
    groupId: string
    epoch: number
    label: string
    selfPk: string
  }): Promise<string[]> {
    const targets = membersAwaitingNewcomerOffer(args.state, selfKey()).filter((hostKey) => {
      const member = args.state.members.find((entry) => entry.hostKey === hostKey)
      return member?.publicKeyB64 !== undefined
    })
    if (targets.length === 0) {
      return []
    }
    const sealed: HostMeshSealedOffer[] = []
    for (const hostKey of targets) {
      const member = args.state.members.find((entry) => entry.hostKey === hostKey)
      if (member === undefined) {
        continue
      }
      let offerUrl: string
      try {
        offerUrl = await mintFor(hostKey)
      } catch {
        continue
      }
      const box = sealTo({
        recipientHostKey: hostKey,
        recipientPublicKeyB64: member.publicKeyB64,
        groupId: args.groupId,
        epoch: args.epoch,
        introducedBy: args.carrierHostKey,
        offerUrl
      })
      if (box !== null) {
        sealed.push(box)
      }
    }
    if (sealed.length === 0) {
      return []
    }
    const request: HostMeshRelayRequest = {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId: args.groupId,
      epoch: args.epoch,
      joiner: { hostKey: selfKey(), label: args.label, publicKeyB64: args.selfPk },
      sealed
    }
    try {
      const result = await deps.send<{ forwarded: number; refused: string[] }>(
        args.environmentId,
        HOST_MESH_RELAY_METHOD,
        request
      )
      return result.refused
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'relay-failed'
      return []
    }
  }

  /** Collects the offers members minted back, which is the other half of every pair. */
  async function collectPending(args: {
    state: HostMeshState
    environmentId: string
    groupId: string
  }): Promise<{ state: HostMeshState }> {
    let state = args.state
    let reply: HostMeshPendingReply
    try {
      reply = await deps.send<HostMeshPendingReply>(args.environmentId, HOST_MESH_PENDING_METHOD, {
        version: HOST_MESH_PAYLOAD_VERSION,
        groupId: args.groupId,
        hostKey: selfKey()
      } satisfies HostMeshPendingRequest)
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'pending-failed'
      return { state }
    }
    for (const sealed of reply.sealed) {
      const member = state.members.find((entry) => entry.hostKey === sealed.senderHostKey)
      const opened = openFrom(sealed, member?.publicKeyB64)
      if (opened.payload === null) {
        continue
      }
      if ((await redeem(opened.payload)) !== null) {
        state = setHostMeshOutboundLink(state, {
          hostKey: sealed.senderHostKey,
          link: { kind: 'ok' }
        })
        state = setHostMeshInboundLink(state, {
          hostKey: sealed.senderHostKey,
          link: { kind: 'active' }
        })
      }
    }
    return { state }
  }

  /**
   * Asks every reachable member what it holds, which is the only way this host learns the direction a
   * member owns TO it — no amount of local bookkeeping can establish that.
   */
  async function pullMemberViews(start: HostMeshState): Promise<HostMeshState> {
    let state = start
    for (const member of state.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId === null) {
        continue
      }
      try {
        const payload = await deps.send<HostMeshSyncPayload>(environmentId, HOST_MESH_SYNC_METHOD, {
          version: HOST_MESH_PAYLOAD_VERSION,
          groupId: state.groupId,
          hostKey: selfKey()
        } satisfies HostMeshPendingRequest)
        if (confirmKey(payload.selfKey, payload.publicKeyB64)) {
          // Why a reply proves the outbound link: the peer authenticated this host and answered on a
          // credential this host holds, which is exactly what `ok` claims. Leaving it at `awaitingOffer`
          // would also mean a migrated group can never start repairing itself — the repair needs one member
          // that already works to carry the others' offers, and nothing else would ever mark one.
          state = setHostMeshOutboundLink(state, { hostKey: member.hostKey, link: { kind: 'ok' } })
          // Why adoption precedes the merge: two hosts upgraded from the same fleet derive their own group
          // ids, and the merge refuses a payload from a group it is not in — so without this the fleet
          // would stay split with each half convinced the other is a stranger.
          const adoption = adoptHostMeshGroup(
            state,
            {
              groupId: payload.groupId,
              epoch: payload.epoch,
              hostKeys: [payload.selfKey, ...payload.members.map((view) => view.hostKey)]
            },
            {
              isTrusted: (hostKey) => deps.environmentIdForHostKey(hostKey) !== null,
              // The member that sent this payload vouches for the list it sent, which is the same standing an
              // introduction has: a machine we are paired with saying "this one is in the group too". Anything
              // we have not been told about is still refused, so a stranger cannot arrive unnoticed.
              vouched: payload.members.map((view) => view.hostKey)
            }
          )
          if (adoption.kind === 'adopt') {
            state = adoption.state
          }
          state = applyHostMeshSync(state, payload)
        }
      } catch (error) {
        // A peer from before this feature answers `method_not_found`: it is not a broken network, it is a
        // machine that has not updated yet, and during a staggered rollout that is the normal state.
        const unsupported = error instanceof Error && error.message === 'method_not_found'
        state = setHostMeshOutboundLink(state, {
          hostKey: member.hostKey,
          link: unsupported
            ? { kind: 'unsupported', since: deps.now() }
            : { kind: 'unreachable', since: deps.now() }
        })
      }
    }
    return state
  }

  async function sync(): Promise<HostMeshSnapshot> {
    let state = loadState()
    if (state.groupId === '') {
      return snapshot()
    }
    const membersBefore = new Set(state.members.map((member) => member.hostKey))
    state = await pullMemberViews(state)
    // Why a tombstone learned from a member tears down: this is the only path a member that was asleep ever
    // takes, and dropping the row without revoking would leave it holding a live credential.
    for (const hostKey of membersBefore) {
      if (!state.members.some((member) => member.hostKey === hostKey)) {
        tearDownPeer(hostKey)
      }
    }

    // Why a sync repairs: a member that refused an introduction once is the ordinary way a pair stalls, and
    // making the owner re-run the join by hand would leave the group half-joined until they noticed.
    const awaiting = membersAwaitingNewcomerOffer(state, selfKey())
    if (awaiting.length > 0) {
      const introducer = state.members.find(
        (member) =>
          !awaiting.includes(member.hostKey) &&
          deps.environmentIdForHostKey(member.hostKey) !== null
      )
      const introducerEnvironment =
        introducer === undefined ? null : deps.environmentIdForHostKey(introducer.hostKey)
      if (introducerEnvironment !== null) {
        await relayToMembers({
          state,
          environmentId: introducerEnvironment,
          carrierHostKey: introducer?.hostKey ?? selfKey(),
          groupId: state.groupId,
          epoch: epochAfter(state.epoch),
          label: deps.labelForHostKey(selfKey()) ?? 'this host',
          selfPk: deps.ownKeypair().publicKeyB64
        })
      }
    }

    if (state.tombstones.some((tombstone) => tombstone.hostKey === selfKey())) {
      // Why the whole group goes: a group that removed this host is not a group this host is in, and
      // keeping the row would let the sidebar offer actions that can no longer reach anything.
      // Why every peer is torn down first: being ejected is a removal of this host by the group, so the
      // credentials on both sides go too — leaving them would keep a live device row for a group this host
      // is no longer in.
      for (const member of state.members) {
        tearDownPeer(member.hostKey)
      }
      state = leaveHostMeshGroup(state, { epoch: epochAfter(state.epoch) })
      saveState(state)
      return snapshot()
    }
    saveState(state)

    for (const member of state.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId === null) {
        continue
      }
      const collected = await collectPending({ state, environmentId, groupId: state.groupId })
      state = collected.state
    }
    saveState(state)

    // Why twice: the repair above changes what members hold, and a status read before it settles would call
    // a pair one-way that is now joined both ways.
    if (awaiting.length > 0) {
      state = await pullMemberViews(state)
      // A tombstone can arrive in either pass, and the set compared above is already behind by then.
      for (const hostKey of membersBefore) {
        if (!state.members.some((member) => member.hostKey === hostKey)) {
          tearDownPeer(hostKey)
        }
      }
      saveState(state)
    }
    return snapshot()
  }

  async function removeMember(hostKey: string): Promise<HostMeshSnapshot> {
    let state = loadState()
    const member = state.members.find((entry) => entry.hostKey === hostKey)
    const environmentId = deps.environmentIdForHostKey(hostKey)
    state = removeHostMeshMember(state, {
      hostKey,
      removedBy: selfKey(),
      epoch: epochAfter(state.epoch)
    })
    const removal = {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId: state.groupId,
      hostKey,
      removedBy: selfKey(),
      epoch: state.epoch
    } satisfies HostMeshRemoveRequest

    // Why the removed machine is told before anything is deleted: once its environment is gone this host
    // cannot reach it, so it would only learn at its own next sync — or never, if it never syncs.
    if (member !== undefined && environmentId !== null) {
      await deps.send(environmentId, HOST_MESH_REMOVE_METHOD, removal).catch(() => undefined)
    }
    tearDownPeer(hostKey)
    saveState(state)

    // Best effort for the rest: a member that is asleep learns at its next sync, and tombstones win there.
    for (const other of state.members) {
      const otherEnvironment = deps.environmentIdForHostKey(other.hostKey)
      if (otherEnvironment === null) {
        continue
      }
      await deps.send(otherEnvironment, HOST_MESH_REMOVE_METHOD, removal).catch(() => undefined)
    }
    return snapshot()
  }

  async function leave(): Promise<HostMeshSnapshot> {
    const current = loadState()
    const removal = {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId: current.groupId,
      hostKey: selfKey(),
      removedBy: selfKey(),
      epoch: epochAfter(current.epoch)
    } satisfies HostMeshRemoveRequest
    for (const member of current.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId !== null) {
        await deps.send(environmentId, HOST_MESH_REMOVE_METHOD, removal).catch(() => undefined)
      }
      tearDownPeer(member.hostKey)
    }
    const state = leaveHostMeshGroup(current, { epoch: epochAfter(current.epoch) })
    saveState(state)
    return snapshot()
  }

  async function updateSettings(patch: Partial<HostMeshSettings>): Promise<HostMeshSnapshot> {
    deps.saveSettings({ ...DEFAULT_HOST_MESH_SETTINGS, ...deps.settings(), ...patch })
    return snapshot()
  }

  return { snapshot, join, sync, removeMember, leave, updateSettings, migrateFromPairings }
}
