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

This skill drives **Orca NP**, whose CLI installs as `orca-np`. Choose the executable once and
reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca NP exports this for
  the sessions it manages, normally as an absolute path to its own launcher.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-np-dev`, the
  dev launcher the running build installed. Inside the repo, `pnpm exec orca-dev` reaches the
  same CLI.
- Otherwise, on Linux, use `orca-ide`. Never run bare `orca` there — outside Orca's terminals it
  normally resolves to the GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the
  user's machine.
- Otherwise, use `orca-np`.

One exception: an execution host served by Orca's SSH relay rather than the desktop app deploys a
shim under the plain name `orca`, so use `orca` there, and only where `orca-np` does not exist.
Everywhere else a bare `orca` is the official Orca install, which targets a different app and data
directory — never fall through to it.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orca-per-workspace-env
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
