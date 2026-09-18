# Branch tracker

Last updated **2026-09-18** — `nplez1/main` rebased onto upstream main @ `0b57ce0295`, 215
commits on from the previous base `291b4ddd6f`. See [UPSTREAM-SYNC-RUNBOOK.md](./UPSTREAM-SYNC-RUNBOOK.md)
for how that is done and [LOCAL-PATCHES.md](./LOCAL-PATCHES.md) § Sync log for what it cost.

The live table — SHAs, whether the fork has each branch, each branch's own delta, and its PR state —
is generated, not kept by hand:

```bash
node local/branch-status.mjs
```

Run it first. This file records what that script cannot know: **why each branch exists, what it
depends on, and what is blocking it.** If the two disagree, the script is right.

## Rules that keep this from rotting

- PR branches are cut from `origin/main`, **never** from `nplez1/main`. That is what makes it
  impossible for a fork-only patch to leak into a PR.
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
```

The three-deep chain is real, not cosmetic: `startup-worktree-hydration` needs the
`WorktreeApi.listCached` method that `worktree-scan-cache-persistence` adds **and** a store action
that `terminal-session-reconnect` adds. Splitting it further would mean duplicating code to hide the
dependency, so the three want to land in that order.

## Base drift — recorded, not fixed

After the 2026-09-18 sync, **every PR-bound branch sits on a pre-sync base** — none of them was
rebased this time, because none is open and the plan is still to open them one at a time. Measured
by merge-base against `upstream/main`:

- the **seven PR-bound branches** (`fix/cli-symlink-world-readable`, `fix/copilot-background-work`,
  `fix/repo-catalog-connection-fence`, `fix/claude-codex-enterprise-accounts`, `feat/copilot-usage`,
  `feat/deepseek-usage`, `feat/fireworks-usage`) sit on `560c42e1d1`, **145 commits behind**;
- the **five deliberately-left ones** (`feat/worktree-scan-cache-persistence`,
  `fix/terminal-session-reconnect`, `feat/startup-worktree-hydration`,
  `feat/startup-service-ordering`, `fix/agent-status-routing-readiness`) sit on `615b1370fb`,
  **239 commits behind**.

Re-measure rather than trusting those numbers (`node local/branch-status.mjs`, and merge-base against
`upstream/main` for the behind count, which that script does not print). Note that `origin/main` — the
branch PRs are nominally cut from — is itself still at `291b4ddd6f` until the next sync pushes
`upstream/main` onto it; the seven PR-bound branches' base is *newer* than it, which is why they are
fewer commits behind than the fork's own line was.

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

### fix/repo-catalog-connection-fence

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
  not being triaged risks all of them going stale. Land one, become a `CONTRIBUTOR`, then move. The six
  PR-bound branches are already current, so opening them later costs nothing.
- **The release line works end to end.** Apple Developer Program is approved; `v1.4.197-np.6` was the
  first build signed with a Developer ID, notarized and stapled (`spctl` reports
  *accepted, source=Notarized Developer ID*). What remains unproven is **self-update**: one release
  cannot demonstrate it, so publish a second trivial one and watch a machine move on its own.
- **Resolved since this file was written:** the identity question (shipped as **Orca NP** — its own
  bundle id, data directory, home directory and CLI; see LOCAL-PATCHES.md § local(identity)), version
  numbering (`<package.json version>-np.<run number>`, already what the workflow derives), and the
  dev-channel leak (one update stream; see LOCAL-PATCHES.md § local(updater)).
