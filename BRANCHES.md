# Branch tracker

Last updated **2026-10-22** — `nplez1/main` merged upstream main @ `57b5082404` (268 commits) from
`c67d40f97b` (merge `05b4768249`, merge base `bbc8303b47`, rollback tag
`archive/pre-sync-c67d40f97b`). 52 conflicted paths, and no add/add this time: `union 22,
both-rewrote 20, modify/delete 5, duplicate-members 2, rename-replay 2, duplicate-tail 1`. Upstream's
delta is mostly **module reorganisation** rather than product work — the `src/main/ephemeral-vm/` and
`src/main/ipc/jira/` groupings, `jira/attachments/`, the mobile chat helpers renamed page → scroll,
the `task-page/gitlab/` group — plus an off-by-default connectors flag, growth in the English runtime
catalog and the new Brazilian Portuguese locale. The renames are what cost the time: the fork's own
flat modules, its extra Jira/board handlers and `en.json` all had to follow them with no conflict
marker pointing at them. Decisions are in
[local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-22 sync", and the
sync log in [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) names each resolution.

Before that, on **2026-10-21** — `nplez1/main` merged upstream main @ `bbc8303b47` (418 commits) from
`43fa95b4cf` (merge `276fe47cee`, merge base `83c768d1b4`, rollback tag
`archive/pre-sync-43fa95b4cf`). 63 conflicted paths, mostly upstream product work rather than a
reorganisation: the SSH settings screen became a grouped/windowed multi-select list, the MiniMax and
GLM accounts sections became host-aware components, queued-message editing grew images, the Agent
Dashboard became a first-class view, and four lint ratchets were added. Two file pairs were
**add/add collisions** — `SshTargetList.tsx` on each side was a different component, and
`AccountsPane.test.tsx`'s MiniMax half — so read [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) § Sync log
before touching either. See [local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) §
"2026-10-21 sync" for the decisions.

Before that, on **2026-10-19** — `nplez1/main` merged upstream main @ `83c768d1b4` (170 commits) from
`cc42fb3b93` (merge base `fc24ac3715`, rollback tag `archive/pre-sync-cc42fb3b93`). 52 conflicted
paths, mostly upstream's own module reorganisation: the SSH tree split into
`ssh/connection/`, `ssh/targets/` and `ssh/config/`, the filesystem-watcher and runtime-environment
modules split, and the locale/markdown helpers moved to `shared/`. Fork-owned files that nobody
conflicted on had to follow those renames — see [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) § Sync log for
the full list of what the merge broke without a conflict marker.

Before that, on **2026-10-18** — `nplez1/main` merged upstream main @ `fc24ac3715` (628 commits) into
the release line from `12545ad17e` (merge `db746c211b`, rollback tag
`archive/pre-sync-12545ad17e`). 89 conflicted paths, and the convergence was three seams rather than
one product line: the **AI Vault parse cache moved onto upstream's SQLite database** (the fork's
JSON snapshot serializer is deleted, and the one-shot legacy importer accepts the last JSON schema
each line shipped, 4 and 6, so a fork install keeps its cache), the **sidebar row model became
upstream's object plan with its shared modules moved into `src/shared/sidebar-list/`** (the fork's
`mergeSameBranchRows` is unchanged and runs on the rendered rows), and **`setupScriptLaunchMode` was
deleted outright**, leaving the fork's `new-tab` behaviour as the only shape. See
[local/sync/convergence-ledger.md](./local/sync/convergence-ledger.md) § "2026-10-18 sync" for the
decisions and [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) § Sync log for what this one cost.

The PR branches below were cut from older release lines, so every one of them now needs its own
catch-up against this merge before it can be opened — `local/open-pr.mjs` refuses a head that does
not descend from its base, and a branch whose base moved needs the new base folded in first.

**Branch measurements could not be re-taken in this worktree.** The PR-bound branches are not
fetched here, so `node local/branch-status.mjs` reports every one as `MISSING locally` and the
merge-base/behind figures below are still the 2026-10-13 measurements. Re-run the script from a
worktree that has them before trusting the numbers; the merge moved the shared ancestor, so every
branch's behind-count has grown by this sync's 311 commits plus the fork's own.

The live table — SHAs, whether the fork has each branch, each branch's own delta, and its PR state —
is generated, not kept by hand:

```bash
node local/branch-status.mjs
```

Run it first. This file records what that script cannot know: **why each branch exists, what it
depends on, and what is blocking it.** If the two disagree, the script is right.

## Rules that keep this from rotting

- **Where a PR goes is a decision, not a default.** Unless upstream is asked for in so many words,
  a PR opens against this fork (`nplez1/orca`) with base `nplez1/main` — the fork's default branch.
  `stablyai/orca` is the target only for the upstream-bound branches listed below, and only when
  that is what was asked for. `node local/open-pr.mjs` applies the default and requires an explicit
  `--upstream` to leave the fork.
- **A PR's head must descend from its base.** The two branches called `main` here are different
  lines: `nplez1/main` is this fork's own line, `main` mirrors upstream. A head cut from `main`
  and opened against `nplez1/main` reads as a small diff locally, but the PR then carries every
  fork-only patch as a reversion. Fork PRs are cut from `nplez1/main`; the upstream-bound branches
  below are cut from `origin/main`, which is the base they are opened against. `open-pr.mjs`
  refuses the mismatch instead of letting review find it.
- Upstream-bound PR branches are cut from `origin/main`, **never** from `nplez1/main`. That is
  what makes it impossible for a fork-only patch to leak into an upstream-bound PR.
- A `local(...)` commit is refused on every branch except `nplez1/main` (`.husky/commit-msg`). If it
  fires, switch branches — do not bypass it.
- A fork-only patch may only touch files that no PR branch owns. `package.json` and the
  rebuild-and-relaunch script are the current examples; see [LOCAL-PATCHES.md](./LOCAL-PATCHES.md).
- One commit per topic on a PR branch, message in the repo's conventional style, and the branch must
  typecheck on its own (or its parent must be named below).

## Dependency graph

```text
origin/main
├── fix/cli-symlink-world-readable          ← PR #20813 (open)
├── fix/copilot-background-work
├── fix/repo-catalog-connection-fence
├── fix/claude-codex-enterprise-accounts
├── feat/copilot-usage
├── feat/deepseek-usage
├── feat/fireworks-usage
├── feat/startup-service-ordering
├── fix/agent-status-routing-readiness
└── feat/worktree-scan-cache-persistence
    └── fix/terminal-session-reconnect
        └── feat/startup-worktree-hydration

nplez1/main  ── this fork's own line: everything above, plus fork-only patches
                └── nplez1/Hide-hosts
                └── nplez1/Bundled-Skills-Target
                └── nplez1/issue-151
```

`nplez1/Bundled-Skills-Target` carries fork issue #99 plus the install half of #94: the published
skill stubs resolve `orca-np`/`orca-np-dev` instead of a bare `orca`, managed PTYs export
`ORCA_CLI_COMMAND`, and the install/update rail plus the freshness lock source name `nplez1/orca`
while still recognizing `stablyai/orca`. It is fork-only by design — upstream publishes the
upstream names — so it lives in [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) § `local(skills)` and must land
on `nplez1/main` before its content reaches any build, because the pin is the build's own commit.

The three-deep chain is real, not cosmetic: `startup-worktree-hydration` needs the
`WorktreeApi.listCached` method that `worktree-scan-cache-persistence` adds **and** a store action
that `terminal-session-reconnect` adds. Splitting it further would mean duplicating code to hide the
dependency, so the three want to land in that order.

## Base drift — recorded, not fixed

**2026-10-16:** the same two fork PRs (`#109`, `#110`) are still open and now sit two syncs behind:
they were cut before the 2026-10-15 sync, and `nplez1/main` has since moved to `ae9db02137` plus
this sync's repairs. Neither was rebased. `#20813` and every unopened branch below are where the
2026-10-13 measurements left them — re-measure rather than trusting a figure in this file.

**2026-10-15:** two fork PRs are open against `nplez1/main` and were cut before this sync, so they now
sit on `bb043b9724` and need a catch-up merge before they can be updated — `#109`
(`nplez1/automations-project-scope`) and `#110` (`nplez1/automations-create-by-desc`). `nplez1/main`
itself moved to `79d7351d64`; a PR head that does not descend from it is refused by
`local/open-pr.mjs` rather than reviewed.

After the 2026-10-13 sync, **every PR-bound branch still sits on a pre-sync base** — none of them
was rebased this time either. `#20813` is open and was deliberately left where it is; the rest are
unopened. Measured by merge-base against `upstream/main` on 2026-10-13:

- the **seven PR-bound branches** (`fix/cli-symlink-world-readable`, `fix/copilot-background-work`,
  `fix/repo-catalog-connection-fence`, `fix/claude-codex-enterprise-accounts`, `feat/copilot-usage`,
  `feat/deepseek-usage`, `feat/fireworks-usage`) sit on `560c42e1d1`, **2818 commits behind**;
- the **five deliberately-left ones** (`feat/worktree-scan-cache-persistence`,
  `fix/terminal-session-reconnect`, `feat/startup-worktree-hydration`,
  `feat/startup-service-ordering`, `fix/agent-status-routing-readiness`) sit on `615b1370fb`,
  **2912 commits behind**.

The two merge-bases have not moved since 2026-10-01 — the branches really are untouched, only the
behind count grows (1141→2818 and 1235→2912 across four upstream syncs).

Re-measure rather than trusting those numbers (`node local/branch-status.mjs`, and merge-base against
`upstream/main` for the behind count, which that script does not print). `origin/main` was
fast-forwarded to the new base (`a5601375d4`) at push time in this sync, so it is no longer the thing
holding the seven PR-bound branches back — their own base is.

**Five branches were deliberately left on the pre-sync base**, all unopened:

- `feat/worktree-scan-cache-persistence` → rebase onto `origin/main`
- `fix/terminal-session-reconnect` → rebase onto `feat/worktree-scan-cache-persistence`
- `feat/startup-worktree-hydration` → rebase onto `fix/terminal-session-reconnect`
- `feat/startup-service-ordering` and `fix/agent-status-routing-readiness` → independent, rebase onto `origin/main`

**The trap:** the three chained branches must be rebased **parent first**. Each child's diff is
measured against its parent, so rebasing a child onto `main` would attribute the parent's files to it
and corrupt both the diff and the PR.

This is not urgent — none of the five is open, and the plan is not to open them until #20813 lands.
Run `node local/branch-status.mjs` for the current numbers rather than trusting a SHA written here.

## Branches

### fix/cli-symlink-world-readable — PR #20813, open

- **Why:** macOS published the privileged `/usr/local/bin/orca` shim as `0700`, so `readlink` failed
  and Settings → CLI registration crashed with `EACCES` (upstream issue #19120).
- **Shape:** the creation-side fix (pin the umask) plus recovery for installs that already have a
  broken link (report `stale` instead of throwing). 4 files.
- **Verified:** typecheck, `pnpm build`, full suite 81,234 pass, plain `oxlint`, changed-code gate;
  both review bots clean; CodeRabbit's two threads resolved. Manual before/after on installed builds
  (`0700` → `0755`).
- **Blocked on:** a maintainer. No human review, no comment, and CI has not even been released to
  run — as of the last check, 17h after opening.

### fix/copilot-background-work

- **Why:** Copilot panes reported `done` while background shells or subagents were still running, and
  a `Notification(permission_prompt)` was treated as `blocked` even though approval may be automatic.
- **Shape:** per-pane background-work state machine + the permission-prompt correction, in three
  files plus tests. 4 files, +394/−19.
- **Targets:** no issue of its own. It is the Copilot counterpart of #10997 / #12382 (Claude).
- **Verified:** typecheck, 1,138 tests, plain `oxlint`.

### nplez1/Copilot-Auto-Approval-Issue

- **Why:** follow-up to `fix/copilot-background-work`, verified against live Copilot CLI 1.0.87
  captures. Copilot panes still showed "Needs attention" for permission requests resolved without
  the user (auto-approval), and the background-work tracker matched signals Copilot never sends:
  shells were detected via invented `background`/`run_in_background` fields (never a real one), every
  `task` counted as background (so sync subagents leaked a count and pinned monitoring), a subagent's
  own background shell was dropped, and a subagent's session events were attributed to the lead pane.
- **Shape:** corrected to the real signals — `mode:"async"`/`detach:true` shells registered from the
  start's result and settled by a `shell_completed` notification or a `read_bash`/`stop_bash` result
  — plus per-shell identity matching, `mode:"background"`-only subagent counting, and child-session
  events keyed against the pane's lead session id. New `copilot-background-work-state.ts` and three
  test files (two split off the oversized normalization test, one replaying a real capture).
- **Targets:** upstream #19780 (auto-approved permission notifications) and #20810 (Copilot pane
  `done` while background work runs).
- **Verified:** `pnpm tc`, changed-code quality gate, targeted `oxlint`, 1,300 tests across
  `src/main/agent-hooks` + `src/shared/agent-hook-listener`, and a replay of a real nested Copilot
  capture.

### nplez1/bug-copilot-and-pi-questions-stay-working-instea

- **Why:** issue #145 — a Copilot pane holding a question or an approval dialog kept reading **Working**,
  so the agent never reached the dashboard's **Needs You** lane.
- **Shape:** Copilot's hook stream cannot prove a dialog — `permission_prompt` also fires for the requests
  its CLI approves itself (3,611 assisted to 831 asked across the 328 recorded sessions behind
  `89a758b98d`), which is why that lane is dropped, and `PermissionRequest` precedes both a prompt and
  a silent approval. The pane's screen already carries the evidence in the blocked-text layer the terminal waits read; it just
  never reached the status row. A stored `working` row now arms one deferred read per pane (250 ms, so the
  TUI can paint the dialog first). If the screen shows an approval or an interactive prompt gained during
  that row's turn, the row is repainted `waiting` with the pane's identity and tool line intact; while
  that wait stands it is re-read once a second (slowing to one per five) so the dialog leaving the screen
  ends it — nothing posts when a person answers, and `PostToolUse` comes only after the approved command
  finishes. The runtime's wait-blocked scan also reports the moment a dialog appears, so a dialog painted
  long after the agent's last hook is seen without a timer. Gated to `copilot` and to rows this host owns
  (`connectionId === null`), the way remote Claude evidence is already skipped. New `shared/agent-screen-prompt.ts`,
  `agent-hooks/server/server-screen-prompt-{corroboration,wiring}.ts`,
  `runtime/terminal/wait/terminal-pane-screen-prompt.ts`; reader bound in both bootstraps.
- **Pi is NOT fixed here, and the reason is measured.** A real PTY capture of Pi-Bolt 1.3.0's select
  dialog (`pi --no-extensions -e <select extension>`, 100x30) shows it painted with cursor addressing:
  the visible grid carries `↑↓ navigate  enter select  escape/ctrl+c cancel`, but the tail text
  `detectTerminalWaitBlockedReason` reads never contains it, so a Pi screen anchor cannot fire. A Pi fix
  needs the emulated screen plus its own "gained" stamp — a separate change, tracked on #145.
- **Targets:** fork issue #145. Upstream-worthy: the Copilot half is the negative of #19780, which taught
  Orca to stop trusting `permission_prompt` — nothing replaced that lane, so a real dialog going
  unanswered had no reporter.
- **Review:** `claude/opus` at high reasoning, five rounds, each over a corrected revision. Round 1:
  the repaint dropped `providerSession`/`launchToken` (the #10630 regression); the wait never ended,
  because the next hook after an approval is the completed command; a dialog was seen only inside the
  250 ms window; the Pi anchor was written without a capture — which the capture then disproved; no
  teardown for pending reads; `readPaneScreenPrompt` untested. Round 2: the new runtime dep was declared
  but never assigned, so the gained-dialog path was a no-op; a repaint of the dialog restarted the loop
  and lost the release; the Pi anchor was still committed; a one-minute cap re-introduced the stuck wait;
  a store refresh of our own row ended the loop; remote rows were not excluded. Round 3: the commit
  attributed the measured ratio to the wrong source and duplicated a paragraph; it claimed a full run
  that had not finished; the slow-re-read case could not fail; the release cancelled the read its own
  write scheduled; a restored wait row had no loop. Round 4: the base had moved under the branch; a
  hydrated wait row was never adopted (and its first test called `arm` directly, so it passed anyway);
  the release-order fix had no test; this entry overstated the history. Fixed, with a case for each that
  fails without the fix (the hydration case was verified by disabling the adoption call). Copilot panes
  over SSH are **not** covered — this host does not own those rows — and #145 stays open for Pi.

### fix/repo-catalog-connection-fence

- **Superseded on 2026-10-11 — do not open this.** Upstream landed `63b3f15cc4` (_every repo
  catalog uses the host-catalog fence_, #27116), its own fix for #20811: `claimHostCatalogFence` /
  `isHostCatalogFenceCurrent` removed both the fork's per-host generation map and its connection
  fence, and upstream's `failed` flag keeps repo-scoped UI from being validated for a host that
  never answered. The 2026-10-11 sync took upstream's side in full, so the branch has nothing left
  to contribute upstream. Its fix is already on `nplez1/main` either way.
- **Why:** an all-hosts repo catalog fetch could outlive the connection it started on, letting a
  catalog fetched over the old connection overwrite the new one's. Also fixes repo-scoped UI being
  validated for a host that never answered.
- **Targets:** upstream issue #20811 (filed).
- **Verified:** typecheck, 4,519 tests, plain `oxlint`.

### fix/claude-codex-enterprise-accounts

- **Why:** enterprise and usage-billed plans report a spending ceiling instead of quota windows, so
  they read as "No usage data". This surfaces the ceiling percentage and the amounts against it.
- **Targets:** upstream issue #8664.
- **Verified:** typecheck, full suite, quality gate.

### feat/copilot-usage / feat/deepseek-usage / feat/fireworks-usage

- **Why:** three new usage providers for the status bar, each split from the original combined
  branch and self-contained (shared modules duplicated deliberately — these were built before the
  decomposition rules existed).
- **Targets:** #6892 (Copilot), #12869 (DeepSeek), #20812 (Fireworks, filed).
- **Verified:** typecheck + provider tests each; full suite for the enterprise branch.
- **Caveat:** `feat/copilot-usage` is 77 files and includes the inline-setup UI, so it needs
  before/after screenshots before it can be opened.

### feat/worktree-scan-cache-persistence

- **Why:** persist the worktree scan so a cold start can hydrate from it instead of re-scanning.
- **Shape:** main-process cache + preload surface. 12 files.
- **Verified:** typecheck, 666 tests across the touched surface, plain `oxlint`.
- **Note:** 2 test files here are the splitting agent's adaptations, not the author's.

### fix/terminal-session-reconnect

- **Parent:** `feat/worktree-scan-cache-persistence` (do not measure it against main — that would
  attribute the parent's files to it).
- **Why:** reconnect a session's terminals. Own delta is 3 files, +134/−53.
- **Verified:** typecheck, 3,222 tests.

### feat/startup-worktree-hydration

- **Parent:** `fix/terminal-session-reconnect`, which itself needs
  `feat/worktree-scan-cache-persistence`. Land in that order.
- **Why:** renderer half of the cached-worktree startup path — the five new `renderer/src/startup/*`
  modules, hydration keys, and the deferred activation/GitHub-refresh work.
- **Own delta:** 23 files, +654/−159.
- **Verified:** typecheck, 12,534 tests.
- **Note:** 3 test-harness files here are the splitting agent's adaptations.

### feat/startup-service-ordering

- **Why:** order first-window and PTY startup so services that others depend on come up first.
  12 files.
- **Verified:** typecheck, 1,431 tests, plain `oxlint`.

### fix/agent-status-routing-readiness

- **Why:** make agent-status IPC routing wait for readiness rather than dropping events that arrive
  before the renderer can accept them. 12 files, but only +33/−7 of production change.
- **Verified:** typecheck, 1,860 tests.
- **Note:** 7 files here are the splitting agent's harness adaptations.

### nplez1/issue-151 — the known-red allowlist (fork issue #151)

- **Why:** gate 1's allowlist had drifted into the shapes its own note warns against: 20 file-level
  wildcards that also mask a _new_ failure in the same file, eight entries stale, and two reds outside
  the file so the gate could not produce a verdict at all. Three of the entries also named files
  upstream's own unit lane excludes, which the gate was nonetheless running.
- **Shape:** `local/gate-unit.mjs` runs the unit lane's file set (`ORCA_BALANCE_UNIT_SHARDS=1` →
  `UNIT_EXCLUDE`, 80 files here), asserts the report collected none of them, refuses an allowlist entry
  for a quarantined file, and runs the fork-local `local/**/*.test.mjs` lane that nothing else reached.
  The manifest is 32 named entries whose arithmetic closes; the one red the tightening surfaced is
  fixed (`pane-screen-prompt.spec.ts` asserted `null` where the implementation documents `undefined`),
  and `local/gate-unit.test.mjs` pins the judging rules and the manifest invariants.
- **Already done by earlier syncs:** § 2 (the eight stale entries were pruned at the 2026-10-21
  reconciliation) and § 4 (both formerly-unlisted reds pass). The issue's correction to the recorded
  extend-test diagnosis is in [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) § `local(test)`: the 28 `TypeError:
  {} is not iterable` rejections had a second cause, the renderer reclaim bridge, fixed in `2368ed38da`.
- **Verified:** see the PR body — `pnpm tc`, the focused suites, `check:code-quality:changed`, the full
  gate verdict for the shipped revision, and the Opus review round.

### nplez1/Hide-hosts — PR #9, **merged** (2026-09-19)

- **Landed as** `cad3e4df59` on `nplez1/main` (`72034293d5`, the tip this sync was rebased from).
  The branch itself is gone from both the fork and this checkout, so `node local/branch-status.mjs`
  reports it MISSING — that is expected, not drift.
- **Why:** a host Orca imports from `~/.ssh/config` could only be removed, and the next sync brought
  it back, so there was no durable way to say "not on this machine's Orca". Discovered hosts now get
  a reversible Hide; hosts the user added keep the trashcan and cannot be hidden.
- **Shape:** a `hidden` flag on the target row plus `ssh:setTargetHidden`, mirrored into the renderer
  store so the host pickers (add-repo, composer/new-workspace, task page, automations, skill install)
  filter on it. Settings splits into a collapsed "Hidden (n)" section; the status bar drops a hidden
  host unless it is connected or connecting. 34 production files, +614/−142, across 3 new modules.
- **Why not filter `listTargets`:** that call also feeds the label/connection mirror whose readers
  treat a missing entry as proof the host was removed, so a filtered list would have rendered a
  hidden host's live workspaces as orphans. Fork PRs of this shape should keep the flag on the row.
- **Verified:** typecheck, changed-code gate (0 findings), max-lines ratchet, localization extraction
  - catalog, rpc-params catalog; 34,326 tests across the touched suites (487 in the files this PR
    adds or changes).
- **Note:** the `$electron` skill `AGENTS.md` names for rendered-UI checks is not installed in this
  worktree, so the new section's layout has no live screenshot. PR body says so under Visual Proof.

### nplez1/main

This fork's own line: upstream `main` plus all of the above plus fork-only patches, and the only
branch that carries the release tooling. See [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) for the patch
series, `.github/workflows/fork-release.yml` for the release pipeline, and
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) for the certificate-day deployment steps.

## Open threads

- **PR #20813 awaits a human.** Rebased onto the current base on 2026-09-16 (4 commits, all
  `range-diff`-identical), so it is mergeable and no longer stale. The next action is still a
  maintainer's; the bots have been the only reviewers. If nothing moves after a few days, one short
  comment on the PR, or their Discord (https://discord.gg/fzjDKHxv8Q), is the proportionate nudge.
- **Do not open the other PRs yet.** A first-time contributor filing eight PRs into a queue that is
  not being triaged risks all of them going stale. Land one, become a `CONTRIBUTOR`, then move. The
  PR-bound branches are _not_ current — see § Base drift for the measured distance — so whoever opens
  one rebases it first, parent-first for the three-deep chain.
- **The release line works end to end.** Apple Developer Program is approved; `v1.4.197-np.6` was the
  first build signed with a Developer ID, notarized and stapled (`spctl` reports
  _accepted, source=Notarized Developer ID_). What remains unproven is **self-update**: one release
  cannot demonstrate it, so publish a second trivial one and watch a machine move on its own.
- **Resolved since this file was written:** the identity question (shipped as **Orca NP** — its own
  bundle id, data directory, home directory and CLI; see LOCAL-PATCHES.md § local(identity)), version
  numbering (`<package.json version>-np.<run number>`, already what the workflow derives), and the
  dev-channel leak (one update stream; see LOCAL-PATCHES.md § local(updater)).
- **A full `pnpm test` needs its environment before it can be trusted.** Verified on 2026-09-21, four
  unrelated setup gaps look like regressions and are not: the browser viewport suites need
  `ORCA_BACKGROUND_LAUNCH=1`; the mobile bundle and render suites need `mobile`'s postinstall
  (`node scripts/build-*-engine.mjs`) and a Playwright browser for the installed revision; the relay
  unit suites need the `cloud/` workspace installed (`pg`); and a leftover
  `tests/e2e/.cross-version-checkouts` (1.3 GB, ~184k files) overflows the `found.push(...)` spread in
  the e2e walker with `Maximum call stack size exceeded`. With those in place the 2026-09-21 sync ran
  green; without them, expect ~96 false failures.
