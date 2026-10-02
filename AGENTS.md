# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Most of it is linted: `pnpm run check:code-quality:changed` fails on new restyles of a `components/ui/` primitive, raw palette colors, and computed `className` strings; `pnpm lint` fails on any class Tailwind cannot generate. See the Enforcement section of the style guide before suppressing either. Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

## Electron UI Validation

Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`,
`app.focus()`, or OS activation. Use CDP screenshots of hidden renderers. Keep native-focus and
visible-window tests paused on the user's desktop; run them on an isolated display or CI.
Rebuild modified launch-policy code before running an app; stale build wrappers are not safe.

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.

# Style

## Reuse Before Reimplementing

Before writing new logic at any scale — a function, component, IPC channel, state store, or whole subsystem/flow — check whether an existing implementation already does the job (or nearly does). Extend or generalize it instead of building a parallel version; only write from scratch when nothing fits. Keep the check proportionate: a quick search for trivial code, a real one before building anything substantial.

## Concise/Brief Non-obvious Comments ONLY

- DO NOT: be verbose, explain the obvious, walk through the code ("WHY not HOW")
- BE CONCISE. 1 LINE if possible

## Lint Rules: Do Not Disable Max Lines

NEVER add a `max-lines` disable (`eslint-disable max-lines`, `oxlint-disable max-lines`, or line-specific variants), and never add a per-file `max-lines` bump in `mobile/.oxlintrc.json`.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Declarations: Prefer `.ts` Over `.d.ts`

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

```ts
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Explain the verified invariant here.
```

# Verifying Changes

- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: `pnpm test [path/to/file.test.ts]`
- **Lint**: `oxlint`, or `pnpm run check:code-quality:changed` for changed files (full `pnpm lint` is slow); format with `pnpm format`
- **Design system**: `pnpm run lint:design-system` for the full renderer report (not a gate); the changed-lines gate above is what CI enforces
- **Real Claude CLI**: when you change Claude structured-session code (`src/main/claude/claude-structured-*`), run `ORCA_REAL_CLAUDE_CLI_TEST=1 pnpm test src/main/claude/claude-structured-real-cli.test.ts src/main/claude/claude-structured-real-cli-fold.test.ts`; it uses your real Claude login

# Writing Pull Requests

Fill in [`.github/pull_request_template.md`](./.github/pull_request_template.md), written for a reviewer who has never seen this code:

- No jargon — plain language, no internal shorthand.
- The before and after as the user experiences it.
- The mechanism you changed, not just the symptom.
- Why this approach over the alternatives you considered.

Cover all four concisely. Don't pad or walk the diff.

# Considerations

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.
- **Windows terminal shells**: `--shell` picks the shell a terminal _is_; `--command` is typed into whatever shell the host spawned, so a shell choice routed through `command` silently becomes a child process. See [`docs/reference/windows-terminal-shell-selection.md`](./docs/reference/windows-terminal-shell-selection.md).
- **Windows setup scripts**: the setup/issue-command runner is a `.cmd` batch file unless the script starts with a `#!` line — never derive that from the user's terminal-shell preference, and never launch a `.cmd` runner with a bare `cmd.exe /c` from a Git Bash pane (MSYS rewrites the `/c`). See [`docs/reference/windows-setup-shell.md`](./docs/reference/windows-setup-shell.md).
- **Windows child processes**: start them through `runProcess`/`spawnProcess` in `src/shared/child-process/` — never `child_process` directly. It pins `windowsHide`, refuses `shell: true`, and encodes `.cmd`/`.bat` arguments so neither `CommandLineToArgvW` nor `cmd.exe` mangles them. A ratchet test fails on any new direct import. Recognised npm/pnpm `.cmd` shims are resolved to their real target so the spawn skips `cmd.exe` entirely; see [`docs/reference/windows-cmd-shim-resolution.md`](./docs/reference/windows-cmd-shim-resolution.md) before adding a shim shape or debugging one.
- **Ripgrep**: Orca bundles `rg` for every platform, WSL, and SSH remotes. Spawn it through `spawnBundledRipgrep` (main) or `resolveRelayRipgrepCommand` (relay), never a bare `'rg'` — Windows resolves a bare name in the spawn cwd before PATH. Don't add git/readdir fallbacks locally; the relay's chain exists only for hosts an upload never reached.
- **Windows process enumeration**: read the table through `src/main/windows/windows-process-table.ts`, never by forking `powershell.exe`. See [`docs/reference/windows-process-enumeration.md`](./docs/reference/windows-process-enumeration.md).
- **Windows MSYS/Git Bash panes**: their children break away from the per-PTY job unless it is created without `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, and a `conpty.node` built before that fix passes every existing gate. Before changing the per-PTY job or debugging `windows-msys-job.win32.test.ts`, read [`docs/reference/windows-msys-job-breakaway.md`](./docs/reference/windows-msys-job-breakaway.md).
- **Windows daemon-host relocation**: the terminal daemon runs from a copy of the app runtime under `%LOCALAPPDATA%`, which is what survives an auto-update. Before touching that copy, its exe name, or the NSIS uninstall macro, read [`docs/reference/windows-daemon-host-relocation.md`](./docs/reference/windows-daemon-host-relocation.md).
- **Windows EDR signal**: don't add `-ExecutionPolicy Bypass`, `-EncodedCommand`, `cmd.exe /c` with escaped free text, per-operation interpreter spawning, or runtime `Add-Type` compilation without reading [`docs/reference/windows-edr-posture.md`](./docs/reference/windows-edr-posture.md) first — behavioural EDR scores each of those, and being signed does not clear them. For file verdicts on the bytes we ship — antivirus false positives, and the vendor programs that clear a release before users meet the detection — see [`docs/reference/antivirus-prerelease-clearance.md`](./docs/reference/antivirus-prerelease-clearance.md).
- **WSL commands**: build argv with `buildWslExecArgs` (always `--exec` — under `--`, `wsl.exe` expands `$name` in every argument and silently rewrites the script), and fence anything whose stdout you parse with `buildWslCapturedLoginShellCommand`, because the interactive login shell prints the distro banner to stdout. See [`docs/reference/wsl-command-execution.md`](./docs/reference/wsl-command-execution.md).
- **Linux native modules**: keep the glibc floor at Ubuntu 20.04 / glibc 2.31. A module compiled from source on a newer runner can reference symbol versions absent on the floor and crash the app on startup. See [`docs/reference/linux-glibc-compatibility.md`](./docs/reference/linux-glibc-compatibility.md); packaging fails if a bundled native binary needs newer glibc.

## Native Dependency Installs

Ordinary `pnpm install` covers the host OS and CPU only. Before packaging for another architecture — including `pnpm build:mac`, which builds x64 and arm64 by default — run `pnpm install:release`. electron-builder only warns on a missing `extraResources` source, so the `beforePack` guard is what turns a thin install into a build failure instead of a silently broken artifact; see [`docs/reference/pnpm-install-policy.md`](./docs/reference/pnpm-install-policy.md).

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution. Before changing anything that reports on, stops, or lists remote work, follow [`docs/reference/ssh-execution-boundary.md`](./docs/reference/ssh-execution-boundary.md): the execution host owns everything that touches execution, and loss of contact is never evidence of process death — the verdict vocabulary is `live` / `unverifiable` / `exited`, with no synonyms.

## Folder Workspace Use Case

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

## Agent Status

The execution host owns agent status in one store, the hook server's, and every reader (sidebar, `worktree ps`, mobile, dashboard) subscribes to it. Before adding a producer, a cache, or a reader-side precedence rule, read [`docs/reference/agent-status-store.md`](./docs/reference/agent-status-store.md): new producers write into that store, and readers keep only presentation policy.

## Agent Terminal Screens

A rule that reads what an agent CLI paints on a terminal — readiness, blocked prompts, idle — must be written against a captured transcript, not a remembered screen. Record one with [`docs/reference/agent-pty-transcript-capture.md`](./docs/reference/agent-pty-transcript-capture.md), which keeps escapes and wrapping intact and scrubs account identifiers before they reach git. Antigravity readiness has no transcript yet and five failed attempts without one; before touching it, read [`docs/reference/antigravity-readiness-evidence.md`](./docs/reference/antigravity-readiness-evidence.md).

## Remote Wire Compatibility

Clients and remote Orca servers update independently, so mixed versions are the normal state. Before changing anything a paired client and host exchange — RPC params, stream frames, or the content either side publishes over them — follow [`docs/reference/remote-wire-compatibility.md`](./docs/reference/remote-wire-compatibility.md). A new optional field is safe; a new stream opcode must be capability-negotiated because decoders drop unknown opcodes silently; and changing what the host publishes reaches old clients even with no wire change.

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline and follow [`docs/reference/git-compatibility.md`](./docs/reference/git-compatibility.md).

When adding or changing a Git command:

- Check when every subcommand and option was introduced. For newer behavior, keep a baseline-compatible fallback or degrade safely.
- Use `GitCapabilityCache` with a narrow unsupported-error predicate so recurring operations do not retry a known-invalid command. Do not rely only on `git --version`; wrappers such as `simple-git` do not remove host-version differences.
- Scope capability state to the host that executes Git: native, WSL distro, SSH provider, or relay connection. Cover the first fallback, later cached calls, concurrent probes, and relevant host isolation in tests.
- Keep the real-binary compatibility contract in PR CI current. When adopting a newer Git feature, add its version boundary so the preferred command and fallback both run against representative Git releases.
- Preserve commands that begin with global Git options such as `-c` before the subcommand, including auto-maintenance suppression used by worktree-create fetches.

## Git Scan Safety

- Never enumerate every ref and then run `git ls-tree -r` or `git show` once per ref. That ref × tree fan-out can retain gigabytes of output before a downstream `sort -u` or search can make progress.
- Prefer `rg` over the checked-out files for source searches. For history or refs, use a named ref, an explicit namespace/path, `--max-count`, and a bounded output; do not use an unqualified `--all` scan as a first diagnostic.
- Keep repository-wide commands targeted to the current repository and worktree. If an unbounded scan is genuinely required, measure the ref count first, explain the cost, and get confirmation before running it.

## File Path Search

The Explore pane's filename filter and Quick Open both search a workspace's file paths, and both are bounded. Before changing how either pane filters, or any bound that applies to a file listing, read [`docs/reference/file-path-filtering-at-scale.md`](./docs/reference/file-path-filtering-at-scale.md): the search must scan and count everything while the display keeps a bounded page, and a filter may claim "no files match" only when the host scanned the whole workspace. `QUICK_OPEN_LISTING_MAX_RESULTS` is an OOM bound — do not raise or remove it to make a filter find more.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.

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
node local/open-pr.mjs --title "<conventional title>" --body-file /tmp/body.md
node local/open-pr.mjs --title "..." --body-file /tmp/body.md --dry-run    # inspect first
node local/open-pr.mjs --title "..." --body-file /tmp/body.md --upstream   # only when asked
```

It defaults to fork `nplez1/orca` / base `nplez1/main`, requires `--upstream` to leave the fork, and
refuses a head that does not descend from its base.

Why the ancestry check matters: the two branches called `main` are different lines. A head cut from
`main` and opened against `nplez1/main` looks like a small diff locally but carries every fork-only
patch as a reversion — that is where the ~300k-line PRs came from.

## Branch state

- `node local/branch-status.mjs` — live SHAs and PR state. **Source of truth.**
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
- **Always pass an explicit `timeout` of at least 600000 ms** for typecheck, test, or lint. The 120 s
  default is below their real cost and causes repeated timeouts and restarts.
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
