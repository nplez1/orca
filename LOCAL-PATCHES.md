# Local patches on `main`

**Naming, 2026-11-09:** the release line was renamed `nplez1/main` → `main`; the old `main` (an
upstream mirror) is retired, so `main` on both remotes is this fork's own line. Entries here have been
rewritten to the new name — where an older one reads oddly for the topology it was written in (a
`main` that mirrored upstream), its date is the explanation. `nplez1/main` survives only in the
known-red JSONs' evidence strings, which quote the refs their runs actually used.

This branch is upstream `main` plus a small, deliberate set of changes that exist **only here**.
They are never proposed upstream, and they must never reach an upstream-bound PR branch.

## Rules

- Local commits use a `local(<area>):` prefix so they stand out in `git log`.
- A local patch may only touch files that **no PR branch owns**. Fork PR branches are cut from
  `main` and upstream-bound ones from `upstream/main`, so a patch can only leak upstream through
  an upstream-bound branch's diff — but if a local patch touched a file a PR also changes, the fork
  and the PR would silently disagree about that file.
- Every patch is listed below with its reason and its exact anchors, because upstream edits to those
  lines are the only thing that breaks them.
- **No fork comment in a file upstream owns.** The reason goes here, in
  `local/sync/convergence-ledger.md`, in the commit message, or in a fork-owned module. Upstream's own
  comment audit (`7d6603aa17`, 16,196 files) accounts for 162 of the 233 pending conflicts, and 73% of
  this sync's hunks have an upstream side that changed only comments. A rationale paragraph above
  upstream's code is conflict adjacency and nothing else. The rule covers the fork's own added blocks
  too: a fork hook should name an exported function in a fork file, not explain itself in prose above
  upstream's code. **Enforced** by `node local/check-upstream-file-comments.mjs`
  (`check-upstream-file-comments` in `local/gate-lint.mjs`) against
  `local/upstream-file-comments-baseline.json`: per-file maxima for the files carrying the most, plus a
  frozen total, measured against the current upstream merge base so a sync moves the ruler with it.
  The total may only move down, and a shrink is a red until `--prune` locks it in, so slack cannot be
  spent elsewhere. Growth needs `--accept <reason>`, recorded in the baseline so it is a reviewed
  edit — including after a sync, which is why the re-baseline step is in `UPSTREAM-SYNC-RUNBOOK.md`
  § Step 3. A comment that has to stay above upstream's code carries `fork-comment-ok: <why>`. A file
  that needs one is worth re-reading as a fork-owned module instead.
  The tree does not satisfy this yet, and the size of the gap is the point: **20 files under `src/` carry
  a `LOCAL(nplez1)` comment and 19 of them are files upstream owns**, some running to five lines (the
  monitoring-policy note in `claude-pane-hold-evidence.ts`, which § `local(agents)` relies on). The marker
  sweep belongs to the architecture epic's comment-hunk ratchet, not to this file; until it lands, treat
  each existing marker as a hunk to resolve on every sync and do not add one without a reason here.
- **No deleting a file upstream still owns.** Restore it and neutralise at a seam instead — a deletion
  is re-applied on every sync, and each upstream edit to the deleted file arrives as a modify/delete
  conflict (19 of the 30 pending ones). A genuine supersession lives in
  `local/sync/expected-deletions.json` with its evidence, and nowhere else.

## Rationale moved out of upstream files

These decisions were comments in files upstream owns. They live here because a comment there is
conflict adjacency, and because each is a trap a well-meaning future edit can fall into.

- **The managed-hook install lock uses `.orca`, not `HOME_DIRECTORY_NAME`**
  (`src/main/agent-hooks/managed-hook-install-lock.ts`). It guards the shared `~/.claude` hooks, which
  an official Orca install manages too, so both must contend on one lock path. Pointing it at this
  fork's own home directory would give the two installs separate locks over one shared file.
- **Quick Open passes `--no-ignore-parent` for a folder project, and only there**
  (`src/shared/quick-open-filter.ts`, `src/main/ipc/filesystem/filesystem-list-files.ts`,
  `src/main/ipc/filesystem/filesystem-search-file-paths.ts`,
  `src/main/ipc/workspace-path-catalog-builder.ts`). A folder workspace inside a git checkout has no
  repository, so the enclosing checkout's `.gitignore`/`.ignore` classify its files as ignored and
  Quick Open hides them; `isFolderProjectRoot` decides it from the store, and a checkout with its own
  repo keeps the flag off so a repo nested in a superproject still honours the enclosing rules.
  The watcher's subtree rescans deliberately do not take the flag: their search root sits below the
  workspace, so ripgrep would then drop the workspace's _own_ root ignore files — which also leaves the
  index classifying a directory created later by the enclosing checkout's rules until the next full
  build, the behaviour this fork had before the fix.
- **The path-index worker is held by a `keepAlive` predicate instead of being torn down under a live
  index** (`src/main/worker-threads/worker-thread-request-queue.ts`,
  `src/main/worker-threads/lazy-worker-thread-host.ts`, wired from
  `src/main/workspace-path-index/workspace-path-index-runtime.ts`; #301). The worker is the only
  holder of every published catalog, so an idle teardown underneath the index drops it, and the next
  search rebuilds from the main thread. An idle expiry that finds the queue idle but the predicate
  true re-arms its timer rather than destroying the worker, because a hold can also clear with
  nothing dispatched — a failure reset, or a build that ends with no generation — and holding until a
  request arrives would leak the thread in exactly those cases. The predicate reads
  `hasResidentGeneration()`, not `hasIndex()`: the latter is also true for entries that are failed or
  still building and own no catalog. `keepAlive` is optional, so the other five queue users keep
  upstream's teardown.

## Patches

### `local(setup)`: the setting-up indicator reaches the local window

Anchor: `src/main/window/renderer-relays/client-event-notice-relay.ts`, the fork relays in
`src/main/window/runtime-window-lifecycle.ts`, and the `runtime:getSetupRunnerState` /
`runtime:worktreeSetupRunnerStateChanged` pair in `src/main/ipc/runtime.ts` and
`src/preload/api/runtime/runtime-bridge.ts`.

Upstream's `worktreeSetupRunnerState` client event reaches paired environments and mobile clients,
but a local window is not a runtime environment: the renderer's client-event bridge never subscribes
for it, and the window's own fan-out forwards only the two event types it has IPC for. Issue #87 is
that gap — the sidebar of the machine running a repo's setup script never showed "Setting up…",
whichever create flow started it. The relay is fork-owned so a sync keeps it; if upstream ports the
state to a local channel of its own, both can go.

### `local(updater)`: point the update feed at this fork

Upstream hardcodes `stablyai/orca` as the update feed in several places. Left alone, a build of this
fork offers to replace itself with an official release — and because local builds carry a
`-local.<ts>.<sha>` pre-release version, semver comparison treats an official release as newer.

Anchors to re-point (`stablyai/orca` → `nplez1/orca`):

- `src/main/updater-prerelease-feed.ts` — `ATOM_FEED_URL`, `RELEASES_API_URL`, `TAG_HREF_RE`.
- `src/main/updater-release-targets.ts` — `RELEASES_REPO` and the download base every manifest and
  asset URL is built from.
- `src/main/updater-release-readiness.ts` — the Windows absolute-asset regex, which decides when a
  HEAD request has to go through `net.request` to see GitHub's redirect.
- `src/main/updater/updater-setup.ts` — the `latest/download` fallback.
- `src/shared/release-channel.ts` — `MAIN_RELEASE_REPO`.

`src/main/updater/updater-release-feed.ts` is **not** on this list: it has no fork hunk. Its only
`latest/download` mention is an upstream comment (line 119) explaining why the concrete tag is pinned,
so a sync can take upstream's side there.

`HOURLY_/DAILY_/ADHOC_RELEASE_REPO` still _name_ upstream's channel repos, but nothing resolves
through them any more: this fork publishes one stream, so every channel maps to `MAIN_RELEASE_REPO`
and the picker offers only stable and rc (`OFFERED_RELEASE_CHANNELS`).

An unsupported channel stays visible-and-disabled rather than disappearing, so a user who heard
about it learns why it is unavailable instead of silently not finding it; with the dev channels
unlisted, that rendering only matters if one is offered again.

Why both halves: hiding the channels is a UI courtesy, but a channel persisted by an older build
still reaches `getReleaseRepoForChannel`, and resolving that to upstream's repo would update an Orca
NP install into an official Orca. The mapping is the part that has to be right; the hiding is what
stops anyone choosing it in the first place. `hasDedicatedReleaseRepo` still reports the dev
channels as such, because it feeds the updater's _reporting_ path — a legacy value that resolves to
this fork is cosmetically described as a dev build, which is harmless and unreachable from the UI.

Tests that pin the re-pointed URLs and the single-stream mapping:
`tests/tools/fork-invariants.test.mjs` (every channel `getReleaseRepoForChannel` offers resolves to
`nplez1/orca`) and `src/main/updater-stable-feed-fallback.test.ts`. They assert this fork's repo
path, so a sync that restores upstream's expectations turns them red again. The updater suites that
carried the mapping before this sync — `updater.check-preflight` and `updater.prerelease-fallback` —
went with upstream's bulk test removals and ownership refactors in the 2026-11-20 sync (#43339,
#43277), and `updater-release-builds` lost its test the same way in the 2026-11-08 sync (the module
itself moved into `updater/releases/`). The prerelease-feed and feed-readiness suites were the last two
of that family and went in upstream's 2026-11-24 test-inventory pass, so the mapping is covered through
the two above and the retired updater cases are re-homed in
`src/main/updater/releases/updater-fork-feed.test.ts` — all but the REST-list-first update-delay
describe block, whose four cases no test covers, as `local/sync/convergence-ledger.md` records.

**The project's own links follow the same constant.** `src/shared/orca-repository.ts` derives
`ORCA_REPOSITORY` / `ORCA_REPOSITORY_URL`, plus the scheme-less `ORCA_REPOSITORY_DISPLAY_URL` that
share text prints, from `MAIN_RELEASE_REPO`. Every desktop link that names this project reads it:

- `src/main/github/client/fetch/orca-star.ts` — the `gh api user/starred/...` check and the `PUT`;
- the star surfaces — `StarNagCard.tsx`, `star-nag/StarNagToastHost.tsx`,
  `settings/GeneralSupportSection.tsx`, `GitHubStarButton.tsx` (the Landing page's star button);
- the report and share surfaces — `sidebar/SidebarFeedbackDialog.tsx` (GitHub issues),
  `terminal-pane/TerminalErrorToast.tsx` (file an issue), `github-project/ProjectViewStates.tsx`
  (feature request), `sidebar/SidebarSettingsHelpMenu.tsx` (Help → GitHub), and
  `stats/ShareUsageButton.tsx` with `stats/share-card-utils.tsx` (shared text and card footer).

Each of those carried upstream's repository as its own literal, so this fork's users starred a
project this build does not come from and filed its bugs against it. A sync that restores one of
those literals re-points the link at upstream; `src/shared/orca-repository.test.ts` requires each of
those files to import the constant, fails on a repository named in any of them — a `github.com/...`
URL or a bare `owner/orca` slug, which is the shape the `gh` call used — and fails on the identity
module spelling the repo out instead of deriving it. The share card's repo line is built from the
constant rather than translated, which leaves `auto.components.stats.share.card.utils.19f4b4dc75`
unreferenced in the six catalogs and in `config/scripts/locale-ko-key-overrides.json`.
`verify:localization-extraction` reports that without failing, the same way it reports the brand-name
keys, but `verify:localization-catalogs` is stricter: an entry with no call site at all cannot be
rebuilt from a default, so it must be listed in `src/renderer/src/i18n/en-runtime-required.json` —
that one-line addition is part of this patch, and a sync that drops it fails the lint chain.

Not covered, deliberately: `mobile/` still names upstream (`settings/about-screen.tsx`,
`settings-menu-screen.tsx`, `ProtocolBlockScreen.tsx`, `app-update/github-release-update-source.ts`).
Whether Orca NP publishes its own mobile app is a product decision; `config/scripts/check-upstream-identity-literals.mjs`
records the APK update-source half as reported-not-policed, and the About, Settings and protocol-block
links are not checked at all.

### `local(updater)`: read this repo's releases, not the ten-entry tag feed

Upstream's resolver reads GitHub's atom feed and probes only the six newest candidates at or above the
installed version (`MAX_MANIFEST_PROBE_CANDIDATES`). Both halves are sound upstream, where the feed is
one repo's own releases and every one of them has a manifest. Neither holds here.

**The feed lists tags, not releases, and caps them at ten.** `nplez1/orca/releases.atom` carries every
tag the repo has — the sync mirrors upstream's `v*` tags and the fork's own `archive/*` branch tags —
measured on 2026-10-29 as eight mirrored tags against two of this repo's releases
(`v1.4.214-np.41`, `v1.4.214-np.40`), out of ten entries. Those tags have no release and no manifest
here (`releases/download/v1.4.244/latest-mac.yml` 404s), and they sort above every `1.4.214-np.*`. A
day with nine new mirrored tags pushes this repo's newest release out of the feed entirely — after
which there is no candidate left to probe at all.

**The state that produces is not "no update".** `pinDefaultReleaseFeed` gets `no-newer` from the feed
and falls through to `fetchLatestStableReleaseTag`, whose `releases/latest` redirect resolves to this
fork's newest release — a `-np.` version, which the pre-release filter rejected outright, so the
fallback returned null and every check ended in
`ReleaseFeedPreflightError('manifest-unavailable', …)`. Automatic and menu checks both fail, the menu
shows "Couldn't reach the update server", and the check is re-armed on the silent 1h→6h cadence.
Nobody running a build published here saw an in-app update offer.

Anchors:

- `src/main/updater-prerelease-feed.ts` — `fetchReleaseListTags` reads
  `api.github.com/repos/nplez1/orca/releases?per_page=100` and keeps entries that are not drafts and
  carry at least one asset, which a bare mirrored tag never does. `fetchReleaseAtomTags` is the same
  atom reader as before, kept as the fallback: the REST call is unauthenticated and shares a 60/hour
  per-IP quota, and a throttled client must still resolve updates. `fetchLatestStableReleaseTag`
  accepts `-np.<n>` (via `isForkReleaseVersion`) alongside non-prerelease versions, because that is
  the only thing `releases/latest` can resolve to here.
- `probeCandidates` still widens to every newer candidate. It is no longer load-bearing against the
  atom noise — the release list has none — but it costs one round trip and stays true for the fallback
  feed, where the mirrored tags are.
- `src/main/updater-stable-feed-fallback.test.ts` — `accepts the fork's own -np. release line, which
  releases/latest resolves to`.
- the atom-feed and candidate-tag cases themselves — `finds this repo's own release when mirrored tags
  have crowded out the atom feed` (this incident), `takes its candidate tags from the release list`, the
  draft/asset-less case, and both fallback cases — lived in the prerelease-feed suite, and the fork-feed
  regression case that exercised the atom fallback in the feed-readiness suite. Both suites went in
  upstream's 2026-11-24 test-inventory pass; every case listed here is re-homed in
  `src/main/updater/releases/updater-fork-feed.test.ts`, the atom-fallback regression included.
- the last-good pin reaching `available` — the suite that asserted that transition,
  `updater.publishing-window-feed.test.ts`, was retired upstream in the 2026-11-20 sync's bulk test
  removals (#43277); the prerelease-feed suite that pinned the `lastGoodTag` the pin is built on went in
  the 2026-11-24 test-inventory pass; its not-ready readings of `lastGoodTag` are re-homed in
  `updater-fork-feed.test.ts`, but the step from last-good to `available` still has no test.
- `src/main/updater-release-targets.ts` and `src/main/updater-release-readiness.ts` — the URL and
  probe halves, split out of the resolver so it stays inside the 300-line module limit. A sync that
  restores the single file has to take these two with it.

Two upstream-owned files also diverge here, and neither is a `local(...)` patch — they are fixes
upstream would want, recorded so the next sync does not quietly undo them:

- `src/shared/release-channel.ts` — `PLATFORM_UPDATE_MANIFESTS` holds one manifest per platform and
  `getPlatformUpdateManifestName(platform, arch)` replaces `getUpdateManifestNamesForPlatform`, so a
  Linux release's manifest is matched to the running architecture rather than "either arch counts".
  Upstream's array-valued table accepts `latest-linux-arm64.yml` on an x64 build and vice versa.
- `src/shared/app-version.ts` — `isForkReleaseAppVersion` (`-np.<n>`, and nothing else). It is what
  lets `releases/latest` resolve this fork's own release line.

The probe window above is history worth keeping: it is why every newer candidate is probed rather
than a fixed six, and the fault it fixed — a manifest-less entry hiding this repo's release behind it
— is the same one the release list now removes at the source. Upstream never needs any of this, so it
is not proposed there.

### `local(build)`: do not bake an updater `publisherName` into Windows builds

This fork ships unsigned. `electron-updater` Authenticode-verifies every installer it downloads
against the `publisherName` recorded in the installed app's `app-update.yml`, and an installer whose
publisher does not match is rejected — including its own channel's next build. Upstream sets
`SignPath Foundation` for non-dev channels. Here it is dropped and `verifyUpdateCodeSignature` is
disabled, which is the same thing upstream's dev channels do for the same reason.

Anchor: `config/electron-builder.config.cjs`, `win.signtoolOptions`.

### `local(build)`: expect this fork's Developer ID team, not upstream's

Upstream's new `verifyMacTerminalHost` (`config/scripts/macos-terminal-host-bundle.cjs`) compares the
packaged `Orca Terminal Host.app`'s signed team against `ORCA_MAC_TEAM_ID`, which upstream hardcodes
to its own team (`6CX3WHS9HZ`). This fork signs with the Developer ID in `MAC_CERTS`, whose team is
the owner's, so the check failed on the first sync to carry it (np.29). The constant now prefers
`APPLE_TEAM_ID` — the team notarization already has to match the certificate, and present exactly
when `MAC_CERTS` is — and keeps upstream's value as the unsigned fallback.

Anchor: `config/electron-builder.config.cjs`, `ORCA_MAC_TEAM_ID`.

### `local(i18n)`: the fork's strings live in overlays, not in upstream's catalogs

Upstream owns every file under `src/renderer/src/i18n/locales/` byte-for-byte. The fork's added
strings, its rewording of upstream's copy, and — the awkward one — the keys a dropped feature
orphans all live in `src/renderer/src/i18n/fork/`:

- `fork/en.json` holds the added and reworded English strings. `locales/en.json` is upstream's.
- `fork/<lang>.json` holds the same for de/es/fr/ja/ko/pt/ru/tr/zh/zh-Hant, merged over upstream's file
  by `loadForkLocaleOverlay` at read time. Every overlay file must be listed in `FORK_LOCALE_URLS`;
  `tests/tools/i18n-catalog-overlay-parity.test.mjs` fails if one on disk is not, because an overlay
  nobody loads is a translation the app never serves.
- A **`null` leaf is a tombstone**: the fork dropped a feature, extraction then finds no source
  reference for upstream's key, and `verify:localization-extraction` fails on any key no source
  references — so before the overlay existed, deleting the feature _forced_ deleting upstream's
  entries and rewriting ~21–25 hunks per catalog.
- `mergeCatalogs` (`config/scripts/localization/catalog-validation/fork-english-catalog.mjs`) and
  `mergeLocaleOverlay`
  (`src/renderer/src/i18n/fork-catalog-overlay.ts`) are the same rule on the Node and renderer sides;
  `tests/tools/i18n-catalog-overlay-parity.test.mjs` fails if they drift.

**Every non-null overlay entry upstream also ships is recorded in `fork/en.overrides.json`** — the
upstream English value at the time the fork overrode it — and `verify:localization-catalogs` fails when
the two disagree (issue #323). Six classes, each reported by name: an override upstream ships that the
manifest does not record (`unrecorded` — this is also how upstream adding a key the fork already added
announces itself), a recorded key whose upstream value changed (`reworded`), a recorded key upstream no
longer ships (`removed upstream`), a record the overlay no longer overrides (`stale override record`),
an overlay entry byte-identical to upstream's (`no-op override` — not an override, delete it), and an
overlay entry that replaces an upstream string with a subtree or the reverse (`structural`). A
tombstone whose key upstream deleted is the same idea for `null` leaves. `--fix` never writes the
manifest: recording upstream's value is a human claim, and auto-recording it would let a reword heal
itself silently.

Anchors: `src/renderer/src/i18n/{i18n.ts,fork-catalog-overlay.ts,fork/*.json,fork/en.overrides.json}`,
`config/scripts/localization/catalog-validation/fork-english-catalog.mjs`,
`config/scripts/localization/catalog-validation/verify-localization-catalog*.mjs`,
`config/scripts/localization/source-extraction/verify-localization-extraction.mjs`.

Not covered, deliberately: **the main process does not read the overlays.** `src/main/i18n/main-i18n.ts`
imports `locales/*.json` directly, so a fork string used by a menu, tray or dialog would silently fall
back to English. Nothing is lost today — every non-null overlay entry is renderer-only — but a fork
string that needs main-process copy belongs in `src/main`'s own catalog, not in the overlay.

Tests that pin the mechanism: `config/scripts/localization/catalog-validation/fork-english-catalog.test.mjs`
(its `mergeCatalogs` and `collectCatalogTombstones` cases are the per-override-drift fixtures — the
validation suite that held them beside it was retired by upstream's 2026-11-24 test-inventory pass),
`src/renderer/src/i18n/fork-catalog-overlay.test.ts` (including the
overlay-fetch-failure path), `tests/tools/i18n-catalog-overlay-parity.test.mjs`.

**Orphaned keys are tombstoned, never deleted (2026-10-31).** The section above described the rule;
this is the first commit that applies it to the keys a dropped feature orphans. 27 upstream keys the
fork's own feature work stopped referencing were being _deleted_ from `locales/*.json`, which meant 11
locale files — the twelve highest-churn paths in the tree, 525–1036 upstream commits per 90 days —
conflicted on every sync for 354 deleted lines. They are tombstones in `fork/<lang>.json` now, and
`locales/*.json` is byte-identical to upstream again. The rule for the next sync: when
`verify:localization-extraction` reports a key no source references, tombstone it in the overlay.

Two measured facts about what the overlay actually serves, both checked 2026-10-31:

- **`de` had never been wired.** `fork/de.json` existed but was absent from `FORK_LOCALE_URLS`, so the
  German runtime catalog was upstream's file with _no_ overlay. Wiring it changes exactly three leaves
  for German users, which is the whole measured delta on the runtime path (`locales/<lang>.json` plus
  the overlay only where `FORK_LOCALE_URLS` lists the language), before `52695fbc41e` vs after:

  ```
  settings.OpenAiTranscriptionKeyDialog.d246b2bdb3
    ~/.orca are stored …        ->  ~/.orca-np are stored …
  settings.ShortcutsPane.d8c988dab4
    ~/.orca/keybindings.json    ->  ~/.orca-np/keybindings.json
  settings.AccountsPane.0c64dc2a64
    <upstream string>           ->  removed (its tombstone in fork/de.json applies for the first time)
  ```

  All three are the fork identity behaving as intended. They are recorded because they are
  user-visible and arrived inside a commit that reads as bookkeeping. The other nine non-English
  locales were already wired and are unchanged; `en` is unchanged for the reason in the next bullet.

- **`fork/en.json` tombstones are verifier-only.** English runtime strings are the code's inline
  defaults plus `fork/en-runtime-required.json`; the full `fork/en.json` is the source the verifiers
  merge over `locales/en.json`, and `i18n.ts` never loads it. So an English tombstone removes a key
  from the verifier's catalog without touching the shipped bundle — harmless for an orphan nothing
  references, and _not_ a way to drop a live English string.

### `local(dev)`: rebuild-and-relaunch helper

`package.json`'s `rebuild:mac:relaunch-installed` script plus
`config/scripts/rebuild-and-relaunch-installed-macos-arm64.sh`: build locally and install over the
running app. Convenience only — not for upstream.

Re-pointed at this build in issue #302, and the `package.json` entry restored with it: the entry was
dropped by merge `7c0a53a148e`, which left the script orphaned, and the script still staged
`dist/mac-arm64/Orca.app` over `/Applications/Orca.app` and quit `com.stablyai.orca` — running it
would have quit and replaced an **official** Orca install. It now stages `dist/mac-arm64/Orca NP.app`
over `/Applications/Orca NP.app`, quits only `com.nplez1.orca`, matches the process
`/Applications/Orca NP.app/Contents/MacOS/Orca NP`, and smoke-checks `/usr/local/bin/orca-np`.

### `local(usage)`: Claude usage is read from the CLI, not only from a rate-limited endpoint

Anchor: `src/main/rate-limits/fork/claude-cli-usage-probe.ts`,
`src/main/rate-limits/fork/claude-cli-usage-response.ts`,
`src/main/rate-limits/fork/claude-active-usage-probe.ts`,
`src/main/rate-limits/claude-active-usage-fetch.ts` (the endpoint-first hunks),
`src/main/rate-limits/claude-oauth-credentials.ts` (the `settings-env` source),
`src/main/rate-limits/service/service-fetch-policy.ts`,
`src/main/rate-limits/service/service-polling.ts`,
`src/main/rate-limits/service/service-provider-cycles.ts`,
`src/main/rate-limits/service/service-full-cycle-preparation.ts`,
`src/main/rate-limits/service/service-inactive-accounts.ts`.

**The symptom.** Claude usage sat still unless a Claude session ran and posted a statusline receipt.
The cause is upstream's single source: `GET /api/oauth/usage` with the stored token. Measured on this
machine 2026-10-31, that endpoint answers **429 with `retry-after: 3600`** for the logged-in account;
`claude-agent-sdk-control-requests.ts` no longer carries the `get_usage` control request either, so
`/usage` in a session was the only live path, and `claude-statusline-rate-limits.ts` says so in
passing ("avoiding usage-endpoint polling that 429s under Orca"). A `Retry-After` then froze the
_whole Claude lane_ for an hour: `shouldSkipAutomatedFetch` and the activation plan both refused to
refresh a provider whose only cure was the endpoint that had just refused it.

**What the fork does.** Runs the CLI the account already has and asks its own control protocol for
the `/usage` panel data — `get_usage` with `skip_behaviors: true`, over Orca's usual SDK spawn hook,
with `settingSources: []` so a workspace's hooks, plugins and statusline cannot run. Measured on this
machine: **278 ms**, `session 7% / weekly 7% / Fable 0%`, `total_cost_usd: 0`, no transcript, no
orphan process, and it works while the endpoint 429s. Upstream's removed hidden-PTY fallback is not
what this is: no PTY, no typed `/usage`, no "y" to a trust prompt, no browser sign-in — a control
request cannot drive a login picker.

- **Probe first, endpoint second.** `fetchActiveClaudeRateLimits` reads the probe before it reads
  credentials, so a healthy account never asks the endpoint at all. The endpoint stays as the
  fallback for an API-key login, a WSL account (the login lives in the guest), Windows, and any CLI
  that answers nothing.
- **`Retry-After` gates the request, never the lane.** `usageEndpointRetryAtMs` carries an open
  `Retry-After` into the fetch, which then refuses to call the endpoint without freezing the provider
  that has a second way to answer. A user refresh still passes (`options.force`).
- **Off by one platform.** The probe rides upstream's existing `allowUsagePanelSupplement` flag,
  which is false on win32 — so Windows keeps exactly upstream's behaviour until someone measures the
  probe there. That flag now means what it says; `allowPtyFallback` stays unused.
- **Inactive previews never probe.** One CLI start per saved account, per switcher open, is not a
  price worth paying for rows nobody is looking at. That holds because
  `fetchInactiveClaudeAccountUsage` builds its own options instead of forwarding them, so the
  service's stale `allowUsagePanelSupplement: true` never reaches the probe — and
  `fork/claude-inactive-account-usage.test.ts` fails if a future edit starts forwarding it. No hunk
  in `service-inactive-accounts.ts` was needed for this; the upstream file is untouched.
- **`usageMetadata.source` is `'cli'`**, a value `shared/rate-limit-types.ts` already carries.

**Freshness, measured 2026-10-31 21:53Z.** The doubt worth answering is whether the CLI serves a
cache: its payload carries the server's own `as_of`, and the SDK notes `model_scoped` is absent from
cached answers. Against a healthy endpoint in the same minute the numbers agree exactly — endpoint
`five_hour 10.0 / seven_day 7.0` at `as_of 21:53:18Z`; probe `five_hour 10 / seven_day 7` at
`as_of 21:53:23Z` — so the probe is a live read, not a replay. During the 429 window the probe still
carried a current `as_of` (`20:31:50Z` at 20:31Z).

**Isolation, and what it does not do.** The probe passes `settingSources: []`, `strictMcpConfig: true`
(no saved MCP server may start for a usage read) and `persistSession: false` (no session or transcript
is left behind), so the only process it can create is the CLI itself. It does not walk Orca's own
child close ladder (`claude-agent-sdk-process-spawn.ts` warns about kills outside it): the child is
ended by `session.close()` and, failing that, the SDK's abort. With strict MCP config there is no
grandchild to reap, which is what makes that acceptable here rather than in a chat session.

**Cost of the probe, stated so it is not a surprise.** A warm start answers in ~0.3–0.5 s and spends
no tokens; the 15-minute cadence is upstream's, not a new timer. It does write the account's
`.claude.json` (Claude Code's own bookkeeping, with its rotating `.claude.json.backup.*`), which is
the same write a session start makes.

**The CLI probe went dead; a turn makes the CLI report again (2026-11-09).** On Claude CLI 2.1.319
the `get_usage` control request still answers — with `rate_limits_available: false` and
`subscription_type: null`, cold and again after a real API turn. So the probe returned `null` on every
poll, the fetch fell through to `GET /api/oauth/usage`, and that endpoint answered **429 with
`retry-after: 3593`** — measured on this machine the same minute. The status bar could then only move
when a session posted a live receipt, which is the "open a session and say hello" symptom.

Three changes, and one deliberately rejected:

- **A turn is what makes the CLI report.** The CLI publishes `rate_limit_event.rate_limit_info` on its
  own stream when it completes a turn: `unifiedWindows.{five_hour,seven_day}` with a 0–1 `utilization`
  and an epoch-seconds `resetsAt`. Captured on 2.1.319 2026-11-09: `five_hour 0.02 / seven_day 0.15`.
  The probe now sends one minimal prompt (`hi`, haiku) and reads that event, so **the Claude app makes
  the call itself** — Orca sends no inference of its own, there is no impersonated client, and nothing
  for a subscription-credential policy to object to. Measured through Orca's own spawn hook: 3.9 s wall, `session 2% / weekly 15%`,
  ~$0.0026 and 73 tokens for the turn.
- **`get_usage` is no longer tried first, and that is a measurement, not a preference.** Asking it costs
  nothing and answers in 140 ms — but issuing it leaves the session unable to run the turn at all: the
  stream then stalls until the deadline (measured twice, 60 s and 15 s budgets). One phase, one timeout.
- **The probe must be handed the login.** It isolates itself with `settingSources: []`, which also hides
  a login kept in the CLI's settings env, and `buildClaudeChildProcessEnv` strips inherited auth on
  purpose. Without the token the child is unauthenticated and reports no limits — the first rewrite
  timed out at 15 s for exactly this. `oauthToken` now travels into the child env.
- **Rejected: reading the API's rate-limit headers from an Orca-issued completion.** It works (a
  `max_tokens: 1` completion returns `anthropic-ratelimit-unified-{5h,7d}-utilization`), and it is
  cheaper in tokens, but it sends _inference_ with a subscription token from a client posing as
  `claude-code/2.1.0`. That is the use Anthropic restricts for third-party tools, and the worst case is
  account action. Recorded here so a later reader does not "simplify" the probe back into it.

**Accepted cost, stated plainly: a probe turn is inference, so it counts as activity in the 5-hour
window.** While the endpoint is throttled the poll spends one small turn (~73 tokens, ~$0.0026) per
interval, which means a window is effectively always running and a user's first real message lands
inside one Orca opened rather than starting the clock itself. The rejected header approach had the same
consequence, and this is not a reason to prefer it — it is the price of freshness while the sanctioned
endpoint refuses to answer. It stops the moment the endpoint answers again, because the endpoint is
asked first, and it never happens on a refusal the probe does not answer (`missing-scope`, `network`).

**The endpoint is asked first, the probe second.** The endpoint is the sanctioned source and the only
one carrying `fableWeekly` / `extraUsage` / `monthly`, so a healthy endpoint must never be shadowed by a
probe reading that has none of them. The probe answers when the endpoint cannot: held by its own
`Retry-After`, or refused — but **only for a refusal a turn can outlast**: `rate-limited` and `server`.
`missing-scope` is excluded because it is permanent for a `claude setup-token` login (the usual value of
`CLAUDE_CODE_OAUTH_TOKEN`, and so of the `settings-env` source), and probing it would spend a billed turn
on every poll forever. For that same reason a `settings-env` login refused with `missing-scope` reports
`unavailable` rather than an error: the base showed no segment for it, and an error row that never clears
is worse than the calm absence it replaced. A refusal's own `Retry-After` is carried onto the probe reading it caused, or the
next poll asks the endpoint again inside its own wait, which is what keeps a 429 window alive.

**The login is where the CLI keeps it, not only where Orca looked.** `readClaudeOAuthCredentials` read
the keychain and `.credentials.json`; this machine's login is `env.CLAUDE_CODE_OAUTH_TOKEN` in
`~/.claude/settings.json`, with no keychain item and no credentials file at all. Every read therefore
reported `missing-credentials` / "No subscription plan — API key billing", which is also what hid the
segment entirely (an `unavailable` Claude snapshot renders no segment). A third source, `settings-env`,
now reads `settings.local.json` then `settings.json` under the same resolved config dir — the order
the code applies, and note that `settings.local.json` is Claude Code's project-scope file, so it only
wins where it exists. It accepts `ANTHROPIC_AUTH_TOKEN` only when it starts `sk-ant-oat`, because that
key also carries plain API keys and those have no plan. It reports `hasRefreshableCredentials: false`
and no `refreshTarget` on purpose: the login belongs to the CLI's settings file, which Orca must never
rewrite. The CLI itself prefers an environment token over its stored keychain login, so an account with
both shows the keychain account's usage here — rare, and recorded rather than inverted. The same ordering
means a keychain or `.credentials.json` login holding only a refresh token (no access token) loses to a
settings-env token, where before Orca would have refreshed the stored login; that account still reads
correctly, it just reads the settings login. `settings.local.json` is Claude Code's project-scope file,
so for the System Default config dir it only applies to `cwd ~` — it is read first because that is the
order the CLI applies them, not because it is a user-scope override.

**Polling no longer requires a focused window, and the sync changed what that buys.** When this was
written, `shouldBackgroundPoll` returned `isVisible() && !isMinimized() && isFocused()`, and a serve-mode
host keeps its window hidden (`applyServeDesktopWindowActivationPolicy`) — so a remote host **never
polled usage at all**. The `51c77320bc` sync brought upstream #37633 (`688adc4b4c2`), which adds
`usageViewers > 0`: a paired client's `accounts.subscribe` stream registers as a viewer, so a remote host
someone is watching already polls. **The M5-host symptom is upstream's now.** What this hunk still adds is
polling for a desktop window nobody is watching — hidden or unfocused — so the numbers are already fresh
when the user looks rather than refreshed on focus.

**The gate is the fork's on the clock and upstream's on a return (2026-11-24).** Upstream's
`service-activation-refresh` case pins that an _unwatched_ owner return stamps the refetch interval
without reading, and the first shape of this patch failed it: one `shouldBackgroundPoll` returning
`true` answered both questions, so an unfocused window coming back read anyway. The gate is now split
by which question it answers. `shouldBackgroundPoll` is upstream's body, byte for byte, and still owns
`refreshIfWatched` — the owner return and the focus/show/restore listeners. `shouldTimerPoll` is the
fork's, and gates the two halves that are _not_ a return: the interval clock in `startTimer`, and the
deferred startup read `attach` schedules, which runs at first paint when the window is typically not
focused yet. Both read through one `refreshActiveWindow` so the plan is not written twice.

That costs a probe turn per interval while the endpoint is throttled (see the cost note above), so it is
a deliberate trade and the piece a later reader may reasonably revert: delete `shouldTimerPoll` and
`refreshIfPolling`, point `startTimer` at `shouldBackgroundPoll`, point
`scheduleDeferredStartupRefresh` back at `refreshIfWatched`, delete
`fork/service-background-polling.test.ts` and this paragraph, and `usageViewers` covers the watched
case on its own.

**Tests that hold the line.** `fork/claude-cli-usage-response.test.ts` pins the payload mapping against
a captured 2.1.316 reply and the `rate_limit_event` mapping against a captured 2.1.319 event;
`fork/claude-cli-usage-probe.test.ts` pins command/cwd/env, the token handed to the child, the abort
paths and the "no payload is not a reading" rule; `fork/claude-active-usage-fetch-probe.test.ts` pins
endpoint-first (a healthy endpoint is never shadowed by a probe reading), the open `Retry-After`
(the endpoint is not called but the fetch still reports the wait), the WSL/`usageError`/opt-out cases; `fork/service-claude-usage-probe.test.ts`
pins that a `Retry-After` no longer freezes a lane on activation _or_ on the timer, and that the next
fetch still receives the open wait (a user refresh receives `null`) — both plumbing hunks fail if
dropped; `fork/claude-inactive-account-usage.test.ts` pins that a saved-account preview never probes;
`fork/claude-settings-env-credentials.test.ts` pins the source order (keychain → `.credentials.json` →
`settings.local.json` → `settings.json`) and that a plain API key in `ANTHROPIC_AUTH_TOKEN` is never
taken as a plan login; `fork/service-background-polling.test.ts` pins that the timer and the deferred startup read poll while
the window is unfocused, hidden and minimized, and stop only when the window is gone.
The upstream suites that described the endpoint-only platform (win32) now say so through
`EndpointOnlyClaudeService`, which is the one behaviour split worth reading twice.

### `local(checks)`: the panel forces one read when the PR rollup reports a run it cannot see

Anchor: `src/shared/github/checks/checks-detail-polling-policy.ts` (`rollupReportsUnseenRun`),
`src/renderer/src/components/right-sidebar/checks-panel/refresh/use-checks-detail-timer.ts` (the
effect that calls it, and the `checks`/`repo`/`prCacheKey` fields it reads off the panel model).

**The patch.** The sidebar icon reads the PR's rollup while the panel reads its own rows, so a push
that starts a run can leave the panel showing the previous head's checks until the next poll. When
the rollup reports a run the panel's rows do not contain, the timer forces one read.

**Why it is not the "second cadence owner" the convergence ledger forbids.**
`local/sync/convergence-ledger.md` § "Checks panel polling and review refresh" hands _when_ the panel
refreshes to upstream's `ChecksDetailPollingPolicy`, and says not to re-add a second `pollIntervalRef`
writer. This sets no interval and writes no cadence: it is an event-driven force that consumes the
existing `forceNextFetch` path and is subject to the same cooldown and backoff. The named follow-up
in that ledger entry — re-add the PR-transition refetch as a policy concern if the panel feels stale
when a new run appears — is what this is; it is simply keyed on the rollup rather than on the review.

**Do not:** make it unconditional. A forced read past a failing endpoint's backoff turns a broken
endpoint into a retry loop, which is why `forceWanted()` also requires `!policyRef.current.failed`.

**Test note.** Upstream's `checks-panel-read-owner-resets.test.tsx` builds its panel model with
`testDouble`, whose contract is that each double supplies every field the hook reads — so the double
carries `checks: []` now that the hook reads it. A model without rows means nothing displayed, and
the force is correctly idle.

### `local(usage)`: Claude's spend cap is upstream's, Codex's stays ours

Anchor: `src/main/rate-limits/claude-oauth-usage-request.ts`,
`src/main/rate-limits/claude-usage-credits.ts`,
`src/renderer/src/components/status-bar/InlineProviderUsage.tsx`,
`src/main/rate-limits/codex-backend-usage-client.ts`.

A Claude seat with no 5h/7d window reports a monthly spend cap. The fork implemented that half of
upstream's `dd1248998f` itself, with its own parser and a separate `allowance` readout line; upstream later
shipped the same feature as `cffb527b82` (#33655), so the fork's half is retired and upstream's is taken
**byte-for-byte** in all three of its files (verified by `git hash-object` against the commit). Three
things upstream does that the fork did not: the legacy `extra_usage` percentage is computed from the
amounts first (the fork read a 0–1 fraction `0.0958` as 0.0958%, not 9.58%); `monthly` requires a real
cap (a currency, a percentage and a limit above 0) rather than a bare percentage; and the window comes
from the same `ExtraUsageBalance` the "Usage credits" section already renders, so the bar and that section
cannot disagree. The duplicate `allowance` line went with it — the Credits section already shows the same
bar and amounts. Net +163/−443 across 5 files, 231 of those deletions in a fork-only test file.

**What remains fork-only, deliberately:** the Codex half. `spend_control.individual_limit` maps to
`monthly` plus a `count`-unit `ProviderAllowance` in `codex-backend-usage-client.ts`; upstream has no
equivalent, and its tests are unchanged. And **#134**, the Claude OAuth token refresh in
`claude-accounts/claude-oauth-token-refresh.ts` — upstream deliberately never refreshes (`1bd308bd84`),
and refreshing is this fork's product decision. That is the one permanent divergence in this area, and
it is isolated in its own module rather than mixed into the spend-cap path.

Two shared docs named Claude as an `allowance` producer, which stopped being true here:
`src/shared/rate-limit-types.ts`, `src/shared/provider-allowance.ts` (Copilot and Codex are the
remaining producers) and `docs/site/content/docs/agents/usage-tracking.mdx`. They now say so, including
that Claude's percentage is one of the two computed ones.

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

**Since the 2026-10-06 sync the live set belongs to a session, not to the process.**
`agent-status-async-subagent-session-source.ts` publishes
`globalThis.__orcaPiAsyncSubagents = { bySession, registration, awaitingSession }`: each factory run
owns its registration, the owning session comes from that registration's own event context, a child
that reports before its session announces itself waits in `awaitingSession` and is adopted only by
the session that names it, and a shutdown closes only its own bus. The `globalThis` home is what lets
a `/reload` — which re-evaluates the module — keep the children a same-file resume expects; it is
deliberately **not** the authority for attribution, because a child bound before its session named
itself would otherwise land in the previous session's bucket.

### `local(agents)`: the cancel latch reads this lane's snapshot as a start

Upstream's cancel latch (`agent-hook-cancel-verdict-latch.ts`, `#47627`) recognises a child that
starts right after Esc by `hookEventName === 'agent_start:subagent'`. This fork's lane above has no
such event — it publishes one `subagent_async_state` snapshot per post — so the start matched nothing
and was held as a late restatement of the cancelled turn for the whole 15s window, leaving the pane
reading done while the child worked.

The latch carries one marked hunk: a snapshot naming a run the cancelled row did not carry is a start.
That suite is kept and green here rather than retired, because the defect was the fork's.

Two holds beside it are load-bearing, for two different reasons. A replayed start stays held because of
the `isReplay` check. An OMP `task:subagent:lifecycle` start stays held because of the **event-name**
check — it posts `agent_start` and does name a child the cancelled row never carried, and it is still
held because that child may belong to the cancelled turn, which is what upstream's suite asserts.

**Do not** widen it to "any snapshot is a start" — a restatement of the same children is exactly the
late work this latch exists to swallow — and **do not** drop the event-name check to "any event naming
a new child", which is the likelier mistake and would release the OMP start.

**Settlement is the other half.** `session_start` is this lane's descendant-scope reset, so the
resume placeholder is gated through `gatePaneStateOnDescendants`, an empty live set is never
defaulted to `working`, and a hold **nobody claims** — no lead verdict and an empty roster — is
retracted rather than merely not re-published. Without that, resuming a session and letting its last
child end left the pane held `working` by a hold nobody had reported, and a child-only update left
the cached row naming a child that no longer existed. Anchors for both:
`src/shared/agent-hook-listener.ts` (the placeholder gate), `descendant-pane-state.ts` (the
retraction), `agent-status-session-boundary-source.ts` (per-registration shutdown), and the
lifecycle cases in `agent-hook-listener-descendant-lifecycle.test.ts` and
`agent-status-async-subagent.test.ts` (resume A with no new turn, last child ends ⇒ `done`).

**The binding belongs to a bus, not to an evaluation.** `PiAsyncSubagentBusBinding { bus,
registration, listeners }` is looked up by the bus object and ownership transfers to the newest
registration on it, so a second factory's distinct bus is still observed and a superseded
registration's in-flight callbacks refuse through the newer registration's `closed` flag. Telling
these apart matters: keyed by evaluation, B's bus was silently unobserved and B's child was filed
under A.

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

**Addendum 2026-10-27 — the roster moved back to upstream's name and path, and the ownership fence
became upstream's.** Two restorations, both gated on evidence rather than assumed:

- `src/shared/codex-subagent-roster.ts` is **upstream's file again**, byte-identical to the sync base,
  with upstream's own name (`CodexSubagentRoster`) — six files back to zero fork hunks
  (`codex-subagent-transcript.ts` and its test, `providers/codex-events.ts`,
  `providers/codex-transcript-poll.ts`, `codex-status-transcript-line.test.ts`).
  `agent-descendant-roster.ts` survives as the **sibling** holding only this lane's pi/claude extras,
  so a sync no longer reports upstream's roster as a modify/delete plus importer rewrites.
- `src/main/pi/agent-status-session-owner-source.ts` (204 lines, the fork's #68 fence) is **deleted**,
  and upstream's `omp-session-status-owner-source.ts` is live at `f37c1f6b95`'s bytes. The gate that
  justified it: the fork's #68 suite ran unmodified against upstream's 54-line rule — **22/22 pass**,
  including all twelve Pi-lane cases (in-process child, reopened child, re-key on a `session_start`
  naming the leaving file, nested child, unpersisted session, the three handoffs, forked-session pane,
  refused transcript, persisted child off an unpersisted pane, switched unpersisted pane, no session
  manager). No case proved upstream's rule insufficient, so the 150-line difference bought nothing.

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

**Addendum 2026-11-07 — one roster decides both the row and its children (#283).** A pi pane
publishes two child inventories: `subagent_runs`, the fork's async live set, and `subagents`,
upstream's roster from `task:subagent:lifecycle`. Only the first gated the row's state, while the
display renders the second — so a row could publish `done` beside a child the fleet list showed
spinning, which is exactly what #283 reported. Three triggers were reproduced through
`normalizeHookPayload` before any code changed: an `agent_end` carrying a live `subagents` roster, a
`model_select` / `subagents_update` restating a previous `done` row with one, and both rosters live at
once (where the async roster _replaced_ the display roster and hid a running child).

The fix is one roster for both outputs: `pane-child-roster.ts` unions the two by id (the roster entry
owns the state and tool line; the reporting lane fills any label it alone carries), publishes that list
as `subagents`, and derives the state from the same list through `foldAgentLeadStatus`. The merged list
is computed per publication and never written into `descendantRosterByPaneKey` — `replaceAgentDescendants`
would delete the reported children on every `subagent_runs` post. **A child event carries no roster of
its own**, so `reportedSubagentsByPaneKey` carries the pane's last reported children into those
publications, stamped and reaped on the roster's own quiet window so a lane that dies mid-child cannot
pin the row. `agentDescendantEffectiveState` is gone — the map-based fold had no callers left once both
paths went through `foldAgentLeadStatus`.

**The two inputs of one pi fold are now supplied by the two issues that designed it.** #284 landed as
`providers/pi-pane-hold-evidence.ts` first, with the scheduled-work input; #283 adds the child input to
it rather than building a second hold. `resolvePiPaneStatus` keeps the split: a live child is
`hasLiveAgentWork` (plain `working`, and it outranks the monitor), scheduled work is
`hasLiveNonAgentWork` (`working` + `workingMode: 'monitoring'`). `applyPiScheduledWorkHold` reads the
child half back off the payload's own roster, which is the one roster the gate published.

The restate problem is split across the two halves of the seam, and both are needed.
`pi-family-events.ts` `restatedLeadFields` re-derives the _published state_ from the lead's own verdict —
the recorded one, except that a settled `mainAgent` outranks it, because a host-side settle (Ctrl-C,
`server-status-inference.ts` `settleTurnWithoutStop`) writes `done` into the cached row without touching
the record. `gatePaneStateOnDescendants` takes `restated` from the same `PI_RESTATEMENT_EVENTS` set and
records nothing for one — a restated state is derived from the record, so writing it back would turn a
value this lane synthesised (`applyDescendantEventToPane`'s `leadState ?? 'working'`) into the verdict,
and the drain that follows could never settle. A restated `done` is the exception and is recorded: the
fold only outputs `done` from a `done` lead, and only a settled row can supply one.

One ordering change comes with the fold and is intended: a lead that is itself `blocked` or `waiting`
now keeps that word where `agentDescendantEffectiveState` returned `waiting` for any waiting child.
`foldAgentLeadStatus` keeps the lead's own vocabulary first because the row's `toolName` and
`interactivePrompt` are the lead's, so `waiting` beside a `blocked` prompt named the wrong surface. The
grok rule is untouched either way: a child's unanswered question still prevents `done`, and grok never
produces `blocked` as a lead state.

Anchors:

- `src/shared/agent-hook-listener/pane-child-roster.ts` — the union, the reported-children store, and
  `resolvePaneHold`, which writes `state`, `workingMode`, `sessionBoundary`, `interrupted` and
  `subagents` together.
- `src/shared/agent-hook-listener/providers/pi-pane-hold-evidence.ts` — the one pi fold, both inputs.
- `src/shared/agent-hook-listener/descendant-pane-state.ts` — `gatePaneStateOnDescendants` (`restated`)
  and `applyDescendantEventToPane`, both publishing through `resolvePaneHold`.
- `src/shared/agent-hook-listener/providers/pi-family-events.ts` — `PI_RESTATEMENT_EVENTS`, exported so
  the normalizer and the gate cannot disagree about which events republish a row, and
  `restatedLeadFields`' settled-row rule.
- `src/shared/agent-hook-listener/descendant-events.ts` — `reported` on a pi live-set fact, where an
  absent `subagents` field means _none_ rather than _no opinion_.
- Tests: `agent-hook-listener-descendant-lifecycle.test.ts` § "one roster decides the row and its
  children (#283)" (all three triggers, the negatives, the two-holds case, and an invariant that no
  published row disagrees with its own children), `pane-child-roster.test.ts`,
  `providers/pi-pane-hold-evidence.test.ts`, and the carry-forward case in
  `pi-claude-child-events.test.ts`.

**Addendum 2026-11-10 — a held row states the lead's verdict, so terminal status cannot settle it
(#197).** #283 made the row and its children agree, but the row it published still said nothing about
the lead: `mainAgent` was absent, and every reader that keys on it then read a held `working` as a
working lead. The one that matters is `programStatusHookYieldEndsAt`: it lets the pane's own terminal
status (OSC 7501) take the row once the hooks go quiet, and the only way a held row opts out is
`isAgentStatusHeldOpenByChildWork` — `mainAgent.state === 'done'` with a row that is not `done`.
`applyPiScheduledWorkHold` publishes exactly that for the monitoring badge, which is why a
scheduled-work hold survived the window and a child hold did not.

The symptom is the report's, both halves from one cause. A pi turn ends under a live child; the pane
is held `working` and posts nothing while the lead is idle; pi's TUI settles the moment the turn ends,
so after `HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS` (2 min) the terminal report takes the pane.
The row it publishes carries no `subagents`, so the pane reads `done` **and** the child's row
disappears, while a 250 s tool is still running — the reported window almost exactly.

The fix is one line of policy: `resolvePaneHold` publishes `mainAgent` (the lead's verdict it folded
against, dated by `turnCompletedAt` and carried across re-holds the way `applyPiScheduledWorkHold`
already does) whenever it holds a `done` lead open. A provider that already stated a `done` verdict
on the payload — grok's gated child question, which carries `outcome` and the turn's own end — keeps
its own, so nothing a roster-owning lane said is replaced. It applies to every provider on this fold,
and the held row keeps the lead's vocabulary, so a held `waiting` still reads `waiting`. Nothing
changes for a lead that is still working: a hold over one asserts nothing a `mainAgent` reader needs.

Four things this deliberately does not change, all stated so the next reader does not re-derive them.
A `waiting` or `blocked` program-status proposal can still take a held row after the silence window —
a needs-you signal should win, and the cost is that its row carries no children, which for pi needs a
child dialog under a finished lead. The hold states no `outcome` of its own — it carries one a previous
`done` verdict already stated — so a turn that errored or was cut off before it produced a reply
announces its end through `terminal-agent-turn-news.ts` as finished where it previously announced
nothing. Inferring one is a follow-up rather than one hunk: stamping `outcome: 'cancellation'` on a
working pi row would arm `isCancelVerdictLatched`, and pi has no `opensNewTurn` event to release it.
The hold has no escape hatch of its own — a pi that stays alive but stops reporting a dead child pins the
row until its next hook post or the 30-minute display decay, the same exposure the scheduled-work hold
and Claude's child roster already carry. And the held row's `mainAgent` is what every `mainAgent`
reader now sees, so three of them change for a held pi row and each is the intended semantics rather
than a side effect: a `tui-idle` wait reports the lead's turn ready while children run (which is what
the lane already does for Claude), `agent_not_working` refuses a Stop instead of sending Escape, and a
plugin subscribed to agent status events sees the lead verdict at lead end and a `done` row without it
at drain.

Anchors:

- `src/shared/agent-hook-listener/pane-child-roster.ts` — `resolvePaneHold`'s `held` input and the
  `mainAgent` it publishes, keeping a `done` verdict the payload already states.
- `src/shared/agent-hook-listener/descendant-pane-state.ts` — both call sites hand it the cached row's
  `mainAgent` and the publication's own clock.
- Tests: `agent-hook-listener-descendant-lifecycle.test.ts` § "a row held open by a live child states
  the lead verdict (#197)" (the held row's shape and one start clock across republishes), and
  `main/agent-hooks/server/testing/providers/pi/server-pi-subagent-hold-precedence.test.ts`, which is
  the regression: on the unfixed code the pane reads `done` one millisecond past the silence window,
  with the child's row gone.

### `local(agents)`: a claude CLI child is not a second session

A pi session can dispatch a subagent through the `claude` CLI (`pi-subagents` → `claude --print`).
That child inherits the pane's `ORCA_*` environment, so it posts the managed Claude hook stream into
the parent's pane under its own `session_id`, and it writes its own conversation as a root transcript
under `~/.claude/projects/`. Upstream has no such topology, so nothing joined the two.

Two things broke, and both are fixed by giving the pair a shared key.

**The child row vanished mid-run.** `pi-subagents` drives a claude child from an in-process pi
session of its own, and that runner session's tool activity reaches the pane it inherited. A pi post
carries the FULL live child set of the session that posted it, and the runner has no children — so
taking that field literally replaced the pane's roster with nothing while the child was still
working. Measured, not inferred: a capture of the hook traffic shows the parent's posts naming run-1
and the runner's posts arriving with an empty set, which is exactly when the row goes; a pi-native
child's row survives the whole run.

The host refuses such a post, and publishes nothing from it — a runner's post may not touch the
pane's turn clock, its prompt or tool cache, or its lead verdict. Four things keep that refusal from
becoming a lockout. It applies only while the pane still holds a live child run, since a runner
session exists only then. The roster is pruned before it is read, so a run whose end never arrived
cannot hold the fence past the reaper's window. A session-ending shutdown now posts its (emptied)
live set unconditionally: `closeOutRun` alone posts only for an unsettled turn, and a `/new` from
idle has nothing pending — so without that post the drained set never reached the host at all.
`piAsyncSubagentForgetSession` parks the session's runs rather than deleting them, so the ending post
reads an empty set while a resume into the same file finds its children again.
pi's transport coalesces to one pending post, so a `session_start` can be lost; with those in place
the next post from the new session is adopted once the child it is unrelated to ends, not never.
`session_start` still hands the pane over immediately, as before.

A child's own stream that arrives after its row has gone is refused too, for five minutes and only
on the conversation it reported: a spooled hook, or a retirement that beat the process, would
otherwise be read as the pane's own agent — ending its presence on a `SessionEnd`, relabelling it on
a `Stop`. That fence is pane-scoped state like every other, so it rides a pane re-key
(`movePaneCacheState`) and dies with the listener's caches (`clearAllListenerCaches`); before #311 it
did neither, so a re-keyed pane lost the fence on its new key and kept a dead one on the old.

**The child's own stream was refused, so the row had nothing to say.** `isInheritedPaneOwnerEvent`
correctly refuses a second agent in an active pane, which meant the child's tool, model and wait
never reached a row. The join key is the child's Claude conversation: the plugin pins it with
`--session-id`, publishes it on `subagents:session` before the first hook fires, the pi lane carries
it as `provider_session` on the wire, and the roster keeps it per child. A claude post whose
`session_id` matches a live child is routed to that row and nowhere else.

That envelope is deliberately narrow, because the server reads a turn edge out of
`(source, hookEventName)`: it reports the PANE's provider, carries no hook event name, and sets
`toolAgentId` to the child's run id — the child marker that path already honours. Without all three,
the child's `SessionStart`/`UserPromptSubmit` would reset the pane's turn clock, clear an
acknowledged attention badge, and re-open manual unread. It never carries the child's process as the
pane's owner, never replaces the pane's resume identity, never settles the parent, and its
`SessionEnd` finishes the row instead of ending the pane.

The durable half is a marker beside the transcript, because the session list is a filesystem scan
that knows nothing about hooks: `<uuid>.pi-parent.json` records the parent pi session. A Claude row
with one carries `subagent.parentSessionId`, so the existing pi-style nesting shows it under its
parent instead of beside it. The marker's suffix, type and path rule live in
`src/shared/pi-claude-parent-marker.ts` because the writer and the scanner read it from opposite ends,
and it records the parent's AGENT: a list filtered to one agent removes the pi parent, and without
that field the child would be counted hidden instead of shown. A cross-agent child whose parent row
is absent from the list is therefore a top-level row, not a hidden one. That field has to survive
every path a listed row takes, so the search index carries it in its own column — a schema bump that
drops and rebuilds the index, which is a cache over the transcripts.

A child's own `SessionEnd` does not end its row: that process exiting is not the RUN ending, and the
runner that started it is still posting. The row is pi's to retire, and the reaper covers a lost end.

Anchors:

- `src/shared/agent-hook-listener/nested-pi-session-guard.ts`, and
  `agent-hook-listener/pi-claude-child-events.ts` — the roster lookup, the claude event → child fact
  mapping, `buildPiClaudeChildEvent`, and `admitNestedAgentPost`, which decides both cases in one
  place before any provider fold runs. Called from `agent-hook-listener.ts`.
- `src/shared/agent-descendant-roster.ts` — `providerSession`, the tool line,
  `findAgentDescendantByProviderSession`, and the `waiting` state a live-set re-upsert must not
  overwrite; `agent-status-subagent-snapshot.ts` carries the same fields so a hydrated row keeps them.
- `src/main/pi/agent-status-async-subagent-{source,session-source}.ts` — the `subagents:session`
  binding, `provider_session`/`model` on the wire (optional, so an older peer ignores them), and the
  session-end drain `agent-status-session-boundary-source.ts` calls.
- `src/main/agent-hooks/server/pi-claude-child-parent-marker.ts` — the marker, written once per
  (transcript, run), best-effort, and only when the post's own conversation name matches the
  transcript it points at. The field is stripped from the row afterwards: it is never persisted.
- AI Vault: `session-scanner-claude-pi-parent-marker.ts` reads the marker and
  `session-scanner-primary-parsers.ts` sets `subagent` from it; `contentDependencyPath` puts the
  marker's stat in the parse-cache key, which is what lets a row cached before the marker existed
  pick the link up on a later scan. `SELF_CONTAINED_TRANSCRIPT_AGENTS.claude` becomes false — a
  claude parse now reads a sibling file — which also turns `session-search-file-write.test.ts`'s
  "clears a stale lineage" case green; it was recorded as proved-not-ours in the 2026-10-16 entry
  and is no longer part of the known red set.
- `src/shared/ai-vault-subagent-nesting.ts` resolves a child's parent against its own agent and host
  first, then — only when exactly one row on that host carries the id under another agent — across
  agents, which is what a claude child naming a pi parent needs.
- Tests: `nested-pi-session-guard.test.ts` (including the `/new` drain and the reaped-run takeover),
  `pi-claude-child-events.test.ts` (including the runner's last posts after a child `SessionEnd`),
  `agent-hooks/server-pi-claude-child.test.ts` (the whole server path: one row, unchanged turn
  clock, unchanged resume id, marker on disk, field not persisted),
  `pi-claude-child-parent-marker.test.ts`, `ai-vault-subagent-nesting.test.ts`, the marker test in
  `ai-vault/session-scanner-claude-pi-parent-marker.test.ts`, the roster cases in
  `agent-descendant-roster.test.ts`, and the `subagents:session` cases in
  `pi/agent-status-async-subagent.test.ts`.

Known gaps, recorded rather than chased:

- A relay forwards events it cannot scan, so a relayed host writes no marker and its session list
  keeps today's behaviour. A paired Orca server writes its own, because it runs its own hook server
  beside the transcript.
- The marker is read only where the transcript is on the scanning machine's disk
  (`ownsTranscriptDisk`); an SSH host's list is unchanged until it scans that file itself.
- A same-agent child whose parent is not in the loaded window is still counted hidden rather than
  shown (the long-standing policy); only a CROSS-agent link is shown as a root when its parent is
  absent, because that absence is usually the agent filter rather than the window.
- After an Orca restart a child is unattributed until the parent's next post republishes
  `provider_session`, because rosters are not restored from disk.

### `local(agents)`: monitoring is reserved for Claude session-cron callbacks and running monitors

Upstream's lead-status fold reads _any_ live non-agent child work as `workingMode: 'monitoring'`,
which includes an ordinary background shell. This fork's `#26` keeps the monitoring badge off a
background shell, because a shell the agent started as part of its turn is still agent work: it is
reserved for Claude session-cron callbacks and for a running **monitor**, which is upstream's own
verdict and the one `claude-background-task-inventory.test.ts` pins. The fork owner chose (2026-09-25)
to keep this policy and express it on upstream's fold rather than revert to upstream's semantics; the
2026-11-27 sync narrowed it to the shell kind alone, because the fork's justification names a shell
and a monitor is `kind: 'monitor'`, not a shell (`classifyClaudeBackgroundTaskKind`).

Anchors, both on upstream-owned files and marked `LOCAL(nplez1)`:

- `src/shared/agent-hook-listener/providers/claude-pane-hold-evidence.ts` — `resolveClaudePaneStatus`
  is where the policy actually lives, and the file a conflict resolver has to keep the fork's side of.
  Through `claudePaneHoldEvidence` it splits the fold's two inputs: `hasLiveAgentWork` is the pane's
  running or owed agent work **or** a running non-agent task whose kind is a shell
  (`state.claudeRunningNonAgentTasksByPaneKey`, `hasShellTask`), so a background shell the agent
  started is agent work; `hasLiveNonAgentWork` is the session-cron set, a running monitor, **plus
  `owedShell`**, because an owed shell is a pending wake-up rather than the running shell the policy is
  about. The same function reports
  `claudeMonitoringEquivalentHold` for a shell-only hold, and `claude-events.ts` reads it where upstream
  asks `heldTurnCountsAsFinished`: upstream stamps `turnCompletedAt` for a monitoring-held turn, so the
  fork must restate that verdict or a shell-held turn never announces its completion. Renaming the badge
  is a display change; dropping the stamp would be a behaviour regression.
- `src/shared/agent-hook-listener/providers/claude-events.ts` — that restatement, and nothing else.
- `src/shared/agent-hook-listener/providers/claude-roster-state.ts` — a caller, not the anchor: it
  imports `resolveClaudePaneStatus` and applies it to roster records. **No fork hunk in this file**, so a
  conflict there is upstream's to resolve.
- `src/shared/agent-hook-listener/providers/grok-events.ts` — the payload drops
  `resolution.workingMode`, so a grok background shell reads plain `working`. Grok has no cron concept,
  so it never earns the badge.
- Tests that encode the policy (all would need re-adapting if it is ever dropped):
  `src/shared/agent-hook-listener-descendant-lifecycle.test.ts` (plain `working` when agent work holds
  the turn, the `monitoring` badge when only scheduled work does) and
  `src/shared/agent-hook-listener/providers/pi-pane-hold-evidence.test.ts` (a finished turn held as
  monitoring while scheduled work is armed, a live child read off the payload instead). The two lane
  suites this bullet used to name — the Claude/Grok background-task-status file with its six
  shell/watcher stories, and the Grok lane's own `workingMode` assertion — were retired by upstream's
  2026-11-24 test-inventory pass, as were the Grok/Claude cancel and helper-settlement suites
  (`main-agent-status-parity` went in the 2026-11-08 sync, `server-grok-background-status.test.ts` in
  the 2026-11-20 sync). The cancel verdict's upstream suite survived 2026-11-24 and is kept
  (`agent-hook-cancel-verdict-latch.test.ts`, with the snapshot rule marked LOCAL(nplez1) above). The
  held-turn repost suite (#48146) is the `fork-refactor` deletion in
  `local/sync/expected-deletions.json`, because it drives the two `subagent:async-*` bindings this fork
  removed; the cancel invariant is also pinned by
  `src/shared/agent-hook-listener-descendant-lifecycle.test.ts` › "starts a background child right
  after a cancel, instead of holding it as late work". The
  helper-settlement badge has no owner at HEAD, so re-homing that case is owed. The
  structured/native-chat lane is deliberately untouched: it still reads a watch loop as monitoring.

Weigh this before keeping it: `isAgentTimeAccruing` is `state === 'working' && workingMode !== 'monitoring'`,
so a shell-held row now **accrues agent time** where it previously did not. That is a session-stats
change beyond the status-bar badge — inherent in calling a shell agent work rather than side effect
of the fold. If the stats change is unwanted, the alternative is to keep upstream's evidence split
and strip only the `workingMode` from the published payloads.

### `local(agents)`: scheduled work earns the monitoring badge for pi too

`#284`. A pi session with a `/loop` armed, a pending `ScheduleWakeup`, or a cold pi-subagents job used
to read `done` when its turn ended: `providers/pi-family-events.ts` mapped `agent_end` straight to
`done`, and the extension's only hold before posting it was its child roster. The work was real — a
live loop's timer re-enters the session, a cold job spawns a subagent — so the row was wrong for
minutes at a time, and closing the tab fired the loop into a session believed finished.

The badge is the one `local(agents)` above already owns (`workingMode: 'monitoring'`), so this is a
missing evidence class, not a new state. It mirrors Claude's session cron, one lane over:

- `src/main/pi/agent-status-scheduled-work-source.ts` + `agent-status-scheduled-work-bus-source.ts` —
  the inventory. Two `pi.events` RPC channels
  (`loop:rpc:schedules:list` served by the user's `loop` extension, `subagents:rpc:schedules:list` by
  pi-subagents) are cached in `globalThis` and posted as `scheduled_work` on **every** pi post, computed
  while the body is built. Live loops publish nothing when armed, stopped or expired, so a re-check
  timer (≤60s) is the only thing that can clear a hold nobody announced; it also restates every 10
  minutes, because a silent `monitoring` row decays to `unverifiable` at 30. The bus is adopted from the
  **fenced** `session_start` handler, never at factory time: pi-subagents runs children in-process on
  their own bus and with the same pid, so a factory-scope adoption would let the first subagent point
  the lead's refreshes at a bus that serves no loops.
- `src/shared/agent-hook-listener/pi-scheduled-work.ts` — the wire reader. Relative `next_in_ms`, so a
  relayed or SSH pane's clock skew cannot move the hold; bounded to 20 jobs; a fire more than two
  minutes overdue means nothing refreshed the evidence, so it holds nothing. That rule is judged
  twice: on arrival, and again whenever the hold is applied, against the receipt time the cached
  inventory now carries (`receivedAt`, `piScheduledWorkIsLive`). Without the second judgement a
  cached hold never aged — the extension dying without posting again left the pane `monitoring`
  until upstream's 30-minute decay (#311). The receipt also bounds the inventory itself at 13
  minutes: the extension's key excludes the countdown, so a fire that merely moves posts nothing and
  the 10-minute restatement is the only freshness signal there is. That bound is what ages the job
  shapes with no fire time to age against — a self-paced loop waiting for its next wakeup, a cold job
  a day out.
- `src/shared/agent-hook-listener/providers/pi-pane-hold-evidence.ts` — the pi lane's pane-hold fold,
  the analogue of `resolveClaudePaneStatus` and the seam `#283` adds its child-work input to. Applied
  at **two** places — `normalization/normalize-hook-payload.ts` for the pane's own posts, and
  `pi-claude-child-events.ts` for a claude child's republish, which builds the row outside that
  normalizer — and both run after `gatePaneStateOnDescendants` and after the session placeholder: the
  gate records the lead's own verdict, so a fold applied before it would teach the gate that a
  finished turn was working. The inventory is cached per pane
  (`piScheduledWorkByPaneKey`) because a republish can be triggered by something carrying no inventory
  at all — a descendant draining, a resumed session's placeholder — and reading absence there would
  drop a hold nothing has cleared.
- A held row publishes `mainAgent.state === 'done'`. Two readers need it: a restatement
  (`pi-family-events.ts` rebuilds every restatement from `mainAgentState`) would otherwise republish
  the held `working` as the lead's verdict and pin the badge for good; and
  `programStatusHookYieldEndsAt` pins hook precedence to `Infinity` only for
  `isAgentStatusHeldOpenByChildWork`, without which the program-status lane takes the row over two
  minutes after every turn.

Fail-safe, not fail-active: a pi that serves neither channel posts no field, and reads exactly as it
did. OMP and prime-agent are untouched — no emission, no fold.

Tests: `src/main/pi/agent-status-scheduled-work.test.ts` drives the real generated source into the real
listener, `providers/pi-pane-hold-evidence.test.ts` pins the reader and the fold,
`server/testing/providers/pi/server-pi-subagent-hold-precedence.test.ts` pins the silence fallback, and
`agent-hook-listener-descendant-lifecycle.test.ts` pins the restatement.

**Follow-up, 2026-11-21 — the revamped roster.** pi-config's `/loop` and pi-subagents grew one
model-facing door (`manage_schedules`) over both homes, with `pause`/`resume`, bounds and `run`, and
that changed what the two channels answer. Two shapes the lane read wrongly:

- **A paused job is listed and arms nothing.** `/loop` keeps a paused loop's id, prompt and cadence
  and only unarms it, so `loop:rpc:schedules:list` returns it with `paused: true` and no `nextAt` —
  the same shape as a self-paced loop waiting for its wakeup, which is why presence was enough
  before. Presence is now filtered by what each extension knows before a fire: `!paused` and
  `enabled !== false` on both homes, plus — on the cold home only — `runCount` under an unspent
  `maxRuns` and an `until` neither passed nor at or before the armed fire. Those bounds are cold-only
  on purpose: the scheduler moves `runCount` in the same step it disables the job, so a firing cold
  job is never dropped, while `/loop` moves `runs` when it arms the fire and starts the turn
  afterwards, so the same test would release a live pane mid-fire. The inventory's no-fire-time case
  still holds, because a dynamic loop between wakeups genuinely is armed.
- **`loop:state` is the armed set `/loop` publishes itself, whenever that set changes.** The lane
  bound only pi-subagents' two events, so a loop armed, paused or re-armed between turns
  had no post to ride: `/loop` typed at an idle prompt, or a `manage_schedules` call that lands after
  the turn ended, left the pane `done` with the loop armed until the first fire. It is now a third
  subscribed channel, and it also covers the session-start order case — a restored loop's emit is
  caught when Orca's extension loads first, and Orca's own `session_start` ask catches it when the
  `loop` extension loads first. The set holds only jobs with an armed fire, so a dynamic loop between
  wakeups is invisible to it — pausing or ending one of those moves nothing, which over-holds rather
  than releasing early, and the ≤60s re-check is the bound.

The events list carries a third entry rather than replacing one: the two pi-subagents channels still
announce cold work, and `/loop`'s create/remove request channels are still deliberately not bound
(binding them reads the inventory before the change lands).

**Known uncovered, on purpose.** `plugins/pi-codex-goal` schedules its own re-entry —
`provider-limit-auto-resume` five minutes after a provider limit, `continuation-scheduler`
sub-second after a turn — and emits **nothing** on `pi.events`. During the five-minute wait the pane
reads `done` while the session will resume itself. Covering it needs that extension to publish the
pending continuation first (a `goals:state`-style channel naming the resume instant); it is not the
job/loop surface, so the lane is left as it is until that signal exists.

### `local(skills)`: re-track the three agent skills the internal move removed

Upstream moved its agent skills out of the tree on 2026-04-29 (`c85f487ebf`, "chore: move agent
skills to internal delivery", PR #1254): it deleted `.agents/skills/**`, gitignored the directory, and
a setup hook keyed on `$ORCA_INTERNAL_DEV_SETUP` now symlinks the private copies back in. That env var
is set only by stablyai's internal tooling and silently no-ops for everyone else, so a fork worktree
gets no skills at all.

This patch re-tracks the three that are useful and safe outside the org, restored byte-for-byte from
`c85f487ebf^`:

- `.agents/skills/electron/SKILL.md` — CDP/`playwright-cli` validation of a running Electron app. Its
  Orca launch line additionally carries `ORCA_BACKGROUND_LAUNCH=1`, matching the repo AGENTS.md rule
  that agent-launched apps must not steal focus or reveal a test window (the skill predates it).
- `.agents/skills/react-useeffect/**` — 4 files of `useEffect` guidance.
- `.agents/skills/typescript/**` — 49 files of TypeScript perf/tsconfig/error patterns.

`auto-pr-merge`, `auto-review-fix` and `auto-submit` are deliberately **not** restored: they encode
stablyai's PR/merge policy (`--admin` merge, sequential review-agent loops) that this fork does not
follow.

Why `git add -f` and not an un-ignore rule: `.agents/skills/` stays ignored, so the internal hook can
still drop machine-local symlinks beside these files without them showing up as untracked. Only the
three directories above are force-tracked.

Scope: a fresh checkout of `main` carries the skills; a worktree branched before this commit
gets them on its next sync. The `electron` skill's runtime dependency is `@playwright/cli`
(`npm i -g @playwright/cli`, which provides the `playwright-cli` binary).

### `local(skills)`: the skill rail, the stubs and the guides name this fork

Upstream publishes skill content and an install rail that both name its own repository, and the
stubs it ships resolve a bare `orca`. On a fork build that is the wrong install: on this machine
`orca` is the official app's CLI (its own bundle, its own data directory, its own `~/.orca`), so
every instruction in the skill that shells out either failed or drove the wrong instance (fork
issue #99). Four parts, one patch.

**Install rail.** `ORCA_SKILLS_REPOSITORY_URL` is `https://github.com/nplez1/orca`. The rail pins
`<repo>/tree/<ORCA_BUILD_COMMIT>`, and that commit is a commit of _this_ repository; pointed at
upstream the pair names a commit upstream never had, which is how a fork build could re-lock a skill
to a ref that does not exist in the repository the lock claims.

**Lock ownership.** `readSkillLockSources` (`src/main/skills/skill-lock-sources.ts`) reports each
installed skill's recorded source verbatim, so a lock written by an official install (`stablyai/orca`)
still reads and a copy of this app's own skills is not relabelled as a third party's same-named copies.
The predicate that used to make that call — `isOrcaSkillLockSource`, which accepted both owners and
rejected a lookalike — was **deleted on 2026-10-27** (`ddc2a7827f`), and
`convergence-ledger.md:1875-1885` records the deletion. Do not re-add an owner allowlist without
deciding again which owners it should hold.

**The stubs' resolver.** The shared block `<!-- block: resolver -->` in
`skill-stubs/_shared/cli-resolution.md` (inserted into each stub with a
`<!-- shared: resolver -->` marker) is inlined into every `skills/*/SKILL.md`. It now resolves
`orca-np` (this build) / `orca-np-dev` (dev) / `ORCA_CLI_COMMAND`, drops the upstream `orca-ide`
rung (that is the official Linux CLI), keeps a relay-host exception so the remote plain-`orca` shim
still works, says the exported value is an absolute path that must be quoted, and states that a bare
`orca` is the official install. Three guides lose an upstream equivalence that no longer holds for
the same reason: the `orca-cli` dev-builds paragraph, the `orca-per-workspace-env` serve invocation,
and `computer-use`'s command naming. `docs/site/content/docs/cli/skills.mdx` re-points every install
command at this repository and says the CLI is `orca-np`.

The identity sweep does not scan `skills/` or `skill-stubs/` (`local/sync/identity-sweep.mjs`,
`SCAN_ROOTS`), and its bare-`orca` rule is report-only, so a sync preserves the upstream names by
design — this entry is the only record that the published bytes are fork-owned.

**Managed sessions export the launcher.** `buildPtyHostEnv` already resolved this app's own CLI
launcher for the child's PATH and then discarded it. It is now also exported as `ORCA_CLI_COMMAND` —
the first rung of the resolver — so a managed session stops depending on a bare `orca` in PATH. The
WSL lane keeps the bare registered name its shell wrappers resolve against `ORCA_WSL_CLI_DIR`, and
an inherited value is still dropped first.

Anchors: `src/shared/agent-feature-install-commands.ts` (`ORCA_SKILLS_REPOSITORY_URL`),
`skill-stubs/_shared/cli-resolution.md`,
`skill-guides/orca-cli.md`, `skill-guides/orca-per-workspace-env.md`,
`skill-guides/computer-use.md`, `docs/site/content/docs/cli/skills.mdx`, and
`src/main/ipc/pty/host-env/assembly.ts` (`buildPtyHostEnv`, at the
`prependOrcaCliDirToChildPath` call).

Generated from those sources, so never edited directly: `skills/*/SKILL.md` and
`src/cli/bundled-skill-guides.ts` (`pnpm run generate:bundled-skill-guides`), and
`resources/skills/current-manifest.json` (`pnpm run generate:skill-bundle-manifest`).

Tests that go red if a sync restores upstream's names: `tests/tools/fork-invariants.test.mjs` — the
pane's `BROWSER`, which resolves from the launcher the pane actually has (pinned through the dev
launch, the one branch whose name differs per build). `pnpm lint` gates the generated content through
`verify:bundled-skill-guides` and `verify:skill-bundle-manifest`, so a hand-edited stub or a stale
manifest fails there.

`ORCA_SKILLS_REPOSITORY_URL` is pinned by `tests/tools/fork-invariants.test.mjs`, which asserts the
install rail's tree URL names `nplez1/orca` at the build commit. Seven paths this section used to cite
no longer exist — src/shared/agent-feature-install-commands.test.ts and
src/shared/skill-freshness.test.ts were retired on 2026-10-27 (and the `isOrcaSkillLockSource`
predicate they covered is gone; see the lock paragraph above), and
src/main/ipc/pty/pty-spawn-env-terminal-basics.test.ts,
src/main/ipc/pty/pty-daemon-spawn-agent-home-env.test.ts, src/main/pty/wsl-orca-env.test.ts,
src/main/skills/skill-lock-sources.test.ts and src/main/skills/skill-update-run.test.ts were deleted
upstream (bulk test removals, fork issue #312). The pane `BROWSER` is the one of those the
fork-invariants test now owns; nothing replaced the rest, so this section is the whole of what a sync
can turn red on skill names. The CLI's own skill-listing test was retired with upstream's bulk test
removals in the 2026-11-10 sync and nothing replaced it, so that coverage is a known gap rather than
a guard (see the sync log's coverage-debt line).

**A repo-relative path here is in backticks only while it must exist.** `local/sync/lib/cited-guards.mjs`
resolves every backticked test path and package script in this file, and post-sync's `cited-guards` row
fails on one that does not — so a retired path is written plain, as history. A bare file name is not
resolved: the ledger uses those as prose, and only a path from the repo root can be checked.

Not covered, deliberately: `~/.agents/.skill-lock.json` on an existing machine still records
`stablyai/orca` until the next update rewrites it, and `src/renderer/src/i18n/locales/*.json` keep a
`github.com/stablyai/orca` share-card label — translated copy, per the rule in `local(identity)`.

Two consequences to know before changing this again:

- **Accepting `stablyai/orca` lets this build rewrite an official install's skills.** On a machine
  running both apps, the update rail treats the official app's globally installed copy as its own
  and replaces it with Orca NP's stubs. That is the intended trade — the alternative labels this
  app's own pre-migration copies as a third party's and never updates them — but it is a takeover
  of another install's files, not a no-op.
- **On Windows the native launcher re-labels the exported path.** `native/windows-cli-launcher`
  collapses any `ORCA_CLI_COMMAND` that is not exactly `orca-np` or `orca-ide` to `orca`, so the
  CLI's own recovery/retry commands printed on Windows name `orca` even though the pane's env now
  carries the absolute `orca-np.exe`. That rewrite is pre-existing and unchanged by this patch; the
  export only makes the absolute-path input the normal case. Fixing it means teaching the launcher
  to keep a path through, which is its own change.

Also unverified, recorded so it is not rediscovered: the daemon decides "is this WSL" from the
session id (`shell-launch-plan.ts`) while the main process uses its own `isWsl`, so a disagreement
would carry a host path across `ORCA_CLI_COMMAND/u` into the guest. The WSL restore above makes the
main-process lane correct either way; no mismatch was observed.

### `local(agents)`: the fork workflow section in `AGENTS.md`

Anchors: the `# Fork workflow` section appended at the end of `AGENTS.md`, headed
`# Fork workflow (nplez1/orca) — local, not proposed upstream`.

**Why:** the fork's PR/branch invariants (fork base, `origin` vs `upstream`, the only sanctioned
PR path, the CI-fix cycle, the Orca NP dev identity, the `Explore`/delegation defaults) were only
recorded in `BRANCHES.md` and `open-pr.mjs`, which agents reach late or not at all. Reads and edits
before a PR were repeatedly aimed at the wrong remote or the wrong `main`, producing PRs against
`stablyai/orca` and ~300k-line diffs from a base mismatch. `AGENTS.md` is the file every harness loads
at session start, so the rules belong there.

**Known deviation from § Rules.** This patch touches `AGENTS.md`, which upstream owns and PR branches
can also edit — exactly the case the rule above warns about. It is deliberate: the alternative
(`.pi/APPEND_SYSTEM.md`) is Pi-only, and these rules need to reach every agent harness that runs in a
worktree. The practical cost is that a future upstream or PR change to `AGENTS.md` must be merged
around this section rather than silently replacing it. If the section is ever dropped by a sync,
re-append it from this description.

Why it is appended rather than woven in: it keeps the fork-only block contiguous, so a conflict during
a merge of upstream's `AGENTS.md` is one hunk at the end of the file instead of several scattered
through upstream's prose.

Two lines in that section are corrections rather than new rules, and a re-append should carry them:
`## Verify` gives the timeout per harness (pi's Bash tool is seconds, Claude Code's is milliseconds —
the original "600000 ms" was only right for one of them, and pi accepts an ms-scale number silently,
producing a command with no deadline), and the `## Opening a PR` example derives its body path with
`mktemp` instead of the fixed `/tmp/body.md` that two concurrent agents collided on.

Scope: same as `local(skills)` — a fresh worktree cut from `main` carries it; a worktree
branched before this commit does not.

### `local(test)`: the 2026-10-29 box — repaired in the tree, and the eight that are recorded

A new machine (18-core, 128 GB, macOS) red the full unit gate at base revision `ef46e09b03`:
136248 passed, 80 failed. The allowlist declared six entries and this box needed more, so the run was
classified before anything was recorded.

**Repaired, not recorded.** Twenty-one failures were the machine: four from a shell hook writing
to stderr on every zsh start (two suites assert empty shell output), fourteen from macOS `/bin/bash`
3.2 against CI's bash 5.x (`mapfile`, `${arr[@]}` under `set -u`) and three from browsers Playwright
had not downloaded. The remaining twelve were fork-local drift that no allowlist entry may cover,
because each is deterministic on any machine: a `vi.mock('electron')` factory that never learned
`ipcMain.on` (added by #234) and a coordinator mock that never learned `reportQuitCancelled` (added
by audit-216); `.github/scripts/fork-release-ref-guard.sh` using `${var,,}`, which is bash 4 syntax
in a script the suite runs with an unqualified `bash`; `fork-pr-gates.yml` missing from
`ci-closed-pr-caches.yml`'s cleanup targets; upstream's draft-PR invariant, which the fork's
`fork-pr-gates.yml` deliberately does not follow; three `copilot-1-0-105` transcripts the fork added
to a shared fixture directory without baseline rows; and a settings suite that reconciled the real
`~/.claude` because it left `agent-view-service` unmocked — the write guard was right, the test was
wrong.

**Recorded.** Two classes, sixteen entries:

- `fork-home-migration-mock` (6) — `local(identity)` added the pre-rename home adoption, and
  `resolveLegacyHomeStoreIn` (`src/main/home-directory-migration.ts:114`) reads its adoption marker on
  every `getApiKeyPath()`, before the key file. The four credential-store suites queue reads with
  `mockReturnValueOnce`, so the marker read spends the one-shot; the store then decodes `undefined`
  and `encrypted-api-key-file-store.ts:167` wraps it as "could not be decrypted". That message sent
  the first diagnosis to Keychain, which was wrong. The fix couples product and test — memoise the
  resolved path per store instance, or make those mocks path-aware — so it belongs in its own change.
- `fork-credentials-ratchet` (2) — `src/main/claude-accounts/claude-oauth-pending-rotations.ts`
  (`afbf7860833`, `e09393fec57`) has no `fsAllowances` row for its `rmSync` and no
  `CREDENTIAL_ROTATION_OWNERS` row for its rotation write. The ratchet is working; granting it here
  would approve an unreviewed persistence surface.

### `local(test)`: the 2026-10-31 sweep — every recorded class closed, all eighteen entries gone

All eighteen entries in `local/unit-known-red.json` were repaired rather than re-justified, and the
manifest's `entries` is empty again. Nothing here weakens a ratchet. Two of the six Mac classes
(`host-toolchain`, `mobile-font-repaint`) and the whole Linux class had been recorded with the wrong
cause — a suppressed red is also an unexamined one, which is what this sweep cost to find out.

- **`fork-home-migration-mock` (6) — closed by mocking the seam the entry named as its second
  option.** The mechanism the entry recorded was right: the fork's pre-rename adoption
  (`resolveLegacyHomeStoreIn`, `src/main/home-directory-migration.ts:114`) reads its adoption marker
  inside `getApiKeyPath()`, so the marker read spends the `mockReturnValueOnce` queued for the key
  file. The four suites now mock `../home-directory-migration`'s `adoptLegacyHomeStore` — the store's
  path is not what these units test, and `home-directory-migration.test.ts` already covers the
  adoption — and each suite pins the migrated file name in its no-file case, so the fork's wiring is
  still asserted. The entry's other option, memoising the resolved path per store instance, was not
  taken: it changes no path, because `resolveLegacyHomeStoreIn` returns `current` from every branch,
  and it is only unsafe if it also caches the `kind: 'failed'` outcome, which is the branch that
  deliberately records no marker so the _next_ read retries it (`home-directory-migration.ts:164`).
  Mocking costs less than a memo that has to remember to skip failures.
- **The same eight cases were allowlisted on the Linux nightly as `credential-store-safe-storage`,
  which is what showed they were never this machine's.** `local/nightly-linux-known-red.json` carried
  them with the evidence "they fail identically here, so the class is the credential store's
  safeStorage/keychain behaviour" — but the eight are six spent one-shot mocks and two deterministic
  source scans, neither of which involves a keychain on any host. The class's `exit` condition was
  "remove when this family is mocked off safeStorage" — which is what the six store cases got, while
  the two ratchet cases were closed by declaring the surface instead — and all eight leave that
  manifest with this change, and
  the `macos`/`linux` pair agreeing was the signal that should have sent someone to the tree sooner.
- **`fork-credentials-ratchet` (2) — closed by declaring the surface, after reading it.**
  `flushPendingRotation` writes back a rotation the store refused _through_
  `writeClaudeOAuthCredentialRotation`, under the store's own compare-and-set on `spentStoreToken`,
  and returns early while an exchange for that key is in flight, so it is an owner of that one write
  rather than a second writer of credentials. Its `rmSync` deletes its own sealed queue once the last
  rotation is written back and nothing else. `fsAllowances` gains that one primitive and
  `CREDENTIAL_ROTATION_OWNERS` gains `PENDING_ROTATION_OWNER`. No comment records this in the file:
  it is an upstream-owned file and `check-upstream-file-comments` counts the lines. Two things the
  declaration does not claim, both of which predate it: the census regex (`mutation`,
  `claude-credential-persistence-ratchet.test.ts:82`) does not match `writeSecureFile`, so it cannot
  see the sealed write at `claude-oauth-pending-rotations.ts:146` at all, and the write-back is also
  reachable from `scheduleUpcomingRetry`'s timer (`:310`) — harmless, because it re-persists a
  rotation that was already minted, but "only the exchange writes its result" is no longer literal.
- **`host-pnpm-shim` (1) — closed on the machine, not in the tree.** The case proves that a bare
  `pnpm exec node-gyp` cannot find node-gyp with `PATH` emptied, and asserts pnpm's own
  `Command "node-gyp" not found`. This machine's `~/.local/bin/pnpm` guardrail resolved the real
  pnpm with bare `ls`/`sort`/`tail`, so an emptied `PATH` killed the shim first (`exit 127`) and
  pnpm's answer never appeared. The shim now uses `/bin/ls`, `/usr/bin/sort` and `/usr/bin/tail`.
  Nothing in the repo changed, so this entry was never writable as one of the fork's own reds: a
  wrapper that breaks under a restricted `PATH` is machine infrastructure failing, and the allowlist
  was hiding it. Its `prunedSince` row records the code commit that carried the manifest change, not
  a commit that fixed anything — there is no such commit, and the entry had no `LOCAL-PATCHES.md`
  evidence line at all, which is how it survived.
- **`mobile-font-repaint` (1) — closed as a premise guard, and the entry's "real render finding"
  claim was wrong.** the mobile-web terminal font-render suite (retired upstream)
  asserts that a stalled web font leaves tofu on screen and that the glyph repaints when the font
  arrives. This host has `~/Library/Fonts/NerdFonts/Symbols/SymbolsNerdFontMono-Regular.ttf`
  installed, and the terminal stack names that same family
  (`mobile/src/terminal/document/text-scaling.ts:44`), so the _fallback_ already draws the identical
  outline and the two frames are byte-identical — correct behaviour with nothing to repaint, not a
  repaint defect. The case now captures the folder glyph, an unassigned codepoint (U+0378, tofu
  everywhere) and the post-load frame, and skips only when both signals say there was nothing to
  repaint: the stalled frame already drew a real glyph **and** the loaded font changed nothing.
  Verified both ways against the same fixture: with the system family present the frames are
  identical (skip), with it removed from the stack they differ (runs for real).

  **The guard's residual gap, stated rather than hidden:** on a host whose system fallback draws
  U+F07B with an outline the web font would _not_ have produced — the nerd font is installed at a
  different version, or another symbol font (Font Awesome also maps U+F07B) supplies it — a _broken_
  repaint also leaves the two frames identical, and the case skips instead of failing. Nothing
  distinguishes "the same family was already drawing it" from "a different family drew it and was
  never replaced" without a second page whose font loads normally, which is what a real closure of
  this hole needs. Linux CI is unaffected: there the stalled frame is tofu, so the assertion runs.
  This is a narrower hole than the allowlist entry it replaces, which suppressed the case on every
  host and reported a real failure as a known red — but it is a hole, and the entry's claim of a
  "real render finding" is withdrawn rather than relocated.

- **`host-toolchain` (8) — closed; six of the eight were mis-attributed to timeouts and stale dist
  reads.** The class was recorded as "the CLI/dev-rebuild harness times out or reads a stale dist
  file under load", i.e. this machine being slow. Nothing times out and no child exits non-zero: the
  dev-rebuild and main-entry-facade failures are macOS path spelling, the class this ledger already
  closed twice (`05fd6bd8e0`, `8be888db9f`). `os.tmpdir()` is `/var/folders/…`, `realpath` is
  `/private/var/folders/…`, and fsevents reports the resolved spelling while the paths the code
  registers keep the unresolved one. The reclaim entry's own diagnosis was right and is fixed as it
  described. Three sites:
  - the dev-rebuild suite's line 32 (and the `main-entry-facade` suite upstream retired this sync)
    built their fixture root from raw `tmpdir()`, so
    every registered watch path and the child's own `__dirname` disagreed. Both realpathed the
    `mkdtemp` result, the idiom 11 other files in this tree already use. That suite was then retired
    itself by upstream's 2026-11-24 test-inventory pass, so `config/build-plugins/` has no test at HEAD
    and the fixture-root fix went with it.
  - `config/build-plugins/process-host-dev-rebuild.ts:87` created its private watch-signal directory
    the same way and registers the signal file with `addWatchFile`, so on macOS a **newly created**
    source file never triggered a rebuild at all — editing an existing one did. That is a product
    bug, not a harness one: after the fixture-root fix, the three cases still failing were exactly
    the three that create a file. The code alone does not prove it, since the directory watcher sets
    `packageDirty` itself (`:132`); the evidence is the measured behaviour, where realpathing the
    signal directory restored all three. Upstream-worthy on its own.
  - `config/scripts/reclaim-worktree-generated-files.mjs:204` recovered only from `EACCES`/`EPERM`.
    `pnpm test` runs vitest under Bun, and Bun's `fs.rm` on a `0o555` directory raises `ENOTEMPTY`
    where Node raises `EACCES`, so the in-process case could not recover while the CLI cases (which
    spawn Node) passed. Measured on bun 1.4.4 against node 24.22.1. `ENOTEMPTY` is now recoverable,
    but only when `makeDirectoriesWritable` actually changed a mode — under Node `ENOTEMPTY` usually
    means a concurrent writer added entries, and neither `descend` nor `sameDirectory`
    (`:28-40`, `:89-91`) re-checks the mtime, so a blind retry would delete that writer's files.
    That file is byte-identical to upstream, so this is fork divergence on an upstream-owned file.

  None of the three is fork-introduced or quarantined by `UNIT_EXCLUDE`, and CI is green on them for
  the reason the class name got wrong: on Linux `/tmp` is not a symlink and removing a `0o555`
  directory gives `EACCES`, so the nightly lane never had the shape to fail.

### `local(test)`: five more environment-bound reds, recorded from the np.37 full run

The full suite on this machine (macOS, external volume, other agents' runs contending) leaves 26
failing cases in 11 files. Six are the ones already recorded above (the `/private/var` path
signature, the macOS bash 3.2 arrays, the dev-rebuild timeouts, the missing `cloud/` workspace).
The five below are the same class and were classified here rather than chased, each with the
signature that identifies it. None imports a module this fork changed.

- the packaged-cli-assets suite, the orcad forked-child-paths suite and the macOS terminal-host-bundle
  suite — all three retired since — each failed the same way: `os.tmpdir()` resolves to `/var/folders/…`
  while the code under test reports the resolved `/private/var/folders/…`.
  `src/main/orcad/orcad-forked-child-paths.ts` still carries the orcad rule, and no test in this tree
  asserts that temp-dir spelling for any of the three now.
- the cli-command-privileged-transaction suite — "Refusing to replace non-Orca command
  at /var/folders/…/protected/orca". **Re-diagnosed and repaired in `local(test)` below, fork issue
  #151 § 4:** the recorded error path is `/var/…`, not `/private/var/…`, and the cause is the fork's
  `orca-np` rename rather than symlink resolution. The entry is gone from the manifest, and the suite
  itself went in upstream's 2026-11-24 test-inventory pass, so nothing asserts that refusal at HEAD.
- `src/main/sqlite/sync-database-portability.test.ts` ("rejects explicit undefined bindings") and
  the profile-state streaming-validation suite ("cannot add
  rowid alias") — the bundled SQLite's own binding behaviour differs from what those contracts
  assume; neither file is imported by anything this fork touches. **Both are closed, and the second
  diagnosis was wrong about the cause (2026-10-29).** The rowid case did fail on SQLite 3.54's refusal
  to add a `rowid` alias by `ALTER TABLE … ADD COLUMN` — that part held — but the upgrade came in with a
  Node release every machine took, so the fix was to update the test, not to allowlist it; upstream
  #34661 (`e5f1eef466`) rebuilt it to shadow the aliases through `CREATE TABLE`. The undefined-bindings
  case was the same story with a different ending: #34661 deleted it, because Node 26.10 binds an
  explicit `undefined` as NULL, so the contract it asserted no longer existed. Neither was something
  "the bundled SQLite" did to this fork alone, and that is what made the first one dangerous: a dead
  entry can never be reported stale. The portability suite survives at
  `src/main/sqlite/sync-database-portability.test.ts` and still covers the rowid integer mode; the
  profile-state streaming-validation file itself went in upstream's 2026-11-24 test-inventory pass, so
  nothing re-homes its rowid-alias case now.
- the lost shell-ready marker when a startup command execs over the shell (`repro-13767`) — "Timed out
  waiting for PTY output", the PTY/subprocess class recorded above. The repro file itself,
  `repro-13767-shell-ready-marker-lost-to-exec.test.ts`, was
  retired upstream in the 2026-11-20 sync (#43367), so that entry is gone from the allowlist with it and
  the class is now unasserted here rather than allowlisted.
- `tests/e2e/cross-version-wire/*` (three files) time out at 30 s inside `materializeReleaseCheckout`
  — a git checkout of a baseline ref — when the machine is loaded. They pass on a quiet machine.

### `local(test)`: the 2026-10-22 sync's red set, and one parser fix it needed

The first full gate run after the sync left 41 failing cases in 19 files. Three were real merge
breaks, fixed in the tree rather than recorded: `session-search-list-reparse` (upstream's new
"second fold" case assumed upstream's `claude: true`, while the fork keeps claude out of the
self-contained set — the case now pins `agent: 'pi'`), `agent-session-failure-words-text` (the
`en.json` union kept a `codexCliTooOld` key upstream had dropped), and `pty-pane-copy-census`
(a fork-only terminal-wait file read `pty.paneKey` directly and now goes through `paneOfPty`).
Fourteen were already recorded. The last two are the same host-toolchain class as their neighbours:

- the dependency-security release suite — the audit action's bash step uses
  `mapfile`, and this machine's bash is Apple's 3.2 (`bash: mapfile: command not found`). Same
  `host-toolchain` signature as the `ci-managed-ssh-execution` entry recorded then — that workflow
  contract suite was retired upstream (2026-11-20 sync, #43278) and this one followed in the 2026-11-24
  test-inventory pass, so the class has no surviving member and no entry left to absorb.
- the cross-version host-model-catalog released-phone suite (retired upstream) — both cases call
  `stripTypeScriptTypes` from `node:module`; the bun 1.4.3 pool's `node:module` does not export it,
  so the file passes only under a Node runtime.

Verdict, on the revision that ships:

```
Unit gate @b8d9bf7987 (clean): PASS — 136644 passed; 38 failed (38 allowlisted, 0 unexpected); 0 flaky re-run passed; 0 unhandled error headline(s); 1227 s
```

**2026-10-26: the machine was fixed, so fourteen entries are gone.** These were never upstream's
failure — `/bin/bash` on macOS is Apple's 3.2, which has no `mapfile` and rejects an empty array under
`set -u`, while the ubuntu runners ship bash 5. Homebrew's `bash` 5.3.20 is now installed; because
`/opt/homebrew/bin` precedes `/bin` on this machine's `PATH`, `bash` resolves to 5.3.20 for every
spawned child with no repository change. Cleared: the five `ci-managed-ssh-execution` cases and the
`dependency-security-release` case (both `mapfile: command not found`) and the eight
`pr-auxiliary-preflight-admission` cases (`MOBILE_CI_ARGS[@]: unbound variable`). Those three files run
**233 passed** against the pruned allowlist, which is now **17 entries over 10 files**. This is the reason to keep chasing an allowlisted failure
even when it looks environmental: it was, and naming the _cause_ rather than the _symptom_ is what made
it a one-command fix. Nothing in the tree changed — the fork still needs bash 4+ to run these, which
`config/.bun-version` and the CI image already assume.

**The gate also had to learn one heading.** Vitest reports the run's unhandled errors in two shapes,
and `collectUnhandledErrors` matched only `Unhandled Rejection` / `Uncaught Exception`. A pool crash
arrives under `Unhandled Error`, so the declared count read 7 against 6 headlines and the gate failed
closed on a count it could not explain. The separator now matches all three; with it, the 7 headlines
are the recorded `selector_not_found`, five of the tolerated worker-teardown race, and one pool crash
(`Worker node-runtime emitted error`, SIGTRAP) whose file passes 11/11 alone — recorded as
`pool-crash` rather than waived silently.

### `local(test)`: the full-suite verdict is a file, not a reading exercise

The section above records the red set as prose, which means every agent that runs the full suite has
to re-read this file and re-derive the classification — and it still ends with a nonzero exit code, so
a session that wants "green" runs the suite again. Measured over seven days: 96 full-suite runs, 72%
of them followed by more edits, one session running it seven times in 2.3 h against a failure set that
never changed, 17–29 minutes a run.

So the red set above now has a machine-readable twin, `local/unit-known-red.json`, shaped like the e2e
titles file (`file` / `test` / `class` / `owner` / `evidence` / `flaky`). `local/gate-unit.mjs` runs
`build:packages`, `ensure-native-runtime` and the full suite with a Vitest JSON reporter, and fails
only on a failure that is **not** recorded. It is a fork-local gate: upstream keeps Vitest's exit code,
and `local/check-unit-shard-verdict.mjs` stays the per-shard CI verdict.

What it deliberately does not do:

- It does not waive an unhandled error. One suite can raise the same rejection 28 times, so headlines
  are collapsed and counted, but a headline outside `unhandledErrors` still fails the gate — an
  unhandled rejection is a claim about the run, not about one test.
- It does not waive a failure in a file that is in the branch's own diff. Every unallowlisted failure
  gets one isolated re-run; a pass there is a load-order flake, except for a file the branch touches,
  where "it passes alone" is not a claim anyone can rest on.
- It does not run on a dirty tree. A verdict belongs to a revision, so an edited tree has none — the
  cache is keyed `(HEAD, allowlist hash)` under `.git/orca-gate/`, which is what stops a re-run on an
  unchanged revision from proving anything.
- A missing or unreadable report, a run with no tests, and a timeout all fail closed.
- It does not, on its own, report a _dead_ entry — one naming a case that no longer exists — because
  staleness comes only from an entry that matched a failure. `tests/tools/unit-gate.test.mjs` closes
  that statically instead, so the blind spot is checked at PR time rather than by the next full run.

The first reconciled run (2026-10-21, `1a64dbe2f6`) found 29 failing cases: 24 allowlisted across nine
files, and two files that are red on their own and so are deliberately **not** listed —
`src/main/ephemeral-vm-runtime-extend.test.ts` (its `vi.mock` for `./ssh/targets/ssh-target-registry`
answered only `getSshConnectionManager`, which is all `ephemeral-vm-runtime-extend.ts:22` imports;
a `vi.mock` replaces the module for every transitive importer, and the modules the real
`./ipc/runtime-environments` graph pulls in read `getSshTargetRegistryStore` through it) and
the session-scanner scope/cwd facts suite (retired upstream) (an `fs` read the test asserts must not
happen does happen). Both reproduce in a scoped two-file run.

**2026-10-21 (the `bbc8303b47` merge) — both are fixed, so nothing is left unlisted.** The ephemeral
mock now answers `getSshTargetRegistryStore: () => null`, the registry's own "no host registered"
answer, so every transitive importer of the mocked module gets the registry's real answer instead of
`undefined`; the session-scanner case passes and was never listed. The merge's own full run
(@`51f09025ca`) passed 134,537 cases with 35 allowlisted failures and **one** unexpected one, that
mock. Eight entries whose failures stopped reproducing were pruned, and
the `ci-managed-ssh-execution` workflow-contract suite
(`config/scripts/ci/workflow-contracts/`) was added: the workflow step its cases execute calls
`mapfile`, which macOS's `/bin/bash` 3.2 does not have (the ubuntu runners ship bash 5) — the same
`host-toolchain` class as the `pr-auxiliary-preflight-admission` entries. That suite was itself retired
upstream in the 2026-11-20 sync (#43278, with the rest of the low-value CI checks), so the class now
rides on the drawing step alone.

**Re-diagnosed for fork issue #151 § 4, and the recorded cause was wrong.** Two corrections:

- `ephemeral-vm-runtime-extend.test.ts:23` mocked `./ipc/runtime-environments`, a path that stopped
  existing in upstream's module reorganisation (`1938bd055a`, #30362) — the code imports
  `./ipc/runtime-environments/runtime-environments` (`ephemeral-vm-runtime-extend.ts:16`), and the
  directory has no `index.ts`, so the mock was inert and the real module loaded with everything it
  reaches. That is how a registry-mock gap surfaced thirty frames away. The mock now names the module
  the code imports.
- The `TypeError: {} is not iterable` rejections were **not** the mock at all:
  `src/renderer/src/hooks/ipc-events/ephemeral-vm-reclaim-ipc-bridge.ts` iterated whatever
  `api.listRuntimes()` answered from a fire-and-forget start caller, and `2368ed38da` made a non-list
  answer mean "nothing to reconcile". The recorded sentence welded the two because they appeared in
  the same run.

Both files are this fork's own (`902955072a` is fork PR #81 and is not in `upstream/main`), so there
was nothing to send upstream, contrary to the issue's premise.

Two local prerequisites decide whether a run's failures are real, and both are install artifacts:
`mobile/node_modules` (without it the mobile type-aware pass reports upstream's own files) and the
pinned Playwright browsers (`node node_modules/playwright-core/cli.js install chromium webkit` — the
`playwright` bin on `PATH` downloads a different revision than `playwright-core/browsers.json` pins).

Maintenance: this file stays the evidence, the JSON stays the assertion, and an entry changes in the
same commit as the red set. An entry that passes is reported stale; an entry that does not appear in a
run is reported unseen, which is the prune signal for one observed once and never reproduced. Prefer a
`test` title over a file-level `*` as soon as the failing name is known — a file-level entry also masks
a new failure inside that file.

### `local(test)`: the unit-gate verdict fails closed, and caches only what it can prove (#150)

`local/gate-unit.mjs` decides whether a PR may open, and #150 found it could report a PASS it never
earned. Three of its five items had already landed when this branch was cut: item 1 (the cache
directory in a linked worktree, where `.git` is a file) in #160, the dirty-verdict half of item 3 in
#177, which also extracted `local/gate-verdict-cache.mjs` so `gate-unit` and `open-pr` read the same
cache, and the missing `closeSync` import plus the judgement module and its tests in #178. What this
branch adds is the rest of items 2, 3 and 4.

**Vitest's exit status is read.** `runSuite` already returned `status` and `evaluate` only ever
consumed `elapsedMs`, so a non-zero exit that the report did not explain still passed. The issue's
phrasing — "a run that dies after writing no report" — is not quite the base's failure mode: a run that
writes no report already failed, and a preparation step that never started already read as `failed`
because a null status satisfies `status !== 0`. What was never read is the status itself, so a run that
wrote a clean report and then exited non-zero was green, and a suite that never spawned read as
`complete` until the missing report caught it one line later. The rule is the CI twin's: a non-zero exit fails the gate
only when neither the report nor the log explains it (`unexplainedSuiteExit`, in
`local/unit-gate-judgement.mjs`). Two smaller tightenings went with it: the declared-vs-read unhandled
count is `!==` rather than `>`, matching `check-unit-shard-verdict.mjs` — a log that yields more
headlines than Vitest declared is a moved log shape too — and a step that could not be spawned now
names the step instead of reading as `failed`.

The limit is worth stating, because it is the one part of item 2 left open: a run that writes a
_partial_ report and exits non-zero still has failures for the exit to explain, and every red-set run on
this machine has allowlisted failures, so `unexplainedSuiteExit` fires only for a run with no failure
and no unhandled error at all. Catching the partial case means comparing the report's totals against the
files it lists, which Vitest does not keep consistent enough to fail a PR over.

**What is recorded, and what is reused, is a decision with a reason.** `--no-cache` forces a re-run
_and still records it_ — the only way a stale or environmental FAIL in the cache can be replaced — and
it does not parse the cache file, so it stays the way out of a damaged one. `--allow-dirty` neither
reads the cache nor records, because both would answer about the tree rather than HEAD; forwarded
selectors record nothing either. Before writing, the gate re-reads HEAD and the tree: the suite takes
twenty minutes, and a commit or edit made in that window would otherwise be recorded as a verdict on
the revision it replaced.

**A verdict says what it was computed against.** The cache file name stays `(revision, allowlist)` — the
path `open-pr` and `gate-unit` both derive — so the gate inputs live _inside_ the record: `gateInputs`,
a `gateInputsFingerprint` over `GATE_INPUT_PATHS` (the gate script, its coupling module, the shared cache
module, the shard-verdict parser, `config/.bun-version`) plus the installed node and bun versions. The
machine-bound `sqlite-binding` and `host-toolchain` classes depend on exactly those, and a bun upgrade
moves them without moving HEAD. `gate-unit` re-runs on a mismatch and `open-pr` refuses the stale verdict
with that reason, fingerprinting the inputs at the commit as it already does for the allowlist. A record
with no revision, or from a gate that never wrote `gateInputs`, fails closed.

**A forwarded selector cannot be quoted as gate 1.** `-- <vitest args>` still runs — it is the useful
way to iterate — but `formatVerdict` (shared with `open-pr`, which quotes it back into a PR body) now
carries `partial: -- <args>` and `NOT a gate-1 verdict: forwarded selectors ran a subset of the suite`.

**A flaky pass is waived only when nothing coupled to the test changed.** The per-test isolated re-run
from #178 stayed a real signal, but the waiver asked only whether the _test_ file was in the diff, so a
branch that changed `src/x.ts` and broke `x.test.ts` one run in ten was waived as "not ours".
`local/gate-flake-coupling.mjs` (split out to stay under oxlint's 600-line budget) couples a test to
itself, the module it sits beside, its imports (one level, relative or `@renderer/`/`@`), and the whole
harness: `SHARED_TEST_INPUTS` plus whatever `config/vitest.config.ts` and `config/scripts/run-vitest.mjs`
import (`sharedHarnessPaths`). The derived half is the fix for the first hand list, which missed the
node-runtime pool, the runtime sequencer and the runtime file set — precisely the files a branch that
re-seats PTY tests would change, which is the harness change no test file names in its own imports. Two
harness inputs are not imports the parser can see and are listed by hand: `config/dark-build-switches.cjs`
(loaded through `createRequire(import.meta.url)(…)`) and `src/packages/process-host/` (the runner's one
bare workspace import, coupled as a directory so any file in that package counts). A diff that cannot be
resolved is never waived. A per-test row that passed its isolated re-run and was still refused says so in
the summary — `FLAKY in isolation, but <file> is in this branch diff` — so a coupling it did not expect is
visible instead of reading as a plain UNEXPECTED failure.

Limits, recorded rather than hidden: imports are followed one level, and a workspace-package specifier
(`@orca/…`) other than process-host is skipped rather than guessed. Each can only waive a flake a branch
caused, never refuse one it did not.

**The setup-file half of that list is derived, not copied (#315).** `SHARED_TEST_INPUTS` spreads
`UNIT_SETUP_FILES`, and the match also asks `isUnitRuntimeEntryPoint` — the shard selector's own rule,
which is what couples a setup file before the list learns it. Neither is duplicated: the list stays in
`config/scripts/ci/unit-selection/dependency-graph/ci-unit-files.mjs` and the predicate stays in
`config/scripts/ci/unit-selection/ci-unit-selection.mjs`, whose only fork edit is the word `export` on
that one line — nothing moved, so an upstream edit to the regex still merges cleanly. The hand copy had
fallen three setup files behind (`vitest-real-agent-cli-guard.ts`, `vitest-inherited-git-env-setup.ts`,
`vitest-orcad-feature-readiness-reset.ts`), which is the wrong direction for this rule to be wrong in: a
branch that edited one of them had its own load-only failure waived as "FLAKY, not ours".
`local/sync/lib/smoke-select.mjs` asks the same `isSharedHarnessPath`, so its harness report names the
same paths the waiver refuses (the waiver additionally narrows a scripts-only `package.json` diff, which
is a judgement about the diff rather than about the path). Both upstream files are gate inputs
(`GATE_INPUT_PATHS`), so a tree whose answer differs from the commit's — an in-progress sync,
`--allow-dirty` — does not reuse a verdict computed against another list or another regex.

**Tests.** `tests/tools/gate-unit.test.mjs` (24 cases) covers the fail-closed rules, the record and reuse
decisions, the summary line and the coupling rule, and pins the derived harness list — a superset of
`UNIT_SETUP_FILES` plus a runtime entry point the list has not learned — so the list cannot go stale
silently again; `tests/tools/open-pr.test.mjs` gains the case its
fixtures needed for the gate-inputs contract. #178 had already added `tests/tools/unit-gate.test.mjs` for
the judgement module, so those cases are not duplicated here.

### `local(ratchets)`: `pnpm lint` was red on `main` (#161)

`pnpm lint` failed on this fork's own default branch. The ratchets that failed are upstream's
(`config/scripts/check-*.mjs` and their baselines are present on `upstream/main`, and no script is
modified here), but **the offending call sites are all this fork's own code** — checked against
`upstream/main`: it has no `relocateRepoPath`, no `project-folder-relocation.ts`, no hidden-host
section in `SshTargetList.tsx` and no cached-listing host gate. #161 read the three as foreign because
they look like upstream files failing; the distinction decides fix-versus-allowlist, so it is worth
being precise: there was no upstream copy to wait for, and fixing them costs no sync. Each is a real
defect, so each is repaired rather than baseline-hidden. A fourth drift the issue could not see has
its own section below (the workspace-record baseline); it is the only one of the four that touches a
baseline, and it adds fork-owned rows rather than allowing an upstream one.

**A repo relocation addressed its row by bare id** (`check:id-only-store-write-ratchet`).
`relocateRepoPath(id, newPath)` resolved `state.repos.find((candidate) => candidate.id === id)`, and a
repo id can be published by two execution hosts — so with one id registered on two hosts, a
primary-checkout relocation rewrote whichever row came first, moving a path that belongs to one
machine. It now takes `RepoHostTarget` and resolves the row through `findRepoRowForHostScopedWrite`,
the gate `updateRepo` already uses (and which reports a host mismatch instead of returning the same
silent `null` as a deleted row). `RelocationDependencies.setRepoPath` lost its `repoId` argument with
it: the plan's own row is in scope at the only call site, so the id was a second, weaker spelling of
the same target.

**A repo row's SSH host was read off the raw `connectionId`** (`check:repo-host-read-ratchet`). Both
sites are hardening rather than a behaviour change, and the two are worth keeping distinct from the
fix above. A row may name its host only as `executionHostId: 'ssh:<target>'`, which a raw read answers
as local:

- `register-worktree-catalog-handlers.ts` already refused those rows a line later through
  `getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID`, so no listing was served from the wrong
  machine. The raw read was also fully redundant: `getRepoExecutionHostId` folds `connectionId` in
  already, so the two conditions in that gate were one question asked twice — and only the weaker
  spelling could disagree with the row's own host stamp. It now goes through `isRepoOnCatalogHost`,
  the strict gate the orcad migration paths already use, which asks the question once.
- `runtime-repository-relocation-controller.ts` passed the raw `connectionId` to
  `getRepoDefaultBranchName`, so an `ssh:`-only row resolved the default branch with a local `git`
  spawn against a path this machine cannot read. The plan refuses a remote row
  (`planPrimaryCheckoutRelocation` → `remote-host`) before that name is used, so the observable effect
  was the wasted spawn and a null branch — but the lookup was one ordering change away from naming a
  project folder from the wrong checkout. It now passes `getRepoRoutingConnectionId(repo)`.

**The hidden-host section drew a card per host** (`check:host-list-render-ratchet`). Hidden hosts are
exactly the ones `~/.ssh/config` keeps re-importing, so that section grows with the config and was the
only host list on the screen drawn outside a window. It now draws a bounded page through
`boundHostList` from `components/host-picker` — the function `useBoundedHostRows` wraps, used directly
because this section has no query of its own: `SshPane`'s filter above already narrows the targets
before the list sees them, and a second box inside the section would AND with it. 13,692 hidden hosts
therefore mount 50 rows plus a "more hosts" note, and nothing is computed while the section is closed.
The pane's filter is also passed down as the ranking query, so typing a name that 60 other hosts share
as a prefix still puts the exact host first instead of showing the first 50 in input order.

### `local(ratchets)`: the fourth lint drift, and the workspace-record baseline

Behind those three in the chain sat `check:workspace-record-read-ratchet`, which the issue could not
see for the same reason (`pnpm lint` never reached it). This one is the fork's own code against an
upstream ratchet, like the three above, so it is repaired where the code is ours:
`jira-issue-workspace-open.ts` and `worktree-pr-comment-inline.ts` read through
`workspace-record-selectors.ts` now, and the two store slices are added to the baseline under the
convention it already uses for writers — `hydrate-cached-worktrees.ts` hands the slice it rewrites to
the merge,
and `worktree-rename-across-hosts.ts` computes the next slice for every host publishing the row. The
row for `useDashboardPopoutBridge.ts` was pruned: that file no longer exists, and the ratchet fails on
a row it cannot reproduce until it is. Three baseline lines in
`config/workspace-record-read-baseline.txt` therefore belong to this fork — the evidence for them is
this paragraph, as with the red sets.

### `local(ratchets)`: an upstream file the fork only fixes keeps its shape

`check:max-lines-ratchet` says to split an oversized file rather than suppress the rule, and for this
fork's own files that is right. It is wrong for an upstream-owned file the fork touches only to clear
a red: the split moves code upstream still owns into a new module, so every later sync carries a fork
hunk in the middle of a file upstream keeps editing — a merge cost paid forever to save three lines.
The rule is therefore scoped by ownership, not by size:

- **Fork-owned file over budget** — split it. `src/renderer/src/components/jira-issue-workspace-side-data.ts`
  is the 2026-11-09 example: its two side reads now share `runGuardedSideRead` in
  `src/renderer/src/lib/guarded-side-read.ts`, which also removed the duplicated guard shape.
- **Upstream-owned file over budget after a fix-only change** — keep upstream's shape and record the
  row in `config/max-lines-baseline.txt` (whose header now says so). `ai-vault-session-refresh.ts` is
  the case: 303 code lines after the React Compiler fixes, with upstream's three inline
  `cancelListSessions` calls and its own `if` left exactly where upstream wrote them. The suppression
  comment and the baseline row both name it, and the row is the record — not a quiet allowance.

**The compiler fix moves comments, and the comment counter reads a move as an addition.**
`check-upstream-file-comments` diffs against the sync base, so wrapping a try/catch/finally into a
module helper relocates every fork comment inside the block and each one counts as newly written —
`use-checks-panel-manual-refresh.tsx` (9) and `ai-vault-session-refresh.ts` (10, of which two are the
max-lines suppression above) cross their maxima with no new prose at all. The commit's own prose was
deleted rather than recorded: the six `Why` lines it had added to `DiffViewer.tsx`,
`useFileExplorerVisibleRowProjection.ts` and `ai-vault-session-refresh.ts` are gone, and the reason for
the whole class lives in this paragraph instead, which is the #267 precedent. The two moved-comment
rows and the total they sum are recorded in `local/lint-known-red.json` with the evidence and pruned
at the next re-baseline.

Anchors: `config/max-lines-baseline.txt` (header + the `ai-vault-session-refresh.ts` row),
`src/renderer/src/components/right-sidebar/ai-vault/scanning/ai-vault-session-refresh.ts` (the
suppression and its reason), `src/renderer/src/lib/guarded-side-read.ts` (the fork-owned split).

### `local(lint)`: the lint verdict is a file too

Reds on the base branch have had to be hand-verified as pre-existing in an unrelated PR (#160, then
#161 itself), and one of them was invisible because `pnpm lint` is a single `&&` chain that stops at
the first failure and says nothing about the other 31 steps. That is the same shape the unit suite had
before `local/unit-known-red.json` and `local/gate-unit.mjs` turned its red set into a verdict.

So the lint chain gets the same shape: `local/gate-lint.mjs` reads the steps out of `package.json`'s
`lint` script (never restates them, so a step a sync adds is run instead of skipped, and a step a sync
removes turns its entries stale), runs each one on its own exactly as `pnpm lint` would, and classifies
every failure against `local/lint-known-red.json`. A recorded failure is reported with its class and
owner; a failure outside the list fails the gate; a recorded failure that stops reproducing is reported
stale and `--prune` drops it. Each ratchet prints one line per offending entry, so an entry can carry a
`match` regex that allowlists that entry alone instead of the whole step — a whole-step entry also
masks a new failure inside it, and only a whole-step entry may cover a step whose output the parser
could not split.

**Known red as of the 51c77320bc sync.** `check-upstream-file-comments` fails on the base commit
`f4337166d22` with no changes from any branch — a detached worktree there measured 5414 fork comment
lines against its 5269 baseline. The sync re-baselined the per-file maxima but not the total its own
resolution added, and it renamed files the older entries pin (`git/worktrees/removal/*`,
`ai-vault/transcripts/*`, `filesystem/host-tree-removal.ts`), so those rows no longer line up with
their files. The entry pins the exact total, so any further growth is a new red; the real fix is a
re-baseline with `--init --accept` in the sync that caused it, or moving that prose into this file.

It is fork-local: upstream keeps `pnpm lint`'s exit code and CI is unchanged.
`tests/tools/lint-gate.test.mjs` covers the chain reader, the per-step failure split and the
classification. There is no per-revision cache, unlike `local/gate-unit.mjs`: the whole chain is
~100–160 s, and a cached verdict would outlive the edit it was computed against. The list was
**empty** from 2026-10-29, when its two entries were fixed in the tree rather than allowlisted (see
`local(lint)` below), until the 2026-11-08 sync recorded six (next section). It is the place a red on
the base branch gets recorded with its evidence instead of being re-derived by hand.
This file stays the evidence and the JSON the assertion, as with the unit red set.

### `local(lint)`: three ratchets red on `main`, re-recorded where they had shrunk

`pnpm check:changed` on `main` was red on three ratchets that no fork commit had touched:
`direct-link-open`, `react-compiler-compat` and `main-blocking-api`. The upstream base
(`0c6207e3d7`) is green on all three, so the drift arrived with the sync and was never
re-recorded. Two of them had only shrunk — upstream removed direct-link opens and React
Compiler bailouts, and the baselines kept the old allowance — so `--prune` /
`--update` records the lower numbers and nothing else changes.

`react-compiler-compat` also grew in three files the fork owns: two lifetime effects keep an
`oxlint-disable-next-line react-hooks/exhaustive-deps` because the dependency array _is_ the
signal that re-runs the effect (the body reads refs only), and `useCreateProjectDefaults`
reads one more ref during render than it used to. `--update` is that ratchet's own path for a
reviewed exception, and these are the exceptions: the disables say why on the line, and the
ref count is the fork's `runtime-create-parent` extraction, not a new pattern.

**Left red on purpose: `main-blocking-api`'s sqlite category.** The fork's AI-vault paging work
(`ai-vault-search/session-search-list.ts`, and `session-search-instance.ts` importing the store)
put upstream's worker-only sqlite on **orcad's** event loop, because orcad installs the search
in process. That is 12 files and ~150 synchronous uses, so it is a code fix — run orcad's search
through the session-search worker, or keep the store out of the module orcad loads — and not a
baseline row. Recording it would silence the ratchet that exists to catch exactly this.
**Resolved 2026-11-25** in the code, as asked: see the next section.

### `local(lint)`: `main-blocking-api`'s sqlite category fixed in the code, two pre-ratchet rows adopted

`check:main-blocking-api-ratchet` was red on an unchanged `main` (767c078) with 13 sqlite findings.
Upstream `7daf01d99f3` is green. The fork's tree was red before that sync too (`1db15d9ff09`,
2026-11-19), so the fork's own code put them there.

- **Session search, 11 files, fixed in the code.** `SessionSearchInstance`, which orcad installs in
  process, now holds no connection. The writer thread records content consent when it opens the index
  (`open` carries `contentEnabled`), and Agent Session History's list is a reader-thread `list` op that
  reads every page in one request. A list the readers fail, such as one a settings change retires,
  answers null, so the caller falls back to the scanner as before. The worker side is
  `worker/session-search-worker-instance-ops.ts`. `removeSessionSearchDatabaseAsync` moved from
  upstream's `storage/session-search-schema.ts` to `storage/session-search-database-removal.ts`, so the
  instance no longer imports the opener. That takes upstream's `session-search-schema.ts` out of orcad's
  graph too (a `0` overlay row).
- **Two pre-ratchet rows adopted**, both fork #238 (2026-10-29), which predates the ratchet's arrival
  in the fork (upstream #41263, 2026-11-15 sync):
  - `parse-cache/session-parse-cache-database.ts` at 27 (+7, the parser-version stamp). Its SQL runs
    only in the scanner child, because the database opens behind `owner`, set only by
    `initSessionParseCachePersistence`.
  - `orchestration/db/schema/migrate.ts` at 1, the pre-DDL `user_version` read. It does run on main,
    once per orchestration DB open. Upstream's own `migrate()` reads the same pragma uncounted.
  - The deeper fix for the first is to move parse-cache's configure/get into a SQL-free module. That
    would also clear upstream's 20 and the helper overlay's 12.
- **Overlay, not base rows:** the ratchet gained the helper ratchet's one `overlayPath:` line, so
  `config/main-blocking-sqlite-baseline.txt` stays upstream's bytes. Rows that dropped out were pruned:
  11 from the helper overlay (one is now `0`) and `session-search-list-schema.ts`'s main-sync-fs row.

Anchors: the `overlayPath:` line in
`config/scripts/static-analysis/ratchets/runtime-lifecycle/check-main-blocking-api-ratchet.mjs`;
`config/main-blocking-sqlite-baseline.fork.txt`; the moved function, a sync-conflict hunk in upstream's
`storage/session-search-schema.ts`. Upstream files that diverge further:
`session-search-instance.ts`, `indexing/session-search-indexer.ts`,
`worker/session-search-{readers,worker-entry,worker-protocol,worker-store-base}.ts` and
`scan-service/session-scanner-service-search.ts`. Tests:
`src/main/ai-vault-search/session-search-instance.test.ts`.

### `local(lint)`: the 2026-11-08 sync's lint gate — 14 red steps, what moved and why

The merge of upstream `51c77320bc` (1537 commits, merge `5a02a4c8406`) left `gate-lint` at 14 failing
steps with 201 new reds. Upstream's owner-scoped tree move is the main cause: every ratchet baseline is
keyed by path, so a moved file shows up twice. Each step was handled as follows.

- **`check-upstream-file-comments`** — re-measured against the new merge base. The total fell
  6011 → 5413 and was pruned. Upstream's moves re-keyed ~96 per-file maxima, and those were accepted
  with `--init --accept`. **Not accepted:** growth the pre-sync tip `3f8bbfb269e` already carried
  against its own baseline, measured at 6161 against 6011: 23 files and 125 lines over their maxima.
  #277, #281, #283/#286, #287 and #295 added it after the last re-baseline (#273) without `--accept`.
  Those files keep their pre-growth maxima, and the total is 5269, excluding the 144 such lines still
  in the tree (6 left with a test upstream deleted). They stay red, and `local/lint-known-red.json`
  records them per owning PR. Each match pins the exact count, so any further growth is a new red.
  To clear them: move the prose here or into a fork-owned module (#267's precedent), or accept it.
- **`check:focus-read-ratchet`** — this growth was real, and it is fixed in the code rather than
  allowed. The resolution imported the fork's owner-routed `getJiraRuntimeTarget` under upstream's
  name, `as rowLessSourceTarget`, in `runtime-jira-client`, `-summary-client`, `-user-fields-client`
  and `jira-collection-read-actions`. The ratchet seeds on that name, so it counted every call, and
  every caller became a transitive reader: 35 reds. The calls now use the real name, and every Jira row
  is back to its pre-sync fork count. `--prune` re-keyed the moved overlay rows, and the reasons it
  dropped are restored. One row was added: `store/slices/store-test-helpers.ts` at 8, the fork's kept
  copy of a helper upstream renamed (`c231b5d7da8`, now `store/testing/app-store-test-fixture.ts`).
  Four fork tests still import it, and it has the same count as before the sync.
- **`check:workspace-path-sync-fs-ratchet`** — four rows re-keyed to their new paths with the same
  counts. `git/huge-folder-ignore.ts` is fixed rather than baselined. Upstream's rewrite turned
  `existsSync(full)`, which the lexical gate cannot see, into a visible
  `existsSync(path.join(worktreePath, name))`. The `stat` that follows already answers that question
  asynchronously, so the sync probe is removed.
- **`check:flaky-test-pattern-ratchet`** (the `lint:ast-grep-gates` rows) — four `0` overlay rows
  re-keyed by `--prune`, with reasons added.
- **`check:path-literal-ratchet`** — `vitest-node-runtime-files.mjs` named three tests upstream deleted:
  `git-command-timeout-behavior` (#38233), `shell-startup-feature-channel` (#38943) and
  `JiraIssueWorkspace.transition-source` (`c10881fa8c8`). The entries and their comment blocks are
  dropped. Note that #155's Node-only regression test went with the first of these.
- **`verify:localization-coverage`** — the allowlist's `object-property:error` "Error" row followed
  `TIMELINE_KIND_LABELS`, which #281 moved from `session-summary-ledger-view.tsx` to
  `session-summary-evidence-view.tsx`.
- **`check:code-quality:changed`** — whole-step known red, stale after the push. Until `main`
  is pushed, `origin/HEAD` is the pre-sync tip. The "changed" set is then upstream's 1537 commits
  (25,053 code files), and `spawnSync` fails with `E2BIG` before reporting anything. The runbook's
  sync-sized form against `upstream/main` reported 96 findings on 72 distinct lines, and every one of
  those lines is present verbatim in the pre-sync tree. The post-merge fix-ups ran clean under
  `ORCA_CODE_QUALITY_BASE=HEAD` (19 files).
- Fixed in the tree, no baseline involved:
  - `check:test-file-runners`: the merge dropped `pane-screen-prompt.spec`'s import when
    `orca-runtime.test.ts` moved to `construction/`, so the spec stopped running. Restored: 600 tests
    pass.
  - Generated artifacts regenerated: `verify:localization-catalogs` (protected-copy keys) and
    `verify:skill-bundle-manifest` / `verify:bundled-skill-guides` (the fork's `orca-computer-use`
    stub).
  - `lint:ast-grep-gates`: the fork's path-index worker now spawns through upstream's
    `spawnWorkerThread`, and upstream's new `PluginAuthor` link declares `data-link-url`.
  - `check:workspace-record-read-ratchet`: `use-workspace-copy-target` reads through
    `selectWorktreesByRepo`.
  - `check-upstream-identity-literals`: upstream's new `updater.check-failure` test now names the
    fork's feed.
  - `audit:code-quality:native`: nine duplicate imports the resolution re-rooted onto one module are
    merged.

### `local(lint)`: the 2026-11-20 sync's lint gate — three upstream ratchets arrive, one inherited red

The merge of upstream `0c6207e3d7` (1425 commits, 579 fork commits replayed) left `gate-lint` at 10
failing steps and 19 new reds. Nine of the ten steps are green in the tree; the tenth is the
`check:code-quality:changed` entry this gate carries until `main` is pushed.

- **Three ratchets are new in this sync** — `check:main-blocking-helper-ratchet`,
  `check:whole-hot-map-selector-ratchet` and `check:workspace-path-sync-fs-ratchet` had no baseline in
  the pre-sync tree (`config/main-blocking-helper-baseline.txt` and
  `config/whole-hot-map-selector-baseline.txt` arrive from upstream; the workspace-path script and its
  baseline are the fork's own). Their reds are therefore not regressions from the resolution: they are
  fork code and inherited upstream code that no gate has looked at before. Upstream's own tree at
  `0c6207e3d7` passes the first two (verified by running both collectors in a detached worktree there),
  so every row below is the fork's.
- **`config/main-blocking-helper-baseline.fork.txt` — 140 rows.** The charge is not the credential
  stores themselves: it is the fork's data-path layer. `src/main/home-directory-migration.ts`
  (`local(identity)`: Orca NP's own home directory) resolves its location with `existsSync`, as do
  `agent-hooks/official-orca-profile.ts`, `jenkins/jenkins-server-store.ts`,
  `claude-accounts/claude-oauth-pending-rotations.ts`,
  `shared/ephemeral-vm-provisioning-attempts.ts` and `ipc/project-folder-placement.ts`, so every store
  built on them is charged and every second-hop caller is charged again. 79 of the 140 rows reach
  through the first alone. Fixing it is a refactor of the identity layer (split pure path getters from
  the sync probe), not a sync fix, and it cannot be verified here without the suite — so the rows are
  the record, with the class stated in the overlay's header, exactly as `local(ratchets)`: the fourth
  lint drift recorded its three `workspace-record` rows. The ratchet still ratchets: a new caller of a
  blocking helper is a new red.
- **`config/whole-hot-map-selector-baseline.fork.txt` — 4 rows**, both consumers genuinely needing the
  whole map: `useWorktreeIdsWithEmptySurface` scans every workspace to compute which are empty, and
  `useConfiguredExecutionHostOptions` builds the registry of every configured host. The rule's own
  escape (`oxlint-disable-next-line`) would hide the call from the ratchet instead of counting it, so
  the row is the better record. Both files are fork code that predates the sync.
- **Two overlays instead of rows in the base files.** Both base baselines are upstream's and this fork
  keeps them byte-identical; `readCountBaseline` already takes an overlay (`local(ratchets)`, the
  focus-read rows), so each script gained one `OVERLAY_PATH` constant and one `overlayPath:` line. A
  row appended to an upstream baseline is a conflict on every sync; a fork-owned file is not.
- **`check:workspace-path-sync-fs-ratchet` — 6 rows in its own baseline**, all six files byte-identical
  to upstream's copy: the CLI sign-in folder probe in `bot-tool-secret-scrub.ts` and
  `rpc/methods/bots-tools.ts`, the `<folder>/.git` probe in `bot-tools-host.ts`, the
  `repo.path`/`worktreePath` pair in `bot-work-runtime.ts`, the disk-usage worker's `realpathSync`, and
  `realpathSync.native` in `qwen-code/workspace-trust.ts` (#44046). Fork-only edits to upstream files are
  a permanent merge cost (`local(ratchets)`: an upstream file the fork only fixes keeps its shape), and
  none of these is reachable from the fork's own side.
- **`check:process-host-imports` / `check:import-boundaries`** — four stale rows, dropped. Upstream
  moved `macos-computer-use-permission-status.ts`, `git-stream-stdout.ts`, `memory/collector.ts` and
  `macos-tailscale-dns-diagnostic.ts` off the direct `child_process` import. The second step runs the
  first, so it was the same four reds.
- **`check-upstream-file-comments`** — re-taken with `--init --accept` at **5115**, after trimming
  `service-credential-read-account-switch.test.ts` from 7 fork comment lines to 4 (it carries no
  per-file maximum of its own): the mock block's two-line "why" is one line, the Copilot note is gone,
  and the Retry-After note keeps its point in two. Nothing else moved — `--init` rewrote only `total`,
  `base` and `accepted`, and the 341 per-file maxima are unchanged, so the growth the 2026-11-08 sync
  deliberately kept out of the baseline is still out.
- **`audit:code-quality:native`** — one duplicate import in `BotHoverDetails.tsx`, merged.
- **`audit:code-quality:type-aware`** — three `await-thenable` warnings in the fork's host-sync
  credential ports, where `map((port) => port.list())` hands `Promise.all` a list the type says is not
  thenable. The ports answer directly or through a promise by design, so the mapper is async; awaiting
  a plain value is still what the caller wants.
- **`lint:ast-grep-gates`** — five `link-affordance-declares-url` errors, fixed by declaring
  `data-link-url` on each element rather than suppressing: `NativeChatConnectorAskerTag`,
  `GoogleAddServiceDialog` (which now computes its URL once), `AntigravityChatApiKeyField`,
  `BotUpNextSection` and `BotMemoryList`.
- **`check:code-quality:changed` — recorded, not fixed.** `origin/main` is still the pre-sync tip, so
  the changed set is upstream's 1425 commits plus the replayed 579, and
  `check-changed-code-quality.mjs` `spawnSync` fails `E2BIG` before it reports a single finding
  (measured 2026-11-20 in `/Volumes/Storage/Code/orca/main`). That is the whole-step entry in
  `local/lint-known-red.json`; the post-merge fix-ups ran clean under `ORCA_CODE_QUALITY_BASE=HEAD`,
  and the entry goes stale on the first run after `git push origin main`.

Anchors: `config/main-blocking-helper-baseline.fork.txt`,
`config/whole-hot-map-selector-baseline.fork.txt`, the two `OVERLAY_PATH` constants,
`config/workspace-path-sync-fs-baseline.txt` (6 rows), `config/process-host-direct-import-baseline.txt`,
`local/upstream-file-comments-baseline.json`, `local/lint-known-red.json`.

### `local(lint)`: the 2026-11-24 sync's lint gate — four prunes, one unrecorded overlay, one accepted comment

The merge of upstream `7daf01d99f3` (1350 commits) left `gate-lint` at 5 failing steps and 14 new reds on
`0705cff5d05`. No check was loosened and no red was recorded in `local/lint-known-red.json`; each was
repaired at its cause and re-measured with the step's own tool.

- **`verify:localization-catalogs`** — real drift, and the only one the gate could not name: it exits on
  the first failing step, so the summary showed the `[ELIFECYCLE]` line alone. `ko.json` carried two
  upstream keys that the fork's own tombstones already retire (`auto.runtime.jira.transitionFieldsNeedsUpdate`
  and `auto.main.window.dashboard.popout.window.title`). `fork/ja.json` and `fork/zh.json` had both, as did
  `fork/en.json`; `fork/ko.json` had neither, so the tombstones never reached Korean and the merge left
  upstream's translations in place. The fix is the two tombstone children in `src/renderer/src/i18n/fork/ko.json`
  — the same entry every other locale already carries — not a deletion of the upstream key and not a
  regeneration.
- **`check:focus-read-ratchet` / `check:workspace-path-sync-fs-ratchet` / `check:main-blocking-helper-ratchet`
  — shrunk, so pruned.** The sync removed the focus read in `use-window-list-model.ts` (upstream moved the
  default-creation-host resolution out of it), one workspace-path probe in `workspace-hooks/hooks.ts`, and ten
  blocking-helper call sites across the codex/droid/ipc/native-chat/session-summary trees. `--prune` on each
  step is that step's own path for a shrink: focus 610 → 609, workspace-path 23 → 22, blocking-helper
  6451 → 6441 before the raises below.
- **`config/main-blocking-helper-baseline.fork.txt` — eight rows raised, all with a trailing `# why`.**
  Pruning the ten shrunk rows left eight files _above_ their allowance, and every one is this class: the
  fork's graph reaches a helper upstream's new code calls. Five belong to the fork's in-process session
  search — upstream `#46549` added a compaction pass whose SQLite calls are helpers, so
  `session-search-{index-compaction,index-writer,retention-delete,store,tool-purge}.ts` are charged for
  calling them, and upstream runs that store in its session-search worker while the fork installs the search
  in process (`LOCAL-PATCHES.md`: main-blocking-api's sqlite category, 2026-11-08). `session-search-store.ts`
  also carries the fork's own `readSessionSearchContentConsent`. The other three are upstream code charged
  through the fork's identity-layer probes: `droid/droid-hook-config-files.ts` (#47853) and
  `cursor/hook-service.ts` through `createManagedCommandMatcher` in `agent-hooks/official-orca-profile.ts`,
  and `perf-notices/perf-notice-signals.ts` through `getWorktreePathSettings` in
  `ipc/project-folder-placement.ts`. The overlay's header records the class; the base file stays upstream's
  bytes.
- **`check-upstream-file-comments`** — re-taken with `--init --accept` at **4764**: the merge moved the
  titlebar-exclusion set into `VIEWS_OWNING_CONTENT_HEADER` in `src/renderer/src/app-shell/AppWorkspaceShell.tsx`,
  and its 6-line comment records why automations and artifacts stay out of it (they rely on that stripe for
  the window-controls band, upstream #47038). The set is not derivable from the code it guards, so the
  comment stays and the total is re-taken against the new merge base rather than trimmed. `--prune` refuses
  a raise by design, so it runs only in the shrink direction.

Anchors: `src/renderer/src/i18n/fork/ko.json` (the two tombstones),
`config/main-blocking-helper-baseline.fork.txt` (header + the nine raised rows),
`config/focus-setting-read-baseline.fork.txt`, `config/workspace-path-sync-fs-baseline.txt`,
`local/upstream-file-comments-baseline.json`.

### `local(lint)`: the 2026-11-26 sync's lint gate — five steps, one merge-diff artifact, two recorded exemptions

The sync landed 530 upstream commits and the five steps below moved with it. Four are closed in the
tree; the fifth is a measurement artifact of scoring a merge commit and is recorded in
`local/lint-known-red.json` with its evidence.

- **`check-host-mesh-upstream-seams`** reds at 18 lines against a budget of 2, and it is not this
  branch's: it diffs `merge-base(HEAD, origin/main)..HEAD`, and on a merge commit that range is the
  whole 530-commit upstream delta, so upstream's own rewrite of `rpc-method-registry.ts` (12+/6-) is
  charged to the fork. The fork's seam is exactly the two lines the budget allows —
  `git diff 3e227259249 HEAD` on that file prints one import and one spread and nothing else. The
  merge _had_ grown the seam to twelve by registering photon, host-settings and session-summary
  separately; all three are fork-only domains, so they moved behind `FORK_RPC_METHODS` and the seam is
  one import plus one spread again. The known-red entry pins that file and goes stale at the next push,
  where the diff base becomes upstream rather than the fork's old tip.
- **`check:main-blocking-helper-ratchet`** — the merge resolution took upstream's baseline file, which
  is correct for the base but dropped the fork's own rows for the photon, webhook and GitHub App stores;
  they are restored verbatim with their `# why` lines, and `bot-tools-file.ts` is raised 21 → 22 for
  `botLaunchExtras` (the fork's launch env reads the credential store once per launch). `--prune` then
  lowered 200-odd rows the merged tree no longer needs, six of them in the fork overlay.
- **`check:react-compiler-compat-ratchet`** — re-taken with `--update`: 14 rows up, 23 down, as both
  sides' renderer code met.
- **`check:process-host-imports`** — two stale rows dropped (the Tailscale diagnostic and the Gemini
  OAuth extractor are gone or clean).
- **`check-upstream-file-comments`** — re-taken at base `3e227259249` with `--init --accept`: +34 fork
  comment lines, every one a line a reviewer sees in the merge diff.

**Two max-lines exemptions, by the owner's decision on 2026-11-26.** `#466` left
`src/main/host-mesh/host-mesh-driver.ts` (721 lines) and `host-mesh-rpc-service.ts` (416) over the
300-line cap with `-- Why:` headers and no baseline row, so `pnpm lint` had been red on `main` since
that PR landed. Both are single large factory closures; splitting them under release pressure would
rewrite the sealed-offer/mesh protocol with no unit coverage at that granularity. The owner chose the
exemption: the rows are in `config/max-lines-baseline.txt` and `local/max-lines-exemption.test.mjs`
records the two paths by name, so the rule still fails any _new_ fork-owned row. **The split is still
owed** — these are the two rows the 2026-11-24 overlay note called "split pending", and they are the
only fork-owned exemptions in the tree.

Anchors: `config/main-blocking-helper-baseline.txt` (+10 restored rows) and its `.fork.txt` overlay,
`config/react-compiler-bailout-baseline.txt`, `config/process-host-direct-import-baseline.txt`,
`config/max-lines-baseline.txt`, `local/max-lines-exemption.test.mjs`,
`local/upstream-file-comments-baseline.json`, `local/lint-known-red.json`,
`src/main/host-mesh/fork-rpc-methods.ts`.

### `local(lint)`: two `fork-comment-ok` markers, and why they are not comments to delete

`src/main/runtime/agent-session/ownership/agent-session-process-identity-probe.ts` carries two of the
tree's markers. The comments are #268's; #266 added the markers when it removed that branch's other 14
fork comment lines to bring the total back to its 6051 baseline, and kept these two:

- above `darwinStartTimePsEnvironment` — `lstart` is local wall clock, the hour a US fall-back repeats
  resolves to the earlier offset, and a start time read there is an hour early. Measured 2026-11-01:
  a process started at 01:37 PST parsed to 08:37Z instead of 09:37Z. `readProcessStartTimeMs` decides
  whether an agent-session owner or a spawned provider process is still the same process, so the error
  is an hour of misidentification twice a year.
- above `parseUtcLstart` — the parser has to read the same zone the printer was asked for; splitting
  one from the other is the bug, and nothing at the call site shows the pairing.

Both reasons are invisible in the code they guard, and both are exactly the kind of note a later
cleanup deletes on its way to reintroducing the defect, which is why they stay above upstream's code
rather than in this ledger. If #268 is ever offered upstream, drop both markers from that patch — they
are fork tooling text, not upstream's.

### `local(lint)`: #267's review-switcher comments removed, and its three transitive focus reads recorded

#267 (`bc4afd9703`) added fork comments to 12 files upstream owns under
`src/renderer/src/components/right-sidebar/**`, and `check:focus-read-ratchet` gained three files at
1 read each. All of the comments were removed rather than marked: every one was prose above upstream's
code explaining a fork decision, and the fork's own modules (`workspace-review-selection.ts`,
`use-workspace-review-selection.ts`, `WorkspaceReviewSwitcher.tsx`) state the same design without a
hunk to resolve on every sync. The comment ratchet counts **118** of those lines — the diff deletes
**120**, because two are continuation lines inside a JSX block comment that the ratchet's line rule
does not count — and it measured **6062** at #267's parent, not 6051: #268's 11 lines were already in
the tree, and #266 removed them afterwards, which is the 6169 this branch carried before the fix. The
total is back to exactly 6051 with 0 stale entries, so no re-baseline was needed.

What the deleted comments guarded, kept here because each is a trap a later edit can fall into:

- **In Source Control the pick is display-only; in Checks it is operational.** Push target, PR
  creation, compare base and the provider hint keep resolving through the workspace's own review
  (`hostedReview`), and only the header's copy (`displayedReview`) moves — a picked review that reached
  those would retarget a push. The Checks pane is the other way round: `HostedReviewActions` gets the
  shown review, and a mutation's refresh goes to the pick first, so pointing those back at
  `hostedReview` would act on a review that is not on screen.
- **Never write `suppressedGitHubPR` for a pick.** It is one tombstone slot, so a pick's number would
  replace the tombstone of a branch PR the user already unlinked and let that PR come back; write it
  only when the shown review is the workspace's own. Omit the key rather than sending `null`, for two
  separate reasons: `null` is a write that clears the tombstone, and a negated `objectContaining`
  assertion still passes on it, so that test shape cannot see the clear.
- **Unlink removes the shown review's row, not the workspace's slot**, and clears the stored selection
  only when the pick is the row being removed. A slot-only clear leaves the row in `linkedItems`, so
  the review returns on the next read; for a pick it would also unlink the review that is not on
  screen. A pick with no row does nothing rather than falling into the slot path.
- **Checks-pane rows follow what it renders, not what is stored.** List only providers the pane has a
  checks/comment body for; check the row the header is actually showing (a pick whose lookup has not
  answered is listed but not shown); a pick's unlink needs a row to remove; and the AI triage strip is
  hidden for a pick, because those actions start an agent in _this_ worktree.
- **The switch effect and the tab-entry refresh have no test driving either.** Nothing under
  `right-sidebar/**` renders `useChecksPanelContextState` or
  `useChecksPanelEntryRefreshAndTitleActions`, so this bullet is their guard.
  - `use-checks-panel-context-state.tsx`, the effect keyed on the shown review: it must fire on a
    _change_, not on mount (`previousShownReviewKeyRef`), because a remount while the pick's cache
    entry is already warm resolves a pick on the first render, and without the guard that first paint
    clears rows and raises loading flags with no switch and no read in flight — those flags are
    otherwise written only by a manual refresh, so nothing would clear them; it clears the previous
    review's rows, because rows on screen belong to the review that was showing when they were
    fetched; and it raises the loading flags only for a pick, because the branch path owns them for
    its own review and raising them for a review with no PR number leaves a spinner behind.
  - `use-checks-panel-entry-refresh-and-title-actions.tsx`: tab entry — the pane's only periodic
    re-read of review metadata — and the post-mutation refresh both go to the pick first, and a picked
    MR also re-reads `fetchGitLabDetails` because its rows come from its own pipelines and threads.
    The branch path below names a different review, so falling through leaves the review the user just
    changed (title, merge, a resolved thread) stale.
- **A refresh's switch test is the store selection.** `refreshRequestKeyRef` is per-request, so a
  switch does not change it and `isCurrentRequest()` cannot see one at all; the result key cannot tell
  a switch from this review's own head moving, which the refresh itself causes. The store changes
  synchronously, so it is the only answer. Two clauses go with it, both pinned by
  `use-checks-panel-manual-refresh.test.tsx`: check the pick again after the awaited review read and
  before claiming `asyncResultKeyRef`, and compare the refreshed `pickedRequestKey` as a local, because
  `isCurrentAsyncResult` reads the ref and comparing the ref with itself always passes. Loading flags
  are cleared only while the pick is still shown, or a switch would blank the review the user moved to;
  the refresh latch is released either way.
- **A picked MR never goes through GitHub checks**, a picked review's reads pass no branch — the branch
  argument is what the store writes a PR's check status onto, and this branch's cached PR is a
  different review — and a pick's successful read must not `retractStalePRRefreshError`, whose error
  belongs to this branch's PR.

The three focus-read rows in `config/focus-setting-read-baseline.fork.txt` are the same shape as the
2026-10-16 `use-linked-issue-pane-actions.ts` one. `use-workspace-review-selection.ts` computes its
hosted-review request key through `getWorkspaceReferenceRuntimeVersion`, which folds
`getProviderRuntimeContextKey(null)` in — `null` is this app, not the focused host — and the fork
reuses the sidebar card's request key on purpose so a switch does not overwrite the branch's entry.
The ratchet counts the transitive call in that file and in the two panes that call the hook, so the
rows record it; restructuring reviewed code to dodge a regex would be the worse trade.

### `local(lint)`: the 2026-11-11 fork-comment re-take, and three focus reads recorded from #361

`node local/check-upstream-file-comments.mjs` was red on `main` at `dbb25491d3e` before this branch
existed: 5511 against a 5419 baseline, from 8 files. Measured in `/Volumes/Storage/Code/orca/main` at
that revision. #361, #363, #364 and #365 added fork comments above upstream's code without re-taking
the ratchet, and each one kept the previous baseline. The baseline is re-taken here with
`--init --accept` at **5507** — four below `main`'s 5511, because this branch's own comments above
upstream code carry `fork-comment-ok` and the ratchet counts none of them — and every file over its old
maximum now carries a frozen per-file maximum, so the drift can only shrink from here. Rebased onto
`f3086f3283c` (#366, the Skills/Mobile chrome) it was re-taken once more at **5515**: that PR added
eight lines in `mobile-page.css`, `SkillsPage.tsx`, `skills-page-column.ts` and
`use-skills-page-keyboard-navigation.ts`, again without re-taking the ratchet. The seven
`check-upstream-file-comments` known-red entries in `local/lint-known-red.json` were stale the moment
the baseline moved, and are pruned; the gate now reports `5507/5507, 0 stale`.

`check:focus-read-ratchet` is red on the same revision, and stays red here: measured in the same
worktree, it reports `use-settings-host-scope.ts` at 2 against a baseline of 0, `Settings.tsx` at 1
against 2, and `WorkspaceDirectorySetting.tsx` at 0 against 1. All three are #361's, which this branch
does not touch — two are prunable slack and one is a real new focus read in that PR's own hook. They
are recorded in `local/lint-known-red.json` with that evidence and the exact lines as matches, so any
new focus read in those files is still a new red. Clearing them belongs to a change that touches #361's
settings scope, not to an issue about the composer's run-target picker.

### `local(lint)`: the 2026-11-12 fork-comment total re-pin, from merges after #411

`node local/check-upstream-file-comments.mjs` on the release line at `80dcc0425` reports 5655 fork
comment lines against the frozen 5515. None of that growth is this branch's: it removed its own four
comment lines above upstream's code in `clone-defaults.ts` and `useCreateProjectDefaults.ts`, which
took the two per-file rows it had produced with them, and the total fell from 5660 to 5655. The
remaining 140 lines arrived through merges of other work (#411, #414, #415, #416, #418, #422, #424,
#425), 73 of them in the per-file rows already recorded and the rest in files under
`PER_FILE_THRESHOLD`, where the total is the only place growth shows. The `fork-comment-foreign-total`
known-red entry is re-pinned from `5648` to `5655` with that evidence, so any further growth is still a
new red. Moving that prose into this file or a fork-owned module is those PRs' change.

### `local(test)`: fork issue #151 — the allowlist names tests, runs the unit lane's file set, and has its own lane

`local/unit-known-red.json` had drifted into the two shapes its own note warns against: every entry was
file-level (`"test": "*"`), which also covers a _new_ failure in that file, and three named files the
gate should never have been running at all — upstream's own unit lane excludes them
(`config/scripts/ci-unit-files.mjs:18`, `:37` and `:51`). What changed:

- **31 named entries instead of 15 wildcards.** The names come from a reconciliation run over the
  allowlisted files, recorded in the JSON's `observedRun`, whose arithmetic closes at 38 records:
  31 allowlisted, 5 upstream-quarantined and 2 repaired. Tightening is safe by construction — a name
  matches exactly what the wildcard matched in that run — and it is what makes the next red in those
  files visible instead of absorbed.
- **The gate runs the unit lane's file set.** `local/gate-unit.mjs` sets `ORCA_BALANCE_UNIT_SHARDS=1`
  for its suite, the switch `config/vitest.config.ts:13` already reads to apply `UNIT_EXCLUDE` instead
  of `defaultExclude` — 80 files here, the electron, node-pty, live-shell and cross-version-wire ones.
  A `--exclude` flag cannot do it: every project in that config sets `extends: false`, so a root-level
  CLI exclude never reaches them (measured: the file still ran). Because parity with the unit lane is
  a switch rather than an argument, the gate also asserts the report collected none of the 80 and
  fails closed if one appears, and it refuses an allowlist entry for a quarantined file rather than
  letting it sit dead — a manifest entry that can never match is the same rot as a stale one.
- **The fork-local lane runs somewhere.** `local/**/*.test.mjs` are `node --test` files and sit outside
  `UNIT_INCLUDE` by upstream's definition, so `local/sync/lib/*.test.mjs` matched no lane at all (fork
  issue #151 § 5). The gate runs them first — 35 tests in 0.7 s — before `build:packages` and the
  suite, so a broken sync tool cannot produce a verdict about anything else.
- **Two reds tightening surfaced were repaired, not recorded.** The wildcard hid both:
  - `the screen prompt a pane is holding answers null for a pane it cannot bind to a terminal`
    asserted `null` where `src/main/runtime/terminal/wait/terminal-pane-screen-prompt.ts:15-20`
    documents `undefined` ("cannot see it" is not "no dialog"), in the same fork commit
    (`3526000b5c`) that added both, so it had never passed.
  - `macOS privileged CLI command transaction repairs an unreadable link to an older Orca launcher`
    linked `/Applications/Old Orca.app/…/bin/orca` while the fork ships `orca-np`
    (`cli-install-constants.ts:6`), and `isManagedSymlinkTarget` rejects a name mismatch
    (`cli-command-inspection.ts:117`) — so the installer read its own launcher as a foreign command.
    The two sibling cases in that file already use `orca-np`; this one arrived later from upstream.
    Not a `/private/var` path case, and not upstream's to fix: owner is the identity patch, and it
    cost one hunk. Recorded as a red it would have hidden the next real break in those files.
- **The isolation re-run is judged per test, not per file.** A file with named reds still exits
  non-zero when re-run alone, so "the file failed again" cannot separate a load flake from a real
  break once entries are named. The re-run writes its own JSON report and a failure is only
  reproduced when that same test failed there; a missing report counts as reproduced (fail closed).
- **A named entry can no longer go quietly dead.** `unseen` used to mean "the file did not fail",
  which cannot happen to a dead entry whose file still reds elsewhere. It is now "nothing in the run
  matched this entry and it is not stale", which also catches a renamed or deleted case.
- **A manifest test.** `tests/tools/unit-gate.test.mjs` pins the judging rules the verdict rests on (a
  named entry does not cover its neighbours, a rename leaves a dead entry visible, a collect failure
  counts as a failure, unhandled headlines collapse and count, and both quarantine checks fire) and
  the manifest invariants: no wildcard entries, no duplicate keys, a class, an owner and evidence on
  every entry, no entry for a quarantined file, and `observedRun` closing its own arithmetic. It sits
  beside `tests/tools/lint-gate.test.mjs` rather than in `local/`, because `tests/tools/**` is the one
  place the unit suite collects a fork-local tool's tests. The judging itself moved to
  `local/unit-gate-judgement.mjs`: pure functions over a report, imported by both the gate and its
  tests, because one file carrying the run and the meaning of its report outgrew this fork's 600-line
  budget.

§ 2 and § 4 of the issue were already resolved by the 2026-10-21 and 2026-10-22 syncs — the eight
stale entries were pruned then, and both formerly-unlisted reds pass — so what is left here is § 1,
§ 3, § 5 and the re-diagnosis recorded above. The contradiction § 2 names is resolved in favour of
pruning: `LOCAL-PATCHES.md` is the history of _why_ a class was red, not a reason to keep an entry
that has stopped reproducing. Same shape as `local(lint)` above: this file is the evidence, the JSON
is the assertion.

**The first full run on this branch found one red the base had, not this branch.** The manifest said
32 entries and the run said 32 plus `src/main/ipc/worktrees-windows.test.ts › resolves the Git username
when the configured prefix consumes it`: `a8ca9685a3` (#170) gave the branch-prefix login the repo's
pinned gh account, so `resolveLocalGitUsername` takes a second argument, and that upstream case still
asserted the one-argument call. Nothing in this branch touches the file — `git diff --stat
b094309766..main` does not list it — so it was repaired in the same shape as the two above
rather than recorded.

The first full run after the tightening (`098d3ea4a3`, before PR #177 landed) passed:

```
Unit gate @098d3ea4a3 (clean): PASS — 135786 passed; 31 failed (31 allowlisted, 0 unexpected); 0 flaky re-run passed; 0 unhandled error headline(s); 80 upstream-quarantined file(s) not run; 2 fork-local test file(s) passed; 2472 s
```

No entry was stale and none was unseen, which is the check that the tightening was faithful: the 31
names are exactly the 31 failures, with no wildcard left to absorb an unknown one. The verdict for the
revision that ships is in the PR body, because `local/open-pr.mjs` now requires a cached PASS for the
exact head revision and this file changing is what changes that revision's cache key.

**2026-11-09 — the first red of this class was the agent's own pane, and the fix was the gate's env.**
`codex-shell-launch-preflight`'s two `keeps a user alias named codex working in {zsh,bash}` cases red
on a full run of `62e54e53ee`, and on `d8bcf47d2cc` when that single file runs there (no gate verdict
is cached for the base, so the claim is about the file, not a full run — the branch touches nothing in
`src/main/pty`, and `git diff --stat` proves it). The cause is ambient: an Orca pane exports
`ORCA_REMOTE_VIEWER_CLIPBOARD=1`, the case inherits `...process.env` without clearing that key (it
clears `CODEX_COMMAND_IDENTITY_ENV_KEYS` only), so `getPosixCodexShellLaunchPreflight` adds
`-c shell_environment_policy.set.SSH_CONNECTION=''` and the exact-args assertion sees it.
`ORCA_REMOTE_VIEWER_CLIPBOARD= pnpm test <that file>` passes 8/8, which is the whole diagnosis.

**Recorded as entries first, which did not work, and that is the useful part.** Both cases were added
to `local/unit-known-red.json` pinned by a `match` on the SSH flag — and the entry could never fire:
Vitest abbreviates the compared values, so the failure's first line is
`launched args=[-c shell_envir…' to be 'launched args=[--alias-flag] …`, and the flag's name is cut off
before the text a `match` would test. Worse, had it matched, it would have absorbed any other break in
the same assertion, since every failure in that case reaches it. The red is not a property of a test;
it is a property of the shell that started the gate, which is exactly what `INHERITED_APP_ENV` in
`local/unit-suite-run.mjs` already exists for (the two WSL gate vars are there for the same reason).
So `ORCA_REMOTE_VIEWER_CLIPBOARD` joined that list and the entries were removed — one place, no
allowlist growth, and the upstream test file is untouched. **A `match` can only pin what Vitest prints;
when the signature is inside an abbreviated value, scrub the env instead.**

### `local(test)`: gate 1 asks for the full suite only when the change is global

The full unit suite moved off the PR boundary. Requiring it per branch is what produced 257 gate
invocations and 45 runs over four minutes across 47 sessions between 2026-10-21 and 10-24 — 26.9 h of
summed tool wall clock, a median of 28 minutes a run, and one session that spent 10.3 h of a 20.5 h
span inside it. That measurement, per-turn transcript data from `~/.pi/agent/sessions`, is the evidence
for the change; `~/Code/orca/AGENTS.md` § Verification tiers — the cross-worktree file, not this repo's
`AGENTS.md` — is the resulting rule.

What replaced it:

- **PR time:** targeted tests for the changed area, `pnpm tc`, `local/gate-lint.mjs`, and the one Opus
  review. No full suite unless the diff carries a global input.
- **`local/open-pr.mjs`:** `needsFullUnitGate(changedPaths)` decides whether gate 1 still demands a
  cached PASS. It fails closed (no changed-path evidence ⇒ full gate) and calls a path global when it
  is `package.json`, a lockfile, `config/**`, a root `tsconfig*.json`, `src/packages/**`,
  `src/shared/**`, outside the source/test/doc/fork-tooling/workflow trees, or **in the closure
  `unitRuntimeInputs` walks from the unit runtime entry points** (see the #316 correction below). Why
  a fixed list rather than `selectUnitFiles`: that needs the reverse-import graph — globs plus the
  TypeScript API — which
  costs minutes in a PR opener and answers "run all 13,064 files" for nearly every input. Measured on
  the last 40 commits, 15 touch `src/shared` or `src/packages`, so the gate still applies to ~37% of
  changes: the ones with real cross-process blast radius.
- **Nightly:** `fork-main-tests.yml`, see `local(ci)` below.
- **Release:** `RELEASE-RUNBOOK.md` Step 1.5, which is now the only place the suite is unconditionally
  mandatory.

Two claims this change rests on were measured rather than assumed, after review challenged them:
`build:packages` takes 1.0 s, so the 21.2 h of `pnpm tc` is the node/cli/web projects and queue wait,
not a build-cache opportunity; and the 15–19 min runs that looked like cold setup in a new worktree were
the `orca-queue` lock, not compilation. A third claim survived a bad retraction of my own: review doubted
that the shim's `VITEST_MAX_WORKERS` cap did anything, grepping this repo finds no reader (true — the
reader is Vitest's `resolveConfig`, which assigns `resolved.maxWorkers` from that variable), so the cap
is real and the export stays. Two corrections to how that was first written down: the cap is **4**, not
2 (`~/.local/bin/pnpm` and the shell profile both export it), and `orca-queue node local/gate-unit.mjs`
**is** capped by it — `local/unit-suite-run.mjs:110-111` prints `gate-unit: VITEST_MAX_WORKERS=<n>`.
The gate is
serialised by the queue, not uncapped. One part of the original claim survives: the fork's custom
`node-runtime` pool never reads `maxWorkers` itself.

**Correction (2026-11-09, #316): the fixed path list had a hole, and a closure closes it.**
`config/scripts/test-runtime/environment/vitest-orcad-feature-readiness-reset.ts` imports
`src/main/runtime/rpc/orcad-feature-readiness.ts`, so that source file loads in **every** unit test
worker — but it sits in `src/main`, which every path rule above reads as targeted, so gate 1 skipped
the suite for it. CI's selector never had this gap: `selectUnitFiles` asks whether any transitive
consumer of a changed file `isUnitRuntimeEntryPoint`, and a setup file is one. The classification now
comes from that same side: `config/scripts/ci/unit-selection/ci-unit-runtime-inputs.mjs` walks the
imports of the runtime entry points transitively (46 files on this revision, 19 of them under `src`),
and `open-pr.mjs` treats anything in that walk as global. Two definitions of "global input" was the
defect; one definition is the fix. The walk costs ~30 ms against the ~8 s a full graph build takes,
which is why the reverse-import graph is still not used here, and an unreadable tree is reported as
"closure unreadable" rather than aborting, so `--dry-run` still reports a refusal.

**Upstream files this touches, for the next sync:** `ci-unit-selection.mjs` gains `export` on
`RUNTIME_ENTRY_POINTS` and `isUnitRuntimeEntryPoint` (the selector keeps owning the definition; the
new module imports it), and `ci-unit-dependency-graph.mjs` gains three exports —
`unitLocalImportPath`, `unitImportCandidatePaths`, `unitSourceImports` — which are the resolution and
parse the graph already did, extracted so the walk resolves imports the same way instead of
re-implementing it. No behaviour changes in either file.

### `local(renderer)`: `ai-vault-session-refresh.ts` was over the `max-lines` budget — resolved

The branch tip was red with an unmodified working tree (`oxlint`: 303 lines against a 300 budget,
from `46f640a501`'s refactor rather than a sync), and `pnpm lint` could not pass on any branch cut from
`main`. **Fixed in the 2026-10-19 sync** the same way every other overflow on this branch was:
a split, never a cap or a baseline entry. The forced-rescan throttle — `claimAiVaultForcedRescan`,
its retry delay and its test reset — moved to `ai-vault-forced-rescan-throttle.ts`, with
`markForcedRescanSpent()` and `forcedRescanRetryDelayMs()` as the new edges the hook and the tab-bar
switch call. `tab-session-history-switch.ts` and three test files import from the new module.

### `local(renderer)`: the fork's styling and transient state are not upstream's files

Both of the fork's renderer stylesheets were **byte-identical to upstream's** at the 2026-10-21 base.
`assets/rich-markdown-editor.css` still is — take upstream's side on any conflict there. `assets/main.css`
is **not** any more: it carries one fork comment hunk (the `.orca-diff-comment-add-btn` note about a
collapsed review thread owning the gutter slot), which is a comment only, so it is safe to take either
side but not byte-identical. The 157 fork lines that used to live in them moved to two colocated files,
verbatim except one comment that pointed "further down this file":

- `components/pr-comment-inline/pr-comment-thread.css` — the `.orca-pr-comment-*` block, imported by
  `PRCommentThreadCard.tsx`, the way upstream imports `AgentKanbanBoard.tsx`'s own stylesheet.
- `components/comment-composer.css` — the composer rules that were in `rich-markdown-editor.css`,
  imported by `comment-composer.tsx`. Not folded into the PR block: `CommentComposer` is rendered by the
  Jira issue workspace too, and it is the only caller that passes `compact` or `disabled`.

Why the load order cannot change the result: no moved selector ties on specificity with a remaining rule
that touches the same element and property. The only overlap is
`.orca-diff-comment-inline > .orca-diff-comment-card` (0,2,0), which outranks `.orca-pr-comment-thread`
(0,1,0) either way; `.monaco-editor .glyph-margin-widgets .cgmr` (0,3,0) likewise; the composer's
`.rich-markdown-editor.comment-composer-editor` (0,2,0) and its `p/ul/ol/blockquote` (0,2,1) outrank every
base `.rich-markdown-editor` rule, and the rules that would tie are scoped to
`.linear-issue-markdown-editor`/`.rich-markdown-editor-shell`, which the composer is never inside. The
block was unlayered in `main.css` and stays unlayered, so it still beats Tailwind's layered utilities.

Transient fork UI state lives in `store/slices/fork-ui.ts` — `settingsProjectAddHostRequest`,
`prCommentInlineDisplayById`, their actions and the `ProjectHostAddRequest` type — registered beside
`worktree-setup-runner` in `store/index.ts` and `store/types.ts`, one line each. `ui.ts`,
`ui-slice-contract.ts`, `ui-slice-contract-contextual.ts` and `ui-slice-surface-actions.ts` now carry no
fork lines for it; the only one left in `ui-slice-settings-actions.ts` is the request clear inside
`closeSettingsPage`. **`store-test-helpers.ts` composes the slice too** — a hand-built `AppState` there
fails `tc:web` without it, which is the check that catches a future slice registered in one place only.
The persisted `hiddenWorkspaceStatusIds` and `mergeSameBranchWorkspaces` stay in upstream's UI slice
because they ride its hydration.

`task-page/jira/Content.tsx` is upstream's nested-ternary shape plus one hook
(`task-page/jira/use-jira-board-mode.ts`) and one early return that mounts the configured board, so its
fork delta is 63 changed lines where it was 384. A conflict there resolves by taking upstream and
re-adding those hunks.

### `local(vault)`: the list tier's schema is the fork's own

The fork's 8 list columns (`model`, `total_tokens`, `queued_message_count`, `subagent_transcript_count`,
`modified_at`, `subagent_parent_session_id`, `subagent_agent_type`, `subagent_parent_agent`) and its
metadata FTS live in `session_list_facts` / `session_metadata_fts`, versioned by
`meta.session_list_schema_version` (`SESSION_LIST_SCHEMA_VERSION`), both created in
`ai-vault-search/session-search-list-schema.ts`. **Never merge them back into upstream's `sessions` or
`SCHEMA_SQL`, and never bump `SESSION_SEARCH_SCHEMA_VERSION` for a fork change** — take upstream's value
verbatim on every sync and bump the fork's key instead. That is the whole point: the two constants used
to collide (fork 6→9, upstream 6→8, merged 10) and the same shape had already hit the parse cache.

Triggers on `sessions` maintain both fork tables — `AFTER UPDATE` and `AFTER INSERT` refreshing the
metadata row, `AFTER DELETE` reclaiming both — so upstream's writer, retention purge and replacement
delete carry no fork hunks, and `session-search-retrieval.ts` / `session-search-retention-delete.ts` are
byte-identical to upstream. **The INSERT trigger is load-bearing, not redundant:** without it metadata
search depends on upstream's `createSessionRow` staying "insert blank, then UPDATE", and the day it
inserts a full row in one statement every session would silently drop out of metadata search. The only
fork lines left are two hook calls in `openSessionSearchDatabase` (`session-search-schema.ts`), one
`writeSessionListFacts` call in `session-search-file-records.ts`, and the list read's `LEFT JOIN` in
`session-search-list.ts` — with every fact column written as `session_list_facts.<name> AS <name>`, so
upstream adding a `model` column to `sessions` cannot make the list query ambiguous.

**A wrong or missing key on a file that already holds sessions rebuilds, it does not stamp.** When the
pre-open check cannot judge the file (a lock timeout, a transient error), `ensureSessionListSchema` throws
`SessionListTierMismatchError` carrying `code = 'SQLITE_CORRUPT'` instead of writing the current fork
version over whatever is on disk — upstream's `openVersionedCacheDatabase` already treats that code as
"delete and rebuild once", so this needs no new lines in upstream's opener. **If upstream changes that
rebuild rule, the schema test fails rather than the index quietly degrading**, which is the coupling to
watch. The stamp itself is a plain `INSERT` and only fires when the key is absent and `sessions` is empty.

**The merged-10 migration.** `migrateMergedLegacyLayout` runs before upstream's opener — it has to,
because upstream deletes a file whose version it does not recognise — and fires only for a version `'10'`
file that has `sessions_fts`, the legacy columns and no fork key. It renames the FTS table, copies the 8
columns into the facts table, drops them from `sessions`, sets the version to the literal `'8'` (the
upstream content the merged 10 carried) and writes the fork key, in one locked transaction. **That
migration is dead the moment upstream's constant passes 8** — delete it then, and the file will be
rebuilt by upstream's own rule like any other stale index.

The host-leg sync delta lives in `ipc/ai-vault-host-leg-sync.ts` and wraps `scan` at the `ai-vault.ts`
call sites, so `scanHostLegWithCache`'s `scan: () => Promise<AiVaultListResult>` stays upstream's
signature. Two hunks stay in `ai-vault-host-leg-cache.ts` deliberately and are not the delta: the
unbounded key/bypass, and the row-capped prune, because every paged reply now carries a fingerprint and
upstream's count-only cap of 8 would no longer bound memory. One behaviour difference to expect: after a
delete, upstream's cache cannot expand an `unchanged` reply, so the next plain refresh rescans (4 where
the fork had 3) — a small diff request, not a full re-download.

### `local(jira)`: a required transition field the issue already fills is not the user's to fill

After the 2026-10-15 sync, two of the three status-change surfaces refused a transition outright with
"Jira requires fields Orca cannot collect yet: Team, Component/s." The ticket in the report had both
fields populated: Jira's `required` flag on `GET /issue/{key}/transitions?expand=transitions.fields`
is the **transition screen's** flag, not a statement that this issue is missing the field, so the
block was for a move Jira would have accepted. Upstream `#28588` (`eb1ee8f908`) only ever collected
`resolution` + `comment` and called everything else `unsupported`; the fork's generic collector
survived only on the configured agile board (`components/task-page/jira/Board.tsx`), which is why the
same transition was blocked from the detail pane and the ad-hoc board and attempted from the board.

Converged on the fork's shape, as one collector on all three surfaces:

- `src/shared/jira/jira-transition-fields.ts` — `JiraTransitionRequirement` has **no `unsupported` kind**.
  `requiredTransitionFields` skips a field whose `currentValue` is set (the `hasDefaultValue`
  exclusion's sibling), exempting `resolution` and `comment` because a workflow can demand those be set
  on the transition even when a value exists. The classifier returns the remaining fields to render and
  de-duplicates a field Jira lists twice instead of refusing the transition over it.
- `src/main/jira/jira-transition-queries.ts` — `attachCurrentValues` reads the issue for the union of
  required field keys and attaches `hasCurrentValue` (any value at all) plus `currentValue` /
  `currentDisplayValue` (that value as a control draft) to each field. The two are separate on purpose:
  Cloud's Team field holds an object no control can seed, and deciding "filled" from the draft alone
  asks for a field the issue already has. Best effort: a failed read leaves every field asked for, and
  an auth failure is rethrown so a dead token cannot read as "these fields are empty".
- `src/shared/jira/jira-transition-fields.ts` — `rejectedTransitionFieldKeys` lets a rejection undo a skip.
  A stale value, or a validator that demands the field be set on this transition, comes back as
  `fieldErrors` naming the field; every surface reopens the form with that field asked for rather than
  printing a sentence the user cannot act on. `classifyTransitionRequirements` takes the forced keys as
  an optional second argument, so the call sites that have none are unchanged.
- `src/main/jira/jira-field-drafts.ts` — **new.** `describeFieldDraft` is the schema-to-draft map lifted
  out of `jira-issue-edit-metadata.ts`, so a transition field and an edit field show a value the same
  way. Primitive array entries (team ids, labels) now draft as themselves instead of as an empty
  option, which the edit form was also getting wrong.
- `src/renderer/src/components/jira-transition-fields-form.tsx` — renders `resolution`, `comment` and
  every other required field through `JiraSchemaFieldControl`, seeded from `currentValue`, submitting
  **only fields the user changed**. That rule is what makes the skip reversible: the classifier only
  renders an unfilled field (so "changed" means "filled in"), and a field a rejection brought back is
  rendered holding the issue's own value and stays unsubmitted until the user edits it — so a shape
  Orca cannot rebuild is never rewritten. A field a rejection brought back is the exception: it is
  always sent when it has a control and a non-empty draft, because resubmitting the value Jira just
  refused would repeat the same request. Jira's `fieldErrors` render beside the control that failed
  and the form stays open to retry; the banner is suppressed only when a _rendered_ field carries the
  sentence, and Jira's separate workflow `errorMessages` are always shown.
- `task-page/jira/TransitionFieldsDialog.tsx` is now a shell over that one form, and the detail-pane
  control, the ad-hoc board move dialog, the board drop **and the workspace sidebar's linked-issue
  pane** all render it. The pane's status row (`right-sidebar/jira-status-row.tsx`) no longer posts a
  bare `{transitionId}`: it opens the form for a screen that requires fields, and a refusal naming a
  field reopens it with that field asked for. A refusal that names none shows beside an "Open in Jira"
  link in that row's own dialog rather than as a toast.
- `src/renderer/src/components/jira-issue-mutation-queue.ts` — `JiraMutationFailure` carries
  `fieldErrors`, and `use-jira-issue-workspace-mutation.ts` passes them through instead of flattening
  the result to `{ ok, error }`, so the detail pane — not only the board paths — can name the field
  Jira refused.

`jira.transitions.unsupported` and `jira.transitions.completeInJira` are now unused in `en.json`. They
stay in the catalogue rather than being deleted, because removing a key churns all 20 locales and the
regenerated catalogues are a sync-owned artifact.

Tests that pin the new behaviour: `src/renderer/src/components/jira-transition-fields-form.test.tsx` (a filled field is not
asked, resolution/comment still are), `src/renderer/src/components/task-page/jira/boards/task-page-jira-board-transitions.ts`
(the value read and its failure path), `task-page-jira-board-view.test.tsx` / `jira-issue-transition-control.test.tsx`
(the filled-field move, the collected custom field, and the field-level rejection) and
`task-page/jira/Board.test.tsx` (the shared form's submit label). A sync that restores upstream's
`unsupported` kind turns all of them red.

### `local(jira)`: components and versions are submitted as references, never as bare strings

Issue #162. Jira reports Component/s (and Affects/Fix Version/s) as `schema: {type: 'array', items:
'string'}`, so `resolveJiraFieldControlKind` gave them the free-text list and
`buildJiraCreateFieldValue`'s array branch submitted `{components: ['Web', 'Platform']}`. Jira takes a
reference per entry (`{id}`), so the field could never be set — on the edit form and on a transition
screen that requires it, which share that builder (`ffad67a863` made the attempt happen at all rather
than blocking the transition first). Neither `createmeta` nor `editmeta` supplies `allowedValues` for
these fields, which is why the shape was never resolvable.

The general fix from the issue, taken as written:

- `src/shared/jira-field-rendering.ts` — `JiraObjectListFieldKind` (`'components' | 'versions'`) and
  `resolveJiraObjectListFieldKind`, keyed off `schema.system` with the field key as the fallback a
  custom field cannot hijack. `resolveJiraFieldControlKind` decides on that reference shape **before**
  any `items` branch, because sites report `items: string` and `items: component`/`version` for the same
  three fields; it returns `optionList` once the project's list is attached and `textList` when it is
  not.
- `src/main/jira/jira-project-field-options.ts` — **new.** `readProjectFieldOptions` reads
  `GET /project/{key}/components` and `/versions`, only for the kinds a field actually needs
  (`needsProjectFieldOptions`: reference shape, no `allowedValues` of its own — a site-scoped list wins)
  and only when Jira sent none. Archived and id-less version entries are dropped, as Jira's own picker
  does. Best effort: a failed read leaves the kind out, the field keeps its text box, and the submission
  sends `{name}` — so a denied permission or an older host degrades to the issue's option (2) instead of
  failing; an auth failure is rethrown so a dead token cannot read as "this project has no components".
  `readIssueProjectKey` asks Jira for the issue's `project` rather than splitting the key: a moved issue
  keeps answering to its old key, and an id-shaped key would be taken for a project id. No project key
  means no list.
- `jira-issue-create-metadata.ts` / `jira-issue-edit-metadata.ts` / `jira-transition-queries.ts` attach
  those lists before the existing value read, which only drafts a component as the id Jira accepts once
  the list can match it. The edit form now offers the three system fields too — nothing else in the
  detail view writes them — while `labels`, `summary` and every other system field stay excluded.
- `src/renderer/src/components/task-page/jira/task-page-jira-create-fields.ts` — the array branch submits `{id}` per
  entry (by name when the project list does not name it) for these three keys only, so Team and labels,
  which really are string arrays, are untouched.

No new IPC channel or RPC method: the reads happen inside the three existing metadata calls, so a host
and a client on either side of this change stay compatible. An older host yields no `allowedValues`, and
the new client sends `{name}`; a newer host with an older client yields a list whose names the old
builder already maps back to `{id}`.

Tests: `src/main/jira/jira-project-field-options.test.ts` (which lists are read, the archived filter,
the project read, the failure paths, auth rethrow), `jira-field-rendering.test.ts` (object-list vs
genuine string list, both item types), `task-page-jira-create-fields.test.ts` (the submitted reference
array, the name fallback, untouched fields), `jira-issue-edit-metadata.test.ts` (a component drafts as
its id; no list without a project), `jira-transition-required-fields.test.ts` (the project and list reads
before the value read, and no list read for a screen without these fields),
`jira-issue-edit-fields-dialog.test.tsx` and `jira-transition-fields-form.test.tsx` (the payload from
both forms, and `[]` as the clear), plus `JiraIssueWorkspace.transition-source.test.tsx`, which used to
pin the bare string.

### `local(test)`: a bun-pool timeout failure can read as `Errors 1: EISDIR` instead of a failing test

Symptom worth recognising, because it reads as a crash rather than a failure and cost a session half an
hour: a test whose `findBy`/`waitFor` times out is reported as `Errors 1` with
`Error: EISDIR: illegal operation on a directory, read` raised inside Vitest's own `getSourceMap`, the
failing test is not named, and the file's remaining tests vanish from the counts (`Tests N passed (N+2)`,
`Test Files N passed (N+1)`). A _synchronous_ assertion failure in the same file reports normally, which
is what makes it look like a flake.

Reproduced 2026-10-22 against src/renderer/src/components/JiraIssueWorkspace.transition-source.test.tsx
(since retired) by appending a deliberate `findByPlaceholderText` timeout: in the bun pool → EISDIR, no test named; the
same file under the node runtime → `× scratch: deliberate timeout reports itself`, failing test named.
Minimal files with the same failing query reported fine in bun, so the trigger is the file, not the
query.

Remedy applied: that file is seated in the node-runtime project
(`config/scripts/vitest-node-runtime-files.mjs`, `LOCAL(nplez1)` entry). If the symptom appears
elsewhere, check it the same way — a deliberate timeout failure is the probe — and seat that file rather
than re-running the suite. Do not read `Errors 1` in a bun-pool run as "the failure was elsewhere".

### `local(test)`: the 2026-10-25 sync's red set — 115 cases repaired, 9 recorded

The first full gate after merging upstream `0571e45107` (556 commits) read `155 failed (31 allowlisted,
124 unexpected); 7 unhandled error headline(s)` at `ef2897da2b`. `observedRun` in
`local/unit-known-red.json` lists every repaired case with its cause. In short: 83 were `mobile/`'s own
workspace never installed; the rest were merge breaks — fork-extracted modules that stopped receiving
an upstream change (`run-process-sync.ts`, `emitWorktreeLifecycle`), a fork suite missing upstream's new
git-worker fixture, a mock path orphaned by the `ipc/filesystem/` move, upstream literals overwriting
the fork identity (`orca-np-dev`, `.orca-np`, `nplez1/orca`), a resolver that reordered the auto-merge
gate and dropped two call sites, a Jira user field with supplied choices rendered as text, and generated
skill sources built from upstream's skills. One was a pre-merge fork defect (#185's star-link surface).

Nine are recorded, all `owner: upstream` on code byte-identical to `0571e45107`:

- **seven `sqlite-binding`** — `persisted-profile-state.unit` (2), `editor-view-layout-apply`,
  `restored-editor-move-restart`, `sweep-terminal-placement` (2), `session-search-indexer`. The merge
  raised `config/.bun-version` 1.4.3 → 1.4.4. Bun's `node:sqlite` on macOS loads Apple's system SQLite,
  which cannot open a WAL database read-only once `close()` has removed `-wal`/`-shm`; 1.4.3 left
  `-shm` behind, which hid it. Probe: writer in WAL mode, `close()`, `new DatabaseSync(p, { readOnly: true })`
  — Node 26.11.1 opens it, bun 1.4.3 opens it, bun 1.4.4 throws `unable to open database file`. The same
  HEAD passes all five files under bun 1.4.3. Product code runs on Electron's Node, not this path.
  **All seven are closed (2026-10-29), and none of them by a test fix.** The three topology files were
  already green: upstream #33533 (`a886dcd1fe9`, merged with the 10-28 sync) added
  `terminal-topology-profile-fixture` to the harness list `config/scripts/vitest-sqlite-runtime-scan.mjs`
  keys on, so `getNodeRuntimeInclude()` had been routing them to the Node project all along. The other
  two — the persisted-profile-state e2e unit suite (moved to `tests/e2e/desktop/electron-fixtures/` from
  `tests/e2e/helpers/` when upstream grouped the e2e tree by feature, #43628) and the
  session-search-indexer suite — reached `node:sqlite` through modules the
  scan does not follow, so they really were running under Bun; both were listed in
  `NODE_RUNTIME_INCLUDE` with the reason, and both passed (3/3 and 42/42) where they failed 2/3 and 1/42.
  `vitest-node-runtime-boundary.test.ts` pinned the two entries, because nothing else would notice their
  removal — and all three are gone now: the two suites went in upstream's 2026-11-24 test-inventory
  pass, their `NODE_RUNTIME_INCLUDE` entries went with them, and the pin suite with them, so nothing
  asserts the fork-local block in
  `config/scripts/test-runtime/sqlite-admission/vitest-node-runtime-files.mjs` any more. Re-homing that
  pin is owed. The hazard the audit named is the real reason this mattered: the entries' `match`,
  `Unable to read profile state database`, is exactly what a genuine profile-state open regression
  throws, so the allowlist could not have seen one.
- **27 `agent-hooks` files, the same `sqlite-binding` class, reopened by the 2026-11-10 sync.** Upstream
  `06a528f774e` (_perf(agent-hooks): save agent status as per-pane SQLite rows_) made `LastStatusStore`
  hydrate through `KeyedJsonRowCache`, which does `new SyncDatabase(path, { readonly: true })` — the
  same read-only WAL reopen that Bun 1.4.4 on macOS refuses with `unable to open database file`, and
  that `-shm` retention under 1.4.3 hid. `findSqliteRuntimeTests`
  (`config/scripts/test-runtime/sqlite-admission/vitest-sqlite-runtime-scan.mjs`) only follows direct
  imports of `sync-database` or a listed harness, and these suites import only `AgentHookServer`, so
  all 27 ran under the Bun project and every presence read degraded to `unverifiable` — 54 failures
  with no test at fault. The same 27 under the Node runtime: **191/191 passed**. They are listed in
  `NODE_RUNTIME_INCLUDE` with the reason, and nothing else changed. The lesson is the scan's, not the
  tests': an indirection added upstream silently moves a suite between runtimes, so a new
  `unable to open database file` cluster should be read as "which project did this run in" before it
  is read as a behaviour regression.
- **`verify-cli-bin`, `macos-path-semantics`** — new upstream case; the child's `process.cwd()` reports
  `/private/var/…` against the unresolved `os.tmpdir()` the case compares.
- **`reclaim-worktree-generated-files`, `host-toolchain`** — new upstream file. The script recovers from
  `EACCES`/`EPERM` only; bun on macOS (1.4.3 and 1.4.4 probed) fails `fs.rm` on a `0o555` directory with
  `ENOTEMPTY`, where Node reports `EACCES`. The in-process case therefore cannot recover; the CLI cases,
  which spawn Node, pass. Not verified on Linux bun.

**The unhandled errors were not the tolerated teardown race.** All seven headlines were
`EnvironmentTeardownError: Cannot load '<module>' … after the environment was torn down`, from eleven
renderer store suites (35 occurrences, the same per-file counts in two full runs, none when a file runs
alone). Cause: upstream fire-and-forget `import()`s still pending when a file ends
(`store/terminals/terminal-tab-appearance.ts`, `slices/worktrees/teardown/removed-workspace-unsaved-files.ts`),
surfaced by upstream's new `experimental: { recordDependencies: !process.env.CI }` in
`config/vitest.config.ts`. Upstream's lane sets `CI`, so it never records dependencies and never sees
them. Four of those suites in one worker: 20 errors as configured, 0 with `CI=1`, 0 with only
`--experimental.recordDependencies=false`, 28/28 passing each time. `local/gate-unit.mjs` now passes that
flag (its suite run and its isolation re-runs) so the gate runs upstream's lane setting; the races are
upstream's to fix and are left in the code.

Verdict on the uncommitted tree; the one unexpected failure compares the committed allowlist with the
working copy, so it reads red until this change is committed:

```
Unit gate @accb095dd6 (dirty): FAIL — 138067 passed; 41 failed (40 allowlisted, 1 unexpected); 0 flaky re-run passed; 0 unhandled error headline(s); 2593 s
```

The committed revision, `7811f60dd6`:

```
Unit gate @7811f60dd6 (clean): PASS — 138072 passed; 41 failed (40 allowlisted, 0 unexpected); 1 flaky re-run passed; 0 unhandled error headline(s); 2575 s
```

### `local(lint)`: upstream's `max-lines` budget is enforced again, with 24 exemptions

**Reversed 2026-10-27, with the measurement that reversed it.** This section used to record the cap as
`"off"` in the four overrides that carried 300/400/600/800. That worked and cost more than it saved:
with the rule off, two of upstream's own coverage tests fail (they assert the installed oxlint still
flags an over-budget file), and the ratchet script — whose whole job is to freeze who may bypass the
rule — becomes inert. Those two tests were deleted by upstream's bulk test removals in the 2026-11-08
sync, so nothing pins the rule today. So the fork was paying four changed lines in a file upstream owns _and_ a red gate, to
avoid an exemption list.

The exemption list turned out to be longer than the first pass measured. With upstream's rule restored,
**24 rows** stand in `config/max-lines-baseline.txt`, four of them upstream's own; the other 20 are the
fork's, each carrying one `eslint-disable max-lines -- Why:` line naming what the fork adds. The fork's
own `local/sync/conflicts.mjs` is inside the same budget rather than exempted: the `local(lint)` pass
split it (`local/sync/lib/conflict-report.mjs`), and it currently sits at 578 counted lines. Splitting
an _upstream_ file to
fit the budget would be the eviction this section exists to stop — a permanent hunk on every sync.

So: upstream's rule, upstream's ratchet, upstream's baseline, **24 grandfathered entries**, four of
them upstream's own (`git show origin/main:config/max-lines-baseline.txt` has exactly those four).
`.oxlintrc.json` is byte-identical to `0571e45107` again, both upstream tests pass, and the ratchet
reports OK. What this does **not** do is undo the evictions
already made; restoring the evicted blocks is § 5.2, and this is what makes it possible.

`.oxlintrc.json` is therefore no longer a file this fork edits — which removes it from the hot-file list
this section used to keep for it.

#### The rule for next time: whose file is it?

The budget is enforced. Whether an over-budget file gets an exemption is decided by **ownership, not by
size**, because the two possible fixes cost wildly different amounts at the next sync:

| The file is…                              | Over budget →                        | Why                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ours** (absent from the sync base)      | **split it.** No exemption, ever     | A split costs one commit. There is no upstream copy to conflict with, so the cap is a free quality guard                                                                     |
| **upstream's** (present at the sync base) | **one directive + one baseline row** | Splitting upstream's file is a permanent hunk at that spot on _every_ sync, and it silently drops upstream's later edits there. A two-line directive conflicts once, if ever |

The cap exists to stop files growing without bound. It does **not** exist to push the fork into
restructuring upstream's code, which is what makes a 3-line overage cost more than the rule saves. So a
fork line that pushes an upstream file past its budget is not a failure to fix — it is a row.

When the fork's own block inside an upstream file becomes self-contained (a whole component, a catalog
section), moving it to a fork-owned sibling is still the better outcome, because it removes a fork hunk
from an upstream file instead of exempting it. That is seam work, tracked in § 5.6/§ 5.5 of
`mergeability-plan.md`, not a budget decision.

**Never** raise the numbers in `.oxlintrc.json` instead. It weakens the guard for every file to spare a
few, and it desyncs the `defaultLimitForPath` constants that `check-max-lines-ratchet.test.mjs` pins —
so the next reader gets a red gate from a config edit that looked harmless.

**Never** turn the rule off. That is what the paragraph above records being tried and reversed: it costs
two of upstream's own tests and makes the ratchet script blind to the very bypasses it exists to freeze.

To list the offenders without touching the real config, run upstream's rule from a probe copy:

```bash
git show 0571e45107:.oxlintrc.json > .oxlintrc.maxprobe.json
npx oxlint --config .oxlintrc.maxprobe.json --format json . | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    for (const x of JSON.parse(s).diagnostics.filter(d=>String(d.code).includes("max-lines")))
      console.log((x.message||"").padEnd(28), String(x.filename).split("/").slice(-2).join("/"))
  })'
rm .oxlintrc.maxprobe.json
```

Then `node config/scripts/static-analysis/ratchets/source-budget/check-max-lines-ratchet.mjs` (expect
`OK — N grandfathered entries`). A row whose file
the fork later slims back under budget is reported stale by `--prune`, so the list shrinks on its own; it
should never need to grow without a reviewer saying yes.

The eight fork exemptions are listed in `config/max-lines-baseline.txt`, and each file carries its own
`-- Why:` naming what the fork added there — deliberately, so the reason travels with the code and cannot
drift away from the file the way a list in this document would.

### `local(test)`: the gate judges a merge by the merge's own diff

Three fixes with one cause: a signal that was **absent** was read as a signal that was satisfied.

- `local/gate-unit.mjs` `branchDiff()` treated an empty diff as a resolved one. A sync merges upstream
  _onto_ `main`, so `merge-base(main, HEAD)` is HEAD itself, the diff is empty, and
  `flakeWaiver` reads "nothing coupled was touched" — waiving every flaky pass on a line a 556-commit
  merge had just built. That is the release line, which is where the gate runs. An empty diff now falls
  back to the merge's first parent (`HEAD^1..HEAD`, what that merge contributed) and to `unknown` when
  there is nothing to compare against, and `unknown` never waives. The `7811f60dd6` PASS above — "1
  flaky re-run passed" — was judged the old way, immediately after a 556-commit merge.
- **Run-level unhandled errors are allowed by headline, and now by regex, on both lanes.** An
  unhandled error is a claim about the run rather than about one test, and its headline can embed a
  machine-specific path — a pnpm store location, a dev-server URL. `local/unit-known-red.json` and
  `local/nightly-linux-known-red.json` therefore each carry an `unhandledErrors` list whose entries
  may give a `match` regex source instead of an exact `headline`; `local/gate-unit.mjs` (via
  `unit-gate-judgement.mjs`) and `local/check-unit-shard-verdict.mjs` honour both forms. Three
  headlines are classified this way, and each is a **claim with a test**: monaco-editor's own
  `CancellationError` raised when the editor is disposed, a `node-runtime` pool worker dying mid-run
  (already documented here), and the browser-mode dev server failing to serve Monaco's TypeScript
  worker because the URL embeds the dependency store path. None of the three names a repository file
  or a test, and the runs that carried them had 0 unexpected named failures — which is the standard
  they must keep: if a run ever reports one of these _and_ an unexpected failure, the failure is the
  finding, not the headline.
- `local/unit-known-red.json` entries carry a `match` regex, tested against the first line of the
  failure, and **every entry needs one** unless it declares `flaky: true` — see § `local(ci)`: one
  known-red matcher (#317), which is where that rule and its enforcement live now. When the field was
  optional, an entry matched on file and title alone, so an allowlisted test that started failing for a
  **new** reason stayed "known" for as long as its title did.
- `config/scripts/check-changed.mjs` resolved its base as `origin/main`, which on this fork is
  **upstream's mirror** — so the pre-handoff gate diffed the fork's whole 2,846-file delta instead of
  the branch's own. `origin/HEAD` now comes first, as it already does in the sibling
  `check-changed-code-quality.mjs`.

### `local(ci)`: the fork's own heavy tests get shard weights (#401)

`src/shared/workspace-path-catalog-core.test.ts` ran the full parity battery at 100k **and** 300k paths
in the default unit suite. In nightly run 43018513608 it took **178.2 s**, the slowest file in the suite
by 5x (the next heaviest is 34.3 s), and its shard's job took **494 s** against a 311 s median. The
planner could not see it: `ci-shard-timings.json` is imported from **upstream** runs, whose tree has no
fork files, so no fork-added file can ever appear in it, and the file was scheduled at the 442 ms
fallback — about 400x too light.

- **The 300k case moved under `ORCA_RUN_PATH_SEARCH_SCALE`**, the flag three other scale files already
  share. The default run keeps a **30k** case, which takes this file from 59.9 s to 4.4 s locally (178 s
  to 14.9 s in CI, both measured). Not a new flag (a synonym), and not `performance-contracts.yml`: that lane
  counts operations, runs three OSes one file at a time, and its `paths:` filter has to stay in sync with
  its contract allowlist. The 500k and 1M cases moved behind `ORCA_RUN_PATH_SEARCH_SCALE_BATTERY`, the
  second flag `workspace-path-search-scale.test.ts` already uses, because they want a 2 GB catalog budget
  and about four minutes.
- **`fork-main-tests.yml` gained a `scale` job** that runs that file with the flag beside the shards, so
  scale parity is automatic again rather than manual only — and, being a separate job, it cannot move
  the shards' balance.
- **`local/ci-shard-timings-overlay.json` is merged over the baseline** by `mergeForkTimingOverlay` in
  `local/ci-shard-timings-overlay-merge.mjs`, which `readTimingBaseline`
  (`config/scripts/ci/sharding/ci-shard-assignment.mjs`) calls in two lines. Every caller already goes
  through it: the CI shard sequencer, the runtime sequencer, the PR selection plan and the E2E plan. A
  missing overlay falls back to the baseline alone, a malformed one **throws** rather than scheduling
  with no weights, and **the baseline wins any collision** — a collision means the file reached upstream
  and the entry is stale. The overlay's bytes join the `baselineSha256` in `unit-assignment.json`, so a
  run's provenance names both files. Why the merge is a fork module rather than lines inside
  `readTimingBaseline`: § Rules above, and it leaves the upstream hunk at one import and one call.
- **`local/ci-shard-timings-overlay.mjs` is the only way to change it.** `import <artifact-dir...>`
  rewrites the entries from a nightly's `unit-report.json` artifacts: fork-added files, absent from the
  baseline, measured at **2 s or more** — the threshold is where the artifacts' `endTime - startTime`
  agrees with the baseline metric (median ratio 1.03 above 5 s; below it, the baseline's per-file
  environment allowance dominates and the 442 ms fallback is closer). It refuses an artifact set that
  mixes runs or attempts, holds a file twice, reports a file discovery did not select, does not cover
  every shard exactly once, or would weight nothing — upstream's importer rejects the same cases, plus a
  reported file discovery did not select. `--check`
  validates the committed file, asks the planner to load it, and runs in the fork test lane;
  `--simulate` replays a set of artifacts through `balanceFiles` and prints the slowest-to-median shard
  ratio, which is how the acceptance criterion is evidenced without a 12-shard run.
- **`local/ci-shard-timings-overlay.test.mjs`** covers the merge, the baseline-wins rule, the malformed
  and missing cases, the entry selection, the artifact-set refusals, and the committed file against the
  committed baseline.

**Measured, from the same lane before and after — one run each way.** `fork-main-tests.yml` dispatched on
the branch (run 43332008251) gives test-step durations of **237–288 s, median 269.5 s, 1.07x** against
run 43018513608's **232–453 s, median 268 s, 1.69x** — the issue's 1.3x criterion, met.

Most of that gain is the 300k move, not the overlay: replaying the same artifacts with the baseline alone
still gives 1.21x, and 1.10x with the overlay. The overlay's own job is that it keeps the placement
correct as fork-owned files accumulate, which is what the missing entry cost before. The overlay the run
wrote is its own measurements, with no estimate in it.

That run's shard 5 job took 716 s against 288–334 s for the other eleven, which is **not** shard
balance: 420 s of its 716 s was the `Checkout` step, against 18–22 s elsewhere, and its test step was
268 s.

Refresh: `node local/ci-shard-timings-overlay.mjs import <dir-with-the-12-artifacts> --runner
ubuntu-24.04-arm`, then `--check`.

### `local(ci)`: the nightly could queue forever and say nothing

`fork-main-tests.yml`'s last **passing** run was 2026-10-08. The 2026-10-26 schedule then hit two
failures at once. Its `relay_integration` job queued on a runner label this fork does not provision —
`unit-tests.yml` asks for `blacksmith-4vcpu-ubuntu-2404` — and four of its five test shards **failed**
(shard 4 passed). The run sat for ~17.5 h and was then cancelled, which set the run-level conclusion to
`cancelled` and hid the red shards behind it. Eighteen days with no passing night, and the only signal
was absence.

Three changes:

- **`run_relay_integration: false`.** `unit-tests.yml` takes that input; the fork ships no cloud relay,
  so the job had nothing to test here even if a runner existed. It drops the two `relay-region` unit
  files, which shard discovery excludes and only that job ran. It does **not** drop `browser_contract`:
  this caller never enabled it (its default is `false`).
- **`cancel-in-progress: true`, with the group keyed on `${{ github.ref }}`.** Under `false` a run
  that never finishes holds the slot until a human cancels it; the 10-26 run held it for 17.5 h.
  Superseding is safe because a shard takes minutes and the next schedule is a day away. The ref in
  the group name keeps a `workflow_dispatch` on some feature branch from cancelling the release line's
  nightly.
- **`node local/check-nightly-liveness.mjs`**, because the first two only make a failure faster. See
  below.

**A shard now greens for a known red, and reds for anything else.** `unit-tests.yml`'s shard job leaves
Vitest's exit code in charge upstream and hands it to `local/check-unit-shard-verdict.mjs` here, so that
script is what reds a nightly shard. It ignored `local/nightly-linux-known-red.json`, which meant every
recurrence of the already-triaged daemon disconnect race failed the workflow and emailed an alarm — at
07:19 on 2026-10-27 for shard 4/5, a failure whose evidence was already written down. It now reads the
manifest on Linux: a matching red is a tolerated warning and the shard passes, an unmatched one still
fails by name. Four inputs are never absorbed — a file-level error (including one beside an absorbed
row), a report declaring more failures than it lists, an unhandled error other than the tolerated
teardown race, and a shard that failed with nothing to explain it. It cannot see a describe-level hook
failure that Vitest attributes to a suite rather than to the file's `message`, because
`numFailedTestSuites` counts failing describes as well as files (2 for one failing file, measured) and
would red every night. Two more inputs are never absorbed since #314: a report that does not name every
file the shard was assigned, and a failed shard whose only explanation is a tolerated worker crash — see
§ `local(unit-ci)`: the Vitest worker teardown race.

The night's verdict is still the cross-shard checker's, not the shard's: `--failures` insists on one
report per declared shard and fails a red that no entry accounts for. What the shard-level change buys
is that a known red no longer sends mail; a new one still does, once, with its name.

**What the first real runs measured.** The 2026-10-26 scheduled run (id `40308443374`) is unusable as a
red set: its cancel rewrote the run-level conclusion, so a reader saw four red shards and no verdict.
The cleaner measurement is the 2026-10-27 dispatch (id `40460070298`, tree = `main` plus this
repair): five shards, **three green**, and three red files in total —
`rate-limits/service-inactive-claude-cooldown.test.ts`, `daemon/daemon-appimage-copy-host.electron.test.ts`
and `daemon/daemon-electron-to-node-adoption.electron.test.ts` — plus one unhandled error,
`selector_not_found`.

**All three were the branch gap, not the platform.** Each maps onto a commit that exists here and not on
`main`: the cooldown expectation (`ba8e632509`), the fixture's esbuild specifiers
(`be847f718f`), and the unhandled rejection (`fbb41b497d`). The third is a **test defect** — the test
attached `.rejects` after awaiting a different promise, so the refusal settled unobserved while the
assertion still passed. So this measurement shows Linux carrying **no environment-bound red set of its
own**: the Mac allowlist's two classes (`host-toolchain`, `sqlite-binding`) do not appear there at all,
and two of the three red files are electron suites that skip on macOS and cannot bundle on Linux until
the fixture path is right.

The lesson is that a red nightly has to be read against `git log`, not against the allowlist: the
allowlist describes this Mac and the runner describes `main`.

**What none of that fixes:** the cancelled run did not block 10-27 — it was cancelled at 04:02Z, ~50 min
before that day's 04:53 cron — and **no scheduled run fired on 10-25, the first night after the 10-24
re-enable, nor on 10-27**, with the slot free both times. `cancel-in-progress` does nothing about a
schedule that does not fire; only the check does. (The wider gap back to 10-08 is the workflow being
disabled in the fleet sweep, which is a different cause and a known one.)

The check exits 0 on a fresh green run, 1 when the newest scheduled run is stale (past two schedule
slots), **wedged** (not `completed` for more than four hours from its own `startedAt`), or **red**, and
2 when it cannot tell. Exit 2 is deliberately not a pass: a missing `gh` must never read as a green
nightly. Make it the first thing a session does after a sync, next to `local/branch-status.mjs`.

It reads two clocks, because a run that was **cancelled on purpose** is not a red night and must not
hide the last verdict: one clock asks whether the schedule fires at all (a `workflow_dispatch` does not
prove the cron fires, so it does not count), the other asks when a completed run last produced a
verdict. An in-flight run is a note on that verdict, never a substitute for it — otherwise a re-run
dispatched after a red night would report green for hours.

**A cancelled run's shards still get a vote.** The check's own first version read the run-level
conclusion only, so run `40308443374` — `cancelled`, with four failed shards — read as "no verdict".
Had the night before been green it would have reported **PASS** on a night that went red, which is the
same failure it exists to catch, one level down. It now reads the jobs of completed verdict-less runs
(up to five, and only runs newer than the newest run with a verdict of its own) and takes a red verdict
from them: a cancel can hide four red shards, but only from a checker that does not look.

**The cost of that, stated plainly:** with `pr.yml` off there is **no required `verify` aggregate on a
fork PR**. A PR can show a couple of unrelated lanes or nothing at all and still read as mergeable, so
the pre-PR gates in `AGENTS.md` (targeted tests for the changed area, `pnpm tc`, `gate-lint`, plus the
review) are the only thing standing between a change and `main` — nothing in CI backstops a
skipped run. Since 2026-10-24 the full unit suite is therefore not a PR gate at all; it runs nightly on
`fork-main-tests.yml` and again at the release gate, and the failure window that choice accepts is a
cross-cutting break sitting on the release line until one of those two runs.

**The Linux red set, and why the Mac one does not substitute for it.** The Mac allowlist names _this
machine's_ environment; the nightly runs `ubuntu-24.04-arm`, which has its own. `local/nightly-linux-known-red.json`
is that set — an entry needs a `file`, a `test` name, a `class`, and **`evidence`; an entry without
evidence is a hard problem, not a warning**, because that is the difference between a verdict and a mute
button. `node local/check-nightly-linux-parity.mjs <artifacts> --failures` judges every failing assertion
in the shards against it: no entry → the run fails; a listed test that _passed_ is reported as prunable
(reported, never enforced, so an upstream fix does not turn the night red in the other direction); and a
file-level failure (a `beforeAll` or import error with no assertion rows) can never be absorbed by a
name-matching entry.

Its first entry is `daemon-pty-adapter-history-recovery.test.ts › serializes concurrent keepHistory and
disconnectOnly checkpoints` (the name is Vitest's full one, describe chain included, since #317), which
failed on Linux in **both** runs — the 04:53Z schedule
(`40485647652`) and this dispatch — with `DaemonConnectionLostError: Disconnected` out of
`disconnectOnly()`, while passing 3/3 on this Mac. Every file in that stack is upstream-owned with zero
fork hunks, so it is upstream's race under Linux runner timing, and the entry records its exit condition
rather than hiding it. Verified in both directions: `--failures` exits 0 on this run's artifacts and
exits **1** on the earlier one, naming the three branch-gap reds that the merge has since fixed.

**The first scheduled run after the unblock, read (2026-10-27, run id `40485647652`, `main` @
`7c53c12a17`).** The schedule fires again — that is the part `#186` fixed, and this run proves it on a
real slot rather than by dispatch. It is red: `plan` succeeded, all five shards ran, `relay integration`
skipped as intended, and **four files failed across four shards** (shard 3 green).

- Three are the branch gap this branch closes, exactly as the dispatch predicted: the cooldown
  expectation, and both `daemon/*.electron` fixtures whose esbuild specifiers `be847f718f` rewrote.
- The fourth is new and belongs to the lane, not the fork: `daemon-pty-adapter-history-recovery.test.ts
  › serializes concurrent keepHistory and disconnectOnly checkpoints`, failing with
  `DaemonConnectionLostError: Disconnected` out of `disconnectOnly()` at its own line 292. **All five
  files in that chain are upstream-owned with zero fork hunks**, so it is upstream's own race under
  Linux runner timing, not a regression here — and it passes 3/3 on this Mac, so it is not a Mac
  allowlist entry either. It is the first case that needs a _Linux_ flake set, which § 6.2's parity
  checker does not carry; until one exists, read it as an ownerless red and do not "fix" it inside the
  fork.

`node local/check-nightly-linux-parity.mjs` on that run's artifacts: **PASS — all 17 Mac-allowlisted
entries passed on Linux** (22/23 pruned entries passed; one absent because it is a macOS-only bundle
test). So the Mac red set transfers clean, and the four failures are branch gap plus one upstream flake —
no environment class of Linux's own, the same conclusion the dispatch reached.

### `local(ci)`: one known-red matcher (#317)

Four judges decided what a listed red covers, and they had drifted apart. `local/gate-unit.mjs` honoured
an entry's `match` and compared the test name exactly. `local/check-unit-shard-verdict.mjs` — the script
that decides a nightly shard — **ignored `match` entirely** and accepted any test name that merely
_ended_ with the entry's title, so a `TypeError: totally new bug` in an allowlisted test was absorbed as
known. `local/check-e2e-known-failure-titles.mjs` matched a title with no notion of a cause at all. And
`local/gate-lint.mjs` read a missing `match` as the broadest possible entry, so one forgotten field
allowlisted a whole step. Two report walkers (`collectCases` and the shard verdict's
`failingTestNames`/`failedFilesWithoutFailingTest`) and two unhandled-error matchers had the same
problem: the shard's walker never read `failureMessages`, so there was no text for a `match` to test.

`local/lib/known-red.mjs` is now the one matcher. A listed failure is absorbed only when the file matches
by `/`-bounded suffix (a report names `/home/runner/work/orca/orca/src/a.ts`, the manifest `src/a.ts`),
the test name matches **exactly** — the suffix match is gone — and the entry's `match` matches the
failure's first line, ANSI-stripped with the reporter's leading `Error: ` removed. Every entry in
`entries` must carry a `match` unless it is `flaky: true`; a missing or unusable one is a named verdict
problem at every call site, and an unusable one absorbs nothing rather than everything. `flaky` used to
be a display label and is now the declared exemption from pinning a cause. `unhandledErrors` entries must
name a cause by `match` or an exact `headline`, with no `flaky` exemption: those are claims about the run,
not about a test. The lint gate keeps its whole-step form, but says so explicitly with
`"wholeStep": true`.

A third bucket came out of the two-way match. An entry whose test failed for a cause its `match` does not
describe is **`drifted`**: unexpected — the verdict fails — but not `unseen`, which a full run reports as
prunable. Without it the first new cause would have proposed deleting a live entry.

Two manifests changed in the same commit, as `AGENTS.md` requires:

- `local/nightly-linux-known-red.json`: the one entry named after the
  daemon-pty-adapter-history-recovery suite, and upstream's `2f217b4d0dd`
  (#38462) moved the file into `src/main/daemon/providers/adapter/testing/` on 2026-11-05. A
  `/`-bounded suffix match cannot pair those, so the entry had been matching **nothing** — the red it
  exists to absorb was not being absorbed at all. It was given the real path, Vitest's full name, and
  `match: "^DaemonConnectionLostError: Disconnected$"` — the whole message, which
  `src/main/daemon/transport/client/daemon-client.ts:283` raises as `rejectAll('Disconnected')`. The
  entry's own `evidence` had quoted `DaemonConnectionLostError: Disconnected` and then, in prose,
  "out of `disconnectOnly()`"; only the quoted part is the error text, and a `match` written from the
  sentence rather than the message would have drifted on the next recurrence. Nothing static covered that manifest;
  `tests/tools/unit-gate.test.mjs` now checks that every entry names a file this tree has and a full name
  that file can still produce. That suite has since been retired — the whole
  `src/main/daemon/providers/adapter/testing/` tree went in upstream's 2026-11-24 test-inventory pass —
  so the entry named a file this tree no longer has, which the check just described reports. It was
  pruned, not re-homed: the suite is gone and only upstream owned that red.
- `local/e2e-known-failure-titles.json`: 30 titles, none with a cause. 17 of the 28 that remain carry a
  `match` built from the `::notice::known failure … — <detail>` lines of the eleven retained scheduled
  runs (2026-09-27 … 2026-10-08, runs `36346182978`…`37848060391`), unioned across every shape observed
  for that title; 11 have no retained observation and declare `flaky: true` instead, which is a claim a
  reader can check rather than the previous silence. The remaining two of the 19 observed shapes were on
  the entries pruned below. Two further entries were **pruned**: their spec
  files no longer exist — `plugin-startup-budget.spec.ts` deleted in `8fb8e6ef0f2` (#37421) and
  `sidebar-measured-row-scroll.spec.ts` in `e98c6a439ac` (#38030) — and the verdict only reports a stale
  entry that _passed_, so both would have sat there for ever. The contract test now fails on an entry
  whose file is gone.

The e2e lane also gained the expected-spec check it never had. `decideE2eVerdict` could not tell a shard
that ran its whole selection from one that was interrupted partway: a spec with no result at all was
neither failed nor passed, so a run with one known failure could pass after a timeout. The verdict step
now passes `--selected ci-shards/selected.txt` — the same file it hands Playwright as `--test-list` — and
fails when a selected file is absent from the report, when a spec produced no result while none of its
tests declared a skip, or when the report names a file the selection does not. It is deliberately **not**
"every selected spec must run": 179 of this repo's 587 e2e spec files call `test.skip`, and a
platform-conditional skip is legitimate. The mechanism is **SUSPECTED, not reproduced**: this config sets
no Playwright `globalTimeout`, and the job's `timeout-minutes` kills the verdict step with the run. What
the check closes is an interrupted run that still finishes the step.

### `local(ci)`: the fork's own tooling tests now run in CI, against the recorded sync base (#318)

The fork's 17 `local/**/*.test.mjs` files sat outside `UNIT_INCLUDE`, so no unit lane collected them:
the only thing that ran them was `gate-unit.mjs`'s fork step, i.e. a release gate somebody had to start
by hand. A broken `local/sync/lib` assertion could therefore live on the release line indefinitely, and
`check-test-file-runners` printed the entry as `Manual only, no CI job` — a line that was honest and
stayed true because nothing changed.

- **`node local/run-fork-tests.mjs`** is the lane's command, in `fork-main-gates.yml` (release line) and
  in `fork-pr-gates.yml`'s `changed-lines` job (before the merge, which is the only place a red is
  cheap). A script rather than the glob in the workflow: `node --test` given a quoted glob **exits 0
  when the pattern matches nothing** (measured), so a lane that silently proved nothing would be the
  same class of defect as the one this closes. An empty match is exit 2, the refusal `gate-unit.mjs`
  already makes for its own fork step. The runner entry in `check-test-file-runners.mjs` loses
  `manual: true` and becomes one row per workflow, so removing the step from either one is drift.
- **The max-lines exemption rule moved out of the Vitest inventory**, from the retired
  tests/tools/max-lines-policy.test.mjs to `local/max-lines-exemption.test.mjs`.
  The old test tried `origin/main`, then fell back to `origin/HEAD` — which resolves to this fork's
  default branch, not upstream's, so the base it compared against was a tree that carries every fork
  path. "Every path exists upstream" made the rule check nothing. It also
  `skipIf`-ed silently in a CI checkout, which has neither ref. The comparison is now the **recorded
  sync base**, `local/upstream-file-comments-baseline.json` `.base` — the same record
  `check-upstream-file-comments.mjs` already falls back to, rewritten by the runbook's `--init` step.
  Never a ref tip: `upstream/main` today (`6530fd17772`) no longer carries two baseline rows upstream
  moved after the 2026-11-08 sync (`ssh/connection/ssh-connection-store.ts` → `ssh/targets/`,
  `ssh/ssh-channel-multiplexer.ts` → `ssh/protocol/`), so a tip-based ruler reports two upstream-owned
  files as fork-owned. All 73 rows exist at the recorded base `51c77320bc`. A missing base **fails**
  with `git fetch --depth=1 origin <sha>` instead of skipping, and both lanes run that fetch before the
  tests. The test left the Vitest inventory and joined the fork-local lane, which runs on PRs: coverage
  went up, not down (`pr.yml` is disabled here and the unit suite is nightly-only).
- **`unit-suite-run.mjs` has tests**, which is what found the last one: a nested `node --test` run under
  a test runner prints "skipping running files" and **exits 0**, so `NODE_TEST_CONTEXT` is now cleared
  for every spawn alongside the app's own inherited env. A gate started from inside a test would
  otherwise have read a failing suite as a pass. `runSuite` takes a `forkProgram` seam so the ENOENT
  case is reachable; timeout and a non-zero fork step use real spawns.

The five `local/sync/*.mjs` entry points stay untested on purpose: they export nothing and are argument
parsing over `lib/` modules that are covered.

### `local(ci)`: four new upstream workflows arrived active, and one was deleting the release line's caches

`node local/check-actions-enablement.mjs` after the 2026-10-28 nightly repair reported **four**
workflows active that are not on the fork's live list. Enablement is repository state, not tree state,
and a workflow file the fork has never had arrives **active** — so a merge that adds one switches it on
with no diff a reader could see. These four came in with upstream's `d9a7aa89c8` (2026-10-25),
`581e23319d`, `8b64ec281a` and `965286939d` (2026-10-27).

- **`ci-branch-cache-sweep.yml` — the one that made this more than tidying drift.** Its keep-set is
  `new Set(['refs/heads/main'])`, and this fork's default branch was then **`nplez1/main`**
  (`gh api repos/nplez1/orca --jq .default_branch`) — so on this fork the branch it was told to keep
  was the upstream mirror, not the release line. Its only run,
  `40762364436` (2026-10-28T20:20Z), logged `Removed 28 idle branch caches (9.39 GB)` and all 28 were
  `refs/heads/main` — the branch its own keep-set names, which is the part that does not add up and is
  recorded here rather than explained away. They included `node-cache-*`, `electron-builder-*`,
  `electron-package-Linux-ARM64-43.8.1`, `native-modules-*`, `pnpm-lockfile-verified-*` and a `bun-`
  key. It ran every three hours. The damage is checkable
  from the other side: the confirmation run below reports `Cache not found for input keys:` for
  `electron-package-Linux-ARM64-43.8.1`, `native-modules-…-4480ff7f…` and `pnpm-lockfile-verified-Linux-arm64-…`
  — keys this sweep had deleted about 4.7 h earlier, matching down to the lockfile-hash suffix. **Never
  re-enable it without moving the keep-set to this fork's default branch in a fork hunk**, and it does
  not belong in `ALLOWED_INERT` either: it has a `schedule`, which is the same reason that list already
  gives for `fork-main-tests.yml` not being inert-able.
- **`unit-module-cache.yml`** — asks for `blacksmith-8vcpu-ubuntu-2404`, which nothing here answers, so
  its run `40695036546` queued all five shards for 12 h before it was cancelled here. Two
  corrections to the first reading of it, both worth having written down, because both make the wedge
  **less** costly than it looked. That run was a **push on `main`** — the upstream mirror, carrying
  upstream's own `f173998203` — not on `nplez1/main`, so `unit-module-cache-${{ github.ref }}` never put
  it in the release line's concurrency group; and the 22:35Z scheduled run `40781154313` was not
  superseded, it was **skipped by design**, because `unit_plan` carries
  `if: github.ref == 'refs/heads/main'` and a schedule on `nplez1/main` can never satisfy it. Every
  scheduled run of this workflow on this fork is skipped for that reason. So the wedge cost a queue slot
  and an Actions tab that read "queued" for half a day, not a night of coverage.
- `computer-macos-native.yml` — upstream's computer-use E2E on `macos-15`, on every PR plus 06:00 UTC.
  No consumer here, and the most expensive label in the set.
- `wsl-orcad-e2e-frozen-runner-retry.yml` — inert in practice (it hangs off a `workflow_run` whose
  parent is disabled), but it is upstream's lane, not this fork's.

After `--fix`: `76 workflows on nplez1/orca, 10 active (3 required + 7 allowed-inert)` and `OK`.

**Disabled is the end state for the cache producer, not a repoint.** The tempting fix — run it on
`ubuntu-24.04-arm` so its key lines up with the nightly — fails in both halves. The nightly passes no
`module_cache`, whose default in `unit-tests.yml` is `'off'`, so there is no restore step for a producer
key to match; and a cache saved by a run on `main` is restorable only by runs on `main` and PRs based on
it — what is shared across branches is the other direction, caches written on the default branch
(`nplez1/main`, and `main` since the rename). Making it real costs three hunks in upstream-owned files — the caller's
runner, `unit_plan`'s `if:` guard, and `module_cache: warm` on the nightly — for a cache nothing here
consumes, since `pr.yml` is off and there is no PR shard to warm. Disabled, and no fork hunk taken.

**The nightly itself was already green, and the red an alarm names is stale.** Read at
2026-10-29T01:00Z: `node local/check-nightly-liveness.mjs` → `PASS`; the newest verdict is run
`40701735011` on `1776dcc575`, all five shards, and `5432633b47` after it touches docs only. The last
**scheduled** run `40675428994` (`10:51Z`) is the red one, and it ran on `7b86cb08` — the pre-merge
commit, before `029137ad95` (the sync's 25-file red set) and `1776dcc575` (a darwin-only cooldown
assertion) existed. So a reader must date a red shard against `git log` before treating it as current;
the run-level word on the Actions page is a day behind the tree.

The Linux red set keeps its one entry. The daemon disconnect race failed in that same scheduled run
(`##[warning] unit shard tolerated a known Linux red, already triaged`) and passed in **every** run
since: `40695078222` (on `d96a57ffc6`, shard 3 green; that run failed only shard 1's cooldown
assertion), `40701735011` (on `1776dcc575`, all five shards) and `40797794635` (below) — the last two
carrying its own `did not fail here, so its known-red entry may be prunable` notice. It stays anyway:
the passes are dispatches, and the entry's exit condition asked for two consecutive green **scheduled**
nights, which no two scheduled runs on record have delivered — the only green scheduled run here is
2026-10-08. The history is also what makes a short pass count weak as evidence of a fix: three failures
in seven observations would produce two passes in a row by luck about a third of the time. So the entry
now asks for the upstream fix, or five consecutive green scheduled nights.

**Confirmed on the revision this record lands on:** run `40797794635` on `fdd5850d0f` (dispatch,
2026-10-29T01:01Z) — `plan` green, all five test shards green, `relay integration` skipped as intended,
and the daemon entry passing rather than absorbed. The `##[error]` lines a green run carries are expected
noise, not reds: `src/entry.ts(1,14): error TS2322` is the broken fixture the
`build-cli` suite writes and then asserts the compiler reports (that suite has since been retired
upstream), and
`cannot read report.json: ENOENT` is `tests/tools/unit-shard-verdict.test.mjs` (23 cases, green)
exercising its own error paths. `Unable to download artifact(s): unit-selection-attempt-1` is the
optional artifact a fresh dispatch has none of. That run also paid the sweep's bill: the three cold
`Cache not found` restores named above.

### `local(sync)`: a file upstream owns is restored, not deleted

The fork deleted 39 files upstream still owns and still edits, so every one was a modify/delete conflict
on the next sync **and** a place where upstream's later fixes were silently dropped instead of
surfacing. Of the 17 outside the dashboard/pop-out subsystem, **13 are restored**; the four that stay
deleted are recorded below with their reason rather than left implied.

Restored, present, and dead — nothing in the fork imports any of these:

- the five Jira files (`JiraIssueRowCopyMenu`, `JiraLinkedWorkspaceAction`, `use-jira-issue-{comment-submission,remote-details,workspace-data}`)
  — the fork's split-button row and side-data modules replaced them. Every import resolves and every
  `translate()` key is in `en.json`, so they compile even though nothing calls them.
- `quick-open-capped-local-listing.ts` — `nextCappedLocalListing` has had no caller since `b3a4f9ddac` (#34).
- three `docs/assets` images — upstream's README references them at lines 7 and 267; this fork's does not.

Still deleted, deliberately:

- `native/computer-use-macos/.../TrustedOrcaApplication.swift` (+ its test), which
  `convergence-ledger.md` already records as a **Do not take back**. Upstream's file hardcodes
  `com.stablyai.orca`; this fork's helper trusts `com.nplez1.orca.computer-use` from its own
  `OrcaBundleIdentity.swift` (fork-created), so restoring it verbatim would make the helper trust
  _upstream's_ app — a real defect, and exactly what
  `config/scripts/computer-use-bundle-identity.test.mjs:39-43` exists to catch.
- `right-sidebar/pr-comment-snapshotted-thread-resolver.ts` (+ test). #169 made the pending ack
  reply-only and removed `PendingPRCommentAiAckGithubResolveTarget`, `PendingPRCommentAiAckGitlabTarget`
  and the `githubResolveTarget`/`gitlabTarget` fields this resolver works against; it cannot compile
  without resurrecting that model, and a dead file is not a reason to bring a removed capability back.
  `local/sync/mergeability-plan.md` § 5 already carries this as a product decision.

The 22 dashboard/pop-out files are split by whether they can be inert, and the split is recorded in
`local/sync/expected-deletions.json` rather than left implied. **The decision is the owner's and it is
settled (2026-10-26): the fork ships the Agent Dashboard as a content-area view and rejects upstream's
drawer and pop-out window**, which are a different feature rather than a better version of the same
one. That makes the renderer half a permanent product deletion, not an unresolved merge question.

- **4 held, dead**: `src/main/ipc/dashboard-popout.ts` (+ its test) and
  `src/main/window/dashboard-popout-window.ts` (+ its test), byte-identical to `upstream/main`.
  Nothing registers the IPC and nothing opens the window — `electron.vite.config.ts` has no `popout`
  entry and there is no `popout.html` to load — so they are dead, but they typecheck and **their 33
  cases pass**. Holding upstream's bytes costs nothing and removes four modify/delete conflicts; the
  ledger marks them `take-theirs` so a sync does not read them.
- **18 stay deleted**, including the preload pair this bullet used to call restored.
  `dashboard-api.ts` and `dashboard-bridge.ts` exist only to publish `window.api.dashboard`, which the
  fork's board stopped calling when it dropped the pop-out relay; `dashboard-bridge.ts` type-checks
  itself against `PreloadApi['dashboard']`, so keeping it forces a `dashboard` member onto `PreloadApi`
  for a runtime API nothing registers. `clipboard-dashboard-popout-access.test.ts` goes with them: it
  asserts that `assertTrustedClipboardTextSender` admits upstream's pop-out renderer, and dead code has
  no business adding an admission to a clipboard trust check. The rest are the drawer, the sidebar
  host, `popout.html`/`popout.tsx`, `DashboardPopoutRoot`, `useDashboardSnapshot` and the open-mode
  and bridge hooks — none of which can be restored inertly. Upstream's drawer needs
  `AppState.agentDashboardDrawerOpen`, which #44 removed, and its `DashboardPopoutRoot` renders the same
  `AgentKanbanBoard` the fork's **live** page renders, so restoring it puts a second live board over one
  snapshot.

Restoring all 22 was measured before deciding, not assumed: **11 of 57 cases fail and `tc:web` reports
29 errors**, because upstream's renderer half has moved past the fork's. That number is the price of a
rejected delivery, not an argument for changing the decision.

`electron.vite.config.ts` keeps upstream's `popout` entry deleted along with `popout.html`: an entry
that resolves nothing does not build, and the fork's comment there says why.

### `local(sync)`: the sync's subagent prompts are checked in, and the Linux lane runs early

`local/sync/templates/` holds the prompts the 2026-11-15 release agent wrote from scratch — the release
brief (the documented way to start a sync and release), the conflict protocol, the per-batch resolver
prompt and four repair prompts — with that run's lessons as rules: batches of at most 20 paths staged
file by file (its 51-file batch staged nothing in 26 minutes), no repo-wide commands in a resolver, no
`sleep` polling (23 polls, 162 minutes), and one runner per heavy gate.

`local/sync/linux-lane.mjs` is UPSTREAM-SYNC-RUNBOOK.md Step 3.5: push HEAD to `sync-candidate/<sha12>`
and dispatch `fork-main-tests.yml` there, because four of the six 2026-11-16 release dispatches failed
in `fork-release.yml`'s Linux unit lane at 8–60 minutes a loop. It refuses a candidate whose tree has a
`push`/`create` trigger that would fire for the ref, or an unprovisioned runner label the lane can
reach; `--cleanup` deletes only candidate refs `origin/main` contains, each leased to its listed sha.
Guarded by `tests/tools/linux-lane.test.mjs`.

### `local(test)`: two `orca-runtime` defects were test bugs, not environment reds

`local/unit-known-red.json` carried three `orca-runtime` items as `macos-path-semantics`. Both causes
were defects **in the tests**, and both are fixed, so the three entries are removed in the same commit.

- **`/private/var` vs `/var`** (two cases). Upstream #30657 (`f6e9e649f4`) made the runtime store git's
  resolved toplevel on purpose, and pinned that in
  `runtime-repository-registration-controller.test.ts:154`, which already calls `realpath` on its temp
  dir. #30657 missed two cases in `repository-project-operations.spec.ts`, which kept comparing against
  an unresolved `mkdtemp(tmpdir())`. **Upstream fixed it in #33540 (`6b255983ae`)**; this takes that hunk
  byte-for-byte, comment included, so the next sync merges it with no hunk to resolve.
- **`Error: selector_not_found`** as an unhandled-error headline. The refusal itself is correct: a
  removal scoped to `ssh:host-b` cannot find the worktree on that host. The test created its promise,
  awaited a _different_ promise, and only then attached `.rejects`; the rejection settles before the
  local removal's real I/O completes, so Node raised an unhandled rejection and Vitest reported it while
  the assertion attached afterwards still passed. Attaching the handler before the await fixes the
  reporting and changes nothing the test checks. The allowlist's `evidence` line blamed the coalescing
  map, which the stack trace contradicts — the rejection comes from target resolution at
  `workspaces/workspace-removal.ts:87`, before that map is reached. The same defect exists on
  `upstream/main` today.

`pnpm test` over the orca-runtime construction suite — before: 2 failed and 1 unhandled
error; after:
`1520 passed | 3 skipped`, green on three consecutive runs. Every cached verdict under `orca-gate/`
mentions `selector_not_found`, so this was persistent rather than a one-off. The suite itself went in
upstream's 2026-11-24 test-inventory pass, so `src/main/runtime/construction/` has no test at HEAD and
the handler-ordering fix recorded here is owed a home.

**Every other `macos-path-semantics` entry was the same defect, and they are all fixed.** Nine cases
across five files, each creating a temp dir with `mkdtemp(tmpdir())` and comparing it against a path the
subject had resolved — the darwin launcher's `cd -P`, orcad's deploy root, a spawned child's reported
cwd. Each now resolves its temp dir first:
the orcad forked-child-paths suite (4), the packaged-cli-assets suite (1) and the macOS
terminal-host-bundle suite (1).
The `orca-runtime` pair above is the other two. A fifth site, the `cli-build/verify-cli-bin` suite,
carried one of these cases and went with upstream's bulk test removals in the 2026-11-20 sync (#43138);
its subject, `config/scripts/cli-build/verify-cli-bin.mjs`, survives unchanged, and nothing asserts that
temp-dir spelling for it now. All four files were retired in the 2026-11-24 test-inventory pass, so no
test in this tree carries that fork-local realpath fix any more.

Every one of those four files was otherwise byte-identical to `upstream/main`, so each was a fork-local
test fix that would have conflicted once, benignly, had upstream made the same change — the same trade
upstream itself made in #33540. Retired now, so the fix is gone with them.
**The `sqlite-binding` class is now empty too**: 40 entries at the
2026-10-26 baseline, 17 after that repair, and **8 today, all `host-toolchain`** — the dev-rebuild
timeouts (6), the bun `fs.rm` on a read-only directory (1) and one facade case (1). The nine
`sqlite-binding` entries went on 2026-10-29: seven because the suites were re-seated or re-routed into
the Node project (`a886dcd1fe9` for the four topology cases, and `2ecae9a7470` for the three the
import scan had never classified), two because upstream #34661 (`e5f1eef466`) deleted or rebuilt the
cases they named. The `host-toolchain` entries that were bash 3.2 rather than
bun or SQLite are gone with the bash install recorded above.

**The manifest can now notice its own dead entries.** `local/gate-unit.mjs` derives staleness only
from an entry that _matched a failure_, so an entry naming a test upstream deleted is structurally
invisible: it sits in the file for ever and no run will ever derive it, because deriving it needs a
failure it can no longer produce. `tests/tools/unit-gate.test.mjs` therefore checks every entry's title
against its own file, statically, at PR time — a Vitest full name is the `describe` chain and the
case title joined by single spaces, so `titleExistsInSource` in `local/unit-gate-judgement.mjs`
rebuilds that shape from the file's title literals (treating an `it.each` substitution as a
wildcard). It found the one dead entry this section used to describe and no other.

### `local(lint)`: the two #198 flaky-test-pattern reds, fixed in the tree and pruned

`orca-queue node local/gate-lint.mjs` on a branch cut from `main` at `941acb70e0` failed
`lint:ast-grep-gates` on two files that commit merged, and on nothing else. That step is where these
live now: the 2026-10-28 sync folded upstream's `check:flaky-test-pattern-ratchet` into
`lint:ast-grep-gates`, and `local/lint-known-red.json` followed the rename. The red itself did not
change.

```
test-no-real-time-wait:src/renderer/src/components/right-sidebar/checks-list-expanded-details.test.tsx: 1 flaky-test finding(s), baseline allows 0.
test-no-wall-clock:src/renderer/src/components/github/check-details-cache.test.ts: 4 flaky-test finding(s), baseline allows 0.
```

Both are static ast-grep findings, so they are deterministic rather than flaky-that-time, and both
arrive through `941acb70e0` — the fork's own work, not a foreign red. They were allowlisted for one
release line and are now fixed where the ratchet asked for them, so both entries are gone:

- `check-details-cache.test.ts` pins the clock with `vi.useFakeTimers()` + `vi.setSystemTime()`. That
  is what the four `Date.now()` reads needed: `checkDetailsNeedRefresh` compares a payload's `readAt`
  against the wall clock, so the TTL cases were really asking how fast the machine ran them.
- `checks-list-expanded-details.test.tsx` drives `useDelayedFlag`'s 200 ms deferral with
  `vi.advanceTimersByTimeAsync(250)` instead of sleeping 250 real milliseconds to catch a label a fast
  machine never shows. The case went from a real quarter-second wait to milliseconds.

**The claim that stood here was false, which is the argument for fixing rather than allowlisting.** It
said the entries' `match` named the rule and the path, "so a _new_ finding in either file still fails
the gate". It does not. The ratchet prints one line per rule and file — `<rule>:<path>: N flaky-test
finding(s), baseline allows M.` — and the regex is anchored on the rule and the path alone, so a fifth
`Date.now()` in `check-details-cache.test.ts` would have printed the same line and been masked. A
`match` narrows an entry to one file; it does not pin the count, so it cannot notice new findings in
an allowlisted file.

### `local(lint)`: a base-branch typecheck red, repaired rather than recorded

A rebase onto `5793b0a125` turned up a **typecheck** red, which is not something `local/lint` can record:
#205 added a required `onBoardUnavailable` prop to the Jira board and updated most of its call sites,
but not `src/renderer/src/components/task-page/jira/Board.silentRefresh.test.tsx`, so `pnpm tc` failed on
two of its renders. Repaired here — two lines in that test — rather than left as a red no gate can
classify, the same shape as the two base reds repaired in #177. It is a two-line hunk on an upstream
file, so it will conflict benignly when upstream makes the same change.

A second red in the same era is gone and must not be reintroduced: the bare `oxlint` step carried a
whole-step `lint-known-red.json` entry covering six lines (one `max-lines` error from #203 and five
`docs/site` warnings from `6aba202d5e`). `d96a57ffc6` recorded it as stale on the 2026-10-28 sync and
pruned it, and that commit's own note in `local/lint-known-red.json` says so — but the section describing
it stayed behind, saying of itself "delete the entry and this section". Both are gone now.
`local/lint-known-red.json` is empty as of 2026-10-29: both entries it held under `lint:ast-grep-gates`
were fixed in the tree with fake timers rather than allowlisted, so nothing in the file covers a whole
step — or any step at all. The file keeps its note and its mechanism for the next base-branch red.

### `local(usage)`: one manifest classifies a usage provider, and a test proves it (#320)

Anchor: `src/shared/usage-providers/usage-provider-manifest.ts`,
`src/shared/usage-providers/usage-provider-manifest.conformance.test.ts`,
`src/main/host-sync/usage-provider-credential-census.test.ts`,
`src/renderer/src/components/status-bar/fork-usage-providers.tsx`.

**The symptom.** The conventions a provider must satisfy were spread across ad-hoc lists, and each one
could miss a provider upstream adds in a sync: its enablement switch, its credential replication, its
status-bar wiring, its "key configured" flag. Two of the lists had already gone stale —
`isSignInSavedHereOnly` still claimed MiniMax and ZCode were local-only after both keys moved onto
host-settings ports, and no list at all covered the credential stores, so an upstream
`foo-api-key-store.ts` would never have been replicated and nothing would have said so.

**What the fork does.** One entry per provider, typed
`as const satisfies Record<ProviderRateLimits['provider'], UsageProviderManifestEntry>`, so a provider
added to the union fails `pnpm tc` here before it can reach a status bar unclassified. Three
type-level never-checks cover the other direction: a `RateLimitState` slot, a presence flag or a
manifest field that exists on one side only. The fork id set, the fork literal unions, the readout
skeleton both snapshot builders spread, the remote-host flag defaults and `isSignInSavedHereOnly` are
all derived from it.

- **The halves a type cannot see are tests.** `usage-provider-manifest.conformance.test.ts` holds the
  manifest to `USAGE_PROVIDER_IDS`, the default status bar, the wire `StatusBarItem` enum and the empty
  state's slots and flags; `usage-provider-credential-census.test.ts` walks `src/main` for credential
  stores and fails on one that neither an entry nor its exemption list names. That walk is the check
  that catches an upstream-added provider.
- **It lives in `src/shared`, so it is a gate-1 global input.** Both halves are fork-owned files; the
  hunks in upstream files are one call to a manifest helper each, with no rationale comment — the
  ratchet in `local/check-upstream-file-comments.mjs` counts them.
- **What it does not do.** It records that the MiniMax session cookie, the Fireworks key/account
  envelope and the Copilot token/enterprise envelope are `local-only`; it does not replicate them. Each
  needs its own adapter and its own review, and `docs/reference/host-settings-replication.md` now says
  so instead of claiming every provider credential travels.

### `local(usage)`: the status bar adds the fork's providers by merging, not by copying upstream (#324)

Anchors: `src/renderer/src/components/status-bar/use-status-bar-controller.ts`,
`src/renderer/src/components/status-bar/fork-status-bar-usage.ts`.

**The symptom.** The fork had replaced upstream's per-provider body in the status bar controller with
its own projection of every provider — 139 lines changed, 123 of them deletions, in a file upstream
touched 21 times in the 90 days before this base. Every provider upstream adds conflicted there, and
the copy went stale silently twice: upstream's `!remoteOwned` Antigravity gate and its ZCode saved-plan
key both had to be ported into the fork's copy by hand after a merge dropped them.

**What the fork does now.** Upstream's body is restored byte for byte. `git diff upstream/main` on that
file is three lines: the import, `return {` becoming `const controller = {`, and a final
`withForkStatusBarUsage(controller, …)` return. The fork's four providers — DeepSeek, Fireworks,
DeepInfra, Copilot — are folded in by that one call, which only widens `anyFetching` /
`hasVisibleUsageMeters` / `anyVisible` and only narrows `isEmptyUsageState`, so a value the fork does
not understand survives a sync untouched. The controller passes upstream's own `usageSettings`, so the
fork inherits upstream's remote-owner handling instead of re-deriving it. `T extends
ForkStatusBarUsage` on the merge is what makes an upstream rename of one of those six keys a `pnpm tc`
failure rather than a silently unmerged field.

**That file has three code lines of headroom left.** Upstream sits at 295 of its 300-line `max-lines`
budget (`skipComments`, `skipBlankLines`) and this seam spends two, so 297. Any further fork addition
there belongs in a fork-owned module, not a fourth line: the ratchet in
`config/max-lines-baseline.txt` may only shrink, so a `max-lines` disable is not an option. It is also
a sync hazard — upstream growing that file by more than three lines breaks the budget on the merge.

- **`ForkUsageProviderSnapshots`' four slots are optional now** (`fork-usage-providers.tsx`). Upstream's
  body cannot name the fork's slots, so requiring them made its `isUsageEmptyState` call a typecheck
  error — which is why the copy existed. The fork's own call passes every slot, so nothing is left
  unchecked.
- **The old `status-bar-usage-projection.ts` is gone.** `fork-status-bar-usage.test.ts` replaces its
  test: the merge is identity when no fork provider is configured, and a fork reading or saved key
  still reaches the roster, the meter count and the empty state.

### `local(test)`: the shared worker's i18n language is restored, and one copy assertion stopped reading it

Anchors: the `afterEach` in `src/renderer/src/i18n/fork-catalog-overlay.test.ts` (fork-owned); the
`englishFallback` const and its seven call sites in
the checks-panel empty-state suite (retired upstream; the component at `src/renderer/src/components/right-sidebar/checks-panel/presentation/checks-panel-empty-state.ts` survives)
(upstream-owned, no fork comment above it). No production module changed.

**The red.** The 2026-11-12 nightly (run `43226305290`, shard 11/12) failed that checks-panel test with
four assertions receiving Spanish copy — `'Autenticación de GitHub fallida'` where it wanted
`'GitHub authentication failed'`. The component was not wrong. The file runs in the `bun-shared`
project, whose files share one worker's module cache (`isolate: false`), and the fork's
`fork-catalog-overlay.test.ts` — same shard, same project, finishing 8 s earlier in that job's log —
leaves the `i18n` singleton on `es`. `config/scripts/test-runtime/environment/vitest-shared-worker-file-reset.mjs`
undoes mocks, timers, globals, env and cwd between shared files; a language held in a module singleton
is none of those, so the next file inherits it.

**The fork's half.** `fork-catalog-overlay.test.ts` reset the language in `beforeEach` but never at the
end, so it handed `es` to whatever ran next. Its `afterEach` now restores `en` and drops the `es` and
`zh` bundles it loaded: `loadRendererUiLanguage` skips the fetch when `hasResourceBundle` is already
true, so a bundle left behind — including the one its own hung-overlay test reloads _without_ the fork's
strings — would be served to the next file. The language restore is what the measurement below
covers; the bundle removal has no victim yet and is there for the same reason.

Measured both ways on this box with `VITEST_MAX_WORKERS=1` (the env var, not `--maxWorkers`: the cap is
applied after the CLI value): with the language restore removed, the following file reads `es`; with
it, `en`.

**Upstream's half.** The checks-panel test called `getChecksPanelReviewState` without its optional `t`,
so it asserted whatever the worker's locale produced. It passes `englishFallback` now — the
`(_key, fallback, options) => interpolated fallback` stub already used in
`FolderWorkspaceWorktreesPanel.test.tsx` and `IssuePaneIssueSwitcher.test.tsx` — so its assertions are
the module's English source strings. That keeps the fix from depending on every other shared file's
tidiness, and it is the half that has to change upstream for the class to be closed there.

### `local(test)`: the shared worker resets the locale singletons between files

Anchors: `config/scripts/test-runtime/environment/vitest-shared-worker-locale-reset.mjs` and its test
(fork-owned, new); one added entry in the shared project's `setupFiles` in `config/vitest.config.ts`
(upstream-owned, `fork-comment-ok`); `src/shared/i18n-instance-registry.ts` (fork-added); one
`registerOrcaI18nInstance` call in `src/shared/orca-i18n-instance.ts` (upstream-owned, code only, no
fork comment) and one `__reset…ForTests` export each in `src/shared/ui-locale.ts` and
`src/renderer/src/i18n/language-readiness.ts` (upstream-owned, `fork-comment-ok`).

**The gap this closes.** A `bun-shared` worker's files share one module cache (`isolate: false`), and
`vitest-shared-worker-file-reset.mjs` undoes mocks, timers, globals, process state and the modules a
file _newly_ evaluated — not a value a module already held. Four of those are locale state:
`rendererDetection` in `src/shared/ui-locale.ts`, the `detectionPromise` and readiness store in
`src/renderer/src/i18n/language-readiness.ts`, and the i18next singleton's language. The reset puts all
four back on what a fresh worker holds: detection unset, cached detection and store dropped, and every
registered instance on `en`.

**The i18next half reads its instances from a registry, not from an import.** Importing either i18n
module from a setup file is wrong in both directions: `src/renderer/src/i18n/i18n.ts` inlines every
locale catalog (about 15 MB of base64 per shared worker) through the `locale-catalog-test-assets`
plugin, `src/main/i18n/main-i18n.ts` reaches `electron`, and importing **i18next itself** leaves a
pending timer that the file reset answers with `resetAllModules` — measured, a shared worker's second
file then re-imports the whole graph. `src/shared/i18n-instance-registry.ts` is a type-only import of
`i18next` plus an array of `WeakRef`s, so a setup file can read it for nothing. `createOrcaI18n`
registers into it; production builds two instances at module load, so it is two entries there. Weak
because a file that makes the i18n module evaluate again — a mock, or a leaked global — registers
another instance, and this module was loaded by the setup file, so nothing else clears it.

**What it waits for, and what it cannot.** The reset awaits `vi.dynamicImportSettled()` first: a
catalog a file started loading in the background would otherwise arrive after the language was put back
and land on the restored one. A _fetched_ catalog (the renderer's route, `fetch` of a base64 data URL)
has no such hook, so a file that leaves a catalog fetch in flight can still settle it late. And
`changeLanguage` restores the language, not everything a file may have changed: a rewrite of the `en`
bundle itself, plugin language packs the file registered, and main's `languageGeneration` counter all
survive it. None of those is reachable from a shared test file today; they are listed so the next
reader does not read this as "locale is fully reset".

**Preventive, not a fix for a live red.** No shared file writes a detection or the store today: the
only writer is `publishLanguageDetection`, whose tests are `@vitest-environment happy-dom` and so are
kept out of the shared project by `ISOLATION_REQUIRING_API`. The language red of 2026-11-12 was
`fork-catalog-overlay.test.ts` and was fixed at the source in #430; three node-env shared files now
restore `en` themselves. This change is what makes the fourth one harmless instead of a repeat.

**Evidence, both directions.** `vitest-shared-worker-locale-reset.test.mjs` has three unit tests (the
detection, the cached detection plus store, and a real `i18n.ts` instance switched to `es`) and one
spawned `isolate: false` fixture: a file plants a Spanish detection and a Spanish i18n instance, and the
next two files assert they start clean. Removing the detection reset reds two of the four, removing the
readiness reset reds one, removing the language switch reds two, and removing the `afterAll` that
registers the hook reds the fixture — measured on 2026-11-14.

Three things that fixture has to keep doing, all learned the hard way:

- **Live under `.tmp/`, never under `node_modules/`.** A spec file inside `node_modules` is loaded as a
  dependency in its own module instance, so a setup file's reset reaches a different copy of the state
  and the assertions pass without proving anything. The same is true of a fixture outside the vite root.
- **Set `VITEST_MAX_WORKERS=1` in the child env.** This box exports 16, and Vitest applies it after the
  config's `maxWorkers`; two workers would give each file its own module cache.
- **Witness with the registry instance, not with a property on the store.** The instance carries the
  planting file's mark, which is what proves the assertion is reading that file's module instance rather
  than a re-evaluated one. A mark on the readiness store is not stable across the fixture's files, and
  the fixture never creates a real i18next instance: it stands one in, because the real one leaves the
  timer described above and then a module reset, not the hook, would be what cleared the language.
- **Read the fixture's two halves for what they are.** Its language assertion is the strong one: remove
  the switch and it reds. Its detection assertion compares the detection to the browser fallback, which
  on a host whose own locale is Spanish would match even without the reset — the unit test above pins
  `de-DE` precisely so that half does not depend on the host.

## Syncing with upstream

**The full procedure is [UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md)** — "sync upstream
main" means that document, start to finish. What matters specifically for the patches below:

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

**The release line merges; only a feature branch rebases** (runbook Step 1). The "patch series" the
older wording named does not exist as a separable thing — no patch ref, ~50 commits of product line
importing the identity modules, 35 shared files — so nothing rebases it, and `curate.mjs`, which
planned it, is retired.
The merge commits are load-bearing: this line carries rollback tags (`archive/pre-sync-<tip>`) and one
hand-resolved merge whose resolutions exist nowhere else, and a rebase drops both. Because each patch
is a one-line constant edit, a conflict here means upstream moved that exact line — re-apply by hand
and amend that commit rather than resolving mechanically. A conflict in a fork file that upstream does
not have is _not_ an upstream change at all: check all three merge stages (`git show :1:$f :2:$f
:3:$f`) before assuming either side.

After a sync, confirm the fork still behaves:

```bash
pnpm typecheck
node -e "require('./config/electron-builder.config.cjs')"   # config still loads
```

**A provider upstream adds is a `tc` failure until it is classified** — that is the point of
`src/shared/usage-providers/usage-provider-manifest.ts` (#320). Give it an entry there (its slot, its
presence flags, its pending readout, its credential and the host-settings port if it has one), and add
its store to `usage-provider-credential-census.test.ts`'s exemption list if it is not a usage
credential. Do not "fix" the failure by widening a list somewhere else; the manifest is the list.

Then check the update path still points at this fork:

```bash
grep -rn "nplez1/orca" src/main/updater-prerelease-feed.ts src/main/updater/updater-*.ts src/shared/release-channel.ts
```

And that nothing of ours was dropped by the merge — every file that differs from the pre-sync tip
while upstream never touched it is a file the merge changed behind our back:

```bash
modified=$(mktemp "${TMPDIR:-/tmp}/orca-sync-modified.XXXXXX")
upstream_changed=$(mktemp "${TMPDIR:-/tmp}/orca-sync-upstream.XXXXXX")
git diff --diff-filter=M --name-only backup/nplez1-main-pre-sync HEAD | sort > "$modified"
git diff --name-only <old-base> upstream/main | sort > "$upstream_changed"
comm -23 "$modified" "$upstream_changed"   # expect empty
```

Why `mktemp`: several agents and worktrees share one `/tmp`, and two of them have already written
the same fixed filename at the same time.

After a **rebase** — a feature branch, never the release line — confirm the
series came through unchanged: `range-diff` prints `=` per patch that is byte-identical:

```bash
git range-diff --no-patch <old-base>..<old-tip> <new-base>..main
```

After resolving any conflict in `src/renderer/src/i18n/en-runtime-required.json`, regenerate it rather
than merging by hand — it is derived:

```bash
pnpm run sync:localization-runtime-catalog
```

### Sync log

**Policy:** the three most recent entries stay inline; older ones move verbatim to
[local/sync/sync-log-archive.md](./local/sync/sync-log-archive.md), newest first, so this
section stays readable. `tests/tools/fork-process-docs.test.mjs` holds the three-entry rule.

- **2026-11-27 — merge of upstream `27a700fd8d6` (441 commits) into the release line, from
  `e8321ad760`** (merge base `3e227259249`, rollback tag `archive/pre-sync-e8321ad760`). **98
  conflicted paths** — `both-rewrote 60, union 28, duplicate-tail 3, modify/delete 3, rename-replay 3,
  duplicate-members 1` — with **no** `package.json` or lockfile conflict and no upstream rename in the
  range (checked at `-M50%`; the two hits at `-M20%` are unrelated files). Resolved in eight area
  batches of ≤20 paths. The three `modify/delete` paths were settled from `expected-deletions.json`
  rather than by a human: they stay deleted and the manifest was re-bound to the new upstream blobs.
  Decisions are in [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § 2026-11-27.
  What a reviewer will want first:

  - **The one feature upstream removed was a safety fix.** `289e3c029e2` stopped reading Antigravity
    usage because the fetcher ran the user's `agy` outside ACP, and headless `agy` runs have been
    reported to get Google accounts flagged. The fork accepts the retirement instead of restoring the
    fetcher it shipped in `np.62`: `antigravityAccounts: []` still publishes for older clients, the
    chat/ACP provider and its accounts section are untouched, and
    `src/main/antigravity/native-account-store.ts` now classifies in `NON_USAGE_CREDENTIAL_STORES`
    because it is an account store, not a usage store.
  - **The dashboard pop-out trio stays deleted.** Upstream's whole delta on the three files was 8
    insertions, nothing outside the deleted set imports them, and the close-shortcut hook — upstream's
    own file at the pinned base — went with them and carries its own `expected-deletion` row.
  - **A re-export was the bug, not the retry.** `jira-api-error.ts` re-exported the class that
    `authenticated-request.ts` declares, so a test mocking the request layer erased `JiraApiError`
    itself and upstream's new unbounded-JQL cases threw on every `instanceof` and every construction.
    The class is declared in `jira-api-error.ts` now. The machinery itself was re-homed onto the fork's
    read path (`jira-issue-page-reads.ts`), and the **paged** path is still unguarded against unbounded
    JQL — a named follow-up, not a sync repair.
  - **The Claude monitor policy narrowed to background shells.** The fork's `local(agents)` demotion
    applied to every running non-agent task; a monitor is its own kind, and the fork's own #284 already
    grants monitoring to pi watch loops, so a monitor now keeps upstream's `workingMode: 'monitoring'`
    and its agent time. `LOCAL-PATCHES.md` § `local(agents)` was corrected to match.
  - **The order that saved a release dispatch:** the early Linux lane ran before the release gates and
    found three shards red on tests the Mac gate cannot see. All three were fixed, not classified.
  - **Baselines moved, each with its reason.** Five upstream-owned files the union pushed past the
    300/400-line budget were exempted with `local/max-lines-exemption.mjs` rather than split; the
    identity sweep's report-only baseline was re-frozen at 551 after `--fix` rewrote five `.orca`
    literals; the deleted-fork-tests baseline was re-bound to `27a700fd8d`..`e8321ad760` and records two
    fork cases whose only subject was the retired Antigravity enable gate; `expected-deletions.json`
    gained the seven `USAGE_PROVIDER_MANIFEST.antigravity.*` symbols and two dead renderer constants; and the fork-comment ratchet was
    pruned to **4817/4817** after its rationale was moved out of upstream-owned files into the ledger
    and § Fork comment rationale below.
  - **Opened clean:** `pnpm tc` was green on the merged tip, `post-sync.mjs` passed 16 of 18 rows with
    2 info, and `check:code-quality:changed` reported 0 findings across 2,982 changed files.

- **2026-11-24 — merge of upstream `7daf01d99f3` (1,350 commits) into the release line, from
  `cc4fefcbaad`** (merge base `0c6207e3d7`, rollback tag `archive/pre-sync-cc4fefcbaa`, merge commit
  `a8c508f5fb7`). **323 conflicted paths** —
  `modify/delete 192, both-rewrote 75, union 42, duplicate-tail 7, rename-replay 5,
  duplicate-members 2` — against an upstream delta that retired **6,116 files, 5,217 of them test
  suites, harnesses and fixtures**, and moved only 15 paths. Resolved in four tiers: **18 paths
  proved** by `conflicts.mjs --apply-proven`, **177 modify/delete taken as deletions** (170 retired
  test files, the retired harnesses, and the three dashboard pop-out files the manifest already
  settled), **10 fork-owned test-support files kept** where surviving tests still import them
  (`restore` entries in `expected-deletions.json`), and **106 both-modified paths in nine area
  batches of ≤20**. Decisions are in [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md)
  § 2026-11-24. What a reviewer will want first:

  - **The test-retirement rule at 3× the last sync** (superseded on 2026-11-26: that record was re-bound to the new range, and its 167 paths / 237 cases now live only in git — see the convergence ledger § 2026-11-26 for the debts that were named there). `local/sync/upstream-deleted-fork-tests-baseline.json`
    now records **167 fork-modified test files and 237 fork-added cases** (was 83), all taken as
    deletions — restoring a file upstream retired costs a permanent modify/delete conflict on every
    future sync. The retired harnesses that surviving tests still import are the 10 `restore`
    entries, so both halves are asserted rather than rediscovered.
  - **Two fork features no conflict marker protected.** Upstream replaced the fork's inlined trigger
    run with `runTriggerDelivery`, and moved the connector-row list into
    `src/shared/bots/bot-connector-entries.ts`: taking either side wholesale would have dropped the
    fork's own-PR guard (the `bot_work` gh-marker check) and the photon/iMessage connector row. Both
    are re-homed, and the fork's `servesLocally` webhook filter is back on `connectorTriggers`.
  - **The workspace card's `surface/worktree-card-*` pair was already dead.** Its only importers were
    themselves unreferenced, and the live renderings of the same two features are
    `template/card-identity-parts.tsx` (same-branch host switcher) and
    `template/card-activity-parts.tsx` (ephemeral-VM lease badge). Deleted with upstream's, features
    intact.
  - **`max-lines` is enforced, and upstream keeps files exactly at their cap.** Fourteen
    upstream-owned files crossed the budget on the fork's delta; each is exempted (baseline row plus
    its own `eslint-disable max-lines -- Why:` line) rather than split, per this file's
    `local(lint)` rule. Three `eslint-disable` headers a resolver dropped are restored: the
    baseline silences the ratchet, not oxlint.
  - **`pnpm tc` opened at 132 errors** (the 2026-11-20 sync opened at 1,083), mostly retired
    test-support imports and renamed exports, repaired in five disjoint area batches.
  - **One fork-added spec was retired rather than propped up.**
    The `pane-screen-prompt` spec, in `src/main/runtime/orca-runtime-tests/`, imported a test-context
    barrel whose closure is ~1.6k lines of harness upstream deleted, and it is the only consumer; the spec
    goes with them and its coverage is recorded here. `--baseline-init` cannot carry it — that
    baseline is fork-modified test files, and this one is fork-added.
  - **`check-upstream-file-comments` was re-based, not widened.** Its recorded `base` was still
    `0c6207e3d7`, the previous sync's base, so every fork comment on a file upstream rewrote in these
    1,350 commits counted as new — 622 file rows against maxima that described the old ruler. `--init
    --base 7daf01d99f3 --accept` re-measured at the new base: **4752 lines against 5113**, a 361-line
    shrink `--prune` then locks in, and 320 per-file maxima. The nine files whose rows moved up by 18
    lines in total are the sync resolution's own comments, absorbed with the reason recorded in
    `accepted` rather than deleted; nothing was raised beyond what the tree already carries.
  - **One upstream suite retired, one repaired, on the pi lane's own terms.**
    `agent-hook-cancel-verdict-latch.test.ts` (#47627) was a real fork defect: the lane publishes one
    `subagent_async_state` snapshot per post instead of upstream's `agent_start:subagent`, so a child
    starting right after Esc was held as late work for the whole 15s window. The latch gained a marked
    `LOCAL(nplez1)` rule and the suite is kept and green, OMP-lifecycle and replay holds included.
    `agent-status-extension-held-turn-repost.test.ts` (#48146) is a `fork-refactor` deletion in
    `expected-deletions.json`: every case needs the two `subagent:async-*` bindings this fork removed,
    and **its coverage is owed (#464)** — the roster lane still reposts a child-held turn and nothing pins
    that cadence on this tree. See `convergence-ledger.md` § "pi subagent bindings".
  - **`macos-updater-tests.yml` left `REQUIRED`.** Upstream #46786 deleted the workflow with the
    updater suites it ran, so the contract named a path no commit on either side carries — a
    permanently red health check rather than a guard. See § `local(ci)`, which is where the lane
    table lives.

- **2026-11-20 — merge of upstream `0c6207e3d7` (1,425 commits) into the release line, from
  `1db15d9ff0`** (merge base `1ce376b27e`, rollback tag `archive/pre-sync-1db15d9ff0`, merge commit
  `2ed6a05ce78`). **477 conflicted paths** — `both-rewrote 248, union 126, modify/delete 81,
  rename-replay 12, duplicate-tail 7, duplicate-members 2, add/add 1`. Resolved in four tiers: **54
  paths proved** by `conflicts.mjs --apply-proven` (import-only and fork-unchanged unions), **77
  modify/delete taken as deletions** (upstream's bulk test retirements plus the dashboard delivery
  family), **4 moved paths ported by hand**, and **241 both-rewrote/union paths in 18 area batches of
  ≤20**. Decisions are in [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md). What
  a reviewer will want first:

  - **Renames were the cost again, at 2.5× the last sync**: upstream moved 2,358 paths and deleted
    2,036. With every marker gone `pnpm tc` opened at **1,083 errors, 544 of them missing modules**. A
    rename-map pass (upstream's own `--find-renames` output, never a basename guess) fixed 369
    specifiers across 268 files, then five area passes took it to clean; 62 further `vi.mock` and
    string references that `tc` cannot see were fixed the same way.
  - **Three breaks no conflict marker showed.** `RuntimeAccountController` was still wired to the
    notifier instead of upstream's Claude-account selection handler (a `@ts-nocheck` file, so invisible
    to `tc`); a sync wrapper over an async credential write left a floating promise, so a saved Jenkins
    token missed the next request; and a union resolution duplicated a `maxBuffer` key.
  - **Upstream changed `BROWSER`** (#43232) to point at the CLI itself rather than an
    `open-url --url %s` template. `tests/tools/fork-invariants.test.mjs` pinned the old shape and now
    pins the basename — the part that matters, since a bare `orca` is GNOME's screen reader on Linux.
  - **83 fork-modified test files and 182 fork-added cases went with upstream's retirements**
    (#42831–#43662, #43120, #43339), recorded in
    [local/sync/upstream-deleted-fork-tests-baseline.json](./local/sync/upstream-deleted-fork-tests-baseline.json)
    — re-bound to the 2026-11-26 range, so this count is now recorded in git history and in the
    convergence ledger § 2026-11-26, not in that file.
    The heaviest loss is the fork's whole `src/main/updater/*.test.ts` set, in one of its most-patched
    areas; re-homing those cases into fork-owned suites is owed.
  - **25 upstream-owned files are exempted from `max-lines`, not split.** Each was verified as
    upstream-owned _and_ under budget upstream, so the overage is the fork's delta; splitting one costs
    a permanent hunk on every sync (this file's `local(lint)` rule). The ratchet grew by 31 entries and
    the review gate should see it.

### Fork comment rationale moved out of upstream-owned files (2026-11-27 sync)

The ratchet (`local/check-upstream-file-comments.mjs`) forbids rationale paragraphs above upstream's
code, so this sync's were moved here and into the ledger. Kept verbatim because the code they explain
is upstream's and the next sync will bring it again:

- **`src/main/jira/jira-api-error.ts`** — the class must be declared here rather than re-exported from
  `authenticated-request.ts`: a re-export makes it part of that module's surface, so anything mocking the
  request layer erases every `instanceof` against it. `fieldErrors` is present when Jira answered with an
  `errors` object, which is how a transition or edit names the field it refused; `scopeMismatch` means
  the credential is valid but under-scoped, so it must not be cleared.
- **`src/main/jira/jira-issue-search.ts`** — the fork extracted `runPerSite` out of `searchIssues`, so
  three of upstream's own comments (discovery-before-search slot order, cancellation through queue
  admission, the partial-success rule) now sit inside the helper and read as fork additions. They are
  marked `fork-comment-ok` in place rather than reworded, because they must stay byte-identical to what
  the next sync brings. The fork's own two cursor comments explain the guard in the line below them.
- **`src/shared/agent-hook-listener/listener-state.ts`** — `piScheduledWorkByPaneKey` is kept on the
  listener state rather than read off the current event because a republish can be triggered by something
  that carries no inventory at all (a descendant draining, a resumed session's placeholder), and reading
  absence there would drop a hold nothing has cleared; its fire times are relative to the post that armed
  it. `descendantLeadStateByPaneKey` is deliberately not a state claim: it only refines a republish an
  incoming descendant event already triggered, and never creates a row on its own.

### `local(ci)`: release workflow

`.github/workflows/fork-release.yml` builds macOS, Windows and Linux artifacts and publishes them as
a release on this fork — which is the feed the patched updater points at. It exists because every
upstream release workflow is a no-op in a fork (they guard on
`github.repository == 'stablyai/orca'`) and publishes to stablyai's separate channel repos. It is
`workflow_dispatch` only, so it never runs on its own.

It builds on GitHub-hosted runners (`macos-15`, `windows-2022`, `ubuntu-latest`) rather than
upstream's Blacksmith labels, which belong to stablyai's account. Signing is conditional on
`MAC_CERTS` being set, so the pipeline is usable before a certificate exists and switches to the
signed, notarized path by itself once it does. The release body comes from
`.github/fork-release-notes.md`, rendered per release with the version, commit, date, and a signing
paragraph that follows the signing mode.

The three legs run **in parallel** (since 2026-11-16) behind a `release-draft` job that generates the
notes and creates the draft, and ahead of a `publish` job that needs all three. electron-builder's
GitHub publisher creates the release only when its listing finds none for the tag
(electron-publish 26.15.3 `GitHubPublisher.getOrCreateRelease`); a draft it finds is always appended
to, so with the draft created before any leg starts there is no create-vs-append decision left to race.
Until then the legs were serialized (`linux: needs: windows`, `windows: needs: macos`) because the
draft was created inside `macos` — 44 minutes of legs in v1.4.214-np.56 (run 43826476774), against
~26 for the longest leg alone. Each leg asserts its own manifest (`latest-mac.yml`, `latest.yml`,
`latest-linux.yml`); `publish` re-asserts all three, that exactly one release carries the tag, the
body, and `fork-release-ref-guard.sh` — which now holds a draft (not only a new tag) above the newest
published `-np.` tag, so a `gh run rerun --failed` that keeps an hours-old `release-ref` cannot
undraft below a release published since.

**The lane runs the compiler's and the lint gate's verdicts (2026-11-14, #298).** Two jobs sit beside
`unit-plan`/`unit-tests` and every artifact leg names both in `needs`: `typecheck` (`pnpm tc` on the
dispatched commit) and `lint` (`node local/gate-lint.mjs`, after the recorded sync base is fetched, with
`ORCA_CODE_QUALITY_BASE: HEAD` for its diff-scoped steps). The trigger was the 2026-11-08 sync, where
`PROVIDER_DISPLAY_NAMES` and `USAGE_PROVIDER_IDS` were short after a rate-limit provider union merged
and `pnpm tc` was the only thing that noticed — a dispatch between two nightlies would have built and
published from that tree.

What made it a hole is narrower than "no lane runs it", which the issue's text implies and which is
stale: `#399` put `pnpm tc` and the lint verdict on both the PR lane and the release line on 2026-11-12.
The hole is that **nothing at dispatch time reads those verdicts.** `local/dispatch-release.mjs` checks
the review manifest, a clean tree, `HEAD == origin/main` and the Actions fleet — not whether `Fork base
gates` came back green for the commit about to be published. That lane was red for eight consecutive
pushes on 2026-11-12, with its `Typecheck` step skipped in all eight, so "main's gates ran" is not
evidence a dispatch may lean on.

Why the whole lint verdict and not a named subset: the lane already blocks on the unit suite, whose
allowlisted reds are more environment-bound than the lint gate's, so the escape hatch
(`local/lint-known-red.json`, committed to the dispatched tree) is the same mechanism in the same
shape. The known cost is that a red the base carries — the moving fork-comment total pin, most often —
now blocks a publish until it is fixed or recorded, which is what `#399` decided reds require anyway.
Both jobs take `contents: read`, which is what `unit-plan` does.

The Linux leg (`2026-10-21`) is x86_64 only and packages AppImage + deb + rpm. Its packaging needs
are the ones upstream's `release-cut.yml` linux matrix entry established: `python3-gi`,
`gir1.2-atspi-2.0`, `at-spi2-core`, `xclip`, `xdotool` and `rpm` from apt (`build:release` verifies
the computer-use provider by importing AT-SPI, and fpm shells out to `rpm`);
`ensure-native-runtime.mjs --runtime=electron` before electron-builder rebuilds node-pty for the
Electron ABI; a host-scoped `pnpm install` (the job packages only for its own architecture); and
Docker, which `beforePack` uses to compile the Wayland clipboard helper against the glibc floor. The
glibc floor gate itself is inside `afterPack`, so it needs no workflow step. No node-gyp override is
installed here: upstream added one for a pnpm postinstall failure that has not reproduced on this
job.

Only the AppImage self-updates. `src/main/updater/updater-install-execution.ts` already routes deb
and rpm to the "manual install required" message, and the release notes say so — those two artifacts
are for people who want their package manager to own the install.

**What the first shipped Linux release confirmed (2026-10-21, `v1.4.214-np.38`).** Checked against the
uploaded `.deb`, not the config: the payload is `/opt/Orca NP/orca-ide` +
`resources/bin/orca-ide` + `chrome-sandbox`; the packages are `orca-np` (dpkg/rpm ownership), and
`postinst` links `/usr/bin/orca-np` at the bundled launcher while `chmod 4755`s the sandbox helper;
`postrm` removes the link only when it points into an Orca NP install. `afterPack`'s glibc floor gate
passed on **21 bundled native binaries** (Ubuntu 20.04 / glibc 2.31 / GLIBCXX_3.4.28), and
`latest-linux.yml` carries the AppImage's blockmap, so an installed AppImage sees the release.

Two follow-ups this release exposed, neither fixed here:

- **`StartupWMClass=orca` is still unverified for this build.** The class comes from the running app,
  not the package, and this fork's product name is `Orca NP`. Confirm with `xprop WM_CLASS` on a Linux
  desktop; the one-line fix is `linux.desktop.entry.StartupWMClass` in
  `config/electron-builder.config.cjs`.
- **The packages still attribute themselves to upstream.** `Vendor: stablyai`, `Maintainer: stablyai`
  and `Homepage: https://github.com/stablyai/orca` come from `package.json`'s `author`/`homepage`
  through fpm plus `linux.maintainer`. The package _name_ is right, so nothing collides, but a
  `orca-np` package that links upstream's homepage reads as an official build. Changing it touches
  `package.json`, which the Windows installer identity also reads, so it needs its own decision rather
  than a rename inside a release.
- **A retried release uploads cleanly now.** electron-builder appends to the release and fails on an
  existing asset name, so the two failed attempts on `np.38` (Apple stapling timeout, then
  `already_exists`) could not be retried as they stood; each leg then cleared its own assets first via
  `.github/actions/clear-release-assets`, matched by name so one leg never deletes another's.
  **Corrected 2026-11-16:** that step never matched anything — its patterns were written `\\.`, a literal
  backslash to `grep -E` (np.56's retry: `cleared 0 asset(s)`) — and was deleted. What makes a retry
  upload cleanly is electron-publish's own overwrite of an `already_exists` name
  (`gitHubPublisher.js:153-154`), which np.38 defeated only because GitHub had renamed the
  `Orca NP-…` blockmap; `mac.artifactName` has kept every name GitHub-safe since.

Why the unsigned path explicitly `unset`s the `CSC_*`/`APPLE_*` variables instead of leaving them
empty: an unset secret still _defines_ them as empty strings, electron-builder reads a defined
`CSC_LINK` as a certificate path, and `resolveCscLinkPath('', cwd)` resolves to the repository root —
so packaging dies with `<repo> not a file`. An empty secret and an absent one are not the same thing.

**The cross-arch terminal-host boot gets a longer deadline (2026-10-13).** Upstream's `afterPack`
check `verifyPackagedMacTerminalHostBoots` boots the packaged `Orca Terminal Host.app` for the slice
it just built and requires it to serve a PTY within `TERMINAL_HOST_BOOT_TIMEOUT_MS` (20s upstream).
On this fork's GitHub-hosted arm64 runner the _x64_ slice is built cross-arch and booted under
Rosetta, where the whole boot costs several times its local cost — measured at **~14s of that 20s**
with a warm Rosetta cache and an idle CPU, and three consecutive np.28 attempts stalled at three
different stages (no daemon token / no handshake / no PTY output). The artifact itself is sound: with
Rosetta installed locally, the x64 `node-pty`, the pinned x64 Node, the daemon entry and a
packaged-shaped helper all complete the same check. So the check keeps its 20s default and the fork's
workflow raises the budget with `ORCA_TERMINAL_HOST_BOOT_TIMEOUT_MS=120000` on the packaging step —
the one-line reader for that variable sits in `config/scripts/verify-packaged-daemon-entry.cjs`, and
it is the only fork-local line in an upstream script this sync introduced.

Fork-only helper scripts live in `local/`:

- `local/branch-status.mjs` — live status of every branch (SHAs, fork presence, own delta, PR).

#### `local(ci)`: the scheduled E2E known-failure ratchet

Upstream's scheduled E2E is red in upstream's own repository — the same handful of titles fail on every
run and are tracked in stablyai's Linear issues, and their triage policy is to leave those tests enabled.
A fork inherits both the tests and the red, so this fork ratchets instead of emailing twice a day:
`local/e2e-known-failure-titles.json` records the titles observed failing in scheduled runs, and
`local/check-e2e-known-failure-titles.mjs` reads the shard's Playwright JSON report and fails the run only
for a failure that is **not** recorded. Every entry carries how many of the sampled runs hit it and whether
the same title failed in an upstream scheduled run, so the list never claims more attribution than it has.

What it deliberately does not do:

- The PR lane (`changed-e2e`) is untouched: a pull request still fails on any spec it runs.
- A title outside the list still fails the run, which is the point — that is how the tab-bar
  quick-launch regression reached this fork.
- A missing or unreadable report fails the verdict, so a crashed or timed-out run cannot pass as green.
- Upstream is untouched: the wiring is guarded on `github.repository` there, and Playwright's exit code
  stays in charge.

Maintenance is the honest part of a ratchet: prune an entry once it stops failing, and the verdict notes
the recorded titles that passed in its shard (a notice, not a warning — they are intermittent, so one
passing shard is not a fix).

#### `local(unit-ci)`: the Vitest worker teardown race

Vitest 4 and 5 fail a run whose tests all passed when a worker's `onUserConsoleLog` RPC is still in
flight as that worker closes (vitest-dev/vitest#11153). Every test passes, the only error is
`EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`, and it
names whichever worker was closing rather than the file that logged late. Upstream's position is that a
repository's own late async work is at fault; the linked pull request only improves the message, and no
released version fixes it. Measured here: about half of shard-8 runs, across unrelated branches, and not
reproducible locally.
`local/check-unit-shard-verdict.mjs` reads the shard's Vitest JSON report (what the tests did) plus the
tee'd run log (which unhandled errors were raised) and tolerates exactly that one headline.

What it deliberately does not do:

- A test failure, a second unhandled error with any other headline, an unreadable or missing report, a
  shard that ran no tests, and a failed shard with nothing to explain it all still fail. A crashed,
  timed-out or genuinely red shard cannot pass as green.
- Vitest's own count of unhandled errors is checked against the headlines read out of the log, so a log
  format change fails closed rather than skipping errors it could not parse.
- Upstream is untouched: the wiring is guarded on `github.repository` there, and Vitest's exit code
  stays in charge.

**The report is judged against the shard's assignment, not on its own (#314).** A report only proves
what ran, and a worker that died takes its file out of it — so a shard could read green over whatever
survived. `--assignment ci-shards/unit-assignment.json` names the manifest `TimingSequencer` writes from
the same plan it hands Vitest (`config/scripts/ci/sharding/ci-unit-sequencer.mjs`), and the verdict now
fails on any assigned file the report does not list, and on any file the report lists that this shard
was not assigned. That second half is what catches a manifest left by another run, shard or revision,
which a missing-file check alone would read as a subset. `runId` / `runAttempt` are compared for the
same reason — defence in depth rather than a measured failure mode, since `actions/checkout` cleans
`ci-shards/` and one job sees one run id on every runner this fork uses. A named assignment that is
missing, malformed, out of range, empty or stale fails closed; the flag is pinned by
`config/scripts/unit-shard-verdict-contract.test.mjs`, so dropping it turns the unit lane red instead
of silently skipping the check.

**A tolerated crash cannot be the only explanation for a failed shard.** `unhandledErrors` entries may
declare `"explainsFailure": false`, and the `pool-crash` entry does: a worker that died can lose tests
inside a file the report still lists, which the file set cannot see, so a crash is tolerable only
beside an absorbed red that already explains the exit — a benign headline in the same log does not
launder it. The field defaults to `true`, so the two other run-level headlines keep their current
standing, and the manifest's own value is pinned by a test in `tests/tools/unit-shard-verdict.test.mjs`.
The `::warning::` line names the entry's class rather than the teardown race, which is how a pool crash
stopped being visible in the log.

One hole this does not close: `local/gate-unit.mjs` (the Mac release gate) still lets its own pool-crash
entry explain a non-zero exit, and its missing-file check cannot see a test lost inside a still-listed
file either. Recorded rather than fixed here, because the gate's lane and its allowlist are a separate
patch.

Remove this patch — the `continue-on-error`, the report arguments, the verdict step and the script —
once Vitest closes #11153.

### `local(ci)`: the upstream release-tag mirror

`.github/workflows/fork-upstream-tags.yml` mirrors upstream's desktop `v*` tags into this fork on a
daily schedule (`17 3 * * *`) and on `workflow_dispatch`. It exists because
`tests/e2e/cross-version-wire/` materializes released versions by tag and pins tags up to `v1.4.224`,
so a fork that lags upstream's release train fails for every branch with "could not resolve ref
vX.Y.Z" — a red check about this fork's tag list, not about the change under test.

Only `v*` desktop tags are fetched. The two mobile release workflows trigger on `mobile-ios-v*` /
`mobile-android-v*` — the only workflows in the tree with a `tags:` trigger, here or upstream at
`v1.4.224` — so mirroring those would start App Store and Play builds, while a `v*` push is inert.

**It needs a credential the job cannot make for itself: the `FORK_TAG_MIRROR_TOKEN` secret.** A tag
brings the commits behind it, upstream's release cuts routinely rewrite `.github/workflows/**`, and
pushing workflow-file changes needs the `workflows` permission, which the Actions `GITHUB_TOKEN` can
never hold — `permissions:` has no `workflows` scope to grant. So the push was rejected on every
scheduled run from 2026-10-10 with "Unable to determine if workflow can be created or updated due to
timeout; `workflows` scope may be required" on `v1.4.223` and `v1.4.224`, and no fork sync could
clear it: those are release-line commits that are not ancestors of `upstream/main`. The checkout now
authenticates with a fine-grained PAT on `nplez1/orca` — Contents: read and write, plus Workflows:
read and write — which `actions/checkout` persists in the git config the `git push` uses. Nothing
authenticates with the built-in token afterwards, so `permissions:` is `contents: read`.

**Rotating that PAT is the maintenance.** A fine-grained PAT expires, and an expired one fails the
job at checkout with "Input required and not supplied: token" rather than the old rejection. The
same failure means the secret is missing entirely, because an empty `token` does not fall back to
the built-in one — so a missing or lapsed credential is a config error, never a repeat of the
permissions rejection. Set a fresh PAT as the repository secret and nothing else changes.

**What that PAT is allowed to do is wider than the job needs (audit #221 C3).** The secret belongs to
`nplez1`, which is the `exempt` bypass actor on the only ruleset protecting `refs/heads/main`,
so the same credential the mirror holds for tags could push, force-push or delete the release line.
It is also handed to `actions/checkout`, which persists it in `.git/config` for the whole job, and no
tag ruleset exists — so "an existing tag is never moved" depended only on the absence of `--force`.

Three parts, of which only the third is in the tree:

1. **Operational fix, not applied here: a non-bypass identity.** A machine user or a GitHub App whose
   token holds Contents and Workflows write on this repository and nothing else. A sync cannot create
   an account or rotate a secret, so this stays a named follow-up rather than a patch.
2. **Operational fix, not applied here: a `refs/tags/v*` ruleset** with `update` and `deletion` rules.
   `gh api repos/nplez1/orca/rulesets` currently returns one branch ruleset and nothing for tags;
   creating one is repository state, and the fork's `v*-np.*` updater tags are only ever created, so
   the rules would not block a release.
3. **In the tree: the guarantee is checked, not inherited.** `actions/checkout` is SHA-pinned, and
   `.github/scripts/fork-tag-mirror-guard.sh` compares this checkout's `refs/tags/v*` — what the push
   sends — against the fork's, fails the job when a name already exists at another commit, and prints
   the refspecs for the tags that are genuinely new. The push is then
   `git push --atomic origin $refspecs`: no `--force`, no `--mirror`, and no `--tags`, because `--tags`
   would also send the fork's own `mobile-ios-v*` / `mobile-android-v*` tags, which start App Store and
   Play builds. `tests/tools/fork-tag-mirror-guard.test.mjs` runs the guard against scratch
   repositories and fails if any of those flags returns to the push.

**Verified 2026-10-16:** with the secret set and the change merged (`077e5e06`), a dispatched run
went green in 1m18s and mirrored `v1.4.223`, `v1.4.224` and `v1.4.227` — the first successful run
since 2026-10-08, and `v1.4.224` is the highest tag that suite pins.

### `local(ci)`: which workflows are live on this fork

Upstream's whole Actions fleet is turned **off at the repository, not in the tree**. There is no
commit to find and nothing a sync can revert: the state is `disabled_manually` on each workflow,
readable only from the API.

```bash
gh api "repos/nplez1/orca/actions/workflows?per_page=100" \
  --jq '.workflows[] | "\(.state)\t\(.name)\t\(.path)"'
gh workflow disable <file>.yml --repo nplez1/orca    # the only way to change it
```

**Why the tree cannot express this.** Deleting the files would fight every sync, and an `if:` guard
would leave the workflow listed and re-enabled at the first `workflow_dispatch` from upstream's own
file. A disabled workflow keeps receiving file updates from sync and stays off until someone turns
it back on — which is what a fork wants, and why this is documented here instead of patched.

**Live on purpose — these must stay enabled:**

- `fork-release.yml` — `workflow_dispatch` only; the feed the patched updater points at.
- `fork-upstream-tags.yml` — the daily `v*` tag mirror (see above).
- `fork-main-tests.yml` — the nightly full unit suite, enabled 2026-10-24. Its last passing run is
  2026-10-08, from before it was disabled in the fleet sweep and re-enabled on 10-24; the first
  scheduled run after that (10-26) wedged, which is why the absence below starts at 10-08 rather than
  at 10-24. This is the backstop the
  PR gates gave up (`~/Code/orca/AGENTS.md` § Verification tiers — the cross-worktree file). It is in `local/check-actions-enablement.mjs`
  `REQUIRED`, not `ALLOWED_INERT`: it has a `schedule`, so "disabled" is drift and should be reported
  as `MISSING`, not silently tolerated.
- `fork-pr-gates.yml` — the cheap PR lane, new on 2026-10-29 (see the cost note below).
- `fork-ci-health.yml` — the daily check that runs `local/ci-health-report.mjs`, which is what keeps a
  silently disabled lane from staying silent. Also `REQUIRED`, for the same reason.

**Also left enabled, and inert without a manual dispatch:** everything in
`local/check-actions-enablement.mjs`'s `ALLOWED_INERT` — `zcode-account-contract.yml`,
`unit-module-cache-benchmark.yml`, `windows-native-preparation-benchmark.yml`,
`qualified-orcad-template.yml`, `layout-owner-e2e.yml`, `dev-channel-win-publish.yml` and
`ci-cache-warmup-platform-jobs.yml`. The last is `workflow_call`-only, so it runs only when
`ci-cache-warmup.yml` does — and that one is disabled. An earlier revision of this list named three
`cloud-operate-relay-*` flags/watchers; no such workflow exists (`.github/workflows/` holds 75 `.yml`
files plus `issue-os-labeler.yaml`, and the list of live ones is what `gh api
repos/nplez1/orca/actions/workflows` returns).

Everything else is `disabled_manually`. As of 2026-10-19 that includes `pr.yml`, `unit-tests.yml`,
`e2e.yml`, `mobile.yml` and `fork-main-gates.yml`. `fork-main-tests.yml` is the exception above: it is
live, and the section below is why its being live was not the same as its running.

#### The daily lane clears inherited drift itself (2026-11-10, #349)

The 2026-11-09 sync added two workflow files and, because upstream's fleet is disabled per workflow
and a **new** file arrives enabled, both came up live: `orca-server-artifact.yml` and
`release-mirror-r2.yml`. Neither had ever run (`gh run list --workflow <file>` returned `[]` for both)
and neither had a live caller — the only callers, `release-cut.yml` and `mobile-android-release.yml`,
are `disabled_manually` — but the daily health check reported both as `DRIFT` and the only way to clear
it was repository state. Both are now `disabled_manually`:

- `orca-server-artifact.yml` carries an inherited `schedule` (`45 11 * * *`) plus a path-gated
  `pull_request` trigger, so leaving it live spends minutes on matching PRs and daily; a disabled
  callee still runs when called, so `release-cut.yml` loses nothing if it is ever re-enabled.
- `release-mirror-r2.yml` needs `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` and writes to upstream's
  `downloads.onorca.dev` bucket. No release on this fork publishes there, so there is nothing to
  mirror and nothing to backfill by hand.

**The class is now self-clearing.** `fork-ci-health.yml` holds `actions: write` and runs
`local/ci-health-report.mjs --fix`, which passes `--fix` to the enablement check alone. Before this,
the drift cost a delegation: an agent, a PR, and a diff that cannot exist, because the fix is
repository state rather than a file. Three bounds make the unattended sweep safe, and each is a bug
that existed before it ran unattended:

- **`refs/heads/main` only** (`maySweep`). A `workflow_dispatch` runs the tree of the ref it was
  dispatched on, and a branch cut before a lane joined `REQUIRED` reads that lane as drift — so a
  dispatch from any other ref would have switched off lanes the release line needs. A refused `--fix`
  now says so, because otherwise a branch dispatch reads as an ordinary report-only run.
- **Never a `REQUIRED` lane, by any of the three routes into `disableTargets`** — drift, a changed
  trigger shape, and unpinned. Only the last two needed a filter. Unpinned is a guard rather than a
  live path: a deleted `EXPECTED_TRIGGERS` row makes the file `UNKNOWN`, because the facts are seeded
  from that table, so the reachable version of this was a required _callee_ (`node-server-tests.yml`,
  through `qualified-orcad-template.yml`) whose row someone removed. The exclusion is one filter, not
  a new mechanism.
- **Never a fork-owned file** (`.github/workflows/fork-*.yml`, `local/**`). A sync cannot add one, so
  an active fork-owned lane with no entry is a person's decision: it is reported as `DECIDE`, and the
  check exits **3** instead of 1. That code is what withholds `agent:auto` — 1 means "a scoped defect
  the pipeline may take on", and the only two things an agent could do here are the two this section
  forbids: disable a lane someone enabled on purpose, or widen the list to hide the finding. It withholds
  the label from the whole issue rather than from that one check, because an agent handed a red it may
  not resolve will resolve it anyway. Exit 3 is keyed on the guard that held the lane back **and** on the
  route: a `REQUIRED` lane whose triggers changed shape stays at 1 and stays delegable, because pinning
  the new trigger is a decision an agent can make and record, and six of the required lanes are
  fork-owned — so "fork-owned" alone would withhold delegation from the routine post-sync case.

A night that heals itself reports clean, so the close comment names what the sweep disabled. When no
issue was open — the ordinary case, because the sweep usually runs before the red ever reaches one —
the record is the run log plus the workflows' own `disabled_manually` state, which `gh api
repos/nplez1/orca/actions/workflows` answers at any time. Root cause was not fixed here:
`local/sync/publish-sync.mjs` already sweeps after its own push, so either the 11-10 sync did not use it
or its sweep failed and nobody acted. The daily sweep is the backstop for every route that skips it — a
gatekeeper merge, a hand push, a sync that did not use that script.

#### The sweep runs both ways, because one direction cannot be a diff (2026-11-19, #447)

The 2026-11-19 health issue was three `REQUIRED` lanes `disabled_manually` — `fork-release.yml`,
`node-server-tests.yml` and `performance-contracts.yml` — disabled inside a nine-second window at
`2026-11-19T02:35:27–36 PST`. Nothing in the tree caused it: `git log --all` has no commit between
2026-11-17 and the check that reported it, no run started in that window, and `sweepable()` refuses to
put a `REQUIRED` path into `disableTargets` by any of its three routes. The actor is not recoverable
from a fork: `gh api repos/nplez1/orca/audit-log` is 404 without admin. The three were restored with
`gh workflow enable` at 07:49 PST, ten minutes after the red run, and the check read `OK`.

**The finding was one line of output and one dead end.** `REQUIRED` already meant "disabled is drift",
but the check could only _report_ a disabled lane, and the remedy is repository state. So the daily lane
applied `agent:auto`, an agent opened a PR, and no diff could contain the fix — the same trap the
section above records for the disable direction, mirrored, and this time nothing closed the loop.

**What changed.** `--fix` now re-enables a `REQUIRED` lane that is present but off, and two rules keep
that from being a silent tug-of-war:

- **A day that re-enabled something still exits 3.** `disabled_manually` only ever comes from a
  deliberate act — the census has never held a `disabled_inactivity` or a `disabled_fork` — so a person
  may have meant it. Exit 3 opens or updates the issue _without_ `agent:auto` and shows what was
  restored; the next clean run closes it. A lane someone keeps turning off reopens the issue every day,
  which is the point: the conflict is visible rather than papered over each morning.
- **A lane is restored only if it would pass the active-lane checks** (`planEnables`). The trigger,
  runner and cron checks only loop over _active_ files, so a disabled lane has never been judged; turning
  one on unchecked could bring back a `blacksmith-*` label (a 24 h queue), a `pull_request_target`, or an
  inherited cron. Those stay off with the reason printed. An ordinary red test is not a reason to hold a
  lane back — `check-fork-lane-red` gives that an owner.

An `absent` lane is still exit 1, because restoring the file _is_ a diff, which is exactly what an agent
can carry. The acting half of the check moved to `local/actions-enablement-sweep.mjs` in the same
change: `local/check-actions-enablement.mjs` was at 570 of the 600 counted-line budget, and the judging
half is the half worth reading on its own — the same split, and the same reason, as
`local/actions-enablement-contract.mjs`.

Root cause is not fixed here either: whatever disabled three required lanes in nine seconds was not the
tree and left no record a fork can read. The sweep is the backstop, and now it can also undo it.

#### The cost premise was wrong, and the PR lane that follows from it (audit #221 C2)

This section said the fleet being fully on "burned nearly the full month in a few days", and put the
nightly at "~50 minutes a night" against a monthly allowance. **Both claims were wrong, and the ledger
they supported was wrong with them.** Standard runners bill **nothing** on a public repository, which
this one is. Measured on 2026-10-29, per run, from
`gh api repos/nplez1/orca/actions/runs/<id>/timing`:

| run           | what it ran                                  | billable ms                     |
| ------------- | -------------------------------------------- | ------------------------------- |
| `40797794635` | nightly, 7 jobs, all five shards green       | `UBUNTU: 0`                     |
| `40863045535` | nightly, 7 jobs, shard 5 red                 | `UBUNTU: 0`                     |
| `40695040714` | a full release, macOS + Windows + Linux legs | `MACOS: 0 UBUNTU: 0 WINDOWS: 0` |

So there is no minutes budget to spend and no `~10,000` to spend it from. Account billing totals could
not be read (the token has no `user` scope), but the per-run timing API is the stronger measurement for
this question: it is what the billable-minutes meter reads.

**The decision, since the reason `pr.yml` was disabled does not hold:** `pr.yml` stays
`disabled_manually`, but not for cost. It is upstream's whole fleet in one file — package, e2e,
relay, cross-version-wire, mobile web, Windows probes — which arrives with every sync, spends 40+
minutes per PR to re-tread a branch that just ran the same suites locally, and would put a dozen
unfamiliar checks on every PR. The cheapest useful lane is the fork's own, and that is now
`fork-pr-gates.yml`: `pull_request` plus `workflow_dispatch`, running `pnpm tc`,
`pnpm run check:code-quality:changed` and `local/gate-lint.mjs` — the classes that reached this line
unnoticed and are enforceable on any branch today. It is deliberately not the unit selection:
`ci-unit-selection.mjs` computes a reverse-import closure that one changed file turns into ~3,000 of
13,064 test files, which is a shard planner, not a PR lane. The unit suite stays on
`fork-main-tests.yml` nightly and now also gates a release (`fork-release.yml`).

**Why the lint verdict and not `pnpm lint`, measured on `main` at 2026-10-29:** `pnpm lint` reported
"2 of 36 lint step(s) failed" — `oxlint` red for `src/cli/handlers/vm.ts` (336 counted lines against a
limit of 300), and `lint:ast-grep-gates` wanting a flaky-test baseline pruned. A required check that is
red on its own base teaches everyone to ignore red — the PR #57 failure shape. Attribution is _not_ the
reason to prefer the gate: since upstream's 2026-10-28 refactor `pnpm lint` is
`run-lint.mjs`, which runs every step concurrently and names all the failures. The reasons are two,
and neither is "wait until the base is green": `pnpm lint` has no notion of a known red, so a lane
re-running it is red on every PR for reds that are not that PR's; and it runs only `LINT_STEPS`, never
the five `FORK_LINT_STEPS` — `check-upstream-file-comments` among them. `local/gate-lint.mjs` runs the
same steps plus those and turns the failures into a verdict against `local/lint-known-red.json`. That is
green on a base that carries foreign reds and red on the change that adds one. Both lanes run it — see
§ `local(ci)`: the lint ratchets run on the PR and on the release line (#399).

**To make it a required check**, once it has run at least once on a PR (GitHub will not offer a check
name that has never reported):

```bash
ruleset=$(mktemp -t orca-ruleset)          # unique per agent: /tmp is shared
gh api repos/nplez1/orca/rulesets/23697698 >"$ruleset"
# add {"type":"required_status_checks","parameters":{"required_status_checks":[
#   {"context":"fork-pr-gates: typecheck"},{"context":"fork-pr-gates: changed lines"},
#   {"context":"fork-pr-gates: lint gate"}]}}
# to .rules[], then PUT the whole object back with -X PUT
```

The contexts are the job `name:` values, spelled in full because a bare `typecheck` or `lint` could be
satisfied by any other workflow with a job of that name. The ruleset is repository state a sync cannot
carry, like the enablement itself, so this paragraph is the record of the intent rather than a patch.
`fork-ci-health.yml` reports the lane going missing; it does not police the ruleset.

#### `local(ci)`: the lint ratchets run on the PR and on the release line (#399)

**The gap, measured while writing this.** `fork-main-gates.yml` ran four lint families and nothing
else from the chain, and `fork-pr-gates.yml` ran `pnpm tc` plus the changed-lines gate, which judges
only a diff. So the ~45 ratchets the changed-lines gate does not name — `check:focus-read-ratchet`,
`check:path-literal-ratchet`, the `lint:ast-grep-gates` pair, `check:workspace-record-read-ratchet`,
`check-upstream-file-comments` — reached the release line only through a hand-run
`orca-queue node local/gate-lint.mjs`. Two measured consequences:

- **#361** (per-host settings, merged 2026-11-11) went green on every check and left `main` red on
  `check:focus-read-ratchet`; `local/lint-known-red.json` gained three entries for it and the cleanup
  fell to the next, unrelated branch. #161 is the same shape from late October.
- **At `9438d16e892` (2026-11-12) the gate reports 3 of 50 steps red and 16 new reds.** None had been
  reported by any lane: `Fork base gates` had been **red for eight consecutive pushes** (first red
  43217410950 at 12:23Z, last green 43211255114 at 11:41Z) — and because the red was at `Localization
  catalogs`, which has no `if: !cancelled()`, the `Typecheck` step after it was **skipped in all
  eight**, so `pnpm tc` had not run on the release line since 11:41Z that morning.

**What changed.** Both lanes now run the gate, and neither runs `pnpm lint`:

- `fork-main-gates.yml` gains a `Lint ratchet verdict` step, placed after the recorded-sync-base fetch
  because `check-upstream-file-comments` measures against that commit, and marked `!cancelled()` so a
  red family above it cannot hide the other 45 steps — which is exactly how the eight-push window
  above hid `pnpm tc`. `timeout-minutes` goes 40 → 50 for the added step. The step sets
  `ORCA_CODE_QUALITY_BASE: HEAD`, because the gate also runs the diff-scoped steps
  (`check:code-quality:changed` and the flaky-test-pattern ratchet) whose base on the release line is
  the release line itself, and a shallow checkout need not carry `origin/main`. A gate red for a
  missing ref rather than for a finding is the failure this lane exists to prevent. The `Typecheck`
  step gains `if: !cancelled()` in the same commit: it is the step the eight-push window skipped, and
  leaving it conditional on the family above it would leave that exact hole open.
- `fork-pr-gates.yml` gains a third job, `fork-pr-gates: lint gate`. It checks out at depth 2, which
  carries the merge commit's first parent for the gate's diff-scoped steps, and fetches the recorded
  sync base for `check-upstream-file-comments`. Outside a pull request there is no merge commit, so the
  job passes `ORCA_CODE_QUALITY_BASE: HEAD` — a dispatch must not red for a `merge-base origin/main
  HEAD` a shallow checkout of a branch cannot answer. Its header comment now records why the lane runs
  the verdict instead of `pnpm lint`, and that the allowlist it reads is the PR's own.

**What the base carries, and where it went.** 16 new reds: 15 are recorded in
`local/lint-known-red.json` per owning PR, each with the exact count it was measured at, so any further
growth is a new red; the sixteenth, the localization catalog, is fixed in the tree (below).

| class                        | owner                                       | reds           |
| ---------------------------- | ------------------------------------------- | -------------- |
| `fork-comment-foreign-422`   | #422, the session-summary timeline          | 2 files        |
| `fork-comment-foreign-424`   | #424, settings search across fields         | 1 file         |
| `fork-comment-foreign-416`   | #416, the cards the sidebar filters hide    | 2 files        |
| `fork-comment-foreign-418`   | #418, a paired host's refused column        | 1 file         |
| `fork-comment-foreign-415`   | #415, Jira list paging                      | 3 files        |
| `fork-comment-foreign-414`   | #414, a failed Jira/Linear read             | 1 file         |
| `fork-comment-foreign-411`   | #411, a cleared clone destination           | 1 file         |
| `fork-comment-foreign-425`   | #425, the settings write failure            | 1 file         |
| `fork-comment-foreign-total` | #411–#425 and the files under the threshold | the 5648 total |
| `focus-read-foreign-425`     | #425, the settings write failure            | 2 rows         |

The total entry is the one that will need maintenance, and that is deliberate: it pins `5648`, so any
PR that adds or removes even one fork comment line in an upstream-owned file is red until it updates
the pin. That is the rule `LOCAL-PATCHES.md` already states — no fork comments in upstream files — so
the churn is the mechanism working rather than a cost to design away.

`check-upstream-file-comments` growth was **not** accepted into the ratchet's own baseline. The 2026-11-08
sync set that precedent: growth the tree carries stays red and is recorded per owning PR, because
`--init --accept` would absorb it silently and the ratchet would stop saying anything about those
files. Moving the prose out is those PRs' work, not this lane's.

**`verify:localization-catalogs` was fixed in the tree instead, and that is the one entry that could
not be recorded.** Its failure is a whole-step red — the check prints a coverage report rather than one
`::error::` line per offender — so a `wholeStep: true` entry would mask every future catalog break in
that step. It was also a generated artifact: #418 (`456f2fa416e`) added the four
`WorkspaceKanbanDrawer.foreignColumnRefused*` strings to `en.json` without running
`pnpm run sync:localization-runtime-catalog`, which the check itself names as the fix. Regenerating it
is the whole change; no judgement was involved.

**Cost.** 83.0 s for all 50 steps, measured at `9438d16e892` on this 18-core host; standard runners bill
nothing on a public repository (`AGENTS.md` § Verification tiers), so the lane costs wall clock only.
The gate's changed-lines step duplicates the `changed-lines` job's work on a PR. That is deliberate: the
lane runs what the release gate runs, so a green here means what a green there means.

**What this does not do.** A PR can still pass by adding its own `local/lint-known-red.json` entry in
the same commit — the file is the assertion, and the entry carries its class, owner and evidence into
the diff where the adversarial review sees it. That is the same property `local/gate-unit.mjs` has, and
it is why the entry, not the lane, is the thing to review. Making the job a **required** check is still
repository state (the ruleset block above); it needs one PR run first, because GitHub will not offer a
context that has never reported.

`tests/tools/fork-pr-gates.test.mjs` pins the third job, its name, the sync-base fetch landing before
the gate, and that the lane runs the verdict rather than `pnpm lint`.

**A sweep is never complete, and the first one wasn't.** Nine workflows survived it on 2026-10-19 —
eight still triggering on `pull_request` (`wsl-orcad-e2e`, `win-orcad-serve-switch-e2e`,
`windows-typecheck-parity`, the three `preflight-*`, and the two `zcode-*-contract`) plus
`ci-cache-warmup-platforms` on `push: [main]`. They surfaced as two mystery checks on PRs #146/#147
— the WSL orcad lane, triggered because both touched `src/main/pi/**`, a path in its filter. So
after any sync that adds workflows, re-run the listing above rather than assuming the sweep still
covers the tree.

**The sweep is now also the response to a push that activates a workflow (audit #221 C5).** Disabling a
workflow does not stop a run that is already going, which is why the 2026-10-28T13:17Z mirror push
could start "Unit transform cache producer" and leave it wedged for 12 hours: nobody swept, and a sweep
that only disabled would not have stopped it either. Two things changed:

- `local/check-actions-enablement.mjs --fix` cancels the queued and in-progress runs of everything it
  disables. It also disables an allowed-inert entry that has gained a `schedule`, `push` or
  `pull_request` trigger, because "disabled is also fine" is what allowed-inert means.
- `local/sync/publish-sync.mjs` is the release-line push and that sweep in one command, so the two
  cannot be separated. It refuses to push when a remote is missing, when `upstream/main` was not
  fetched, or when it is run from a checkout other than the one it lives in — the push would otherwise
  target one repository while the sweep targeted another.

What neither fixes: a run started by the push itself, before the sweep reaches it. That window is
seconds now instead of unlimited, and it is closed properly only by not mirroring upstream `main` at
all, which upstream-bound branches still need.

**One consequence of the 2026-11-09 rename, recorded because nothing else would say it.** `main` is now
the release line, so every upstream lane that guards on `github.ref == 'refs/heads/main'` or triggers on
`push: [main]` runs against the fork's own tree where it used to run against the mirror. Three do, all
enabled: `mobile.yml`'s path-gated push leg, `install-node-dependencies/action.yml`'s pnpm verification
cache save on any non-PR run, and `node-server-tests.yml`'s cache save on a dispatch from `main`. The
first is a real cost worth knowing (a fork-line push that touches `mobile/**` or the runtime paths it
names now runs that lane); the other two are cache writes and are the behaviour their `if:` guards
asked for. `unit-tests.yml`'s leg stays inert, because `module_cache` defaults to `off`.

#### Six lanes enabled on 2026-10-31 (audit #221 C4 follow-up)

The premise is settled above: standard runners bill nothing on a public repository, so enablement is a
review-attention decision, not a cost one. Measured over the 40.1 days to 2026-10-31, the pre-existing
fleet spent 8,291 billable-equivalent minutes (Windows ×2, macOS ×10) — `fork-release` 73%, the nightly
26%, the two PR lanes 1% — and the API reports $0 against all of it. These six add roughly 1,000
equivalent minutes a month, still $0.

| lane                        | triggers                                    | why it is on                                                             |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `fork-main-gates.yml`       | schedule, push `main`, dispatch             | repo-wide oxlint, max-lines, localization, `pnpm tc` on the release line |
| `dependency-security.yml`   | `pull_request` (path-gated), call, dispatch | supply-chain audit; lockfile/Cargo/patches changes only                  |
| `mobile.yml`                | `pull_request`, push `main`                 | mobile parity is first-class and no PR lane covered it                   |
| `node-server-tests.yml`     | `pull_request`, call, schedule, dispatch    | headless/remote server path                                              |
| `macos-updater-tests.yml`   | `pull_request`, dispatch                    | retired upstream 2026-11-24, see the note below                          |
| `performance-contracts.yml` | schedule, `pull_request`, dispatch          | perf regression contract, 21 of 24 runs green                            |

**2026-11-24 sync: `macos-updater-tests.yml` is gone, and it is the only row this list has ever
lost.** Upstream deleted the workflow itself in #46786 ("cut the suite to the tests that guard real
invariants"), together with the updater suites it ran, so the requirement was pointing at a path no
commit on either side still carries — and a required lane that no longer exists is reported `MISSING`
forever, which teaches the next reader to ignore the check. The entry came out of `REQUIRED` and
`EXPECTED_TRIGGERS` in `local/actions-enablement-contract.mjs` in the same change as this paragraph;
`check-actions-enablement.mjs` reports both a `MISSING` required lane and a `STALE` pinned entry for a
path that is gone, and the two fork tests that pin contract-against-tree
(`tests/tools/actions-enablement.test.mjs`, `tests/tools/check-actions-enablement.test.mjs`) went green
from the removal itself. Nothing is being hidden: a retirement is the one edit to that contract that
removes work instead of absorbing a finding. Its repository row was disabled by hand (the sweep can
only act on a workflow it can read), and the lane it ran — auto-update correctness, ~7 min of macOS —
now has **no** cover here; carrying it as a fork-owned `fork-updater-tests.yml` is a named follow-up,
not a sync fix. The same sweep disabled two workflows the merge brought back enabled
(`pr-description.yml`, `mobile-native-fingerprint.yml`), and the fleet stands at **18 active: 11
required + 7 inert** of 74 workflows.

**The ordering is the load-bearing part.** `local/sync/publish-sync.mjs` is the release-line push and
`check-actions-enablement --fix` in one command, so a lane that is active but not on the list is disabled
by the next sync. That is what "GitHub auto-disabled a bunch of stuff" turned out to be: the census is
`67 disabled_manually`, and it has never contained a `disabled_inactivity` (GitHub's inactivity rule
needs 60 days without repository activity, and this repo pushes daily) or a `disabled_fork`. The sweep
is the only mechanism, so the six went into `REQUIRED` in the same change that enabled them — otherwise
the next sync push would have undone it.

**`fork-main-gates.yml` had been off since 2026-10-08**, when it went red three runs running, which left
23 days in which nothing ran repo-wide oxlint, max-lines, the localization catalogs or `pnpm tc` on the
release line. The red it was disabled for (`src/cli/handlers/vm.ts`, 336 counted lines against 300) was
cleared by `8bcd16e`. At `86fb0b33` the whole step set is green: oxlint 0 errors over 40,242 files,
max-lines ratchet OK with 46 grandfathers, `audit:anti-slop` clean, `check-upstream-identity-literals` 0
findings, `pnpm tc` exit 0. It gains `timeout-minutes: 40`, which bounds a hung `pnpm tc` at 40 min
instead of the default 360 — but not the 2026-10-26 class: that job never started, and a timeout counts
only once a runner picks the job up. It **keeps `cancel-in-progress: false`** for the other half of that
incident: the run was cancelled after ~17.5 h and the cancel rewrote the run conclusion to `cancelled`,
hiding four red shards. A merge must not be able to do that to a running gate.

Two hazards are accepted knowingly, recorded here so the next reader does not rediscover them.
`node-server-tests.yml`'s `fast_runners` defaults to **true** for `workflow_dispatch` and `workflow_call`,
so a manual dispatch puts its jobs on `blacksmith-*` labels this fork does not provision; `pull_request`
and `schedule` events pass no input and stay on GitHub-hosted runners. And `mobile.yml`'s `push` leg
targets `branches: [main]`, which was the upstream mirror branch before the 2026-11-09 rename and is the
fork's own line now — so that leg used to re-test upstream's own code and now re-tests the release line.
The PR leg is still the useful half.

**Still off, and why.** `pr.yml` and `unit-tests.yml`: upstream's whole fleet in one 1,400-line file,
20 jobs, six without a timeout, `ubuntu-slim` and `blacksmith-*` labels, and it calls the red
`e2e.yml`. `unit-tests.yml` is `workflow_call`-only and already runs whenever `fork-main-tests.yml` calls
it — which is the proof that a _disabled_ reusable workflow still executes, and why enabling that file
would be a no-op. `e2e.yml` (25 of 27 runs red, no `concurrency`), `terminal-perf` (16/18),
`node-next-compat` (11/11), `terminal-ime-e2e` (4/18, no `concurrency`). The `windows-*` and `wsl-*`
lanes need signing secrets and runners this fork lacks. The publishing set the fork does not use:
`homebrew-bump`, `readme-downloads-badge`, `hourly-mac-build`, `daily-mac-build`, `release-javascript*`,
`mobile-*-release`, `cloud-*`, `pullfrog`, `docs.yml`.

**Not yet covered, stated so it is not mistaken for done.** `REQUIRED` fails when a lane is _disabled_;
nothing fails when an enabled lane sits _red_ or sits _queued_, except the nightly via
`check-nightly-liveness.mjs`. Three of the six have schedules, and GitHub mails a scheduled failure to
whoever last edited its cron line — an upstream author, for the upstream-owned ones. The cheap closure
is a queued-run check (`actions/runs?status=queued`, fail past one hour) in `fork-ci-health.yml`, which
catches every hang source including the `blacksmith-*` default above.

Two more gaps in the same guard, both reachable by a sync rather than by anyone here. Trigger validation
runs only against `ALLOWED_INERT`, so an enabled upstream-owned file can silently gain a `schedule`,
`push` or `pull_request` trigger — or a `blacksmith-*` label inside a `runs-on` expression, which no scan
looks at today. And nothing rejects `pull_request_target` in an active file; `ci-closed-pr-caches.yml`
uses it and must stay off, so a future sync is one paste away from bringing it in unwatched.

Reviewed by Opus 5.5, high, one round on the plan packet: it confirmed both premises and corrected two
items that landed here — `cancel-in-progress` stays `false`, and `fast_runners` defaults to true rather
than false, which the first draft had backwards.

#### The guards the sweep was missing (2026-11-01)

The sweep could only answer "is it disabled". Three failures it could not see, each with a real
incident behind it:

- **A lane whose `on:` keys changed.** Trigger validation covered `ALLOWED_INERT` only, so the eleven
  required lanes were unguarded: a sync could add `schedule` or `pull_request` to any of them and the
  check passed. `EXPECTED_TRIGGERS` now pins the exact keys for all 18 enabled files. **Changing a
  trigger is therefore a two-file change** — the workflow and the pin — which is the point: it makes
  the change visible in review. A mismatch on a required lane is reported and **left enabled**; only an
  allowed-inert one is disabled by `--fix`. Otherwise a sync could edit `fork-ci-health.yml`'s triggers
  and the sweep would turn off the watchdog that reports it.
- **`pull_request_target`, and `workflow_run` with it.** Both run with a write token against code from
  a fork. `ci-closed-pr-caches.yml` uses the first and must stay off, and nothing stopped a sync
  bringing either in.
- **A runner this fork does not provision.** `timeout-minutes` cannot bound this: the timeout starts
  when a runner picks the job up, so a job on a `blacksmith-*` label waits for GitHub's 24 h queue
  limit — the 17.5 h `relay_integration` wait on 2026-10-26 and the 12 h cache producer on 10-28. The
  scan follows `uses: ./.github/workflows/*.yml` edges transitively, because a called workflow runs
  whether or not it is enabled, and it reads every value except the ones that cannot select a runner
  (`run`, `if`, names and prose) — so a matrix list and a caller's `with:` are read, while
  `unit-tests.yml`'s byte-comparison of an 8-vcpu label inside a `run:` block is not. A callee that
  cannot be read is reported rather than treated as label-free. `ACCEPTED_RUNNER_LABELS` names the exact
  labels each file may use, with a reason: `node-server-tests` (behind `fast_runners`, true only for dispatch
  and call), `ci-cache-warmup-platform-jobs` (call-only, both callers disabled), and `unit-tests` (the
  `runner` input default, which both active callers override). `e2e.yml` is there for the same reason
  and is reached only through dispatch-only lanes. A new label in any of them still fails, so the
  exception cannot cover a job added later — the scan found the last two only because it looks through
  the call edge.

`local/check-queued-runs.mjs` is the runtime half, a third check in `fork-ci-health`. It reports a run
stuck in a waiting status **and** a job queued inside a run that reads `in_progress`, because that is how
both incidents actually looked — a run-level status check would have missed them. The remedy differs by
status and only one of them is a runner: `queued`/`requested` is a label, `waiting` is an environment
protection rule that has not approved the job, and `pending` is another run holding the concurrency
group. Its limits are deliberate: a one-hour threshold, three pages (recent, `queued`, `in_progress`),
and job lookups for the ten oldest in-flight runs past the threshold — oldest first, because the API's
newest-first order would cut exactly the run the check exists for. The line it prints says how many
runs' jobs it actually read.

**It found a real one on its first run.** Run `37640199177` ("Fork release", attempt 2, 2026-10-07) has
been `queued` for 593 h with **zero jobs**. GitHub refuses every API remedy — `cancel` answers
"completed", `force-cancel` answers "not queued yet", `DELETE` is 403 for this token — so it needs a
manual delete in the Actions UI, and until then the daily health check is red on it. That class is
reported as `NO JOBS` rather than `QUEUED` precisely because the fix is not a runner.

**Repository setting, not a patch:** fork-PR approval moved from `first_time_contributors` to
`all_external_contributors` (`PUT /repos/nplez1/orca/actions/permissions/fork-pr-contributor-approval`).
Default workflow permissions were already `read`, so a fork PR's token cannot write; requiring approval
is now the only way a public fork's code reaches these runners, including the macOS and Windows lanes.

#### The review after the merge found the watchdog could not fire (2026-11-01)

A fresh review of the merged revision checked the code against the real REST payloads, which the tests
had not. The job half of `check-queued-runs` was gated on `job.started_at`, and **GitHub sets
`started_at` when the job is queued, not when a runner claims it**. The 2026-10-26 relay job, captured
from `gh api`:

```
status: completed  conclusion: cancelled
started_at:   2026-10-26T10:35:26Z
completed_at: 2026-10-27T04:02:39Z   (17.5 h later)
runner_name: ""    runner_id: 0
```

So every real queued job was skipped and the check could not report either incident it was written for.
It passed 85 tests because every fixture had `started_at: null` — a shape the API never returns. Three
changes, and the test built from that payload rather than from an idea of the payload:

- **Judge a job by `status`, and use an empty `runner_name`/`runner_id: 0` as the "no runner" signal**,
  with the age from `created_at`. A job that has a runner is skipped.
- **`local/queued-known-ghosts.json`.** A zero-job run cannot be cancelled or deleted through the API,
  and `ci-health-report` _updates_ one issue in place — an edit nobody is notified about. Left as a red
  finding it would hold the check red forever and swallow the next real finding silently. Listed
  entries are reported as acknowledged and do not redden the check; anything unlisted still does, and
  an entry that stops matching is reported for pruning. An unreadable manifest does not abort the
  check: an entry can only _relax_ a finding, so continuing with none acknowledged fails safe — the
  listed ghost goes red instead of a real wait hiding behind an exit 2 that names the wrong cause.
- **The scanner denies families, not one vendor**: `blacksmith-*`, `self-hosted`, `depot-*`,
  `namespace-*`, `buildjet-*`, `ubicloud-*`, `warp-*`, `cirrus-*`, `arc-*`, the macOS size suffixes and
  the `-Ncore`/`-N-cores` spellings GitHub uses for Linux and Windows larger runners. `self-hosted`
  matters most on a public fork, and a larger runner bills even on a public repository. Matching is
  case-insensitive and anchored on a word boundary, so `concurrency.group: deploy-self-hosted-now` is
  prose. Exclusions are inherited, so anything under `env:` or a github-script `script:` body is prose
  too; call edges come from parsed `jobs.*.uses`, not from a text match.
- **`created_at` is the right age for a job, measured rather than assumed.** A job gated on `needs:`
  gets its record created when it becomes _eligible_, not at run start — on run `40308443374` the plan
  job started at 10:34:21 and its shards were created at 10:35:26, and a release run's shards were
  created 1m11s after it began. So a dependency wait cannot read as a queue wait. What the check does
  report after an hour is a job held by an environment rule or a job-level `concurrency:`, and it says
  so in its remedy line instead of blaming a runner.

**Known limit of that guard: it is a deny-list, not an allow-list.** A typo (`ubunut-latest`) or a
vendor nobody has added still passes. Allowing only `ubuntu-*`/`windows-*`/`macos-*` without a larger
suffix would be strictly stronger, and is the change to make if this ever misses something real.

**Deferred, recorded so a later reader does not assume them done.** Nothing checks that every caller of
a workflow with an accepted input default (`unit-tests.yml`'s `runner`) actually passes it, so a new
caller that omits the input would pass statically — the run-status check catches the wedged result in
production instead. The push that publishes a sync evaluates upstream's copy of each file — that was
the mirror push, and it is the release-line push now — which this scan never reads. `/jobs` is read one page.

#### GitHub disabled Actions for inherited crons (2026-11-06)

On 2026-11-06 GitHub switched Actions off for the whole repository. The stated reason was compute
"wasted" by inherited workflows: _"Workflows inherited from the upstream repository often run on
schedules or events that aren't needed on a fork."_ Nothing had run since 18:09 that day, and every
endpoint this repo's own checks read still said healthy — `actions/permissions` reported
`enabled: true`, all 18 active workflows reported `active`, and `check-actions-enablement` printed
`OK` while CI had been dead for 33 hours.

**The inherited crons were the fault, and the sweep was enforcing them.** Two upstream files carried
upstream's cron and nothing else did:

| file                        | cron          | fork-written?   |
| --------------------------- | ------------- | --------------- |
| `node-server-tests.yml`     | `30 11 * * *` | no — upstream's |
| `performance-contracts.yml` | `15 9 * * *`  | no — upstream's |

The other four schedules are `fork-main-tests` (`53 4`), `fork-main-gates` (`23 4`),
`fork-upstream-tags` (`17 3`) and `fork-ci-health` (`11 6`) — every one of them a lane this fork wrote.
The problem was not that the two upstream crons were invisible: `EXPECTED_TRIGGERS` **pinned them as
expected**, so the guard that exists to catch work nobody asked for was the mechanism keeping it.
Pinning the status quo is not approving it, and the table could not tell the difference.

**Three changes, in the order they matter.**

- The two `schedule:` blocks are gone. Both lanes keep their `pull_request` legs, which is the coverage
  the fork enabled them for; `node-server-tests` keeps `workflow_call`, so `qualified-orcad-template`
  still reaches it. Measured cost of the removed crons: 324 + 85 minutes a week.
- `FORK_SCHEDULES` is a new positive assertion in `check-actions-enablement.mjs`: the only files
  allowed a `schedule:` trigger, each with the reason it needs a clock. An enabled file with a cron and
  no entry is reported as `SCHEDULE` and is **never** auto-disabled — the fix is to delete the cron,
  not to switch the lane off, and a `--fix` that disabled `node-server-tests` would delete real
  headless-path coverage to solve a scheduling problem.
- `judgeActionsEnabled` reads `GET /repos/nplez1/orca/actions/permissions` and reports an explicit
  `enabled: false`. It can only help from outside Actions — a repository with Actions disabled cannot
  run the workflow that would report it — so its value is `node local/check-actions-enablement.mjs` on
  the host, which is the only vantage point that can see an absence of runs as an absence.

**The cron removal broke an upstream test, and the PR gate did not run it.**
An upstream test pinned `workflow.on.schedule` for `node-server-tests.yml` at one entry, and the fork
re-pointed it at its own truth (`not.toHaveProperty('schedule')`) with the reason inline. Deleting the
cron made the original assertion fail with `Target cannot be null or undefined`.
It reached `main` because every path #288 touched — `local/`, `tests/`, `.github/`, `*.md` — is
in `open-pr.mjs`'s `TARGETED_PATHS`, so gate 1 read "not required" and no suite ran; the first run to
see it was the 2026-11-08 dispatch, shard 12/12.
**That guard is gone now.** Upstream retired the test in the 2026-11-08 sync — its module is
`config/scripts/node-server/qualification/node-server-change-scope.mjs`, and no assertion about
`schedule` survives there — so nothing pins the cron's absence any more. `FORK_SCHEDULES` in
`check-actions-enablement.mjs` is what is left, and it is a different check: it reports an enabled
workflow whose cron has no allowlist entry, not a cron that has gone missing.
The lesson is not "run the suite more" — the classification was right about every path it looked at. It
is that a **workflow file is a global input when a test parses it**, which no path rule can express, so
the `config/scripts` consumers are where to look after any workflow edit.

**Why this is not just "we deleted two lines".** The next upstream sync can put either cron back, and
it will: those are upstream's files. `FORK_SCHEDULES` is what makes the reintroduction a report rather
than a silent return, and `local/sync/publish-sync.mjs` already runs
`check-actions-enablement --fix` after a sync. The four fork-owned crons are in `REQUIRED`, so the same
sweep cannot disable them either.

**Not fixed, and worth knowing.** The 2026-11-06 disable also means the fork ran ~33 hours with no
nightly, no health report and no release lane before anyone noticed, because every detector lives
inside the thing that was off. The host-side run above is the only one that closes that, and it is a
launchd job rather than a workflow.

#### The perf contracts get a fork-owned clock (2026-11-17, #289)

Removing the two inherited crons left one real gap. `performance-contracts.yml` runs
`config/vitest.performance.config.ts`, which `fork-main-tests.yml` does not cover, and its
`pull_request` leg is path-gated to ~18 named contract files — so a change that slowed something down
without touching one of them was caught by nothing until someone ran the lane by hand.

**The cron is in a new fork-owned caller, `.github/workflows/fork-performance-contracts.yml`, and not
in `performance-contracts.yml` itself.** The issue allowed either. The reason for this one is what
`FORK_SCHEDULES` can see: it reports a cron on a file it has **no** entry for, and `EXPECTED_TRIGGERS`
pins a lane's trigger _keys_, not the cron's value. Listing the upstream file in `FORK_SCHEDULES`
would therefore switch the guard off for exactly the file 2026-11-06 was about — a sync restoring its
own `15 9 * * *` would be silent, and so would a change back to daily. Leaving it out keeps both
reportable, and the fork's own file is one a sync cannot touch at all.

- `performance-contracts.yml` gains `workflow_call:` and nothing else — not even a `#` comment, because
  `local/check-upstream-file-comments.mjs` freezes the fork's comment lines in upstream-owned files and
  the reasoning already lives in the caller and in this section. Its `pull_request` leg, its matrix and
  its own `workflow_dispatch` are untouched.
- The caller runs `15 9 */2 * *` and `workflow_dispatch`. Its one job has neither `runs-on` nor
  `timeout-minutes` — neither key is allowed on a job that calls a reusable workflow, so what runs is
  the callee's three-OS matrix, and its 20 minutes per leg is the bound.
- **The two concurrency groups must differ.** A called workflow shares the caller's `github` context,
  so the callee's `performance-contracts-${{ github.event.pull_request.number || github.ref }}`
  resolves to `performance-contracts-refs/heads/main`; two workflows in one group deadlock, and GitHub
  resolves that by cancelling the run.
- **Known cost of that shared group:** a _direct_ dispatch of `performance-contracts.yml` on `main`
  joins the same group, so it cancels a scheduled call in flight. A cancelled run is not a verdict, so
  nothing reports a false red — the cost is up to four days without one. The caller's own group is
  separate and cannot collide with anything.
- `FORK_SCHEDULES` gains the caller with its reason, and `EXPECTED_TRIGGERS` gains `workflow_call` for
  the callee and `['schedule', 'workflow_dispatch']` for the caller — so a sync that drops
  `workflow_call` fails the table-vs-file test before the scheduled run breaks with `startup_failure`.
  One test pins the call edge itself: a retargeted `uses:` would otherwise leave a scheduled lane that
  runs green doing nothing.
- The caller is in `REQUIRED` (a `FORK_SCHEDULES` path must be), which puts it in
  `check-fork-lane-red.mjs`'s judged set: a red run on `main` now opens or updates `Fork CI health:
  attention` and delegates `agent:auto`. That is intended — a lane on a clock with no owner is the
  failure that check exists to end — but it is new automated work on lanes that were 21 of 24 green.
  Its header now says so, and the report's name column widened from 18 to 26 for the longer lane name.
- Cost: 85 min/week at daily, ~43 at this cadence, and 0 billable minutes on standard runners for a
  public repository.
- **`*/2` on day-of-month means odd days, so a month with 31 days runs the 31st and then the 1st a day
  apart** (and a leap February its 29th and the 1st). Harmless, and cheaper than a cron that has to stay
  in step with month lengths.

**Upstream's `config/performance-audit.md` still says this lane "runs daily", and is left alone.** The
sentence is true of upstream's own copy, which keeps its cron, and editing it would put a conflict
point in an upstream file at every sync for a cadence note this section already carries.

**The `OK` verdict is only reachable after the merge.** A required lane that exists only on a branch is
`STALE` (no workflow file by that path on the repository) and `MISSING` (required but absent) until the
file lands on `main`, so `node local/check-actions-enablement.mjs` on the branch reports exactly those
two and exits 1. That is the same transient `fork-pr-gates.yml` had on 2026-10-29, and the post-merge
shape is what the table tests pin. `check-fork-lane-red.mjs` reads `cannot tell` (exit 2) on the branch
for the same reason — its runs endpoint is keyed by workflow file name, and the file is registered by
the push to `main`. After that push the lane reads `NO RUNS` until its first scheduled run — 09:15 UTC
on an odd day — or a dispatch, which is exit 0, so no false red is possible in between.

#### The health issue delegates itself (2026-11-08)

A red nightly still needed a person: `fork-ci-health.yml` opened `Fork CI health: attention`, and
the rule in `~/Code/orca/AGENTS.md` was that the first agent to open a session triages it. Meanwhile
the `agent:auto` pipeline had a working end-to-end lane, so the red night sat until someone noticed.
`ci-health-report.mjs` now reconciles `agent:auto` against its own verdict and the pipeline picks the
issue up.

**The obvious implementation does not work, and that is the point of recording it here.** Adding
`--label agent:auto` to the existing `gh issue create` would have produced an issue the driver skips
forever: `driver.py::_labeler_permission` reads the `labeled` event's actor and returns `skip_labeler`
for any `[bot]` actor before it ever checks permission, because "an agent holding a token must not be
able to queue work for itself". The workflow authenticates as `github-actions[bot]`, so the label has
to come from a token whose actor is a collaborator — `AGENT_DELEGATE_TOKEN` — and the report exits 2
rather than quietly leaving the label off when that secret is unset. Silent success is the failure
mode this file exists to end, so it must not be reintroduced by the fix.

**The known-red filter was already there, one layer down.** No new filter was written: a shard job
fails only when its red matches no entry in `local/nightly-linux-known-red.json`
(`local/check-unit-shard-verdict.mjs`, called at `unit-tests.yml:176`), so a known-red-only night is
green at the job level and `failedJobs` is empty. The classes `AGENTS.md` forbids fixing inside the
fork therefore cannot reach the issue at all — asserted in the issue body rather than assumed.

**Two narrower calls worth disagreeing with deliberately.** Only exit 1 delegates: exit 2 means a
check never reached a verdict, which is a broken harness rather than a scoped request, and an
implementer with auto-merge should not be guessing at it. And `close` never removes the label, since
the pipeline keeps it on a closed issue as the audit record; an `update` whose red has cleared does
remove it, which revokes the delegation before a workspace can merge a fix for a failure that is gone.

#### Only the nightly's reds reached the issue (2026-11-16)

A triage of every red run from 2026-11-12 to 11-16 found seventeen failure emails and one issue behind
thirteen of them. Those thirteen were the 11-15/16 upstream sync and release on `main` — a macOS native
build (`cannot find 'TrustedOrcaApplication' in scope`), `check-upstream-file-comments`, five unit shard
verdicts and two PR-branch iterations — and every one was green by 08:23Z, with the release gate passing
at 07:49Z and `v1.4.214-np.56` published at 09:05Z. The one lane left red, `Main blocking work guards`,
was an upstream lane the sync re-enabled and the enablement sweep correctly disabled.

What was not fine is that nothing would have said so. The other four were `Mirror upstream release tags`
failing on **four consecutive scheduled days**: upstream re-pointed `v1.4.256`, the fork had it at
another commit, and `.github/scripts/fork-tag-mirror-guard.sh` refused — correctly, because adopting
upstream's commit for a published tag name is a release decision. The only record was the failure email,
cleared by hand on 11-15T19:21Z.

Why it was invisible: `ci-health-report.mjs` owns one issue and it carried three checks — enablement, the
nightly's liveness, stuck runs. A nightly red does reach it, and that is the machinery working as
intended: #423 opened 2026-11-12T15:06Z carrying `check-nightly-liveness — exit 1 "nightly red (failure)
at 1.8h old"`, `agent:auto` applied by `nplez1` (not `github-actions[bot]`, which the driver refuses),
picked up by the driver, closed when the shard's red cleared. A red in any _other_ lane reached nothing.

So `local/check-fork-lane-red.mjs` is the fourth check. Its scope is four deliberate bounds: fork-owned
`REQUIRED` lanes only (an upstream lane's red is a sync or a disable, not a row someone should chase);
`--branch main` only (a PR-branch red cannot merge, and reading it would redden the daily issue on every
work-in-progress push); the **newest** verdict rather than every run, which is what makes it self-healing
— a lane whose newest verdict is green has been fixed; and `cancelled` is not a verdict, since 11 of the
21 non-success runs in the 11-16 window were `concurrency.cancel-in-progress` supersessions.

Two lanes are excluded, with the reason stated in the module rather than implied. `fork-main-tests.yml`
belongs to `check-nightly-liveness`, which also separates "stopped firing" from "fired and failed" — a
distinction a run-list reader cannot make. `fork-ci-health.yml` is the reporter itself: its own red (an
unset `AGENT_DELEGATE_TOKEN`, a crash) is the one signal that cannot be delivered inside the issue it
maintains, and stays a failure email. That is the same gap recorded above as "every detector lives
inside the thing that was off", and it is stated rather than papered over.

**A red in the tag mirror is exit 3, not exit 1.** It has two failure causes and both are a person's:
the guard refusing to move a tag, where which commit a published tag points at is not an agent's call,
and `FORK_TAG_MIRROR_TOKEN` missing or expired, which is a secret rotation. Exit 3 withholds `agent:auto`
from the whole issue through the existing `judgeDelegation` rule — an agent handed a red it may not
resolve resolves it anyway — so the issue still opens, and the four red days stop being silent.

**What that costs, stated because it is not free.** Because exit 3 vetoes the whole issue, a decision red
that persists also withholds the delegation of every other red for as long as it persists. Replay
2026-11-12 → 11-15 with this check in place and the nightly red of 11-12 would have been withheld until
the tag was cleared by hand on 11-15. With the enablement check that veto was a rare one-off; here it can
last days. Keeping it is still the right call — the alternative is handing an agent an issue containing a
release decision — but the mitigation is that a decision red is now visible instead of email-only: the
issue opens and its body names the choice under `DECISION:`. Narrowing the veto (a check marking its own
rows as out of scope without vetoing the others') is the change to make if a long decision red ever holds
a real fix hostage.

**`fork-release` is a delegable red that a merge does not clear.** Its only trigger is a dispatch, so its
newest verdict moves only when someone cuts another release — and one of its failures is
`cannot find 'TrustedOrcaApplication' in scope`, a macOS native build break that no other lane compiles,
which is why it is not simply excluded. The row says so under `DISPATCH:` instead: fix the failure, and
the re-run is a release decision. Left out of this: the same argument would apply to anything dispatched
by hand, and nothing yet bounds a stale dispatch red's age.

The same triage found `local/queued-known-ghosts.json` carrying `43095501923`, a run that completed as
`cancelled` on 2026-11-15T17:39Z; the check had been reporting it for pruning. Removed.

#### The stale-nightly check could not name the third cause (2026-11-08, #291)

The disable above surfaced as `check-nightly-liveness` exit 1: _"the newest scheduled run is 40h old
(failure), past the 36h threshold for a 4:53 UTC daily schedule — the cron is not firing, or the
workflow is disabled."_ Both of those were false. The cron was fine and the workflow read `active`; the
repository-level switch was off. `judgeActionsEnabled` can only read that switch from the host, because
a workflow token gets `403 Resource not accessible by integration` from
`GET /repos/{owner}/{repo}/actions/permissions` — that 403 is in issue #291's own report, printed beside
a `check-actions-enablement` row that says `OK`.

So the check now **infers** the cause rather than guessing between two. When the schedule is stale it
reads repository-wide run history (`gh run list --repo`, no workflow and no branch filter) and asks the
one question a workflow-scoped list cannot: did anything in this repository run inside the 12 h window
the slot should have fired in? Run against this incident, the answer it prints is:

> the 2026-11-07T04:53:00Z slot produced no run, and no workflow in nplez1/orca ran in the 12h after it
> either (34.3h of silence from 2026-11-06T18:09:57Z) — so the repository-level Actions switch was off
> or GitHub was down, which is not this cron.

Five bounds keep it honest. It judges the **newest** slot whose window has closed, because the oldest
would blame a past outage for a cron that is still broken — and `missedSlot` therefore means the slot
being judged, not the first one missed, which a `--json` consumer has to read that way. The count of
due slots is arithmetic and uncapped (only the listing is bounded at 14), because a month-long outage
reported as two weeks is the same class of error. The 12 h window is measured, not assumed:
every nightly so far has landed between 10:37 and 12:54 UTC against a 04:53 schedule, so GitHub's cron
delay is hours and a slot's own minute proves nothing. A page of runs that **stops short** of the slot
is reported as no evidence rather than as silence, because a truncated list would manufacture exactly
the false cause this exists to find. And runs without a `schedule` event are their own answer — the
repository is working and no cron anywhere is firing, which no enablement of this workflow explains.
The read happens **only** when a slot is due, and a failed or forbidden read reports the cause as
unknown rather than falling back to the old two-way guess. A `--json` consumer sees all of it as
`staleSchedule`, `missedSlot`, `missedSlots`, `repoRunsInWindow` and `repoReadError`.

It cannot _fix_ a disabled repository — nothing inside Actions can. What it changes is who the issue
blames: this triage read the cron, the workflow's enablement and the last run's logs first, and none of
them was the answer.

The same run's red shard was a different problem and is already fixed: `use-agent-tab-focus-overlay-
close.test.tsx › leaves focus that lands after the overlay is gone` raced `act`'s queued task flush, and
#285 drains the observer's records on a microtask instead. The first run carrying that fix, the
2026-11-08 dispatch, passed shard 4/12.

### `local(hooks)`: refuse fork-only commits on an upstream-bound branch

`.husky/commit-msg` refuses any commit whose subject starts with `local(` unless the branch is on
`main`'s own line, and refuses any commit staging a fork-owned path on a branch that is not.
Upstream-bound branches are cut from `upstream/main`, so a fork-only file committed to one is reviewed
upstream. It is `commit-msg` rather than `pre-commit` because the message is what identifies the
commit as fork-only, and `pre-commit` cannot see it. The decision lives in
`local/commit-msg-guard.mjs`, which imports the same fork-owned path set from
`local/fork-owned-paths.mjs` that `local/open-pr.mjs --upstream` refuses at PR time — one definition,
two stops.

**Scoped to lineage on 2026-10-27, not to a branch name.** The original rule allowed `local(` on
`main` and nowhere else, which included fork PR branches — and the result was worse than the
mistake it guarded: policy work committed there _without_ the `local(` label at least five times
(#146, #130, #142, #177, #52), producing unlabelled fork-only changes riding fork PRs. A fork PR
branch descends from `main`; that lineage is what the rule follows, so `local(` is allowed
on the fork's own line and still refused on anything cut from `upstream/main`.

**Tested as lineage, not as the tip, on 2026-11-09 (#319).** The first lineage test asked whether the
_current_ `main` tip was an ancestor of `HEAD`, so the moment the fork advanced — any other PR
squash-merging — every older fork branch was refused, which pushed exactly the same unlabelled-commit
workaround. It also refused every `local(` commit when no local `main` ref existed, which is
the state of a fresh clone. Now: `merge-base --all HEAD <forkRef>` must be non-empty, and `git
rev-list -1 <bases> --not <every resolvable upstream ref>` must be non-empty — the fork's own commits
have to be behind `HEAD`, however far behind the tip the branch is. `UPSTREAM_BASE_REFS` is a list for
that reason and holds one entry, `upstream/main`: `main` on both remotes is the fork's own line since
the 2026-11-09 rename, so `origin/main` is the opposite of an upstream base — listing it emptied the
derived fork-owned set and let a fork-only file ride an upstream-bound branch. Unresolvable refs,
an unborn `HEAD`, and a fork ref with no reachable common ancestor (a `--depth` clone) allow the
commit with a warning, because a hook that blocks a fresh clone gets `--no-verify`'d and then guards
nothing.

**Known limit, not a bug to rediscover:** a branch whose commits reach `main` through a merge
commit rather than a squash is indistinguishable from fork work, because its own commits become
fork-only bases. Lineage cannot tell that case apart from a real fork branch. The `local(` subject and
the fork-owned paths are what remain, plus `open-pr --upstream`.

**The hook can only see a tree that carries it.** `upstream/main` has neither `.husky/commit-msg` nor
`local/`, and husky's runner exits 0 when a hook file is absent, so a clean
upstream checkout has no hook at all. It fires on a tree that already carries the fork's hook: a merge
of `main` into an upstream branch, a manual checkout of the hook, or a tree that has already
leaked. `local/open-pr.mjs --upstream` remains the stop for the rest, and a plain `gh pr create`
still bypasses both.

If a commit is wrongly refused, the fix is to branch from `main`, not to bypass the hook.

### `local(vm)`: an ephemeral machine per worktree

`environmentRecipes` in `orca.yaml` plus `local/orca-vm/{create,destroy,suspend,resume}.sh`: allocate a
machine from the team provisioning system when a worktree is created, and release it when that
worktree is deleted.

**The fork's two startup duties sit in the registrar, and they have to.** The 2026-11-27 sync brought
upstream's lazy IPC groups: `src/main/ipc/ephemeral-vm/ephemeral-vm.ts` now loads only on the first
`ephemeralVm:*` call. The fork's reclaim sweep (`startEphemeralVmRuntimeReclaim`) and
interrupted-provision flagging (`flagInterruptedEphemeralVmProvisioning`) are about state the previous
session left behind, so the session that never opens the VM UI is exactly the one that must still run
them: both are called from `runForkEphemeralVmStartupDuties` in
`src/main/ipc/ephemeral-vm/lazy-ephemeral-vm-handlers.ts`, outside the lazy group, and
`lazy-ephemeral-vm-handlers.test.ts` fails if they move back inside it. Each call is idempotent across
registrations (the reclaimer adopts the new context rather than arming a second interval). The two
`fork-comment-ok` markers that carry this reason in upstream's file point here; a third comment in
`ephemeral-vm.ts` was deleted rather than marked, because the registrar already says it.

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
bundle hash, so it moves on every commit to the relay's own source tree; the compiled dependencies are
deliberately keyed on something stabler — `~/.orca-remote/native/<relayPlatform>-<depsHash>/node_modules`,
keyed on the pinned dep versions plus patch bytes, symlinked into every relay dir, immutable once
`.deps-complete` is written last after a probe on that host loaded both addons.

Read this section as background: upstream **deleted the SSH relay server** at `2b4b60a87ea` ("delete the
SSH relay server, its build assets and tests", #27215), so the flat `src/relay/` tree no longer exists and
the per-platform `out/relay` directories it described are gone. What remains is the bridge under
`src/main/ssh/legacy-relay/`, which is host-side.

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
| Linux deb/rpm package name       | `orca-np` (`/usr/bin/orca-np`)    |
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

Deliberately NOT renamed: the bundled launcher FILE names (see the Linux note below); the per-repo
`.orca/` directory convention, which is a repo directory rather than the home directory; and the
AppImage artifact name.

#### The Linux packages (`2026-10-21`)

This fork now releases Linux, so the deferred half of the table above is settled. `deb.packageName`
and `rpm.packageName` are **`orca-np`**, with matching artifact file names
(`orca-np_<version>_amd64.deb`, `orca-np-<version>.x86_64.rpm`). That name is what dpkg and rpm use
for ownership: while it stayed `orca-ide`, installing Orca NP from a package would have _replaced_ an
official Orca install rather than sitting beside it, which is the whole point of this section.
`resources/linux/packaging/after-install.sh` now links `/usr/bin/orca-np` (never
`/usr/bin/orca-ide`, which belongs to the official package) and discovers the install directory from
a quoted candidate list, because `productName` puts a space in it (`/opt/Orca NP` —
electron-builder's `sanitizeFileName` keeps spaces, and only the directory name comes from it).

Four couplings that stay as upstream has them, each for a reason:

- **`linux.executableName: 'orca-ide'`** in the base config, and the bundled launcher file
  `resources/bin/orca-ide`. `LINUX_CLI_COMMAND_NAME` and the AppImage cache layout resolve that exact
  path, and the _installed_ command is already `orca-np` (`CLI_COMMAND_NAME`) — so renaming the
  in-bundle file would touch app-side CLI registration and its AppImage tests for no gain. The base
  config keeps upstream's value byte-identically because the overlay overrides it to `orca-np`, which
  is what pins it (`config/scripts/electron-builder-np-config.test.mjs`); the in-bundle launcher file's
  name is pinned by `config/scripts/electron-builder-linux-config.test.mjs`, which holds
  `linux.executableName` at `orca-ide` and records that `LINUX_CLI_COMMAND_NAME` and the AppImage cache
  layout locate `resources/bin/orca-ide`. The packaged-cli-assets suite that exercised the launcher
  itself was retired by upstream's 2026-11-24 test-inventory pass, so
  `src/main/cli/packaged-assets/bundled-cli-launcher-path.ts` carries that rule with no test at HEAD.
- **The AppImage artifact name** (`orca-linux[-arm64].AppImage`).
  `config/scripts/static-appimage-package-contract.cjs` derives the artifact's target architecture
  from that exact name, and the PR lane runs it as `dist/orca-linux.AppImage`.
- **`StartupWMClass: 'orca'`** — unchanged, because the class comes from the app name Electron reports
  rather than from the package or executable name. **Unverified for this fork's packaged name**:
  upstream observed `WM_CLASS=orca` with its own app name, and this build's packaged app name is
  `Orca NP` (`main-process-ready-foundation.ts` calls `app.setName`), so the first shipped build
  should confirm with `xprop WM_CLASS` that the dock still groups. If it reports something else, that
  one line in `config/electron-builder.config.cjs` is the fix.
- **The `/opt` prefix itself.** electron-builder always stages the package payload at
  `/opt/${sanitizedProductName}`, so the only lever is the discovery list in the two packaging
  scripts — not a `productName` change, which would move the macOS bundle and the Windows app too.

Files touched by the rename, so a sync can recheck them: `config/electron-builder.np.config.cjs`,
`resources/linux/packaging/after-install.sh`, `resources/linux/packaging/after-remove.sh`,
`config/scripts/electron-builder-np-config.test.mjs`, and the two package-name literals in
`.github/workflows/pr.yml`'s "Verify root-package marker payloads" step.

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
- `APP_DEV_DISPLAY_NAME` = `Orca NP Dev` — the dev/E2E label. It was meant to drive `app.setName`,
  but it does not: `src/main/startup/dev-instance-identity.ts:5` has its own literal
  `BASE_APP_NAME = 'Orca NP'` and builds the dev name from it, and `APP_DEV_DISPLAY_NAME` is read only
  by `system-tray.ts`. The constant property is what matters either way — a per-worktree dev name would
  mint a new macOS safeStorage Keychain item per branch — so the two literals must be renamed together.

TS readers: `src/main/startup/dev-instance-identity.ts`, plus the display slots in `system-tray.ts`,
`createMainWindow.ts`, `main-window-close-lifecycle.ts`, `dashboard-popout-window.ts`,
`push-dispatcher.ts` and the three notification builders under `src/main/ipc/`; in the renderer,
`TitlebarLeftControls.tsx`, `resource-usage-metrics.tsx`, `OnboardingFlow.tsx`,
`CrashReportDialogSurface.tsx`, `HomeSlide.tsx`, `AutomationEditorDialogHeader.tsx`,
`AutomationRunDetailsPage.tsx`, `web-app-api.ts` and `web-runtime-environment.ts`.

Two readers cannot import TypeScript and therefore keep a literal: `productName` in
`config/electron-builder.np.config.cjs` and `DEV_BUNDLE_DISPLAY_NAME` in
`config/scripts/development/electron-bundle-cache/dev-electron-bundle-identity.mjs`. Each is pinned
to the literal by a test (`electron-builder-np-config.test.mjs`,
`tests/tools/fork-invariants.test.mjs`), so a rename that misses one fails there instead of shipping
a build whose window disagrees with its own bundle name.

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

#### The names one install owns below the bundle id (2026-10-29, fork issue #211)

The rename above held at the bundle id and the userData path and failed at every level below it: a
second install was still reachable through shared install directories, shared package payload paths,
shared CLI profiles and shared supervisor and guest registrations. Each is independently reachable, so
each now carries the identity, and each is pinned by a test rather than by a comment:

| Piece                                                   | Value                                                                      | Pinned by                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| package `name` (NSIS install dir, `*-updater` cache)    | `orca-np`                                                                  | `config/scripts/electron-builder-np-config.test.mjs`               |
| `linux.executableName` (desktop entry, icons, mime xml) | `orca-np`                                                                  | same file                                                          |
| Linux CLI profile                                       | `~/.config/orca-np`                                                        | `src/cli/runtime/metadata.test.ts`                                 |
| agent-hook entry matcher                                | `.orca-np` only                                                            | `src/main/agent-hooks/managed-command-matcher-legacy-home.test.ts` |
| shared managed-hook script path                         | `~/.orca-np/agent-hooks/<script>`                                          | `tests/tools/fork-invariants.test.mjs`                             |
| managed-hook command (posix, cmd, PowerShell)           | the same `~/.orca-np/agent-hooks/<script>`                                 | same file                                                          |
| launchd label / systemd unit / serve logs               | `com.nplez1.orca.serve`, `orca-np-serve.service`, `~/Library/Logs/orca-np` | `tests/tools/fork-invariants.test.mjs`                             |
| WSL guest command + bridge                              | `~/.local/bin/orca-np`, `~/.local/share/orca-np/orca-wsl-bridge.ps1`       | nothing at HEAD — coverage owed                                    |
| `BROWSER` in a pane                                     | the resolved launcher's basename                                           | `tests/tools/fork-invariants.test.mjs`                             |
| dev profile fallback                                    | `orca-np-dev`                                                              | same file                                                          |
| `serve service install` default command                 | `orca-np`                                                                  | nothing at HEAD — coverage owed                                    |
| serve park/ack coordination root                        | `Application Support/orca-np`                                              | `src/shared/serve-bundle-coordination.test.ts`                     |
| bundle id (`np.appId`, notification pane, TCC trust)    | `com.nplez1.orca`                                                          | `tests/tools/fork-invariants.test.mjs`                             |
| app name / AppUserModelId / dev bundle plist            | `Orca NP`, `Orca NP Dev`, `com.nplez1.orca.dev`                            | same file                                                          |
| release feed, downloads and skills repository           | `nplez1/orca`                                                              | same file                                                          |
| Developer ID team (`ORCA_MAC_TEAM_ID`)                  | `APPLE_TEAM_ID` when set                                                   | same file                                                          |
| Linux install symlink                                   | `/usr/bin/orca-np`, from `after-install.sh`                                | same file                                                          |
| managed-hook install lock                               | `~/.orca` (shared cross-install mutex, deliberately not renamed)           | same file                                                          |

The two rows above whose pin reads "coverage owed" lost their guard in upstream's 2026-11-24
test-inventory pass: the WSL managed-CLI suite went with the rest of `src/main/cli/wsl/`'s tests, so
`getManagedWslCliDir` is unpinned, and the serve-service suite went too, so the default command
`serve service install` derives from `getOrcaCliCommandNameForPlatform` in
`src/shared/cli/orca-cli-command-name.ts` has no test asserting the name it resolves.

Three couplings that only show up in the built artifact:

- **`extraMetadata` is spread, not replaced.** A dev-channel build stages its `version` there, so the
  overlay writes `{ ...release.extraMetadata, name }`; overwriting the object ships the wrong version.
- **`resources/linux/bin/orca-ide` now searches for `orca-np` first.** The in-bundle CLI launcher keeps
  upstream's file name (pinned by `LINUX_CLI_COMMAND_NAME`), but the executable beside it is this
  build's. The packaged-cli-assets suite ran the script against both layouts; it went in upstream's
  2026-11-24 test-inventory pass and nothing runs that script at HEAD, so that coverage is owed.
- **`src/shared/appimage-cache-identity.ts` recognises both executable names.** An AppImage generation
  cached by an earlier build still runs as `orca-ide`, so keying the cache layout on one name would
  drop its lease and its update handoff.

#### The shared hook script path is pinned by behaviour, not by file (`2026-11-09`, fork issue #299)

Upstream extracted `getSharedManagedScriptPath` out of `installer-utils.ts` into
`agent-hooks/installation/scripts/managed-hook-script-path.ts` with a literal `join(homedir(), '.orca',
'agent-hooks', …)`, so the next sync re-introduces the collision **without a conflict**: the new file
is an add, and this fork's copy of the old one is a modify/delete. Nothing else catches it —
`fork-symbol-survival` reads the name as relocated and only asks for review, and the identity sweep
reports the literal as a report-only `home-dir-reader` finding and exits 0 (its allowlist entry is
scoped to the install-lock **test**, which is a different file). At sync time, point that file at
`HOME_DIRECTORY_NAME`. The pin is `tests/tools/fork-invariants.test.mjs`, which finds the module that
_defines_ the resolver by search rather than importing a known path, so the assertion survives the
relocation instead of failing on it. It also fails if `HOME_DIRECTORY_NAME` itself is reverted,
because the resolved path must not carry `LEGACY_HOME_DIRECTORY_NAME`.

The same test pins `wrapRuntimeHomeHookCommand`, the reader rather than the writer: upstream renames
it into `agent-hooks/installation/commands/` with `.orca` in all three of its branches, and a reverted
reader runs the official install's scripts. A computed import is invisible to the reverse-import
selector, so `local/sync` runs the test itself as the `fork-invariants` post-sync row — otherwise the
first run to go red would be the nightly, after the merge is already pushed.

The identity sweep's allowlist entry for the lock is depth-independent for the same reason: upstream
re-homed `managed-hook-install-lock.test.ts` under `agent-hooks/installation/locking/`, where a fixed
path pattern stops matching and the lock's `.orca` reads as an unfixed literal.

Two upgrade costs, both accepted deliberately rather than migrated:

- **The `BROWSER` command did not change on macOS or Linux, and did not need to.** There the basename
  of the resolved launcher is `orca` — this build's own bundled launcher and its own Linux shim
  (created only so a bare `orca` reaches us instead of GNOME's screen reader), both ahead of anything
  else on the pane's PATH. What changed is that the value is now derived from the launcher the pane
  actually has; Windows (previously `orca`) and dev/WSL follow their own names.
- **macOS Keychain and Linux libsecret identity move with the package name.** Electron fixes the
  safeStorage service name before `ready` from the bundled `package.json`'s `name`, which is why
  `main-process-preflight.ts` renames only dev builds pre-ready. Renaming the package therefore moves
  the macOS Keychain item from `orca Safe Storage` to `orca-np Safe Storage`. That is also the bug being
  fixed — with `name: orca`, this build and an official install shared one Keychain item — but the cost
  is real: an install that predates this change cannot decrypt what it stored (provider credentials,
  plugin secrets, browser cookies) and has to sign in again. No migration is attempted; copying the
  other item would mean reading another install's key.

What is deliberately left alone, because either side of the pair is indistinguishable:

- **`~/.orca` agent-hook entries.** The matcher sweeps them when they cannot be an official install's:
  an unresolved `${HOME}` template or another host's home (remote registrations, Codex's frozen
  command form). Those remote forms are swept because a remote `.orca` path may be either install's
  and the command alone cannot tell them apart. A resolved `.orca` path in this user's home is swept
  only when `hasOfficialOrcaProfile()` finds no official profile directory — otherwise it is that
  install's. Grok's owner directories are read from both installs; only this build's is pruned, and
  only a live process in the other one holds the removal open.
- **A Muse pointer to a pre-rename hooks file.** `managed_hooks_path` naming
  `~/.orca/agent-hooks/muse-hooks.json` — on the local machine or an SSH host — is reported as "a
  pre-rename or official Orca registration" and left alone, because an official install writes the
  same pointer. Registration stays blocked until the user clears or repoints `managed_hooks_path`.
- **A `~/Library/Application Support/orca` profile holding nothing but `bundle-coordination`.** That
  tree is the only thing builds before the coordination-root move ever wrote there, so the probe treats
  such a profile as absent and the legacy sweep still runs; anything else in the directory is the
  official app's. Two residual risks, both recorded rather than guessed at:
  - An official install that only ever ran a supervised serve with a pinned `ORCA_USER_DATA_PATH`
    leaves exactly that same one-entry profile, so its local `~/.orca` hook entries would be swept.
    Reading the park tree's `supervisors/*.json` to tell the two apart is the fix if it is ever
    observed; the sweep only ever deletes entries that look like this build's own.
  - A `.DS_Store` (or any other second entry) in that directory makes an Orca-NP-only Mac read as an
    official install, so its `~/.orca` leftovers are not swept. That is the safe direction.
- **A pre-rename `serve` unit and a pre-rename WSL registration.** Both were written under upstream's
  names with upstream's marker, exactly like the official app's, so neither can be removed or adopted
  safely. The launchd _label_ is still recognised, which is what lets an upgrade park the supervisor
  an older build started; that supervisor keeps running until it is booted out by hand, because the
  new unit is deliberately a different label. A `~/.local/bin/orca-ide` launcher is left in place too:
  re-registering the WSL CLI creates `orca-np` beside it rather than replacing it.
- **A pre-rename park/ack tree.** `Application Support/orca-np` is a new coordination root; a
  supervisor started by an older build registered under `Application Support/orca` and will not be
  parked by this one. Parking fails towards "the old supervisor keeps running", never towards a
  half-installed bundle.
- **Existing Windows installs do not migrate.** The NSIS installer reads `InstallLocation` from
  `HKCU\Software\<appId GUID>`, and the appId is unchanged, so an install made before the package
  rename keeps updating in place under `%LOCALAPPDATA%\Programs\orca` — beside the official app's
  default directory, which is the collision this fix removes. Only a fresh install lands in
  `Programs\orca-np`. Uninstalling the old copy (or clearing its `InstallLocation` value) is a manual
  step, and the release notes for the first build carrying this say so.

#### The install layout resolves from one module (2026-11-09, fork issue #302)

Six paths still named an official Orca install, so each either found nothing or acted on the other
app: orcad's Electron browser host (`/Applications/Orca.app/Contents/MacOS/Orca`,
`Programs\Orca\Orca.exe`, `/opt/Orca/orca-ide`), the Windows updater's moved-install check
(`Uninstall Orca.exe`, `orca.exe`), the Command Code hook's endpoint recovery (`orca`, `orca-dev`), the
packaged macOS terminal daemon's launchd label (`com.stablyai.orca.terminal.*`), the `local(dev)`
rebuild helper, and the local-build update reader, which unzipped `Orca.app/Contents/Resources/…` out
of a zip this build had written as `Orca NP.app/…` and so never recognised its own artifact.
`src/main/fork/install-layout-names.ts` derives every one of them from constants this fork already
had, and each upstream file calls it rather than carrying a literal — which is also why the rationale
is here and not above their code (the rule at the top of this file).

| Name                               | Value                                               | Follows                               | Pinned by                                            |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| macOS bundle + its executable      | `Orca NP.app`, `Contents/MacOS/Orca NP`             | `productName`                         | `install-layout-names.test.ts`, np config test       |
| Windows executable + uninstaller   | `Orca NP.exe`, `Uninstall Orca NP.exe`              | `win.executableName`                  | same                                                 |
| Windows per-user install directory | `%LOCALAPPDATA%\Programs\orca-np`                   | `extraMetadata.name`                  | same                                                 |
| Linux payload directory + binary   | `/opt/Orca NP`, `orca-np`                           | `productName`, `linux.executableName` | same                                                 |
| terminal-daemon launchd label      | `com.nplez1.orca.terminal.<hash>.v<n>`              | the appId                             | `config/scripts/electron-builder-np-config.test.mjs` |
| Command Code endpoint recovery     | `orca-np`, `orca-np-dev`, `orca-dev`, `orca-dev-wt` | `app-directory-names.ts`              | `command-code-managed-script.test.ts`                |

Six things a reader will otherwise get wrong:

- **The Windows install directory is the package name, not the product name.** NSIS's `APP_FILENAME`
  is `appInfo.sanitizedName` for a one-click per-user install (`getWindowsInstallationDirName`), so it
  is `orca-np` even though the executable inside is `Orca NP.exe`. The two names differ on purpose and
  a future `oneClick`/`perMachine` change would move the directory to `Orca NP` — which is why the
  candidate list derives it rather than repeating it.
- **The browser host has no fallback to an official install.** orcad spawns the resolved binary with
  `--serve`, so a candidate naming the other app starts the other app's browser host — the defect
  itself. When this build is not installed the resolver answers `null`, which the caller already
  handles as "no Electron provider".
- **The launchd label moved, and the old one is retired rather than migrated.** The job already
  declares itself to launchd under `com.nplez1.orca` through `AssociatedBundleIdentifiers`, and the
  terminal-host helper's `CFBundleIdentifier` is asserted equal to the appId, so the label was the
  last place naming the other app. The label's profile hash is `sha256(resolve(userDataPath))`, and
  this build's `userData` is `appData/orca-np`, so a `com.stablyai.orca.terminal.<hash>` job can only
  be one of our own earlier builds — an official install's `userData` hashes differently. That job is
  released before bootstrap: waited out until the deadline that reserves time for bootstrap and
  startup if it is still running, booted out if it is stopped (which pays `stopMacDaemonJob`'s own
  10 s `bootout` plus 3 s poll, outside that budget, once — after that the job is gone), and left
  alone if it outlives the deadline, because booting out a live daemon would kill the user's
  terminals. This costs one extra `launchctl print` per launch, for a label that is almost always
  missing.
- **`orca-dev` and `orca-dev-wt` stay in the hook's recovery list.** They are still this fork's dev
  profile roots (`SHARED_DEV_PROFILE_DIR_NAME`, `WORKTREE_DEV_PROFILES_DIR_NAME` in
  `dev-instance-isolation.mjs`); only upstream's packaged `orca` root left the list, because adopting
  another install's endpoint when the two happen to share a loopback port would post our hook to the
  other app.
- **`docs/agents-md-refs/macos-daemon-tcc-attribution.md` still describes upstream's label.** It is
  upstream's design note, and its `AssociatedBundleIdentifiers` sentence was already wrong for this
  build before the label moved; the fork's record is this section, not an edited upstream doc.
- **A pre-rename Windows install is a candidate, keyed on the executable name.** An install made
  before the package rename keeps updating in place under `%LOCALAPPDATA%\Programs\orca` (see the
  upgrade note above), but it runs `Orca NP.exe` there, because `win.executableName` became the
  product name in `ddc2a7827fe` — before the package rename in `b883bff3c8f`. The official install's
  copy in that same folder is `Orca.exe`, so the name inside the folder is what separates them and the
  legacy directory is safe to resolve. Only a build older than both (executable `Orca.exe`) stays
  unreachable, and that one is indistinguishable from the official app by design.

### `local(test)`: the 2026-11-20 sync's deleted coverage — four test sets restored, one gap recorded

This sync of `0c6207e3d71` took upstream deletions of test files the fork had extended, and one
upstream test lost the fork's `it.each` block with the file it lived in. The release review of the
merge found each one and the delta round held them open until each was answered. Four are back by
re-pointing imports at the modules upstream moved, or by covering the same behaviour at the layer it
still lives in; the last one is recorded because the assertion itself went with the file.

- **The worktrees-local-create-base-prefetch suite (303 lines, fork-only, deleted),
  replaced by two smaller tests.** Its harness — `worktrees-test-harness.ts`,
  `worktrees-test-module-mocks.ts`, `worktrees-test-runtime-stub.ts` — no longer exists at HEAD, so
  the file itself cannot come back. What it pinned still ships, so the pinning moved to the layers
  that own it: `src/main/ipc/worktrees/create/register-worktree-prefetch-handler.test.ts` covers the
  handler's fork gating (unknown repo, a blocked WSL distro making a speculative prefetch a no-op,
  the swallowed failure Create reports) and the checkout preparation it hands back;
  `src/main/workspaces/creation/worktree-create-base-prefetch.test.ts` covers the prefetch itself
  (folder and `connectionId` repos short-circuit, register-during-fetch then materialize once, the
  pre-materialization gate settling offline, and the shared `origin` fetch fallback). What is _not_
  restored is the old file's end-to-end create flow through the deleted harness.
- **The web-preload-api-workspace-catalog suite (fork's `it.each`, 3 cases,
  dropped).** The fork's block was the only test of the web client's
  `repos.getDefaultCreateProjectParent` wiring (three platform cases). Upstream relocated the test file
  and the block did not come with it. The rule it exercised is covered by
  `src/renderer/src/components/sidebar/project-admission/create/checkout-parent-parity.test.ts`, so
  what is lost is the _wiring_ assertion: that the web preload calls the rule at all. That gap matters
  more than usual in this sync, because the runtime RPC of the same name had drifted onto a different
  rule and now delegates to `resolveDefaultCreateProjectParent` (see the review finding on
  `runtime-repository-registration-controller.defaultCreateParent`).

Restored in this pass, all import-path-only ports that pass at HEAD:

- `src/renderer/src/runtime/web-session-tabs-sync/agent-status/web-session-tabs-sync-remote-status-title-flap.test.ts`
  (restored, 6 cases) — the fork's `+179` lines pinned the parts of the paired-pane fence the fork owns:
  a host question that reports `waiting` through `ui_prompt_start` (Pi) or the Copilot screen lane
  pierces the fence, `resetHostDialogObservationsForTests` in setup, and a three-cycle flap count. Upstream
  deleted the file; restoring the fork's version needed four imports re-pointed (`shared/orca-profiles/constants`,
  `snapshots/snapshot-api`, `./agent-status-patch`, `tracking/tracking-{lifecycle,decisions}`) and no
  behavioural change.
- `window-close-request-coordinator.test.ts` (12 fork cases: close-guard veto and ordering, quit
  retraction, the checkpoint-in-progress flag, re-entrant dispatch, the Terminal-less close) moved to
  `src/renderer/src/app-shell/shutdown/`.
- `terminal-tab-actions-unified-close.test.ts` (5 cases: the `closeTerminalTab` unified-close contract,
  including the fork's #96 case that an emptied worktree stays selected) moved to
  `src/renderer/src/components/terminal/tab-lifecycle/terminal-tab-actions.test.ts`.

### `local(ci)`: a hung lint step is killed, named and bounded (#446)

**The gap, measured from two pushes.** Runs
[44057634767](https://github.com/nplez1/orca/actions/runs/44057634767) (`31a3268`, 2026-11-17) and
[43825293066](https://github.com/nplez1/orca/actions/runs/43825293066) (`5930d49`, 2026-11-16) each sat
in `Lint ratchet verdict` for ~48 minutes with **no conclusion on the step** — steps 1–11 green, the job
ending only at its own 50-minute bound, so the alert named the workflow and the commit and never the
step. Intermittent: neighbouring pushes were green in 4–17 minutes.

Three properties of the gate turned one hung child into that. `runStep` used
`spawnSync(..., { timeout })`, whose timeout kills the **direct child** — but a `pnpm run` step runs the
real linter one level down, and a grandchild that inherits the output pipe keeps it open, so the wait
outlives the kill. And the gate printed a step **only after it finished**, so the log could not name the
one that never did at all — a line printed before the spawn would only have helped where a pipe write is
queued rather than synchronous, and nothing printed one. `DEFAULT_TIMEOUT_MS` was 30 minutes, close
enough to the job's 50 that one step could take the whole job.

**What changed** — `local/gate-lint.mjs`, fork-owned, so no sync can revert it:

- **`runStep` spawns instead of blocking, and kills the tree.** `spawn` with `detached: true` makes the
  step a process-group leader; a timeout sends `SIGKILL` to `-child.pid` with a `child.kill('SIGKILL')`
  fallback, and `taskkill /T /F` plus the same fallback on Windows. It resolves (never rejects) with
  `{ id, command, exitCode, signal, output, tail, timedOut, seconds }`, so a hang is a result the verdict
  can name. A second deadline (`KILL_GRACE_MS`, 5 s) settles the step even if a grandchild left the group
  via `setsid` and would otherwise hold the pipe forever — the gate must not be able to wait on a stream
  at all. A step that _exits_ while a leftover child holds its pipe is drained for `DRAIN_GRACE_MS` (5 s)
  from its exit, then settled with **its own** exit code: a step that answered is not a hang, and two of
  them must not eat the workflow's step bound without a verdict. Output is kept per stream and joined
  stdout-then-stderr, as `spawnSync` gave it — a chunk boundary that falls mid-line must not splice a
  `::error::` line into something no parser here reads. `detached` removes the step from the gate's
  process group, so `SIGINT`/`SIGTERM`/`SIGHUP` are forwarded to the tree before the gate exits.
- **The step is named before it runs.** `runSteps` awaits a `running [i/N] <id> — <command>` line before
  each spawn (a promise-wrapped `stream.write`, so the line is in the pipe before the step can hang and a
  runner that kills the step still has it), keeps the completion line, and on a timeout prints
  `::error::lint step <id> timed out after <n>s (--timeout-ms <ms>) …` followed by the last 8 output
  lines, so both the CI log and the annotation name the step and quote what it printed.
- **The gate is bounded.** `DEFAULT_TIMEOUT_MS` 30 → 10 minutes, `--timeout-ms` still overrides. A
  timeout is already classified ahead of every allowlist lookup in `classifyRun` (it can only ever be a
  new red); `finalize` now also prints an explicit "a timeout is never a known red, re-run with
  `--only <id>`" line, and the gate exits 1 with its FAIL verdict.
- **The verdict is testable.** `runSteps` and `finalize` moved out of `main` so
  `tests/tools/lint-gate.test.mjs` drives the whole path against a fixture step that spawns a
  `SIGTERM`-ignoring grandchild holding the pipe: it asserts `timedOut`, the named step, the `::error::`
  line, exit 1, and that the **grandchild pid is gone** (`kill(pid, 0)` → `ESRCH`) rather than merely
  that a kill was called.
- **`fork-main-gates.yml` gains `timeout-minutes: 20` on `Lint ratchet verdict`.** The group kill is the
  fix; the step timeout is the backstop, sized at a runner's normal run plus the 10-minute per-step
  bound — one hung step fails the step, named, in 20 minutes instead of consuming the 50-minute job. For
  scale, the whole 54-step gate took **92 s** on the 18-core host this was written on. The job timeout
  stays the outer bound for the `pnpm tc` step above it.

**Anchors:** `runStep`/`runSteps`/`killTree`/`finalize` in `local/gate-lint.mjs`; the
`timeout-minutes: 20` line and its `(#446)` comment on the last step of
`.github/workflows/fork-main-gates.yml`. Neither is a file upstream owns, so a sync cannot reintroduce
the `spawnSync` timeout.

### `local(bots)`: look around on Pi, and the shell a look run needs

`LOOK_AROUND_AGENTS` is the whole gate, and it listed `claude` and `codex`. Adding `'pi'` flips every
reader at once — eleven call sites in nine files, so `lookAroundSupported` is the line a sync must not
move: the setting is honoured (`bot-look-around-state.ts:311`), a slot can come due and `Look now` is
allowed (`bot-look-around-runner.ts:118,163,202`), the CLI stops refusing (`bots-look-around.ts:75`),
both renderer sections and the Up-next rows grow (`BotLookAroundSection.tsx:89`,
`BotTidyUpSection.tsx:54`, `BotSettingsRoot.tsx:368`, `bot-upcoming-rows.ts:26`), and — because
`bot-memory-tidy-up-runner.ts:106` and `bot-memory-tidy-up.ts:162` read the same constant —
**overnight memory tidy-up arrives with it**. That coupling is the reason this patch is not only about
looking around: a reply-only run needs nothing more than `--no-tools --no-mcp`, so the easier half
rides along rather than shipping separately. The long form, with the design's own readers table and the
open questions, is `local/design/look-around-pi.md`.

The launch side was already done and tested; the gap was that nothing held a pi run to reads. A look
prompt's entire job is shell reads (`gh pr view|checks|diff`, `orca worktree ps`, `git log|show|diff`,
`bot-look-around-prompt.ts:25`), and `--tools read,grep,find,ls` offers no shell — so a pi look would
read files in its own home, learn nothing about the owner's work, and suggest nothing. Claude and Codex
each carry the guard per agent (an SDK `PreToolUse` hook; every approval answered from the allow-list
instead of a person). Pi's `tool_call` event can block, so pi gets the same two layers:

1. **The tool selection.** `bash` joins `PI_READ_TOOLS`, so a look run launches with
   `--tools read,grep,find,ls,bash --no-mcp`. `PI_TOOL_SELECTION_FLAGS` still refuses any other tool
   selection on a limited run, which is what keeps a user from widening it; that guard must grow with
   the read set, not stay behind it.
2. **The per-call gate.** A managed extension, written by the fork module below and passed as
   `--extension`, lets `read`/`grep`/`find`/`ls` through (layer 1 bounded those), answers a `bash` call
   from the read-only policy, and refuses **everything else** — an extension's own tool, a subagent —
   returning `{ block: true, reason: LOOK_AROUND_REFUSAL }`, pi's own contract and the same refusal
   text a blocked Claude run gives its owner. Denying by default is deliberate: `--tools` bounds Pi's
   own built-ins, but a look run still loads the user's extensions, and nothing in the tree says
   `--tools` also removes tools those register. It is the answer `lookAroundToolDecision` already gives
   Claude, and it is not installed for a reply-only session, where layer 1 means no tools at all.

Anchors, each a bare line or word in a file upstream owns — the reason is here, never in the file:

| File                                               | Line   | Change                                                                                                        |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `src/shared/bots/bot-look-around.ts`               | `:9`   | `'pi'` in `LOOK_AROUND_AGENTS`                                                                                |
| `src/main/pi/rpc/launch/rpc-launch.ts`             | `:72`  | `'bash'` in `PI_READ_TOOLS`                                                                                   |
| `src/main/pi/rpc/launch/rpc-launch.ts`             | `:133` | 3 lines: a `'read'` run with no gate throws, so dropping the write below cannot ship ungated bash             |
| `src/main/pi/rpc/launch/rpc-launch.ts`             | `:186` | one spread: `options.readOnlyGate` becomes `--extension`, beside the three extensions upstream already passes |
| `src/main/pi/rpc/launch/rpc-launch-resolution.ts`  | `:257` | the write itself, one property beside `botTools` (plus one import)                                            |
| `src/main/runtime/rpc/methods/bots-look-around.ts` | `:75`  | the refusal names no agent: `'This bot’s agent cannot look around.'`                                          |
| `src/main/bots/bot-look-around-runner.ts`          | `:264` | one import and one expression: `lookStartFailureWords(error, LOOK_FAILURES.couldNotStart)`                    |

Read top to bottom: a word, a word, one three-line guard, one spread of a shape the file already repeats,
one write that mirrors `botTools`, one string, and one import plus one expression. The read line itself
(`rpc-launch.ts:182`) is upstream's own again — the fork no longer adds anything to it. The guard is the
one piece of the feature that is structural rather than tested-in-place: every current path is gated
(`rpc-session-adapter.ts` only launches from the resolver, which awaits the write, and the catalog probe
never sets `tools`), but a sync that drops the resolution layer's property, or a future caller that builds
`'read'` args itself, now fails loudly instead of shipping pi look runs with unrestricted `bash`.

**Fork-owned, all the logic:**

- `src/main/pi/fork-read-only-gate.ts` — the extension source as a template string, its file name (the
  shape of `PI_BOT_TOOLS_EXTENSION_FILE`/`_SOURCE`), and `writePiReadOnlyGate(directory)`, which is
  `writePiExtensionFile` with those two arguments bound. Pi loads the extension **in its own process**,
  where Orca is not on the module path, so the template imports nothing and carries its own copy of the
  policy. Keeping the helper here is what makes the resolution layer's diff four lines — the file sits
  on the 300-line `max-lines` budget, whose ratchet only shrinks.
- `src/main/pi/fork-read-only-gate.test.ts` — drives the **generated** extension (evaluated with
  `new Function`, as Pi would load it) against `lookAroundCommandAllowed`, one allowed case and one
  refused-argument case for **every** `READ_COMMANDS` path, plus the shapes a bot actually writes
  (`"${ORCA_CLI_COMMAND:-orca}"`, bare and inside `bash -lc`, a repository, a github.com URL) and the
  commands that must never run (`gh pr merge`, `git push`, shell syntax, an unparsable command). A
  corpus alone cannot see upstream _tightening_ the policy — a path removed, or a refused argument
  added, after a security report leaves the template loose while every case still agrees — so the test
  also pins a sha256 of `bot-look-around-policy.ts` from `READ_COMMANDS` through
  `lookAroundCommandAllowed`, and fails with "upstream changed the look-around policy; re-mirror
  fork-read-only-gate.ts and update this hash". **`src/main/bots/bot-look-around-policy.ts` is therefore
  a file the next sync must watch**, and `fork-read-only-gate.ts`'s template is the only fork-side copy
  of it. It also covers `user_bash` (nobody types in a look run, but a command that arrives that way is
  held to the same policy), a tool neither layer bounded, and a bash call whose command it cannot read.
- `src/main/bots/bot-look-around-start-failure.ts` + its test — the recorded failure for a look that
  could not start, so the runner keeps one expression. `agentCliInstallationProblemOf` searches the
  error's cause chain while `errorMessage` reads only the outermost error, so formatting the found
  problem with `agentCliTooOldWords` is what actually surfaces a wrapped too-old refusal.

**Why the write is in the resolution layer, and not the launch builder.** The first version wrote the
extension from `buildPiRpcLaunch`, which is synchronous, so the write had to be `writeFileSync` — and two
upstream ratchets charged it: `check:main-sync-fs-ratchet` counts every `*Sync` fs call on the main
thread, and `check:main-blocking-helper-ratchet` charges **every caller** of a helper that makes one, so
one sync writer made `buildPiRpcLaunch`, the model-catalog probe and the session adapter blocking too.
Both are right: a look launch happens in the main process. So the write moved to the async layer that
already writes `botTools`, through `writePiReadOnlyGate` (the same `writePiExtensionFile`: staged temp
file plus rename), and `rpc-launch.ts` only spreads the option it is handed. That costs one property in
`rpc-launch-resolution.ts`, measured at 11 upstream commits in 180 days against 6 for `rpc-launch.ts` —
the hot file this patch originally avoided. The trade is deliberate: a sync write there would be a
permanent ratchet exemption with reviewer sign-off on every sync, and the property is shaped exactly like
the three next to it.

**The honest limit, written down rather than implied.** For pi, `permissionMode: 'ask'` — which the
shared composition sets for every read-only session
(`structured-agent-launch-composition.ts:231`) — carries no weight: pi's structured chat is full access
only (`rpc-launch.ts:113` throws otherwise), and `fullAccess` is resolved independently of `readOnly`
(`rpc-launch-resolution.ts:231`). So unlike Claude, whose hook is backed by the CLI's own permission
engine, pi's guarantee is two Orca-side guards inside the agent process, and the extension runs with the
agent's full OS permissions. Same class of guarantee in practice; not the same mechanism, and not one
to describe as a sandbox. One further limit, owned by the user's own code: pi runs `tool_call` handlers
in load order and does not re-validate, so a later extension can rewrite `input.command` after this gate
allowed it. `Object.freeze(event.input)` would close that and break every bash call for a user whose own
extension mutates bash, so the limit stays. The gate is the last extension in the argument list, after
`backgroundWork` and `botTools`, so Orca's own extensions run before it and cannot rewrite a command the
gate has already seen; the residual risk is the user's own extensions, which load after the launch's.

**The too-old trap this patch opens.** `piToolLimit` throws `AgentCliInstallationError.tooOld('pi', …)`
below 1.0.4 (`rpc-launch.ts:102`), which could not fire while pi never looked around. Now an older
install fails _every_ look, each failure is recorded against the run, and ten in a row turn Look around
off (`LOOK_FAILURES_TO_TURN_OFF`) — with the runner having dropped the cause, the record says "The last
look couldn't start." on every one and nothing tells the owner that pi needed updating. The runner
therefore records the cause beside that line when the error is an installation problem, so the run's
record reads _Your Pi CLI on this computer is 1.0.3. Chats need 1.0.4 or newer._ Making the setting's
offer depend on the host's agent capabilities is the real fix and belongs upstream; one expression is
the cheap fork version.

**The same trap, still open for tidy-up.** `piToolLimit` refuses `'reply-only'` below the same version,
so every tidy-up on such a host fails with `TIDY_UP_FAILURES.couldNotStart` and no cause — the half
this patch turned on is also the half that inherits the trap. Left alone here because it is a second
runner and a second upstream anchor; the same one-line treatment is the follow-up.

**Deliberately not done here.** A read scoped to the bot's home folder would be strictly better than
Claude's anywhere-read, but the first patch matches Claude rather than exceeding it. And
`LOOK_AROUND_AGENTS` stays a list: turning it into a capability would need an edit at each of the
eleven call sites, which is exactly the divergence this patch avoids. Both are in the design note's open
questions.

Tests: `src/main/pi/fork-read-only-gate.test.ts` (the generated extension against every read path the
policy declares, one case per `REFUSED_ARGUMENTS` alternative on an allowed path, the pinned policy
text, and the tools the launch already bounded), `src/main/bots/bot-look-around-start-failure.test.ts`
(a wrapped too-old refusal keeps its cause, a plain failure does not), and the existing bot look-around
suites. The launch wiring — `bash` in the read set, `readOnlyGate` becoming `--extension`, and the
throw for a `'read'` run with no gate — was asserted by the rpc-launch suite, which upstream's
2026-11-24 test-inventory pass retired; `src/main/pi/rpc/launch/rpc-launch.ts` and
`rpc-launch-resolution.ts` carry the rule with no test at HEAD, so re-homing those three cases is owed.

### `local(bots)`: talking to a bot without Orca Cloud, and the identity its writes carry

Step 0 and Step 3 of `local/design/talking-to-bots.md`: a person can ask a bot on this computer something
from their own shell, the bot is told who asked, and every GitHub body a bot writes carries an invisible
marker that its own event rules read as "not mine". Step 1 (the loopback `POST /ask` listener) is still
not built; Step 2 (the Photon iMessage channel) shipped in #454/#457, and its settings card in the release
gaps pass, so the design note's status line is the place to look, not this one. Authority does not
move: a local ask runs as the owner, on the owner's credentials, exactly as a cloud turn does. What this
patch adds is attribution — who is addressed, and which writes were the bot's.

**The asker, and why it is not a flag.** `orca bot ask` is a thin CLI over `orchestration.send` — the same
mail path `orca orchestration send --to bot:<name>` already uses — so it inherits every refusal, hold and
dedupe instead of growing a parallel one. The asker is _not_ taken from the payload: a surface that can
name a person is not the same thing as a person who may claim any identity. The host decides, from two
things it alone knows: the send has no caller session behind it, and the transport did not prove the caller
to be a paired device or a phone. Both hold only for a send from this computer's own shell, and only that
send mints the owner as a `BotRequestPerson` (`source: 'local'`, `role: 'owner'`). Every other send keeps
`OWNER_ACTS_FOR`'s bare owner, which is all a cloud turn or another computer's mail can claim — a paired
Orca's mail arrives with no session of its own either, so the session test alone stamped another machine's
agent as this computer's owner, which is what the scope test fixes. The CLI's own half of the same rule:
`orca bot ask` sends a `from` only when the shell carries Orca's own `ORCA_TERMINAL_HANDLE`, and validates
it so a stale one is re-minted. It never infers a terminal from the working folder — that would let an ask
typed in any shell speak as a sibling pane, take its mail, and have the answer typed into its agent.

**A withdrawn deliverable, recorded so the next reader does not re-add it.** An earlier commit in this
patch carried a `fork-local-results.ts` that routed a run's result into the asking chat. It was
misconceived and is deleted: a local ask is _mail_, which `bot-request-send.ts` delivers, while
`deliverBotRunResult` only ever sees _automation_ runs — so the code never ran for a local ask, and for
an automation run whose conversation held a local person it overrode the configured Slack/Linear/thread
destination and posted to the Home Chat rather than the chat the ask came from. **The cloud-off reply hole
(`bot-run-results.ts`: "Orca Cloud isn't connected, so the result wasn't posted") therefore stays open.**
A fallback belongs there only where upstream returns `COPY.cloudOff`/`COPY.signedOut`, and would deliver
to `result.sessionId` through `sendToSession`, not `sendToChat`.

**Anchors, each the smallest diff that works in a file upstream owns — the reason is here, never in the
file:**

| File                                                                              | Line   | Change                                                                                                                |
| --------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `src/shared/bots/bot-acts-for.ts`                                                 | `:9`   | `BotRequestPersonSource` and `BOT_REQUEST_SOURCE_NAMES`: `'local'` widens the asker's source, nothing else            |
| `src/shared/bots/bot-acts-for.ts`                                                 | `:19`  | `source: BotRequestPersonSource` on `BotRequestPerson`                                                                |
| `src/shared/bots/bot-acts-for.ts`                                                 | `:33`  | one function, `ownerAsPerson`, additive beside `OWNER_ACTS_FOR`                                                       |
| `src/main/bots/bot-request-view.ts`                                               | `:1`   | one import, `BOT_REQUEST_SOURCE_NAMES` beside `BOT_QUIET_MARKER`                                                      |
| `src/main/bots/bot-request-view.ts`                                               | `:45`  | `askedFromShell`, additive: a local person's ask is the owner at a shell, not the owner's agent                       |
| `src/main/bots/bot-request-view.ts`                                               | `:80`  | the asker label reads `BOT_REQUEST_SOURCE_NAMES`, so a local asker reads as this computer                             |
| `src/main/bots/bot-request-view.ts`                                               | `:92`  | the sender name says the shell, and `:182` says the answer comes back to the terminal it was asked from               |
| `src/main/runtime/rpc/methods/orchestration/messaging/bot-recipient.ts`           | `:10`  | one import                                                                                                            |
| `src/main/runtime/rpc/methods/orchestration/messaging/bot-recipient.ts`           | `:211` | `context` replaces `callerSessionId`, so the caller's own scope travels with the session                              |
| `src/main/runtime/rpc/methods/orchestration/messaging/bot-recipient.ts`           | `:252` | one line, below the dispatch branch: `botMailCallerOf` names the session and the turn a send with no session acts for |
| `src/main/runtime/rpc/methods/orchestration/messaging/bot-request-send.ts`        | `:43`  | one import                                                                                                            |
| `src/main/runtime/rpc/methods/orchestration/messaging/bot-request-send.ts`        | `:61`  | the context is `BotMailContext`: the same fields, in one line, with the caller scope the decision reads               |
| `src/main/runtime/rpc/methods/orchestration/messaging/bot-request-send.ts`        | `:94`  | one call: the context where the caller's session id used to be                                                        |
| `src/main/runtime/rpc/methods/orchestration/federation/peer-mail-bot-delivery.ts` | `:63`  | `callerScope: { kind: 'runtime-paired', grants: [] }`: a paired Orca delivered it, not this shell                     |
| `src/main/bots/bot-launch-tools.ts`                                               | `:8`   | one import                                                                                                            |
| `src/main/bots/bot-launch-tools.ts`                                               | `:33`  | `name` on the bot a launch describes                                                                                  |
| `src/main/bots/bot-launch-tools.ts`                                               | `:42`  | one expression: the shim folder, in the CLI's own env, only for a launch that can name its bot                        |
| `src/main/bots/bot-launch-tools.ts`                                               | `:61`  | one spread: Codex's commands get the token, both agents' env get the shim folder                                      |
| `src/main/bots/bot-launch-tools.ts`                                               | `:75`  | `withBotLaunchToolsEnv` merges through `withBotGhShimOnPath` instead of the raw env                                   |
| `src/main/bots/bot-tools-file.ts`                                                 | `:284` | `'name'` joins the `Pick`, and the bot's name reaches `BotLaunchTools.for`                                            |
| `src/main/bots/bot-tools-file.ts`                                                 | `:301` | one property: the name, so the shim carries the bot's name rather than its id                                         |
| `src/main/connector-cloud/own-pr-trigger-guard.ts`                                | `:11`  | one import                                                                                                            |
| `src/main/connector-cloud/own-pr-trigger-guard.ts`                                | `:14`  | `'text'` joins `OwnPrRun`'s `Pick`, so the body is readable                                                           |
| `src/main/connector-cloud/own-pr-trigger-guard.ts`                                | `:81`  | one condition: a marked body is the bot's work, beside the head-branch check                                          |
| `src/cli/specs/bot.ts`                                                            | `:45`  | the `bot ask` spec                                                                                                    |
| `src/cli/bots/bot-handler-groups.ts`                                              | `:10`  | the handler group, so the command has a handler behind it                                                             |
| `skill-guides/orca-cli/references/bots.md`                                        | table  | one row, so the guide names the command                                                                               |

**No `bot-preamble.ts` line.** An earlier commit taught `orca bot ask` in the bot's own Tools and Rules;
that is dropped. `bot-command-drift.test.ts` checks that commands the preamble and guides _teach_ parse
against the CLI — it never forces the reverse, so nothing asked for that line, and it told a bot to run a
command a person runs. The guide row stays because it documents the command where the guide already
documents every other one.

**The marker, appended by code the bot cannot skip.** `fork-gh-shim.ts` writes a bash `gh` into
`~/.orca/bots/.gh-shims/<botId>/gh`, and a bot launch puts that folder first on `PATH` through
`BotLaunchTools`, so no preamble line the model has to remember is involved. The shim marks the body of
every verb that posts one — `pr comment`, `issue comment`, `pr review`, `pr create`, `pr edit`,
`issue create`, `issue edit`, and `new`, which gh aliases to `create` — in a single rewrite: it finds the
verb past a persistent `-R`/`--repo`, takes the **last** body flag including the attached short forms gh
accepts (`-bText`, `-b=Text`, `-FFile`, `--body-file=`), reads a file or `-` for stdin, drops every body
argument and hands gh one `--body "<text>\n\n<!-- orca-bot:<name> -->"`. Everything else `exec`s
byte-identical, exit code included — and the shapes whose body it cannot mark are refused with exit 2
rather than posted unmarked (see the limits below).
A body travels as an argument (GitHub caps one at 65,536 characters, far under `ARG_MAX`), so there is no
temp file to leak on a signal. An empty body stays empty: a marker on its own would turn a refused comment
into a blank one. It finds the real `gh` by PATH order and compares inodes (`-ef`), because `pwd -P` on
macOS turns `/tmp` into `/private/tmp` and the first version resolved itself and recursed forever. The
marker takes `>` and a doubled hyphen out of the bot's name — one would break the read-back, the other ends
the HTML comment and renders the rest visibly.

**Coverage, measured rather than assumed.** Every structured agent in a bot home gets the shim, because
`botSessionToolServers` → `BotLaunchTools.for` → `withBotLaunchToolsEnv` is the one env path they all take:
Claude (`claude-structured-launch-resolution.ts:257`), Codex (`codex-structured-launch-resolution.ts:228`),
Pi (`rpc-launch-resolution.ts:264`) and ACP agents (`acp-structured-launch-resolution.ts:295`). **Bot workers
do not**: `botSessionToolServers` returns `BotLaunchTools.none` for a session outside the bot's home
(`bot-tools-file.ts:289`), so a worker's `gh` is unmarked even though workers open most bot pull requests —
for those, the head-branch check is what identifies the work, and only while the worker is live. Windows
bots get no shim at all: `installBotGhShim` returns null there.

**Probe launches install nothing.** `cliWithLaunchTools` (`bot-tools-host.ts`, `bot-tools-sign-in.ts`) hands
`BotLaunchTools.for` no name, and the shim is installed only when there is one. An earlier version fell back
to the bot's id, which rewrote the file the live session runs with a marker naming the id instead of the bot.

**Deliberately not done here.**

- **The `Co-authored-by:` trailer.** It needs the same shim family for `git`, an email per bot, and a
  decision about repos that require signed commits; more than a shim and its test, so deferred.
- **`BotChatOrigin`.** A local ask wants a seventh origin, but that union is upstream's and reaches icons,
  labels and the phone; a local conversation's chat shows as `side` until it is worth the divergence.
- **A separate `'local'` member of `CONNECTOR_SOURCES`.** The first version added one; it widened every
  `z.enum` built on that list (`connector-message-asker.ts`, `bot-link-open-target.ts`, `bot-deep-link.ts`),
  so a cloud payload or a deep link could claim `local`. The widened _asker_ source does the job and keeps
  the connector union what it was.

**The honest limits.**

- **Comment verbs the shim does not cover.** `issue close`, `pr close` and `reopen --comment` post a body
  too, and are not marked; the shim marks the verbs a bot writes with, not every verb gh has.
- **Calls that bypass the shim entirely.** `gh api -f body=…` writes a body through the API, `env -i` and an
  absolute path to another `gh` skip PATH, and a bot's own `gh alias set` can point anywhere. None is
  detected; the fallback the design note names — recording the ids of the comments the fork created — is
  not built.
- **It fails closed where it cannot mark.** `--fill`/`--fill-first`/`--fill-verbose`, a `-T`/`--template`
  with no body, and a combined short flag that could hide `-b`/`-F` (`-db`, `-dF`) exit 2 with a message
  telling the bot to pass `--body`. A bot sees that as a refused command; it is deliberate, because the
  alternative is a body posted unmarked. `--body` with `--body-file` is passed through to gh, which
  refuses the pair itself.
- **Inlining `--body-file` moves relative image resolution.** gh 2.103 resolves a relative `--attach` path
  against the body file's directory; the shim hands gh the body as an argument, so it resolves against the
  working directory instead. Absolute paths are unaffected.
- **PATH is not ours to keep.** The shim only stays first if the shell does not put another `gh` ahead of
  it: with `~/.local/bin` absent from the inherited PATH, `~/.zshenv` prepends it, and any profile that
  prepends gh's own directory does the same. Nothing detects it, and the marker would then be missing with
  no signal. The fallback the design note names — recording the ids of the comments the fork created — is
  not built.
- **`.gh-shims/<botId>` is never removed** when a bot is deleted.
- **`askedInOwnersChat` still reads `asker.kind === 'owner'`**, so a local owner's request is labelled as a
  person's on the _sender's_ view lines. The receiving bot reads the owner's name, which is the point.
- **The cloud-off reply hole stays open** (see the withdrawn deliverable above).

**Two files sit exactly at the 300-line budget.** `bot-recipient.ts` (300) and `bot-request-send.ts`
(299) are upstream files that were at 298/299 before this patch: the fork's diff on each was paid for by
shaping it as a parameter swap and one call rather than new statements. A sync that grows either file has
to shrink the fork's share first, or the `max-lines` rule fails on a file the fork did not touch.

**The next sync's obligation.** `bot_conversation_acts_for` rows this patch wrote hold
`{"kind":"person","source":"local"}`, and bot request records hold the same. Those rows are persisted: a
sync must not narrow `BotRequestPersonSource` back to `ConnectorSource`, and must keep
`BOT_REQUEST_SOURCE_NAMES` covering `'local'`, or an existing conversation's asker stops reading and its
turns fall to `unknown`. The ratchet files to watch are `bot-acts-for.ts` (the widened source),
`bot-recipient.ts` (`readActingSender`'s `context` parameter and `botMailCallerOf`), and
`bot-launch-tools.ts` (the env merge).

Tests: `src/shared/bots/bot-acts-for.test.ts` (the owner as a person is still the owner),
`src/main/bots/fork-local-owner.test.ts` (the turn names the owner, and only a send with no session, the
owner's scope and no peer delivery counts as this shell), `src/main/bots/fork-gh-shim.test.ts` (the
**generated** shim driven against a fake `gh`: every marked verb, the attached and `--body-file=` forms,
`-F -`, a repeated `-b`, `pr -R … comment`, an empty body left alone, four byte-identical passthroughs
including a failing one's exit code, the name sanitiser, and the install gate),
`src/cli/bots/fork-bot-ask.test.ts` (unknown and ambiguous bots, a chat that takes no mail, the id address,
the `from` it sends and prints, the subject), `src/main/connector-cloud/own-pr-trigger-guard.test.ts` (the
marker as own work, without asking the branch), and
`src/main/runtime/rpc/methods/orchestration/federation/paired-server-asks.test.ts` (the paired Orca's
direction: an ask from a person in that window rather than `asAgent`, and the sender named by this
computer's name for the server) — the bot-recipient suite that held both directions of the local asker
went in upstream's 2026-11-24 test-inventory pass, leaving this shell's own send pinned by
`src/cli/bots/fork-bot-ask.test.ts` above.

### `local(webhooks)`: GitHub events on a bot with no Orca account

The design, its trade-offs and the deferred list are `local/design/local-webhooks.md`; this records what
shipped, where the anchors are, and what the note could not promise. A bot whose host is signed out of
Orca Cloud is told, accurately, that events do not reach it — yet a GitHub webhook is a payload the
computer can receive itself, `gh` already holds the credential, and the bot already reads the same data
with `gh pr view`. So this adds a **second delivery route for the same event source**: a loopback listener
on this computer, kept in the cloud ledger's shape, feeding the existing `webhook.call` path. Which host
answers a hook is decided **per save**, not by a host-wide switch: a new hook goes to this computer when
the host has no Orca Cloud or is signed out of it, an edit keeps whichever host already holds it, and the
renderer card that would let a signed-in owner choose is deferred. The listener itself is not opt-in: it
runs and publishes wherever Orca NP runs.

**Why `webhook.call` and not a `github.local` source.** Every `github.*` kind carries cloud semantics —
`from=me`, once-per-commit `ci_failed`, the `[conclusion=failure]` token — and every one of those lives in
`AUTOMATION_EVENT_KINDS` and `automation-github-triggers.ts`, files upstream edits routinely. `webhook.call`
is already "an arbitrary third-party payload, treated as data": the filters, the adapters, the fence
prompt, the `.untrusted.json` writer, the per-call ledger, run caps and Items are all code this patch does
not write and does not maintain. GitHub's `action`/`pull_request.*` fields become `where=` clauses.

**The seam.** `AutomationWebhookSaves` holds five methods of the host (`automation-webhook-saves.ts:13-60`),
a delivery enters through `WebhookHostService.receive`, and at run time the cloud is asked exactly two
things (`envelope`, `start`, `webhook-call-runs.ts:175,264`). A hook answered locally therefore needs no
change to the run path at all.

**The anchors.** Sixteen sites across twelve files upstream owns, plus one ratchet baseline; each is a
line or two, and the reason each exists is this file. `connector-host-install.ts` is three hunks, not one
— the review of R1 was right about that. `src/shared/rpc-contract/webhooks-params.ts` is the one under
`src/shared/`, so any sync that moves it is a global input and needs the full unit gate.

| File                                                                         | Anchor                                             | Change                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/main/connector-cloud/connector-host-install.ts`                         | the `WebhookHostService` import                    | the import becomes the two fork-owned classes                                                                |
| `src/main/connector-cloud/connector-host-install.ts`                         | `const webhooks = new WebhookHostService({`        | `LocalWebhooks` built beside it, and `LocalWebhookHostService` built with `local:`                           |
| `src/main/connector-cloud/connector-host-install.ts`                         | `const stops` / `if (runtime.getConnectorCloud())` | `setWebhooks`, both stops and the cloud host's `start()` hoist out of the guard; Composio stays in it        |
| `src/main/connector-cloud/connector-host-install.ts`                         | the cloud host's deps                              | `ownsExtraCallFiles: () => localWebhooks.callFiles()`, so its sweep leaves this computer's call files alone  |
| `src/main/webhooks/webhook-host-service.ts`                                  | `WebhookHostServiceDeps`                           | one optional field, `ownsExtraCallFiles`, passed to the ledger on the constructor line it already had        |
| `src/main/webhooks/webhook-host-service.ts`                                  | `advertised()`'s neighbours                        | `answersNewWebhooks()` and `heldLocally()`, both `false`/`[]` here and overridden by the fork's host         |
| `src/main/webhooks/webhook-host-ledger.ts`                                   | the constructor / `files()`                        | an optional `alsoOwned` third parameter that `files()` unions into what the sweep treats as owned            |
| `src/main/webhooks/automation-webhook-saves.ts`                              | `hearing()`'s neighbours                           | `AutomationWebhooksHost` (a host may answer rules itself) and `cloudRules()`, the rules Orca Cloud must hear |
| `src/main/runtime/integrations/automations/runtime-automation-bot-update.ts` | the `assertBotHearsEventTriggers` call             | one expression: `cloudRules(updates.on)` instead of `updates.on`                                             |
| `src/main/runtime/integrations/automations/runtime-automation-target.ts`     | the same call, and `BotAutomationLookups`          | the same expression, and its `webhooks` type gains `cloudRules` as a required member                         |
| `src/main/runtime/rpc/methods/bots.ts`                                       | `bots.list`'s result                               | `localWebhooks` and `localWebhookHooks`, so a client can ask which host answers a rule                       |
| `src/main/connector-cloud/connector-triggers.ts`                             | `connectorTriggers`                                | a third parameter, `servesLocally`, so a hello never lists a rule this computer answers                      |
| `src/main/connector-cloud/connector-cloud-install.ts`                        | both `connectorTriggers` calls                     | pass `webhooks.servesLocally`, and widen the local `webhooks` type by the optional method                    |
| `src/shared/rpc-contract/webhooks-params.ts`                                 | `WebhookSummary`                                   | one optional field, `urlChangesOnRestart`, so `orca webhooks show` can say a fallback port will move         |
| `src/cli/webhooks/webhooks.ts`                                               | `hookJson` and `formatSummary`                     | a loopback URL is printed (it carries the token that is its whole auth), a cloud URL still is not            |
| `src/cli/specs/webhooks.ts`                                                  | `WEBHOOK_NOTES`                                    | the note names where a hook on this computer is discovered                                                   |

Two of those files were **tests** upstream owns, edited rather than added to — the
automation-event-triggers CLI suite (the signed-out CLI cases) and the runtime's bots suite
(`bots.list`'s new fields). Both went in upstream's 2026-11-24 test-inventory pass; what survives is the
CLI spec layer at `src/cli/automations/automation-event-trigger-spec.test.ts` (the signed-out note, and
which host it names) and the rule layer at
`src/main/webhooks/local/local-webhook-provider.test.ts` (a Slack rule refused while signed out, this
computer's own webhook rule heard, and the hooks it answers marked). And
one is a ratchet baseline, `config/main-blocking-helper-baseline.txt`, which is a **global input**: two rows
for `writeSecureFileAsync`, one per fork-owned module that writes. The store's row is per delivery (the body,
then the index) and on win32 that helper writes, chmods and fsyncs synchronously, so a delivery there is two
blocking durable writes; the listener's row is once per start, publishing the endpoint file.

`installConnectorHost` is the whole wiring path, which is the point: the desktop main process
(`main-process-connector-startup.ts:32`) and `orcad` / `orca serve` (`orcad-connector.ts:14`) both call it,
so the listener exists in both hosts with no second path. **A sync that moves that guard must keep
`setWebhooks` and the cloud host's `start()` outside it**, or local hooks stop being savable; and it must
keep `ownsExtraCallFiles` wired, or Orca Cloud's sweep deletes this computer's call files an hour after
they are written, taking the file a running prompt points at with it.

**Fork-owned, all the logic** (`src/main/webhooks/local/`, seven modules, ~1,300 lines with tests):

- `local-webhook-store.ts` — hooks, one row per call and the mint intents in
  `<userDataPath>/local-webhooks/local-webhooks.json`, owner-only through `writeSecureFileAsync` with
  `durable`, deliberately **not** the cloud ledger's file: that file's `state`/`change` schema is the
  cloud's. Each call's **body is its own file** (`local-webhooks/calls/<callId>.json`), written before the
  index row and removed with it, so a delivery touches one small file rather than rewriting a week of
  bodies. Every change runs through **one promise queue**, each over the state the previous one left: two
  overlapping writes would otherwise clone the same index and the last to finish would silently drop the
  other's row — a call whose `200` was already sent, or a hook a change event had just dropped coming back
  to life. A mint intent (`LOCAL_MINT_GRACE_MS`, ten minutes, as the cloud's `STALE_INTENT_MS`) keeps a
  hook alive between its mint and its automation's save.
- `local-webhook-listener.ts` — binds `127.0.0.1` on the port this profile names (`localWebhookPort`, a
  hash of the userDataPath into 43000–47999, so a forwarder's URL survives a restart; a port already taken
  falls back to an ephemeral one and publishes `ORCA_LOCAL_WEBHOOK_STABLE=0`), publishes
  `local-webhooks/endpoint.env` in the agent-hook listener's shape (owner-only, removed on stop, a failed
  write logged rather than fatal), and serves `POST /hook/<hookId>/<token>`: method checked, hook must
  exist, token compared as SHA-256 digests through `timingSafeEqual`, capped at 2 MiB read as bytes, `429`
  past `WEBHOOK_RUN_CAPS.hookDefault` (200) in the rolling hour **checked again as the call is kept**, so
  senders that pass the first check while their bodies arrive cannot pass the cap together. `{ok:true,callId}`
  only after the call is durable. `GET /state` answers the endpoint file's bearer with every hook's URL.
- `local-webhook-envelope.ts` — what the sender posted, as the cloud would have kept it: body by content
  type, headers minus our own token and any credential the sender added.
- `local-webhook-delivery.ts` — the `TriggerDelivery` and `AutomationRunEvent` a local call becomes, and the
  filter comparison an edit uses.
- `local-webhook-provider.ts` — `LocalWebhooks`: store, ledger, replay, mint, settle, `servesLocally`,
  `holdsLocally`, `callFiles`.
- `local-webhook-routes.ts` — the `WebhookCloudCalls` a host asks, routed per hook id, so one host holds
  local and cloud hooks at once. A local hook's `url` is the complete URL its token makes usable; a cloud
  hook's `remove` keeps a null answer null so it is retried instead of read as done; `sample`, `rotate` and
  `setSecret` stay the cloud's routes.
- `local-webhook-host.ts` — `LocalWebhookHostService`: `advertised`, `servesLocally`, `holdsLocally`,
  `settle`, and a local hook's `card`/`reveal` answered here so the hook's id never reaches the cloud ledger
  (a row there would have reconcile send the real Orca Cloud a `DELETE` for an id it never made).

**A cloud that makes hooks answers for them.** `advertised()` is the cloud's answer whenever a cloud can
make a hook, even one that does not take them: the save is then refused with "Orca Cloud doesn't support
webhooks yet" instead of failing inside the mint, `bots.list` does not offer `webhook.call` to a bot that
cannot have it, and `helloAnswered` does not retry a pause against a cloud that takes no webhooks. Only a
host with no cloud to make one falls back to this computer — and it says yes before its listener has
bound, because `settle` routes here on the same question, so the offer and the save cannot disagree.

**The CLI asks the same question the host does.** In every packaged build Orca Cloud is configured and
reports `signed-out` with no account, so the never-signed-in user is the target of this route — and
`botEventTriggerRefusal` counts every `webhook` rule as the cloud's. `bots.list` therefore reports
`localWebhooks` (a rule made now would be answered here) and `localWebhookHooks` (the ids already held),
and `src/cli/bots/bot.ts` answers `servesWebhookHere`/`cloudRules` from them: a webhook rule is created on
a signed-out host, a Slack rule is still refused, and the listing's "won't fire while signed out" note
covers only the rules Orca Cloud delivers.

**Sign-out is per rule, not per host** — the one real defect the R1 review found. `signedOut()` was
overridden to `false` while the listener was up, which made `AutomationWebhookSaves.hearing()` tell
`bot-event-sources.ts` that the whole host was signed in; a signed-out desktop then **accepted**
`slack.message`, `github.*` and `linear.*` rules it could never fire. The override is gone. `hearing()`
keeps the host's real answer, and `cloudRules()` removes the rules this computer answers before
`botEventTriggerRefusal` sees them, so: a Slack rule on a signed-out host is refused with the sign-in line,
a local webhook rule is saved, and a **cloud** webhook rule is still refused. `wontFireNote`'s listing note
stays host-wide because the CLI cannot see which hooks are local; it over-warns for a local rule, which is
the safe direction, and the card is where a per-rule note belongs.

**Local rules never reach Orca Cloud.** A hello lists the rules the cloud delivers, so
`connectorTriggers` filters out every hook this computer holds — hook id, automation id and `where=`
filters that could name a private repository stay here. The same instinct stops `card()` from writing a
local row into the cloud ledger.

**The replay pass is the requirement, not a nicety.** `WebhookCallRuns.resume()` already offers every
unsettled call again after a restart, and `start()` resumes _before_ it binds, so a port that will not
listen cannot hide a call written before its ack. Two ledgers are live at once
(`webhook-host.json` for the cloud, `local-webhooks/webhook-host.json` for this computer) because a local
call's id must never appear in the cloud's file; the local one's account is the constant
`LOCAL_LEDGER_ACCOUNT`, not the signed-in account, since a local hook exists while signed out.

**Never claim more than the code does.** This is authenticated **to** the listener, not delivery from
GitHub: a path token plus loopback binding, which is the model the cloud hook already uses (the URL is the
secret). Anything running as you can read the endpoint file and the store. It is a **latency optimisation,
not a queue**: `gh webhook forward` never replays, so a delivery while nothing serves the profile is lost.
The safety net is look-around, which runs on `claude`, `codex` and `pi`, so a bot on any other agent
(Hermes included) needs the scheduled-automation fallback — `--trigger hourly` with a `--precheck '<gh …>'`
— before this route is safe for it. A brand-new hook is made by this computer only while Orca Cloud cannot
make one; a signed-in owner picking "this computer" is the deferred card's job.

**Deliberately not done:** the renderer webhook card (needs Electron UI validation and its own STYLEGUIDE
pass), the `orcad` receive-before-start window (nobody runs `orcad` here), signature verification and the
app-inbound half of the note's "an app on the account" section (both need a public hop, which is the thing
this route exists to avoid), Slack or Linear local delivery, and a per-rule "won't fire" note in listings.
`gh webhook forward` against a real repository was **not** exercised: it needs the owner's GitHub account,
and nothing here created or registered a webhook.

Tests: `local-webhook-store.test.ts` (round-trip, 0600/0700, one body file per call, bodies dropped with
their rows, mint intents, prune writing nothing when it has nothing to drop),
`local-webhook-listener.test.ts` (the profile's port and the ephemeral fallback with
`ORCA_LOCAL_WEBHOOK_STABLE=0`, the endpoint file, a delivery kept before the answer, its own token and
`authorization` absent, unknown hook, wrong token, path with a suffix, non-POST, oversize body, the 201st
call, `over_cap` and `failed` verdicts, `/state` refusing every token but the endpoint file's, the file
removed on stop), `local-webhook-provider.test.ts` (mint with no operation id and an edit keeping the id, a
real-HTTP delivery producing one call, one `.untrusted.json` and one run, recovery exactly once after a
restart and not again after a second, a hook whose rule nothing lists going silent, a freshly minted hook
surviving a save that has not landed and going once its grace expires, the cap held against four senders
arriving together, a signed-out host refusing a Slack rule while hearing its own webhook rule, `advertised`
true while signed out, no local row in the cloud ledger, and a host holding both kinds at once with a local
call started here), `local-webhook-sweep.test.ts` (a live local call file surviving Orca Cloud's sweep, and
the same sweep deleting it when it is not told), `connector-host-install-local-webhooks.test.ts` (a host
with no connector cloud still installing webhooks, publishing its endpoint and taking a delivery), and
`connector-triggers.test.ts` (a hello never listing a rule this computer serves),
`src/main/webhooks/local/local-webhook-provider.test.ts` (the rules this computer answers marked as
such, so a signed-out card never calls one paused), and
`src/cli/automations/automation-event-trigger-spec.test.ts` (the listing note covering only the cloud's
rules, and which host is named as not signed in). The two suites this bullet used to name — the runtime
bots suite and the automation-event-triggers CLI suite — went in upstream's 2026-11-24 test-inventory
pass, so creating a webhook rule on a signed-out host and refusing a Slack one there are covered at the
provider layer now rather than through the CLI.

Round 3 added the concurrency proof: two overlapping `putCall`s keep both rows and both survive a reopen,
a drop cannot be undone by a write already in flight, and a call whose hook went before its body landed is
refused rather than kept. `local-webhook-listener.test.ts` gained the stale-bind case (a bind that finishes
after `stop()` closes its server and can start again).

### `local(bots)`: iMessage, so a bot can be texted where Hermes already is

The design is `local/design/imessage-channel.md`; this records what shipped, the anchors, and what the
note could not promise. The gap it closes is the one the channel set named: GitHub gives a bot presence but
not a conversation of its own, and the owner already talks to Hermes over iMessage. Photon is the
integration because it is **outbound** — a Socket.IO stream over HTTP, no webhook URL, no public endpoint,
no signing secret — which is the same shape as the loopback designs and the only kind of inbound this fork
can have. The bot gets a number of its own, so texting it is a conversation with Scout rather than with
yourself, and that is the half of the identity requirement GitHub mode gave up.

**The decision that shapes the code is Beta (2.0), for both provisioning and streaming.** Provisioning does
not exist on Stable at all (only CLI commands), and mixing a Beta provisioning client with a Stable
streaming one would mean two auth schemes (Bearer vs Basic) and two contracts for one conversation. Beta's
transport is Socket.IO and its provisioning is plain HTTPS, both pure JS — the doc's one reopening
condition, a native gRPC binding, does not fire, so there is no sidecar. That was **checked, not assumed**:
`@photon-ai/api@0.7.1` pulls only `zod` and `standardwebhooks`, `socket.io-client@4.8.4` pulls `debug`,
`engine.io-client`, `socket.io-parser` and `@socket.io/component-emitter`, and a full install has no
`binding.gyp`, no prebuilt `.node`, no `prebuilds/` directory and no install script. One dependency is
added (`socket.io-client`); `zod` was already a dependency, so `@photon-ai/api`'s own client is not.

**Two stores, and the split is the point.** The message payload goes to `<userData>/local-photon/inbox/`
**before any turn starts**, which is both the crash guard and the dedupe index; the Photon **cursor** goes
to `local-photon/cursors/<projectId>/<purpose>.json` and advances **only** once that message is durably in
the inbox. The handler Photon means by "success" is "accepted into Orca's queue", never "the agent finished
answering", which is what lets a four-minute turn hold no cursor. The inbox entry carries a `handledAt`
mark, so a crash between the write and the dispatch replays the turn while a replay of something already
dispatched is a no-op — the two cases the note separates. Cursors are opaque and may contain gaps: nothing
here computes `last + 1`, `startSeq: 0` is new-events-only, and an advance whose message the inbox does not
hold is refused rather than taken.

**Reconnect is the failure mode worth naming.** Socket.IO reconnects the socket itself, but the server
disables session recovery, so the application must subscribe again — a reconnect that forgets to
resubscribe hears nothing while looking healthy. `PhotonStream` therefore reports `subscribed` separately
from `connected`, reads its cursor **fresh on every subscribe** (not once at start), arms a liveness
deadline that turns a connected-but-unsubscribed stream into `stalled`, and `assertLive()` throws on
`connected && !subscribed`. `orca bot connectors` prints `deaf` for that state rather than `live`.

**Provisioning is a saga, and its repair is a reconciler, not a rollback.** Rolling back would delete a
project that cost the user capacity and burn a slug that can never be reused — by an active project _or a
deleted one_. So every step asks upstream first (the slug is the project's natural key, the assignment list
is the allowlist, a handle that already has a number keeps it), the project id is persisted before the next
step can fail, and `reconcile()` reads state back and finishes the record. Idempotency keys are **derived**
from the bot id (`photon-create-<botId>`, `photon-key-<botId>-<generation>`, `photon-assign-<botId>-<sha>`)
rather than stored, so a restart resumes the same saga without an intent file that could itself be lost.
The slug is stored beside the bot and never re-derived, because it is immutable upstream.

**Deleting a bot is not deleting a project.** A bot delete releases its numbers and revokes its key, and
says `projectKept: true`; the project stays. `DELETE /v1/projects/{id}` is a separate call that must name
the slug it is deleting (a mismatch refuses), because the slug is a one-way door. Its closure is polled to
a terminal state and a `closing` answer is reported as "still closing", never as success.

**One send per finished turn.** The turn end is read for that turn's own last assistant message, so
progress items, tool calls and status lines are never messages — a turn that emitted twenty of them still
sends once. Long output folds into one attachment rather than N messages. There is no host-wide message
counter: the 5,000/day budget that justified one belongs to Stable, which this path deliberately does not
use. A send is only ever addressed to a conversation already in the thread map, so Orca never cold-starts a
conversation. A failed send is written to `photon-outbox.json` before the attempt and retried with a key
derived from the entry, so a send that may already have landed replays rather than arriving twice.

**Two credentials, two blast radii.** The account service key can create projects and mint keys; it is
**opt-in to store** (`storesKey`, off by default), because the alternative to storing it is re-pasting it
for every new bot. Each bot stores only its own project key, in `local-photon/photon-secrets.json` written
through `writeDurableSecureJsonFile` alongside the Slack token discipline, and **no key is readable back
out**: a lost project key is replaced by minting one and revoking the old, and there is no "show key" path
in the RPC surface at all.

**Access control is the assignment list.** Giving someone a number and admitting them are the same call, so
Orca's Who-can-ask is an editor of the provider's records rather than a second ACL to keep in sync.
`allow_all` is never offered. An unknown handle cannot reach the stream at all, so the access-request flow
(`bot-access-request.ts`) deliberately does not apply here — `orca bot connectors` says "add them, then they
can text" instead of promising a queue that never fills.

**The anchors.** Thirty-seven hunks across fourteen files upstream owns, one of them generated. Each is a
line or two, and the reason each exists is this file. **How that number was produced:**
`git diff <base> -- <path> | grep -c '^@@'`, summed over the upstream-owned files only. `git diff --stat`
counts files, not hunks, so it cannot produce this figure; the fork-owned files under `src/main/bots/photon/`
and `src/main/runtime/rpc/methods/bots-photon*` are whole new modules, not hunks, and are not in this table.
`src/shared/connectors/external-conversation-link.ts` is the union member the note calls for, and
`src/shared/bots/bot-connectors-view.ts` is under `src/shared/` too, so **this patch is a global input**:
`package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` also move, which means gate 1 is required, not
optional.

| File                                                               | Anchor                                   | Change                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/shared/connectors/external-conversation-link.ts`              | `CONNECTOR_SOURCES` and the names record | `'photon'` added as one union member, named `Photon`                                                                 |
| `src/shared/bots/bot-connectors-view.ts`                           | `BotConnectorService.source`             | widened by `'photon'`, which is not an offer source: its own card is the channel's settings section                  |
| `src/shared/bots/bot-connectors-view.ts`                           | `botConnectorServices`                   | one optional `photon` argument and a `photonService` row: the number and who may text it                             |
| `src/shared/bots/bot-connectors-view.ts`                           | `serviceLines`                           | names the row `iMessage`, since `CONNECTOR_OFFER_NAMES` has no entry for it                                          |
| `src/main/bots/bot-chat-tree-base.ts`                              | the link-origin loop                     | a photon link shows as a side chat, as Discord's does (upstream's own comment line kept)                             |
| `src/main/bots/bot-run-results.ts`                                 | `replyInThread`                          | the conversation is narrowed by `ConnectorConversation.safeParse`, so a photon thread has no cloud thread to post to |
| `src/main/bots/bot-structured-session-wiring.ts`                   | `turnEnded`                              | one optional `outsideTurnEnded` dep, handed the turn's id and its reader                                             |
| `src/main/runtime/orca-runtime-bots.ts`                            | `requestTurnEnded`'s neighbours          | `outsideTurnEnded` sends a finished turn's answer to the conversation that asked                                     |
| `src/main/startup/cloud-startup/main-process-connector-startup.ts` | the desktop-only block                   | `photonChannel(runtime).startStreams()`, which does nothing when nothing is connected                                |
| `src/main/runtime/rpc/methods/bots-connectors.ts`                  | `botConnectorServices` call              | passes the bot's photon row, when it has one                                                                         |
| `src/main/runtime/rpc/methods/rpc-method-registry.ts`              | `...BOT_CONNECT_METHODS`                 | `...BOT_PHOTON_METHODS` beside it                                                                                    |
| `src/main/runtime/rpc/methods/bots.ts`                             | the `paused` branch of `bots.update`     | a resume replays the channel's held messages, as it already releases held mail                                       |
| `src/main/runtime/rpc/methods/bots.ts`                             | `bots.delete`'s handler                  | `releaseDeletedPhotonChannel(runtime, botId)`, which releases the numbers and key while the bot still exists         |
| `src/shared/rpc-contract/rpc-params-catalog.generated.ts`          | eight rows                               | regenerated by `config/scripts/plugin-authoring/rpc-catalog/generate-rpc-params-catalog.mjs`                         |
| `package.json`                                                     | `dependencies`                           | `socket.io-client`; nothing else, and `@photon-ai/api` is **not** a dependency of this patch                         |
| `pnpm-workspace.yaml`                                              | `overrides`                              | `ws@<8.22.0: 8.22.0`, so `engine.io-client`'s `~8.21.0` cannot reach an unpatched native socket                      |
| `pnpm-lock.yaml`                                                   | generated                                | the two additions and that override                                                                                  |

**Fork-owned, all the logic** (`src/main/bots/photon/`, fifteen modules with tests):

- `photon-contract.ts` — the endpoint table as one file: the pinned `Photon-Version` (`2026-07-01`), the
  stream path and event names, and a zod schema for every shape Orca reads. A wrong guess about a Beta
  shape therefore fails loudly: `photonParse` throws `PhotonContractError` naming what was being read,
  and a frame or acknowledgement it cannot parse stops the stream instead of being treated as empty.
- `photon-api.ts` — the HTTPS client. Every call names the credential it takes, so a project key is never
  accepted where the account key is required. `read`/`created` parse; `write` does not read a body.
- `photon-stream.ts`, `photon-inbound.ts`, `photon-thread-map.ts` — the stream, the ask adapter and the one
  piece of genuinely new state: `conversationId → chatId`, so a second message continues the chat and a new
  conversation starts another.
- `photon-inbox.ts`, `photon-cursor.ts`, `photon-outbox.ts`, `photon-store.ts` — the two stores, the retry
  queue and the non-secret record.
- `photon-provisioning.ts`, `photon-teardown.ts`, `photon-send.ts`, `photon-service.ts`,
  `photon-runtime.ts`, `photon-chat-replies.ts` — the saga and its reconciler, the two teardown weights, the
  send path, and the surface the RPC methods and the turn-end hook call.

**What this does not claim.** Beta is a **preview**: replay is limited to an unpublished retention window
and is **not** exactly-once, which is why dedupe by message id is mandatory rather than an optimisation. A
long outage is therefore a gap. The setup text has to say one more thing the code cannot enforce: a newly
assigned number's inbound is dropped until the line is picked up at token renewal, so the instructions end
"restart Orca, then text it".

**The settings card is now built** (`components/bots/photon/PhotonChannelSettings.tsx`): connect with an
organization id and an account key, then per bot give it a number, add a person who may text it, Repair and
Release. It renders nothing on a host that answers `method_not_found`, so an older host is untouched.

**Deliberately not done, each for its own reason.** The project-delete step has no button: its RPC needs the
slug typed back and burning a slug is irreversible, so it stays a CLI/RPC-only action. **Every
live-account verification**: there is no Photon account here, no line and no project, so the test the note
calls for (text the bot, quit Orca, text again, reopen, confirm the turn runs) is unverified, as is the
claim that a new assignment's inbound is dropped until renewal — neither is faked. Attachments and length limits (the note lists them as unknown, so a long
answer is capped into one message rather than pretending an upload works), group chats and the Business
tier, and Stable. And the sidecar question is settled for Beta, so none was built.

Tests: `photon-stores.test.ts` (the opt-in account key, per-bot key isolation with no secret in the record,
dedupe, a write-then-crash replay, an id escape refused, a cursor that will not pass a message the inbox
does not hold, gaps `41 → 47`, no rewind, per-purpose isolation, thread continuation across a restart,
outbox retry and its attempt cap), `photon-api.test.ts` (the real HTTP surfaces: the pinned version header,
a bearer credential, an unknown shape refused, a non-JSON body refused, a 404 read as absence, replayed
create / key-mint / assignment all returning the first result, a taken slug refused, the closure reported
as still closing then closed, slug determinism), `photon-provisioning.test.ts` (the whole saga, a re-run
finding one project, resuming after the key mint failed and after the number was refused, one derived
create key, the reconciler repairing an unpersisted assignment and a stale slug and saying so when the
project is gone, release keeping the project, a wrong-slug deletion refused, a still-closing deletion never
reported as success, the closure polled to terminal), `photon-stream.test.ts` (subscribe with the saved
cursor, resubscribe from the _moved_ cursor, a forgotten resubscribe caught by the liveness assertion
rather than by silence, `stalled` on an unacknowledged subscribe, a frame delivered, a failing handler
stopping the stream, an unreadable frame refused), `photon-inbound.test.ts` (same id twice runs once,
continuation versus a new conversation, the right `BotRequestPerson` and the member role, an unknown handle
ignored with the cursor still advanced, the cursor held when the turn could not start, that replay running
after a restart, a handled replay absorbed, a gap resumed), `photon-send.test.ts` (one send for sixteen
progress items, a long answer folded to one attachment, a cold start refused, a failed send kept and
retried with the same key), `photon-turn-result.test.ts` (the turn's own message, not a later turn's; a
progress-only turn sending nothing), and `photon-service.test.ts` (creating before connecting refused with
a sentence that says what to do, the opt-in key, one project, add and release, the `orca bot connectors`
row, a bot delete keeping the project, and no row for a bot with no project). Everything network-facing ran
against a **real loopback HTTP server** (`photon-fake-server.test-fixture.ts`) with knobs to fail a key
mint, an assignment and a send, and with real idempotency replay — a mock that cannot fail is not a test.

### `local(lint)`: the iMessage channel's work off the main thread, and two upstream warnings fixed rather than recorded

The channel's stores were synchronous, and every one of their reads and writes runs on a delivery or a
turn end rather than once at startup — a blocking read there stalls every window on Electron's main
thread. They now use `node:fs/promises` and `writeSecureFileAsync`, the same two the webhook store uses,
so `check:main-sync-fs-ratchet` charges them **nothing**: 0 sync fs calls in `photon-store.ts`,
`photon-inbox.ts`, `photon-outbox.ts`, `photon-cursor.ts` and `photon-thread-map.ts`, where the first
version of this patch charged twelve.

What is left is `check:main-blocking-helper-ratchet`, and it is left because it cannot be removed while
using the sanctioned helper: `writeSecureFileAsync` publishes with a synchronous `renameSync` on purpose
("Sync so the check above and the publish share a turn: a sign-out's clear cannot land between them"), so
every file that calls it is charged by design. Six rows, one per module, each with the same evidence —
the identical shape `local(webhooks)` records for the same helper in the same file:

```
1 src/main/bots/photon/photon-cursor.ts    # per delivery and per turn end, through writePhotonJson: …
1 src/main/bots/photon/photon-files.ts     # …
1 src/main/bots/photon/photon-inbox.ts     # …
1 src/main/bots/photon/photon-outbox.ts    # …
2 src/main/bots/photon/photon-store.ts     # …
1 src/main/bots/photon/photon-thread-map.ts # …
```

Six rows is more than the webhook store's two, and the difference is the file count rather than the calls:
each module keeps one store, so the charge lands once per file. Collapsing them would mean one store class
for four different file shapes, which is worse code than six documented rows. Every read in all six is
asynchronous; nothing here reads on the message path.

**Two upstream warnings, one claim each, both fixed rather than allowlisted.**
`useIpynbDocumentEditing.ts:153` carried an `react-hooks(exhaustive-deps)` warning: `fileId` in
`flushSourceDrafts`'s dependency array, which the callback never reads — it works off
`sourceDraftsRef`, `draftBasesRef` and `contentRef`, all stable, plus `latestCells`. `pnpm lint` runs
oxlint with `--deny-warnings`, so the warning was a failing step. It reproduced on `main` at
`9d8c6c8cb64` when oxlint ran on that file alone, so it is not this branch's bug; the repair is the
dependency list `[latestCells]`, which is what the hook actually closes over, and no behaviour changes.

Recorded as an anchor because it is an upstream file:

| File                                                                                               | Anchor                                         | Change                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/editor/notebook/document/useIpynbDocumentEditing.ts`                  | `flushSourceDrafts`'s dependency array         | `[fileId, latestCells]` → `[latestCells]`; `fileId` was never read by the callback                                   |
| `src/renderer/src/components/editor/rich-markdown/document/useRichMarkdownPendingSerialization.ts` | `flushPendingSerialization`'s dependency array | the same claim in the markdown editor: `fileId` removed, and it is read only by the neighbouring hook two lines down |

`local/lint-known-red.json` therefore keeps **no** entry for this branch, and the one the gate reported as
stale — `check:code-quality:changed`, `wholeStep`, left from the 2026-11-20 sync — is gone, because the
changed checks run clean here.

### `local(lint)`: two `check:changed` ratchets red on `main` after the 2026-11-24 sync

`pnpm check:changed` reports two failures at `767c078fde1` that the fork's lint gate —
`node local/gate-lint.mjs`, the PR line's gate — does not run, so that gate is green (54/54) while the
changed-checks entry point is not:

- **`main-blocking-api`, sqlite category.** Ten `src/main/ai-vault-search/storage/` files carry
  blocking sqlite with no baseline row. `countBlockingApis` scans `readEventLoopSources(root)` — the
  whole tree, never the diff — and those files are byte-identical at `main` and on a branch cut from it,
  so this is a base-branch red that no branch fixes by changing its own code. The 2026-11-08 note above
  (AI-vault paging work on orcad's event loop) is the same red: it is a code fix, and a baseline row
  would silence the check that exists to catch it.
- **`react-compiler-compat`.** Three entries record more bailouts than the tree has —
  `DiffViewer.tsx`, `RepositoryIconPicker.tsx`, `ClaudeSwitcherForOwner.tsx` — a baseline the
  2026-11-24 sync shrank past. The fix is that ratchet's own `--prune`, re-taken on `main`, not in a
  feature branch's diff.

Neither goes in `local/lint-known-red.json`: that file allowlists failures of `local/gate-lint.mjs`'s own
steps, and an entry for a step the gate never runs allows nothing.

### `local(test)`: one `host-load` flake seen on the iMessage branch, and why the red set was left alone

`local/unit-known-red.json` has been empty of entries since the 2026-10-31 sweep, and this branch leaves
it that way. What it saw, because a flake nobody records is one nobody believes:

the google key-download-watch suite's `takes the key once the browser renames it to its
final name, ignoring other files` failed the full gate **three times in a row** at `25689fb920` with
`Test timed out in 30000ms` on the `await rename`, while the same file passed **4/4 standalone**
(`--maxWorkers=1`, three consecutive runs). Nothing in this branch touches `src/main/google/`. The tests
themselves are the evidence for the other direction: the full suite was green at `9cc8c07d76`
(`27758 passed, 0 failed`), red at `25689fb920` on that one case, and green again at `6bd42822f9`
(`27759 passed, 0 failed, 0 allowlisted`) — the same code path each time, which is what "under load"
means here rather than "broken". The suite itself went in upstream's 2026-11-24 test-inventory pass, so
this record is the only trace of the case; `src/main/google/google-setup-key-download.ts` has no test at
HEAD and re-homing one is owed.

- **No entry was added.** The red set is the machine's assertion about what is _reliably_ red on it, and
  this case is not: it passed the gate at this branch's HEAD. An allowlist entry that the next run does
  not need is exactly the slack the file warns about, and it would also have had to re-reconcile
  `observedRun` — `tests/tools/unit-gate.test.mjs` pins a new entry to a fresh run, so adding one means
  replacing the 2026-10-29 reconciliation and moving its fifty `prunedSince` rows out of the assertion.
  That is a real cost, and it is not this branch's to pay for a red it cannot reproduce.
- **The test was not edited either.** A 30 s `fs.watch` deadline is upstream's to widen; changing an
  upstream suite in the fork costs more at the next sync than the red costs now, which is the same rule
  that keeps the other classes out of the fork's files.
- **What to do if it comes back.** It is a `host-load` class with the text above: `Test timed out in
  30000ms` on `google-key-download-watch.test.ts`. Recording it properly means a fresh `observedRun`
  (one failing record, one allowlisted) and the fifty historical prune rows kept somewhere that is not
  the assertion — the plan sketched in this branch's review replies.

### `local(bots)`: what a release needed before the bot features were reachable

Four defects found by auditing the tree against what shipped in #451–#459, all of them copy or reach
rather than transport. Each is small; together they were the difference between "the feature exists" and
"a person can use it".

**iMessage had no way in.** Every Photon RPC existed and nothing called it, so the channel was merged and
unreachable. It is now a connector on the bot, where every other connector is set up:
`components/bots/photon/BotPhotonCard.tsx` on the bot's Connectors tab, with `PhotonConnectForm.tsx`
beside it. The card does the whole job in one place — connect the owner's own Photon account (organization
id and account key, stored only if they say so), give the bot a number with the owner's own handle as the
first person who may text it, then add or remove the others, Repair (its notes shown), and Release behind
a confirmation, because releasing is a dead end Settings cannot undo. The computer's own group keeps only
the account: `PhotonChannelSettings.tsx` connects and reports it, and says that numbers and people belong
to a bot. Both render nothing on a host that answers `method_not_found`.
`src/renderer/src/lib/photon-channel-client.ts` is the RPC client, shaped like `github-app-client.ts`, and
both now sit on the shared `host-rpc-view.ts` hook. The row is listed before Photon is connected, so the
empty Connectors state still offers Add a connector and still carries the iMessage row that sets it up.

**Keeping a key needs a keyring, and the card says so.** `photon-secrets.ts` falls back to `plain:`
base64 when the host cannot seal, and `PhotonService.connect` refused to be quiet about that: it will not
write a key it cannot seal (`assertPhotonKeyCanBeStored`), and the checkbox is disabled with a sentence
that names the session-only consequence. Before this, "kept, sealed by its keyring" and "not kept" could
both be wrong on the same host.

**A working webhook was called paused.** `BotWebhooksCard` replaced its whole face with "paused while
signed out" whenever Orca Cloud was signed out, while a local hook went on firing. `WebhookSummary` now
carries `servedHere`, set by `LocalWebhookHostService` for the hooks this computer holds — in `card` and in
one `list` override — and the card pauses only the cloud's hooks. The per-rule "this computer" choice
beside "Orca Cloud" stays deferred: on a host with no cloud the save already routes to this computer, so
the missing card is a preference for cloud users, not a gap for an account-free one.

**The GitHub row said "Coming soon" with an App connected.** `useBotConnectorAvailable` gates GitHub on the
cloud, which is right for adding a linked account and wrong once an App is connected: the row now shows,
and reads `Bots act as <slug>[bot]`. `src/shared/rpc-contract/github/github-app-params.ts` gains
`canPushWorkflows`, read from GitHub's own `permissions.workflows` by `readWritePermission` in
`github-app-api.ts`, stored beside `contentsWrite`, and shown under the connected App — the setup steps used
to claim a `.github/workflows` push is always rejected, which was false for any installation that holds it.

**Connecting a bot to Photon is the owner's step.** The iMessage card asks before it creates anything:
"Connect <bot> to Photon" reveals the handle field, and only that second step runs `bots.photon.create`,
which makes the project, mints the key and assigns the owner — the owner's handle is required and is the
bot's first person. Nothing in main provisions on its own: the only caller is that method. The computer's
Bots page keeps the account alone, because the account is per machine and the agent is per bot.

**A bot's own skills load first, and it can write them.** A bot created from a template already had
skills written into its home (`skillsFolderFor(agent)`), but nothing loaded that folder explicitly: whether
they arrived depended on the agent's own cwd conventions, and a skill the bot wrote later was seen by
whatever happened to rescan. `bot-skill-roots.ts` now reads the bot's own `.agents/skills` (or
`.claude/skills`) as a skill root and links it ahead of the projects, so every agent Orca launches - Claude
by added directory, Codex by skill root, pi by `skillDirs`, the ACP agents by plugin folder - loads what the
bot wrote for itself. `relinkedSkills` asks for the list every turn instead of only when the linked
projects changed, because a key made of folder names cannot see a new skill inside a folder; the
fingerprint still decides whether the agent hears about it. Sharing between bots is a folder symlink in a
bot's own skills folder - the scan admits a linked folder and resolves it - and the shared, cross-bot set
is `botSkillFolders` above. `bot-skill-folder-scan.ts` holds the SKILL.md reading those three sources share.

**A skills tree outside Orca could not reach a bot.** Bot skills were project-only: `<repo>/.agents/skills`
or `<repo>/.claude/skills`, linked per bot. A tree kept outside Orca — `~/.agents/skills`, where a Hermes
setup keeps its skills — could only be linked by registering its parent as a folder project. The setting
`botSkillFolders` (`GlobalSettings`, disposition `hostLocal`) is a list of folders whose children are skills;
`scanSkillRoots` in `bot-skill-projects.ts` scans them and `linkedSkillProjects` / `linkedSkillListing` link
them beside the projects, so every bot on the computer loads them.

Four things make it work rather than nearly work. A path is read by `resolveSkillRoot`, which expands `~/`
and refuses anything not absolute — Settings suggests `~/.agents/skills`, and main's cwd is nobody's home, so
without that the headline case loaded nothing silently. `linkedSkillKeys` puts the folders in the key a
running chat compares, so adding one reaches an open chat at its next message instead of its next launch.
`relinkBotSkills` is handed the folders too, because `syncLinks` deletes every link it was not given and a
project change would otherwise strip them. And `skillLinks` de-duplicates by folder, so a root that overlaps
a linked project's `.agents/skills` links one skill once. One list per computer, not per bot, because the
tools they document are installed once on that computer; the section says plainly that every bot here loads
the folder, including bots other people can message.

**Not rebuilt, on purpose.** `src/main/bots/bot-pr-events.ts` is inert in upstream and no fork commit
touched it: a bot is no longer woken by its workers' pull requests. The account-free way to react to GitHub
is the local webhook route plus an automation rule, which is what #453 ships. Diverging here would fight an
upstream decision for a behaviour the fork does not need.

### `local(ci)`: the secret-holding jobs name a GitHub Environment (#review-2 R2-1)

`workflow_dispatch --ref <branch>` runs **that branch's** copy of the workflow, so every guard the
fork's release, tag-mirror and CI-health lanes run is a file in the dispatched tree — and none of
those guards costs the `workflows` permission to edit. Anyone who can push a branch and dispatch a run
could therefore neuter the guard and reach the Apple signing secrets, the mirror PAT (contents and
workflows write; the `exempt` actor on `main`'s ruleset) and the agent delegate token.

The tree's half of the fix is `environment:` on `release-ref`, `release-draft`, `macos`, `windows`,
`linux` and `publish` in `fork-release.yml`, on `mirror` in `fork-upstream-tags.yml`, and on `health`
(`ci-health`) in `fork-ci-health.yml`. The half that matters is repository state and cannot be carried
by a sync: three environments — `release`, `ci-health`, `upstream-tag-mirror` — created with
**Deployment branches: `main`** (Settings → Environments, or `PUT
/repos/nplez1/orca/environments/<name>` with `custom_branch_policies` plus a `main` branch policy).
That rule is what GitHub checks before a job's steps run, whatever the dispatched branch contains. A
required reviewer on `release` is the second check worth adding for releases; it is not configured here
because a dispatch would then wait on a human.

**Verified 2026-11-25:** all three exist and each allows only `main`
(`gh api repos/nplez1/orca/environments` → 3, one branch policy each).

What is **not** done, because it needs the secret values re-entered by hand: the seven repository
secrets (`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `MAC_CERTS`,
`MAC_CERTS_PASSWORD`, `FORK_TAG_MIRROR_TOKEN`, `AGENT_DELEGATE_TOKEN`) are still repository-level, so
any job that does **not** name an environment can read them. Every job that uses them now does, which
is what makes the branch rule bite; moving them into the matching environment is the defence in depth
left to do.

Two smaller changes ride with it, from the same review: the three release legs' checkouts carry
`persist-credentials: false` (`pnpm install` and the release build run third-party lifecycle scripts
while a `contents: write` token would otherwise sit in `.git/config`), and their electron-builder
caches no longer `restore-keys` by prefix — a prefix match lets any `main` job, including the read-only
ones that run those same install scripts, seed the cache a signing leg restores.

### `local(hosts)`: hosts know each other, so every instance shows the same fleet

The design, its trade-offs and the four capabilities it separates are `local/design/host-graph.md`; this
records what shipped, where the anchors are, and the three places the note was wrong. The complaint this
answers is one sentence long: **a host is a record in one install, not a machine**, so four machines paired
into a mesh each showed only its own pairings, and a laptop that could reach nothing but the Studio showed
nothing at all. Stage 2 (discovery) is built; stages 1, 3 and 4 are not, and this patch does not touch
`ExecutionHostId`, so nothing about row identity, settings scope or worktree ownership changes underneath.

**The mechanism, and why it is not a pull-only read.** One capability (`host.graph.adjacency.v1`) and one
method (`hostGraph.exchange`). The method is _symmetric_: the caller sends its own adjacency and the callee
answers with its own plus the reports its callers have left with it. A pull-only design cannot work here,
because in this fork's own topology (`bot-host-topology.md`) a leaf has no outbound pairings and can call
nobody — it would report zero hosts forever. Hearsay is labelled as hearsay and never re-nested, so depth is
bounded by the payload's shape rather than by a hop decrement. Nothing is persisted: the answer is other
machines' claims about right now, and a file would outlive the pairing it was read under.

**Identity without an id migration.** A machine is named by `orcaHostKey` — the digest
`publicRuntimeEnvironmentWithHostKey` already publishes, derived from the host's own E2EE key — with
`sshHostKeys` beside it as the only key a non-orcad host has. `machineKey` was the note's name for it and was
already taken by the managed-server home naming. A merge on equal `orcaHostKey` is trusted; an SSH-key match
may complete an SSH-only entry but never join two machines that each presented a _different_ pairing key, or
a lying peer could hide a host from the count. The viewer's own machine (`viewer` and the `own.self` it sent)
is dropped, which is what makes the number mean "all the OTHER hosts".

**What is disclosed, and what bounds it.** An adjacent host learns labels and public-key digests of every
member machine, and the edge kinds — no endpoints, ports, usernames, device tokens, target ids or pairing
ids. A direct caller needs `workspace`, which already implies command execution on this host, so it learns
nothing it could not read from `orca-environments.json` itself. The genuinely new disclosure is that a
**callee** learns upstream membership: a work host the Studio controls, holding no rights on the Studio,
learns the laptop's name and identity. The bounds are: `ephemeral-vm` environments are never reported, the
method is deliberately absent from both mobile allowlists so a phone cannot enumerate the fleet, heard
reports are memory-only and aged out by the same TTL the client uses, the answer a peer returns is
validated before it is composed (`params` bounds what this host is asked, not what it is told), every array
and string is bounded in `host-graph-params.ts`, and relayed rows are labelled and not actionable (there is
no connect control, because reaching one needs stage 3).

**The anchors.** Six files upstream owns, each a line or two, plus one generated catalog; every reason each
exists is this section. `src/shared/host-graph/**` is under `src/shared/`, so it is a **global input**: a PR
carrying it needs the full unit gate, and a sync that moves it invalidates a cached verdict.

| File                                                                                 | Anchor                                                    | Change                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/runtime/rpc/methods/rpc-method-registry.ts`                                | beside `...HOST_SETTINGS_METHODS`                         | `...HOST_GRAPH_METHODS`, plus its import                                                                                                                                                                                                      |
| `src/shared/remote-runtime/protocol/protocol-version.ts`                             | beside `HOST_SETTINGS_REPLICATION_RUNTIME_CAPABILITY`     | `HOST_GRAPH_RUNTIME_CAPABILITY`, in the same commit as the method                                                                                                                                                                             |
| `src/renderer/src/components/status-bar/host-connections/SshStatusSegment.tsx`       | the selector block, the early return, the count, the menu | imports; `useRelayedFleetHosts()`; the early return also requires `relayed.length > 0`, or a leaf shows nothing; the count adds live relayed hosts; a `Via other hosts` section with its two failure footers; `refreshRelayed()` on menu open |
| `src/renderer/src/components/status-bar/host-connections/ssh-status-segment-copy.ts` | end of file                                               | five copy helpers: `relayedHostViaLabel`, `relayedHostStaleLabel`, `viaOtherHostsLabel`, `hostGraphPartialLabel`, `hostGraphOlderPeerLabel`                                                                                                   |
| `src/shared/rpc-contract/rpc-params-catalog.generated.ts`                            | generated                                                 | `pnpm generate:rpc-params-catalog`, never hand-edited                                                                                                                                                                                         |
| `src/main/ipc/runtime-environments/runtime-environment-connection-observation.ts`    | beside the replication `observeConnection` call           | `observeHostGraphEnvironmentConnection(args)` and `invalidateHostGraphSnapshot()`, so a pairing's own liveness is known and a host attaching refreshes the fleet before the TTL                                                               |

**Why the count is additive, and what it is not.** The status-bar number is the direct connected hosts plus
the relayed machines confirmed inside `HOST_GRAPH_NODE_TTL_MS`; on a mesh of diameter two that is the same
fleet size on every instance, which is the whole ask. It is not a claim that this client can reach them, and
the menu says so twice: each relayed row reads `via <host>`, and a partial fan-out or a peer too old to
answer is stated in its own footer rather than being allowed to look like hosts lost.

**What the review changed, and why it is worth knowing.** The first version answered the exchange
symmetrically but composed only the answers to the questions it had asked, so a host that is _called_ and
never _calls_ learned nothing: on the documented hub the Studio showed two hosts, the laptop three, and the
VM and the Windows box zero — the exact failure the requirement forbids. The driver now composes the reports
it holds as well, which makes a machine that only ever calls this one a direct pairing in the other
direction. Three corrections came with it: an answer's `revision` covers the hearsay as well as the
adjacency, or a new caller stayed invisible to everyone else for as long as the caller kept asking; a failed
host replays what it last said at its original age instead of vanishing on one bad round trip; and a
pairing's liveness comes from its own transport rather than from an SSH tunnel it may not use. The second
review round caught the consequence of the revision fix: because the revision ignores arrival times, a host
that kept confirming the same answer let the hearsay inside it age out here while it was still current there,
so an unchanged answer now re-stamps the reports it carries.

**Known limits, accepted deliberately.** A machine reached both directly and through a relay whose stored
SSH key is filed under a different hostname spelling can be counted twice, because only a pairing key can
prove two entries are one machine. And once this client knows its own pairing key, an entry carrying only an
SSH key is never treated as "us": VM images cloned from one template share `/etc/ssh` host keys, so a clone
shows as its own row. That is the safer direction — a spare row, instead of a peer being able to hide a
machine from the count by claiming our host key.

### `local(hosts)`: mesh groups, so one join pairs a machine with every member

The design, the three rejected mechanisms and the security reasoning are `local/design/host-mesh.md`. This
records what shipped, every upstream file it anchors, and what is still unproven.

Orca pairing is directional — the caller holds the environment record — so a fully connected group of n
machines needs n(n−1) records and n(n−1) user actions. Three machines is six links. A group makes it n
actions: joining one member introduces the newcomer to every other member, and every host in the group then
lists every member's workspaces, which is the outcome the feature exists for.

**The decision that shapes it: no host mints a pairing offer for another.** `pairing.createOffer` is
`pairing-admin` and that tier is owner-only (`runtime/rpc/methods/pairing/pairing.ts`, _"paired clients and
phones never hold pairing-admin"_). Minting on a peer's behalf would turn every pairing into a grant to widen
that peer's access — the escalation `local/design/host-graph.md` §4 refuses. So each host mints its own offer
with **no grants**, seals it to the one machine allowed to redeem it (`nacl.box` static-static over the domain
`orca-mesh-offer/v1`), and the introducer is a courier for a box it cannot open, alter or relabel.

**Fork-owned files** (no sync cost): `src/shared/host-mesh/*` (contract, membership reducer, admission
rules), `src/main/host-mesh/*` (sealed offer, store, driver, RPC service, runtime façade) — with 81 unit
tests, including a three-host simulation that drives the real protocol through a fake transport.

**Upstream anchors — every one of these will need resolving at the next sync:**

| Upstream file                                                                                                                                   | What the fork adds                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/main/runtime/rpc/core.ts`                                                                                                                  | the `hostMesh` context field                                          |
| `src/main/runtime/rpc/methods/rpc-method-registry.ts`                                                                                           | the `HOST_MESH_METHODS` spread                                        |
| `src/main/runtime/rpc/methods/host-mesh.ts`                                                                                                     | new: thirteen methods, seven peer-facing and six owner-facing         |
| `src/main/runtime/rpc/dispatch/dispatcher-stream-options.ts`, `server/runtime-rpc-request-admission.ts`, `server/runtime-rpc-mobile-pairing.ts` | threading the service to the handler context                          |
| `src/shared/rpc-contract/host-mesh-params.ts`, `rpc-params-catalog.generated.ts`                                                                | the params schemas and their generated catalog                        |
| `src/main/ipc/register-fork-handlers.ts`, `.test.ts`, `src/main/ipc/host-mesh/host-mesh-handlers.ts`                                            | the renderer's six IPC channels                                       |
| `src/preload/api/{fork-preload-api,index,api-types}.ts`                                                                                         | the `window.api` surface                                              |
| `src/renderer/src/components/settings/runtime-environments/…`                                                                                   | the Host mesh panel, its one switch, and the per-row mesh state/Eject |
| `src/cli/{specs/index,hosts/host-handler-groups,dispatch/remote-selection-scope}.ts`                                                            | `orca group` registration                                             |
| `src/main/startup/runtime-startup/main-process-runtime-launch.ts`                                                                               | the one `configureHostMeshRuntimeFromApp` call                        |

**A host's name, and what it cost upstream (2026-11-26).** A name is a fact about the group rather than
about the client showing it: `HostMeshSyncPayload.names` carries a versioned register, a rename on any
host propagates on the next pass, and each pass renames this host's own pairing row from the winning
entry — which is what repairs the rows a redemption had named `Mesh host 8f3ac2b1`, without re-pairing
anything. A redemption now names the row from the label the peer reports in its request (the sealed
payload is held to an exact field set and deliberately unchanged); the peer index records the label a
redemption wrote so a later pass can rank an invented name below one an owner typed. The upstream cost is
six seams, all declared in `local/checks/host-mesh-upstream-seams.mjs`: one command case, the protocol
request/success pair, one async facade wrapper, the operations re-export, the glyph slot on the
status bar's runtime host row, and one blocking-helper baseline row. The rename operation, the merge rules
and the ranking live in fork-owned files (`runtime-environment-rename.ts`, `host-mesh-names.ts`,
`MeshPairStatusIcon.tsx`, `use-host-mesh-pair-statuses.ts`).

**Permissions, and why they are what they are.** The six peer-facing methods are `workspace` — a caller at
that tier already runs host-user code, so learning membership is not a new capability, and every dangerous
effect is bounded by a sealed box only the newcomer's key could have minted — except removal, which is
`host-admin`. The six owner-facing methods are `host-admin`, so no paired desktop can widen itself.

**One honest cost of auto-accept, stated on the settings row.** With introductions accepted automatically,
one compromised member can add a machine it controls to every member, and every member gains a shell on every
other. That is inherent in what the group is for. The bounds are attribution on every row, a notification on
each host, a cap of 12 members, four introductions per introducer per hour, and any member able to eject.

**What the unit evidence does not cover.** Endpoint reachability across LAN and Tailscale is the likeliest
cause of a half-join and needs three real machines; loopback is refused outside tests, so an offer exchange
between two real Electron main processes cannot be exercised on one Mac. Removal while a member sleeps is
likewise proven only at the store level. Until that run happens, treat a group as reliable on one network and
unproven across two.

**Reviewed, and what the review changed.** Opus 5.5 at high on the combined diff found that the first join
could not work at all (the hello carried an empty group id the params schema refused), that removal revoked
nothing (`mintRuntimeOffer` discarded the device row id, so `forgetDevice` had nothing to delete), and that a
pair was reported complete when only one direction existed. All three are fixed, along with redemption
verifying the offer's own key _before_ saving an environment, a host that was ejected now acting on the
notice, and the introduction limit actually being counted. A delta re-check found one new blocker — the
opt-in could not be turned on, because the patch schema and the store did not name it — which is now fixed
and pinned by a test. **That last fix has not been re-reviewed**; a third round needs the owner's approval.

**Known limits, stated rather than hidden.** A relayed offer is bound to its recipient and to the machine
that minted it, but the single-use nonce that `host-mesh-contract.ts` promises is not yet enforced, so a box
can be replayed inside its ten-minute window. A member list arrives unauthenticated, which is the conceded
cost of auto-pairing: one member can name a machine it controls and every member will pair with it. Any
`workspace` caller can drain another host's pending boxes (a denial of service, since only the addressee can
open one). The store has no lock, so two concurrent RPCs can lose an update.

**Upgrading an existing install.** Nothing is rewritten: the group lives in its own `host-mesh.json`, the
pairing table and its schema are untouched, and a build without the mesh simply ignores the new file. What
would otherwise happen is that an existing fleet stays exactly as scattered as it was — pairings are
directional, so every machine already holds the machines it was paired with but nothing groups them — and the
owner would have to create a group by hand on each one.

So there is one migration, at startup, and it runs once per install. It reads the pairing table (the same
edges discovery already reports), groups this host with every machine it is already paired with, and records
that it ran. Nothing is minted or dialled by it: every link starts awaiting its offer, so the panel shows an
unrepaired fleet rather than a false one. A machine with no pairings has nothing to group and records that,
which is why pairing a second machine later does not silently create a group the owner never asked for. And
because the file is written, leaving the group is never undone by the next launch.

Two machines upgrading independently cannot agree on a group id without help — each derives one from the
fleet it can see, and a leaf sees only the hub — so `adoptHostMeshGroup` is the rule that settles it: a host
takes on another's group when that group contains its own and every machine in it is either already paired
here or vouched for by a member that is. The id is derived from the members rather than random so two
machines that saw the same fleet agree outright, and containment rather than overlap so two fleets that share
one machine never merge through it.

The other half of the same gap was structural, not migration-specific: `decideIntroduce` refused a host with
no group at all, so a machine that had never joined could not be brought in by anyone — the opposite of one
join pairing it with everyone. It adopts instead, on the same trust rule. `hostMesh.sync` also answered a
member whose group id differed with an empty member list, which is what kept a fleet split after an upgrade;
membership now decides that rather than the id, and a non-member still learns nothing.

Verified by a three-host simulation of the upgrade itself: three machines that only ever knew the hub each
migrate to their own group, and after two syncs each they hold one group and know all three members.

**A fleet that updates one machine at a time.** The normal case is the machine holding every pairing
upgrading first, while the others are still on a build with no mesh in it. Handled explicitly:

- An old-build peer answers `method_not_found`, and that is recorded as `unsupported` rather than
  `unreachable`, because it is not a network fault. The panel says _Needs update_ for it, and the group
  listing otherwise stays honest: the upgraded host knows all members, the members know only themselves
  until they update.
- No offer is minted for a member known to be unreachable or unsupported. `membersAwaitingNewcomerOffer`
  returns every member whose link is not `ok`, so without that exclusion the repair would have minted a live
  device row at a machine that cannot redeem it, on every sync.
- A successful sync now proves the outbound link (`ok`). That is what lets a migrated group repair itself:
  the repair needs one member that already works to carry the others' offers, and nothing else would ever
  mark one.
- Migration carries each peer's public key from the pairing record. Without it nothing can be sealed to that
  member, the repair skips it silently, and the fleet never completes.
- The store's link schema is now tested against every kind the driver can write. Adding `unsupported` to the
  union without teaching the store made the store refuse the file its own driver had just written — which
  reads to the owner as "move it aside to start over", in the middle of an upgrade.

Verified by three simulations of exactly this rollout: the hub upgrading first mints nothing and reports both
peers as needing an update; a leaf picked up the moment it updates converges on the hub's group and learns
the member it had never met; and when the last machine updates, all three hold one group with every pair
complete.

**The upgrade that did not converge, and the reverse offer that fixes it (2026-11-26).** The first real
three-machine upgrade reported the failure the simulations had not covered: a studio that dials two work hosts,
and work hosts that hold nothing. They listed no members at all, and the studio showed both pairs _One-way_
with `Sync now` unable to change it. Local evidence: `orca-environments.json` empty and `host-mesh.json` at
`state: null, migration.peerCount: 0` on a work host. Three causes, all now closed:

- `listPairedHostKeys` reads the environment table, so a machine that is only ever **dialled** migrates
  nothing and records that run permanently. The migration is a one-shot and deliberately stays one (`pairing a
  machine later must not silently create a group`), so the fix is not to widen it.
- Every method in the protocol is a call the holder of an environment makes — `join`, `relayIntroductions`,
  `introduce`, `sync` — so a host with nothing could neither dial a member nor be introduced by one, and
  adoption at the far end asked for an outbound environment it did not have. The one-way badge was honest and
  nothing could repair it.
- The manual path the design note depends on was unreachable: `hostMesh.join` needs a local environment, the
  renderer never called it, and `allowJoins` was not in the IPC allowlist.

`hostMesh.offerBack` closes it: a machine that already holds a credential into a peer hands that peer an offer of
its own, sealed to it, and the peer redeems it and adopts the group. No host mints on another's behalf, the box
is single-use and expires, and the only machine that can open it is the one it was addressed to. The trust anchor
is the device row the caller authenticated with — it reached the method over a token this host issued, so it
already runs commands here — and the box names a minter key whose own pairing offer must hash to that name, so a
caller cannot present itself as a different machine. The residual risk is the accepted one: a machine this host
already trusts can add itself, bounded by attribution, `HOST_MESH_MAX_MEMBERS` and ejection.

One offer per member per launch, retried no more often than `HOST_MESH_REVERSE_OFFER_RETRY_MS`, and never again
in the launch after a refusal: an offer is a device row here, and a machine with the mesh switched off must not
be handed ten of them. Verified by two new driver simulations — the reported fleet converges to every pair
complete with no action on either work host, and a refusal leaves the pair honestly one-way with exactly one
offer minted — plus six admission tests for the rule chain (no device row, mesh off, another machine's box, a
box addressed elsewhere, a tombstoned member).

**One switch, and one list of hosts.** `HostMeshSettings` is `{ enabled }`; the five per-rule booleans were a
protocol audit dressed as a setting, and the pane's member list repeated every host already in the server list
above it. Each host row now carries its mesh status and an Eject (one new declared seam: two lines in
`runtime-server-row.tsx`), and the section is the switch, the summary, when it last checked itself, and _Leave
mesh_. The only list left is a member this computer cannot reach — it has no row to hang anything on, which is the
one case the old second list was actually for. A bridge-independent renderer store (`host-mesh-shared-state.ts`)
feeds the section and every row from one snapshot, so an eject cannot leave one of them showing the old state.

**No Sync control anywhere, and why.** The owner's next sentence was the requirement: _"I shouldn't have the push
sync on anything. Everything should happen automatically!"_ `host-mesh-auto-sync.ts` now owns one reconcile in the
main process — a pass ~10s after launch, on every connection-change observation, when the switch goes on, and when
a peer pairs this host, all collapsed into a single nudge; then one pass a minute while the fleet answers, doubling
to a 15-minute ceiling while it does not. A self-scheduling `setTimeout`, not `setInterval`, because a fixed
cadence is exactly what the recurring-timer ratchet refuses and a closed laptop must make this quieter; the handle
is unref'd, so it never holds the app open. The driver holds one in-flight pass, so a nudge and the scheduled pass
cannot interleave two writes. The renderer lost `hostMesh:sync` and `window.api.hostMesh.sync` with the button; a
pane re-reads the local snapshot on the shared 15s clock and prints `lastSyncedAt`, so it follows the passes
instead of showing what it mounted with. `orca group sync` stays as a script's one-shot. Six fake-timer tests pin
the cadence, the burst collapse, the backoff and its recovery, a nudge that lands mid-pass, the idempotent start and
the stop.

**What the review of this branch caught, and what it changed.** Opus 5.5 at high reasoning reviewed `R1` before the
first push and returned two blockers and five should-fixes. Both blockers were real and both are fixed here:

- _The pane had no data in the running app._ `useHostGroupSnapshot` kept every read in its own state, so the shared
  store that the switch, the summary and every row read was only ever written by the fixture — in the app the section
  said "Reading the mesh…" forever and no row got a badge. Each read and each action now publishes.
- _One pass could hand two machines the same credential._ Upstream's `getOrCreatePendingDevice` reuses one unused
  pending offer per (grants, creator) — right for a QR code shown twice, wrong for a pass that mints once per member.
  Two members shared a device row, so both presented one identity and ejecting either revoked the other's link for
  good while the host still recorded it as active. Each mint is now a fresh row: `createPairingOffer({ fresh })` —
  two declared seams, `pairing-offer-requests.ts` and `runtime-rpc-pairing.ts` — with a test against the real
  `DeviceRegistry` pinning that reuse returns one row and a fresh mint returns two, neither orphaning the other.

The should-fixes, each with the reason it was one:

- **Every local writer now shares one lock** (`host-mesh-write-lock.ts`, the driver and the peer-facing service). A
  pass reads, awaits seconds of network per member, then writes; an Eject or an inbound `remove` landing in that
  window was silently overwritten by the pass's own later write. An inbound call that waits behind a pass merely
  retries — losing nothing — which is the trade this lock makes on purpose.
- **A refusal is a wait, not the end of the launch**, and a transport failure is no longer recorded as a refusal. The
  owner at that machine can turn the mesh on at any time; the retry interval bounds the minting.
- **The backoff actually engages.** The driver catches every member failure per member, so a pass against a sleeping
  fleet returned happily and the loop dialled those machines every minute forever. The snapshot now reports
  `lastPassReached`, the pass doubles its wait when that is zero, and a driver test drives a sleeping fleet to prove
  the number is 0 there and 2 once they wake.
- **A reconnect resets the retry window** (`noteConnectionChange`), so a machine that finishes updating between
  passes is offered again at once instead of waiting out ten minutes.
- **An Eject on the dialled side revokes something.** `offerBack` accepted a caller over a token this host issued and
  then never recorded that row, so ejecting the studio from a work host revoked nothing. It is recorded now.
- **A background pass no longer widens network exposure.** Minting for network reach calls `ensureNetworkExposure`,
  which the design note records as irreversible; that was harmless while only an owner's join minted one, and the
  scheduled pass would have opened a loopback-only host to the LAN with no owner action. The mint now hands back an
  offer at the reach the existing pairing already uses.

The delta re-check then caught two defects those fixes had introduced, both now closed:

- **Two hosts' passes could wait on each other.** Taking the lock in every peer-facing method put the pure reads
  behind the receiving host's own pass: A's pass held A's lock and awaited B's `sync`, while B's pass held B's lock
  and awaited A's `sync`. Both ran out the 20s call timeout, both recorded the other as unreached, and both backed off
  in step. `sync` and `pending` read and reply with no await between them, so they are no longer locked; a driver test
  runs both hosts' passes at once and would hang if they were.
- **A refused offer left a live credential behind.** Fresh mints plus a retry interval means one new row per attempt,
  and nothing revoked the row when the far side said no — a peer with the mesh switched off or on an old build would
  add ~144 never-expiring `workspace` tokens a day. A mesh mint now carries `HOST_MESH_OFFER_TTL_MS`, an explicit
  refusal or `method_not_found` revokes the row it just minted, and a dropped connection does not (the box may have
  arrived and be redeeming), leaving that one to its TTL.

Smaller ones taken as well: the public key is checked before minting (a keyless member got a credential nothing could
redeem), the caller and settings checks run before the box is opened (opening spends a nonce and writes the store), a
nudge that arrives during a pass is kept rather than overwritten by the schedule, a 15s re-read no longer disables the
switch or clears an action's error, a row keeps its Eject when mesh mode is off (that is how an owner who switched it
off can still end a pairing), and the copy and comments that still mentioned a Sync button are gone.

**The five per-rule switches were never in a release.** `git tag --contains 1504c94a167` is empty: `#466` exists only
on an archive branch, so no installed build carries `acceptIntroductions`/`relayIntroductions` and there is no
consent to migrate. A fork-main build that had them reads a settings record without them and gets the one switch,
which is the documented simplification rather than a silently widened permission.

### `local(hosts)`: the fleet every instance sees, and one join that pairs it with all

Two features, one PR: discovery (what each host knows about the machines you own) and the group (join one
member, be paired with every member, so the workspace list is identical everywhere). They are one patch
because discovery without the group gives you a fleet you cannot act on, and the group without discovery
cannot tell you which machines exist.

**Upstream surface: 42 lines across 9 files.** The register is `local/checks/host-mesh-upstream-seams.mjs`,
which is wired into `local/gate-lint.mjs`; it fails when a declared seam grows past its budget, and reports an
upstream-owned file it does not declare as a note. Per-seam resolution notes are in
`local/design/host-mesh.md` § Upstream sync surface. Nothing above upstream's code: the fork's own
`check-upstream-file-comments` ratchet measured 162 of 233 sync conflicts coming from exactly that, so this
patch adds **zero** fork comment lines to upstream files — the register lives here and in the design note.

**The 2026-11-27 sync added six register rows, and none of them is new mesh surface.** That sync brought
upstream's `check:zod-prefer-lazy-ratchet`, whose baseline is 0, and the merge's resolutions had rebuilt this
feature's params files eagerly; the repair re-wrapped them in `lazyZodSchema` as upstream writes them. The
wrapper lines are fork lines on upstream-owned files — the `lazyZodSchema` imports are the sync's own, not
this repair's — so each is declared with the lines it added — `jira/jira-params.ts` 32,
`github-account-binding-params.ts` 21, `claude-oauth-credentials.ts` 18, `projects/repo-params.ts` 12,
`session-list-result-validation.ts` 2, and one row removed from `config/zod-prefer-lazy-baseline.txt`.
Measured: `node local/checks/host-mesh-upstream-seams.mjs --base <the merge commit>` reports **6 upstream
files, 86 lines, every declared seam within budget**.

**Those six budgets are held for a sync repair, and only for that.** Five of the six files are not mesh surface
at all — `projects/repo-params.ts` is host-graph work, where discovery's selectors are declared — and the
register needs a row for each because an undeclared upstream file is what a sync repair would otherwise red
on; there is no "not my feature" escape in the check. So the 86 lines are not allowance for this feature: a
hosts diff that grows one of those files must move its code into a fork-owned module and call it from the
upstream file, exactly as every other seam above does, rather than spend a repair's budget. Each row's `why`
says which file it is and that its budget covers the repair alone.

Where a hook was unavoidable, the upstream line calls a fork-owned module (`installHostMeshRuntime`,
`FORK_RPC_METHODS`, `HOST_MESH_HANDLER_GROUP`, `notifyHostGraphOfConnectionChange`,
`RelayedFleetStatusItems`). Where it was avoidable it was deleted instead: the mesh service is a configured
singleton, so threading it through `RpcContext` would have put this feature into `core.ts`, the admission
prologue, the mobile pairing subclass and the stream options to copy a constant — all four are untouched.

Fork extension points are used as designed: `register-fork-handlers.ts`, `fork-preload-api.ts`,
`i18n/fork/en.json`. The generated RPC param catalog is regenerated, never hand-edited.

**Not upstream-ready, and not proposed upstream:** the mesh assumes every member holds `host-admin` (the
paired-desktop standard), and a group's membership list is not authenticated — the conceded premise of
auto-pairing. Both are in the design note.

**What the fork's own gates made this patch change.** Three ratchets are worth naming, because each one
made this feature better rather than merely compliant:

- `check:recurring-timer-ratchet` refused the renderer's own interval for staleness. It now uses upstream's
  shared clock (`lib/window-activity/use-now`), so the fork adds no timer and staleness still ages.
- `check:main-sync-fs-ratchet` refused two direct `node:fs` probes in the store: an existence check and an
  unused `clear`. Both are gone — a missing file is the reader's ENOENT now, which is also the honest
  reading — and the machine-identity ssh read is async, as its only caller already was.
- `check:main-blocking-helper-ratchet` still counts the store, because it reads and writes one small JSON
  file through **upstream's own** bounded reader and secure writer. Those rows are in
  `config/main-blocking-helper-baseline.fork.txt` with the reason, beside the fork's other data-path rows,
  rather than in upstream's baseline. The store stays synchronous on purpose: a snapshot renders from it and
  the file is a few hundred bytes.

**The max-lines split, and what is left of it.** The fork's `check:max-lines-ratchet` refuses a new
`max-lines` exemption, so the store was split along its real seam — the pending-box mailbox is now
`host-mesh-store-pending-boxes.ts` with the box reader in `host-mesh-store-boxes.ts` — and the store needs no
exemption at all. Two files still carry one, and both are **fork-owned**, so neither can conflict with an
upstream sync:

- `host-mesh-driver.ts` — the local lifecycle of one protocol step: snapshot, join, sync, repair, removal.
  Splitting it means threading the state accessors and the store through a context object into a transfer
  module; that is a refactor of a tested protocol, and it is follow-up work rather than a sync risk.
- `host-mesh-rpc-service.ts` — the peer-facing half: six methods that each run a whole pass on the same store.

Both are declared in `local/lint-known-red.json` with that reason, in the same commit, which is what that file
is for. The debt is named rather than hidden: `local/checks/host-mesh-upstream-seams.mjs` will keep the
upstream surface small either way, and the next person to touch these files should take the split first.

**Why an undeclared upstream file is a note for another feature and a red for this one (2026-11-26).** The
register was failing on _any_ upstream-owned file a diff touched, and `local/gate-lint.mjs` runs it on every pull
request, so from #466's merge the lint gate was red on every branch that fixes an upstream bug — the first one
to run was #471 (`nplez1/issue-96-empty-tabs-state`), whose eight upstream files are a workspace state fix and
not the host group at all. A register cannot demand declarations from features it does not describe, so the
refusal is now scoped to a diff that touches this feature's own code: a `host-mesh`, `host-graph` or `host-group`
path segment that upstream's tree does not have and that is not under `local/` (the ledgers are not shipped code,
and the measured surface ignores them already). That is the only evidence available that a branch is hosts
work, and such a diff still reds on an upstream file it has not declared — the sprawl the check exists to catch —
while another feature's upstream edits are notes. A declared seam over budget fails hard either way.

Three limits worth knowing. A sync **never** derives that strictness, because a sync's diff is upstream's own
work and its resolution touches feature files routinely — `--strict` is how a sync, or a seam-only change
carrying no feature file, is judged. Budgets and seams are measured **per diff**, not cumulatively, so a later
branch can spend a seam's budget again: the register bounds one branch's sprawl, not the fork's total. And the
first cut of this fix keyed on three directory prefixes, which missed `src/shared/host-mesh/`,
`src/main/ipc/host-graph/`, `src/cli/specs/host-mesh.ts` and the renderer's `host-group/` directory — the join
with upstream ownership is what makes a segment check safe, since `host-groups` is one of upstream's own file
names.

Evidence: `node local/checks/host-mesh-upstream-seams.mjs --base origin/main` on #471's tree reported 8 upstream
files / 158 lines and exit 1 before, exit 0 after, `--strict` still 1; and the check's own suite builds a fixture
where a fork-owned `src/shared/host-mesh/` commit plus an undeclared upstream file is a problem, while the same
diff carrying the sync-base record is not. The same change fixes a latent crash: the verbose listing read
`seam.budget` for every touched file, which no run reached while an undeclared file exited first.

### `local(lint)`: the mesh row's upstream surface, measured back down (#492)

The lint gate reddened on #492 at `b4e2b203` (run
[45970908792](https://github.com/nplez1/orca/actions/runs/45970908792/job/140410832857)): `check-host-mesh-upstream-seams`
reported `server-rows/runtime-server-row.tsx` at **21 lines against a budget of 2**, and the same revision measured
locally under the strictness a hosts diff derives reports three upstream files the register did not declare at all —
`src/main/ipc/mobile.ts` (9), `runtime-server-row-menu.tsx` (3) and `host-rows/ServerListRow.tsx` (2). 35 lines of
upstream surface where the register allowed 2, and every one of them a hunk a sync pays for. The feature was right
and the placement was not: the branch had moved Rename and Eject out of two ghost buttons beside the chip and into the
host's overflow menu, which put the dialog's state, the dialog itself and a widened import into upstream's row file.

Three changes, each following the register's own rule ("put what grew behind a fork-owned module"):

- **The row is three lines again.** `mesh-member-affordance.tsx` (fork-owned) exports `MeshMemberAffordance`, which
  renders the chip _and_ the dialogs, and `MeshMemberMenuItems`, which opens them. The menu and the chip slot are two
  slots of upstream's row, so no component of this feature owns both: the open action lives in a module store beside
  the snapshot the group already publishes (`useSyncExternalStore`, a primitive snapshot, so one row opening a dialog
  does not re-render the others). The row renders one element plus one `meshItems` slot, and `budget: 2 → 3` is that
  slot — the only raise here. Both dialogs portal, so the chip slot is a correct place to render them.
- **`mobile.ts` is three lines, not nine.** The expired-offer predicate moved to the fork-owned
  `host-mesh-runtime-grants.ts`, so upstream's file keeps its own import line and swaps one filter argument; five of
  those nine lines were upstream's multi-line import block widening to carry a second name.
- **Two seams declared, not moved.** `runtime-server-row-menu.tsx` (3: the optional `meshItems` slot) and
  `host-rows/ServerListRow.tsx` (2: `py-px`/`leading-4` off the shared chip, so a Mesh, Default or SSH-tunnel chip
  sits at label height — the third complaint recorded in `BRANCHES.md`) have no fork-owned alternative: one is a prop
  on the component that owns the menu, the other is a class string. Both are in the register with a `why`, at their
  measured line counts.

Evidence: `node local/checks/host-mesh-upstream-seams.mjs --base origin/main` on `d423d627dd4` reports 4 upstream
files / 35 lines and exit 1 (one over-budget seam, three undeclared), and exit 0 after, every declared seam at or
under budget and nothing left as a note. The register now declares 22 upstream files / 107 budgeted lines; this
branch spends 11 across four files. `local/design/host-mesh.md` § Upstream sync surface carries the same table.

Anchors: `local/checks/host-mesh-upstream-seams.mjs` (three entries added, one raised),
`src/renderer/src/components/settings/runtime-environments/host-group/mesh-member-affordance.tsx` (the store and the
single element the row renders), `src/main/host-mesh/host-mesh-runtime-grants.ts`, `local/design/host-mesh.md`.

### `local(test)`: the perf contract whose Windows wall clock, not its operation count, reddened the lane

`fork-performance-contracts` reddened on `main` at `767c078fde1` (run
[45683322849](https://github.com/nplez1/orca/actions/runs/45683322849), 2026-11-25): the `windows-latest`
leg failed `src/main/native-chat/agent-session-journal/journal-domain-operation-window.performance.test.ts`
with `Test timed out in 30000ms`, on the test at line 377. The other two legs passed, and the run before
it (11-23) was green because the file had not reached `main` yet — it arrived with the 2026-11-24 sync's
1350 upstream commits.

**Why a timeout, and not a defect.** The contract counts rows returned to our code, never wall clock, and
its fixture is the cost: twelve separate chats of up to 500 turns, ≈3,900 turns × 3 journal applies, each
DB created in `tmpdir()`. That is 1.6 s on this Mac and 33,065 ms on `windows-2022` in the same run —
most likely the temp file's writes and re-reads going through Defender's real-time scan, since nothing in
the product is slow enough to explain a ~20x per-turn cost. The 30 s default is Vitest's, and it is the
only part of that test that is a wall-clock budget.

**What the fork changed**, in the same commit as this entry: two closing `})` lines become `}, 120_000)`,
and each of the two tests carries a one-line reason above it, marked `fork-comment-ok:` so the comment
ratchet does not count it (4763/4763 unchanged). The reason comment is not decoration: the fork's
`test-timeout-needs-reason` ratchet refuses a per-test timeout without one, which is the right rule — it
is what stops a timeout bump from quietly hiding a slow test.

- the test at line 377 of the red run (`stops reading a long send family at its first member older than the newest
  turns`) — the one that failed. **Upstream made this exact call in `7b6c852e2de` (#47789)**, after our
  sync base, and that commit's own comment says the fixture is "about 30s on a Windows runner; it counts
  work, not time". The fork takes the code line only: upstream's comment is not copied, because a fork
  comment above upstream's code is the comment ratchet's growth (`check-upstream-file-comments`,
  4763/4763 unchanged) and this entry is where the reason belongs. **The next sync does collide on that
  hunk**, and the resolution is known: `7b6c852e2de` inserts its comment immediately above the `it(...)`
  where our `fork-comment-ok:` line sits, and its `}, 120_000)` is byte-identical to ours — so keep
  upstream's comment, drop ours, keep the timeout. The collision is one line and its answer is written
  here; that is cheaper than the comment ratchet growth an unmarked copy would have cost today.
- the test at line 270 of the red run (`reads the newest turns with the same work however many turns came before them`)
  — the fork's own call, because it passed on the same runner by 3.5 s: 26,488 ms of the 30 s budget on
  `windows-2022`, and 18,920 ms of it on `ubuntu-24.04` (63%). It is the slowest test in the lane and the
  slowest in this file, so one slower runner reddens `fork-performance-contracts` and the nightly unit
  lane, which runs the same `src/**/*.performance.test.*` glob. Leaving it at 88% of its budget would have
  been a red waiting for the next bad neighbour.

**Not a widened allowlist.** Nothing was added to `local/nightly-linux-known-red.json`,
`local/unit-known-red.json` or the actions-enablement contract; the tests still run on all three legs and
still assert the same operation counts. The anchors are the two `it(...)` titles above — an upstream edit
to either test's body is the only thing that moves them.

The six lines this costs in an upstream file are **not** declared in
`local/checks/host-mesh-upstream-seams.mjs`, and #484 (`local(lint)`, 2026-11-26) is why: that register
describes one feature's surface — the host group's — and from #466's merge it demanded a declaration from
every branch that touched an upstream file, which made the lint gate red for a whole class of unrelated
work. It now scopes the refusal to a diff carrying the feature's own `host-mesh` / `host-graph` /
`host-group` path, and reports another feature's upstream edits as a note. This diff carries no hosts
path, so it is a note — and adding a row anyway would have put a hard budget on a test file that is not
hosts work, re-creating exactly the false red #484 removed for everyone else. Its anchors are the two
`it(...)` titles above.

**Verified:** the file passes locally (7/7, 4.5 s, macOS, `config/vitest.performance.config.ts`), and
both ratchets this change touches are green (`test-timeout-needs-reason`, `check-upstream-file-comments`
4763/4763). The runner that reddened is the one that decides, so the fix was dispatched on the branch
rather than trusted from a Mac. Run
[45783770764](https://github.com/nplez1/orca/actions/runs/45783770764) at `449bc7d866b` — the rebased
branch this entry ships with — is **green on all three legs**: `ubuntu-24.04` 2m7s, `macos-15` 3m45s,
`windows-2022` 2m47s, with the test that reddened taking 26,170 ms and passing. Three dispatches before
the rebase agree: `45780910456` at `803bad1e65f` (26,610 ms), `45780202134` at `41a041bc6f2` (26,777 ms)
and `45779423920` at `12957a82e44` (34,636 ms), each green on all three legs.

Those numbers are the measurement behind the fix. The test that reddened at 33,065 ms against a 30 s cap
has since taken 26.2 s, 26.6 s, 26.8 s and 34.6 s on the same runner — one of four still over the old
cap, and the margin that let the other three through is the coin flip this entry is about.

### `local(test)`: the card test that charged its module graph to a 20s test budget

`fork-main-tests` reddened on `main` at `830852634b4` (run
[45942815750](https://github.com/nplez1/orca/actions/runs/45942815750), 2026-11-27): shard 17/24 failed
`src/renderer/src/components/sidebar/WorktreeCard.merge-marker.test.tsx` with `Test timed out in
20000ms` on the first test, and then failed the second test too, 281 ms later, on an assertion about a
metadata row.

**The cost was the card's module graph, not the assertions.** Each test opened with its own
`await import('./workspace-card/surface/WorktreeCard')`, so the cold transform and load of that graph
was charged to the test's own timeout — and the file's line in the run the night before
([45758341047](https://github.com/nplez1/orca/actions/runs/45758341047), green) is **17,462 ms**. Before
this change on a warm Mac the same file was 1.5 s and its first test alone was 1,506 ms of it: a 20 s
budget against a 17.5 s cost, decided by how loaded the runner is. The renders are milliseconds — the
second test, whose import was already cached, took 3 ms.

**The second failure was the first one's shadow.** A timed-out test body is abandoned, not cancelled, so
the first test's continuation ran during the second, left the module-level `settings` on the experimental
card style, and the default-style metadata row the last assertion reads was never rendered. Test 1 is the
one that covers both card styles; test 2 pins the default style, so its last assertion was the one the
leftover state could break, and one red was reported as two.

**What the fork changed**, in the same commit as this entry: one static
`import WorktreeCard from './workspace-card/surface/WorktreeCard'` replaces both dynamic imports, and the
two `}, 20_000)` timeouts go with them. Module scope has no per-test budget to cross, and both bodies are
now synchronous, so an abandoned body has no `await` to resume from. The tests stay bounded: the project
default is `testTimeout: 30_000` (`config/vitest.config.ts`), which now covers only the renders, and
Vitest compares elapsed time against it after a body returns even where it cannot interrupt one. The file
is fork-added, so this costs nothing in `check-upstream-file-comments` (4,828/4,828) and needs no
`host-mesh-upstream-seams` row; no allowlist moved, and both tests still run and assert the same markup.

**Verified on the runner that reddened.** Dispatch
[45953273363](https://github.com/nplez1/orca/actions/runs/45953273363) at `9a0bd1b944c` — the commit this
entry ships with — is green on all 24 shards, and the file's own line reads **137 ms** for its two tests
where the same line read 17,462 ms the night before. The 17 s did not disappear: shard 17's wall clock is
102 s against 103 s on the green run before it, so the cost moved to the file's collection, where the
shard job's `timeout-minutes: 60` covers it.

**The shard-timing overlay cannot see that move, and the next regeneration will drop this file.**
`local/ci-shard-timings-overlay.json` weighs this test file at 3,894 ms from run 43332008251, and its
metric is the report's per-file `endTime - startTime`, which excludes collection. At 137 ms the file
falls under the 2,000 ms threshold on the next `import`, and `--override` cannot put it back — it refuses
a file `selectEntries` already dropped (`local/ci-shard-timings-overlay.mjs:302`). So the weight has to be
re-added to the JSON by hand with the collection cost, or the metric taught to count collection, before
the shard plan stops reading this file as free. Shard balance rather than correctness, recorded here
because a silent 17 s hole in the weights outlives the reason it was made.

The anchors are the file and its two `it(...)` titles. A future edit that puts an `await` back inside
either body re-creates the exposure this entry removes, charged to the 30 s project default rather than to
a budget sized for the graph.
