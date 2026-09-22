# Local patches on `nplez1/main`

This branch is upstream `main` plus a small, deliberate set of changes that exist **only here**.
They are never proposed upstream, and they must never reach a PR branch.

## Rules

- Local commits use a `local(<area>):` prefix so they stand out in `git log`.
- A local patch may only touch files that **no PR branch owns**. PR branches are cut from
  `origin/main`, never from this branch, so nothing here can leak into a PR — but if a local patch
  touched a file a PR also changes, the fork and the PR would silently disagree about that file.
- Every patch is listed below with its reason and its exact anchors, because upstream edits to those
  lines are the only thing that breaks them.

## Patches

### `local(updater)`: point the update feed at this fork

Upstream hardcodes `stablyai/orca` as the update feed in several places. Left alone, a build of this
fork offers to replace itself with an official release — and because local builds carry a
`-local.<ts>.<sha>` pre-release version, semver comparison treats an official release as newer.

Anchors to re-point (`stablyai/orca` → `nplez1/orca`):

- `src/main/updater-prerelease-feed.ts` — `ATOM_FEED_URL`, `RELEASES_DOWNLOAD_BASE`, `TAG_HREF_RE`,
  and the Windows absolute-asset regex.
- `src/main/updater/updater-setup.ts` — the `latest/download` fallback.
- `src/main/updater/updater-release-feed.ts` — the `latest/download` fallback.
- `src/shared/release-channel.ts` — `MAIN_RELEASE_REPO`.

`HOURLY_/DAILY_/ADHOC_RELEASE_REPO` still _name_ upstream's channel repos, but nothing resolves
through them any more: this fork publishes one stream, so every channel maps to `MAIN_RELEASE_REPO`
and the picker offers only stable and rc (`OFFERED_RELEASE_CHANNELS`).

Why both halves: hiding the channels is a UI courtesy, but a channel persisted by an older build
still reaches `getReleaseRepoForChannel`, and resolving that to upstream's repo would update an Orca
NP install into an official Orca. The mapping is the part that has to be right; the hiding is what
stops anyone choosing it in the first place. `hasDedicatedReleaseRepo` still reports the dev
channels as such, because it feeds the updater's _reporting_ path — a legacy value that resolves to
this fork is cosmetically described as a dev build, which is harmless and unreachable from the UI.

Tests that pin the re-pointed URLs and the single-stream mapping: `src/main/updater-release-builds.test.ts`,
`src/main/updater.check-preflight.test.ts`, and `src/main/updater.prerelease-fallback.test.ts`. They
assert this fork's repo path, so a sync that restores upstream's expectations turns them red again.

### `local(updater)`: probe every newer release, not a fixed window

Upstream's resolver probes only the six newest candidates at or above the installed version
(`MAX_MANIFEST_PROBE_CANDIDATES`), which is sound upstream because every entry in upstream's atom feed
is one of its own releases and therefore has a manifest. It is not sound here: `nplez1/orca`'s feed
also carries the parent repo's release entries (`v1.4.196`–`v1.4.202` at fork time, plus a `pr-…` and a
`mobile-android-…` tag), and those tags have no manifest in this repo — `releases/download/v1.4.202/latest-mac.yml`
404s. All seven of them sort above `1.4.197-np.N`, so an installed fork build filled the whole window
with manifest-less entries and never reached this repo's own tag.

The state that produces is not "no update" — it is `not-ready` with no `lastGoodTag`, which
`pinDefaultReleaseFeed` turns into a `ReleaseFeedPreflightError`, so the check is re-armed on the
silent 1h→6h retry cadence and no `available` status is ever sent. Automatic and menu checks both
fail; the menu one shows "Couldn't reach the update server", which is a misleading cause. Net effect:
nobody running a build published here ever sees an in-app update offer.

Anchors:

- `src/main/updater-prerelease-feed.ts` — `probeCandidates`, widened from a fixed six-wide
  `slice(newestNewerIndex, newestNewerIndex + MAX_MANIFEST_PROBE_CANDIDATES)` to
  `Math.max(newerCandidateCount, MAX_MANIFEST_PROBE_CANDIDATES)` entries. Keeping six as a *floor* is
  deliberate: the tag after the primary is the fallback feed a missing manifest walks back to, and
  widening only when more newer candidates exist leaves upstream-shaped feeds byte-identical.
- `src/main/updater-prerelease-feed.test.ts` — `probes every newer candidate concurrently`.
- `src/main/updater-prerelease-feed-readiness.test.ts` — the fork-feed regression case.
- `src/main/updater.publishing-window-feed.test.ts` — the last-good pin reaching `available`.

Still fork-only, and still incomplete: the resolver only ever sees the tags in a feed that GitHub caps
at ten entries, so the manifest-less entries ahead of this repo's tag recede by one per release. A
release published while it sits seventh is skipped by every build already installed; the next one
lands inside the window. Upstream never needs any of this, so it is not proposed there.

### `local(build)`: do not bake an updater `publisherName` into Windows builds

This fork ships unsigned. `electron-updater` Authenticode-verifies every installer it downloads
against the `publisherName` recorded in the installed app's `app-update.yml`, and an installer whose
publisher does not match is rejected — including its own channel's next build. Upstream sets
`SignPath Foundation` for non-dev channels. Here it is dropped and `verifyUpdateCodeSignature` is
disabled, which is the same thing upstream's dev channels do for the same reason.

Anchor: `config/electron-builder.config.cjs`, `win.signtoolOptions`.

### `local(dev)`: rebuild-and-relaunch helper

`package.json`'s `rebuild:mac:relaunch-installed` script plus
`config/scripts/rebuild-and-relaunch-installed-macos-arm64.sh`: build locally and install over the
running app. Convenience only — not for upstream.

## Syncing with upstream

**The full procedure is [UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md)** — "rebase upstream
main" means that document, start to finish. What matters specifically for the patches below:

```bash
git fetch origin
git rebase origin/main
```

The local commits replay on top. Because each patch is a one-line constant edit, a conflict here
means upstream moved that exact line — re-apply by hand and amend that commit rather than resolving
mechanically. A conflict in a fork file that upstream does not have is *not* an upstream change at
all: check all three merge stages (`git show :1:$f :2:$f :3:$f`) before assuming either side.

After a sync, confirm the fork still behaves:

```bash
pnpm typecheck
node -e "require('./config/electron-builder.config.cjs')"   # config still loads
```

Then check the update path still points at this fork:

```bash
grep -rn "nplez1/orca" src/main/updater-prerelease-feed.ts src/main/updater/updater-*.ts src/shared/release-channel.ts
```

And that nothing of ours was dropped by the replay — every file that differs from the pre-sync tip
while upstream never touched it is a file the rebase changed behind our back:

```bash
git diff --diff-filter=M --name-only backup/nplez1-main-pre-sync HEAD | sort > /tmp/modified.txt
git diff --name-only <old-base> upstream/main | sort > /tmp/upstream-changed.txt
comm -23 /tmp/modified.txt /tmp/upstream-changed.txt   # expect empty
```

Confirm the series came through unchanged — `range-diff` prints `=` per patch that is byte-identical:

```bash
git range-diff --no-patch <old-base>..<old-tip> <new-base>..nplez1/main
```

After resolving any conflict in `src/renderer/src/i18n/en-runtime-required.json`, regenerate it rather
than merging by hand — it is derived:

```bash
pnpm run sync:localization-runtime-catalog
```

### Sync log

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
    Converged on upstream's model: `totalCount` and `ignoredFiles` moved *into* the request-keyed
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
    than unioned: the status field now lands in the *new* builder module; `visible-worktrees.ts`
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
    added the `pi.events` surface our *later* commit converges onto. Kept upstream's implementation
    and applied only our removals, so the file ended byte-identical to `upstream/main`.
  - **The two traps that fired, both found by the gates and not by a conflict marker:**
    1. **A new provider in a fork enumeration.** Upstream added `opencode2` to the shared
       `AgentHookSource` union, and `descendant-events.ts` enumerates every provider in a `Record`
       over that union *by design*, so `pnpm tc` failed instead of silently ignoring children.
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
    one finding that *was* ours — a type assertion in the adapted pi test — is fixed.

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
    `reports being switched off before blaming a scope it does not know` became *blames an unknown
    scope rather than consent with content search off*, which is the same rule the previous sync
    recorded for `e696169ecf`.
  - **Cache-format collision, caught only after the sync had landed.** Upstream's Devin parse and
    sidecar change invalidated rows cached under the old parser and bumped
    `session-parse-cache-persistence.ts` 2 → 3 for them; this fork had *already shipped* 3, for the
    Copilot cwd move. Same number, two meanings, so a fork install upgrading from the last release
    crossed no version boundary and would have replayed its pre-fix Devin rows — whose mtime and
    size still match, so nothing else re-parses them. Since schema 2 the `appVersion` equality gate
    is gone, which makes the number the only compatibility signal left, and upstream's own test for
    its bump writes the *previous* version, so it cannot see this collision. Fixed in the commit
    that follows this one (4); the lesson is in UPSTREAM-SYNC-RUNBOOK.md § Traps.
  - **Trap: a clean merge is not a correct merge — hit for real.** Upstream's new
    `agent-status-extension-omp-model.test.ts` asserts exact pi payloads, and the descendant roster
    deliberately rides *every* post (the transport keeps only the newest), so those payloads now
    carry `subagent_runs: []`. Nothing conflicted; the touched-area tests found it. The expectation
    was updated in the commit that put the field on every post, so the tree is green at every
    commit.
  - **Trap that did *not* apply:** all six merge commits in the replay range are clean automatic
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

### `local(ci)`: release workflow

`.github/workflows/fork-release.yml` builds macOS and Windows artifacts and publishes them as a
release on this fork — which is the feed the patched updater points at. It exists because every
upstream release workflow is a no-op in a fork (they guard on
`github.repository == 'stablyai/orca'`) and publishes to stablyai's separate channel repos. It is
`workflow_dispatch` only, so it never runs on its own.

It builds on GitHub-hosted runners (`macos-15`, `windows-2022`) rather than upstream's Blacksmith
labels, which belong to stablyai's account. Signing is conditional on `MAC_CERTS` being set, so the
pipeline is usable before a certificate exists and switches to the signed, notarized path by itself
once it does. The release body comes from `.github/fork-release-notes.md`, rendered per release with
the version, commit, date, and a signing paragraph that follows the signing mode.

Why the unsigned path explicitly `unset`s the `CSC_*`/`APPLE_*` variables instead of leaving them
empty: an unset secret still _defines_ them as empty strings, electron-builder reads a defined
`CSC_LINK` as a certificate path, and `resolveCscLinkPath('', cwd)` resolves to the repository root —
so packaging dies with `<repo> not a file`. An empty secret and an absent one are not the same thing.

Fork-only helper scripts live in `local/`:

- `local/branch-status.mjs` — live status of every branch (SHAs, fork presence, own delta, PR).

### `local(hooks)`: refuse fork-only commits on a PR branch

`.husky/commit-msg` refuses any commit whose subject starts with `local(` unless the current branch is
`nplez1/main`. PR branches are cut from `origin/main`, so a fork-only file committed to one would be
reviewed upstream — which is precisely what happened twice before this guard existed. It is
`commit-msg` rather than `pre-commit` because the message is what identifies the commit as fork-only,
and `pre-commit` cannot see it.

If a commit is wrongly refused, the fix is to switch branches, not to bypass the hook.

### `local(vm)`: an ephemeral machine per worktree

`environmentRecipes` in `orca.yaml` plus `local/orca-vm/{create,destroy,suspend,resume}.sh`: allocate a
machine from the team provisioning system when a worktree is created, and release it when that
worktree is deleted.

Inert until wired — each script names the provider verbs it needs at the top; until then it fails
loudly rather than silently allocating nothing. **Nothing in this flow is provider-specific in
Orca:** the recipe scripts run on the laptop, from the repo root, and Orca only consumes the one JSON
object they print on stdout. Confirm with:

```bash
orca vm recipe doctor team-machine --provision --json   # passes only with no fail and no warn
```

The contract details worth not rediscovering:

- stdout must be **exactly one JSON object**. The result is parsed with a strict schema that rejects
  unknown keys, so a stray progress line lands as "Recipe stdout must be one JSON object."
- Orca imposes **no timeout** on `create`. The script's own bounded SSH wait is what stops a bad
  allocation from hanging the worktree, and it releases the machine before failing.
- `relayGracePeriodSeconds` lives inside `target`; 0 means "keep terminals alive until reset", which
  is wrong for a disposable host, so this uses one hour.
- `create` gets an empty stdin; `suspend`/`resume`/`destroy` get a payload with `recipeResult` on
  stdin, which is where the `userData.resourceId` handle comes back.
- Agent credentials are **not** pushed to the guest. The image must already have the agent CLIs
  installed and logged in, or every machine needs a manual login.

#### Baking an image (what actually makes a fresh machine fast)

Bake the **shared native-deps cache**, not the relay bundle. A relay install dir is keyed on the JS
bundle hash, so it moves on every commit to `src/relay/`; the compiled dependencies are deliberately
keyed on something stabler — `~/.orca-remote/native/<relayPlatform>-<depsHash>/node_modules`, keyed on
the pinned dep versions plus patch bytes, symlinked into every relay dir, immutable once
`.deps-complete` is written last after a probe on that host loaded both addons.

That is the artifact worth baking, and it survives Orca updates. `node-pty@1.1.0` ships no Linux
prebuild, so without it a fresh guest pays a `node-gyp` source build on first connect — the dominant
first-connect cost (#1693, #18009). Windows is excluded from the shared cache by design (win32
prebuilts exist and the console-list patch mutates in place).

Produce it by connecting once from Orca to a golden machine and snapshotting: the `.deps-complete`
marker is only written after a probe on that host, so a `node_modules` copied from elsewhere cannot
be passed off as complete. Never snapshot an entry without the marker — linking is gated on it, and
the cache GC reclaims markerless entries.

Two layers, so a rebake is rare:

1. **Base** (rebake only when the native dep versions or patch bytes move): node 18+, npm, git, the
   Linux C/C++ toolchain, a warm npm cache, a repo mirror, and a complete
   `~/.orca-remote/native/<key>/`.
2. **Agent auth** (rebake when credentials rotate): the agent CLIs and their logins — the one step
   that cannot be automated.

Gate a candidate image with `local/orca-vm/verify-guest-image.sh`, run on the guest: it exits
non-zero until node/npm/git, the toolchain, a _complete_ baked native-deps entry with both addons,
and at least one agent CLI are present.

### `local(identity)`: ship as "Orca NP" beside an official Orca

This fork must coexist with an official Orca install on the same machine, so every name either
install owns is changed here. Nothing in this section is a PR candidate.

| Piece                            | Value                             |
| -------------------------------- | --------------------------------- |
| appId / `BASE_APP_USER_MODEL_ID` | `com.nplez1.orca`                 |
| product name                     | `Orca NP`                         |
| installed CLI command            | `orca-np` (Windows `orca-np.cmd`) |
| dev CLI                          | `orca-np-dev`                     |
| packaged userData                | `appData/orca-np`                 |
| home directory                   | `~/.orca-np`                      |
| URL scheme                       | **unchanged**: `orca://`          |

Why the scheme stays: `orca://pair` is what the official mobile app and official clients consume,
and `orca://skills/share/...` is how share links open this app. A fork-only scheme would make its own
pairing links unopenable by everything else. Sharing it costs one ambiguity — on a machine with both
installs, macOS routes `orca://` to only one of them.

Why `~/.orca-np` rather than sharing: it holds keybindings, provider credentials and the agent-hook
scripts, so sharing would let either install overwrite the other's hooks.

Three couplings this rename depends on. Each fails silently, so change them together:

1. **The macOS launcher shim hardcodes the in-bundle executable path**
   (`resources/darwin/bin/orca` → `Contents/MacOS/Orca NP`). The executable is named after
   `productName`, so changing one without the other installs a CLI that fails on every invocation.
2. **The Windows launcher ships as `resources/bin/orca-np.exe` + `orca-np.cmd`**, with
   `getBundledLauncherPath` and the `extraResources` mapping following. Windows resolves the CLI to
   the packaged launcher rather than to a PATH directory, so all three move as a unit.
3. **The SSH relay shim is a different identity.** A remote execution host runs the relay's own shim,
   deployed under a fixed name (plain `orca` / `orca.cmd`) that must NOT follow the local rename —
   see `getRelayCliCommandNameForPlatform` and `launchCmdByRemotePlatform`. Conflating the two makes
   every remote launch invoke a command the remote PATH never had. This is the coupling that hides:
   upstream's local and remote names coincided, so a test asserting the wrong one still looks
   plausible.

Deliberately NOT renamed: the Linux deb/rpm names and `executableName: 'orca-ide'` (this fork builds
only macOS and Windows, and renaming puts a space in the `/opt` install path that `after-install.sh`
resolves unquoted); the bundled launcher FILE names; and the per-repo `.orca/` directory convention,
which is a repo directory rather than the home directory.

Consequences to expect on first run of a renamed build: it cannot read an official install's data,
Keychain items or E2EE pairing files, and macOS re-prompts for TCC once per permission because
grants anchor on bundle id + team id. The official install keeps working — its `~/.orca`, its CLI
shim and its `orca://` handling are untouched.

#### The in-app display name comes from one constant

The rename above changed the names an _install_ owns, but the running app still called itself "Orca"
in its own chrome: the title bar, window title, tray tooltip, notification titles, status bar and
onboarding header each carried a private `'Orca'` literal, so a renamed build looked like an official
one in exactly the places a user looks to tell them apart.

`src/shared/app-display-name.ts` is now the single source:

- `APP_DISPLAY_NAME` = `Orca NP` — the packaged name and the base of every dev label.
- `APP_DEV_DISPLAY_NAME` = `Orca NP Dev` — drives `app.setName`, so it must stay constant across
  branches or each worktree mints a new macOS safeStorage Keychain item.

TS readers: `src/main/startup/dev-instance-identity.ts`, plus the display slots in `system-tray.ts`,
`createMainWindow.ts`, `main-window-close-lifecycle.ts`, `dashboard-popout-window.ts`,
`push-dispatcher.ts` and the three notification builders under `src/main/ipc/`; in the renderer,
`TitlebarLeftControls.tsx`, `resource-usage-metrics.tsx`, `OnboardingFlow.tsx`,
`CrashReportDialogSurface.tsx`, `HomeSlide.tsx`, `AutomationEditorDialogHeader.tsx`,
`AutomationRunDetailsPage.tsx`, `web-app-api.ts` and `web-runtime-environment.ts`.

Two readers cannot import TypeScript and therefore keep a literal: `productName` in
`config/electron-builder.config.cjs` and `DEV_BUNDLE_DISPLAY_NAME` in
`config/scripts/dev-electron-bundle-identity.mjs`. Each is pinned to the constant by a test
(`electron-builder-config.test.mjs`, `dev-electron-bundle-identity.test.ts`), so a rename that misses
one fails there instead of shipping a build whose window disagrees with its own bundle name.

Deliberately unchanged, and why each is not a copy to collapse:

- **Translated copy.** The i18n keys whose whole value was the bare brand name
  (`auto.App.5096cbbc86` and its siblings) are no longer referenced — the brand is not translatable,
  and the repo's brand policy already reverts machine-translated brand names to Latin. Those keys stay
  in `en.json` and the five locale catalogs as orphans, which `verify:localization-extraction`
  reports without failing on. Removing them would mean editing five upstream-owned locale files, the
  exact sync conflict this branch avoids. Prose that merely mentions the product ("Orca's graphics
  process has crashed") is left alone for the same reason.
- **Interop and setup identity.** `TERM_PROGRAM`, the Codex `clientInfo.title`, the JIRA user-agent,
  the SSH relay shim name and every path in `app-directory-names.ts` are what other tools and existing
  installs match on; renaming them would break pairing, updates or an existing install's data.
- **Translated tray labels.** `tray.openOrca` / `tray.activityWaiting` are hand-authored i18n keys,
  so their English is a catalog value rather than an inline literal. The non-dev attention tooltip now
  reuses the existing `tray.activityWaitingSuffix` key, which drops one `'Orca'` literal without
  touching a catalog; the remaining "Open Orca" menu label is left to the translations.
