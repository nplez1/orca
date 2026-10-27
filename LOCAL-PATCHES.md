# Local patches on `nplez1/main`

This branch is upstream `main` plus a small, deliberate set of changes that exist **only here**.
They are never proposed upstream, and they must never reach an upstream-bound PR branch.

## Rules

- Local commits use a `local(<area>):` prefix so they stand out in `git log`.
- A local patch may only touch files that **no PR branch owns**. Fork PR branches are cut from
  `nplez1/main` and upstream-bound ones from `origin/main`, so a patch can only leak upstream through
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
  upstream's code.
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

### `local(build)`: expect this fork's Developer ID team, not upstream's

Upstream's new `verifyMacTerminalHost` (`config/scripts/macos-terminal-host-bundle.cjs`) compares the
packaged `Orca Terminal Host.app`'s signed team against `ORCA_MAC_TEAM_ID`, which upstream hardcodes
to its own team (`6CX3WHS9HZ`). This fork signs with the Developer ID in `MAC_CERTS`, whose team is
the owner's, so the check failed on the first sync to carry it (np.29). The constant now prefers
`APPLE_TEAM_ID` — the team notarization already has to match the certificate, and present exactly
when `MAC_CERTS` is — and keeps upstream's value as the unsigned fallback.

Anchor: `config/electron-builder.config.cjs`, `ORCA_MAC_TEAM_ID`.

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

**Since the 2026-10-06 sync the live set belongs to a session, not to the process.**
`agent-status-async-subagent-session-source.ts` publishes
`globalThis.__orcaPiAsyncSubagents = { bySession, registration, awaitingSession }`: each factory run
owns its registration, the owning session comes from that registration's own event context, a child
that reports before its session announces itself waits in `awaitingSession` and is adopted only by
the session that names it, and a shutdown closes only its own bus. The `globalThis` home is what lets
a `/reload` — which re-evaluates the module — keep the children a same-file resume expects; it is
deliberately **not** the authority for attribution, because a child bound before its session named
itself would otherwise land in the previous session's bucket.

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
a `Stop`.

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

Scope: a fresh checkout of `nplez1/main` carries the skills; a worktree branched before this commit
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

**Lock ownership.** `isOrcaSkillLockSource` accepts **both** owners, `nplez1/orca` and
`stablyai/orca`. The upstream entry is not compatibility slack: every copy installed before this
patch is locked to `stablyai/orca`, and dropping it would relabel this app's own skills as a third
party's same-named copies, so the review dialog would offer them as **Not from Orca** and never
rewrite them from the fork.

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

Tests that go red if a sync restores upstream's names: `src/shared/agent-feature-install-commands.test.ts`
(the literal fork URL and the pinned-commit pair), `src/shared/skill-freshness.test.ts` (both lock
owners accepted, a lookalike owner rejected), `src/cli/skills.test.ts` and
`src/main/skills/skill-update-run.test.ts` (the executed rail), and
`src/main/ipc/pty-spawn-env-terminal-basics.test.ts` plus
`src/main/ipc/pty-daemon-spawn-agent-home-env.test.ts` (packaged / dev / WSL `ORCA_CLI_COMMAND`).
`pnpm lint` gates the generated content through `verify:bundled-skill-guides` and
`verify:skill-bundle-manifest`, so a hand-edited stub or a stale manifest fails there.

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

Scope: same as `local(skills)` — a fresh worktree cut from `nplez1/main` carries it; a worktree
branched before this commit does not.

### `local(test)`: five more environment-bound reds, recorded from the np.37 full run

The full suite on this machine (macOS, external volume, other agents' runs contending) leaves 26
failing cases in 11 files. Six are the ones already recorded above (the `/private/var` path
signature, the macOS bash 3.2 arrays, the dev-rebuild timeouts, the missing `cloud/` workspace).
The five below are the same class and were classified here rather than chased, each with the
signature that identifies it. None imports a module this fork changed.

- `src/main/cli/packaged-cli-assets.test.ts`, `src/main/orcad/orcad-forked-child-paths.test.ts`,
  `config/scripts/macos-terminal-host-bundle.test.mjs` — `os.tmpdir()` resolves to `/var/folders/…`
  while the code under test reports the resolved `/private/var/folders/…`.
- `src/main/cli/cli-command-privileged-transaction.test.ts` — "Refusing to replace non-Orca command
  at /var/folders/…/protected/orca". **Re-diagnosed and repaired in `local(test)` below, fork issue
  #151 § 4:** the recorded error path is `/var/…`, not `/private/var/…`, and the cause is the fork's
  `orca-np` rename rather than symlink resolution. The entry is gone from the manifest.
- `src/main/sqlite/sync-database-portability.test.ts` ("rejects explicit undefined bindings") and
  `src/main/persistence/profile-state/profile-state-streaming-validation.test.ts` ("cannot add
  rowid alias") — the bundled SQLite's own binding behaviour differs from what those contracts
  assume; neither file is imported by anything this fork touches.
- `src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts` — "Timed out waiting for PTY
  output", the PTY/subprocess class recorded above.
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

- `config/scripts/dependency-security-release.test.mjs` — the audit action's bash step uses
  `mapfile`, and this machine's bash is Apple's 3.2 (`bash: mapfile: command not found`). Same
  signature as `ci-managed-ssh-execution.test.mjs`, which is already recorded.
- `tests/e2e/cross-version-wire/host-model-catalog-released-phone.unit.test.ts` — both cases call
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

The first reconciled run (2026-10-21, `1a64dbe2f6`) found 29 failing cases: 24 allowlisted across nine
files, and two files that are red on their own and so are deliberately **not** listed —
`src/main/ephemeral-vm-runtime-extend.test.ts` (its `vi.mock` for `./ssh/targets/ssh-target-registry`
answered only `getSshConnectionManager`, which is all `ephemeral-vm-runtime-extend.ts:22` imports;
a `vi.mock` replaces the module for every transitive importer, and the modules the real
`./ipc/runtime-environments` graph pulls in read `getSshTargetRegistryStore` through it) and
`src/main/ai-vault/session-scanner-scope-cwd-facts.test.ts` (an `fs` read the test asserts must not
happen does happen). Both reproduce in a scoped two-file run.

**2026-10-21 (the `bbc8303b47` merge) — both are fixed, so nothing is left unlisted.** The ephemeral
mock now answers `getSshTargetRegistryStore: () => null`, the registry's own "no host registered"
answer, so every transitive importer of the mocked module gets the registry's real answer instead of
`undefined`; the session-scanner case passes and was never listed. The merge's own full run
(@`51f09025ca`) passed 134,537 cases with 35 allowlisted failures and **one** unexpected one, that
mock. Eight entries whose failures stopped reproducing were pruned, and
`config/scripts/ci-managed-ssh-execution.test.mjs` was added: the workflow step its cases execute calls
`mapfile`, which macOS's `/bin/bash` 3.2 does not have (the ubuntu runners ship bash 5) — the same
`host-toolchain` class as the `pr-auxiliary-preflight-admission` entries.

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

**Tests.** `tests/tools/gate-unit.test.mjs` (24 cases) covers the fail-closed rules, the record and reuse
decisions, the summary line and the coupling rule; `tests/tools/open-pr.test.mjs` gains the case its
fixtures needed for the gate-inputs contract. #178 had already added `tests/tools/unit-gate.test.mjs` for
the judgement module, so those cases are not duplicated here.

### `local(ratchets)`: `pnpm lint` was red on `nplez1/main` (#161)

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

It is fork-local: upstream keeps `pnpm lint`'s exit code and CI is unchanged.
`tests/tools/lint-gate.test.mjs` covers the chain reader, the per-step failure split and the
classification. There is no per-revision cache, unlike `local/gate-unit.mjs`: the whole chain is
~100–160 s, and a cached verdict would outlive the edit it was computed against. The list is empty
today — the four repairs above make all 32 steps green — and it is the place a future red on the base
branch gets recorded with its evidence instead of being re-derived by hand. This file stays the
evidence and the JSON the assertion, as with the unit red set.

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
b094309766..nplez1/main` does not list it — so it was repaired in the same shape as the two above
rather than recorded.

The first full run after the tightening (`098d3ea4a3`, before PR #177 landed) passed:

```
Unit gate @098d3ea4a3 (clean): PASS — 135786 passed; 31 failed (31 allowlisted, 0 unexpected); 0 flaky re-run passed; 0 unhandled error headline(s); 80 upstream-quarantined file(s) not run; 2 fork-local test file(s) passed; 2472 s
```

No entry was stale and none was unseen, which is the check that the tightening was faithful: the 31
names are exactly the 31 failures, with no wildcard left to absorb an unknown one. The verdict for the
revision that ships is in the PR body, because `local/open-pr.mjs` now requires a cached PASS for the
exact head revision and this file changing is what changes that revision's cache key.

### `local(test)`: gate 1 asks for the full suite only when the change is global

The full unit suite moved off the PR boundary. Requiring it per branch is what produced 257 gate
invocations and 45 runs over four minutes across 47 sessions between 2026-10-21 and 10-24 — 26.9 h of
summed tool wall clock, a median of 28 minutes a run, and one session that spent 10.3 h of a 20.5 h
span inside it. That measurement, per-turn transcript data from `~/.pi/agent/sessions`, is the evidence
for the change; `AGENTS.md` § Verification tiers is the resulting rule.

What replaced it:

- **PR time:** targeted tests for the changed area, `pnpm tc`, `local/gate-lint.mjs`, and the one Opus
  review. No full suite unless the diff carries a global input.
- **`local/open-pr.mjs`:** `needsFullUnitGate(changedPaths)` decides whether gate 1 still demands a
  cached PASS. It fails closed (no changed-path evidence ⇒ full gate) and calls a path global when it
  is `package.json`, a lockfile, `config/**`, a root `tsconfig*.json`, `src/packages/**`,
  `src/shared/**`, or outside the source/test/doc/fork-tooling/workflow trees. Why a fixed list rather
  than `selectUnitFiles`: that needs the reverse-import graph — globs plus the TypeScript API — which
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
that the shim's `VITEST_MAX_WORKERS=2` cap did anything, grepping this repo finds no reader (true — the
reader is Vitest's `resolveConfig`, which assigns `resolved.maxWorkers` from that variable), so the cap
is real and the export stays. It is narrower than it first looked: the fork's custom `node-runtime` pool
never reads `maxWorkers`, and `orca-queue node local/gate-unit.mjs` bypasses the shim entirely, so the
gate's own full run is uncapped — deliberately, since the queue makes it the only heavy run on the box.

### `local(renderer)`: `ai-vault-session-refresh.ts` was over the `max-lines` budget — resolved

The branch tip was red with an unmodified working tree (`oxlint`: 303 lines against a 300 budget,
from `46f640a501`'s refactor rather than a sync), and `pnpm lint` could not pass on any branch cut from
`nplez1/main`. **Fixed in the 2026-10-19 sync** the same way every other overflow on this branch was:
a split, never a cap or a baseline entry. The forced-rescan throttle — `claimAiVaultForcedRescan`,
its retry delay and its test reset — moved to `ai-vault-forced-rescan-throttle.ts`, with
`markForcedRescanSpent()` and `forcedRescanRetryDelayMs()` as the new edges the hook and the tab-bar
switch call. `tab-session-history-switch.ts` and three test files import from the new module.

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

- `src/shared/jira-transition-fields.ts` — `JiraTransitionRequirement` has **no `unsupported` kind**.
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
- `src/shared/jira-transition-fields.ts` — `rejectedTransitionFieldKeys` lets a rejection undo a skip.
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

Tests that pin the new behaviour: `src/shared/jira-transition-fields.test.ts` (a filled field is not
asked, resolution/comment still are), `src/main/jira/jira-transition-required-fields.test.ts` (the
value read and its failure path), `task-page-jira-board-view.test.tsx` / `jira-issue-transition-control.test.tsx`
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
- `src/renderer/src/components/task-page-jira-create-fields.ts` — the array branch submits `{id}` per
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

Reproduced 2026-10-22 against `src/renderer/src/components/JiraIssueWorkspace.transition-source.test.tsx`
by appending a deliberate `findByPlaceholderText` timeout: in the bun pool → EISDIR, no test named; the
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

### `local(lint)`: upstream's `max-lines` budget is enforced again, with 8 exemptions

**Reversed 2026-10-27, with the measurement that reversed it.** This section used to record the cap as
`"off"` in the four overrides that carried 300/400/600/800. That worked and cost more than it saved:
with the rule off, two of upstream's own coverage tests in
`config/scripts/check-max-lines-ratchet.test.mjs` fail (they assert the installed oxlint still flags an
over-budget file), and the ratchet script — whose whole job is to freeze who may bypass the rule —
becomes inert. So the fork was paying four changed lines in a file upstream owns _and_ a red gate, to
avoid an exemption list.

The exemption list turned out to be short. With upstream's rule restored, **nine files** exceeded
budget: eight upstream-owned, over by 1, 3, 3, 9, 20, 23, 31 and 34 lines, and the fork's own
`local/sync/conflicts.mjs` at 682. The fork's file was split (`local/sync/lib/conflict-report.mjs`,
leaving 568); the eight upstream files each carry one `eslint-disable max-lines -- Why:` line naming
what the fork adds, with a matching `config/max-lines-baseline.txt` row. Splitting an _upstream_ file to
fit the budget would be the eviction this section exists to stop — a permanent hunk on every sync.

So: upstream's rule, upstream's ratchet, upstream's baseline, 12 grandfathered entries of which four are
upstream's own. `.oxlintrc.json` is byte-identical to `0571e45107` again, both upstream tests pass, and
the ratchet reports `OK — 12 grandfathered entr(y/ies)`. What this does **not** do is undo the evictions
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

Then `node config/scripts/check-max-lines-ratchet.mjs` (expect `OK — N grandfathered entries`) and
`pnpm test config/scripts/check-max-lines-ratchet.test.mjs` for upstream's own coverage. A row whose file
the fork later slims back under budget is reported stale by `--prune`, so the list shrinks on its own; it
should never need to grow without a reviewer saying yes.

The eight fork exemptions are listed in `config/max-lines-baseline.txt`, and each file carries its own
`-- Why:` naming what the fork added there — deliberately, so the reason travels with the code and cannot
drift away from the file the way a list in this document would.

### `local(test)`: the gate judges a merge by the merge's own diff

Three fixes with one cause: a signal that was **absent** was read as a signal that was satisfied.

- `local/gate-unit.mjs` `branchDiff()` treated an empty diff as a resolved one. A sync merges upstream
  _onto_ `nplez1/main`, so `merge-base(nplez1/main, HEAD)` is HEAD itself, the diff is empty, and
  `flakeWaiver` reads "nothing coupled was touched" — waiving every flaky pass on a line a 556-commit
  merge had just built. That is the release line, which is where the gate runs. An empty diff now falls
  back to the merge's first parent (`HEAD^1..HEAD`, what that merge contributed) and to `unknown` when
  there is nothing to compare against, and `unknown` never waives. The `7811f60dd6` PASS above — "1
  flaky re-run passed" — was judged the old way, immediately after a 556-commit merge.
- `local/unit-known-red.json` entries carry an optional `match` regex, tested against the first line
  of the failure. Without it an entry matched on file and title alone, so an allowlisted test that
  started failing for a **new** reason stayed "known" for as long as its title did. 9 of the current 17
  are pinned, each to a signature the failure text actually carried in the `8da9849c43` run; the rest
  keep matching on title alone because their text is a generic deep-equality diff, and guessing a
  signature there would turn a known red into an unexpected one. (Counts move as entries are pruned; the
  file is the number, not this line.)
- `config/scripts/check-changed.mjs` resolved its base as `origin/main`, which on this fork is
  **upstream's mirror** — so the pre-handoff gate diffed the fork's whole 2,846-file delta instead of
  the branch's own. `origin/HEAD` now comes first, as it already does in the sibling
  `check-changed-code-quality.mjs`.

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

**What the first real runs measured.** The 2026-10-26 scheduled run (id `40308443374`) is unusable as a
red set: its cancel rewrote the run-level conclusion, so a reader saw four red shards and no verdict.
The cleaner measurement is the 2026-10-27 dispatch (id `40460070298`, tree = `nplez1/main` plus this
repair): five shards, **three green**, and three red files in total —
`rate-limits/service-inactive-claude-cooldown.test.ts`, `daemon/daemon-appimage-copy-host.electron.test.ts`
and `daemon/daemon-electron-to-node-adoption.electron.test.ts` — plus one unhandled error,
`selector_not_found`.

**All three were the branch gap, not the platform.** Each maps onto a commit that exists here and not on
`nplez1/main`: the cooldown expectation (`ba8e632509`), the fixture's esbuild specifiers
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
review) are the only thing standing between a change and `nplez1/main` — nothing in CI backstops a
skipped run. Since 2026-10-24 the full unit suite is therefore not a PR gate at all; it runs nightly on
`fork-main-tests.yml` and again at the release gate, and the failure window that choice accepts is a
cross-cutting break sitting on the release line until one of those two runs.

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

`pnpm test src/main/runtime/orca-runtime.test.ts` — before: 2 failed and 1 unhandled error; after:
`1520 passed | 3 skipped`, green on three consecutive runs. Every cached verdict under `orca-gate/`
mentions `selector_not_found`, so this was persistent rather than a one-off.

**Every other `macos-path-semantics` entry was the same defect, and they are all fixed.** Nine cases
across five files, each creating a temp dir with `mkdtemp(tmpdir())` and comparing it against a path the
subject had resolved — the darwin launcher's `cd -P`, orcad's deploy root, a spawned child's reported
cwd. Each now resolves its temp dir first:
`orcad-forked-child-paths.test.ts` (4), `cli/packaged-cli-assets.test.ts` (1),
`config/scripts/verify-cli-bin.test.mjs` (1), `config/scripts/macos-terminal-host-bundle.test.mjs` (1).
The `orca-runtime` pair above is the other two.

Every one of those four files is otherwise byte-identical to `upstream/main`, so each is a fork-local
test fix that will conflict once, benignly, when upstream makes the same change — the same trade
upstream itself made in #33540. **The class is now empty**: 40 entries at the 2026-10-26 baseline, 17
today, and all 17 are `host-toolchain` (8) and `sqlite-binding` (9) — a different machine's different bun
and SQLite, which is not something this fork can fix in a test. The `host-toolchain` entries that were
bash 3.2 rather than bun or SQLite are gone with the bash install recorded above.

## Syncing with upstream

**The full procedure is [UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md)** — "sync upstream
main" means that document, start to finish. What matters specifically for the patches below:

```bash
git fetch upstream
git checkout nplez1/main
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
git range-diff --no-patch <old-base>..<old-tip> <new-base>..nplez1/main
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

- **2026-10-25 — merge of upstream `0571e45107` (556 commits) into the release line, from
  `095cf32705`** (merge base `57b5082404`, rollback tag `archive/pre-sync-095cf32705`, merge commit
  `281cccf5a4`, then `995f2dbc27`, `ef2897da2b`, `accb095dd6`, `7811f60dd6`, `1b848feba6`).
  **249 conflicted paths, 367 hunks** — `both-rewrote 167, union 47, modify/delete 23,
  duplicate-tail 8, rename-replay 2, duplicate-members 1, add/add 1` — four to five times the
  previous two syncs (52 and 63 paths). Upstream's delta is 11,612 files (−290,038/+189,207); most of
  the deletions are the `docs/audits/**` JSON upstream removed. Substantively it is a **mass
  comment-terseness pass** plus regroupings — `src/main/ipc/filesystem-watcher-*` into
  `src/main/ipc/filesystem/watchers/`, `shared/jira-*` into `shared/jira/`, several
  `src/main/runtime/` groups — and ~50 test inventories retired. The terseness pass is why
  `both-rewrote` dominates: upstream rewrote the comments around nearly every fork hunk. Decisions
  are in [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-25 sync";
  the ones a reviewer will want first:

  - **Resolved in three tiers, and most of it by proof rather than judgement.** All 367 blocks were
    machine-verified against their recorded base/ours/theirs before any was touched. **215 hunks
    mechanically:** 133 where upstream never touched the region (ours), 50 where ours differed only
    by identity tokens (theirs, and `identity-sweep` re-applies the identity), 32 import-only.
    **85 by direct decision** — `ORCA_SKILLS_REPOSITORY_URL` stays `nplez1/orca`, the identity-aware
    `OrcaBundleIdentity.isTrustedPeer`, `listCached`, the both-owner skill-lock acceptance, the
    schema version below. **67 by an Opus review pass** over the both-rewrote cluster. Reuse this
    shape at the next large sync: the proof tier is what made 249 paths tractable.
  - **`SESSION_SEARCH_SCHEMA_VERSION` is 10.** The fork had gone 6 → 9 and upstream 6 → 8, so the
    merged schema takes a version above every one either line has shipped (runbook trap 8), not the
    higher of the two.
  - **The pi compaction guard reads the fork's async lane; `isHeldByChildren()` is unchanged**
    (`ef2897da2b`). Upstream's new test expects a finished reply's compaction not to be announced
    while children run, and upstream fills `lifecycleState.active` from the roster lane — but this
    fork routes the async channels to its own lane (`agent-status-async-subagent-source.ts`) and
    keeps them out of that set. The compaction guard alone now also consults
    `piAsyncSubagentHasLiveRuns()`. `isHeldByChildren()` also gates `postAgentEndOnce`, and the fork
    posts `agent_end` while async children run so the host holds the pane from `subagent_runs`;
    feeding the async lane into `onEvent` instead broke 27 fork tests that pin that separation.
  - **Computer-use identity converges on the fork's `OrcaBundleIdentity`** (`accb095dd6`). Upstream
    added `TrustedOrcaApplication.swift` for the same job; the fork's helper is identity-aware
    (`com.nplez1.orca`) and `main.swift` already calls it, so upstream's unreferenced duplicate is
    deleted with its test. Its `com.stablyai.orca` literals are also what the fork's "leaves no
    pre-rename bundle id in any helper source" test forbids.
  - **Derived files were regenerated, not merged.** `en.json` by a three-way JSON merge (0 true
    conflicts; 736 fork strings kept, 245 upstream keys added, 96 dropped), then
    `en-runtime-required.json`, `bundled-skill-guides.ts`, `focus-setting-read-baseline.txt`
    (`--prune`, 718 → 690 reads) and `pnpm-lock.yaml`.
  - **Ten defects the merge introduced with no conflict marker**, all fixed:
    `emitWorktreeLifecycle` never reached the fork's extracted project-group controller
    (`orca-runtime-owned-controllers.ts`), so `deleteFolderWorkspace` threw; `run-process-sync.ts`
    missed `captureStderrAsBytes`; a fork-only real-git test never got upstream's worker-thread
    child-process fixture; a filesystem test's mock path did not follow its file into
    `ipc/filesystem/`; four suites got upstream's `orca-dev`/`.orca` back over
    `orca-np-dev`/`.orca-np`; `markKimiWorkspaceTrusted` became async under callers that did not
    await it; the conflict check slipped behind the merge-queue branch, so a conflicting PR on a
    merge-queue branch was offered "Merge when ready"; `autoMergeActionWhenDirectMergeAvailable`
    lost both call sites; a Jira user field with a fixed choice list rendered as a text box; and the
    skill bundle manifest arrived built from upstream's skills. `995f2dbc27` separately restored nine
    files where a repair script had rewritten `./src/main/...` inside esbuild `stdin.contents`
    templates — cwd-relative strings, not imports.
  - **Lost or diverged, stated plainly.** `src/shared/skill-freshness.ts` was fork-only — upstream
    deleted the module and the renderer owns those types — and it is **now deleted too** (2026-10-27):
    its both-owner lock-source rule had stopped being on a live path, nothing but its own test imported
    it, so keeping it recorded a rule the app no longer applied. Six fork-only exports
    upstream's refactors superseded are acknowledged, with their live replacements, across five paths
    in `local/sync/expected-deletions.json`. The onboarding test lost its `nplez1` URL assertion.
    `worktrees:listAll` went with the IPC surface upstream dropped; `listCached` stays, live in
    `startup-worktree-cache.ts`.
  - **Environment, not code: `origin/main` had never existed in this clone.** `gate-lint.mjs`'s
    flaky ratchet scopes to `merge-base HEAD origin/main`, so the base fell back to a far older
    commit and every fork-only test looked changed (28 spurious reds). `git push origin
    upstream/main:main` created the branch, and `remote.origin.fetch` gained
    `+refs/heads/main:refs/remotes/origin/main` and
    `+refs/heads/upstream/*:refs/remotes/origin/upstream/*`.

  Verified on `7811f60dd6`: `Unit gate @7811f60dd6 (clean): PASS — 138072 passed; 41 failed (40
  allowlisted, 0 unexpected); 1 flaky re-run passed; 0 unhandled error headline(s); 2575 s`;
  `lint gate @7811f60dd6+dirty: PASS — 39 green, 0 failing: 0 known red, 0 new; 39 steps; 103.7 s`
  (the dirty part became `1b848feba6`); `pnpm tc` clean on node, cli and web. Nine allowlist entries
  were added — see § "`local(test)`: the 2026-10-25 sync's red set" — and the unit lane now runs
  upstream's `--experimental.recordDependencies=false`. The tagged revision is past the gated one:
  `1b848feba6` changes only tests, e2e specs and two lint inputs (no product source), and the
  docs-only sync record follows it, so the unit verdict does not cover `1b848feba6`'s test edits.

- **2026-10-22 — merge of upstream `57b5082404` (268 commits) into the release line, from
  `c67d40f97b`** (merge base `bbc8303b47`, rollback tag `archive/pre-sync-c67d40f97b`, merge commit
  `05b4768249`). **52 conflicted paths** — `union 22, both-rewrote 20, modify/delete 5,
  duplicate-members 2, rename-replay 2, duplicate-tail 1`. Upstream's delta is a reorganising sync
  rather than a product wave: `src/main/ephemeral-vm/` and `src/main/ipc/jira/` groupings,
  `jira/attachments/`, the mobile chat helpers renamed page → scroll, the `task-page/gitlab/` group,
  an off-by-default `experimentalConnectors` flag and a Brazilian Portuguese locale. No patch in the
  series needed a behavioural change; the cost was renames with no conflict marker. Decisions are in
  [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-22 sync"; the ones
  a reviewer will want first:

  - **The ephemeral-VM grouping is upstream's, and the fork's four modules stay flat.**
    `src/main/ephemeral-vm-recipe-runner.ts` (a three-line barrel over shared modules) is deleted as
    upstream deleted it; the fork's extend/context-menu/lock/reclaim modules stay where they are
    because they are fork-only and never collide. Every fork importer followed the moves
    (`./ephemeral-vm-runtime-service` → `./ephemeral-vm/runtime-service`, and five more).
  - **Jira's register file is upstream's per-module split plus the fork's three additions.**
    `registerJiraBoardHandlers()`, the `jira:listEditFields` handler and the second `normalizeIssueUpdate`
    narrower ride on `ipc/jira/register-handlers.ts`; the fork's `jira-rendered-html.ts` followed the
    `jira/attachments/` renames with no conflict to point at it.
  - **`queueWorkspaceDelete` lands inside the fork's extracted `worktree.rm`.** Upstream routes the
    delete through the workspace lifecycle queue; the fork had extracted the method for max-lines.
    Both stay, and `deleteRemoteBranch` rides through the `run` callback rather than a sixth
    `RemovalFlag` — while the lifecycle delete **key** is widened with it, so a retry that asks for
    the other remote-branch choice cannot join the pending delete's reply. On the renderer side, `confirmedDiscards` is computed inside
    `useDeleteWorktreeDialogActions` from an `unsavedTargets` argument.
  - **The agent-hook guards stay and carry upstream's `incomingProcess`.** `isInheritedPaneOwnerEvent`
    gained the parameter and forwards it to `resolveAgentStatusIdentity`; `readAgentProcessIdentity`
    is upstream's `readHookAgentProcess(source, record.agentProcess)`.
  - **The popout window stays deleted.** Upstream's three fixes to `dashboard-popout-window*` and
    `useDashboardPopoutBridge` are taken as deletions, per the dashboard decision above.
  - **`en.json` was unioned, then regenerated.** 15 conflicting leaves: 8 kept the fork's text (the
    `~/.orca-np` paths, the floating-workspace copy, the dashboard description, the Jira-aware
    issue-link copy, the provider list), 7 took upstream's. `sync:localization-catalog` added the 8
    keys the merged source needs. **Found here:** `jira.board.noTransition` carried two different
    sentences, so the placeholder-less one is now `jira.board.noTransitionSelected` — that file is
    also the red-flag scan's one "modified, upstream never touched it" entry.
  - **Two max-lines splits and a re-pruned ratchet.** `orcad-entry.ts` yielded
    `orcad-secret-store-bootstrap.ts`; the pi harness yielded `agent-status-extension-test-env.ts`.
    The focus-read baseline was pruned against upstream's removal of the runtime Jira/Linear reads
    (1161 → 718) and the fork's two documented transitive readers were restored with their causes.
  - **Four merge breaks with no conflict marker**, all now fixed and each named by `pnpm tc`: the
    test store lost `createWorktreeSetupRunnerSlice` under upstream's `withEditorBufferRecords`
    wrapper, the browser new-tab caller missed the review hook's new required `issueRepo` /
    `issueRepoIsOffDevice`, the two disposition tables needed three new fields classified
    (`experimentalConnectors` replicated, the Portuguese migration marker host-local, the closed-pane
    session field host-local), and a test mocked the SSH filesystem provider upstream deleted.
  - **Three upstream renames are acknowledged in `expected-deletions.json`** (mobile page → scroll,
    the task-page GitLab loading hook), and the two entries whose deletions left the range are pruned;
    `TaskPageGitLabLoadingModel` has no importer in the merged tree, which is why its absence is not a
    loss.

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

The three jobs are **serialized** (`linux: needs: windows`, `windows: needs: macos`) because every
leg appends into one release and electron-builder decides create-vs-append at upload time. The
`macos` job creates the draft, and the undraft is the last step of the last leg — so "published"
means every platform's update manifest exists, and each leg asserts its own (`latest-mac.yml`,
`latest.yml`, `latest-linux.yml`).

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
  `already_exists`) could not be retried as they stood; each leg now clears its own assets first via
  `.github/actions/clear-release-assets`, matched by name so one leg never deletes another's.

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

**Live on purpose — these three must stay enabled:**

- `fork-release.yml` — `workflow_dispatch` only; the feed the patched updater points at.
- `fork-upstream-tags.yml` — the daily `v*` tag mirror (see above).
- `fork-main-tests.yml` — the nightly full unit suite, enabled 2026-10-24. Its last passing run is
  2026-10-08, from before it was disabled in the fleet sweep and re-enabled on 10-24; the first
  scheduled run after that (10-26) wedged, which is why the absence below starts at 10-08 rather than
  at 10-24. This is the backstop the
  PR gates gave up (`AGENTS.md` § Verification tiers). It is in `local/check-actions-enablement.mjs`
  `REQUIRED`, not `ALLOWED_INERT`: it has a `schedule`, so "disabled" is drift and should be reported
  as `MISSING`, not silently tolerated. Billing is ~50 min a night because five shards bill
  concurrently — ~1,500 min/month against the account's ~10,000, which is the accepted cost. Check the
  real figure with `gh api repos/nplez1/orca/actions/workflows` and the run history before adding any
  further lane; the whole fleet being on is what burned nearly the full month in a few days.

**Also left enabled, and inert without a manual dispatch:** `zcode-account-contract.yml`,
`unit-module-cache-benchmark.yml`, `windows-native-preparation-benchmark.yml`, and the three
`cloud-operate-relay-*` flags/watchers. `ci-cache-warmup-platform-jobs.yml` is `workflow_call`-only,
so it runs only when `ci-cache-warmup.yml` does — and that one is disabled.

Everything else is `disabled_manually`. As of 2026-10-19 that includes `pr.yml`, `unit-tests.yml`,
`e2e.yml`, `mobile.yml` and `fork-main-gates.yml`. `fork-main-tests.yml` is the exception above: it is
live, and the section below is why its being live was not the same as its running.

**A sweep is never complete, and the first one wasn't.** Nine workflows survived it on 2026-10-19 —
eight still triggering on `pull_request` (`wsl-orcad-e2e`, `win-orcad-serve-switch-e2e`,
`windows-typecheck-parity`, the three `preflight-*`, and the two `zcode-*-contract`) plus
`ci-cache-warmup-platforms` on `push: [main]`. They surfaced as two mystery checks on PRs #146/#147
— the WSL orcad lane, triggered because both touched `src/main/pi/**`, a path in its filter. So
after any sync that adds workflows, re-run the listing above rather than assuming the sweep still
covers the tree.

### `local(hooks)`: refuse fork-only commits on an upstream-bound branch

`.husky/commit-msg` refuses any commit whose subject starts with `local(` unless the branch carries
`nplez1/main` in its history. Upstream-bound branches are cut from `origin/main`, so a fork-only file
committed to one is reviewed upstream. It is `commit-msg` rather than `pre-commit` because the message
is what identifies the commit as fork-only, and `pre-commit` cannot see it.

**Scoped to lineage on 2026-10-27, not to a branch name.** The original rule allowed `local(` on
`nplez1/main` and nowhere else, which included fork PR branches — and the result was worse than the
mistake it guarded: policy work committed there _without_ the `local(` label at least five times
(#146, #130, #142, #177, #52), producing unlabelled fork-only changes riding fork PRs. A fork PR
branch descends from `nplez1/main`; that lineage is what the rule now follows, so `local(` is allowed
on the fork's own line and still refused on anything cut from `origin/main`. `local/open-pr.mjs
--upstream` remains the second stop, refusing the subject and every fork-owned path.

If a commit is wrongly refused, the fix is to branch from `nplez1/main`, not to bypass the hook.

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

- **`linux.executableName: 'orca-ide'`** and the bundled launcher file `resources/bin/orca-ide`.
  `LINUX_CLI_COMMAND_NAME` and the AppImage cache layout resolve that exact path, and the _installed_
  command is already `orca-np` (`CLI_COMMAND_NAME`) — so renaming the in-bundle file would touch
  app-side CLI registration and its AppImage tests for no gain. The directory differs from an
  official install's, so nothing collides. Pinned by `config/scripts/electron-builder-config.test.mjs`.
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

Files touched by the rename, so a sync can recheck them: `config/electron-builder.config.cjs`,
`resources/linux/packaging/after-install.sh`, `resources/linux/packaging/after-remove.sh`,
`config/scripts/electron-builder-config.test.mjs`, and the two package-name literals in
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
