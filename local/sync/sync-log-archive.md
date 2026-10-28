# Sync log archive

Entries moved verbatim out of [LOCAL-PATCHES.md](../../LOCAL-PATCHES.md) § Sync log, which keeps the
three most recent inline so that section stays readable. Same text and same order; newest first.

- **2026-10-21 — merge of upstream `bbc8303b47` (418 commits) into the release line, from
  `43fa95b4cf`** (merge base `83c768d1b4`, rollback tag `archive/pre-sync-43fa95b4cf`, merge commit
  `276fe47cee`). **63 conflicted paths** — `both-rewrote 33, union 16, rename-replay 7,
  duplicate-tail 4, add/add 2, duplicate-members 1`. Upstream's delta is a product wave rather than
  a reorganisation: the Agent Dashboard became a first-class view, the SSH settings screen became a
  grouped/windowed multi-select list, the MiniMax and GLM accounts sections became self-contained
  host-aware components, queued-message editing grew image support, and four new quality ratchets
  went into `pnpm lint`. Decisions are in
  [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-21 sync"; the
  ones a reviewer will want first:

  - **The SSH settings screen is upstream's list with the fork's Hide on top.** `SshTargetList.tsx`
    is now a _different component on each side_ (add/add): upstream's groups by source, windows
    > 10k imported hosts, and multi-selects. The fork's Hide feature survives as
    > `partitionSshTargetsByVisibility()` (the offered/hidden split, unit-tested) plus the existing
    > `SshTargetVisibilityToggle` in the row's action cluster and a collapsible "Hidden (N)" section;
    > the card keeps upstream's dropdown menu, and Remove is omitted from it for a host
    > `~/.ssh/config` keeps re-importing. `SshPane` keeps upstream's filter/toolbar/selection and
    > passes `onSetHidden`; its group totals count non-hidden hosts so a hidden host never reads as
    > "filtered out".
  - **MiniMax converges on upstream's component, and the fork's enable switch wraps every section.**
    Upstream's `MiniMaxAccountsSection` owns its own credential state through
    `useMiniMaxCredentials(host.owner)` and says where the credential is stored, so the fork's
    model-driven MiniMax half (`accounts-pane-minimax-section.tsx`, the `MiniMaxCredentialSectionModel`
    type and its factory in `accounts-pane-credential-sections.ts`) is deleted. What the fork keeps is
    the per-provider switch, which upstream has no equivalent of: `gateUsageProvider(...)` now wraps
    upstream's _component_ sections too (MiniMax, Grok, Cursor), not only the model-driven ones.
    Recorded in `local/sync/expected-deletions.json` with both call sites named.
  - **The new-tab focus handoff stays a fork hook, carrying upstream's synchronous chat focus.**
    Upstream changed the same inline code inside `use-tab-bar-create-menu-controller.ts` that the fork
    had extracted into `new-tab-menu-focus-handoff.ts`, so the hook took upstream's deltas: the
    `{ focus, synchronous? }` ref, the clear-then-queue that drops a stale animation frame, the
    unmount path clearing the pending focus, and the chat composer focused **without** waiting a
    frame because a structured chat mounts synchronously.
  - **Queued-message editing is upstream's module, and it is a superset.** The fork's
    `queued-message-text-update.ts` (text-only compare-and-set) is gone;
    `queued-message-update.ts` does the same decision for text **and** images, refuses an image card
    the caller was shown no images for, and returns the previous body. Both former callers
    (`journal-queued-messages.ts`, `structured-agent-session-queued-edit.ts`) now import it, and its
    `.spec.ts` carries the retry/superseded cases. Acknowledged in `expected-deletions.json`.
  - **The File Explorer takes upstream's strict-owner routing.**
    `getFileExplorerOperationOwnerFromState` is upstream's (`resolveOwner`/`HostAuthority`: a twin
    refuses, focus never decides), which retired the fork's `operationOwnerFromHostId` helper; the
    fork's `getFileExplorerListUnavailableMessage` copy survives as an export because the list
    surfaces still import it.
  - **Nothing of the fork's was silently dropped this time — two were caught and restored.**
    The clipboard paste-expiry sweep (`sweepExpiredNativeChatPastes`, `NATIVE_CHAT_PASTE_TTL_MS`)
    vanished with upstream's rewrite of `native-chat-paste-files.ts`, whose header then read "never
    swept"; the sweep and its `registerClipboardHandlers` call are restored, and the header now says
    what it actually deletes. The status bar's placeholder-last chip ordering
    (`isOwnerNotSetUpPlaceholder`) vanished with the roster array the fork had moved into
    `status-bar-usage-projection.ts`; it is ported there.
  - **A green typecheck is not a green merge — four files landed over the max-lines budget** and each
    was split rather than capped: `runtime-environment-connection-observation.ts` (the replication
    observe folded into the diagnostics seam, which now has exactly one caller),
    `takeWorktreeLayoutMode()` in `runtime-project-setup-layout-mode.ts`,
    `src/cli/project-worktree-layout-flag.ts`, and
    `config/scripts/electron-builder-linux-config.test.mjs` (the Linux packaging contracts, moved
    out of `electron-builder-config.test.mjs`).
  - **The branch was red before the merge started.** `1c81139662` added a `translate()` call whose
    literal default equals the catalog value, so `TabBar.ab589350e5` stopped being runtime-required;
    the derived `en-runtime-required.json` was never regenerated, and the pre-sync derived-catalog
    gate refused to start. Fixed as its own commit (`43fa95b4cf`) before the merge.
  - **`git merge` reported a clean tree that was not clean.** Three seams resolved without a marker:
    `removeWorktreeMetadataAndTransientState` gained a `{ store, runtime }` argument (two fork call
    sites passed a bare `store`), `store.migrateWorktreeIdentity` gained a host-qualified target (the
    fork's relocation controller passed a string), and the two host-sync disposition tables gained
    upstream's new fields (`agentNativeChatPermissionModes` replicated, `nodeDistMirrorUrl`
    host-local like `httpProxyUrl`, `pairedTerminalTabCloseIntentsByEnvironment` host-local).

  Verified: `pnpm tc` clean on all four projects, `post-sync.mjs` fully PASS (including the
  derived-catalog, identity-sweep, deleted-export and repo-wide `oxlint` gates),
  `check:code-quality:changed` clean once `mobile/` dependencies are installed — without them the
  mobile type-aware pass reports upstream's own files as failures, which is an install artifact, not
  a finding. The sidebar goldens were regenerated: every change is upstream's host-identity ordering
  (row order inside a section, `lastChild`), with no row added or lost. **This merge ships the first
  fork release with the Linux leg**; nothing in the Linux packaging contract needed a change for it.

Entries from 2026-10-19 back to 2026-09-16 — 24 of them — are in
[local/sync/sync-log-archive.md](./local/sync/sync-log-archive.md).

- **2026-10-19 — merge of upstream `83c768d1b4` (170 commits) into the release line, from
  `cc42fb3b93`** (merge base `fc24ac3715`, rollback tag `archive/pre-sync-cc42fb3b93`). Upstream's
  delta is mostly a module reorganisation rather than a feature wave: the SSH tree split into
  `ssh/connection/`, `ssh/targets/` and `ssh/config/`, `filesystem-watcher.ts` split into
  `filesystem-watcher-handlers.ts` + `filesystem-watcher-shutdown.ts`, `locale-text-collators` and
  `markdown-document-paths` moved to `shared/`, `hasRuntimeRpcErrorCode` moved to
  `shared/runtime-rpc-error-code.ts`, `@types/node` came back down to `^24.19.2`, and the AI Vault
  caches gained a scope-aware depth rule.

  The merge produced **52 conflicted paths** — `both-rewrote 34, union 10, rename-replay 3,
  duplicate-tail 2, modify/delete 2, duplicate-members 1` — exactly the set the dry run named. Every
  decision is in [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-19
  sync"; the ones a reviewer will want first:

  - **The unbounded AI Vault bypass belongs to the two main-process scan caches, not the answer
    cache.** `localCacheHit` (`cached-session-list.ts`) and both gates in `ai-vault-host-leg-cache.ts`
    read `cached.depth === 'unlimited' || aiVaultCachedDepthServes(...)`, so a scoped bounded request
    is answered from an unbounded scan (the fork's rule, pinned by its three
    `serves a scoped bounded … list from the unbounded one already loaded` cases). The renderer's
    result cache is strict — upstream's rule, pinned by its `rescans a scoped view at a lowered depth`
    case — and its dead unbounded fallback is deleted rather than left to invite a "fix". A shared
    helper for both was written and removed during the merge: it cannot satisfy both suites, and the
    ledger records why not.
  - **`codex-subagent-roster` stays deleted** (the fork renamed it to `agent-descendant-roster`) and
    upstream's child-cap removal is ported into the renamed module and its test.
  - **The AI Vault view-options hook keeps upstream's shared store and both fork extras.**
    `usePersistedAiVaultViewOptions(localAgents?, disabledTuiAgents?)`: upstream's argument stays
    first because the `/resume` dialog passes it positionally, and
    `setAllAgentsEnabled(enabled, scope = AI_VAULT_AGENTS)` keeps the fork's scope-aware bulk toggle
    so a one-argument call still means "every agent".
  - **Two max-lines extractions, one of which retires recorded debt.**
    `runtime-host-mode-capabilities.ts` took the three host-mode capability pushes out of
    `orca-runtime-get-status.ts`, and `ai-vault-forced-rescan-throttle.ts` took the rescan throttle
    out of the refresh hook — the overflow this file recorded as deliberate debt above is now gone.
  - **`web-file-mutation-session.ts` adopted upstream's `assertMutationSupported({ pinConnection })`**
    contract, including the connection-epoch pin, because the fork's own web preload module is the
    provider for upstream's `web-file-mutation-methods.ts`.

- **2026-10-19 — full-suite evidence, and where this machine's run stops short.** The suite was run
  in three passes because the local tail is environment-bound. (1) `pnpm test` (both projects) ran to
  completion once: 69 failing cases in 23 files, every one classified — the list below. (2) After the
  fixes, the `bun` project ran to completion on its own: **116,520 cases passed, 31 failed**, and every
  failing case is a recorded class — `pr-auxiliary-preflight-admission` (8, bash 3.2),
  `browser-*.electron.test.ts` (10) and `renderer-publication-throttle.electron.test.ts` (1) — all the
  no-Electron-window class, `orcad-forked-child-paths` (4), `packaged-cli-assets` (1),
  `cli-command-privileged-transaction` (1), plus two of the same class not yet listed:
  `macos-update-running-instances.integration` (`BrowserWindow.getAllWindows` undefined) and
  `shell-process-readiness`'s real-`lsof` case (30 s timeout). (3) The `node-runtime` project, run in
  the CI shape (`ORCA_BALANCE_UNIT_SHARDS=1`, which applies the repo's own exclude list), was clean —
  **0 failures** across the 1,320 files it reported — and then stalled with idle workers in the
  environment-bound tail, at the bench/integration files the repo's CI excludes and the electron
  tests that burn 40–180 s per case waiting for a window this harness never opens. That stall
  reproduces on unmodified code paths and is not attributable to a file this merge touched; the
  remaining files are not evidence of a regression, and no failing case was left unexplained.

- **2026-10-19 — what the first full run after the merge found, and what each failure was.** 69
  failing cases in 23 files, all classified; every one that was not already recorded below is fixed
  in this merge. The recorded reds reproduce unchanged: the macOS `/private/var` path signature
  (`packaged-cli-assets`, `macos-terminal-host-bundle`, all four `orcad-forked-child-paths` cases,
  `cli-command-privileged-transaction`), the bash 3.2 array failure in
  `pr-auxiliary-preflight-admission` (8), the dev-rebuild harness (`main-entry-facade`), and the
  relay-region test that needs the `cloud/` workspace.

  Fixed, in the order they were found — each one is a merge artefact no conflict marker showed:

  - **`process.emit` under `@types/node` 24.** The AI Vault service harness's two-argument emit does
    not typecheck against the 24.x typings (`sendHandle` is required); it now passes `undefined` like
    every other harness.
  - **Two spellings of one module.** `captured-output.ts` and `captured-git-output.ts` both existed
    after the merge, and `git-exec-file.ts` imported both (duplicate identifiers). Upstream's rename
    won and the fork's copy is deleted.
  - **The path/scope/target renames reached fork-owned files that nobody conflicted on.**
    `ephemeral-vm-runtime-{extend,reclaim}.ts`, `ipc/ephemeral-vm.ts`, `ipc/session-summary.ts`,
    `runtime-{project-setup-layout-mode,repository-relocation-controller}.ts` and the two
    `ephemeral-vm-runtime-*.test.ts` mocks were pointed at the new module paths;
    `shellEscape` became `quotePosixShell` (byte-identical) now that `ssh-connection-utils.ts` is
    gone; `jira-sprint-sorter.ts` follows the collator move to `shared/`.
  - **`stopProjectTerminals` forwarded only the deadline.** The controller decides, per removal,
    whether the project's native chats close; dropping the options object silently skipped that
    close, which is what `project-removal-structured-sessions` asserts.
  - **`repos:update` resolves the row before writing**, so the fork's `sharedDirectoriesMode` cases
    must stub `getRepo` — the assertion is now on the resolved target.
  - **The repo session-tab layout harness needed the new `subscribeWebRuntimeStatus` mock**, because
    the fork's workspace-name search subscribes at import time.
  - **The Codex adapter's new assertion pinned `orca-dev`**; this build's dev CLI is `orca-np-dev`.
  - **Upstream's new sidebar parity and golden suites do not know the fork's same-branch merge.**
    The parity harness compares the desktop render with the feed projection, so it now runs with
    `mergeSameBranchWorkspaces` off on both sides (the merge is a desktop presentation step, not
    plan identity). The six
    `__goldens__/sidebar-list-stamp-order` files were regenerated, and the differences are the
    merge's artefacts, all of them effects of two cards collapsing into one: one row instead of two,
    the survivor without a `hostLabel`, the section line still naming the merged-away occurrence,
    `renderedKeys` one lower, and — **not yet explained and worth a follow-up** — `cmd1-9 mounted`
    renumbers while `cmd1-9 unmounted` does not (so ⌘3 is `lab` in the mounted list and `orca-ssh`
    in the unmounted one), and a header still says `count=2` over a single row. Both predate this
    merge (the merge only changed which collision upstream's goldens capture); they are recorded here
    rather than fixed, and the header count and the ⌘-index divergence are the named next step.

- **2026-10-18 — merge of upstream `fc24ac3715` (628 commits) into the release line, from
  `12545ad17e`** (merge base `ac015cd3b2`, merge `db746c211b`, rollback tag
  `archive/pre-sync-12545ad17e`). The line was fast-forwarded to `12545ad17e` first, so PRs #129,
  #130 and #132 ship in this release. Upstream's window is the largest since this merge strategy
  started: the AI Vault parse cache moved from one JSON file to a per-row SQLite database, the
  sidebar row model became an object plan with its shared modules moved into
  `src/shared/sidebar-list/`, `setupScriptLaunchMode` was deleted outright, the workspace-space
  window replaced the dashboard popout on upstream's side of the zoom routing, and the checks
  panel, PR cache, agent-hook status and repository controllers were all reworked.

  The merge produced **89 conflicted paths** — `both-rewrote 52, union 29, duplicate-tail 5,
  rename-replay 2, modify/delete 1` — exactly the set the dry run named. Every decision is in
  [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-18 sync"; the
  ones a reviewer will want first:

  - **The AI Vault parse cache became upstream's.** Upstream deleted the JSON snapshot serializer
    the fork had extended to schema 6 and replaced the store with a SQLite database (layout version 4) plus a one-shot legacy importer. The serializer is deleted, nothing imported it, and the
    fork's `subagent` fields ride inside the row's `session` JSON. The importer's gate is widened to
    `[4, 6]` — the last JSON schema each line shipped — so a fork install keeps its cache instead of
    cold-scanning once; schema 5 is skipped because 6 exists to invalidate its Copilot titles.
  - **`setupScriptLaunchMode` is gone, and the fork's behaviour is what survives it.** Upstream
    deleted the setting and strips it on load; the fork's default was `new-tab`, so the host still
    spawns a dedicated Setup terminal and hands the window no `setup` payload — now with no
    launch-mode read and no split branch. The two renderer fixtures keep writing the retired key on
    purpose: they prove all three former locations produce one tab.
  - **The sidebar's shared row modules moved, and the fork's merge rides on the plan.** `row-types`,
    `group-keys` and `host-section-rows` now live in `src/shared/sidebar-list/`, `buildSidebarRowPlan`
    is `planSidebarRows(...)` with `.render(collapsedGroups)`, and `rendered-row-keys.ts` replaces the
    fork's `rendered-sidebar-row-keys.ts` (deleted). `mergeSameBranchRows` is byte-identical and still
    runs on the rendered rows. Five row-model goldens changed because the merge now lands in upstream's
    serialised shape — reviewed line by line, not blanket-updated.
  - **The web project keeps its own `worktree-path-comparison` copy.** Upstream consolidated it into
    `src/main/git/`, which drags `./runner` and the command-runner graph along; because
    `src/main/ipc/project-folder-placement.ts` is inside `tsconfig.tc.web.json`, pointing it at the
    consolidated copy fails the build with fourteen TS6307s. The fork's reduced copy stays listed in
    that project's `include`.
  - **The dashboard popout stays deleted.** Upstream kept editing the popout's zoom routing
    (`zoomDashboardPopoutIfFocused`, `closeDashboardPopout`) while the fork had deleted the window
    itself, so both `main-process-i18n-menu.ts` and `createMainWindow.ts` take upstream's new
    workspace-space call and only that — the ledger's § "Dashboard and the popout window" already
    ruled out restoring it to carry a fix.
  - **The checks panel's sticky label was the whole regression.** `check-run-details.tsx` was resolved
    to the stale side of a rename and kept the fork's `hasLogTail ? 'View full logs' : 'View full
    details'` conditional, which upstream had already collapsed to a constant. The tests find that
    action by accessible name, so a stale label failed as three different "lost feature" errors
    (worktree override, GitLab job id, sticky surface) that had nothing wrong with them.
  - **The PR cache's preserve-on-reject is now qualified.** PR #25's rule ("keep the last good PR
    cache entry when a refresh loses a race") had been merged unqualified, so it also preserved the
    entry in the case upstream added — main's newer hosted-review broadcast found no review, or the
    same number in another repository, and must delete it. It preserves only when the rejecting write
    is not newer than the result.

- **The Opus review of `db746c211b`+repairs came back ship-ready, and two findings landed as
  `a37f0a5165`.** `claude/opus` at high reasoning, tool-enabled, over `git show --remerge-diff
  db746c211b` plus the repair commits, told not to accept these docs as evidence: no blockers.
  - The legacy AI Vault JSON gate admitted schema 4 as well as 6, on the premise that 4 was the last
    JSON schema upstream shipped. That premise is false — the file lives in Orca NP's own
    `appData/orca-np`, so only fork builds wrote it — and 4 and 5 are exactly the two versions whose
    faults 6 exists to invalidate (a 4 row titles Copilot sessions with the `<current_datetime>`
    prefix; a 5 row carries `subagent: null` and puts every Pi sub-agent transcript at top level).
    The gate is now `[6]`, and the discard test covers 4 and 5 by number instead of borrowing the
    database's own version constant.
  - The merge ported only half of upstream's `!remoteOwned` guard into
    `getStatusBarUsageProjection`: `settings` was nulled for a remote owner, but
    `antigravityUsageConfigured` was still computed from _this_ machine's `agy` detection, so a
    remote account owner could show an empty Antigravity bar. `remoteOwned` now threads in and gates
    the flag.
  - Also deleted `preserved-branch-removal-completion.ts`, which the merge orphaned.
- **A divergence-debt audit ran before the release, and the debt it found was paid down
  (`46f640a501`).** The maintainer's rule is that a merge must not leave debt behind: no fork copy of
  something upstream now owns, no fork-only rename where upstream's name costs nothing, no two live
  paths for one job. An Opus audit found 11 items; seven were fixed, four recorded.
  - **Fork copies of upstream's own modules are gone**: `linear-handler-groups.ts` (upstream's
    `LINEAR_HANDLER_GROUP` now fits the max-lines budget upstream itself solved by extracting it),
    `ai-vault-session-ids.ts`, a duplicate `isRuntimeScopeForbiddenError`, duplicated usage-warning
    constants, and a dead `getDefaultBaseRef` wrapper. Each had a live importer, so the importers
    moved rather than the code being re-written.
  - **Two cosmetic renames were undone so the next sync conflicts visibly instead of silently**:
    `right-panel-comment-focus-timers.ts` and `ui-slice-hydration-status-bar-items.ts` are upstream's
    files again, with the fork's rows edited in place. The second matters most: the fork had _deleted_
    upstream's file to add three default-on providers, which means a future upstream default-on
    provider would have been missed rather than merged.
  - **One job, one vocabulary**: the Jira priority chips now use upstream's `jira-priority-*` tokens
    and the fork's parallel `--severity-*` scale is gone from both themes. Hues shifted with it
    (blocker red-700 → `#e40014`, dark red-300 → `#ff6568`, major orange → amber) because the
    surviving tokens resolve through `--destructive`/`--status-warning`.
  - **Two half-ported upstream changes were completed.** `getStatusBarUsageProjection` never carried
    upstream's `zcodePlanApiKeyConfigured` or its ZCode PATH exemption, so a saved GLM plan key with
    no CLI on PATH showed no meter; the projection now takes both, and a new test fails if either the
    ZCode exemption or the `!remoteOwned` Antigravity gate regresses. `orcadCredentialRoot()`
    hardcoded the upstream home, so the headless server's secret store enumerated and sealed an
    official Orca's credentials while missing this build's own — it resolves through
    `HOME_DIRECTORY_NAME` now.
  - **Left open, by name**, so the next release does not have to rediscover them:
    1. `task-page-jira-priority-badge.tsx`'s docstring says `data-severity` separates the tiers; it does
       not — nothing in `src/renderer` selects on it, and the linked-issue pane has no surface wash at
       all, so there the label is the only separator. Wording fix, no behaviour.
    2. `getJiraPrioritySeverity` trims the priority name and upstream's `getJiraPriorityTone` does not,
       so a name of `" Blocker "` earns a tier and a wash but a grey chip. Upstream's list cell has the
       same asymmetry; fix both sides or neither.
    3. The `orcadCredentialRoot()` commit message (`3074852b7c`'s follow-up) overstates the old bug: the
       credential _targets_ always resolved the fork's home, so the defect was the headless server's
       sealing key living beside an official Orca's key state, not that it sealed that app's secrets.
  - **Recorded rather than changed**: the `aiVaultSearch.contentEnabled` tier rename (a persisted
    settings key; three earlier syncs paid for it, but changing it is a migration, not a cleanup);
    `accounts-search-extra-providers.ts` and `worktree-remove-method.ts` still move _upstream's_ code
    out to make room for the fork's, which is the same shape as the projection bug above and should be
    inverted next time those files are touched; `jira-api-error.ts` keeps a parallel error class; and
    `dashboard-payload-validation.ts` keeps upstream's bytes declined because the fork's
    `cardClickAction` validation is load-bearing.
  - Carried as notes, not fixed: upstream's `mkdir -m 700` on the publish directory is still dropped
    (the parent transaction directory is 0700, so it is not exploitable); the qualified
    `preservePRCacheOnReject` leaves the "hosted-review-only write newer than the result" case
    deleting the paired PR entry, which is upstream's rule and is covered by upstream's own test but
    not pinned by a fork test; two sidebar goldens freeze a pre-merge Cmd+1–9 ordering disagreement
    between the mounted and unmounted lists rather than a regression this merge introduced.
- **The five over-cap files were split, not capped** — `ssh-types.ts` (311),
  `agent-hook-listener.ts` (307), `server-state.ts` (301), `CheckRunDetailsPanel.tsx` (434),
  `settings.test.ts` (814). The extracts are `ssh-target-visibility.ts`,
  `agent-hook-listener/inherited-pane-owner-guard.ts`, `forgetAgentExitForPane` in
  `agent-exit-evidence.ts`, `editor/check-run-details-status.ts`, and one parameterised `it.each`
  where the file had two copies of the same durable-flush test. No disable, no baseline bump.
- **Auto-merged breaks the typechecker caught** — the typecheck ran after every cluster, and found:
  three module paths the renames orphaned (`@/store/slices/github-cache-key`,
  `grouping/row-types`, `grouping/build-rows`), a duplicate `...LINEAR_HANDLER_GROUPS` entry in
  `handler-group-manifest.ts` that made every CLI suite fail to load (duplicate command key, 57
  files), a `GlobalSettings` field the disposition map did not carry
  (`alwaysForceDeletePreservedBranches`, `claudeAccountSwitchRunningSessions`, `nativeChatProviders`,
  `sshRemoteCliControlExistingHostsMigrated`), the fork's three usage providers dropped from
  `owner-usage-rate-limits.ts`'s exhaustive record, and two files still importing the
  `worktree-path-comparison` path upstream removed.
- **Deletions reviewed, none of them a lost feature.** `post-sync`'s deleted-export scan names five
  exports of three files that existed at the merge base: `codex-account-restart-startup.ts` (upstream
  deleted it and its importers), `worktree-activation-test-harness.ts` (superseded by
  `worktree-activation.test-fixture.ts`, whose `setLegacySetupScriptLaunchMode` keeps the retired-key
  regression) and `tests/e2e/helpers/setup-split-and-sleep-journeys.ts` (the setup-split journeys the
  retired launch mode took with it). `pnpm tc` is clean, so nothing references them.
- **Left failing, and proved not ours.** Ten files, in three classes, none of which this merge's
  resolution touches:
  - _macOS path semantics._ `src/main/cli/packaged-cli-assets.test.ts` is the documented one from the
    2026-10-16 sync — the darwin launcher's `app_realpath` uses `cd -P`, resolving `/var` to
    `/private/var` while the test builds its path from the unresolved `os.tmpdir()`. The same
    signature takes `config/scripts/macos-terminal-host-bundle.test.mjs` (a `yaml` decoy read as
    "outside the helper") and all four `src/main/orcad/orcad-forked-child-paths.test.ts` cases (that
    file is upstream's, and `src/main/orcad/**` had no conflicted path in this merge).
  - _Host toolchain, not the tree._ `config/scripts/pr-auxiliary-preflight-admission.test.mjs` (8 of 194) fails on `bash: MOBILE_CI_ARGS[@]: unbound variable` — macOS ships bash 3.2, where an empty
    array under `set -u` is an error. `config/scripts/process-host-dev-rebuild.test.ts` (6 of 8) and
    `config/scripts/main-entry-facade.test.ts` time out or mismatch inside the dev-rebuild/build
    harness. `src/main/ssh/ssh-relay-endpoint-incumbent-shell.integration.test.ts` and
    `tests/e2e/cursor-quota-transport.unit.test.ts` time out per test (46s and 62s).
  - _No Electron window in this harness._ `browser-session-ua-wire-identity.electron.test.ts` (5),
    `browser-session-ua-wire-identity-cross-context.electron.test.ts` (2) and
    `browser-route-persisted-worker-egress.electron.test.ts` (1) each fail at exactly their per-test
    timeout (40s/60s/180s) with no assertion reached; all three are upstream's, under
    `src/main/browser/`, which had no conflicted path here.
  - The previously recorded reds still reproduce unchanged: the AI Vault stale-lineage case
    (`session-search-file-write.test.ts`, see the 2026-10-16 entry) and the workspace path index
    admission test, which passes in isolation and fails only under full-suite load.
  - **`check:code-quality:changed` reports one finding, and it is an install artefact.**
    `mobile/src/host-screen/host-worktree-child-navigation.test.tsx:76`
    (`no-redundant-type-constituents` on `ReturnType<typeof create> | undefined`) only appears because
    `mobile/node_modules` is not installed in this worktree: `@types/react-test-renderer` is a mobile
    devDependency, so `create` degrades to `any` and the union looks redundant. The file is upstream's,
    byte-identical to `upstream/main`, and dropping the `| undefined` to satisfy a missing type package
    would break the typed build. This is the mirror image of the trap the 2026-10-16 entry records —
    there the mobile graph resolving to nothing made oxlint exit 0, here it invents a finding.

- **2026-10-16 — merge of upstream `ac015cd3b2` (60 commits) into the release line, from
  `e27bc2efbf`** (merge base `e8c7b32a90`, merge `ae9db02137`, backup
  `backup/nplez1-main-pre-sync`, rollback tag `archive/pre-sync-e27bc2efbf`). The line was
  fast-forwarded to `ac70d2bad0` first, so the seven merged PRs (#113, #114, #116, #120, #121,
  #122, #123) ship in this release. The upstream-branch workflow left `origin/main` where it
  was.

  Pre-flight failed once, on the derived runtime-required English catalog: two post-sync Jira
  cleanups dropped the literal-default call sites for `jira.copy.actions`, `jira.copy.context`
  and `jira.workspace.openFailed` without regenerating it, and the generator keeps every
  `en.json` entry no call site carries a literal default for. Regenerating it (`e27bc2efbf`) was
  the gate's required state. The drift predates this sync — neither commit (`9e8e83bef8`,
  `8932ce3b1a`) is in it — and no commit pulled in today touched either file.

  The merge produced **31 conflicted paths** — `both-rewrote 24, union 5, modify/delete 1,
  rename-replay 1` — the same 31 the dry run named. Upstream's window was mostly the AI Vault
  scan-progress work (#28788, #29126), a provider-account-services extraction, the credential
  stores moving onto a `SecretStore` port, a runtime mixin rework, and the "trim redundant
  tests" consolidation (#29156).

  - **The AI Vault scan seam gained a parameter on both sides.** Upstream put a progress handle
    where the fork put `request: { refresh, query }` — the same third argument of
    `scanAiVaultSessionsInService`. Both are kept, request third and progress fourth, and
    `cached-session-list.ts` passes both. Everything else about the scan follows upstream:
    `scanReportingProgress` returns upstream's `{ result, work }`, and the fork's index-first
    listing answers from `sessionSearch.listSessions` when it can, falling back to the scan with
    `work: null` — an indexed list runs no scan, so there is no tally to report.
  - **The query is part of the scan's scope key, inside upstream's helper.** Upstream replaced
    the fork's inline key with `aiVaultLocalScanScopeKey`/`aiVaultLocalScanKey`; the fork's rule
    (a filtered listing must never be served for an unfiltered request) is re-expressed in
    `aiVaultLocalScanScopeKey`, so the cache key and the coordinator key still agree and the
    renderer's `requestedScanKey` still matches the host's.
  - **The fork's provider wiring moved onto upstream's extracted module.** Upstream pulled the
    desktop's inline account-service construction into `createProviderAccountServices`, which
    the desktop and orcad share. The fork's DeepSeek/Fireworks/Copilot config resolvers, the
    `disabledUsageProviders` gate on `RateLimitService`'s construction, the enable/disable
    settings hook and the gated `gh auth status` warm-up moved with it, so both entry points get
    them. **This is what turned the runtime-electron ratchet red** (below).
  - **The credential stores converged on the `SecretStore` port.** Both sides replaced Electron's
    `safeStorage` in the same files. Upstream's inline `getSecretStore()` calls are kept, with
    the fork's sealed-vs-plaintext rule, its "secret encryption unavailable" wording and its
    `adoptLegacyHomeStore()` identity intact. The fork's test mocks — a plain `secretStoreMock`
    plus `_resetSecretStoreForTests()` — are kept over upstream's per-suite `setSecretStore`
    calls, because they were already the port and they reset.
  - **Upstream's test consolidation was taken, with the fork's expectations re-homed.**
    `accounts-pane-claude-section.test.tsx` is deleted (both of its cases now live in
    `AccountsPane.test.tsx`), and `tui-agent-startup.test.ts` became an import barrel over
    upstream's new `.spec.ts` files, so the fork's `orca-np` launch expectations moved into
    `tui-agent-startup.spec.ts`. One test name is the fork's (the local Claude Agent Teams
    case), the rest are upstream's; the expectations and two SSH-relay comments are the fork's.
  - **`use-section-rows.ts` was split, not raised.** Upstream keeps it at the `max-lines` budget,
    so the fork's same-branch merge overflowed it and the commit hook caught it. The
    rendered-row key collector moved to `rendered-sidebar-row-keys.ts` and the merge policy to
    `use-merged-sidebar-rows.ts` — the ledger's standing remedy.
  - **The breaks no conflict marker showed, all repaired (`96824ecfd7`).** `pnpm tc` found four:
    the scan signal passed twice, after the resolution put two arguments side by side;
    `AccountsPane.test.tsx` needing the fork's provider fields on its section model; upstream
    removing `WorktreeRow.lineageTrail` under three fork fixtures; and upstream's own new
    account-label test using the identifier `issue`, which the fork's half of that file had
    renamed to `linkedIssue` for its `issue()` helper — upstream's test text resolved to a
    function.
  - **The full lint chain was red, three items of it before this sync (`e3fc6d2e1c`).** `pnpm
    lint` is a wider gate than post-sync's three localization/type checks, and at the pre-sync
    tip it was already red on the ts-nocheck ratchet
    (`workspace-process-listing.ts`, from the 2026-10-15 sync's mixin base-class swap) and on the
    focus-read ratchet (five Jira files). Both were re-run at `e27bc2efbf` in a fresh worktree
    and reproduce identically there; both were recorded in their baselines with a dated note and
    their reason. The ts-nocheck one lasted only until the review below, which found the chain fix
    that removes it outright. The
    fourth red, and the only one this sync caused, was: upstream's `provider-account-services` extraction makes orcad
    build `RateLimitService`, which statically reaches the fork's DeepSeek and Fireworks
    fetchers, and those imported `net` from Electron directly. Both now read the host HTTP port
    the way the Gemini and Kimi fetchers already do (`getMainHttpClient()`), which the ratchet
    accepts and both provider suites still pass; their own suites install the port instead of a
    fake `electron` module (`6424ea5833`). The catalogs verifier's red was the previous merge's:
    a stray top-level `settings.appearance.chat.title` dotted key left beside the nested object
    upstream had already moved it into.
  - **One failure proved not ours, the way this section asks for it.**
    `src/main/ai-vault-search/session-search-file-write.test.ts` ("clears a stale lineage when a
    re-read says the session is a root") fails identically at the pre-sync tip `e27bc2efbf` in a
    fresh worktree — 1 of its 25 cases, leaving a stale `subagent_parent_session_id` in the
    index. Every module it imports is byte-identical to the pre-sync tip and this sync did not
    touch `src/main/ai-vault-search/`, so it is recorded rather than chased.
  - **The Opus review found two must-fix items, and both are fixed.** `claude/opus` at high
    reasoning, tool-enabled, over the merge diff (`git show --remerge-diff ae9db02137` plus the
    repair commits), told not to accept these docs as evidence. The first was that the
    `@ts-nocheck` recorded above **was avoidable**: upstream already declares those
    forward references in `workspace-process-listing-dependencies.ts`, and the 2026-10-15 sync
    orphaned that layer by re-pointing the file at `OrcaRuntimeWithSetupRunnerState` directly.
    Chaining the two — `OrcaRuntimeWithWorktreePsDependencies` now extends the fork's
    `OrcaRuntimeWithSetupRunnerState`, and `OrcaRuntimeWithGetWorktreePs` extends it in turn —
    removes the suppression: `pnpm tc:node` is clean without it, the ratchet is back to its one
    grandfathered entry, and the file sits closer to upstream than the fork had left it. The second
    was user-visible: on the index-first path `work: null` reached `finish()`, which published a
    finished row with no tally, so the strip read "Scanned 0 files" with a tick on the default path.
    `finish()` now publishes nothing when there is no work and nothing was ever reported, with a
    case for the index answer in `ai-vault-scan-progress-flow.test.ts`. Its two lesser findings are
    fixed too: eight keys upstream had deleted with their call sites came back in the `en.json`
    union (`queuePaused*`, `sendConfirm*`, plus the fork's own dead `queuePausedCleared`), and
    `components.native-chat.find` was still duplicated by a 2026-10-09 fork commit.
  - **Two side effects of the merge worth naming.** The commit hook's `oxfmt --write` normalised
    about a dozen upstream files the merge had touched — wrapped calls the union pushed past the
    print width. That is the repo's own formatter doing what `pnpm format` would, but it is diff
    surface upstream owns, and it is why `git show --remerge-diff` lists files outside the 31. The
    second is a behaviour change on orcad: the fork's provider wiring now runs there too, per the
    ledger's decision, so orcad builds the DeepSeek/Fireworks/Copilot resolvers against its own
    credential store and spawns the `gh auth status` warm-up unless Copilot is disabled. Intended,
    and new for that host.
  - **What the run produced.** post-sync reports 9 of its 10 checks passing and one informational:
    conflict markers, the identity sweep (1168 report-only findings), the derived catalog
    regenerating to no diff, both localization verifiers, the builder config, the update-feed
    references, the deleted-module surface scan, oxlint and `pnpm tc` all pass, and the red-flag
    scan flags three files this sync touched deliberately —
    `src/main/runtime/workspaces/workspace-process-listing.ts` and
    `…-dependencies.ts` (the chain fix above) and `config/focus-setting-read-baseline.txt` (the
    recorded counts). The changed-code quality gate reports 0 findings across 947 changed files;
    `pnpm lint` is green end to end; and the touched areas' suites ran 4,600
    tests — 4,581 passing, 18 skipped, and the one pre-existing failure above. The **mobile web
    bundle fence was not re-measured**: `mobile/node_modules` is not installed here, so
    `pnpm build:mobile-web` cannot run. Its only input, `mobile-web-page-routes.mjs`, was
    touched by neither side in this range (diffed against `e27bc2efbf` and `ac015cd3b2`), so the
    sweep is not staled — but the per-route script counts against the four-script margin are
    unmeasured on this tree.
  - **The full `pnpm test` run still does not complete in this environment, and the release says
    so.** Unchanged from the 2026-10-15 entry: the runner stalls at 0% CPU with no summary, the
    file that holds the worker open passes its assertions and never releases it, and it is
    pre-existing (reproduced with two reporters and under sharding). It is being tracked as its
    own work in the separate `hunt-vitest-nonexit` worktree, and this release does not block on
    it.
  - **Follow-ups opened by this sync, by name.** (1) Route the fork's remaining Jira
    `activeRuntimeEnvironmentId` reads through the resource owner; the focus-read baseline now
    records four more files and pruned one, dated. (2) The port hop is done for the two fetchers
    this sync exposed — check the other fork-only rate-limit paths the same way. (3)
    `local/sync/post-sync.mjs` should run `verify:localization-catalogs` too: its dotted-key check
    is what would have caught the previous merge's stray key, and the duplicate-key check the
    `native-chat.find` one.

    One further upstream file is edited by this sync:
    `.github/scripts/check-required-pr-context.mjs`, where the changed-code gate rejected upstream's
    untyped array interpolated into a template literal, so the message reads
    `${owners.join(', ')}`. Behaviour is unchanged, and it is one line to reconcile at the next
    sync.

- **2026-10-15 — merge of upstream `e8c7b32a90` (311 commits) into the release line, from
  `bb043b9724`** (merge base `8b0fa15e943b`, backup `backup/nplez1-main-pre-sync`, rollback tag
  `archive/pre-sync-bb043b9724`). The upstream-branch workflow still leaves `origin/main` where it
  was; nothing here touched it. The pre-flight gate passed on the fork tip before any resolution.

  The merge produced **88 conflicted paths** — `both-rewrote 51, union 20, rename-replay 6,
  modify/delete 5, add/add 4, duplicate-members 2`. Upstream spent the same window building the same
  Jira features this fork built, so roughly a third of the conflict set was one idea implemented twice
  on both lines (assignee search and _Assign to me_ #28612, a board and current-sprint filter #28633,
  required transition fields #28588, planning columns #28615, linked-workspace views #28590). The
  convergence is recorded in [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md)
  under five new sections; the short version is **per capability, not per feature**: upstream's shape
  wins wherever it is a superset, and every fork addition is re-expressed on top of it.

  - **The Jira line, converged without losing the fork's half.** `JiraTransition.requiredFields`
    became upstream's canonical `fields`, with the fork's one rule inside it (a required field Jira
    will default itself is not the user's to fill) re-homed into
    `src/shared/jira-transition-fields.ts` so upstream's `classifyTransitionRequirements` inherits it.
    `jira-transition-queries.ts` takes upstream's version wholesale. `JiraIssueUpdate` carries both
    upstream's `transitionComment` and the fork's shaping keys. `jiraAddIssueComment` gained an
    **optional** `bodyFormat` — required would have broken upstream's four-argument call site. The
    fork keeps what upstream has no counterpart for: self-hosted Server/DC _body_ rendering,
    editmeta custom-field editing, sprint assignment, the configured agile board with drag-drop
    transitions, board settings, priority tone, and the generic transition-fields dialog (upstream
    handles only resolution + comment and calls anything else `unsupported`).
  - **Two `JiraApiError` classes became one.** Upstream split a second class into `jira-api-error.ts`
    whose `toJiraApiError` nothing in the merged tree calls, while every real `instanceof
    JiraApiError` site tests the fork's class — so auth classification would have depended on which
    module threw. That file now re-exports the single class, and the constructor accepts upstream's
    positional boolean as well as the fork's detail object, so upstream's own call site is unchanged.
  - **Upstream retired its own Orca/Hermes automation target; no fork work went with it.** The merge
    stages ~2,455 deletions across 77 `components/automations` files, which looks exactly like a merge
    eating fork work. The test that separates the two: the deleted files (`automation-hermes-save.ts`,
    `hermes-cron-output-parse.ts`, `ExternalAutomationRunTable.tsx`, …) exist at the merge base **and**
    at the fork tip but not upstream, and the fork's only contribution anywhere in that feature was
    `cd3e64b6cf` substituting `APP_DISPLAY_NAME` for the app name in a toggle upstream removed. The
    orphaned import was deleted; the feature is not re-added.
  - **Silent losses found by machinery, not by conflict markers.** Three more of the class this
    section has recorded before, each fixed rather than tolerated:
    - _Upstream replaced an inheritance chain with composition._ `RuntimeFileCommands` now holds
      `search`/`access`/`reads`/`mutations`/`watches` sub-objects, and the merge deleted
      `runtime-file-command-access.ts`, `runtime-file-search.ts`, `runtime-file-command-host.ts` and
      `runtime-file-command-target.ts` with it. The fork's `searchWorkspacePathNameFilter` lived only
      in a module inheriting from the deleted one, so the merge left it with three dangling imports
      **and no caller**, while `runtime-file-command-surface.ts` still required the method and
      `rpc/methods/files.ts` still called it. Re-homed onto upstream's composition — and note the
      2026-10-13 entry below already says of this same module "do not delete it again"; the local half
      is what the web client and paired desktops use.
    - _Upstream made a runtime mixin `abstract`._ `OrcaRuntimeWithStartTuiIdleVisibleReadProbe` moved
      under `terminal/wait/` and became abstract, so the fork's two concrete mid-chain classes were
      suddenly required to implement 119 inherited members. Both are `abstract` now, matching
      upstream's chain, and the requirement propagates to the same concrete endpoint as upstream's.
    - _An upstream field was dropped from a persisted type._ The auto-merge took the fork's shape of
      `PersistedUIState` and lost upstream's `dashboardPopoutBounds`, which upstream's own
      schema-parity check then caught. Restoring it exposed a second gap: upstream's new
      `wsl-move-ui-dispositions.ts` asserts every `PersistedUIState` field is classified, and the
      merged type now carries five fork-only fields. All six entries were added, and the same class of
      gap was fixed in the storage dispositions too (the fork's `jira-board-view-storage.ts` in the
      localStorage map, upstream's `ai-vault-search.sessions_fts` in the SQLite map). **The sweep test
      that caught these is the general form of the trap** — after a sync, every exhaustiveness map
      upstream adds has to learn the merged content.
  - **Five `max-lines` overflows, all fixed by splitting, none by a cap bump.** Upstream keeps
    several files at exactly the budget, so a union overflows with no marker and no type error:
    `rpc/methods/jira.ts` 324→292 (the four board methods moved to `jira-board-methods.ts`),
    `task-page-jira-issue-list.tsx` 488→144 (`JiraIssueRow` → `task-page-jira-issue-row.tsx`),
    `worktree.ts` 301→258, `runtime-project-host-setup-controller.ts` 301→274,
    `use-task-page-jira-list-effects.ts` 312→279. One `max-lines` overflow came from the coordinator's
    own repair (`global-settings-types.ts`, 301), fixed by moving the worktree-layout settings field
    into `orca-workspace-layout.ts` and intersecting it — the pattern that file already used.
  - **The focus-read ratchet was raised deliberately, with its cause named.** Four Jira surfaces
    gained owner-aware reads from the merged upstream work (`JiraIssueWorkspace.tsx` 1→2,
    `jira-issue-workspace-side-data.ts` 6→8, `task-page/jira/Board.tsx` 3→4,
    `runtime-jira-board-client.ts` 3→4). The fork's owner-routing migration is the standing follow-up
    from 2026-10-11 and this sync did not take it on, so the counts are recorded in
    `config/focus-setting-read-baseline.txt` with a dated annotation — the same action the 2026-10-11
    entry above took for the same reason.
  - **Two failures proved not ours, the way this section asks for it.**
    `src/main/cli/packaged-cli-assets.test.ts` reproduces **identically** on the pre-sync tip
    `bb043b9724` in a fresh worktree (the darwin launcher's `app_realpath` uses `cd -P`, which resolves
    macOS's `/var` → `/private/var` symlink while the test builds its path from the unresolved
    `os.tmpdir()`), and the test file plus both launcher assets are byte-identical at `HEAD`.
    `src/main/workspace-path-index/workspace-path-index-publication-admission.test.ts` is fork-only and
    unchanged, passes 3/3 in isolation twice, and fails only under full-suite load — a `vi.waitFor`
    default timeout expiring while the bundled worker still reports `reason: 'building'`. Both are
    recorded rather than chased, which is the standing convention here.
  - **The four red-flag files reviewed.** `post-sync.mjs` flags files modified here that upstream
    never touched in the range; all four are deliberate and none is a lost feature:
    `src/main/agent-hooks/first-work-folder-rename.test.ts` (nodefix: the `makeDeps` fixture now
    resolves `worktreeLayoutMode`, which the merged `WorktreePathSettings` requires),
    `src/renderer/src/components/quick-open-file-list.ts` (the Quick Open convergence above),
    `src/shared/orca-workspace-layout.ts` (the new `OrcaWorkspaceLayoutSettings` slice) and
    `src/shared/rpc-contract/client-ui-params.ts` (the restored `dashboardPopoutBounds` schema entry).
  - **The full `pnpm test` run does not complete in this environment, and the release says so.** The
    runner stalls at 0% CPU with no summary — reproduced with the default and TAP reporters and under
    four-way sharding — and it is **pre-existing**: the file that holds the worker open
    (`persistence-loading-store-extraction.test.ts`) passes its 10 assertions but never releases the
    runner, is byte-identical at the fork tip, and excluding it does not clear the stall, so at least
    one more file waits on something that never arrives. It is being tracked as its own work.
    What the run did produce: two of four shards completed, **~62,000 tests passing**, and every
    failing file was triaged — the merge-introduced ones fixed (the Jira renderer and detail surface,
    two identity tests pointing at a literal `~/.orca` where production writes `~/.orca-np`, an
    incomplete `Orca NP` tray re-point, a capability list short of `armWorktreeSetupRunner`), and the
    rest proven pre-existing (the darwin launcher's `cd -P` resolving macOS's `/var` → `/private/var`),
    environment-bound (the relay region test needing the uninstalled `cloud/` workspace) or a
    load-dependent flake (`workspace-path-index-publication-admission` passes 3/3 in isolation).
    Three PTY files that get no child output under the `bun` project were re-seated into
    `NODE_RUNTIME_INCLUDE`, which is the documented fix for that gap.
  - **Follow-ups opened by this sync, by name.** (1) `local/sync/post-sync.mjs` should gain the
    fork-only reference sweep that found the orphan above: take every `src/` path from the pre-sync
    fork-only inventory, resolve every relative and `@/` import specifier in the tree, and report each
    fork-only file nothing references. Run by hand it found that module plus four pre-existing dead
    files. (2) `Content.tsx` currently exposes two board surfaces — the configured agile board and
    upstream's status board over the current result set — deliberately kept apart because unifying
    them is a UI decision, not a sync decision. (3) The Quick Open list-target helpers are a known
    duplicate that this sync converged onto upstream's pair.

- **2026-10-14 — released as `v1.4.214-np.30`** from `419cdb689e` (workflow run 38508995384, attempt 2,
  signed and notarized, both macOS slices plus Windows), onto upstream `8b0fa15e94`, from the
  released tip `v1.4.214-np.26`. The release needed two fork-local build fixes that the sync's own
  upstream merge introduced, both found by the packaging gates that arrived with it (see
  `local(ci)` and the new `local(build)` note below): a configurable terminal-host boot deadline, and
  the fork's own signing team instead of upstream's. Three earlier attempts (runs 28 and 29) failed
  inside those gates and left only drafts, which are deleted; nothing was published from them.

- **2026-10-13 — merge of upstream `8b0fa15e94` (389 commits) into the release line, from
  `dcb5ddfbc1`** (merge base `cc5c85fb7a`, rollback tag `archive/pre-sync-dcb5ddfbc1`). The merge
  produced **68 conflicted paths** — `both-rewrote 34, union 23, modify/delete 8, duplicate-tail 2,
  duplicate-members 1` — as the dry run predicted. Pre-flight failed once, on the derived catalog:
  the four `ExperimentalPane.agentDashboard` entries the 2026-10-11 repair of
  `AgentDashboardExperimentalSetting.tsx` left behind have literal defaults identical to their call
  sites, so the generator no longer requires them; regenerating and committing that
  (`dcb5ddfbc1`) was the gate's required state.

  - **The SSH convergence is now finished, not extended.** Upstream retired the last relay-era git
    and quick-open plumbing: `SshGitWorktreeProvider`, `removeRegisteredRemoteWorktree`,
    `runtime-registered-remote-worktree-removal`, the `getSshFilesystemProvider` branch of
    `fs:listFiles`, and — with them — the **SSH half** of the fork's path search
    (`filesystem-remote-path-search.ts`, its test, `ssh-filesystem-provider-crud.ts`, the
    `remote-session-scanner-*` family's copilot source, and the two `IFilesystemProvider` hooks
    `searchWorkspacePathNameFilter`/`workspacePathSearchCapability`). Those had no surviving
    implementation to call, so the deletions are adopted rather than reverted: `fs:searchFilePaths`
    answers an SSH target with an empty result the way `fs:listFiles` does, and a `files.searchPaths`
    name-filter request over an SSH route answers an `unsupported` partial response.
  - **The local half of that module was live and is kept — do not delete it again.**
    `RuntimeFileCommandsWithWorkspacePathSearch` has two branches, and only the SSH one was dead: the
    `else` branch runs `searchQuickOpenFilePaths` for a non-SSH runtime route, which is exactly the
    path the **web client and paired desktop clients** take through `files.searchPaths` with
    `mode: 'name-filter'` (`web/preload-api/web-workspace-path-search.ts`,
    `runtime-workspace-path-search-client.ts`). This sync first deleted the whole module and routed
    `files.searchPaths` through `searchMobileFilePaths`; the Opus review of the sync caught it as
    ship-blocking, and `runtime-file-commands-workspace-path-search.ts`, `runtime-file-command-access.ts`,
    `runtime-file-command-surface.ts`, `files.ts` and the fork's `files-path-search.test.ts` were
    restored with only the SSH branch replaced by the partial response above. The local IPC handler
    (`fs:searchFilePaths`, the worker-owned path index) was never affected.
  - **`deleteRemoteBranch` survives, on the local path only.** Upstream now routes every removal
    through `removeRegisteredLocalWorktree` and refuses `repo.connectionId` with
    `SshHostNotServedError`, so the fork's relay-era remote variants of that path are gone; the
    option keeps flowing from the RPC params to `git worktree remove` on the local path, which is
    the ledger's existing "Worktree create and removal" decision unchanged.
  - **An automation create must not stage setup twice.** Upstream's new
    `provisionManagedWorktreeTerminals` provisions an automation's setup and default tabs in main,
    and it arrived in the same sync as the fork's `setupScriptLaunchMode`-aware guard — so with no
    startup command the fork spawned a Setup terminal _and_ handed `setup` to the provisioner. The
    guard now also returns early when the host provisions (`spawnLocalStartupAndSetupTerminals` takes
    `provisionedByHost`), the automation test asserts `runtime.createTerminal` was never called, and
    the app-window test asserts the Setup terminal _was_ created. Also caught by the Opus review.
  - **The release needed a longer terminal-host boot deadline, and the cause was measured, not
    guessed.** Upstream added `verifyPackagedMacTerminalHostBoots`, which requires the packaged
    `Orca Terminal Host.app` for each slice to serve a PTY within 20s. On the fork's GitHub-hosted
    arm64 runner the x64 slice is built cross-arch and booted under Rosetta, and three np.28
    attempts stalled at three different stages (no daemon token, no handshake, no PTY output).
    With Rosetta installed locally the whole chain proved sound — x64 `node-pty`
    (`Mach-O 64-bit bundle x86_64`), the pinned x64 Node spawning a PTY, the daemon entry completing
    the check's own `runTerminalHostRoundTrip` with an arm64 _and_ an x64 client, and a
    packaged-shaped helper passing the real `verifyPackagedMacTerminalHostBoots` — at **13.9s of the
    20s budget** on an idle machine. So the workflow raises the budget
    (`ORCA_TERMINAL_HOST_BOOT_TIMEOUT_MS=120000`) and the check keeps its default; see
    `local(ci)` in this file for the one-line reader and the reasoning.
  - **The fork's reconnect direct-SSH scoping went with its type.** Upstream deleted
    `ReconnectPersistedTerminalsOptions` and the `directSshAuthority` plumbing along with
    `direct-ssh-retry-status.ts` and `hidden-restore-state-and-ssh-probe.ts`; the fork's extra
    parameter was already dead at the call sites (all of them pass a signal only), so the removal is
    adopted and `publishPersistedTerminalHints` — the fork's extraction, used by the slice type and
    its suite — is kept.
  - **`en.json` was hand-unioned, not resolved by picking a side.** Both sides had rewired large
    parts of the source catalog, and this time the merge conflicted (12 hunks) instead of
    auto-merging. The union was computed as a three-way JSON merge with the fork's key order as the
    spine: **0 true conflicts**, 69 keys dropped because upstream deleted them and the fork never
    changed them, 618 fork-only keys kept, and the derived `en-runtime-required.json` regenerated
    (never hand-merged). The 69 drops were checked against the source tree — none of them is
    referenced by code — and `verify:localization-extraction` agrees. The technique is now in the
    ledger's localization entry so the next sync does not re-derive it.
  - **The `check:owner-routing-ratchet` → `check:focus-read-ratchet` replacement is not a loss.**
    Upstream split the ratchet into `check-focus-read-ratchet.mjs` and
    `check-layout-writer-ratchets.mjs`, and the file the new script reads is the fork's own
    `config/focus-setting-read-baseline.txt`, which still carries the thirteen Jira/Linear files the
    2026-10-11 sync registered. The lint chain now names the new scripts; the old script and its
    three helpers (`countFocusRoutingCalls`, `formatBaseline`, `parseBaselineNotes`) are gone with
    nothing to re-home.
  - **Three files upstream left at the `oxlint` max-lines budget needed room for the fork's
    additions** — and one had none left to give. `handler-group-manifest.ts` (exactly 300 code
    lines upstream, +1 from the fork's `repo relocate` key) now spreads `LINEAR_HANDLER_GROUPS` from
    a new `linear-handler-groups.ts`, mirroring upstream's own `browser-handler-groups.ts`, which
    also buys headroom for the next sync; `protocol-version.ts` reached 302 because the fork's
    derived `WORKSPACE_PATH_SEARCH_NAME_FILTER_RUNTIME_CAPABILITY` alias was two lines, so the array
    entry now uses the contract's name and the one test that imported the alias imports it from
    `workspace-path-search-contract`; `service-full-cycle-preparation.ts` and `FileExplorer.tsx`
    were brought back under budget by collapsing wrapped constructions and, in `FileExplorer.tsx`,
    dropping the `translate` import upstream's deleted inline placeholder had left behind. **Do not
    add a max-lines disable for any of these** (AGENTS.md) — split or compact.
  - **A silent loss the conflict markers did not show, and the typecheck did.** The `translate`
    import above is one of **33 typecheck sites in 12 files** the first `pnpm tc` after the merge
    reported. All of them were the same two shapes: a caller whose module upstream retired in this
    range (the SSH path-search stack, the `remote-session-scanner-*` family, `getSshFilesystemProvider`
    mock factories, the `ssh-git-dispatch`/`./pty` mock shapes) or a fork literal that no longer
    matched a type upstream widened (the new `PairedRuntimeConnection` fields, `WatchedRoot`'s five
    path-index fields, the disposition table's two new settings, `EventEmitter`'s import dropped by
    upstream's own test deletion). Every one is fixed in `c17416e75f`; `pnpm tc` is clean.
  - **The unreferenced-export census was reviewed, not waved through.** 34 exported names in modules
    deleted between the pre-sync tip and HEAD have no surviving reference. They fall into three
    groups, each verified by finding the successor: **renamed** (`registerLegacyBinaryControlFrames`
    → `registerTerminalSubscribeBinaryControlFrames`, `parseCopilotSessionContent` →
    `parseCopilotSessionFile`, the signed-out-child retire logic →
    `structured-agent-session-outgrown-child.ts`), **superseded** (`check-owner-routing-ratchet.mjs`
    by the two ratchets above), and **dead with the relay/direct-SSH removal** (`ssh-relay-*`,
    `relay-retry-after-header`, `docker-ssh-relay-*`,
    `relay-windows-process-tree-prepared-addon`, `direct-ssh-retry-status`,
    `hidden-restore-state-and-ssh-probe`, the remote-layout snapshot and terminal-legacy families).
    Nothing had a live caller to re-home.
  - **The identity sweep flagged 14 sites, all of them upstream's new hook tests** writing
    `~/.orca`: `gemini`, `kimi`, `copilot`, `command-code`, `agent-hooks`. `identity-sweep.mjs
    --fix` re-pointed them at `~/.orca-np` — for `gemini`/`command-code` those are assertions about
    where the service really installs, so the sweep was load-bearing rather than cosmetic. It now
    reports **0 fixable** (1130 report-only, 231 allowlisted).
  - **Kept deliberately, against upstream's deletion:** the `runtime-file-client.ts` barrel (the
    fork re-exports its split `searchRuntimeFilePaths` through it, and four fork renderer files
    import it, so the renderer tests keep importing the split module rather than upstream's); the
    `git blame`-visible question of the barrel is answered in the ledger. The zcode stores keep the
    fork's `getSecretStore` port and never adopt upstream's `guardedSafeStorage` — the 2026-10-11
    decision stands. The hidden-SSH-target status-bar filter stays while upstream's
    `userManagedEnvironments`/`visibleHostLabels` wording replaces the old host list.
  - **Re-seated rather than resolved by picking a side:** `editor-tab-view-types.ts` gained the
    fork's `errorAction` field after upstream moved `OpenCheckRunDetailsState` there, with
    `CheckDetailsErrorAction` lifted to shared and re-exported from the renderer lib; the AgentsPane
    keeps upstream's `AgentLaunchSettingsSection` structure with the fork's `SessionSummaryAiSetting`
    and `AgentSessionSearchSection` re-inserted; the jump palette keeps `applyWorkspaceKindFilters`
    and gains upstream's folder exemption; `runtime-project-host-setup-controller` and
    `main-process-runtime-service` keep the fork's own additions beside upstream's; `MAIN_BUILD_ENTRY_POINTS`
    (upstream's new module) gained the fork's `workspace-path-index-worker-entry`, which the merged
    guard would otherwise have failed at build start.
  - **Two upstream ratchets needed the fork's own counts.** `check:layout-writer-ratchets.mjs` and
    `check:main-sync-spawn-ratchet.mjs` are both new in this range, baselined against upstream's
    tree. `config/main-sync-spawn-baseline.txt` had one stale entry (a synchronous launch moved out
    of `macos-tailscale-dns-diagnostic.ts`), pruned with the script's own `--prune`;
    `config/renderer-layout-writer-baseline.txt` had `workspace-terminal-reconnect.ts` at upstream's
    2 writes while the fork's `publishPersistedTerminalHints` adds two more, so that entry is 4 —
    the fork's own code at its current count, the same shape the 2026-10-11 sync used for
    `config/focus-setting-read-baseline.txt`. No other entry moved.
  - **`pnpm lint` passes end to end in a CI-shaped tree** (no `mobile/` install). With
    `mobile/node_modules` present in this checkout, `audit:code-quality:native`'s `--deny-warnings`
    step reports five `import(no-cycle)` warnings in `mobile/` sources — verified to be identical at
    `upstream/main` in the same environment, so they are a property of the installed mobile
    workspace, not of this sync. Every step after it was run individually and passes.
  - **Test evidence:** `pnpm tc` clean after `c17416e75f`; repo-wide `oxlint` clean; identity sweep
    0 fixable; `pnpm test` ran **120,560 tests with 158 failing across 35 files, none of them this
    sync's**. Fifteen are the upstream-red/env classes that reproduce at the pre-merge tip
    (`dcb5ddfbc1`, 57 failed tests there); two fail at `upstream/main` itself
    (`tests/e2e/cross-version-wire/legacy-relay-bridge.unit.test.ts` and
    `tests/e2e/agent-launch-setup-choice.unit.test.ts`); eighteen are the mobile-web-bundle and
    macOS-host assembly script tests, which fail identically at the pre-merge tip in this
    environment (they bundle the mobile app with esbuild and hit alias resolution — the `mobile`
    workspace's install is partial here); one (`src/main/ssh/orcad-state-snapshot-shell.test.ts`)
    fails only under full-suite load and passes in isolation. The set was re-checked after the two
    review fixes (`7b70893f71`): every one of the 35 is in the classes above. The ten files that _were_ this sync's
    are fixed in `d31978f8e3`: an upstream test whose expectation this fork deliberately changed (the
    host stages setup for a blank create with default tabs; the Linux CLI is `orca-np`; the daemon
    host root and launchd bundle-id list are the fork's), and a fork file the merge re-pointed off
    the module its suite mocks (the `runtime-file-client` barrel).
  - **Follow-ups, named rather than left as TODOs:** (1) the explorer name filter has no
    runtime/SSH half any more — if a remote name filter is wanted, it needs a new transport, not a
    resurrection of `searchWorkspacePathNameFilter`; (2) `protocol-version.ts` sits at exactly 300
    code lines with no headroom, so the next capability upstream adds must be split out, and
    `mobile-web-bundle-manifest.mjs` scrapes `runtime-protocol-versions.ts` — keep the constant's
    line intact; (3) the fork's `files-path-search.test.ts` additions for the deleted name-filter
    branch are gone with upstream's version of that file; (4) the launchd job label still names
    `com.stablyai.orca` (`macDaemonJobLabel` in `macos-daemon-launchd.ts`, whose
    `AssociatedBundleIdentifiers` already uses the fork's `appId`) — worth fixing for
    coexistence, but it is persisted state, so it wants a migration rather than a sweep.

- **2026-10-11 — merge of upstream `cc5c85fb7a` (386 commits) into the release line, from
  `cce80247fb`** (merge base `1cda323b6a`, rollback tag `archive/pre-sync-cce80247fb`). Pre-flight
  passed and recorded the conflict set; the merge produced **102 conflicted paths** — `both-rewrote
  49, modify/delete 20, union 17, duplicate-tail 6, add/add 6, rename-replay 4`.

  - **The substantial convergence was the SSH relay, and taking upstream's removal was the fork
    owner's decision.** Upstream deleted the entire relay (`2b4b60a87e` the server, `ff27338299` the
    client path — together ~158k lines) and now serves SSH hosts from orcad; `31b2b17d9b` moved the
    WSL guest bundle sources out of `src/relay` into `src/wsl-guest`. The fork's investment in the
    relay was three commits against 467 files upstream had abandoned, so the removal was adopted
    rather than reverted: 36 relay-related paths resolved to deletion, plus
    `src/shared/ssh-ai-vault-relay.ts` and the fork's six `src/wsl-guest/` additions — dead code by
    then, since every consumer of them was a deleted relay file. See ledger § "SSH relay removal".
  - **Repo detection went to upstream's generator shape**, retiring the fork's parallel async copy
    of `repo-detection.ts` and `repo-git-marker-scan.ts` (`b63d39ebe5` reached the same goal with one
    body serving sync and async callers). The ledger entry now records the four filesystem steps
    upstream still runs synchronously as an **Open** item.
  - **Owner routing:** upstream deleted `getActiveRuntimeTarget` and `settingsForRuntimeOwner`
    outright and added `check-owner-routing-ratchet.mjs`, which fails on any use. The fork's six
    `runtime-compatibility-cache` re-exports were kept, and the two fork-only callers
    (`runtime-file-path-search-client.ts`, `preserved-branch-removal-completion.ts`) plus the
    fork's extracted listing helper were migrated to `runtimeTargetForOwnerEnvironment`.
  - **The fork's hidden-SSH-host UI was re-homed, not dropped.** Upstream's restructure removed the
    relay-era `onResetRelay`/`onTerminateSessions` props the fork's render relied on, which left
    `setSshTargetHiddenWithReport` with no entry point on the first pass. It is wired again:
    `SshPane.tsx` takes upstream's post-relay shape but renders the fork-only `SshTargetList.tsx`,
    and `SshTargetCard.tsx` carries `onSetHidden`, the hidden badge and `SshTargetVisibilityToggle`.
    Taking upstream's inline card retired `SshTargetCardActions.tsx`, and `SshTargetServerList.tsx`
    went too — it was a duplicate of `SshTargetList.tsx`. The card's Host-Node notes and
    "terminals until reset" line were common-ancestor copy upstream deleted with the relay, not
    fork features. See ledger § "SSH settings pane".
  - **Feature changes this sync made, recorded as follow-ups rather than left silent.** The fork's
    relay-side half of the explorer name filter (#34) died with the relay; the main-side half is
    intact. `StatusBarProviderSegment.tsx` keeps the fork's credits display, re-homed into
    upstream's sections-map structure. `agent-status-extension-async-subagents.test.ts` is the
    fork's suite, so upstream's newer cases (including the workflow-key naming test) are not
    covered here yet.
  - **The fork's repo-catalog connection fence converged onto upstream's, losing nothing.** Upstream
    `63b3f15cc4` (_every repo catalog uses the host-catalog fence_, #27116) is upstream's own fix for
    what the fork filed as #20811 and implemented as `claimRepoCatalogGeneration` plus
    `captureRuntimeRepoCatalogConnectionFence`: its `claimHostCatalogFence` /
    `isHostCatalogFenceCurrent` replace both mechanisms, and its `failed` flag replaces the fork's
    `incomplete` so a dropped catalog is no longer treated as an answer. `repo-catalog-fencing.ts`,
    `repo-catalog-actions.ts` and `all-host-repo-catalog-actions.ts` are byte-identical to upstream's
    now. The upstream-bound branch `fix/repo-catalog-connection-fence` is therefore superseded.
  - **Open (2026-10-11 sync): the fork's Jira/Linear surfaces still route by the Active Server
    setting.** Upstream's new `check-owner-routing-ratchet.mjs` fails on any renderer read of
    `settings.activeRuntimeEnvironmentId`. Thirteen fork-only files trip it —
    `jira-issue-workspace-detail-state.ts`, `jira-issue-workspace-side-data.ts`,
    `linear-issue-edit-rows.tsx`, `right-sidebar/JiraLinkedIssuePane.tsx`,
    `right-sidebar/LinearLinkedIssuePane.tsx`, `right-sidebar/use-linked-issue-pane-actions.ts`,
    `settings/JiraBoardSettings.tsx`, `tab-bar/use-tab-bar-default-agent.ts`,
    `task-page-jira-board-page-fetch.ts`, `task-page/jira/Board.tsx`,
    `use-task-page-jira-board-pages.ts`, `use-task-page-jira-board.ts` and
    `runtime/runtime-jira-board-client.ts`. They keep their pre-sync _routing target_ — which host
    they talk to is unchanged — and are registered in `config/focus-setting-read-baseline.txt` at
    their current counts so the ratchet holds the line. Routing them by the resource's owner is the
    follow-up. The repair did change their _implementation_, though: the source is now a
    `defaultScopeSource(...)` value, and because that allocates on every call it must be
    `useMemo`-stabilised at each call site, or it re-triggers the hooks that list `providerSettings`
    as a dependency and re-fetches on every render (see "Silent losses" below).
  - **CLOSED (2026-10-16, issue #124): the fork's Jira/Linear surfaces now route by the resource's
    owner.** The transport type is the fix, not a call-site edit: `RuntimeJiraSettings` /
    `RuntimeLinearSettings` were `RowLessSource` (`TaskSourceContext | RuntimeClientTarget |
    DefaultScopeSource`), and resolving the `default-scope` arm inside `getJiraRuntimeTarget` /
    `getLinearRuntimeTarget` _is_ the Active Server read. Those two now take `OwnedSource`
    (`TaskSourceContext | RuntimeClientTarget`, the new `lib/provider-source-target.ts`), so a caller
    has to name an owner before it can call anything, and `defaultScopeSource`, `rowLessSourceTarget`
    and `DefaultScopeSource` are gone. Read surfaces take a real owner, and where that owner really
    can differ from the focused host it is now used: the right-sidebar issue panes read _and write_
    through the workspace's creation-time task source when that task is the same provider, else the
    workspace's own host, and a Cmd-J-opened detail keeps its own source. The task page's board and detail route by the host
    the page already captured for its Jira/Linear account, which on that page _is_ the focused host
    by design — so their behaviour is unchanged, and what changed is that the read is now a decided
    target rather than a per-call settings read. A pane now carries one source rather than a target
    beside a nullable context: the Linear pane's issue-cache lookup keys on the source it fetched
    with instead of only the bare identifier, so the store hydration, the detail read, the property
    edit and the comment all name one host. Creation, connection and settings-scope flows resolve
    `defaultCreationHost` / `defaultScopeHost` explicitly, the same target as before, so
    `getJiraRuntimeTarget` never allocates on their behalf. Every source the board hooks and the Jira
    board picker derive is `useMemo`-stabilised on a _primitive_ host id
    (`jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId`), not on the model, the source
    object or the settings object — the ledger's trap was that a re-created object re-triggers every
    load effect, and the board suite now fails if the memo returns a fresh target. The memos that do
    key on a source object key on ones `use-task-page-detail-routing` already memoises, except the
    issue pane's: it derives its source from the workspace row through the sidebar's own resolver —
    one resolver, so the card and the pane cannot cache under different scopes — and holds it stable
    by value (`useStableTaskSource`), because the active row is replaced on routine writes that
    change nothing an owner depends on and the panes refetch on their source's identity.
    The ratchet fell **1161 → 959 reads** and 19 of the 22 annotated rows are gone entirely; the
    three that remain are at 1 read each and name their cause in the baseline: `JiraBoardSettings`
    (the default Jira board is a global setting, so the pane's board list belongs to the focused
    host's account and its memo keys on that host id) and two files that read the setting
    _transitively_ through non-Jira code (`openHttpLink`'s Link Routing; the agent-detection owner
    resolver's focused-runtime fallback before a workspace's owner hydrates). No count was raised to
    make this land.
  - **Issue #98 (Jira lane drag-and-drop, Dev/QE field editing) raised five focus-read counts.**
    The feature adds real provider reads of its own: an `editmeta` read for the issue detail
    (`jira-issue-workspace-detail-state.ts` 3→4, `jira-issue-workspace-side-data.ts` 4→6,
    `runtime/runtime-jira-client.ts` 17→18) and two new board-drop hook files at 1 each
    (`task-page/jira/use-jira-board-drop.ts`, `use-jira-board-transition-move.ts`). `Board.tsx`
    moved its transition calls into those hooks and pruned 4→3. They are recorded in
    `config/focus-setting-read-baseline.txt` at their current counts, the same fork-code shape as
    the 2026-10-11 sync above; owner-routing remains the follow-up and is unchanged by this work.
  - **Silent losses found only after the merge was first committed, and repaired.** Three classes —
    none visible to a conflict marker, a typecheck, or a `node-runtime`-only test run, so the fork's
    own release line would have shipped all three:
    - _A whole file deleted though both sides had it._
      `components/settings/AgentDashboardExperimentalSetting.tsx` was present at `cce80247fb` **and**
      at upstream and absent from the merge, as was the `ExperimentalPane.tsx` block that mounted
      it. Found by sweeping `git diff --diff-filter=D --name-only cce80247fb <merge>` against
      upstream: one hit out of 1014 deletions. Take the fork's variant — the merged
      `global-settings-types.ts` and the fork's test both use
      `experimentalAgentDashboardCardClickAction`, which upstream had replaced with
      `experimentalAgentDashboardMode`.
    - _Upstream behaviour dropped when the fork's side won a file._ Confirmed for
      `right-sidebar/ai-vault-session-refresh.ts`, which lost upstream's `c2c63e7f9a` (#27383)
      conditional paired-runtime history refresh — the renderer stopped sending `afterFingerprint`,
      so history was re-downloaded in full on every refresh — and for the zcode plan API-key store
      publication race and the kiro hook service, whose upstream tests pass at `cc5c85fb7a` and fail
      here. The detector is upstream's own test: **run every new upstream test against the merged
      tree before trusting a sync.**
    - _A hidden dependency on a source file's contents._ `config/scripts/mobile-web-bundle-manifest.mjs`
      regex-scrapes `src/shared/protocol-version.ts` for `export const RUNTIME_PROTOCOL_VERSION = (\d+)`.
      Splitting that file to satisfy `max-lines` moved the line and silently broke
      `readProtocolWindow()`, which `build:mobile-web` — and so `build:desktop` and every
      `build:release*` script — depends on. **When moving a declaration out of a file, grep
      `config/scripts/` for regex readers of that file.**
  - **Test evidence for the next sync: `--project node-runtime` is not the suite.** `pnpm test` runs
    two projects and `node-runtime` is a curated include list; the `bun` project runs everything
    else, including most renderer, `config/scripts` and packaging tests. A `node-runtime`-only run
    reports green while whole features are missing — that is exactly how the three losses above
    survived the first pass. Run both, or run `pnpm test`.
  - **Two contradictory repairs inside one sync, resolved FORK-first.** `zcode-plan-api-key-store.ts`
    was first changed to upstream's `safeStorage`, which broke its own suite; it was reverted to the
    fork's `getSecretStore` port (fork #75, _depend on the SecretStore port instead of Electron's
    safeStorage_, and `secret-store.ts`'s rule that core modules never import `electron`), and the
    three sibling suites were re-pointed with `setSecretStore`/`_resetSecretStoreForTests` instead.
    47 tests pass across them. **Do not re-introduce `safeStorage` in the zcode store.**
  - **Other re-points this sync made, none of them behaviour changes.**
    `runtime-home-hook-command.ts` had its POSIX branch half-reverted to the `.orca` literal while
    the Windows branch kept the fork's rename; both now use `${HOME_DIRECTORY_NAME}` again, matching
    `cce80247fb`. `managed-hook-install-lock.ts` stays the one deliberate `.orca` exception
    (cross-install mutex) — do not sweep it. `config/ts-nocheck-baseline.txt` gained
    `orca-runtime-owned-controllers.ts`, the module extracted from
    `orca-runtime-preserved-branch-cleanup.ts` for the `max-lines` budget: it inherits that file's
    `@ts-nocheck` and belongs to the same deliberately-untyped split-runtime mixin family, so the
    entry is a family membership rather than a new suppression. `host-operation-ownership.ts` gained
    `hostSettings: 'host'` for the fork's own `hostSettings.applyReplication`/`replicationState` RPC
    namespace (fork #70); `host-operation-ownership.test.ts` classifies every method in the generated
    RPC catalog, so completeness is test-enforced.
  - **Pre-existing, and fixed because the review found it while reading this sync's diff.**
    `runtime-home-hook-command.ts`'s PowerShell branch spelled `'.${HOME_DIRECTORY_NAME}\…'`, which
    rendered `..orca-np` — `HOME_DIRECTORY_NAME` already carries its leading dot — so `Test-Path`
    never matched and the managed hook silently fell through to the fallback for every PowerShell hook
    caller. Byte-identical at `cce80247fb` (a `local(identity)` slip, not a merge casualty),
    root-caused only because the review re-read the file when the POSIX branch was restored. Fixed
    here too: `zcode-plan-api-key-store-native-windows.test.ts` mocked `electron`'s `safeStorage`
    while the fork-first resolution settled the store on `getSecretStore`, and never installed a store
    of its own, so it inherited the setup file's sealing default and would have failed on the first
    Windows run — hidden by `skipIf(platform !== 'win32')`. It now installs the same plaintext-forcing
    store as its three siblings.
  - **Pre-existing, found while classifying and deliberately left alone.** `zcode/hook-service.ts:145`
    installs to `${remoteHome}/.orca/agent-hooks/...` — and `kiro/hook-service.ts:218` spells the same
    remote path — while their dsh twins use `HOME_DIRECTORY_NAME` —
    byte-identical at the merge base and at both parents, so it is identity backlog, not a merge
    casualty. `config/scripts/command-code-transcript-scan-benchmark.mjs` and
    `mobile-agent-status-projection-benchmark.mjs` are stale regex readers whose constants moved —
    also stale identically at both parents, so upstream's to fix, worth an upstream-facing note.
  - **Review gate (recorded, because the mandated reviewer was unavailable).** The sync's standing
    gate is Opus 5.5 at high reasoning. Its review of the first committed revision (`1262ebae7f`)
    returned _not ready to ship_ with three blockers — the Jira `defaultScopeSource` re-fetch loop,
    the `mobile-web-bundle-manifest.mjs` scraper broken by the `protocol-version.ts` split, and the
    dropped AI Vault `afterFingerprint` path — plus two should-fixes. All five were repaired. The
    mandated re-review then could not run: the `github-copilot` allowance was exhausted mid-session
    (HTTP 429). On the fork owner's explicit direction the re-review was run by
    **`xiaomi/mimo-v2.6-pro` at high reasoning as a substitute**, and that substitution is recorded
    here rather than left implicit. Its verdict on the final revision: one ship-blocking finding —
    the upstream-new, Windows-only `zcode-plan-api-key-store-native-windows.test.ts` still pinned
    `~/.orca` while the store resolves `~/.orca-np` through `adoptLegacyHomeStore`, which the
    `skipIf(platform !== 'win32')` guard hid on macOS — now re-pointed to `HOME_DIRECTORY_NAME` like
    its three siblings. It confirmed every other repair, found **no weakened assertions**, and gave
    explicit sign-off on the `ts-nocheck` entry, recording the typed alternative as chain-wide work
    rather than a sync repair. Two further passes followed, each after a round of fixes, both by the
    same substitute model: `ff8ea42b23` fixed that Windows-store blocker and, on the reviewer's
    reading, a pre-existing `..orca-np` PowerShell hook path (the constant already carries its
    leading dot, so `Test-Path` never matched); its re-review returned one further blocker — the same
    Windows-only store suite still mocking `electron`'s `safeStorage` instead of installing the
    fork's SecretStore, which the `skipIf(platform !== 'win32')` guard hid on macOS. `aba543909a`
    fixed that, and the re-review of it returned **ship-ready with no blocking findings**, confirming
    every repair in the series and finding **no weakened assertions** anywhere. Both substitutions are
    recorded because the gate's whole value is that it is checkable. A third pass reviewed the
    bundle fix below and returned **ship-ready with no blocking findings**, having independently
    re-measured the sweep table row by row.
  - **The mobile web bundle fence was re-measured, not bumped.** Release run 26 failed at
    `verify-mobile-web-app-bundle`: 129 assets against a derived budget of 128 for 16 routes and 49
    images. The ceiling is derived from `MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP`, and this sync's
    upstream mobile changes moved the swept tree from **74 to 79** scripts at the same 16 routes —
    past the margin of four, which is the file's own trigger for a re-measurement rather than a
    bump. The table was re-measured by building `routes.slice(0, n)` for every n, as its comment
    prescribes, and its two crossing pins were re-derived at the tree's 49 images (`maxChunks(28) =
    203` → 253 assets pass; `maxChunks(29) = 213` → 263 > the shell's 256, throws). The margin stays
    4 and every contract constant is untouched; the fence now sits exactly one margin above the
    build, on both sides.
  - **Open (2026-10-11 sync): two consecutive syncs have grown that sweep by five, and nothing has
    diagnosed which module the chunks come from.** The ledger already asks for the one diagnostic
    pass that would name it; this sync added a second five-chunk step, so the third will re-measure
    a table whose growth is still unexplained. The ratchet is doing its job — the two-sided margin
    test pins the envelope to within four of the build, so it is real growth rather than accumulated
    slack — but a re-measurement is not a diagnosis.
  - **Left failing, and proved not ours:** `pnpm run audit:code-quality:native` reports five
    `import(no-cycle)` warnings — `mobile/src/transport/client-context.tsx`,
    `mobile/src/transport/host-client-hooks.ts`, `mobile/src/terminal/document/fit-scale.ts` (x2)
    and `mobile/src/terminal/document/mouse-report-cell.ts`. All five files, the plugin config and
    the resolved oxlint version are byte-identical to both `HEAD` and upstream, and the same five
    warnings reproduce on the pre-merge tip `cce80247fb` in a clean worktree. **Watch the trap:** it
    is only visible with `mobile/node_modules` installed — without it oxlint cannot resolve the
    mobile graph and the command silently exits 0, which made a first pass here read as "introduced
    by this merge". Breaking the cycles would mean restructuring upstream-owned mobile files, so it
    is carried as fork-wide debt rather than taken on as this sync's divergence.

- **2026-10-09 — merge of upstream `1cda323b6a` (199 commits) into the release line, from
  `6a7b39c398`** (merge base `e5ade4b868`; merge commit `f94d10ff60`, with this sync's `fix(sync)`
  and `docs(fork)` commits on top). The pre-flight gate passed and recorded the conflict set; the
  merge produced **37 conflicted paths** — `no-markers 15, both-rewrote 9, modify/delete 7, union 4,
  rename-replay 1, duplicate-tail 1`. 15 of them had already been resolved in the working tree by the
  session that was interrupted mid-merge; those resolutions were reviewed against both stages rather
  than trusted.

  - **The one substantial convergence went to the fork owner, and upstream won on structure.**
    Upstream's `b1cd85820b` ("Show multiple reviews and tasks in workspace cards and details")
    rebuilt the worktree-meta dialog as a linked-items/attachments model in the same week this fork's
    PRs #52/#64 built a Jira link into the same files — `use-worktree-issue-link.ts`,
    `WorktreeIssueLinkField.tsx`, `worktree-issue-displacement.ts`, `worktree-meta-updates.ts`. Two
    implementations of one idea, not a union: upstream's composer accumulates many attachments, the
    fork's Issue field displaced the one link it held. **Owner's answer: take upstream's model.** The
    five upstream-deleted paths plus the fork's now-superseded dialog helpers
    (`use-worktree-meta-save.ts`, `use-worktree-meta-issue-row.ts`, `use-worktree-meta-jira-link.ts`,
    `issue-link-provider-options.ts`, the dialog test harness and `WorktreeMetaDialog.jira.test.tsx`)
    are deleted, and the fork's test file is upstream's. Nothing of the feature is lost: upstream
    ships `provider: 'jira'` attachments with `jiraIdentifier` and a routing `taskSourceContext`, a
    `jira-issue` composer kind, and a site-aware source with an account chooser whose search rows also
    resolve a bare key. One fork-only rule had no counterpart and was **re-homed**, not dropped:
    `buildIssueUnlinkUpdates` → `sidebar/workspace-issue-unlink-updates.ts`, because the Jira issue
    pane's Unlink must still clear the GitHub number, the Linear key and the created-from work item
    together. Both decisions are in the ledger.
  - **Also revisited: the merge-readiness marker.** Upstream moved the review glyph out of the card's
    metadata row into its new `WorktreeReferenceStack.tsx`, which silently dropped this fork's merge
    marker (`data-review-merge-marker`) and its `Ready to merge` / `Conflicts` suffix — no conflict
    pointed at them. Both are re-seated into the stack, and `WorktreeCardStatusSlot`'s accessible
    label was split so a collection checks summary owns the checks half while the merge blocker still
    reaches the screen reader.
  - **Breaks no conflict marker showed, all found by `pnpm tc` and tests.** `main-window-actions.ts`
    kept upstream's import of the `dashboard-popout-window` module the fork deleted (ledger:
    _Dashboard and the popout window_) — the serve-mode quit loop closes only the main window again
    and the two tests that mocked the popout lost that mock. The fork's three Jira board RPC methods
    were missing the `permission` field upstream made required (`workspace`, like `jira.listIssues`).
    The orphan-removal helper still invalidated the **global** authorized-roots cache, which is
    exactly the call upstream's `worktrees-removal-recovery` test forbids now that the call site
    invalidates per repo. The fork's `runtime-workspace-path-search-capability.ts` subscribes at
    module scope, so five upstream tests that mock the runtime RPC client needed the fork's
    `subscribeRuntimeWorkspacePathSearchCapabilityInvalidation` stub — the same repair the deleted
    `structured-agent-session-accepted-send-capability.test.tsx` had carried. And
    `ai-vault-session-refresh` kept the host query in its scan key while upstream's new list-request
    adapter dropped it, so a changed query served the unfiltered cache.
  - **One identity "fix" was wrong and was reverted.** `managed-hook-install-lock.ts` hard-codes
    `.orca` for the install-lock parent while the fork's home is `.orca-np`, and this sync first
    "swept" it. It is deliberate: that lock is a cross-install mutex over the shared `~/.claude`
    hooks, which an official Orca install manages too. The literal and both test expectations are
    restored, and the ledger's identity section now says not to sweep it — this is the second time
    the same sweep has been attempted.
  - **The hand-unioned locale catalog dropped 8 upstream copy changes.** The i18n union took the
    base's text for every key only upstream had changed (`settings.chat.description`, the native-chat
    experimental pane's `description`/`copy`, the experimental search entry, four `components.*`
    notices). A per-key audit of base/ours/upstream/merged found all 8 and no other drift; the two
    catalogs were then regenerated rather than merged, and the 23 keys upstream deleted were kept
    deliberately (a fork code path may still resolve one dynamically; a missing key renders an
    inline default only when the caller passed one).
  - **Generated files regenerated, not merged:** `src/cli/bundled-skill-guides.ts`,
    `en-runtime-required.json`, the non-English locale catalogs. `rpc-params-catalog.generated.ts`
    was already current.
  - **Verification.** `pnpm tc` clean. `post-sync.mjs` green (10 checks; the deleted-module surface
    scan acknowledged below). The full suite ran 118 575 tests: **63 failing across 21 files, of
    which 57 across 14 are the classes measured on this machine's pre-merge tree** — the
    `agent-session-*` / `agent-launch-*` / `structured-agent-session-*` family (their test files are
    byte-identical to upstream's own, so upstream's tests fail here), the relay region test that
    needs the uninstalled `cloud/` workspace, and three of the four PTY/`bun` files that get no child
    output. The remaining 6 were this merge's and are fixed: 5 from the module-scope capability
    subscription above and 1 that the reverted lock sweep broke. `check:dead-classes` clean.
  - **Named follow-ups.** Two list components now render the SSH settings surface — the fork's
    `SshTargetList.tsx` is dead in production and the extracted `SshTargetServerList.tsx` duplicates
    it; consolidate. The fork's bare-key direct add and its site-ambiguity copy did not come across
    with upstream's composer (ledger, _Linked work items_). And the two retired test inventories
    (`renderer-node-builtin-boundary.test.ts`, `structured-agent-session-accepted-send-capability.test.tsx`)
    took the deletion per the _Test inventories retired upstream_ entry, so the popout entry in the
    first and the capability stub in the second are gone with them.

- **2026-10-07 — merge of upstream `e5ade4b868` (148 commits) into the release line, from
  `ed0be2085f`**, on the merge flow (merge commit `7c0a53a148`). Pre-flight proved the tip green and
  predicted **56 conflicted paths** (`both-rewrote 24, modify/delete 19, union 6, rename-replay 3,
  duplicate-tail 2, duplicate-members 1, add/add 1`); the merge produced exactly those.

  - **What the classes resolved to.** The 7 `modify/delete` where the fork had deleted the Agent
    Dashboard popout plumbing took the deletion (ledger: _Dashboard and the popout window_). The 12
    where upstream's `ca4e239861` retired test inventories took the deletion, including the fork's
    identity-renamed assertions. Identity-only conflicts took upstream's file for `identity-sweep.mjs`
    to re-sweep.
  - **Upstream rewrites taken whole, fork delta re-applied.** `notification-options.ts` (the fold now
    takes a translator), `use-hosted-review-polling.ts` and `use-checks-panel-foreground-effects.tsx`
    (review refresh moved to upstream's visibility coordinator), `use-section-rows.ts`,
    `FloatingTerminalPanelSurface.tsx`, `QuickOpen.tsx`, `AgentKanbanBoard.tsx`,
    `file-explorer-{watch,watcher}-reconcile*` (both sides had landed the same single cache-key
    enumeration). `resolveClaudePaneStatus` moved to `claude-pane-hold-evidence.ts`, where the fork's
    `local(agents)` monitoring policy is re-expressed.
  - **Four things the merge left half-applied, all found by tests, fixed in `4370252718`:**
    `owedShell` belongs to non-agent work (the fork's policy only moves _running_ shells); the fork's
    30s unfinished-checks cadence is dropped in favour of upstream's detail timer while the `force`
    cache bypass stays; the floating sentinel scope resolves the fork's pure folder path again (going
    through the settings-aware resolver mkdirs `~/.orca/floating-workspace`, which the test home-write
    guard rejects); and `protocol-version.ts` keeps upstream's explicit orchestration re-exports
    without the `export *` the merge unioned beside them.
  - **Two clean merges that were not correct merges.** Upstream's new `NODE_RUNTIME_INCLUDE` list
    needed the fork's two SQLite-reading search suites (the boundary gate fails otherwise), and
    upstream's new agent-launch route suite mocks the RPC client, so it must answer the fork's
    import-time capability subscription. Both fixed in `4370252718`.
  - **`post-sync.mjs` green, and one second-model gate — NO-GO, then two fixes.** A single
    `github-copilot/gpt-6.1-sol` high-reasoning pass ran its own probes over the merged tree. **P1
    (release blocker):** the floating-terminal scope had been resolved with the fork's pure folder
    function, which ignores a configured `floatingTerminalCwd` — and that scope _is_ a launch cwd
    (`orca-runtime-create-terminal.ts` falls back to `workspace.path`), while the panel's own floating
    terminal honours the setting, so an agent could run in one directory while its filesystem requests
    addressed another. Its probe printed `CONFIGURED_DIRECTORY_HONOURED false`. **Fixed** to honour the
    setting with a pure fallback when it is unset, pinned by two new cases in
    `agent-launch-floating-workspace.test.ts`. **P2:** an owed shell notification alone earns
    `monitoring`, against the `local(agents)` sentence that reserves the badge for session crons. The
    fork's own tests pin both halves of the real rule (a running shell + cron → plain `working`; a cron
    with the shell set empty → `monitoring`), and every alternative mapping breaks one of them, so the
    nuance is **accepted and now written into the ledger** rather than silently kept. Everything else
    the gate probed held: the polling force flag reads a fresh closure and no other cadence writer is
    left; the four deletions leave no orphaned caller; upstream's only `tui-agent-config` table change
    was `rovo` and it is ported; no consumer lost an export with `export *` removed; the notes range and
    cherry counts agree (156 / 155 `+` / 0 `-`). Its third finding — `~/.orca/floating-workspace` being
    the fork's own storage — reproduces at `ed0be2085f`, so it is pre-existing and recorded in the
    ledger as an open migration.
  - **Verification.** `post-sync.mjs` 9 passed / 1 info / no hard gate; `pnpm tc` clean;
    `check:code-quality:changed` clean against the pre-sync tip across 2752 changed files (against
    `upstream/main` it reports 58 findings, all in fork-owned files — pre-existing debt). Tests:
    `src/renderer/src` 39 239 passed, `src/shared` + `src/main/ipc` + `src/main/git` + `config/scripts`
    20 786 passed, `src/main/agent-hooks` + `src/main/claude` 3 169 passed, plus the floating-workspace
    and policy suites re-run after the gate's fixes.
  - **Failures that are this machine, with the proof.** The agent-session/agent-launch SQLite family
    and `config/scripts/verify-localization-catalogs.test.mjs` (a `spawnSync bun ENOENT`) fail
    identically on a worktree of the pre-sync tip and of `upstream/main` — 8 of 19 in
    `agent-launch-restart-replay.test.ts` on the upstream tree itself. Bun is not installed here, and
    this SQLite setup does not persist the journal across a restart, so `pnpm test` (which runs vitest
    under bun) is the harness to trust for those.
  - **Named follow-ups:** the PR-transition refetch in the checks panel if a new run reads stale; the
    three fork-specific assertions that went with upstream's retired test inventories; upstream's
    `owedShell`/`owedAgent` lease semantics re-checked against the fork's policy on the next sync; and
    the `~/.orca` vs `~/.orca-np` floating-workspace path, which the ledger and the code disagree on
    and which is a note migration rather than a rename.

- **2026-10-06 — released as `v1.4.214-np.18`** from `2d0c739ee6` (signed and notarized, workflow run
  37485475655), on the merge line: the release carries upstream `6c693edf40` in full. **This one went
  through three second-model gates, and the first two were NO-GO.** That is the headline: the flow
  caught four defects that a green test suite did not.

  - **Gate 1** (on the merge) found pi settlement stranding on resume, pi ownership holes, relay
    cancellation matching only the sender id while the renderer submits under a UUID, and release
    notes counting 103 rebase-duplicate commits as new. **Gate 2** confirmed the settlement fix and
    the notes, then rejected the ownership fix outright — _"B's distinct bus is unobserved… 'once per
    evaluation' preserves the collision rather than fixes it"_ — and found a child-only update
    stranding the cached row plus two cancellation races (a cancel during authorization still
    submitting its query; a settled token falling back to the sender id and killing a peer). **Gate
    3** ran its own probes over the fixed tree and returned GO (`PI_PROBES_PASS`,
    `CANCELLATION_PROBES_PASS`), naming no blockers.
  - **What the fixes changed, in mechanism terms:** pi children are keyed by the session that owns
    them and the _binding_ is keyed by the bus (`PiAsyncSubagentBusBinding { bus, registration,
    listeners }`, ownership transferred to the newest registration on that bus), a hold nobody claims
    is retracted rather than merely not re-published, and `session_start`'s placeholder is gated so a
    resumed session that loses its last child settles `done`. Cancellation moved to a live
    token→request fence begun before the first await and checked again after submission, with
    `fs:cancelListFiles` requiring a live request so an unknown or settled token cancels nothing.
  - **Release notes now lead with what changed** — the previous body was install instructions and
    project detail. `.github/scripts/fork-release-notes.mjs` groups the range by type, counts only
    commits that are not patch-equivalents of the last release (`git cherry`, which matters because
    this fork's line gets rebased), caps each group, folds sync bookkeeping into one counted line, and
    links the full comparison.
  - **Deferred by the reviewer, with its agreement:** acknowledgement validation and a
    review-required status for modified-file red flags in `post-sync`; notes-body validation beyond a
    heading plus size floor; the dual `includeIgnored`/`includeIgnoredFiles` spelling; the
    `recentError` row that is computed but no longer rendered; and the unnamed-consumer sender
    fallback in the path-search handler, which no current renderer call site reaches.

- **2026-10-05 (second sync of the day) — merge of upstream `6c693edf40` (50 commits) into the
  release line, from `807aa6062c`.** The first sync on the new flow
  ([UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md)), and the pilot that paid for the tooling:
  `pre-sync.mjs` proved the tip green and predicted **26 conflicted paths** with classes
  (both-rewrote 17, union 4, rename-replay 2, duplicate-members 1, duplicate-tail 1, modify/delete 1)
  _before anything moved_, the merge produced exactly those 26, `conflicts.mjs` triaged them file by
  file, and `post-sync.mjs` finished with **7 passed, 1 skipped, no hard gate failed**. One conflict
  set, resolved once per file — no commit was replayed, nothing was force-pushed.

  - **What the merge surfaced that no conflict marker showed.** A pi session change never cleared the
    fork's live subagent state, so a closed session's children rode the next session's post and a
    fresh bus had zero listeners (`agent-status-session-boundary-source.ts`); upstream's newer
    `quick-open-recent-validation.ts` needed `runtime-file-request-debounce.ts`, which this fork's line
    had deleted; and three fork modules are now superseded by upstream's and are gone
    (`filesystem-text-search-handler.ts`, `filesystem-quick-open-listing-handler.ts`,
    `relay/quick-open-list-line-processor.ts`). Dead code that upstream outgrew is the one case where
    the fork's own file goes.
  - **Test re-seats.** 18 upstream pi/renderer assertions were re-seated onto the fork's model (its
    pi lane emits `subagent_async_state`/`subagent_runs`, never upstream's `subagents`/
    `subagents_update` rows). The 1 deletion — upstream's "brings a session's children back when it is
    resumed", dropped because the fork's lane appeared to park children nowhere — was **restored**
    once the lane got per-session state, rewritten for this lane's `subagent_runs` shape; see the
    second-model review below. The binding policy — one binding per channel — is unchanged.
  - **Verified:** `pnpm tc` clean; 347 pi, 1,941 renderer quick-open + runtime, 6,346
    `src/main/ipc` + providers, 2,184 relay and 24,398 `src/renderer/src/components` tests passing;
    the runtime-required catalog regenerates to no diff and both localization verifiers pass;
    `check:code-quality:changed` passes; the identity sweep and the lost-content scan are clean.
  - **Left failing, and proved not ours:** `agent-session-*`, `agent-launch-replay`,
    `agent-state-rules-live-update` and `DiffViewer.word-wrap-lifecycle` reproduce on pre-merge
    `807aa6062c`; `file-explorer-watch-reconcile` reproduces on pristine upstream `6c693edf40`.
  - **Left open, by name:** the relay now carries both an `includeIgnored` and the fork's older
    `includeIgnoredFiles` spelling — one of them should go, and the choice belongs with the
    path-index work. The fork's `recentError` status row is computed and tested but no longer
    rendered; decide whether it comes back or the module drops it. Both are unresolved convergence
    questions, so neither is in the ledger yet.

  - **A second-model review of the merge found three things this sync did not fix**, recorded here
    rather than fixed silently:
    1. _The pi lifecycle fix may be incomplete._ **Fixed** in `local(agents)`: a session change no
       longer clears the fork's live `subagentRuns`. The set is keyed by the session that owns it on
       `globalThis.__orcaPiAsyncSubagents`, every post carries the current session's bucket only, and
       a superseded registration is refused by a `piAsyncSubagentState.registration` guard — so
       children are preserved and restored per session (`/new` then `/resume`, and across a
       `/reload`), while a closed session's children still cannot ride the next session's post. The
       deleted upstream test is **restored** for the fork's lane and the reload test now asserts the
       set surviving; the ledger's pi entry carries the mechanism.
    2. _The fork's indexed path search has no cancellation._ Verified not a regression — the
       pre-merge fork file had none either — but `fs:cancelSearch`/`fs:cancelListFiles` cover
       upstream's two paths only, so a superseded indexed query keeps running.
    3. _The ledger and an adapted test disagree about `/reload`._ **Settled, and the ledger was the
       one that was right:** a `/reload` keeps the live set (item 1), and the listener count of 2 is
       expected rather than a doubling — two lanes bind `subagent:process-terminal` (the fork's
       descendant bus and upstream's runner-exit lane).
  - **A tooling limit this sync exposed:** `post-sync.mjs`'s lost-content check compares _modified_
    files, so deleting fork-only code that had unique side effects escapes it. Three fork modules
    were deleted this sync as upstream-superseded; the review is the only thing that questioned
    whether a replaced surface was a superset. The next version of that check should inventory a
    deleted module's exported side effects, not just its paths.

- **2026-10-05 — unreleased** from `0ca31372cc`, onto upstream `9def4b9ba1` (505 commits), from the
  released tip `99f1a03ba7` (np.16). **148 commits replayed**, then this sync's fix commit on top:
  `range-diff` pairing not re-counted, but no commit was dropped and one `fix(sync)` commit was
  added. No merge commits were in the replay range, so the `--rebasemerge` trap did not apply.
  Upstream moved 50 commits further on while this ran; `origin/main` was fast-forwarded to its
  newest tip (`6c693edf40`), so the next sync starts from there.

  - **Two convergence decisions went to the fork owner, and both were settled:**
    1. **The key-store factory.** Upstream added `createEncryptedApiKeyFileStore` (`53f9ea7839`)
       in the same range the fork's `bde2837be6` added `createSecureCredentialStore`; upstream's is
       a behavioural superset (`{ durable: true }` writes, `ApiKeyFileUnreadableError` for a
       transient read failure, which upstream's `service-fetch-targets.ts` catches). Upstream's
       survives; the fork's file, its test and every call site are gone, and the deepseek,
       fireworks and copilot stores were ported onto it.
    2. **Repo detection: async meets one spawn.** Upstream rewrote `repo-detection.ts` to be sync
       with a single combined `rev-parse`; the fork's `ea059d2afc` made the same functions async to
       keep them off the main thread. The merged file keeps the fork's async execution _and_
       upstream's `GitRepoProbe`/`isGitRepoFromProbe`/`inspectGitRepoForRegistration` structure,
       ported to `gitExecFileAsync`/`scanGitMarker`/`fs/promises`, including upstream's
       newline-safe `indexOf('\\n')` root parse and the `records.length === 4` newline-ambiguity
       fallback. `local-repo-registration.ts` awaits the inspected root.
    3. **Floating workspace.** Upstream and the fork's `#16` each gave it a folder. The fork's
       `~/.orca-np/floating-workspace` (`ensureFloatingWorkspaceDirectory`, the launch-directory
       module, `moveLegacyFloatingNotes`) survives, with upstream's tabular work — `FileDocument`,
       `.csv`/`.tsv`, `isOsOpenedDocumentName`, `MAX_PENDING_OS_OPENED_DOCUMENTS` — ported onto it
       in upstream's `os-opened-documents.ts` (the fork's `os-opened-markdown-files.ts` is gone,
       and the test upstream superseded was deleted).

  - **`authorizeExternalPath` and upstream's `extraRoots` now coexist.** Upstream's `51fe6f3fba`
    deleted main's in-memory path grants in favour of `extraRoots` plus the `user-file` access
    kind, but the fork's floating-workspace, picker-grant and OS-opened-document surfaces are built
    on the grants (62 callers at the old base). The rebase first dropped them, which `pnpm tc` and
    eight tests caught; the mechanism is ported onto the newer `filesystem-auth.ts` and both
    mechanisms are live.

  - **Other re-seats.** The fork's `codexRoster` → `agentDescendant` rename replayed onto upstream's
    new `codex-transcript-poll.ts` and `codex-status-transcript-line.test.ts`; the fork's
    `statusCacheHydrationReady` wrapping moved into upstream's extracted
    `initializeStatusHookOwner()`; `local(identity)` extended to upstream's new
    `TABULAR_PROGID` (`OrcaNP.Tabular`) and to jcode/qoder remote-hook paths; the ai-vault session
    index took upstream's `AiVaultServiceScanOptions` + shared `SESSION_PARSE_CACHE_SCHEMA_VERSION`
    (trap 8: both sides meant 4, then 5 — the higher number wins and the number now lives in the
    snapshot serializer); `#20`'s extracted `quick-open-rg-path-scan.ts` gained upstream's filename
    decoder, `getQuickOpenRgOutputMode` and path-too-large verdict; `#34` kept the fork's chunked
    projection and worker-shaped relay over upstream's NUL reader; `#39`/`#40` moved the
    Antigravity and Zcode search catalogs into the fork's `accounts-search-extra-providers.ts` to
    stay under the 300-line cap (no suppression); `#42` re-seated the disabled-provider gates onto
    upstream's zcode/antigravity/OpenCode plumbing; the dashboard popout plumbing stays deleted
    (`#44` made the dashboard a first-class view) rather than carrying upstream's window fix;
    `#45` keeps `useJiraIssueWorkspaceDetail` with upstream's request-id and comments-loading
    fixes re-seated into it.

  - **Verified:** `pnpm tc` clean across all three projects; `check:code-quality:changed` against
    `upstream/main` reports 27 design-system + 12 other findings, all in fork-only files and
    unchanged in kind from the previous syncs (two duplicate-import findings this sync introduced
    were fixed); the local builder config loads, all five update-feed references name
    `nplez1/orca`, the runtime-required catalog regenerates and both localization verifiers pass;
    the lost-content diff reduces to 17 files, 15 of them absent upstream and two deliberate.
    Suites run and green: `src/main/ipc`, `src/main/session-summary`, `src/main/ai-vault`,
    `src/main/ai-vault-search`, `src/main/git`, `src/shared/agent-hook-listener`,
    `src/renderer/src/components/{settings,status-bar,right-sidebar}`, `src/relay`, plus the
    tab-bar and sidebar suites.

  - **The sync process itself changed.** Every sync so far rebased the whole line, which pays per
    commit _per collision_: seven fork commits touch `service-full-cycle-preparation.ts`, so that one
    file stopped this rebase three times and the same decision was made three times. The release line
    now **merges** upstream (measured on the 50-commit delta pending after this sync: a merge presents
    26 file-level conflicts and auto-merges 68 files, while a rebase replays 150 commits), and rebase
    is kept for the `local(...)` series and for feature branches, which are small and want linear
    review. `git range-diff` stays for those and is replaced on the release line by
    `git show --remerge-diff` plus endpoint-delta review. Four tools and one ledger now back the
    process — `node local/sync/{pre-sync,conflicts,post-sync,identity-sweep}.mjs` and
    `local/sync/convergence-ledger.md`, documented in `local/sync/README.md` and the rewritten
    `UPSTREAM-SYNC-RUNBOOK.md`. The ledger is the part that pays back first: it holds the decisions
    this sync settled (key store, repo detection, floating workspace, identity, provider unions, the
    schema-version rule) so they are not re-litigated next time. `local/sync/curate.mjs` can collapse
    the scaffolding into a curated series (150 → 126 patches, removing 10 conflict-capable commits)
    and was deliberately **not** run: that is another public rewrite for a modest gain.

  - **Left open, by name:**
    - _The mobile-web sweep table follows upstream._ The fork's `a2994c2741` had re-measured
      `MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP` one script lower per route; this rebase took upstream's
      re-measurement (74 scripts, spread 10) and its fence suite passes, but the fork's own
      bundling job should re-measure if it disagrees.
    - _The five remaining `pnpm test` areas are upstream-red or environment-bound_, unchanged from
      the previous sync: the `agent-session-*` files, the two `browser-manager` suites that need
      `ORCA_BACKGROUND_LAUNCH=1`, and the relay region test that needs the uninstalled `cloud/`
      workspace.
    - The four findings the previous sync's fixes carried (the file-explorer display-root cache
      key, `projectionContextKey`, the unforced `displayRootPath` spread, and the `~/.orca`
      readers) are unchanged.

- **2026-10-01 — released as `v1.4.214-np.16`** from `b5dddf0421` (workflow run 36886007740,
  signed and notarized), onto upstream `a5601375d4` (166 commits), from the released tip
  `5065084bf1` (np.15 released from `c8fa8feead`, with `#44`–`#47` landed on top of it). **140
  commits replayed**, then this sync's three fix commits on top: **105 byte-identical by
  `range-diff`, 34 adapted, none dropped, none added.** The replayed tip is `546e94bf16`; the
  re-seat fixes landed as `883aa7d5f1`, `e32ee8446e` and `b5dddf0421`. No merge commits were in the
  replay range, so the `--rebase-merges` trap did not apply this time.

  - **A fork-owner decision finally settled upstream's source-grep purges.** Upstream is retiring
    whole classes of test that assert on production source text, and this sync's range brought four
    such waves (`45c63a66e9`, `7980ab9942`, `1f8159cca6`, `33351b0085`, `85f8d6b5f5`). The fork
    asked, and the answer is **hybrid**: take upstream's deletion, and re-seat any assertion that
    only the fork's own surface explains. Applied as follows.
    - `app-startup-routing.test.ts` (650 lines, 27 cases) and the retired cases in
      `desktop-startup-ordering.test.ts`, `use-file-explorer-name-filter.test.ts`,
      `installer-utils.test.ts`, `ssh-connection-store.test.ts`, `dashboard-payload-validation.test.ts`,
      `ai-vault-search-all-hosts-real-index.test.ts`, `folder-repo-git-upgrade.test.ts`,
      `filesystem-watcher.test.ts`, `session-parse-cache-persistence.test.ts` and the updater suite
      are **deleted as upstream deleted them**. Where the fork's version had been only a string
      re-point, the fork's change goes with it.
    - **Re-seated**, because nothing upstream reaches them: the four
      `agentHookStatusCacheHydrationReady` assertions became a new case in upstream's trimmed
      `desktop-startup-ordering.test.ts` (the file is still a `reliability-gates` `assertionRefs`
      target, so it has to exist); the `cardClickAction: 'popover'` rejection stayed where upstream's
      surviving analogue already asserts it; and the fork's _new_ cases in those files stayed.

  - **`local(identity)` met a Rust rewrite of the Windows launcher.** Upstream replaced
    `native/windows-cli-launcher/OrcaCliLauncher.cs` with `src/main.rs` (`#23383`, for MSIL
    heuristics). The fork's two C# deltas were carried over: the `orca-np` case in the
    `ORCA_CLI_COMMAND` whitelist, and `cfcaae6b54`'s `ResolveElectronPath` — which matters more than
    the whitelist, because the fork ships `Orca NP.exe` and upstream's Rust launcher hardcodes
    `Orca.exe`, so the CLI would have been dead on Windows again.

  - **The MiniMax credential protection re-seated onto the fork's extracted store.** Upstream added
    `getMiniMaxApiKeyProtection()` (envelope-kind read, no decrypt, so opening Settings cannot
    prompt for the keychain) into the module `fbf4b16e66` had emptied into
    `createSecureCredentialStore`. It became `SecureCredentialStore.protection()`, so both new
    stores get it too. The same shape recurred in `AccountsPane`, where the fork had moved the
    state into `useAccountsPaneCredentialSections` — upstream's two new states were re-seated into
    `useMiniMaxCredentials`.

  - **The explorer name filter converged again, and this was the sync's largest merge.** `#34`
    refactored the projection into helpers (`file-explorer-name-filter-policy`,
    `-path-acceptance`, `-tree-nodes`, `-tree-sort`, `-projection-cache`) while upstream added the
    display-root scope (`displayRootPath`, `#18750`). The merged projection keeps the fork's
    helper-based acceptance/insertion/byte budget/chunked builder **and** upstream's
    `getRelativePathInsideRoot` scope walk plus its containment gate. Two consequences worth naming:
    `worktreePath` → `displayRootPath` wherever it means the _displayed_ root, and
    `file-explorer-visible-row-projection-build.ts` needed upstream's delta ported into it because
    `#34` had extracted those functions cleanly (git saw no conflict while upstream had patched
    exactly them).

  - **Upstream added a real Antigravity fetch, which supersedes the fork's borrow.**
    `antigravityResultPromise`/`antigravitySettled` arrived in this range; the fork's
    `deriveAntigravityRateLimits(gemini)` declared the same name in the same scope. Kept upstream's
    real read and dropped the derive — an upgrade, not a loss, but a **behaviour change** worth
    knowing: Antigravity no longer borrows Gemini's numbers on a failed read.

  - **Convergence decisions that went the other way.** `tui-agent-config.ts` took the fork's
    extraction into `tui-agent-config-table.ts` (43 entries, fork identity intact);
    `service-full-cycle-preparation.ts` took the fork's move of `FetchAllCyclePrepared` into
    `service-types.ts`, with upstream's new `antigravityResultPromise` member re-added to the moved
    copy; `worktree-removal.ts` keeps upstream's per-repo serialization with the fork's
    remote-branch read/write inside it; `worktree-remote.ts` keeps upstream's removal of the trust
    preflight (centralized in `execution-host-workspace-trust.ts`, `#23744`) and its
    `surfaceOwner: false`, with `#27`'s `if (startup && sequencedStartup)` structure and its
    `setup && !hasDefaultTabs` branch.

  - **Four transient reds, all proved pre-existing in the fork's own history and none chased.**
    Fixing them mid-replay would only have conflicted with the commit that already owns the fix:
    1. `src/main/claude/hook-settings.ts` — the staging snapshot committed
       `getWindowsPowerShellLifecycleCommand` mid-edit (`const innerCommand =` with no `return`).
       `451c286810` owns it. Landed correctly.
    2. `use-worktree-activity-status.ts` — the comma after `hasRetainedFailed` upstream's insertion
       displaced. Same owner, same commit.
    3. The three rate-limit provider suites (`service-{cursor,deepseek,fireworks}-usage`) failed
       mid-series on the shared harness's provider mocks until `fc2ed2727e` added them.
    4. `service-full-cycle-application.ts` was 308 counted lines until `ab0c9d9beb` extracted the
       inline provider fallbacks into `providerResultSnapshot()`.

  - **The traps, all found by a gate and none behind a conflict marker.**
    1. **`pnpm tc`**: `deleteBranchOfRemovedWorktree` survived one resolution as an inline body, so
       `finishUnregisteredWorktreeRemoval` lost its definition; the fork's `deleteRemoteBranch`
       never reached upstream's extracted `finishLocalWorktreeRemoval` or the runtime finish args,
       so the option was silently dropped between the IPC entry point and `git worktree remove`; an
       unused `SecretAtRestProtection` import in `AccountsPane`; and a plain unused-import set where
       two deleted tests had been the only users.
    2. **The pre-commit `max-lines` hook**, twice. `file-explorer-name-filter-projection.ts` needed
       the display-root gate/descent and the expanded-paths walk extracted into
       `file-explorer-name-filter-projection-walk.ts`, and the chunk predicate moved into
       `file-explorer-name-filter-tree-nodes.ts`. `remove-registered-local-worktree.ts` needed the
       orphaned-worktree recovery extracted into `orphaned-local-worktree-cleanup.ts`. No
       suppression and no per-file bump was added, per `AGENTS.md`.
    3. **The pre-sync-tip lost-content diff reduced to six files, all fork-only by construction** —
       `secure-credential-store.ts`, `service-types.ts`, `accounts-pane-credential-sections.ts`,
       `file-explorer-name-filter-tree-nodes.ts`, `file-explorer-visible-row-projection-build.ts`,
       `worktree-remote-branch-removal-real-git.test.ts`. Upstream never touched any of them because
       the fork introduced them; each carries a deliberate re-seat listed above.

  - Verified: `pnpm tc` clean at the tip; `range-diff` pairing all 140 patches with 105 `=` and 34
    `!`, every `!` reviewed; the pre-sync-tip lost-content diff as above; the derived localization
    catalog regenerated and both verifiers green; the fork's builder config loads and all five
    update-feed references still name `nplez1/orca`; `check:max-lines-ratchet` OK (7 grandfathered
    suppressions, no new bypasses); `check:reliability-gates` passes for 140 gates; the rpc-params
    catalog verifies; and `ORCA_CODE_QUALITY_BASE=upstream/main pnpm run check:code-quality:changed`
    reports **36 findings (27 design-system) across 1,464 changed files** — identical in kind and
    count to the previous three entries, with all nine flagged files byte-identical to the released
    np.15 tip.
    - The full `pnpm test` run reports **99,812 passing, 105 failing**, and the three fix commits
      above clear all but the environmental set. What remains, none of it from this sync:
      `browser-manager-{tab-identity,viewport-ownership}` need `ORCA_BACKGROUND_LAUNCH=1` (41/41
      pass with it); `tests/e2e/relay-region-correction.unit.test.ts` needs the uninstalled `cloud/`
      workspace's `pg`; and **22 cases across seven `agent-session-*` files are red because upstream
      is red there** — `src/main/native-chat/` and every file those suites load is byte-identical to
      `a5601375d4`, so this fork cannot be the cause and the next sync should re-check before
      assuming it is inherited.

  - **Left open, by name:**
    - _The projection cache key ignores the display root._
      `getFileExplorerNameFilterProjectionCacheKey` keys on `root: worktreePath`, and
      `use-file-explorer-chunked-projection` derives its job key from the same function, so two
      display roots over one worktree can serve each other's cached rows. The risk exists only
      because `#34`'s cache now meets `#18750`'s scope, and closing it means deciding whether the
      display root belongs in the key or in the cached value.
    - _`projectionContextKey` likewise omits `displayRootPath`_, so switching display root with a
      filter active does not invalidate the "previous page" fence.
    - _Nothing forces `displayRootPath` through the chunked path._ `NameFilteredProjectionArgs` is
      built with a spread, so a future caller omitting it silently gets worktree-root scoping
      rather than a compile error.
    - _`local(identity)` and the remaining `~/.orca` readers_ — unchanged from the previous entry,
      still a per-store data migration rather than a constant swap.
    - _The mobile page's Phase C sweep_ — unchanged from the previous entry; the module that moved is
      still unnamed.

- **2026-09-29 — released as `v1.4.214-np.15`** from `c8fa8feead` (workflow run 36563775496,
  signed and notarized), onto upstream `31012aeb09` (173 commits), from the tip `976844fac3`
  (np.14 released from `fd69125d49`, with `#40`–`#42` landed on top of it). **129 published commits
  replayed**, plus one new `local(terminal)` commit committed before the rebase and this sync's two
  fix commits on top: **107 byte-identical by `range-diff`, 22 adapted, none dropped, none added.**
  Sixteen of the 129 stopped on a conflict, across 37 distinct files; every hunk was an additive
  union, a re-seat of the fork's intent onto upstream's refactor, or upstream deleting a file the
  fork had patched — so no convergence question went to the fork owner this time either.
  - **`local(terminal)`: a BEL inside a control string is not a bell.** Pi writes `ESC _ pi:c BEL`
    on every prompt repaint, and the detector tracked only OSC, so each repaint announced a phantom
    "Attention requested". APC/DCS/PM/SOS now all swallow a BEL. Deliberately _not_ xterm-strict:
    xterm keeps those four open until ST, and Pi never sends one, so xterm's rule would pin the
    string and drop every later real bell. This commit leads the sync so the replayed series stays
    a linear patch series; it is not upstream-bound.
  - **Rate-limit providers unioned on every enumeration again.** Upstream's `zcode` joined the
    provider union, the five status-item migrations, the service state/polling/preparation and the
    bar's pending chain, in the same places `deepseek`/`fireworks`/`copilot` already sit. The
    `zcode` field is _optional_ on `UsageProviderSnapshots`, so its pending probe keeps upstream's
    `providers.zcode !== undefined` guard: an absent slice is not a pending one, and without that
    guard the setup CTA is held back forever.
  - **Upstream's junk-test purge deleted eleven files the fork had patched.** `#23815` removed 101
    test files, four of which is `DESCENDANT_PROVIDERS`' peers here
    (`orchestration-timeout*-cli.test.ts`, `claude-session-end-install.test.ts`,
    `SourceControl.host-context-boundary.test.ts`, `windows-pty-native-capability-workflow.test.mjs`)
    plus `track-community-prs.yaml`. All were `local(identity)` or `local(build)` string
    re-points, so the deletions are taken and the fork's change goes with them.
  - **The status bar is where upstream and the fork both keep adding providers.**
    `appearance-status-bar-search.ts` took upstream's `getZcodeStatusBarToggleSearchEntry()` into
    the fork's `appearance-status-bar-provider-toggles.ts` delegation, and
    `status-bar-default-on-migrations.ts` took upstream's ZCode one-shot migration. The order that
    matters is the migration list's: this fork's providers stay contiguous (`deepseek`,
    `fireworks`, `cursor`, `copilot`) with upstream's `zcode` after them, which is what
    `ui-hydration-workspace-preferences.test.ts` asserts.
  - **`#27` re-seated onto upstream's restructured worktree create.** The trust preflight and its
    terminal now sit inside the fork's `if (startup && sequencedStartup)` guard, with upstream's
    new `qoder` preset added inside it, and `#19`'s `setup` status kept ahead of upstream's
    `hasRetainedFailed` — a live setup outranks a retained verdict, which is upstream's own rule
    for live work.
  - **Two workflow files, both upstream-rewritten under a fork-owned verdict.** `e2e.yml` and
    `unit-tests.yml` keep upstream's new steps (the failure summary, the shard-selection artifact,
    the `.index`/`.count` matrix) _and_ the fork's verdict wiring. Their JSON reports were
    reconciled rather than duplicated: Playwright honours `PLAYWRIGHT_JSON_OUTPUT_FILE` over
    `PLAYWRIGHT_JSON_OUTPUT_NAME` when both are set (measured on 1.63.0), so the e2e step keeps
    upstream's env var and its own `--reporter=list,json` and the fork's verdict now reads the same
    `ci-shards/results.json` the failure summary does — the fork's second output name is gone, and
    with it the `if repository != stablyai/orca` shell guard the run step no longer needs. The
    unit-shard step keeps its report arguments inside that guard, because upstream added no
    reporter of its own there. Both verdict contract suites were updated to pin the _interaction_
    and both pass. `e2e.yml`'s `Summarize E2E failures` step and the `unit-tests.yml`
    tee/mkdir/pipefail lines stay unguarded on purpose: upstream's shard lane already creates
    `ci-shards/` for its download-artifact step, and `pipefail` preserves Vitest's exit code, so
    neither changes what upstream's lane decides.
  - **`local(identity)` re-applied onto nine new surfaces.** Upstream's CLI-identity suites pin
    `orca`/`orca-dev`/`orca.exe`; the fork ships `orca-np`/`orca-np-dev`/`orca-np.exe`, and the
    login-shell harness stubs the app's launcher by that name, so its bare-name arm models the
    fork's own command rather than upstream's. The new dsh hook service hardcoded `.orca` for its
    remote script and managed-hooks path where claude/devin/droid/gemini/copilot/cursor use
    `HOME_DIRECTORY_NAME` — an SSH install wrote into an official install's directory.
  - **Measured, never chosen:** the mobile page's Phase C sweep. This head cuts the swept tree into
    73 chunks against the 69 the table recorded, past the four the fence gives a refactor, so
    `MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP` was re-derived by building `routes.slice(0, n)` for every
    n rather than the envelope raised. Its worst marginal route now costs ten scripts (was nine),
    which moves in the route count at which the derived asset ceiling passes the shell's 256 from
    32 to 30. `DIRECT_IMPORTER_PIN` and `UNHIDDEN_SPAWNER_PIN` needed nothing this time: the
    purge-superseded pin was dropped by upstream, and the allowlist fixture only lost
    `macos-tailscale-dns-diagnostic.ts` to a `runProcess` migration the gates saw.
  - **The traps, all found by a gate and none behind a conflict marker:**
    1. **`pnpm tc`**: the replayed `local(identity)` patch tore
       `getWindowsPowerShellLifecycleCommand` apart — the merge kept upstream's
       `const innerCommand =` opener and the base's closing paren, leaving no `return` (`innerCommand`
       was dead, so only the shape was wrong); a missing comma after `hasRetainedFailed` in
       `use-worktree-activity-status`'s dep array; and three providers upstream added to
       `AgentHookSource` (`qoder`, `codebuddy`, `dsh`) that the fork's `DESCENDANT_PROVIDERS`
       `Record` enumerates by design, so a new provider is a compile error rather than a gap.
    2. **A failing suite, not a type error — eleven surfaces upstream added or rewrote after this
       fork's base:** the ZCode fetcher joined the shared rate-limit harness, so the DeepSeek and
       Fireworks suites needed its mock the way Cursor's already had it; the Jenkins panel suite's
       `@/i18n/i18n` mock predated the localized catalog reading `i18n` off that module; and the
       nine CLI-identity suites above needed the fork's launcher names.
    3. **A file the purge left in the fork's tree.** `windows-pty-native-capability-workflow.test.mjs`
       and `track-community-prs.yaml` conflicted as modify/delete; both are taken as deleted, not
       re-added.
  - Verified: `pnpm tc` clean at the tip; `range-diff` pairing all 129 patches with 107 `=` and 22
    `!` (every `!` reviewed — six are context-only shifts under upstream's new lines); the
    pre-sync-tip lost-content diff reduced to the four files this sync deliberately adapted
    (`appearance-status-bar-provider-toggles.ts`, `status-bar-default-on-migrations.ts` and the two
    `terminal-bell-detector` files of the new `local(terminal)` commit), none of which upstream
    touched in this range; the derived localization catalog regenerated and both verifiers green;
    the fork's builder config loads and all five update-feed references still name `nplez1/orca`;
    and the full `pnpm test` run reports **98,196 passing, 1 failing** — a 30s timeout in
    `release-checkout.unit.test.ts` under full-suite load that passes 10/10 in isolation, in the
    same cross-version lane the previous entry records as environmental; the uninstalled `cloud/`
    workspace's `pg` keeps `relay-region-correction.unit.test.ts` red, as documented.
  - **Pre-existing, not from this sync:** `pnpm run check:code-quality:changed` reports **36 findings
    (27 design-system) across 1,326 changed files** with `ORCA_CODE_QUALITY_BASE=upstream/main` —
    identical in kind and count to the last two entries. All nine flagged files were checked and
    every one is byte-identical to the released np.14 tip.
  - **Base drift, re-measured:** the seven PR-bound branches now sit **975 commits behind**
    `upstream/main` (from `560c42e1d1`), the five deliberately-left ones **1069 behind** (from
    `615b1370fb`) — see [BRANCHES.md](./BRANCHES.md).
  - **Left open, by name:**
    - _Which module added the five chunks_ the mobile page's sweep grew by. The re-measure is the
      documented response to drift past the margin, but it is a measurement, not a diagnosis: a
      shared importer set moving is the known cause and the split is still inside both budgets, so
      nobody has yet named the module that moved. Worth one pass before the next sync re-measures
      again.
    - _`local(identity)` and the remaining `~/.orca` readers._ `local(identity)` renames the _home_
      directory (`~/.orca` → `~/.orca-np`) only where this patch already reached. Upstream has
      since added home-scoped stores that still hardcode `.orca`: `jira/site-credential-store.ts`,
      `jenkins/jenkins-server-store.ts`, `bitbucket/credential-store.ts`,
      `credentials/secure-credential-store.ts`, `agent-hooks/managed-hook-install-lock.ts`,
      `floating-workspace-launch-directory.ts` — plus the remote hook paths in
      `muse/hook-service.ts`, `muse/hook-settings.ts` and `zcode/hook-service.ts`. None is a
      regression from this sync and no gate flags them, because each writes and reads the same
      path. The reason not to sweep them into a sync is that several of those paths hold **on-disk
      state** — credentials, a lock file, the managed-hooks directory — so re-pointing them is a
      data migration that orphans what is already there, not a constant swap. Per-store triage
      before any of them moves: unreachable in a fork build, a live write whose reader already
      moved, or a migration that has to be designed.
    - _The intermediate commits of this series are not self-consistent about the derived catalog._
      `en-runtime-required.json` conflicted twice and was resolved by taking one side and
      regenerating at the tip (the runbook's procedure), so `runtime-required-catalog.test.ts`
      cross-checks `en.json` only at the tip. Nothing gates a mid-series commit, but a `git bisect`
      that lands there would see it.

- **2026-09-27 — released as `v1.4.214-np.14`** from `fd69125d49` (workflow run 36342286779,
  signed and notarized), onto upstream `27b823f934` (206 commits), from the released tip
  `2ca7d38b4f` (np.13 released). **116 commits replayed**, plus this sync's two fix commits on top
  (`c4a09ba325`, `1c7a5ceb85`): **92 byte-identical by `range-diff`, 24 adapted, none dropped,
  none added.** Twenty-two of the 116 stopped on a conflict, across 40 distinct files; every hunk
  classified as an additive union or a re-seat of the fork's intent onto upstream's refactor, so no
  convergence question went to the fork owner this time.
  - **Rate-limits providers, unioned onto upstream's `service/` split.** Upstream added a `cursor`
    provider to every enumeration the fork adds `deepseek`/`fireworks` to, and both sides added a
    money readout (`credits`/`allowance`). `service-types.ts`'s moved `FetchAllCyclePrepared`
    (from `#33`) took upstream's `SettledProviderResult` and `cursorResultPromise`. Still only
    covered per provider: no single test drives `cursor`, `deepseek` and `fireworks` together
    through state → polling → result-policy, so the shared contract is the residual risk of this
    sync's largest union.
  - **Two "upstream built the same thing" re-seats, both kept on the fork's subsystem.**
    `appearance-status-bar-provider-toggles.ts` (the fork's delegation) took upstream's
    `getCursorStatusBarToggleSearchEntry()`, and `status-bar-default-on-migrations.ts` took
    upstream's Cursor one-shot migration. That left upstream's
    `ui-slice-hydration-status-bar-items.ts` with no importer; it is deleted so the next sync
    conflicts instead of silently missing a new default-on provider.
  - **`#19` re-seated onto upstream's flattened mixin chain.** Upstream deleted
    `orca-runtime-structured-agent-session-launch-tui.ts` and re-homed its methods, so
    `OrcaRuntimeWithSetupRunnerState` now sits directly above `OrcaRuntimeWithGetWorktreePs`.
  - **The explorer path index (`#20`, `#34`) met upstream's reworked watcher and worker queue.**
    `worker-thread-request-queue.ts` unions upstream's abort-signal support with the fork's
    concurrent registry; `worker-thread-concurrent-request-registry.ts` (new here) was adapted to
    upstream's `WorkerRequestTransport`; `filesystem-watcher-local-subscription.ts` unions
    upstream's sender lifetime with the fork's sender-less `indexConsumerId` consumer. Upstream
    moved the three SSH pending-install tests into the fork's own new
    `filesystem-watcher-pending-ssh-install.test.ts`, so that duplicate file is deleted and
    upstream's rewritten copies stay in `filesystem-watcher.test.ts`.
  - **`local(identity)` re-applied onto surfaces upstream rewrote.** The ZCode hook test now derives
    its directory from `HOME_DIRECTORY_NAME`; `wsl-managed-cli`'s new fixture uses
    `orca-np.exe`/`orca-np-dev`; `daemon-host-relocation.test.ts` no longer hardcodes `Orca`;
    `ORCA_CLI_COMMAND` keeps the fork's `orca-np` literal. Upstream's new `getManagedWslCliDir`
    named the managed launcher `orca-ide` (via `getWslCliCommandName`), which `WSL_MANAGED_CLI_PATH_RESTORE`
    checks against `$ORCA_WSL_CLI_DIR/$ORCA_CLI_COMMAND` — so the managed dir was never added to
    PATH and every WSL shell warned "Orca CLI unavailable". The launcher is now named by the new
    `getManagedWslCliLauncherName` (`orca-np`/`orca-np-dev`, matching `ORCA_CLI_COMMAND`), while
    `getWslCliCommandName` keeps upstream's `orca-ide` for the browser command, which resolves
    through the guest registration.
  - **Measured ratchets, never chosen:** `DIRECT_IMPORTER_PIN` 152 → 148 → 147 and
    `UNHIDDEN_SPAWNER_PIN` 61 → 60, each taken from the failing test's own message after the
    allowlist settled.
  - **The traps, all found by a gate and none behind a conflict marker.** Upstream's new surfaces
    are where this sync actually cost work:
    1. **`pnpm tc`**: the DeepSeek doc-comment opener torn off by a union in `rate-limit-types.ts`
       (the same trap as 2026-09-25); a fork-added `isUsageEmptyState` literal missing upstream's
       `cursor` key; and `zcode` added to `AgentHookSource`, which the fork's `DESCENDANT_PROVIDERS`
       `Record` enumerates by design, so a new provider is a compile error rather than a gap.
    2. **A failing test, not a type error — nine surfaces upstream added or rewrote after this
       fork's base:** the new session-search feature tip read the pre-rename `enabled` consent
       field (a real bug: the resolved settings object only has `contentEnabled`, so the tip was
       always offered and enabling it wrote `contentEnabled: false`); the new DNS probe-admission
       test mocked `execFileSync`, which this fork replaced with the async `runProcess` probe; the
       new filesystem-watcher root double omitted fields `#34` made required, crashing
       `cancelLocalBatchFlush`; the Cursor and Copilot providers joined the shared rate-limit
       harness, so the older service suites needed their mocks; the new WSL-CLI fixture, the ZCode
       hook test, the updater feed test, and the new `default-branch-folder-project-root` options
       literal all needed the fork's names; and `AiVaultPanelSearch.test.tsx` expected the literal
       `enabled` write.
    3. **A skipped commit's tail.** `#34` moved the SSH pending-install tests, so upstream's
       rewritten copies and the moved file had to be reconciled rather than both kept.
  - Verified: `pnpm tc` clean at the tip; `range-diff` pairing all 116 patches with 92 `=` and 24
    `!`; the pre-sync-tip lost-content diff reduced to the five files this sync deliberately adapted
    (`worker-thread-concurrent-request-registry.ts`, `appearance-status-bar-provider-toggles.ts`,
    `visible-worktree-kind-filters.ts`, `status-bar-default-on-migrations.ts`, `descendant-events.ts`),
    none of which upstream touched; the derived localization catalog regenerated with **no diff** and
    both verifiers green; the fork's builder config loads and all five update-feed references still
    name `nplez1/orca`; and the full `pnpm test` run reports **95,555 passing, 4 failing** — all four
    environmental (Playwright browsers for the `mobile-web-app-*` render suites, the uninstalled
    `cloud/` workspace's `pg`, and the `.cross-version-checkouts` tag), the documented set.
  - **Pre-existing, not from this sync:** `pnpm run check:code-quality:changed` reports **36 findings
    (27 design-system) across 1,273 changed files** with `ORCA_CODE_QUALITY_BASE=upstream/main` —
    identical in kind and count to the 2026-09-25 entry. All ten flagged files were checked: eight
    are byte-identical to the released np.13 tip, and the two that differ
    (`detected-scan-failure-authority.test.ts`, `use-worktree-jump-palette-worktrees.ts`) carry the
    same assertions text that the released tip already had. The one finding this sync did add — a
    stale `repoMap` dependency left in the jump palette's `emptyQueryVisibleWorktrees` memo — was
    removed, which is what brings the count back to 36.
  - **E2E stayed green.** The two scheduled failures the fork's `#36` repaired stay repaired (the
    New-tab locator and the ungrouped host-status spec), and `golden-core-flows`, `tabs`,
    `tab-create-entry-file-paths`, `golden-tab-bar-agent-launch`, `golden-shell-after-agent-exit`,
    `terminal-attention` and `terminal-tab-switch-visual-restore` all pass on a clean rebuild of the
    rebased tree. `runtime-host-status-recovery` passes the recovery and host-card assertions this
    fork touches and then fails at `launchPairedWebClient` with "HUB runtime did not provide a paired
    web client URL" — the same failure the unmodified spec hits on upstream `27b823f934` and on the
    pre-sync tip in this environment, where no `out/web` bundle is built. The `known-failure-titles`
    ratchet and its two contract suites are untouched (`21/21` pass), so a genuinely new scheduled
    failure still fails the run.

- **2026-09-25 — released as `v1.4.197-np.12`** from `c80bbf6aba` (workflow run 36121027339,
  signed and notarized), then **`v1.4.197-np.13`** from `227953323b` (run 36173876959) carrying the
  two `local(agents)` follow-ups below. One commit landed on the remote's `nplez1/main` while the sync
  was running —
  `dd06e8a8f4` (#32, hide disabled agents from the session-history filter). It was cherry-picked onto
  the rebased line as `c80bbf6aba`, applied with no conflict and the same 130/57 delta; `pnpm tc`
  stayed clean, its three touched suites pass 16/16, `local(identity)`'s `contentEnabled` rename in
  `AiVaultPanel.legacy-filter.test.tsx` survived, and the localization catalog was regenerated with
  no diff. The force-push was rejected first with `stale info` — the pinned lease caught it, which is
  exactly what the lease is for — and re-issued against the real remote tip.
- **2026-09-25** — onto upstream `f5d2ce5de7` (160 commits), from the released tip `244781de27`
  (np.11 released). 104 commits replayed: **83 byte-identical by `range-diff`, 20 adapted, 1 dropped
  as already-applied, none added.** Fourteen of the 104 stopped on a conflict, across 29 distinct
  files (a few files conflicted twice, from two different patches). Two
  convergences were put to the fork owner and both were decided for the fork's side of the question:
  the Codex child-work lane adapted onto upstream's fold, and the explorer name filter adapted onto
  upstream's host-filter model.
  - **Additive union, mechanical** (7 sites): `rate-limit-types.ts`, `rate-limit-state-factory.ts`,
    `rate-limit-types.test.ts`, `service-configuration.ts` (upstream's `opencodeGoApiKeyConfigured`
    beside our DeepSeek/Fireworks flags), `use-status-bar-controller.ts` (upstream's OpenCode key flag
    beside ours — needed a hand fix, the union duplicated `grokAuthConfigured`), `accounts-pane`
    (`apiKey` in the edited-settings ref beside our `useAccountsPaneCredentialSections`),
    `electron-builder-config.test.mjs` (one import each) and `en.json` twice (`hosted.review` blocks;
    one union lost the DeepSeek doc-comment opener and `pnpm tc` caught it, and one lost a closing
    brace, caught by `JSON.parse`).
  - **Codex child-work lane, converged onto upstream's fold** (`66ca697812`, the sync's largest
    decision): upstream's `#22521`/`b4d732685c` landed _after_ our commit was authored and pushed
    Codex child work through the shared `agent-lead-status-fold`, while our commit generalized the
    Codex roster to `AgentDescendantRoster` and added a generic descendant lane. Took upstream's
    `codex-events.ts`/`codex-state.ts` and applied our rename mapping to them (longest identifiers
    first), kept upstream's `codexRosterChildWorkLiveness` name because upstream's parity test
    imports it, and kept our `agentDescendantEffectiveState` for the generic lane. `muse` and
    `opencode2` were then added to the provider enumerations: upstream added both to the shared
    `AgentHookSource` union, and the enumerations are `Record`s over it _by design_, so a new member
    is a compile error rather than a silent gap (muse answers "owns its own lifecycle" — its
    provider already filters child sessions). That last addition made the fork's own later
    `dc725bef8b` redundant, and git **dropped it as already-applied**; its whole diff is the one
    `opencode2: null` line, verified present.
  - **Explorer name filter, converged onto upstream's host-filter model** (`99bb44623f`, `0b625aaca5`):
    upstream independently built `hostFilterWhenCapped` + `shared/file-name-filter-tokens.ts` ("the
    host can filter a scan exactly like the renderer") while our commits add `queryMode`/`queryLimit`,
    an exact `totalCount`, `ignoredFiles` and the honest empty state. Both are driven from the same
    call site, so a syntactic union would have sent two competing host-filter requests. Kept
    upstream's `hostFilterWhenCapped` (and its `usesRuntimePathSearch` rule, dropping our local-query
    rewrite) plus our `totalCount`/`truncated` plumbing and `getFileExplorerNameFilterEmptyMessageKind`
    — upstream has no equivalent of that empty state, and `FileExplorerNameFilterTruncationNotice`
    reads `totalCount`. The projection's tokenizer moved to upstream's shared module so renderer and
    host cannot disagree. Two of our tests were **dropped**: they asserted the local-query search that
    the capped host re-list replaces (`quick-open-file-list.react.test.tsx`), on the same footing as
    the 2026-09-22 sync's dropped test; upstream's own `quick-open-file-list-host-name-filter.react.test.tsx`
    covers the new path, `use-file-explorer-name-filter.test.ts` covers queryMode/queryLimit/totalCount,
    and `file-explorer-name-filter-empty-message.test.ts` covers the empty state. The harness typo a
    later fork commit also fixed (`onState: () => {}` never populating `states`) was fixed here.
  - **Ripgrep scan extraction met upstream's in-place rework** (`0b625aaca5`): our commit extracted
    `scanRipgrepPaths` into `quick-open-rg-path-scan.ts` while upstream reworked that same function in
    place (bundled ripgrep, synchronous-spawn classifier, missing-cwd diagnosis, optional `stdout`).
    Merged upstream's reworked body **into** the extracted module, keeping our `onPath`/early-stop
    contract, then re-added `collectQuickOpenPaths` and the `includeIgnoredFiles` pass selection to
    `filesystem-search-file-paths.ts`. This is the one place in the sync where two compilable halves
    had to be fused rather than chosen.
  - **`local(identity)`** (`1c7e1f6a7d`, `6dca5cd822`): the `.orca-np` predicate in the managed-hook
    test is superseded by upstream's `/\\.(?:sh|cmd)$/` test, which no longer names a directory at all.
  - **Ratchet pins are measured, not chosen** (`5741e10d96`): `DIRECT_IMPORTER_PIN` and
    `UNHIDDEN_SPAWNER_PIN` were lowered on both sides for different reasons, so the merged tree's real
    counts are the answer — `151` and `61`, taken from the failing tests' own messages. Never pick
    either side's number here.
  - **Monitoring policy, kept on upstream's fold** (`b56efa03ec`, the second fork-owner decision):
    upstream's fold reads any live non-agent child work as `monitoring`, including a background shell;
    our `#26` reserves the badge for Claude session-cron callbacks. Expressed the fork's policy on
    upstream's fold (`hasLiveAgentWork` = roster-working or running shell; `hasLiveNonAgentWork` =
    session-cron only) and dropped grok's `workingMode` spread, then realigned the seven test surfaces
    that encode it. Now documented as a `local(agents)` patch — including the consequence flagged to
    the fork owner: because `isAgentTimeAccruing` excludes only `monitoring`, a shell-held row now
    accrues agent time where it did not before, which is a session-stats change beyond the badge.
  - **pi single-binding patch, re-seated** (`183a25f9ba`): upstream `#21882` moved the pi subagent
    bindings into `agent-status-subagent-roster-source.ts`, so the fork's removal of the two
    `subagent:async-*` bindings moved with them (`LOCAL(nplez1)` comment). The matching test
    adaptation followed into the new `agent-status-extension-async-subagents.test.ts`: its four
    deferral cases now assert what the fork actually does (the child ids ride `subagent_runs` and the
    lead's `agent_end` is not withheld at source) instead of upstream's withheld `agent_end`, keeping
    each case's subject and asserting exact roster sequences rather than weakening to truthiness.
    **Gap closed after the sync:** upstream's roster removes a child on `subagent:process-terminal`,
    which the fork's bus did not bind, so a pi child whose only end signal was a runner exit stayed in
    the fork's live set until the descendant lane's quiet-reap window or a scope reset retracted it.
    The fork's bus now binds that channel through the same retire-and-repost path as its other end
    channels, so the child leaves the live set on its runner exit and the pane recomputes its hold
    from the shrunken set; the quiet reap remains the recovery for a loss nothing reports at all.
  - **Other mechanical resolutions:** `local(identity)`'s builder-config import; the `main.css`
    add/add of the _same_ `--status-warning` tokens with different values (kept upstream's `#ca8a04`
    light / `#eab308` dark — upstream's yellow serves our own comment's stated intent, since our
    `#b45309` _is_ amber-700); `agent-descendant-roster.ts` keeping both upstream's
    `codexRosterChildWorkLiveness` and our `agentDescendantEffectiveState`; and `listener-state.ts`
    twice (upstream's extraction of the lead-turn types to `main-agent-turn-state.ts` beside our
    `CopilotBackgroundWorkState`, which a later fork commit moved to its own module).
  - **The traps, all found by a gate and none behind a conflict marker:**
    1. **`pnpm tc`**: the DeepSeek doc-comment opener lost in an additive union; `AgentStatusState`
       dropped from `listener-state.ts`'s imports when our commit's import edit collided with
       upstream's; `descendant-events.ts`'s provider switch no longer exhaustive after upstream added
       `muse`/`opencode2` to the source union; and a second `PathSearchMatcher` import dropped while
       trimming unused imports after the scan extraction.
    2. **A failing test, not a type error — three more surfaces upstream added that assume the
       fork's environment away:** the fork's `service-deepseek-usage.test.ts` and
       `service-fireworks-usage.test.ts` still mocked `./opencode-go-usage-fetcher`, which upstream
       retired in favour of `./opencode-go-usage-source-selection` (both sides typecheck; only the
       shared harness's `vi.mocked(...).mockResolvedValue` failed at runtime — 15 tests);
       `muse/hook-service.test.ts` hardcoded `.orca` where `local(identity)` renamed the home
       directory (now derived from `HOME_DIRECTORY_NAME`, so the next rename cannot leave it
       behind); and `agent-hook-listener-grok-completion.test.ts` still expected
       `workingMode: 'monitoring'` for a grok shell — the **eighth** surface of the monitoring policy,
       which arrived with upstream after the seven the sync realigned. The worktree-listing trio
       (`detected-worktree-scan-superseded`, `detected-provider-listing-catalog-version`,
       `detected-provider-listing-overtaken-scan`) is the same shape from the other direction:
       upstream's new test files build a minimal `store` double, and the fork's
       `detected-worktree-scan-cache.ts` calls `getProfileStorageDirectory()`, which the fork's own
       store doubles elsewhere already stub. The missing method made the scan degrade to its
       metadata fallback and fail three unrelated assertions, so the fix is the double, not the scan.
    3. **Ratchets** and **`main.css`**: see above — both are cases where "pick a side" is the wrong
       operation.
  - **Two red patches were proved transient, not chased:** the intermediate reds in
    `AiVaultPanel.legacy-filter.test.tsx` (`enabled` vs our renamed `contentEnabled`),
    `use-file-explorer-name-filter.test.ts` (a `resolvedQuery` field that exists in neither tip) and
    the `ReadonlyMap` misuse in two of our test files are all fixed by commits later in the series
    (`90a9b123d1` and `e51c334309`'s successors). Each was checked against the _original_ commit with
    `git show <sha>:<path>` before deciding, and every one was pre-existing in the fork's own history
    rather than rebase-induced. Fixing them mid-replay would only have created a conflict at the
    commit that already owns the fix.
  - Verified: `pnpm tc` clean at the tip; the definitive full `pnpm test` run reports **9,571 passing
    tests (9,648 files, 72 skipped) and 5 failing files — every one of them classified and proved
    environmental rather than reconciled against the first run**: the 12
    `browser-manager-viewport-ownership` cases pass with `ORCA_BACKGROUND_LAUNCH=1` (as this repo's
    policy requires for a background-launched suite); the `build-native-for-platform` case
    "stalls past the reap timeout" is a wall-clock test that passes 21/21 standalone;
    `cross-version-wire/release-checkout` passes 10/10 standalone and only times out under full-suite
    load (17.7 s case against a 30 s budget). The remaining three are the documented `tests/e2e` class:
    the uninstalled `cloud/` workspace's `pg`, and the 1.5 GB `.cross-version-checkouts` walker. An
    earlier run of the same suite reproduced exactly this set. Also verified: `range-diff` pairing all
    104 patches with 83 `=` and 20 `!`; the pre-sync-tip lost-content diff reduced to the five files
    this sync deliberately adapted (all five ours — upstream never touched any of them); the derived
    localization catalog regenerated with **no diff** and both verifiers green; the fork's builder
    config loads and all six update-feed references still name `nplez1/orca`; `fork-release.yml` is
    byte-identical to np.11's with all five signing secrets present; `oxlint` reporting only the
    repo's pre-existing findings (`check:max-lines-ratchet` green — "7 grandfathered suppression(s),
    no new bypasses"); and the changed-code gate re-run against the true base (see below).
  - **Pre-existing, not from this sync:** `pnpm run check:code-quality:changed` reports **36 findings
    (27 design-system) across 908 changed files** when run with `ORCA_CODE_QUALITY_BASE=upstream/main`.
    Identical in kind and count to the 2026-09-22 entry. Each of the nine flagged files was then
    checked one by one, the way the reviewer asked: **eight are byte-identical to the released np.11
    tip** (`git diff --quiet backup/nplez1-main-pre-sync HEAD -- <path>`), and the ninth,
    `src/renderer/src/hooks/ipc-events-test-harness.ts`, is flagged for one assertion —
    `} as Record<string, unknown>,` — whose text is byte-identical in the np.11 tip, in
    `upstream/main`, and now, and which carries no `SAFETY:` comment in any of the three. So this sync
    introduced none of the 36, and the harness finding is attributable only because the fork's own
    commit adds lines in that file and the gate's added-line window covers the assertion.
    As before, the gate's own base resolves to the _pre-sync_ tip (`origin/HEAD` names `nplez1/main`,
    which the rebase has not been pushed to yet), so its merge-base falls back and the whole
    fork+upstream delta reads as added lines — the run is only meaningful once `origin/main` is
    fast-forwarded, or with the explicit base above.
  - **Resolved after the sync — grok no longer gated twice, and its one child question kept:** our
    generic descendant lane owned grok while upstream's new grok lane both refuses to settle the
    parent from a child event and reads a background subagent as working. Upstream's
    `providers/grok-events.ts` is now the single owner of grok's child lifecycle, and the fork's
    grok-specific reader and its descendant-lifecycle cases were deleted; the cases that were really
    about the generic lane's own bookkeeping (roster, quiet reap, scope reset, pane-scoped cache)
    moved to pi, its other provider. One surface could not simply be given up, because it is the one
    upstream's lane cannot carry: grok auto-allows `ask_user_question`, so a child blocked on a human
    answer announces it as a PreToolUse carrying `subagentType` — and upstream drops every payload
    that names a child. A row settling `done` over an unanswered question is the worst state to hide,
    so the lane keeps exactly that one reader and gates an owning provider's row only while its
    roster holds a waiting child. See the `local(agents)` section below for the anchors.

- **2026-09-22** — onto upstream `6ae5ef2d00` (67 commits), from the released tip `08b1285fda`
  (np.10 released) plus the commit that landed on `nplez1/main` while the sync was running
  (`3a346cc657`, #25 — cherry-picked onto the rebased line, where it replays byte-identical). 95
  commits replayed: **87 byte-identical by `range-diff`, 8 adapted, none dropped.** Four of the 95
  conflicted, across eight files:
  - **Additive union** (1 file): `en.json` took upstream's `NativeChatResumeStatusSegment` (#21397)
    beside our `providerCredits` block at the same spot. The derived catalog was regenerated, never
    hand-merged.
  - **Upstream rewrote the same hook** (4 files): upstream's #22173 (`b57facc5bc`, stale listings)
    deleted `resolvedQuery` from `RuntimeFileListState` and replaced the hook's
    `files`/`truncated`/`loading`/`resolvedQuery` state with a request-keyed `{ listing,
    loadingRequest }` pair — while our `2d946fd65a`/`1b420e58c6` (#20) add `totalCount`,
    `ignoredFiles`, `queryMode`/`queryLimit` and the name-filter matcher to that same hook.
    Converged on upstream's model: `totalCount` and `ignoredFiles` moved _into_ the request-keyed
    listing — upstream's own comment there already promises "local listings key without the query, so
    they answer every query" — so every `setTotalCount`/`setIgnoredFiles` site collapsed into
    `setListing(NO_LISTING)` / `setListing({ requestKey, ...result })`, and our renderer-side
    `nameFilterListingIsUsable` fence was deleted rather than ported, because the hook now produces
    exactly the behaviour it implemented. One upstream test was **dropped**:
    `'keeps the local listing across query changes without restarting it'` asserts the pre-#20
    premise (one `listRuntimeFiles` across query changes) that #20 deliberately replaces with a
    per-query host search, so it cannot hold here.
  - **Upstream refactored the same surface** (3 files): upstream's #22098 (`6ce7208b98`) moved
    `buildVisibleWorktreeOptionsFromState` and the paired-device helpers out of `visible-worktrees.ts`
    into `visible-worktree-options-from-state.ts`, while our #23 extracted the four kind filters into
    `visible-worktree-kind-filters.ts`, added `hiddenWorkspaceStatusIds` to `VisibleWorktreeOptions`
    and threaded it through the sidebar pipeline, the jump palette and the board. Re-seated rather
    than unioned: the status field now lands in the _new_ builder module; `visible-worktrees.ts`
    takes upstream's narrower import set plus our `applyWorkspaceKindFilters`, which is what retires
    `isDefaultBranchWorkspace` and the paired-device helpers from that file; and the jump palette
    keeps upstream's `worktreeIdsWithStructuredChat` memo beside our `kindFilteredWorktrees`.
  - **The traps, both found by a gate and neither behind a conflict marker** — five sites across four
    files, split across two gates:
    1. **`pnpm tc`** (`90a9b123d1`): `use-file-explorer-name-filter.test.ts` set `resolvedQuery` on a
       mocked listing (upstream deleted the field); `use-visible-worktrees.test.tsx` built a
       `filterState` for a test upstream added in #22098 without `hiddenWorkspaceStatusIds`, which
       our #23 made required; and `AiVaultPanel.legacy-filter.test.tsx` enabled the vault search as
       `enabled`, the legacy name, in two tests upstream added, against the `contentEnabled` type our
       `3141d7578a` had narrowed. Those last two still **passed** at runtime through
       `resolveAiVaultSearchSettings`'s legacy `enabled` fallback, so only the typechecker saw them.
    2. **A failing test, not a type error** (`7f011bbc1c`): our `da585d39a4`'s "falls back to this
       install's own helper bundle id" test read the helper plist with `execFileSync` and asserted
       the reset against `spawnSync`; upstream then moved both the bundle-id read and `tccutil reset`
       onto the shared `runProcess` chokepoint (`macos-tcc-reset.ts`). The clean merge kept our test
       with upstream's implementation, so the test's way of making the plist unreadable never reached
       the code under test. Its production half is intact and still what the test pins:
       `DEFAULT_COMPUTER_USE_BUNDLE_ID` is `${ORCA_APP_ID}.computer-use` here, where upstream
       hardcodes `com.stablyai.orca.computer-use`.
       Both are carried as **two commits on top of the replayed series** rather than folded back into
       the commits they belong to, matching how the 2026-09-21 sync carried `9908062478` and
       `c7e93e5b2d`. They are the two `>` entries the sync's `range-diff` prints.
  - Verified: `pnpm tc` clean; **7,308 passing tests across 850 files** (4 skipped) covering every
    touched area — the explorer name filter and its projection/truncation notices, quick-open,
    sidebar listing/jump-palette/board, settings accounts, ai-vault, rate-limits, updater,
    computer-use, the github PR cache and source control, and filesystem search; `range-diff` with all
    95 patches paired and the pre-sync-tip lost-content diff empty; the localization catalog
    regenerated with no diff and both verifiers green; the fork's builder config loads and the update
    feed still names `nplez1/orca`; `pnpm install --frozen-lockfile` clean, the `package.json` delta
    being scripts only.
  - **Pre-existing, not from this sync:** `pnpm run check:code-quality:changed` reports 36 findings
    (27 design-system) across 1,396 changed files. The gate's base still resolves to the old base
    `663d670878` — `origin/HEAD` names the pre-sync tip, so its merge-base falls back and the whole
    fork+upstream delta reads as added lines. All nine flagged files are **byte-identical to the
    released np.10 tip**, so this sync added none of them.
  - **Still open from 2026-09-21, unchanged:** the OMP async-alias coverage given up by converging on
    the fork's pi subsystem.

- **2026-09-21** — onto upstream `663d670878` (128 commits), from the released tip `b2ac711f55`
  (np.9 released; the next build stamps its own run number). 84 commits replayed: **75
  byte-identical by `range-diff`, 9 adapted, none dropped.** Six of the 84 conflicted, across five
  files, and every one was mechanical:
  - **Additive union** (3 files, 8 sites): `AccountsPane.test.tsx` and `accounts-search.test.ts`
    (upstream's OpenCode console-cookie tests landed beside our DeepSeek/Fireworks ones), and
    `listener-state.ts` twice — our `copilotBackgroundWorkByPaneKey` and then
    `descendantRosterByPaneKey`/`descendantLeadStateByPaneKey` against upstream's new
    `opencodeSessionPaneBySessionId`/`lastLaunchTokenByPaneKey`. Both sides were kept at each site,
    and the `CodexSubagentRoster` → `AgentDescendantRoster` rename replayed onto upstream's version.
    Upstream never touched `paneHasStateClaims`, so our claim check on the Copilot map survived.
  - **Derived file** (1 file): `en-runtime-required.json` conflicted in `bf3598c6ff`; the source
    `en.json` auto-merged and the catalog was regenerated, never hand-merged.
  - **One surface, two lineages** (1 file): the pi test harness. Our older commit bound a mocked
    process bus (`emitProcessBus`) that the harness no longer needs, because upstream had already
    added the `pi.events` surface our _later_ commit converges onto. Kept upstream's implementation
    and applied only our removals, so the file ended byte-identical to `upstream/main`.
  - **The two traps that fired, both found by the gates and not by a conflict marker:**
    1. **A new provider in a fork enumeration.** Upstream added `opencode2` to the shared
       `AgentHookSource` union, and `descendant-events.ts` enumerates every provider in a `Record`
       over that union _by design_, so `pnpm tc` failed instead of silently ignoring children.
       Answered `null`, matching `opencode` (`9908062478`).
    2. **Upstream built the same feature.** `35005fb65c` ("keep panes working while async subagents
       run", #21882) reimplements what the fork's `42227039d5..0b0f8ac40d` series does. Both bound
       `pi.events`, so `subagent:async-started`/`:async-complete` fired twice, and omp/prime-agent
       got a binding the fork deliberately withholds. Converged on the fork's subsystem because
       upstream's 39 lines are a narrow subset of it; channel coverage differs in both directions,
       so upstream's OMP-only `task:subagent:lifecycle` gate stays and only the fork's two channels
       were dropped from it. Upstream's alias test was adapted to assert the fork's `subagent_runs`
       roster rather than a withheld `agent_end` (`c7e93e5b2d`).
  - **Left open, named:** converging on the fork's subsystem gives up the async-alias coverage
    upstream's #21882 adds for OMP runtimes. After this sync an OMP pane bound to
    `@earendil-works/pi-subagents` is held only by upstream's `task:subagent:lifecycle` gate; the
    only local evidence that channel has a producer is upstream's own test (OMP is not installed on
    this machine, and both pi-subagents plugin trees emit `subagents:*` and `subagent:async-*`,
    never `task:`). So OMP panes behave as they did in np.9 — not a regression, but the new OMP
    coverage is not gained either. Closing it, if wanted, is one guarded binding for `kind !== 'pi'`
    in `agent-status-handler-source.ts` plus the matching expectation in
    `agent-status-async-subagent.test.ts`. An independent review of this sync also noted that
    `lifecycleState.onEvent`'s `forcedStatus` parameter is now vestigial (nothing passes it) and that
    a plugin emitting both lineages for one child would double-dispatch; neither is reachable with
    the installed plugins.
  - Verified: `pnpm tc` clean; **8,130 tests green across 897 files** covering every touched area
    (rate-limits, pi, agent-hook-listener and its descendants, agent-hooks, settings/accounts,
    sidebar branch groups, ai-vault, diagnostics, updater); `range-diff` with all 84 patches paired
    and the pre-sync-tip lost-content diff empty; the localization catalog regenerated with no diff
    and both verifiers green; the fork's builder config loads and all six update-feed URLs still name
    `nplez1/orca`. The full `pnpm test` run's residual failures were all environmental and each was
    proved so, never chased as regressions: they need `ORCA_BACKGROUND_LAUNCH=1`, `mobile`'s
    generated engine artifacts, a Playwright browser for the newly-installed revision, the
    uninstalled `cloud/` workspace (`pg`), or a cleared `tests/e2e/.cross-version-checkouts` cache
    (1.3 GB of leftovers whose file count overflows a spread in that walker).
  - **Pre-existing, not from this sync:** `pnpm run check:code-quality:changed` reports 52 findings
    (24 design-system) since the old base, on the same footing as last sync — after a rebase the
    gate's base (`origin/HEAD`) still names the pre-sync tip, so its merge-base falls back and the
    whole fork+upstream delta reads as added lines. Nine of the fourteen flagged files are
    byte-identical to the released tip and four carry upstream's own incoming `as` assertions. The
    one finding that _was_ ours — a type assertion in the adapted pi test — is fixed.

- **2026-09-19** — onto upstream `3ad6b7e46e` (96 commits), from the released tip `72034293d5`
  (np.9-to-be). 75 commits replayed: **65 byte-identical by `range-diff`, 10 adapted, none
  dropped.** Eight of the 75 conflicted, across 10 files, in three classes:
  - **Mechanical/orthogonal** (6 files): upstream had rewritten the file or the surrounding region
    and our delta re-applied onto upstream's version. `agent-status-event-applicator.ts` (an import
    plus the routing-readiness guard), `wsl-orca-env.test.ts` (one value, `orca.exe` →
    `orca-np.exe`), and the three pi descendant sources, which landed on upstream's
    `pi.on` → `onStatus` rewrite and its post-queue `metadata`/`cancelPostRetry` refactor; the test
    harness's process-bus surface became the `pi.events` surface our commit binds, and gained
    upstream's `registerCommand`/`setModel` alongside it. `06df7b1aef` and `a64e28aa72` differ only
    as that context moved.
  - **Additive union** (1 file): `en.json`. Upstream appends `TerminalRenderingSection` (inline
    images) and we append `AgentSessionSearchSection` + `agent-session-search-search` to the same
    `auto.components.settings` object, so both blocks were kept; the derived
    `en-runtime-required.json` regenerated with **no diff**. Checked as a set property: every key
    in upstream's catalogue and in the pre-sync tip is present in the result (0 missing).
  - **Rename inside a rewrite** (1 file): `use-ai-vault-search.ts`. Upstream replaced the hook's
    `paths` parameter with `within` and split `localConsent` into `hasQuery`/`needsLocalConsent`;
    our consent rename (`policy.enabled` → `policy.contentEnabled`) re-applied inside that.
  - **Convergence, asked and answered — the fork's metadata tier wins.** Upstream's new scope tests
    assert that consent off means no index (`unavailable/disabled`). This fork always indexes the
    metadata tier, so `disabled` has no producer left in the tree at all. The fork's always-on tier
    was kept: the two compatible tests took the rename, and
    `reports being switched off before blaming a scope it does not know` became _blames an unknown
    scope rather than consent with content search off_, which is the same rule the previous sync
    recorded for `e696169ecf`.
  - **Cache-format collision, caught only after the sync had landed.** Upstream's Devin parse and
    sidecar change invalidated rows cached under the old parser and bumped
    `session-parse-cache-persistence.ts` 2 → 3 for them; this fork had _already shipped_ 3, for the
    Copilot cwd move. Same number, two meanings, so a fork install upgrading from the last release
    crossed no version boundary and would have replayed its pre-fix Devin rows — whose mtime and
    size still match, so nothing else re-parses them. Since schema 2 the `appVersion` equality gate
    is gone, which makes the number the only compatibility signal left, and upstream's own test for
    its bump writes the _previous_ version, so it cannot see this collision. Fixed in the commit
    that follows this one (4); the lesson is in UPSTREAM-SYNC-RUNBOOK.md § Traps.
  - **Trap: a clean merge is not a correct merge — hit for real.** Upstream's new
    `agent-status-extension-omp-model.test.ts` asserts exact pi payloads, and the descendant roster
    deliberately rides _every_ post (the transport keeps only the newest), so those payloads now
    carry `subagent_runs: []`. Nothing conflicted; the touched-area tests found it. The expectation
    was updated in the commit that put the field on every post, so the tree is green at every
    commit.
  - **Trap that did _not_ apply:** all six merge commits in the replay range are clean automatic
    merges — `git log --remerge-diff` is empty for each, against 590 lines for the previously
    hand-resolved `b1daf0ca58` — so linearising them lost no hand-resolution content this time.
  - Verified: `pnpm tc` clean; 2,543 tests green across 260 files covering every touched area
    (ai-vault-search, ai-vault, pi, agent-hook-listener/descendant, ipc-events, right-sidebar,
    runtime session-search settings, wsl env); `range-diff` with all 75 patches paired and the
    pre-sync-tip lost-content diff empty; the three localization verifiers green; the fork's
    builder config loads and its update-feed URLs are intact.
  - **Pre-existing, not from this sync:** `pnpm run check:code-quality:changed` reports 37 findings
    (28 of them design-system) on lines the fork added before this sync. Every flagged file but one
    is byte-identical to the released tip, and the exception's finding is on a line this sync did
    not touch. They surface now only because after a rebase the gate's base (`origin/HEAD`, the
    fork's default branch) still names the pre-sync tip, so its merge-base falls back to the old
    base and the whole fork+upstream delta reads as added lines. Worth its own pass; not a
    regression to chase here.

- **2026-09-18** — onto upstream `0b57ce0295` (215 commits), from the released tip `ef784bf681`
  (np.8). 60 commits replayed. Three of them needed resolution beyond the mechanical, and the
  conflicts fell into three classes worth naming:
  - **Trivial additive** (9 files): both sides appended to one list — the credentials creators in
    `web-preload-api.ts`, a `DetectedWorktreeListSource` member (`'cache'` vs `'session-fallback'`),
    six per-pane enumerations in `listener-state.ts`, the pi test harness's `killMock`.
  - **Rename replays** (2 files): `codexRoster*` → `agentDescendant*` re-applied onto
    `codex-events.ts` and `codex-subagent-transcript.ts`.
  - **Convergence** (2 decisions): `ae84a327e7`'s grok `stop_cancelled` fix was **dropped** —
    upstream reimplemented it in `normalizeGrokEvent` (104 → 229 lines) with turn identity, session
    boundaries and subagent gating, a strict superset. And `4adcf411a8`'s all-computers search engine
    was **dropped in favour of upstream's** (#20582/#20753/#20754/#20870/#20886/#20887/#20986): the
    fork's `ai-vault-search-merged-order.ts`, `ai-vault-search-status-aggregation.ts`,
    `session-search-rank-fusion.ts`, `ai-vault-search-host-fanout.ts` and their tests are gone, while
    the metadata FTS tier, the indexed list, the service `query`/`refresh` protocol and the Copilot
    source — which upstream has no equivalent of — stay. Re-porting reciprocal-rank fusion and the
    fork's per-host status vocabulary onto upstream's engine is left open, not lost.
  - **Trap, hit for real:** a plain rebase drops merge commits, and this fork's one hand-resolved
    merge (`b1daf0ca58`) held six resolutions that existed nowhere else — the grok/copilot union,
    `workingMode: 'monitoring'`, the pi `pi.events` binding, the legacy-adapter test helpers, the
    `StopCancelled` de-duplication. All of it had to be restored by hand. The pre-sync-tip diff in
    UPSTREAM-SYNC-RUNBOOK.md Step 3 found it; nothing else would have.
  - Verified: `pnpm tc` clean, `range-diff` clean across the series, the pre-sync-tip diff empty, and
    620 tests green across ai-vault/session-search plus the agent-hook-listener, grok and pi suites.
  - Left open: `SessionHistorySettingsPane` (upstream) and `AgentSessionSearchSection` (ours) are
    both mounted and now both write `contentEnabled`; consolidating them is a UX task.
- **2026-09-16** — onto upstream `291b4ddd6f` (131 commits). Three of the 29 local commits needed
  resolution: two i18n locale files (took upstream's side; the derived catalog was then regenerated,
  which removed exactly the stale fixture keys the local side carried) and
  `src/shared/agent-hook-listener/listener-state.ts`, where upstream wrapped the state factory in a
  legacy-adapter layer — kept that scaffolding _and_ the `CopilotBackgroundWorkState` type. Verified:
  26 of 29 patches byte-identical by `range-diff`, all three typecheck projects clean, 161 test files
  green. Also removed an unused import in an upstream `native-chat` test that upstream's CI does not
  gate on but this repo's typecheck does.
