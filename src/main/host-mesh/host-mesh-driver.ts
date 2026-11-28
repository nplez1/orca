/* eslint-disable max-lines -- Why: one cohesive protocol step (the local lifecycle: snapshot, join, sync, repair, removal), and the four calls it orders are unreadable apart; the sealing and the peer-facing half already live in their own modules. */
import { randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import {
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_MAX_LABEL_CHARS,
  HOST_MESH_NAME_DEFAULT_VERSION,
  HOST_MESH_NAME_SEED_VERSION,
  HOST_MESH_OFFER_BACK_METHOD,
  HOST_MESH_OFFER_TTL_MS,
  HOST_MESH_PAYLOAD_VERSION,
  HOST_MESH_PENDING_METHOD,
  HOST_MESH_RELAY_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_REVERSE_OFFER_RETRY_MS,
  HOST_MESH_SYNC_METHOD,
  hostMeshPairStatus,
  isHostMeshPlaceholderName,
  type HostMeshJoinReply,
  type HostMeshJoinRequest,
  type HostMeshMember,
  type HostMeshOfferBackReply,
  type HostMeshOfferBackRequest,
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
  setHostMeshRoutes,
  summarizeHostMesh
} from '../../shared/host-mesh/host-mesh-membership'
import { dialCandidates } from '../../shared/host-mesh/host-mesh-routes'
import { mergeHostMeshNames, setHostMeshName } from '../../shared/host-mesh/host-mesh-names'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { createHostMeshStore, type HostMeshStore } from './host-mesh-store'
import { createHostMeshWriteLock } from './host-mesh-write-lock'
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

/**
 * What this launch knows about the offer it made to one member.
 *
 * Why the mint time is separate from the attempt time: each mint is a device row on this host, so minting is
 * what has to be bounded. An attempt is just a send, and the box an earlier attempt produced can be sent
 * again inside its own lifetime.
 */
type ReverseOffer = {
  /** When a credential was last minted for this member. Never moved forward by a retry. */
  mintedAt: number
  /** When the request was last sent. */
  attemptedAt: number
  refused: string | null
  /** The sealed request, kept so a retry resends it rather than minting a second credential. */
  request: HostMeshOfferBackRequest | null
  mintedRowId: string | null
  /** Set by a connection change: the last attempt failed technically, so repeating it now is worth it. */
  retryNow: boolean
}

export function createHostMeshDriver(deps: HostMeshDriverDeps): HostMeshDriver {
  const store: HostMeshStore = createHostMeshStore({ userDataPath: deps.userDataPath })
  const keypair = () => deps.ownKeypair()
  const selfKey = () => orcaHostKeyOf(keypair().publicKeyB64)

  const withLock = deps.lock ?? createHostMeshWriteLock()

  let lastError: string | null = null
  /** In memory on purpose: "kept current" is a fact about this launch, not about the group. */
  let lastSyncedAt: number | null = null
  /** How many members answered the last pass, or null before one ran: the signal a backoff needs. */
  let lastPassReached: number | null = null

  /**
   * The offers this launch has already made to members that held nothing back to here.
   *
   * Why in memory and not in the store: each attempt mints a device row on this host, so the only thing worth
   * remembering is "do not mint another one this minute" — and a fresh launch retrying once is the behaviour a
   * fleet that was asleep when the first offer was made needs.
   */
  const reverseOffers = new Map<string, ReverseOffer>()

  /**
   * Drops the offers nobody redeemed and the peer index kept an id for.
   *
   * Why the pass does this: every retry mints a device row, and an owner cannot tell thirty spent offers from
   * thirty pairings — Settings lists them as active links because that is what they are until they expire.
   * The rows are dead once their own TTL has passed, so the pass that made them is the pass that clears them.
   */
  function pruneStaleOffers(): void {
    if (deps.pruneExpiredOffers === undefined) {
      return
    }
    try {
      const pruned = deps.pruneExpiredOffers()
      if (pruned.length > 0) {
        store.forgetPeerDeviceRows(new Set(pruned))
      }
    } catch (error) {
      // Why swallowed: spent offers are bookkeeping, and a device registry that refuses a revoke must not cost the
      // whole pass the members it would otherwise reach.
      console.debug('[host-mesh] could not prune expired offers', error)
    }
  }

  /**
   * Whether the failure came from the peer rather than from the path to it.
   *
   * Why the distinction exists: a peer that answered and refused proves its address works, so adopting another one
   * would be a repair aimed at the wrong fact.
   */
  function isPeerRefusal(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'peerCode' in error
  }

  /**
   * A member that answered `invalid_argument`: its schema refused the request, not this host's credential.
   *
   * Why its own name: a sync whose `endpoints` a pre-route-publishing build cannot read is a wire-shape mismatch
   * between two working machines, and the retry without them is the only thing that keeps that pair joined.
   */
  function isInvalidParams(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'peerCode' in error &&
      error.peerCode === 'invalid_argument'
    )
  }

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

  /** What the group calls this host, if it has ever been named. */
  function selfName(state: HostMeshState): string | undefined {
    return state.names[state.selfKey]?.label
  }

  /**
   * What this host reports when it introduces or offers itself.
   *
   * Why the fallback is the hostname and not "this host": a recipient stores this string as the pairing's name, so
   * "this host" would leave every machine that redeemed an offer from here with a row nobody can identify.
   */
  function myName(state: HostMeshState): string {
    return selfName(state) ?? deps.labelForHostKey(selfKey()) ?? deps.selfLabel?.() ?? 'Orca host'
  }

  /**
   * Names the group has for its members, this host's own included — the seed a peer reads on its next pull.
   *
   * Why a seed is derived here and not stored at pairing time: the name a machine has on THIS host is exactly the
   * name its owner typed into this host's own pairing row, which is often the only good name that exists for a
   * machine nobody has renamed since.
   */
  function namesForPass(state: HostMeshState): HostMeshState {
    let names = state.names
    const peerIndex = store.readPeerIndex()
    for (const member of state.members) {
      if (names[member.hostKey] !== undefined) {
        continue
      }
      const label = deps.labelForHostKey(member.hostKey)
      if (label === null || label.trim() === '') {
        continue
      }
      // Why a placeholder is never seeded, invented or not: it names no machine, and a group-wide `Mesh host 8f3ac2b1`
      // would then outrank a hostname another host reported, on a tie it wins by sorting after `Build-` and `MacBook`.
      if (isHostMeshPlaceholderName(label, member.hostKey)) {
        continue
      }
      const invented = peerIndex.get(member.hostKey)?.redeemedLabel === label
      names = mergeHostMeshNames(names, {
        [member.hostKey]: {
          label,
          version: invented ? HOST_MESH_NAME_DEFAULT_VERSION : HOST_MESH_NAME_SEED_VERSION
        }
      })
    }
    return names === state.names ? state : { ...state, names }
  }

  /**
   * The group's name for a member, as a name this host's own surfaces show.
   *
   * Why the pairing row is renamed rather than a display override written: the environment name is what the sidebar,
   * the status bar and the CLI all read, and an override would leave each of them with its own answer.
   */
  async function applyMemberNames(state: HostMeshState): Promise<void> {
    const rename = deps.renameEnvironment
    if (rename === undefined) {
      return
    }
    for (const member of state.members) {
      const name = state.names[member.hostKey]?.label
      if (name === undefined || deps.labelForHostKey(member.hostKey) === name) {
        continue
      }
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId === null) {
        continue
      }
      try {
        await rename(environmentId, name)
      } catch (error) {
        // Why not `lastError`: that line is the pass's verdict, and a name the store refused says nothing about
        // whether every member answered.
        console.debug('[host-mesh] could not rename the pairing for', member.hostKey, error)
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
  async function mintFor(args: {
    environmentId: string
    recipientHostKey: string
  }): Promise<{ offerUrl: string; deviceId: string; endpointCandidates: string[] }> {
    const minted = await deps.mintRuntimeOffer(args)
    store.recordPeer(args.recipientHostKey, { deviceRowId: minted.deviceId })
    return minted
  }

  /**
   * Keeps the addresses a minter published with its offer, so this host can dial it there if this path dies.
   *
   * Why an offer carries them: the endpoint inside a pairing code is the only one it names, and a machine that has
   * not synced since it moved has no other way to say where it can be reached.
   */
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

  /**
   * Redeems one box from a peer: the only place this host gains an outbound credential.
   *
   * Why the label comes from the caller and not the box: a sealed payload is held to an exact field set so no build
   * can smuggle anything past the opener, and a display name is not worth widening that. The name a peer reports
   * about itself travels in the request it just made, which is the same standing an introduction has.
   */
  async function redeem(
    payload: HostMeshOfferPayload,
    label?: string
  ): Promise<RedeemedPeer | null> {
    try {
      const peer = await deps.redeemOffer(payload.offerUrl, payload.minterHostKey, label)
      store.recordPeer(peer.hostKey, {
        environmentId: peer.environmentId,
        // Only a row this redemption created carries a name this host chose; an existing row kept the owner's.
        ...(peer.namedHere ? { redeemedLabel: peer.label } : {})
      })
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
    // Why unrecorded when mesh mode is off: recording the run would make the owner's later switch-on a step that
    // never groups the fleet it was installed for. Nothing is written, so the next launch still has the option.
    if (!deps.settings().enabled) {
      return { kind: 'nothing-to-group' }
    }
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
      // Why the name wins over the row's own label: a rename reaches the group before it reaches every pairing
      // row, and a surface reading the row would keep announcing the old word.
      label: state.names[member.hostKey]?.label ?? member.label,
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
      lastSyncedAt,
      lastPassReached,
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

  function join(environmentId: string): Promise<HostMeshJoinOutcome> {
    return withLock(() => joinLocked(environmentId))
  }

  async function joinLocked(environmentId: string): Promise<HostMeshJoinOutcome> {
    if (!deps.settings().enabled) {
      lastError = 'mesh-disabled'
      return { kind: 'refused', reason: 'mesh-disabled', snapshot: await snapshot() }
    }
    let state = loadState()
    const own = keypair()
    const label = myName(state)

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
      const offerUrl = (await mintFor({ environmentId, recipientHostKey: hello.selfKey })).offerUrl
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
        state = rememberOfferedRoutes(state, hello.selfKey, opened.payload.endpointCandidates)
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
    // members' own records, and a sync is what turns those into a truthful per-pair status. It runs inside the
    // lock this operation already holds, which is why it is not the public `sync`.
    await runSyncLocked()
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
        offerUrl = (await mintFor({ environmentId: args.environmentId, recipientHostKey: hostKey }))
          .offerUrl
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
      if (
        (await redeem(
          opened.payload,
          state.names[sealed.senderHostKey]?.label ?? member?.label
        )) !== null
      ) {
        state = rememberOfferedRoutes(
          state,
          sealed.senderHostKey,
          opened.payload.endpointCandidates
        )
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
   * Hands a member this host's own offer when that member holds no credential back to here.
   *
   * Why this is the only call that repairs an upgraded fleet: every other method in this protocol is a call the
   * holder of an environment makes, and a work host the studio dials holds none — so it can neither dial a
   * member nor be introduced by one. The side with the credential hands over an offer of its own, sealed to the
   * member, and the member redeems it and dials back. Neither host mints for the other.
   */
  async function offerBackTo(args: {
    state: HostMeshState
    member: HostMeshMember
    environmentId: string
  }): Promise<HostMeshState> {
    const { member } = args
    const known = reverseOffers.get(member.hostKey)
    // Why a resend and not a fresh offer: the box already minted is valid for exactly the window the retry
    // interval covers, so sending it again costs nothing. Minting again for every attempt is what left an
    // owner reading hundreds of spent offers as "active links", each one a live credential until it expired.
    if (known?.request != null) {
      // Why an aged box is dropped rather than resent: the retry interval and the offer lifetime are the same value,
      // so a resend that comes due is also one the recipient can only refuse — a round trip spent to learn the clock.
      if (deps.now() - known.mintedAt >= HOST_MESH_OFFER_TTL_MS) {
        known.request = null
        known.mintedRowId = null
      } else if (
        !known.retryNow &&
        deps.now() - known.attemptedAt < HOST_MESH_REVERSE_OFFER_RETRY_MS
      ) {
        return args.state
      } else {
        return deliverOfferBack({
          state: args.state,
          member,
          environmentId: args.environmentId,
          known
        })
      }
    }
    // Why a refusal is a wait and not an end: the owner at that machine can turn the mesh on at any time, and this
    // launch will not restart to notice. The wait is the retry interval, which is what bounds the minting.
    if (known !== undefined && deps.now() - known.mintedAt < HOST_MESH_REVERSE_OFFER_RETRY_MS) {
      return args.state
    }
    // Why the key is checked before minting: a member with no public key can never receive a sealed offer, so
    // minting one for it would leave a live credential behind that nothing could ever redeem.
    const now = deps.now()
    const entry: ReverseOffer = {
      mintedAt: now,
      attemptedAt: now,
      refused: null,
      request: null,
      mintedRowId: null,
      retryNow: false
    }
    // Recorded before the mint, so a mint that throws is throttled like any other attempt instead of retried
    // on every pass.
    reverseOffers.set(member.hostKey, entry)
    if (toBytes(member.publicKeyB64 ?? '') === null) {
      entry.refused = 'no-public-key'
      return args.state
    }

    const epoch = epochAfter(args.state.epoch)
    try {
      const minted = await mintFor({
        environmentId: args.environmentId,
        recipientHostKey: member.hostKey
      })
      entry.mintedRowId = minted.deviceId
      const sealed = sealTo({
        recipientHostKey: member.hostKey,
        recipientPublicKeyB64: member.publicKeyB64,
        groupId: args.state.groupId,
        epoch,
        introducedBy: selfKey(),
        offerUrl: minted.offerUrl,
        endpoints: minted.endpointCandidates
      })
      // A member with no sealable key is nothing to try until a sync brings one.
      if (sealed !== null) {
        entry.request = {
          version: HOST_MESH_PAYLOAD_VERSION,
          groupId: args.state.groupId,
          epoch,
          offerer: {
            hostKey: selfKey(),
            label: myName(args.state),
            publicKeyB64: keypair().publicKeyB64
          },
          sealed
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'offer-mint-failed'
      return args.state
    }
    if (entry.request === null) {
      return args.state
    }
    return deliverOfferBack({
      state: args.state,
      member,
      environmentId: args.environmentId,
      known: entry
    })
  }

  /** Sends the member the box this launch already holds for it, and records what came back. */
  async function deliverOfferBack(args: {
    state: HostMeshState
    member: HostMeshMember
    environmentId: string
    known: ReverseOffer
  }): Promise<HostMeshState> {
    const { known, member } = args
    known.attemptedAt = deps.now()
    known.retryNow = false
    try {
      const reply = await deps.send<HostMeshOfferBackReply>(
        args.environmentId,
        HOST_MESH_OFFER_BACK_METHOD,
        known.request
      )
      if (reply.kind !== 'accepted') {
        known.refused = reply.reason
        // Why the box is dropped: the far side answered, and its answer was no — so it can never be redeemed and
        // there is nothing left to resend. A replay is the exception: that reason means the member already opened
        // this box, so its link exists and revoking the row would cut the credential that link uses.
        known.request = null
        if (known.mintedRowId !== null && reply.reason !== 'offer-replayed') {
          deps.revokeMintedRow(known.mintedRowId)
          known.mintedRowId = null
        }
        return args.state
      }
      // Accepted, so the box is spent and there is nothing left to resend.
      known.request = null
      known.refused = null
    } catch (error) {
      // A machine on a build without this method, and a transport that dropped mid-call, are both "no answer
      // yet" rather than a refusal. Keeping the box is what stops either from minting an offer per pass.
      const reason = error instanceof Error ? error.message : 'offer-back-failed'
      if (reason !== 'method_not_found') {
        lastError = reason
      }
      // Why this one row is revoked even though the call failed: an unknown method means the box was never read, so
      // the credential is dead weight on a machine that will keep being retried. A dropped connection is not the same
      // fact — the box may have arrived and be redeeming — so that box stays and is resent instead.
      if (reason === 'method_not_found' && known.mintedRowId !== null) {
        deps.revokeMintedRow(known.mintedRowId)
        known.mintedRowId = null
        known.request = null
      }
      known.refused = null
      return args.state
    }
    // Why the inbound link is taken from the reply: the member answered `accepted` only after redeeming the
    // offer this host minted, so it now holds a working link back here — and waiting for its own report would
    // leave a pair that is joined both ways reading "one-way" until that member next synced.
    return setHostMeshInboundLink(args.state, {
      hostKey: member.hostKey,
      link: { kind: 'active' }
    })
  }

  /**
   * Asks every reachable member what it holds, which is the only way this host learns the direction a
   * member owns TO it — no amount of local bookkeeping can establish that.
   */
  async function pullMemberViews(start: HostMeshState): Promise<HostMeshState> {
    let state = start
    let reached = 0
    // Where this host can be dialed right now, read once for the pass: it is the same answer for every member.
    const endpoints = await deps.ownEndpoints().catch(() => [])
    for (const member of state.members) {
      const environmentId = deps.environmentIdForHostKey(member.hostKey)
      if (environmentId === null) {
        continue
      }
      try {
        const view = await readMemberView({ state, member, environmentId, endpoints })
        state = view.state
        if (view.reached) {
          reached += 1
        }
        continue
      } catch (error) {
        // Why a peer's own refusal is not a route problem: that host answered, so its address works — moving the row
        // to another of its addresses would trade a proven path for an unproven one, on every pass.
        const adopted = isPeerRefusal(error)
          ? false
          : await adoptRoute({ state, member, environmentId })
        // Why another route is tried before the member is called unreachable: the pairing row names the one endpoint
        // the pair was made on, so a machine that changed networks — a tailnet switched off, a new DHCP lease —
        // fails there while an address it published on an earlier pass still answers. Adoption repairs that row, so
        // every other feature dials the live path too, without any of them knowing about routes.
        if (adopted) {
          try {
            const view = await readMemberView({ state, member, environmentId, endpoints })
            state = view.state
            if (view.reached) {
              reached += 1
            }
            continue
          } catch (retryError) {
            state = markUnreachable(state, member, retryError)
            continue
          }
        }
        state = markUnreachable(state, member, error)
        continue
      }
    }
    lastPassReached = reached
    return state
  }

  /**
   * Tries the member's other known addresses and adopts the one that answers.
   *
   * Why it is the routes of the member and not this host's interfaces: only the far side knows where the far side
   * is, and what it published in an earlier sync is the newest answer this host has.
   */
  async function adoptRoute(args: {
    state: HostMeshState
    member: HostMeshMember
    environmentId: string
  }): Promise<boolean> {
    const adopt = deps.adoptReachableEndpoint
    if (adopt === undefined) {
      return false
    }
    const candidates = dialCandidates({
      current: null,
      routes: args.state.routes[args.member.hostKey]
    })
    if (candidates.length === 0) {
      return false
    }
    try {
      const adopted = await adopt({ environmentId: args.environmentId, candidates })
      if (adopted === null) {
        return false
      }
      // Why the pooled transport is dropped as well: everything that resolves the row per call already dials the new
      // address, while a connection opened before the move keeps the one the row no longer names.
      deps.invalidateTransport?.(args.environmentId)
      return true
    } catch (error) {
      // Why swallowed: a path that could not be adopted is the same fact as one that did not answer, and the pass
      // already reports the member as unreachable.
      console.debug('[host-mesh] could not adopt a route to', args.member.hostKey, error)
      return false
    }
  }

  /** The link state a failed pass leaves behind: a peer too old for this protocol is not a broken network. */
  function markUnreachable(
    state: HostMeshState,
    member: HostMeshMember,
    error: unknown
  ): HostMeshState {
    const unsupported = error instanceof Error && error.message === 'method_not_found'
    return setHostMeshOutboundLink(state, {
      hostKey: member.hostKey,
      link: unsupported
        ? { kind: 'unsupported', since: deps.now() }
        : { kind: 'unreachable', since: deps.now() }
    })
  }

  /**
   * One member's view, merged — the whole of a pass that reaches it.
   *
   * Why its own function: an unreachable path is retried on another route, and the retry has to run exactly this
   * rather than a copy of it.
   */
  async function readMemberView(args: {
    state: HostMeshState
    member: HostMeshMember
    environmentId: string
    endpoints: readonly string[]
  }): Promise<{ state: HostMeshState; reached: boolean }> {
    const { member, environmentId } = args
    let state = args.state
    const request = {
      version: HOST_MESH_PAYLOAD_VERSION,
      groupId: state.groupId,
      hostKey: selfKey(),
      // Why this host publishes its own addresses on every request: the member that can still be reached learns
      // where to look before the path it is using dies.
      ...(args.endpoints.length === 0 ? {} : { endpoints: [...args.endpoints] })
    } satisfies HostMeshPendingRequest
    const payload = await deps
      .send<HostMeshSyncPayload>(environmentId, HOST_MESH_SYNC_METHOD, request)
      .catch(async (error: unknown) => {
        // Why the list is retried without: a member on a build whose schema predates route publishing answers
        // `invalid_argument` for the extra key, and the addresses are an optimisation while the sync is the pair.
        if (request.endpoints === undefined || !isInvalidParams(error)) {
          throw error
        }
        const { endpoints: _endpoints, ...withoutEndpoints } = request
        return await deps.send<HostMeshSyncPayload>(
          environmentId,
          HOST_MESH_SYNC_METHOD,
          withoutEndpoints
        )
      })
    if (!confirmKey(payload.selfKey, payload.publicKeyB64)) {
      return { state, reached: false }
    }
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
    // Why after the merge and not before: a member that reported a working link back here is already
    // paired, and one that reported nothing is exactly the half this pass exists to close.
    if (state.links.inbound[member.hostKey]?.kind !== 'active') {
      state = await offerBackTo({ state, member, environmentId })
    }
    return { state, reached: true }
  }

  /**
   * A member's connection came up, so the wait that bounds re-offering is no longer the truth.
   *
   * Why this exists for a staggered upgrade: an update restarts a machine, which drops and re-establishes its
   * connection — the one moment this host can know an offer it was refused on technical grounds is worth making
   * again. A refusal on the merits is kept, because a connection does not change that machine's mind.
   */
  function noteConnectionChange(): void {
    for (const entry of reverseOffers.values()) {
      if (entry.refused === null) {
        // Why the mint window is left alone: a member whose connection flaps would otherwise cost one device row
        // per flap. What a reconnect changes is that the box this launch already minted is worth sending again.
        entry.retryNow = entry.request !== null
      }
    }
  }

  /** One pass at a time: a peer-triggered pass and a scheduled one must not interleave two writes. */
  let syncing: Promise<HostMeshSnapshot> | null = null

  function sync(): Promise<HostMeshSnapshot> {
    if (syncing !== null) {
      return syncing
    }
    // Why the pass takes the write lock: it reads the store, then spends seconds per member on the network, then
    // writes. Without the lock an Eject or an inbound removal landing in that window is silently overwritten.
    const run = withLock(runSyncLocked).finally(() => {
      syncing = null
    })
    syncing = run
    return run
  }

  async function runSyncLocked(): Promise<HostMeshSnapshot> {
    let state = loadState()
    // Why mesh mode gates the pass itself: off means this computer neither dials a member nor mints an offer, and
    // a sync that still did either would be the one thing that switch is supposed to stop.
    if (state.groupId === '' || !deps.settings().enabled) {
      return snapshot()
    }
    // Why before the pull: this is the pass that tells the members what this host calls them, so seeding after it
    // would postpone every repair by one cycle.
    state = namesForPass(state)
    pruneStaleOffers()
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
          label: myName(state),
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
    lastSyncedAt = deps.now()

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
    // Why after the second pass: a name can arrive in either pull, and renaming on the first would leave the pairing
    // row of a host renamed in the second showing its old name until the next minute.
    await applyMemberNames(state)
    return snapshot()
  }

  /**
   * Renames a machine for the whole group.
   *
   * Why this host may rename a machine it is not: the name is a property of the group rather than of the machine, so
   * whoever knows the better name writes it once and every host — the named one included — reads it on its next pass.
   */
  function renameMember(hostKey: string, label: string): Promise<HostMeshSnapshot> {
    const wanted = label.trim()
    if (wanted === '' || wanted.length > HOST_MESH_MAX_LABEL_CHARS) {
      return Promise.reject(new Error('host_mesh_invalid_request'))
    }
    return withLock(async () => {
      const state = loadState()
      // Why the state is checked before the write: naming a machine outside a group would write a group file that the
      // upgrade step then reads as "already grouped", leaving the fleet this install was paired with ungrouped.
      if (state.groupId === '') {
        throw new Error('host_mesh_not_in_group')
      }
      if (
        hostKey !== state.selfKey &&
        !state.members.some((member) => member.hostKey === hostKey)
      ) {
        // Why its own code: the host may have been ejected while the dialog that named it was open, and an
        // unusable-name message for a machine that is no longer a member misleads the owner.
        throw new Error('host_mesh_unknown_member')
      }
      const next = setHostMeshName(state, { hostKey, label: wanted })
      saveState(next)
      await applyMemberNames(next)
      return snapshot()
    })
  }

  function removeMember(hostKey: string): Promise<HostMeshSnapshot> {
    return withLock(async () => {
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
    })
  }

  function leave(): Promise<HostMeshSnapshot> {
    return withLock(async () => {
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
      return await snapshot()
    })
  }

  async function updateSettings(patch: Partial<HostMeshSettings>): Promise<HostMeshSnapshot> {
    deps.saveSettings({ ...DEFAULT_HOST_MESH_SETTINGS, ...deps.settings(), ...patch })
    return snapshot()
  }

  return {
    snapshot,
    join,
    sync,
    noteConnectionChange,
    renameMember,
    removeMember,
    leave,
    updateSettings,
    migrateFromPairings
  }
}
