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

## SSH relay removal: upstream's orcad model wins

**Paths:** `src/relay/**`, `src/wsl-guest/**`, `src/shared/ssh-ai-vault-relay.ts`, `src/main/providers/ssh-filesystem-*.ts`, `src/main/runtime/runtime-file-commands-search-remote-quick-*`, `src/main/runtime/runtime-file-commands-workspace-path-search.ts`, `src/main/ipc/filesystem/filesystem-remote-path-search.ts`, `src/main/providers/ssh-filesystem-provider-crud.ts`, `src/main/ai-vault/remote-session-scanner-*.ts`

**Decision:** Upstream's deletion of the SSH relay stands. The 2026-10-11 sync takes the whole
`src/relay/` removal (`2b4b60a87e` the server, `ff27338299` the client path) instead of reverting
it, and the fork's WSL guest sources follow upstream into `src/wsl-guest/` (`31b2b17d9b`). SSH hosts
are served by orcad; there is no relay on this branch.

The **2026-10-13 sync finishes that removal**: upstream retired the last relay-era callers
(`SshGitWorktreeProvider`, `removeRegisteredRemoteWorktree`,
`runtime-registered-remote-worktree-removal`, the `getSshFilesystemProvider` branch of `fs:listFiles`),
and the fork's remaining SSH path-search stack goes with them rather than being re-pointed. An SSH
target is answered locally now: `fs:listFiles` and `fs:searchFilePaths` return an empty list, and
`files.searchPaths` takes upstream's mobile/file-search shape. The fork's `IFilesystemProvider`
additions (`searchWorkspacePathNameFilter`, `workspacePathSearchCapability`) are deleted with their
implementations.

**Why:** the fork's own investment in the relay is three commits (explorer name filter #34,
agent-status #26, the ai-vault session-history pair) against 467 files and ~158k lines upstream has
abandoned. Reverting would make the fork the sole maintainer of the subsystem and re-open the same
~100-file conflict set at every future sync. By 2026-10-13 the relay-era SSH path-search stack had
no surviving provider implementation to call, so keeping it would mean re-implementing the relay,
not preserving a feature.

**Do not:** reintroduce `src/relay/` or a relay client path; leave fork-added relay files at the old
flat `src/relay/` path instead of relocating them under `src/wsl-guest/`; or keep citing the
fork's relay-era SSH docs as describing this branch. **Do not resurrect the SSH half of the path
search** — `filesystem-remote-path-search.ts`, `ssh-filesystem-provider-crud.ts` and the
`IFilesystemProvider` hooks (`searchWorkspacePathNameFilter`, `workspacePathSearchCapability`) are
gone with the provider dispatch; the **local** branch of `searchWorkspacePathNameFilter` is live and
stays (see "Explorer name filter and the path index").

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


**2026-10-16 addendum.** Both sides replaced Electron's `safeStorage` in the same files, so the
merge is upstream's `getSecretStore()` shape plus the fork's own rules: the sealed-envelope-only
port consultation, the "secret encryption unavailable" wording, and `adoptLegacyHomeStore()` for
the home-directory identity. Where upstream left a test on a per-suite `setSecretStore({...})` call,
the fork's `secretStoreMock` const plus `_resetSecretStoreForTests()` is kept instead — it was
already the port, and it resets between cases rather than only setting up.

---

## Repo detection and local Git children

**Paths:** `src/main/git/repo-detection.ts`, `src/main/git/command-runner/**`, `src/main/ipc/repos/local-repo-registration.ts`, `src/main/git/repo-default-base-ref.ts`

**Decision:** upstream's generator shape (`probeGitRepo` / the `*Commands` helpers as
`Generator<GitRepoCommand, T, string>`, run by `runGitRepoCommands` / `runGitRepoCommandsSync`),
with upstream's sync entry points (`isGitRepo`, `inspectGitRepoForRegistration`, `getGitRepoRoot`,
`getLinkedWorktreeMainRepoRoot`) kept alongside `isGitRepoAsync`,
`inspectGitRepoForRegistrationAsync` and `getGitRepoRootAsync`. Callers take the variant they need.
`repo-git-marker-scan.ts` is upstream's sync `scanGitMarkerSync` / `resolveRealPathSync` again,
because the generator runs the marker scan synchronously.

**Why:** upstream's `b63d39ebe5` reached the same goal the fork's `ea059d2afc` did — git execution
off the main thread — with one body serving sync and async callers, so the fork's parallel async
copy of both files was superseded rather than merged. `getGitRepoRoot` still parses git's output
with `indexOf('\n')`, so a path containing a newline survives.

**Open (2026-10-11 sync):** upstream's shape still runs four filesystem steps synchronously even
through the async entry points — the `statSync` entry checks (`repo-detection.ts:33,97,155,205`),
the ancestor `scanGitMarkerSync` walk (`:51`, `:193`) and `resolveRealPathSync` (`:201`). Those are
precisely the steps that freeze on a dead WSL or network mount, which is the case `ea059d2afc` was
written for. Extending `GitRepoCommands` to carry the fs steps is the follow-up.

**Do not:** reintroduce a second async copy of `repo-detection.ts` or `repo-git-marker-scan.ts`.
Upstream rewrote `repo-detection.ts` the day before this sync, so a fork copy re-conflicts at every
future sync and drops upstream's single decision tree.

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

**Sentinel scope (2026-10-07 sync):** the floating-terminal *scope* resolves through
`resolveFloatingWorkspacePath()`, which honours a configured `floatingTerminalCwd` and otherwise
returns `resolveFloatingWorkspaceLaunchDirectory()` **without creating it**. It deliberately does not
fall back through `resolveFloatingTerminalCwd` with an empty path: that call ensures the folder, which
writes `~/.orca/floating-workspace` during a resolution, trips the unit-test home-write guard, and is
the launch path's job. `agent-launch-floating-workspace.test.ts` pins both branches — configured
directory honoured, default folder when unset.

**Why:** the scope becomes the launch cwd (`orca-runtime-create-terminal.ts` falls back to
`workspace.path`), so ignoring the setting here would put a floating agent in one directory while the
panel's own floating terminal and its filesystem requests use another.

**Open (needs the fork owner):** the ledger above says the folder is `~/.orca-np/floating-workspace`,
but `floating-workspace-launch-directory.ts` joins `HOME_DIRECTORY_NAME`-less `.orca` and its test
pins that. The identity sweep reports both as `home-dir-unknown` / `home-dir-reader`. Re-pointing it
moves users' notes and `AGENTS.md` context, so it is a migration, not a rename.

**Do not:** route this scope through the settings-aware resolver again.

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
the non-host path; or delete the `src/renderer/src/runtime/runtime-file-client.ts` barrel while the
fork's renderer files still import it — upstream deleted that barrel on 2026-10-13 and the fork
keeps it, with `searchRuntimeFilePaths` living in `runtime-file-path-search-client.ts` and the
barrel re-exporting it.

**The runtime-RPC name filter is live, and only its SSH half is gone (2026-10-13).**
`src/main/runtime/runtime-file-commands-workspace-path-search.ts`'s
`searchWorkspacePathNameFilter` has two branches: the **local** one runs `searchQuickOpenFilePaths`
for a non-SSH runtime route and is what the **web client and paired desktop clients** reach through
`files.searchPaths` with `mode: 'name-filter'`; the **SSH** one called
`IFilesystemProvider.searchWorkspacePathNameFilter` and died with the relay-era dispatch. This sync
first deleted the whole module and routed `files.searchPaths` through `searchMobileFilePaths`, which
would have broken the web client's filename filter — the Opus review caught it, and the module, the
command surface, the `files.ts` branch and the fork's `files-path-search.test.ts` are restored with
only the SSH branch replaced by an `unsupported` partial response.

**Do not:** delete `RuntimeFileCommandsWithWorkspacePathSearch`, remove the `mode: 'name-filter'`
branch of `files.searchPaths`, or drop `searchWorkspacePathNameFilter` from
`runtime-file-command-surface.ts` — that breaks the web client's and paired clients' explorer name
filter. The **SSH** half needs a new transport if it is ever wanted back, not the old provider hook.

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

**Monitoring badge (2026-10-07 sync):** upstream moved `resolveClaudePaneStatus` into
`providers/claude-pane-hold-evidence.ts` and split its evidence into `runningAgent` / `owedAgent` /
`runningNonAgent` / `owedShell`. The fork's `local(agents)` policy is expressed there, not at the
call sites: `hasLiveAgentWork` is `held.runningAgent || held.owedAgent ||
state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)` and `hasLiveNonAgentWork` is
`state.claudeActiveSessionCronPaneKeys.has(paneKey) || held.owedShell`.

**Why:** a running shell the agent launched is still agent work, and `foldAgentLeadStatus` returns
`monitoring` only when `hasLiveAgentWork` is false, so moving the running shell off the non-agent side
is the whole badge difference. Two fork tests pin the two halves from opposite directions:
`claude-background-task-status.test.ts` (a running shell *and* a cron → plain `working`, because the
running shell is agent work) and `server-claude-cancel-captures.test.ts` (a cron with the shell set
empty → `monitoring`).

**Accepted nuance:** upstream's *owed* shell notification stays on the non-agent side, as upstream
maps it, so a lone owed-shell window (no cron) can show `monitoring` for the notification lease. The
2026-10-07 review gate flagged that against the policy sentence above; the alternative (owed shell as
agent work) breaks `claude-background-task-status.test.ts`, and treating a live cron as overriding a
running shell breaks the cancel-capture case. An owed shell is a pending wake-up rather than the
running shell the policy is about, so the fork deviates from upstream only for the running shell set.

**Do not:** stop re-adapting upstream tests that pin the other policy — `server-claude-terminal-interrupt.test.ts`
needed its running-shell case changed to expect no `workingMode`.

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


**2026-10-16 addendum.** Upstream extracted the desktop's inline account-service construction into
`createProviderAccountServices`, which the desktop and orcad both call. The fork's additions moved
with it rather than staying behind in `main-process-account-services.ts`: the DeepSeek, Fireworks
and Copilot config resolvers, the `disabledUsageProviders` gate on `RateLimitService`'s
construction, the enable/disable settings hook, and the `gh auth status` warm-up gated on Copilot
being enabled. Keeping them at the desktop call site was the alternative and was rejected: the
resolvers define the providers' credentials, and upstream's module is the one place that knows how
a host builds the usage service.

That move is what turned the runtime-electron ratchet red, because orcad now reaches
`RateLimitService`. The two fork fetchers that imported `net` from Electron read the host HTTP port
instead (`getMainHttpClient()`, the way the Gemini and Kimi fetchers already do); their suites
install the port rather than a fake `electron` module.

It is also a behaviour change on orcad, and deliberately so: orcad builds the fork's three resolvers
against its own credential store, honours the enable/disable setting, and spawns the `gh auth status`
warm-up unless Copilot is disabled — none of which it did while the wiring was desktop-only.

Do not put an Electron import back into any fetcher reachable from `createProviderAccountServices`:
the runtime, orcad and the structured-chat lanes must boot on plain Node.

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


**2026-10-16 addendum.** Upstream and the fork both extended the same third parameter of
`scanAiVaultSessionsInService` in one sync — upstream with the scan-progress handle (#28788), the
fork with `request: { refresh, query }`. Both are kept: the request is the third argument, the
progress handle the fourth, and `scanAiVaultSessionsInBackground` forwards both. `work` is
upstream's final tally and the fork's index-first path reports `work: null`, because an answer from
`sessionSearch.listSessions` runs no scan to tally.

The fork's query rule now lives inside upstream's helpers rather than beside them: upstream
replaced the fork's inline cache key with `aiVaultLocalScanScopeKey`/`aiVaultLocalScanKey`, and
`aiVaultLocalScanScopeKey` carries `aiVaultHostListQuery(args?.query ?? '')`. That keeps the cache
key, the coordinator key and the renderer's `requestedScanKey` in agreement — a query in the cache
key but not the coordinator key would let a filtered request coalesce onto an unfiltered scan. The
renderer's key omits `query` today only because the panel never sends one; a panel that starts
sending `hostQuery` has to add it to `requestedScanKey` in the same change, or the strip stops
matching the host's scans.

`work: null` is also a rendering decision, not just a protocol one: upstream's strip turns a
finished row into "Scanned N files", so a zero-tally finish showed "Scanned 0 files" with a tick on
the index path. `finish()` publishes nothing when the work is null **and** nothing was ever reported
(no agents, no reads); a scan that really ran always reports something. Keep that pairing — the
condition is "no scan ran", not "the tally is empty". The one remaining route to a zero-count row is
the `fail()` path: an index answer that hits the service's no-progress deadline still publishes
`stage: 'stopped'`, which reads "Stopped after 0 files". That is upstream's deadline behaviour and
needs a reconcile slower than 130s to reach, so it is recorded rather than worked around.

Do not add a fifth parameter here; the two sides of the seam are request and progress, and either
one silently dropped reports success with the wrong rows or no progress.

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


**2026-10-16 addendum.** Upstream's "trim redundant tests" pass (#29156) deleted
`accounts-pane-claude-section.test.tsx` and moved both of its cases into `AccountsPane.test.tsx`,
so the deletion is taken and the fork's only contribution there — the DeepSeek/Fireworks/Copilot
fields its section model needed — is re-applied to upstream's consolidated file. The same pass
turned `tui-agent-startup.test.ts` into an import barrel over new `.spec.ts` files, so the fork's
`orca-np` launch expectations moved into `tui-agent-startup.spec.ts`.

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
revert the blank-create branch to a single unconditional spawn. Since 2026-10-13 there is **no SSH
variant of that path**: upstream refuses `repo.connectionId` with `SshHostNotServedError` and routes
every removal through `removeRegisteredLocalWorktree`, so the option is threaded to the local path
only — do not re-add `removeRegisteredRemoteWorktree` or thread the option through a revived SSH
branch.

**Automation creates are provisioned in main, and the fork's guard must know it.**
`spawnLocalStartupAndSetupTerminals` takes `provisionedByHost` and returns early when it is set with
no startup command, because `provisionManagedWorktreeTerminals` (upstream, 2026-10-13) runs the same
setup script from `worktree-remote.ts`. Without that exclusion the setup script runs twice and the
blank first shell activates a background workspace. **Do not** drop the `provisionedByHost` argument
when the guard is next touched, and keep the automation test's
`expect(runtime.createTerminal).not.toHaveBeenCalled()`.

**Open (found by the sync's review):** the same double-setup shape survives for an automation create
that *does* carry a startup command — the spawner stages setup and
`provisionManagedWorktreeTerminals` runs it again with `hasStartupTerminal: false`
(`worktree-remote.ts`). Upstream at `8b0fa15e94` behaves the same, and no current caller reaches it
(the in-app automation dispatch passes no startup, and the other automation creates go through
`createManagedWorktree`), so it was not changed mid-sync. Fix it when an automation path grows a
startup command.

---

## Identity: this fork ships as Orca NP

**Paths:** `config/**`, `native/**`, `resources/**`, `mobile/**`, `src/**`, `package.json`

**Decision:** `Orca NP`, bundle `com.nplez1.orca`, CLI `orca-np` (`orca-np-dev` in dev), packaged
userData `appData/orca-np`, home directory `~/.orca-np`, NSIS ProgIDs `OrcaNP.Markdown` /
`OrcaNP.Tabular`, daemon-host root `%LOCALAPPDATA%\orca-np`. The `orca://` URL scheme and the
relay's fixed plain `orca` shim are deliberate exceptions.

**Why:** coexistence with an official install is the whole point of the identity patch, and upstream
keeps adding new `~/.orca` and `orca.exe` references that must be swept each sync. Upstream's tests
are the biggest source: the 2026-10-13 sync flagged 14 fresh `~/.orca` sites, all in upstream's new
hook-service suites, and for `gemini`/`command-code` they are assertions about where the service
really installs.

**Do not:** rename the URL scheme, or sweep the relay shim to `orca-np`; **and never hand-edit the
sweep's subjects** — run `node local/sync/identity-sweep.mjs --fix` on a clean tree and review the
diff (it reports `N fixable`, which must be 0). A hook test that writes `~/.orca` fails against this
build, it does not merely read oddly.

**Tooling:** `node local/sync/identity-sweep.mjs` reports every remaining violation (allowlisted
cases are in that script).

**The one deliberate `~/.orca` exception (2026-10-09 sync):** the managed-hook install lock parent
in `managed-hook-install-lock.ts` stays the literal `.orca` (and `managed-hook-runtime.test.ts`
asserts both `.orca` and `.orca-np`), because that lock is a **cross-install mutex over the shared
`~/.claude` hooks**: an official Orca install manages the same hook files, so both must contend on
one lock path. The fork renamed its own home, not this mutex. This has now been "repaired" twice —
`identity-sweep.mjs` reports the literal, and a 2026-10-09 resolution changed it to
`HOME_DIRECTORY_NAME` and swept the test with it, which broke
`codex-state-db-backfill-recovery.test.ts`. **Do not sweep this one.**

---

## pi subagent session boundaries

**Paths:** `src/main/pi/agent-status-*-source.ts`, `src/main/pi/agent-status-extension-session-change.test.ts`, `src/shared/agent-hook-listener/descendant-events.ts`

**Decision:** the fork's live pi child set is **keyed by the session that owns it**, on
`globalThis.__orcaPiAsyncSubagents` (`agent-status-async-subagent-session-source.ts`) — the one home
that survives a `/reload`, which re-evaluates the generated module. Every post carries the _current_
session's bucket and nothing else, so a pane shows one session's children at a time. A session change
(`/new`, fork, a resume into a different file) resets the three bind flags and invalidates the
registration that bound the old bus (`piAsyncSubagentState.registration`, the guard a stale callback
is refused by), but **clears no children**: they stay in their own bucket and come back when that
session is current again — after `/new` by `/resume`, and across a `/reload` of the session already
open. A resume into the file already open keeps its bucket current throughout (`keepsSession`). The
key is the file Pi names in a resume target (`session_file`), its `session_id` as fallback, and the
last key seen while a re-evaluated module has no metadata yet.

**The binding's identity is the bus, and ownership lives on the registration.**
`PiAsyncSubagentBusBinding { bus, registration, listeners }` is looked up by the **bus object**, and
ownership transfers to the newest registration on that bus; both callbacks read
`binding.registration` per call and refuse once it is closed. Shutdown marks its registration closed
and splices only the binding that registration owns, unsubscribing through the bus's own `off`, so a
superseded registration owns no binding: its shutdown leaves the live bus reporting, and its
in-flight callbacks refuse through the newer registration's `closed` flag. Keying this on the
_evaluation_ instead — the shape the second gate rejected — left a second, distinct bus unobserved
and let a superseded callback still post. `subagent:process-terminal` carries two listeners by
design (the fork's descendant bus and upstream's runner-exit lane).

**A hold nobody claims is retracted.** `descendant-pane-state.ts` recognises when nothing claims the
pane — no lead verdict and an empty roster — and drops the cached row if it still carries
descendants. Merely declining to publish a new claim is not enough: the previously published hold
stayed in `lastStatusByPaneKey` naming a child that no longer existed.

**Why:** measured on the merge of upstream `6c693edf40` and then on the second-model review of it: a
session change reported a closed session's children under the next one, a fresh bus had zero
listeners, and a module-scope live set was rebuilt empty by `/reload` — losing the children a
same-file resume keeps, against the intent that declaration's own comment stated. The receiver
replaces its child list with every post (`replaceAgentDescendants`), so a post may only ever carry one
session's set, and a stale registration must not file a closed session's children under the one now
on screen. `agent-status-extension-session-change.test.ts` is the spec: "brings a session's children
back when it is resumed, and shows none of them under another session" was **restored** for the
fork's lane after the merge deleted its upstream counterpart (its fixture is producible again), and
"keeps the children and the hold across a reload" asserts the set surviving rather than empty.

**Do not:** emit upstream's `subagents` / `subagents_update` roster rows (the fork removed the
pi `subagent:async-*` bindings, so they have no producer); withhold `agent_end`; clear the live set on
a session boundary, hold it in module scope, or drop the registration guard — each one loses children
the session still owns, or lets a superseded registration write into the session now current. Do not
re-adapt the reload test to an empty set a second time.

---

## Quick Open recent candidates

**Paths:** `src/renderer/src/components/quick-open-*.ts*`, `src/renderer/src/runtime/runtime-file-*`

**Decision:** a recent candidate is validated by `useQuickOpenRecentListing` from the **request
chain**, keyed by request id (`quick-open-recent-file-merge.ts`). The listing result is the fork's
`FilePathSearchResult`, so `totalCount` is required on both sides of the seam.

**Why:** starting the validation from a render effect arms its debounce past the caller's window, so
the candidate can be handed on unvalidated.

**Do not:** move that validation back into an effect, or make `totalCount` optional to satisfy an
older fixture.

---

## Localization catalogs

**Paths:** `src/renderer/src/i18n/**`

**Decision:** `src/renderer/src/i18n/locales/en.json` is the source and is hand-unioned;
`en-runtime-required.json` is **derived** and is regenerated, never merged:
`pnpm run sync:localization-runtime-catalog`, then both verifiers.

**Do not:** hand-edit the derived catalog, or resolve a locale conflict by picking a side for the
derived file.

**Conflict technique (2026-10-13):** when `en.json` itself conflicts, compute a three-way JSON
merge — base/ours/theirs — with the fork's key order as the spine, then review the two counts that
fall out: keys dropped because upstream deleted them and the fork never changed them, and keys kept
because the fork owns them. On 2026-10-13 that was 0 true conflicts, 69 dropped, 618 kept, and the
dropped set was checked against the source tree before it was believed. Never textually union the
1 MB file: a hand union reorders keys and hides a dropped entry in the churn.

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

**Ack intent (2026-10-07 sync):** the fork keeps the 1-arg ack — `onAckAgent: (paneKey: string) =>
void` on `AgentKanbanBoard`, calling `onAckAgent(card.paneKey)` — and does not adopt upstream's
`AgentSubjectReadIntent` parameter. Upstream added it with the popout relay the fork deleted; the
fork's store call is `acknowledgeAgents([paneKey])`, which has no intent concept, so adopting the
parameter would be cosmetic. The merge's test file had both assertions (`'explicit'`, `'view'`) from
upstream's side; both are reverted to the 1-arg form.

**Do not:** restore the popout window to carry an upstream fix.

---

## Checks panel polling and review refresh

**Paths:** `src/renderer/src/components/right-sidebar/checks-panel/**`, `src/renderer/src/components/right-sidebar/source-control/review/**`, `src/shared/review-refresh-policy.ts`

**Decision:** upstream's visibility-driven refresh owns *when* the panel refreshes —
`useChecksDetailTimer` + `ChecksDetailPollingPolicy.delayMs` + `reviewRefreshIntervalMs` — and the
fork does not set `pollIntervalRef` against that cadence. `use-hosted-review-polling.ts` and upstream's
copy of the foreground refresh effect are taken as deletions; the fork's
`scheduleAfterWorktreeActivationInputQuiet` wrap on them is gone with them. What the fork keeps is the
cache bypass: `fetchPRChecks(..., { force: force || checksPending })`, where `checksPending` is
`checks.some((check) => check.status !== 'completed')`, read from `modelRef.current`.

**Why:** the fork's 30s-while-unfinished cadence and its PR-level `checksStatus` refetch were written
against the polling implementation upstream replaced. Upstream's stability suite
(`use-checks-panel-polling-stability.test.ts`) pins the new cadence, and the fork's force flag is
independent of it — it only skips the renderer/gh cache while a run is live.

**Open (named follow-up):** if the panel feels stale when a *new* run appears, re-add the
PR-transition refetch as a policy concern inside `ChecksDetailPollingPolicy`, not as a second
`pollIntervalRef` writer.

**Do not:** re-add a second cadence owner, or re-wrap the refresh effects in the fork's activation
quiet scheduler.

---

## Test inventories retired upstream

**Paths:** `config/scripts/*.test.mjs`, `src/main/**/*-audit.test.ts`, `src/shared/child-process/**`, `src/shared/*-boundary.test.ts`

**Decision:** upstream's `ca4e239861` ("Remove low-value test inventories and duplicate fuzz oracles")
deleted ~50 workflow-contract scrapers and guard inventories (~21.6k lines) and the fork takes the
deletion, including where the fork had only renamed assertions to Orca NP or added a fork-specific
entry. Twelve paths were `modify/delete` in this sync and all twelve were resolved as deletions.

**Why:** they are maintenance-heavy inventories whose churn the fork would re-pay every sync, and
upstream replaced the ones it still wants with real tests
(`pty-lifecycle-generation-retention.test.ts`, `terminal-output-frame-chunks.test.ts`).

**Lost fork-specific coverage, as follow-ups:** `proxy-guarded-fetch-call-site-audit.test.ts` (the
fork's `main/jenkins/jenkins-request.ts` entry), `desktop-startup-ordering.test.ts` (the fork's
hook status-cache hydration readiness phase), and
`mobile-web-bundle-packaging-workflow-contract.test.mjs` (the fork-release workflow entries). The
fork docs that asserted those ratchets exist — `AGENTS.md` § Windows child processes, § Ripgrep —
now describe guards upstream retired.

**Do not:** re-add a deleted inventory to carry one fork entry; add the assertion to a surviving test
instead.


**2026-10-16 addendum.** Two more of upstream's consolidations were taken with the fork's content
re-homed rather than restored: `accounts-pane-claude-section.test.tsx` (deleted; both cases live in
`AccountsPane.test.tsx`) and the `tui-agent-startup` suite split into `.spec.ts` files under a
barrel. The barrel's own `.test.ts` extension is upstream's and stays. Nineteen `.test.ts` →
`.spec.ts` renames landed the same way; none carried fork content, which is why none conflicted. The
twentieth new `.spec.ts` is `tui-agent-startup.spec.ts`, the case above, whose fork expectations were
re-homed by that same commit.

---

## Node-runtime test inclusion

**Paths:** `config/scripts/vitest-node-runtime-files.mjs`

**Decision:** upstream's `NODE_RUNTIME_INCLUDE` list takes the fork's two SQLite-reading search suites
as explicit entries — `src/main/ai-vault-search/session-search-instance.test.ts` and
`session-search-list-latency.test.ts` — marked `LOCAL(nplez1)`.

**Why:** upstream's new boundary gate (`vitest-sqlite-runtime-boundary.test.ts`) walks every unit file
that imports a SQLite runtime and fails when it is not in the Node project. The fork's two suites open
the index with `SyncDatabase` directly, so they must run there; without the entries the gate fails
only in this fork, which is exactly what it is for.

**Do not:** delete those entries as "fork-only noise" — the gate will fail the moment they are gone.

---

## Orchestration capability re-exports

**Paths:** `src/shared/protocol-version.ts`, `src/shared/orchestration-runtime-capabilities.ts`

**Decision:** `protocol-version.ts` keeps upstream's explicit `export { ... } from
'./orchestration-runtime-capabilities'` block and imports `ORCHESTRATION_RUNTIME_CAPABILITIES` for its
own aggregate; the fork's `export * from './orchestration-runtime-capabilities'` is removed.

**Why:** both files were added independently with identical content, and the merge unioned the two
export shapes, which lint reports as a duplicate export of twelve names. The aggregate array has no
external importer, so the explicit block is the complete surface.

**Do not:** re-add `export *` beside the explicit block.

---

## TUI agent config split

**Paths:** `src/shared/tui-agent-config.ts`, `src/shared/tui-agent-config-table.ts`, `src/shared/tui-agent-config-types.ts`

**Decision:** the fork's three-module split stands, and upstream's edits to the config table are
ported into `tui-agent-config-table.ts` by hand — in this sync, `rovo` becoming `detectCmd: 'acli'`
with `launchCmd: 'acli rovodev run'`.

**Why:** upstream keeps a single 381-line file the fork split for the line budget, so a table edit
upstream lands in `tui-agent-config.ts` while the fork's copy is in the `-table` module. The merge
shows no conflict for either module, which is what makes this one easy to miss.

**Do not:** accept a clean merge here as "nothing to port" — diff the table between the pinned base
and upstream at every sync.

---

## Pane-scoped cache helpers

**Paths:** `src/shared/agent-hook-listener/pane-scoped-cache-entries.ts`, `src/shared/agent-hook-listener/listener-state.ts`

**Decision:** upstream's `pane-scoped-cache-entries.ts` is the module; the fork's
`pane-scoped-cache-keys.ts` (same four exports, different order) is deleted and `listener-state.ts`
imports only from `-entries`.

**Why:** both sides added the same helpers after the pinned base, and the merge left both imports in
`listener-state.ts`, which is a duplicate-identifier error rather than a silent choice.

**Do not:** keep a second module for the same four helpers.

---

## File-explorer cache enumeration

**Paths:** `src/renderer/src/components/right-sidebar/file-explorer-watch-*.ts`, `src/renderer/src/components/right-sidebar/file-explorer-watcher-reconcile.ts`

**Decision:** upstream's shape wins — `cachedDirKeys` / `cachePathIndex()` /
`purgeDirCacheSubtrees(..., { cache, keys })` — and the fork's parallel one-enumeration variant
(`cacheKeys()`, `priorScan`, `hasCachedDirectoryLink(cache, keys)`) is dropped.

**Why:** both implement the same "enumerate the cache once per payload" optimization, landed
independently; upstream's `createCachedDirPathIndex(cache, keys = Object.keys(cache))` already accepts
pre-computed keys, so the property the fork measured is preserved.

**Do not:** restore the second variant — it re-litigates the same idea every sync.

---

## Linked work items: the worktree-meta dialog

**Paths:** `src/renderer/src/components/sidebar/WorktreeMetaDialog*.tsx`,
`src/renderer/src/components/sidebar/Worktree{[LinkedItems]Field,LinkedItemRow,ReferenceStack}*`,
`src/renderer/src/components/sidebar/{use-worktree-meta-*,worktree-attachment-editing,workspace-*attachment*,use-workspace-reference-*}`,
`src/renderer/src/components/sidebar/WorkspaceAttachment*`

**Decision:** upstream's linked-items model is the dialog. `WorktreeMetaDialog.tsx` is a 9-line
owner-keyed shell over `WorktreeMetaDialogDraft.tsx`, which renders `WorktreeLinkedItemsField` over a
`WorkspaceAttachment[]` draft and saves through `buildWorkspaceAttachmentEdits`. **Jira is a
first-class attachment provider on upstream's side** — `provider: 'jira'` with `jiraIdentifier` and a
routing `taskSourceContext`, the `jira-issue` composer kind, and a site-aware source
(`use-jira-url-source.ts` + `use-jira-source-connection.ts`) that offers an account chooser when
several connected sites match and whose search rows also resolve a bare key. The fork's own
Jira-link implementation (PRs #52/#64: `use-worktree-issue-link.ts`, `WorktreeIssueLinkField.tsx`,
`worktree-issue-displacement.ts`, `worktree-meta-updates.ts` and the dialog-side helpers that sat on
them) is **deleted** — upstream's `b1cd85820b` landed the same feature in the same week, and its
model is a superset (many items per workspace, an attachment composer, origin tracking).

**Why:** the two implementations were one idea built twice, and a merge of them cannot be
"union"-ed: the fork's `Issue` field displaces one link, upstream's composer accumulates many. The
fork owner chose upstream's model on 2026-10-09 after the alternative (re-seating upstream's rework
into the fork's dialog) was priced.

**What the fork keeps.** One rule had no upstream counterpart and was re-homed to
`workspace-issue-unlink-updates.ts`: `buildIssueUnlinkUpdates`, which the Jira **issue pane**
(PR #64, `right-sidebar/use-linked-issue-pane-actions.ts`) uses, clears the GitHub number, the
Linear key and the created-from `linkedWorkItem`/`linkedTaskSourceContext` **together** on Unlink —
a workspace holds one issue, so the pane cannot clear only the slot it renders.

**The merge-readiness marker is the second thing to re-seat.** `ReviewIconWithMergeMarker`
(`worktree-review-helpers.tsx`) and the `hostedReviewMergeVerdictLabel` suffix live on whatever
renders a review glyph, and upstream moved that from the card's metadata row into
`WorktreeReferenceStack.tsx` — so a merge that only resolves conflicts silently drops the marker.
Both sites are now covered: the stack's glyph and its single/summary labels, plus
`WorktreeCardStatusSlot`'s status lane, where a collection checks summary owns the checks half of
the label and only the merge reason is appended.

**Do not:** reinstate the fork's dialog modules, or drop `buildIssueUnlinkUpdates`/the marker
because a conflict did not point at them.

**Named follow-up (2026-10-09):** the fork's bare-key *direct* add (type `ABC-123`, press Enter) and
its site-ambiguity copy were not ported into upstream's composer — upstream resolves a bare key
through its search rows instead. Re-add only if that extra step proves annoying.

---

## SSH settings pane: upstream's inline card wins, hidden hosts ride on top

**Paths:** `src/renderer/src/components/settings/SshPane.tsx`, `SshTargetCard.tsx`,
`SshTargetList.tsx`, `SshTargetVisibilityToggle.tsx`, `ssh-target-visibility.ts`

**Decision:** `SshPane.tsx` and `SshTargetCard.tsx` take upstream's post-relay shape — an inline,
self-contained card with no terminate-sessions or reset-relay buttons, `sshTargetConnectFailureText`
for connect errors, and a direct `window.api.ssh.removeTarget({ id })`. The fork's
hide-auto-imported-hosts feature (PR #9, `cad3e4df59`) is re-expressed on top as an
`onSetHidden(hidden)` prop, a "Hidden" badge, and a `SshTargetVisibilityToggle` that replaces the
trash button for `isAutoImportedSshTarget` hosts. The collapsible "Hidden (N)" section stays in the
fork-only `SshTargetList.tsx`, so the fork's change to upstream's `SshPane.tsx` is one block swap.

**Why:** the relay is gone on this branch, so `onResetRelay`/`onTerminateSessions` had no meaning
left, and keeping the fork's parallel `SshTargetCardActions.tsx` would have re-conflicted at every
sync against a card upstream had already flattened. Hiding is a separate, still-shipping fork
feature: a discovered `~/.ssh/config` host could only be removed and the next import brought it
back, so Hide is the durable "not on this machine's Orca". Losing its entry point would have been a
regression of a merged PR, not a tidy-up.

**Do not:** reintroduce `SshTargetCardActions.tsx` or a second list component —
`SshTargetServerList.tsx` was a duplicate of `SshTargetList.tsx` and is deleted; or drop
`onSetHidden`/the toggle when upstream rewrites the card again.

---

## Max-lines budget pressure

**Paths:** `.oxlintrc.json`, `config/max-lines-baseline.txt`, `src/cli/handler-group-manifest.ts`, `src/shared/protocol-version.ts`, `src/main/rate-limits/service/service-full-cycle-preparation.ts`, `src/renderer/src/components/right-sidebar/FileExplorer.tsx`

**Decision:** upstream keeps several files at exactly the `.ts` budget (300 non-blank, non-comment
lines), so **any** fork addition to one of them overflows and fails `oxlint` — no conflict marker
shows it, and `pnpm tc` does not either. The 2026-10-13 sync hit four: the Linear handler groups
moved to `linear-handler-groups.ts` (mirroring upstream's own `browser-handler-groups.ts`, which also
buys headroom); the fork's two-line `WORKSPACE_PATH_SEARCH_NAME_FILTER_RUNTIME_CAPABILITY` alias was
replaced by the contract's own name; and two wrapped constructions were collapsed.

**Why:** the file is upstream's, so the fork cannot shrink upstream's half; the fork's own addition is
always the line that has to go or move.

**Do not:** add a `max-lines` disable or a `config/max-lines-baseline.txt` entry (AGENTS.md forbids
the first, and the ratchet exists to fail the second). **Do not move a declaration out of
`src/shared/protocol-version.ts` without checking `config/scripts/mobile-web-bundle-manifest.mjs`** —
it regex-scrapes `runtime-protocol-versions.ts` for `RUNTIME_PROTOCOL_VERSION`, and the 2026-10-11
split broke `readProtocolWindow()` that way.

**2026-10-15 addendum.** upstream moved the whole inline capability list out of
`src/shared/protocol-version.ts` into `runtime-capability-constants.ts` and the five `ACCOUNT_*`
names into `account-runtime-capabilities.ts`, while the fork's own split of the version numbers into
`runtime-protocol-versions.ts` stays load-bearing. The merged file is upstream's shape plus three
fork lines (`export * from './runtime-protocol-versions'`, the `HOST_SETTINGS_REPLICATION` and
`WORKSPACE_PATH_SEARCH_NAME_FILTER` capabilities), which lands at 256 lines instead of 435. The same
sync overflowed `src/renderer/src/runtime/runtime-jira-client.ts` by 8 lines, so `jiraListEditFields`
now lives in `runtime-jira-detail-client.ts` as `jiraListEditFieldsForTarget` and is re-exported —
mirroring upstream's own split of that file.


**2026-10-16 addendum.** `src/renderer/src/components/sidebar/worktree-list/listing/use-section-rows.ts`
overflowed the `.ts` budget by 26 lines once the fork's same-branch merge was re-expressed on
upstream's `buildSidebarRowPlan` shape, and the pre-commit hook caught it before the merge commit
existed. Split, per the standing remedy: `rendered-sidebar-row-keys.ts` took the rendered-row key
collector and `use-merged-sidebar-rows.ts` took the merge policy plus its dependency list, leaving
`use-section-rows.ts` at 295 raw lines. This is the same shape as the five splits of the
2026-10-15 sync — upstream keeps a file at the budget, so the fork's addition is the line that
moves.

---

## The Jira product line: upstream's shape, the fork's extra capabilities

**Paths:** `src/main/jira/*`, `src/main/ipc/jira.ts`, `src/renderer/src/runtime/runtime-jira{,-client,-detail-client,-board-client,-text-fields}.ts`,
`src/renderer/src/components/{JiraIssueWorkspace,jira-issue-assignee-control,jira-issue-workspace-*}.tsx`,
`src/renderer/src/components/task-page/jira/*`, `src/shared/{jira-types,jira-transition-fields,jira-runtime-capabilities}.ts`

**Decision (2026-10-15, fork owner):** upstream spent the same window building the same Jira features
the fork built — assignee search and "Assign to me" (`#28612`), a board and current-sprint filter
(`#28633`), required transition fields (`#28588`), planning columns (`#28615`), linked-workspace views
(`#28590`) — so this sync converged **per capability, not per feature**: take upstream's shape
whenever it is a superset, and re-express every fork addition on top of it rather than dropping it.

**Settled here:**

- `JiraTransition.requiredFields` is **gone**; the canonical field is upstream's `fields`. The fork's
  one rule inside it — a required field Jira will default itself is not the user's to fill — is
  re-homed into `src/shared/jira-transition-fields.ts` as the `hasDefaultValue !== true` exclusion in
  `requiredTransitionFields`, so upstream's `classifyTransitionRequirements` inherits it.
- `jira-transition-queries.ts` takes upstream's version wholesale (its `strict` mode, the
  400/403/404 fallback off the `expand=transitions.fields` call, and `columns` on the status order).
- **`JiraApiError` has one declaration, in `authenticated-request.ts`.** Upstream split a second
  class into `jira-api-error.ts`, whose `toJiraApiError` is called by nothing in the merged tree while
  every real `instanceof JiraApiError` site (`client.ts`, `credential-verification.ts`,
  `attachment-images.ts`, `jira-issue-mutations.ts`, `jira-transition-queries.ts`) tests the fork's
  class — so two classes would have made auth classification depend on which module threw. That file
  now re-exports the single class, and the constructor accepts upstream's positional boolean for
  `scopeMismatch` as well as the fork's detail object, so upstream's own test call site is unchanged.
- `JiraIssueUpdate` carries both `transitionComment` (upstream) and the fork's
  `transitionUserFieldKeys` / `transitionTextFieldKeys` / `customFields` / `userFieldKeys` /
  `textFieldKeys` / `sprintId`.
- `jiraAddIssueComment` gained an **optional** `bodyFormat` — required would have broken upstream's
  four-argument call site, and omitting it is the pre-composer "store verbatim" behaviour.
- `src/shared/jira-runtime-capabilities.ts` now **re-exports** upstream's Jira capability names from
  `jira-detail-capabilities.ts` instead of re-declaring `JIRA_USER_FIELDS_*`, so each name has one
  declaration; its `JIRA_RUNTIME_CAPABILITIES` array holds only the fork-only text-fields capability.
- `JiraIssueAssigneeControl` keeps **upstream's prop contract** (`issue`, `disabled`, `sourceContext`,
  `owner`, `runtimeContextKey`, `mutateIssue`) because that is what carries host/source awareness, and
  preserves the fork's pin-me-and-my-team ordering inside it: the picker's empty-query lookup result
  is remembered as the project roster and pinned above every later search's matches. The fork's
  "roster arrives in a prop, so opening the picker costs no request" optimisation is **not** kept —
  upstream's control fetches on open, and one request per open is its accepted cost. The pinned
  roster is also **sorted by display name**, not left in Jira's returned order as the fork had it:
  upstream sorts candidate rows by name, and the pinned group is a prefix of that same list rather
  than a separately-ordered one. Both suites' ordering assertions hold only with the sort, and the
  feature the fork's tests lock — *me and my team above the matches* — is unaffected by it.
- Fork-only capability with no upstream counterpart is kept: self-hosted Jira Server/DC **body
  rendering** (`jira-rendered-html.ts`, the `renderedHtmlOnly`/`htmlOptions` path, the wiki comment
  write), editmeta-driven custom-field editing (`jira-issue-edit-metadata.ts`), the generic
  schema-driven transition-fields dialog (`TransitionFieldsDialog.tsx` — upstream handles only
  resolution + comment and calls anything else `unsupported`), the configured agile board with
  drag-drop transitions (`task-page/jira/Board.tsx`), sprint assignment, board settings, and the
  priority tone.

- **The Task view uses one shared linked-workspace resolver — strict first, permissive fallback.**
  `findJiraIssueWorkspaceAttachmentForIssue(workspaces, issue, source)`
  (`jira-issue-workspace-attachment.ts`) tries upstream's strict
  `findJiraIssueWorkspaceAttachmentsInIndex` (host, account, project and site scoped, most-recent
  ordering) and only then the fork's `findJiraIssueWorkspaceAttachment` URL-identity finder.
  `findJiraIssueWorkspaceAttachmentInIndex` and `openJiraIssueWorkspaceOrStart` both call it, so the
  label, the row chip, the board chip and the button's **action** cannot disagree — an earlier round
  had the label strict and the action permissive, so a link from another host or one naming no site
  read "Start workspace" while clicking it opened an existing workspace. **Why the fallback is kept:**
  the fork's permissive matcher is deliberate leniency for links recorded before sites were stored,
  pinned by `jira-issue-workspace-attachment.test.ts` ("still matches when one side names no site"),
  which upstream's strict predicate would refuse. **Do not** collapse this to one matcher without
  settling that case. Two call sites are settled by name: the **default Jira list** must consume the
  same resolver **and** `issueWorkspaceAttachmentIndex` — the merge had dropped the fork's title-line
  chip from it while the backlog list kept it, so a no-site link offered a plain "Start workspace"
  (opening a duplicate) on the row and "Open <workspace>" in the sheet; and
  `collectLinkedJiraIssueRefs` deliberately keeps **strict site resolution**, because it maps an
  attachment to a site+key for the Linked view to fetch under, and the permissive fallback is a
  workspace-identity heuristic that cannot supply a site to fetch with. **The row keeps BOTH
  affordances, and that is the settled shape:** the fork's title-line chip, its open-or-start button
  and a visible copy-menu button, **plus** upstream's `JiraLinkedWorkspaceAction` picker whenever the
  resolver returns **more than one** linked workspace — count badge, one entry per workspace, and
  "Start new workspace". Both surfaces that render the chip (the default list and the configured
  board's backlog) must pass the same three props. Four consecutive review rounds each fixed one side
  of this row by displacing the other (the chip, then the picker); **do not resolve this row by
  choosing between them again** — an issue linked from two workspaces must reach both, and start a
  third. Both open paths share `openJiraIssueWorkspace`, which passes `executionHostId` (upstream's
  picker omitted the host, which is wrong when one worktree id exists on two hosts).
- **The row's final shape is a split button, and the owner chose it (2026-10-15).**
  `JiraIssueWorkspaceSplitAction.tsx` is one control: the body's default click is the fork's
  open-or-start (open the linked workspace, or start one when none is linked — exactly the pre-sync
  behaviour), and the caret **or a 500 ms press-and-hold on the body** opens one menu listing every
  linked workspace plus "Start new workspace". Every workspace entry opens on its own host. Superseding
  `JiraLinkedWorkspaceAction` (deleted) is what makes all of it fit: the split control is a **constant
  36 px** (24 px body + 12 px caret, the count badge replaced by the caret's `aria-label`), so
  `split + gap + open-in-Jira = 64 px` — an **exact fit** for the backlog's 64 px column, 8 px slack at
  72 px and 40 px slack in the list's 104 px. No grid template or minimum width changed, which is what
  the four prior rounds could not achieve by adding controls.
- **The visible copy button is now contextual, and that is the owner-authorised trade-off.** Copy
  moved to the row's right-click menu because a visible copy button needs 24 + 4 px more, i.e. a 92 px
  split that cannot fit the 64 px backlog column the owner forbade widening. Copy stays discoverable
  and no menu item was removed. **Do not** re-add it as a visible button without also revisiting the
  column width — the arithmetic is the reason it is not one.
- **The transition toast is a caller opt-out, not a field-name rule.** `mutateIssue` takes
  `options?: { reportsInline?: boolean }` and toasts unless the caller sets it; only the sheet's
  transition control does, because it renders the error itself. An earlier round keyed the skip on
  `field === 'transition'` and made the right-sidebar pane's status row fail **silently** — it has no
  inline error display, so it must keep the toast. **Rule:** whether a failure is reported inline is a
  property of the *surface*, never of the field name.
- **Upstream's orphaned Jira detail hooks are deleted, and their transitions state is folded in —
  and this deletion is invisible to `post-sync.mjs`.** `use-jira-issue-workspace-data.ts`,
  `use-jira-issue-remote-details.ts` and `use-jira-issue-comment-submission.ts` (plus the orphaned
  `useJiraIssueWorkspaceActions` export) had no importers after the merge; the comments behaviour was
  already covered by the fork's `jira-issue-workspace-comments.ts`, and the one behaviour that lived
  **only** in the dead data hook — real `transitionsLoading` / `transitionsError` for the transition
  control's spinner, error and Retry — is re-implemented in `jira-issue-workspace-side-data.ts`.
  The reason this is recorded rather than just done: `post-sync-checks.mjs`'s orphan scan
  (`deletedForkModules`) only looks at *fork* files, so it cannot see an orphaned **upstream** module,
  and the next sync would re-import these three while silently dropping the transitions state again.
  **Follow-up:** extend that scan to upstream files, which is the general form of this gap.

**Named follow-up:** `task-page/jira/Content.tsx` now has **two** board surfaces — the configured
agile board (`jiraBoardViewMode` + `board.viewMode`-style preference, drag-drop transitions) and
upstream's ad-hoc status board over the current result set (`jiraViewMode`, current-sprint filter,
host-targeted). Both are deliberate for now; unifying them into one control is a UI decision that
should not be made inside a sync.

**Do not:** re-litigate the Jira overlap per sync. The fork's implementations of the assignee,
board, sprint-filter and required-fields ideas are the ones upstream superseded; re-adding them means
re-resolving these same 30 paths next time.

---

## Tabs slice: upstream's module split keeps the fork's one action

**Paths:** `src/renderer/src/store/slices/tabs/{create-tabs-slice,tabs-slice-contract,tabs-split-ratio-actions,tabs-branch-group-host-actions}.ts`

**Decision:** upstream deleted `tabs-secondary-actions.ts`, splitting `setTabGroupSplitRatio` into
`tabs-split-ratio-actions.ts` and dropping `copyUnifiedTabToGroup`/`mergeGroupIntoSibling` outright.
The fork's addition to that file was a single action, `setBranchGroupHost`, which the merged contract
still declares and which the fork-only `WorktreeBranchHostSelect.tsx` /
`use-branch-group-host-selection.ts` still call — so it survives as
`tabs-branch-group-host-actions.ts` (`createTabsBranchGroupHostActions`), wired into
`create-tabs-slice.ts`. The old file name would have described one action among its removed
neighbours, hence the rename.

**Why:** a `modify/delete` conflict whose only fork content is one action is not a reason to keep the
whole module; accepting upstream's deletion silently would have left `setBranchGroupHost` declared
and uninitialised, which no conflict marker showed.

**Do not:** re-add `copyUnifiedTabToGroup`/`mergeGroupIntoSibling` from the fork's copy of the deleted
file — upstream removed them, and nothing in the merged tree calls them.

---

## Automations: upstream retired its own Orca/Hermes target, and the fork's label went with it

**Paths:** `src/renderer/src/components/automations/**`

**Decision:** upstream deleted the whole external-automation / Hermes-target subsystem in this
delta — `automation-hermes-save.ts`, `hermes-cron-output-parse.ts`, `ExternalAutomationRunTable.tsx`,
`automation-external-target-match.ts`, `HermesCronOutputView.tsx` and their tests all exist at the base
and at the fork tip but not upstream, and upstream rewrote the ~77 surrounding files (≈2,455 deleted
lines). The fork's **only** contribution anywhere in that feature was `cd3e64b6cf`
(`local(identity)`) substituting `APP_DISPLAY_NAME` for the app name in the create-target toggle, so
nothing fork-owned is lost: the retired `AutomationCreateTarget` / `isHermesCreate` / `isEditingExternal`
identifiers had zero remaining referents in the merged tree, and the orphaned `APP_DISPLAY_NAME`
import in `AutomationEditorDialogHeader.tsx` was removed.

**Why this is checked rather than assumed:** a whole subsystem vanishing as staged deletions in a
merge looks identical to the merge silently discarding fork work. The test that separates them is
`git cat-file -e <base>:<path>` / `HEAD:<path>` / `upstream/main:<path>` — a file present on both
local sides and absent upstream was upstream's to retire.

**Do not:** resurrect the Hermes automation target, and do not re-add `APP_DISPLAY_NAME` to the
automations UI — upstream's replacement, whatever it becomes, owns that surface now.

---

## Runtime file commands: upstream's composition, with the fork's path search re-homed

**Paths:** `src/main/runtime/orca-runtime-files.ts`, `src/main/runtime/runtime-file-commands-workspace-path-search.ts`,
`src/main/runtime/runtime-file-command-surface.ts`

**Decision:** upstream replaced the fork's file-command **inheritance chain** with **composition** —
`RuntimeFileCommands` in `orca-runtime-files.ts` now holds `search`/`access`/`reads`/`mutations`/
`watches` sub-objects built from `files/*`, and deleted `runtime-file-command-access.ts`,
`runtime-file-search.ts`, `runtime-file-command-host.ts` and `runtime-file-command-target.ts`. The
fork's `searchWorkspacePathNameFilter` (the negotiated `files.searchPaths` name filter the web and
paired clients use) lived only in `runtime-file-commands-workspace-path-search.ts`, which inherited
from the deleted `runtime-file-search.ts` — so the merge left it with three dangling imports **and**
no caller, while `runtime-file-command-surface.ts` still required the method and
`rpc/methods/files.ts` still called it. It is now a composed unit on `RuntimeFileCommands`
(`this.workspacePathSearch`), delegating through the same `Parameters<...>` style the other search
methods use, with its imports re-pointed at `files/search/file-search`, `files/file-command-host` and
`files/file-target`.

**Why this was easy to miss:** no conflict marker pointed at it. The orphan only shows up as a
fork-only module that no longer has an importer. **Follow-up:** add the sweep to
`local/sync/post-sync.mjs` — take every path in the pre-sync fork-only inventory under `src/`
(no tests/fixtures), resolve every `from './x'`, `import './x'` and `from '@/x'` specifier in the
tree, and report each fork-only file nothing references. Run on 2026-10-15 it found exactly this
module plus four pre-existing dead files (`task-page-jira-board-page-state.ts`,
`quick-open-path-inventory-limits.ts`, `workspace-path-search-request-budget.ts`, already
unreferenced at the fork tip), so the check needs an allowlist for known-dead paths and for worker
entries loaded by path (`workspace-path-index-benchmark-worker-entry.ts`).

**Do not:** rebuild the old inheritance chain; add new file-command units as composed fields here.

---

## Quick Open list-target helpers: upstream's pair, the fork's duplicate deleted

**Paths:** `src/renderer/src/components/quick-open-file-list.ts`,
`src/renderer/src/components/quick-open-file-list-target.ts` + `quick-open-nested-worktrees.ts`
(upstream), `src/renderer/src/components/runtime-file-list-scan-target.ts` (fork, **deleted**)

**Decision:** converge on upstream's pair. The two spell the same six helpers —
`NestedWorktreeExcludeRequest`, `RuntimeFileListTarget`, `getRuntimeFileListTarget`,
`getNestedWorktreeExcludeRequest`, `isNestedWorktreePath`, `getNestedWorktreeExcludePaths` — with no
capability difference; upstream split them across two modules, the fork kept one. `quick-open-file-list.ts`
now imports upstream's `quick-open-file-list-target` and `quick-open-nested-worktrees`, and the fork's
`runtime-file-list-scan-target.ts` is deleted.

**Why it moved from "deferred" to "done" in the same sync:** the first pass left both because
re-pointing a fork-critical component late in a sync buys nothing for no behaviour change — but the
suite then showed a test asserting **function identity** across the two modules
(`expect(getRuntimeFileListTarget).toBe(fileListTarget.getRuntimeFileListTarget)`), which two distinct
exports can never satisfy. Equivalence was checked by diff against `upstream/main` before re-pointing:
the other four helpers are byte-identical and `isNestedWorktreePath` / `getNestedWorktreeExcludePaths`
are the two upstream moved into the nested-worktrees module.

**Do not:** re-add a fork-local copy of those helpers; import upstream's.

---

## Quality ratchets: runtime-electron, ts-nocheck, focus-read

**Paths:** `config/ts-nocheck-baseline.txt`, `config/focus-setting-read-baseline.txt`, `config/scripts/check-runtime-electron-ratchet.mjs`

**2026-10-16 addendum.** Three quality ratchets had to be settled, and the distinction between them
is the point: two were already red at the pre-sync tip and one was this sync's.

- **runtime-electron was this sync's, and is fixed.** Upstream's `createProviderAccountServices`
  makes orcad build `RateLimitService`, which statically reaches the fork's DeepSeek and Fireworks
  fetchers; both imported `net` from Electron. They now read the host HTTP port. Re-run at
  `e27bc2efbf` the ratchet is green, at HEAD it was red, so this one is on the sync.
- **ts-nocheck was pre-existing, and is now gone rather than recorded.** It reproduced identically
  at the pre-sync tip in a fresh worktree: `workspace-process-listing.ts` gained `@ts-nocheck` in the
  2026-10-15 sync, when its base class was re-pointed straight at the fork's
  `OrcaRuntimeWithSetupRunnerState`. The mixin has to stay in the chain (it carries
  `armWorktreeSetupRunner`/`reapWorktreeSetupRunnerState` for the whole chain; dropping it breaks
  ~40 concrete classes, verified by trying), but the suppression did not. **Upstream already declares
  the seven forward references in `workspace-process-listing-dependencies.ts`**, in a
  declarations-only layer the 2026-10-15 sync orphaned; chaining it —
  `OrcaRuntimeWithWorktreePsDependencies extends OrcaRuntimeWithSetupRunnerState`, and
  `OrcaRuntimeWithGetWorktreePs extends OrcaRuntimeWithWorktreePsDependencies` — is what closes the
  hole. The entry was recorded during the sync and removed by the review that found this.
  `workspace-process-listing.ts` is byte-identical to upstream's copy again: the fork's whole delta
  in this seam is the one parent change in the declarations layer, which is one file to reconcile at
  the next sync instead of two.
- **focus-read was pre-existing, and is recorded.** Four files added (one a `__mocks__` fixture the
  scanner does not exclude), one pruned; they are the owner-routing follow-up the ledger already
  carries for five other files.

**2026-10-16 — the owner-routing follow-up landed (issue #124), and the counts fell.**
`RuntimeJiraSettings` and `RuntimeLinearSettings` are now `OwnedSource`
(`TaskSourceContext | RuntimeClientTarget`, `src/renderer/src/lib/provider-source-target.ts`) instead
of `RowLessSource`, so the `default-scope` arm — and the Active Server read inside it — is gone from
`getJiraRuntimeTarget`/`getLinearRuntimeTarget` and from every wrapper that resolved through them.
`defaultScopeSource`, `rowLessSourceTarget` and `DefaultScopeSource` are deleted; a creation or
connection flow resolves `defaultCreationHost`, a settings scope resolves `defaultScopeHost`, and a
read surface resolves its resource's owner. The owner that genuinely differed from the focused host
was the right-sidebar linked-issue pane's — the workspace's creation-time task source when that task
is the same provider, else the workspace's own host — and that pane now carries **one** source: the store hydration, the
detail read, the property edit, the comment and the cache key it looks its issue up under all name
it, where before the hydration and the children could fall back to the focused server while the
detail read the workspace's. The task page's own board and detail capture the focused host as the
page's Jira/Linear account, so their behaviour is unchanged. The measured result: **1161 → 959
reads**, 19 of the 22 annotated rows removed, and no row raised. The **trap held** — the fix is to
memoise on the *primitive* host id rather than the model, the source object or the settings object,
because `TaskPageJiraBoard` re-creates its model on every store write and `JiraBoardSettings`
receives a new settings object on every settings write; a memo keyed on either would have re-fetched
the board each time. The board suite fails if that memo returns a fresh target. A memo that does key
on a source object keys on one a `use-task-page-detail-routing` memo already stabilised — except the
issue pane's: it derives its source from the workspace row through the sidebar's own resolver, so
the card and the pane cannot cache under different scopes, and holds it stable *by value*
(`useStableTaskSource`), because the active row is replaced on routine writes — a PTY bind bumps
`lastActivityAt` — and the panes refetch on their source's identity. Three rows survive at 1 read each
and name their cause in the baseline: the global default-Jira-board setting, and two *transitive*
readers that are not Jira/Linear surfaces at all (`openHttpLink`'s Link Routing; the agent-detection
owner resolver's focused-runtime fallback for a workspace whose owner has not hydrated).

The focus-read entries name their cause and their date. Do not add a ratchet entry without that, and
do not "fix" one by bumping a count: the focus-read counts exist to fall as the owner routing lands.
The ts-nocheck ratchet is back to its single grandfathered entry, and its baseline is the place a
future forward-reference chain has to justify itself — reach for the declarations layer first.
**This is also why `local/sync/post-sync.mjs` should run `verify:localization-catalogs`** — its
dotted-key check is what would have caught the stray top-level `settings.appearance.chat.title` that
the previous merge's union left beside the nested object, and post-sync's three localization checks
do not include it.
