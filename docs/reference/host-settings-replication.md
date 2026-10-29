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

A removal deletes only ids in the host's own _replicated_ record. A credential the user entered on this
host is not in that record, so replication never removes it. Two exclusions exist so a transient local
fault cannot look like a deliberate removal:

- `unreadable` credentials (a locked keyring) are never treated as absent;
- a snapshot's stranded sweep skips them for the same reason.

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

| Field                       | Disposition                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| provider credentials        | replicated; only ids in the host's replicated record may be removed |
| `unreadable` credential ids | reported by the main, never deleted here                            |
| settings / UI state         | not replicated by this path                                         |
| revision, `syncedAt`        | host-local ledger, written after an applied payload                 |

Nothing else about the host's own stores is read or written; the host's local values for anything
outside this contract are the user's and are left alone.
