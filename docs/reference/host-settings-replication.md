# Host settings replication: one main machine, subordinate paired hosts

**Status: proposed. Nothing in this document is implemented.**

## The shape we want

One machine — the main laptop — is authoritative for settings and provider credentials. Several
paired Orca instances run the **full GUI app** (so GUI builds of a target app can be driven there)
and are subordinate: they take the main's settings as they are, rather than being configured
separately.

Two properties follow, and they decide the design:

- **A paired host must keep working while the main is offline.** The laptop is often asleep,
  closed, or on another network. So this is *replication* — each host holds its own copy — not a
  read proxied back to the main.
- **"Subordinate" is about settings, not about the workspace view.** Which terminals, tabs,
  worktrees, and windows a host has open is local UI state and stays local. Replicating it would
  fight the user rather than serve them.

Why not the alternatives:

- **Resolve credentials across hosts at read time** (ask whichever host has the site connected).
  Simple, no secret copies, and it is what the Jira read path does today for `local` and `ssh:*`
  hosts (`getTaskSourceRuntimeSettings` maps only `runtime:<id>` to an environment). But every
  subordinate then needs the main online to draw a ticket panel, which contradicts the first
  property. Rejected.
- **Configure each host by hand.** Today's behaviour, and the reason a fleet is unusable.
- **Copy secrets opportunistically, with no authority.** No revocation story. Rejected.

## What already exists to build on

This is an extension of machinery already in the tree, not a new subsystem:

- **Profile transfer, with a per-field decision table.** `src/main/orca-profiles/profile-active-transfer.ts`
  moves a profile between hosts, and `profile-project-session-field-disposition.ts` decides each
  session field's fate through explicit axes — currently `onRepoRemoval` and `onTransfer`, with
  values such as `notTransferred` and `copiedByBespokeRule`. Replication is a **third axis** on the
  same table.
- **Orca Cloud profiles and org membership** (`profile-cloud-*`, PKCE auth, org members) — the
  natural identity layer for "these hosts are mine".
- **A paired-runtime RPC surface with capability negotiation**, governed by
  [`remote-wire-compatibility.md`](./remote-wire-compatibility.md): a new optional field is safe, a
  new stream opcode must be capability-negotiated because decoders drop unknown opcodes silently.
- **Credential stores that already model at-rest protection** (`SecretAtRestProtection`,
  `credentialProtection`), so a host whose keyring is unavailable is already representable.
- **Nothing in `orca-profiles` transfers provider credentials today.** That is the genuinely new
  part, and the risky one.

## Field disposition: the third axis

Add `onHostSync` to the disposition table, with three values:

| Value | Meaning | Examples |
| --- | --- | --- |
| `replicated` | The main's value wins; the host applies it. | settings, agent defaults, task-source connections, provider credentials, card properties |
| `hostLocal` | Never leaves or arrives; it describes *this* machine. | repo registrations and roots, paths, terminal shell and PTY config, VM/GPU/emulator settings, port forwards, SSH keys, `activeWorkspaceExecutionHostId` |
| `replicatedOnlyIfEmpty` | Fills a host that has nothing, never overwrites a deliberate local value. | anything a user may have set locally on purpose |

The table is the contract. A field with no entry is a bug, not a default, so the test that walks it
should fail on an unknown key.

## Prerequisite: the fork's own home directory

This must be fixed first, and it is worth fixing regardless.

The Jira credential store hardcodes `~/.orca` (`src/main/jira/site-credential-store.ts:29`) even
though the fork's own directory module states the intent — "this fork is meant to sit beside an
official Orca install on the same machine. Sharing these names would let either install read,
migrate, or clobber the other's state" (`src/shared/app-directory-names.ts:9-15`, which defines
`HOME_DIRECTORY_NAME = '.orca-np'`).

Jenkins, Bitbucket, zcode, the encrypted API-key store and the floating workspace share the same
hardcoded path. Replicating settings and credentials into a directory shared with an official Orca
install would corrupt both installs' state — so the rename is a hard prerequisite, with a
legacy-path fallback so an existing connection is not silently lost
(`migrateLegacyKeybindings` in `keybindings/keybinding-file.ts` is the established shape).

## Hard questions this has to answer

1. **Secrets.** A replicated token is stored on the receiver. If that host's keyring is weaker, its
   protection is silently downgraded — the difference between a sealed token and
   `credentialProtection: 'plaintext'`. That needs an explicit policy (refuse? warn? replicate
   anyway?) and a way to see which hosts hold which credential.
2. **Revocation.** Disconnecting on the main has to delete the credential on every host that
   received it, and verify the deletion. A host you later hand to someone else must be revocable,
   and that must be observable.
3. **Conflict and drift.** "Main wins" is a policy, but a silent overwrite of a deliberate local
   edit reads as a bug. The override has to be visible, and a host that was offline for a week
   needs a snapshot-plus-delta answer rather than a queue of replays.
4. **Transport and versions.** Push on connect, or pull on demand? What does a host show before its
   first sync — "not synced" or an empty connection list? How does an older host degrade instead of
   breaking (capability negotiation, per the wire rules).
5. **Which credentials are in scope.** Jira, Linear, GitHub and GitLab tokens, and AI provider keys
   are all per-host files today. One policy for all of them, or per-provider opt-in?
6. **Trust boundary.** Which hosts may hold which credential. A subordinate that only drives GUI
   builds may not need an AI provider key at all.

## Verification, when it is built

- A host that has never synced reports "not synced" — never an empty connection list that reads as
  "you have no integrations".
- Disconnect on the main leaves no token on any paired host, asserted against the on-disk stores,
  not just the in-memory state.
- Every session and settings field is asserted to have a disposition, table-driven.
- Cross-version: an old host paired with a new client still functions, covered by
  `tests/e2e/cross-version-wire/`.
