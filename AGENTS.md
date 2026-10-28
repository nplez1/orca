# Useful Commands

- **While editing**: `pnpm check:iteration --maxWorkers=2` for repeated feedback on uncommitted edits against HEAD (CI unit inventory).
- **Before handoff**: `pnpm check:changed --maxWorkers=2` once for the whole branch (format, lint, typecheck, affected tests, ratchets; cached when nothing changed). An iteration pass does not replace this gate.
- Stream check output and poll the same running process/session for progress. Redirecting to a file hides progress unless you tail it; keep any outer execution deadline longer than the check's step budgets plus shutdown time.
- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: `pnpm test [path/to/file.test.ts]`; affected only: `pnpm test:changed [path] --maxWorkers=2` ([details](.github/CONTRIBUTING.md#targeting-local-tests))
- **Lint**: `oxlint`; format: `pnpm format`

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. Read the `docs/styleguide/` deep dive it links only when your change touches that topic. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

# Electron UI Validation

Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`,
`app.focus()`, or OS activation. Use CDP screenshots of hidden renderers. Keep native-focus and visible-window tests paused on the user's desktop; run them on an isolated display or CI.
Rebuild modified launch-policy code before running an app; stale build wrappers are not safe.

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.
Screenshot presentational components without Electron: `pnpm fixtures:shot <id>` ([fixtures](docs/agents-md-refs/component-fixtures.md)).

# Code Style

## Reuse Before Reimplementing

Before writing new logic at any scale — a function, component, IPC channel, state store, or whole subsystem/flow — check whether an existing implementation already does the job. Extend or generalize it instead of building a parallel version.

## Avoid Comments

- Only use when code does not describe
- BE CONCISE. 1 LINE if possible (why not how)

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

# First Class Citizens

Every change must consider these areas:

## Cross-Platform Support

Support macOS, Linux, and Windows. Guard platform-specific behavior at runtime; use platform-aware shortcuts, paths, and existing process wrappers. Before changing platform-specific code, processes, shells, shortcuts, paths, or native modules, read [`docs/agents-md-refs/cross-platform-support.md`](./docs/agents-md-refs/cross-platform-support.md).

## Remote Use Case

Support remote execution as well as local. Clients and servers update independently; preserve compatibility across mixed versions.

## Mobile

Any feature should be considered for parity on mobile

## Folder Workspaces

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

# Git / GitHub

If changing code around `git`, `gh`, source-control, or review behavior read [`docs/agents-md-refs/git-workflow.md`](./docs/agents-md-refs/git-workflow.md).

For a failed GitHub Actions run, inspect the failed jobs and retry with `gh run rerun <run-id> --failed --repo stablyai/orca`. Preserve successful jobs; use a full rerun only when the failure requires revalidating them. A code fix needs a new push and fresh checks, not a retry of the old SHA.

# Tests

Avoid adding low-value tests. These might be fine for development but offer negative value when checked in. [Anti-patterns](./docs/agents-md-refs/test-antipatterns.md)

## File Path Search

The Explore pane's filename filter and Quick Open both search a workspace's file paths, and both are bounded. Before changing how either pane filters, or any bound that applies to a file listing, read [`docs/reference/file-path-filtering-at-scale.md`](./docs/reference/file-path-filtering-at-scale.md): the search must scan and count everything while the display keeps a bounded page, and a filter may claim "no files match" only when the host scanned the whole workspace. `QUICK_OPEN_LISTING_MAX_RESULTS` is an OOM bound — do not raise or remove it to make a filter find more.

# Fork workflow (`nplez1/orca`) — local, not proposed upstream

Everything above is upstream's guidance and stays authoritative. This section is fork-local: it
describes how work reaches a branch and a PR in this fork. See [`LOCAL-PATCHES.md`](./LOCAL-PATCHES.md)
for why fork-only material lives outside PR-owned files.

## Remotes — work goes to the fork

- `origin` → `ssh://git@ssh.github.com:443/nplez1/orca.git` — **the fork. This is where work goes.**
- `upstream` → `https://github.com/stablyai/orca.git` — someone else's repository. **Read-only.**
- Worktree branch: `nplez1/<Task>`.

**Never open a PR or an issue on `stablyai/orca` unless upstream is asked for in so many words.** If
one was already opened, say so before anything else and offer to close it.

## Opening a PR — use the script, never hand-rolled `gh`

```bash
body=$(mktemp "${TMPDIR:-/tmp}/orca-pr-body.XXXXXX")   # unique per agent — /tmp is shared
node local/open-pr.mjs --title "<conventional title>" --body-file "$body"
node local/open-pr.mjs --title "..." --body-file "$body" --dry-run         # inspect first
node local/open-pr.mjs --title "..." --body-file "$body" --upstream        # only when asked
```

The body path is `mktemp`-derived on purpose: several agents run at once on one machine and share
`/tmp`, and a fixed `/tmp/body.md` has already collided between two of them.

It defaults to fork `nplez1/orca` / base `nplez1/main`, requires `--upstream` to leave the fork, and
refuses a head that does not descend from its base. The base is resolved against the remote the PR
targets (`upstream` for an upstream PR, `origin` otherwise), because the two track different branches,
and an upstream head carrying any `local(` commit — or any fork-owned path (`local/`,
`LOCAL-PATCHES.md`, `BRANCHES.md`, `UPSTREAM-SYNC-RUNBOOK.md`, `.husky/commit-msg`) — is refused
outright.

**Both PR gates are read by that script.** It refuses any PR whose body has no review claim line:

```
Reviewed by Opus 5.5, high: R1 (2 blocking fixed), delta clean on R2
```

Gate 1 is **diff-scope dependent**, because the full unit suite moved off the PR boundary and onto the
nightly `fork-main-tests.yml` lane plus the release gate (`AGENTS.md` § Verification tiers). The script
requires a cached unit-gate PASS for this exact revision (`orca-queue node local/gate-unit.mjs` writes
one per revision) only when a changed path is a **global input** — `package.json`, the lockfiles,
`config/**`, a root `tsconfig*.json`, `src/packages/**`, `src/shared/**`, or anything outside the
source, test, doc, fork-tooling and workflow trees. An ordinary `src/` change is verified by its
targeted tests, and the script prints `gate 1 not required` instead of demanding a suite run. Measured
on the last 40 commits, 15 touched `src/shared` or `src/packages`, so roughly a third of changes still
carry the full gate — the third with the blast radius.

`--waive-gate <1|2>:<reason>` records a deliberate exception, prints it, and expects the PR body to
state it. Gate 1 is fork-local either way, so an upstream PR carries no verdict for it and always needs
an explicit `--waive-gate 1:"upstream PR, gated by upstream CI"`. `--dry-run` reports a refusal instead
of aborting, so the decision can be inspected before the ~20-minute run.

Why the ancestry check matters: the two branches called `main` are different lines. A head cut from
`main` and opened against `nplez1/main` looks like a small diff locally but carries every fork-only
patch as a reversion — that is where the ~300k-line PRs came from.

## Branch state

- `node local/branch-status.mjs` — live SHAs and PR state. **Source of truth.** The inventory is derived
  from `refs/heads/nplez1`, `origin/nplez1/*` and the fork's own heads, and PR state is read from both
  `nplez1/orca` and `stablyai/orca`; `--local-only` skips the network. A dependency key that matches no
  branch is reported rather than ignored.
- [`BRANCHES.md`](./BRANCHES.md) — why each branch exists, what blocks it, dependency order. Read before
  any PR or branch work. It records what the script cannot know; if the two disagree, the script is right.
- [`LOCAL-PATCHES.md`](./LOCAL-PATCHES.md) — the fork-only patch series.
- A `local(...)` commit is refused on every branch except `nplez1/main` (`.husky/commit-msg`). If it
  fires, switch branches — do not bypass it.
- Fork PR branches are cut from `nplez1/main`; upstream-bound branches from `origin/main`.
- Chained branches rebase **parent-first**. Force-push with `--force-with-lease origin <branch>`.

## Verify

- Typecheck `pnpm tc` (`tc:node` / `tc:cli` / `tc:web`) · tests `pnpm test <path>`
- Changed-lines gate CI enforces: `pnpm run check:code-quality:changed`
- Lint `pnpm exec oxlint` · format `pnpm format`
- **Always pass an explicit `timeout`** for typecheck, test, or lint: the harness default is below
  their real cost and causes repeated timeouts and restarts. The unit is per-harness — pi's Bash tool
  takes **seconds** (`timeout: 600`), Claude Code's takes **milliseconds** (`600000`). An ms-scale
  number handed to pi is not rejected, it just means ~7 days: no deadline at all.
- Electron and tests: `ORCA_BACKGROUND_LAUNCH=1`, hidden renderers, CDP screenshots. Never steal focus.

## CI-fix cycle — standing preference

When asked to fix CI failures:

1. `gh pr checks` to identify the failing checks.
2. Run **only the failing test files** locally.
3. Commit and push.
4. **Let CI verify — do not run the full suite locally.**

Do not poll CI with long sleeps inside one turn; one check after the push, then report. A full
relevant-suite run is still expected **before opening a PR** — this preference is about CI-fix cycles,
not about skipping verification on new work.

## Dev build identity

This fork ships as **Orca NP** — its own bundle id, data directory, home directory, and CLI name (see
[`LOCAL-PATCHES.md`](./LOCAL-PATCHES.md) § `local(identity)`). Launch and point at **Orca NP**, never
the upstream `Orca` app. If a path or launcher looks like upstream's, stop and check.

## Host settings replication

One machine is authoritative for settings and provider credentials and replicates them to its
subordinate paired hosts. The design, the field-disposition contract, and the open questions are in
[`docs/reference/host-settings-replication.md`](./docs/reference/host-settings-replication.md) —
read it before changing how a host resolves a setting, a provider credential, or the fork's own home
directory.

## Project skills

This repo's agent skills are tracked by the `local(skills)` patch at
`.agents/skills/{electron,typescript,react-useeffect}`. A worktree branched before that patch has none
— that is expected, not a missing install. Do not look for them in `~/.agents/skills/`.

For rendered Orca UI validation use the `$electron` skill plus Playwright CDP — not computer-use.

## Shared / multi-agent worktrees

When other agents may be editing the same worktree: re-read a file **in the same turn** as your edit
(never from a body read several turns earlier), keep edits small and disjoint, make each `oldText`
unique in the file, and re-check the file afterwards. Never emit overlapping edits in one call.

## Delegation defaults

When handed a bounded research, review, or implementation prompt, assume unless it says otherwise:

- **Read-only** unless the prompt says to write.
- **Worktree-scoped**: read, search, and edit only under the worktree path named. Never read outside it.
- **Cite `file:line`** for every claim about existing code.
- **Respect any word budget** given.
- **Report what was not verified**, plus any cap, skip, or sampling applied.

## Search; do not guess paths

- Resolve a path with a search before reading it. On `ENOENT`, search for the real path — do not guess
  a second spelling.
- Filename search: `fd`. Content search: `rg`. (`bfs` is not installed by default.)
- Never edit a path that has not been confirmed to exist.
