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
  `Math.max(newerCandidateCount, MAX_MANIFEST_PROBE_CANDIDATES)` entries. Keeping six as a _floor_ is
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

### `local(agents)`: one binding per pi subagent channel

Upstream's `#21882` tracks pi's async children _inside_ the generated extension source — its own
roster withholds the lead's `agent_end` while a child is live. This fork does the same job one layer
down: `agent-status-async-subagent-source.ts` binds **both** plugin lineages (`subagents:*` from the
tintinweb fork, `subagent:async-*` from `@earendil-works/pi-subagents`), posts the full live set as
`subagent_runs` on every post, and the pane is held `working` receiver-side from that roster. That
binding spans `subagent:process-terminal` too, so a child whose only end signal is its runner exit
leaves the live set there — the quiet-reap window is the recovery for a loss nothing reports, not
the normal path. With both lineages in place every child lifecycle event fired twice, and the fork's
deliberate silence on those channels for omp/prime-agent was filled by upstream's unconditional
binding.

So the two `subagent:async-*` bindings are dropped from upstream's roster setup; upstream's
OMP-only `task:subagent:lifecycle` binding stays. Channel coverage differs in both directions (see
the 2026-09-21 sync entry), which is why this converges on the fork's subsystem rather than
upstream's.

Anchors:

- `src/main/pi/agent-status-subagent-roster-source.ts` — `getPiSubagentRosterSetupSourceLines()`, the
  two bindings removed, marked with a `LOCAL(nplez1)` comment. Upstream `#21882` later moved these
  lines out of `agent-status-handler-source.ts`; the 2026-09-25 sync re-seated the patch into the new
  module.
- `src/main/pi/agent-status-async-subagent-source.ts` — `getPiAgentStatusAsyncSubagentSourceLines()`,
  the fork's own bus: both lineages' start/end channels and the single retire-and-repost path they
  share, including `subagent:process-terminal`.
- Tests pinned to the fork's contract: `src/main/pi/agent-status-async-subagent.test.ts` drives the
  real generated source into the real listener; `agent-status-extension-async-subagents.test.ts`
  asserts the `subagent_runs` roster rather than upstream's withheld `agent_end` (the deferral cases
  there were re-seated onto this contract by that same sync); `agent-status-extension-omp-lifecycle.test.ts`
  carries the equivalent adaptation from 2026-09-21.

Still not gained from upstream, and unchanged since 2026-09-21: an OMP pane bound to
`@earendil-works/pi-subagents` is held only by upstream's `task:subagent:lifecycle` gate, whose only
local evidence of a producer is upstream's own test. Closing it means one guarded binding for
`kind !== 'pi'` plus the matching expectation.

### `local(agents)`: the descendant lane is pi's, plus one grok child question

After the 2026-09-25 sync, upstream's `providers/grok-events.ts` is the single owner of grok's child
lifecycle: it refuses to settle the parent from a child event and reads a background subagent as
`working`. The fork's generic descendant lane therefore serves **pi**, whose live child set
`agent-status-async-subagent-source.ts` posts as `subagent_runs` on every post, and the lane's
working-state gating for grok — a second copy of what the owning lane already does — is gone.

The one surface that cannot be given up is the _wait_. Grok auto-allows `ask_user_question`, so a
child blocked on a human answer announces it as a `PreToolUse` carrying `subagentType` — which is
exactly the payload shape upstream drops, so the row would settle `done` over a question nobody has
answered. The lane keeps one narrow grok reader for that event and nothing else, and the dispatch
gates an owning provider's row only while its own roster holds a waiting child: the sole state the
owning lane cannot answer for, rather than a parallel implementation of the states it can.

Anchors:

- `src/shared/agent-hook-listener/descendant-events.ts` — `readGrokChildQuestion` (requires
  `subagentType`, so the LEAD's own question still goes through the normalizer that carries
  `toolName` and `interactivePrompt`), `DESCENDANT_PROVIDERS.grok`, and
  `providerOwnsDescendantLifecycle` claiming grok.
- `src/shared/agent-hook-listener/descendant-pane-state.ts` — `paneHasWaitingDescendant`.
- `src/shared/agent-hook-listener/provider-dispatch.ts` — the read runs for every provider that has
  a reader (a `null` adapter answers nothing), and the row is gated when the provider does not own a
  roster **or** our roster holds a waiting child.
- Tests: `agent-hook-listener-descendant-lifecycle.test.ts`'s "a grok child blocked on a human
  answer" case (the wait surfaces, survives the lead's own turn ending underneath it, and every
  other grok child event is left alone); `agent-hook-listener-grok.test.ts` pins the lead's own
  question path.

Bounded by the lane's quiet window, not by a scope reset: an owning provider's roster has no reset
for this lane to read, so a question nothing ever retracts cannot hold the row forever.

### `local(agents)`: monitoring is reserved for Claude session-cron callbacks

Upstream's lead-status fold reads _any_ live non-agent child work as `workingMode: 'monitoring'`,
which includes an ordinary background shell. This fork's `#26` reserves the monitoring badge for
Claude session-cron callbacks, because a shell the agent started as part of its turn is still agent
work. The fork owner chose (2026-09-25) to keep this policy and express it on upstream's fold rather
than revert to upstream's semantics.

Anchors, all on upstream-owned files and marked `LOCAL(nplez1)`:

- `src/shared/agent-hook-listener/providers/claude-roster-state.ts` — `resolveClaudePaneStatus`: the
  fold's `hasLiveAgentWork` is "the roster has a working child **or** a background shell is running",
  and `hasLiveNonAgentWork` is the session-cron set alone.
- `src/shared/agent-hook-listener/providers/grok-events.ts` — the payload drops
  `resolution.workingMode`, so a grok background shell reads plain `working`. Grok has no cron concept,
  so it never earns the badge.
- Tests that encode the policy (all would need re-adapting if it is ever dropped):
  `src/shared/claude-background-task-status.test.ts`, `src/shared/main-agent-status-parity.test.ts`
  (the Claude and Grok lane helpers plus the six shell/watcher stories),
  `src/main/agent-hooks/server-grok-background-status.test.ts`, `server-grok-cancel.test.ts`,
  `server-claude-cancel-captures.test.ts` and `server-relayed-claude-cancel.test.ts`. The
  structured/native-chat lane is deliberately untouched: it still reads a watch loop as monitoring.

Weigh this before keeping it: `isAgentTimeAccruing` is `state === 'working' && workingMode !== 'monitoring'`,
so a shell-held row now **accrues agent time** where it previously did not. That is a session-stats
change beyond the status-bar badge — inherent in calling a shell agent work rather than side effect
of the fold. If the stats change is unwanted, the alternative is to keep upstream's evidence split
and strip only the `workingMode` from the published payloads.

## Syncing with upstream

**The full procedure is [UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md)** — "rebase upstream
main" means that document, start to finish. What matters specifically for the patches below:

```bash
git fetch origin
git rebase origin/main
```

The local commits replay on top. Because each patch is a one-line constant edit, a conflict here
means upstream moved that exact line — re-apply by hand and amend that commit rather than resolving
mechanically. A conflict in a fork file that upstream does not have is _not_ an upstream change at
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

- **2026-09-25 — released as `v1.4.197-np.12`** from `c80bbf6aba` (workflow run 36121027339,
  signed and notarized). One commit landed on the remote's `nplez1/main` while the sync was running —
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
