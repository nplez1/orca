# A host graph: one machine, many paths

**Status:** design note, 2026-11-22. **Stage 2 (discovery) built 2026-11-25** on `nplez1/host-graph-discovery`
— see § "What building it changed" for the three places this note was wrong before the code was written, and
`LOCAL-PATCHES.md` § `local(hosts)` for what shipped and its anchors. Stages 1, 3 and 4 are not built.
Supersedes the accepted limits in `bot-host-topology.md` § "Accepted limit 1" if stage 1 lands; that note
stays correct until it does.
**Why:** today a host is a _record in one install_, not a machine. So the same box reached two ways is two
hosts, two projects, two settings scopes, and only the install that holds the record can update or configure
it. The topology note accepted that. This one refuses it: hosts should know each other, a machine should have
one identity however many paths reach it, and a client should be able to name the shortest one.
**Placement:** fork patch (`local(hosts)`). Stage 1 is additive — a `machineKey` field and a merge in the row
plan, no schema migration. Only stages 3–4 need `ExecutionHostId` itself to name a machine, and that is the
long tail: it is in row identity, settings scope, sidebar facts, worktree ids and tombstones.

## Four capabilities, not one

"All hosts know each other" bundles four things that can land separately, and only the last is really the
graph. Building them as one piece is how this becomes a two-year project.

| #   | Capability                                                                    | Today                                      | Delivers                                                         |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| 1   | **Canonical identity** — one machine has one id, whatever record points at it | per-record ids                             | de-duplication, correct labels, one settings scope per machine   |
| 2   | **Discovery** — know which machines exist and which edges join them           | one hop, from the client's own pairings    | seeing a host the client cannot reach itself                     |
| 3   | **Routing** — reach a machine through another one                             | manual, per-host pairing                   | settings, updates and rollback for hosts you are not paired with |
| 4   | **Shortest path** — pick the cheapest available route                         | `preferredEndpointId`, a stored preference | latency and fewer hops; **not** new capability                   |

Read that column carefully: the visible pain is in 1 (two rows for one machine) and 3 (no settings or updates
for a host you are not paired with). Shortest path is an optimisation and carries the most risk per unit of
benefit — and capability 1 does **not** require the id migration, which is the single most expensive piece
here.

## The model: one machine, many providers

The user-visible requirement, stated as one sentence: _a machine is one host, once, with one list of
worktrees — and the client picks the right connection for each thing it does, without being asked._

That decomposes cleanly, and only the first half is identity work:

- **A machine** is identified by a key it holds — the SSH host key fingerprint (§1). One machine, one row,
  everywhere: host picker, settings scope, project list.
- **A provider** is a way to reach that machine, owned by one runtime: your direct `ssh:` target, the Studio's
  `runtime:` environment with its nested target, and later a relay. Providers are _not_ hosts and never appear
  as separate rows.
- **Truth about what exists on the machine comes from the disk, not from either store.** Orca already reads
  it that way, per host: `git worktree list --porcelain`, parsed in `parseWorktreeList`
  (`src/main/git/worktrees/catalog/worktree-list-reader.ts:16`, host-routed by `GitWorktreeExecOptions`). A
  store's registration is a claim about _ownership and state_, not about existence.
- **An owner** is the runtime that created a worktree and holds its state: you, or a bot on the Studio. Owner
  is displayed on the row and decides where stateful work goes.

So the merged list is: every worktree on that machine, as reported by the cheapest live provider, each row
carrying the owner that actually holds it. Two owners of one repo on one disk stop being two projects and
become one project with two kinds of row.

### Routing: small, explicit, and not a heuristic

The "smart" part is a decision table, and it should be written down rather than inferred:

| Operation                                         | Provider used                                                       | Why                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| your files, git, terminal — on a worktree you own | your direct provider                                                | shortest path; you are the actor                                |
| the same on a bot-owned worktree                  | the bot's provider (the Studio)                                     | the work row, agent session and pty live there                  |
| new work you start on that machine                | primary provider for the machine — direct if it is up, else a relay | your work should not depend on the Studio being awake           |
| new work a bot starts                             | the bot host's provider                                             | bots live on one host by design (`bot-host-topology.md`)        |
| destructive actions — delete, move, prune         | **the owner's provider, never a guess**                             | the other owner would just re-adopt the leftover                |
| settings, updates, rollback, repair               | the owner of that host                                              | stage 3, until routing lands                                    |
| viewing a _bot's live terminal_                   | the Studio                                                          | **the pty is owned by the Studio; the stream must traverse it** |

That last row is the one place the "always use the most direct connection" rule cannot hold, and it is worth
being blunt about: a stream is not a file read. A pty created by the Studio's agent session can only be
streamed by the runtime that owns it — the alternative is attaching a second client to the same pty, which
duplicates keystrokes and loses the session identity. What _can_ be direct is everything you do: your own
terminals, files and git on that machine never touch the Studio.

Failover follows the same table, with one rule: only **stateless** operations may fall back to another
provider. Creating a worktree, deleting one, or resuming a session must go to its owner or fail loudly —
silently doing it through another provider produces a workspace its owner cannot see.

### The hard part is drift, not presentation

- **Two stores, one disk.** A worktree the Studio created is _unregistered_ from your store's point of view,
  which Orca already models as an external worktree with an adopt affordance
  (`importedWorktreesByRepo`, `NewExternalWorktreesInboxCandidate` in `sidebar-row-plan.ts:82-83`). The rule
  must be: **a worktree's identity is its path; registration is a per-owner attribute.** The merged view
  de-duplicates by `(machineKey, repoPath, worktreePath)`, and adopting a row registers it in the adopting
  owner only — never both.
- **Busy-branch checks are per host today** — _"Busy branches are checked by the host."_
  (`src/shared/new-workspace/composer-branch-selection.ts:68`). With two owners on one repo that check can be
  satisfied twice and create the same branch in two worktrees. The merged view has to compute busy branches
  from the **disk union**, not from one store's list.
- **Deletion leaves leftovers.** `worktree-removal-leftover.ts` exists because a half-removed worktree gets
  re-discovered; routing deletion to the owner (above) is what keeps the merged list stable.

### The minimum code that delivers it

1. **`machineKey?` on each host entry** in `sidebarInputs.desktopFacts` — additive, from the SSH host key
   fingerprint both sides already record. No new RPC, no new key material.
2. **Provider grouping in the host registry** (`buildExecutionHostRegistry` / `pickerExecutionHosts`): one
   machine entry with its providers attached, instead of one entry per record.
3. **Merged project sections** in `planSidebarRows`: key by `(machineKey, repoId)` instead of per host;
   worktree rows keyed by path, with an owner badge only where more than one owner is present.
4. **A worktree union read per machine** — the existing `git worktree list --porcelain` call through the
   cheapest live provider — used to complete the list with rows the reading store does not own.
5. **One resolver, `resolveOperationProvider(machine, owner, operation)`**, implementing the table above. Every
   terminal, file, git and destructive path asks it. This is the whole of the "smart" behaviour, and it is
   ~one function plus call sites.

Nothing about ids, stores, credentials or ownership changes underneath. `ExecutionHostId` stays as it is;
`machineKey` is an additional field, so this lands without the migration that makes stage 1 expensive.

## 1. Canonical machine identity

## 1. Canonical machine identity

### Why record ids cannot be it

```ts
export type ExecutionHostId = 'local' | `ssh:${string}` | `runtime:${string}`
```

`src/shared/execution-host/execution-host.ts:7`

A row's identity is `JSON.stringify([hostId\0repoId, connectionId])` (`repo-host-identity.ts:18-20`). `ssh:`
ids name an SSH _target record_ and `runtime:` ids name an _environment record_; both are per-install files.
`'local'` is the literal string `'local'` on every machine. Nothing in that id space can prove two rows are
one box, which is exactly why twins are kept rather than merged — _"a paired server's twins share its
`runtime:` host and differ by nested SSH target"_.

**A route fingerprint cannot be it either.** `fingerprintRuntimeSshTarget` hashes
host/port/username/configHost/jumpHost/proxy (`runtime-ssh-target-fingerprint.ts:3`) — but also `identityFile`
and `identityAgent`, which differ per client by construction. A route fingerprint _distinguishes_ paths; the
whole point here is collapsing them.

### What can be: a key the machine holds

Two machine-held keys already exist, and one of them is universal:

- **SSH host key** — every host reachable over SSH has one, and Orca already records it per host and port
  with its fingerprint: `ssh-host-keys.json`, `{ host, port, keyType, key, fingerprint, acceptedAt }`
  (`src/main/ssh/host-keys/ssh-host-key-store.ts:17-24`). It is machine-owned, comparable across installs,
  and survives Orca being reinstalled.
- **Orca pairing public key** (`hostPublicKeyB64`, E2EE) for hosts that run orcad — the identity
  `peerFingerprint` already compares on resolve, refusing with _"now identifies a different Orca server"_.

So: `machine:<ssh host-key fingerprint>` is the canonical id, with the pairing key as a second handle on the
same machine and a recorded mapping between them (a paired server's SSH host key is known too, which is what
links them). No new key material, no new registration step.

### Two ways to land it, and only one is expensive

- **Additive `machineKey`** — a field on each host entry, used to group presentation. No id changes, no
  migration, no effect on what any store means. This is what stage 1 needs, and it is enough for one host
  picker row, one project section and one worktree list per machine.
- **`ExecutionHostId` naming the machine** — needed once the machine itself must be _addressed_: a route
  selected per machine, a settings write aimed at a machine rather than a record, a relay grant naming one.
  That is stages 3–4, and it is where the migration cost lives.

The rest of this section describes the second form, because it is the end state; stage 1 should not wait for
it.

### What the second form changes

- `ExecutionHostId` gains a machine form; `ssh:` and `runtime:` become **edges and views** over a machine
  rather than hosts in their own right.
- Row identity drops `connectionId` for `[machineId, repoId]` (+ path), so two paths to one repo collapse to
  one row; per-path facts (which install owns it, credentials, latency) move into the edge, not the row.
- `getRepoRegistrationHostIds` already models same-id twins across hosts
  (`src/shared/repository/repo-host-identity.ts:24-28`) — that set becomes the alias set to collapse.
- Migration is the hard part: dual-write, an alias table for existing `ssh:`/`runtime:` ids, and tombstones
  (`RemovedSshTargetTombstone`, `SshRepoReadoption`) mapping onto machine ids so history survives.

Stage 1 alone removes the duplicate-row problem and makes host labels honest, with no graph and no new
network surface.

## 2. Discovery

### The mechanism that exists

Cross-host RPC is real: `callOrchestrationWorkerServer(selector, method, params)`, used by bots, mail,
workers and preflight, with versioned capabilities (`'orchestration.federation.v1'`,
`'host.settings.replicate.v1'`) and per-host attribution (`authenticatedCallerFingerprint`,
`orchestration-peer-caller.ts:37`). But the _fleet snapshot_ runs **in the client**, one hop:
`FLEET_HOST_CONCURRENCY = 4`, 3 s per host, 5 s total, with `host_unavailable` / `peer_changed` /
`capability_unsupported` as the failure vocabulary (`federated-fleet-snapshot.ts:14-18`).

**A host does not expose its own peers.** That single missing call is what makes the world one hop deep.

### What to add

One capability, one method:

```
hostGraph.adjacency → {
  machine: <this host's canonical id + both keys>,
  edges: [{ machine, kind: 'ssh' | 'pairing', endpoint?, capabilities, signature }],
  revision
}
```

Rules that keep it cheap and safe:

- **A host reports only edges it owns.** Its own SSH targets and its own pairings. A claim about a machine it
  cannot reach is not an edge.
- **Signed by the reporting machine**, so composition is attributable — the same reason `peerFingerprint` is
  compared rather than trusted.
- **The client composes the graph transitively** from the answers, with a hop cap (start at 2), bounded
  fan-out, and a cached revision. Live composition, not persisted gossip: no new replication channel, no
  split-brain, and staleness is bounded by the read timeout that already exists.

The judge preferred persisted gossip with revisions (0.57 vs 0.30 for live query, both low-confidence) and I
would not start there: gossip is durable state that has to be signed, versioned, expired and reconciled. Live
signed adjacency gets the same _knowledge_ with none of that state — and it can become gossip later, because
the same adjacency payload is what gossip would carry.

## 3. Routing

Reaching B through A is not a new protocol: it is the existing peer call, nested. A asks `B` on the client's
behalf and returns the answer, and the client never holds B's credentials.

- **Cost**: measured RTT per edge (EWMA, piggybacked on real calls plus an occasional probe), one hop
  penalty per relay, an availability term, and a **capability penalty** — a call needing `fleet-snapshot.v1`
  cannot route through a host that lacks it, so the route must be chosen per call, not per host.
- **Availability is per edge, not per machine.** A sleeping laptop takes its edges down; the target is not
  down. This is the failure the topology note was built around, and the graph should encode it.
- **Selection** with hysteresis: prefer direct, then fewest hops, then lowest measured RTT, and hold a route
  until it fails or is materially beaten — flapping between two roughly-equal paths is worse than one extra
  millisecond.
- **Loop and depth**: a hop cap and a path fingerprint in the envelope, so a cycle is rejected rather than
  walked.

This is also the answer to the admin limitation, and it arrives with stage 3 — **not** with shortest path.
Settings (`settings.update` routed to `{kind: 'environment'}`), updates (`environment update`), rollback and
repair all become routable once a relay exists and is authorized, because they are ordinary RPCs.

## 4. Authorization — the part that decides whether this is safe

A relay uses **the relay host's credentials**: its SSH keys, its tunnels, its orcad fence. So "the laptop may
route through the Studio" means "the laptop may act with the Studio's reach". That is borrowed identity, the
exact doctrine the rest of this design series refused — a bot acting as its owner is tolerated on GitHub only
because no second identity exists, and it is why the marker and the trailer exist.

The judge was decisive here (0.92):

> **end-to-end caller fingerprint carried through the relay, with the target host enforcing its own policy
> per authenticated caller**

Concretely:

- the original caller's `authenticatedCallerFingerprint` travels **inside** the relayed envelope and is the
  identity the target authorizes, so a relay can neither forge nor widen it;
- the target host holds **per-caller policy** — which machines may reach it, and through which relays — with
  per-edge grants as the storage (judge 0.08 for grants-on-the-relay alone, because a relay's opinion of its
  own trustworthiness is not the thing to trust);
- **default deny** for a new pairing. Reaching a host through another is granted deliberately, one edge at a
  time, revocable on the target;
- every relayed call **records its route and its original caller**, because a graph that lets one machine
  exercise another's reach is a lateral-movement surface and must be auditable afterwards.

Without this layer the graph is a privilege-escalation feature with a nice UI. With it, it is the same
per-actor identity model the bots already use, applied one level down.

## What it costs

- **A new server capability on every host.** Version skew turns into a routing property: a path through an
  older host silently loses features unless the cost function penalises it. Two or three app versions of
  tail.
- **`ExecutionHostId` touches everything.** It is in row identity, settings scope, sidebar facts, the
  composer's busy-branch check, worktree ids, project registration and tombstones. This is the real size of
  the project — not the graph.
- **The desktop routes through one active runtime today** (`activeRuntimeEnvironmentId`). Per-call target
  selection — the thing that makes a graph useful — is a renderer change broader than the graph itself.
- **Fan-out is bounded for a reason.** The existing 4-wide / 3 s / 5 s budget is what keeps a fleet read from
  becoming a stall. A graph read has to inherit that discipline, not replace it.
- **Lateral movement.** Every relay edge is a path an attacker on any host can try to use. Default deny,
  end-to-end caller identity and an audit record are the mitigation, and they are not optional.

## Staged plan

| Stage | Work                                                                                                                | Unblocks                                                                                                      | Risk                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1     | `machineKey` + provider grouping + merged project sections + disk-truth worktree union + `resolveOperationProvider` | **one host, one project, one worktree list per machine**; owner badges; direct connection for your own work   | drift between two stores over one disk                |
| 2     | Failover for stateless operations; capability-aware provider choice                                                 | your work does not depend on the bot host being awake                                                         | a fallback that silently changes who owns a workspace |
| 3     | `hostGraph.adjacency` + relayed RPC with end-to-end caller fingerprint and per-caller policy, default deny          | **settings, updates, rollback, repair for any host, from any client** — the whole admin limitation disappears | authorization bugs are privilege bugs                 |
| 4     | `ExecutionHostId` names the machine; measured cost, hysteresis, capability penalties                                | addressing by machine; latency and hop count                                                                  | the id migration's long tail                          |

Stage 1 is the one the complaint actually asks for, and it needs no relay, no migration and no new trust: it
is a field, a grouping and one routing function. Stage 3 is what makes the Studio's admin reach available to
every client. Stage 4 is last on purpose.

## Open questions

1. **A machine with several SSH host keys** (rotated, or IPv4/IPv6 entries). The identity needs a set of
   accepted keys and a rule for rotation that is not "re-register the host".
2. **A host that moves** — new hostname, same machine (the `SshRepoTombstone` / route-fingerprint machinery
   already chases this). Which wins, the key or the route?
3. **Does an edge grant follow a re-pairing?** `peer_changed` means the environment id is new but the machine
   probably is not; default deny says the grant must be re-stated, and that may be too strict in practice.
4. **Where does the composed graph live** — renderer memory, main's store, or both? It has to survive a
   window reload without a full re-read.
5. **Does the bot host inherit routes**, or must a bot's own host hold its own edges? Round 1 of this design
   series said the bot host's reach is its own; a graph weakens that, and the marker/mode logic may need to
   say which machine actually acted.

## What building it changed

Stage 2 was built from this note, and three of its instructions were wrong. They are recorded here rather
than quietly fixed, because each is a trap the next stage will fall into again.

**A pull-only read cannot deliver the count.** The note has the client compose the graph from its own
questions, one hop deep. In the topology `bot-host-topology.md` fixes — laptop and phone paired with the
Studio, the Studio paired with the VM and the Windows box — a **leaf has no outbound pairings at all**. It
can call nobody, so a pull-only design would leave the laptop showing zero hosts forever while the Studio
showed three. Information has to travel down the pairing as well as up. The method is therefore one
symmetric `hostGraph.exchange`: the caller sends its own adjacency, and the callee answers with its own
plus the reports its callers have left with it. Hearsay is labelled as hearsay and is never re-nested, which
is what keeps the payload's depth bounded without a per-hop decrement that would be easy to get wrong.
Practically this makes a fleet of diameter three converge within one or two refresh periods, so the hop cap
survives as a guard on a report's `depth` rather than as a live filter.

**The signature is not achievable, and would not prove anything if it were.** The note asks for edges
"signed by the reporting machine". Host keys here are X25519 (`host-challenge-envelope.ts` says outright
that they cannot sign), and the Ed25519 keys this tree does hold are per-client credentials rather than host
identity. A second hop could not check the claim in any case: it only learns C's key _from_ B, so it has no
independent anchor. Attribution therefore comes from the transport — the direct hop is E2EE-authenticated
and the callee knows `authenticatedCallerFingerprint` — and every relayed fact is attributed to the reporter
it came from. If stage 3 needs a signature for a relayed call, that is payload v2 with its own reasoning.

**`machineKey` was already taken.** It means `sha256(os:machine-id)[:16]` in
`src/main/orca-profiles/../managed-server/host-state/orcad-machine-name-home.ts:25`. The identity field is
`orcaHostKey` (the digest `publicRuntimeEnvironmentWithHostKey` already publishes, so a peer's pairing record
and the machine's own answer agree byte for byte) with `sshHostKeys` beside it as the only key a non-orcad
host has.

One placement correction, and it is minor: the fleet snapshot does not run in the renderer as the note says,
it runs in main (`federated-fleet-snapshot.ts`). So the composer is in `src/shared/host-graph/` — pure, and
tested without a socket — and the driver that fans out is in `src/main/host-graph/`.

What the note got right and the code keeps: no endpoints on the wire, `ephemeral-vm` excluded, edges only
for machines the reporter actually holds a key for, and the identity rules that let an `orcaHostKey` match
trusted while an SSH-key match may only complete an SSH-only entry.
