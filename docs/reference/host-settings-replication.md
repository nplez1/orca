# Host settings replication

One machine (the **main**) owns provider credentials and a set of settings; its paired hosts receive
them. This note records the wire contract, how each field is disposed of, and — the reason it exists —
what the "pin" does and does not protect. The implementation is
[`src/main/host-sync/`](../../src/main/host-sync/) with the wire types in
[`src/shared/host-settings-replication.ts`](../../src/shared/host-settings-replication.ts).

## Shape

- The main sends **deltas** (`baseRevision` names the revision it expects the host to hold) and
  **snapshots** (`baseRevision: null`, authoritative over the set replication owns).
- A host records `revision`, `syncedAt`, the credential ids it holds on replication's behalf, and the
  identity of the machine that pinned it (`mainFingerprint`, `mainDeviceId`).
- A host that cannot follow the delta asks for a snapshot rather than guessing.

## What a host will and will not delete

A removal deletes only ids in the host's own _replicated_ record — or, when this host has no record at
all, any id the main names for removal (below). A credential the user entered on this host is not in
that record, so replication never removes it: the removal is reported `keptHostValue` and the value
stands. A removal naming an id the host holds nothing under is reported `removed` — the store answering
with nothing is the proof — so a stale record on the main cannot make a clean host look partially
synced. Two exclusions exist so a transient local fault cannot look like a deliberate removal:

- `unreadable` credentials (a locked keyring) are never treated as absent;
- a snapshot's stranded sweep skips them for the same reason.

An id the main cannot read is carried against a host only when that host already held it as a replica.
Recording an unreadable id the host never received would claim a credential the user supplied on the
host, and the next removal would then delete it. The narrow cost: a replica that was unreadable when
the main started and was then revoked before that host reconnected stays on the host until its next
reconnect, whose snapshot sweeps it from the host's own record.

A host that has lost its own record is the mirror case, resolved the other way. Nothing on it can be
shown to be replication's, and a removal names an id the main once put here, so the main's removal list
is the only evidence left — skipping it would leave a credential the user revoked on this host for good.
Two exposures remain, both requiring a second fault: a main still on a build that carried every
unreadable id, naming an id the host entered itself (upgrading the main closes it); and a record lost
while the main's keyring was locked, where the snapshot that arrives names the credential `unreadable`
rather than absent, so nothing is removed and the revision it stamps makes the record look known from
then on.

Whatever deletes credentials on a host must go through the same gate. `revokeReplicatedCredential`
(which has no transport yet) must not delete an id the host reported as its own, or the ledger's
willingness to list too much would turn into deleting the user's key.

## What the pin does

The first snapshot pins the host to that caller's fingerprint and device id. While the pin is verifiable
— the caller's fingerprint matches **and** the pairing row it names still exists — the host refuses:

- any delta from a different caller (`refusedNotTheMain`);
- any snapshot from a different caller (`refusedNotTheMain`).

That is what stops a second paired desktop from _accidentally_ becoming the writer: it holds the same
`accounts-admin` capability, so two writers would otherwise take turns deleting each other's
credentials. The escape hatch is explicit and visible: remove the stale pairing row on this host, and
the next snapshot re-pins.

## What the pin does not do

**The pin is not a trust boundary.** A caller that is refused can send a snapshot instead. An
unverifiable pin — no pairing row, or a record written by a build that predates device ids — admits
that snapshot, which clears every credential replication owns and stamps the caller as the new main.

That is by design, not an oversight, because nothing at this layer can be the boundary: pairing already
implies command execution on this host, so a paired desktop that wanted to take the credentials could
take them directly. The pin is a guard against a confusing second writer, and the code is written to say
so rather than to imply a guarantee it cannot keep. A real boundary would have to be local confirmation
before the pin moves — see the credential-replication epic (H2).

## Field disposition

| Field                             | Disposition                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider credentials              | replicated for the keys a host-settings port carries; only ids in the host's replicated record may be removed, or any id the main names when that record is lost                                                                                                      |
| provider credentials with no port | **not** replicated — the MiniMax session cookie, the Fireworks key-plus-account envelope, and the Copilot token-plus-enterprise envelope; each needs its own adapter, and each is recorded as `local-only` in `src/shared/usage-providers/usage-provider-manifest.ts` |
| `unreadable` credential ids       | reported by the main, never deleted here                                                                                                                                                                                                                              |
| settings / UI state               | not replicated by this path                                                                                                                                                                                                                                           |
| revision, `syncedAt`              | host-local ledger, written after an applied payload                                                                                                                                                                                                                   |

**Which provider keys travel is a list, not a guess.** The five ports in
`src/main/host-sync/host-settings-api-key-ports.ts` are claimed one-for-one by an entry in
`src/shared/usage-providers/usage-provider-manifest.ts`, and `usage-provider-credential-census.test.ts`
fails when a provider store exists that no entry claims — so a provider added upstream cannot be
silently un-replicated. Read the manifest, not this table, for the current answer.

Nothing else about the host's own stores is read or written; the host's local values for anything
outside this contract are the user's and are left alone.
