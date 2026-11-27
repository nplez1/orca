# Host mesh groups: one join, everyone paired

**Status:** design note, 2026-11-25; **the pairing side shipped in #466 on 2026-11-26**, and the first real
three-machine upgrade proved it insufficient — see § "What the first real upgrade proved wrong", which records the
reverse offer (`hostMesh.offerBack`), the one switch that replaced five, and the two things this note got wrong.
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
- **One switch, not five.** `HostMeshSettings` is `{ enabled }`; the per-rule booleans (`allowJoins`,
  `acceptIntroductions`, `relayIntroductions`, `autoAcceptIntroducedMembers`, and the reverse offer's own) were a
  protocol audit dressed as a setting. Off refuses joins, introductions, relays and reverse offers together, and
  stops the repair pass, which is the whole of what an owner can meaningfully decide here.
- **Introduced links get the least authority that works**: `workspace`, never `desktop-control`, never
  `pairing-admin`. Ordinary paired clients hold `workspace` and nothing more.
- **Joining widens the network.** Minting a runtime offer can call `ensureNetworkExposure()`, and that
  widening does not reverse. A loopback-only host is never widened silently by an introduction.

## What the first real upgrade proved wrong

A studio plus two work hosts, all upgraded at once, listed nothing on the two work hosts and showed both pairs
one-way on the studio, and "Sync now" could not change it. The local evidence was decisive:
`orca-environments.json` empty on a work host, one device row in `orca-devices.json`, and `host-mesh.json` with
`state: null` and `migration.peerCount: 0`. Three defects, in the order they bite:

1. **The upgrade could only see outbound pairings.** `listPairedHostKeys` reads `listEnvironments`, so a machine the
   studio dials — the fork's own topology — migrates nothing and records `peerCount: 0` forever.
2. **Every repair path was a call the holder of an environment makes.** `join`, `relayIntroductions`,
   `introduce` and `sync` are all issued by a host that can dial, so a host with nothing could neither dial a
   member nor be introduced by one, and adoption at the far end required an outbound environment it did not have.
   The one-way badge was truthful; nothing in the protocol could close it.
3. **The designed manual path was unreachable.** `hostMesh.join` needs a local environment, the renderer never
   called it, and `allowJoins` — which `decideJoin` requires — was not even in the IPC allowlist, so the one tick
   the note's § "The join" depends on could not be given.

**The fix, and why it is the smallest one that converges:** a machine that already holds a credential into a peer
hands that peer an offer of **its own**, sealed to it (`hostMesh.offerBack`). The peer opens the box with its own
key, redeems the offer — so the credential now exists in the direction that was missing — adopts the group, and
reports `outbound: ok` on its next sync, which is the evidence the other end needs for `inbound: active`. The
relay batches that follow are the ones already built, so a mesh of spokes completes without a new join path.

**The trust anchor, stated plainly:** the caller must hold a device row this host issued — it reached the method
over a token this host minted, so it already runs commands here. The box is self-certifying in the other
respects: it names a minter key and carries an ordinary pairing offer whose own key must hash to that name, so a
caller cannot present itself as a different machine, and only the recipient's key can open it. The residual risk
is the one this note already accepted for introductions: **a machine this host already trusts can add itself to
the group**, which is why attribution, a bounded member count and ejection remain the bounds rather than
authentication.

**Why nothing is minted twice:** an offer is a device row on the sender, so the driver remembers the attempt per
member per launch, retries at most every `HOST_MESH_REVERSE_OFFER_RETRY_MS`, and stops for the rest of the launch
after a refusal — a machine with the mesh off is not asked again ten times.

**What the settings pane became:** the group is a property of a host the owner already paired, so the pane no
longer repeats every host in a second list, offers no Sync button, and keeps one switch. Each host row carries its
mesh status and an Eject, and the section is the switch, the group's summary, a line saying when it last checked
itself, and Leave mesh. The only list left is for a member this computer cannot reach, which has no row to hang
anything on.

## Nothing is pushed: the mesh reconciles itself

The owner's requirement, verbatim: _"I shouldn't have the push sync on anything. Everything should happen
automatically!"_ So there is no Sync control in Settings and no periodic pass owned by a surface. `host-mesh-auto-sync.ts`
schedules one reconcile in the main process:

- **Event first.** A pass ~10s after launch, on every connection-change observation (`notifyHostGraphOfConnectionChange`),
  when the switch is turned on, and when a peer pairs this host (`requestOwnSync` from `hostMesh.offerBack`). Those
  nudges collapse into one pass 1.5s later, so three connections coming up cost one pass.
- **Then a slow reconcile.** One pass a minute while the fleet answers, doubling to a 15-minute ceiling while it does
  not. Why a self-scheduling `setTimeout` and not `setInterval`: a fixed cadence is what the recurring-timer ratchet
  exists to refuse — it asks at full rate whether or not anything moved — and a laptop that closed its lid must make
  this quieter, not louder. The handle is unref'd, so a background reconcile never keeps the app alive. Why the
  driver has to report `lastPassReached`: every member failure is caught per member, so a pass against a sleeping
  fleet returns happily, and a backoff keyed on a thrown error would never engage.
- **One pass at a time, and one writer at a time.** The driver holds a single in-flight promise, so a peer-triggered
  pass and the scheduled one cannot overlap; and every local writer — the pass, `join`, an Eject, a leave, and each
  inbound RPC — takes one lock over `host-mesh.json` (`host-mesh-write-lock.ts`). A narrower lock around only the
  write would let two paths derive a mutation from the same read and lose one of them; the cost of the wide lock is
  that an inbound call may wait behind a pass and retry at its caller, which loses nothing. The one exception is the
  two methods that read and reply with no await in between (`sync`, `pending`): locking those is what would deadlock
  two hosts, each pass holding its own lock and waiting on the other's read.
- **A credential nothing redeems is revoked.** Every offer is a fresh device row with an `offerTtlMs`, and a refusal
  or an unknown method revokes the row it just minted; a dropped connection does not, because the box may have arrived
  and be redeeming. Otherwise a peer with the mesh switched off would accumulate a never-expiring token per retry.
- **A reconnect resets the retry window.** `noteConnectionChange` clears the attempts that failed for technical
  reasons, so a machine that finishes updating between passes is offered again within seconds rather than waiting out
  the ten-minute interval. A refusal on the merits is left alone: a connection coming up does not change a machine's
  mind about consent.
- **A pane only reads.** The settings surface re-reads the local snapshot on the shared 15s clock and after each
  action, publishes it to the shared store every row reads, and shows `lastSyncedAt`, so an open pane follows the
  passes rather than showing what it mounted with. Nothing in the renderer can start a pass: `hostMesh:sync` and
  `window.api.hostMesh.sync` were deleted with the button. `orca group sync` stays as a script's one-shot (it is not a
  control a person is asked to press).

`migrateFromPairings` deliberately still runs once and unrecorded when mesh mode is off, so an owner who turns the
mesh on later still upgrades the fleet that was already paired.

## Finding a member after it moves

A pairing row holds exactly one endpoint — the address the pair was made on — and nothing in it can be updated by
a machine that changed networks. A tailnet switched off is the everyday version: the studio keeps dialing an
address that no longer answers, the pair reads half-joined, and every other feature that resolves that row
(host-sync, the host graph, any paired client) fails with it.

Two stale-credential facts go with it, because both made the panel lie about the fleet:

- **An offer nobody redeemed before its own TTL is not an active link.** It cannot pair anything, and the mesh mints
  one per failed reverse offer, so counting them turned a one-way pair into "77 active links" in Settings. A live
  unredeemed offer still counts, because it is revocable and still scannable — the filter is in
  `isExpiredPairingOffer`, and `mobile.ts`'s grant list only calls it.
- **A pass revokes the expired offers that mesh minted**, rather than leaving them for the count to filter
  forever. "That mesh minted" is the peer index, not the whole device table: an offer the owner minted by hand
  expires on the same TTL and is theirs to clear.

So a member publishes where it is, and the pass acts on it:

- **Both directions of every sync carry the sender's own endpoints**, best first — LAN before tailnet, because the
  directly-attached path is the one that works without an overlay being up. The field is optional, so a peer on an
  older build keeps syncing and the receiver keeps the routes it had. The receiver records what a request carried
  (only from a member), which is what makes the one-way case repairable: the machine that can dial _here_ publishes
  its addresses on the call it makes, and the pass that cannot dial it back has them anyway.
- **Routes are remembered per member, merged rather than replaced**, capped at four, with one slot spent on the
  best address held before — a machine that reports a full set would otherwise erase the only address a failed dial
  can fall back on. On the publishing side one slot is likewise reserved for a tailnet address, because four bridge
  or docker adapters would otherwise consume the cap with addresses no other machine can reach. A host that lost
  its tailnet address therefore reports only the LAN one, and the address it held before stays.
- **A failed dial is retried on those routes before the member is called unreachable.** Each candidate must answer
  a `status.get` with the pairing's _own_ credential — an address that answers without it is some other machine —
  and the one that does is adopted: the pairing row's endpoint is rewritten, and the connections pooled for that
  environment are dropped. The rewrite keeps the credential and `pairingRevision`, because a re-pairing would read
  to worker stop/observe and the automation owner keys as a different machine. That is why this stays a mesh-only
  change: everything that resolves the row per call (host-sync, the host graph, a paired client) picks the repair
  up on its next dial instead of each feature learning about routes.
- **An offer carries the same set.** The sealed payload already had `endpointCandidates`; it is now filled, so a
  freshly paired host knows the other machine's addresses before it has ever synced.

What this does not do: a host in no mesh group has no pass to repair it, so it keeps the single stale endpoint. An
SSH-tunnel pairing is never repaired — its endpoint is a local port the tunnel owns, so rewriting it would point the
row at an address nothing serves — and neither is a row carrying an access link or a managed deployment, whose own
schema pins the address it prefers. Learning needs one direction to still work: a pair dead at both ends, or one
whose local addresses all changed at once, still needs a re-pair.

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

Built and tested: the wire contract, the membership reducer, the admission rules (one ordered function, so
what an introducer can talk us into is auditable), the sealed-offer envelope, the store with the peer index,
the driver, the peer-facing and owner-facing RPC methods, the IPC/preload/renderer surface, `orca group`, and
the startup wiring that makes any of it reachable.

Proven by a three-host simulation through a fake transport, with the real reducer, the real admission rules
and real sealed boxes: a join reaches every pair; the fleet a host renders is identical on every host; a
refused introduction shows as a gap instead of a false pairing; a stalled pair repairs on the next sync;
removal cuts both directions and a tombstone refuses re-introduction. 81 unit tests.

**Not verified, and not verifiable on one machine:** endpoint reachability across LAN and Tailscale — the
likeliest cause of a half-join — and removal while a member is asleep. The route failover above is the answer to
the first, and it is proved only against a fake transport: a real Studio-plus-laptop run with Tailscale toggled
mid-day is what would show it working on two networks. `verifyPairingCode` refuses loopback outside tests, so a
real offer exchange needs two real Electron main processes. Until that run happens, a group is proven on one
network and unproven across two.

## Upstream sync surface

This feature is 10k lines, and 107 of them are allowed in files upstream owns, across 22 declared seams. That ratio is
deliberate and it is checked: `node local/checks/host-mesh-upstream-seams.mjs` (wired into `local/gate-lint.mjs`) fails
when a declared seam grows past its budget, and reports an upstream file it does not declare as a note — `--strict`
is for this feature's own branches, where that note is the sprawl the check was built to catch. Budgets are per diff,
not cumulative: the 22 are the register's ceiling for any one branch, and the busiest (this one, at 11 lines across
four files) is far below it.

| Upstream file                                                        | Lines | What it is                                                          | If a sync conflicts                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status-bar/host-connections/SshStatusSegment.tsx`                   | 21    | the relayed-fleet menu block                                        | keep our call site, the hook destructure, and the two counts (`relayed` in the early return, `relayed` in `connectedHostCount`); the JSX lives in `RelayedFleetStatusItems.tsx`      |
| `settings/.../server-rows/runtime-server-row.tsx`                    | 3     | one import, `<MeshMemberAffordance />`, and the `meshItems` slot    | keep all three; the chip, both actions and both dialogs are fork-owned, so a host row carries its mesh state and its Eject instead of the pane repeating every host in a second list |
| `settings/.../server-rows/runtime-server-row-menu.tsx`               | 3     | the optional `meshItems` slot in the row's menu                     | keep; it is a prop on the component that owns the menu, and what it renders is fork-owned                                                                                            |
| `settings/host-rows/ServerListRow.tsx`                               | 2     | `py-px`/`leading-4` off the shared chip                             | keep; without it a Mesh, Default or SSH-tunnel chip sits taller than the row's name beside it                                                                                        |
| `main/ipc/mobile.ts`                                                 | 3     | one import and one predicate in the runtime-grant list              | keep both; the predicate is `host-mesh-runtime-grants.ts`, and an offer past its TTL is not a link                                                                                   |
| `cli/hosts/host-handler-groups.ts`                                   | 6     | one import and `HOST_MESH_HANDLER_GROUP`                            | keep both; the entry itself is in `host-mesh-handler-group.ts`                                                                                                                       |
| `startup/runtime-startup/main-process-runtime-launch.ts`             | 3     | import, `installHostMeshRuntime(runtimeRpc)`, `max-lines` directive | keep all three; the directive is only there because upstream's file sits exactly at the 300-line cap                                                                                 |
| `settings/.../RuntimeEnvironmentsPane.tsx`                           | 3     | one import and `<HostGroupSection />`                               | keep both                                                                                                                                                                            |
| `runtime/rpc/methods/rpc-method-registry.ts`                         | 2     | `FORK_RPC_METHODS` import and spread                                | keep both                                                                                                                                                                            |
| `shared/remote-runtime/protocol/protocol-version.ts`                 | 2     | the runtime capability entry                                        | keep; it is how peers negotiate the fleet                                                                                                                                            |
| `runtime-environments/runtime-environment-connection-observation.ts` | 2     | one call to `notifyHostGraphOfConnectionChange`                     | keep                                                                                                                                                                                 |
| `cli/specs/index.ts`                                                 | 2     | `HOST_MESH_COMMAND_SPECS` import and spread                         | keep                                                                                                                                                                                 |
| `cli/dispatch/remote-selection-scope.ts`                             | 1     | `commandPath[0] === 'group'`                                        | keep                                                                                                                                                                                 |

Rules this follows, each learned the expensive way:

- **No comments in upstream files.** `local/check-upstream-file-comments.mjs` forbids them on measured
  evidence (162 of the 233 conflicts in the 2026-10-28 sync came from fork comments above upstream code). The
  register therefore lives here and in `LOCAL-PATCHES.md`, where nothing upstream can collide with it.
- **A seam is one line, and the line calls a fork-owned module.** `installHostMeshRuntime`,
  `FORK_RPC_METHODS`, `HOST_MESH_HANDLER_GROUP`, `notifyHostGraphOfConnectionChange`, `RelayedFleetStatusItems`
  and `hostMeshGroupIdFor`'s neighbours all exist so the upstream side is a call, not an implementation.
- **Deliberately deleted, not moved:** the mesh service is a configured singleton, so threading it through
  `RpcContext` would have touched four more upstream files (`core`, the admission prologue, the mobile pairing
  subclass, the stream options) to copy a constant. The handler resolves it itself, and those four files are
  untouched.
- **Fork extension points are used as they are.** IPC registration goes through `register-fork-handlers.ts`,
  the preload bridge through `fork-preload-api.ts`, strings through `i18n/fork/en.json`. A sync never has to
  reconcile those.

Verification for a sync: `node local/checks/host-mesh-upstream-seams.mjs` (every declared seam still within
budget) and `node local/check-upstream-file-comments.mjs` (the fork-comment baseline re-measured) both green,
then `pnpm test src/main/host-mesh src/shared/host-mesh`. This feature's own branches are judged strictly without
a flag — a diff touching a fork-owned `host-mesh`/`host-graph`/`host-group` path must declare every upstream file
it touches. A sync never derives that, because its diff is upstream's own work, so `--strict` is how a sync or a
seam-only change is judged by the same rule.
