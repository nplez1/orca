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
- A **`Paths:` glob must name what the entry decides.** A glob wide enough to catch the whole tree makes
  "this path has a decision" true everywhere and worthless — the Identity section was `src/**`, which
  matched 227 of the 233 pending conflicts. Narrow it, or say `**Reach:** catch-all` so nothing reads it
  as coverage.
- A **`Resolution:` line says what to do** with a matched conflict, not what the design is: `keep-ours`,
  `take-theirs`, `delete` (propose `git rm`), `rerere`, or `manual`. Prose cannot be executed, so a
  modify/delete conflict is currently re-decided by a human on every sync.

---

## SSH relay removal: upstream's orcad model wins

**Paths:** `src/relay/**`, `src/wsl-guest/**`, `src/shared/ssh-ai-vault-relay.ts`, `src/main/providers/ssh-filesystem-*.ts`, `src/main/runtime/runtime-file-commands-search-remote-quick-*`, `src/main/runtime/runtime-file-commands-workspace-path-search.ts`, `src/main/ipc/filesystem/filesystem-remote-path-search.ts`, `src/main/providers/ssh-filesystem-provider-crud.ts`, `src/main/ai-vault/remote-session-scanner-*.ts`

**Resolution:** take-theirs — upstream retired the relay, so their deletion of these files wins and the
fork's SSH path-search stack goes with it

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

**Sentinel scope (2026-10-07 sync):** the floating-terminal _scope_ resolves through
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

**Addendum 2026-10-27 — the codex half of that decision is retired.** Upstream's
`codex-subagent-roster.ts` is the codex roster again (`CodexSubagentRoster`,
`getOrCreateCodexSubagentRoster`), restored byte-identical to the sync base with six files back to
zero fork hunks. `agent-descendant-roster.ts` keeps only the pi/claude descendant extras, so this entry
now governs those lanes and not the codex one. Reason: the rename cost a modify/delete plus importer
rewrites on every sync for no behaviour, and upstream's cap-removal port survives in upstream's own
file.

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
`claude-background-task-status.test.ts` (a running shell _and_ a cron → plain `working`, because the
running shell is agent work) and `server-claude-cancel-captures.test.ts` (a cron with the shell set
empty → `monitoring`).

**Accepted nuance:** upstream's _owed_ shell notification stays on the non-agent side, as upstream
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

**Decision:** the search catalogs live in `accounts-search.ts` — upstream's four (Grok, Cursor,
Antigravity, ZcodePlan) in upstream's order, then the fork's three (DeepSeek, Fireworks, Copilot) as
pure additions after them. Credential sections are split per provider; a pane that mounts
`OpenCodeGoCredentials` or a GLMT plan section needs those `window.api` doubles in its test.

**Why:** this was `accounts-search-extra-providers.ts` from 2026-10-15 until 2026-10-26, and the reason
then was the 300-line cap. The cap is now off (`max-lines` is `"off"` in every `.oxlintrc.json`), so a
split is no longer a reason to move upstream's code — and leaving upstream's entries where upstream has
them turns this file's next sync into an addition rather than a rival copy.

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

**Typed workspace labels name their own branch.** Upstream `9608420517b` (#32919) added
`src/main/worktree-create-branch-seed.ts`, which swapped a typed workspace label for a random
creature branch on the theory that first-work renaming would replace it later; both create paths
(`worktree-remote.ts`, `runtime-local-worktree-create-candidate.ts`) now fall through to
`effectiveSanitizedName`, and the module is gone (PR #251). **Do not** re-apply the seed when
resolving that conflict: on this machine first-work renaming never fires, so the placeholder is
permanent. A blank name still gets a creature name for both, and the worktree meta carries
`branchNameWasGenerated` so a typed creature word (`nautilus`) is not renamed out from under the user
while a generated one still is.

**Open (found by the sync's review):** the same double-setup shape survives for an automation create
that _does_ carry a startup command — the spawner stages setup and
`provisionManagedWorktreeTerminals` runs it again with `hasStartupTerminal: false`
(`worktree-remote.ts`). Upstream at `8b0fa15e94` behaves the same, and no current caller reaches it
(the in-app automation dispatch passes no startup, and the other automation creates go through
`createManagedWorktree`), so it was not changed mid-sync. Fix it when an automation path grows a
startup command.

---

## Identity: this fork ships as Orca NP

**Paths:** `package.json`, `config/electron-builder.config.cjs`, `config/nsis/**`, `config/scripts/{build-notification-status-macos,check-upstream-identity-literals,computer-use-bundle-identity,dev-electron-bundle-identity,smoke-packaged-cli,verify-agent-hook-stdin-lifecycle}.mjs`, `native/**`, `resources/**`, `mobile/**`, `src/cli/**`, `src/main/cli/**`, `src/main/{floating-workspace-launch-directory,home-directory-migration,macos-press-and-hold-default,macos-tcc-prompt-watch}.ts`, `src/main/{agent-hooks,ai-vault,jenkins,pi,runtime,skills}/**`, `src/main/{ipc/floating-workspace-directory,ipc/notification-system-settings-link,ipc/pty/host-env/assembly,startup/dev-instance-identity}.ts`, `src/renderer/src/components/settings/**`, `src/renderer/src/i18n/locales/en.json`, `src/shared/{agent-launch-remote,app-directory-names,app-display-name,local-build-compatibility-contract,orca-cli-command-name,orca-repository,orcad-artifacts,release-channel,tui-agent-config-table}.ts`, `src/shared/local-build-compatibility-contract.json`, `src/shared/rpc-contract/orchestration-params.ts`

**Resolution:** manual. The identity literal is `keep-ours`, but everything around it is upstream's, so
this is a hunk-level decision and a whole-file verb would revert upstream's work wholesale. The fork's
names, paths and bundle ids are the product, so they win wherever they appear — and nothing else in these
files is the fork's to hold. An edit that keeps a whole file because one literal is in it is how this
entry got a 227-path match.

**Reach:** wide by nature — identity is a rename, not a module, so it lands wherever a name, path or
bundle id is written (49 non-test files at 2026-10-26, 44 of them upstream-owned). It was `src/**`
until then, which matched 227 of the 233 pending conflicts and made "this path has a ledger decision"
worthless; it is now the files that actually carry an identity literal. Still do not read a match here
as "this conflict has a decision" — check whether a narrower section also matched.

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

## Dashboard delivery: a content-area view, not a drawer or a pop-out

**Paths:** `src/renderer/src/components/dashboard/AgentDashboard{Page,Drawer}*`,
`src/renderer/src/components/dashboard/agent-dashboard-open-mode*`,
`src/renderer/src/components/dashboard-popout/DashboardPopoutRoot*`,
`src/renderer/src/components/dashboard-popout/useDashboardSnapshot*`,
`src/renderer/src/components/dashboard/DashboardPopoutBridge*`,
`src/renderer/src/components/dashboard/useDashboardPopoutBridge*`,
`src/renderer/src/components/sidebar/AgentDashboard{SidebarHost,Drawer}*`, `src/renderer/src/popout.*`,
`src/preload/api/dashboard-api.ts`, `src/preload/api/dashboard-bridge.ts`

**Resolution:** delete

**Decision:** the Agent Dashboard is a first-class view (`AgentDashboardPage.tsx` rendered by
`AppWorkspaceShell.tsx:80` while `activeView === 'dashboard'`), and that view is the only delivery the
fork ships. This is a **product decision the owner made explicitly on 2026-10-26**: upstream's drawer
and pop-out window are not a better version of the fork's page, they are a different feature the fork
does not want. Both surfaces are therefore dead ends here, not candidates for restore.

The renderer half of upstream's delivery — the drawer, the sidebar host, `popout.html`/`popout.tsx`,
`DashboardPopoutRoot`, `useDashboardSnapshot`, the open-mode and bridge hooks — cannot be restored
inertly, and that is a structural fact rather than a preference: upstream's drawer needs
`AppState.agentDashboardDrawerOpen`, which #44 removed, and its `DashboardPopoutRoot` renders the same
`AgentKanbanBoard` the fork's live page renders, so restoring it puts a second live board over one
snapshot. The preload pair (`dashboard-api.ts`, `dashboard-bridge.ts`) only exists to publish
`window.api.dashboard`, which the fork's board stopped calling when it dropped the pop-out relay;
`dashboard-bridge.ts` type-checks itself against `PreloadApi['dashboard']`, so keeping it forces a
`dashboard` member onto `PreloadApi` for a runtime API that nothing registers.

**Do not:** measure this by restore-and-run. Restoring all 22 files was tried: 11 of 57 cases fail and
`tc:web` reports 29 errors, because upstream's renderer half has moved past the fork's. The number is
not a reason to change the decision — it is the cost of a delivery the fork rejected.

---

## Dashboard popout plumbing: upstream's bytes, held inert

**Paths:** `src/main/ipc/dashboard-popout.ts`, `src/main/ipc/dashboard-popout.test.ts`,
`src/main/window/dashboard-popout-window.ts`, `src/main/window/dashboard-popout-window.test.ts`

**Resolution:** take-theirs

**Decision:** these four are byte-identical to `upstream/main` and stay that way. They are dead —
nothing registers the IPC and nothing opens the window, because `electron.vite.config.ts` has no
`popout` entry and there is no `popout.html` to load. Holding them costs nothing (they typecheck and
their 33 cases pass) and removes four modify/delete conflicts, so a sync should take upstream's version
without reading it. The fork contributes nothing to these files and must not start.

**Do not:** wire them up to "carry" an upstream fix. They exist to merge cleanly, not to ship. The
preload halves that would have completed the wiring are deleted by the entry above, so a restore of
that wiring cannot compile.

---

## Agent board: click jumps to the workspace, ack takes no intent

**Paths:** `src/renderer/src/components/dashboard-popout/AgentKanbanBoard.tsx` (+ its test)

**Resolution:** manual

**Decision:** the fork's board differs from upstream's in behaviour, not only in routing, and every
difference is deliberate:

- **A card click follows `snapshot.cardClickAction`** — `'workspace'` (the default) dispatches
  `dashboardCardRevealArgs(card)` to the workspace, `'preview'` opens the in-board terminal dialog.
  Upstream always opens the dialog. The setting lives in `np-settings-types.ts` and is the fork's own.
- **Ack is 1-arg** (`onAckAgent: (paneKey: string) => void`, calling `onAckAgent(card.paneKey)`).
  Upstream's `AgentSubjectReadIntent` parameter arrived with the pop-out relay the fork deleted; the
  fork's store call is `acknowledgeAgents([paneKey])`, which has no intent concept.
- **No pop-out relays.** Upstream defaults `onAckAgent`/`onRevealAgent` to `window.api.dashboard.*`
  relays; the fork passes both from the page and deleted the relays.

This file is a 14-hunk conflict on every sync and `manual` is the honest resolution: a whole-file
`keep-ours` would revert upstream's unrelated board work, and `take-theirs` would revert the click
behaviour the owner chose. The comments that name the pop-out _are_ kept, because restoring upstream's
text would describe a renderer the fork no longer builds.

**Do not:** "modernise" the board to upstream's prop shape as a merge-cleanliness exercise. The relays
would have to come back for the defaults to mean anything, and that reverses the entry above.

---

## Pending PR-comment acknowledgements: no snapshot thread resolver

**Paths:** `src/renderer/src/components/right-sidebar/pr-comment-snapshotted-thread-resolver*`

**Resolution:** delete

**Decision:** #169 made the pending ack reply-only and removed
`PendingPRCommentAiAckGithubResolveTarget`, `PendingPRCommentAiAckGitlabTarget` and the
`githubResolveTarget`/`gitlabTarget` fields this resolver works against. It cannot compile without
resurrecting that model, and a dead file is not a reason to bring a removed capability back.
`local/sync/mergeability-plan.md` § 5 carries the same decision, and
`local/sync/expected-deletions.json` asserts it.

**Do not:** restore it to "keep the file present". Presence is only free when the file still compiles
against the tree it sits in; this one does not.

---

## Checks panel polling and review refresh

**Paths:** `src/renderer/src/components/right-sidebar/checks-panel/**`, `src/renderer/src/components/right-sidebar/source-control/review/**`, `src/shared/review-refresh-policy.ts`

**Decision:** upstream's visibility-driven refresh owns _when_ the panel refreshes —
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

**Open (named follow-up):** if the panel feels stale when a _new_ run appears, re-add the
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

**Named follow-up (2026-10-09):** the fork's bare-key _direct_ add (type `ABC-123`, press Enter) and
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

**2026-10-25 addendum.** The merge of `0571e45107` left seven files over budget, none of it
duplicated comment text (comments do not count toward the cap), so each was split or deduplicated:
`claude-status-line-slot.ts` took the status-line slot policy out of `src/main/claude/hook-settings.ts`;
`service-full-cycle-preparation.ts` now wraps the Antigravity promise in the existing
`trackSettledProviderResult` instead of an inline copy of it; `comments-display-mode-menu.tsx` took
the triage/timeline dropdown out of `comments-list.tsx`; `agent-status-assistant-text-source.ts` took
the generated `extractAssistantText` out of `src/main/pi/agent-status-handler-source.ts` (byte-identical
output); `settings-update-telemetry.ts` took the `settings_changed` and `agent_dashboard_enabled`
emitters out of `src/main/ipc/settings.ts`; `worktree-set-parent-selector.ts` took upstream's new
`worktree set` folder-parent and selector-recovery text out of `src/cli/handlers/worktree.ts`
(upstream sits at exactly 300; the fork's Jira link is the overflow); and
`index-project-setup-test-fixtures.ts` took the project fixtures and a `legacyProjectSetup` builder
out of `src/cli/index-project-setup.test.ts`.

**2026-10-26 reversal: the cap is off, and six of those splits are undone.** `max-lines` is now `"off"`
in all four `.oxlintrc.json` overrides, because the cap was making the fork evict _upstream_ code into
fork-owned files — a permanent conflict at the carve point plus a copy that silently drifts. Six blocks
went back into the upstream file they came from, verbatim from the merge base, and the sibling files are
gone:

| Back into                                                     | From                                      |
| ------------------------------------------------------------- | ----------------------------------------- |
| `src/renderer/src/components/status-bar/tooltip.tsx`          | `provider-rate-limit-window-sections.tsx` |
| `src/renderer/src/components/editor/CheckRunDetailsPanel.tsx` | `check-run-details-status.ts`             |
| `src/renderer/src/web/preload-api/web-filesystem-api.ts`      | `web-file-mutation-session.ts`            |
| `src/main/claude/hook-settings.ts` + `hook-service.ts`        | `claude-status-line-slot.ts`              |
| `src/renderer/src/components/settings/accounts-search.ts`     | `accounts-search-extra-providers.ts`      |
| `src/main/ipc/filesystem/watchers/filesystem-watcher-wsl.ts`  | `filesystem-watcher-wsl-snapshot.ts`      |

Each was upstream's code with no fork content beyond an `export` keyword, so the split bought nothing
once the cap went. Thirty-one other splits were examined and left alone because the block carries fork
code, was restructured rather than moved, or upstream has since changed it — the measured table is in
the 2026-10-26 analysis. **A split whose block is fork-authored is not affected by this:** that file is
the fork's own and stays.

---

## The Jira product line: upstream's shape, the fork's extra capabilities

**Paths:** `src/main/jira/*`, `src/main/ipc/jira.ts`, `src/renderer/src/runtime/runtime-jira{,-client,-detail-client,-board-client,-text-fields}.ts`,
`src/renderer/src/components/{JiraIssueWorkspace,jira-issue-assignee-control,jira-issue-workspace-*}.tsx`,
`src/renderer/src/components/task-page/jira/*`, `src/shared/jira/{jira-types,jira-transition-fields}.ts`, `src/shared/jira-runtime-capabilities.ts`

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
  feature the fork's tests lock — _me and my team above the matches_ — is unaffected by it.
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
  property of the _surface_, never of the field name.
- **Upstream's orphaned Jira detail hooks are deleted, and their transitions state is folded in —
  and this deletion is invisible to `post-sync.mjs`.** `use-jira-issue-workspace-data.ts`,
  `use-jira-issue-remote-details.ts` and `use-jira-issue-comment-submission.ts` (plus the orphaned
  `useJiraIssueWorkspaceActions` export) had no importers after the merge; the comments behaviour was
  already covered by the fork's `jira-issue-workspace-comments.ts`, and the one behaviour that lived
  **only** in the dead data hook — real `transitionsLoading` / `transitionsError` for the transition
  control's spinner, error and Retry — is re-implemented in `jira-issue-workspace-side-data.ts`.
  The reason this is recorded rather than just done: `post-sync-checks.mjs`'s orphan scan
  (`deletedForkModules`) only looks at _fork_ files, so it cannot see an orphaned **upstream** module,
  and the next sync would re-import these three while silently dropping the transitions state again.
  **Follow-up:** extend that scan to upstream files, which is the general form of this gap.

**Named follow-up:** `task-page/jira/Content.tsx` now has **two** board surfaces — the configured
agile board (`jiraBoardViewMode` + `board.viewMode`-style preference, drag-drop transitions) and
upstream's ad-hoc status board over the current result set (`jiraViewMode`, current-sprint filter,
host-targeted). Both are deliberate for now; unifying them into one control is a UI decision that
should not be made inside a sync.

**2026-10-22 — the required-fields half of that follow-up landed, on the fork's shape.** Adopting
upstream `#28588`'s classifier on the detail pane and the ad-hoc board reintroduced a `local(jira)`
regression rather than converging anything: it collected only `resolution` + `comment` and refused
every other required field, including fields the issue already fills, because Jira's `required` flag
describes the transition screen and not the issue. The two boards are still two surfaces; what is now
shared is the fields collector — one form, seeded from the issue's own values, on all three surfaces.
The patch and its anchors are in [LOCAL-PATCHES.md](../../LOCAL-PATCHES.md) § `local(jira)`. The two
board surfaces stay as they are.

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
fork-only module that no longer has an importer. **Follow-up — done 2026-10-27.** `post-sync.mjs` now runs `unreferenced-fork-modules`, built on
`lib/orphan-sweep.mjs`: every fork-only path under `src/` (no tests, no fixtures) checked against the
specifiers every tracked source file carries, including the `@/` and `@renderer/` aliases. Run on
2026-10-27 it found this module plus four pre-existing dead files (`task-page-jira-board-page-state.ts`,
`quick-open-path-inventory-limits.ts`, `workspace-path-search-request-budget.ts`, already unreferenced
at the fork tip) — all four are now deleted (§ 4.9 of the plan). Two limits it states rather than hides:
a cycle of two files that only import each other reads as live, and entries loaded by path
(`…benchmark-worker-entry.ts`) need the allowlist argument.

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
memoise on the _primitive_ host id rather than the model, the source object or the settings object,
because `TaskPageJiraBoard` re-creates its model on every store write and `JiraBoardSettings`
receives a new settings object on every settings write; a memo keyed on either would have re-fetched
the board each time. The board suite fails if that memo returns a fresh target. A memo that does key
on a source object keys on one a `use-task-page-detail-routing` memo already stabilised — except the
issue pane's: it derives its source from the workspace row through the sidebar's own resolver, so
the card and the pane cannot cache under different scopes, and holds it stable _by value_
(`useStableTaskSource`), because the active row is replaced on routine writes — a PTY bind bumps
`lastActivityAt` — and the panes refetch on their source's identity. Three rows survive at 1 read each
and name their cause in the baseline: the global default-Jira-board setting, and two _transitive_
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

**2026-10-19 addendum.** Upstream added a seeded reader — `resolveOwnerWithLegacyFallback` — whose
legacy branch returns the focused runtime from an object literal, so every function returning its
result is a focus read by discovery. Two fork surfaces became readers through it:
`SessionSummaryPane.tsx` and `session-summary-subject.ts` (2 each, via the worktree owner resolver).
Recorded, with the cause and the date, rather than re-routed mid-sync: the pane genuinely asks the
worktree owner resolver for the active workspace's host, and an unstamped legacy row has no named
owner to resolve — switching to `getKnownExecutionHostIdForWorktree` there would turn the pane's host
into `null` for those rows. The owner-routing follow-up (#124) still owns the reduction.

---

## 2026-10-18 sync (upstream `fc24ac3715`, 628 commits)

The largest delta since the merge strategy started, and the one that moved two subsystems onto
upstream's shape outright. Merge base `ac015cd3b2`, pre-sync tip `12545ad17e`, 89 conflicted paths
(`both-rewrote 52, union 29, duplicate-tail 5, rename-prey 2, modify/delete 1`).

### AI Vault parse cache: upstream's SQLite database wins, and the legacy import accepts both lineages

**Paths:** `src/main/ai-vault/session-parse-cache-*.ts`, `src/main/ai-vault-search/**`

**Decision (owner, 2026-10-18).** Upstream replaced the single JSON snapshot file with a per-row
SQLite database (`session-parse-cache-database.ts`, layout version 4) plus a one-shot legacy importer,
and deleted the fork's `session-parse-cache-snapshot-serialization.ts` (which had reached JSON schema
6). Upstream's storage wins and the fork's serializer is deleted — nothing in the merged tree imported
it. The fork's capability in that seam rides inside the row's `session` JSON: the `subagent` /
`subagentTranscriptCount` fields on `AiVaultSession`, so no extra column and no second serializer.

The legacy importer's gate is widened to `LEGACY_JSON_SCHEMA_VERSIONS = [4, 6]` — 4 is the last JSON
schema upstream shipped, 6 the last this fork shipped, so a fork install keeps its cache instead of
cold-scanning once. **5 is deliberately skipped**: it titled Copilot sessions from injected context,
and 6 exists to invalidate exactly those rows.

**Do not:** reintroduce a JSON snapshot serializer, keep two caches, or bump the DB layout version on
the fork's schedule. `SESSION_PARSE_CACHE_SCHEMA_VERSION = 4` versions the _database_ layout, whose
first fork build is this one.

### `setupScriptLaunchMode` is retired; the host still stages its own Setup tab

**Paths:** `src/main/ipc/worktree-remote.ts`, `src/shared/global-settings-*`, `src/main/orca-profiles/host-sync-settings-disposition.ts`

**Decision.** Upstream deleted `setupScriptLaunchMode` from `GlobalSettings` and strips it on load
(see its `docs/automated-setup-tab-design.md`). The fork's default was `new-tab` — the host spawns a
dedicated Setup terminal and hands the window no `setup` payload — and that behaviour is what remains:
`canSpawnSetupWithoutStartup` is now `setup !== undefined`, with no launch-mode read and no
split-vertical/horizontal branch. The field is gone from the host-sync disposition map too.

`src/renderer/src/lib/worktree-activation.test-fixture.ts::setLegacySetupScriptLaunchMode` and
`worktree-creation-background-mount.test.ts` keep writing the retired key on purpose: they are the
regression fixtures proving all three former locations now produce one tab.

### The sidebar row model is upstream's object plan, with the fork's same-branch merge on top

**Paths:** `src/shared/sidebar-list/**`, `src/renderer/src/components/sidebar/worktree-list/**`

**Decision.** `row-types.ts`, `group-keys.ts` and `host-section-rows.ts` moved to
`src/shared/sidebar-list/`; the positional `buildSidebarRowPlan` is now `planSidebarRows(...)` with a
`.render(collapsedGroups)` method; `rendered-row-keys.ts` replaces the fork's
`rendered-sidebar-row-keys.ts` (deleted). The fork's `mergeSameBranchRows` is unchanged and still runs
on the plan's rendered rows through `useMergedSidebarRows`.

**Do not** re-add a fork-local copy of a moved module. Import the shared path; the modules are shared
so main, renderer and mobile agree on row identity.

Two known artefacts of the merge, recorded rather than fixed: a merged-away sibling that was its
section's last child leaves the survivor's `isLastLineageChild` stale (the merge spreads the primary
row and never recomputes the flag — pre-existing, only visible now that upstream's goldens serialise
it), and the occurrence plan still lists the merged-away occurrence, so `renderedKeys` and the
`SECTION project:…` lines disagree by exactly the merged pairs. Consumers of `plan.bySection` must
tolerate that.

### The web project keeps its own `worktree-path-comparison` copy

**Paths:** `src/main/ipc/worktree-path-comparison.ts`, `config/tsconfig.tc.web.json`

**Decision.** Upstream consolidated path comparison into `src/main/git/worktree-path-comparison.ts`,
which pulls `./runner` and the whole command-runner graph with it. `src/main/ipc/project-folder-placement.ts`
is inside the _web_ TypeScript project (the renderer imports it), so pointing it at the `git/` copy
drags fourteen main-process modules into `tsconfig.tc.web.json` and fails the build with TS6307. The
fork's reduced 118-line copy stays, listed in the web project's `include`, and the two fork-only
importers keep pointing at it.

### Max-lines: five files split, none capped

`ssh-types.ts` (311), `agent-hook-listener.ts` (307), `server-state.ts` (301),
`CheckRunDetailsPanel.tsx` (434), `settings.test.ts` (814) all crossed their budget in the merge —
upstream keeps each at the cap, so the union is what overflows. Per the standing remedy:

- `src/shared/ssh-target-visibility.ts` took `SshTargetVisibilityInput`, `isAutoImportedSshTarget` and
  `isSshTargetHidden`, re-exported from `ssh-types.ts`.
- `src/shared/agent-hook-listener/inherited-pane-owner-guard.ts` took the inherited-pane-owner
  predicate upstream added inline.
- `server-state.ts::forgetAgentExit` delegates to `forgetAgentExitForPane` in
  `agent-exit-evidence.ts`; `statusCacheHydrationReady` needs no comment line to explain it.
- `src/renderer/src/components/editor/check-run-details-status.ts` took the timestamp formatter,
  the status-label map (and its three `translate` calls, keys unchanged) and `isFailureState`.
- `src/main/ipc/settings.test.ts`'s two durable-flush preference tests became one `it.each` — they
  exercise the same path with two keys.

### Checks panel: upstream's constant sticky label

`check-run-details.tsx` was resolved to the stale side of a rename and kept the fork's
`hasLogTail ? 'View full logs' : 'View full details'` conditional, which upstream had already
collapsed to the constant "View full details". The stale label was the whole failure: the tests find
the sticky action by accessible name, so the click never happened and the worktree-override and
GitLab-job paths looked broken too. **Whichever side changes a user-visible string, the label is what
the suite navigates by** — a resolution that keeps the older string fails as a navigation error three
tests downstream.

### PR cache: preserve-on-reject is qualified by the newer write's timestamp

The fork's PR #25 rule ("keep the last good PR cache entry when a refresh loses a race") was merged
unqualified, so every lost-race reject preserved the entry — including the case upstream added, where
main's newer hosted-review broadcast found no review or the same number in another repository and must
delete it. `preservePRCacheOnReject` now preserves only when the rejecting write is **not newer** than
the result (`entry.fetchedAt < args.fetchedAt`).

## 2026-10-19 sync (upstream `83c768d1b4`, 170 commits)

Merge base `fc24ac3715`, pre-sync tip `cc42fb3b93`, rollback tag `archive/pre-sync-cc42fb3b93`.
**52 conflicted paths** — `both-rewrote 34, union 10, rename-replay 3, duplicate-tail 2, modify/delete 2,
duplicate-members 1`. Upstream's delta is mostly a module reorganisation (the SSH tree split into
`ssh/connection/`, `ssh/targets/`, `ssh/config/`; the runtime-environment and filesystem-watcher
modules split; `locale-text-collators` and `markdown-document-paths` moved to `shared/`), plus a new
workspace-unread host capability and the AI Vault scope-aware cache-depth rule.

### AI Vault: the unbounded bypass belongs to the scan caches, not the answer cache

**Paths:** `src/shared/ai-vault-session-depth.ts`, `src/main/ai-vault/cached-session-list.ts`,
`src/main/ipc/ai-vault-host-leg-cache.ts`,
`src/renderer/src/components/right-sidebar/ai-vault-session-result-cache.ts`

**Decision (owner, 2026-10-19).** Upstream added `aiVaultCachedDepthServes(cached, requested,
scopePaths)`: a scoped request reuses only a scan of its **own** depth, because a scoped scan budgets
in-scope rows per source, so a deeper scan holds rows a shallower one would not have kept. The fork's
`unbounded` fallback ("an unbounded entry answers a bounded request") survives **in the two
main-process scan caches only** — `localCacheHit` in `cached-session-list.ts` and both gates in
`ai-vault-host-leg-cache.ts` read `cached.depth === 'unlimited' || aiVaultCachedDepthServes(...)`. The
renderer's result cache is strict: it stores the **truncated** answer it handed the UI, so reusing a
deeper (or unbounded) scan there would show rows the requested depth excludes.

The two sides are not interchangeable, and the tests pin both: the fork's
`serves a scoped bounded {local,all-host,runtime} list from the unbounded one already loaded` (main
process) and upstream's `rescans a scoped view at a lowered depth instead of reusing the deeper scan`
(renderer) cannot both pass under one rule. An unscoped bounded request still rides an unbounded
entry everywhere, because `aiVaultSessionDepthCovers` covers it.

`aiVaultAppliedScopePaths` (the fork's "an unbounded read depends on no scope") stays for keys,
requests and the scan call. **Do not** collapse the two rules into one helper again: a shared
`aiVaultCacheEntryServes` was tried in this sync and broke whichever side it was not written for.

**Accepted cost, recorded by the review.** Because main still answers a scoped lowered-depth request
from an unbounded scan, a user who switches from Unlimited to a preset in a _scoped_ view can see the
deeper view's in-scope rows until that entry expires — up to 60 s locally (`AI_VAULT_CACHE_TTL_MS`)
or 15 s for a host leg. It can only ever show _more_ rows than the preset would have produced, never
fewer, and the renderer's own cache stays strict. Narrowing it means giving the fork's three
"unbounded list answers a scoped request" cases up, which is a product decision rather than a sync
one.

The renderer's result cache has no unbounded fallback at all any more: an unlimited answer keys
without a scope, so an unlimited request finds it as its own entry, and a scoped request is refused by
the depth rule. Its dead `unboundedKey` branch (and the "bump" branch that existed only for it) were
deleted after the review flagged the comment that invited their return.

### `codex-subagent-roster` is gone; upstream's cap removal lands on `agent-descendant-roster`

**Paths:** `src/shared/agent-descendant-roster.ts`, `src/shared/codex-subagent-roster.ts`,
`src/shared/agent-status-types.ts`

**Decision.** The fork renamed the module in an earlier sync; upstream kept editing the old name and
removed its child cap (`AGENT_STATUS_MAX_SUBAGENTS` and the `roster.size >=` early return). The
deletion stands and upstream's removal is ported into the renamed module and its test, including the
`posts every running child` expectation. The constant is deleted from `agent-status-types.ts` and must
not come back — nothing references it any more (the fork's Pi async-subagent test takes upstream's
uncapped assertion).

**Addendum 2026-10-27 — reversed: the deletion does not stand.** Upstream's
`codex-subagent-roster.ts` is restored at its own path and name, byte-identical to the sync base, and
the cap removal (upstream's own, which it made in that file) came with it. `agent-descendant-roster.ts`
keeps only the pi/claude extras. The rename was the divergence; `AGENT_STATUS_MAX_SUBAGENTS` still must
not come back, and that part of this entry holds.

### The SSH tree, the watcher and the RPC error helper moved; fork-owned files followed

**Paths:** `src/main/ssh/**`, `src/main/ipc/ephemeral-vm.ts`, `src/main/ipc/session-summary.ts`,
`src/main/session-summary/**`, `src/main/runtime/runtime-repository-relocation-controller.ts`

**Decision.** Upstream split `ssh/` into subdirectories and `filesystem-watcher.ts` into
`filesystem-watcher-handlers.ts` + `filesystem-watcher-shutdown.ts`, moved
`invalidateAuthorizedRootsCache` into `registered-worktree-roots-cache.ts`, and moved
`hasRuntimeRpcErrorCode` into `shared/runtime-rpc-error-code.ts` (which `runtime-rpc-client` still
re-exports, so the fork's Jira pages keep their import). `ssh-connection-utils.ts` is deleted: its
`shellEscape` was byte-identical to `quotePosixShell` in `shared/shell-argument-quoting.ts`, which is
what the remote-transcript reader now uses. `captured-output.ts` became `captured-git-output.ts`; the
fork's duplicate copy was deleted rather than kept beside it.

**Do not:** re-add a `captured-output.ts` or an `ssh-connection-utils.ts` copy. A merge that keeps both
spellings of one module typechecks only until the duplicate import is reached — this sync hit exactly
that in `git-exec-file.ts`.

### AI Vault view options: upstream's shared store, the fork's two extras

**Paths:** `src/renderer/src/components/right-sidebar/use-persisted-ai-vault-view-options.ts`,
`AiVaultPanel.tsx`

**Decision.** Upstream rewrote the hook around a module-level store (`useSyncExternalStore` +
`subscribe`/`updateOptions`) so the sidebar and the `/resume` dialog cannot undo each other, and added
a `localAgents` argument for the dialog's own agent filter. The fork's `disabledTuiAgents` →
`availableAgents` filter and its `showSubagentSessions` option ride on top. The signature is
`usePersistedAiVaultViewOptions(localAgents?, disabledTuiAgents?)` — upstream's argument stays first
because its dialog passes it positionally — and the panel passes both.

`setAllAgentsEnabled(enabled, scope = AI_VAULT_AGENTS)` keeps the fork's scope-aware bulk toggle with
`AI_VAULT_AGENTS` as the default, so upstream's one-argument dialog call still means "every agent".
`withAllAgentsEnabled` is deleted; `withAgentEnabled` remains for the single-agent path.

**Do not:** drop the `local` branch in `updateAgents` (the dialog's filter is never persisted), or
re-add `options.disabledAgents` to the agent list — a local filter must win over the stored one.

### Max-lines: two extractions, and the refresh hook's recorded debt is gone

`orca-runtime-get-status.ts` overflowed by 5 lines on the union — `hostModeRuntimeCapabilities()` moved
to `runtime-host-mode-capabilities.ts` (the desktop-bridge, host-raised-unread and mobile-bundle
capabilities: the ones that follow _how_ the host runs, not what its build contains).
`ai-vault-session-refresh.ts` had been **red at the tip before this merge** (303 lines, recorded in
LOCAL-PATCHES.md as deliberate debt); the forced-rescan throttle moved to
`ai-vault-forced-rescan-throttle.ts` with `markForcedRescanSpent()` and `forcedRescanRetryDelayMs()` as
its new edges, and the two external importers follow it. `index-project-setup.test.ts` reuses
`ORCA_PROJECT` for the four identical inline project literals.

**Do not:** bump a cap or add a baseline entry for any of the three.

### `@types/node` follows upstream down to 24.19.2

Upstream pinned `@types/node` back to `^24.19.2` (the fork was on `^25.6.0`). Those typings declare
`process.emit("message", message, sendHandle)` with a **required** third argument, so the AI Vault
service harness emits `process.emit('message', message, undefined)` like every other harness in the
repo. A two-argument emit typechecks against 25.x and fails against 24.x — that is the whole symptom.

## 2026-10-21 sync (upstream `bbc8303b47`, 418 commits)

63 conflicted paths. Upstream's delta is a product wave — the Agent Dashboard as a first-class view,
the SSH settings screen rebuilt, the MiniMax/GLM accounts sections turned into host-aware components,
queued-message editing grown to images, and four new lint ratchets — so most decisions below are
"upstream's newer design wins, and here is where the fork's feature rides on it".

### SSH settings: upstream's grouped, windowed list keeps the fork's Hide

**Paths:** `src/renderer/src/components/settings/Ssh{TargetList,TargetCard,Pane}.tsx*`, `SshTargetVisibilityToggle.tsx`, `ssh-target-list-model.ts`

**Decision:** `SshTargetList.tsx` is an **add/add collision of two different components**. Upstream's
wins: grouped by source (`groupSshTargetsBySource`), windowed through `VirtualizedList` (a generated
`~/.ssh/config` can import >10k hosts), grouped select-all, ⌘/Ctrl-A scoped to the list's own rows.
The fork's Hide feature rides on top, all of it in the same file:

- `partitionSshTargetsByVisibility(targets)` splits offered from hidden and is the unit under test
  (the list itself cannot be rendered in happy-dom, because `VirtualizedList` needs a scroll element).
- The row keeps `SshTargetVisibilityToggle` (fork component) in its action cluster, and the "Hidden"
  `Badge` next to the label; the card is upstream's compact row with its dropdown menu, and the menu
  omits Remove when the host is one `~/.ssh/config` re-imports.
- The collapsible "Hidden (N)" section renders below upstream's groups, with the fork's copy.
- `SshPane` passes `onSetHidden`, and its `totalBySource` counts **non-hidden** hosts, so a hidden
  host never reads as "filtered out" (`{{count}} of {{total}}`).

**Why:** upstream's list is a behavioural superset for everything except hiding, and the fork's
privacy affordance cannot be dropped — a discovered host returns on every config sync, so Remove
never sticks. Keeping two list components would re-conflict on every future sync.

**Do not:** reintroduce a second list component, drop `onSetHidden` when upstream rewrites the card
again, gate Remove back on for an auto-imported host, or count hidden hosts in `totalBySource`.
`SshTargetCard`/`SshPane` tests render inside `TooltipProvider` because the fork's toggle is the only
tooltip in the row — the app root has one.

### Accounts: upstream's host-aware MiniMax component, the fork's switch wrapped around it

**Paths:** `src/renderer/src/components/settings/AccountsPane.tsx`, `accounts-pane-{types,credential-sections,minimax-credentials}.ts(x)`, `MiniMaxAccountsSection.tsx`, `use-minimax-credentials.ts`

**Decision:** MiniMax is upstream's `MiniMaxAccountsSection` component: it owns its credential state
via `useMiniMaxCredentials(host.owner)` and renders where the credential is stored for the host the
pane shows. The fork's model-driven half is **deleted** — `accounts-pane-minimax-section.tsx`
(`renderMiniMaxAccountsSection`), `MiniMaxCredentialSectionModel`, and `useMiniMaxCredentials` inside
`accounts-pane-credential-sections.ts` (which now serves DeepSeek, Fireworks and Copilot only).
`miniMaxRateLimits` stays on `AccountsPaneSectionModel` because the component takes it as a prop.

The fork's **per-provider enable switch** has no upstream equivalent. It is registry-driven since
2026-10-31: `provider-accounts-sections.tsx` lists every provider once (id, icon, title, description,
search entries, body renderer) and `ProviderAccountsSection.tsx` renders that entry's header with the
switch leading the row, so a provider cannot reach the pane without one. `kimi`, `antigravity` and
`zcode` joined `USAGE_PROVIDER_IDS`, and main's cycle gates all three.

**Why:** upstream's component is the newer design and is strictly better at the host question (a
paired host's credential lives on that host). Duplicating it as a model section would mean two
surfaces writing one credential, which this ledger already forbids elsewhere.

**Do not:** re-add a MiniMax model section, or render a provider section outside
`PROVIDER_ACCOUNTS_SECTIONS` — `provider-accounts-sections.test.ts` holds the registry against
`USAGE_PROVIDER_IDS`, and `AccountsPane.test.tsx` pins the per-provider switch and off notice.

### The new-tab focus handoff: the fork's hook carries upstream's synchronous chat focus

**Paths:** `src/renderer/src/components/tab-bar/{new-tab-menu-focus-handoff.ts,use-tab-bar-create-menu-controller.ts}`

**Decision:** the fork's extraction (`useNewTabMenuFocusHandoff`) stands, and upstream's deltas are
ported into it: `pendingNewTabMenuFocusRef` holds `{ focus, synchronous? }`; `queueFocusAfterNewTabMenuClose`
clears a pending animation frame and retry before queueing; the unmount ref also clears the pending
focus; and a `synchronous` request runs immediately instead of after a frame, because a structured
chat mounts synchronously. The controller's `onFocusChat` (upstream) passes `true`.

**Why:** a merge that resolved the controller as upstream's would have dropped the extraction and
re-conflicted at every sync; a union would have kept two divergent copies of the deferred-focus logic.

**Do not:** restore the inline refs in the controller, or make the chat focus wait for a frame — the
composer has already mounted by then and Radix's close-time focus restore wins.

### File Explorer owner routing: upstream's strict owner

**Paths:** `src/renderer/src/components/right-sidebar/file-explorer-{operation-owner,types}.ts`

**Decision:** `getFileExplorerOperationOwnerFromState` is upstream's `resolveOwner`/`HostAuthority`
shape — a twin refuses rather than guessing, and focus never decides. The fork's
`operationOwnerFromHostId` helper went with it. The fork's `getFileExplorerListUnavailableMessage`
stays exported (the list surfaces import it).

**Do not:** reintroduce a route-to-owner helper for the floating workspace; upstream's resolver
already covers it, and a second path is how the two disagree.

### Clipboard pastes: the expiry sweep is the fork's, and it stays

**Paths:** `src/main/window/{native-chat-paste-files.ts,clipboard-ipc-handlers.ts}`

**Decision:** upstream rewrote the paste folder helpers and dropped the fork's TTL sweep, with a
header comment claiming the folder is "never swept". The sweep is restored
(`sweepExpiredNativeChatPastes`, `NATIVE_CHAT_PASTE_TTL_MS`, `PASTE_FILE_NAME`, called from
`registerClipboardHandlers`), and the header now says exactly what it deletes: only this build's own
`orca-paste-*.png` names past 30 days. Nothing else in the folder is touched, and a restore still
refuses anything outside it.

**Why:** it shipped, and dropping it silently leaves the folder growing forever. Upstream's reason for
not sweeping ("nothing tells which of them a sent message names") is about _arbitrary_ contents, not
about this build's own expired files.

**Do not:** widen the sweep to any other file in the folder, or delete the header paragraph that
scopes it.

### Queued-message editing: upstream's module, images included

**Paths:** `src/main/native-chat/agent-session-journal/queued-message-{update,text-update,table}.ts`, `src/main/native-chat/agent-session-wire/structured-agent-session-queued-edit.ts`

**Decision:** the fork's `queued-message-text-update.ts` is gone; upstream's `queued-message-update.ts`
makes the same compare-and-set decision and is a superset — text _and_ images, `readsImageCards`
refusal, and the previous body returned for a diff. The fork's two callers already import it.

**Do not:** restore a text-only copy beside it; the fingerprint compare-and-set is the whole contract,
and two copies is how a retry starts overwriting newer text again.

### Sidebar ordering: upstream's host identity, the fork's merge unchanged

The stamp-order goldens changed only in row order inside a section and the `lastChild` flag: upstream
sorts by host identity (`rankOf(worktree)` + `sortedByHostIdentity`), and the fork's `mergeSameBranchRows`
still runs on the rendered rows. No row was added or lost. `computeVisibleWorktrees` keeps the fork's
workspace-status pre-pass (`applyWorkspaceKindFilters` over upstream's plan inputs); re-applying the
kind switches there would hide folder roots.

### Max-lines: four splits, no caps

`runtime-environment-request-connections.ts` (upstream at the budget) folded the fork's spawn-time
`observeConnection` into `runtime-environment-connection-observation.ts` — one seam that both
broadcasts diagnostics and tells replication, so a later edit cannot do one without the other.
`runtime-project-host-setup-controller.ts` gained `takeWorktreeLayoutMode()`,
`src/cli/handlers/project.ts` yielded `project-worktree-layout-flag.ts`, and
`config/scripts/electron-builder-config.test.mjs` yielded
`electron-builder-linux-config.test.mjs` (the Linux packaging contracts).

**Do not:** solve either of the first two by shortening upstream's half — the fork's addition is the
line that moves, as in every previous sync.

## 2026-10-22 sync (upstream `57b5082404`, 268 commits)

52 conflicted paths: `union 22, both-rewrote 20, modify/delete 5, duplicate-members 2,
rename-replay 2, duplicate-tail 1`. No add/add, and almost no product collision: upstream's delta is
a **module reorganisation** — `src/main/ephemeral-vm/`, `src/main/ipc/jira/`, `jira/attachments/`,
`task-page/gitlab/`, and the mobile chat helpers renamed page → scroll — with one feature behind a
flag (`experimentalConnectors`) and one new locale. The cost was the renames that never conflicted.

### Ephemeral VM: upstream's `ephemeral-vm/` grouping wins; the fork's modules stay flat

**Paths:** `src/main/ephemeral-vm/**`, `src/main/ephemeral-vm-*.ts`, `src/shared/ephemeral-vm-recipe-*`

**Decision.** Upstream moved its ten ephemeral-VM modules into `src/main/ephemeral-vm/`. Those moves
are taken as renames, and every fork-owned importer follows them (`./ephemeral-vm-runtime-service` →
`./ephemeral-vm/runtime-service`, and the same for `runtime-ssh`, `runtime-ssh-cleanup`,
`runtime-environment-release`, `provisioned-root-source` and `failed-start-cleanup`). The fork's own
four modules — `ephemeral-vm-runtime-extend.ts`, `-context-menu.ts`, `-lock.ts`, `-reclaim.ts` — stay
**flat**, because they are fork-only and never collide; moving them buys nothing and costs a rename on
every future sync. `src/main/ephemeral-vm-recipe-runner.ts` is **deleted**, as upstream deleted it:
it was a three-line barrel over shared modules, so its one importer now reads
`shared/ephemeral-vm-recipe-extend-runner` directly, and the moved `ephemeral-vm/recipe-runner.test.ts`
imports each shared module by name.

**Do not:** recreate the barrel to keep an import path stable, or move the fork's four flat modules
into the directory "for consistency" — `rg 'ephemeral-vm-runtime-(extend|lock|reclaim|context-menu)'`
is the shape the next sync expects.

### Jira: upstream's `ipc/jira/` split and `jira/attachments/` renames win

**Paths:** `src/main/ipc/jira/**`, `src/main/jira/**`, `src/main/ipc/jira-board-handlers.ts`,
`src/main/ipc/jira-issue-update-payload.ts`

**Decision.** `src/main/ipc/jira.ts` became `ipc/jira/register-handlers.ts`, and upstream split
`jira/issues.ts`'s operations into `jira-issue-mutations` / `-read` / `-comments` /
`-transition-queries` / `-issue-search` (`jira/issues.ts` survives upstream as a barrel). The
register file takes upstream's per-module imports and keeps the fork's three additions on top:
`registerJiraBoardHandlers()` (from the flat `ipc/jira-board-handlers.ts`), the `jira:listEditFields`
handler (from `jira-issue-edit-metadata`), and the `normalizeIssueUpdate` second narrower. The
attachment modules moved to `jira/attachments/` (`discovery`, `image-cache`), which the fork's own
`jira-rendered-html.ts` had to follow.

**Do not:** import `jira:listEditFields`'s source from the `jira/issues` barrel in new code — the
per-module import is what upstream uses, and the barrel is a compatibility surface only.

### Worktree delete: the queue is upstream's, the extraction is the fork's

**Paths:** `src/main/runtime/rpc/methods/worktree.ts`, `worktree-remove-method.ts`,
`src/renderer/src/components/sidebar/DeleteWorktreeDialog.tsx`, `use-delete-worktree-dialog-actions.ts`

**Decision.** Upstream routes `worktree.rm` through `queueWorkspaceDelete(runtime, selector, hostId,
params, run)` so a delete queues on the workspace lifecycle; the fork had extracted the whole method
into `worktree-remove-method.ts` on the max-lines budget. Both survive: the extraction keeps
`WORKTREE_REMOVE_METHOD`, and upstream's queue call lands **inside** it, carrying the fork's
`deleteRemoteBranch` through the `run` callback (`queueWorkspaceDelete` only normalizes the four
`RemovalFlag`s). On the renderer side upstream added `confirmedDiscards` to every delete path; the
fork's `useDeleteWorktreeDialogActions` hook computes it from `unsavedTargets` — passed in as an
argument — so the dialog component keeps its size and the hook keeps both dependency arrays.

**Why:** the alternative — dropping the extraction — puts the dialog back over `max-lines` and
re-couples the two destructive actions; dropping the queue loses the lifecycle serialization.

**Do not:** give `queueWorkspaceDelete` a sixth flag for `deleteRemoteBranch`. The `run` callback
already sees the raw `params`, which is where the fork reads it.

**Correction (2026-10-23).** The flag rule was read too widely at first: the _key_ still has to carry
the choice. `queueWorkspaceDelete` normalized only the four `RemovalFlag`s before keying the delete,
so `getRuntimeWorktreeRemovalOptionsKey` always produced `…:keep-remote-branch` and the queue handed
a `deleteRemoteBranch: true` retry the pending keep-the-branch delete's reply
(`workspace-lifecycle-queue.ts` shares a reply on an equal key), skipping the `git push --delete`
silently. `requested` now takes the field for the key only — `removal` still carries four flags, and
the value still reaches the removal through `run`. Two deletes that differ only in this choice must
not coalesce; `workspace-lifecycle-commands.test.ts` pins both directions.

### Agent-hook listener: the fork's guards stay and carry upstream's `incomingProcess`

**Paths:** `src/shared/agent-hook-listener.ts`, `src/shared/agent-hook-listener/inherited-pane-owner-guard.ts`

**Decision.** The fork's two extractions (`admitNestedAgentPost`, `isInheritedPaneOwnerEvent`) stay,
and upstream's new evidence is threaded through them: `readAgentProcessIdentity` is upstream's
`readHookAgentProcess(source, record.agentProcess)`, and the guard takes an `incomingProcess` argument
and forwards it to `resolveAgentStatusIdentity`, which uses it to tell a nested `claude -p` from the
pane's own agent. `previousReceivedAt` lives inside the guard (it has no other reader), so the
listener computes only `agentProcess`.

**Do not:** delete the guard's `incomingProcess` parameter as "unused by the caller" — the caller
passes it, and dropping it turns a nested child into the pane's owner.

### Localization: `en.json` is unioned then regenerated, and one key held two sentences

**Paths:** `src/renderer/src/i18n/locales/en.json`, `src/renderer/src/i18n/en-runtime-required.json`

**Decision.** `en.json` was resolved by a three-way merge of the parsed catalogs (15 conflicting
leaves: 8 kept the fork's value — the `~/.orca-np` paths, the floating-workspace copy, the dashboard
description, the Jira-aware issue-link copy, the fork's provider list — and 7 took upstream's, all
cases where upstream rewrote the same string and ours was still the base value), then
`pnpm run sync:localization-catalog` added the 8 keys the merged source needed. `en-runtime-required.json`
is never hand-merged; it is regenerated.

**Found and fixed here:** `jira.board.noTransition` was used for two different sentences (one with
`{{column}}`/`{{key}}`, one without) — the catalog's placeholder check caught it, and the
placeholder-less sentence is now `jira.board.noTransitionSelected`. That file is the red-flag scan's
single "modified but upstream never touched it" entry this sync, which is the scan working.

### The worktree base watcher: upstream deleted the helper, so the fork's rule moved to the call site

**Paths:** `src/main/ipc/worktree-base-directory-watch-targets.ts`

Upstream deleted `getBaseWatchLayout` (with the SSH filesystem provider and the local/remote
branching that surrounded it) as part of its SSH removal, and this sync first took that deletion
whole — which silently dropped the fork's project-folder rule with it: `nestWorkspaces` must be
`false` when the layout is `project-folder`, because the watched root already IS the per-project
container and a nested matcher then looks for a repo-named level that placement never creates. With
the rule gone, a worktree created outside the app is not detected. The rule now lives on the `config`
object that `maybeAddBaseTarget` builds, and `worktree-base-directory-watch-targets.test.ts`'s
"watches the per-project container as a flat root" case pins it.

**Why this is recorded rather than just fixed:** a deletion upstream makes for its own reasons can
carry a fork rule out with it, and the deletion conflicts cleanly — there is no marker, and the only
signal is a fork test the sync did not run. That test is not in `local/unit-known-red.json` and must
never be added there.

**Do not:** re-add `getBaseWatchLayout` or the SSH provider branch to get the rule back.

### Max-lines and the ratchets: two splits, one prune, two restorations

`orcad-entry.ts` was over the budget on the union, so its credential-store bootstrap moved to
`orcad-secret-store-bootstrap.ts` (one seam: prepare the store, then migrate the plaintext
credentials); the pi test harness moved its `BASE_ENV` fixture to
`agent-status-extension-test-env.ts`. Neither cap moved. The focus-read baseline was re-pruned
against the upstream code that removed the runtime Jira/Linear reads (1161 → 718 reads) and the
fork's two documented transitive readers were **restored with their causes**
(`use-linked-issue-pane-actions.ts`'s `openHttpLink`, and `JiraBoardSettings.tsx`'s global default
board) — taking upstream's baseline alone would have deleted both justifications.

**Do not:** re-add a ratchet entry without its cause and date, and do not carry upstream's baseline
over the top of the fork's entries — the counts belong to the merged tree, not to either side.

### A clean merge is not a correct merge — the four breaks no marker showed

- `store-test-helpers.ts`: upstream wrapped the test store in `withEditorBufferRecords`, and that
  rewrite dropped `createWorktreeSetupRunnerSlice` from the list while the fork's `AppState` still
  requires it (`pnpm tc` named the missing properties).
- `use-browser-new-tab-linked-items.ts` (fork-only): upstream's review-details hook gained required
  `issueRepo` / `issueRepoIsOffDevice` outputs, so the browser new-tab caller had to pass them.
- `host-sync-settings-disposition.ts` and `profile-project-session-field-disposition.ts`: two new
  upstream settings (`experimentalConnectors` → `replicated`, a feature flag;
  `uiLanguagePortugueseMigrationApplied` → `hostLocal`, a migration marker) and one new session field
  (`closedTerminalPanesByPaneKey` → `hostLocal`) have to be classified, or the replication contract
  fails to compile.
- `worktrees-local-create-base-prefetch.test.ts` mocked `../providers/ssh-filesystem-dispatch`, which
  upstream deleted, so the mock target vanished with it.

## 2026-10-25 sync (upstream `0571e45107`, 556 commits)

Merge base `57b5082404`, pre-sync tip `095cf32705`, rollback tag `archive/pre-sync-095cf32705`, merge
commit `281cccf5a4`. **249 conflicted paths, 367 hunks** — `both-rewrote 167, union 47,
modify/delete 23, duplicate-tail 8, rename-replay 2, duplicate-members 1, add/add 1` — four to five
times the previous two syncs. Upstream's delta is a **mass comment-terseness pass** (which is why
`both-rewrote` dominates) plus regroupings: `ipc/filesystem/watchers/`, `shared/jira/`, several
`src/main/runtime/` groups, and ~50 retired test inventories. The max-lines splits are in § "Max-lines
budget pressure", 2026-10-25 addendum.

### Filesystem watchers: upstream's `filesystem/watchers/` grouping wins, and the fork's files moved in

**Paths:** `src/main/ipc/filesystem/watchers/**`, `src/main/ipc/filesystem-watcher-*`

**Decision.** Upstream moved its flat `src/main/ipc/filesystem-watcher-*` modules into
`src/main/ipc/filesystem/watchers/`. The fork's seven watcher files moved **with** them —
`filesystem-watcher-event-coalescing.ts`, `-local-teardown.ts`, `-path-index-coverage.ts`,
`-path-index-reconciliation.ts` (+ test), `-wsl-snapshot.ts` and `-local-lifecycle.test.ts` — and
none is left flat.

**Why this is not the ephemeral-VM rule** (2026-10-22: fork-only modules stay flat). Those were
standalone; these are halves the fork extracted out of upstream's watcher modules, and each is
imported only by an upstream sibling (`-local-events`, `-local-subscription`, `-wsl`) and imports
siblings itself. Left flat, every one becomes a cross-directory pair with the module it was cut from.
`1b848feba6` pruned the flaky-ratchet rows the move stranded at the old flat paths.

**Do not:** move the seven back to `src/main/ipc/`. `git ls-files 'src/main/ipc/filesystem-watcher-*'`
printing nothing is the shape the next sync expects.

### Jira shared types: `shared/jira/jira-types` is upstream's path; the fork's types rode inside it

**Paths:** `src/shared/jira/**`, `src/shared/jira-*.ts`

**Decision.** Upstream moved `src/shared/jira-*` into `src/shared/jira/`, `jira-types.ts` included.
The fork's additions to that file moved with it rather than into a fork file: eleven fork-only
exported types (`JiraBoard`, `JiraBoardColumn`, `JiraBoardIssuePage`, `JiraBoardIssuePageRequest`,
`JiraBoardOverview`, `JiraBoardSelection`, `JiraCommentBodyFormat`, `JiraEditableField`,
`JiraFieldErrors`, `JiraSprint`, `JiraSprintAssignment`) and five fork-only `JiraCreateField` members
(`hasDefaultValue`, `currentValue`, `hasCurrentValue`, `currentDisplayValue`, `currentUsers`). The
fork-only modules no upstream file imports stay flat, per the ephemeral-VM rule:
`jira-board-view-preferences`, `jira-field-draft`, `jira-field-rendering`, `jira-link-site-selection`,
`jira-runtime-capabilities`.

**Do not:** split the fork's types out into a second `jira-types` file to shrink the diff — every Jira
importer would then need two imports, and the next sync re-conflicts the same block anyway.

### Session search schema: version 10, above both lines

**Paths:** `src/main/ai-vault-search/session-search-schema.ts`

**Decision.** `SESSION_SEARCH_SCHEMA_VERSION` went 6 → 9 on the fork and 6 → 8 upstream; the merged
file is **10**. Runbook trap 8: when both sides bump a persisted-format version in one sync, take a
version strictly above every version either line has shipped. At 9, a fork install's database would
read as current without upstream's version-8 change; 10 is a number neither line has written, so
both rebuild.

**Do not:** resolve to `max(ours, theirs)`. The two lines have meant the same number before.

### pi: the async lane is the fork's, the roster lane is upstream's, and the compaction hold reads both

**Paths:** `src/main/pi/agent-status-compaction-source.ts`, `src/main/pi/agent-status-async-subagent-session-source.ts`, `src/main/pi/agent-status-handler-source.ts`

**Decision** (`ef2897da2b`). Upstream fills `lifecycleState.active` from the roster lane; the fork
routes the async channels to its own lane (§ "pi subagent bindings") and keeps them out of that set.
Upstream's new test expects a finished reply's compaction not to be announced while children run,
so the compaction guard in `agent-status-compaction-source.ts` now reads
`isHeldByChildren() || piAsyncSubagentHasLiveRuns()` — the second reading the same live set
`subagent_async_state` posts. **`isHeldByChildren()` itself is unchanged.**

**Why:** `isHeldByChildren()` also gates `postAgentEndOnce`, and the fork posts `agent_end` while
async children run, letting the host hold the pane from `subagent_runs`. Feeding the async lane into
`onEvent` (so `lifecycleState.active` would see it) broke 27 fork tests that pin that separation.

**Do not:** fold `piAsyncSubagentHasLiveRuns()` into `isHeldByChildren()`, or route the async channels
back into the roster lane to satisfy an upstream hold — add the async check at the one guard instead.

### Computer-use identity: the fork's `OrcaBundleIdentity`, upstream's duplicate deleted

**Paths:** `native/computer-use-macos/Sources/**`, `native/computer-use-macos/Tests/**`

**Decision** (`accb095dd6`). Upstream added `TrustedOrcaApplication.swift` (+ test) for the job
`OrcaBundleIdentity.isTrustedPeer` already does here. The fork's helper is identity-aware
(`com.nplez1.orca` and its dev id) and `main.swift` already calls it, so upstream's file was
unreferenced and is deleted with its test. Its `com.stablyai.orca` literals are also what the fork's
"leaves no pre-rename bundle id in any helper source" test forbids.

**Do not:** take `TrustedOrcaApplication.swift` back when upstream next edits it. Port the change into
`OrcaBundleIdentity` if it adds a rule.

### Worktree IPC: `worktrees:listAll` is gone, `listCached` stays

**Paths:** `src/main/ipc/worktrees.ts`, `src/preload/api/worktree{s-bridge,-api}.ts`

**Decision.** Upstream dropped the `worktrees:listAll` IPC surface, and the fork's copy went with it.
`worktrees:listCached` is fork-only and stays: `src/renderer/src/startup/startup-worktree-cache.ts`
calls it on startup (and the web preload mirrors it).

**Do not:** delete `listCached` as part of the same surface. It looks like a sibling of `listAll`; it
is not.

### Skill freshness: `src/shared/skill-freshness.ts` is fork-only now

**Paths:** `src/shared/skill-freshness.ts`, `src/shared/skill-freshness.test.ts`

**Decision.** Upstream deleted the module (the renderer owns those types now); the fork kept it for
the both-owner lock-source rule (`isOrcaSkillLockSource` accepts `stablyai/orca` and `nplez1/orca`).
**Resolution: delete** — resolved 2026-10-27. After the merge nothing but its own test imported it: the
renderer's freshness status derives from upstream's bundled-skill plan, so the rule was not on a live
path and the file recorded a policy the app no longer applied. `isOrcaSkillLockSource` and
`ORCA_SKILL_LOCK_SOURCES` are gone with it. If a both-owner rule is ever needed again it belongs in
upstream's ownership check, not in a resurrected dead module.

### The unit gate runs upstream's lane setting: `recordDependencies=false`

**Paths:** `local/gate-unit.mjs`, `config/vitest.config.ts`

**Decision.** `local/gate-unit.mjs` passes `--experimental.recordDependencies=false` (`UNIT_LANE_ARGS`)
to its suite run and its isolation re-runs. Upstream's `config/vitest.config.ts` sets
`experimental: { recordDependencies: !process.env.CI }`, and upstream's lane sets `CI`, so CI never
records dependencies. Left on, this machine reports 35 `EnvironmentTeardownError` races per full run
from upstream's fire-and-forget `import()`s that CI never sees. Reproduced on four suites in one
worker: as configured 20 errors, `CI=1` 0, `recordDependencies=false` 0, 28/28 passing each time.

**Trade-off, accepted:** the gate no longer surfaces those races. They are upstream's to fix and stay
in the code.

**Do not:** set `CI` for the gate instead — other suites read `CI` for their own behaviour, so the flag
is the narrower switch.

## 2026-10-28 sync (upstream `f173998203`, 838 commits)

Merge base `0571e45107`, pre-sync tip `7b86cb0846`, rollback tag `archive/pre-sync-7b86cb0846`, merge
commit `2fadfe371b`. **431 conflicted paths, 621 hunks** — `both-rewrote 223, union 86, add/add 72,
modify/delete 31, duplicate-tail 11, duplicate-members 3, rename-replay 5`. Upstream's delta is a
feature wave (WSL host chat, Jira board rework, team agents) plus two test-retirement campaigns and a
consolidated lint runner. Tiers: 255 hunks proved mechanically, 69 docs-churn paths removed, 27
settled deletions, 163 paths resolved in 13 batches.

### The lint chain is now upstream's single runner, and the gate expands it

**Paths:** `config/scripts/run-lint.mjs`, `package.json`, `local/gate-lint.mjs`

**Decision.** `package.json`'s `lint` is `node config/scripts/run-lint.mjs` — one command, N steps.
`resolveGateSteps` expands that runner's exported `LINT_STEPS` back into one gate step each (40 total:
36 upstream + 4 fork) and **fails closed** when the runner cannot be parsed. The three fork ratchets
upstream does not know (`check:process-host-imports`, `check:workspace-path-sync-fs-ratchet`,
`check:compat-boundary-imports`) moved into `FORK_LINT_STEPS`; `check:flaky-test-pattern-ratchet` and
`lint:ast-grep` needed no entry, because upstream folded both into `lint:ast-grep-gates`.

**Why.** Read literally the chain is a single `run-lint` step, which loses per-step attribution and
`--only` — the two things the gate exists to provide. `FORK_LINT_STEPS` is fork-owned, so a sync
cannot drop a step from it; that is the same reason the identity check lives there.

**Do not:** restate the step list in `local/gate-lint.mjs`. Reading the runner is what keeps a step
upstream adds from being skipped.

### Max-lines: thirteen more upstream-owned files over budget, exempted by ownership

**Paths:** `config/max-lines-baseline.txt`, the 13 files named there under "Added 2026-10-28"

**Decision.** Each carries one `eslint-disable max-lines -- Why:` line naming what the fork adds, and a
baseline row. Overages were 1–18 code lines. The `src/main/orcad/orcad-entry.ts` row went stale (the
fork's delta shrank) and was pruned; the baseline is 24 entries.

**Why.** The rule in § "`local(lint)`: upstream's `max-lines` budget is enforced again" is ownership,
not size: splitting an upstream file costs a permanent hunk on every sync.

**Do not:** add a row for a fork-owned file. Those split.

### Retired test inventories, the 2026-10-28 batch

**Paths:** the 13 colocated suites deleted under `src/renderer/src/components/**` and `src/renderer/src/runtime/**`

**Decision.** Upstream's deletion wins for `AgentDashboardSettingsMenu`, `ai-vault-view-defaults`,
`right-sidebar-activity-visibility`, `ExperimentalPane`, `FloatingWorkspacePane`, `accounts-search`,
`appearance-status-bar-search`, `create-project-defaults`, `ssh-target-duplicate`,
`use-worktree-activity-statuses`, `usage-provider-settings-target`, `runtime-jira-priority-client`
and `runtime-jira-project-client` (all #33770/#34156/#34161/#34234). Three cases were **re-homed, not
restored**: `getFailedStepsForCheck` into `src/shared/pr-checks-fix-prompt.test.ts`, the Orca NP
overlay into a trimmed `tui-agent-config.test.ts`, and the `setup` status into a trimmed
`StatusIndicator.test.ts`.

**Why.** Same reason as the earlier batches — churn the fork would re-pay every sync. The re-homed
three cover fork code that nothing else exercises.

**Do not:** restore a retired file to carry one fork case. Trim a surviving suite instead, next to the
code it covers.

### i18n: orphan keys retired, drifted copy re-pointed, one reused key split

**Paths:** `src/renderer/src/i18n/locales/*.json`, `src/renderer/src/i18n/fork/*.json`, `config/scripts/locale-ko-key-overrides.json`

**Decision.** 198 keys with no source reference (test-harness fixtures for the retired suites) were
removed from every locale, the fork overlay and the ko overrides. Nine English entries whose source
copy had moved were set to the **source** text, and their translations retired so they fall back to
English rather than render a stale sentence with the wrong placeholders. The fork's "Gemini CLI
(legacy)" heading and upstream's "Gemini" label shared one key; the heading took
`AccountsPane.aa4de4475b`. Two toasts the fork rewords (#169) had upstream translations with different
placeholders — also retired.

**Why.** The catalog value is what renders, so a stale catalog entry is a wrong string in the app, and
a reused key is a rendering bug waiting for a locale switch.

**Do not:** hand-merge a locale file. Union the source catalog, then `pnpm run sync:localization-catalog`.

### Checks-panel details: the fork keeps the cached payload when a refresh fails

**Paths:** `src/renderer/src/components/github-item-dialog/inspect-pull-request/checks-tab-request-details.ts`, `src/renderer/src/components/pull-request-page/checks/details-request.ts`, `src/renderer/src/components/github-checks-tab-state.ts`

**Decision.** #198's `settleGitHubChecksTabDetailsKeepingShown` stays at both call sites, so a failed
refresh keeps the details already on screen. Upstream's failure-shape expectations in
`check-details-failure-mapping.test.ts` and `check-details-ingestion.test.ts` now assert the fork's
contract (payload survives, plus the `readAt`/`readFor` stamps the fork's state writes on every
settlement).

**Why.** It is the fork's deliberate fix for a pane that re-spun to empty on a transient failure;
upstream's shape predates it. The stamps are what `isFresh` reads.

**Do not:** revert to `settleGitHubChecksTabDetails` on the failure path to satisfy an upstream test.

### Comment acknowledgements keep the latest-consumer refresh ref

**Paths:** `src/renderer/src/components/right-sidebar/checks-panel/use-checks-panel-ai-acknowledgement.tsx`

**Decision.** `commentLaunchCallbacks` is created at queue time, so the post-launch refresh goes
through a ref, not the captured `fetchComments`. The merge kept the fork's reply-only ack but dropped
the ref indirection both parents had; it is restored.

**Why.** Without it a head-churn rerender binds the refresh to a stale `fetchComments` whose
requestKey fails `isCurrentAsyncResult`, and the forced refresh plus `setCommentsLoading(false)` are
silently dropped.

**Do not:** call `fetchComments` directly from the callbacks.

### The update feed's identity rule covers URLs built in code, not just literals

**Paths:** `src/main/updater-prerelease-feed.ts`

**Decision.** `fetchLatestStableReleaseTag` names `nplez1/orca` in the `releases/latest` URL **and** in
the redirect-pathname regex. Upstream shipped both as `stablyai/orca`.

**Why.** With upstream's values the fork's own redirect never matches, the function returns `null`,
and every background and menu check dies in preflight. The identity sweep cannot see this: it scans
literals, and one side of the bug is a regex.

**Do not:** treat "no identity-sweep finding" as proof a URL is retargeted. Grep the updater for
`stablyai` after every sync.

### Host-sync disposition: four upstream settings classified, one superseded key dropped

**Paths:** `src/main/orca-profiles/host-settings-sync-disposition.ts`

**Decision.** `claudeSubagentNavigationEnabled`, `orchestrationHeartbeatsEnabled`,
`orchestrationHeartbeatIntervalMinutes` and `experimentalBrowserExtensions` are `replicated`
(preferences and feature flags the user turned on, like `orchestrationChatErrorEscalationEnabled` and
`experimentalConnectors`). `agentNativeChatPermissionModes` is gone from the map because the merged
`GlobalSettings` no longer declares it and nothing reads it.

**Why.** The map is `satisfies Record<keyof GlobalSettings, …>`, so an unclassified key fails the
typecheck — which is the point: a new upstream setting cannot silently inherit a disposition.

**Do not:** mark an experimental flag `hostLocal` unless it is a hardware or power decision, the way
`experimentalEphemeralVms` and `experimentalWslHosts` are.

### TUI launch command: two rules, not a choice between them

**Paths:** `src/shared/tui-agent-config.ts`, `src/shared/tui-agent-config-np.ts`

**Decision.** A remote launch returns `launchCmdByRemotePlatform` first (the relay shim's fixed
`orca` / `orca.cmd`); a local Linux launch falls through to upstream's
`skipsLinuxOrcaCliRename(isRemote)`, which reads the real launcher path; otherwise the fork's
`launchCmdByPlatform` (`orca-np`).

**Why.** Each rule answers a different question — "is this a remote" versus "does this host publish
its own launcher" — and dropping either reintroduces the bug it fixed.

**Do not:** collapse them into one branch to make an expectation pass.

### Schema versions: no both-sides bump this sync

**Paths:** `src/main/ai-vault/session-parse-cache-database.ts`, `src/main/ai-vault-search/session-search-schema.ts`

**Decision.** The parse-cache constant went 7 → 8 on upstream's side only, so the merged file takes 8.
`SESSION_SEARCH_SCHEMA_VERSION` is 8 on both sides and moves for neither. The strictly-above rule was
not triggered; it stays the rule for the next sync that does trigger it.

### Tooling repaired at sync size

**Paths:** `local/sync/lib/post-sync-checks.mjs`, `config/scripts/check-flaky-test-pattern-ratchet.mjs`

**Decision.** The post-sync deletion scan runs `git diff --no-renames` on **both** sides, and the
flaky-pattern ratchet's `git()` helper sets `maxBuffer: 256 MiB` like its sibling `ast-grep-scan.mjs`.

**Why.** With rename detection off only on our side, an upstream _rename_ of a fork-untouched file
(`terminal-file-link-detection-ranges.ts`, #33964) read as a fork-only deletion with a lost export.
And with no `maxBuffer`, a ~20k-path merge aborts the spawn with `ENOBUFS` before the ratchet can
scope itself — it read as a lint failure rather than a tooling limit.

### Flakes and deliberate exceptions in the flaky-pattern ratchet

**Paths:** `config/flaky-test-pattern-baseline.txt`, `src/main/jenkins/*.test.ts`

**Decision.** `worktree-initial-terminal-close-records.test.ts` goes 2 → 3 wall-clock reads: the third
is a restored TTL case, and the clock is the subject under test. Three jenkins suites carry
`// ast-grep-ignore: test-no-in-test-import-actual -- <reason>`: they redirect the **real** homedir,
which a stubbed `node:os` would not exercise.

**Do not:** use the ignore for a test that merely found mocking inconvenient.

## 2026-10-30 sync (upstream `a903985082`, 906 commits)

Merge base `f173998203`, pre-sync tip `16f49e00cf`, rollback tag `archive/pre-sync-16f49e00cf`, merge
commit `985687d2004`. **184 conflicted paths, 340 hunks** — `both-rewrote 98, union 57,
rename-replay 10, duplicate-tail 8, modify/delete 8, duplicate-members 2, add/add 1`. Tiers: 38 paths
proved mechanically by `conflicts.mjs --apply-proven`, 8 deletions settled, 138 paths resolved in five
disjoint area batches, and the 11 sidebar `.txt` goldens regenerated from the resolved row model.

### The PR conversation parser: the fork's review verdicts ride in upstream's extraction

**Paths:** `src/main/github/client/fetch/pr-conversation-response.ts`,
`src/main/github/client/fetch/get-pr-comments.ts`

**Decision.** Upstream extracted the GraphQL/REST conversation parse into
`pr-conversation-response.ts` and kept only body-carrying reviews. The fork's
`includeReviewVerdicts` stays and is threaded through both paths: `commentSchema` reads `state`,
`mapGraphQLReview` sets `reviewState`, and the keep-rule is the shared
`isReportableReviewSubmission` — a review submitted with no body is a verdict the Checks panel must
show and an empty card everywhere else.

**Why.** A resolution that keeps the option and drops the mapping is worse than either side: the flag
is accepted, ignored, and the two fork tests that pin a bodyless `APPROVED` summary go red with no
marker pointing at the cause.

**Do not:** make the option a no-op again because upstream's shape is simpler. The asymmetry is the
feature.

### The update feed's redirect is derived, not a second escaped literal

**Paths:** `src/main/updater-prerelease-feed.ts`, `src/main/updater-release-targets.ts`,
`local/sync/lib/post-sync-checks.mjs`

**Decision.** The `releases/latest` redirect check builds its tag prefix from `RELEASES_REPO` instead
of matching `/nplez1\/orca/releases/tag/` by hand, and `FEED_FILES` names
`src/main/updater-release-targets.ts` — the one declaration every feed URL reads. A feed file may now
satisfy the check through a checked constant rather than carrying its own copy of the slug.

**Why.** An escaped literal is invisible to the fixed-string grep the check runs, so the fork's
identity rested on a copy nobody was asserting. This is the same failure the 2026-10-28 entry records
in a different costume.

**Do not:** restore a literal to make the grep happy. Add the declaration to `FEED_FILES` instead.

### Worktree first-work naming: upstream implemented #251, and the fork's flag is what still differs

**Paths:** `src/main/ipc/worktree-remote.ts`, `src/main/runtime/runtime-local-worktree-create-candidate.ts`,
`src/main/worktree-create-first-work-test-harness.ts`, `src/main/ipc/worktrees-create-label-only-first-work.test.ts`,
`src/main/runtime/runtime-local-worktree-create.test.ts`

**Decision.** Upstream's `f5a4a7218ab` ("use a typed workspace name as its branch again") implements
the same typed-name-owns-its-branch behaviour as the fork's PR #251, and both sides deleted
`worktree-create-branch-seed.ts`. The merged tree takes upstream's shape and keeps the fork's
fixtures (`labelOnlyCreateCases`, `FirstWorkRenameOutcome`) plus upstream's
`generatedNameCreateRequest`, which upstream's own new tests import.

**Why.** The piece that still distinguishes the two lines is the fork's `branchNameWasGenerated` meta
flag (`first-work-rename-runtime.ts`, `worktree-remote.ts:1667`): it keeps a _typed_ creature word
from being renamed while a _generated_ one still is. Upstream never grew that, so a plain
take-theirs would have silently started renaming typed names.

**Do not:** treat the shared behaviour as a reason to drop `labelOnlyCreateCases`. Its typed-creature
and generated-creature rows are exactly the two cases that still differ.

### Status labels, synthetic titles and copilot rules: three unions that dropped code with no marker

**Paths:** `src/renderer/src/lib/worktree-status.ts`,
`src/main/runtime/terminal/output/terminal-transient-facts.ts`,
`src/main/runtime/agent-state-rules/agent-state-rules-catalog.ts`

**Decision.** `STATUS_LABELS` keeps all ten getters (upstream's nine plus the fork's `setup`).
`getTrackedPtyTitle` exists once — upstream's raw variant, whose declared consumer is upstream's
synthetic-title producer — and the fork's display variant stays as the protected
`getTrackedDisplayTitleForPty`. `RAW_BUNDLED_AGENT_STATE_RULE_FILES` keeps `copilot`, upstream never
had that file, so upstream's lazy-parse refactor had nothing to delete.

**Why.** Each of these merged with no conflict marker: a `Record<WorktreeStatus, string>` missing
eight keys, a duplicate class method, and a rule file nobody imports. The typecheck caught the first
two and the identity/ratchet checks caught neither for copilot.

**Do not:** fold `copilot` into `unknown-pane`. It is the fork's own rules for that agent.

### Local agent inventory: the fork's `isolated` flag survives the extraction

**Paths:** `src/renderer/src/store/slices/local-agent-inventory-refresh.ts`,
`local-detected-agent-store-state.ts`

**Decision.** `refreshLocalAgentInventory` treats `options.isolated === true` as isolation in addition
to the floating-terminal worktree id, and `LocalAgentRefreshOptions` declares `isolated?: boolean`
while `refreshDetectedAgents` accepts the fork's positional boolean or upstream's options bag.

**Why.** Upstream's extraction derived isolation only from `FLOATING_TERMINAL_WORKTREE_ID`, so a
per-workspace enable re-read would blank or flash the shared `detectedAgentIds`. The merged suite
still pins that behaviour.

**Do not:** drop the positional form — `agent-enablement-redetection.ts` still passes `true`.

### Host-sync disposition: thirteen upstream settings classified, one marker reasoned

**Paths:** `src/main/orca-profiles/host-sync-settings-disposition.ts`

**Decision.** `browserDefaultProfileIdByHostId`, `codexShareHistoryAcrossAccounts`,
`nativeChatLinkPreviews`, the three `pluginAppTheme*` ids, `pluginDismissedFileTypes`,
`pluginFileTypeSuggestions`, `pluginIconTheme`, `pluginUpdatePolicy`, `terminalPluginPalettes`,
`themeBeforePlugin` and `pluginSystemDefaultedOn` are all `replicated`.

**Why.** They are preferences and per-host selections the user made, which is what the map's
`replicated` arm is for; `pluginSystemDefaultedOn` is a one-shot default marker and follows
`autoRenameBranchFromWorkDefaultedOn` rather than the `…Migrated…` hostLocal pattern, because a host
that has not seen the default must not be told it already fired.

**Do not:** mark a preference `hostLocal` to shrink the replicated set. This map is
`satisfies Record<keyof GlobalSettings, …>`, so a new upstream setting fails the typecheck until it is
classified — that is the point.

### Max-lines: twenty-two ownership exemptions, and the five that should still be split

**Paths:** `config/max-lines-baseline.txt` and the 22 files named under the 2026-10-30 rows

**Decision.** Every one is upstream-owned and sat at the 300/400/600/800 budget before the fork's
delta rode inside it; each carries an inline `eslint-disable max-lines -- Why:` naming its overage
and a baseline row. The overages run 1–93 code lines.

**Why.** Same rule as the 2026-10-28 entry: splitting an upstream file costs a permanent hunk on every
later sync, and the fork's additions here are small. The five largest —
`worktree-title-derived-agent-rows.test.ts` (+91), `pty-spawn-env-terminal-basics.test.ts` (+93),
`fs-bridge.ts` (+39), `worktree-agent-activity-summary.ts` (+35), `session-search-store.ts` (+35) —
are recorded as split candidates because their overage is a fork block rather than a few lines.

**Do not:** add a row for a fork-owned file. Those split.

### `fork-symbols.mjs` followed one return and called a name lost

**Paths:** `local/sync/lib/fork-symbols.mjs`

**Decision.** `exposedObjectLiterals` follows **every** top-level `return` in a function body, not
only a lone one.

**Why.** A guard plus a fallback return exposes the same literal on both paths.
`describeUpdateFailure`'s `ok`/`error` were reported as lost while both were declared, which is the
shape that would let a real loss hide behind a false one next time.

### Fork-comment ratchet re-baselined to 5962

**Paths:** `local/upstream-file-comments-baseline.json`

**Decision.** `--init --accept`, reason recorded in the run output: four upstream-owned files became
fork-modified in this merge and carry fork rationale that has no fork-owned home yet
(`git-exec-file-sync.ts` add/add login-shell env, `task-page-jira-item-source-context.ts` after the
move under `task-page/jira/`, and the two worktree first-work test surfaces), plus three comment lines
from this sync's own repairs.

**Do not:** accept growth again without naming which files caused it.

### Deletions this sync settled

**Paths:** the 8 modify/delete entries

**Decision.** Four renderer paths (`AgentDashboardDrawer.tsx`, `useDashboardPopoutBridge.ts` and its
test, `popout.tsx`) follow the existing dashboard-delivery decision; the manifest entries had only
reverted to `pending-decision` because upstream's blobs moved. Four are upstream test retirements:
`ipc/jira/project-metadata-registration.test.ts`,
`runtime-client-settings-wsl-host-hooks.test.ts`,
`ipc/worktrees-create-first-work-rename.test.ts` (superseded, above) and
`task-page-jira-item-source-context.test.ts` (deleted with the move; the matcher keeps its own suite).

**Why.** Retirement wins where the fork's whole delta was drift repair or an assertion another layer
already covers; `strict` on `listPriorities` is still forwarded-and-pinned at
`src/main/runtime/rpc/methods/jira.test.ts:170-178`.

**Do not:** restore a retired suite to carry one case. Re-home it into a surviving suite, as the
2026-10-28 entry did for three.

### 2026-10-30 release gate: two gates green, and the two run-level headlines classified

**Gate lines.** `Unit gate @9383ffade4 (clean): PASS — 142215 passed; 18 failed (18 allowlisted, 0
unexpected); 0 flaky re-run passed; 0 unhandled error headline(s)`. `lint gate: PASS — 44 green, 0
failing: 0 known red, 0 new`. `pnpm tc` clean on the same revision.

The gate took 116 unexpected failures to 0, in five rounds. What the rounds found is worth keeping,
because none of it was a marker and the typecheck saw only one of them:

- **`update-worktree-meta.ts` wrote the state update before the save, not after it.** The "dismiss
  error" path therefore cleared the error on click and unmounted the dialog it lived in, so the
  button could never show a pending state — and the file's own rule, "a failed save must leave the
  error visible", was broken. Upstream runs the save first. **Restored to save-then-set.**
- **The fork's path-search scheduler is one-at-a-time**: it aborts a running search and dispatches
  the replacement only once that search's promise settles. A test written against upstream's
  scheduler-less version (a promise that never settles) therefore never saw the replacement. The
  fixture now rejects on abort, as the real client does.
- **Bun on macOS does not report EPIPE for a small write to a closed stdin; Node does.** The
  pipe-close case asserts that error, production runs on Electron's Node, so the suite joins
  `NODE_RUNTIME_INCLUDE` with that reason rather than being weakened.
- **A compat re-export counted as a synchronous git launch.** `git-exec-file.ts` re-exported
  `gitExecFileSync` for #176; `runner.ts` imports the helper directly, so nothing lost it.
- **Two sync fs probes identical to upstream's**, in a fork-only ratchet and both memoized, got
  baseline rows rather than a divergence in upstream code.
- **Five fork sites formatted dates and counts in the OS locale** instead of the UI language; they
  use `uiDateTimeFormat` / `getIntlLocale()` now.
- **The mobile admin-bypass confirm copy** was the last English-only literal in `PRActionsSection`;
  it has keys in the mobile catalog.

**Classified:** the two remaining run-level headlines are third-party and machine-bound, not repo
reds — monaco-editor's own `CancellationError` from disposing the editor, and the browser-mode dev
server refusing to serve Monaco's TypeScript worker because this machine's pnpm store sits at
`/Volumes/Storage/.pnpm-store`, outside the project directories it may read. Both name no repository
file, and the run that carried them had 0 unexpected test failures. See
`local/unit-known-red.json` § `unhandledErrors`.

**Machine prerequisites, both load-bearing and both now recorded outside any worktree**
(`~/Code/orca/AGENTS.md`): `bash` 5.3 must be **first** on PATH (the old pin only appended, so a
parent process's earlier append left `/bin/bash` 3.2 ahead of it and ~14 `.mjs` suites failed on
`set -u` empty-array expansion), and `mobile/` needs its own `pnpm install --frozen-lockfile`
(24 bundle tests fail on `Could not resolve "expo-localization"` otherwise). Neither is repo state.

**Shipped.** `v1.4.214-np.43` was published from `402c238a18e` by
`fork-release.yml` run 41132916318 — unit plan, 12/12 shards, macOS, Windows and Linux all green
(the Linux lane absorbed the 18 credential-store and host-toolchain reds through
`local/nightly-linux-known-red.json`, and the unit lane reported no unhandled headline). All 16
assets are present, including `latest-mac.yml`, `latest.yml` and `latest-linux.yml`, and
`releases/latest` resolves to `v1.4.214-np.43`.
