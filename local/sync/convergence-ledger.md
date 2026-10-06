# Convergence ledger

Every upstream sync re-asks the same questions: _which side's design wins here, and what shape did
we settle on last time?_ This file answers them by subsystem so a conflict resolution does not have
to be re-derived. `local/sync/conflicts.mjs` prints the entries whose `Paths` match a conflicted
file.

Rules for using it:

- An entry is a **decision**, not a suggestion. If reality has moved past it, change the entry in
  the same commit that contradicts it.
- `Do not` lines are the expensive mistakes this fork has already made once.
- When a decision is superseded by upstream, record the new one and delete the old, rather than
  accumulating contradictory entries.

---

## Credential and key stores

**Paths:** `src/main/credentials/**`, `src/main/{deepseek,fireworks,copilot-credentials,minimax,zcode,opencode}/**key*store*`, `src/main/rate-limits/service/service-{configuration,fetch-targets}.ts`

**Decision:** Upstream's `createEncryptedApiKeyFileStore` is the only factory. The fork's
`createSecureCredentialStore` was deleted in the 2026-10-05 sync; deepseek, fireworks and copilot
stores use upstream's factory (`providerLabel`/`logScope`, not `description`/`logTag`).

**Why:** upstream's version is a behavioural superset — `{ durable: true }` writes and
`ApiKeyFileUnreadableError` for a transient read failure, which
`service/service-fetch-targets.ts` catches to set `apiKeyReadSkipped`.

**Do not:** reintroduce a second factory, or a store that throws a plain decrypt error for a
transient read failure.

---

## Repo detection and local Git children

**Paths:** `src/main/git/repo-detection.ts`, `src/main/git/command-runner/**`, `src/main/ipc/repos/local-repo-registration.ts`, `src/main/git/repo-default-base-ref.ts`

**Decision:** async execution **and** upstream's consolidated shape. `probeGitRepo` returns
`Promise<GitRepoProbe>` from one combined `rev-parse`; `isGitRepoFromProbe`,
`inspectGitRepoForRegistration` and the root helpers are async; callers await
(`await inspectGitRepoForRegistration(...)`). `getGitRepoRoot` parses git's output with
`indexOf('\n')` so a path containing a newline survives.

**Why:** the fork's `ea059d2afc` moved this off the main thread deliberately (WSL/network paths are
the slowest); upstream's single spawn and `records.length === 4` newline fallback are fixes this
fork does not want to lose.

**Do not:** make these functions sync, or split the newline handling back into
`split('\n')`.

---

## Floating workspace and file access

**Paths:** `src/main/ipc/floating-workspace-directory.ts`, `src/main/floating-workspace-launch-directory.ts`, `src/main/startup/os-opened-documents.ts`, `src/main/ipc/filesystem-auth.ts`, `src/main/ipc/local-file-access-resolution.ts`

**Decision:** the folder is `~/.orca-np/floating-workspace`, created and authorized by
`ensureFloatingWorkspaceDirectory()`. Upstream's `extraRoots` / `user-file` access kind **and** the
fork's `authorizeExternalPath` grant set both exist and both stay: upstream's covers declared
requests, the fork's covers paths main resolves itself (OS-handed documents, picker grants).

**Why:** upstream deleted main's in-memory grants in favour of `extraRoots`, but the fork's
floating-workspace surfaces are built on them — dropping the grants left eight tests red, and the
grants are what make a first-launch OS-opened document readable.

**Do not:** delete `authorizeExternalPath`, or "converge" the two mechanisms into one.

---

## Explorer name filter and the path index

**Paths:** `src/renderer/src/components/right-sidebar/file-explorer-name-filter-*.ts`, `src/renderer/src/components/right-sidebar/useFileExplorerVisibleRowProjection.ts`, `src/main/ipc/quick-open-*`, `src/relay/fs-handler-list-files*.ts`

**Decision:** the fork's chunked projection, worker-owned path index and `onPathBatch` scan API
win; upstream's NUL-separated reader, `RipgrepFilenameDecoder`, `getQuickOpenRgOutputMode` and
path-too-large verdict live inside them. Separator semantics come from the **root's syntax**
(`isWindowsAbsolutePathLike(root)`), never from `path.includes('\\')`: on a POSIX root a backslash
is a literal filename character. The absolute-path guard in `file-explorer-name-filter-path-acceptance.ts`
applies only when `hostAppliedScope` is true.

**Why:** POSIX roots legitimately carry literal backslashes (`C:\foo/a\b.txt` is a relative name
there), and upstream's identity tests pin that.

**Do not:** pick a separator from the presence of a backslash, or reject absolute-looking paths on
the non-host path.

---

## Agent-hook listener, rosters, descendant tracking

**Paths:** `src/shared/agent-hook-listener/**`, `src/shared/agent-descendant-roster.ts`, `src/main/agent-hooks/**`

**Decision:** the roster is `AgentDescendantRoster` in `agent-descendant-roster.ts`
(`getOrCreateAgentDescendantRoster`, `finishAgentDescendant`); the fork's status-cache hydration
promise is published by `initializeStatusHookOwner()` in
`server-status-hook-lifecycle.ts` and awaited by `start()` before the listener binds. New upstream
sources (`jcode`, `qoder-cn`, `qwen-code`) get `null` descendant adapters until something emits
descendant facts for them.

**Why:** the rename is fork-wide and recurrent — upstream keeps adding files that import the old
name; `main/codex/codex-subagent-roster.ts` is a _different_ module and keeps its name.

**Do not:** resurrect `codexRoster*` names in `src/shared/`, or initialize hook-owner state
synchronously ahead of the readiness promise.

---

## pi subagent bindings: one binding per channel

**Paths:** `src/main/pi/agent-status-subagent-roster-source.ts`, `src/main/pi/agent-status-async-subagent-source.ts`, `src/main/pi/agent-status-extension-source.ts`, `src/main/pi/agent-status-{async-subagent,extension-async-subagents,extension-omp-lifecycle}.test.ts`

**Decision:** the fork's own bus owns pi's child roster. `agent-status-async-subagent-source.ts`
binds **both** plugin lineages (`subagents:*` from the tintinweb fork and `subagent:async-*` from
`@earendil-works/pi-subagents`), posts the full live set as `subagent_runs` on every post, and routes
`subagent:process-terminal` through the same retire-and-repost path. The two `subagent:async-*`
bindings are therefore removed from upstream's roster setup in
`agent-status-subagent-roster-source.ts` (marked `LOCAL(nplez1)`); upstream's OMP-only
`task:subagent:lifecycle` binding stays.

**Why:** with both lineages bound, every child lifecycle event fired twice, and upstream's
unconditional binding filled the fork's deliberate silence on those channels for omp/prime-agent.
Channel coverage differs in both directions, which is why this converges on the fork's subsystem
rather than upstream's.

**Do not:** re-add the two `subagent:async-*` bindings to the roster setup, or drop
`subagent:process-terminal` from the fork's bus — a child whose only end signal is its runner exit
then stays in the live set until the descendant lane's quiet-reap window retracts it.

---

## Status bar, usage providers, rate limits

**Paths:** `src/main/rate-limits/**`, `src/renderer/src/components/status-bar/**`, `src/shared/rate-limit-types.ts`

**Decision:** provider enumerations, switch cases and status-item lists are **unions** — the fork's
(deepseek, fireworks, copilot) plus upstream's (zcode, antigravity, …). The fork's
"switch off a provider" gates wrap upstream's per-provider plumbing. `FetchAllCyclePrepared` lives in
`service-types.ts` (the fork's move) and carries upstream's members (`zcodeConfigChanged`,
`zcodeGeneration`).

**Why:** this is the single most repeated conflict shape in the repo — every sync adds a provider.

**Do not:** let a union duplicate a member (the concatenation repeats the shared ones), or drop the
`disabled.has(...)` gate when re-seating a provider.

---

## AI Vault session index and the parse cache

**Paths:** `src/main/ai-vault/**`, `src/main/ai-vault-search/**`

**Decision:** `AiVaultServiceScanOptions` (upstream's name) everywhere; the background scanner passes
its `request` argument to the service and no longer has a worker fallback. The persisted-format
version is the single shared `SESSION_PARSE_CACHE_SCHEMA_VERSION` in
`session-parse-cache-snapshot-serialization.ts` — when both sides bump it in one sync, the merged
file takes a version **strictly above every version either side has shipped**, never merely the
higher of the two: the two lineages have already meant the same number once (both sides meant 4,
then both meant 5), and a released build is out there writing it.

**Why:** the version number is the only compatibility signal (the `appVersion` equality gate is
gone), and two meanings under one number silently replay wrong rows.

**Do not:** reintroduce `AiVaultWorkerScanOptions` or a second schema constant.

---

## Accounts settings, search catalogs, provider panes

**Paths:** `src/renderer/src/components/settings/accounts-search*.ts`, `src/renderer/src/components/settings/AccountsPane*.tsx`, `src/main/ipc/register-core-handlers/**`

**Decision:** the newer-provider search catalogs live in `accounts-search-extra-providers.ts` and
are re-exported from `accounts-search.ts` to stay under the 300-line cap (Grok, Cursor, Antigravity,
ZcodePlan). Credential sections are split per provider; a pane that mounts `OpenCodeGoCredentials`
or a GLMT plan section needs those `window.api` doubles in its test.

**Why:** `accounts-search.ts` was over the cap once already; moving catalogs out is the accepted way
to stay inside it, and no `max-lines` suppression is allowed.

**Do not:** add a `max-lines` disable, or inline a credential section back into `AccountsPane.tsx`.

---

## Worktree create and removal

**Paths:** `src/main/ipc/worktree-remote.ts`, `src/main/ipc/worktrees/**`, `src/main/runtime/runtime-*-worktree-*.ts`

**Decision:** the startup terminal keeps the fork's `if (startup && sequencedStartup) … else if
(setup && !hasDefaultTabs)` structure with the host's creation-evidence argument;
`deleteRemoteBranch` is part of the removal options key and the removal finish args; setup terminals
capture `.handle` from both `splitTerminal` and `createTerminal`.

**Why:** the fork's setup-status feature reads that handle to arm the runner, and the fork's tests
pin the two-argument blank-create call.

**Do not:** drop `deleteRemoteBranch` between the IPC entry point and `git worktree remove`, or
revert the blank-create branch to a single unconditional spawn.

---

## Identity: this fork ships as Orca NP

**Paths:** `config/**`, `native/**`, `resources/**`, `mobile/**`, `src/**`, `package.json`

**Decision:** `Orca NP`, bundle `com.nplez1.orca`, CLI `orca-np` (`orca-np-dev` in dev), packaged
userData `appData/orca-np`, home directory `~/.orca-np`, NSIS ProgIDs `OrcaNP.Markdown` /
`OrcaNP.Tabular`, daemon-host root `%LOCALAPPDATA%\orca-np`. The `orca://` URL scheme and the
relay's fixed plain `orca` shim are deliberate exceptions.

**Why:** coexistence with an official install is the whole point of the identity patch, and upstream
keeps adding new `~/.orca` and `orca.exe` references that must be swept each sync.

**Do not:** rename the URL scheme, or sweep the relay shim to `orca-np`.

**Tooling:** `node local/sync/identity-sweep.mjs` reports every remaining violation (allowlisted
cases are in that script).

---

## Localization catalogs

**Paths:** `src/renderer/src/i18n/**`

**Decision:** `src/renderer/src/i18n/locales/en.json` is the source and is hand-unioned;
`en-runtime-required.json` is **derived** and is regenerated, never merged:
`pnpm run sync:localization-runtime-catalog`, then both verifiers.

**Do not:** hand-edit the derived catalog, or resolve a locale conflict by picking a side for the
derived file.

---

## Wire compatibility

**Paths:** `src/shared/protocol-version.ts`, `src/shared/rpc-contract/**`

**Decision:** protocol constants are upstream's. The fork's `orchestration-runtime-capabilities`
re-export stays, because the fork lifted those constants out of `protocol-version.ts`.

**Why:** paired clients and hosts update independently; a renumbered constant breaks old peers.

**Do not:** raise or lower a protocol version to resolve a conflict.

---

## Dashboard and the popout window

**Paths:** `src/renderer/src/components/dashboard/**`, `src/renderer/src/components/dashboard-popout/**`, `src/main/ipc/dashboard*.ts`, `src/preload/api/dashboard*.ts`, `src/main/window/dashboard-popout-window*`

**Decision:** the Agent Dashboard is a first-class view (`AgentDashboardPage.tsx`). The popout
window plumbing (`src/main/window/dashboard-popout-window.ts`, its test, the popout IPC and preload)
was **deleted** by the fork, so upstream's later fixes to those files are taken as deletions rather
than merged back in.

**Do not:** restore the popout window to carry an upstream fix.
