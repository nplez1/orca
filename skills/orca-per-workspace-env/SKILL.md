---
name: orca-per-workspace-env
description: >-
  Set up, review, debug, or validate an Orca per-workspace environment recipe: the
  on-demand, disposable runtime (cloud sandbox, VM, SSH host, or local container)
  Orca creates fresh for each workspace. Use to stand up a new recipe end to end,
  fix an `environmentRecipes` entry in `orca.yaml`, scaffold provider lifecycle
  scripts, or resolve an `orca vm recipe doctor` failure. Use `orca-cli` for
  ordinary worktree and workspace creation with no recipe involved.
---

# Per-Workspace Environments

This discovery stub loads the version-matched guide from the Orca executable used for this session.

## Resolve the CLI for this session

This skill drives **Orca NP**, whose own CLI installs as `orca-np`. Choose the executable once and
reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca NP exports it for the
  sessions it manages when it knows their executable — WSL terminals and agent chats — normally as
  an absolute path to its own launcher. Substitute it directly,
  quoted — these paths contain spaces (`/Applications/Orca NP.app/…`, `…/Application Support/…`) —
  with double quotes in POSIX shells, `& "…"` in PowerShell, and `"…"` in cmd.exe.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-np-dev`, the
  dev launcher the running build installed. Inside the repo, `pnpm exec orca-dev` reaches the
  same CLI.
- Otherwise, use `orca-np`.

One case needs a different executable, and it has to be established rather than guessed from what
happens to be on `PATH`: an Orca host that deployed its own CLI shim to this machine — an
Orca-managed remote or SSH session — names that shim plain `orca`, so use `orca` there. Nothing you
merely find on `PATH` establishes it: outside this app's managed sessions a bare `orca` is the
official Orca install, which targets a different app and data directory, and on Linux it is normally
the GNOME Orca screen reader (`/usr/bin/orca`), which starts speech on the user's machine. `orca-ide`
is the official Linux install too.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything — quoted as above when it is a path — and do not create a shell variable or run
`ORCA` literally. The quoting rule above is the only thing that differs between POSIX shells,
PowerShell, and cmd.exe (and a path is safer run directly than through `cmd /c`, which strips the
outer pair of quotes).

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build. Exception: on
Windows, when `ORCA_CLI_COMMAND` or `ORCA_TERMINAL_HANDLE` is set (Orca supplied the
executable), a sandboxed shell that reports it as not recognized or access denied before
Orca itself runs cannot read Orca's install. Re-run that command, and later Orca commands,
with escalated permissions before giving up.

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orca-per-workspace-env
```

Run `skills get` as shown, without `--json`: `--json` packs the guide into one escaped line.
If your tool cuts the middle out of the guide, read only the missing line range rather than
loading the whole guide again. Prefer `--json` for other commands. Use the selected
executable's `--help` for commands or flags the guide does not cover. A
`runtime_unavailable` error is usually transient while Orca is busy or restarting: wait a
few seconds and retry the command. Before retrying a command that changes something, check
whether it already took effect, and reuse any request ID the error names. `ORCA open` can
bring Orca's window to the front over the user's work, so never run it to retry a failed
command. Run it only when the user asks, or when Orca is really not running:
`ORCA status --json` reports `result.app.running: false`, or every command, `ORCA status`
included, still cannot connect after about 30 seconds of retries. If a command fails with
`runtime_access_denied`, your sandbox blocked the connection: re-run it with escalated
permissions, and do not run `ORCA open` or restart Orca. If `skills get` is unknown, explain
that updating Orca restores the guide; use `--help` for read-only discovery and do not guess
unsupported commands.
