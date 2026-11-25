# Host mesh groups: one join, everyone paired

**Status:** design note, 2026-11-25. **Partly built** on `nplez1/host-mesh` — the group contract, the
membership reducer, the sealed-offer envelope and the on-disk store. **The pairing side is not wired**: no
offer is minted, relayed or redeemed yet, so nothing in a running app can join a group. See § "What is built,
and what is not".
**Why:** Orca pairing is directional. The caller holds a `KnownRuntimeEnvironment` for the callee, so a fully
connected set of n machines needs **n(n−1)** records and n(n−1) user actions. Three machines is six links;
four is twelve. The user's requirement, verbatim: _"If I pair to a host, I want it paired the other way too.
And pairing to a third machine then adds that machine to both machines in my current pair. Pairing a 4th pairs
the new machine to all 3 existing machines in the group."_
**Placement:** fork patch (`local(hosts)`). Depends on `host-graph.md`'s discovery half, because a joining
host learns the group's membership from it.

## The outcome, stated as the user does

Every machine in the group lists the same workspaces, counts the same hosts, and can run work on any other
member with `orca-np --environment <label>`. Losing any one member leaves every other pair intact, because
the topology is a mesh and not a hub. That last property is the whole reason for the other n(n−1)−n links.

Orca already renders a paired server's projects and workspaces (`PairedServerRowsProducer` → `worktree.ps`
per paired server; `fetchRepoCatalogForTarget` → `repo.list` per paired target), with agent activity and
actions. So the sidebar requirement is **not a rendering problem** — it is a pairing-topology problem, and
this note is what closes the topology.

## The decision that shapes everything: nobody mints on another's behalf

`pairing.createOffer` is `pairing-admin`, and that tier is owner-only by design
(`src/main/runtime/rpc/methods/pairing/pairing.ts:36`: _"paired clients and phones never hold
pairing-admin"_). Three designs were considered:

| Design                                                           | Why not                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introducer **mints** an offer for its peer                       | Needs `pairing-admin` on the peer. That turns every pairing into a grant to widen the peer's access — the escalation `host-graph.md` §4 refuses at 0.92.               |
| Introducer **vouches**, target registers the newcomer directly   | Host keys are X25519 and cannot sign, so the introducer cannot make a statement the target can check; and the target would register an endpoint it learned third-hand. |
| Each host **mints its own** offer; the introducer **carries** it | Chosen. The offer belongs to the host that will accept it, is sealed to the one machine allowed to redeem it, and the courier cannot open, alter or reuse it.          |

So the introducer is a courier for a box it cannot open. That is the only arrangement where adding n−1
pairings does not also hand one machine the power to act as another.

## The join

`n` user actions for `n` machines. Words below: **G** is the group, `epoch` a monotonic counter, and
`Seal(X→Y, m)` is `nacl.box` with X's static secret and Y's static public over the domain
`orca-mesh-offer/v1`. A static-static box gives confidentiality to Y **and** authenticity from X, which is
the strongest thing available without a signing key.

1. **The human pairing, and the tick that creates the obligation.** The user pastes A's access link on C and
   ticks _Join this server's group_, or A mints the link with _Invite to my group_ and C's user ticks join.
   Either way the tick is an owner action on **that owner's own host**, and it is the consent that matters.
2. **C → A `hostMesh.join`.** C sends its `hostPublicKeyB64`, its label, and `Seal(C→A, C's own offer)`. A
   opens it, redeems it through the ordinary pairing path, and now holds the A→C link. A replies with the
   member list — keys and labels only, no endpoints.
3. **C seals one offer per member.** For each member B, C mints its own offer and seals it to B. C hands A
   the batch.
4. **A → B `hostMesh.introduce`.** A forwards `{G, newcomer key, label, Seal(C→B, offer)}`. B checks that B
   is in G with introductions allowed, that A is a current member, that the box opens from C's key, and that
   the inner offer's `publicKeyB64` **equals** the newcomer key A declared — which is what stops A splicing
   in a different machine's offer. B dials C, redeems, and returns `Seal(B→C, B's own offer)`.
5. **A carries B's offer back to C.** C redeems it. The pair is now joined in both directions.
6. **`hostMesh.sync`.** Members, tombstones and each host's own link states, so every member renders the same
   matrix and a half-join is visible on every machine rather than only on the one that failed.

## Offer binding, and the risk it cannot remove

A relayed offer is a bearer token in transit through a third party, so it is bound four ways:

- **Sealed to `recipientHostKey`**, so the courier cannot open it and a different machine cannot use it.
- **The inner `publicKeyB64` must equal the key the introducer declared**, so the introducer cannot swap in a
  machine it controls.
- **Single-use**: the offer is minted as a ticket (`ticket: true`), and the recipient's first sign-in retires
  the token, so a replay fails rather than joining twice.
- **Ten minutes**, matching the planning offer window, with the envelope's own `expiresAt` checked before
  dialling.

**The residual risk, stated plainly:** an introducer can lie about _which_ machine it is introducing. It can
hand B a box from a machine it controls and call it C. No introducer-based scheme can prevent that, because B
has no independent anchor for C — the same reason `host-graph.md` § "What building it changed" says a second
hop cannot verify a signature. Consent, attribution (`introducedBy` on every member), a visible notification
on every host, and ejection are the bounds. They limit the damage; they do not prevent it.

## Consent

- **Default deny for a host in no group.** A plain pairing never creates a group; joining is a tick, and the
  tick is the standing grant "accept members introduced by current members".
- **Auto-accept is on for a joined host**, because asking a person to approve every introduction on every
  machine is the n(n−1) problem again in a different costume. The honest cost: one compromised member can add
  a machine it controls to every member. Bounds — attribution on the row, a notification on every host, any
  member can eject, `HOST_MESH_MAX_MEMBERS` is 12, and an introducer may forward at most
  `HOST_MESH_MAX_INTRODUCTIONS_PER_HOUR` per hour.
- **"Ask before adding members" is a per-host setting, default off.** A host that turns it on lands
  introductions as pending approvals in Settings.
- **Introduced links get the least authority that works**: `workspace`, never `desktop-control`, never
  `pairing-admin`. A new permission tier (`mesh-member`) is what the mesh methods check, and ordinary paired
  clients do not hold it.
- **Joining widens the network.** Minting a runtime offer can call `ensureNetworkExposure()`, and that
  widening does not reverse. The copy on the join tick says so; a loopback-only host is never widened
  silently by an introduction.

## Leaving, and why this half matters more

A mesh that cannot shrink is a liability, so removal is the failure-intolerant half:

1. The remover writes a tombstone `{hostKey, epoch, removedBy}` and cuts **both** directions locally: the
   device row first (which kills the inbound credential and fails bound sockets), then the environment (which
   stops this host calling out).
2. Tombstones are a **union** carried by every member in `hostMesh.sync`, and **removal wins forever** — a
   stale peer never resurrects a member, and a remover that is itself removed later does not restore what it
   removed. That is what the pure reducer pins (`host-mesh-membership.test.ts`).
3. **An offline member learns on its first sync after waking.** The exposure window is that gap, during which
   a removed member could still call it. The mitigation is to sync before serving mesh-tagged rows after
   wake.
4. **The link teardown keys on the peer index, not on fields of the pairing rows** — another build rewriting
   the device registry or `orca-environments.json` must not be able to strand a removal
   (`host-mesh-store.ts`).

## What is built, and what is not

Built, tested, inert:

| Piece                                          | Why it is shaped that way                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/host-mesh/host-mesh-contract.ts`   | capability `host.mesh.v1`, the sealed-offer and sync payloads, the bounds, and `hostMeshPairStatus` so a half-join is representable |
| `src/shared/host-mesh/host-mesh-membership.ts` | the group's rules as a pure reducer: union of members, union of tombstones, cap, removal-wins, link states                          |
| `src/main/host-mesh/host-mesh-sealed-offer.ts` | `nacl.box` static-static, domain-separated, refuses rather than throws on every untrusted-input path                                |
| `src/main/host-mesh/host-mesh-store.ts`        | the on-disk group and the peer index removal depends on                                                                             |

Not built: minting an offer with `grants: []` and `ticket: true` on the pairing layer; the device-row and
environment tags; the six `hostMesh.*` methods and the `mesh-member` permission tier; the introduction and
removal outboxes; the Settings surface; `orca group`.

## What cannot be validated without real machines

- **Two real Electron main processes** are needed for a real offer exchange, a real ticket redemption, and
  the network widening that accompanies them. Two profiles on one Mac can check the protocol only with
  loopback allowed, which `verifyPairingCode` refuses outside tests.
- **Three real machines — Studio, laptop, VM** — are needed for the transitive join itself, for endpoint
  reachability across LAN and Tailscale (the likeliest cause of a half-join), and for removal while one
  member is asleep.
- Everything in the "built" table above is validated by unit tests only.

So the honest merge order is: the inert layers land on unit evidence, and the pairing side lands behind an
experimental setting and is turned on only after a three-machine run.
