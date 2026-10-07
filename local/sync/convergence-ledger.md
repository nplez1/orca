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
